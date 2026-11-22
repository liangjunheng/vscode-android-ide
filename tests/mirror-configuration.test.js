const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { transformSync } = require('esbuild');

// 执行真实activate配置及Build/Explorer接线；Node>=22 VM回归断言命名空间读写、恢复、资源归属和只读provider的延迟取值/错误传播。
function fixture(initializeError) {
  const f = { value: false, workspaceValue: undefined, workspaceMode: undefined, globalMode: undefined, writes: [], applied: [], errors: [], instances: [], subscriptions: [], fail: false };
  const listener = { disposed: false, dispose() { this.disposed = true; } };
  const vscode = {
    ConfigurationTarget: { Global: 1, Workspace: 2 },
    workspace: {
      findFiles: async () => [], onDidCreateFiles: () => ({ dispose() {} }), onDidDeleteFiles: () => ({ dispose() {} }), onDidRenameFiles: () => ({ dispose() {} }), onDidChangeWorkspaceFolders: () => ({ dispose() {} }),
      getConfiguration: section => { assert.equal(section, 'android-ide'); return ({
        get: (key, fallback) => key === 'mirrorVisible' ? f.value : fallback,
        inspect: key => key === 'deviceViewMode' ? { workspaceValue: f.workspaceMode, globalValue: f.globalMode } : { workspaceValue: f.workspaceValue },
        update: async (key, value, target) => { if (f.fail) throw new Error('read-only settings'); f.writes.push({ key, value, target }); if (key === 'mirrorVisible') f.value = value; else if (key === 'deviceViewMode') { if (target === 2) f.workspaceMode = value; else f.globalMode = value; } },
      }); },
      onDidChangeConfiguration: fn => { f.listener = fn; return listener; },
    },
    debug: { registerDebugAdapterDescriptorFactory() {} },
    commands: { registerCommand() {}, async executeCommand() {} }, window: { registerWebviewViewProvider() {}, showErrorMessage: error => f.errors.push(error) },
  };
  class Running {
    constructor(ext, action, preference) { this.preference = preference; f.instances.push(this); }
    async applyDeviceViewMode(visible) { if (f.rejectApply) throw new Error('stream failed'); f.applied.push(visible); }
  }
  const deps = { './android-debugger/coordinator/androidCoordinator': { AndroidCoordinator: class { async dispose() {} } }, './android-debugger/adapter': { createAndroidDebugAdapterFactory: () => ({}) }, './android-debugger/jvm-debugger/adapter': { registerJvmDebugger() {} }, './deviceExplorer': { DeviceExplorerController: class {
    // 保存只读provider但激活时不取值，wiring回归验证Build尚未创建时无访问。
    constructor(post, currentApplicationId, resolveDebugProject) { this.currentApplicationId = currentApplicationId; this.resolveDebugProject = resolveDebugProject; f.explorer = this; }
    async dispose() {}
  } }, vscode, './runningDevices': { RunningDeviceView: Running }, './androidBuild': { AndroidBuildController: class {
    // 记录实例和读取次数，供真实activate的闭包回归检查当前选择与错误不被缓存/吞掉。
    constructor() { f.build = this; this.reads = 0; this.applicationId = 'com.example.app'; }
    async initialize() { this.initialized = true; if (initializeError) throw initializeError; }
    // 返回替身当前ID或抛metadata错误；wiring回归断言调用次数和相同异常。
    currentApplicationId() { this.reads++; if (this.error) throw this.error; return this.applicationId; }
    // 精确记录Attach提供方入参，wiring回归验证signal与当前模型结果不被缓存或吞错。
    async resolveCurrentDebugProject(...args) { this.debugProjectArgs = args; if (this.debugProjectError) throw this.debugProjectError; return this.debugProject; }
    dispose() {}
  } }, './logcat': { LogcatView: class {} }, './deviceManager': { registerDeviceManager() {} }, './extendedControls': {} };
  const module = { exports: {} };
  vm.runInNewContext(transformSync(fs.readFileSync(path.join(__dirname, '../src/extension.ts'), 'utf8'), { loader: 'ts', format: 'cjs' }).code, { module, exports: module.exports, require: id => id === './runtimeContext' ? require('./runtime-context-loader.cjs')() : deps[id] });
  f.activate = () => module.exports.activate({ extensionPath: '', subscriptions: f.subscriptions });
  f.disposable = listener;
  return f;
}

// 激活无需打开面板即初始化；初始化失败可见且不阻断其他注册，不产生未观察的拒绝。
test('extension starts Gradle initialization during activation and displays initialization errors', async () => {
  const f = fixture(new Error('cache read failed'));
  assert.doesNotThrow(() => f.activate());
  assert.equal(f.build.initialized, true);
  assert.ok(f.subscriptions.includes(f.build));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.errors, ['Error: cache read failed']);
});

