/**
 * 功能点：直接JVM引擎descriptor的启动边界，替代已删除传输wrapper。
 * 受影响对象：registerJvmDebugger及公开provider配置、findJava和宿主Executable。
 * 复现路径：真实注册并创建descriptor，仅模拟文件系统、JDK查找与宿主API。
 * 测试范围：配置优先级、空参数、日志隔离、缺JAR及原始查找错误；协议字节交由真实引擎入口覆盖。
 * 执行入口：node --test tests/android-engine-transport.test.js。
 * 预期结果：VS Code直接启动JAR，descriptor不spawn、不建TCP或代理消息。
 * 判据：完整命令参数和错误身份一致；非法输入不查找Java。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { jvmFixture } = require('./fixture/android-public.cjs');

// 功能：会话显式空参数覆盖宿主默认；输入两个会话；输出独立日志且无额外进程。
test('直接descriptor保留空JVM参数并按会话隔离日志', async t => {
  const f = jvmFixture({ settings: { javaHome: '/test/jdk', adapterJvmArgs: ['-Xmx1g'], logLevel: 'WARN' } }); t.after(f.close);
  const config = await f.resolve({ java: { adapterJvmArgs: [], logLevel: 'TRACE' } });
  const a = await f.descriptor.createDebugAdapterDescriptor({ id: 'a', configuration: config, workspaceFolder: f.folder });
  const b = await f.descriptor.createDebugAdapterDescriptor({ id: 'b', configuration: {}, workspaceFolder: f.folder });
  assert.equal(a.args[0], '-jar'); assert.equal(b.args[0], '-Xmx1g');
  assert.equal(a.args.at(-1), 'TRACE'); assert.equal(b.args.at(-1), 'WARN');
  assert.equal(a.args[a.args.indexOf('--log-file') + 1], path.join(f.context.logUri.fsPath, 'jvm-a.log'));
  assert.equal(b.args[b.args.indexOf('--log-file') + 1], path.join(f.context.logUri.fsPath, 'jvm-b.log'));
  assert.deepEqual(f.calls.filter(row => row[0] === 'java'), [['java', '/test/jdk'], ['java', '/test/jdk']]);
  assert.equal(f.starts.length, 0);
});

// 功能：缺资源或JDK错误不降级；输入边界错误；输出实际失败且没有替代引擎。
test('直接descriptor缺JAR或JDK查找失败不创建替代引擎', async t => {
  const absent = jvmFixture({ jar: false }); t.after(absent.close);
  await assert.rejects(absent.descriptor.createDebugAdapterDescriptor({ id: 'missing', configuration: {} }), /JAR 不存在/);
  assert.equal(absent.calls.some(row => row[0] === 'java'), false);
  const failure = new Error('JDK原始错误'), broken = jvmFixture({ javaError: failure }); t.after(broken.close);
  await assert.rejects(broken.descriptor.createDebugAdapterDescriptor({ id: 'broken', configuration: {} }), error => error === failure);
  assert.equal(broken.calls.some(row => row[0] === 'mkdir'), false);
});

// 功能：非法配置先拒绝；输入非字符串参数与未知日志级别；输出错误和零Java查找。
for (const configuration of [{ adapterJvmArgs: '-Xmx1g' }, { adapterJvmArgs: [7] }, { logLevel: 'SILENT' }]) test('直接descriptor拒绝非法配置：' + JSON.stringify(configuration), async t => {
  const f = jvmFixture(); t.after(f.close);
  await assert.rejects(f.descriptor.createDebugAdapterDescriptor({ id: 'invalid', configuration }), /必须/);
  assert.equal(f.calls.some(row => row[0] === 'java'), false);
});
