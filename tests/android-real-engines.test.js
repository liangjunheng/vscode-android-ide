/**
 * 功能点：注册的直接JVM descriptor启动真实JAR并调试本地Java fixture。
 * 受影响对象：registerJvmDebugger、findJava、真实JAR stdio DAP和测试自有HotSpot进程。
 * 复现路径：Node>=22、esbuild、完整JDK17+及已构建JAR；显式ANDROID_REAL_ENGINES_TEST=1；
 *   ANDROID_REAL_JAVA_HOME或JAVA_HOME必须指定真实JDK。context使用固定extensionUri/logUri/subscriptions。
 * 测试范围：直接Executable、initialize、attach、initialized、断点、stopped、栈、局部变量、
 *   evaluate、continue、detach、真实子进程close；不经过Android provider，不调用设备、ADB或旧代理。
 * 执行入口：ANDROID_REAL_ENGINES_TEST=1 node --test tests/android-real-engines.test.js；默认仅显式opt-in跳过。
 * 预期结果：响应全部来自descriptor指向的真实JAR；目标计算84，detach后自行退出。
 * 判据：依赖缺失、协议超时、断点或计算错误及清理失败均失败；本地HotSpot不等同ART，Native由独立入口覆盖。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { Module } = require('node:module');
const { randomUUID } = require('node:crypto');
const root = path.resolve(__dirname, '..');
const diagnosticMs = 25000;
const initializeArgs = { clientID: 'android-real-engines', adapterID: 'android-jvm', locale: 'en-US', linesStartAt1: true, columnsStartAt1: true, pathFormat: 'path', supportsVariableType: true, supportsVariablePaging: true, supportsRunInTerminalRequest: false };

/** 功能：限定真实操作诊断时间；输入Promise和标签；输出实际结果或明确超时。 */
async function bounded(operation, label, ms = diagnosticMs) {
  let timer;
  try { return await Promise.race([operation, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('真实引擎诊断超时：' + label)), ms); })]); }
  finally { clearTimeout(timer); }
}

/** 功能：积累先发事件避免竞态；输入独占日志；输出真实观测账本及条件等待。 */
function journal(file) {
  const values = [], listeners = new Set();
  return { values,
    // 功能：持久化真实消息；输入观测；输出唤醒等待者，不生成响应。
    push(value) { values.push(value); fs.appendFileSync(file, JSON.stringify(value) + '\n'); for (const listener of [...listeners]) listener(); },
    // 功能：等待真实条件；输入谓词和名称；输出匹配值或最近诊断。
    async wait(predicate, label) {
      let inspect;
      const promise = new Promise(resolve => { inspect = () => { const value = values.find(predicate); if (value !== undefined) resolve(value); }; listeners.add(inspect); inspect(); });
      try { return await bounded(promise, label); }
      catch (error) { throw new Error(error.message + '\n最近真实观测：' + JSON.stringify(values.slice(-12)), { cause: error }); }
      finally { listeners.delete(inspect); }
    },
  };
}

/** 功能：启动自有进程；输入命令、参数和目录；输出真实输出、close凭据及精确清理。 */
function spawnOwned(command, args, directory, logFile) {
  const observations = journal(logFile), child = cp.spawn(command, args, { cwd: directory, stdio: 'pipe', windowsHide: true });
  let stdout = '', stderr = '', closed = false;
  child.stdout.on('data', bytes => { stdout += bytes.toString(); observations.push({ kind: 'stdout', text: stdout }); });
  child.stderr.on('data', bytes => { stderr += bytes.toString(); observations.push({ kind: 'stderr', text: stderr }); });
  child.stdin.on('error', error => observations.push({ kind: 'stdin-error', message: error.message }));
  const completion = new Promise(resolve => {
    child.once('error', error => observations.push({ kind: 'spawn-error', message: error.message }));
    child.once('close', (code, signal) => { closed = true; observations.push({ kind: 'close', code, signal }); resolve({ code, signal, stdout, stderr }); });
  });
  return { child, observations, completion,
    // 功能：仅结束本次自有进程；输入无；输出等到实际close，不扫描其他进程。
    async close() { if (!closed && child.exitCode === null && child.signalCode === null) assert.equal(child.kill(), true); await bounded(completion, '自有进程close'); },
  };
}

