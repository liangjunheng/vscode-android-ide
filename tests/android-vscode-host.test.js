const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const vm = require('node:vm');
const { spawn, execFileSync } = require('node:child_process');
const runner = require('./fixtures/android-debugger/host-runner.cjs');

const root = path.resolve(__dirname, '..');
const fixtureRoot = path.join(root, 'tests', 'fixtures', 'android-debugger');
const source = path.join(fixtureRoot, 'java', 'dev', 'androidtools', 'debugfixture', 'DebugActivity.java');
const packageName = 'dev.androidtools.debugfixture';
const optIn = process.env.ANDROID_VSCODE_HOST_TEST === '1';

/** 输入候选 CLI，输出可验证 Code.exe；不把 code.cmd 代理当作宿主进程。 */
function resolveCodeExecutable(cli = process.env.VSCODE_CLI) {
  const candidates = [cli, process.env.VSCODE_PATH].filter(Boolean);
  for (const candidate of candidates) {
    const absolute = path.resolve(candidate);
    if (path.basename(absolute).toLowerCase() === 'code.cmd') {
      const sibling = path.join(path.dirname(absolute), 'code.exe');
      if (fs.existsSync(sibling)) return sibling;
    }
    if (path.basename(absolute).toLowerCase() === 'code.exe' && fs.existsSync(absolute)) return absolute;
  }
  return [
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Microsoft VS Code', 'Code.exe'),
    path.join(process.env.PROGRAMFILES || '', 'Microsoft VS Code', 'Code.exe')
  ].find(fs.existsSync);
}

/** 输入隔离目录，输出完整 VS Code 参数；路径全部归本次测试所有。 */
function buildHostArgs({ userData, extensions, workspace, extensionTests, repository }) {
  return [
    '--user-data-dir', userData, '--extensions-dir', extensions,
    '--disable-workspace-trust', '--extensionDevelopmentPath', repository,
    '--extensionTestsPath', extensionTests, workspace
  ];
}

