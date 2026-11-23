const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { transformSync } = require('esbuild');
const path = require('node:path');
const autoModule = { exports: {} };
vm.runInNewContext(transformSync(fs.readFileSync(path.join(__dirname, '../src/android-debugger/autoConfig.ts'), 'utf8'), { loader: 'ts', format: 'cjs' }).code,
  { module: autoModule, exports: autoModule.exports });

/** 功能点：Processes附加启动与视图/设备取消的所有权交接。
 * 受影响对象：ProcessesController、startAndroidDebugging、真实startup登记及宿主start/termination订阅。
 * 复现路径：Node>=22，加载真实入口及 autoConfig，输入进程快照，显式报告实际类型会话与 connected 后导航取消视图；拒绝与预先取消单独注入。
 * 测试范围：Native/Java/Dual附加、外部Launch转Attach、配置保留、类型转换后的身份、视图隐藏、启动拒绝和监听释放。
 * 执行入口：node --test tests/process-attach-start.test.js；完整入口npm test。
 * 预期结果：先启动后导航，已交接启动只受设备连接取消管理；拒绝可见且所有宿主监听注销。
 * 判据：精确配置/调用顺序/通知及监听集合符合断言，不连接设备或启动真实引擎。
 */
// 功能：隔离宿主及设备边界加载真实Processes；输入模式；输出集合事件边界、连接与视图信号，供本文件用例使用。
function fixture(mode = 'native') {
  const f = { calls: [], external: [], notices: [], mode, controller: new AbortController(), connection: new AbortController(), starts: new Set(), ends: new Set() };
  f.report = session => { for (const listener of [...f.starts]) listener(session); };
  f.terminate = session => { for (const listener of [...f.ends]) listener(session); };
  const vscode = {
    workspace: { isTrusted: true, workspaceFolders: [{ uri: { fsPath: '/workspace' } }], getConfiguration: () => ({ get: () => f.external }) },
    window: {
      showQuickPick: async items => { f.items = items; return f.pick ? f.pick(items) : items.find(item => item.config?.mode === f.mode); },
      showErrorMessage: async message => f.notices.push(message),
    },
    commands: { async executeCommand(command) { f.calls.push(['view', command]); f.controller.abort(new Error('view hidden')); } },
    debug: {
      // 功能：登记精确start订阅；输入监听器；输出仅注销自身的对象，供启动交接回归使用。
      onDidStartDebugSession(listener) { f.starts.add(listener); return { dispose() { f.starts.delete(listener); } }; },
      // 功能：登记精确termination订阅；输入监听器；输出仅注销自身的对象，不省略真实宿主契约。
      onDidTerminateDebugSession(listener) { f.ends.add(listener); return { dispose() { f.ends.delete(listener); } }; },
      // 功能：停止指定会话；输入真实入口观察到的对象；输出记录与匹配termination事件。
      async stopDebugging(session) { f.calls.push(['stop', session]); f.terminate(session); },
      // 功能：报告宿主接受与独立连接结果；输入映射配置；输出实际类型会话及已连接 Promise，拒绝时不伪造连接。
      async startDebugging(folder, config) {
        f.calls.push(['start', config]);
        f.onStart?.();
        if (f.reject) return false;
        const resolved = { ...config, type: config.type === 'android-debug' ? (config.mode === 'java' ? 'android-jvm' : 'android-tools') : config.type };
        startup.reportDebugConnection(resolved, Promise.resolve());
        f.report({ id: 'session', configuration: resolved });
        return true;
      },
    },
  };
  const apiModule = { exports: {} };
  const startup = require('./debug-startup-loader.cjs')();
  vm.runInNewContext(transformSync(fs.readFileSync(path.join(__dirname, '../src/android-debugger/index.ts'), 'utf8'), { loader: 'ts', format: 'cjs' }).code,
    { module: apiModule, exports: apiModule.exports, AbortController, console, require: id => id === './startup' ? startup : id === 'vscode' ? vscode : id === './autoConfig' ? autoModule.exports : require(id) });
  const backend = { async watch(update) { f.update = update; return async () => {}; } };
  const module = { exports: {} };
  vm.runInNewContext(transformSync(fs.readFileSync(path.join(__dirname, '../src/processes.ts'), 'utf8'), { loader: 'ts', format: 'cjs' }).code,
    { module, exports: module.exports, require: id => id === 'vscode' ? vscode : id === './android-debugger' ? apiModule.exports : id === './deviceExplorerProcesses' ? { DeviceExplorerProcesses: class { constructor() { Object.assign(this, backend); } } } : require(id) });
  f.processes = new module.exports.ProcessesController('phone', f.connection.signal, () => {});
  return f;
}

