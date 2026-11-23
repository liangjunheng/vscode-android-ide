'use strict';
/**
 * 功能点：task137，真实 JVM Attach 在完整 JDWP 握手后分别遇到 RST、EOF 和错误握手字节时立即失败，仅拒绝连接继续等待。
 * 受影响对象：VmConnector.attach 的握手失败诊断、SessionConfig、KotlinDebugServer、bundled JAR 与自有本地进程/socket。
 * 前置条件：Node>=22、本地 JDK17+/JDI（自动发现或 JAVA_HOME/JVM_DEBUGGER_JAVA_HOME）及已经存在的主构建 JAR；本文件不构建 JAR。
 * 复现路径：initialize 成功后只发送一次 attach；本地 fake TCP 对端收到完整14字节握手后分别 resetAndDestroy、主动 EOF 或回写14字节错误内容；另保留先拒绝再同端口启动 JDWP 的对照路径。
 * 测试范围：真实 stdio DAP 分片/多帧、握手后 RST/EOF/错误字节、握手异常的原始 JDI 类与 message、通用 RST 原因、host/port、EOF刷新后的cause日志栈、无 debugger 猜测、无重试、拒绝连接等待及 EOF 退出清理。
 * 执行入口：默认 npm test；定向 node --test tests/jvm-connection-reset.test.js；本文件不构建 JAR、不执行 ADB，缺 JDK/JAR 明确失败而非 skip。
 * 成功判据：握手异常响应包含原 JDI 具体原因和 host/port，不含另一个 debugger 归因，fake 对端仅收到一次连接且无等待重试输出，日志包含原异常完整 stack，JAR 通过 EOF 正常退出；拒绝对照仍单次 Attach 成功。
 * 失败判据：异常原因丢失或被改写为猜测、发生第二次连接/重试、日志没有原异常 stack、资源未正常关闭，或既有 RST/拒绝回归失败。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { findJavaHome } = require('../scripts/build-jvm-debugger.cjs');
const ROOT = path.resolve(__dirname, '..');
const JAR = path.join(ROOT, 'resources/jvm-debugger/kotlin-debug-adapter.jar');
const SESSION = path.join(ROOT, 'src/android-debugger/jvm-debugger/upstream/adapter/src/main/kotlin/dev/ktdebug/session');
const DIAGNOSTIC_MS = 10000;

/** 功能：创建隔离目录和事件驱动夹具；输入本地 JDK；输出真实 DAP、进程和网络资源操作，供下方两入口使用。 */
function harness(java) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jvm-reset-'));
  const bus = new EventEmitter(), messages = [], requests = [], owners = [], sockets = new Set();
  let firstError, firstResponseError, buffer = Buffer.alloc(0), connections = 0, handshakes = 0;
  let handshakeAction = 'reset';
  /** 功能：保存异步首错并唤醒等待；输入原始异常；输出稳定诊断，不以清理异常覆盖。 */
  function fail(error) { firstError ||= error; bus.emit('pulse'); }
  /** 功能：按事件检查条件；输入判据及诊断说明；输出结果或首错，清理阶段单独等待资源关闭。 */
  function wait(predicate, label, cleaning = false) {
    return new Promise((resolve, reject) => {
      /** 功能：结束当前等待并移除监听及诊断计时器；输入结果/异常；输出唯一完成状态。 */
      function finish(error, value) { clearTimeout(timer); bus.off('pulse', check); error ? reject(error) : resolve(value); }
      /** 功能：评估当前事件状态；输出满足的结果或保留的首错。 */
      function check() {
        try { if (!cleaning && firstError) throw firstError; const value = predicate(); if (value) finish(null, value); }
        catch (error) { finish(error); }
      }
      const timer = setTimeout(() => finish(new Error(`${label}：诊断等待结束；首个失败响应=${JSON.stringify(firstResponseError)}；stderr=${owners.map(o => o.stderr).join('\n')}`)), DIAGNOSTIC_MS);
      bus.on('pulse', check); check();
    });
  }
  /** 功能：解析 stdout 的 Content-Length 字节帧；输入任意分片/合帧；输出消息及首个响应错误，非法协议立即失败。 */
  function receive(bytes) {
    buffer = Buffer.concat([buffer, bytes]);
    for (;;) {
      const split = buffer.indexOf('\r\n\r\n'); if (split < 0) return;
      const match = /^Content-Length:\s*(\d+)\s*$/mi.exec(buffer.subarray(0, split).toString('ascii'));
      assert.ok(match, 'DAP 必须包含 Content-Length');
      const length = Number(match[1]); assert.ok(Number.isSafeInteger(length) && length > 0, 'DAP 长度必须有效');
      if (buffer.length < split + 4 + length) return;
      const message = JSON.parse(buffer.subarray(split + 4, split + 4 + length).toString('utf8'));
      buffer = buffer.subarray(split + 4 + length);
      if (message.type === 'response') {
        if (message.success === false) firstResponseError ||= message;
        const request = requests.find(r => r.seq === message.request_seq);
        assert.ok(request, '响应必须引用已发送请求');
        assert.equal(typeof message.success, 'boolean', '响应必须声明 success');
        assert.equal(message.command, request.command, '响应命令必须匹配');
        assert.ok(!messages.some(m => m.type === 'response' && m.request_seq === message.request_seq), '不得重复响应');
      }
      messages.push(message);
    }
  }
  /** 功能：启动自有 JVM；输入参数及是否 DAP；输出被登记的句柄，事件异常交给首错处理。 */
  function start(args, dap = false) {
    const child = spawn(java, args, { cwd: directory, windowsHide: true, shell: false, stdio: 'pipe' });
    const owner = { child, closed: false, code: null, signal: null, stdout: '', stderr: '' }; owners.push(owner);
    child.on('error', fail); child.stdin.on('error', fail);
    child.stdout.on('error', fail); child.stderr.on('error', fail);
    child.stdout.on('data', bytes => {
      try { if (dap) receive(bytes); else owner.stdout += bytes.toString('utf8'); } catch (error) { fail(error); }
      bus.emit('pulse');
    });
    child.stderr.on('data', bytes => { owner.stderr += bytes.toString('utf8'); bus.emit('pulse'); });
    child.on('close', (code, signal) => {
      Object.assign(owner, { closed: true, code, signal });
      if (dap && buffer.length) fail(new Error('JAR EOF 存在未完成的 DAP 帧'));
      bus.emit('pulse');
    });
    return owner;
  }
  const server = net.createServer(socket => {
    connections++; sockets.add(socket); let greeting = Buffer.alloc(0);
    socket.on('error', fail);
    socket.on('close', () => { sockets.delete(socket); bus.emit('pulse'); });
    socket.on('data', bytes => {
      try {
        greeting = Buffer.concat([greeting, bytes]);
        if (greeting.length < 14) return;
        assert.equal(greeting.toString('ascii'), 'JDWP-Handshake', '必须收到完整真实握手再 RST');
        handshakes++;
        if (handshakeAction === 'eof') socket.end();
        else if (handshakeAction === 'wrong') socket.end(Buffer.from('NOT-JDWP-ERROR'));
        else socket.resetAndDestroy();
        bus.emit('pulse');
      } catch (error) { fail(error); socket.destroy(); }
    });
  });
  server.on('error', fail);
  server.on('listening', () => bus.emit('pulse'));
  /** 功能：监听独占回环端口；输出动态端口，错误由事件等待报告。 */
  async function listen() {
    server.listen(0, '127.0.0.1'); await wait(() => server.listening, '本地服务监听'); return server.address().port;
  }
  /** 功能：关闭本夹具监听服务；输出关闭 Promise，供拒绝场景和 finally 共用。 */
  function closeServer() {
    return new Promise((resolve, reject) => {
      if (!server.listening) return resolve();
      server.close(error => error ? reject(error) : resolve());
    });
  }
  /** 功能：发送唯一编号的 DAP 请求；输入后端、命令及参数；输出序号，Attach 不自动重发。 */
  function send(owner, command, args) {
    assert.ok(!owner.closed, '发送前 JAR 必须存活');
    const request = { seq: requests.length + 1, type: 'request', command, arguments: args }; requests.push(request);
    const body = Buffer.from(JSON.stringify(request));
    owner.child.stdin.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body])); return request.seq;
  }
  /** 功能：等指定请求响应；输入后端及序号；输出真实响应，提前退出立即失败。 */
  function response(owner, seq) {
    return wait(() => {
      const message = messages.find(m => m.type === 'response' && m.request_seq === seq);
      if (message) return message;
      assert.ok(!owner.closed, `JAR 在响应前退出：${owner.stderr}`); return false;
    }, `DAP 请求 ${seq}`);
  }
  /** 功能：以 EOF 停止指定自有进程；输出正常退出断言，仅异常清理时 kill 此句柄并仍报告失败。 */
  async function stop(owner) {
    if (!owner.closed) owner.child.stdin.end();
    try { await wait(() => owner.closed, '自有 JVM EOF 退出', true); }
    catch (error) {
      owner.child.kill(); await wait(() => owner.closed, '自有句柄 kill 后退出', true); throw error;
    }
    assert.equal(owner.signal, null, '自有 JVM 应通过 EOF 正常退出');
    assert.equal(owner.code, 0, `自有 JVM 非正常退出：${owner.stderr}`);
  }
  /** 功能：finally 中收敛全部自有资源；输出清理错误集合，不使用进程名/外部 kill 或遗留临时源码。 */
  async function dispose() {
    for (const socket of sockets) socket.destroy();
    const outcomes = await Promise.allSettled([...owners.map(stop), closeServer(), wait(() => sockets.size === 0, '自有 socket 全部关闭', true)]);
    try { fs.rmSync(directory, { recursive: true, force: true }); }
    catch (error) { outcomes.push({ status: 'rejected', reason: error }); }
    const errors = outcomes.filter(o => o.status === 'rejected').map(o => o.reason);
    if (firstError) errors.unshift(firstError);
    if (errors.length) throw new AggregateError(errors, '夹具清理或异步首错');
    assert.equal(sockets.size, 0); assert.equal(server.listening, false);
  }
  /** 功能：选择完整握手后的 fake 对端行为；输入 reset、eof 或 wrong；输出后续 Attach 的单一网络结果。 */
  function setHandshakeAction(action) { assert.ok(['reset', 'eof', 'wrong'].includes(action)); handshakeAction = action; }
  return { directory, messages, requests, listen, closeServer, start, send, response, wait, setHandshakeAction, socketCount: () => sockets.size, dispose,
    counts: () => ({ connections, handshakes }) };
}

