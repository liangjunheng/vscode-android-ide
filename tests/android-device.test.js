// 功能点：DebugDevice 的设备操作与自有 JDWP 资源生命周期。
// 受影响对象：devices、clients、launch、stop、clearDebugApp、forward、resume、abis；真实 FrameReader。
// 复现路径：加载当前 TypeScript 源码，仅替换 execFile、AdbSmartSocket 方法、SDK 路径和 net.Socket 外部边界。
// 测试范围：正常枚举、精确进程匹配、旧快照、安装及 Launcher、安全输入、握手与回复、取消、EOF、清理聚合、ABI 隔离。
// 执行入口：node --test tests/android-device.test.js；完整回归使用npm test。
// 预期结果：断言命令、事件顺序、错误对象、协议字节及资源释放，整个过程不连接真实设备或网络。
// 判据：所有用例通过且无悬挂读取、错误被吞或其他包 ABI 混入；任一断言失败即失败。
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
const pkg = 'com.example.app';

// 功能：创建可直接推进的事件屏障；输入无；输出承诺与结算函数；验证：本文件的取消和关闭用例。
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

// 功能：构造严格 JDWP 回复或事件；输入编号、正文和标志；输出协议帧；验证：握手及协议错误用例。
function packet(id, body = Buffer.alloc(0), flags = 0x80, code = 0) {
  const header = Buffer.alloc(11);
  header.writeUInt32BE(11 + body.length, 0);
  header.writeUInt32BE(id, 4);
  header[8] = flags;
  header.writeUInt16BE(code, 9);
  return Buffer.concat([header, body]);
}

