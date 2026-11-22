const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

/**
 * 功能点：真实 VS Code 宿主中按 java、native、dual 三模式对同一 PID 进行三轮 reattach。
 * 受影响对象：本模式唯一 fixture、唯一宿主、父 DAP 会话、实际 JVM/LLDB 子会话及原始 DAP 请求链。
 * 复现路径：设备测试已完成一次普通 am start；每轮 attach 后触发显式广播，检查 verified、源码 frame、value=41，单步到下一源码行得到 value=42，再 continue、pause，最后由父会话 disconnect(false)。
 * 测试范围：三模式独立宿主和唯一包；迟到启动、父子终止、同PID、新事件cursor及资源基线；DAP流式写入且退出前等待完整落盘，避免同步逐条I/O污染计时；pending或active禁止后续轮次。
 * 执行入口：由 coordinator-reattach-device.test.js 以 ANDROID_COORDINATOR_REATTACH_TEST=1 启动本文件。
 * 预期结果：三轮全部 PASS，原始启动 Promise 必须结算，父会话必须精确发送 disconnect(false)，父子会话全部真实终止且 fixture PID 保持不变。
 * 判据：任一真实 DAP、Promise、termination、PID 或资源状态不满足即 FAIL；不伪造父会话成功，不重启应用，不 retry。
 */
