const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { spawn, execFileSync } = require('node:child_process');
const { buildSync, transformSync } = require('esbuild');

const root = path.resolve(__dirname, '..');
const artifacts = path.join(root, 'artifacts/android-debugger');
const fixture = path.join(root, 'tests/fixtures/android-debugger/kotlin');
const source = path.join(fixture, 'app/src/main/java/dev/androidtools/kotlindebugfixture/DebugActivity.kt');
const packageName = 'dev.androidtools.kotlindebugfixture';
const serial = process.env.ANDROID_KOTLIN_DEBUG_TEST_SERIAL;

/** 并发等待 Attach 最终响应与 initialized 后的断点配置，避免后端等待 configurationDone 时死锁。
 * 输入真实请求/事件入口、Attach 参数及断点配置回调，输出 Attach body；任一失败原样传播。
 * 回归：node --test tests/android-kotlin-device.test.js 的 configuration-gated 用例以未完成 Attach 验证配置先执行及失败传播；真机用例复用同一入口。
 */
async function configureAttachedSession(request, event, args, configure) {
  const [attached] = await Promise.all([
    request('attach', args),
    (async () => {
      await event('initialized');
      await configure();
      await request('configurationDone', {});
    })(),
  ]);
  return attached;
}

/** 使用受控 DAP 边界证明配置解除 Attach 等待，拒绝退化为顺序等待；不连接设备或合成真机验收。 */
test('configuration-gated attach configures before awaiting final response and preserves failures', async () => {
  const calls = [];
  let finishAttach;
  const attach = new Promise(resolve => { finishAttach = resolve; });
  const body = { attached: true };
  const request = async command => {
    calls.push(command);
    if (command === 'attach') return attach;
    assert.equal(command, 'configurationDone');
    finishAttach(body);
  };
  const event = async name => { assert.equal(name, 'initialized'); calls.push(name); };
  const result = await configureAttachedSession(request, event, { processId: 123 }, async () => { calls.push('breakpoints'); });
  assert.equal(result, body);
  assert.deepEqual(calls, ['attach', 'initialized', 'breakpoints', 'configurationDone']);
  const denied = new Error('attach denied');
  await assert.rejects(configureAttachedSession(async command => { if (command === 'attach') throw denied; }, async () => {}, {}, async () => {}), error => error === denied);
  const invalid = new Error('breakpoint configuration failed');
  await assert.rejects(configureAttachedSession(async () => {}, async () => {}, {}, async () => { throw invalid; }), error => error === invalid);
});

/** 输入已授权串号与 SDK 环境，输出真实设备回归；默认跳过，不推断设备授权。
 * 映射：debugMain attach/configurationDone/breakpoint/threads/stack/scopes/variables/step/disconnect，
 * DapTransport framing/dispose，Debugger 自有 forward 生命周期；fixture KOTLIN_BREAKPOINT/KOTLIN_STEP_TARGET。
 * 复现：ANDROID_KOTLIN_DEBUG_TEST_SERIAL=<授权串号> ANDROID_SDK_ROOT=<SDK> node --test tests/android-kotlin-device.test.js。
 * 成功证据：真实 breakpoint/value=41、next/value=42、helper 进出、detach 同 PID、自有转发释放。
 * 前置：Node>=22，现有 esbuild 依赖，已签名 debuggable fixture APK 与在线授权设备；失败保留完整证据。
 */
