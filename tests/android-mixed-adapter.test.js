/**
 * 功能点：Dual的Native主会话与直接JVM子会话交接。
 * 受影响对象：registerAndroidDebugging、LLDB只读tracker、startDebugging父会话选项。
 * 复现路径：真实provider返回LLDB配置，显式发送attach/configurationDone/continued观测。
 * 测试范围：三项屏障、乱序、stopped及stopOnEntry拒绝、子配置重入和外来tracker。
 * 执行入口：node --test tests/android-mixed-adapter.test.js。
 * 预期结果：只有Native已附加、配置并恢复后才启动一个精确所属JVM，不代理DAP。
 * 判据：宿主调用、父对象、端口次数与资源清理断言全部成立。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture, turn } = require('./fixture/android-public.cjs');

// 功能：生成真实引擎成功观测；输入命令；输出tracker接受的标准响应。
function response(command) { return { type: 'response', command, success: true }; }

// 功能：乱序屏障不提前创建JVM；输入Native真实观测顺序；输出唯一精确父子配置。
for (const order of [['attach', 'configurationDone', 'continued'], ['configurationDone', 'continued', 'attach'], ['continued', 'attach', 'configurationDone']]) test('Dual公开交接顺序：' + order.join('/'), async t => {
  const f = fixture(); t.after(f.close);
  const config = await f.resolve({ mode: 'dual', java: { sourcePaths: ['src/main/java'] } });
  const { session, tracker } = f.track(config);
  for (const command of order.slice(0, -1)) { tracker.onDidSendMessage(command === 'continued' ? { type: 'event', event: command } : response(command)); await turn(); assert.equal(f.starts.length, 0); }
  const last = order.at(-1); tracker.onDidSendMessage(last === 'continued' ? { type: 'event', event: last } : response(last));
  await turn(); assert.equal(f.starts.length, 1);
  const child = f.starts[0]; assert.equal(child.settings.parentSession, session); assert.equal(child.config.type, 'android-jvm');
  assert.equal(child.config.pid, 42); assert.equal(child.config.serial, 'phone'); assert.equal(child.config.port, 4500);
  assert.match(child.config.name, / · JVM$/);
  const forwarded = f.calls.filter(row => row[0] === 'forward').length;
  assert.equal(await f.providers.get('android-jvm').resolveDebugConfigurationWithSubstitutedVariables(f.folder, child.config), child.config);
  assert.equal(f.calls.filter(row => row[0] === 'forward').length, forwarded);
  tracker.onDidSendMessage(response('attach')); await turn(); assert.equal(f.starts.length, 1);
});

// 功能：主Native提前暂停明确失败；输入已配置但stopped的主会话；输出诊断且不创建JVM。
test('Dual主Native暂停时不连接JVM并清理本次Native资源', async t => {
  const f = fixture(); t.after(f.close); const config = await f.resolve({ mode: 'dual' }); const { tracker } = f.track(config);
  tracker.onDidSendMessage({ type: 'event', event: 'stopped' });
  tracker.onDidSendMessage(response('attach')); tracker.onDidSendMessage(response('configurationDone'));
  await turn(); await f.owner.dispose();
  assert.equal(f.starts.length, 0); assert.ok(f.errors.some(value => /Native paused/.test(value)));
  assert.equal(f.calls.filter(row => row[0] === 'native-close').length, 1);
});

// 功能：stopOnEntry不能让Dual死等；输入准备的暂停配置；输出明确拒绝且回收连接。
test('Dual拒绝stopOnEntry且没有JVM转发', async t => {
  const f = fixture(); t.after(f.close);
  await assert.rejects(f.resolve({ mode: 'dual', native: { stopOnEntry: true } }), /requires Native to continue/);
  assert.equal(f.starts.length, 0); assert.equal(f.calls.some(row => row[0] === 'forward'), false);
  assert.equal(f.calls.filter(row => row[0] === 'native-close').length, 1);
});

// 功能：JVM宿主拒绝不变成Dual成功；输入外部start失败；输出可见诊断与两项资源回收。
test('Dual的JVM宿主启动拒绝时关闭本次Native和转发', async t => {
  const f = fixture({ start: async () => false }); t.after(f.close);
  const config = await f.resolve({ mode: 'dual', request: 'launch' }), { tracker } = f.track(config);
  tracker.onDidSendMessage(response('attach')); tracker.onDidSendMessage(response('configurationDone'));
  tracker.onDidSendMessage({ type: 'event', event: 'continued' }); await turn(); await f.owner.dispose();
  assert.equal(f.starts.length, 1); assert.ok(f.errors.some(value => /JVM debugger did not attach/.test(value)));
  for (const kind of ['forward-close', 'native-close', 'clear', 'stop']) assert.equal(f.calls.filter(row => row[0] === kind).length, 1, kind);
});

// 功能：外来会话不可取得本次tracker；输入不同名称或串号；输出undefined且不启动子会话。
test('外来LLDB会话不获得Android运行tracker', async t => {
  const f = fixture(); t.after(f.close); const config = await f.resolve({ mode: 'dual' });
  for (const changes of [{ name: '外来' }, { serial: 'other' }]) assert.equal(f.track({ ...config, ...changes }, 'foreign').tracker, undefined);
  assert.equal(f.starts.length, 0);
});
