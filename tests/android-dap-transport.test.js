/**
 * 功能点：公开配置直接交给JVM executable或Native引擎，无主DAP代理。
 * 受影响对象：registerAndroidDebugging、registerJvmDebugger及宿主descriptor注册。
 * 复现路径：真实provider准备内存设备，调用已注册JVM descriptor或读取Native返回配置。
 * 测试范围：JVM直接JAR命令、Native配置选项、只读tracker与非Android LLDB隔离。
 * 执行入口：node --test tests/android-dap-transport.test.js。
 * 预期结果：返回真实引擎配置或Executable，不创建inline wrapper，不虚构DAP响应。
 * 判据：注册类型、命令、参数与原消息不变，只有Dual允许宿主子启动。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { fixture, jvmFixture, root } = require('./fixture/android-public.cjs');

// 功能：真实注册descriptor直接交付JAR；输入准备后的JVM会话；输出Executable而不是inline实现。
test('JVM公开配置直接进入注册的Executable descriptor', async t => {
  const f = jvmFixture(); t.after(f.close);
  const config = await f.resolve({ java: { adapterJvmArgs: ['-Xmx768m'], logLevel: 'TRACE' } });
  const descriptor = await f.descriptor.createDebugAdapterDescriptor({ id: 'direct', configuration: config, workspaceFolder: f.folder });
  assert.ok(descriptor instanceof f.vscode.DebugAdapterExecutable);
  assert.equal(descriptor.implementation, undefined);
  assert.equal(descriptor.command, path.join(root, 'fixture-jdk', 'bin', 'java'));
  assert.deepEqual(Array.from(descriptor.args), ['-Xmx768m', '-jar', path.join(root, 'resources/jvm-debugger/kotlin-debug-adapter.jar'), '--log-file', path.join(f.context.logUri.fsPath, 'jvm-direct.log'), '--log-level', 'TRACE']);
  assert.deepEqual([...f.factories.keys()], ['android-jvm']);
  assert.equal(f.starts.length, 0);
});

// 功能：Native直接使用LLDB返回配置；输入用户选项；输出原语义及只读tracker。
test('Native交付直接LLDB配置，tracker不写协议或改能力', async t => {
  const f = fixture(); t.after(f.close);
  const config = await f.resolve({ mode: 'native', native: { initCommands: ['settings set target.x 1'], sourceMap: { '/remote': '/local' } } });
  assert.equal(config.type, 'lldb'); assert.equal(config.request, 'attach');
  assert.equal(config.pid, 42); assert.equal(config.serial, 'phone');
  assert.deepEqual(Array.from(config.initCommands), ['settings set target.x 1']);
  const { tracker } = f.track(config);
  const messages = [Object.freeze({ type: 'response', command: 'initialize', success: true, body: Object.freeze({ supportsReadMemoryRequest: true }) }), Object.freeze({ type: 'event', event: 'output', body: Object.freeze({ output: '中文' }) }), Object.freeze({ type: 'request', command: 'runInTerminal', seq: 7 })];
  const before = JSON.stringify(messages);
  for (const value of messages) tracker.onDidSendMessage(value);
  assert.equal(JSON.stringify(messages), before); assert.equal(f.starts.length, 0);
  assert.equal(f.factories.size, 0); assert.equal(tracker.handleMessage, undefined);
});

// 功能：普通LLDB不进入Android路径；输入非Android配置；输出相同对象且零设备操作。
test('普通LLDB配置保持对象身份并不访问设备', async t => {
  const f = fixture(); t.after(f.close);
  const config = Object.freeze({ type: 'lldb', request: 'launch', name: '本地C++', program: '/local/app' });
  assert.equal(await f.providers.get('lldb').resolveDebugConfigurationWithSubstitutedVariables(f.folder, config), config);
  assert.deepEqual(f.calls, []);
});
