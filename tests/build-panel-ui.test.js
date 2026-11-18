const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { transformSync } = require('esbuild');
const js = fs.readFileSync(path.join(__dirname, '../media/build-panel.js'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, '../media/build-panel.css'), 'utf8');

// 执行面板完整脚本并记录真实 DOM 状态与宿主消息；npm test 回归涵盖按钮、状态、选择及空列表。
function fixture(initialVisible = true) {
  const nodes = {}, sent = [];
  let receive;
  const get = id => nodes[id] ||= { value: '', children: [], textContent: '', disabled: false, title: '', classList: { toggle() {} }, setAttribute(k, v) { this[k] = v; }, replaceChildren() { this.children = []; }, appendChild(o) { this.children.push(o); } };
  vm.runInNewContext(js, { document: { body: { dataset: { mirrorVisible: String(initialVisible) }, classList: { toggle() {} } }, getElementById: get, createElement: () => ({}) }, send: m => sent.push(m), addEventListener: (type, fn) => { receive = fn; } });
  return { get, sent, receive: data => receive({ data }) };
}

// npm test：实际脚本验证无项目/设备、busy和错误按钮状态；已移除工具不再绑定，构建和Logcat消息保持。
test('build panel UI renders safe options and routes all commands', () => {
  const f = fixture(), get = f.get;
  assert.equal(f.sent[0].action, 'refresh');
  assert.equal(f.sent[1].type, 'getMirrorVisibility');
  assert.equal(get('build-run').disabled, true);
  assert.equal(get('build-profiler').onclick, undefined);
  assert.equal(get('build-logcat').disabled, false);
  get('build-logcat').onclick();
  assert.equal(f.sent.at(-1).type, 'logcat');
  const state = { type: 'buildState', projects: [{ id: 'root', label: '<Project>' }], project: 'root', targets: [{ id: ':app:Debug', label: 'app | debug' }], target: ':app:Debug', busy: false, status: 'Ready' };
  f.receive(state);
  assert.equal(get('build-project').children[0].textContent, '<Project>');
  assert.equal(get('build-target').value, ':app:Debug');
  assert.equal(get('build-build').disabled, false);
  assert.equal(get('build-install').disabled, true);
  f.receive({ type: 'devices', serial: 'phone' });
  assert.equal(get('build-run').disabled, false);
  assert.equal(get('build-logcat').disabled, false);
  get('build-logcat').onclick();
  assert.equal(f.sent.at(-1).type, 'logcat');
  get('build-mirror').onclick();
  assert.equal(f.sent.at(-1).type, 'setDeviceViewMode');
  assert.equal(f.sent.at(-1).mode, 'hidden');
  f.receive({ type: 'mirrorVisibility', visible: false });
  assert.equal(get('build-mirror')['aria-pressed'], 'false');
  assert.equal(get('build-mirror').title, 'Show mirroring');
  get('build-mirror').onclick();
  assert.equal(f.sent.at(-1).mode, 'mirror');
  f.receive({ type: 'mirrorVisibility', visible: true });
  assert.equal(get('build-mirror')['aria-pressed'], 'true');
  get('build-project').onchange();
  assert.equal(f.sent.at(-1).value, 'root');
  get('build-target').onchange();
  assert.equal(f.sent.at(-1).action, 'target');
  for (const action of ['run', 'build', 'install', 'debug', 'refresh', 'output']) { get('build-' + action).onclick(); assert.equal(f.sent.at(-1).action, action); }
  assert.equal(get('build-wifi').onclick, undefined);
  assert.equal(f.sent.some(message => message.type === 'pairDevice'), false);
  f.receive({ ...state, busy: true, status: 'Gradle :app:installDebug' });
  assert.equal(get('build-run-label').textContent, 'Stop');
  assert.equal(get('build-run').disabled, false);
  assert.equal(get('build-target').disabled, true);
  assert.equal(get('build-logcat').disabled, false);
  get('build-run').onclick();
  assert.equal(f.sent.at(-1).action, 'stop');
  f.receive({ ...state, busy: false, running: true });
  assert.equal(get('build-run-label').textContent, 'Stop');
  get('build-run').onclick();
  assert.equal(f.sent.at(-1).action, 'stop');
  f.receive({ ...state, error: 'Build failed' });
  assert.equal(get('build-status').textContent, 'Build failed');
  f.receive({ type: 'devices', serial: undefined });
  assert.equal(get('build-logcat').disabled, false);
  get('build-logcat').onclick(); assert.equal(f.sent.at(-1).type, 'logcat');
  f.receive({ type: 'buildState', targets: [], projects: [], busy: false });
  assert.equal(get('build-target').children[0].textContent, 'No Android variants');
  assert.equal(get('build-run').disabled, true);
});

