/** 功能点：旧 Node ADB 调试控制面退出活动调用链；受影响对象：Native/JVM Launch；复现路径：读取模块与活动入口；测试范围：旧API和直接ADB调用；执行入口：npm test；预期结果：只通过Coordinator；判据：无旧导出及引用。 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { transformSync } = require('esbuild');
test('Native launch and JVM launch have no retired Node ADB control plane', () => {
  const module = { exports: {} };
  new Function('module', 'exports', transformSync(fs.readFileSync('src/android-debugger/native-debugger/nativeTarget.ts', 'utf8'), { loader: 'ts', format: 'cjs' }).code)(module, module.exports);
  assert.deepEqual(Object.keys(module.exports), []);
  for (const file of ['src/android-debugger/sessionAdapter.ts', 'src/android-debugger/jvm-debugger/adapter.ts']) {
    const source = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(source, /adbExec|launchDebuggableApp|resolveLauncherActivity|createJdwpForward/);
    assert.match(source, /coordinator/);
  }
});