/** 功能：只打包当前JVM注册模块；输入宿主API；输出真实registerJvmDebugger，设备依赖禁止进入图。 */
async function loadProduction(vscode) {
  const result = await require('esbuild').build({
    absWorkingDir: root, entryPoints: [path.join(root, 'src/android-debugger/jvm-debugger/adapter.ts')],
    bundle: true, write: false, platform: 'node', format: 'cjs', external: ['vscode'], metafile: true,
  });
  assert.ok(Object.keys(result.metafile.inputs).every(file => !/(?:device\.ts|sessionAdapter|coordinator\/|\/engines\.ts)/.test(file)), '直接descriptor不能引入设备或旧代理');
  const filename = path.join(root, 'tests/android-real-engines.bundle.cjs'), loaded = new Module(filename, module);
  loaded.filename = filename; loaded.paths = Module._nodeModulePaths(root);
  loaded.require = id => id === 'vscode' ? vscode : module.require(id);
  loaded._compile(result.outputFiles[0].text, filename); return loaded.exports;
}

/** 功能：注册并取得真实Executable；输入固定context及JDK；输出生产factory返回的命令，不伪造descriptor。 */
async function descriptor(context, javaHome) {
  let factory;
  class Executable {
    // 功能：承载宿主Executable值；输入生产参数；输出启动命令和参数，不模拟引擎。
    constructor(command, args) { this.command = command; this.args = args; }
  }
  const vscode = {
    Uri: { joinPath: (uri, ...parts) => ({ fsPath: path.join(uri.fsPath, ...parts) }) }, DebugAdapterExecutable: Executable,
    workspace: { getConfiguration: () => ({ get: (key, fallback) => key === 'javaHome' ? javaHome : fallback }) },
    window: { createOutputChannel: () => ({ appendLine() {}, dispose() {} }) },
    debug: {
      registerDebugAdapterTrackerFactory: () => ({ dispose() {} }),
      registerDebugAdapterDescriptorFactory(type, value) { assert.equal(type, 'android-jvm'); assert.equal(factory, undefined); factory = value; return { dispose() {} }; },
    },
  };
  const api = await loadProduction(vscode); api.registerJvmDebugger(context);
  const value = await factory.createDebugAdapterDescriptor({ id: 'real-jvm', configuration: { adapterJvmArgs: [], logLevel: 'DEBUG' }, workspaceFolder: { uri: { fsPath: context.logUri.fsPath } } });
  assert.ok(value instanceof Executable); assert.equal(value.implementation, undefined);
  assert.deepEqual(value.args.slice(0, 2), ['-jar', path.join(root, 'resources/jvm-debugger/kotlin-debug-adapter.jar')]);
  return value;
}

/** 功能：通过真实子进程stdio使用DAP；输入自有引擎和日志；输出请求关联及严格字节解析，不填充成功响应。 */
function dapClient(engine, logFile) {
  const messages = journal(logFile); let buffer = Buffer.alloc(0), sequence = 100, protocolError;
  engine.child.stdout.on('data', bytes => {
    if (protocolError) return;
    try {
      buffer = Buffer.concat([buffer, bytes]);
      while (true) {
        const end = buffer.indexOf('\r\n\r\n'); if (end < 0) return;
        const matches = [...buffer.subarray(0, end).toString('ascii').matchAll(/^Content-Length:\s*(\d+)\s*$/gmi)];
        assert.equal(matches.length, 1, '真实JAR必须输出唯一Content-Length');
        const length = Number(matches[0][1]); assert.ok(length > 0 && length <= 8 * 1024 * 1024);
        if (buffer.length < end + 4 + length) return;
        messages.push(JSON.parse(buffer.subarray(end + 4, end + 4 + length).toString('utf8')));
        buffer = buffer.subarray(end + 4 + length);
      }
    } catch (error) { protocolError = error; messages.push({ kind: 'protocol-error', message: String(error.stack || error) }); }
  });
  return { messages,
    // 功能：关联真实DAP响应；输入命令参数；输出匹配序号的真实成功响应。
    async request(command, args = {}) {
      if (protocolError) throw protocolError;
      const seq = sequence++, body = Buffer.from(JSON.stringify({ type: 'request', seq, command, arguments: args }));
      engine.child.stdin.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]));
      const response = await messages.wait(value => value.type === 'response' && value.request_seq === seq || value.kind === 'protocol-error', command);
      if (protocolError) throw protocolError;
      assert.equal(response.command, command); assert.equal(response.success, true, JSON.stringify(response)); return response;
    },
    // 功能：确认真实流无残帧；输入无；输出协议错误或完整帧断言。
    check() { if (protocolError) throw protocolError; assert.equal(buffer.length, 0, '真实JAR留下未完成DAP帧'); },
  };
}

