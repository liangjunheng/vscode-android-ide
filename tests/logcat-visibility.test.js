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
  const f = { requests: [], streams: [], watches: [], errors: [], selections: [], intervals: new Map() };
  let timerId = 0;
  const vscode = {
    Uri: { file: p => p, joinPath: (...p) => p.join('/') },
    workspace: {
      getConfiguration: () => ({ get: (key, fallback) => fallback }),
      findFiles: () => f.scan ? f.scan.promise : Promise.resolve(f.gradle ? [{ fsPath: 'project.gradle' }] : []),
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
    proc.stdout = new EventEmitter(); proc.stderr = new EventEmitter(); proc.stdout.setEncoding = () => {};
    proc.kill = () => { proc.killed = true; };
    f.streams.push({ proc, args }); return proc;
  };
  // 输入设备与 watcher 回调，输出可控快照/错误/停止句柄；不替换真实 LogcatView 业务。
  class DeviceExplorerProcesses {
    constructor(serial) { this.serial = serial; }
    watch(update, error) {
      const watch = { serial: this.serial, update, error, stops: 0 }; f.watches.push(watch);
      return () => { watch.stops++; return watch.pending?.promise ?? Promise.resolve(); };
    }
  }
  const parserModule = { exports: {} };
  vm.runInNewContext(transformSync(fs.readFileSync(path.join(__dirname, '../src/logcatParser.ts'), 'utf8'), { loader: 'ts', format: 'cjs' }).code, { module: parserModule, exports: parserModule.exports, Buffer, Set, String, Math });
  const deps = { vscode, './sdk': sdk, './logcatParser': parserModule.exports, child_process: { spawn }, './deviceExplorerProcesses': { DeviceExplorerProcesses }, fs: { ...fs, readFileSync: (file, encoding) => file === 'project.gradle' ? f.gradle : fs.readFileSync(file, encoding) } };
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

// 构造 logger_entry v1 字节帧，供后端真实 parser 回归使用；消息内容不参与边界推断。
function binaryFrame({ pid = 11, tid = 21, sec = 1577836800, nsec = 0, priority = 4, tag = 'Tag', msg = 'normal' } = {}) {
  const body = Buffer.concat([Buffer.from([priority]), Buffer.from(tag), Buffer.from([0]), Buffer.from(msg), Buffer.from([0])]);
  const frame = Buffer.alloc(20 + body.length); frame.writeUInt16LE(body.length, 0); frame.writeUInt16LE(0, 2); frame.writeInt32LE(pid, 4); frame.writeInt32LE(tid, 8); frame.writeInt32LE(sec, 12); frame.writeInt32LE(nsec, 16); body.copy(frame, 20); return frame;
}

// 真实后端接收二进制 record：消息内换行保留，同头独立条目不合并，旧 partial 不串入重启后的进程。
test('Logcat binary records preserve multiline messages and isolate old stream partials', async () => {
  const f = fixture(), host = f.resolve(); await f.provider.select('phone');
  const first = f.streams[0].proc;
  assert.deepEqual(Array.from(f.streams[0].args), ['-s','phone','logcat','-B','-b','main','-b','system','-b','crash','-T','1000']);
  const msg = 'row0)\nrow1)\n\nrow3)\n2026-01-01 00:00:00.000 11 21 I Tag: embedded\n';
  const bytes = Buffer.concat([binaryFrame({msg, priority:7,nsec:123456789}),binaryFrame({msg:'independent',priority:7,nsec:123456789})]);
  for (const byte of bytes) first.stdout.emit('data', Buffer.from([byte]));
  f.provider.flush();
  const items = host.messages.findLast(m => m.type === 'batch').items;
  assert.equal(items.length,2); assert.equal(items[0].msg,msg); assert.equal(items[1].msg,'independent');
  assert.equal(items[0].lv,'A'); assert.equal(items[0].ts,items[1].ts); assert.match(items[0].ts,/\.123$/);
  const partial = binaryFrame({msg:'old partial'}); first.stdout.emit('data',partial.subarray(0,23));
  await host.view.receive({type:'restart'}); const current=f.streams.at(-1).proc;
  const before=host.messages.length;
  first.stdout.emit('data',partial.subarray(23)); first.stderr.emit('data',Buffer.from('old error')); first.emit('error',new Error('stale')); first.emit('close',1);
  f.provider.flush(); assert.equal(host.messages.length,before); assert.equal(f.provider.proc,current);
  current.stdout.emit('data',binaryFrame({msg:'new record'})); f.provider.flush();
  assert.equal(host.messages.findLast(m=>m.type==='batch').items[0].msg,'new record');
  host.view.dispose();
});

// stderr/error 与坏帧/EOF 必须显示诊断，坏帧停止拥有的采集进程；已完成条目仍投递，不误报为成功。
test('Logcat binary stream reports stderr errors malformed frames and truncated EOF', async () => {
  const f=fixture(), host=f.resolve(); await f.provider.select('phone');
  let proc=f.streams[0].proc;
  proc.stderr.emit('data',Buffer.from('permission denied')); assert.match(host.messages.at(-1).text,/permission denied/);
  proc.emit('error',new Error('spawn failed')); assert.match(host.messages.at(-1).text,/spawn failed/);
  proc.stdout.emit('data',Buffer.concat([binaryFrame({msg:'before bad'}),Buffer.from([3,0,19,0])]));
  assert.equal(proc.killed,true); assert.match(host.messages.at(-1).text,/unsupported header size/);
  f.provider.flush(); assert.equal(host.messages.findLast(m=>m.type==='batch').items[0].msg,'before bad');
  await host.view.receive({type:'restart'}); proc=f.streams.at(-1).proc;
  proc.stdout.emit('data',binaryFrame().subarray(0,10)); proc.emit('close',1);
  assert.ok(host.messages.some(m=>m.type==='status' && /truncated frame/.test(m.text)));
  assert.match(host.messages.at(-1).text,/truncated frame/); host.view.dispose();
});

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

// 无硬件通过 ready 扫描真实 mine，再选择设备；输出可观察 watcher，作为进程分隔日志回归入口。
async function processFixture() {
  const f = fixture(), host = f.resolve();
  f.gradle = 'android { namespace = "com.example.app" }';
  await host.view.receive({ type: 'ready' });
  f.requests[0].resolve([{ serial: 'phone', state: 'device' }, { serial: 'two', state: 'device' }]); await settled();
  return { ...f, ...host };
}

// 精确检查首次/重复/新增/移除/:service/非项目/未知 PID，metadata 缺失不代表 ENDED；同队列不得按设备时间排序。
test('Logcat project processes emit exact Studio separators once and preserve receipt order', async () => {
  const f = await processFixture(), watch = f.watches[0], proc = f.streams[0].proc;
  const before = Date.now();
  watch.update([{ pid: 11, packageName: 'com.example.app' }, { pid: 12, name: 'com.example.app:service' }, { pid: 13, packageName: 'other.app' }, { pid: 14 }]);
  watch.update([{ pid: 11, packageName: 'com.example.app' }, { pid: 12, name: 'com.example.app:service' }, { pid: 13 }, { pid: 14 }]);
  proc.stdout.emit('data', binaryFrame({ msg: 'normal' }));
  watch.update([{ pid: 11 }, { pid: 12 }, { pid: 14, name: 'com.example.app:later' }]);
  watch.update([{ pid: 11 }, { pid: 14 }]);
  f.provider.flush();
  const items = f.messages.findLast(m => m.type === 'batch').items;
  assert.equal(items.length, 5);
  const separator = '-'.repeat(28);
  assert.deepEqual(Array.from(items, i => i.msg), [
    separator + ' PROCESS STARTED (11) for package com.example.app ' + separator,
    separator + ' PROCESS STARTED (12) for package com.example.app ' + separator,
    'normal',
    separator + ' PROCESS STARTED (14) for package com.example.app ' + separator,
    separator + ' PROCESS ENDED (12) for package com.example.app ' + separator,
  ]);
  for (const item of items.filter(i => i.system)) {
    assert.equal(item.ts, ''); assert.equal(item.tag, ''); assert.equal(item.tid, 0); assert.equal(item.lv, 'I');
    assert.equal(item.pkg, 'com.example.app'); assert.equal(item.system, true); assert.ok(item.rx >= before && item.rx <= Date.now());
  }
  assert.equal(items[2].system, undefined); assert.equal(items[2].pid, 11); assert.equal(items[2].tid, 21);
  watch.update([]); f.provider.flush();
  assert.deepEqual(Array.from(f.messages.findLast(m => m.type === 'batch').items, i => i.pid), [11, 14]);
  watch.update([{ pid: 11, packageName: 'com.example.app' }]); f.provider.flush();
  assert.match(f.messages.findLast(m => m.type === 'batch').items[0].msg, /PROCESS STARTED \(11\)/);
  f.view.dispose(); await settled(); assert.equal(watch.stops, 1);
});

// hide/select/restart/dispose 均释放 tracker，丢弃旧队列但不虚构 ENDED，旧快照/错误和旧 stdout 不得串入新设备。
test('Logcat process ownership releases on hide selection restart and disposal without synthetic endings', async () => {
  const f = await processFixture();
  let watch = f.watches[0];
  watch.update([{ pid: 11, packageName: 'com.example.app' }]);
  f.view.visible = false; f.view.visibilityChanged();
  assert.equal(watch.stops, 1); const hiddenCount = f.messages.length;
  watch.update([]); watch.error(new Error('stale hidden')); f.provider.flush();
  assert.equal(f.messages.length, hiddenCount);
  f.view.visible = true; f.view.visibilityChanged();
  f.requests.at(-1).resolve([{ serial: 'phone', state: 'device' }, { serial: 'two', state: 'device' }]); await settled();
  watch = f.watches.at(-1); watch.pending = deferred();
  watch.update([{ pid: 22, packageName: 'com.example.app' }]);
  await f.provider.select('two'); assert.equal(watch.stops, 1);
  const current = f.watches.at(-1); assert.equal(current.serial, 'two');
  const count = f.messages.length;
  watch.update([]); watch.error(new Error('stale selected')); f.streams[0].proc.stdout.emit('data', binaryFrame({ msg: 'stale' })); f.provider.flush();
  assert.equal(f.messages.length, count);
  watch.pending.resolve(); await settled();
  current.update([{ pid: 33, packageName: 'com.example.app' }]); f.provider.flush();
  await f.view.receive({ type: 'restart' }); assert.equal(current.stops, 1);
  const restarted = f.watches.at(-1); restarted.update([{ pid: 33, packageName: 'com.example.app' }]); f.provider.flush();
  assert.equal(f.messages.filter(m => m.type === 'batch').flatMap(m => m.items).filter(i => i.msg.includes('PROCESS ENDED')).length, 0);
  f.view.dispose(); await settled(); assert.equal(restarted.stops, 1); assert.equal(f.intervals.size, 0);
});

// 项目扫描晚于选择与初始快照时，ready 只补发仍存活的项目 PID；被移除的未知 PID 不得回放。
test('Logcat ready classifies live cached processes after asynchronous project discovery', async () => {
  const f = fixture(), host = f.resolve();
  await f.provider.select('phone');
  const watch = f.watches[0];
  watch.update([{ pid: 11, name: 'com.example.app:service' }, { pid: 12, packageName: 'com.example.app' }]);
  watch.update([{ pid: 11 }]);
  f.provider.flush(); assert.equal(host.messages.filter(m => m.type === 'batch').length, 0);
  f.gradle = 'namespace "com.example.app"'; await host.view.receive({ type: 'ready' });
  f.provider.flush();
  const items = host.messages.findLast(m => m.type === 'batch').items;
  assert.equal(items.length, 1); assert.equal(items[0].pid, 11); assert.match(items[0].msg, /PROCESS STARTED/);
  watch.update([{ pid: 11, packageName: 'com.example.app' }]); f.provider.flush();
  assert.equal(host.messages.filter(m => m.type === 'batch').length, 1);
  host.view.dispose(); f.requests[0].resolve([]); await settled();
});

// tracker 与单 PID metadata 错误必须明确报告；停止失败向宿主显示且不产生未处理 rejection，未知移除不伪造系统行。
test('Logcat process errors are explicit and stale failures cannot modify current batches', async () => {
  const f = await processFixture(), watch = f.watches[0];
  watch.update([{ pid: 99, error: 'metadata denied' }]); watch.update([]); f.provider.flush();
  assert.match(f.messages.findLast(m => m.type === 'status').text, /99.*metadata denied/);
  assert.equal(f.messages.filter(m => m.type === 'batch').length, 0);
  watch.error(new Error('tracker disconnected'));
  assert.match(f.messages.at(-1).text, /Process tracking failed:.*tracker disconnected/);
  watch.pending = deferred(); f.view.visible = false; f.view.visibilityChanged();
  watch.pending.reject(new Error('tracker stop failed')); await settled();
  assert.match(f.errors.at(-1), /tracker stop failed/); assert.equal(watch.stops, 1);
  f.view.dispose();
});
