const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { transformSync } = require('esbuild');

// 真实 activate 和两个提供方，仅替换 VS Code、ADB/视频源和目录定时器；npm test 可无硬件运行并严格计数。
function fixture() {
  const f = { devices: [{ serial: 'phone', state: 'device' }, { serial: 'two', state: 'device' }], views: {}, handlers: {}, commands: [], errors: [], streams: [], mirrors: [], intervals: new Map() };
  const vscode = {
    Uri: { file: p => p, joinPath: (...p) => p.join('/') },
    debug: { registerDebugAdapterDescriptorFactory: () => ({ dispose() {} }) },
    workspace: { getConfiguration: () => ({ get: (key, fallback) => fallback, inspect: () => undefined }), onDidChangeConfiguration: () => ({ dispose() {} }) },
    commands: { registerCommand: (id, fn) => { f.handlers[id] = fn; }, executeCommand: async (id, arg) => { f.commands.push([id, arg]); return f.handlers[id]?.(arg); } },
    window: { registerWebviewViewProvider: (id, view) => { f.views[id] = view; }, showErrorMessage: e => f.errors.push(e) },
  };
  let timerId = 0;
  const sdk = { listDevices: async () => { f.discoveries = (f.discoveries || 0) + 1; if (f.failure) throw f.failure; return f.devices; }, skinForAvd: () => undefined, adbPath: () => 'adb', sdkRoot: () => '' };
  const spawn = (exe, args) => {
    const proc = new EventEmitter(); proc.stdout = new EventEmitter(); proc.stdout.setEncoding = () => {};
    proc.kill = () => { proc.killed = true; }; f.streams.push({ args, proc }); return proc;
  };
  // 转译当前源码，确保回归运行实际消息处理、选择幂等和扩展接线，而非测试副本。
  function load(name, deps) {
    const module = { exports: {} };
    vm.runInNewContext(transformSync(fs.readFileSync(path.join(__dirname, '../src/' + name + '.ts'), 'utf8'), { loader: 'ts', format: 'cjs' }).code, {
      module, exports: module.exports, process, Buffer, AbortController, setTimeout, clearTimeout,
      setInterval: (fn, ms) => { const id = ++timerId; f.intervals.set(id, { fn, ms }); return id; }, clearInterval: id => f.intervals.delete(id),
      require: id => id === './runtimeContext' ? require('./runtime-context-loader.cjs')() : Object.hasOwn(deps, id) ? deps[id] : require(id),
    });
    return module.exports;
  }
  const running = load('runningDevices', { vscode, './sdk': sdk, './emulatorGrpc': {}, './scrcpy': {}, './skin': sdk });
  // tracker 是独立传输依赖；选择测试仍执行真实 LogcatView 的启动、停止和消息处理。
  const parserModule = load('logcatParser', {});
  const logcat = load('logcat', { vscode, './sdk': sdk, './logcatParser': parserModule, child_process: { spawn }, './deviceExplorerProcesses': { DeviceExplorerProcesses: class { watch() { return async () => {}; } } } });
  // 调试适配器注册属于独立宿主依赖；仍执行真实 activate 和两侧设备选择，不加载无关调试会话。
  load('extension', { './android-debugger/jvm-debugger/adapter': { createAndroidDebugAdapterFactory: () => ({}) }, './deviceExplorer': { DeviceExplorerController: class { async setContext() {} async handle() {} async dispose() {} } }, vscode, './runningDevices': running, './logcat': logcat, './androidBuild': { AndroidBuildController: class { dispose() {} } }, './deviceManager': { registerDeviceManager() {} }, './extendedControls': {} }).activate({ extensionPath: path.join(__dirname, '..'), subscriptions: [] });
  f.running = f.views['android-ide.runningDevice']; f.logcat = f.views['android-ide.logcat'];
  f.running.pickMode = () => 'screencap'; f.running.startScreencap = () => { f.mirrors.push(f.running.serial); f.running.loop = {}; };
  // 创建实际 HTML 与宿主消息入口，默认均可见；可在测试中延迟创建或隐藏来覆盖生命周期。
  f.resolve = (provider) => {
    const messages = [], view = { visible: true, webview: { cspSource: 'test:', asWebviewUri: p => p, postMessage: m => messages.push(m), onDidReceiveMessage: fn => { view.receive = fn; } }, onDidDispose() {}, onDidChangeVisibility: fn => { view.visibilityChanged = fn; } };
    provider.resolveWebviewView(view); return { view, messages };
  };
  return f;
}

