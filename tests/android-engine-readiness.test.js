/**
 * 功能点：配置调用取消登记与宿主令牌桥接，不包含已删除的引擎ready表。
 * 受影响对象：registerDebugStartup、debugStartupSignal、debugCancellationToken。
 * 复现路径：每例隔离加载真实startup，使用公开name/serial身份和AbortController。
 * 测试范围：克隆匹配、重复拒绝、不同调用隔离、幂等注销、预取消及订阅释放。
 * 执行入口：node --test tests/android-engine-readiness.test.js。
 * 预期结果：只登记配置调用，不注入私有元数据、不承诺引擎协议就绪。
 * 判据：信号身份、导出集合、取消回调上下文和监听数精确一致。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { getEventListeners } = require('node:events');
const load = require('./debug-startup-loader.cjs');
const config = Object.freeze({ type: 'android-debug', name: 'JVM', request: 'attach', serial: 'phone' });

// 功能：调用身份只用name和serial；输入宿主转换配置；输出原信号且不修改配置。
test('startup按公开name与serial匹配转换后的引擎配置', () => {
  const api = load(), controller = new AbortController(), before = JSON.stringify(config);
  const release = api.registerDebugStartup(config, controller.signal);
  assert.equal(api.debugStartupSignal({ ...config, type: 'android-jvm', request: 'launch', pid: 42 }), controller.signal);
  for (const changes of [{ name: '外来' }, { serial: 'other' }]) assert.equal(api.debugStartupSignal({ ...config, ...changes }), undefined);
  assert.throws(() => api.registerDebugStartup({ ...config }, new AbortController().signal), /already starting/);
  assert.equal(JSON.stringify(config), before); release(); release(); assert.equal(api.debugStartupSignal(config), undefined);
  assert.deepEqual(Object.keys(api).sort(), ['debugCancellationToken', 'debugStartupSignal', 'registerDebugStartup']);
});

// 功能：不同调用独立注销；输入同名不同设备及同设备不同名；输出只移除所属登记。
test('startup独立调用取消和注销不会影响他人', () => {
  const api = load(), a = new AbortController(), b = new AbortController(), other = { ...config, serial: 'other' };
  const releaseA = api.registerDebugStartup(config, a.signal), releaseB = api.registerDebugStartup(other, b.signal);
  a.abort(new Error('调用取消')); assert.equal(api.debugStartupSignal(config).reason, a.signal.reason);
  assert.equal(api.debugStartupSignal(other).aborted, false); releaseA();
  assert.equal(api.debugStartupSignal(other), b.signal); releaseB();
  const release = api.registerDebugStartup(config, b.signal); assert.equal(api.debugStartupSignal(config), b.signal); release();
});

// 功能：桥接宿主取消及上下文；输入thisArgs与释放数组；输出同步取消和零残留监听。
test('取消令牌只订阅所属信号并支持宿主释放数组', () => {
  const api = load(), controller = new AbortController(), token = api.debugCancellationToken(controller.signal), context = {}, disposables = [];
  let called = 0;
  token.onCancellationRequested(function () { assert.equal(this, context); called++; }, context, disposables);
  assert.equal(token.isCancellationRequested, false); controller.abort();
  assert.equal(token.isCancellationRequested, true); assert.equal(called, 1); assert.equal(disposables.length, 1);
  disposables[0].dispose(); disposables[0].dispose(); assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

// 功能：预取消可读取且注销监听有效；输入已取消或已释放订阅；输出正确状态而非伪ready。
test('预取消状态可读且提前dispose阻止通知', () => {
  const api = load(), before = new AbortController(); before.abort(new Error('预取消'));
  assert.equal(api.debugCancellationToken(before.signal).isCancellationRequested, true);
  const controller = new AbortController(), token = api.debugCancellationToken(controller.signal);
  const subscription = token.onCancellationRequested(() => assert.fail('已注销不应通知'));
  subscription.dispose(); controller.abort(); assert.equal(token.isCancellationRequested, true);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});
