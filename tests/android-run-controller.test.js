/**
 * 功能点：直接调试运行的六种组合与生命周期回归。
 * 受影响对象：公开registerAndroidDebugging、DebugDevice边界及真实LLDB/JVM tracker。
 * 复现路径：真实provider准备Launch/Attach，宿主tracker注入真实引擎格式观测并结束会话。
 * 测试范围：Native/JVM/Dual六组合、失败回滚、就绪后detach、重复配置、取消和错误诊断。
 * 执行入口：node --test tests/android-run-controller.test.js。
 * 预期结果：只管理明确设备操作和资源，不重建已删除的引擎代理或内部AndroidRun接口。
 * 判据：引擎类型、精确目标、资源次数、停止策略和取消信号符合断言；模拟不等同ART验收。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture, turn } = require('./fixture/android-public.cjs');

// 功能：内置模板六组合独立；输入公开配置查询；输出六种模式请求及无共享可变选项。
test('公开六配置完整且每次查询返回独立副本', async t => {
  const f = fixture(); t.after(f.close);
  const configs = f.index.getAndroidDebugConfigurations();
  assert.equal(configs.length, 6);
  assert.deepEqual(Array.from(configs, value => value.mode + '/' + value.request), ['native/launch', 'native/attach', 'java/launch', 'java/attach', 'dual/launch', 'dual/attach']);
  assert.equal(new Set(Array.from(configs, value => value.name)).size, 6);
  configs[0].native.symbolSearchPaths.push('/test/changed'); configs[2].java.adapterJvmArgs.push('-Xmx1g');
  const fresh = f.index.getAndroidDebugConfigurations();
  assert.equal(fresh[0].native.symbolSearchPaths.length, 0); assert.equal(fresh[2].java.adapterJvmArgs.length, 0);
  assert.equal(f.providers.get('android-debug:dynamic').provideDebugConfigurations().length, 6);
});

// 功能：宿主迟到根会话归属精确；输入取消及启动门闩；输出前台原错误且清理等到唯一termination。
test('公开start取消后只停止所属迟到根会话并等待实际termination', async () => {
  const gate = Promise.withResolvers(), entered = Promise.withResolvers(), controller = new AbortController();
  const f = fixture({ stop: async () => undefined, start: async () => { entered.resolve(); return gate.promise; } });
  const config = { type: 'android-debug', name: '迟到根会话', request: 'attach', mode: 'java' };
  let cleanup, cleanupSettled = false;
  const pending = f.index.startAndroidDebugging(f.folder, config, { serial: 'phone', packageName: 'com.example.app', signal: controller.signal,
    // 功能：订阅公开启动清理；输入生产Promise；输出独立结算状态。
    onStartupCleanup(value) { cleanup = value; void value.then(() => { cleanupSettled = true; }); },
  });
  const rejected = assert.rejects(pending, error => error === controller.signal.reason);
  await entered.promise;
  const mapped = f.starts[0].config, reason = new Error('用户取消迟到根会话'); controller.abort(reason); await rejected;
  assert.equal(f.startup.debugStartupSignal(mapped), controller.signal);
  const foreign = { id: 'foreign', configuration: { ...mapped, packageName: 'com.other.app' } }, child = { id: 'foreign-child', configuration: mapped, parentSession: { id: 'external-parent' } };
  f.started.fire(foreign); f.started.fire(child);
  const owned = { id: 'owned-late', configuration: { ...mapped, type: 'android-jvm' } }; f.started.fire(owned); f.started.fire(owned);
  gate.resolve(true); await turn();
  assert.deepEqual(f.stops, [owned]); assert.equal(cleanupSettled, false);
  f.ended.fire(foreign); await turn(); assert.equal(cleanupSettled, false);
  f.ended.fire(owned); await cleanup;
  assert.equal(f.startup.debugStartupSignal(mapped), undefined);
  assert.equal(f.started.listeners.size, 0); assert.equal(f.ended.listeners.size, 0);
  assert.equal(f.calls.some(row => row[0] === 'command'), false, '取消不得打开成功调试视图');
  await f.close();
});

// 功能：宿主无真实启动证据不得成功；输入false、无事件或早终止；输出失败并注销登记。
for (const kind of ['false', 'no-event', 'already-ended']) test('公开start拒绝虚假启动：' + kind, async t => {
  const f = fixture({ start: async (_folder, configuration, _settings, host) => {
    if (kind === 'already-ended') { const session = { id: 'ended', configuration }; host.started.fire(session); host.ended.fire(session); }
    return kind !== 'false';
  } }); t.after(f.close);
  await assert.rejects(f.index.startAndroidDebugging(f.folder, { type: 'android-debug', name: '失败启动', request: 'attach' }, { serial: 'phone' }), /did not start|did not report a live start/);
  assert.equal(f.startup.debugStartupSignal({ name: '失败启动', serial: 'phone' }), undefined);
  assert.equal(f.started.listeners.size, 0); assert.equal(f.ended.listeners.size, 0);
});

// 功能：通过公开tracker完成主连接；输入真实引擎配置；输出生产观察到的附加、配置与恢复。
async function connected(f, config) {
  const tracked = f.track(config);
  tracked.tracker.onDidSendMessage({ type: 'response', command: 'attach', success: true });
  tracked.tracker.onDidSendMessage({ type: 'response', command: 'configurationDone', success: true });
  tracked.tracker.onDidSendMessage({ type: 'event', event: 'continued' });
  await turn(); return tracked;
}

// 功能：六组合真实入口回归；输入模式和请求；输出直接引擎与正确应用策略。
for (const mode of ['native', 'java', 'dual']) for (const request of ['launch', 'attach']) test(mode + '/' + request + '直接引擎与资源生命周期', async () => {
  const f = fixture(), config = await f.resolve({ mode, request, launchActivity: '.Main' });
  assert.equal(config.type, mode === 'java' ? 'android-jvm' : 'lldb'); assert.equal(config.request, 'attach'); assert.equal(config.pid, 42);
  assert.equal(config.serial, 'phone'); assert.equal(config.packageName, 'com.example.app');
  const { session } = await connected(f, config);
  assert.equal(f.starts.length, mode === 'dual' ? 1 : 0);
  assert.equal(f.calls.filter(row => row[0] === 'native').length, mode === 'java' ? 0 : 1);
  assert.equal(f.calls.filter(row => row[0] === 'resume').length, mode === 'native' && request === 'launch' ? 1 : 0);
  assert.equal(f.calls.filter(row => row[0] === 'launch').length, request === 'launch' ? 1 : 0);
  f.ended.fire(session); await f.owner.dispose();
  assert.equal(f.calls.filter(row => row[0] === 'clear').length, request === 'launch' ? 1 : 0);
  assert.equal(f.calls.filter(row => row[0] === 'stop').length, 0, '已运行detach不强停应用');
  assert.equal(f.calls.filter(row => row[0] === 'forward-close').length, mode === 'native' ? 0 : 1);
  assert.equal(f.calls.filter(row => row[0] === 'native-close').length, mode === 'java' ? 0 : 1);
  await f.close();
});

// 功能：设备Launch失败保留原错误；输入失败设备操作；输出唯一停止和清除设置。
test('Launch失败清理明确包且保留原始错误', async t => {
  const failure = new Error('设备启动失败'), f = fixture({ launch: async () => { throw failure; } }); t.after(f.close);
  await assert.rejects(f.resolve({ request: 'launch' }), error => error === failure);
  assert.equal(f.calls.filter(row => row[0] === 'clear').length, 1); assert.deepEqual(f.calls.find(row => row[0] === 'stop'), ['stop', 'com.example.app']);
  assert.equal(f.calls.some(row => row[0] === 'forward'), false);
});

// 功能：连接失败不伪造主DAP响应；输入真实tracker失败；输出可见诊断及Launch回滚。
for (const command of ['attach', 'configurationDone']) test('主引擎' + command + '失败回滚Launch', async t => {
  const f = fixture(); t.after(f.close); const config = await f.resolve({ request: 'launch' }), { tracker } = f.track(config);
  tracker.onDidSendMessage(Object.freeze({ type: 'response', command, success: false, message: '真实失败消息' }));
  await turn(); await f.owner.dispose();
  assert.ok(f.errors.some(value => value.includes('真实失败消息')));
  assert.equal(f.calls.filter(row => row[0] === 'stop').length, 1); assert.equal(f.calls.filter(row => row[0] === 'clear').length, 1);
});

// 功能：重复运行仅拒绝同公开身份；输入相同配置名和设备；输出不重复分配端口。
test('重复配置拒绝且不重复取得转发', async t => {
  const f = fixture(); t.after(f.close); await f.resolve();
  await assert.rejects(f.resolve(), /already running/);
  assert.equal(f.calls.filter(row => row[0] === 'forward').length, 1);
});

// 功能：在途取消等待迟到资源归还；输入转发门闩及已登记取消；输出原错误和精确资源回收。
test('provider转发在途取消不接受迟到结果并关闭所得资源', async t => {
  const gate = Promise.withResolvers(), entered = Promise.withResolvers(), controller = new AbortController();
  let closed = 0;
  const f = fixture({ forward: async () => { entered.resolve(); return gate.promise; } }); t.after(f.close);
  const unregister = f.startup.registerDebugStartup({ name: '测试调试', serial: 'phone' }, controller.signal); t.after(unregister);
  const pending = f.resolve(), rejected = assert.rejects(pending, error => error === controller.signal.reason);
  await entered.promise; controller.abort(new Error('在途取消'));
  gate.resolve({ port: 4500, close: async () => { closed++; } }); await rejected;
  assert.equal(closed, 1); assert.equal(f.calls.some(row => row[0] === 'stop'), false);
});

// 功能：宿主中途取消通过真实provider作用域；输入客户端挂起和取消事件；输出取消原因及订阅归零。
test('宿主token取消到达在途设备调用并释放订阅', async t => {
  const entered = Promise.withResolvers(), gate = Promise.withResolvers(), listeners = new Set();
  let signal;
  const f = fixture({ clients: async value => { signal = value; entered.resolve(); await gate.promise; value.throwIfAborted(); return []; } }); t.after(f.close);
  const token = { isCancellationRequested: false,
    // 功能：记录宿主取消订阅；输入监听；输出可释放对象。
    onCancellationRequested(listener) { listeners.add(listener); return { dispose: () => listeners.delete(listener) }; },
  };
  const pending = f.resolve({}, token), rejected = assert.rejects(pending, /cancelled/);
  await entered.promise; for (const listener of [...listeners]) listener();
  assert.equal(signal.aborted, true); gate.resolve(); await rejected;
  assert.equal(listeners.size, 0); assert.equal(f.calls.some(row => row[0] === 'forward'), false);
});

// 功能：Native显式恢复只在实际连接后执行；输入Attach与resumeProcess；输出同PID解除等待及精确租约清理。
test('Native Attach显式resumeProcess在实际连接后恢复同一PID', async () => {
  const f = fixture(), config = await f.resolve({ mode: 'native', resumeProcess: true });
  assert.equal(f.calls.some(row => row[0] === 'resume'), false);
  await connected(f, config); assert.deepEqual(f.calls.find(row => row[0] === 'resume'), ['resume', 42]);
  await f.close(); assert.equal(f.calls.filter(row => row[0] === 'resume-close').length, 1);
  assert.equal(f.calls.some(row => ['stop', 'clear'].includes(row[0])), false);
});

// 功能：不支持configurationDone的真实能力可以完成连接；输入能力与attach；输出Native恢复，不虚构配置响应。
test('引擎明确无configurationDone能力时以attach完成连接', async t => {
  const f = fixture(); t.after(f.close); const config = await f.resolve({ mode: 'native', request: 'launch' }), { tracker } = f.track(config);
  tracker.onDidSendMessage({ type: 'response', command: 'initialize', success: true, body: { supportsConfigurationDoneRequest: false } });
  tracker.onDidSendMessage({ type: 'response', command: 'attach', success: true }); await turn();
  assert.equal(f.calls.filter(row => row[0] === 'resume').length, 1);
});

// 功能：预取消先于设备操作；输入宿主已取消token；输出取消错误和零调用。
test('宿主预取消不查询设备', async t => {
  const f = fixture(); t.after(f.close); let disposed = 0;
  await assert.rejects(f.resolve({}, { isCancellationRequested: true, onCancellationRequested() { return { dispose: () => { disposed++; } }; } }), /cancelled/);
  assert.deepEqual(f.calls, []); assert.equal(disposed, 1);
});
