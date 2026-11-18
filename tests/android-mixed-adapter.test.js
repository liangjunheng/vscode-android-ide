const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { transformSync } = require('esbuild');

/** 真实 coordinator 加载到 VM，仅替换两个子 DAP 边界；具名用例断言启动屏障和真实请求输出。 */
function fixture(options = {}) {
  class Emitter {
    listeners = new Set();
    event = callback => { this.listeners.add(callback); return { dispose: () => this.listeners.delete(callback) }; };
    fire(value) { for (const listener of this.listeners) listener(value); }
    dispose() { this.listeners.clear(); }
  }
  const module = { exports: {} };
  vm.runInNewContext(transformSync(fs.readFileSync('src/android-debugger/jvm-native-debugger/adapter.ts', 'utf8'), { loader: 'ts', format: 'cjs' }).code,
    { module, exports: module.exports, require: id => id === 'vscode' ? { EventEmitter: Emitter } : require(id), AbortController, AggregateError });
  const calls = [], output = [], waits = new Map(); let seq = 100, launchResolve, launchReject, nativeAttach;
  let launched;
  const jvmEvents = new Emitter(), nativeEvents = new Emitter();
  const success = (body = {}) => ({ success: true, body });
  const body = (owner, command) => command === 'threads' ? { threads: [{ id: 7, name: owner }] } : command === 'stackTrace' ? { stackFrames: [{ id: 7, name: owner, source: { path: owner === 'jvm' ? '/Main.kt' : '/lib.rs', sourceReference: 7 } }] } : command === 'scopes' ? { scopes: [{ name: owner, variablesReference: 7 }] } : command === 'variables' ? { variables: [{ name: owner, value: '42', variablesReference: 7 }] } : command === 'setBreakpoints' ? { breakpoints: [{ id: 7, verified: true }] } : { owner, command };
  const jvm = {
    onDidSendMessage: jvmEvents.event,
    async beginSuspended(args, launch) {
      calls.push(['jvm-begin', args, launch]);
      if (options.prepareError) throw new Error(options.prepareError);
      launched = new Promise((resolve, reject) => { launchResolve = resolve; launchReject = reject; });
      jvmEvents.fire({ type: 'event', seq: 1, event: 'initialized' });
      return { target: { serial: 'phone', packageName: 'com.example.app', pid: 4321 }, response: launched, setup: Promise.resolve() };
    },
    async requestBackend(command, args) {
      calls.push(['jvm', command, args]);
      if (command === 'configurationDone') { launchResolve(success({ actual: 'jvm-attach' })); return success({ actual: 'jvm-configured' }); }
      if (command === 'initialize') return success({ supportsConfigurationDoneRequest: true, supportsSetVariable: true, supportsStepBack: false, backendOnly: true });
      return success(body('jvm', command));
    },
    handleMessage(message) {
      calls.push(['jvm-message', message]);
      if (message.type === 'request') jvmEvents.fire({ ...success(), type: 'response', seq: 1, request_seq: message.seq, command: message.command });
    },
    async dispose() { calls.push(['jvm-dispose']); launchReject?.(new Error('JVM disposed')); if (options.jvmDisposeError) throw new Error('JVM cleanup failed'); },
  };
  const native = {
    onDidSendMessage: nativeEvents.event,
    handleMessage(message) {
      calls.push(['native', message.command, message.arguments, message]);
      if (message.type !== 'request') return;
      const answer = (bodyValue = {}) => nativeEvents.fire({ type: 'response', seq: 1, request_seq: message.seq, command: message.command, success: true, body: bodyValue });
      if (message.command === 'attach') {
        nativeAttach = message;
        if (options.attachError) { nativeEvents.fire({ type: 'response', seq: 1, request_seq: message.seq, command: 'attach', success: false, message: 'native attach rejected', body: { error: { id: 91 } } }); return; }
        nativeEvents.fire({ type: 'event', seq: 1, event: 'initialized' }); return;
      }
      if (message.command === 'configurationDone' && options.configurationError) { nativeEvents.fire({ type: 'response', seq: 1, request_seq: message.seq, command: message.command, success: false, message: 'native configuration failed' }); return; }
      if (message.command === 'configurationDone') {
        calls.push(['native-resumed']);
        nativeEvents.fire({ type: 'response', seq: 1, request_seq: nativeAttach.seq, command: 'attach', success: true, body: { actual: 'native-attach' } });
        answer({ actual: 'native-configured' }); return;
      }
      if (message.command === 'initialize') { answer({ supportsConfigurationDoneRequest: true, supportsSetVariable: true, supportsStepBack: true }); return; }
      if (options.commandError === message.command) { nativeEvents.fire({ type: 'response', seq: 9, request_seq: message.seq, command: message.command, success: false, message: 'actual native failure', body: { error: { id: 92 } } }); return; }
      answer(body('native', message.command));
    },
    async dispose() { calls.push(['native-dispose']); if (options.nativeDisposeError) throw new Error('Native cleanup failed'); },
  };
  const adapter = new module.exports.MixedDebugAdapter(jvm, native, { androidProjectRoot: '/project' });
  adapter.onDidSendMessage(message => { output.push(message); if (message.type === 'response') { waits.get(message.request_seq)?.(message); waits.delete(message.request_seq); } });
  /** 每个请求等待对应 request_seq，不以时延/轮询判断成功；routing/startup 各用例共享。 */
  function request(command, args = {}) {
    const id = seq++;
    const result = new Promise(resolve => waits.set(id, resolve));
    adapter.handleMessage({ type: 'request', seq: id, command, arguments: args });
    return result;
  }
  /** 只等待协调器真实 Native initialized 事件，允许 launch response 继续等待 configurationDone。 */
  function ready() {
    if (output.some(message => message.event === 'initialized')) return Promise.resolve();
    return new Promise(resolve => { const subscription = adapter.onDidSendMessage(message => { if (message.event === 'initialized') { subscription.dispose(); resolve(); } }); });
  }
  return { adapter, calls, output, request, ready, jvmEvents, nativeEvents };
}