// 功能：创建真实源码的独立沙箱；输入边界行为；输出设备类、命令记录及事件控制器；验证：本文件全部用例。
function fixture(options = {}) {
  const calls = [], trackers = [], sockets = [], lifecycle = [];
  const tracked = deferred(), connected = deferred(), handshake = deferred(), removed = deferred();
  let trackerClosed = 0;
  // 功能：记录并模拟 ADB 参数数组；输入 execFile 边界参数；输出回调结果；验证：安装、转发和取消用例。
  const execFile = (file, args, config, callback) => {
    calls.push({ kind: 'exec', file, args: [...args], signal: config.signal });
    Promise.resolve().then(() => {
      if (options.exec) { return options.exec(args, config); }
      return args.includes('--remove') ? '' : args.includes('install') ? 'Success\n' : '32001\n';
    }).then(value => {
      if (args.includes('--remove')) { lifecycle.push('remove'); removed.resolve(); }
      callback(null, value, '');
    }, error => {
      if (args.includes('--remove')) { lifecycle.push('remove-error'); removed.resolve(); }
      callback(error, '', error.message);
    });
  };
  // 功能：仅替换设备服务边界；输入串号、命令和信号；输出可控响应和订阅；验证：枚举、客户端及启动用例。
  class MockAdbSmartSocket {
    async command(command, signal) {
      calls.push({ kind: 'command', command, signal });
      return Buffer.from(options.command ? await options.command(command, signal) : 'serial-1\tdevice\nserial-2\toffline\nserial-3\tunauthorized\n');
    }
    async shell(serial, command, signal) {
      calls.push({ kind: 'shell', serial, command, signal });
      return Buffer.from(options.shell ? await options.shell(command, signal) : '');
    }
    trackJdwp(serial, onPids, onError, signal) {
      const tracker = { serial, onPids, onError, signal };
      trackers.push(tracker);
      calls.push({ kind: 'track', serial, signal });
      tracked.resolve(tracker);
      if (options.track) { options.track(tracker); }
      else { onPids([]); }
      return async () => {
        trackerClosed++;
        lifecycle.push('tracker-close');
        if (options.trackClose) { await options.trackClose(); }
      };
    }
  }
  // 功能：模拟网络事件而不替换帧读器；输入连接及写入；输出真实字节流和生命周期事件；验证：resume 用例。
  class MockSocket extends EventEmitter {
    constructor() { super(); this.destroyed = false; this.readable = true; this.writable = true; this.writes = []; sockets.push(this); }
    connect(port, host) {
      this.port = port; this.host = host;
      connected.resolve(this);
      queueMicrotask(() => {
        if (options.connect) { options.connect(this); }
        else if (!this.destroyed) { this.emit('connect'); }
      });
      return this;
    }
    write(value, callback) {
      const bytes = Buffer.from(value);
      this.writes.push(bytes);
      queueMicrotask(() => {
        if (this.destroyed) { return; }
        if (bytes.equals(Buffer.from('JDWP-Handshake'))) { handshake.resolve(this); }
        if (options.write) { options.write(this, bytes); }
        else if (bytes.equals(Buffer.from('JDWP-Handshake'))) { this.feed(bytes); }
        else {
          const id = bytes.readUInt32BE(4);
          const body = id === 1 ? Buffer.alloc(20) : Buffer.alloc(0);
          if (id === 1) { [0, 4, 8, 12, 16].forEach(offset => body.writeUInt32BE(8, offset)); }
          this.feed(packet(id, body));
        }
        if (typeof callback === 'function') { callback(); }
      });
      return true;
    }
    // 功能：以分片触发真实读取逻辑；输入一帧；输出两次数据事件；验证：握手和回复分片用例。
    feed(bytes) {
      const middle = Math.max(1, Math.floor(bytes.length / 2));
      this.emit('data', bytes.subarray(0, middle));
      this.emit('data', bytes.subarray(middle));
    }
    // 功能：按 Node 顺序异步发出错误及关闭；输入可选错误；输出一次 close；验证：取消、EOF 和清理顺序用例。
    destroy(error) {
      if (this.destroyed) { return this; }
      this.destroyed = true;
      queueMicrotask(() => {
        if (error) { this.emit('error', error); }
        lifecycle.push('socket-close');
        this.emit('close', Boolean(error));
      });
      return this;
    }
    setNoDelay() { return this; }
    setKeepAlive() { return this; }
    pause() { return this; }
    resume() { return this; }
  }
  const net = { Socket: MockSocket };
  const cache = new Map();
  // 功能：转译并加载当前源码，保留真实 FrameReader；输入绝对源文件路径；输出模块；验证：所有真实函数用例。
  function load(file) {
    if (cache.has(file)) { return cache.get(file).exports; }
    const module = { exports: {} };
    cache.set(file, module);
    const nativeRequire = createRequire(file);
    const localRequire = id => {
      if (id === 'node:net' || id === 'net') { return net; }
      if (id === 'node:child_process' || id === 'child_process') { return { execFile }; }
      if (/^(?:\.\/|\.\.\/)sdk$/.test(id)) { return { adbPath: () => 'mock-adb' }; }
      if (id === '../adbSmartSocket') {
        const actual = load(path.join(root, 'src', 'adbSmartSocket.ts'));
        return { ...actual, AdbSmartSocket: MockAdbSmartSocket };
      }
      if (id.startsWith('.')) {
        const source = path.resolve(path.dirname(file), id + '.ts');
        if (fs.existsSync(source)) { return load(source); }
      }
      return nativeRequire(id);
    };
    const output = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
      fileName: file,
    }).outputText;
    const run = vm.runInThisContext('(function(require,module,exports,__filename,__dirname){' + output + '\n})', { filename: file });
    run(localRequire, module, module.exports, file, path.dirname(file));
    return module.exports;
  }
  const { DebugDevice } = load(path.join(root, 'src', 'android-debugger', 'device.ts'));
  return { DebugDevice, device: new DebugDevice('serial-1'), calls, trackers, sockets, lifecycle,
    tracked, connected, handshake, removed, closed: () => trackerClosed };
}

// 功能：验证枚举协议和取消原因；输入设备行及边界错误；输出严格列表或原错误；验证：此测试入口。
test('设备枚举保留全部状态并拒绝畸形输出，取消不被包装', async () => {
  const f = fixture();
  assert.deepEqual(await f.DebugDevice.devices(), [
    { serial: 'serial-1', state: 'device' }, { serial: 'serial-2', state: 'offline' }, { serial: 'serial-3', state: 'unauthorized' },
  ]);
  assert.equal(f.calls[0].command, 'host:devices');
  await assert.rejects(fixture({ command: () => 'bad row' }).DebugDevice.devices(), /非法设备列表/);
  const controller = new AbortController(), reason = new Error('枚举取消');
  const cancelled = fixture({ command: () => { controller.abort(reason); throw new Error('边界取消包装'); } });
  await assert.rejects(cancelled.DebugDevice.devices(controller.signal), error => error === reason);
  const before = fixture();
  await assert.rejects(before.DebugDevice.devices(controller.signal), error => error === reason);
  assert.equal(before.calls.length, 0);
});

