const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const { transformSync } = require('esbuild');
const unzipper = require('unzipper');
const { EventEmitter } = require('node:events');

const root = path.resolve(__dirname, '..');
const fixtureRoot = path.join(root, 'tests', 'fixtures', 'android-debugger');
const javaSource = path.join(fixtureRoot, 'java/dev/androidtools/debugfixture/DebugActivity.java');
const nativeSource = path.join(fixtureRoot, 'native/debugfixture.c');
const packageName = 'dev.androidtools.debugfixture';
const serial = process.env.ANDROID_MIXED_DEVICE_SERIAL;
const optIn = process.env.ANDROID_MIXED_DEVICE_TEST === '1';
const artifacts = path.join(root, '.test-artifacts', 'android-debugger');

/** 执行真实 adb argv 并记录设备返回；输入命令参数，输出成功文本，非零退出原样失败。 */
function adbText(adb, args, transcript) {
  try {
    const stdout = execFileSync(adb, ['-s', serial, ...args], { encoding: 'utf8', timeout: 20000, windowsHide: true });
    transcript.push({ direction: 'adb', args, stdout });
    return stdout.trim();
  } catch (error) {
    const result = { args, status: error.status, stdout: String(error.stdout || ''), stderr: String(error.stderr || ''), message: error.message };
    transcript.push({ direction: 'adb-error', ...result });
    throw new Error(JSON.stringify(result));
  }
}

/** 递归编译真实生产 TypeScript，仅注入最小 vscode API；不替换 DAP、ADB、LLDB 或任一子适配器。 */
function loadTs(file, vscode, modules = new Map()) {
  if (modules.has(file)) return modules.get(file).exports;
  const module = { exports: {} };
  modules.set(file, module);
  const localRequire = id => id === 'vscode'
    ? vscode
    : id.startsWith('.')
      ? loadTs(path.resolve(path.dirname(file), id) + '.ts', vscode, modules)
      : require(id);
  const code = transformSync(fs.readFileSync(file, 'utf8'), { loader: 'ts', format: 'cjs', target: 'node22' }).code;
  vm.runInNewContext(code, { module, exports: module.exports, require: localRequire, process, Buffer, AbortController, AbortSignal, AggregateError, structuredClone, console, setTimeout, clearTimeout, setInterval, clearInterval, __dirname: path.dirname(file) });
  return module.exports;
}

/** 从父级签名 APK 提取真实 arm64 DWARF 库；输入目标目录，输出 LLDB 符号目录并校验 ELF/源码名。 */
async function extractSymbols(destination, apk) {
  fs.mkdirSync(destination, { recursive: true });
  const archive = await unzipper.Open.file(apk);
  const entry = archive.files.find(file => file.path === 'lib/arm64-v8a/libdebugfixture.so');
  assert.ok(entry, 'signed fixture APK lacks arm64 native library');
  const so = path.join(destination, 'libdebugfixture.so');
  fs.writeFileSync(so, await entry.buffer());
  const bytes = fs.readFileSync(so);
  assert.equal(bytes.readUInt32BE(0), 0x7f454c46);
  assert.equal(bytes[4], 2);
  assert.ok(bytes.includes(Buffer.from('.debug_info')), 'native library lacks DWARF');
  assert.ok(bytes.includes(Buffer.from('debugfixture.c')), 'native library lacks fixture source');
  return destination;
}

/** 等待真实混合 DAP 响应或事件；输入 predicate 和事件队列，输出首次匹配消息，不使用延时轮询。 */
function waiter(state, predicate) {
  if (state.closed) return Promise.reject(state.closed);
  const found = state.events.findIndex(predicate);
  if (found >= 0) return Promise.resolve(state.events.splice(found, 1)[0]);
  return new Promise((resolve, reject) => state.waiters.push({ predicate, resolve, reject }));
}

/** 读取源码 marker 的可执行下一行；输入源码与注释标记，输出真实断点行并校验锚点未漂移。 */
/** 启动混合会话的配置屏障：输入 initialized 事件流和 attach Promise，输出成功或保留原始失败响应，避免真实错误变成无界等待。 */
async function awaitMixedStartup(session, attach) {
  const startup = await Promise.race([
    session.event(message => message.event === 'initialized').then(() => ({ initialized: true })),
    attach.then(response => {
      if (response?.success === false) return { error: Object.assign(new Error(response.message || 'Mixed attach failed'), { response }) };
      return { initialized: false };
    }, error => ({ error })),
  ]);
  if (startup.error) throw startup.error;
  if (!startup.initialized) await session.event(message => message.event === 'initialized');
}