// 两个选择下拉各自切换，重复消息不重启，清空同步；精确断言每次启动串号与旧流释放。
test('device selection sync is bidirectional and idempotent through actual activate', async () => {
  const f = fixture(), r = f.resolve(f.running), l = f.resolve(f.logcat);
  await f.running.onMessage({ type: 'select', serial: 'phone' });
  assert.equal(f.logcat.serial, 'phone'); assert.equal(l.messages.at(-1).serial, 'phone');
  assert.equal(f.streams.length, 1); assert.deepEqual(f.mirrors, ['phone']);
  await f.logcat.onMessage({ type: 'select', serial: 'two' });
  assert.equal(f.running.serial, 'two'); assert.equal(r.messages.findLast(m => m.type === 'devices').serial, 'two');
  assert.equal(f.streams[0].proc.killed, true); assert.equal(f.streams[1].args[1], 'two');
  assert.deepEqual(f.mirrors, ['phone', 'two']);
  await f.running.onMessage({ type: 'select', serial: 'two' });
  await f.logcat.show({ serial: 'two' });
  assert.equal(f.streams.length, 2); assert.equal(f.mirrors.length, 2);
  await f.running.select();
  assert.equal(f.logcat.serial, undefined); assert.equal(f.streams[1].proc.killed, true);
  assert.equal(l.messages.findLast(m => m.type === 'devices').serial, undefined);
});

// 在未创建/隐藏视图时同步选择，不抢焦点或建立隐藏流；打开后仍使用同步后的设备。
test('device selection sync retains selection before views exist and while hidden', async () => {
  const f = fixture();
  await f.handlers['android-ide.selectDevice']({ serial: 'two' });
  assert.equal(f.logcat.serial, 'two'); assert.equal(f.streams.length, 0); assert.equal(f.commands.length, 0);
  const l = f.resolve(f.logcat); l.view.visible = false;
  await f.running.applyMirrorVisibility(false);
  const r = f.resolve(f.running); r.view.visible = false;
  assert.ok(r.view.webview.html.includes('class="empty mirror-hidden" data-mirror-visible="false"'));
  await f.logcat.onMessage({ type: 'select', serial: 'phone' });
  assert.equal(f.running.serial, 'phone'); assert.equal(f.mirrors.length, 0); assert.equal(f.streams.length, 0);
  l.view.visible = true;
  await f.logcat.show();
  assert.equal(f.streams.length, 1); assert.equal(f.streams[0].args[1], 'phone');
  await f.running.applyMirrorVisibility(false); r.view.visible = true;
  await f.logcat.select('two');
  assert.equal(f.running.serial, 'two'); assert.equal(f.mirrors.length, 0);
});

// 现有目录 tick 初始默认首台，拔出清空而不替换且下次保持空；重新手选后查询失败保留选择并报错。
test('device selection sync publishes catalog choices disconnects and discovery errors', async () => {
  const f = fixture(); f.resolve(f.running); f.resolve(f.logcat);
  f.logcat.startPolling(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.running.serial, 'phone'); assert.equal(f.logcat.serial, 'phone');
  const tick = [...f.intervals.values()].find(v => v.ms === 3000).fn;
  f.devices = [{ serial: 'two', state: 'device' }]; await tick();
  assert.equal(f.running.serial, undefined); assert.equal(f.logcat.serial, undefined);
  await tick();
  assert.equal(f.running.serial, undefined); assert.equal(f.logcat.serial, undefined);
  await f.logcat.select('two');
  f.failure = new Error('discovery failed'); await tick();
  assert.equal(f.running.serial, 'two'); assert.match(f.errors.at(-1), /discovery failed/);
  f.failure = undefined; f.devices = []; await tick();
  assert.equal(f.running.serial, undefined); assert.equal(f.logcat.serial, undefined);
  assert.equal(f.streams.at(-1).proc.killed, true);
  f.logcat.stopPolling(); f.logcat.stopStream(); assert.equal(f.intervals.size, 0);
});

