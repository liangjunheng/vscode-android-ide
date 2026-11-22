/** 功能点：CodeLLDB实例自有ADB转发精确回收。
 * 受影响对象：NativeForwardLease、Native provider清理链及独占平台日志。
 * 复现路径：Node>=22，创建真实独占日志，在ADB边界注入基线、当前三元组与可控删除操作。
 * 测试范围：平台/GDB/TCP映射、其他设备/会话、基线占用、空日志/未知记录证据缺失、端口改绑、删除失败及重复关闭。
 * 执行入口：npm test；定向 node --test tests/native-forward-lease.test.js。
 * 预期结果：只删除当前仍匹配且不在基线中的本实例日志映射；失败保留日志证据。
 * 判据：精确删除端口、其他映射不变、错误传播及幂等等待全部符合断言。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const sync = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { transformSync } = require('esbuild');

/** 功能：加载生产资源账本；输入ADB基线；输出真实日志和可控映射；验证：本文件全部用例。 */
async function fixture(t, baseline = []) {
  const module = { exports: {} };
  vm.runInNewContext(transformSync(sync.readFileSync('src/android-debugger/native-debugger/forwardLease.ts', 'utf8'), { loader: 'ts', format: 'cjs' }).code, { module, exports: module.exports, require, AggregateError });
  const state = { rows: [...baseline], removed: [] };
  const backend = { async getForwardList() { return [...state.rows]; }, async removePortForward(port) { if (state.fail === port) throw new Error('remove denied'); state.removed.push(port); state.rows = state.rows.filter(row => !row.startsWith(`S tcp:${port} `)); } };
  const lease = await module.exports.NativeForwardLease.create('S', backend);
  t.after(() => fs.rm(path.dirname(lease.logFile), { recursive: true, force: true }));
  return { lease, state, async log(text) { await fs.writeFile(lease.logFile, text); } };
}

test('owned log records release exact platform and GDB ports without deleting other sessions', async t => {
  const f = await fixture(t, ['S tcp:100 localabstract:gdbserver.baseline']);
  f.state.rows.push('S tcp:101 localabstract:/owned', 'S tcp:102 localabstract:gdbserver.owned', 'S tcp:103 localabstract:gdbserver.foreign', 'T tcp:104 localabstract:gdbserver.owned');
  await f.log('Connected to Android device "S"\nForwarding remote socket "/owned" to local TCP port 101\nForwarding remote socket "gdbserver.owned" to local TCP port 102\nConnected to Android device "T"\nForwarding remote socket "gdbserver.owned" to local TCP port 104\n');
  const closing = f.lease.close(); assert.equal(closing, f.lease.close()); await closing;
  assert.deepEqual(f.state.removed, [101, 102]); assert.equal(f.state.rows.length, 3);
  assert.equal(sync.existsSync(f.lease.logFile), false);
});

/** 功能：覆盖CodeLLDB远端TCP记录；输入实际日志格式与当前三元组；输出仅删除匹配的自有本地端口；验证：本文件定向入口。 */
test('owned remote TCP records remove only the exact local mapping', async t => {
  const f = await fixture(t); f.state.rows.push('S tcp:105 tcp:5039', 'S tcp:106 tcp:5040');
  await f.log('Connected to Android device "S"\nForwarding remote TCP port 5039 to local TCP port 105\n');
  await f.lease.close(); assert.deepEqual(f.state.removed, [105]); assert.deepEqual(f.state.rows, ['S tcp:106 tcp:5040']);
});

test('baseline ports are never deleted even if included in the current instance log', async t => {
  const f = await fixture(t, ['S tcp:100 localabstract:gdbserver.baseline']);
  await f.log('Connected to Android device "S"\nForwarding remote socket "gdbserver.baseline" to local TCP port 100\n');
  await f.lease.close(); assert.deepEqual(f.state.removed, []); assert.equal(f.state.rows.length, 1);
});

test('port rebinding fails visibly and preserves the new owner and evidence', async t => {
  const f = await fixture(t); f.state.rows = ['S tcp:102 localabstract:gdbserver.foreign'];
  await f.log('Connected to Android device "S"\nForwarding remote socket "gdbserver.owned" to local TCP port 102\n');
  await assert.rejects(f.lease.close(), error => error.errors.some(item => /ownership changed/.test(item.message)));
  assert.deepEqual(f.state.removed, []); assert.equal(sync.existsSync(f.lease.logFile), true);
});

test('independent removal failure does not skip other owned ports and retains diagnostics', async t => {
  const f = await fixture(t); f.state.rows = ['S tcp:101 localabstract:/owned', 'S tcp:102 localabstract:gdbserver.owned']; f.state.fail = 101;
  await f.log('Connected to Android device "S"\nForwarding remote socket "/owned" to local TCP port 101\nForwarding remote socket "gdbserver.owned" to local TCP port 102\n');
  await assert.rejects(f.lease.close(), error => error.errors.some(item => /remove denied/.test(item.message)));
  assert.deepEqual(f.state.removed, [102]); assert.equal(sync.existsSync(f.lease.logFile), true);
});

/** 功能：在缺失或未知日志记录时保留映射与证据；输入非基线映射和损坏记录；输出显式拒绝；验证：本文件定向入口。 */
test('missing or unknown ownership records preserve mappings and diagnostics', async t => {
  for (const log of ['', 'Connected to Android device "S"\nForwarding remote socket with changed format\n', 'Connected to Android device with changed format\nForwarding remote socket "gdbserver.owned" to local TCP port 102\n']) {
    const f = await fixture(t); f.state.rows.push('S tcp:102 localabstract:gdbserver.foreign');
    await f.log(log);
    await assert.rejects(f.lease.close(), /ownership (?:evidence|record)/);
    assert.deepEqual(f.state.removed, []); assert.equal(sync.existsSync(f.lease.logFile), true);
  }
});

test('already released mappings and an unused session do not remove anything', async t => {
  const f = await fixture(t);
  await f.log('Connected to Android device "S"\nForwarding remote socket "gdbserver.owned" to local TCP port 102\n');
  await f.lease.close(); assert.deepEqual(f.state.removed, []);
  const empty = await fixture(t); await empty.lease.close(); assert.deepEqual(empty.state.removed, []);
});