/** 读取源码 marker 的可执行下一行；输入源码与注释标记，输出真实断点行并校验锚点未漂移。 */
function markerLine(file, marker, offset = 1) {
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  const index = lines.findIndex(line => line.includes(marker));
  assert.ok(index >= 0, 'fixture marker missing: ' + marker);
  return index + 1 + offset;
}

/** 绑定一个真实 Mixed DAP 会话；输入生产类、运行配置和会话目录，输出请求/事件/清理状态。 */
function createSession(classes, config, context, record) {
  const VscodeEmitter = class {
    constructor() { this.events = new EventEmitter(); }
    event = listener => { this.events.on('message', listener); return { dispose: () => this.events.off('message', listener) }; }
    fire(message) { this.events.emit('message', message); }
    dispose() { this.events.removeAllListeners(); }
  };
  const vscode = {
    EventEmitter: VscodeEmitter,
    Uri: { file: fsPath => ({ fsPath }) },
    workspace: { isTrusted: true, getWorkspaceFolder: uri => ({ uri }) },
  };
  const jvm = new classes.AndroidJvmDebugAdapter(context, {
    configuration: config,
    workspaceFolder: { uri: { fsPath: root } },
  });
  const native = new classes.NativeDebugAdapter(context, { ...config, androidMode: 'native' }, root);
  const adapter = new classes.MixedDebugAdapter(jvm, native, config);
  const state = { events: [], waiters: [], replies: new Map(), sequence: 1, adapter, jvm, native, closed: undefined };
  /** 结束真实会话并拒绝所有挂起等待；输入关闭原因，输出幂等清理信号，防止 timeout 遗留 child/waiter。 */
  state.close = error => {
    if (state.closed) return;
    state.closed = error instanceof Error ? error : new Error(String(error));
    for (const waiter of state.waiters.splice(0)) waiter.reject(state.closed);
    for (const pending of state.replies.values()) pending.reject(state.closed);
    state.replies.clear();
  };
  adapter.onDidSendMessage(message => {
    record({ direction: 'dap-in', message });
    if (message.type === 'event' && message.event === 'output' && /DAP backend closed|backend closed/i.test(String(message.body?.output || ''))) {
      state.close(new Error(String(message.body.output)));
    }
    if (message.type === 'response') {
      const pending = state.replies.get(message.request_seq);
      if (pending) { state.replies.delete(message.request_seq); pending.resolve(message); }
      return;
    }
    if (message.type === 'event') {
      const index = state.waiters.findIndex(item => item.predicate(message));
      if (index >= 0) state.waiters.splice(index, 1)[0].resolve(message);
      else if (!state.closed) state.events.push(message);
    }
  });
  /** 发送混合前端请求并保留真实 response；输入 DAP command/arguments，输出成功响应或原始失败。 */
  state.request = (command, args = {}) => {
    const seq = state.sequence++;
    if (state.closed) return Promise.reject(state.closed);
    const response = new Promise((resolve, reject) => state.replies.set(seq, { resolve, reject }));
    const message = { type: 'request', seq, command, arguments: args };
    record({ direction: 'dap-out', message });
    adapter.handleMessage(message);
    return response;
  };
  state.event = predicate => waiter(state, predicate);
  state.abort = async reason => { state.close(reason || new Error('Mixed test cancelled')); await adapter.dispose(); };
  return state;
}

/** 本地生命周期回归：dispose/abort 必须拒绝 awaitEvent，避免真机超时后遗留 pending waiter 或 child。 */
test('mixed session abort settles pending event without device', async () => {
  class FakeChild {
    constructor() { this.emitter = new EventEmitter(); this.onDidSendMessage = listener => { this.emitter.on('message', listener); return { dispose: () => this.emitter.off('message', listener) }; }; }
    async beginSuspended() { throw new Error('unused'); }
    async requestBackend() { return { success: true, body: {} }; }
    handleMessage() {}
    async dispose() {}
  }
  class FakeMixed {
    constructor() { this.emitter = new EventEmitter(); this.onDidSendMessage = listener => { this.emitter.on('message', listener); return { dispose: () => this.emitter.off('message', listener) }; }; }
    async dispose() { this.disposed = true; }
  }
  const session = createSession({ AndroidJvmDebugAdapter: FakeChild, NativeDebugAdapter: FakeChild, MixedDebugAdapter: FakeMixed }, {}, {}, () => {});
  const reason = new Error('deterministic cancellation');
  const pending = session.event(() => true);
  await session.abort(reason);
  await assert.rejects(pending, error => error === reason);
  assert.equal(session.adapter.disposed, true);
});