/** 功能：通过直接JAR调试真实Java断点；输入descriptor和独占目录；输出断点、栈、变量和退出证据。 */
async function javaSession(executable, directory, t) {
  const token = randomUUID(), result = `REAL_JVM_RESULT_${token}=84`, exited = `REAL_JVM_EXIT_${token}`;
  const source = ['public class RealEngineFixture {', '  // 功能：提供真实局部变量、断点及detach后退出屏障。', '  public static void main(String[] args) throws Exception {', '    int seed = 37;', '    int local = seed + 5;', '    int answer = local * 2;', `    System.out.println("REAL_JVM_RESULT_${token}=" + answer);`, '    System.in.read();', `    System.out.println("${exited}");`, '  }', '}'].join('\n') + '\n';
  const sourceFile = path.join(directory, 'RealEngineFixture.java'), breakpointLine = source.split('\n').findIndex(line => line.includes('int answer =')) + 1;
  fs.writeFileSync(sourceFile, source);
  const compiler = spawnOwned(path.join(path.dirname(executable.command), process.platform === 'win32' ? 'javac.exe' : 'javac'), ['-g', '-d', directory, sourceFile], directory, path.join(directory, 'javac.jsonl'));
  try { const completion = await bounded(compiler.completion, 'javac -g'); assert.equal(completion.code, 0, JSON.stringify(completion)); }
  finally { await compiler.close(); }
  const target = spawnOwned(executable.command, ['-agentlib:jdwp=transport=dt_socket,server=y,suspend=y,address=127.0.0.1:0', '-cp', directory, 'RealEngineFixture'], directory, path.join(directory, 'target.jsonl'));
  let engine, dap;
  try {
    const listening = await target.observations.wait(value => ['stdout', 'stderr'].includes(value.kind) && /Listening for transport dt_socket at address:\s*(\d+)/.test(value.text), '动态JDWP端口');
    const port = Number(/Listening for transport dt_socket at address:\s*(\d+)/.exec(listening.text)[1]); assert.ok(port > 0 && port <= 65535);
    engine = spawnOwned(executable.command, executable.args, directory, path.join(directory, 'adapter-process.jsonl'));
    dap = dapClient(engine, path.join(directory, 'direct-jvm-dap.jsonl'));
    const initialized = await dap.request('initialize', initializeArgs);
    assert.equal(initialized.body.supportsConfigurationDoneRequest, true); assert.equal(initialized.body.supportsEvaluateForHovers, true);
    const attached = dap.request('attach', { type: 'android-jvm', name: '真实本地JVM', request: 'attach', hostName: '127.0.0.1', port, projectRoot: directory, sourcePaths: [directory] });
    void attached.catch(error => t.diagnostic('真实attach失败：' + error.message));
    await dap.messages.wait(value => value.event === 'initialized', '真实initialized');
    const breakpoints = await dap.request('setBreakpoints', { source: { name: 'RealEngineFixture.java', path: sourceFile }, breakpoints: [{ line: breakpointLine }], sourceModified: false });
    assert.equal(breakpoints.body.breakpoints.length, 1); const breakpoint = breakpoints.body.breakpoints[0]; assert.ok(Number.isInteger(breakpoint.id));
    await dap.request('configurationDone');
    const stopped = await dap.messages.wait(value => value.event === 'stopped' && value.body?.reason === 'breakpoint', '真实断点stopped');
    assert.ok(stopped.body.threadId > 0); assert.ok(stopped.body.hitBreakpointIds?.includes(breakpoint.id));
    if (!breakpoint.verified) await dap.messages.wait(value => value.event === 'breakpoint' && value.body?.breakpoint?.id === breakpoint.id && value.body.breakpoint.verified, '类加载后断点verified');
    await attached;
    const stack = await dap.request('stackTrace', { threadId: stopped.body.threadId, startFrame: 0, levels: 20 }); assert.ok(stack.body.stackFrames.length > 0);
    const frame = stack.body.stackFrames[0]; assert.match(frame.name, /main/); assert.equal(frame.line, breakpointLine); assert.equal(path.normalize(frame.source.path), path.normalize(sourceFile));
    const scopes = await dap.request('scopes', { frameId: frame.id }), locals = scopes.body.scopes.find(value => /local/i.test(value.name)); assert.ok(locals?.variablesReference > 0);
    const variables = await dap.request('variables', { variablesReference: locals.variablesReference });
    assert.equal(variables.body.variables.find(value => value.name === 'seed')?.value, '37'); assert.equal(variables.body.variables.find(value => value.name === 'local')?.value, '42');
    assert.equal((await dap.request('evaluate', { expression: 'local * 2', frameId: frame.id, context: 'watch' })).body.result, '84');
    await dap.request('continue', { threadId: stopped.body.threadId }); await target.observations.wait(value => value.kind === 'stdout' && value.text.includes(result), '真实计算输出84');
    await dap.request('disconnect', { terminateDebuggee: false }); await dap.messages.wait(value => value.event === 'terminated', '真实detach终止事件');
    target.child.stdin.end('\n'); const completion = await bounded(target.completion, '目标detach后自行退出');
    assert.equal(completion.code, 0, JSON.stringify(completion)); assert.equal(completion.signal, null); assert.ok(completion.stdout.includes(exited));
    engine.child.stdin.end(); const closed = await bounded(engine.completion, '直接JAR实际close'); assert.equal(closed.code, 0, JSON.stringify(closed)); dap.check();
    t.diagnostic('真实注册descriptor→JAR→HotSpot断点/栈/locals/evaluate/continue/detach完成；不代表ART或Native验收。');
  } finally { try { if (engine) await engine.close(); } finally { await target.close(); } }
}