// 功能：验证订阅首帧、精确 PID 和异常聚合；输入 ps 与跟踪事件；输出合法客户端或错误；验证：此测试入口。
test('客户端首帧关闭后匹配ps，保留取消断线与清理双错误', async () => {
  const f = fixture({ track: t => t.onPids([10, 11, 12, 14]), shell: () =>
    'PID NAME\n10 com.example.app\n11 com.example.app:remote\n12 system_server\n13 com.other.app\n14 com.other.app\n' });
  assert.deepEqual(await f.device.clients(), [
    { pid: 10, packageName: pkg }, { pid: 11, packageName: pkg }, { pid: 14, packageName: 'com.other.app' },
  ]);
  assert.equal(f.closed(), 1);
  assert.equal(f.calls.at(-1).command, 'ps -A -o PID,NAME');
  for (const output of ['PID OTHER\n1 name', 'PID NAME\nbad row extra', 'PID NAME\n0 com.example.app']) {
    await assert.rejects(fixture({ track: t => t.onPids([1]), shell: () => output }).device.clients());
  }
  const controller = new AbortController(), reason = new Error('客户端取消'), cleanup = new Error('订阅清理失败');
  const aborted = fixture({ track() {}, trackClose: () => { throw cleanup; } });
  const pending = aborted.device.clients(controller.signal);
  controller.abort(reason);
  await assert.rejects(pending, error => error instanceof AggregateError && error.errors[0] === reason && error.errors[1] === cleanup);
  assert.equal(aborted.closed(), 1);
  const eof = new Error('track EOF');
  await assert.rejects(fixture({ track: t => { t.onPids([10]); t.onError(eof); } }).device.clients(), error => error === eof);
});

// 功能：验证启动事件门和旧快照精确目标；输入安装、Launcher、跟踪及 ps；输出主进程；验证：此测试入口。
test('启动安装与Launcher使用真实函数，旧快照不误认远程进程或其他包', async () => {
  let f, scans = 0;
  f = fixture({ track: t => t.onPids([40, 41]), shell: command => {
    if (command.startsWith('cmd package')) { return 'priority=0\ncom.example.app/.MainActivity\n'; }
    if (command.startsWith('am start')) { f.trackers[0].onPids([40, 41, 42]); return 'Starting: Intent\n'; }
    if (command === 'ps -A -o PID,NAME') {
      scans++;
      return 'PID NAME\n40 com.example.app:remote\n41 com.example.application\n42 com.example.app\n';
    }
    return '';
  } });
  const controller = new AbortController();
  assert.equal(await f.device.launch(pkg, undefined, 'C:/build folder/app.apk', controller.signal), 42);
  assert.equal(scans, 2);
  assert.equal(f.closed(), 1);
  const install = f.calls.find(c => c.kind === 'exec');
  assert.deepEqual(install.args, ['-s', 'serial-1', 'install', '-r', 'C:/build folder/app.apk']);
  assert.equal(install.signal, controller.signal);
  assert.deepEqual(f.calls.map(c => c.kind === 'exec' ? 'install' : c.kind === 'shell' ? c.command : c.kind), [
    'am force-stop com.example.app', 'install',
    'cmd package resolve-activity --brief -a android.intent.action.MAIN -c android.intent.category.LAUNCHER com.example.app',
    'track', 'am start -D -n com.example.app/com.example.app.MainActivity', 'ps -A -o PID,NAME', 'ps -A -o PID,NAME',
  ]);
  const old = fixture({ track: t => t.onPids([50]), shell: command => command.startsWith('ps ') ? 'PID NAME\n50 com.example.app\n' : '' });
  assert.equal(await old.device.launch(pkg, '.MainActivity', undefined, new AbortController().signal), 50);
  assert.equal(old.closed(), 1);
});

