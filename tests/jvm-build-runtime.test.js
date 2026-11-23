/**
 * 功能点：现役 JVM 构建链的执行、失败阻断和发布边界。
 * 受影响对象：build、Maven/JDK 发现、适配器版本校验、Gradle 构建及许可复制。
 * 复现路径：Node>=22，在 VM 中替换文件、网络及进程边界，模拟没有 Coordinator 的工作区。
 * 测试范围：两项现役构建、JDK 17/21 门槛、缺失/损坏产物、构建失败、许可缺失及测试模式不发布。
 * 执行入口：node --test tests/jvm-build-runtime.test.js；也由 npm test 发现。
 * 预期结果：默认模式严格校验并发布两项产物，测试模式仅执行原上游 Maven test。
 * 判据：任何多余服务调用、绕过必要校验、失败后继续发布或测试模式写资源均失败。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('node:events');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { Readable } = require('node:stream');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const scriptPath = path.join(root, 'scripts', 'build-jvm-debugger.cjs');
const scriptSource = fs.readFileSync(scriptPath, 'utf8');

/** 功能：在 VM 边界替换文件、网络、归档及进程依赖；输入替身，输出模块与隔离环境，禁止真实构建。 */
function loadScript({ fsOverrides = {}, fspOverrides = {}, childProcess = {}, https, unzipper, platform = process.platform } = {}) {
  const fsMock = new Proxy(fs, { get(target, property) { return property in fsOverrides ? fsOverrides[property] : target[property]; } });
  const fspMock = new Proxy(fsp, { get(target, property) { return property in fspOverrides ? fspOverrides[property] : target[property]; } });
  const childMock = new Proxy(require('node:child_process'), { get(target, property) { return property in childProcess ? childProcess[property] : target[property]; } });
  const module = { exports: {} };
  const localRequire = name => {
    if (name === 'node:fs') return fsMock;
    if (name === 'node:fs/promises') return fspMock;
    if (name === 'node:child_process') return childMock;
    if (name === 'node:https') return https;
    if (name === 'unzipper' && unzipper) return unzipper;
    return require(name);
  };
  const processMock = Object.create(process);
  Object.defineProperties(processMock, {
    platform: { value: platform },
    env: { value: { ...process.env }, writable: true },
  });
  const context = {
    Buffer,
    URL,
    clearTimeout,
    console,
    exports: module.exports,
    __dirname: path.dirname(scriptPath),
    __filename: scriptPath,
    module,
    process: processMock,
    require: localRequire,
    setTimeout,
  };
  const instrumented = scriptSource.replace('if (require.main === module)', 'if (false)') + '\nmodule.exports.__test = { download, ensureMaven, findJavaHome, run, verifyJar };';
  vm.runInNewContext(instrumented, context, { filename: scriptPath });
  return { api: module.exports, process: processMock };
}

function versionedChildProcess(version = 21, spawnCalls = []) {
  return {
    spawnSync() { return { status: 0, stdout: '', stderr: `java version "${version}.0.1"` }; },
    spawn(command, args, options) {
      spawnCalls.push({ command, args, options });
      const child = new EventEmitter();
      process.nextTick(() => child.emit('close', 0));
      return child;
    },
  };
}

/** 创建可观察的 HTTP 响应和文件流，覆盖下载成功、重定向与中止时的所有权释放。 */
function downloadResponse(mode, location) {
  const response = new EventEmitter();
  response.statusCode = mode === 'redirect' ? 302 : mode === 'http-error' ? 503 : 200;
  response.headers = location ? { location } : {};
  response.resumed = false;
  response.destroyed = false;
  response.resume = () => { response.resumed = true; process.nextTick(() => response.emit('end')); };
  response.destroy = () => { response.destroyed = true; };
  response.pipe = destination => {
    if (mode === 'aborted') process.nextTick(() => response.emit('aborted'));
    if (mode === 'success') process.nextTick(() => destination.emit('finish'));
    return destination;
  };
  return response;
}