// 功能：显式启用真实JVM协议验收；输入明确JDK与内置JAR；输出完整真实证据或失败，不降级为模拟。
test('真实注册JVM descriptor端到端DAP：本地JVM不是ART', { skip: process.env.ANDROID_REAL_ENGINES_TEST !== '1' && '需显式ANDROID_REAL_ENGINES_TEST=1', timeout: 180000 }, async t => {
  const javaHome = process.env.ANDROID_REAL_JAVA_HOME || process.env.JAVA_HOME; assert.ok(javaHome && path.isAbsolute(javaHome), '必须设置绝对ANDROID_REAL_JAVA_HOME或JAVA_HOME');
  fs.accessSync(path.join(javaHome, 'bin', process.platform === 'win32' ? 'javac.exe' : 'javac'), fs.constants.X_OK);
  fs.accessSync(path.join(root, 'resources/jvm-debugger/kotlin-debug-adapter.jar'), fs.constants.R_OK);
  const artifacts = path.join(root, '.test-artifacts'); fs.mkdirSync(artifacts, { recursive: true });
  const directory = fs.mkdtempSync(path.join(artifacts, 'android-real-engines-')); t.diagnostic('本次真实证据：' + directory);
  const context = { extensionPath: root, extensionUri: { fsPath: root }, logUri: { fsPath: directory }, subscriptions: [] };
  try {
    const executable = await descriptor(context, path.resolve(javaHome));
    assert.equal(path.normalize(executable.command), path.normalize(path.join(javaHome, 'bin', process.platform === 'win32' ? 'java.exe' : 'java')));
    const version = spawnOwned(executable.command, ['-version'], directory, path.join(directory, 'java-version.jsonl'));
    try { const actual = await bounded(version.completion, '真实Java版本'); assert.equal(actual.code, 0); t.diagnostic(actual.stdout + actual.stderr); } finally { await version.close(); }
    await javaSession(executable, directory, t);
  } finally { for (const subscription of context.subscriptions.reverse()) await subscription.dispose(); }
});