test('authorized Android Kotlin DAP device regression', {
  skip: !serial && 'ANDROID_KOTLIN_DEBUG_TEST_SERIAL is required; no device action is authorized by default',
  timeout: 60000
}, async t => {
  fs.mkdirSync(artifacts, { recursive: true });
  const run = fs.mkdtempSync(path.join(artifacts, 'kotlin-device-'));
  const transcript = path.join(run, 'dap.jsonl');
  const sdk = process.env.ANDROID_SDK_ROOT || process.env.ANDROID_HOME;
  assert.ok(sdk, 'Explicit ANDROID_SDK_ROOT or ANDROID_HOME is required');
  const adb = process.env.ADB || path.join(sdk, 'platform-tools', process.platform === 'win32' ? 'adb.exe' : 'adb');
  const apk = path.join(artifacts, 'kotlin-device-fixture.apk');
  const lines = fs.readFileSync(source, 'utf8').split(/\r?\n/);
  const marker = lines.findIndex(line => line.includes('KOTLIN_BREAKPOINT'));
  const breakpointLine = marker + 2;
  const helperLine = lines.findIndex(line => line.includes('KOTLIN_STEP_TARGET')) + 1;
  assert.ok(marker >= 0 && helperLine > 0, 'fixture markers missing');
  assert.equal(lines[breakpointLine - 1].trim(), 'value++');
  assert.ok(fs.existsSync(apk), 'Signed Kotlin fixture APK missing; build the isolated fixture into artifacts/android-debugger/kotlin-device-fixture.apk');
  let transport;
  let deviceTouched = false;
  let pid;
  let baseline;
  let ownedForwards = [];
  const resources = { serial, cleanupErrors: [] };

  /** 输入方向与 JSON 证据，立即追加 transcript；所有失败、命令和真实 DAP 消息均可追溯。 */
  function record(direction, data) {
    fs.appendFileSync(transcript, JSON.stringify({ at: new Date().toISOString(), direction, data }) + '\n');
  }

  /** 输入 argv，输出有界真实 adb 结果；可检查失败码但绝不将其当作成功。 */
  function adbResult(args) {
    try {
      const stdout = execFileSync(adb, ['-s', serial, ...args], { encoding: 'utf8', timeout: 15000, windowsHide: true });
      const result = { status: 0, stdout };
      record('adb', { args, ...result });
      return result;
    } catch (error) {
      const result = { status: error.status, stdout: String(error.stdout || ''), stderr: String(error.stderr || ''), message: error.message };
      record('adb-error', { args, ...result });
      return result;
    }
  }

  /** 输入 adb argv，输出成功文本；非零退出包含完整设备证据并立即失败。 */
  function adbText(args) {
    const result = adbResult(args);
    assert.equal(result.status, 0, JSON.stringify(result));
    return result.stdout.trim();
  }

  /** 无输入，输出精确转发行集合；仅查询，不删除其他会话的转发。 */
  function forwards() {
    return adbText(['forward', '--list']).split(/\r?\n/).filter(Boolean);
  }

  /** 输入源码栈帧和期望行号，断言真实文件 URI 与方法行映射，不接受仅同名源文件。 */
  function assertFrame(frame, expectedLine) {
    assert.ok(frame, 'runtime frame missing');
    assert.equal(path.resolve(frame.source.path).toLowerCase(), source.toLowerCase());
    assert.equal(frame.line, expectedLine);
  }

  /** 输入命令参数，输出原后端响应 body；不替换失败响应，也不合成运行时状态。 */
  async function request(command, args) {
    record('client-request', { command, arguments: args });
    const response = await transport.request(command, args);
    assert.equal(response.success, true, command);
    return response.body;
  }

  /** 输入线程，输出真实顶帧；用于断点、next、stepIn/stepOut 的源码断言。 */
  async function topFrame(threadId) {
    const stack = await request('stackTrace', { threadId, startFrame: 0, levels: 20 });
    assert.ok(stack.stackFrames.length > 0, 'runtime stack empty');
    return stack.stackFrames[0];
  }

  /** 输入帧和期望整数，断言真实 scopes/variables 的 value；不以 evaluate 替代局部变量。 */
  async function assertValue(frame, value) {
    const scopes = await request('scopes', { frameId: frame.id });
    const local = scopes.scopes.find(scope => scope.name === 'Local');
    assert.ok(local && local.variablesReference > 0, 'runtime local scope missing');
    const variables = await request('variables', { variablesReference: local.variablesReference });
    assert.equal(variables.variables.find(variable => variable.name === 'value')?.value, String(value));
  }

  // 测试超时仅终止独占后端以解除 pending request；设备清理仍由 finally 同步执行。
  const onAbort = () => { if (transport) void transport.dispose(); };
  t.signal.addEventListener('abort', onAbort, { once: true });
  try {
    assert.equal(adbText(['get-state']), 'device');
    baseline = forwards();
    resources.baselineForwards = baseline;
    deviceTouched = true;
    assert.match(adbText(['install', '-r', apk]), /Success/);
    const component = adbText(['shell', 'cmd', 'package', 'resolve-activity', '--brief', '-a', 'android.intent.action.MAIN', '-c', 'android.intent.category.LAUNCHER', packageName])
      .split(/\r?\n/).find(line => line.startsWith(packageName + '/'));
    assert.ok(component, 'installed fixture launcher component unresolved');
    adbText(['shell', 'am', 'force-stop', packageName]);
    adbText(['shell', 'am', 'start', '-D', '-n', component]);
    const pidText = adbText(['shell', 'pidof', '-s', packageName]);
    assert.match(pidText, /^\d+$/);
    pid = Number(pidText);
    resources.pid = pid;
    const bundle = path.join(run, 'backend.cjs');
    buildSync({ entryPoints: [path.join(root, 'android-debugger/jvm/src/debugMain.js')], bundle: true, platform: 'node', format: 'cjs', outfile: bundle, logLevel: 'silent' });
    const module = { exports: {} };
    vm.runInNewContext(transformSync(fs.readFileSync(path.join(root, 'src/android-debugger/dapTransport.ts'), 'utf8'), { loader: 'ts', format: 'cjs' }).code,
      { module, exports: module.exports, require, Buffer, Error, console });
    const child = spawn(process.execPath, [bundle], { cwd: root, shell: false, stdio: 'pipe', env: { ...process.env, ANDROID_HOME: sdk, ANDROID_SDK_ROOT: sdk } });
    child.stdout.on('data', chunk => fs.appendFileSync(path.join(run, 'stdout.bin'), chunk));
    child.stderr.on('data', chunk => fs.appendFileSync(path.join(run, 'stderr.txt'), chunk));
    transport = new module.exports.DapTransport(child);
    const queue = [];
    let waiter;
    let closeError;
    // 真实事件先入队再唤醒，保证 response 前到达的 initialized/stopped 不会丢失。
    transport.on('event', event => {
      queue.push(event);
      if (waiter) { const resolve = waiter; waiter = undefined; resolve(); }
    });
    transport.on('message', message => record('backend', message));
    transport.on('close', error => {
      closeError = error;
      if (waiter) { const resolve = waiter; waiter = undefined; resolve(); }
    });

    /** 输入事件名，输出按到达顺序的真实匹配事件；仅在 await 时创建等待，无游离 rejection。 */
    async function event(name) {
      while (true) {
        const index = queue.findIndex(message => message.event === name);
        if (index >= 0) return queue.splice(index, 1)[0];
        if (closeError) throw closeError;
        if (t.signal.aborted) throw t.signal.reason;
        await new Promise(resolve => { waiter = resolve; });
      }
    }

    await request('initialize', { adapterID: 'android-tools', clientID: 'authorized-device-test', linesStartAt1: true, columnsStartAt1: true, pathFormat: 'path' });
    await configureAttachedSession(request, event, { processId: pid, targetDevice: serial, appSrcRoot: fixture, autoStartADB: false }, async () => {
      ownedForwards = forwards().filter(line => !baseline.includes(line));
      assert.ok(ownedForwards.some(line => { const parts = line.split(/\s+/); return parts[0] === serial && parts[2] === 'jdwp:' + pid; }), 'session JDWP forward missing');
      const breakpoints = await request('setBreakpoints', { source: { path: source }, breakpoints: [{ line: breakpointLine }] });
      assert.equal(breakpoints.breakpoints.length, 1);
      assert.equal(breakpoints.breakpoints[0].line, breakpointLine);
    });
    const stopped = await event('stopped');
    assert.equal(stopped.body.reason, 'breakpoint');
    const threadId = stopped.body.threadId;
    assert.ok(Number.isInteger(threadId) && threadId > 0);
    const threads = await request('threads', {});
    assert.ok(threads.threads.some(thread => thread.id === threadId && thread.name));
    const frame = await topFrame(threadId);
    assertFrame(frame, breakpointLine);
    assert.match(frame.name, /marker/);
    await assertValue(frame, 41);
    await request('next', { threadId });
    assert.equal((await event('stopped')).body.reason, 'step');
    const nextFrame = await topFrame(threadId);
    assertFrame(nextFrame, breakpointLine + 1);
    await assertValue(nextFrame, 42);
    await request('stepIn', { threadId });
    assert.equal((await event('stopped')).body.reason, 'step');
    const helper = await topFrame(threadId);
    assertFrame(helper, helperLine);
    assert.match(helper.name, /helper/);
    await request('stepOut', { threadId });
    assert.equal((await event('stopped')).body.reason, 'step');
    const returned = await topFrame(threadId);
    assert.match(returned.name, /marker/);
    // ART Step Out 停在调用返回后的同一语句；字节码 putfield 仍属于调用行，下一次 next 才到 return 行。
    assertFrame(returned, breakpointLine + 1);
    await assertValue(returned, 42);
    await request('next', { threadId });
    assert.equal((await event('stopped')).body.reason, 'step');
    const afterReturn = await topFrame(threadId);
    assert.match(afterReturn.name, /marker/);
    assertFrame(afterReturn, breakpointLine + 2);
    await request('continue', { threadId });
    assert.equal(adbText(['shell', 'pidof', '-s', packageName]), String(pid));
    await request('disconnect', { terminateDebuggee: false });
    assert.equal(adbText(['shell', 'pidof', '-s', packageName]), String(pid));
    const remaining = forwards();
    assert.ok(ownedForwards.every(line => !remaining.includes(line)), 'owned forwards leaked after detach');
    assert.ok(baseline.every(line => remaining.includes(line)), 'unowned baseline forwards changed');
    resources.detachedPidAlive = true;
  } catch (error) {
    record('failure', { message: error.message, response: error.response, stack: error.stack });
    throw error;
  } finally {
    t.signal.removeEventListener('abort', onAbort);
    if (deviceTouched) {
      const stopped = adbResult(['shell', 'am', 'force-stop', packageName]);
      resources.forceStopStatus = stopped.status;
      if (stopped.status !== 0) resources.cleanupErrors.push(stopped);
    }
    if (transport) {
      await transport.dispose();
      resources.backendDisposed = true;
    }
    if (deviceTouched) {
      const status = adbResult(['shell', 'pidof', '-s', packageName]);
      resources.finalPid = status.stdout.trim();
      if (!(status.status === 1 && !status.stdout.trim() && !status.stderr)) resources.cleanupErrors.push(status);
      const finalForwards = adbResult(['forward', '--list']);
      resources.finalForwards = finalForwards;
      if (finalForwards.status !== 0) resources.cleanupErrors.push(finalForwards);
      else {
        const finalRows = finalForwards.stdout.trim().split(/\r?\n/).filter(Boolean);
        resources.remainingOwnedForwards = finalRows.filter(line => {
          const parts = line.split(/\s+/);
          return !baseline.includes(line) && parts[0] === serial && parts[2] === 'jdwp:' + pid;
        });
        if (resources.remainingOwnedForwards.length) resources.cleanupErrors.push('owned JDWP forward remains');
      }
    }
    fs.writeFileSync(path.join(run, 'resources.json'), JSON.stringify(resources, null, 2));
    t.diagnostic('DAP transcript: ' + transcript);
    assert.deepEqual(resources.cleanupErrors, [], 'fixture cleanup failed; see resources.json');
  }
});