// Device Tools 的目录发现断开必须清空日志侧；同步连接失败不吞错且旧视频源先停止。
test('device selection sync clears invalid mirror device and exposes selection errors', async () => {
  const f = fixture(); f.resolve(f.running); const l = f.resolve(f.logcat);
  await f.running.select({ serial: 'phone' });
  f.devices = [{ serial: 'two', state: 'device' }]; await f.running.refresh();
  assert.equal(f.running.serial, undefined); assert.equal(f.logcat.serial, undefined);
  f.running.selectionChanged = async () => { throw new Error('selection failed'); };
  let stops = 0; f.running.session = { stop: () => stops++ };
  await assert.rejects(f.running.select({ serial: 'two' }), /selection failed/); assert.equal(stops, 1);
  f.logcat.selectionChanged = async () => { throw new Error('log selection failed'); };
  await assert.rejects(f.logcat.onMessage({ type: 'select', serial: 'two' }), /log selection failed/);
  await l.view.receive({ type: 'select', serial: 'phone' });
  assert.match(f.errors.at(-1), /log selection failed/);
});

// 无设备的按钮消息必须到达实际 focus 命令，有设备仍携带所选串号；命令失败向调用方传播。
test('Logcat entry always opens without a device and preserves selected device', async () => {
  const f = fixture(); f.resolve(f.running); f.resolve(f.logcat);
  await f.running.onMessage({ type: 'logcat' });
  assert.ok(f.commands.some(([id]) => id === 'android-ide.logcat.focus')); assert.equal(f.streams.length, 0);
  await f.handlers['android-ide.mirrorDevice']({ serial: 'two' });
  assert.equal(f.logcat.serial, 'two'); assert.equal(f.running.serial, 'two');
  await f.running.onMessage({ type: 'logcat' }); assert.equal(f.streams.length, 1);
  f.handlers['android-ide.showLogcat'] = async () => { throw new Error('focus failed'); };
  await assert.rejects(f.running.onMessage({ type: 'logcat' }), /focus failed/);
});

// 真实入口无硬件复现重复展开；npm test 断言查询次数、默认首台、在线保留、离线清空和查询失败。
test('device dropdown discovery refreshes every opening and respects selection lifecycle', async () => {
  for (const side of ['running', 'logcat']) {
    const f = fixture(), r = f.resolve(f.running); f.resolve(f.logcat);
    const provider = f[side];
    f.devices.unshift({ serial: 'offline', state: 'offline' });
    await provider.onMessage({ type: 'discoverDevices' });
    assert.equal(f.running.serial, 'phone'); assert.equal(f.logcat.serial, 'phone');
    const before = f.discoveries, mirrors = f.mirrors.length, streams = f.streams.length;
    f.devices.push({ serial: 'new', state: 'device' });
    await provider.onMessage({ type: 'discoverDevices' });
    await provider.onMessage({ type: 'discoverDevices' });
    assert.equal(f.discoveries, before + 2);
    assert.equal(f.mirrors.length, mirrors); assert.equal(f.streams.length, streams);
    const snapshot = side === 'running' ? r.messages.findLast(m => m.type === 'devices').devices : f.logcat.devices;
    assert.ok(snapshot.some(d => d.serial === 'new'));
    assert.ok(snapshot.some(d => d.serial === 'offline' && d.state === 'offline'));
    await provider.onMessage({ type: 'select', serial: 'two' });
    await provider.onMessage({ type: 'discoverDevices' });
    assert.equal(f.running.serial, 'two'); assert.equal(f.logcat.serial, 'two');
    f.failure = new Error('discovery failed');
    await assert.rejects(provider.onMessage({ type: 'discoverDevices' }), /discovery failed/);
    assert.equal(provider.serial, 'two'); f.failure = undefined;
    f.devices = [{ serial: 'two', state: 'offline' }, { serial: 'phone', state: 'device' }];
    await provider.onMessage({ type: 'discoverDevices' });
    assert.equal(f.running.serial, undefined); assert.equal(f.logcat.serial, undefined);
    assert.equal(f.streams.at(-1).proc.killed, true);
    await provider.onMessage({ type: 'discoverDevices' });
    assert.equal(f.running.serial, undefined); assert.equal(f.logcat.serial, undefined);
    f.logcat.stopStream(); await f.running.dispose();
  }
});

