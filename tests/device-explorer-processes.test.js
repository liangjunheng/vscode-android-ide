const test = require('node:test');
const assert = require('node:assert/strict');
const { Duplex } = require('node:stream');
const vm = require('node:vm');
const { transformSync } = require('esbuild');
const fs = require('node:fs');
const path = require('node:path');

// 运行实际TS模块，保留net协议实现，仅注入真实Duplex对端；无真实设备、无测试生产分支。
function load(file, cache = new Map()) {
  if (cache.has(file)) return cache.get(file).exports;
  const module = { exports: {} }; cache.set(file, module);
  vm.runInNewContext(transformSync(fs.readFileSync(file, 'utf8'), { loader: 'ts', format: 'cjs' }).code, { module, exports: module.exports, Buffer, process, AbortController, console, require: id => id.startsWith('.') ? load(path.resolve(path.dirname(file), id + '.ts'), cache) : require(id) });
  return module.exports;
}
const { DeviceExplorerProcesses, parseHelo, parseProcessSnapshot } = load(path.resolve(__dirname, '../src/deviceExplorerProcesses.ts'));
const { FrameReader, AdbSmartSocket } = load(path.resolve(__dirname, '../src/adbSmartSocket.ts'));

// UTF16长度与实际DDMS HELO布局相同，含非BMP名称/可选ABI/包名，防止使用错误长度协议。
function helo(pid, full = true) {
  const be = s => Buffer.from(s, 'utf16le').swap16(), int = n => { const b = Buffer.alloc(4); b.writeInt32BE(n); return b; };
  const name = 'com.example.测试😀', value = [int(1), int(pid), int(3), int(name.length), be('ART'), be(name)];
  if (full) value.push(int(10), int(7), be('arm64-v'), int(0), Buffer.from([0]), int(15), be('com.example.app'));
  const data = Buffer.concat(value); return Buffer.concat([Buffer.from('HELO'), int(data.length), data]);
}
// JDWP回复与shell v2退出帧来自实际wire格式，按byte分片和合包分别喂给读器。
function reply(body = Buffer.alloc(0), id = 1, error = 0) { const h = Buffer.alloc(11); h.writeUInt32BE(11 + body.length); h.writeUInt32BE(id, 4); h[8] = 0x80; h.writeUInt16BE(error, 9); return Buffer.concat([h, body]); }
function frame(value) { const b = Buffer.from(value); return Buffer.concat([Buffer.from(b.length.toString(16).padStart(4, '0')), b]); }
function shellFrame(id, value) { const body = Buffer.isBuffer(value) ? value : Buffer.from(value); const h = Buffer.alloc(5); h[0] = id; h.writeUInt32LE(body.length, 1); return Buffer.concat([h, body]); }

