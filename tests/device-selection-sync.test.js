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
    workspace: { getConfiguration: () => ({ get: (key, fallback) => fallback }), onDidChangeConfiguration: () => ({ dispose() {} }) },
    commands: { registerCommand: (id, fn) => { f.handlers[id] = fn; }, executeCommand: async (id, arg) => { f.commands.push([id, arg]); return f.handlers[id]?.(arg); } },
    window: { registerWebviewViewProvider: (id, view) => { f.views[id] = view; }, showErrorMessage: e => f.errors.push(e) },
  };
  let timerId = 0;
  const sdk = { listDevices: async () => { if (f.failure) throw f.failure; return f.devices; }, skinForAvd: () => undefined, adbPath: () => 'adb', sdkRoot: () => '' };
  const spawn = (exe, args) => {
    const proc = new EventEmitter(); proc.stdout = new EventEmitter(); proc.stdout.setEncoding = () => {};
    proc.kill = () => { proc.killed = true; }; f.streams.push({ args, proc }); return proc;
  };
  // 转译当前源码，确保回归运行实际消息处理、选择幂等和扩展接线，而非测试副本。
  function load(name, deps) {
    const module = { exports: {} };
    vm.runInNewContext(transformSync(fs.readFileSync(path.join(__dirname, '../src/' + name + '.ts'), 'utf8'), { loader: 'ts', format: 'cjs' }).code, {
      module, exports: module.exports, process, Buffer,
      setInterval: (fn, ms) => { const id = ++timerId; f.intervals.set(id, { fn, ms }); return id; }, clearInterval: id => f.intervals.delete(id),
      require: id => Object.hasOwn(deps, id) ? deps[id] : require(id),
    });
    return module.exports;
  }
  const running = load('runningDevices', { vscode, './sdk': sdk, './emulatorGrpc': {}, './scrcpy': {}, './skin': sdk });
  const logcat = load('logcat', { vscode, './sdk': sdk, child_process: { spawn } });
  load('extension', { vscode, './runningDevices': running, './logcat': logcat, './androidBuild': { AndroidBuildController: class { dispose() {} } }, './deviceManager': { registerDeviceManager() {} }, './extendedControls': {} }).activate({ extensionPath: path.join(__dirname, '..'), subscriptions: [] });
  f.running = f.views['android.runningDevice']; f.logcat = f.views['android.logcat'];
  f.running.pickMode = () => 'screencap'; f.running.startScreencap = () => f.mirrors.push(f.running.serial);
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
  await f.handlers['android.selectDevice']({ serial: 'two' });
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

// 现有目录 tick 的初始自动选择、拔出替换及全部断开均通知另一侧；目录失败只报告且不误清选择。
test('device selection sync publishes catalog choices disconnects and discovery errors', async () => {
  const f = fixture(); f.resolve(f.running); f.resolve(f.logcat);
  f.logcat.startPolling(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.running.serial, 'phone'); assert.equal(f.logcat.serial, 'phone');
  const tick = [...f.intervals.values()].find(v => v.ms === 3000).fn;
  f.devices = [{ serial: 'two', state: 'device' }]; await tick();
  assert.equal(f.running.serial, 'two'); assert.equal(f.logcat.serial, 'two');
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
  assert.ok(f.commands.some(([id]) => id === 'android.logcat.focus')); assert.equal(f.streams.length, 0);
  await f.handlers['android.mirrorDevice']({ serial: 'two' });
  assert.equal(f.logcat.serial, 'two'); assert.equal(f.running.serial, 'two');
  await f.running.onMessage({ type: 'logcat' }); assert.equal(f.streams.length, 1);
  f.handlers['android.showLogcat'] = async () => { throw new Error('focus failed'); };
  await assert.rejects(f.running.onMessage({ type: 'logcat' }), /focus failed/);
});
