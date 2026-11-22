const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');

/** 功能点：真实 VS Code 宿主六组合调试。
 * 受影响对象：扩展注册、父 DAP、JVM/CodeLLDB 子会话和 Coordinator。
 * 复现路径：授权专用设备，构建 Java/JNI fixture，由 coordinator-device-host.test.js 启动隔离宿主。
 * 测试范围：三模式Launch/Attach、Dual两侧独立断点/源码帧/变量/单步、精确子终止及转发回收。
 * 执行入口：ANDROID_COORDINATOR_DEVICE_TEST=1 npm test。
 * 预期结果：六组合均建立真实后端并命中源码断点，关闭无残留子会话。
 * 判据：实际 DAP、源码位置和结束事件均符合断言，否则记录错误并失败。
 */
exports.run = async function run() {
  const vscode = require('vscode');
  const result = process.env.COORDINATOR_HOST_RESULT;
  const workspace = process.env.COORDINATOR_HOST_WORKSPACE;
  const spec = JSON.parse(fs.readFileSync(process.env.COORDINATOR_HOST_SPEC, 'utf8'));
  const checks = [], messages = [], active = new Map(), stopped = [], waiters = [];
  const text = args => execFileSync(spec.adb, ['-s', spec.serial, ...args], { encoding: 'utf8', windowsHide: true, timeout: 30000 }).trim();
  let starting;
  const javaSource = path.join(spec.sources, 'dev/androidtools/debugfixture/DebugActivity.java');
  const javaLine = fs.readFileSync(javaSource, 'utf8').split(/\r?\n/).findIndex(line => line.includes('JAVA_BREAKPOINT')) + 2;
  const nativeLine = fs.readFileSync(spec.nativeSource, 'utf8').split(/\r?\n/).findIndex(line => line.includes('NATIVE_BREAKPOINT')) + 2;
  const takeStopped = session => {
    const index = stopped.findIndex(item => item.session === session.id);
    if (index >= 0) return Promise.resolve(stopped.splice(index, 1)[0].message);
    return new Promise((resolve, reject) => waiters.push({ id: session.id, resolve, reject }));
  };
  const tracker = vscode.debug.registerDebugAdapterTrackerFactory('*', {
    createDebugAdapterTracker(session) {
      if (!session.configuration.name.startsWith('coordinator-fixture') && !session.parentSession?.configuration.name.startsWith('coordinator-fixture')) return;
      return {
        onDidSendMessage(message) {
          const item = { session: session.id, type: session.type, message }; messages.push(item);
          fs.appendFileSync(result + '.dap.jsonl', JSON.stringify(item) + '\n');
          if (message.event === 'stopped') {
            const index = waiters.findIndex(waiter => waiter.id === session.id);
            if (index >= 0) waiters.splice(index, 1)[0].resolve(message); else stopped.push(item);
          }
        },
        onExit(code) { for (const waiter of waiters.filter(waiter => waiter.id === session.id)) waiter.reject(new Error(session.type + ' exited: ' + code)); },
      };
    },
  });
  const started = vscode.debug.onDidStartDebugSession(session => {
    if (session.configuration.name.startsWith('coordinator-fixture') || session.parentSession?.configuration.name.startsWith('coordinator-fixture')) active.set(session.id, session);
  });
  const ended = vscode.debug.onDidTerminateDebugSession(session => active.delete(session.id));
  const breakpoints = [];
  try {
    const extension = vscode.extensions.getExtension('liangjunheng.vscode-android-ide'); assert.ok(extension); await extension.activate();
    for (const mode of ['java', 'native', 'dual']) for (const request of ['launch', 'attach']) {
      const tag = `coordinator-fixture-${mode}-${request}`;
      fs.appendFileSync(result + '.progress', tag + '\n');
      if (request === 'attach') {
        text(['shell', 'am', 'force-stop', spec.packageName]);
        text(['shell', 'am', 'start', '-D', '-n', spec.packageName + '/' + spec.activity]);
        spec.pid = Number(text(['shell', 'pidof', '-s', spec.packageName])); assert.ok(spec.pid > 0);
      }
      const source = mode === 'native' ? spec.nativeSource : javaSource, line = mode === 'native' ? nativeLine : javaLine;
      const breakpoint = new vscode.SourceBreakpoint(new vscode.Location(vscode.Uri.file(source), new vscode.Position(line - 1, 0)));
      const nativeBreakpoint = mode === 'dual' ? new vscode.SourceBreakpoint(new vscode.Location(vscode.Uri.file(spec.nativeSource), new vscode.Position(nativeLine - 1, 0))) : undefined;
      const currentBreakpoints = nativeBreakpoint ? [breakpoint, nativeBreakpoint] : [breakpoint];
      breakpoints.push(...currentBreakpoints); vscode.debug.addBreakpoints(currentBreakpoints);
      const config = { type: 'android-debug', name: tag, request, mode, serial: spec.serial, target: spec.serial,
        packageName: spec.packageName, launchActivity: spec.activity, ...(request === 'launch' ? { apkPath: spec.apk } : { pid: spec.pid, resumeProcess: mode === 'native' }),
        androidProjectRoot: workspace, sourcePaths: [spec.sources], java: { name: tag + '-jvm', sourcePaths: [spec.sources] },
        native: { sdkRoot: spec.sdk, ndkRoot: spec.ndk, abi: 'arm64-v8a', symbolSearchPaths: [] },
      };
      const ok = await vscode.debug.startDebugging(vscode.workspace.workspaceFolders[0], config);
      assert.equal(ok, true, tag + ' failed: ' + JSON.stringify(messages.slice(-12)));
      const parent = [...active.values()].find(session => session.configuration.name === tag); assert.ok(parent, tag + ' parent absent'); starting = parent;
      const children = [...active.values()].filter(session => session.parentSession?.id === parent.id);
      assert.deepEqual(children.map(session => session.type).sort(), mode === 'java' ? ['android-jvm'] : mode === 'native' ? ['lldb'] : ['android-jvm', 'lldb']);
      const engine = children.find(session => session.type === (mode === 'native' ? 'lldb' : 'android-jvm'));
      const event = await takeStopped(engine); assert.equal(event.body.reason, 'breakpoint');
      const threadId = event.body.threadId;
      const stack = await engine.customRequest('stackTrace', { threadId });
      const frame = stack.stackFrames.find(frame => frame.source?.path && path.resolve(frame.source.path).toLowerCase() === path.resolve(source).toLowerCase());
      assert.ok(frame, 'source frame missing'); assert.equal(frame.line, line);
      const scopes = await engine.customRequest('scopes', { frameId: frame.id });
      const variables = await engine.customRequest('variables', { variablesReference: scopes.scopes.find(scope => /local/i.test(scope.name)).variablesReference });
      assert.ok(variables.variables.some(variable => variable.name === 'value'), 'actual local variable missing');
      await engine.customRequest('next', { threadId });
      const step = await takeStopped(engine); assert.equal(step.body.reason, 'step');
      let nativeChecked = mode === 'native';
      if (mode === 'dual') {
        const native = children.find(session => session.type === 'lldb');
        await engine.customRequest('continue', { threadId });
        const nativeStop = await takeStopped(native); assert.equal(nativeStop.body.reason, 'breakpoint');
        const nativeStack = await native.customRequest('stackTrace', { threadId: nativeStop.body.threadId });
        const nativeFrame = nativeStack.stackFrames.find(frame => frame.source?.path && path.resolve(frame.source.path).toLowerCase() === path.resolve(spec.nativeSource).toLowerCase());
        assert.ok(nativeFrame, 'Dual Native source frame missing'); assert.equal(nativeFrame.line, nativeLine);
        const nativeScopes = await native.customRequest('scopes', { frameId: nativeFrame.id });
        const nativeVariables = await native.customRequest('variables', { variablesReference: nativeScopes.scopes.find(scope => /local/i.test(scope.name)).variablesReference });
        assert.ok(nativeVariables.variables.some(variable => variable.name === 'value'), 'Dual Native value missing');
        await native.customRequest('next', { threadId: nativeStop.body.threadId });
        assert.equal((await takeStopped(native)).body.reason, 'step'); nativeChecked = true;
      }
      for (const child of children) { const threads = await child.customRequest('threads', {}); assert.ok(threads.threads?.length, child.type + ' has no real threads'); }
      const terminated = new Promise(resolve => { const subscription = vscode.debug.onDidTerminateDebugSession(session => { if (session.id === parent.id) { subscription.dispose(); resolve(); } }); });
      await vscode.debug.stopDebugging(parent); await terminated;
      assert.equal([...active.values()].some(session => session.parentSession?.id === parent.id), false);
      starting = undefined; vscode.debug.removeBreakpoints(currentBreakpoints);
      checks.push({ mode, request, children: children.map(session => session.type), threads: true, breakpoint: frame.line, variables: true, step: true, nativeChecked });
    }
    fs.writeFileSync(result, JSON.stringify({ success: true, checks }));
  } catch (error) { fs.writeFileSync(result, JSON.stringify({ success: false, checks, error: String(error.stack ?? error), messages: messages.slice(-20) })); throw error; }
  finally {
    if (starting) await vscode.debug.stopDebugging(starting);
    vscode.debug.removeBreakpoints(breakpoints); tracker.dispose(); started.dispose(); ended.dispose();
  }
};