// 标准Duplex公开connecting状态，取消和close走原生stream生命周期，不手动伪造关闭。
class Socket extends Duplex {
  constructor(respond) { super(); this.connecting = true; this.writes = []; this.respond = respond; queueMicrotask(() => { this.connecting = false; this.emit('connect'); }); }
  _read() {}
  _write(chunk, encoding, done) { this.writes.push(Buffer.from(chunk)); try { this.respond(this, Buffer.from(chunk)); done(); } catch (error) { done(error); } }
}
// 功能：创建真实内存 ADB 对端；输入可控协议响应，输出 socket/命令/独占记录，不替换生产函数。
function peer(options = {}) {
  const sockets = [], commands = [], trackers = [], packets = [], owners = new Map(), rejections = [];
  const feed = (s, b) => options.split === false ? s.push(b) : [...b].forEach(byte => s.push(Buffer.from([byte])));
  const factory = () => { let phase = 0, service = '', pid;
    const socket = new Socket((s, data) => {
      if (phase < 2) {
        const length = parseInt(data.toString('ascii', 0, 4), 16); assert.equal(data.length - 4, length); const command = data.subarray(4).toString(); commands.push(command);
        if (!phase++) { assert.match(command, /^host:transport:/); feed(s, Buffer.from('OKAY')); return; }
        service = command;
        if (options.fail) { feed(s, Buffer.concat([Buffer.from('FAIL'), frame('permission denied')])); return; }
        if (service === 'track-jdwp') { trackers.push(s); feed(s, Buffer.concat([Buffer.from('OKAY'), frame(options.pids === undefined ? '123\n456\n' : options.pids)])); }
        else if (service.startsWith('jdwp:')) {
          pid = Number(service.slice(5));
          if (options.exclusive && owners.has(pid)) { rejections.push(pid); feed(s, Buffer.concat([Buffer.from('FAIL'), frame('FAKE_ADB_EXCLUSIVE: ' + pid)])); return; }
          if (options.exclusive) { owners.set(pid, s); s.once('close', () => { if (owners.get(pid) === s) owners.delete(pid); }); }
          feed(s, Buffer.from('OKAY'));
        }
        else if (service.startsWith('shell,v2,raw:')) { options.onShell?.(s, service); if (options.holdShell) return; if (options.shellEof) { feed(s, Buffer.from('OKAY')); s.push(null); return; } const bad = options.shellError; const value = service.includes('ps -A') ? (typeof options.metadata === 'function' ? options.metadata() : options.metadata || '') : bad || (service.includes('force-stop') ? '' : 'Success\n'); feed(s, Buffer.concat([Buffer.from('OKAY'), shellFrame(bad ? 2 : 1, bad || value), shellFrame(3, Buffer.from([bad ? 1 : 0]))])); }
        else { throw Error('unexpected service ' + service); }
      } else if (data.equals(Buffer.from('JDWP-Handshake'))) { feed(s, data); }
      else {
        assert.equal(data.readUInt32BE(0), data.length); assert.equal(data[8], 0);
        packets.push(data); options.onPacket?.(s, data);
        if (options.jdwpEof) { s.push(null); return; }
        if (options.noAck || (options.holdHelo && data[9] === 0xc7) || options.holdQuery) return;
        feed(s, reply(data[9] === 0xc7 ? helo(pid) : options.queryBody || Buffer.alloc(0), data.readUInt32BE(4), options.jdwpError || 0));
      }
    }); sockets.push(socket); return socket;
  };
  return { factory, sockets, commands, trackers, packets, feed, owners, rejections };
}

// 功能：建立事件门闩；输出 Promise 与完成入口，以协议事件控制并发而不使用延时。
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
// 功能：确认测试拥有的连接均已原生关闭并解除生产监听；输入对端，断言失败即资源泄漏。
function assertReleased(p) {
  assert.ok(p.sockets.every(socket => socket.destroyed && socket.closed));
  for (const socket of p.sockets) for (const event of ['data', 'end', 'error', 'close', 'connect', 'timeout']) assert.equal(socket.listenerCount(event), 0, '残留监听：' + event);
  assert.equal(p.owners.size, 0);
}

// 设备ps快照回退恢复进程名、包名和Android用户，覆盖HELO失败时的关键展示字段。
test('device ps snapshot restores process identity and user id',()=>{const row=parseProcessSnapshot('PID USER NAME ARGS\n18912 u0_a123 com.tcl.sdk.note.hd com.tcl.sdk.note.hd\n',18912);assert.equal(row.pid,18912);assert.equal(row.name,'com.tcl.sdk.note.hd');assert.equal(row.packageName,'com.tcl.sdk.note.hd');assert.equal(row.userId,0);});