/** 构造 GUI 宿主专属环境，移除 Electron 的 Node 运行模式且不修改父环境；回归：本文件 host GUI environment 用例断言继承配置保留，node --test tests/android-vscode-host.test.js。 */
function hostGuiEnvironment(environment, runtime) {
  const env = { ...environment, ...runtime };
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

/** 使用实际继承变量形状验证 GUI 与 Node 子进程边界，不连接设备。 */
test('host GUI environment removes Node mode without mutating parent configuration', () => {
  const parent = { ELECTRON_RUN_AS_NODE: '1', PATH: 'retained', ANDROID_SDK_ROOT: 'sdk' };
  const child = hostGuiEnvironment(parent, { HOST_RESULT: 'result' });
  assert.equal(Object.hasOwn(child, 'ELECTRON_RUN_AS_NODE'), false);
  assert.equal(child.PATH, parent.PATH);
  assert.equal(child.ANDROID_SDK_ROOT, 'sdk');
  assert.equal(child.HOST_RESULT, 'result');
  assert.equal(parent.ELECTRON_RUN_AS_NODE, '1');
});

/** 输入基线和 after 快照，断言只释放本测试 PID 对应的新增 forward 且基线保留。 */
function assertForwardLifecycle(baseline, during, after, serial, pid) {
  assert.ok(baseline.every(line => during.includes(line)));
  assert.ok(baseline.every(line => after.includes(line)));
  assert.ok(runner.ownedJdwpForwards(baseline, during, serial, pid).length > 0);
  assert.equal(runner.ownedJdwpForwards(baseline, after, serial, pid).length, 0);
}

/** 释放本测试 serial+PID 且基线中不存在的精确转发；回归：owned forward cleanup 用例断言其他会话/既有转发保留，node --test tests/android-vscode-host.test.js。 */
async function removeOwnedForwards(baseline, current, serial, pid, remove) {
  for (const row of runner.ownedJdwpForwards(baseline, current, serial, pid)) {
    const local = row.split(/\s+/)[1];
    assert.match(local, /^tcp:\d+$/);
    await remove(local);
  }
}

/** 真实生命周期清理回归只模拟 adb 删除边界，验证精确所有权而不使用 remove-all。 */
test('owned forward cleanup preserves baseline other PID and other serial', async () => {
  const baseline = ['S tcp:1 jdwp:7'];
  const current = [...baseline, 'S tcp:2 jdwp:7', 'S tcp:3 jdwp:8', 'T tcp:4 jdwp:7'];
  const removed = [];
  await removeOwnedForwards(baseline, current, 'S', 7, local => removed.push(local));
  assert.deepEqual(removed, ['tcp:2']);
  const denied = new Error('remove failed');
  await assert.rejects(removeOwnedForwards(baseline, current, 'S', 7, async () => { throw denied; }), error => error === denied);
});

/** 输入错误集合，输出聚合错误；资源清理失败不得静默吞掉。 */
function aggregateCleanupErrors(errors) {
  const failures = errors.filter(Boolean).map(error => error instanceof Error ? error.message : String(error));
  return failures.length ? new Error('Cleanup failures: ' + failures.join(' | ')) : undefined;
}

/** 输入 child，等待其退出；只接受本测试自己创建的宿主。 */
function awaitChildExit(child, signal) {
  if (child.exitCode !== null) return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  return new Promise((resolve, reject) => {
    let settled = false;
    const onError = error => finish(error);
    const onExit = (code, childSignal) => finish(undefined, { code, signal: childSignal });
    const onAbort = () => finish(signal.reason || new Error('host child wait aborted'));
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      child.removeListener('error', onError);
      child.removeListener('exit', onExit);
      signal?.removeEventListener('abort', onAbort);
      error ? reject(error) : resolve(result);
    };
    child.once('error', onError);
    child.once('exit', onExit);
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** 创建本测试唯一 loopback HTTP 栅栏；ready 请求读取 during 快照后以响应 ACK。 */
function createReadyBarrier(onReady) {
  let resolveReady;
  let rejectReady;
  let settled = false;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  ready.catch(() => {});
  const server = http.createServer(async (request, response) => {
    if (request.method !== 'POST' || request.url !== '/ready') {
      response.writeHead(404).end();
      return;
    }
    if (settled) {
      response.writeHead(409).end();
      return;
    }
    try {
      const value = await onReady(request);
      settled = true;
      resolveReady(value);
      response.writeHead(200).end('ack');
    } catch (error) {
      settled = true;
      rejectReady(error);
      response.writeHead(500).end();
    }
  });
  const listening = new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve(server.address().port);
    });
  });
  return {
    server,
    listening,
    ready,
    async close(reason = new Error('ready barrier closed')) {
      if (!settled) {
        settled = true;
        rejectReady(reason);
      }
      await listening;
      if (!server.listening) return;
      return new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  };
}

/** 输入栅栏、宿主退出和取消信号，等待 HTTP ready/ACK 或立即失败并关闭监听。 */
async function waitForHostReady(barrier, exited, signal) {
  const abortError = () => signal.reason || new Error('host readiness aborted');
  const abort = () => { void barrier.close(abortError()); };
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort, { once: true });
  try {
    await Promise.race([
      barrier.ready,
      exited.then(exit => {
        const error = new Error('VS Code exited before runner readiness: ' + JSON.stringify(exit));
        void barrier.close(error);
        throw error;
      })
    ]);
  } finally {
    signal?.removeEventListener('abort', abort);
  }
}

/** 输入本测试 child，终止并等待退出；绝不杀其他 IDE、ADB 或设备进程。 */
async function closeOwnedChild(child) {
  if (child && child.exitCode === null) {
    child.kill();
    await awaitChildExit(child);
  }
}