// npm test：真实模板断言构建栏仅七项且以Logcat结尾；保留设备视图、配对及构建宿主接线。
test('build panel bridge routes selected serial and publishes snapshots', async () => {
  const module = { exports: {} }, calls = [];
  const vscode = { Uri: { file: p => p, joinPath: (...p) => p.join('/') }, commands: { executeCommand: (...args) => { calls.push(args); } } };
  const deps = { vscode, './sdk': {}, './emulatorGrpc': {}, './scrcpy': {}, './skin': {} };
  const source = fs.readFileSync(path.join(__dirname, '../src/runningDevices.ts'), 'utf8');
  vm.runInNewContext(transformSync(source, { loader: 'ts', format: 'cjs' }).code, { module, exports: module.exports, process, Buffer, require: id => Object.hasOwn(deps, id) ? deps[id] : require(id) });
  const view = new module.exports.RunningDeviceView('', async (m, serial) => { calls.push([m.action, serial]); });
  let receive;
  const webview = { cspSource: 'test:', asWebviewUri: p => p, postMessage: m => calls.push(m), onDidReceiveMessage: fn => { receive = fn; } };
  view.icons = () => ({});
  view.resolveWebviewView({ webview, onDidDispose() {}, onDidChangeVisibility() {} });
  view.serial = 'phone';
  await receive({ type: 'buildPanel', action: 'install' });
  assert.deepEqual(calls.at(-1), ['install', 'phone']);
  await receive({ type: 'pairDevice' });
  assert.equal(calls.at(-1)[0], 'android-ide.pairDevice');
  view.publishBuildState({ type: 'buildState', status: 'Ready' });
  assert.equal(calls.at(-1).status, 'Ready');
  for (const id of ['build-project', 'build-target', 'build-run', 'build-install', 'build-debug', 'build-status']) assert.ok(webview.html.includes('id="' + id + '"'));
  assert.ok(webview.html.includes('build-panel.js'));
  const output = webview.html.indexOf('id="build-output"'), logcat = webview.html.indexOf('id="build-logcat"'), mirror = webview.html.indexOf('id="build-mirror"');
  assert.ok(mirror < output && output < logcat);
  const deviceRow = webview.html.slice(webview.html.indexOf('<div class="build-device-row">'), webview.html.indexOf('<div class="build-actions">'));
  const actionRow = webview.html.slice(webview.html.indexOf('<div class="build-actions">'), webview.html.indexOf('<div class="build-status"'));
  assert.ok(deviceRow.indexOf('id="dev"') < deviceRow.indexOf('id="build-mirror"'));
  for (const id of ['build-mirror', 'build-explorer', 'build-processes']) {
    assert.equal(deviceRow.split('id="' + id + '"').length, 2);
    assert.equal(actionRow.includes('id="' + id + '"'), false);
  }
  assert.equal(webview.html.includes('id="build-wifi"'), false);
  assert.equal(js.includes("get('build-wifi')"), false);
  assert.ok(css.includes('body.mirror-hidden #wrap'));
  assert.ok(css.includes('repeat(6,minmax(16px,26px))'));
  const buttons = [...actionRow.matchAll(/<button id="([^"]+)"/g)].map(match => match[1]);
  assert.deepEqual(buttons, ['build-run', 'build-build', 'build-install', 'build-debug', 'build-refresh', 'build-output', 'build-logcat']);
  assert.equal(webview.html.includes('build-profiler'), false);
  assert.ok(webview.html.includes('class="build-view-separator"'));
  assert.ok(webview.html.includes('class="build-view-modes"'));
  assert.ok(webview.html.includes('id="build-explorer"'));
  assert.ok(webview.html.indexOf('build-panel.css') > webview.html.indexOf('</style>'));
  assert.ok(css.includes('min-width:0'));
  assert.ok(css.includes('@media(max-width:260px)'));
});
// npm test：实际activate断言已移除命令不再注册，同时保留构建动作、状态、控制器和调试工厂。
test('build panel integration owns controller and connects both directions', async () => {
  const calls = [], registrations = [], commandNames = [], module = { exports: {} }, subscriptions = [];
  let running, build;
  class Running { constructor(ext, action) { running = this; this.action = action; } publishBuildState(m) { calls.push(m); } }
  class Build { constructor(post) { build = this; this.post = post; } async handle(m, serial) { calls.push([m.action, serial]); } dispose() {} }
  const debugFactory = {};
  const extensionContext = { extensionPath: 'extension-root', subscriptions };
  const factoryContexts = [];
  const vscode = { workspace: { getConfiguration: () => ({ get: (key, fallback) => fallback, inspect: () => undefined }), onDidChangeConfiguration: () => ({ dispose() {} }) }, commands: { registerCommand(name) { commandNames.push(name); } }, window: { registerWebviewViewProvider() {} }, debug: { registerDebugAdapterDescriptorFactory: (type, factory) => { registrations.push([type, factory]); return { dispose() {} }; } } };
  const deps = { './deviceExplorer': { DeviceExplorerController: class { async setContext() {} async handle() {} async dispose() {} } }, vscode, './androidBuild': { AndroidBuildController: Build }, './runningDevices': { RunningDeviceView: Running }, './deviceManager': { registerDeviceManager() {} }, './logcat': { LogcatView: class {} }, './extendedControls': {}, './android-debugger/jvm-debugger/adapter': { createAndroidDebugAdapterFactory: context => { factoryContexts.push(context); return debugFactory; } } };
  const source = fs.readFileSync(path.join(__dirname, '../src/extension.ts'), 'utf8');
  vm.runInNewContext(transformSync(source, { loader: 'ts', format: 'cjs' }).code, { module, exports: module.exports, require: id => id === './runtimeContext' ? require('./runtime-context-loader.cjs')() : deps[id] });
  module.exports.activate(extensionContext);
  assert.ok(subscriptions.includes(build));
  assert.equal(commandNames.includes('android-ide.openProfiler'), false);
  assert.ok(commandNames.includes('android-ide.showLogcat'));

  // 回归扩展调试接线：activate 必须以 android-tools 类型注册准确工厂，避免调试入口静默缺失。
  assert.equal(registrations.length, 1);
  assert.equal(registrations[0][0], 'android-tools');
  assert.equal(registrations[0][1], debugFactory);
  assert.equal(factoryContexts[0], extensionContext);
  await running.action({ action: 'build' }, 'phone');
  assert.deepEqual(calls.at(-1), ['build', 'phone']);
  build.post({ type: 'buildState', status: 'Ready' });
  assert.equal(calls.at(-1).status, 'Ready');
});
// npm test：脚本尚未收到宿主消息时使用页面初始配置，隐藏状态不会在初始化期间错误显示选中。
test('build panel initial mirror state reflects restored markup before messages', () => {
  const f = fixture(false);
  assert.equal(f.get('build-mirror')['aria-pressed'], 'false');
  assert.equal(f.get('build-mirror').title, 'Show mirroring');
  assert.equal(f.sent.at(-1).type, 'getMirrorVisibility');
  f.receive({ type: 'mirrorVisibility', visible: true });
  assert.equal(f.get('build-mirror')['aria-pressed'], 'true');
});