// HELO失败时设备侧快照仍恢复完整进程字段，调试错误保持显式。
test('HELO failure falls back to device process metadata', async () => {
  const metadata = 'PID USER NAME ARGS\n123 u0_a123 com.tcl.sdk.note.hd com.tcl.sdk.note.hd\n__DEX_EXE__\n123\t/system/bin/app_process64\n__DEX_VM__\n__DEX_ABI64__\narm64-v8a\n__DEX_ABI__\narmeabi-v7a';
  const p = peer({ metadata, jdwpError: 1, split: false });
  const rows = await new DeviceExplorerProcesses('phone', p.factory).list();
  assert.equal(rows[0].name, 'com.tcl.sdk.note.hd');
  assert.equal(rows[0].packageName, 'com.tcl.sdk.note.hd');
  assert.equal(rows[0].userId, 0);
  assert.equal(rows[0].abi, '64-bit (arm64)');
  assert.equal(rows[0].vm, undefined);
  assert.equal(rows[1].abi, undefined);
  assert.equal(rows[1].vm, undefined);
  assert.equal(rows[0].debugger, 'error');
  assert.match(rows[0].error, /JDWP error 1/);
  const commands = p.commands.filter(c => c.startsWith('shell,v2,raw:'));
  assert.equal(commands.length, 1);
  assert.match(commands[0], /^shell,v2,raw:ps -A -o PID,USER,NAME,ARGS &&/);
  assert.ok(commands[0].includes('readlink "$entry"'));
  assert.ok(commands[0].includes('getprop ro.product.cpu.abilist32'));
  assert.ok(p.sockets.every(s => s.destroyed));
});


// EOF 后恢复身份但保留原始错误；shell 失败时两个错误均可见，不返回伪成功。
for (const shellError of [undefined, 'permission denied']) test('metadata EOF fallback preserves errors ' + (shellError || 'with identity'), async () => {
  const p = peer({ pids: '123\n', jdwpEof: true, shellError, metadata: 'PID USER NAME ARGS\n123 u0_a123 com.example.app com.example.app\n' });
  const [row] = await new DeviceExplorerProcesses('phone', p.factory).list();
  assert.equal(row.debugger, 'error');
  assert.match(row.error, /ADB socket EOF/);
  if (shellError) {
    assert.match(row.error, /metadata fallback: Error: permission denied/);
    assert.equal(row.name, undefined);
  } else {
    assert.equal(row.packageName, 'com.example.app');
    assert.equal(row.userId, 0);
    assert.equal(row.abi, undefined);
    assert.equal(row.vm, undefined);
    assert.doesNotMatch(row.error, /metadata fallback|not a function/);
  }
  assert.ok(p.sockets.every(s => s.destroyed));
});

// 使用 shell 到达事件取消读取，无延时或轮询；断言取消传播且真实 socket 已关闭。
test('metadata fallback cancellation releases sockets', { timeout: 2000 }, async () => {
  let entered;
  const shell = new Promise(resolve => { entered = resolve; });
  const p = peer({ pids: '123\n', jdwpEof: true, holdShell: true, onShell: entered });
  const controller = new AbortController();
  const pending = new DeviceExplorerProcesses('phone', p.factory).list(controller.signal);
  const rejected = assert.rejects(pending, /cancel|abort/i);
  await shell;
  controller.abort();
  await rejected;
  assert.ok(p.sockets.every(s => s.destroyed));
});

/**
 * 功能点：后台 watch 仅用 shell 元数据，不占用前台调试连接。
 * 受影响对象：DeviceExplorerProcesses.watch、快照解析、AdbSmartSocket、Processes/Logcat 后台订阅者。
 * 复现路径：Node>=22 且安装 esbuild；真实 TS 模块连接内存 Duplex；tracker 新增同批 PID，扣住 shell 或显式 JDWP 回复。
 * 测试范围：初始未知/同批共享、下一批 fresh、shell 非零/EOF、移除/取消/stop、异常 tracker、独占并发与监听释放；list/kill 旧协议不变。
 * 执行入口：node --test tests/device-explorer-processes.test.js；仅设计，本任务不执行。
 * 预期结果：后台零 jdwp 服务与 HELO，包/PID/ABI/UID 按真实快照更新，VM 不猜测，错误显式，显式查询成功。
 * 判据：全部严格断言成立且自有 socket 原生 close/监听清零；任意后台 JDWP、伪 Default/ART 或泄漏均失败；fake 规则不证明真机端口根因。
 */
