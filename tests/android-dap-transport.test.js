const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { transformSync } = require('esbuild');
const source = fs.readFileSync(path.join(__dirname, '../src/android-debugger/dapTransport.ts'), 'utf8');

/** 输入可选 spawn 实现，在 esbuild/VM 环境输出生产类；各测试经相同构造契约断言，不增加生产测试 API。 */
function loadTransport(spawn) {
  const module = { exports: {} };
  // 输入模块名，输出真实 Node 模块或本地启动替身；launch 测试断言替身收到独立的命令和参数。
  function requireModule(id) {
    if (id === 'node:child_process' && spawn) return { spawn };
    return require(id);
  }
  vm.runInNewContext(transformSync(source, { loader: 'ts', format: 'cjs' }).code, {
    module, exports: module.exports, require: requireModule, Buffer, Error, Map, Number, JSON
  });
  return module.exports.DapTransport;
}

/** 无输入，输出带真实 Node 流的独占进程替身；所有用例断言帧、事件、kill 次数及监听释放。 */
function childFixture() {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.signalCode = null;
  child.killed = false;
  child.killCalls = 0;
  child.originalListeners = [child, child.stdin, child.stdout, child.stderr].map(emitter =>
    new Map(emitter.eventNames().map(name => [name, emitter.listeners(name)])));

  // 输入可选信号，输出成功并记录只针对该进程的终止；dispose/failures 用例断言单次调用。
  child.kill = function () { this.killCalls++; this.killed = true; this.signalCode = 'SIGTERM'; this.emit('close', null, 'SIGTERM'); return true; };
  return child;
}

/** 输入 DAP JSON 对象，输出按 UTF-8 字节计数的帧；framing/encoding 用例用独立字节断言校验解析结果。 */
function frame(message) {
  const body = Buffer.from(JSON.stringify(message));
  return Buffer.concat([Buffer.from('Content-Length: ' + body.length + '\r\n\r\n'), body]);
}

/** 输入已终止进程和传输，断言 transport 自有监听归零；用于 invalid/failures/dispose，无异步等待或轮询。 */
function assertReleased(child, transport) {
  const emitters = [child, child.stdin, child.stdout, child.stderr];
  for (let index = 0; index < emitters.length; index++) {
    const emitter = emitters[index];
    const current = new Map(emitter.eventNames().map(name => [name, emitter.listeners(name)]));
    assert.deepEqual(current, child.originalListeners[index]);
  }
  assert.equal(transport.eventNames().length, 0);
}

// framing：输入逐字节头/体及合并帧，前置为字节流；断言完整消息才发布、顺序和多字节内容原样保留。
test('framing handles split headers, split UTF8 bodies and coalesced messages', () => {
  const child = childFixture();
  const transport = new (loadTransport())(child);
  const messages = [];
  const events = [];
  transport.on('message', message => messages.push(message));
  transport.on('event', message => events.push(message));
  const first = { seq: 1, type: 'event', event: 'output', body: { output: '中文😀' } };
  const bytes = frame(first);
  for (const byte of bytes.subarray(0, -1)) {
    child.stdout.write(Buffer.from([byte]));
    assert.equal(messages.length, 0);
  }
  child.stdout.write(bytes.subarray(-1));
  const second = { seq: 2, type: 'event', event: 'initialized' };
  const third = { seq: 3, type: 'event', event: 'stopped', body: { threadId: 23 } };
  child.stdout.write(Buffer.concat([frame(second), frame(third)]));
  assert.deepEqual(messages, [first, second, third]);
  assert.deepEqual(events, messages);
  transport.dispose();
  assertReleased(child, transport);
});

// encoding/responses：输入两个并发请求和逆序响应；断言 stdin 字节长度及参数、响应身份、后端失败信息。
test('encoding and responses preserve UTF8 bytes and correlate concurrent requests', async () => {
  const child = childFixture();
  const transport = new (loadTransport())(child);
  const first = transport.request('evaluate', { expression: '中文😀' });
  const second = transport.request('threads');
  // 输入失败 Error，断言仍携带原始 request_seq 和后端结构化错误体。
  const failed = assert.rejects(second, error => {
    assert.match(error.message, /backend refused/);
    assert.equal(error.response.request_seq, 2);
    assert.deepEqual(error.response.body, { error: { id: 42, format: 'backend refused' } });
    return true;
  });
  const encoded = child.stdin.read();
  const separator = encoded.indexOf('\r\n\r\n');
  const length = Number(encoded.subarray(0, separator).toString().split(':')[1]);
  const request = JSON.parse(encoded.subarray(separator + 4, separator + 4 + length).toString());
  assert.deepEqual(request, { seq: 1, type: 'request', command: 'evaluate', arguments: { expression: '中文😀' } });
  assert.equal(length, Buffer.byteLength(JSON.stringify(request)));
  assert.ok(length > JSON.stringify(request).length);
  const response = { seq: 7, type: 'response', request_seq: 1, command: 'evaluate', success: true, body: { result: '真实后端结果' } };
  child.stdout.write(Buffer.concat([
    frame({ seq: 6, type: 'response', request_seq: 2, command: 'threads', success: false, message: 'backend refused', body: { error: { id: 42, format: 'backend refused' } } }),
    frame(response)
  ]));
  assert.deepEqual(await first, response);
  await failed;
  transport.dispose();
  assertReleased(child, transport);
});