exports.run = async function run() {
  const vscode = require('vscode');
  const resultFile = process.env.COORDINATOR_REATTACH_HOST_RESULT;
  const spec = JSON.parse(fs.readFileSync(process.env.COORDINATOR_REATTACH_HOST_SPEC, 'utf8'));
  const checks = [];
  const messages = [];
  const dapLog = fs.createWriteStream(resultFile + '.dap.jsonl');
  const dapWritten = require('node:stream/promises').finished(dapLog).then(() => undefined, error => error);
  const sessions = new Map();
  const observed = new Map();
  const terminations = [];
  const consumed = new Map();
  /** 功能：生成当前宿主结果；输入无；输出三轮成功状态和全部证据索引；验证：只有三轮 PASS 才允许宿主 exit 0。 */
  const result = () => ({
    success: checks.length === 3 && checks.every(item => item.status === 'PASS'),
    mode: spec.mode,
    checks,
    packageName: spec.packageName,
    pid: spec.pid,
    source: { java: spec.javaSource, javaLine, native: spec.nativeSource, nativeLine },
  });
  const adb = args => execFileSync(spec.adb, ['-s', spec.serial, ...args], { encoding: 'utf8', windowsHide: true, timeout: 5000 }).trim();
  const javaLine = fs.readFileSync(spec.javaSource, 'utf8').split(/\r?\n/).findIndex(line => line.includes('JAVA_BREAKPOINT')) + 2;
  const nativeLine = fs.readFileSync(spec.nativeSource, 'utf8').split(/\r?\n/).findIndex(line => line.includes('NATIVE_BREAKPOINT')) + 2;
  const engines = [
    ...(spec.mode !== 'native' ? [{ type: 'android-jvm', key: 'java', source: spec.javaSource, line: javaLine }] : []),
    ...(spec.mode !== 'java' ? [{ type: 'lldb', key: 'native', source: spec.nativeSource, line: nativeLine }] : []),
  ];
  const hostDeadline = Date.now() + spec.hostBudgetMs - 10000;
  let roundDeadline = Infinity;

  /** 功能：记录自有会话的双向原始 DAP；输入会话、方向和消息；输出追加证据文件，验证请求链可复核。 */
  function record(session, direction, extra) {
    const item = { index: messages.length, at: new Date().toISOString(), direction, session: session.id, type: session.type, name: session.configuration.name, ...extra };
    messages.push(item);
    dapLog.write(JSON.stringify(item) + '\n');
  }

  /** 功能：等待有限期限；输入标签、Promise 工厂、超时和清理标记；输出原始 Promise 结果且不取消底层操作。 */
  async function deadline(label, operation, timeout = 12000, cleanup = false) {
    const budget = Math.min(timeout, (cleanup ? hostDeadline : roundDeadline) - Date.now());
    if (budget <= 0) throw new Error(label + ' 阶段预算耗尽');
    let timer;
    try {
      return await Promise.race([
        Promise.resolve().then(operation),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label + ' diagnostic deadline ' + budget + 'ms')), budget); }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** 功能：只轮询新事件；输入标签、谓词、超时和清理标记；输出首次满足谓词的事件，错误或超时均保留失败状态。 */
  async function waitFor(label, predicate, timeout = 12000, cleanup = false) {
    const expires = Math.min(Date.now() + timeout, cleanup ? hostDeadline : roundDeadline);
    while (Date.now() < expires) {
      const value = predicate();
      if (value) return value;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error(label + ' diagnostic deadline ' + timeout + 'ms');
  }

  /** 功能：发送真实 DAP 请求并关联原始 request/response；输入会话、命令、参数和清理标记；输出结果及可复核报文。 */
  async function request(session, command, args, cleanup = false) {
    const from = messages.length;
    const value = await deadline(session.type + '.' + command, () => session.customRequest(command, args), cleanup ? 10000 : 12000, cleanup);
    const sent = messages.slice(from).find(item => item.session === session.id && item.direction === 'client-to-adapter' && item.message?.type === 'request' && item.message.command === command);
    const response = sent && messages.slice(from).find(item => item.session === session.id && item.message?.type === 'response' && item.message.request_seq === sent.message.seq && item.message.command === command);
    if (!sent || !response || response.message.success !== true) throw new Error(session.type + '.' + command + ' 缺少完整成功DAP请求响应链');
    return { value, sent, response };
  }

  /** 功能：等待当前子会话的新 stopped；输入子会话、标签、消息起点和原因；输出未消费事件，禁止复用旧 cursor。 */
  async function waitStopped(child, label, from, reason) {
    const start = Math.max(from, consumed.get(child.id) || 0);
    const event = await waitFor(label, () => messages.slice(start).find(item => item.session === child.id && item.direction === 'adapter-to-client' && item.message?.event === 'stopped' && (!reason || item.message.body?.reason === reason)));
    consumed.set(child.id, event.index + 1);
    return event;
  }

  /** 功能：读取唯一 fixture 的 PID；输入无；输出当前 PID，只有 pidof 无输出退出 1 才解释为不存在。 */
  function processPid() {
    try {
      return Number(adb(['shell', 'pidof', '-s', spec.packageName]) || 0);
    } catch (error) {
      if (error.status === 1 && !String(error.stdout || '').trim() && !String(error.stderr || '').trim()) return 0;
      throw error;
    }
  }

  /** 功能：取得本次 fixture 的资源快照；输入无；输出 PID、forward 和自有进程行，供断开后同 PID 及 server 检查。 */
  function snapshot() {
    return {
      at: new Date().toISOString(),
      pid: processPid(),
      forward: adb(['forward', '--list']),
      processes: adb(['shell', 'ps', '-A', '-o', 'PID,ARGS']).split(/\r?\n/).filter(line => line.includes(spec.packageName) || line.includes('lldb-server')),
    };
  }

  /** 功能：筛选当前子会话消息；输入实际子会话；输出原始DAP证据；验证：本入口断点和单步断言。 */
  function sessionMessages(child) { return messages.filter(item => item.session === child.id); }

  /** 功能：筛选当前引擎断点的真实 verified 响应和事件；输入子会话及源码行；输出完整响应、事件和 verified 结论。 */
  function breakpointStatus(child, line) {
    const response = messages.filter(item => item.session === child.id && item.message?.command === 'setBreakpoints' && item.message.type === 'response').flatMap(item => item.message.body?.breakpoints || []);
    const events = messages.filter(item => item.session === child.id && item.message?.event === 'breakpoint').map(item => item.message.body?.breakpoint).filter(Boolean);
    return { response, events, verified: [...response, ...events].some(item => item.verified === true && item.line === line) };
  }

  /** 功能：检查断点 stopped 的真实源码 frame 和 value=41；输入子会话、引擎、消息起点和证据对象；输出线程及变量证据。 */
  async function inspect(child, engine, from, evidence) {
    evidence.stopped = await waitStopped(child, engine.key + ' marker', from, 'breakpoint');
    evidence.threadId = evidence.stopped.message.body.threadId;
    evidence.threads = await request(child, 'threads', {});
    evidence.stack = await request(child, 'stackTrace', { threadId: evidence.threadId, levels: 20 });
    evidence.frame = evidence.stack.value?.stackFrames?.find(frame => frame.source?.path && path.resolve(frame.source.path).toLowerCase() === path.resolve(engine.source).toLowerCase() && frame.line === engine.line);
    if (!evidence.frame) throw new Error(engine.key + ' 缺少真实源码 frame: ' + JSON.stringify({ source: engine.source, line: engine.line, stack: evidence.stack.value }));
    evidence.scopes = await request(child, 'scopes', { frameId: evidence.frame.id });
    const local = evidence.scopes.value?.scopes?.find(scope => /local/i.test(scope.name));
    if (!local) throw new Error(engine.key + ' 缺少 Local scope');
    evidence.variables = await request(child, 'variables', { variablesReference: local.variablesReference });
    if (!evidence.variables.value?.variables?.some(variable => variable.name === 'value' && /^41(?:\b|$)/.test(variable.value))) throw new Error(engine.key + ' 缺少真实 value=41: ' + JSON.stringify(evidence.variables.value));
  }

  /** 功能：异步触发唯一 fixture 的显式广播；输入本轮证据对象；输出 adb 子进程及原始完成 Promise，不启动 Activity。 */
  function trigger(evidence) {
    const args = ['-s', spec.serial, 'shell', 'am', 'broadcast', '--receiver-foreground', '-n', spec.packageName + '/dev.androidtools.debugfixture.TriggerReceiver', '-a', spec.packageName + '.TRIGGER'];
    evidence.args = args;
    evidence.startedAt = new Date().toISOString();
    evidence.stdout = '';
    evidence.stderr = '';
    const child = require('node:child_process').spawn(spec.adb, args, { windowsHide: true });
    child.stdout.on('data', data => { evidence.stdout += data; });
    child.stderr.on('data', data => { evidence.stderr += data; });
    child.on('error', error => { evidence.error = String(error); });
    const completion = new Promise(resolve => child.on('close', code => { evidence.exit = code; evidence.endedAt = new Date().toISOString(); resolve(code); }));
    return { child, completion };
  }

  /** 功能：即时写入本轮结论；输入无；输出 result JSON，成功只允许三轮且每轮 PASS。 */
  function persist() {
    fs.writeFileSync(resultFile, JSON.stringify(result(), null, 2) + '\n');
  }

  /** 功能：登记被阻塞的剩余轮次；输入首个轮次和真实原因；输出未执行结论，禁止 pending/active 后继续。 */
  function notExecuted(first, reason) {
    for (let round = first; round <= 3; round++) checks.push({ round, status: '未执行', reason });
    persist();
  }

  /** 功能：判断会话是否属于当前唯一测试标签；输入会话和标签；输出布尔值，避免接纳无父子关系的伪造父会话。 */
  function belongs(session, tag) {
    return session.configuration.name === tag || session.parentSession?.configuration?.name === tag;
  }

  const tracker = vscode.debug.registerDebugAdapterTrackerFactory('*', {
    createDebugAdapterTracker(session) {
      if (!session.configuration.name.startsWith('same-pid-reattach-') && !session.parentSession?.configuration?.name.startsWith('same-pid-reattach-')) return;
      return {
        onWillReceiveMessage: message => record(session, 'client-to-adapter', { message }),
        onDidSendMessage: message => record(session, 'adapter-to-client', { message }),
        onError: error => record(session, 'adapter-error', { error: String(error.stack || error) }),
        onExit: (code, signal) => record(session, 'adapter-exit', { code, signal }),
      };
    },
  });
  const started = vscode.debug.onDidStartDebugSession(session => {
    if (!session.configuration.name.startsWith('same-pid-reattach-') && !session.parentSession?.configuration?.name.startsWith('same-pid-reattach-')) return;
    sessions.set(session.id, session);
    observed.set(session.id, session);
    record(session, 'vscode-start', { parentId: session.parentSession?.id || null });
  });
  const ended = vscode.debug.onDidTerminateDebugSession(session => {
    if (!observed.has(session.id)) return;
    terminations.push({ id: session.id, type: session.type, name: session.configuration.name, parentId: session.parentSession?.id || null, at: new Date().toISOString() });
    fs.appendFileSync(resultFile + '.termination.jsonl', JSON.stringify(terminations.at(-1)) + '\n');
    sessions.delete(session.id);
  });

  try {
    const extension = vscode.extensions.getExtension('liangjunheng.vscode-android-ide');
    if (!extension) throw new Error('宿主未加载目标扩展');
    if (fs.realpathSync(extension.extensionPath).toLowerCase() !== fs.realpathSync(spec.extensionRoot).toLowerCase()) throw new Error('宿主加载的不是本次开发扩展目录');
    roundDeadline = Date.now() + 20000;
    await deadline('扩展激活', () => extension.activate(), 20000);
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) throw new Error('隔离 workspace 未打开');

    for (let round = 1; round <= 3; round++) {
      const tag = 'same-pid-reattach-' + spec.mode + '-round-' + round;
      roundDeadline = Date.now() + Math.floor((hostDeadline - Date.now()) / (4 - round)) - 15000;
      const evidence = { round, tag, expectedPid: spec.pid, startedAt: new Date().toISOString(), messagesStart: messages.length, terminationStart: terminations.length, status: 'RUNNING' };
      checks.push(evidence);
      persist();
      let currentBreakpoints = [];
      let broadcast;
      let disconnect;
      let startPromise;
      try {
        evidence.before = snapshot();
        if (evidence.before.pid !== spec.pid) throw new Error('attach 前 PID 改变: ' + evidence.before.pid);
        currentBreakpoints = engines.map(engine => new vscode.SourceBreakpoint(new vscode.Location(vscode.Uri.file(engine.source), new vscode.Position(engine.line - 1, 0))));
        vscode.debug.addBreakpoints(currentBreakpoints);
        const config = {
          type: 'android-debug', request: 'attach', name: tag, mode: spec.mode, serial: spec.serial, target: spec.serial,
          pid: spec.pid, processId: spec.pid, packageName: spec.packageName, launchActivity: spec.activity,
          androidProjectRoot: spec.workspace, projectRoot: spec.workspace, sourcePaths: [spec.sourceRoot],
          java: { name: tag + '-jvm', sourcePaths: [spec.sourceRoot] },
          native: { sdkRoot: spec.sdk, ndkRoot: spec.ndk, abi: 'arm64-v8a', symbolSearchPaths: [] },
        };
        evidence.config = config;
        evidence.startRaw = { state: 'pending', calledAt: new Date().toISOString() };
        startPromise = Promise.resolve().then(() => vscode.debug.startDebugging(folder, config)).then(value => {
          Object.assign(evidence.startRaw, { state: 'fulfilled', value, settledAt: new Date().toISOString() });
          fs.appendFileSync(resultFile + '.start-promise.jsonl', JSON.stringify({ round, ...evidence.startRaw }) + '\n');
          persist();
          return value;
        }, error => {
          Object.assign(evidence.startRaw, { state: 'rejected', error: String(error.stack || error), settledAt: new Date().toISOString() });
          fs.appendFileSync(resultFile + '.start-promise.jsonl', JSON.stringify({ round, ...evidence.startRaw }) + '\n');
          persist();
          throw error;
        });
        startPromise.catch(() => undefined);
        evidence.startDebugging = await deadline('startDebugging', () => startPromise, 25000);
        if (!evidence.startDebugging) throw new Error('startDebugging 返回 false');
        const parent = await waitFor('父会话', () => [...sessions.values()].find(session => session.configuration.name === tag));
        evidence.parent = { id: parent.id, type: parent.type, name: parent.configuration.name };
        const children = await waitFor('该模式全部实际引擎', () => {
          const found = [...sessions.values()].filter(session => session.parentSession?.id === parent.id);
          return engines.every(engine => found.some(session => session.type === engine.type)) ? found : false;
        }, 25000);
        evidence.children = children.map(session => ({ id: session.id, type: session.type, name: session.configuration.name }));
        if (children.length !== engines.length) throw new Error('父会话子引擎数量不匹配: ' + JSON.stringify(evidence.children));
        evidence.afterAttach = snapshot();
        await waitFor('全部实际引擎 setBreakpoints 响应', () => engines.every(engine => sessionMessages(children.find(child => child.type === engine.type)).some(item => item.message?.type === 'response' && item.message.command === 'setBreakpoints')));
        evidence.breakpointsBeforeTrigger = Object.fromEntries(engines.map(engine => [engine.key, breakpointStatus(children.find(child => child.type === engine.type), engine.line)]));
        let from = messages.length;
        evidence.trigger = {};
        broadcast = trigger(evidence.trigger);
        for (const engine of engines) {
          const child = children.find(item => item.type === engine.type);
          const detail = evidence[engine.key] = {};
          await inspect(child, engine, from, detail);
          const stepCursor = messages.length;
          detail.next = await request(child, 'next', { threadId: detail.threadId });
          detail.stepStopped = await waitStopped(child, engine.key + ' 单步停止', stepCursor, 'step');
          detail.stepStack = await request(child, 'stackTrace', { threadId: detail.stepStopped.message.body.threadId, levels: 20 });
          const stepFrame = detail.stepStack.value?.stackFrames?.find(frame => frame.source?.path && path.resolve(frame.source.path).toLowerCase() === path.resolve(engine.source).toLowerCase() && frame.line === engine.line + 1);
          if (!stepFrame) throw new Error(engine.key + ' 单步未进入下一源码行: ' + JSON.stringify(detail.stepStack.value));
          detail.stepScopes = await request(child, 'scopes', { frameId: stepFrame.id });
          const stepLocal = detail.stepScopes.value?.scopes?.find(scope => /local/i.test(scope.name));
          if (!stepLocal) throw new Error(engine.key + ' 单步后缺少 Local scope');
          detail.stepVariables = await request(child, 'variables', { variablesReference: stepLocal.variablesReference });
          if (!detail.stepVariables.value?.variables?.some(variable => variable.name === 'value' && /^42(?:\b|$)/.test(variable.value))) throw new Error(engine.key + ' 单步后缺少真实 value=42: ' + JSON.stringify(detail.stepVariables.value));
          from = messages.length;
          detail.continue = await request(child, 'continue', { threadId: detail.stepStopped.message.body.threadId });
        }
        await deadline('广播实际执行完成', () => broadcast.completion);
        if (evidence.trigger.exit !== 0 || !evidence.trigger.stdout.includes('pid=' + spec.pid + ';java=43;native=43')) throw new Error('广播没有完成 marker: ' + evidence.trigger.stdout);
        evidence.pause = {};
        for (const engine of engines) {
          const child = children.find(item => item.type === engine.type);
          const cursor = messages.length;
          const pause = evidence.pause[engine.key] = {};
          pause.request = await request(child, 'pause', { threadId: evidence[engine.key].threadId });
          pause.stopped = await waitStopped(child, engine.key + ' 新 pause stopped', cursor);
          pause.continue = await request(child, 'continue', { threadId: pause.stopped.message.body.threadId });
        }
        evidence.breakpointsAfterTrigger = Object.fromEntries(engines.map(engine => [engine.key, breakpointStatus(children.find(child => child.type === engine.type), engine.line)]));
        if (!engines.every(engine => evidence.breakpointsAfterTrigger[engine.key].verified)) throw new Error('该模式实际引擎断点 verified 不完整');
        evidence.beforeDisconnect = snapshot();
        evidence.status = 'PASS';
      } catch (error) {
        evidence.status = 'FAIL';
        evidence.error = String(error.stack || error);
      } finally {
        try {
          await waitFor('启动 Promise 结算及全部真实父子 termination', () => {
            const parent = [...sessions.values()].find(session => session.configuration.name === tag);
            if (parent && !disconnect) {
              disconnect = request(parent, 'disconnect', { terminateDebuggee: false }, true).then(value => {
                evidence.disconnect = value;
                const args = value.sent?.message?.arguments;
                if (value.sent?.session !== parent.id || args?.terminateDebuggee !== false) {
                  evidence.disconnectError = 'disconnect 未由精确父会话发送 terminateDebuggee=false';
                  evidence.status = 'FAIL';
                }
              }, error => {
                evidence.disconnectError = String(error.stack || error);
                evidence.status = 'FAIL';
              });
            }
            return evidence.startRaw?.state !== 'pending' && [...observed.values()].filter(session => belongs(session, tag)).every(session => terminations.some(item => item.id === session.id)) && ![...sessions.values()].some(session => belongs(session, tag));
          }, 30000, true);
        } catch (error) {
          evidence.terminationError = String(error.stack || error);
          evidence.status = 'FAIL';
        }
        if (disconnect) await disconnect;
        evidence.observedSessions = [...observed.values()].filter(session => belongs(session, tag)).map(session => ({ id: session.id, type: session.type, parentId: session.parentSession?.id || null }));
        evidence.terminations = terminations.slice(evidence.terminationStart);
        evidence.stillActive = [...sessions.values()].filter(session => belongs(session, tag)).map(session => ({ id: session.id, type: session.type }));
        if (evidence.startRaw?.state === 'pending' || evidence.stillActive.length) evidence.status = 'FAIL';
        const observedIds = new Set(evidence.observedSessions.map(session => session.id));
        if (!evidence.parent || !observedIds.has(evidence.parent.id) || !evidence.children?.every(child => observedIds.has(child.id)) || !evidence.children?.every(child => evidence.terminations.some(item => item.id === child.id)) || !evidence.terminations.some(item => item.id === evidence.parent?.id)) evidence.status = 'FAIL';
        if (broadcast && broadcast.child.exitCode === null) { broadcast.child.kill(); evidence.trigger.adbClientStoppedByCleanup = true; }
        try {
          evidence.afterDisconnect = snapshot();
          const forwardRows = text => text.split(/\r?\n/).filter(Boolean).sort();
          if (JSON.stringify(forwardRows(evidence.afterDisconnect.forward)) !== JSON.stringify(forwardRows(spec.baseline))) {
            evidence.resourceError = '断开后forward未精确恢复本模式基线';
            evidence.status = 'FAIL';
          }
          if (evidence.afterDisconnect.processes.some(line => line.includes('/' + spec.packageName + '/') && line.includes('/lldb-server'))) {
            evidence.resourceError = '断开后本次包仍有lldb-server';
            evidence.status = 'FAIL';
          }
          if (evidence.afterDisconnect.pid !== spec.pid || (evidence.afterAttach && evidence.afterAttach.pid !== spec.pid)) {
            evidence.pidError = '已取得的快照中fixture PID不等于原PID';
            evidence.status = 'FAIL';
          }
          if (!evidence.afterAttach) {
            evidence.attachSnapshotNotExecuted = true;
            evidence.status = 'FAIL';
          }
        } catch (error) {
          evidence.snapshotError = String(error.stack || error);
          evidence.status = 'FAIL';
        }
        vscode.debug.removeBreakpoints(currentBreakpoints);
        evidence.messagesEnd = messages.length;
        evidence.messageCount = messages.length - evidence.messagesStart;
        evidence.finishedAt = new Date().toISOString();
        persist();
      }
      if (evidence.startRaw?.state === 'pending' || evidence.stillActive?.length || evidence.afterDisconnect?.pid !== spec.pid || evidence.resourceError) {
        notExecuted(round + 1, '上一轮启动或清理未完成、资源残留或原PID改变；禁止继续: ' + JSON.stringify({ startRaw: evidence.startRaw, stillActive: evidence.stillActive, pid: evidence.afterDisconnect?.pid, resourceError: evidence.resourceError }));
        break;
      }
    }
  } catch (error) {
    fs.appendFileSync(resultFile + '.cleanup.log', 'W 模式前置阻塞: ' + String(error.stack || error) + '\n');
    notExecuted(checks.length + 1, String(error.stack || error));
  } finally {
    fs.writeFileSync(resultFile + '.summary.json', JSON.stringify({ checks, allMessages: messages.length, terminations, stillActive: [...sessions.keys()] }, null, 2) + '\n');
    persist();
    tracker.dispose();
    started.dispose();
    ended.dispose();
    dapLog.end();
    const writeError = await dapWritten;
    if (writeError) throw new Error('原始DAP证据写入失败', { cause: writeError });
  }
};