// 功能：逐批推送新增 PID；成功和失败后的下一批都重新查询，不复用旧 Promise。
for (const firstError of [false, true]) test('watch shell metadata stays fresh for new PIDs ' + firstError, { timeout: 2000 }, async () => {
  let snapshot = 'PID USER NAME ARGS\n123 u0_a123 com.example.first com.example.first\n';
  const options = { pids: '123\n', metadata: () => snapshot, shellError: firstError ? 'permission denied' : undefined };
  const p = peer(options), errors = [], first = deferred(), second = deferred();
  const stop = new DeviceExplorerProcesses('phone', p.factory).watch(rows => {
    if (rows.some(row => row.pid === 123 && (row.name || row.error))) first.resolve(rows);
    if (rows.some(row => row.pid === 456 && row.name)) second.resolve(rows);
  }, error => errors.push(error));
  try {
    const initial = await first.promise;
    assert.equal(initial[0].name, firstError ? undefined : 'com.example.first');
    assert.equal(initial[0].debugger, firstError ? 'error' : 'unknown');
    if (firstError) assert.match(initial[0].error, /permission denied/);
    options.shellError = undefined;
    snapshot = 'PID USER NAME ARGS\n456 u10_a234 com.example.second com.example.second\n';
    p.feed(p.trackers[0], frame('456\n'));
    const rows = await second.promise;
    assert.equal(rows.length, 1); assert.equal(rows[0].pid, 456);
    assert.equal(rows[0].packageName, 'com.example.second'); assert.equal(rows[0].userId, 10);
    assert.equal(rows[0].debugger, 'unknown'); assert.equal(rows[0].error, undefined);
    assert.equal(p.commands.filter(c => c.startsWith('shell,v2,raw:')).length, 2);
    assert.equal(p.commands.some(c => c.startsWith('jdwp:')), false); assert.equal(p.packets.length, 0);
    assert.equal(errors.length, firstError ? 1 : 0);
    if (firstError) assert.match(String(errors[0]), /permission denied/);
  } finally { await stop(); }
  assertReleased(p);
});

// 功能：扣住同批 shell，检查先发未知行、每批只查询一次，以及各 PID 包/ABI/UID 隔离和 VM 缺失。
test('watch shares shell metadata and publishes unknown before real identity', { timeout: 2000 }, async () => {
  const entered = deferred(), ready = deferred(), updates = [], errors = [];
  const metadata = 'PID USER NAME ARGS\n123 u0_a1 com.example.first args\n456 u10_a2 com.example.second args\n789 u0_a3 com.example.third args\n__DEX_EXE__\n123\t/system/bin/app_process64\n456\t/system/bin/app_process32\n789\t/system/bin/unknown64\n__DEX_VM__\n__DEX_ABI64__\narm64-v8a\n__DEX_ABI__\narmeabi-v7a';
  const p = peer({ pids: '123\n456\n789\n999\n', holdShell: true, onShell: s => entered.resolve(s) });
  const stop = new DeviceExplorerProcesses('phone', p.factory).watch(rows => {
    updates.push(rows); if (rows.filter(row => row.name).length === 3) ready.resolve(rows);
  }, error => errors.push(error));
  try {
    const shell = await entered.promise;
    assert.deepEqual(Array.from(updates[0], row => [row.pid, row.debugger, row.error, row.vm]), [[123, 'unknown', undefined, undefined], [456, 'unknown', undefined, undefined], [789, 'unknown', undefined, undefined], [999, 'unknown', undefined, undefined]]);
    p.feed(p.trackers[0], frame('123\n456\n789\n999\n'));
    p.feed(shell, Buffer.concat([Buffer.from('OKAY'), shellFrame(1, metadata), shellFrame(3, Buffer.from([0]))]));
    const rows = await ready.promise;
    assert.equal(rows[0].packageName, 'com.example.first'); assert.equal(rows[0].abi, '64-bit (arm64)'); assert.equal(rows[0].userId, 0);
    assert.equal(rows[1].packageName, 'com.example.second'); assert.equal(rows[1].abi, '32-bit (armeabi-v7a)'); assert.equal(rows[1].userId, 10);
    assert.equal(rows[2].abi, undefined); assert.equal(rows[3].name, undefined); assert.equal(rows[3].userId, undefined);
    assert.ok(rows.every(row => row.debugger === 'unknown' && row.vm === undefined && row.error === undefined));
    assert.equal(p.commands.filter(c => c.startsWith('shell,v2,raw:')).length, 1);
    assert.equal(p.commands.some(c => c.startsWith('jdwp:')), false); assert.deepEqual(errors, []);
  } finally { await stop(); }
  assertReleased(p);
});

