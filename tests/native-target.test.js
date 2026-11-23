/**
 * 功能点：当前Native目标走debugging设备路径，死模块不回到活动依赖图。
 * 受影响对象：debugging.ts、device.ts、Native prepareNativeConnection及公开注册。
 * 复现路径：真实provider使用内存设备准备精确Native目标，并检查当前源码依赖边界。
 * 测试范围：Device身份、项目根、PID和workspaceState交接；无旧控制器/代理导入。
 * 执行入口：node --test tests/native-target.test.js。
 * 预期结果：Native连接通过当前DebugDevice准备，直接返回LLDB配置。
 * 判据：精确调用参数成立，活动源码不引用已删除模块，设备无真实调用。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { fixture, root } = require('./fixture/android-public.cjs');

// 功能：设备目标通过当前公开provider交接；输入Native配置；输出精确设备和根目录。
test('Native目标通过debugging的DebugDevice直接交接', async t => {
  const f = fixture(); t.after(f.close); const config = await f.resolve({ mode: 'native', projectRoot: 'app' });
  const call = f.calls.find(row => row[0] === 'native');
  assert.equal(call[1], 42); assert.equal(call[2], 'phone'); assert.equal(call[3], path.join(root, 'app'));
  assert.equal(call[4], f.folder); assert.equal(call[5], f.context.workspaceState);
  assert.equal(config.type, 'lldb'); assert.equal(config.androidLldbServerSocket, 'fixture-socket');
});

// 功能：活动源码禁止死模块依赖；输入当前实现文件；输出源码边界断言而非读取删除文件。
test('当前调试路径没有已删除的内部模块和代理接口', () => {
  const files = ['debugging.ts', 'device.ts', 'index.ts', 'startup.ts', 'jvm-debugger/adapter.ts', 'native-debugger/adapter.ts'];
  for (const relative of files) {
    const source = fs.readFileSync(path.join(root, 'src/android-debugger', relative), 'utf8');
    assert.doesNotMatch(source, /(?:from\s*|require\s*\()\s*['"][^'"]*(?:coordinator\/|sessionAdapter|\/engines|\.\/tasks|nativeTarget)/, relative);
    assert.doesNotMatch(source, /startJvmEngine|startNativeEngine|AndroidDebugCoordinatorClient|AndroidCoordinator|createAndroidDebugAdapterFactory/, relative);
  }
  const debugging = fs.readFileSync(path.join(root, 'src/android-debugger/debugging.ts'), 'utf8');
  assert.match(debugging, /new DebugDevice\(serial, config\.androidProjectRoot\)/);
  assert.match(debugging, /prepareNativeConnection\(this\.config, this\.pid!, this\.device/);
  const jvm = fs.readFileSync(path.join(root, 'src/android-debugger/jvm-debugger/adapter.ts'), 'utf8');
  assert.match(jvm, /new vscode\.DebugAdapterExecutable/); assert.doesNotMatch(jvm, /DebugAdapterInlineImplementation/);
});
