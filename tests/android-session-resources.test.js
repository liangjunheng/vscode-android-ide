/**
 * 功能点：直接调试会话的资源归属与清理。
 * 受影响对象：registerAndroidDebugging返回owner、真实tracker及DebugDevice资源边界。
 * 复现路径：内存设备准备真实provider配置，以宿主termination或owner关闭结束。
 * 测试范围：独立转发、重复关闭、真实退出屏障、清理错误与Launch/Attach停止策略。
 * 执行入口：node --test tests/android-session-resources.test.js。
 * 预期结果：只关闭本次资源，等待指定会话termination，错误不被吞掉。
 * 判据：端口关闭次数、应用操作及Promise结算顺序精确一致。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture, turn } = require('./fixture/android-public.cjs');

// 功能：资源独立归属；输入两个运行；输出各自关闭一次且不停止Attach目标。
test('独立运行各持有一次转发且重复dispose不重复释放', async () => {
  const f = fixture();
  await f.resolve({ name: '甲' }); await f.resolve({ name: '乙' });
  await f.owner.dispose(); await f.owner.dispose();
  assert.equal(f.calls.filter(row => row[0] === 'forward-close').length, 2);
  assert.equal(f.calls.some(row => ['stop', 'clear'].includes(row[0])), false);
  await f.close(); assert.equal(f.ended.listeners.size, 0);
});

// 功能：关闭等待宿主实际termination；输入延后终止；输出资源不提前回收。
test('stopDebugging返回不等于宿主termination', async () => {
  const f = fixture({ stop: async () => undefined });
  const config = await f.resolve(), { session } = f.track(config);
  let settled = false; const closing = f.owner.dispose().then(() => { settled = true; });
  await turn(); assert.equal(settled, false); assert.equal(f.stops[0], session);
  assert.equal(f.calls.some(row => row[0] === 'forward-close'), false);
  f.ended.fire({ id: 'foreign' }); await turn(); assert.equal(settled, false);
  f.ended.fire(session); await closing;
  assert.equal(f.calls.filter(row => row[0] === 'forward-close').length, 1);
  await f.close();
});

// 功能：清理错误保留身份；输入转发关闭错误；输出聚合错误并继续清除Launch状态。
test('资源关闭失败聚合原错误且仍清理应用', async () => {
  const failure = new Error('端口关闭失败'), f = fixture({ closeError: failure });
  await f.resolve({ request: 'launch' });
  await assert.rejects(f.owner.dispose(), error => error.errors[0].errors.includes(failure));
  assert.equal(f.calls.filter(row => row[0] === 'clear').length, 1);
  assert.equal(f.calls.filter(row => row[0] === 'stop').length, 1);
  await f.close();
});

// 功能：Dual子会话退出归属于本次运行；输入真实子tracker及termination；输出只停止自有根并释放两项资源。
test('Dual子会话退出只清理所属运行不接管foreign会话', async () => {
  const f = fixture(), config = await f.resolve({ mode: 'dual' }), { session, tracker } = f.track(config);
  tracker.onDidSendMessage({ type: 'response', command: 'attach', success: true });
  tracker.onDidSendMessage({ type: 'response', command: 'configurationDone', success: true });
  tracker.onDidSendMessage({ type: 'event', event: 'continued' }); await turn();
  assert.equal(f.starts.length, 1);
  const child = f.track(f.starts[0].config, 'owned-child', session); assert.ok(child.tracker);
  f.ended.fire({ id: 'foreign' }); await turn(); assert.equal(f.stops.length, 0);
  f.ended.fire(child.session); await f.owner.dispose();
  assert.deepEqual(f.stops, [session]);
  assert.equal(f.calls.filter(row => row[0] === 'native-close').length, 1);
  assert.equal(f.calls.filter(row => row[0] === 'forward-close').length, 1);
  await f.close();
});

// 功能：断开与销毁策略由真实tracker观察；输入公开disconnect/terminate；输出仅显式销毁才停止Attach。
for (const [command, args, stops] of [['disconnect', { terminateDebuggee: false }, 0], ['disconnect', { terminateDebuggee: true }, 1], ['terminate', {}, 1]]) test('Attach清理策略：' + command + JSON.stringify(args), async () => {
  const f = fixture(), config = await f.resolve(), { session, tracker } = f.track(config);
  tracker.onWillReceiveMessage({ type: 'request', command, arguments: args });
  f.ended.fire(session); await f.owner.dispose();
  assert.equal(f.calls.filter(row => row[0] === 'stop').length, stops);
  assert.equal(f.calls.some(row => row[0] === 'clear'), false);
  assert.equal(f.calls.filter(row => row[0] === 'forward-close').length, 1);
  await f.close();
});