// 功能：真实 shell EOF/非零退出保持行错误并通知 onError，不把查询失败伪装成 unknown。
for (const shellEof of [true, false]) test('watch shell failures retain errors and release sockets ' + shellEof, { timeout: 2000 }, async () => {
  const ready = deferred(), errors = [], updates = [];
  const p = peer({ pids: '123\n', shellEof, shellError: shellEof ? undefined : 'permission denied' });
  const stop = new DeviceExplorerProcesses('phone', p.factory).watch(rows => updates.push(rows), error => { errors.push(error); ready.resolve(); });
  try {
    await ready.promise;
    assert.equal(updates.at(-1)[0].debugger, 'error');
    assert.match(updates.at(-1)[0].error, shellEof ? /ADB socket EOF/ : /permission denied/);
    assert.equal(errors.length, 1); assert.match(String(errors[0]), shellEof ? /ADB socket EOF/ : /permission denied/);
    assert.equal(p.commands.some(c => c.startsWith('jdwp:')), false);
  } finally { await stop(); }
  assertReleased(p);
});

// 功能：在真实 shell 读取中移除全部 PID、外部取消或 stop，完成事件确认关闭，无延时和轮询。
for (const mode of ['remove', 'abort', 'stop']) test('watch pending metadata releases on ' + mode, { timeout: 2000 }, async () => {
  const entered = deferred(), updates = [], errors = [], controller = new AbortController();
  const p = peer({ pids: '123\n456\n', holdShell: true, onShell: s => entered.resolve(s) });
  const stop = new DeviceExplorerProcesses('phone', p.factory).watch(rows => updates.push(rows), error => errors.push(error), controller.signal);
  try {
    const shell = await entered.promise, closed = new Promise(resolve => shell.once('close', resolve));
    if (mode === 'remove') p.feed(p.trackers[0], frame(''));
    else if (mode === 'abort') controller.abort();
    else await stop();
    await closed;
    if (mode === 'remove') assert.equal(updates.at(-1).length, 0);
    else assert.ok(updates.every(rows => rows.every(row => row.debugger === 'unknown')));
    assert.deepEqual(errors, []); assert.equal(p.commands.some(c => c.startsWith('jdwp:')), false);
  } finally { await stop(); }
  assertReleased(p);
});

// 功能：同批仅移除一个 PID 不取消其他 PID 的共享读取；迟到快照不能复活被移除的进程。
test('watch removed PID cannot publish foreign metadata into surviving rows', { timeout: 2000 }, async () => {
  const entered = deferred(), removed = deferred(), ready = deferred(), updates = [], errors = [];
  const p = peer({ pids: '123\n456\n', holdShell: true, onShell: s => entered.resolve(s) });
  const stop = new DeviceExplorerProcesses('phone', p.factory).watch(rows => {
    updates.push(rows); if (rows.length === 1) removed.resolve(); if (rows.some(row => row.name)) ready.resolve(rows);
  }, error => errors.push(error));
  try {
    const shell = await entered.promise;
    p.feed(p.trackers[0], frame('456\n')); await removed.promise; assert.equal(shell.destroyed, false);
    p.feed(shell, Buffer.concat([Buffer.from('OKAY'), shellFrame(1, 'PID USER NAME ARGS\n123 u0_a1 com.example.removed args\n456 u10_a2 com.example.live args\n789 u0_a3 com.example.foreign args\n'), shellFrame(3, Buffer.from([0]))]));
    const rows = await ready.promise;
    assert.deepEqual(Array.from(rows, row => [row.pid, row.packageName, row.userId, row.debugger]), [[456, 'com.example.live', 10, 'unknown']]);
    assert.ok(updates.slice(1).every(rows => rows.every(row => row.pid === 456))); assert.deepEqual(errors, []);
    assert.equal(p.commands.filter(c => c.startsWith('shell,v2,raw:')).length, 1);
  } finally { await stop(); }
  assertReleased(p);
});