/** 三种内置Attach均先分配会话，再导航；面板隐藏不取消已经交给连接生命周期的启动。 */
for (const mode of ['native', 'java', 'dual']) test('Processes ' + mode + ' attaches before view navigation cancellation', async () => {
  const f = fixture(mode);
  await f.processes.start(false, []);
  f.update([{ pid: 42, packageName: 'com.example.app', abi: 'arm64-v8a' }]);
  await f.processes.handle({ action: 'debug', pid: 42 }, f.controller.signal);
  assert.equal(f.items.length, 3);
  assert.deepEqual(f.calls.map(call => call[0]), ['start', 'view']);
  const config = f.calls[0][1];
  assert.equal(config.request, 'attach'); assert.equal(config.mode, mode);
  assert.equal(config.serial, 'phone'); assert.equal(config.pid, 42); assert.equal(config.processId, 42);
  assert.equal(f.controller.signal.aborted, true); assert.equal(f.connection.signal.aborted, false);
  assert.equal(f.notices.length, 0); assert.equal(f.starts.size, 0); assert.equal(f.ends.size, 0); await f.processes.dispose();
});

/** 全部有效外部配置保留在菜单，选外部Launch也只能附加当前进程，不改原配置/任务/源码选项。 */
test('Processes menu includes every launch.json request alongside three built-in attaches', async () => {
  const f = fixture();
  const launch = { type: 'android-debug', request: 'launch', mode: 'dual', name: 'External launch', preLaunchTask: 'prepare', apkPath: 'user.apk', java: { type: 'android-jvm', sourcePaths: ['sdk/src'] } };
  const attach = { type: 'external', request: 'attach', name: 'External attach' };
  f.external = [launch, attach, attach, { type: 'bad', request: 'invalid', name: 'Invalid' }];
  f.pick = items => items.find(item => item.config === launch);
  await f.processes.start(false, []); f.update([{ pid: 42, packageName: 'com.example.app' }]);
  await f.processes.handle({ action: 'debug', pid: 42 }, f.controller.signal);
  assert.equal(f.items.length, 5);
  assert.equal(f.items[3].config, launch); assert.equal(f.items[4].config, attach);
  const config = f.calls[0][1]; assert.equal(config.request, 'attach'); assert.equal(config.pid, 42);
  assert.equal(config.preLaunchTask, 'prepare'); assert.deepEqual(Array.from(config.java.sourcePaths), ['sdk/src']);
  assert.equal(launch.request, 'launch'); await f.processes.dispose();
});

/** 显式面板取消仍阻止交接，启动拒绝即使面板隐藏也必须通过宿主通知可见。 */
test('Processes preserves pre-start cancellation and surfaces attach refusal', async () => {
  const cancelled = fixture(); await cancelled.processes.start(false, []); cancelled.update([{ pid: 42 }]);
  cancelled.pick = items => { cancelled.controller.abort(new Error('cancelled')); return items[0]; };
  await assert.rejects(cancelled.processes.handle({ action: 'debug', pid: 42 }, cancelled.controller.signal), /cancelled/);
  assert.equal(cancelled.calls.length, 0); await cancelled.processes.dispose();
  const refused = fixture(); await refused.processes.start(false, []); refused.update([{ pid: 42 }]); refused.reject = true;
  await assert.rejects(refused.processes.handle({ action: 'debug', pid: 42 }, refused.controller.signal), /did not start/);
  assert.match(refused.notices[0], /attach failed/); assert.equal(refused.calls.some(call => call[0] === 'view'), false);
  await refused.processes.dispose();
});
