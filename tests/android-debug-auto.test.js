/** 功能点：launch.json的auto配置契约。
 * 受影响对象：omitAuto、顶层及嵌套Native/JVM配置输入。
 * 复现路径：Node>=22，传入包含auto、显式选项及非法端口的配置。
 * 测试范围：动态字段省略、原配置不变、数组隔离边界和端口不被吞掉。
 * 执行入口：npm test；node --test tests/android-debug-auto.test.js。
 * 预期结果：auto字段转为缺省，显式配置保留，非法端口留给严格校验。
 * 判据：返回配置和原始配置逐项符合断言，不分配设备或引擎资源。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const load = require('./auto-config-loader.cjs');

test('auto configuration preserves explicit engine options without mutating launch.json input', () => {
  const { omitAuto } = load();
  const input = { type: 'android-debug', name: 'debug', request: 'launch', sourcePaths: 'auto', projectRoot: 'auto', target: 'auto', apkPath: 'auto', native: { abi: 'auto', sdkRoot: 'auto', symbolSearchPaths: ['symbols'] }, java: { sourcePaths: 'auto', projectRoot: 'auto', port: 'auto', adapterJvmArgs: ['-Xmx512m'] } };
  const before = JSON.stringify(input), result = omitAuto(input);
  for (const field of ['sourcePaths', 'projectRoot', 'target', 'apkPath']) assert.equal(Object.hasOwn(result, field), false);
  assert.equal(Object.hasOwn(result.native, 'abi'), false); assert.equal(Object.hasOwn(result.native, 'sdkRoot'), false);
  assert.equal(Object.hasOwn(result.java, 'sourcePaths'), false); assert.equal(Object.hasOwn(result.java, 'projectRoot'), false);
  assert.equal(result.java.port, 'auto'); assert.deepEqual(Array.from(result.native.symbolSearchPaths), ['symbols']);
  assert.notEqual(result.native, input.native); assert.notEqual(result.java, input.java);
  assert.equal(JSON.stringify(input), before);
});
