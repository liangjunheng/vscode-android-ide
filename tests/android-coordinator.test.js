/**
 * 功能点：设备和进程选择的公开provider行为，替代已删除控制面协议。
 * 受影响对象：registerAndroidDebugging、DebugDevice边界及宿主QuickPick。
 * 复现路径：Node>=22；加载真实provider，所有设备来自内存fixture。
 * 测试范围：离线拒绝、用户取消、上次设备、进程选择、精确PID包名及信任边界。
 * 执行入口：node --test tests/android-coordinator.test.js。
 * 预期结果：只准备明确在线目标，取消或非法目标不分配连接。
 * 判据：返回配置、选择令牌及设备调用参数满足断言；不执行ADB。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./fixture/android-public.cjs');

// 功能：在线过滤不接受离线设备；输入显式串号；输出错误且不分配端口。
test('公开provider拒绝离线及不存在设备', async t => {
  for (const state of ['offline', 'unauthorized']) {
    const f = fixture({ devices: [{ serial: 'phone', state }] }); t.after(f.close);
    await assert.rejects(f.resolve(), /not online/);
    assert.deepEqual(f.calls, [['devices']]);
  }
});

// 功能：选择取消不得继续准备；输入无设备选择；输出undefined与零连接。
test('用户取消设备选择不创建连接', async t => {
  const f = fixture({ pick: () => undefined }); t.after(f.close);
  assert.equal(await f.resolve({ serial: undefined }), undefined);
  assert.equal(f.picks.length, 1);
  assert.equal(f.picks[0].token.isCancellationRequested, false);
  assert.deepEqual(f.calls, [['devices']]);
});

// 功能：上次设备来自本次注册；输入第二次选择；输出沿用同串号而非重复弹窗。
test('last-selected只复用本注册已选在线设备', async t => {
  const f = fixture(); t.after(f.close);
  const first = await f.resolve({ serial: 'select', name: '第一项' });
  const second = await f.resolve({ serial: 'last-selected', name: '第二项' });
  assert.equal(first.serial, 'phone'); assert.equal(second.serial, 'phone');
  assert.equal(f.picks.length, 1);
  assert.equal(f.calls.filter(row => row[0] === 'forward').length, 2);
});

// 功能：进程选择返回精确身份；输入多进程与无PID配置；输出选择的包和PID。
test('进程选择及取消只作用于明确候选', async t => {
  const f = fixture({ pick: items => items[1] }); t.after(f.close);
  f.rows = [{ pid: 41, packageName: 'com.other.app' }, { pid: 42, packageName: 'com.example.app' }];
  const config = await f.resolve({ pid: undefined, packageName: undefined });
  assert.equal(config.pid, 42); assert.equal(config.packageName, 'com.example.app');
  assert.equal(f.picks[0].items[1].description, '42');
  const cancelled = fixture({ pick: () => undefined }); t.after(cancelled.close);
  cancelled.rows = f.rows;
  assert.equal(await cancelled.resolve({ pid: undefined, packageName: undefined }), undefined);
  assert.equal(cancelled.calls.some(row => row[0] === 'forward'), false);
});

// 功能：Attach交叉核对身份；输入错误包、PID或重复匹配；输出拒绝且无连接。
test('Attach要求唯一PID与包名共同匹配', async t => {
  for (const rows of [[{ pid: 42, packageName: 'com.other.app' }], [{ pid: 43, packageName: 'com.example.app' }], [{ pid: 42, packageName: 'com.example.app' }, { pid: 42, packageName: 'com.example.app' }]]) {
    const f = fixture(); t.after(f.close); f.rows = rows;
    await assert.rejects(f.resolve(), /one existing process/);
    assert.equal(f.calls.some(row => row[0] === 'forward'), false);
  }
});

// 功能：信任边界先于设备通信；输入不可信宿主；输出拒绝且零设备调用。
test('不可信工作区不查询设备', async t => {
  const f = fixture(); t.after(f.close); f.vscode.workspace.isTrusted = false;
  await assert.rejects(f.resolve(), /not trusted/); assert.deepEqual(f.calls, []);
});