// startup：两个实际 attach 响应都等配置；不提前合成 launch 成功，Native 先恢复，JVM 后恢复。
for (const command of ['launch', 'attach']) test('startup exact JVM PID and configuration barriers for ' + command, async () => {
  const f = fixture();
  try {
    const init = await f.request('initialize'); assert.equal(init.success, true);
    assert.deepEqual(JSON.parse(JSON.stringify(init.body)), { supportsConfigurationDoneRequest: true, supportsSetVariable: true });
    const launch = f.request(command, { serial: 'ignored-by-verified-target', pid: command === 'attach' ? 4321 : undefined });
    await f.ready();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.output.filter(message => message.event === 'initialized').length, 1);
    assert.equal(f.output.some(message => message.command === command && message.type === 'response'), false);
    const actual = f.calls.find(call => call[0] === 'native' && call[1] === 'attach')[2];
    assert.equal(actual.pid, 4321); assert.equal(actual.processId, 4321); assert.equal(actual.serial, 'phone'); assert.equal(actual.packageName, 'com.example.app');
    assert.equal(actual.androidMode, 'native'); assert.equal(actual.androidProjectRoot, '/project');
    assert.equal(f.calls.filter(call => call[0] === 'jvm-begin').length, 1); assert.equal(f.calls.find(call => call[0] === 'jvm-begin')[2], command === 'launch');
    assert.equal(f.calls.some(call => call[0] === 'native' && call[1] === 'launch'), false);
    const configured = await f.request('configurationDone'); assert.equal(configured.success, true);
    assert.ok(f.calls.findIndex(call => call[0] === 'native-resumed') < f.calls.findIndex(call => call[0] === 'jvm' && call[1] === 'configurationDone'));
    assert.equal((await launch).body.actual, 'jvm-attach');
  } finally { await f.adapter.dispose(); }
});

// routing：两个 backend 返回同一 child ID，前端引用仍隔离；线程/栈/变量和源码完整回送原 backend。
test('routing owns thread frame variable source and breakpoint references', async () => {
  const f = fixture();
  try {
    const threads = (await f.request('threads')).body.threads; assert.equal(threads.length, 2); assert.notEqual(threads[0].id, threads[1].id);
    const frames = [];
    for (const thread of threads) {
      const stack = await f.request('stackTrace', { threadId: thread.id }); frames.push(stack.body.stackFrames[0]);
      assert.equal(stack.body.stackFrames[0].name, thread.name);
      const scopes = await f.request('scopes', { frameId: stack.body.stackFrames[0].id });
      const variables = await f.request('variables', { variablesReference: scopes.body.scopes[0].variablesReference }); assert.equal(variables.body.variables[0].name, thread.name);
      const source = await f.request('source', { sourceReference: stack.body.stackFrames[0].source.sourceReference, source: stack.body.stackFrames[0].source }); assert.equal(source.body.owner, thread.name);
    }
    assert.notEqual(frames[0].id, frames[1].id);
    for (const [file, owner] of [['/Main.kt', 'jvm'], ['/Main.java', 'jvm'], ['/lib.cpp', 'native'], ['/lib.rs', 'native']]) {
      const response = await f.request('setBreakpoints', { source: { path: file }, breakpoints: [{ line: 3 }] }); assert.equal(response.success, true);
      assert.ok(f.calls.some(call => call[0] === owner && call[1] === 'setBreakpoints' && call[2].source.path === file));
    }
    const before = f.calls.length; const bad = await f.request('stackTrace', { threadId: 999999 }); assert.equal(bad.success, false); assert.match(bad.message, /Unknown mixed thread/); assert.equal(f.calls.length, before);
    const mixed = await f.request('scopes', { frameId: frames[0].id, threadId: threads[1].id }); assert.equal(mixed.success, false); assert.match(mixed.message, /different backend/);
    for (const path of ['/unknown.xyz', '/xjava']) { const unknown = await f.request('setBreakpoints', { source: { path } }); assert.equal(unknown.success, false); }
    const exceptions = await f.request('setExceptionBreakpoints', { filters: [] }); assert.equal(exceptions.success, true);
    assert.equal(f.calls.filter(call => call[1] === 'setExceptionBreakpoints').length, 2);
  } finally { await f.adapter.dispose(); }
});

