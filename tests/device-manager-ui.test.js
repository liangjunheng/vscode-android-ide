const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { transformSync } = require('esbuild');
const pkg = require('../package.json');
const runningSource = fs.readFileSync(path.join(__dirname, '../src/runningDevices.ts'), 'utf8');

// 在现有 Node 运行器中转译实际 TS 模块；只替换宿主/设备依赖，不新增生产导出。
function load(name, dependencies) {
  const src = fs.readFileSync(path.join(__dirname, '../src/' + name + '.ts'), 'utf8');
  const module = { exports: {} };
  vm.runInNewContext(transformSync(src, { loader: 'ts', format: 'cjs' }).code, {
    module, exports: module.exports, Buffer, console, process, AbortController, setTimeout, clearTimeout, setInterval, clearInterval,
    require: (id) => id.endsWith('/runtimeContext') ? require('./runtime-context-loader.cjs')(dependencies) : Object.hasOwn(dependencies, id) ? dependencies[id] : require(id),
  });
  return module.exports;
}


// npm test：执行真实 select/restart/refreshDevices，替换流启动依赖；断言旧流停止、所选串号、空选择、掉线和错误传播。
test('mirror selection clears previous frames and never falls back to another phone', async () => {
  let devices = [{ serial: 'phone', state: 'device' }, { serial: 'other', state: 'device' }], failure;
  const { RunningDeviceView } = load('runningDevices', { vscode: { commands: { executeCommand: async (...args) => commands.push(args) }, workspace: { getConfiguration: () => ({ get: () => 150 }) } }, './sdk': { listDevices: async () => { if (failure) throw failure; return devices; } }, './emulatorGrpc': {}, './scrcpy': {}, './skin': { skinForAvd: () => undefined } });
  const mirror = new RunningDeviceView('');
  const messages = [], started = [], commands = [];
  let stopped = 0;
  mirror.view = { visible: true, webview: { postMessage: (m) => messages.push(m) } };
  mirror.pickMode = () => 'screencap';
  mirror.startScreencap = () => { started.push(mirror.serial); mirror.loop = {}; };
  mirror.session = { stop: () => stopped++ };
  await mirror.select({ serial: 'phone' });
  assert.equal(stopped, 1);
  assert.equal(messages.find((m) => m.type === 'devices').devices.length, 0);
  assert.equal(started.at(-1), 'phone');
  assert.equal(messages.find((m) => m.devices?.length).devices.length, 2);
  assert.deepEqual(messages.filter((m) => m.type === 'deviceLoading').map((m) => m.loading), [true, false]);
  await mirror.select();
  assert.equal(mirror.serial, undefined);
  assert.equal(started.length, 1);
  devices = [{ serial: 'other', state: 'device' }];
  await mirror.select({ serial: 'phone' });
  assert.equal(mirror.serial, undefined);
  assert.equal(started.length, 1);
  failure = new Error('adb unavailable');
  await assert.rejects(mirror.select({ serial: 'phone' }), /adb unavailable/);
  await assert.rejects(mirror.show({ serial: 'phone' }), /adb unavailable/);
  await assert.rejects(mirror.refresh(), /adb unavailable/);
  await mirror.onMessage({ type: 'openDM' });
  assert.deepEqual(commands.at(-1), ['android-ide.addDevice']);
  mirror.view.visible = false;
  await mirror.select({ serial: 'other' });
  assert.equal(mirror.serial, 'other');
  assert.equal(started.length, 1);
});


