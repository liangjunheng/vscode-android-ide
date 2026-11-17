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
// 每条连接按服务选择准确响应，支持tracker空列表、HELO/Exit、shell v2和错误场景。
function peer(options = {}) {
  const sockets = [], commands = [], trackers = [], packets = [];
  const feed = (s, b) => options.split === false ? s.push(b) : [...b].forEach(byte => s.push(Buffer.from([byte])));
  const factory = () => { let phase = 0, service = '', pid;
    const socket = new Socket((s, data) => {
      if (phase < 2) {
        const length = parseInt(data.toString('ascii', 0, 4), 16); assert.equal(data.length - 4, length); const command = data.subarray(4).toString(); commands.push(command);
        if (!phase++) { assert.match(command, /^host:transport:/); feed(s, Buffer.from('OKAY')); return; }
        service = command;
        if (options.fail) { feed(s, Buffer.concat([Buffer.from('FAIL'), frame('permission denied')])); return; }
        if (service === 'track-jdwp') { trackers.push(s); feed(s, Buffer.concat([Buffer.from('OKAY'), frame(options.pids === undefined ? '123\n456\n' : options.pids)])); }
        else if (service.startsWith('jdwp:')) { pid = Number(service.slice(5)); feed(s, Buffer.from('OKAY')); }
        else if (service.startsWith('shell,v2,raw:')) { options.onShell?.(s, service); if (options.holdShell) return; const bad = options.shellError; const value = service.includes('ps -A') ? (typeof options.metadata === 'function' ? options.metadata() : options.metadata || '') : bad || (service.includes('force-stop') ? '' : 'Success\n'); feed(s, Buffer.concat([Buffer.from('OKAY'), shellFrame(bad ? 2 : 1, bad || value), shellFrame(3, Buffer.from([bad ? 1 : 0]))])); }
        else { throw Error('unexpected service ' + service); }
      } else if (data.equals(Buffer.from('JDWP-Handshake'))) { feed(s, data); }
      else { packets.push(data); if (options.jdwpEof) { s.push(null); return; } if (options.noAck) return; feed(s, reply(data[9] === 0xc7 ? helo(pid) : Buffer.alloc(0), data.readUInt32BE(4), options.jdwpError || 0)); }
    }); sockets.push(socket); return socket;
  };
  return { factory, sockets, commands, trackers, packets, feed };
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

// watcher 的下一帧新增 PID 必须读当批快照，不能复用首次成功或失败的 Promise。
for (const firstError of [false, true]) test('watch fallback loads fresh metadata for new PIDs ' + firstError, { timeout: 2000 }, async () => {
  let snapshot = 'PID USER NAME ARGS\n123 u0_a123 com.example.first com.example.first\n';
  const options = { pids: '123\n', jdwpEof: true, metadata: () => snapshot, shellError: firstError ? 'permission denied' : undefined };
  const p = peer(options), errors = [];
  let firstReady, secondReady;
  const first = new Promise(resolve => { firstReady = resolve; });
  const second = new Promise(resolve => { secondReady = resolve; });
  const stop = new DeviceExplorerProcesses('phone', p.factory).watch(rows => {
    if (rows.some(row => row.pid === 123 && row.error)) firstReady(rows);
    if (rows.some(row => row.pid === 456 && row.name)) secondReady(rows);
  }, error => errors.push(error));
  try {
    const initial = await first;
    assert.equal(initial[0].name, firstError ? undefined : 'com.example.first');
    options.shellError = undefined;
    snapshot = 'PID USER NAME ARGS\n456 u10_a234 com.example.second com.example.second\n';
    p.feed(p.trackers[0], frame('456\n'));
    const rows = await second;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].packageName, 'com.example.second');
    assert.equal(rows[0].userId, 10);
    assert.equal(p.commands.filter(c => c.startsWith('shell,v2,raw:')).length, 2);
    assert.deepEqual(errors, []);
  } finally { await stop(); }
  assert.ok(p.sockets.every(s => s.destroyed));
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

// tracker生命周期真实关闭并等待新增PID查询，不通过轮询检测完成；取消无残留监听。
test('watch publishes live processes and stop awaits all owned sockets', { timeout: 2000 }, async () => {
  const p = peer({ pids:'123\n' }), rows = [], errors = [];
  let ready; const first = new Promise(resolve => { ready = resolve; });
  const stop = new DeviceExplorerProcesses('phone',p.factory).watch(value => { rows.push(value); if (value.some(r => r.name)) ready(); }, e => errors.push(e));
  await first; p.feed(p.trackers[0],frame('')); await new Promise(resolve => setImmediate(resolve)); assert.equal(rows.at(-1).length,0); await stop(); assert.equal(errors.length,0); assert.ok(p.sockets.every(s=>s.destroyed));
});

// fail后的新read必须立即拒绝，4hex坏帧也必须失败，不能再次挂起到测试超时。
test('FrameReader rejects EOF and malformed length with complete listener cleanup', async () => {
  const s = new Socket(()=>{}), reader = new FrameReader(s); const pending = reader.readExact(4); s.push(Buffer.from('xx')); s.push(null); await assert.rejects(pending,/EOF/); assert.equal((await reader.readExact(2)).toString(), 'xx'); await assert.rejects(reader.readExact(1),/EOF/); reader.dispose(); assert.equal(s.listenerCount('data'),0); s.destroy();
  const bad = new Socket(()=>{}), r = new FrameReader(bad); bad.push(Buffer.from('zzzz')); await assert.rejects(r.readLength(),/Malformed/); r.dispose(); bad.destroy();
  const env = process.env.ADB_SERVER_SOCKET; try { process.env.ADB_SERVER_SOCKET='localabstract:adb'; assert.throws(()=>AdbSmartSocket.endpoint(),/Unsupported/); } finally { if(env===undefined)delete process.env.ADB_SERVER_SOCKET;else process.env.ADB_SERVER_SOCKET=env; }
});