// 功能：验证启动异常、安全输入及取消；输入非法参数与边界失败；输出失败且订阅关闭；验证：此测试入口。
test('启动拒绝注入、文本错误、安装失败与多主进程，取消保持原错误', async () => {
  const signal = new AbortController().signal;
  for (const serial of ['', '-s', 'x y', 'x\n', 'x\0']) { assert.throws(() => new (fixture().DebugDevice)(serial), /非法设备串号/); }
  for (const [name, activity, apk] of [[pkg + ';id', '.Main', undefined], [pkg, 'other.pkg/.Main', undefined],
    [pkg, '.Main;id', undefined], [pkg, '.Main', '-g'], [pkg, '.Main', 'a\0.apk']]) {
    const f = fixture();
    await assert.rejects(f.device.launch(name, activity, apk, signal));
    assert.equal(f.calls.length, 0);
  }
  for (const output of ['Failure [BAD_APK]', 'Success\nError: rejected', '']) {
    const f = fixture({ exec: () => output });
    await assert.rejects(f.device.launch(pkg, '.Main', 'app.apk', signal), /安装失败/);
    assert.equal(f.trackers.length, 0);
  }
  const installAbort = new AbortController(), installReason = new Error('安装取消');
  const installing = fixture({ exec: () => { installAbort.abort(installReason); throw new Error('AbortError'); } });
  await assert.rejects(installing.device.launch(pkg, '.Main', 'app.apk', installAbort.signal), error => error === installReason);
  for (const output of ['', 'other.pkg/.Main\n', 'com.example.app/.A\ncom.example.app/.B\n']) {
    await assert.rejects(fixture({ shell: command => command.startsWith('cmd package') ? output : '' }).device.launch(pkg, undefined, undefined, signal));
  }
  const startError = fixture({ track: t => t.onPids([]), shell: command => command.startsWith('am start') ? 'Error: no activity' : '' });
  await assert.rejects(startError.device.launch(pkg, '.Main', undefined, signal), /no activity/);
  assert.equal(startError.closed(), 1);
  const duplicates = fixture({ track: t => t.onPids([10, 11]), shell: command => command.startsWith('ps ') ? 'PID NAME\n10 com.example.app\n11 com.example.app\n' : '' });
  await assert.rejects(duplicates.device.launch(pkg, '.Main', undefined, signal), /多个主进程/);
  assert.equal(duplicates.closed(), 1);
  const controller = new AbortController(), reason = new Error('启动等待取消');
  let waiting;
  waiting = fixture({ track: t => t.onPids([]), shell: command => {
    if (command.startsWith('ps ')) { controller.abort(reason); return 'PID NAME\n'; }
    return '';
  } });
  await assert.rejects(waiting.device.launch(pkg, '.Main', undefined, controller.signal), error => error === reason);
  assert.equal(waiting.closed(), 1);
  const disconnect = new Error('启动track断线');
  let disconnected;
  disconnected = fixture({ track: t => t.onPids([10]), shell: command => {
    if (command.startsWith('ps ')) { disconnected.trackers[0].onError(disconnect); return 'PID NAME\n10 com.example.app\n'; }
    return '';
  } });
  await assert.rejects(disconnected.device.launch(pkg, '.Main', undefined, signal), error => error === disconnect);
  const stop = fixture();
  await stop.device.stop(pkg); await stop.device.clearDebugApp();
  assert.deepEqual(stop.calls.map(c => c.command), ['am force-stop com.example.app', 'am clear-debug-app']);
  await assert.rejects(stop.device.stop(pkg + ';id'));
  await assert.rejects(fixture({ shell: () => 'java.lang.SecurityException: denied' }).device.clearDebugApp(), /SecurityException/);
});

// 功能：验证动态转发归属和取消竞态；输入 PID、端口及边界错误；输出幂等租约或聚合错误；验证：此测试入口。
test('转发仅回收自有端口，取消竞态不丢失资源且清理错误可见', async () => {
  const f = fixture(), controller = new AbortController();
  const lease = await f.device.forward(12, controller.signal);
  assert.equal(lease.port, 32001);
  await Promise.all([lease.close(), lease.close()]);
  assert.deepEqual(f.calls.map(c => c.args), [
    ['-s', 'serial-1', 'forward', 'tcp:0', 'jdwp:12'], ['-s', 'serial-1', 'forward', '--remove', 'tcp:32001'],
  ]);
  assert.equal(f.calls[0].signal, undefined);
  for (const pid of [0, -1, 1.2, NaN, Number.MAX_SAFE_INTEGER + 1]) {
    const invalid = fixture();
    await assert.rejects(invalid.device.forward(pid, controller.signal), /非法PID/);
    assert.equal(invalid.calls.length, 0);
  }
  for (const port of ['0', '65536', '-1', '12 extra', '']) {
    const invalid = fixture({ exec: () => port });
    await assert.rejects(invalid.device.forward(12, controller.signal), /非法ADB转发端口/);
    assert.equal(invalid.calls.length, 1);
  }
  for (const cleanupFails of [false, true]) {
    const abort = new AbortController(), reason = new Error('分配时取消'), cleanup = new Error('端口清理失败');
    const cancelled = fixture({ exec: args => {
      if (args.includes('--remove')) { if (cleanupFails) { throw cleanup; } return ''; }
      abort.abort(reason); return '32123';
    } });
    await assert.rejects(cancelled.device.forward(12, abort.signal), error => cleanupFails
      ? error instanceof AggregateError && error.errors[0] === reason && error.errors[1].cause === cleanup
      : error === reason);
    assert.deepEqual(cancelled.calls.at(-1).args, ['-s', 'serial-1', 'forward', '--remove', 'tcp:32123']);
  }
});