// 功能：tracker EOF/非法 PID 仍通知错误，stop 回收尚未完成的元数据；预取消不创建 socket。
for (const malformed of [false, true]) test('watch tracker failures release pending shell on stop ' + malformed, { timeout: 2000 }, async () => {
  const entered = deferred(), failed = deferred(), errors = [];
  const p = peer({ pids: '123\n', holdShell: true, onShell: s => entered.resolve(s) });
  const stop = new DeviceExplorerProcesses('phone', p.factory).watch(() => {}, error => { errors.push(error); failed.resolve(error); });
  try {
    await entered.promise;
    if (malformed) p.feed(p.trackers[0], frame('foreign\n')); else p.trackers[0].push(null);
    assert.match(String(await failed.promise), malformed ? /Malformed JDWP process list/ : /ADB socket EOF/);
  } finally { await stop(); }
  assert.equal(errors.length, 1); assertReleased(p);
  const cancelled = peer(), controller = new AbortController(); controller.abort();
  await new DeviceExplorerProcesses('phone', cancelled.factory).watch(() => assert.fail('预取消不应发布'), () => assert.fail('预取消不应报错'), controller.signal)();
  assert.equal(cancelled.sockets.length, 0);
});

// 功能：复用 task62 的按 PID 独占规则，扣住真实 shell 与显式 JDWP；后台全程零 JDWP，第二路真实请求成功。
test('watch never occupies exclusive JDWP while an explicit real request succeeds', { timeout: 2000 }, async () => {
  const entered = deferred(), queried = deferred(), ready = deferred(), errors = [], controller = new AbortController();
  const p = peer({ pids: '123\n', exclusive: true, holdHelo: true, holdShell: true, holdQuery: true, onShell: s => entered.resolve(s), onPacket: (socket, packet) => queried.resolve({ socket, packet }) });
  const adb = new AdbSmartSocket(p.factory);
  const stop = new DeviceExplorerProcesses('phone', p.factory).watch(rows => { if (rows.some(row => row.name)) ready.resolve(rows); }, error => errors.push(error));
  let request;
  try {
    const shell = await entered.promise;
    assert.equal(p.commands.some(c => c.startsWith('jdwp:')), false); assert.equal(p.packets.length, 0); assert.equal(p.owners.size, 0);
    request = adb.jdwpRequest('phone', 123, 1, 1, Buffer.alloc(0), controller.signal);
    const observed = request.catch(error => error);
    const { socket, packet } = await queried.promise;
    assert.equal(p.owners.get(123), socket); assert.equal(packet.toString('hex'), '0000000b00000001000101');
    await assert.rejects(adb.jdwpRequest('phone', 123, 1, 1), /FAKE_ADB_EXCLUSIVE: 123/);
    assert.deepEqual(p.rejections, [123]);
    p.feed(shell, Buffer.concat([Buffer.from('OKAY'), shellFrame(1, 'PID USER NAME ARGS\n123 u0_a1 com.example.concurrent args\n'), shellFrame(3, Buffer.from([0]))]));
    const rows = await ready.promise;
    assert.equal(rows[0].debugger, 'unknown'); assert.equal(rows[0].vm, undefined); assert.equal(rows[0].error, undefined);
    assert.equal(p.owners.get(123), socket); assert.equal(socket.destroyed, false);
    assert.equal(p.commands.filter(c => c.startsWith('jdwp:')).length, 2); assert.equal(p.packets.length, 1);
    assert.equal(p.packets.some(packet => packet[9] === 0xc7), false);
    p.feed(socket, reply(Buffer.from('explicit-query-success'), packet.readUInt32BE(4)));
    assert.equal((await request).toString(), 'explicit-query-success'); await observed;
    assert.deepEqual(errors, []);
  } finally { controller.abort(); if (request) await request.catch(() => {}); await stop(); }
  assertReleased(p);
});