function downloadHarness(sequence) {
  const requests = [];
  const outputs = [];
  const https = {
    get(url, callback) {
      const request = new EventEmitter();
      request.destroyed = false;
      request.destroy = () => { request.destroyed = true; };
      requests.push({ url, request });
      const response = sequence.shift();
      process.nextTick(() => callback(response));
      return request;
    },
  };
  const fsOverrides = {
    createWriteStream() {
      const output = new EventEmitter();
      output.destroyed = false;
      output.closed = false;
      output.destroy = () => { output.destroyed = true; };
      output.close = callback => { output.closed = true; callback(); };
      outputs.push(output);
      return output;
    },
  };
  return { https, fsOverrides, requests, outputs };
}

/** 功能点：构建JDK版本选择；受影响对象：findJavaHome；复现路径：父目录含17且分别配置JDK17/21；测试范围：缺失目录和版本门槛；执行入口：npm test；预期结果：模拟版本由精确可执行路径决定；判据：17/21选择与断言一致。 */
test('findJavaHome handles missing Windows candidates and minimum versions', () => {
  const fake17 = path.join(root, 'fake-jdk-17');
  const fake21 = path.join(root, 'fake-jdk-21');
  const fsOverrides = {
    readdirSync() {
      const error = new Error('missing');
      error.code = 'ENOENT';
      throw error;
    },
    existsSync(candidate) { return candidate === path.join(fake17, 'bin', 'java.exe') || candidate === path.join(fake21, 'bin', 'java.exe'); },
  };
  const childProcess = {
    spawnSync(java) {
      assert.ok(java === path.join(fake17, 'bin', 'java.exe') || java === path.join(fake21, 'bin', 'java.exe'));
      return { stdout: '', stderr: `java version "${java === path.join(fake17, 'bin', 'java.exe') ? '17.0.12' : '21.0.4'}"` };
    },
  };
  const { api } = loadScript({ fsOverrides, childProcess, platform: 'win32' });
  const selectedForBuild = api.__test.findJavaHome({ JVM_DEBUGGER_JAVA_HOME: fake17, JAVA_HOME: fake21, PATH: '' }, 17);
  assert.equal(selectedForBuild.home, fake17);
  const selectedForTest = api.__test.findJavaHome({ JVM_DEBUGGER_JAVA_HOME: fake17, JAVA_HOME: fake21, PATH: '' }, 21);
  assert.equal(selectedForTest.home, fake21);
});

/** 回归：Windows Adoptium 扫描的非缺失错误必须传播，避免把权限/IO 故障伪装成未安装。 */
test('findJavaHome propagates non-ENOENT candidate errors', () => {
  const fsOverrides = {
    readdirSync() {
      const error = new Error('access denied');
      error.code = 'EACCES';
      throw error;
    },
  };
  const { api } = loadScript({ fsOverrides, platform: 'win32' });
  assert.throws(() => api.__test.findJavaHome({ PATH: '' }), /access denied/);
});

/** 回归：不完整的用户 Maven 目录不得被删除或覆盖，必须在下载前明确失败。 */
test('ensureMaven rejects an existing incomplete tools directory', async () => {
  const tools = path.join(root, 'tools', 'maven');
  const fsOverrides = {
    existsSync(candidate) { return candidate === tools; },
  };
  const fspOverrides = {
    mkdir: async () => { throw new Error('should not create or replace user files'); },
  };
  const { api } = loadScript({ fsOverrides, fspOverrides });
  await assert.rejects(api.__test.ensureMaven({ PATH: '' }), /Maven directory exists but its executable is missing/);
});

/** 回归：Maven 归档 SHA-512 不匹配时拒绝并删除归档，绝不进入解压安装流程。 */
test('ensureMaven rejects a Maven archive with the wrong hash', async () => {
  const tools = path.join(root, 'tools', 'maven');
  const archive = path.join(root, 'tools', 'apache-maven-3.9.16-bin.tar.gz');
  const removed = [];
  const fsOverrides = {
    existsSync(candidate) { return candidate === archive; },
    createReadStream() { return Readable.from(['not the pinned archive']); },
  };
  const fspOverrides = {
    mkdir: async () => {},
    rm: async candidate => { removed.push(candidate); },
  };
  const { api } = loadScript({ fsOverrides, fspOverrides });
  await assert.rejects(api.__test.ensureMaven({ PATH: '' }), /SHA-512 does not match/);
  assert.deepEqual(removed, [archive]);
  assert.notEqual(tools, archive);
});

