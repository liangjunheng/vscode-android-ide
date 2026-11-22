/** 功能点：自动配置归一化；受影响对象：六项模板与用户输入；复现路径：加载真实omitAuto并传入嵌套配置；测试范围：自动字段、数字端口、副本隔离；执行入口：npm test；预期结果：仅移除自动字段且不改原配置；判据：结构与值精确匹配。 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { omitAuto } = require('./auto-config-loader.cjs')();

test('auto configuration values are removed before dynamic resolution', () => {
  const input = { apkPath: 'auto', packageName: 'auto', launchActivity: 'auto', target: 'auto', serial: 'auto', native: { abi: 'auto', sdkRoot: 'auto', symbolSearchPaths: [] }, java: { sourcePaths: 'auto', port: 'auto' }, custom: 'keep' };
  const result = omitAuto(input);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), { native: { symbolSearchPaths: [] }, java: { port: 'auto' }, custom: 'keep' });
  assert.equal(input.packageName, 'auto'); assert.equal(input.native.abi, 'auto'); assert.equal(input.java.sourcePaths, 'auto');
});

test('explicit dynamic and user-managed port inputs are never normalized away', () => {
  for (const port of [0, 5005, '5005', 'auto']) {
    const input = { java: { port, preLaunchTask: 'prepare-jdwp', sourcePaths: ['src'] }, native: { abi: 'arm64-v8a' }, pid: 42 };
    const output = omitAuto(input); assert.equal(output.java.port, port); assert.equal(output.java.preLaunchTask, 'prepare-jdwp');
    assert.notEqual(output.java, input.java); assert.notEqual(output.native, input.native); assert.equal(output.pid, 42);
  }
});