// npm test：无设备验证标题栏布局、Wi-Fi 深浅主题资源及创建后顺序；断言注册项和刷新错误提示。
test('title selector replaces device list and registers only the mirror view', async () => {
  assert.deepEqual(pkg.contributes.views.androidTools.map(v => v.id), ['android-ide.runningDevice']);
  assert.equal(pkg.contributes.views.androidTools[0].name, 'Device Tools');
  const menus = pkg.contributes.menus['view/title'];
  assert.ok(menus.every(m => m.when === 'view == android-ide.runningDevice'));
  const pair = pkg.contributes.commands.find(c => c.command === 'android-ide.pairDevice');
  for (const theme of ['light', 'dark']) {
    assert.equal(pair.icon[theme], 'media/icons/pair-over-wifi-' + theme + '.svg');
    const svg = fs.readFileSync(path.join(__dirname, '..', pair.icon[theme]), 'utf8');
    assert.ok(svg.includes('<svg') && !svg.includes('currentColor'));
  }
  assert.equal(menus.find(m => m.command === 'android-ide.createAvd').group, 'navigation@1');
  assert.equal(menus.find(m => m.command === 'android-ide.pairDevice').group, 'navigation@2');
  assert.match(runningSource, /id=\"open-dm\"/);
  assert.match(runningSource, /send\(\{type:'openDM'\}\)/);
  assert.match(runningSource, /#tab\{[^}]*border:1px solid var\(--vscode-dropdown-border/);
  assert.match(runningSource, /#tab\{[^}]*border-radius:6px/);
  assert.match(runningSource, /#tab select\{background:transparent/);
  assert.match(runningSource, /#tab select:hover,#tab select:active\{background:transparent\}/);
  assert.match(runningSource, /#tab \.dot\{display:none\}/);
  assert.ok(runningSource.includes('id=\"tic-d\"') && runningSource.includes('id=\"tic-l\"'), 'leading device icons remain');
  const dropdowns = fs.readFileSync(path.join(__dirname, '../media/dropdowns.css'), 'utf8');
  assert.match(dropdowns, /select::picker\(select\)\{[^}]*min-width:anchor-size\(width\)/);
  const handlers = {}, views = [], errors = [], debugRegistrations = [], debugProviders = [], buildActions = [];
  const vscode = { DebugConfigurationProviderTriggerKind: {Initial:1,Dynamic:2}, workspace: { findFiles: async () => [], getConfiguration: () => ({ get: (key, fallback) => fallback, inspect: () => undefined }), onDidChangeConfiguration: () => ({ dispose() {} }), onDidCreateFiles: () => ({ dispose() {} }), onDidDeleteFiles: () => ({ dispose() {} }), onDidRenameFiles: () => ({ dispose() {} }), onDidChangeWorkspaceFolders: () => ({ dispose() {} }) }, commands: { registerCommand: (id, fn) => { handlers[id] = fn; }, executeCommand: async () => undefined }, window: { registerWebviewViewProvider: id => views.push(id), showErrorMessage: e => errors.push(e) }, debug: { registerDebugAdapterDescriptorFactory: (type, factory) => { debugRegistrations.push([type, factory]); return { dispose() {} }; }, registerDebugConfigurationProvider: (type, provider, trigger) => { debugProviders.push([type, provider, trigger]); return { dispose() {} }; }, onDidStartDebugSession: () => ({ dispose() {} }), onDidTerminateDebugSession: () => ({ dispose() {} }) } };
  class Running { async refresh() { throw new Error('adb unavailable'); } }
  // 通过真实 Native adapter 转译加载；仅隔离其直接上游/工具链边界，本用例不启动后端或设备命令。
  const adapter = load('android-debugger/native-debugger/adapter', {
    vscode,
    '@vscode/debugadapter': { LoggingDebugSession: class {}, TerminatedEvent: class {}, OutputEvent: class {} },
    '@vscode/debugprotocol': {},
    '../index': load('android-debugger/index',{vscode}),
    './upstream/src/android': {},
    './upstream/src/targetPicker': { activate() {}, pickTarget: async () => ({ udid: 'phone' }), getLastOrPickTarget: async () => ({ udid: 'phone' }), getTargetFromUDID: async udid => ({ udid }), setCurrentTarget() {}, resetCurrentTarget() {} },
    './upstream/src/debugConfigProvider': { AndroidDebugConfigurationProvider: class {}, LLDBDebugConfigurationProvider: class {} },
    './upstream/src/debugAdapter': { DebugAdapterDescriptorFactory: class { createDebugAdapterDescriptor() {} } },
    './upstream/src/targetCommand': { activate() {}, pickAndroidProcess() {}, getBestAbi() {}, getBestMappedAbi() {}, getPackageNameForPid: async () => 'app', resumeWaitingProcess() {}, setAbiResolutionInfo() {}, setProcessPickerInfo() {}, resetAbiResolutionInfo() {}, resetProcessPickerInfo() {} },
    './nativeToolchain': { resolveNativeToolchain: () => ({ adb: 'adb', sdkRoot: '', ndkRoot: '' }) },
    './nativeTarget': { resolveLauncherActivity: async () => 'MainActivity', adbExec: async () => '' },
    '../../sdk': { adbPath: () => 'adb', listDevices: async () => [] },
    '../../projectLocalConfig': { readProjectLocalConfig: () => ({}) },
    './nativeSymbols': { selectNativeLibraries: async () => [] },
  });
  // UI 回归只验证设备视图接线；JVM debugger 的外部注册边界由独立测试覆盖，因此在这里隔离整个注册模块。
  load('extension', { './deviceExplorer': { DeviceExplorerController: class { async setContext() {} async handle() {} async dispose() {} } }, './androidBuild': { AndroidBuildController: class { constructor() { this.refreshes = 0; } async initialize() {} async handle(message) { buildActions.push(message.action); if (message.action === 'refresh') this.refreshes++; } dispose() {} currentNativeDebugMetadata() {} } }, vscode, './android-debugger/native-debugger/adapter': adapter, './android-debugger/jvm-debugger/adapter': { registerJvmDebugger() {} }, './deviceManager': { registerDeviceManager() {} }, './runningDevices': { RunningDeviceView: Running }, './logcat': { LogcatView: class {} }, './extendedControls': {} }).activate({ extensionPath: '', subscriptions: [] });
  assert.deepEqual(views, ['android-ide.runningDevice', 'android-ide.logcat']);
  // extension 同一工厂注册两种外部入口；android-tools仅保留resolver，android-debug提供六项动态内置配置。
  assert.deepEqual(debugRegistrations.map(item => item[0]).sort(), ['android-debug', 'android-tools'].sort());
  assert.deepEqual(debugProviders.map(item => item[0]).sort(), ['android-debug', 'android-debug', 'android-tools', 'lldb'].sort());
  const dynamic = debugProviders.find(item => item[0] === 'android-debug' && item[2] === 2);
  assert.equal(dynamic[1].provideDebugConfigurations().length, 6);
  assert.deepEqual(JSON.stringify(Array.from(dynamic[1].provideDebugConfigurations(), config => config.name).sort()), JSON.stringify([
    'Android: Android Native Debug Launch', 'Android: Android Native Debug Attach',
    'Android: Android JVM Debug Launch', 'Android: Android JVM Debug Attach',
    'Android: Android Dual(Native and JVM) Debug Launch', 'Android: Android Dual(Native and JVM) Debug Attach',
  ].sort()));
  assert.equal(typeof dynamic[1].resolveDebugConfiguration,'function');
  assert.equal(typeof debugRegistrations.find(item => item[0] === 'android-debug')[1].createDebugAdapterDescriptor, 'function');
  await handlers['android-ide.refresh']();
  assert.deepEqual(buildActions, ['refresh']);
  assert.match(errors[0], /adb unavailable/);
});

// npm test：执行实际注册的设备选择器，覆盖真机/无本地 AVD 模拟器/授权/离线/取消/配对/启动和发现异常。
test('picker includes connected devices and exposes unavailable states', async () => {
  const handlers = {}, calls = [], warnings = [], errors = [];
  let choose, items, failure, devices = [{ serial: 'usb', name: 'Phone', state: 'device' }, { serial: 'emulator-5554', state: 'device' }, { serial: 'locked', state: 'unauthorized' }, { serial: 'gone', state: 'offline' }];
  const avd = { name: 'Pixel', config: {} };
  const vscode = { Uri: { file: p => p }, QuickPickItemKind: { Separator: -1 }, commands: { registerCommand: (id, fn) => { handlers[id] = fn; }, executeCommand: (...args) => { calls.push(args); } }, window: { showQuickPick: async list => { items = list; return choose?.(list); }, showWarningMessage: async m => warnings.push(m), showErrorMessage: m => errors.push(m) } };
  const sdk = { listDevices: async () => { if (failure) throw failure; return devices; }, listAvds: () => [avd] };
  load('deviceManager', { vscode, './sdk': sdk }).registerDeviceManager({ extensionPath: '', subscriptions: [] }, () => {});
  choose = list => list.find(i => i.device?.serial === 'usb');
  await handlers['android-ide.addDevice']();
  assert.equal(items.filter(i => i.device).length, 4);
  assert.equal(calls.at(-1)[0], 'android-ide.mirrorDevice');
  assert.equal(calls.at(-1)[1].serial, 'usb');
  choose = list => list.find(i => i.device?.state === 'unauthorized');
  await handlers['android-ide.addDevice']();
  assert.match(warnings.at(-1), /allow USB debugging/);
  choose = list => list.find(i => i.device?.state === 'offline');
  await handlers['android-ide.addDevice']();
  assert.match(warnings.at(-1), /offline/);
  const count = calls.length;
  choose = undefined;
  await handlers['android-ide.addDevice']();
  assert.equal(calls.length, count);
  choose = list => list.find(i => i.pair);
  await handlers['android-ide.addDevice']();
  assert.equal(calls.at(-1)[0], 'android-ide.pairDevice');
  choose = list => list.find(i => i.avd);
  await handlers['android-ide.addDevice']();
  assert.equal(calls.at(-1)[0], 'android-ide.startAvd');
  devices = [{ serial: 'emulator-5554', avdName: 'Pixel', state: 'device' }];
  await handlers['android-ide.addDevice']();
  assert.equal(calls.at(-1)[0], 'android-ide.mirrorDevice');
  failure = new Error('ADB discovery failed');
  await handlers['android-ide.addDevice']();
  assert.match(errors.at(-1), /ADB discovery failed/);
});

// npm test：执行实际 SDK 路径和设备发现，模拟 execFile 输出；断言无 SDK 使用 PATH、已配置 SDK 优先及错误不伪装空设备。
test('SDK discovers PATH adb and preserves device states and errors', async () => {
  let configured = '', failure = false;
  const commands = [];
  const sdk = load('sdk', {
    vscode: { workspace: { getConfiguration: () => { throw new Error('SDK path must not read VS Code settings'); } } },
    './projectLocalConfig': { readProjectLocalConfig: root => { assert.equal(root, undefined); return { sdkPath: configured || undefined }; } },
    fs: { statSync: p => {
      if (configured && p === configured) return { isDirectory: () => true, isFile: () => false };
      if (configured && p === path.join(configured, 'platform-tools', process.platform === 'win32' ? 'adb.exe' : 'adb')) return { isDirectory: () => false, isFile: () => true };
      throw Object.assign(new Error('missing fixture path'), { code: 'ENOENT' });
    } },
    child_process: { execFile: (cmd, args, options, callback) => {
      commands.push(cmd);
      if (failure) callback(new Error('ENOENT'), '', 'adb missing');
      else callback(null, args[0] === 'devices' ? 'List of devices attached\r\nusb device model:Phone\r\nlocked unauthorized\r\ngone offline\r\n' : 'Phone\n', '');
      return {};
    } },
  });
  assert.equal(sdk.adbPath(), process.platform === 'win32' ? 'adb.exe' : 'adb');
  const devices = await sdk.listDevices();
  assert.deepEqual(Array.from(devices, d => d.state), ['device', 'unauthorized', 'offline']);
  assert.ok(devices[0].name.includes('Phone'));
  configured = path.resolve('test-sdk');
  assert.equal(sdk.adbPath(), path.join(configured, 'platform-tools', process.platform === 'win32' ? 'adb.exe' : 'adb'));
  failure = true;
  await assert.rejects(sdk.listDevices(), /ADB discovery failed.*adb missing/);
});


// npm test：在 VM 中执行实际 renderDevices，断言当前名称、全部设备、不可用状态和空态，并验证选择消息绑定。
test('device dropdown renders all devices and selection bridge', () => {
  const start = runningSource.indexOf('function renderDevices(m){');
  const end = runningSource.indexOf("addEventListener('message'", start);
  assert.ok(start >= 0 && end > start);
  let fn = runningSource.slice(start, end);
  fn = fn.replace(/\$\{JSON.stringify\(icons\['([^']+)'\]\)\}/g, (_, key) => JSON.stringify(key));
  const options = [], sent = [];
  let empty, clears = 0;
  const labelButton = { tagName: 'BUTTON' };
  const dev = { value: '', title: '', querySelector: () => labelButton, replaceChildren(button) { assert.equal(button, labelButton); options.length = 0; }, appendChild(option) { options.push(option); }, onchange: null };
  const nodes = { dev, 'tic-d': { innerHTML: '' }, 'tic-l': { innerHTML: '' }, tdot: { style: {} }, msg: { textContent: '' }, screen: { removeAttribute() {} } };
  const ctx = {
    document: {
      body: { classList: { toggle: (name, value) => { empty = value; } } },
      getElementById: id => nodes[id],
      createElement: () => ({ value: '', textContent: '', disabled: false, title: '' }),
    },
    ctx: { clearRect() { clears++; } }, send: m => sent.push(m), img: nodes.screen, msg: nodes.msg, dev, tdot: nodes.tdot,
    JSON, icons: {}, cv: { width: 100, height: 200 },
  };
  const vmCtx = { ...ctx, input: { serial: 'phone', devices: [
    { serial: 'phone', label: 'Phone', state: 'device', physical: true },
    { serial: 'offline', label: 'Old Phone', state: 'offline', physical: true },
    { serial: 'emu', label: 'Pixel', state: 'device', physical: false },
  ] } };
  vm.runInNewContext(fn + '\nrenderDevices(input);', vmCtx);
  assert.deepEqual(options.map(o => o.textContent), ['Select Device', 'Phone (phone)', 'Old Phone (offline) (offline)', 'Pixel (emu)']);
  assert.equal(options[2].disabled, true);
  assert.equal(dev.value, 'phone');
  assert.equal(dev.title, 'Phone (phone)');
  assert.equal(empty, false);
  assert.equal(nodes['tic-d'].innerHTML, 'physical-dark');
  const change = runningSource.match(/dev\.onchange=[^;]+;/)[0];
  vm.runInNewContext(change, vmCtx);
  dev.value = 'emu';
  dev.onchange();
  assert.equal(sent.at(-1).type, 'select');
  assert.equal(sent.at(-1).serial, 'emu');
  vm.runInNewContext(fn + '\nrenderDevices({...input, serial: \"emu\"});', vmCtx);
  assert.equal(dev.title, 'Pixel (emu)');
  assert.equal(nodes['tic-d'].innerHTML, 'virtual-dark');
  assert.match(runningSource, /dev\.onchange=\(\)=>send\(\{type:'select',serial:dev\.value\}\)/);
  vm.runInNewContext(fn + '\nrenderDevices({ devices: [], serial: undefined });', vmCtx);
  assert.equal(options[0].textContent, 'No devices');
  assert.equal(dev.value, '');
  assert.equal(empty, true);
  assert.equal(clears, 1);
  const link = runningSource.match(/document\.getElementById\('open-dm'\)\.onclick=[^;]+;/)[0];
  nodes['open-dm'] = {};
  vm.runInNewContext(link, vmCtx);
  nodes['open-dm'].onclick();
  assert.equal(sent.at(-1).type, 'openDM');
  assert.match(runningSource, /send\(\{type:'openDM'\}\)/);
});

// npm test：实际执行后台选择消息，断言切换到指定设备及清空选择后不启动其他设备。
test('dropdown selection messages switch the actual mirrored serial', async () => {
  const { RunningDeviceView } = load('runningDevices', { vscode: {}, './sdk': { listDevices: async () => [{ serial: 'one', state: 'device' }, { serial: 'two', state: 'device' }] }, './emulatorGrpc': {}, './scrcpy': {}, './skin': { skinForAvd: () => undefined } });
  const mirror = new RunningDeviceView('');
  const started = [], messages = [];
  mirror.view = { visible: true, webview: { postMessage: m => messages.push(m) } };
  mirror.pickMode = () => 'screencap';
  mirror.startScreencap = () => { started.push(mirror.serial); mirror.loop = {}; };
  await mirror.onMessage({ type: 'select', serial: 'one' });
  await mirror.onMessage({ type: 'select', serial: 'two' });
  assert.deepEqual(started, ['one', 'two']);
  assert.equal(messages.filter(m => m.type === 'devices').at(-1).serial, 'two');
  assert.deepEqual(messages.filter((m) => m.type === 'deviceLoading').at(-2)?.loading, true);
  assert.equal(messages.filter((m) => m.type === 'deviceLoading').at(-1)?.loading, false);
  await mirror.onMessage({ type: 'select', serial: '' });
  assert.equal(mirror.serial, undefined);
  assert.equal(started.length, 2);
});