// reverse/stderr：输入诊断字节和后端反向请求；断言 stderr 不进入消息解析，send 输出真实反向响应且无虚构事件。
test('reverse requests and stderr diagnostics remain separate', () => {
  const child = childFixture();
  const transport = new (loadTransport())(child);
  const diagnostics = [];
  const messages = [];
  const requests = [];
  transport.on('diagnostic', chunk => diagnostics.push(chunk));
  transport.on('message', message => messages.push(message));
  transport.on('request', message => requests.push(message));
  child.stderr.write(Buffer.from('not DAP: 后端日志'));
  assert.equal(messages.length, 0);
  assert.equal(Buffer.concat(diagnostics).toString(), 'not DAP: 后端日志');
  const request = { seq: 45, type: 'request', command: 'runInTerminal', arguments: { args: ['backend'] } };
  child.stdout.write(frame(request));
  assert.deepEqual(requests, [request]);
  assert.deepEqual(messages, [request]);
  const response = { seq: 9, type: 'response', request_seq: 45, command: 'runInTerminal', success: true };
  transport.send(response);
  assert.deepEqual(child.stdin.read(), frame(response));
  transport.dispose();
  assertReleased(child, transport);
});

// invalid：输入缺失、重复、负数、非整数、溢出长度或非法 JSON；每种情况都断言等待请求拒绝、关闭一次并释放监听。
for (const malformed of [
  'Content-Length: nope\r\n\r\n', 'Content-Length: -1\r\n\r\n', 'Content-Length: 1.5\r\n\r\n',
  'Content-Length: 0\r\n\r\n', 'Content-Length: 9007199254740992\r\n\r\n',
  'Other: 1\r\n\r\n', 'Content-Length: 2\r\nContent-Length: 2\r\n\r\n{}',
  'Content-Length: 1\r\n\r\n{', 'Content-Length: 4\r\n\r\nnull'
]) {
  test('invalid framing rejects pending calls: ' + JSON.stringify(malformed), async () => {
    const child = childFixture();
    const transport = new (loadTransport())(child);
    const closed = [];
    transport.on('close', error => closed.push(error));
    const pending = assert.rejects(transport.request('threads'), /Invalid DAP/);
    child.stdout.write(Buffer.from(malformed));
    await pending;
    assert.equal(closed.length, 1);
    assert.equal(child.killCalls, 1);
    assertReleased(child, transport);
    await assert.rejects(transport.request('threads'), /Invalid DAP/);
  });
}

// failures：前置为两个等待请求，输入进程 error/close 或任一管道 error；断言所有 Promise 失败、退出原因和无监听残留。
for (const origin of ['process', 'close', 'stdin', 'stdout', 'stderr']) {
  test('failures reject every pending request on ' + origin, async () => {
    const child = childFixture();
    const transport = new (loadTransport())(child);
    const error = new Error('backend broken');
    const expected = origin === 'close' ? /code 17, signal null/ : /backend broken/;
    const first = assert.rejects(transport.request('threads'), expected);
    const second = assert.rejects(transport.request('stackTrace'), expected);
    if (origin === 'close') { child.exitCode = 17; child.emit('close', 17, null); }
    else (origin === 'process' ? child : child[origin]).emit('error', error);
    await first;
    await second;
    assert.equal(child.killCalls, origin === 'close' ? 0 : 1);
    assertReleased(child, transport);
    await assert.rejects(transport.request('continue'), expected);
  });
}

// dispose：输入两个独立进程和外部监听，重复 dispose；断言仅自有进程 kill 一次、请求拒绝、外部监听保留且另一会话继续传输。
test('dispose only closes its owned backend and preserves unrelated listeners', async () => {
  const first = childFixture();
  const second = childFixture();
  const DapTransport = loadTransport();
  const external = () => {};
  first.on('close', external);
  first.stdout.on('data', external);
  const transport = new DapTransport(first);
  const other = new DapTransport(second);
  const pending = assert.rejects(transport.request('threads'), /disposed/);
  transport.dispose();
  transport.dispose();
  await pending;
  assert.equal(first.killCalls, 1);
  assert.equal(second.killCalls, 0);
  assert.deepEqual(first.listeners('close'), [external]);
  assert.deepEqual(first.stdout.listeners('data'), [external]);
  first.off('close', external);
  first.stdout.off('data', external);
  assertReleased(first, transport);
  const response = other.request('threads');
  second.stdout.write(frame({ seq: 1, type: 'response', request_seq: 1, command: 'threads', success: true, body: { threads: [] } }));
  assert.equal((await response).success, true);
  assert.throws(() => transport.send({ seq: 1, type: 'event', event: 'output' }), /disposed/);
  other.dispose();
  assertReleased(second, other);
});

