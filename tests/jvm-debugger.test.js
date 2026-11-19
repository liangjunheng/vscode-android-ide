const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { transformSync } = require('esbuild');

/** 隔离VS Code/ADB/进程边界加载真实适配层；所有用例执行生产函数并断言可见结果。 */
function fixture() {
  const f = { calls: [], errors: [], registrations: [], devices: [{ serial: 'phone', state: 'device' }], exists: true };
  class Emitter {
    listeners = new Set();
    event = listener => { this.listeners.add(listener); return { dispose: () => this.listeners.delete(listener) }; };
    fire(message) { for (const listener of this.listeners) listener(message); }
    dispose() { this.listeners.clear(); }
  }
  const disposable = () => ({ dispose() {} });
  const vscode = {
    EventEmitter: Emitter,
    workspace: { isTrusted: true, getConfiguration: section => { assert.equal(section, 'android-ide.jvmDebugger'); return { get: (key, fallback) => fallback }; } },
    window: { createOutputChannel: () => ({ appendLine() {}, dispose() {}, show() {} }), showQuickPick: async items => f.cancel ? undefined : items[0], showErrorMessage: message => f.errors.push(message) },
    DebugConfigurationProviderTriggerKind: { Dynamic: 2 },
    DebugAdapterExecutable: class { constructor(command, args) { Object.assign(this, { command, args }); } },
    DebugAdapterInlineImplementation: class { constructor(implementation) { this.implementation = implementation; } },
    debug: {
      registerDebugAdapterTrackerFactory(type) { assert.equal(type, 'kotlin-jvm'); return disposable(); },
      registerDebugAdapterDescriptorFactory(type, factory) { f.registrations.push(['factory', type, factory]); return disposable(); },
      registerDebugConfigurationProvider(type, provider, kind) { f.registrations.push(['provider', type, provider, kind]); return disposable(); },
    },
  };
  const configModule = { exports: {} };
  vm.runInNewContext(transformSync(fs.readFileSync('src/android-debugger/index.ts', 'utf8'), { loader: 'ts', format: 'cjs' }).code,
    { module: configModule, exports: configModule.exports, require: id => id === 'vscode' ? vscode : require(id) });
  const module = { exports: {} };
  const dependencies = {
    vscode,
    './java': { findJava: async home => { f.javaHome = home; return { java: '/jdk/bin/java', version: 21 }; } },
    '../index': configModule.exports,
    '../../sdk': { adbPath: () => '/sdk/adb', listDevices: async () => f.devices },
    '../../projectLocalConfig': { readProjectLocalConfig: () => ({}) },
    '../native-debugger/nativeTarget': {
      resolveLauncherActivity: async () => '.MainActivity',
      async adbExec(adb, serial, args, signal) {
        f.calls.push({ adb, serial, args: Array.from(args), signal });
        if (f.adb) return f.adb(args, signal);
        return args[0] === 'forward' ? args[1] === '--remove' ? '' : '4567' : args.includes('pidof') ? '42' : 'Status: ok';
      },
    },
    'node:fs': { ...fs, existsSync: () => f.exists, mkdirSync: () => undefined },
    'node:child_process': { spawn: () => f.child },
  };
  vm.runInNewContext(transformSync(fs.readFileSync('src/android-debugger/jvm-debugger/adapter.ts', 'utf8'), { loader: 'ts', format: 'cjs' }).code,
    { module, exports: module.exports, require: id => dependencies[id] ?? require(id), Buffer, AbortController, AggregateError });
  f.api = module.exports; f.vscode = vscode;
  return f;
}

/** 模拟stdio子进程，只替换OS边界；保留真实Content-Length打包解析与关闭事件顺序。 */
function childFixture(f, config = { android: true, request: 'launch', serial: 'phone', packageName: 'com.example.app' }) {
  const child = new EventEmitter();
  Object.assign(child, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
  child.kill = () => { f.kills = (f.kills ?? 0) + 1; child.emit('close', 0); return true; };
  const adapter = new f.api.AndroidJvmAdapter(child, config, error => f.errors.push(error));
  const output = [], writes = [];
  adapter.onDidSendMessage(message => output.push(message));
  child.stdin.on('data', chunk => writes.push(Buffer.from(chunk)));
  return { adapter, child, output, writes };
}

/** 生成UTF8 DAP帧；分片/合并用例检查Content-Length按字节计算。 */
function frame(message) {
  const body = Buffer.from(JSON.stringify(message));
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]);
}

