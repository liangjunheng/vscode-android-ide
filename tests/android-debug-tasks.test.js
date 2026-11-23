/**
 * 功能点：外部调试任务由宿主处理，Android只配置端口与资源归属。
 * 受影响对象：公开provider的JVM配置、index配置绑定及直接宿主start调用。
 * 复现路径：内存设备加载真实入口；传入用户preLaunchTask与明确端口。
 * 测试范围：外部端口、无任务自建转发、非法端口、原配置不变及任务原样交给宿主。
 * 执行入口：node --test tests/android-debug-tasks.test.js。
 * 预期结果：不再运行已删除任务runner；外部端口不分配或回收自有转发。
 * 判据：返回配置、forward次数及start实参严格符合断言。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./fixture/android-public.cjs');

// 功能：显式外部任务和端口保留所有权；输入顶层或嵌套JVM配置；输出无自有转发。
for (const direct of [true, false]) test('外部任务端口归宿主管理：' + (direct ? '顶层' : '嵌套'), async () => {
  const f = fixture(), options = { preLaunchTask: '用户构建和转发', port: 45678, hostName: 'external.test' };
  const config = await f.resolve(direct ? { type: 'android-jvm', ...options } : { java: options });
  assert.equal(config.preLaunchTask, options.preLaunchTask); assert.equal(config.port, options.port); assert.equal(config.hostName, options.hostName);
  await f.close(); assert.equal(f.calls.some(row => row[0].startsWith('forward')), false);
});

// 功能：端口缺少有效外部任务时创建自有转发；输入空白任务或零端口；输出本地自有端口。
for (const java of [{ port: 4501 }, { port: 4501, preLaunchTask: '   ' }, { port: 0, preLaunchTask: '构建' }]) test('非外部连接创建自有转发：' + JSON.stringify(java), async () => {
  const f = fixture(), config = await f.resolve({ java });
  assert.equal(config.port, 4500); assert.equal(config.hostName, '127.0.0.1');
  await f.close(); assert.equal(f.calls.filter(row => row[0] === 'forward').length, 1); assert.equal(f.calls.filter(row => row[0] === 'forward-close').length, 1);
});

// 功能：非法端口不可交给宿主或建立转发；输入非整数及越界；输出直接拒绝。
for (const port of [-1, 65536, 1.5, '4500']) test('非法JVM端口拒绝：' + port, async t => {
  const f = fixture(); t.after(f.close); await assert.rejects(f.resolve({ java: { port, preLaunchTask: '外部任务' } }), /Invalid JVM debug port/);
  assert.equal(f.calls.some(row => row[0] === 'forward'), false);
});

// 功能：公开启动不执行用户任务；输入冻结配置；输出宿主接收原任务名并返回真实会话。
test('startAndroidDebugging只将任务配置交给宿主且不修改输入', async t => {
  const f = fixture({ start: async (_folder, config, _settings, host) => { host.started.fire({ id: 'task-root', configuration: config }); return true; } }); t.after(f.close);
  const config = Object.freeze({ type: 'android-jvm', name: '外部任务启动', request: 'attach', preLaunchTask: '原始任务', port: 45678 });
  const before = JSON.stringify(config), session = await f.index.startAndroidDebugging(f.folder, config, { serial: 'phone', packageName: 'com.example.app' });
  assert.equal(session.id, 'task-root'); assert.equal(f.starts.length, 1); assert.equal(f.starts[0].config.preLaunchTask, '原始任务');
  assert.equal(JSON.stringify(config), before); assert.equal(f.calls.some(row => row[0] === 'devices'), false);
});