// npm test：按钮默认写用户配置，已有工作区覆盖时只更新覆盖值，配置写入失败向按钮传播。
test('mirror configuration remembers visibility and respects workspace overrides', async () => {
  const f = fixture(); f.activate();
  assert.equal(f.instances[0].preference.visible, false);
  await f.instances[0].preference.save(true);
  assert.equal(f.writes[0].key, 'mirrorVisible');
  assert.equal(f.writes[0].target, 1);
  f.workspaceValue = false;
  await f.instances[0].preference.save(false);
  assert.equal(f.writes[1].target, 2);
  f.activate();
  assert.equal(f.instances[1].preference.visible, false);
  f.fail = true;
  await assert.rejects(f.instances[1].preference.save(true), /read-only/);
  assert.equal(f.value, false);
});

// npm test：设置页只同步相关项，错误可见且监听加入 subscriptions，不产生配置写回循环。
test('mirror configuration changes sync live and own the settings subscription', async () => {
  const f = fixture(); f.activate();
  f.listener({ affectsConfiguration: key => false });
  assert.deepEqual(f.applied, []);
  f.value = true;
  f.listener({ affectsConfiguration: key => key === 'android-ide.mirrorVisible' });
  assert.deepEqual(f.applied, ['mirror']);
  assert.equal(f.writes.length, 0);
  f.rejectApply = true;
  f.listener({ affectsConfiguration: () => true });
  await new Promise(resolve => setImmediate(resolve));
  assert.match(f.errors[0], /stream failed/);
  assert.ok(f.subscriptions.includes(f.disposable));
  f.disposable.dispose(); assert.equal(f.disposable.disposed, true);
});

// npm test：VS Code 布尔配置与 CSS 专用 20px 图标声明可被现有运行器发现并严格断言。
test('mirror configuration schema and enlarged Logcat icon are registered', () => {
  const schema = require('../package.json').contributes.configuration.properties['android-ide.mirrorVisible'];
  assert.equal(schema.type, 'boolean'); assert.equal(schema.default, true); assert.equal(schema.scope, 'window');
  const css = fs.readFileSync(path.join(__dirname, '../media/build-panel.css'), 'utf8');
  assert.match(css, /#build-logcat svg\{width:20px;height:20px;max-width:100%;flex:none\}/);
});

// 执行真实activate配置接线，Processes写入后扩展重建、设置监听及工作区覆盖均保持同一模式。
test('Processes mode persists across activation and respects live workspace configuration',async()=>{
  const f=fixture();f.activate();assert.equal(f.instances.at(-1).preference.mode,'hidden');
  await f.instances.at(-1).preference.saveMode('processes');assert.equal(f.writes.at(-1).key,'deviceViewMode');assert.equal(f.writes.at(-1).target,1);
  f.activate();assert.equal(f.instances.at(-1).preference.mode,'processes');
  f.workspaceMode='explorer';await f.instances.at(-1).preference.saveMode('processes');assert.equal(f.writes.at(-1).target,2);
  f.activate();assert.equal(f.instances.at(-1).preference.mode,'processes');
  const writes=f.writes.length;f.workspaceMode='hidden';f.listener({affectsConfiguration:key=>key==='android-ide.deviceViewMode'});assert.deepEqual(f.applied,['hidden']);assert.equal(f.writes.length,writes);
  f.fail=true;await assert.rejects(f.instances.at(-1).preference.saveMode('mirror'),/read-only/);assert.equal(f.workspaceMode,'hidden');
});

// Node>=22执行真实activate，Attach提供方延迟读取当前Build并保留原包名/工作区/signal及失败对象。
test('extension wires Attach project provider lazily with exact identity and cancellation', async () => {
  const f = fixture(); f.activate();
  assert.equal(f.build.debugProjectArgs, undefined);
  assert.equal(typeof f.explorer.resolveDebugProject, 'function');
  const signal = new AbortController().signal;
  f.build.debugProject = { androidProjectRoot: '/workspace', androidModuleRoot: '/workspace/app', androidVariant: 'debug', androidSourceRoots: [] };
  assert.equal(await f.explorer.resolveDebugProject('com.example.app', '/workspace', signal), f.build.debugProject);
  assert.deepEqual(Array.from(f.build.debugProjectArgs), ['com.example.app', '/workspace', signal]);
  f.build.debugProjectError = new Error('Selected package mismatch');
  await assert.rejects(f.explorer.resolveDebugProject('com.other.app', '/other', signal), error => error === f.build.debugProjectError);
});

// Node>=22执行真实activate：不在构造阶段访问Build，Explorer读取当前ID及缺失undefined，真实metadata故障仍原样传播。
test('extension wires current Build application ID lazily and follows selection changes', () => {
  const f = fixture(); f.activate();
  assert.equal(f.build.reads, 0); assert.equal(typeof f.explorer.currentApplicationId, 'function');
  assert.equal(f.explorer.currentApplicationId(), 'com.example.app');
  f.build.applicationId = 'com.other.release';
  assert.equal(f.explorer.currentApplicationId(), 'com.other.release'); assert.equal(f.build.reads, 2);
  f.build.applicationId = undefined;
  assert.equal(f.explorer.currentApplicationId(), undefined); assert.equal(f.build.reads, 3);
  f.build.error = new Error('Invalid applicationId in metadata');
  assert.throws(() => f.explorer.currentApplicationId(), error => error === f.build.error);
  assert.ok(f.subscriptions.includes(f.build)); assert.ok(f.subscriptions.includes(f.explorer));
});