// 功能：验证真实 FrameReader 与协议以及关闭顺序；输入分片回复及网络终结；输出长寿命租约或完整错误；验证：此测试入口。
test('resume完成握手、IDSizes与Resume，取消EOF及提前close均结算并聚合清理', async () => {
  const normal = fixture(), controller = new AbortController();
  const lease = await normal.device.resume(12, controller.signal);
  const socket = normal.sockets[0];
  assert.equal(socket.port, 32001); assert.equal(socket.host, '127.0.0.1');
  assert.equal(socket.destroyed, false);
  assert.equal(socket.writes[0].toString(), 'JDWP-Handshake');
  assert.deepEqual(socket.writes.slice(1).map(b => [b.readUInt32BE(0), b.readUInt32BE(4), b[8], b[9], b[10]]), [
    [11, 1, 0, 1, 7], [11, 2, 0, 1, 9],
  ]);
  await Promise.all([lease.close(), lease.close()]);
  assert.deepEqual(normal.lifecycle, ['socket-close', 'remove']);
  for (const name of ['data', 'error', 'end', 'close', 'connect']) { assert.equal(socket.listenerCount(name), 0, name); }
  for (const event of ['abort', 'end', 'close', 'error']) {
    const abort = new AbortController(), reason = new Error('读取取消'), network = new Error('网络失败');
    const f = fixture({ write() {} });
    const pending = f.device.resume(12, abort.signal);
    const rejected = assert.rejects(pending, error => event === 'abort' ? error === reason : event === 'error' ? error === network : /EOF|关闭/.test(error.message));
    const peer = await f.handshake.promise;
    if (event === 'abort') { abort.abort(reason); }
    else if (event === 'close') { peer.destroy(); }
    else { peer.emit(event, network); }
    await rejected;
    assert.deepEqual(f.lifecycle, ['socket-close', 'remove']);
  }
  const beforeConnect = new AbortController(), connectReason = new Error('连接前取消');
  const connecting = fixture({ connect() {} });
  const connectingResult = connecting.device.resume(12, beforeConnect.signal);
  const connectRejected = assert.rejects(connectingResult, error => error === connectReason);
  await connecting.connected.promise;
  beforeConnect.abort(connectReason);
  await connectRejected;
  const cleanup = new Error('JDWP转发清理失败'), activeAbort = new AbortController(), activeReason = new Error('租约取消');
  const active = fixture({ exec: args => { if (args.includes('--remove')) { throw cleanup; } return '32001'; } });
  const activeLease = await active.device.resume(12, activeAbort.signal);
  activeAbort.abort(activeReason);
  await active.removed.promise;
  await assert.rejects(activeLease.close(), error => error instanceof AggregateError && error.errors[0] === activeReason && error.errors[1].cause === cleanup);
  await assert.rejects(activeLease.close(), error => error instanceof AggregateError && error.errors[0] === activeReason);
  assert.equal(active.calls.filter(c => c.kind === 'exec' && c.args.includes('--remove')).length, 1);
  const badHandshake = fixture({ write: peer => peer.feed(Buffer.from('BADP-Handshake')) });
  await assert.rejects(badHandshake.device.resume(12, new AbortController().signal), /握手错误/);
  assert.deepEqual(badHandshake.lifecycle, ['socket-close', 'remove']);
  for (const fault of ['sizes', 'id', 'flags', 'code', 'length', 'resume']) {
    const f = fixture({ write: (peer, bytes) => {
      if (bytes.equals(Buffer.from('JDWP-Handshake'))) { peer.feed(bytes); return; }
      const id = bytes.readUInt32BE(4), body = id === 1 ? Buffer.alloc(20) : Buffer.alloc(0);
      if (id === 1) { [0, 4, 8, 12, 16].forEach(offset => body.writeUInt32BE(fault === 'sizes' ? 3 : 8, offset)); }
      let reply = packet(fault === 'id' ? 99 : id, fault === 'resume' && id === 2 ? Buffer.alloc(1) : body,
        fault === 'flags' ? 0 : 0x80, fault === 'code' ? 99 : 0);
      if (fault === 'length') { reply.writeUInt32BE(10, 0); }
      peer.feed(reply);
    } });
    await assert.rejects(f.device.resume(12, new AbortController().signal), /JDWP/);
    assert.deepEqual(f.lifecycle, ['socket-close', 'remove']);
  }
  let events = 0;
  const interleaved = fixture({ write: (peer, bytes) => {
    if (bytes.equals(Buffer.from('JDWP-Handshake'))) { peer.feed(bytes); return; }
    const id = bytes.readUInt32BE(4), body = id === 1 ? Buffer.alloc(20) : Buffer.alloc(0);
    if (id === 1) { [0, 4, 8, 12, 16].forEach(offset => body.writeUInt32BE(8, offset)); }
    const event = Buffer.alloc(5); event[0] = 0;
    peer.feed(packet(77, event, 0, 0x4064)); events++;
    peer.feed(packet(id, body));
  } });
  const interleavedLease = await interleaved.device.resume(12, new AbortController().signal);
  assert.equal(events, 2); await interleavedLease.close();
  const failingCleanup = fixture({ exec: args => { if (args.includes('--remove')) { throw cleanup; } return '32001'; },
    write: peer => peer.feed(Buffer.from('BADP-Handshake')) });
  await assert.rejects(failingCleanup.device.resume(12, new AbortController().signal), error =>
    error instanceof AggregateError && /握手/.test(error.errors[0].message) && error.errors[1].cause === cleanup);
});

