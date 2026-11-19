const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { transformSync } = require('esbuild');

/** 加载真实Processes和配置入口，仅隔离VSCode/设备边界；验证视图取消与设备连接取消的不同所有权。 */
function fixture(mode = 'native') {
  const f = { calls: [], external: [], notices: [], mode, controller: new AbortController(), connection: new AbortController() };
  const vscode = {
    workspace: { isTrusted: true, workspaceFolders: [{ uri: { fsPath: '/workspace' } }], getConfiguration: () => ({ get: () => f.external }) },
    window: {
      showQuickPick: async items => { f.items = items; return f.pick ? f.pick(items) : items.find(item => item.config?.mode === f.mode); },
      showErrorMessage: async message => f.notices.push(message),
    },
    commands: { async executeCommand(command) { f.calls.push(['view', command]); f.controller.abort(new Error('view hidden')); } },
    debug: {
      onDidStartDebugSession(listener) { f.listener = listener; return { dispose() { f.listener = undefined; } }; },
      async startDebugging(folder, config) {
        f.calls.push(['start', config]);
        f.onStart?.();
        if (f.reject) return false;
        f.listener({ id: 'session', configuration: config });
        return true;
      },
    },
  };
  const apiModule = { exports: {} };
  vm.runInNewContext(transformSync(fs.readFileSync('src/android-debugger/index.ts', 'utf8'), { loader: 'ts', format: 'cjs' }).code,
    { module: apiModule, exports: apiModule.exports, require: id => id === 'vscode' ? vscode : require(id) });
  const backend = { async watch(update) { f.update = update; return async () => {}; } };
  const module = { exports: {} };
  vm.runInNewContext(transformSync(fs.readFileSync('src/processes.ts', 'utf8'), { loader: 'ts', format: 'cjs' }).code,
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
  assert.equal(f.notices.length, 0); await f.processes.dispose();
});

/** 全部有效外部配置保留在菜单，选外部Launch也只能附加当前进程，不改原配置/任务/源码选项。 */
test('Processes menu includes every launch.json request alongside three built-in attaches', async () => {
  const f = fixture();
  const launch = { type: 'android-debug', request: 'launch', mode: 'dual', name: 'External launch', preLaunchTask: 'prepare', apkPath: 'user.apk', java: { type: 'kotlin-jvm', sourcePaths: ['sdk/src'] } };
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