/** 回归：HTTP 错误、响应中止和重定向均完成 reject/resolve，并关闭涉及的流与请求。 */
test('download closes streams on HTTP and aborted failures and follows redirects', async () => {
  {
    const harness = downloadHarness([downloadResponse('http-error')]);
    const { api } = loadScript({ fsOverrides: harness.fsOverrides, https: harness.https });
    await assert.rejects(api.__test.download('https://example.invalid/maven.tar.gz', 'archive.tar.gz'), /HTTP 503/);
    assert.equal(harness.requests[0].request.destroyed, true);
    assert.equal(harness.requests.length, 1);
  }
  {
    const harness = downloadHarness([downloadResponse('aborted')]);
    const { api } = loadScript({ fsOverrides: harness.fsOverrides, https: harness.https });
    await assert.rejects(api.__test.download('https://example.invalid/maven.tar.gz', 'archive.tar.gz'), /aborted/);
    assert.equal(harness.requests[0].request.destroyed, true);
    assert.equal(harness.outputs[0].destroyed, true);
  }
  {
    const harness = downloadHarness([downloadResponse('redirect', '/final.tar.gz'), downloadResponse('success')]);
    const { api } = loadScript({ fsOverrides: harness.fsOverrides, https: harness.https });
    await api.__test.download('https://example.invalid/maven.tar.gz', 'archive.tar.gz');
    assert.equal(harness.requests.length, 2);
    assert.equal(harness.requests[1].url, 'https://example.invalid/final.tar.gz');
    assert.equal(harness.outputs[0].closed, true);
  }
});

/** 回归：Windows cmd 调用保持独立 argv/cwd 的 -f pom 行为，并拒绝 shell 元字符注入。 */
test('run keeps Windows Maven command safe and preserves -f pom', async () => {
  const spawnCalls = [];
  const { api } = loadScript({ childProcess: versionedChildProcess(21, spawnCalls) });
  const maven = path.join(root, 'tools', 'maven', 'bin', 'mvn.cmd');
  const pom = path.join(root, 'adapter', 'pom.xml');
  await api.__test.run(maven, ['-B', '-f', pom, 'test'], root, { ComSpec: 'C:\\Windows\\System32\\cmd.exe' });
  assert.equal(spawnCalls.length, 1);
  assert.equal(spawnCalls[0].command, 'C:\\Windows\\System32\\cmd.exe');
  assert.equal(spawnCalls[0].options.cwd, path.dirname(maven));
  assert.match(spawnCalls[0].args[4], /mvn\.cmd/);
  assert.match(spawnCalls[0].args[4], /-f/);
  assert.match(spawnCalls[0].args[4], /pom\.xml/);
  await assert.rejects(api.__test.run(maven, ['-f', 'bad&injection.xml'], root, { ComSpec: 'cmd.exe' }), /Unsafe Maven command or argument/);
});

/** 功能：检查适配器版本输出；输入成功、非零、空白及非法版本结果，断言非标准输出阻断发布。 */
test('verifyJar validates java -jar version output', () => {
  let result = { status: 0, stdout: '2.0.0\n', stderr: '' };
  const { api } = loadScript({ childProcess: { spawnSync: () => result } });
  assert.doesNotThrow(() => api.__test.verifyJar('java.exe', 'adapter.jar'));
  for (const failure of [
    { status: 1, stdout: '', stderr: 'bad jar' },
    { status: 0, stdout: '', stderr: '' },
    { status: 0, stdout: 'not a version', stderr: '' },
  ]) {
    result = failure;
    assert.throws(() => api.__test.verifyJar('java.exe', 'adapter.jar'), /failed version check/);
  }
});

