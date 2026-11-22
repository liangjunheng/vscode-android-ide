/** 功能点：Coordinator 会话资源账本。
 * 受影响对象：AndroidDebugSession、租约、子引擎及 Native server。
 * 复现路径：加载真实会话类并在资源边界注入可控 Promise。
 * 测试范围：关闭等待、异常聚合、外部资源隔离、取消晚到租约。
 * 执行入口：npm test。
 * 预期结果：精确逆序释放且失败不跳过其余资源，不保留已删除的磁盘锁架构。
 * 判据：实际释放序列与取消结果符合断言。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { transformSync } = require('esbuild');

/** 功能：加载生产会话类；输入无；输出真实类；验证：本文件全部用例。 */
function sessionClass() {
  const module = { exports: {} };
  vm.runInNewContext(transformSync(fs.readFileSync('src/android-debugger/coordinator/androidCoordinator.ts', 'utf8'), { loader: 'ts', format: 'cjs' }).code, { module, exports: module.exports, require: () => ({}), AbortController, AggregateError });
  return module.exports.AndroidDebugSession;
}

test('session close waits for actual resource completion and preserves another session', async () => {
  const Session = sessionClass(), order = [], gate = Promise.withResolvers();
  const coordinator = { onEvent: () => ({ dispose() { order.push('unsubscribe'); } }) };
  const first = new Session(coordinator, 'S', () => {}, () => order.push('closed'));
  const other = new Session(coordinator, 'T', () => {}, () => {});
  first.own(async () => { order.push('lease'); }); first.own(async () => { order.push('engine'); await gate.promise; });
  let done = false; const closing = first.close().then(() => { done = true; }); await Promise.resolve();
  assert.equal(done, false); assert.deepEqual(order, ['engine']); assert.equal(other.signal.aborted, false);
  gate.resolve(); await closing; assert.deepEqual(order, ['engine', 'lease', 'unsubscribe', 'closed']); await other.close();
});

test('cancelled late lease is released before claim rejects and is never registered twice', async () => {
  const Session = sessionClass(), gate = Promise.withResolvers(), order = [];
  const coordinator = { onEvent: () => ({ dispose() {} }), claim: () => gate.promise };
  const session = new Session(coordinator, 'S', () => {}, () => {});
  const claim = session.claim(42), failed = assert.rejects(claim);
  session.cancel(); gate.resolve({ leaseId: '1', port: 8700, cleanup: async () => { order.push('release'); } });
  await failed; await session.close(); assert.deepEqual(order, ['release']);
});

test('independent cleanup failures remain visible and do not skip later resources', async () => {
  const Session = sessionClass(), order = [];
  const session = new Session({ onEvent: () => ({ dispose() {} }) }, 'S', () => {}, () => {});
  session.own(async () => { order.push('lease'); throw new Error('lease failed'); });
  session.own(async () => { order.push('server'); throw new Error('server failed'); });
  await assert.rejects(session.close(), error => error.errors.length === 2 && error.errors.every(item => /failed/.test(item.message)));
  assert.deepEqual(order, ['server', 'lease']); assert.equal(session.close(), session.close());
});
