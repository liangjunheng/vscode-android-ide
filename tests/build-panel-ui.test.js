const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { transformSync } = require('esbuild');
const js = fs.readFileSync(path.join(__dirname, '../media/build-panel.js'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, '../media/build-panel.css'), 'utf8');

// 执行完整面板脚本，输入初始可见状态并记录DOM/消息；node --test tests/build-panel-ui.test.js断言三模式互斥、宿主确认、按钮状态和空列表，不伪造旧Wi-Fi控件绑定。
function fixture(initialVisible = true) {
  const nodes = {}, sent = [];
  let receive;
  const get = id => nodes[id] ||= { value: '', children: [], textContent: '', disabled: false, title: '', classList: { toggle() {} }, setAttribute(k, v) { this[k] = v; }, replaceChildren() { this.children = []; }, appendChild(o) { this.children.push(o); } };
  vm.runInNewContext(js, { document: { body: { dataset: { mirrorVisible: String(initialVisible) }, classList: { toggle() {} } }, getElementById: get, createElement: () => ({}) }, send: m => sent.push(m), addEventListener: (type, fn) => { receive = fn; } });
  return { get, sent, receive: data => receive({ data }) };
}

// npm test：截图面板在无项目/设备、执行中、错误时呈现正确按钮状态，实际执行所有 UI 动作并断言消息。
test('build panel UI renders safe options and routes all commands', () => {
  const f = fixture(), get = f.get;
  assert.equal(f.sent[0].action, 'refresh');
  assert.equal(f.sent[1].type, 'getMirrorVisibility');
  assert.equal(get('build-run').disabled, true);
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
  assert.equal(f.sent.at(-1).type, 'setDeviceViewMode');
  assert.equal(f.sent.at(-1).mode, 'mirror');
  f.receive({ type: 'mirrorVisibility', visible: true });
  assert.equal(get('build-mirror')['aria-pressed'], 'true');
  get('build-project').onchange();
  assert.equal(f.sent.at(-1).value, 'root');
  get('build-target').onchange();
  assert.equal(f.sent.at(-1).action, 'target');
  for (const action of ['run', 'build', 'install', 'debug', 'refresh', 'output']) { get('build-' + action).onclick(); assert.equal(f.sent.at(-1).action, action); }
  for (const mode of ['explorer', 'processes', 'mirror']) {
    get('build-' + mode).onclick();
    assert.equal(f.sent.at(-1).type, 'setDeviceViewMode');
    assert.equal(f.sent.at(-1).mode, mode);
    f.receive({ type: 'deviceViewMode', mode });
    for (const candidate of ['mirror', 'explorer', 'processes']) assert.equal(get('build-' + candidate)['aria-pressed'], String(candidate === mode));
    assert.equal(get('device-explorer').hidden, mode === 'mirror');
    get('build-' + mode).onclick(); assert.equal(f.sent.at(-1).mode, 'hidden');
    f.receive({ type: 'deviceViewMode', mode: 'hidden' });
    for (const candidate of ['mirror', 'explorer', 'processes']) assert.equal(get('build-' + candidate)['aria-pressed'], 'false');
    assert.equal(get('device-explorer').hidden, true);
  }
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

// npm test：实际投屏类接入可选构建处理器，不增加旧测试依赖；断言当前 serial、Wi-Fi、状态投递和页面资源结构。
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
  assert.equal(calls.at(-1)[0], 'android.pairDevice');
  view.publishBuildState({ type: 'buildState', status: 'Ready' });
  assert.equal(calls.at(-1).status, 'Ready');
  for (const id of ['build-project', 'build-target', 'build-run', 'build-install', 'build-debug', 'build-status']) assert.ok(webview.html.includes('id="' + id + '"'));
  assert.ok(webview.html.includes('build-panel.js'));
  const rowStart = webview.html.indexOf('<div class="build-device-row">'), actionsStart = webview.html.indexOf('<div class="build-actions">');
  assert.ok(rowStart >= 0 && actionsStart > rowStart);
  const row = webview.html.slice(rowStart, actionsStart), actions = webview.html.slice(actionsStart, webview.html.indexOf('id="build-status"'));
  const positions = ['dev', 'build-mirror', 'build-explorer', 'build-processes'].map(id => row.indexOf('id="' + id + '"'));
  assert.ok(positions.every((position, index) => position >= 0 && (!index || position > positions[index - 1])));
  assert.equal(row.includes('id="build-output"'), false); assert.equal(row.includes('id="build-logcat"'), false);
  assert.ok(actions.indexOf('id="build-output"') >= 0 && actions.indexOf('id="build-logcat"') > actions.indexOf('id="build-output"'));
  assert.equal(actions.includes('id="build-mirror"'), false); assert.equal(webview.html.includes('id="build-wifi"'), false);
  assert.ok(css.includes('body.mirror-hidden #wrap'));
  assert.ok(css.includes('repeat(6,minmax(16px,26px))'));
  assert.ok(css.includes('.build-view-modes{display:grid;grid-template-columns:repeat(3,minmax(0,1fr))'));
  assert.ok(webview.html.indexOf('build-panel.css') > webview.html.indexOf('</style>'));
  assert.ok(css.includes('min-width:0'));
  assert.ok(css.includes('@media(max-width:260px)'));
});
// npm test：实际 activate 接线验证构建动作参数、状态回传和控制器加入扩展资源列表。
test('build panel integration owns controller and connects both directions', async () => {
  const calls = [], module = { exports: {} }, subscriptions = [];
  let running, build;
  class Running { constructor(ext, action) { running = this; this.action = action; } publishBuildState(m) { calls.push(m); } }
  class Build { constructor(post) { build = this; this.post = post; } async handle(m, serial) { calls.push([m.action, serial]); } dispose() {} }
  const deps = { vscode: { workspace: { getConfiguration: () => ({ get: (key, fallback) => fallback, inspect: () => undefined }), onDidChangeConfiguration: () => ({ dispose() {} }) }, commands: { registerCommand() {} }, window: { registerWebviewViewProvider() {} } }, './deviceExplorer': { DeviceExplorerController: class { async dispose() {} } }, './androidBuild': { AndroidBuildController: Build }, './runningDevices': { RunningDeviceView: Running }, './deviceManager': { registerDeviceManager() {} }, './logcat': { LogcatView: class {} }, './extendedControls': {} };
  const source = fs.readFileSync(path.join(__dirname, '../src/extension.ts'), 'utf8');
  vm.runInNewContext(transformSync(source, { loader: 'ts', format: 'cjs' }).code, { module, exports: module.exports, require: id => deps[id] });
  module.exports.activate({ extensionPath: '', subscriptions });
  assert.ok(subscriptions.includes(build));
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
