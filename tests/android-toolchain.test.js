/** 功能点：当前调试工具链遵循项目配置边界；受影响对象：Native SDK/NDK与Coordinator；复现路径：加载生产工具链；测试范围：覆盖字段及非法输入；执行入口：npm test；预期结果：只接受现有工具链字段；判据：精确返回或拒绝。 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { transformSync } = require('esbuild');

/** 功能：加载生产工具链但不探测本机；输入无；输出解析函数；验证：本文件边界测试。 */
function fixture() {
  const module = { exports: {} };
  const deps = { '../../sdk': {}, '../../projectLocalConfig': {}, '../../runtimeContext': {} };
  vm.runInNewContext(transformSync(fs.readFileSync('src/android-debugger/native-debugger/nativeToolchain.ts', 'utf8'), { loader: 'ts', format: 'cjs' }).code, { module, exports: module.exports, require: id => deps[id] ?? require(id), process });
  return module.exports;
}

test('Native overrides isolate explicit SDK and NDK fields without reviving retired backend options', () => {
  const api = fixture();
  const value = api.nativeToolchainOverrides({ sdkRoot: 'sdk', ndkRoot: 'ndk', lldbDapPath: 'retired' });
  assert.deepEqual(JSON.parse(JSON.stringify(value)), { sdkRoot: 'sdk', ndkRoot: 'ndk' });
  for (const input of [null, [], 42, { sdkRoot: '' }, { ndkRoot: 42 }]) assert.throws(() => api.nativeToolchainOverrides(input), /Invalid Native/);
});

test('Native ABI validation rejects unsupported or malformed candidates', () => {
  const api = fixture();
  for (const abi of ['arm64-v8a', 'armeabi-v7a', 'x86', 'x86_64']) assert.doesNotThrow(() => api.validateNativeAbis({ abi, abiSupported: [abi] }));
  for (const value of [{ abi: '../escape' }, { abiSupported: [] }, { abiSupported: ['unknown'] }]) assert.throws(() => api.validateNativeAbis(value), /Invalid Native/);
});
