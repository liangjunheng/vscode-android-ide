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

/** 在 VM 边界替换 Node 依赖，测试私有函数而不扩大生产模块导出 API。 */
function loadScript({ fsOverrides = {}, fspOverrides = {}, childProcess = {}, https, platform = process.platform } = {}) {
  const fsMock = new Proxy(fs, { get(target, property) { return property in fsOverrides ? fsOverrides[property] : target[property]; } });
  const fspMock = new Proxy(fsp, { get(target, property) { return property in fspOverrides ? fspOverrides[property] : target[property]; } });
  const childMock = new Proxy(require('node:child_process'), { get(target, property) { return property in childProcess ? childProcess[property] : target[property]; } });
  const module = { exports: {} };
  const localRequire = name => {
    if (name === 'node:fs') return fsMock;
    if (name === 'node:fs/promises') return fspMock;
    if (name === 'node:child_process') return childMock;
    if (name === 'node:https') return https;
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

/** 回归：Windows Eclipse Adoptium 目录不存在只跳过，显式 JDK 仍按 17/21 门槛和优先级选择。 */
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
      return { stdout: '', stderr: `java version "${java.includes('17') ? '17.0.12' : '21.0.4'}"` };
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

/** 回归：--version 结果验证发布 JAR，非零退出或空输出均阻断复制。 */
test('verifyJar validates java -jar version output', () => {
  let result = { status: 0, stdout: '2.0.0\n', stderr: '' };
  const { api } = loadScript({ childProcess: { spawnSync: () => result } });
  assert.doesNotThrow(() => api.__test.verifyJar('java.exe', 'adapter.jar'));
  result = { status: 1, stdout: '', stderr: 'bad jar' };
  assert.throws(() => api.__test.verifyJar('java.exe', 'adapter.jar'), /failed version check/);
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
  const { api, process: processMock } = loadScript({ fsOverrides, fspOverrides, childProcess });
  processMock.env = { JVM_DEBUGGER_JAVA_HOME: javaHome, JAVA_HOME: '', PATH: '' };
  await api.build({ test: true });
  assert.equal(spawnCalls.length, 1);
  assert.match(spawnCalls[0].args[4], /test/);
  assert.doesNotMatch(spawnCalls[0].args[4], /package/);
  assert.ok(spawnCalls[0].options.env.PATH.split(path.delimiter).includes(path.dirname(maven)));
});