// 执行真实页面/脚本绑定，主键每次展开及键盘展开都查询；右键和非展开键不查询。
test('device dropdown pointer and keyboard openings request fresh discovery', () => {
  const f = fixture(), { view } = f.resolve(f.running);
  for (const script of [view.webview.html, fs.readFileSync(path.join(__dirname, '../media/logcat/main.js'), 'utf8')]) {
    const dev = {}, sent = [];
    const bindings = script.split('\n').filter(line => line.includes('.onpointerdown') || line.includes('.onkeydown = e =>') || line.startsWith('dev.onkeydown=')).join('\n');
    assert.ok(bindings.includes('onpointerdown') && bindings.includes('onkeydown'));
    vm.runInNewContext(bindings, { dev, $: () => dev, send: m => sent.push(m), vs: { postMessage: m => sent.push(m) } });
    dev.onpointerdown({ button: 0 }); dev.onpointerdown({ button: 0 });
    dev.onpointerdown({ button: 2 }); dev.onkeydown({ key: 'Tab' });
    for (const key of ['Enter', ' ', 'ArrowDown', 'ArrowUp', 'F4']) dev.onkeydown({ key });
    assert.deepEqual(sent.map(m => m.type), Array(7).fill('discoverDevices'));
  }
});

// 执行生产头部渲染：其他设备仍存在时，断开后的空选择有明确占位而非隐式显示首台。
test('Logcat dropdown renders explicit unselected state after disconnect', () => {
  const script = fs.readFileSync(path.join(__dirname, '../media/logcat/main.js'), 'utf8');
  const dev = { dataset: {} }, end = { classList: { toggle() {} }, setAttribute() {} }, status = { style: {} };
  const context = { $: id => ({ dev, 'b-end': end, status })[id], deviceList: [{ serial: 'two', model: 'Phone', state: 'device' }, { serial: 'offline', state: 'offline' }, { serial: 'locked', state: 'unauthorized' }], serial: '', stick: false, statusText: '', esc: s => s };
  vm.runInNewContext(script.slice(script.indexOf('  function drawHeader()'), script.indexOf('  // 更新状态模型')) + ';drawHeader();', context);
  assert.match(dev.innerHTML, /<option value="">Select Device<\/option>/);
  assert.match(dev.innerHTML, /value="two">/); assert.equal(dev.value, '');
  assert.match(dev.innerHTML, /value="offline" disabled>[^<]*\(offline\)/);
  assert.match(dev.innerHTML, /value="locked" disabled>[^<]*\(unauthorized\)/);
});


// 初始无在线设备时保留默认选择意图；后续发现第一台在线设备后同步两侧，明确清空后不再自动选择。
test('device dropdown discovery selects first later connection but preserves explicit clearing', async () => {
  for (const side of ['running', 'logcat']) {
    const f = fixture(); f.resolve(f.running); f.resolve(f.logcat);
    const provider = f[side];
    f.devices = [{ serial: 'offline', state: 'unauthorized' }];
    await provider.onMessage({ type: 'discoverDevices' });
    assert.ok(!f.running.serial && !f.logcat.serial); assert.equal(f.streams.length, 0); assert.equal(f.mirrors.length, 0);
    f.devices.push({ serial: 'first', state: 'device' });
    await provider.onMessage({ type: 'discoverDevices' });
    assert.equal(f.running.serial, 'first'); assert.equal(f.logcat.serial, 'first');
    await provider.onMessage({ type: 'select', serial: '' });
    await provider.onMessage({ type: 'discoverDevices' });
    assert.equal(f.running.serial, undefined); assert.equal(f.logcat.serial, undefined);
    f.logcat.stopStream(); await f.running.dispose();
  }
});
