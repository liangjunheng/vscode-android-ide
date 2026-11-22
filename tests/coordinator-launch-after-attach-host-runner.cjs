/**
 * 功能点：任务62单模式隔离宿主，固化同PID双轮attach、生产launch换PID及新PID再次attach。
 * 受影响对象：当前模式唯一fixture包、android-debug父会话、实际JVM/LLDB子会话、Coordinator原始进程及双向DAP流。
 * 复现路径：设备入口已完成一次普通am start -W；本宿主对旧PID连续attach两轮，均广播Java/JNI marker并执行verified/frame/value41/next42/continue/pause，精确父disconnect(false)；随后用同包APK调用生产launch一次，验证新PID，再attach新PID一次。
 * 测试范围：java、native、dual由设备入口分别启动本文件；每轮只使用真实选定引擎，不手动force-stop/start替代生产launch；pending或active时禁止后续阶段。
 * 执行入口：由coordinator-launch-after-attach-device.test.js以ANDROID_COORDINATOR_LAUNCH_TEST=1加载本文件。
 * 预期结果：旧PID两轮及新PID轮均真实命中源码断点并完成单步、变量和暂停；生产launch无固定请求总期限，45秒只作为宿主诊断上限且不改变底层取消机制；所有父子会话真实结束且新PID在disconnect(false)后保留。
 * 判据：每个阶段的原始DAP、start Promise、父disconnect(false)、termination、PID和资源断言全部满足才为COMPLETED；失败阶段之后全部明确记为未执行。
 */
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const assert = require('node:assert/strict');
const { finished } = require('node:stream/promises');

/** 功能：执行设备命令并记录原始输出；输入本模式spec和argv；输出文本，失败原样抛出。验证：PID、广播和资源快照。 */
function createAdb(spec, log) {
  return args => {
    const at = new Date().toISOString();
    try {
      const stdout = cp.execFileSync(spec.adb, ['-s', spec.serial, ...args], { encoding: 'utf8', windowsHide: true, timeout: 5000 }).trim();
      log({ at, args, stdout });
      return stdout;
    } catch (error) {
      log({ at, args, status: error.status, stdout: String(error.stdout || ''), stderr: String(error.stderr || ''), error: String(error) });
      throw error;
    }
  };
}