/** 等待真实生产异步操作完成，不以延时或轮询判断结果。 */
async function started(adapter) { await adapter.startup; }

/** 与已安装Kotlin插件共存时不得重复注册其设置；运行时读取由fixture严格断言新命名空间。 */
test('JVM settings use an extension-owned namespace without upstream collisions', () => {
  const properties = require('../package.json').contributes.configuration.properties;
  assert.equal(Object.keys(properties).some(key => key.startsWith('kotlinDebugger.')), false);
  for (const key of ['javaHome', 'adapterJvmArgs', 'traceProtocol', 'logLevel']) assert.ok(Object.hasOwn(properties, 'android-ide.jvmDebugger.' + key), key);
  for (const file of ['src/android-debugger/jvm-debugger/java.ts', 'src/android-debugger/jvm-debugger/adapter.ts', 'src/android-debugger/jvm-debugger/upstream/adapter/src/main/kotlin/dev/ktdebug/Main.kt']) {
    const source = fs.readFileSync(file, 'utf8');
    assert.equal(source.includes('kotlinDebugger'), false, file);
    assert.ok(source.includes('android-ide.jvmDebugger'), file);
  }
});

test('JVM built-in providers are isolated and registered as initial plus dynamic', () => {
  const f = fixture();
  const context = { subscriptions: [] };
  f.api.registerJvmDebugger(context);
  assert.deepEqual(f.registrations.map(row => row.slice(0, 2)), [['factory', 'kotlin-jvm'], ['provider', 'kotlin-jvm'], ['provider', 'kotlin-jvm']]);
  assert.equal(f.registrations[2][3], 2);
  const provider = f.registrations[1][2];
  const configs = provider.provideDebugConfigurations();
  assert.equal(configs.length, 1); assert.equal(configs[0].name, 'Kotlin/Java: Attach to JVM'); assert.equal(configs[0].request, 'attach'); assert.equal(configs[0].port, 5005);
  configs[0].sourcePaths.push('changed');
  assert.equal(provider.provideDebugConfigurations()[0].sourcePaths.length, 0);
  assert.equal(context.subscriptions.length, 6);
});

test('JVM provider supports upstream launch attach defaults and rejects invalid boundaries', async () => {
  const f = fixture(), provider = new f.api.JvmConfigurationProvider();
  const folder = { uri: { fsPath: path.resolve('sample') } };
  const config = await provider.resolveDebugConfiguration(folder, { type: 'kotlin-jvm', request: 'attach', name: 'JVM', port: '5005', sourcePaths: ['src'] });
  assert.equal(config.port, 5005); assert.equal(config.hostName, 'localhost');
  assert.equal(config.sourcePaths[0], path.join(folder.uri.fsPath, 'src'));
  const defaults = await provider.resolveDebugConfiguration(undefined, {}); assert.equal(defaults.port, 5005);
  for (const port of [undefined, 0, 65536, 'bad', 2.5]) await assert.rejects(provider.resolveDebugConfiguration(folder, { request: 'attach', port }), /port/);
  await assert.rejects(provider.resolveDebugConfiguration(folder, { request: 'launch' }), /mainClass/);
  assert.equal((await provider.resolveDebugConfiguration(folder, { request: 'launch', mainClass: 'MainKt' })).cwd, folder.uri.fsPath);
  await assert.rejects(provider.resolveDebugConfiguration(folder, { request: 'bogus' }), /request/);
  await assert.rejects(provider.resolveDebugConfiguration(folder, { request: 'attach', port: 5005, sourcePaths: [42] }), /sourcePaths/);
  const roots = await provider.resolveDebugConfiguration(folder, { request: 'attach', port: 5005, androidSourceRoots: ['src/java'] });
  assert.equal(roots.sourcePaths[0], path.join(folder.uri.fsPath, 'src/java'));
  f.vscode.workspace.isTrusted = false; await assert.rejects(provider.resolveDebugConfiguration(folder, {}), /trusted/);
});