/** 功能：运行握手失败 Attach；输入 EOF 或错误14字节模式；输出原JDI诊断、cause日志、单连接及EOF清理断言。 */
async function handshakeScenario(t, action) {
  const runtime = findJavaHome();
  assert.ok(runtime, '需要本地 JDK17+/JDI；请设置 JAVA_HOME 或 JVM_DEBUGGER_JAVA_HOME，不能跳过回归');
  assert.ok(fs.existsSync(JAR), '需要主构建更新后的 bundled kotlin-debug-adapter.jar');
  const h = harness(runtime.java); let failure;
  try {
    h.setHandshakeAction(action);
    const port = await h.listen();
    const logFile = path.join(h.directory, `${action}.log`);
    const jar = h.start(['-jar', JAR, '--log-file', logFile, '--log-level', 'DEBUG'], true);
    const init = h.send(jar, 'initialize', { adapterID: 'kotlin-jvm', clientID: `task137-${action}`, linesStartAt1: true, columnsStartAt1: true, pathFormat: 'path' });
    assert.equal((await h.response(jar, init)).success, true);
    const attach = h.send(jar, 'attach', { hostName: '127.0.0.1', port, projectRoot: h.directory, sourcePaths: [h.directory] });
    const failed = await h.response(jar, attach);
    assert.equal(failed.success, false, JSON.stringify(failed));
    assert.match(failed.message, new RegExp(`JDWP handshake failed at 127\\.0\\.0\\.1:${port} \\(java\\.[^:]+:[^)]*\\)`));
    assert.doesNotMatch(failed.message, /another debugger|already attached/i);
    await h.wait(() => h.counts().handshakes === 1 && h.counts().connections === 1, '握手失败网络计数');
    await h.wait(() => h.socketCount() === 0, 'fake 对端正常 EOF 关闭');
    assert.equal(h.requests.filter(r => r.command === 'attach').length, 1, '握手失败不得重发 Attach');
    jar.child.stdin.end(); await h.wait(() => jar.closed, 'JAR EOF 退出并刷新文件日志');
    assert.equal(jar.code, 0); assert.equal(jar.signal, null);
    const log = fs.readFileSync(logFile, 'utf8');
    assert.match(log, /JDWP handshake failed at 127\.0\.0\.1:/);
    assert.match(log, /\n(?:java\.|javax\.)[^\n]+Exception[^\n]*\n\s+at /, '日志必须保留原异常完整 stack');
    assert.doesNotMatch(log, /another debugger|already attached/i);
  } catch (error) { failure = error; }
  finally {
    try { await h.dispose(); }
    catch (error) { if (!failure) failure = error; else t.diagnostic(`W：保留首错；清理异常：${error.stack}; ${error.errors?.map(e => e.stack).join('\n')}`); }
  }
  if (failure) throw failure;
}