/** 输入 adb 命令，输出结果；非零退出保留错误由调用方断言。 */
function adbResult(adb, serial, args) {
  try {
    return { status: 0, stdout: execFileSync(adb, ['-s', serial, ...args], { encoding: 'utf8', timeout: 15000, windowsHide: true }) };
  } catch (error) {
    return { status: error.status, stdout: String(error.stdout || ''), stderr: String(error.stderr || ''), message: error.message };
  }
}

/** 输入 adb 结果，输出成功文本；失败不合成设备状态。 */
function adbText(adb, serial, args) {
  const result = adbResult(adb, serial, args);
  assert.equal(result.status, 0, JSON.stringify({ args, result }));
  return result.stdout.trim();
}

/** 输入 adb，输出完整 forward 快照；不触碰其他会话的 forward。 */
function readForwards(adb, serial) {
  return runner.parseForwardLines(adbText(adb, serial, ['forward', '--list']));
}

/** 输入目录，删除且仅删除本次测试拥有的目录。 */
async function removeOwnedDirectory(directory) {
  await fs.promises.rm(directory, { recursive: true, force: true });
}

/** HTTP 回归覆盖创建/ACK、child 早退、abort 和监听关闭，不使用 fs.watch。 */
test('host readiness uses HTTP barrier lifecycle', async () => {
  const immediate = createReadyBarrier(() => undefined);
  await immediate.close();
  assert.equal(immediate.server.listening, false);
  const values = [];
  const barrier = createReadyBarrier(async request => {
    request.resume();
    await new Promise(resolve => request.once('end', resolve));
    values.push('ready');
  });
  const port = await barrier.listening;
  const client = runner.waitForHostAck({ HOST_DURING_PORT: port });
  await client;
  await barrier.ready;
  await barrier.close();
  assert.deepEqual(values, ['ready']);
  assert.equal(barrier.server.listening, false);

  const early = createReadyBarrier(() => undefined);
  const exited = Promise.resolve({ code: 1, signal: null });
  await early.listening;
  await assert.rejects(waitForHostReady(early, exited), /exited before runner readiness/);
  await early.close();
  assert.equal(early.server.listening, false);

  const cancelled = createReadyBarrier(() => undefined);
  await cancelled.listening;
  const controller = new AbortController();
  const waiting = waitForHostReady(cancelled, new Promise(() => {}), controller.signal);
  controller.abort(new Error('cancelled readiness'));
  await assert.rejects(waiting, /cancelled readiness/);
  assert.equal(cancelled.server.listening, false);
});