test('Android provider selects devices validates identity and resolves Build package lazily', async () => {
  const f = fixture(); let reads = 0;
  const provider = new f.api.JvmConfigurationProvider(() => { reads++; return 'com.example.app'; });
  const input = { type: 'kotlin-jvm', request: 'attach', name: 'Android child', android: true, target: 'select' };
  const config = await provider.resolveDebugConfiguration(undefined, input);
  assert.equal(config.serial, 'phone'); assert.equal(config.packageName, 'com.example.app'); assert.equal(input.serial, undefined);
  const attach = await provider.resolveDebugConfiguration(undefined, { android: true, request: 'attach', serial: 'phone', packageName: 'com.example.app' });
  assert.equal(attach.processId, undefined); assert.equal(reads, 1);
  for (const value of [{ pid: 0 }, { pid: 1.5 }, { pid: 42, processId: 41 }]) await assert.rejects(provider.resolveDebugConfiguration(undefined, { android: true, request: 'attach', serial: 'phone', ...value }), /process|requires/);
  const noPackage = new f.api.JvmConfigurationProvider(() => undefined);
  await assert.rejects(noPackage.resolveDebugConfiguration(undefined, { android: true, request: 'attach', serial: 'phone' }), /process|requires/);
  f.cancel = true; assert.equal(await provider.resolveDebugConfiguration(undefined, input), undefined);
  const broken = new f.api.JvmConfigurationProvider(() => { throw new Error('model failed'); });
  await assert.rejects(broken.resolveDebugConfiguration(undefined, input), /model failed/);
  const exactPid = await broken.resolveDebugConfiguration(undefined, { type: 'kotlin-jvm', request: 'attach', name: 'PID', android: true, serial: 'phone', pid: 42, apkPath: '/missing.apk' });
  assert.equal(exactPid.pid, 42);
});

/** Attach-only内置模式只查询现有进程，不安装/启动APK，并使用动态forward端口。 */
test('Android attach-only resolves an existing package PID without installing or launching', async () => {
  const f = fixture(), x = childFixture(f, { android: true, serial: 'phone', packageName: 'com.example.app' });
  f.adb = async args => args.includes('pidof') ? '42' : args[1] === 'tcp:0' ? '4567' : '';
  x.adapter.handleMessage({ type: 'request', seq: 7, command: 'attach', arguments: {} }); await started(x.adapter);
  assert.deepEqual(f.calls.map(call => call.args), [['shell', 'pidof', '-s', 'com.example.app'], ['forward', 'tcp:0', 'jdwp:42']]);
  const sent = JSON.parse(x.writes[0].subarray(x.writes[0].indexOf('\r\n\r\n') + 4));
  assert.equal(sent.command, 'attach'); assert.equal(sent.arguments.port, 4567);
  await x.adapter.close(); assert.deepEqual(f.calls.at(-1).args, ['forward', '--remove', 'tcp:4567']);
});

test('Android launch forwards exact PID and preserves backend DAP response and UTF8 frames', async () => {
  const f = fixture(), x = childFixture(f);
  x.adapter.handleMessage({ type: 'request', seq: 7, command: 'launch', arguments: {} });
  await started(x.adapter);
  assert.equal(f.calls[0].args.includes('-W'), false);
  assert.deepEqual(f.calls.map(call => call.args), [
    ['shell', 'am', 'start', '-D', '-n', 'com.example.app/.MainActivity'],
    ['shell', 'pidof', 'com.example.app'], ['forward', 'tcp:0', 'jdwp:42'],
  ]);
  const sent = JSON.parse(x.writes[0].subarray(x.writes[0].indexOf('\r\n\r\n') + 4));
  assert.equal(sent.command, 'attach'); assert.equal(sent.arguments.port, 4567);
  const response = frame({ type: 'response', seq: 1, request_seq: 7, command: 'attach', success: true });
  x.child.stdout.write(response.subarray(0, 9)); x.child.stdout.write(response.subarray(9));
  assert.equal(x.output[0].command, 'launch'); assert.equal(x.output[0].success, true);
  const event = { type: 'event', seq: 2, event: 'output', body: { output: '中文' } };
  x.child.stdout.write(Buffer.concat([frame(event), frame({ type: 'event', seq: 3, event: 'initialized' })]));
  assert.equal(x.output[1].body.output, '中文'); assert.equal(x.output[2].event, 'initialized');
  const close = x.adapter.close(); assert.equal(close, x.adapter.close()); await close;
  assert.deepEqual(f.calls.at(-1).args, ['forward', '--remove', 'tcp:4567']); assert.equal(f.kills, 1);
});

