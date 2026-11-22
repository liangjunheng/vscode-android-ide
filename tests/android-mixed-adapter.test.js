/** 功能点：Dual 复用独立 JVM/Native 能力。
 * 受影响对象：attachDual、统一父 DAP、两种子会话。
 * 复现路径：执行生产 Dual 组合函数，以门闩控制两种能力；六组合父 DAP 由 native-codelldb.test.js 覆盖。
 * 测试范围：两能力均启动、共享失败取消、等待迟到退出、聚合错误及模块依赖方向。
 * 执行入口：npm test。
 * 预期结果：Dual 不复制配置/端口/符号逻辑，两边全部结算后才完成。
 * 判据：真实函数调用次数、完成顺序和错误集合与断言一致。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { transformSync } = require('esbuild');

/** 功能：加载生产组合函数；输入无；输出attachDual；验证：本文件全部组合回归。 */
function load() {
  const module = { exports: {} };
  vm.runInNewContext(transformSync(fs.readFileSync('src/android-debugger/dual-debugger/session.ts', 'utf8'), { loader: 'ts', format: 'cjs' }).code, { module, exports: module.exports, AggregateError });
  return module.exports.attachDual;
}

test('Dual invokes both existing capabilities and waits for both completions', async () => {
  const attach = load(), native = Promise.withResolvers(), jvm = Promise.withResolvers(), calls = [];
  let finished = false;
  const starting = attach(() => { calls.push('native'); return native.promise; }, () => { calls.push('jvm'); return jvm.promise; }, () => assert.fail('unexpected failure')).then(() => { finished = true; });
  assert.deepEqual(calls, ['native', 'jvm']); native.resolve(); await Promise.resolve(); assert.equal(finished, false);
  jvm.resolve(); await starting; assert.equal(finished, true);
});

test('Dual cancels on either capability failure and waits for sibling rollback', async () => {
  for (const side of ['native', 'jvm']) {
    const attach = load(), gate = Promise.withResolvers(), cancelled = Promise.withResolvers(), error = new Error(side + ' failed');
    let finished = false;
    const starting = attach(() => side === 'native' ? Promise.reject(error) : gate.promise, () => side === 'jvm' ? Promise.reject(error) : gate.promise, failure => cancelled.resolve(failure));
    const failed = assert.rejects(starting, failure => failure.errors.includes(error)); starting.catch(() => { finished = true; });
    assert.equal(await cancelled.promise, error); assert.equal(finished, false); gate.resolve(); await failed;
  }
});

test('unified host imports JVM Native and Dual without Native owning generic DAP', () => {
  const source = fs.readFileSync('src/android-debugger/sessionAdapter.ts', 'utf8');
  assert.match(source, /jvm-debugger\/session/); assert.match(source, /native-debugger\/session/); assert.match(source, /dual-debugger\/session/);
  assert.match(source, /parentSession: this.session/); assert.match(source, /child session terminated/);
  assert.equal(fs.existsSync('src/android-debugger/native-debugger/upstream/src/debugAdapter.ts'), false);
  const dual = fs.readFileSync('src/android-debugger/dual-debugger/session.ts', 'utf8');
  assert.doesNotMatch(dual, /claim\(|nativeStart|Content-Length|nativeLibraryCommands|type: 'lldb'/);
});