// 同批两个PID共享真实快照却保持位数/用户/包名隔离；不把缺失VM或未知exe伪装成正常字段。
test('HELO fallback shares one PID-specific snapshot',async()=>{
  const metadata='PID USER NAME ARGS\n123 u0_a1 com.example.first args\n456 u10_a2 com.example.second args\n__DEX_EXE__\n123\t/system/bin/app_process64\n456\t/system/bin/app_process32\n__DEX_VM__\n__DEX_ABI64__\narm64-v8a\n__DEX_ABI__\narmeabi-v7a';
  const p=peer({metadata,jdwpError:1,split:false}),rows=await new DeviceExplorerProcesses('phone',p.factory).list();
  assert.equal(rows[0].abi,'64-bit (arm64)');assert.equal(rows[1].abi,'32-bit (armeabi-v7a)');assert.equal(rows[1].userId,10);assert.equal(rows[0].packageName,'com.example.first');assert.equal(rows[1].packageName,'com.example.second');assert.ok(rows.every(r=>r.vm===undefined&&r.debugger==='error'));
  assert.equal(p.commands.filter(c=>c.startsWith('shell,v2,raw:')).length,1);assert.ok(p.sockets.every(s=>s.destroyed));
  const unknown=peer({pids:'123\n',metadata:metadata.replace('123\t/system/bin/app_process64','123\t/system/bin/unknown64'),jdwpError:1,split:false});
  assert.equal((await new DeviceExplorerProcesses('phone',unknown.factory).list())[0].abi,undefined);assert.ok(unknown.sockets.every(s=>s.destroyed));
});

// HELO初始数值/双字符串长度/可选字段必须精确解析，损坏输入拒绝而非默默返回空字段。
test('HELO decodes actual fields and rejects malformed optional segments', () => {
  const full = parseHelo(helo(123)); assert.equal(full.pid, 123); assert.equal(full.name, 'com.example.测试😀'); assert.equal(full.vm, 'ART'); assert.equal(full.abi, 'arm64-v'); assert.equal(full.userId, 10); assert.equal(full.packageName, 'com.example.app');
  assert.equal(parseHelo(helo(123, false)).abi, undefined);
  assert.throws(() => parseHelo(helo(123).subarray(0, 20)), /Malformed/);
  const bad = Buffer.concat([helo(123, false), Buffer.from([1])]); bad.writeUInt32BE(bad.length - 8, 4); assert.throws(() => parseHelo(bad), /Truncated/);
});

// 分片和合包均运行真实list与HELO，全部连接在返回前关闭，元数据不是硬编码waiting。
for (const split of [true, false]) test('track snapshot and HELO metadata survive ' + (split ? 'byte splits' : 'coalesced packets'), { timeout: 2000 }, async () => {
  const p = peer({ split }), controller = new AbortController();
  try { const rows = await new DeviceExplorerProcesses('phone', p.factory).list(controller.signal); assert.deepEqual(Array.from(rows, r => r.pid), [123,456]); assert.equal(rows[0].packageName, 'com.example.app'); assert.equal(rows[0].debugger, 'default'); assert.equal(p.sockets.length, 3);assert.equal(p.commands.some(c=>c.startsWith('shell,v2,raw:')),false); assert.ok(p.sockets.every(s => s.destroyed)); assert.equal(p.packets[0].subarray(11,15).toString(), 'HELO'); }
  finally { controller.abort(); p.sockets.forEach(s => s.destroy()); }
});