// 功能：验证包段隔离及主次 ABI；输入多个包和全局字段；输出仅目标包 ABI；验证：此测试入口。
test('ABI只取目标Package段主次字段，不混入其他包或SDK回落', async () => {
  const signal = new AbortController().signal;
  const output = [
    'primaryCpuAbi=global-abi', 'Packages:',
    '  Package [com.other.before] (aaa):', '    primaryCpuAbi=x86', '    secondaryCpuAbi=x86_64',
    '  Package [com.example.app] (bbb):', '    primaryCpuAbi=arm64-v8a', '    secondaryCpuAbi=armeabi-v7a',
    '  Package [com.other.after] (ccc):', '    primaryCpuAbi=other-abi',
    'Hidden system packages:', '  Package [com.other.hidden] (ddd):', '    secondaryCpuAbi=hidden-abi',
  ].join('\n');
  const f = fixture({ shell: () => output });
  assert.deepEqual(await f.device.abis(pkg, signal), ['arm64-v8a', 'armeabi-v7a']);
  assert.deepEqual(f.calls.map(c => c.command), ['dumpsys package com.example.app']);
  assert.equal(f.calls[0].signal, signal);
  assert.deepEqual(await fixture({ shell: () => '  Package [com.example.app]:\n    primaryCpuAbi=null\n    secondaryCpuAbi=null\n' }).device.abis(pkg), []);
  assert.deepEqual(await fixture({ shell: () => '  Package [com.example.app]:\n    primaryCpuAbi=x86\n    secondaryCpuAbi=x86\n' }).device.abis(pkg), ['x86']);
  assert.deepEqual(await fixture({ shell: () => '  Package [com.example.app]:\n    primaryCpuAbi=arm64-v8a\nOther section:\n  secondaryCpuAbi=x86\n' }).device.abis(pkg), ['arm64-v8a']);
  for (const output of [
    'Package [com.example.application]:\n  primaryCpuAbi=x86',
    'Package [com.example.app]:\n  primaryCpuAbi=x86\nPackage [com.example.app]:\n  secondaryCpuAbi=x86',
    'Package [com.example.app]:\n  primaryCpuAbi=arm;id',
    'Package [com.example.app]:\n  primaryCpuAbi=x86\n  primaryCpuAbi=arm64-v8a',
  ]) { await assert.rejects(fixture({ shell: () => output }).device.abis(pkg)); }
  const injection = fixture();
  await assert.rejects(injection.device.abis(pkg + ';id'));
  assert.equal(injection.calls.length, 0);
  const controller = new AbortController(), reason = new Error('ABI取消');
  const cancelled = fixture({ shell: () => { controller.abort(reason); throw new Error('边界AbortError'); } });
  await assert.rejects(cancelled.device.abis(pkg, controller.signal), error => error === reason);
});