/** 功能映射：纯测试覆盖断点构造、事件队列、forward/PID 解析和正反生命周期断言。 */
test('VS Code host runner pure API and lifecycle helpers', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'android-vscode-host-pure-'));
  try {
    const fake = {
      Uri: { file: file => ({ path: file }) },
      Position: class { constructor(line, character) { this.line = line; this.character = character; } },
      Location: class { constructor(uri, position) { this.uri = uri; this.position = position; } },
      SourceBreakpoint: class { constructor(location) { this.location = location; } }
    };
    const breakpoint = runner.createSourceBreakpoint(fake, 'DebugActivity.java', 32);
    assert.ok(breakpoint.location instanceof fake.Location);
    assert.equal(breakpoint.location.position.line, 31);
    const queue = runner.createMessageQueue();
    queue.push({ event: 'stopped' });
    assert.equal((await queue.take(message => message.event === 'stopped')).event, 'stopped');
    queue.close(new Error('closed'));
    assert.equal(queue.push({ event: 'late' }), false);
    await assert.rejects(queue.take(message => message.event === 'late'), /closed/);
    const text = 'SERIAL tcp:1 localabstract:baseline\r\nSERIAL tcp:2 jdwp:123\r\n';
    const rows = runner.parseForwardLines(text);
    assert.deepEqual(rows, ['SERIAL tcp:1 localabstract:baseline', 'SERIAL tcp:2 jdwp:123']);
    assert.equal(runner.ownedJdwpForwards(rows.slice(0, 1), rows, 'SERIAL', 123).length, 1);
    assert.equal(runner.ownedJdwpForwards(rows.slice(0, 1), rows, 'SERIAL', 124).length, 0);
    assertForwardLifecycle(['SERIAL tcp:1 localabstract:baseline'], rows, ['SERIAL tcp:1 localabstract:baseline'], 'SERIAL', 123);
    assert.throws(() => assertForwardLifecycle(['SERIAL tcp:1 localabstract:missing'], rows, ['SERIAL tcp:1 localabstract:baseline'], 'SERIAL', 123));
    assert.throws(() => assertForwardLifecycle(['SERIAL tcp:1 localabstract:baseline'], rows, rows, 'SERIAL', 123));
    assert.equal(aggregateCleanupErrors([]), undefined);
    assert.match(aggregateCleanupErrors([new Error('x')]).message, /x/);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

/** 功能映射：executeFake 使用真实 HTTP 栅栏覆盖 runner 成功、命令失败和取消，并断言资源释放。 */
test('shared host runner fake VS Code boundary', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'android-vscode-host-fake-'));
  try {
    const workspace = path.join(temp, 'workspace');
    fs.mkdirSync(workspace);
    fs.copyFileSync(source, path.join(workspace, 'DebugActivity.java'));

    // executeFake 使用与真实 host 相同的 loopback ready/ACK 接口，禁止合成真机通过。
    async function executeFake(failCommand, language = 'java') {
      const fixture = runner.jvmFixture(language);
      const fixtureSource = path.join(fixtureRoot, fixture.sourceRelative);
      fs.copyFileSync(fixtureSource, path.join(workspace, fixture.sourceName));
      const fixtureLines = fs.readFileSync(fixtureSource, 'utf8').split(/\r?\n/);
      const bpLine = fixtureLines.findIndex(line => line.includes(fixture.marker + '_BREAKPOINT')) + 2;
      const helperLine = fixtureLines.findIndex(line => line.includes(fixture.marker + '_STEP_TARGET')) + 1;
      const result = path.join(temp, failCommand ? 'fail-result.json' : 'result.json');
      let tracker;
      const requests = [];
      const breakpoints = [];
      let startListener;
      let state = 'breakpoint';
      let disposedTracker = false;
      let disposedStart = false;
      let duringRequests = 0;
      const abortController = failCommand === 'cancel' ? new AbortController() : undefined;
      const barrier = createReadyBarrier(async request => {
        request.resume();
        await new Promise(resolve => request.once('end', resolve));
        duringRequests += 1;
      });
      const port = await barrier.listening;
      const send = message => tracker?.onDidSendMessage?.(message);
      const session = {
        configuration: { name: 'host-real-jvm' },
        async customRequest(command, args) {
          requests.push({ command, args });
          if (command === failCommand) throw new Error('fake response failed for ' + command);
          if (command === 'threads') return { threads: [{ id: 7, name: 'main' }] };
          if (command === 'stackTrace') {
            const frames = {
              breakpoint: { id: 1, name: 'marker', line: bpLine, source: { path: path.join(workspace, fixture.sourceName) } },
              next: { id: 2, name: 'marker', line: bpLine + 1, source: { path: path.join(workspace, fixture.sourceName) } },
              helper: { id: 3, name: 'helper', line: helperLine, source: { path: path.join(workspace, fixture.sourceName) } },
              returned: { id: 4, name: 'marker', line: bpLine + 1, source: { path: path.join(workspace, fixture.sourceName) } },
              afterReturn: { id: 5, name: 'marker', line: bpLine + 2, source: { path: path.join(workspace, fixture.sourceName) } }
            };
            return { stackFrames: [frames[state]] };
          }
          if (command === 'scopes') return { scopes: [{ name: 'Local', variablesReference: 9 }] };
          if (command === 'variables') return { variables: [{ name: 'value', value: state === 'breakpoint' ? '41' : '42' }] };
          if (command === 'next') {
            state = state === 'returned' ? 'afterReturn' : 'next';
            send({ type: 'event', event: 'stopped', body: { reason: 'step', threadId: 7 } });
          }
          if (command === 'stepIn') {
            state = 'helper';
            send({ type: 'event', event: 'stopped', body: { reason: 'step', threadId: 7 } });
          }
          if (command === 'stepOut') {
            state = 'returned';
            send({ type: 'event', event: 'stopped', body: { reason: 'step', threadId: 7 } });
          }
          return {};
        }
      };
      const fake = {
        Uri: { file: file => ({ path: file }) },
        Position: class { constructor(line, character) { this.line = line; this.character = character; } },
        Location: class { constructor(uri, position) { this.uri = uri; this.position = position; } },
        SourceBreakpoint: class { constructor(location) { this.location = location; } },
        workspace: { workspaceFolders: [{}] },
        debug: {
          registerDebugAdapterTrackerFactory(type, factory) {
            tracker = factory.createDebugAdapterTracker(session);
            return { dispose() { disposedTracker = true; } };
          },
          onDidStartDebugSession(listener) {
            startListener = listener;
            return { dispose() { disposedStart = true; startListener = undefined; } };
          },
          async addBreakpoints(items) { breakpoints.push(...items); },
          async startDebugging(folder, configuration) {
            assert.equal(configuration.processId, 123);
            assert.equal(configuration.packageName, fixture.packageName);
            assert.equal(path.basename(breakpoints[0].location.uri.path), fixture.sourceName);
            startListener(session);
            send({ type: 'event', event: 'initialized' });
            send({ type: 'event', event: 'stopped', body: { reason: 'breakpoint', threadId: 7 } });
            return true;
          }
        }
      };
      const config = {
        HOST_WORKSPACE: workspace, HOST_RESULT: result, HOST_DURING_PORT: port, ANDROID_VSCODE_HOST_LANGUAGE: language,
        HOST_ABORT_SIGNAL: abortController?.signal,
        ANDROID_DEBUG_TEST_SERIAL: 'SERIAL', ANDROID_DEBUG_TEST_PID: '123'
      };
      const loaded = { exports: {} };
      vm.runInNewContext(fs.readFileSync(path.join(fixtureRoot, 'host-runner.cjs'), 'utf8'), {
        module: loaded, exports: loaded.exports, require: name => name === 'vscode' ? fake : require(name),
        process: { env: config }, Buffer, URL, console, setTimeout, clearTimeout
      });
      const runPromise = loaded.exports.run('legacy-tests-root', () => { throw new Error('unexpected legacy callback'); });
      if (failCommand === 'cancel') {
        abortController.abort(new Error('cancelled'));
        await assert.rejects(runPromise, /cancelled/);
      } else if (failCommand) {
        await assert.rejects(runPromise, /fake response failed/);
      } else {
        await runPromise;
        await barrier.ready;
      }
      await barrier.close().catch(() => {});
      return { requests, breakpoints, result: JSON.parse(fs.readFileSync(result, 'utf8')), duringRequests, disposedTracker, disposedStart };
    }

    const success = await executeFake();
    assert.equal(success.result.ok, true);
    assert.deepEqual(success.requests.map(request => request.command), [
      'threads', 'stackTrace', 'scopes', 'variables', 'next',
      'stackTrace', 'scopes', 'variables', 'stepIn', 'stackTrace',
      'stepOut', 'stackTrace', 'next', 'stackTrace', 'continue', 'disconnect'
    ]);
    assert.equal(success.requests.find(request => request.command === 'disconnect').args.terminateDebuggee, false);
    assert.equal(success.requests.filter(request => request.command === 'setBreakpoints').length, 0);
    assert.equal(success.breakpoints.length, 1);
    assert.equal(success.breakpoints[0].location.position.line, 31);
    assert.equal(success.duringRequests, 1);
    assert.equal(success.disposedTracker, true);
    assert.equal(success.disposedStart, true);
    const kotlin = await executeFake(undefined, 'kotlin');
    assert.equal(kotlin.result.ok, true);
    assert.equal(kotlin.result.language, 'kotlin');
    assert.equal(kotlin.breakpoints[0].location.position.line, 27);
    assert.equal(kotlin.result.helperLine, 35);
    assert.deepEqual(kotlin.requests.map(request => request.command), success.requests.map(request => request.command));
    assert.throws(() => runner.jvmFixture('unsupported'), /Unsupported JVM fixture/);
    const failure = await executeFake('threads');
    assert.equal(failure.result.ok, false);
    assert.match(failure.result.error.message, /fake response failed/);
    assert.equal(failure.disposedTracker, true);
    const cancelled = await executeFake('cancel');
    assert.equal(cancelled.result.ok, false);
    assert.match(cancelled.result.error.message, /cancelled/);
    assert.equal(cancelled.disposedTracker, true);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

/** 功能映射：opt-in 真实 ExtensionHost attach 使用真实 PID；HTTP 栅栏 ACK 前读取 during，之后断言 PID 存活、baseline 保留及 owned forward 释放。 */
test('authorized VS Code ExtensionHost real JVM regression', { skip: !optIn && 'ANDROID_VSCODE_HOST_TEST=1 is required; no host or device action is authorized by default', timeout: 180000 }, async t => {
  const environment = process.env;
  const code = resolveCodeExecutable(environment.VSCODE_CLI);
  const sdk = environment.ANDROID_SDK_ROOT || environment.ANDROID_HOME;
  const fixture = runner.jvmFixture(environment.ANDROID_VSCODE_HOST_LANGUAGE);
  const source = path.join(fixtureRoot, fixture.sourceRelative);
  const packageName = fixture.packageName;
  const apk = path.join(root, fixture.apkRelative);
  const missing = [];
  if (!environment.ANDROID_DEBUG_TEST_SERIAL) missing.push('ANDROID_DEBUG_TEST_SERIAL');
  if (!sdk) missing.push('ANDROID_SDK_ROOT or ANDROID_HOME');
  if (!code) missing.push('installed VS Code Code.exe');
  if (!fs.existsSync(apk)) missing.push('signed fixture APK');
  if (!fs.existsSync(path.join(root, 'dist', 'extension.js'))) missing.push('compiled extension dist/extension.js');
  if (missing.length) throw new Error('ANDROID_VSCODE_HOST_TEST=1 prerequisites missing: ' + missing.join(', '));
  const serial = environment.ANDROID_DEBUG_TEST_SERIAL;
  const adb = environment.ADB || path.join(sdk, 'platform-tools', process.platform === 'win32' ? 'adb.exe' : 'adb');
  const run = await fs.promises.mkdtemp(path.join(root, '.test-artifacts', 'android-vscode-host-'));
  const workspace = path.join(run, 'workspace');
  const result = path.join(run, 'result.json');
  let child;
  let pid;
  let touched = false;
  let baseline;
  let during;
  let after;
  const cleanupErrors = [];
  const barrier = createReadyBarrier(async request => {
    request.resume();
    await new Promise(resolve => request.once('end', resolve));
    during = readForwards(adb, serial);
  });
  try {
    assert.equal(adbText(adb, serial, ['get-state']), 'device');
    touched = true;
    baseline = readForwards(adb, serial);
    assert.match(adbText(adb, serial, ['install', '-r', apk]), /Success/);
    const component = adbText(adb, serial, ['shell', 'cmd', 'package', 'resolve-activity', '--brief', '-a', 'android.intent.action.MAIN', '-c', 'android.intent.category.LAUNCHER', packageName]).split(/\r?\n/).find(line => line.startsWith(packageName + '/'));
    assert.ok(component);
    adbText(adb, serial, ['shell', 'am', 'force-stop', packageName]);
    adbText(adb, serial, ['shell', 'am', 'start', '-D', '-n', component]);
    pid = Number(adbText(adb, serial, ['shell', 'pidof', '-s', packageName]));
    assert.ok(Number.isInteger(pid) && pid > 0);
    await fs.promises.mkdir(workspace, { recursive: true });
    fs.copyFileSync(source, path.join(workspace, fixture.sourceName));
    const port = await barrier.listening;
    child = spawn(code, buildHostArgs({ userData: path.join(run, 'user-data'), extensions: path.join(run, 'extensions'), workspace, extensionTests: path.join(fixtureRoot, 'host-runner.cjs'), repository: root }), {
      cwd: root,
      env: hostGuiEnvironment(environment, { HOST_RESULT: result, HOST_WORKSPACE: workspace, HOST_DURING_PORT: String(port), ANDROID_DEBUG_TEST_SERIAL: serial, ANDROID_DEBUG_TEST_PID: String(pid) }),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', chunk => { stdout.push(chunk); fs.appendFileSync(path.join(run, 'stdout.log'), chunk); });
    child.stderr.on('data', chunk => { stderr.push(chunk); fs.appendFileSync(path.join(run, 'stderr.log'), chunk); });
    const exited = awaitChildExit(child, t.signal);
    await waitForHostReady(barrier, exited, t.signal);
    await barrier.ready;
    const exit = await exited;
    child = undefined;
    after = readForwards(adb, serial);
    const outcome = fs.existsSync(result) ? JSON.parse(fs.readFileSync(result, 'utf8')) : undefined;
    assert.equal(exit.code, 0, JSON.stringify({ exit, outcome, stdout: Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderr).toString() }));
    assert.equal(outcome?.ok, true, JSON.stringify(outcome));
    assert.equal(outcome.language, fixture.language);
    assert.equal(adbText(adb, serial, ['shell', 'pidof', '-s', packageName]), String(pid));
    assertForwardLifecycle(baseline, during, after, serial, pid);
  } catch (error) {
    fs.writeFileSync(path.join(run, 'failure.json'), JSON.stringify({ language: fixture.language, error: { message: error.message, stack: error.stack } }, null, 2));
    throw error;
  } finally {
    await barrier.close().catch(error => cleanupErrors.push(error));
    if (child) await closeOwnedChild(child).catch(error => cleanupErrors.push(error));
    if (touched) {
      const stop = adbResult(adb, serial, ['shell', 'am', 'force-stop', packageName]);
      if (stop.status !== 0) cleanupErrors.push(stop);
      try {
        after = readForwards(adb, serial);
        if (baseline && pid) {
          await removeOwnedForwards(baseline, after, serial, pid, local => adbText(adb, serial, ['forward', '--remove', local]));
          after = readForwards(adb, serial);
          assert.ok(baseline.every(row => after.includes(row)), 'baseline forward changed during cleanup');
          assert.equal(runner.ownedJdwpForwards(baseline, after, serial, pid).length, 0);
        }
      } catch (error) { cleanupErrors.push(error); }
    }
    try {
      fs.writeFileSync(path.join(run, 'resources.json'), JSON.stringify({ language: fixture.language, serial, pid, baseline, during, after, cleanupErrors: cleanupErrors.map(error => error instanceof Error ? error.message : String(error)), result }, null, 2));
    } catch (error) {
      cleanupErrors.push(error);
    }
    const cleanupError = aggregateCleanupErrors(cleanupErrors);
    if (cleanupError) throw cleanupError;
  }
});

module.exports = { resolveCodeExecutable, buildHostArgs, assertForwardLifecycle, aggregateCleanupErrors, awaitChildExit, closeOwnedChild, createReadyBarrier, waitForHostReady };