/** 回归：--test 只执行 Maven test，成功后不检查或复制 target 中可能残留的旧 JAR。 */
test('build test mode does not publish a stale jar', async () => {
  const maven = path.join(root, 'tools', 'maven', 'bin', 'mvn.cmd');
  const javaHome = path.join(root, 'fake-jdk-21');
  const spawnCalls = [];
  const fsOverrides = {
    readdirSync() {
      const error = new Error('missing');
      error.code = 'ENOENT';
      throw error;
    },
    existsSync(candidate) {
      return candidate === maven || candidate === path.join(javaHome, 'bin', 'java.exe');
    },
  };
  const fspOverrides = {
    copyFile: async () => { throw new Error('test mode must not publish a JAR'); },
  };
  const childProcess = versionedChildProcess(21, spawnCalls);
  const { api, process: processMock } = loadScript({ fsOverrides, fspOverrides, childProcess, platform: 'win32' });
  processMock.env = { JVM_DEBUGGER_JAVA_HOME: javaHome, JAVA_HOME: '', PATH: '' };
  await api.build({ test: true });
  assert.equal(spawnCalls.length, 1);
  const adapterPom = path.join(root, 'src', 'android-debugger', 'jvm-debugger', 'upstream', 'adapter', 'pom.xml');
  assert.equal(spawnCalls[0].args[4], 'mvn.cmd ' + ['-B', '-f', adapterPom, 'test'].map(arg => '"' + arg + '"').join(' '));
  assert.doesNotMatch(spawnCalls[0].args[4], /package|coordinator|skipTests/);
  assert.ok(spawnCalls[0].options.env.PATH.split(path.delimiter).includes(path.dirname(maven)));
});

/** 功能：模拟仅有现役工程的默认构建；输入故障场景，输出隔离构建 API 和调用记录；不读取或修改实际资源。 */
function buildHarness(scenario = '') {
  const adapter = path.join(root, 'src', 'android-debugger', 'jvm-debugger', 'upstream', 'adapter');
  const adapterJar = path.join(adapter, 'target', 'kotlin-debug-adapter.jar');
  const toolingPom = path.join(root, 'src', 'gradle-tooling', 'pom.xml');
  const toolingJar = path.join(root, 'src', 'gradle-tooling', 'target', 'gradle-tooling-server-1.0.0.jar');
  const output = path.join(root, 'resources', 'jvm-debugger', 'kotlin-debug-adapter.jar');
  const toolingOutput = path.join(root, 'resources', 'gradle-tooling-server.jar');
  const upstreamLicense = path.join(root, 'src', 'android-debugger', 'jvm-debugger', 'upstream', 'LICENSE');
  const tools = path.join(root, 'tools', 'maven');
  const maven = path.join(tools, 'bin', 'mvn');
  const javaHome = path.join(root, 'fake-jdk-17');
  const java = path.join(javaHome, 'bin', 'java');
  const calls = [], copies = [], writes = [], checks = [];
  const fsOverrides = {
    existsSync(candidate) {
      assert.doesNotMatch(candidate, /coordinator/i);
      return [tools, maven, java, ...(scenario === 'missing-adapter' ? [] : [adapterJar])].includes(candidate);
    },
  };
  const fspOverrides = {
    mkdir: async directory => { assert.equal(directory, path.dirname(output)); },
    readFile: async (file, encoding) => {
      assert.equal(file, path.join(root, 'resources', 'licenses', 'Apache-2.0', 'legalcode.txt'));
      assert.equal(encoding, 'utf8');
      return 'Apache 原文';
    },
    writeFile: async (file, content) => { writes.push({ file, content }); },
    copyFile: async (from, to) => { copies.push([from, to]); },
    stat: async file => { assert.equal(file, output); return { size: scenario === 'empty-output' ? 0 : 128 }; },
  };
  const childProcess = {
    spawnSync(command, args) {
      assert.equal(command, java);
      checks.push([...args]);
      if (args[0] === '-version') return { status: 0, stdout: '', stderr: 'java version "17.0.12"' };
      assert.deepEqual(Array.from(args), ['-jar', adapterJar, '--version']);
      return { status: scenario === 'invalid-adapter' ? 1 : 0, stdout: '2.0.0\n', stderr: '' };
    },
    spawn(command, args, options) {
      assert.equal(command, maven);
      assert.doesNotMatch(args.join(' '), /coordinator|copy-dependencies/i);
      calls.push({ args: [...args], options });
      const child = new EventEmitter();
      const fail = scenario === 'adapter-build-failure' && calls.length === 1 || scenario === 'tooling-build-failure' && calls.length === 2;
      process.nextTick(() => child.emit('close', fail ? 1 : 0));
      return child;
    },
  };
  const unzipper = { Open: { file: async file => {
    assert.equal(file, toolingJar);
    if (scenario === 'missing-tooling') throw new Error('tooling JAR missing');
    if (scenario === 'invalid-tooling') throw new Error('tooling ZIP corrupt');
    return { files: scenario === 'missing-license' ? [] : [{ path: 'META-INF/LICENSE.txt', buffer: async () => Buffer.from('MIT 原文\nMIT 原文\n') }] };
  } } };
  const { api, process: processMock } = loadScript({ fsOverrides, fspOverrides, childProcess, unzipper, platform: 'linux' });
  processMock.env = { JVM_DEBUGGER_JAVA_HOME: javaHome, PATH: '' };
  return { api, calls, copies, writes, checks, adapter, adapterJar, toolingPom, toolingJar, output, toolingOutput, upstreamLicense };
}

