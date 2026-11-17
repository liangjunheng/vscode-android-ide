const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { transformSync } = require('esbuild');

// 无输入，输出可控 Promise；前提为测试显式完成它，用于确定异步边界而不依赖延时。
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

// 无硬件装载真实 LogcatView；仅替换宿主、进程和调度器，输出事件/查询/消息记录供 npm test 严格断言。
function fixture() {
  const f = { requests: [], streams: [], errors: [], selections: [], intervals: new Map() };
  let timerId = 0;
  const vscode = {
    Uri: { file: p => p, joinPath: (...p) => p.join('/') },
    workspace: {
      getConfiguration: () => ({ get: (key, fallback) => fallback }),
      findFiles: () => f.scan ? f.scan.promise : Promise.resolve([]),
    },
    window: { showErrorMessage: error => f.errors.push(error) },
    commands: { executeCommand: async () => {} },
  };
  const sdk = {
    listDevices: () => { const request = deferred(); f.requests.push(request); return request.promise; },
    adbPath: () => 'adb', sdkRoot: () => '', adb: async () => '',
  };
  // 输入 adb 参数并输出事件进程；仅记录 spawn/kill，验证真实 start/stopStream 的资源语义。
  const spawn = (exe, args) => {
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter(); proc.stdout.setEncoding = () => {};
    proc.kill = () => { proc.killed = true; };
    f.streams.push({ proc, args }); return proc;
  };
  const deps = { vscode, './sdk': sdk, child_process: { spawn } };
  const module = { exports: {} };
  const source = fs.readFileSync(path.join(__dirname, '../src/logcat.ts'), 'utf8');
  vm.runInNewContext(transformSync(source, { loader: 'ts', format: 'cjs' }).code, {
    module, exports: module.exports, process, Buffer,
    require: id => Object.hasOwn(deps, id) ? deps[id] : require(id),
    setInterval: (fn, ms) => { const id = ++timerId; f.intervals.set(id, { fn, ms }); return id; },
    clearInterval: id => f.intervals.delete(id),
  });
  f.provider = new module.exports.LogcatView(path.join(__dirname, '..'), serial => {
    f.selections.push(serial); return f.selectionPending?.promise;
  });
  // 输入初始宿主可见性，输出真实 resolve 绑定的事件入口；测试直接发事件且不复制生产生命周期逻辑。
  f.resolve = (visible = true) => {
    const messages = [];
    const view = {
      visible,
      webview: { cspSource: 'test:', asWebviewUri: p => p, postMessage: m => messages.push(m), onDidReceiveMessage: fn => { view.receive = fn; } },
      onDidDispose: fn => { view.dispose = fn; },
      onDidChangeVisibility: fn => { view.visibilityChanged = fn; },
    };
    f.provider.resolveWebviewView(view);
    return { view, messages };
  };
  return f;
}

// 等待已完成 Promise 的续体耗尽，无输入/输出；仅用于启动时 void tick 的可观测结果，不驱动生产定时器。
async function settled() { await new Promise(resolve => setImmediate(resolve)); }

// 初始隐藏 ready 必须携带 false，目录/流均不启动；显示事件携带 true 并恢复真实采集，再隐藏必须清空所有调度。
test('Logcat visibility initializes hidden and resumes only while host is visible', async () => {
  const f = fixture(), { view, messages } = f.resolve(false);
  await view.receive({ type: 'ready' });
  assert.equal(messages.find(m => m.type === 'init').visible, false);
  assert.equal(f.requests.length, 0); assert.equal(f.intervals.size, 0); assert.equal(f.streams.length, 0);
  view.visible = true; view.visibilityChanged();
  assert.equal(messages.at(-1).type, 'visibility'); assert.equal(messages.at(-1).visible, true);
  assert.equal(f.requests.length, 1);
  f.requests[0].resolve([{ serial: 'phone', state: 'device' }, { serial: 'offline', state: 'offline' }]);
  await settled();
  assert.equal(f.streams.length, 1); assert.equal(f.streams[0].args[1], 'phone');
  const catalog = messages.findLast(m => m.type === 'devices').list;
  assert.equal(catalog.length, 2);
  assert.equal(catalog[1].state, 'offline');
  assert.equal([...f.intervals.values()].filter(t => t.ms === 3000).length, 1);
  assert.equal([...f.intervals.values()].filter(t => t.ms === 60).length, 1);
  view.visible = false; view.visibilityChanged();
  assert.equal(messages.at(-1).type, 'visibility'); assert.equal(messages.at(-1).visible, false);
  assert.equal(f.streams[0].proc.killed, true); assert.equal(f.intervals.size, 0);
  view.dispose();
});

// 延迟项目扫描时隐藏；init 必须取完成时可见性，ready 不得在 hide 后新建轮询。
test('Logcat ready reads host visibility after asynchronous project discovery', async () => {
  const f = fixture(), { view, messages } = f.resolve();
  f.scan = deferred(); const ready = view.receive({ type: 'ready' });
  view.visible = false; view.visibilityChanged(); f.scan.resolve([]); await ready;
  assert.equal(messages.find(m => m.type === 'init').visible, false);
  assert.equal(f.requests.length, 0); assert.equal(f.intervals.size, 0); assert.equal(f.streams.length, 0);
  view.dispose();
});