/** 启动屏障回归：失败 response/reject 必须保留诊断，initialized 先到和 attach 成功先到均不误报；不访问设备。 */
test('mixed startup barrier settles DAP attach failures and success ordering', async () => {
  const deferred = () => { let resolve; let reject; const promise = new Promise((res, rej) => { resolve = res; reject = rej; }); return { promise, resolve, reject }; };
  const event = deferred();
  const failed = { success: false, message: 'jdwp closed' };
  await assert.rejects(awaitMixedStartup({ event: () => event.promise }, Promise.resolve(failed)), error => error.response === failed);
  const rejected = new Error('transport closed');
  await assert.rejects(awaitMixedStartup({ event: () => new Promise(() => {}) }, Promise.reject(rejected)), error => error === rejected);
  const initialized = deferred();
  initialized.resolve({ event: 'initialized' });
  await awaitMixedStartup({ event: () => initialized.promise }, new Promise(() => {}));
  const attachFirst = deferred();
  const initializedLater = deferred();
  const success = awaitMixedStartup({ event: () => initializedLater.promise }, attachFirst.promise);
  attachFirst.resolve({ success: true });
  initializedLater.resolve({ event: 'initialized' });
  await success;
});

/** 真实设备 MixedDebugAdapter 验收：外部 suspended 同 PID 同时交给 JVM/Native，验证 Java/JNI、引用路由、step 与双边清理。 */
test('authorized Android Mixed JVM and Native device regression', { skip: !optIn, timeout: 120000 }, async t => {
  assert.ok(serial, 'ANDROID_MIXED_DEVICE_SERIAL is required with ANDROID_MIXED_DEVICE_TEST=1');
  const sdk = process.env.ANDROID_SDK_ROOT || process.env.ANDROID_HOME;
  assert.ok(sdk, 'Explicit ANDROID_SDK_ROOT or ANDROID_HOME is required');
  const adb = process.env.ADB || path.join(sdk, 'platform-tools', process.platform === 'win32' ? 'adb.exe' : 'adb');
  const apk = process.env.ANDROID_MIXED_DEVICE_APK || path.join(artifacts, 'fixture/debugfixture.apk');
  for (const file of [adb, apk, javaSource, nativeSource]) assert.ok(fs.existsSync(file), 'missing dependency: ' + file);
  fs.mkdirSync(artifacts, { recursive: true });
  const run = fs.mkdtempSync(path.join(artifacts, 'mixed-device-'));
  const transcriptFile = path.join(run, 'dap.jsonl');
  const diagnosticFile = path.join(run, 'diagnostic.json');
  const symbols = await extractSymbols(path.join(run, 'symbols'), apk);
  const transcript = [];
  let session;
  let deviceTouched = false;
  let pid;
  let baseline;
  let failure;
  let onAbort;
  const config = {
    androidProjectRoot: root,
    androidModuleRoot: fixtureRoot,
    androidSourceRoots: [path.join(fixtureRoot, 'java')],
    androidNativeSymbolDirs: [symbols],
    serial,
    packageName,
  };
  const javaLine = markerLine(javaSource, 'System.loadLibrary', 0);
  const javaAfterLoadLine = javaLine + 1;
  const nativeLine = markerLine(nativeSource, 'NATIVE_BREAKPOINT', 1);
  const record = item => { transcript.push(item); fs.appendFileSync(transcriptFile, JSON.stringify(item) + '\n'); };
  try {
    const initial = execFileSync(adb, ['-s', serial, 'get-state'], { encoding: 'utf8', timeout: 20000, windowsHide: true }).trim();
    assert.equal(initial, 'device');
    baseline = adbText(adb, ['forward', '--list'], transcript);
    deviceTouched = true;
    adbText(adb, ['install', '-r', apk], transcript);
    const component = adbText(adb, ['shell', 'cmd', 'package', 'resolve-activity', '--brief', '-a', 'android.intent.action.MAIN', '-c', 'android.intent.category.LAUNCHER', packageName], transcript).split(/\r?\n/).find(line => line.startsWith(packageName + '/'));
    assert.ok(component, 'fixture launcher component unresolved');
    adbText(adb, ['shell', 'am', 'force-stop', packageName], transcript);
    // 外部 -D 与 native extra 必须先建立同一 suspended PID，Mixed 只 attach，不重启或替换目标。
    adbText(adb, ['shell', 'am', 'start', '-D', '-n', component, '--ez', 'native', 'true'], transcript);
    const pidText = adbText(adb, ['shell', 'pidof', '-s', packageName], transcript);
    assert.match(pidText, /^\d+$/);
    pid = Number(pidText);
    const VscodeEmitter = class {
      constructor() { this.events = new EventEmitter(); }
      event = listener => { this.events.on('message', listener); return { dispose: () => this.events.off('message', listener) }; }
      fire(message) { this.events.emit('message', message); }
      dispose() { this.events.removeAllListeners(); }
    };
    const vscode = { EventEmitter: VscodeEmitter, Uri: { file: fsPath => ({ fsPath }) }, workspace: { isTrusted: true, getWorkspaceFolder: uri => ({ uri }) } };
    const classes = {
      ...loadTs(path.join(root, 'src/android-debugger/jvm-debugger/adapter.ts'), vscode),
      ...loadTs(path.join(root, 'src/android-debugger/native-debugger/adapter.ts'), vscode),
      ...loadTs(path.join(root, 'src/android-debugger/jvm-native-debugger/adapter.ts'), vscode),
    };
    const context = { extensionPath: root, globalStorageUri: { fsPath: run } };
    session = createSession(classes, { ...config, androidMode: 'jvm-native' }, context, record);
    onAbort = () => { void session.abort(t.signal.reason || new Error('Mixed test cancelled')); };
    t.signal.addEventListener('abort', onAbort, { once: true });
    const send = async (command, args = {}) => {
      const response = await session.request(command, args);
      record({ direction: 'asserted-response', command, response });
      assert.equal(response.success, true, response.message || command);
      return response.body;
    };
    await send('initialize', { adapterID: 'android-tools-mixed-device', clientID: 'authorized-device-test', linesStartAt1: true, columnsStartAt1: true, pathFormat: 'path' });
    const attach = session.request('attach', { serial, packageName, pid, androidProjectRoot: root, androidModuleRoot: fixtureRoot, androidSourceRoots: [path.join(fixtureRoot, 'java')], androidNativeSymbolDirs: [symbols] });
    // 启动屏障同时观察 initialized 与 attach 错误；真实 JDWP 拒绝应立即失败，不能放大成超时。
    await awaitMixedStartup(session, attach);
    const javaBp = await send('setBreakpoints', { source: { path: javaSource }, breakpoints: [{ line: javaLine }] });
    assert.equal(javaBp.breakpoints.length, 1);
    assert.equal(javaBp.breakpoints[0].line, javaLine);
    const nativeBp = await send('setBreakpoints', { source: { path: nativeSource }, breakpoints: [{ line: nativeLine }] });
    assert.equal(nativeBp.breakpoints.length, 1);
    assert.equal(nativeBp.breakpoints[0].line, nativeLine);
    await send('configurationDone');
    await attach;
    const javaStopped = await session.event(message => message.event === 'stopped' && message.body?.reason === 'breakpoint');
    const javaThreads = await send('threads');
    assert.ok(javaThreads.threads.some(thread => thread.id === javaStopped.body.threadId), 'Java stopped thread must be mixed-owned');
    const javaStack = await send('stackTrace', { threadId: javaStopped.body.threadId, startFrame: 0, levels: 20 });
    const javaFrame = javaStack.stackFrames.find(frame => frame.source?.path && path.basename(frame.source.path) === path.basename(javaSource));
    assert.ok(javaFrame, 'Java source frame missing');
    assert.equal(javaFrame.line, javaLine);
    assert.match(javaFrame.name, /onCreate/);
    const javaScopes = await send('scopes', { frameId: javaFrame.id });
    const javaLocal = javaScopes.scopes.find(scope => /local/i.test(scope.name));
    assert.ok(javaLocal?.variablesReference > 0, 'Java local scope missing');
    const javaVars = await send('variables', { variablesReference: javaLocal.variablesReference });
    assert.ok(javaVars.variables.length > 0, 'Java locals missing');
    // Java 第23行停在 loadLibrary 执行前；必须用真实 next 走到第24行，才能证明 JNI 库已加载。
    await send('next', { threadId: javaStopped.body.threadId });
    const javaAfterLoad = await session.event(message => message.event === 'stopped' && message.body?.reason === 'step');
    const javaAfterLoadStack = await send('stackTrace', { threadId: javaAfterLoad.body.threadId, startFrame: 0, levels: 20 });
    const javaAfterLoadFrame = javaAfterLoadStack.stackFrames.find(frame => frame.source?.path && path.basename(frame.source.path) === path.basename(javaSource));
    assert.ok(javaAfterLoadFrame, 'Java post-load source frame missing');
    assert.equal(javaAfterLoadFrame.line, javaAfterLoadLine);
    assert.match(javaAfterLoadFrame.name, /onCreate/);
    const refreshedNativeBp = await send('setBreakpoints', { source: { path: nativeSource }, breakpoints: [{ line: nativeLine }] });
    assert.equal(refreshedNativeBp.breakpoints[0].verified, true, 'native pending breakpoint did not resolve after JNI load');
    await send('continue', { threadId: javaAfterLoad.body.threadId });
    const nativeStopped = await session.event(message => message.event === 'stopped' && message.body?.reason === 'breakpoint');
    const nativeThreads = await send('threads');
    assert.ok(nativeThreads.threads.some(thread => thread.id === nativeStopped.body.threadId), 'Native stopped thread must be mixed-owned');
    assert.notEqual(nativeStopped.body.threadId, javaStopped.body.threadId, 'mixed child thread references must not collide');
    const nativeStack = await send('stackTrace', { threadId: nativeStopped.body.threadId, startFrame: 0, levels: 20 });
    const nativeFrame = nativeStack.stackFrames.find(frame => frame.source?.path && path.basename(frame.source.path) === path.basename(nativeSource));
    assert.ok(nativeFrame, 'Native source frame missing');
    assert.equal(nativeFrame.line, nativeLine);
    assert.match(nativeFrame.name, /nativeMarker/);
    const nativeScopes = await send('scopes', { frameId: nativeFrame.id });
    const nativeLocal = nativeScopes.scopes.find(scope => /local/i.test(scope.name));
    assert.ok(nativeLocal?.variablesReference > 0, 'Native local scope missing');
    const nativeVars = await send('variables', { variablesReference: nativeLocal.variablesReference });
    assert.equal(nativeVars.variables.find(variable => variable.name === 'value')?.value, '41');
    await send('next', { threadId: nativeStopped.body.threadId });
    const nativeNext = await session.event(message => message.event === 'stopped' && message.body?.reason === 'step');
    const nativeNextStack = await send('stackTrace', { threadId: nativeNext.body.threadId, startFrame: 0, levels: 20 });
    const nativeNextFrame = nativeNextStack.stackFrames.find(frame => frame.source?.path && path.basename(frame.source.path) === path.basename(nativeSource));
    assert.ok(nativeNextFrame);
    const nativeNextScopes = await send('scopes', { frameId: nativeNextFrame.id });
    const nativeNextLocal = nativeNextScopes.scopes.find(scope => /local/i.test(scope.name));
    const nativeNextVars = await send('variables', { variablesReference: nativeNextLocal.variablesReference });
    assert.equal(nativeNextVars.variables.find(variable => variable.name === 'value')?.value, '42');
    await send('continue', { threadId: nativeNext.body.threadId });
    assert.equal(await send('disconnect', { terminateDebuggee: false }).then(() => adbText(adb, ['shell', 'pidof', '-s', packageName], transcript)), String(pid));
  } catch (error) {
    failure = error;
    fs.writeFileSync(diagnosticFile, JSON.stringify({ error: { message: error.message, stack: error.stack }, serial, pid, transcript }, null, 2));
    throw error;
  } finally {
    const cleanupErrors = [];
    if (onAbort) t.signal.removeEventListener('abort', onAbort);
    try { if (session) await session.abort(new Error('Mixed test cleanup')); } catch (error) { cleanupErrors.push(error); }
    if (deviceTouched) {
      try { adbText(adb, ['shell', 'am', 'force-stop', packageName], transcript); } catch (error) { cleanupErrors.push(error); }
      try {
        const current = adbText(adb, ['forward', '--list'], transcript);
        assert.equal(current, baseline, 'mixed session changed unowned adb forwards');
      } catch (error) { cleanupErrors.push(error); }
    }
    try { fs.writeFileSync(path.join(run, 'resources.json'), JSON.stringify({ serial, pid, baseline, transcript, cleanupErrors: cleanupErrors.map(error => String(error)) }, null, 2)); } catch (error) { cleanupErrors.push(error); }
    t.diagnostic('Mixed DAP transcript: ' + transcriptFile);
    if (cleanupErrors.length) throw new AggregateError(failure ? [failure, ...cleanupErrors] : cleanupErrors, 'Mixed cleanup failed');
  }
});