// 退出命令必须为1/10/body1且只发送一次；无ACK、错误回复和取消不能伪成功。
test('VM.Exit has exact bytes and cancellation rejects a missing reply', { timeout: 2000 }, async () => {
  const p = peer(); await new DeviceExplorerProcesses('phone', p.factory).kill(77); assert.equal(p.packets.length,1); assert.equal(p.packets[0].toString('hex'), '0000000f0000000100010a00000001');
  const absent = peer({ noAck: true }), controller = new AbortController(); const pending = new DeviceExplorerProcesses('phone', absent.factory).kill(77, controller.signal); const observed = pending.catch(e => e); await new Promise(resolve => setImmediate(resolve)); controller.abort(); assert.match(String(await observed), /cancel|abort/i); assert.ok(absent.sockets.every(s => s.destroyed));
});

// shell v2有独立stderr和退出码，force-stop无输出也可成功；包校验与非零失败均严格断言。
test('package actions use verified names and shell v2 exit status', { timeout: 2000 }, async () => {
  const p = peer(), explorer = new DeviceExplorerProcesses('phone', p.factory); await explorer.forceStop('com.example.app',10); await explorer.clearData('com.example.app'); await explorer.uninstall('com.example.app'); assert.ok(p.commands.includes('shell,v2,raw:am force-stop --user 10 com.example.app'));
  await assert.rejects(explorer.forceStop('bad;name'), /Invalid package/); await assert.rejects(explorer.clearData('com.example.app',-1), /Invalid user/);
  const bad = peer({ shellError: 'permission denied' }); await assert.rejects(new DeviceExplorerProcesses('phone',bad.factory).forceStop('com.example.app'), /permission denied/); assert.ok(bad.sockets.every(s => s.destroyed));
});

// 功能：真实 tracker 发布、清空进程并停止；事件门闩确认移除，stop 等待连接关闭且后台零 JDWP。
test('watch publishes live processes and stop awaits all owned sockets', { timeout: 2000 }, async () => {
  const p = peer({ pids: '123\n', metadata: 'PID USER NAME ARGS\n123 u0_a1 com.example.live args\n' }), errors = [], first = deferred(), empty = deferred();
  const stop = new DeviceExplorerProcesses('phone', p.factory).watch(rows => {
    if (rows.some(row => row.name)) first.resolve(rows);
    if (!rows.length) empty.resolve(rows);
  }, error => errors.push(error));
  try {
    assert.equal((await first.promise)[0].debugger, 'unknown');
    p.feed(p.trackers[0], frame('')); assert.equal((await empty.promise).length, 0);
    assert.equal(errors.length, 0); assert.equal(p.commands.some(command => command.startsWith('jdwp:')), false);
  } finally { await stop(); }
  assertReleased(p);
});

// fail后的新read必须立即拒绝，4hex坏帧也必须失败，不能再次挂起到测试超时。
test('FrameReader rejects EOF and malformed length with complete listener cleanup', async () => {
  const s = new Socket(()=>{}), reader = new FrameReader(s); const pending = reader.readExact(4); s.push(Buffer.from('xx')); s.push(null); await assert.rejects(pending,/EOF/); assert.equal((await reader.readExact(2)).toString(), 'xx'); await assert.rejects(reader.readExact(1),/EOF/); reader.dispose(); assert.equal(s.listenerCount('data'),0); s.destroy();
  const bad = new Socket(()=>{}), r = new FrameReader(bad); bad.push(Buffer.from('zzzz')); await assert.rejects(r.readLength(),/Malformed/); r.dispose(); bad.destroy();
  const env = process.env.ADB_SERVER_SOCKET; try { process.env.ADB_SERVER_SOCKET='localabstract:adb'; assert.throws(()=>AdbSmartSocket.endpoint(),/Unsupported/); } finally { if(env===undefined)delete process.env.ADB_SERVER_SOCKET;else process.env.ADB_SERVER_SOCKET=env; }
});