// 无 Coordinator 的默认构建必须仍执行两次 Maven、版本校验与全部现役许可复制。
test('default build publishes only the verified JVM adapter and Gradle tooling', async () => {
  const f = buildHarness();
  assert.equal(await f.api.build(), f.output);
  assert.equal(f.calls.length, 2);
  assert.deepEqual(f.calls[0].args, ['-B', '-f', path.join(f.adapter, 'pom.xml'), '-DskipTests', '-Dmaven.test.skip=true', 'package']);
  assert.deepEqual(f.calls[1].args, ['-B', '-f', f.toolingPom, '-DskipTests', 'package']);
  assert.equal(f.calls[0].options.cwd, f.adapter);
  assert.equal(f.calls[1].options.cwd, root);
  assert.deepEqual(f.checks, [['-version'], ['-jar', f.adapterJar, '--version']]);
  assert.deepEqual(f.copies, [[f.adapterJar, f.output], [f.toolingJar, f.toolingOutput], [f.upstreamLicense, path.join(path.dirname(f.output), 'LICENSE')]]);
  assert.deepEqual(f.writes.map(entry => entry.file), [path.join(root, 'resources', 'gradle-tooling-LICENSE.txt')]);
  assert.ok(f.writes[0].content.includes('Apache 原文'));
  assert.ok(f.writes[0].content.endsWith('MIT 原文\nMIT 原文\n'));
});

// 每个现役构建错误都必须传播；适配器失败不发布，Gradle 失败不发布其成品。
for (const [scenario, message, calls, copies] of [
  ['adapter-build-failure', /exited with code 1/, 1, 0],
  ['missing-adapter', /shaded JAR is missing/, 1, 0],
  ['invalid-adapter', /failed version check/, 1, 0],
  ['tooling-build-failure', /exited with code 1/, 2, 1],
  ['missing-tooling', /tooling JAR missing/, 2, 1],
  ['invalid-tooling', /tooling ZIP corrupt/, 2, 1],
  ['missing-license', /Tooling API SLF4J license missing/, 2, 1],
  ['empty-output', /generated JAR is empty/, 2, 3],
]) {
  test('default build rejects ' + scenario, async () => {
    const f = buildHarness(scenario);
    await assert.rejects(f.api.build(), message);
    assert.equal(f.calls.length, calls);
    assert.equal(f.copies.length, copies);
    if (copies === 0) assert.equal(f.writes.length, 0);
    if (copies <= 1) assert.equal(f.copies.some(([, to]) => to === f.toolingOutput), false);
  });
}

// 默认构建接受 JDK17，但原上游测试仍要求 JDK21，不能借移除服务降低门槛。
test('JVM test mode still rejects JDK 17 before Maven test', async () => {
  const f = buildHarness();
  await assert.rejects(f.api.build({ test: true }), /JDK 21\+ not found/);
  assert.equal(f.calls.length, 0);
  assert.equal(f.copies.length, 0);
  assert.equal(f.writes.length, 0);
});