// launch：输入含空格/命令符号的可执行路径、参数和环境；断言 spawn 原样收到各字段且强制禁用 shell。
test('launch uses structured executable arguments without a shell', () => {
  const child = childFixture();
  const calls = [];
  // 输入启动字段，输出独占管道进程；下方严格断言字段保持原样，无命令字符串拼接。
  function spawn(command, args, options) { calls.push({ command, args, options }); return child; }
  const DapTransport = loadTransport(spawn);
  const args = ['--stdio', 'a b', '& do not execute'];
  const env = { JAVA_HOME: 'C:\\Java Home' };
  const transport = DapTransport.launch('C:\\Debug Backend\\backend.exe', args, { cwd: 'C:\\workspace', env });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, 'C:\\Debug Backend\\backend.exe');
  assert.equal(calls[0].args, args);
  assert.equal(calls[0].options.env, env);
  assert.equal(calls[0].options.cwd, 'C:\\workspace');
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[0].options.stdio, 'pipe');
  transport.dispose();
  assertReleased(child, transport);
});

// write-failures：前置已有等待请求，输入同步 write 抛错或异步完成错误；断言两个请求均拒绝且单次终止，无监听泄漏。
for (const mode of ['throw', 'callback']) {
  test('write-failures reject all pending calls on ' + mode, async () => {
    const child = childFixture();
    const transport = new (loadTransport())(child);
    const first = assert.rejects(transport.request('threads'), /write failed/);
    // 输入编码帧和完成回调，输出写入失败；只替换依赖行为，不扩展生产契约。
    child.stdin.write = function (bytes, callback) {
      assert.ok(Buffer.isBuffer(bytes));
      if (mode === 'throw') throw new Error('write failed');
      callback(new Error('write failed'));
      return false;
    };
    const second = assert.rejects(transport.request('continue'), /write failed/);
    await first;
    await second;
    await transport.dispose();
    assert.equal(child.killCalls, 1);
    assertReleased(child, transport);
  });
}

// serialization：输入循环引用参数，断言该请求失败且未输出残帧，随后合法请求仍能正常匹配后端响应。
test('serialization failure rejects only the unsent request', async () => {
  const child = childFixture();
  const transport = new (loadTransport())(child);
  const arguments_ = {};
  arguments_.self = arguments_;
  await assert.rejects(transport.request('evaluate', arguments_), /circular/i);
  assert.equal(child.stdin.read(), null);
  const valid = transport.request('threads');
  child.stdout.write(frame({ seq: 1, type: 'response', request_seq: 2, command: 'threads', success: true }));
  assert.equal((await valid).success, true);
  await transport.dispose();
  assertReleased(child, transport);
});

// dispose-await：输入尚未 close 的独占进程，前置 kill 仅记录；断言 Promise 未提前完成，close 后才清理监听。
test('dispose waits for actual close and handles errors while closing', async () => {
  const child = childFixture();
  // 输入终止请求，只记录 kill，不伪造关闭；下方手动 close 验证真实生命周期。
  child.kill = function () { this.killCalls++; this.killed = true; return true; };
  const transport = new (loadTransport())(child);
  let resolved = false;
  const disposed = transport.dispose();
  // 输入清理完成通知，记录 Promise 状态；微任务后未 close 时必须为 false。
  const observed = disposed.then(() => { resolved = true; });
  await Promise.resolve();
  assert.equal(resolved, false);
  assert.equal(child.listenerCount('close'), 1);
  child.stdin.emit('error', new Error('write interrupted during shutdown'));
  assert.equal(child.killCalls, 1);
  child.emit('close', null, 'SIGTERM');
  await observed;
  assert.equal(resolved, true);
  assertReleased(child, transport);
  assert.equal(transport.dispose(), disposed);
});

// real-child：真实 Node 子进程保持 stdin，等待 spawn 后 dispose；断言实际 close、退出状态和自有监听归零。
test('real-child disposal waits for owned process close', { timeout: 5000 }, async () => {
  const { spawn } = require('node:child_process');
  const { once } = require('node:events');
  const child = spawn(process.execPath, ['-e', 'process.stdin.resume()'], { shell: false, stdio: 'pipe' });
  const transport = new (loadTransport())(child);
  let closed = false;
  // 输入真实 close，记录 OS 子进程已终止；dispose 完成后必须观察到此事件。
  child.once('close', () => { closed = true; });
  try {
    await once(child, 'spawn');
    await transport.dispose();
    assert.equal(closed, true);
    assert.ok(child.exitCode !== null || child.signalCode !== null);
    assert.equal(child.listenerCount('error'), 0);
    assert.equal(child.listenerCount('close'), 0);
    assert.equal(child.stdout.listenerCount('data'), 0);
    assert.equal(child.stderr.listenerCount('data'), 0);
    assert.equal(transport.eventNames().length, 0);
  } finally {
    await transport.dispose();
  }
});