test('Android attach owns forward and refuses ambiguous launch process or ADB failures', async () => {
  const f = fixture(), x = childFixture(f, { android: true, serial: 'phone', pid: 52 });
  x.adapter.handleMessage({ type: 'request', seq: 1, command: 'attach', arguments: {} }); await started(x.adapter);
  assert.deepEqual(f.calls[0].args, ['forward', 'tcp:0', 'jdwp:52']); await x.adapter.close();
  for (const failure of ['ambiguous', 'adb']) {
    const g = fixture(), y = childFixture(g);
    g.adb = async args => { if (failure === 'adb') throw new Error('ADB denied'); return args.includes('pidof') ? '42 43' : 'Status: ok'; };
    y.adapter.handleMessage({ type: 'request', seq: 2, command: 'launch', arguments: {} }); await started(y.adapter);
    assert.equal(y.output[0].success, false); assert.match(y.output[0].message, failure === 'adb' ? /ADB denied/ : /exactly one/);
    assert.equal(y.writes.length, 0); await y.adapter.close();
  }
});

test('Android startup cancellation after forward awaits ownership and removes only allocated port', async () => {
  const f = fixture(), x = childFixture(f, { android: true, serial: 'phone', pid: 42 });
  let resolveForward;
  f.adb = async args => args[1] === 'tcp:0' ? new Promise(resolve => { resolveForward = resolve; }) : '';
  x.adapter.handleMessage({ type: 'request', seq: 1, command: 'attach', arguments: {} });
  const closing = x.adapter.close(); resolveForward('4567'); await closing;
  assert.equal(x.output.find(message => message.request_seq === 1).success, false);
  assert.deepEqual(f.calls.at(-1).args, ['forward', '--remove', 'tcp:4567']); assert.equal(x.writes.length, 0);
});

/** 后端终止/断开都必须释放forward，终止事件只发一次且保留原body。 */
test('Android backend termination and disconnect response close the owned JAR and forward', async () => {
  for (const event of [true, false]) {
    const f = fixture(), x = childFixture(f, { android: true, serial: 'phone', pid: 42 });
    x.adapter.handleMessage({ type: 'request', seq: 1, command: 'attach', arguments: {} }); await started(x.adapter);
    if (!event) x.adapter.handleMessage({ type: 'request', seq: 2, command: 'disconnect', arguments: {} });
    x.child.stdout.write(frame(event ? { type: 'event', seq: 3, event: 'terminated', body: { restart: false } } : { type: 'response', seq: 3, request_seq: 2, command: 'disconnect', success: true }));
    await x.adapter.close(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.kills, 1); assert.deepEqual(f.calls.at(-1).args, ['forward', '--remove', 'tcp:4567']);
    assert.equal(x.output.filter(message => message.event === 'terminated').length, 1);
    if (event) assert.equal(x.output.find(message => message.event === 'terminated').body.restart, false);
    else assert.equal(x.output.find(message => message.request_seq === 2).success, true);
  }
});

test('Android cleanup and malformed transport errors remain visible', async () => {
  const f = fixture(), x = childFixture(f, { android: true, serial: 'phone', pid: 42 });
  x.adapter.handleMessage({ type: 'request', seq: 1, command: 'attach', arguments: {} }); await started(x.adapter);
  f.adb = async args => { if (args[1] === '--remove') throw new Error('remove denied'); return '4567'; };
  await assert.rejects(x.adapter.close(), /cleanup/);
  const g = fixture(), y = childFixture(g);
  y.child.stdout.write(Buffer.from('Broken: 1\r\n\r\nx')); await y.adapter.close();
  assert.match(String(g.errors[0]), /Content-Length/);
});