/** 功能：运行单模式Coordinator诊断；输入隔离宿主环境中的vscode和spec；输出result.json并在finally完成全部流刷新。验证：本文件的完整attach-launch-reattach入口。 */
exports.run = async function run() {
  const vscode = require('vscode');
  const spec = JSON.parse(fs.readFileSync(process.env.COORDINATOR_LAUNCH_HOST_SPEC, 'utf8'));
  const resultFile = process.env.COORDINATOR_LAUNCH_HOST_RESULT;
  const directory = path.dirname(resultFile);
  const dapLog = fs.createWriteStream(resultFile + '.dap.jsonl');
  const dapWritten = finished(dapLog).then(() => undefined, error => error);
  const deviceLog = fs.createWriteStream(resultFile + '.device.jsonl');
  const deviceWritten = finished(deviceLog).then(() => undefined, error => error);
  const messages = [];
  const observed = new Map();
  const active = new Map();
  const terminations = [];
  const starts = {};
  const startPromises = new Map();
  const disconnects = [];
  const coordinatorLogs = [];
  const coordinatorProcesses = [];
  const coordinatorCloses = [];
  const coordinatorWritten = [];
  const coordinatorSources = [];
  const outcome = {
    status: 'RUNNING', stage: 'activation', mode: spec.mode, packageName: spec.packageName,
    oldPid: spec.pid, starts, disconnects, terminations, coordinator: [], phases: [], notExecuted: [],
  };
  const javaLine = fs.readFileSync(spec.javaSource, 'utf8').split(/\r?\n/).findIndex(line => line.includes('JAVA_BREAKPOINT')) + 2;
  const nativeLine = fs.readFileSync(spec.nativeSource, 'utf8').split(/\r?\n/).findIndex(line => line.includes('NATIVE_BREAKPOINT')) + 2;
  const engines = [
    ...(spec.mode !== 'native' ? [{ type: 'android-jvm', key: 'java', source: spec.javaSource, line: javaLine }] : []),
    ...(spec.mode !== 'java' ? [{ type: 'lldb', key: 'native', source: spec.nativeSource, line: nativeLine }] : []),
  ];
  const phaseNames = ['attach-1', 'attach-2', 'launch', 'reattach'];
  const adbLog = item => deviceLog.write(JSON.stringify({ at: new Date().toISOString(), ...item }) + '\n');
  const adb = createAdb(spec, adbLog);
  const originalSpawn = cp.spawn;
  let snapshotTimer;
  let phaseIndex = 0;
  let currentPhaseIndex = -1;

  /** 功能：同步写入当前结果；输入无；输出result.json，供设备入口读取阶段和精确失败原因。 */
  function persist() {
    fs.writeFileSync(resultFile, JSON.stringify({ ...outcome, active: [...active.values()].map(session => ({ id: session.id, type: session.type, name: session.configuration.name })), messageCount: messages.length }, null, 2) + '\n');
  }

  /** 功能：记录原始双向DAP消息；输入会话、方向和载荷；输出追加流式jsonl，不改变生产报文。 */
  function record(session, direction, extra) {
    const item = { index: messages.length, at: new Date().toISOString(), direction, session: session.id, parentId: session.parentSession?.id || null, type: session.type, name: session.configuration.name, ...extra };
    messages.push(item);
    dapLog.write(JSON.stringify(item) + '\n');
  }

  /** 功能：判断会话是否属于本任务标签；输入会话和标签；输出布尔值，避免接纳无关父子会话。 */
  function belongs(session, tag) {
    return session.configuration.name === tag || session.parentSession?.configuration?.name === tag;
  }

  /** 功能：判断会话是否属于本宿主所有任务阶段；输入会话；输出布尔值，供原始流和终止追踪使用。 */
  function isOwned(session) {
    return session.configuration.name?.startsWith('task62-launch-') || session.parentSession?.configuration?.name?.startsWith('task62-launch-');
  }

  /** 功能：拦截并旁路记录Coordinator原始stdout/stderr；输入原始spawn参数；输出不变的子进程对象。验证：Coordinator流与DAP流独立留档。 */
  cp.spawn = function diagnosticSpawn(command, args, options) {
    const child = originalSpawn.apply(this, arguments);
    if (Array.isArray(args) && args.some(arg => String(arg).endsWith('android-debug-coordinator.jar'))) {
      const recordItem = { pid: child.pid, command, args, at: new Date().toISOString() };
      outcome.coordinator.push(recordItem);
      const stdout = fs.createWriteStream(path.join(directory, 'coordinator-stdout-' + child.pid + '.log'));
      const stderr = fs.createWriteStream(path.join(directory, 'coordinator-stderr-' + child.pid + '.log'));
      coordinatorLogs.push(stdout, stderr);
      coordinatorWritten.push(...[stdout, stderr].map(stream => finished(stream).then(() => undefined, error => error)));
      for (const [source, destination] of [[child.stdout, stdout], [child.stderr, stderr]]) {
        const listener = data => destination.write(data);
        source.on('data', listener);
        coordinatorSources.push({ source, listener });
      }
      const closed = new Promise(resolve => child.once('close', (code, signal) => {
        Object.assign(recordItem, { exitCode: code, signal, closedAt: new Date().toISOString() });
        persist();
        resolve(recordItem);
      }));
      coordinatorProcesses.push(child);
      coordinatorCloses.push(closed);
      persist();
    }
    return child;
  };

  /** 功能：等待有限期限且不取消底层操作；输入标签、真实Promise、毫秒数；输出真实Promise结果，超时明确失败。验证：生产launch仅受宿主45秒诊断上限约束。 */
  async function deadline(label, operation, timeout) {
    let timer;
    try {
      return await Promise.race([
        Promise.resolve().then(operation),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label + ' 宿主诊断上限 ' + timeout + 'ms，底层操作未视为完成')), timeout); }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** 功能：等待真实事件或状态；输入标签、谓词和毫秒数；输出首次满足谓词的对象，不伪造事件。 */
  async function waitFor(label, predicate, timeout = 15000) {
    const expires = Date.now() + timeout;
    while (Date.now() < expires) {
      const value = predicate();
      if (value) return value;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error(label + ' 等待超时 ' + timeout + 'ms');
  }

  /** 功能：发送真实DAP请求并核对同一session的request/response；输入会话、命令和参数；输出原始响应证据。验证：响应必须success=true。 */
  async function request(session, command, args, timeout = 15000) {
    const from = messages.length;
    const value = await deadline(session.type + '.' + command, () => session.customRequest(command, args), timeout);
    const sent = messages.slice(from).find(item => item.session === session.id && item.direction === 'client-to-adapter' && item.message?.type === 'request' && item.message.command === command);
    const response = sent && messages.slice(from).find(item => item.session === session.id && item.direction === 'adapter-to-client' && item.message?.type === 'response' && item.message.request_seq === sent.message.seq && item.message.command === command);
    assert.ok(sent && response?.message.success === true, '缺少实际成功DAP链 ' + command);
    return { value, sent, response };
  }

  /** 功能：读取唯一fixture的当前PID；输入无；输出PID或明确的0；验证：不将异常设备命令吞为不存在。 */
  function processPid() {
    try { return Number(adb(['shell', 'pidof', '-s', spec.packageName]) || 0); }
    catch (error) {
      if (error.status === 1 && !String(error.stdout || '').trim() && !String(error.stderr || '').trim()) return 0;
      throw error;
    }
  }

  /** 功能：取得当前模式的只读设备资源快照；输入阶段；输出PID、forward和进程行，供断开及迁移断言。 */
  function snapshot(stage) {
    const item = {
      stage, at: new Date().toISOString(), pid: processPid(),
      forward: adb(['forward', '--list']),
      processes: adb(['shell', 'ps', '-A', '-o', 'PID,ARGS']).split(/\r?\n/).filter(line => line.includes(spec.packageName) || line.includes('lldb-server')),
    };
    outcome.snapshots ??= [];
    outcome.snapshots.push(item);
    persist();
    return item;
  }

  /** 功能：读取指定子会话的全部原始消息；输入子会话；输出可复核DAP证据数组。 */
  function sessionMessages(child) {
    return messages.filter(item => item.session === child.id);
  }

  /** 功能：检查指定引擎的真实verified断点；输入子会话和源码行；输出响应、事件及verified结论。 */
  function breakpointStatus(child, line) {
    const response = sessionMessages(child).filter(item => item.message?.type === 'response' && item.message.command === 'setBreakpoints').flatMap(item => item.message.body?.breakpoints || []);
    const events = sessionMessages(child).filter(item => item.message?.event === 'breakpoint').map(item => item.message.body?.breakpoint).filter(Boolean);
    return { response, events, verified: [...response, ...events].some(item => item.verified === true && item.line === line) };
  }

  /** 功能：等待指定子会话新的stopped事件；输入子会话、标签、消息起点和可选原因；输出未消费的真实事件。 */
  async function waitStopped(child, label, from, reason) {
    const event = await waitFor(label, () => messages.slice(from).find(item => item.session === child.id && item.direction === 'adapter-to-client' && item.message?.event === 'stopped' && (!reason || item.message.body?.reason === reason)));
    return event;
  }

  /** 功能：异步触发fixture的显式marker广播；输入阶段证据对象；输出广播子进程和完成Promise，不启动Activity。 */
  function trigger(evidence) {
    const args = ['-s', spec.serial, 'shell', 'am', 'broadcast', '--receiver-foreground', '-n', spec.packageName + '/dev.androidtools.debugfixture.TriggerReceiver', '-a', spec.packageName + '.TRIGGER'];
    Object.assign(evidence, { args, startedAt: new Date().toISOString(), stdout: '', stderr: '' });
    const child = originalSpawn(spec.adb, args, { windowsHide: true });
    child.stdout.on('data', data => { evidence.stdout += data; });
    child.stderr.on('data', data => { evidence.stderr += data; });
    const completion = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', code => { evidence.exit = code; evidence.endedAt = new Date().toISOString(); resolve(code); });
    });
    return { child, completion };
  }

  /** 功能：启动并保存原始startDebugging Promise；输入配置及阶段键；输出不改变的Promise，拒绝和结算状态原样留档。 */
  function start(config, key) {
    const raw = starts[key] = { state: 'pending', request: config.request, name: config.name, calledAt: new Date().toISOString(), config };
    const promise = Promise.resolve().then(() => vscode.debug.startDebugging(vscode.workspace.workspaceFolders[0], config));
    const tracked = promise.then(value => {
      Object.assign(raw, { state: 'fulfilled', value, settledAt: new Date().toISOString() });
      raw.failures = messages.filter(item => item.name === config.name && item.message?.type === 'response' && item.message.success === false);
      persist();
      if (!value) throw new Error('startDebugging返回false: ' + JSON.stringify(raw.failures));
      return value;
    }, error => {
      Object.assign(raw, { state: 'rejected', error: String(error.stack || error), settledAt: new Date().toISOString() });
      persist();
      throw error;
    });
    startPromises.set(key, tracked);
    tracked.catch(() => undefined);
    persist();
    return tracked;
  }

  /** 功能：等待指定标签的真实父会话及全部实际引擎子会话；输入阶段标签；输出父子会话对象。 */
  async function pair(tag) {
    const parent = await waitFor(tag + '父会话', () => [...active.values()].find(session => session.configuration.name === tag));
    const children = await waitFor(tag + '实际引擎', () => {
      const found = [...active.values()].filter(session => session.parentSession?.id === parent.id);
      return engines.every(engine => found.some(session => session.type === engine.type)) ? found : false;
    });
    assert.equal(children.length, engines.length, tag + '实际引擎数量不匹配');
    return { parent, children };
  }

  /** 功能：对一个真实引擎执行断点、frame、变量、单步和continue；输入子会话、引擎、触发消息起点和阶段证据；输出完整真实DAP证据。 */
  async function inspectAndContinue(child, engine, triggerFrom, evidence) {
    evidence.stopped = await waitStopped(child, engine.key + ' marker', triggerFrom, 'breakpoint');
    evidence.threadId = evidence.stopped.message.body.threadId;
    evidence.threads = await request(child, 'threads', {});
    evidence.stack = await request(child, 'stackTrace', { threadId: evidence.threadId, levels: 20 });
    evidence.frame = evidence.stack.value?.stackFrames?.find(frame => frame.source?.path && path.resolve(frame.source.path).toLowerCase() === path.resolve(engine.source).toLowerCase() && frame.line === engine.line);
    assert.ok(evidence.frame, engine.key + ' 缺少真实源码frame');
    evidence.scopes = await request(child, 'scopes', { frameId: evidence.frame.id });
    const local = evidence.scopes.value?.scopes?.find(scope => /local/i.test(scope.name));
    assert.ok(local, engine.key + ' 缺少Local scope');
    evidence.variables = await request(child, 'variables', { variablesReference: local.variablesReference });
    assert.ok(evidence.variables.value?.variables?.some(variable => variable.name === 'value' && /^41(?:\b|$)/.test(variable.value)), engine.key + ' 缺少真实value=41');
    evidence.verified = breakpointStatus(child, engine.line).verified;
    assert.equal(evidence.verified, true, engine.key + ' 缺少真实verified断点');

    const stepFrom = messages.length;
    evidence.next = await request(child, 'next', { threadId: evidence.threadId });
    evidence.stepStopped = await waitStopped(child, engine.key + ' 单步停止', stepFrom, 'step');
    evidence.stepStack = await request(child, 'stackTrace', { threadId: evidence.stepStopped.message.body.threadId, levels: 20 });
    evidence.stepFrame = evidence.stepStack.value?.stackFrames?.find(frame => frame.source?.path && path.resolve(frame.source.path).toLowerCase() === path.resolve(engine.source).toLowerCase() && frame.line === engine.line + 1);
    assert.ok(evidence.stepFrame, engine.key + ' 单步未进入下一源码行');
    evidence.stepScopes = await request(child, 'scopes', { frameId: evidence.stepFrame.id });
    const stepLocal = evidence.stepScopes.value?.scopes?.find(scope => /local/i.test(scope.name));
    assert.ok(stepLocal, engine.key + ' 单步后缺少Local scope');
    evidence.stepVariables = await request(child, 'variables', { variablesReference: stepLocal.variablesReference });
    assert.ok(evidence.stepVariables.value?.variables?.some(variable => variable.name === 'value' && /^42(?:\b|$)/.test(variable.value)), engine.key + ' 单步后缺少真实value=42');
    evidence.continue = await request(child, 'continue', { threadId: evidence.stepStopped.message.body.threadId });
  }

  /** 功能：完成一次真实父会话disconnect(false)并等待其父子termination；输入精确父会话和阶段名；输出响应及成员结束证据。 */
  async function disconnect(parent, stage, expires = Date.now() + 35000) {
    const parentId = parent.id;
    const remaining = () => {
      const budget = expires - Date.now();
      if (budget <= 0) throw new Error(stage + '清理期限已结束');
      return budget;
    };
    const response = await request(parent, 'disconnect', { terminateDebuggee: false }, Math.min(15000, remaining()));
    const args = response.sent?.message?.arguments;
    assert.equal(response.sent?.session, parentId, stage + ' disconnect必须由精确父会话发送');
    assert.equal(args?.terminateDebuggee, false, stage + ' disconnect必须使用terminateDebuggee=false');
    disconnects.push({ stage, parentId, terminateDebuggee: args.terminateDebuggee, sent: response.sent.message, response: response.response.message });
    await waitFor(stage + '全部父子termination', () => {
      const members = [...observed.values()].filter(session => session.id === parentId || session.parentSession?.id === parentId);
      return members.length > 0 && members.every(session => terminations.some(item => item.id === session.id)) && ![...active.values()].some(session => session.id === parentId || session.parentSession?.id === parentId);
    }, Math.min(20000, remaining()));
    const members = [...observed.values()].filter(session => session.id === parentId || session.parentSession?.id === parentId);
    const after = snapshot(stage + '-after-disconnect');
    return { response, members: members.map(session => ({ id: session.id, type: session.type })), afterDisconnect: after };
  }

  /** 功能：执行一个阶段并在失败后登记剩余阶段；输入阶段名、阶段函数和结果容器；输出阶段完成值。验证：失败后不进入后续阶段。 */
  async function phase(name, target, output) {
    outcome.stage = name;
    currentPhaseIndex = phaseNames.indexOf(name);
    const item = output || { name, status: 'RUNNING', startedAt: new Date().toISOString() };
    outcome[name] = item;
    outcome.phases.push(item);
    persist();
    try {
      const value = await target(item);
      if (value && typeof value === 'object') Object.assign(item, value);
      outcome[name] = item;
      item.status = 'PASS';
      item.endedAt = new Date().toISOString();
      phaseIndex++;
      persist();
      return value;
    } catch (error) {
      item.status = 'FAIL';
      item.error = String(error.stack || error);
      item.endedAt = new Date().toISOString();
      outcome.stage = name;
      outcome.error = item.error;
      outcome.notExecuted.push(...phaseNames.slice(currentPhaseIndex + 1));
      persist();
      throw error;
    }
  }

  /** 功能：执行一个attach阶段的完整真实流程；输入阶段编号和阶段证据；输出断开后仍保留旧PID的结果。验证：同一旧PID两轮及新PID轮共用该逻辑。 */
  async function attachPhase(roundName, pid, isReattach = false) {
    const tag = 'task62-launch-' + spec.mode + '-' + roundName;
    const currentBreakpoints = engines.map(engine => new vscode.SourceBreakpoint(new vscode.Location(vscode.Uri.file(engine.source), new vscode.Position(engine.line - 1, 0))));
    vscode.debug.addBreakpoints(currentBreakpoints);
    let broadcast;
    const round = outcome[roundName];
    if (!isReattach) (outcome.attachRounds ??= []).push(round);
    try {
      const before = snapshot(roundName + '-before-attach');
      assert.equal(before.pid, pid, roundName + ' attach前PID不匹配');
      const config = {
        type: 'android-debug', request: 'attach', name: tag, mode: spec.mode, serial: spec.serial, target: spec.serial,
        pid, processId: pid, packageName: spec.packageName, launchActivity: spec.activity,
        androidProjectRoot: spec.workspace, projectRoot: spec.workspace, sourcePaths: [spec.sourceRoot],
        java: { name: tag + '-jvm', sourcePaths: [spec.sourceRoot] },
        native: { sdkRoot: spec.sdk, ndkRoot: spec.ndk, abi: 'arm64-v8a', symbolSearchPaths: [] },
      };
      const startValue = await deadline(roundName + ' startDebugging', () => start(config, roundName), 25000);
      assert.equal(startValue, true, roundName + ' startDebugging返回false');
      const pairValue = await pair(tag);
      round.parent = { id: pairValue.parent.id, type: pairValue.parent.type, name: pairValue.parent.configuration.name };
      round.children = pairValue.children.map(child => ({ id: child.id, type: child.type, name: child.configuration.name }));
      const configured = await waitFor(roundName + '全部setBreakpoints响应', () => engines.every(engine => sessionMessages(pairValue.children.find(child => child.type === engine.type)).some(item => item.message?.type === 'response' && item.message.command === 'setBreakpoints')));
      round.setBreakpointsConfigured = Boolean(configured);
      round.breakpointsBeforeTrigger = Object.fromEntries(engines.map(engine => [engine.key, breakpointStatus(pairValue.children.find(child => child.type === engine.type), engine.line)]));
      const triggerFrom = messages.length;
      round.trigger = {};
      broadcast = trigger(round.trigger);
      const inspectPromises = engines.map(engine => {
        const child = pairValue.children.find(item => item.type === engine.type);
        return inspectAndContinue(child, engine, triggerFrom, round[engine.key] = {});
      });
      await Promise.all(inspectPromises);
      assert.equal(await deadline(roundName + '广播完成', () => broadcast.completion, 15000), 0);
      assert.match(round.trigger.stdout, new RegExp('pid=' + pid + ';java=43;native=43'));
      round.pause = {};
      for (const engine of engines) {
        const child = pairValue.children.find(item => item.type === engine.type);
        const cursor = messages.length;
        const pause = round.pause[engine.key] = {};
        pause.request = await request(child, 'pause', { threadId: round[engine.key].threadId });
        pause.stopped = await waitStopped(child, engine.key + ' pause停止', cursor);
        pause.continue = await request(child, 'continue', { threadId: pause.stopped.message.body.threadId });
      }
      round.breakpointsAfterTrigger = Object.fromEntries(engines.map(engine => [engine.key, breakpointStatus(pairValue.children.find(child => child.type === engine.type), engine.line)]));
      assert.ok(engines.every(engine => round.breakpointsAfterTrigger[engine.key].verified), roundName + '实际引擎断点verified不完整');
      round.beforeDisconnect = snapshot(roundName + '-before-disconnect');
      const disconnected = await disconnect(pairValue.parent, roundName);
      round.disconnect = disconnected;
      round.afterDisconnect = disconnected.afterDisconnect;
      assert.equal(round.afterDisconnect.pid, pid, roundName + ' disconnect(false)后PID改变');
      round.status = 'PASS';
      return round;
    } finally {
      if (broadcast?.child.exitCode === null) broadcast.child.kill();
      vscode.debug.removeBreakpoints(currentBreakpoints);
    }
  }

  const tracker = vscode.debug.registerDebugAdapterTrackerFactory('*', {
    createDebugAdapterTracker(session) {
      if (!isOwned(session)) return;
      return {
        onWillReceiveMessage: message => record(session, 'client-to-adapter', { message }),
        onDidSendMessage: message => record(session, 'adapter-to-client', { message }),
        onError: error => record(session, 'adapter-error', { error: String(error.stack || error) }),
        onExit: (code, signal) => record(session, 'adapter-exit', { code, signal }),
      };
    },
  });
  const started = vscode.debug.onDidStartDebugSession(session => {
    if (!isOwned(session)) return;
    active.set(session.id, session);
    observed.set(session.id, session);
    record(session, 'vscode-start', {});
  });
  const ended = vscode.debug.onDidTerminateDebugSession(session => {
    if (!observed.has(session.id)) return;
    active.delete(session.id);
    const item = { id: session.id, type: session.type, name: session.configuration.name, parentId: session.parentSession?.id || null, at: new Date().toISOString() };
    terminations.push(item);
    record(session, 'vscode-terminate', item);
    persist();
  });

  try {
    const extension = vscode.extensions.getExtension('liangjunheng.vscode-android-ide');
    assert.ok(extension, '宿主未加载目标扩展');
    assert.equal(fs.realpathSync(extension.extensionPath).toLowerCase(), fs.realpathSync(spec.extensionRoot).toLowerCase(), '宿主加载的不是本次开发扩展目录');
    await deadline('扩展激活', () => extension.activate(), 20000);
    assert.ok(vscode.workspace.workspaceFolders?.length, '隔离workspace未打开');

    await phase('attach-1', item => attachPhase('attach-1', spec.pid), { name: 'attach-1', status: 'RUNNING', startedAt: new Date().toISOString() });
    await phase('attach-2', item => attachPhase('attach-2', spec.pid), { name: 'attach-2', status: 'RUNNING', startedAt: new Date().toISOString() });

    await phase('launch', async item => {
      const tag = 'task62-launch-' + spec.mode + '-launch';
      const currentBreakpoints = engines.map(engine => new vscode.SourceBreakpoint(new vscode.Location(vscode.Uri.file(engine.source), new vscode.Position(engine.line - 1, 0))));
      vscode.debug.addBreakpoints(currentBreakpoints);
      let broadcast;
      try {
        const launchConfig = {
          type: 'android-debug', request: 'launch', name: tag, mode: spec.mode, serial: spec.serial, target: spec.serial,
          packageName: spec.packageName, launchActivity: spec.activity, apkPath: spec.apk,
          androidProjectRoot: spec.workspace, projectRoot: spec.workspace, sourcePaths: [spec.sourceRoot],
          java: { name: tag + '-jvm', sourcePaths: [spec.sourceRoot] },
          native: { sdkRoot: spec.sdk, ndkRoot: spec.ndk, abi: 'arm64-v8a', symbolSearchPaths: [] },
        };
        item.launchStartedAt = new Date().toISOString();
        const launchValue = await deadline('生产launch startDebugging', () => start(launchConfig, 'launch'), spec.launchDiagnosticBudgetMs || 45000);
        assert.equal(launchValue, true, '生产launch原始startDebugging返回false');
        item.startSettledAt = new Date().toISOString();
        const newPid = await waitFor('生产launch新PID', () => {
          const currentPid = processPid();
          return currentPid > 0 && currentPid !== spec.pid ? currentPid : false;
        }, 15000);
        assert.ok(newPid > 0, '生产launch后未取得新PID');
        assert.notEqual(newPid, spec.pid, '生产launch后PID未迁移');
        outcome.newPid = newPid;
        const pairValue = await pair(tag);
        item.parent = { id: pairValue.parent.id, type: pairValue.parent.type, name: pairValue.parent.configuration.name };
        item.children = pairValue.children.map(child => ({ id: child.id, type: child.type, name: child.configuration.name }));
        await waitFor('生产launch全部setBreakpoints响应', () => engines.every(engine => sessionMessages(pairValue.children.find(child => child.type === engine.type)).some(message => message.message?.type === 'response' && message.message.command === 'setBreakpoints')));
        item.breakpointsBeforeTrigger = Object.fromEntries(engines.map(engine => [engine.key, breakpointStatus(pairValue.children.find(child => child.type === engine.type), engine.line)]));
        const triggerFrom = messages.length;
        item.trigger = {};
        broadcast = trigger(item.trigger);
        await Promise.all(engines.map(engine => inspectAndContinue(pairValue.children.find(child => child.type === engine.type), engine, triggerFrom, item[engine.key] = {})));
        assert.equal(await deadline('生产launch广播完成', () => broadcast.completion, 15000), 0);
        assert.match(item.trigger.stdout, new RegExp('pid=' + newPid + ';java=43;native=43'));
        item.pause = {};
        for (const engine of engines) {
          const child = pairValue.children.find(candidate => candidate.type === engine.type);
          const cursor = messages.length;
          const pause = item.pause[engine.key] = {};
          pause.request = await request(child, 'pause', { threadId: item[engine.key].threadId });
          pause.stopped = await waitStopped(child, engine.key + ' launch pause停止', cursor);
          pause.continue = await request(child, 'continue', { threadId: pause.stopped.message.body.threadId });
        }
        item.breakpointsAfterTrigger = Object.fromEntries(engines.map(engine => [engine.key, breakpointStatus(pairValue.children.find(child => child.type === engine.type), engine.line)]));
        assert.ok(engines.every(engine => item.breakpointsAfterTrigger[engine.key].verified), '生产launch实际引擎断点verified不完整');
        item.beforeDisconnect = snapshot('launch-before-disconnect');
        const disconnected = await disconnect(pairValue.parent, 'launch');
        item.disconnect = disconnected;
        item.afterDisconnect = disconnected.afterDisconnect;
        assert.equal(item.afterDisconnect.pid, newPid, '生产launch disconnect(false)后新PID改变');
      } finally {
        if (broadcast?.child.exitCode === null) broadcast.child.kill();
        vscode.debug.removeBreakpoints(currentBreakpoints);
      }
    }, { name: 'launch', status: 'RUNNING', startedAt: new Date().toISOString() });

    await phase('reattach', async item => {
      const round = await attachPhase('reattach', outcome.newPid, true);
      Object.assign(item, round);
    }, { name: 'reattach', status: 'RUNNING', startedAt: new Date().toISOString() });
    outcome.status = 'COMPLETED';
    outcome.stage = 'complete';
  } catch (error) {
    outcome.status = 'FAILED';
    outcome.error = String(error.stack || error);
    outcome.failedAt = new Date().toISOString();
    if (outcome.notExecuted.length === 0) outcome.notExecuted.push(...phaseNames.slice(currentPhaseIndex + 1));
    persist();
  } finally {
    clearInterval(snapshotTimer);
    const cleanupDeadline = Date.now() + 45000;
    while (Date.now() < cleanupDeadline) {
      const parents = [...active.values()].filter(session => session.type === 'android-debug' && session.configuration.name?.startsWith('task62-launch-'));
      for (const parent of parents) {
        try {
          await disconnect(parent, 'failure-cleanup-' + parent.id, cleanupDeadline);
        } catch (error) {
          outcome.cleanup ??= [];
          outcome.cleanup.push({ parentId: parent.id, warning: '精确父会话清理失败', error: String(error.stack || error) });
        }
      }
      const pending = Object.values(starts).some(item => item.state === 'pending');
      const stillOwned = [...active.values()].some(session => session.configuration.name?.startsWith('task62-launch-') || session.parentSession?.configuration?.name?.startsWith('task62-launch-'));
      if (!pending && !stillOwned) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    outcome.stillActive = [...active.values()].map(session => ({ id: session.id, type: session.type, name: session.configuration.name }));
    const pendingStarts = Object.entries(starts).filter(([, item]) => item.state === 'pending').map(([key]) => key);
    if (outcome.stillActive.length || pendingStarts.length) {
      outcome.status = 'FAILED';
      outcome.cleanup ??= [];
      outcome.cleanup.push({ warning: '清理期限结束时仍有活动会话或未结算启动', sessions: outcome.stillActive, pendingStarts });
    }
    outcome.endedAt = new Date().toISOString();
    persist();
    tracker.dispose();
    started.dispose();
    ended.dispose();
    cp.spawn = originalSpawn;
    for (const child of coordinatorProcesses) child.stdin?.end();
    try {
      const closed = await deadline('Coordinator EOF关闭', () => Promise.all(coordinatorCloses), 15000);
      assert.ok(closed.every(item => item.exitCode === 0 && !item.signal), 'Coordinator未正常退出: ' + JSON.stringify(closed));
    } catch (error) {
      outcome.status = 'FAILED';
      (outcome.cleanup ??= []).push({ error: String(error.stack || error) });
    }
    for (const { source, listener } of coordinatorSources) source.off('data', listener);
    dapLog.end();
    deviceLog.end();
    for (const stream of coordinatorLogs) stream.end();
    const writeErrors = (await Promise.all([dapWritten, deviceWritten, ...coordinatorWritten])).filter(Boolean);
    if (writeErrors.length) {
      outcome.status = 'FAILED';
      outcome.logErrors = writeErrors.map(String);
    }
    persist();
  }
};