// 查询已启动后隐藏，完成结果可缓存但不得变更选择、投递设备 DOM 或启动流；再次显示重新发现并正常恢复。
test('Logcat listDevices completion while hidden cannot refresh devices or restart collection', async () => {
  const f = fixture(), { view, messages } = f.resolve();
  await view.receive({ type: 'ready' });
  assert.equal(messages.find(m => m.type === 'init').visible, true);
  const staleTick = [...f.intervals.values()].find(t => t.ms === 3000).fn;
  view.visible = false; view.visibilityChanged(); const count = messages.length;
  f.requests[0].resolve([{ serial: 'phone', state: 'device' }]); await settled();
  assert.equal(f.provider.devices[0].serial, 'phone');
  assert.equal(messages.length, count); assert.equal(f.selections.length, 0);
  assert.equal(f.streams.length, 0); assert.equal(f.intervals.size, 0);
  await staleTick(); assert.equal(f.requests.length, 1);
  view.visible = true; view.visibilityChanged();
  assert.equal(f.requests.length, 2);
  f.requests[1].resolve([{ serial: 'two', state: 'device' }]); await settled();
  assert.equal(f.streams.length, 1); assert.equal(f.streams[0].args[1], 'two');
  assert.equal(messages.findLast(m => m.type === 'devices').serial, 'two');
  view.dispose(); assert.equal(f.intervals.size, 0); assert.equal(f.streams[0].proc.killed, true);
});

// 自动选择的同步回调尚未返回时隐藏；后续 tick 也不能投递设备或重新启动已经停止的流。
test('Logcat selection continuation respects visibility after selection synchronization', async () => {
  const f = fixture(), { view, messages } = f.resolve();
  f.selectionPending = deferred(); await view.receive({ type: 'ready' });
  f.requests[0].resolve([{ serial: 'phone', state: 'device' }]); await settled();
  assert.equal(f.selections[0], 'phone'); assert.equal(f.streams.length, 1);
  view.visible = false; view.visibilityChanged(); const count = messages.length;
  f.selectionPending.resolve(); await settled();
  assert.equal(messages.length, count); assert.equal(f.streams.length, 1);
  assert.equal(f.streams[0].proc.killed, true); assert.equal(f.intervals.size, 0);
  view.dispose();
});

// 扫描期间销毁并创建新视图，旧 ready 的初始化及旧视图事件不得投递到新宿主。
test('Logcat disposed ready and callbacks cannot control a replacement view', async () => {
  const f = fixture(), old = f.resolve(); f.scan = deferred();
  const ready = old.view.receive({ type: 'ready' }); old.view.dispose();
  const current = f.resolve(); f.scan.resolve([]); await ready;
  assert.equal(old.messages.length, 0); assert.equal(current.messages.length, 0);
  assert.equal(f.requests.length, 0); assert.equal(f.intervals.size, 0);
  old.view.visible = false; old.view.visibilityChanged(); old.view.dispose();
  await old.view.receive({ type: 'restart' });
  assert.equal(f.provider.view, current.view); assert.equal(current.messages.length, 0);
  await current.view.receive({ type: 'ready' });
  assert.equal(current.messages.find(m => m.type === 'init').visible, true);
  assert.equal(f.requests.length, 1); current.view.dispose();
  f.requests[0].resolve([]); await settled(); assert.equal(f.intervals.size, 0);
});

// 旧目录查询在销毁后返回，不能污染替换宿主的缓存、选择或流；新宿主自己的查询正常生效。
test('Logcat disposed device discovery cannot update replacement view ownership', async () => {
  const f = fixture(), old = f.resolve(); await old.view.receive({ type: 'ready' }); old.view.dispose();
  const current = f.resolve(); await current.view.receive({ type: 'ready' });
  const count = current.messages.length;
  f.requests[0].resolve([{ serial: 'old', state: 'device' }]); await settled();
  assert.equal(current.messages.length, count); assert.equal(f.provider.devices.length, 0);
  assert.equal(f.selections.length, 0); assert.equal(f.streams.length, 0);
  f.requests[1].resolve([{ serial: 'current', state: 'device' }]); await settled();
  assert.equal(f.streams.length, 1); assert.equal(f.streams[0].args[1], 'current');
  old.view.dispose(); assert.equal(f.provider.view, current.view);
  assert.equal(f.streams[0].proc.killed, undefined);
  current.view.dispose(); assert.equal(f.streams[0].proc.killed, true); assert.equal(f.intervals.size, 0);
});

// 设备发现失败仍向宿主显式报告，不能伪装为空目录或清除选择；下一次现有 tick 可正常使用。
test('Logcat discovery errors remain visible without clearing selected device', async () => {
  const f = fixture(), { view, messages } = f.resolve();
  f.provider.serial = 'phone'; await view.receive({ type: 'ready' });
  f.requests[0].reject(new Error('device discovery failed')); await settled();
  assert.match(f.errors[0], /device discovery failed/); assert.equal(f.provider.serial, 'phone');
  assert.equal(messages.filter(m => m.type === 'devices').length, 0); assert.equal(f.streams.length, 0);
  view.dispose(); assert.equal(f.intervals.size, 0);
});