// reverse/error：双边相同反向序号必须分别还原，后端错误正文不可被协调器成功替换。
test('routing preserves reverse requests events and backend error bodies', async () => {
  const f = fixture({ commandError: 'stackTrace' });
  try {
    for (const events of [f.jvmEvents, f.nativeEvents]) events.fire({ type: 'request', seq: 7, command: 'runInTerminal', arguments: { kind: 'integrated' } });
    const requests = f.output.filter(message => message.type === 'request'); assert.equal(requests.length, 2); assert.notEqual(requests[0].seq, requests[1].seq);
    for (const request of requests) f.adapter.handleMessage({ type: 'response', seq: 33, request_seq: request.seq, command: request.command, success: true, body: { processId: 99 } });
    assert.equal(f.calls.find(call => call[0] === 'jvm-message')[1].request_seq, 7);
    assert.equal(f.calls.find(call => call[0] === 'native' && call[3].type === 'response')[3].request_seq, 7);
    const threads = (await f.request('threads')).body.threads;
    const error = await f.request('stackTrace', { threadId: threads[1].id }); assert.equal(error.success, false); assert.equal(error.body.error.id, 92); assert.equal(error.message, 'actual native failure');
    f.nativeEvents.fire({ type: 'event', seq: 9, event: 'stopped', body: { reason: 'breakpoint', threadId: 7, allThreadsStopped: false } });
    assert.equal(f.output.at(-1).body.threadId, threads[1].id); assert.equal(f.output.at(-1).body.reason, 'breakpoint'); assert.equal(f.output.at(-1).body.allThreadsStopped, false);
    f.nativeEvents.fire({ type: 'event', seq: 10, event: 'continued', body: { threadId: 7, allThreadsContinued: true } }); assert.equal(f.output.at(-1).body.allThreadsContinued, false);
  } finally { await f.adapter.dispose(); }
});

// failure/cleanup：Native attach 失败不能恢复 JVM；失败和显式 dispose 都必须关闭两个子适配器。
test('failure cleans both children and never resumes after native refusal', async () => {
  const f = fixture({ attachError: true });
  const response = await f.request('launch', {}); assert.equal(response.success, false); assert.equal(response.body.error.id, 91);
  assert.equal(f.calls.some(call => call[0] === 'jvm' && call[1] === 'configurationDone'), false);
  assert.equal(f.calls.filter(call => call[0] === 'jvm-dispose').length, 1); assert.equal(f.calls.filter(call => call[0] === 'native-dispose').length, 1);
  assert.equal(f.adapter.dispose(), f.adapter.dispose()); await f.adapter.dispose();
});
// failure：准备失败/Native 配置拒绝必须可见，禁止误恢复 JVM，真实子终止后回收另一侧。
test('failure preparation and configuration errors close owned children', async () => {
  const f = fixture({ prepareError: 'cannot prepare target' });
  assert.match((await f.request('launch')).message, /cannot prepare target/);
  assert.equal(f.calls.filter(call => call[0].endsWith('dispose')).length, 2);
  const g = fixture({ configurationError: true });
  const launch = g.request('launch'); await g.ready();
  const config = await g.request('configurationDone'); assert.equal(config.success, false); assert.match(config.message, /configuration failed/);
  assert.equal((await launch).success, false);
  assert.equal(g.calls.some(call => call[0] === 'jvm' && call[1] === 'configurationDone'), false);
  const h = fixture();
  const ended = new Promise(resolve => h.adapter.onDidSendMessage(message => { if (message.event === 'terminated') resolve(message); }));
  h.nativeEvents.fire({ type: 'event', seq: 3, event: 'terminated', body: { restart: false } });
  assert.equal((await ended).body.restart, false);
  assert.equal(h.calls.filter(call => call[0].endsWith('dispose')).length, 2);
});

test('cleanup aggregates child disposal failures and disconnect owns both', async () => {
  const f = fixture({ jvmDisposeError: true, nativeDisposeError: true });
  await assert.rejects(f.adapter.dispose(), /JVM cleanup failed.*Native cleanup failed/);
  const g = fixture(); const response = await g.request('terminate'); assert.equal(response.success, true);
  assert.equal(g.calls.find(call => call[0] === 'native' && call[1] === 'disconnect')[2].terminateDebuggee, false);
  assert.equal(g.calls.find(call => call[0] === 'jvm-message')[1].command, 'terminate');
  assert.equal(g.calls.filter(call => call[0].endsWith('dispose')).length, 2);
});