/** 上游JDK探测真实实现的边界回归，拒绝旧Java/JRE并验证17+/21与版本解析。 */
test('upstream JDK discovery requires Java 17 and jdk.jdi without invoking shells', async () => {
  const source = transformSync(fs.readFileSync('src/android-debugger/jvm-debugger/java.ts', 'utf8'), { loader: 'ts', format: 'cjs' }).code;
  for (const [version, jdi, accepted] of [[8, true, false], [17, false, false], [17, true, true], [21, true, true]]) {
    const module = { exports: {} }, calls = [];
    const deps = {
      fs: { existsSync: file => file === path.join('/jdk', 'bin', process.platform === 'win32' ? 'java.exe' : 'java') },
      child_process: { execFile(command, args, options, callback) { calls.push({ command, args }); callback(null, args[0] === '-version' ? `openjdk version "${version}.0.1"` : jdi ? `jdk.jdi@${version}` : 'java.base@17', ''); } },
    };
    vm.runInNewContext(source, { module, exports: module.exports, require: id => deps[id] ?? require(id), process: { platform: process.platform, env: { JAVA_HOME: '/jdk', PATH: '' } } });
    assert.equal(module.exports.parseJavaVersion('java version "1.8.0_402"'), 8);
    assert.equal(module.exports.parseJavaVersion('openjdk version "21.0.4"'), 21);
    assert.equal(module.exports.parseJavaVersion('not java'), 0);
    if (accepted) {
      const runtime = await module.exports.findJava(undefined); assert.equal(runtime.version, version);
      await module.exports.findJava(undefined); assert.equal(calls.length, 2);
    } else await assert.rejects(module.exports.findJava(undefined), /No suitable JDK/);
    assert.ok(calls.every(call => call.command.endsWith(process.platform === 'win32' ? 'java.exe' : 'java')));
  }
});

/** 追踪仅记录不修改DAP，退出异常必须可见；默认不输出敏感协议内容。 */
test('JVM tracker preserves tracing switch and surfaces adapter crashes', () => {
  const f = fixture(), lines = []; let shown = 0;
  const factory = new f.api.JvmTrackerFactory({ appendLine: line => lines.push(line), show: () => shown++ });
  let tracker = factory.createDebugAdapterTracker();
  tracker.onWillReceiveMessage({ command: 'initialize' }); assert.equal(lines.length, 0);
  f.vscode.workspace.getConfiguration = () => ({ get: () => true });
  tracker = factory.createDebugAdapterTracker();
  tracker.onWillReceiveMessage({ command: 'threads' }); tracker.onDidSendMessage({ body: { threads: [] } });
  tracker.onError(new Error('transport failed')); tracker.onExit(2, undefined);
  assert.match(lines[0], /threads/); assert.match(lines[1], /threads/); assert.match(lines[2], /transport failed/); assert.equal(shown, 1);
});

/** 扩展停用释放每个Android子进程，不能只释放注册句柄；两个会话资源均须结算。 */
test('JVM factory owns Android adapter processes across extension disposal', async () => {
  const f = fixture(), factory = new f.api.JvmAdapterFactory({ asAbsolutePath: value => '/extension/' + value });
  const children = [];
  for (const id of ['first', 'second']) {
    const child = new EventEmitter();
    Object.assign(child, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
    child.kill = () => { child.killed = true; child.emit('close', 0); return true; };
    children.push(child); f.child = child;
    const descriptor = await factory.createDebugAdapterDescriptor({ id, configuration: { android: true, serial: 'phone', pid: 42 } });
    assert.equal(typeof descriptor.implementation.handleMessage, 'function');
  }
  await factory.dispose();
  assert.ok(children.every(child => child.killed));
  assert.equal(f.errors.length, 0);
});

test('JVM factory uses bundled JAR with upstream arguments and rejects missing JAR', async () => {
  const f = fixture(), context = { asAbsolutePath: value => '/extension/' + value };
  const factory = new f.api.JvmAdapterFactory(context);
  const session = { id: 'session', configuration: {}, workspaceFolder: undefined };
  const descriptor = await factory.createDebugAdapterDescriptor(session);
  assert.equal(descriptor.command, '/jdk/bin/java');
  assert.equal(descriptor.args[0], '-Xmx512m'); assert.equal(descriptor.args[1], '-jar');
  assert.equal(descriptor.args[2], '/extension/resources/jvm-debugger/kotlin-debug-adapter.jar');
  assert.ok(descriptor.args.includes('--log-file'));
  f.vscode.workspace.getConfiguration = section => {
    assert.equal(section, 'android-ide.jvmDebugger');
    return { get: (key, fallback) => ({ javaHome: '/custom-jdk', adapterJvmArgs: ['-Xmx768m'], logLevel: 'DEBUG' })[key] ?? fallback };
  };
  const configured = await factory.createDebugAdapterDescriptor(session);
  assert.equal(f.javaHome, '/custom-jdk'); assert.equal(configured.args[0], '-Xmx768m');
  assert.equal(configured.args[configured.args.indexOf('--log-level') + 1], 'DEBUG');
  f.exists = false; await assert.rejects(factory.createDebugAdapterDescriptor(session), /missing/);
  await factory.dispose();
});