/** 功能：运行单次 Attach 对照；输入测试上下文和 RST/拒绝模式；输出协议及资源断言，所有资源严格 finally 结束。 */
async function scenario(t, reset) {
  const runtime = findJavaHome();
  assert.ok(runtime, '需要本地 JDK17+/JDI；请设置 JAVA_HOME 或 JVM_DEBUGGER_JAVA_HOME，不能跳过回归');
  assert.ok(fs.existsSync(JAR), '需要主构建更新后的 bundled kotlin-debug-adapter.jar');
  const h = harness(runtime.java); let failure;
  try {
    const port = await h.listen(); if (!reset) await h.closeServer();
    const jar = h.start(['-jar', JAR], true);
    const init = h.send(jar, 'initialize', { adapterID: 'kotlin-jvm', clientID: 'task137', linesStartAt1: true, columnsStartAt1: true, pathFormat: 'path' });
    const initialized = await h.response(jar, init); assert.equal(initialized.success, true, JSON.stringify(initialized));
    const attach = h.send(jar, 'attach', { hostName: '127.0.0.1', port, projectRoot: h.directory, sourcePaths: [h.directory] });
    if (reset) {
      const failed = await h.response(jar, attach);
      assert.equal(failed.success, false, JSON.stringify(failed));
      assert.match(failed.message, new RegExp(`Could not attach to JVM at 127\\.0\\.0\\.1:${port} \\(Connection reset\\)`));
      assert.doesNotMatch(failed.message, /another debugger|already attached/i);
      assert.ok(!h.messages.some(m => m.event === 'initialized'), 'RST 不得发布 initialized');
      assert.ok(!h.messages.some(m => /Waiting for JVM debug port/.test(m.body?.output || '')), 'RST 不得进入重试等待');
    } else {
      await h.wait(() => {
        assert.ok(!jar.closed, '等待拒绝连接输出前 JAR 不得退出');
        assert.ok(!h.messages.some(m => m.type === 'response' && m.request_seq === attach), '拒绝连接时 Attach 应保持 pending');
        return h.messages.find(m => m.event === 'output' && /Waiting for JVM debug port.*Connection refused/i.test(m.body?.output || ''));
      }, '拒绝连接等待输出');
      assert.ok(!h.messages.some(m => m.event === 'initialized'), '端口未监听不得初始化成功');
      // 静态默认值与无限循环检查补足短时实测的边界，不以诊断计时器代替产品设置。
      assert.match(fs.readFileSync(path.join(SESSION, 'SessionConfig.kt'), 'utf8'), /timeoutMs = a\.num\("timeout"\)\?\.toInt\(\),/);
      const connector = fs.readFileSync(path.join(SESSION, 'VmConnector.kt'), 'utf8');
      assert.match(connector, /^\s*val deadline = timeoutMs\?\.takeIf \{ it > 0 \}\?\.let \{ System\.currentTimeMillis\(\) \+ it \}\s*$/m);
      assert.match(connector, /while \(deadline == null \|\| System\.currentTimeMillis\(\) < deadline\)/);
      const source = path.join(h.directory, 'ResetWaitFixture.java');
      fs.writeFileSync(source, 'class ResetWaitFixture { public static void main(String[] args) throws Exception { System.in.read(); } }\n');
      const fixture = h.start([`-agentlib:jdwp=transport=dt_socket,server=y,suspend=n,address=127.0.0.1:${port}`, source]);
      await h.wait(() => {
        assert.ok(!fixture.closed, `JDWP 夹具提前退出：${fixture.stderr}`);
        return /Listening for transport dt_socket at address:/.test(fixture.stdout + fixture.stderr);
      }, '同端口 JDWP 监听');
      const attached = await h.response(jar, attach); assert.equal(attached.success, true, JSON.stringify(attached));
      await h.wait(() => {
        assert.ok(!jar.closed, '成功后 JAR 不得提前退出'); return h.messages.some(m => m.event === 'initialized');
      }, '成功 initialized');
      assert.equal(h.counts().connections, 0, '真实 JDWP 不能误连 RST 服务');
    }
    assert.equal(h.requests.filter(r => r.command === 'attach').length, 1, '每场景只发送一次 Attach');
    assert.ok(!Object.hasOwn(h.requests.find(r => r.command === 'attach').arguments, 'timeout'));
    // 正常路径先以 EOF 结束后端，再结束 fixture，避免夹具退出抢先断开已建立的 JDI 会话。
    jar.child.stdin.end(); await h.wait(() => jar.closed, 'JAR EOF 退出');
    assert.equal(jar.code, 0); assert.equal(jar.signal, null);
    if (reset) {
      assert.deepEqual(h.counts(), { connections: 1, handshakes: 1 });
      assert.ok(!h.messages.some(m => m.event === 'initialized'), '包括退出阶段也不得 initialized');
    }
  } catch (error) { failure = error; }
  finally {
    try { await h.dispose(); }
    catch (error) { if (!failure) failure = error; else t.diagnostic(`W：保留首错；清理异常：${error.stack}; ${error.errors?.map(e => e.stack).join('\n')}`); }
  }
  if (failure) throw failure;
}

/** 功能：npm test 的握手失败回归入口；输入完整握手后的 EOF；输出原JDI原因、日志stack、无重试及EOF清理判据。 */
test('JVM JDWP 握手后 EOF 保留原始原因且不重试', t => handshakeScenario(t, 'eof'));
/** 功能：npm test 的错误握手回归入口；输入完整握手后的错误14字节；输出具体诊断、无猜测归因及单连接判据。 */
test('JVM JDWP 错误握手字节保留原始原因且不重试', t => handshakeScenario(t, 'wrong'));
/** 功能：npm test 的 RST 回归入口；输入真实 JDK/JAR及完整握手后的本地 RST；输出单次失败、原错及 EOF 清理判据。 */
test('JVM 单次 Attach 遇握手后 RST 立即失败且不重连', t => scenario(t, true));
/** 功能：npm test 的拒绝连接对照入口；输入未监听端口及随后同端口 JDWP；输出同次 Attach 成功、无默认期限静态边界及资源清理判据。 */
test('JVM 拒绝连接保持等待，同端口 JDWP 就绪后单次 Attach 成功', t => scenario(t, false));
