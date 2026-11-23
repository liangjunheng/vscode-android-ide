const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { transformSync } = require('esbuild');
const autoModule = { exports: {} };
vm.runInNewContext(transformSync(fs.readFileSync(path.join(__dirname, '../src/android-debugger/autoConfig.ts'), 'utf8'), { loader: 'ts', format: 'cjs' }).code,
  { module: autoModule, exports: autoModule.exports });

/** 功能点：Android 配置选择及宿主启动取消的清理归属。
 * 受影响对象：index.ts 的配置与启动 API、startup.ts 登记及 VS Code 启动和终止监听。
 * 复现路径：Node>=22，隔离宿主边界加载真实模块；独立挂起 startDebugging 和 connected，报告转换类型会话后拒绝、抛错、取消或终止，再释放宿主、连接与 termination。
 * 测试范围：六配置、真实连接成功/失败/取消、类型转换、严格PID/package身份、start后false/throws/立即终止、同ID去重、foreign child隔离、stop失败传播及逐会话终止门闩。
 * 执行入口：node --test tests/android-debugger-configurations.test.js；npm test。
 * 预期结果：调用方取消立即拒绝，清理等待宿主结算与每个真实 termination，所有监听最终释放。
 * 判据：Promise 状态、精确停止对象、次数、registry 信号和监听数全部符合断言；不替代宿主或设备实测。
 */
// 功能：隔离宿主并捕获可见警告；输入可控配置和事件；输出真实 registry、连接报告、精确停止及警告记录，供本文件全部用例使用。
function fixture() {
  const f = { configs: [], pick: 0, starts: [], events: [], disposed: 0, accept: true, trusted: true, reportSession: true,
    startListeners: new Set(), endListeners: new Set(), stops: [] };
  f.report = session => { for (const listener of [...f.startListeners]) listener(session); };
  f.terminate = session => { for (const listener of [...f.endListeners]) listener(session); };
  const vscode = {
    workspace: { get isTrusted() { return f.trusted; }, getConfiguration: section => { assert.equal(section, 'launch'); return { get: () => f.configs }; } },
    window: { showErrorMessage: async message => { (f.notices ??= []).push(message); }, showQuickPick: async items => { f.items = items; return f.pick === undefined ? undefined : items[f.pick]; } },
    commands: { async executeCommand(command) { f.events.push(['view',command]); if(f.navigationFailure) throw f.navigationFailure; await f.onFocus?.(); } },
    debug: {
      // 功能：登记宿主start事件；输入监听器；输出只注销自身的订阅，计数仅记录start监听释放。
      onDidStartDebugSession(listener) { f.startListeners.add(listener); return { dispose() { f.disposed++; f.startListeners.delete(listener); } }; },
      // 功能：登记宿主termination事件；输入监听器；输出精确注销对象，不把停止调用当作终止。
      onDidTerminateDebugSession(listener) { f.endListeners.add(listener); return { dispose() { f.endListeners.delete(listener); } }; },
      // 功能：停止指定会话并报告对应termination；输入自有会话；输出精确停止记录及宿主终止事件。
      async stopDebugging(session) { f.stops.push(session); f.terminate(session); },
      // 功能：分别报告宿主 start 与实际连接；输入映射配置；输出转换类型的会话及独立连接 Promise，未报告会话时不伪造连接。
      async startDebugging(folder, config) {
        f.events.push(['start',config.type]); f.starts.push(config); if (f.failure) throw f.failure;
        if (f.accept && f.reportSession) {
          const resolved = { ...config, type: f.resolvedType ?? (config.type === 'android-debug' ? (config.mode === 'java' ? 'android-jvm' : 'android-tools') : config.type), ...(f.resolvedPackage ? { packageName: f.resolvedPackage } : {}), ...(f.resolvedPid ? { pid: f.resolvedPid, processId: f.resolvedPid } : {}) };
          startup.reportDebugConnection(resolved, f.connection ?? Promise.resolve());
          f.report({ id: 'parent-session', configuration: resolved });
        }
        return f.accept;
      },
    },
  };
  const module = { exports: {} };
  const startup = require('./debug-startup-loader.cjs')();
  f.startup = startup;
  vm.runInNewContext(transformSync(fs.readFileSync(path.join(__dirname, '../src/android-debugger/index.ts'), 'utf8'), { loader: 'ts', format: 'cjs' }).code,
    { module, exports: module.exports, AbortController, console: { ...console, warn: (...args) => { (f.warnings ??= []).push(args.map(String).join(' ')); } }, require: id => id === './startup' ? startup : id === 'vscode' ? vscode : id === './autoConfig' ? autoModule.exports : require(id) });
  f.api = module.exports; f.vscode = vscode; return f;
}

/** 六种内置配置只作兜底，各模式复制隔离；附加入口仅展示Attach且取消不启动。 */
test('six Android fallback configurations preserve modes requests and independent options', async () => {
  const f = fixture(), configurations = f.api.getAndroidDebugConfigurations();
  assert.equal(configurations.length, 6);
  assert.deepEqual(Array.from(configurations, config => [config.mode, config.request]), [
    ['native', 'launch'], ['native', 'attach'], ['java', 'launch'], ['java', 'attach'], ['dual', 'launch'], ['dual', 'attach'],
  ]);
  for (const config of configurations) {
    assert.equal(config.type, 'android-debug'); assert.equal(config.target, 'auto');
    if (config.request === 'attach') assert.equal(config.pid, 'auto');
    if (config.request === 'launch') { assert.equal(config.apkPath, 'auto'); assert.equal(config.packageName, 'auto'); assert.equal(config.launchActivity, 'auto'); if (config.mode !== 'native') { assert.equal(config.java.type, 'android-jvm'); assert.equal(config.java.port, undefined); assert.equal(config.java.hostName, undefined); assert.equal(config.java.preLaunchTask, undefined); assert.deepEqual(Array.from(config.java.adapterJvmArgs), []); } }

    const mapped = f.api.createAndroidDebugConfiguration(config, { serial: 'phone' });
    assert.equal(mapped.request, config.request); assert.equal(mapped.mode, config.mode);
  }
  configurations[0].native.abi = 'x86'; configurations[2].java.name = 'changed';
  assert.equal(f.api.createAndroidDebugConfiguration(configurations[0], { serial: 'phone' }).packageName, undefined);
  assert.equal(f.api.getAndroidDebugConfigurations()[0].native.abi, 'auto');
  assert.equal(f.api.getAndroidDebugConfigurations()[2].java.name, 'Android JVM');
  const config = await f.api.selectAndroidDebugConfiguration(); assert.equal(f.items.length, 6);
  const session = await f.api.startAndroidDebugging(undefined, config, { serial: 'phone', pid: 42 });
  assert.equal(session.id, 'parent-session'); assert.equal(f.starts[0].request, 'attach');
  assert.equal(f.starts[0].pid, 42); assert.equal(f.starts[0].processId, 42); assert.equal(f.disposed, 1);
  assert.deepEqual(f.events, [['start', 'android-debug'], ['view', 'workbench.view.debug']]);
  await f.api.selectAndroidDebugConfiguration(undefined, 'attach');
  assert.equal(f.items.length, 3); assert.ok(f.items.every(item => item.config.request === 'attach'));
  f.pick = undefined; assert.equal(await f.api.selectAndroidDebugConfiguration(), undefined); assert.equal(f.starts.length, 1);
  for (const mode of ['kotlin-java', 'jvm-native', 'invalid']) assert.throws(() => f.api.createAndroidDebugConfiguration({ ...config, mode }, { serial: 'phone' }), /Unsupported Android debug mode/);
});

// 外部配置保留类型和原始选项；源Android Debug允许的java配置覆盖语义不被宿主强行禁止。
test('Android configurations preserve original external options and never merge Kotlin into Java', async () => {
  const f = fixture();
  const config = { type: 'android-debug', request: 'launch', name: 'Mixed', custom: 17,
    java: { type: 'java', sourcePaths: ['java-src'] }, kotlin: { type: 'android-jvm', port: 5005, sourcePaths: ['kotlin-src'] }, native: { symbolSearchPaths: ['symbols'] } };
  f.configs = [config, config, { type: 'external', request: 'invalid', name: 'Invalid' }];
  f.pick = 0;
  const selected = await f.api.selectAndroidDebugConfiguration();
  assert.notStrictEqual(selected, config); assert.equal(selected.name, 'Android: Native Debug Launch'); assert.equal(f.items.length, 6);
  const mapped = f.api.createAndroidDebugConfiguration(config, { serial: 'phone', processId: 77, packageName: 'com.demo' });
  assert.equal(mapped.request, 'attach'); assert.equal(mapped.pid, 77); assert.equal(mapped.custom, 17); assert.equal(mapped.packageName, 'com.demo');
  assert.notStrictEqual(mapped.java, config.java); assert.strictEqual(mapped.kotlin, config.kotlin); assert.notStrictEqual(mapped.native, config.native);
  assert.deepEqual({ ...mapped.java }, config.java); assert.deepEqual({ ...mapped.native }, config.native);
  assert.equal(mapped.java.type, 'java'); assert.equal(mapped.kotlin.type, 'android-jvm'); assert.equal(mapped.java.port, undefined);
  assert.equal(config.request, 'launch'); assert.equal(config.pid, undefined);
  assert.equal(f.api.findAndroidDebugConfiguration().name, 'Android: Native Debug Launch'); assert.equal(f.api.findAndroidDebugConfiguration(undefined, true).mode, 'native');
  assert.equal(f.api.createAndroidDebugConfiguration(config, { serial: 'phone' }).request, 'launch');
});

/** Launch只有同名外部配置覆盖内置；Processes保留三个内置Attach和全部外部Launch/Attach。 */
test('launch.json matches built-in names before replacing launch configurations', async () => {
  const f = fixture();
  const launch = { type: 'android-debug', request: 'launch', name: 'User dual', mode: 'dual', preLaunchTask: 'prepare', apkPath: 'user.apk', java: { type: 'android-jvm', sourcePaths: ['sdk/src'] }, native: { abi: 'arm64-v8a', symbolSearchPaths: ['symbols'] } };
  f.configs = [launch];
  const fallback = await f.api.selectAndroidDebugConfiguration(); assert.equal(fallback.name, 'Android: Native Debug Launch'); assert.notStrictEqual(fallback, launch); assert.equal(f.items.length, 6);
  const matching = { ...launch, name: 'Android: Dual(Native and JVM) Debug Launch' };
  f.configs = [matching]; f.pick = 0;
  assert.equal(await f.api.selectAndroidDebugConfiguration(), matching); assert.equal(f.items.length, 1);
  await f.api.selectAndroidDebugConfiguration(undefined, 'attach'); assert.equal(f.items.length, 4);
  assert.deepEqual(Array.from(f.items.slice(0, 3), item => item.config.request), ['attach', 'attach', 'attach']);
  assert.equal(f.items[3].config, matching);
  const attach = { ...launch, name: 'User attach', request: 'attach' };
  f.configs = [launch, attach, attach]; f.pick = 4;
  assert.equal(await f.api.selectAndroidDebugConfiguration(undefined, 'attach'), attach);
  assert.equal(f.items.length, 5); assert.equal(f.items[4].config, attach);
  assert.deepEqual(Array.from(f.items.slice(0, 3), item => item.config.mode), ['native', 'java', 'dual']);
  f.pick = undefined; assert.equal(await f.api.selectAndroidDebugConfiguration(), undefined);
  const mapped = f.api.createAndroidDebugConfiguration({ ...launch, packageName: 'com.explicit.app' }, { serial: 'phone', packageName: 'com.build.app' });
  assert.equal(mapped.packageName, 'com.explicit.app'); assert.equal(mapped.preLaunchTask, 'prepare'); assert.equal(mapped.apkPath, 'user.apk');
  assert.deepEqual(mapped.java.sourcePaths, ['sdk/src']); assert.deepEqual(mapped.native.symbolSearchPaths, ['symbols']);
  f.configs = [{ type: 'android-debug', request: 'invalid', name: 'Invalid' }]; f.pick = 0;
  await f.api.selectAndroidDebugConfiguration(); assert.equal(f.items.length, 6);
});

// 同时覆盖false、异常和没有实际会话事件；失败不能被空对象或undefined伪装为正常启动。
test('Android session start propagates refusal errors and absent session while always releasing listener', async () => {
  const f = fixture(), config = { type: 'android-tools', name: 'Attach', request: 'attach' };
  f.accept = false;
  await assert.rejects(f.api.startAndroidDebugging(undefined, config, { serial: 'phone' }), /did not start/); assert.equal(f.disposed, 1);
  const failure = new Error('adapter failed'); f.failure = failure;
  await assert.rejects(f.api.startAndroidDebugging(undefined, config, { serial: 'phone' }), error => error === failure); assert.equal(f.disposed, 2);
  f.failure = undefined; f.accept = true; f.reportSession = false;
  await assert.rejects(f.api.startAndroidDebugging(undefined, config, { serial: 'phone' }), /did not report a live start/); assert.equal(f.disposed, 3);
  f.trusted = false;
  await assert.rejects(f.api.startAndroidDebugging(undefined, config, { serial: 'phone' }), /not trusted/); assert.equal(f.disposed, 3); assert.equal(f.starts.length, 3);
});

// provider自动补齐的身份不能使真实start事件被丢弃，已明确请求的身份仍严格匹配。
test('Android startup accepts provider-resolved package and command PID without weakening explicit identity', async () => {
  const f = fixture(); f.resolvedPackage = 'com.device.app'; f.resolvedPid = 81;
  const config = { type: 'android-tools', request: 'attach', name: 'Auto', pid: '${command:pickAndroidProcess}' };
  const session = await f.api.startAndroidDebugging(undefined, config, { serial: 'phone' });
  assert.equal(session.configuration.packageName, 'com.device.app'); assert.equal(session.configuration.pid, 81);
  await assert.rejects(f.api.startAndroidDebugging(undefined, { ...config, packageName: 'com.explicit.app' }, { serial: 'phone' }), /did not report a live start/);
  await assert.rejects(f.api.startAndroidDebugging(undefined, config, { serial: 'phone', pid: 42 }), /did not report a live start/);
});

// 显式配置或目标中的 PID 必须双字段一致；类型转换只放宽引擎类型，不能接管同名同设备的其他进程。
for (const field of ['pid', 'processId']) test('Android startup keeps explicit configuration process identity strict; ' + field, async () => {
  const f = fixture(); f.resolvedPid = 99;
  const config = { type: 'android-debug', request: 'attach', name: 'Explicit PID', mode: 'native', [field]: 42 };
  await assert.rejects(f.api.startAndroidDebugging(undefined, config, { serial: 'phone' }), /did not report a live start/);
  assert.equal(f.startListeners.size, 0); assert.equal(f.endListeners.size, 0);
});

// 非法配置或设备身份必须在调用宿主之前失败，重复PID字段不允许指向两个进程。
test('Android configuration validation rejects invalid targets before allocating session listeners', async () => {
  const f = fixture(), config = { type: 'android-tools', name: 'Attach', request: 'attach' };
  for (const target of [{ serial: '' }, { serial: 'bad serial' }, { serial: 'phone', pid: -1 }, { serial: 'phone', processId: 1.2 }, { serial: 'phone', pid: 1, processId: 2 }]) {
    assert.throws(() => f.api.createAndroidDebugConfiguration(config, target), /serial|process id/);
  }
  assert.throws(() => f.api.createAndroidDebugConfiguration({ ...config, request: 'invalid' }, { serial: 'phone' }), /Invalid Android debug/);
  await assert.rejects(f.api.startAndroidDebugging(undefined, config, { serial: 'phone', pid: 0 }), /process id/);
  assert.equal(f.disposed, 0); assert.equal(f.starts.length, 0);
  assert.equal(f.api.androidDebugger.startAndroidDebugging, f.api.startAndroidDebugging);
});
/** 导航前已完成真实连接；视图取消不反向取消成功会话，外部配置也导航，导航失败只记录警告。 */
test('all built-in attaches start before navigation can cancel the Processes view', async () => {
  for (const config of fixture().api.getAndroidDebugConfigurations().filter(config => config.request === 'attach')) {
    const f = fixture(), scope = new AbortController();
    f.onFocus = () => scope.abort(new Error('Device Explorer view is inactive'));
    const session = await f.api.startAndroidDebugging(undefined, config, { serial: 'phone', pid: 42, signal: scope.signal });
    assert.equal(session.id, 'parent-session'); assert.equal(f.starts.length, 1); assert.equal(scope.signal.aborted, true);
    assert.deepEqual(f.events, [['start', 'android-debug'], ['view', 'workbench.view.debug']]); assert.equal(f.disposed, 1);
  }
  const external = fixture(); await external.api.startAndroidDebugging(undefined, { type: 'external', request: 'launch', name: 'External' }, { serial: 'phone' });
  assert.deepEqual(external.events, [['start', 'external'], ['view', 'workbench.view.debug']]);
  const failure = fixture(); failure.navigationFailure = new Error('view unavailable');
  const session = await failure.api.startAndroidDebugging(undefined, { type: 'android-debug', request: 'attach', name: 'Native', mode: 'native' }, { serial: 'phone', pid: 42 });
  assert.equal(session.id, 'parent-session'); assert.match(failure.warnings[0], /W:.*view unavailable/);
  const cancelled = fixture(), scope = new AbortController(); scope.abort(new Error('user cancelled'));
  await assert.rejects(cancelled.api.startAndroidDebugging(undefined, { type: 'android-debug', request: 'attach', name: 'Attach' }, { serial: 'phone', signal: scope.signal }), /user cancelled/);
  assert.equal(cancelled.starts.length, 0);
  const refused = fixture(); refused.accept = false;
  await assert.rejects(refused.api.startAndroidDebugging(undefined, { type: 'android-debug', request: 'attach', name: 'Attach' }, { serial: 'phone' }), /did not start/);
  assert.deepEqual(refused.events, [['start', 'android-debug']]);
});

/** 功能：在选择配置时响应停止；输入挂起的原生选择控件及启动取消；输出控件令牌触发并拒绝迟到选择；验证：本文件定向入口。 */
test('Android configuration picker closes through the startup cancellation signal', async () => {
  const f = fixture(), controller = new AbortController(), entered = Promise.withResolvers();
  f.vscode.window.showQuickPick = (_items, _options, token) => new Promise(resolve => {
    entered.resolve(token);
    token.onCancellationRequested(() => resolve(undefined));
  });
  const choosing = f.api.selectAndroidDebugConfiguration(undefined, undefined, controller.signal);
  const rejected = assert.rejects(choosing, /stop while selecting/);
  const token = await entered.promise;
  controller.abort(new Error('stop while selecting'));
  assert.equal(token.isCancellationRequested, true); await rejected;
  assert.equal(f.starts.length, 0);
});

// 以一次事件循环检查点观察 Promise 状态，不结算宿主门闩，也不等待定时器或轮询。
async function settlement(promise) {
  return Promise.race([promise.then(() => 'fulfilled', () => 'rejected'), new Promise(resolve => setImmediate(() => resolve('pending')))]);
}

// 功能：隔离宿主与连接屏障；输入显式 start/terminate 和连接 Promise；输出独立的宿主、connected、stop 与真实 termination 边界。
function pendingStartupFixture() {
  const f = fixture();
  f.host = Promise.withResolvers(); f.entered = Promise.withResolvers();
  f.starts = f.startListeners; f.ends = f.endListeners;
  f.vscode.debug.startDebugging = (_folder, config) => {
    f.mapped = config;
    f.startup.reportDebugConnection(config, f.connection ?? Promise.resolve());
    f.entered.resolve(); return f.host.promise;
  };
  f.vscode.debug.stopDebugging = async session => { f.stops.push(session); };
  return f;
}

// 功能：区分宿主接受和真实连接；输入成功、连接失败或等待期间取消；输出前台结算、精确会话停止及 registry 生命周期断言。
for (const outcome of ['connected', 'failed', 'cancelled']) test('Android startup waits for the real connection and retains registration through cleanup; ' + outcome, async () => {
  const f = pendingStartupFixture(), scope = new AbortController(), connection = Promise.withResolvers();
  f.connection = connection.promise;
  let cleanup;
  const failure = new Error('real connection failed');
  const starting = f.api.startAndroidDebugging(undefined, { type: 'android-debug', request: 'attach', name: 'Connection boundary', mode: 'native' },
    { serial: 'phone', pid: 42, signal: scope.signal, onStartupCleanup: value => { cleanup = value; } });
  const rejected = outcome === 'connected' ? undefined : assert.rejects(starting, error => error === (outcome === 'failed' ? failure : scope.signal.reason));
  await f.entered.promise;
  const owned = { id: 'real-engine-session', configuration: { ...f.mapped, type: 'android-tools' } };
  f.report(owned); f.host.resolve(true);
  assert.equal(await settlement(starting), 'pending');
  assert.equal(await settlement(cleanup), 'pending');
  assert.equal(f.startup.debugStartupSignal(owned.configuration), scope.signal);
  assert.deepEqual(f.events, []);
  if (outcome === 'connected') {
    connection.resolve();
    assert.equal(await settlement(starting), 'fulfilled');
    assert.equal(await starting, owned); await cleanup;
    assert.deepEqual(f.events, [['view', 'workbench.view.debug']]); assert.deepEqual(f.stops, []);
  } else {
    if (outcome === 'cancelled') {
      scope.abort(new Error('cancel while connecting')); await rejected;
      assert.equal(await settlement(cleanup), 'pending');
      assert.equal(f.startup.debugStartupSignal(owned.configuration), scope.signal);
      connection.reject(scope.signal.reason);
    } else connection.reject(failure);
    await rejected;
    assert.equal(await settlement(cleanup), 'pending');
    assert.deepEqual(f.stops, [owned]); assert.deepEqual(f.events, []);
    assert.equal(f.startup.debugStartupSignal(owned.configuration), scope.signal);
    f.terminate({ ...owned });
    assert.equal(await settlement(cleanup), 'fulfilled'); await cleanup;
  }
  assert.equal(f.startup.debugStartupSignal(owned.configuration), undefined);
  assert.equal(f.starts.size, 0); assert.equal(f.ends.size, 0);
});

// 功能：确认自有 Android 会话不能在连接尚未登记时假成功；输入先 start 后报告的连接；输出有限检查点的 pending 和最终真实连接结果。
test('Android startup does not treat an unreported Android connection as connected', async () => {
  const f = fixture(), entered = Promise.withResolvers(), connection = Promise.withResolvers();
  f.vscode.debug.startDebugging = async (_folder, config) => {
    f.mapped = config;
    f.report({ id: 'late-connection-report', configuration: { ...config, type: 'android-tools' } });
    entered.resolve(); return true;
  };
  const starting = f.api.startAndroidDebugging(undefined, { type: 'android-debug', request: 'attach', name: 'Late connection', mode: 'native' }, { serial: 'phone' });
  await entered.promise;
  assert.equal(await settlement(starting), 'pending');
  f.startup.reportDebugConnection(f.mapped, connection.promise);
  assert.equal(await settlement(starting), 'pending');
  connection.resolve();
  assert.equal(await settlement(starting), 'fulfilled');
  assert.equal((await starting).id, 'late-connection-report');
  assert.equal(f.startListeners.size, 0); assert.equal(f.endListeners.size, 0);
});

// 挂起宿主并取消，分别覆盖普通 Error 和默认 DOMException，调用方不得被清理屏障阻塞。
test('Android startup abort rejects immediately while permanently pending host retains cleanup and registry', async () => {
  for (const reason of [new Error('explicit startup abort'), undefined]) {
    const f = pendingStartupFixture(), scope = new AbortController();
    let cleanup;
    const config = { type: 'android-debug', request: 'attach', name: 'Pending', mode: 'native' };
    const starting = f.api.startAndroidDebugging(undefined, config, { serial: 'phone', signal: scope.signal, onStartupCleanup: value => { cleanup = value; } });
    const rejected = assert.rejects(starting, error => error === scope.signal.reason);
    await f.entered.promise; scope.abort(reason);
    assert.equal(await settlement(starting), 'rejected'); await rejected;
    assert.equal(await settlement(cleanup), 'pending');
    assert.equal(f.startup.debugStartupSignal(f.mapped), scope.signal);
    await assert.rejects(f.api.startAndroidDebugging(undefined, config, { serial: 'phone' }), /already starting/);
    assert.equal(f.starts.size, 1); assert.equal(f.stops.length, 0);
  }
});

// 未取消时两个同配置匹配也只能返回最早登记的会话，不允许第二个事件覆盖首个。
test('Android startup preserves its first matching session before the host settles', async () => {
  const f = pendingStartupFixture();
  let cleanup;
  const starting = f.api.startAndroidDebugging(undefined, { type: 'android-debug', request: 'attach', name: 'First match', mode: 'native' },
    { serial: 'phone', onStartupCleanup: value => { cleanup = value; } });
  await f.entered.promise;
  const first = { id: 'first-match', configuration: { ...f.mapped } }, second = { id: 'second-match', configuration: { ...f.mapped } };
  f.report(first); f.report(second); f.host.resolve(true);
  assert.equal(await starting, first); await cleanup;
  assert.equal(f.starts.size, 0); assert.equal(f.ends.size, 0); assert.equal(f.stops.length, 0);
});

// 两个同配置事件均归属取消范围；首个匹配不能被后者覆盖，宿主结算不能代替任一个真实退出。
for (const beforeAbort of [true, false]) test('Android cancellation stops every exact late session and awaits each termination; reported before abort=' + beforeAbort, async () => {
  const f = pendingStartupFixture(), scope = new AbortController();
  let cleanup;
  const starting = f.api.startAndroidDebugging(undefined, { type: 'android-debug', request: 'attach', name: 'Owned', mode: 'native' },
    { serial: 'phone', pid: 42, signal: scope.signal, onStartupCleanup: value => { cleanup = value; } });
  const rejected = assert.rejects(starting, error => error === scope.signal.reason);
  await f.entered.promise;
  const first = { id: 'first', configuration: { ...f.mapped } }, second = { id: 'second', configuration: { ...f.mapped } };
  const foreign = { id: 'foreign', configuration: { ...f.mapped, serial: 'other-phone' } };
  const foreignChild = { id: 'foreign-child', parentSession: { id: 'foreign-parent' }, configuration: { ...f.mapped } };
  if (beforeAbort) { f.report(first); f.report(second); }
  scope.abort(new Error('cancel owned startup'));
  assert.equal(await settlement(starting), 'rejected'); await rejected;
  // 取消前先出现两个匹配时，仍须首先停止最早登记的会话。
  if (beforeAbort) { await Promise.resolve(); assert.equal(f.stops[0], first); }
  if (!beforeAbort) { f.report(first); f.report(second); }
  f.report(foreign); f.report(foreignChild);
  await Promise.resolve();
  assert.deepEqual(f.stops, [first, second]);
  assert.equal(await settlement(cleanup), 'pending');
  f.terminate(foreign); f.terminate(foreignChild);
  f.host.resolve(true);
  assert.equal(await settlement(cleanup), 'pending');
  f.terminate(second);
  assert.equal(await settlement(cleanup), 'pending');
  f.terminate(first); await cleanup;
  assert.deepEqual(f.stops, [first, second]);
  assert.equal(f.starts.size, 0); assert.equal(f.ends.size, 0);
  assert.equal(f.startup.debugStartupSignal(f.mapped), undefined);
});

/** 功能：宿主先报告start再false/throws时保留清理；输入两种失败及独立termination；输出原失败、精确stop和清理屏障断言；验证：本文件入口。 */
for (const outcome of ['false', 'throws']) test('Android host failure after start stops observed sessions and awaits real termination; ' + outcome, async () => {
  const f = pendingStartupFixture(), failure = new Error('host failed after start');
  let cleanup;
  const starting = f.api.startAndroidDebugging(undefined, { type: 'android-debug', request: 'attach', name: 'Host failure', mode: 'native' },
    { serial: 'phone', onStartupCleanup: value => { cleanup = value; } });
  const rejected = assert.rejects(starting, outcome === 'throws' ? error => error === failure : /did not start/);
  await f.entered.promise;
  const owned = { id: 'reported-before-failure', configuration: { ...f.mapped } };
  f.report(owned);
  assert.equal(await settlement(cleanup), 'pending');
  if (outcome === 'throws') f.host.reject(failure); else f.host.resolve(false);
  await rejected;
  assert.equal(await settlement(cleanup), 'pending');
  assert.deepEqual(f.stops, [owned]);
  assert.equal(f.startup.debugStartupSignal(f.mapped).aborted, false);
  assert.equal(f.starts.size, 1); assert.equal(f.ends.size, 1);
  await assert.rejects(f.api.startAndroidDebugging(undefined, { ...f.mapped }, { serial: 'phone' }), /already starting/);
  // termination按ID归属，不要求事件沿用相同对象引用。
  f.terminate({ ...owned }); await cleanup;
  assert.equal(f.startup.debugStartupSignal(f.mapped), undefined);
  assert.equal(f.starts.size, 0); assert.equal(f.ends.size, 0);
  assert.deepEqual(f.events, []);
});

/** 功能：拒绝启动中已退出的首会话；输入start后同步termination、可选另一个存活会话及宿主成功；输出拒绝且只停止尚存对象，清理等待其真实退出；验证：本文件入口。 */
for (const hasSurvivor of [false, true]) test('Android start immediately followed by termination cannot return a successful session; survivor=' + hasSurvivor, async () => {
  const f = pendingStartupFixture(); let cleanup;
  const starting = f.api.startAndroidDebugging(undefined, { type: 'android-debug', request: 'attach', name: 'Ended', mode: 'native' },
    { serial: 'phone', onStartupCleanup: value => { cleanup = value; } });
  const rejected = assert.rejects(starting, /did not report a live start/);
  await f.entered.promise;
  const owned = { id: 'already-ended', configuration: { ...f.mapped } };
  const survivor = { id: 'still-alive', configuration: { ...f.mapped } };
  f.report(owned); f.terminate({ ...owned });
  if (hasSurvivor) f.report(survivor);
  f.host.resolve(true); await rejected;
  if (hasSurvivor) {
    assert.equal(await settlement(cleanup), 'pending'); assert.deepEqual(f.stops, [survivor]);
    f.terminate(survivor);
  }
  await cleanup;
  assert.deepEqual(f.stops, hasSurvivor ? [survivor] : []); assert.deepEqual(f.events, []);
  assert.equal(f.starts.size, 0); assert.equal(f.ends.size, 0);
  assert.equal(f.startup.debugStartupSignal(f.mapped), undefined);
});

/** 功能：同ID事件只登记一次；输入取消前后重复对象及克隆事件；输出唯一stop并等待该ID真实终止；验证：本文件入口。 */
test('Android duplicate start events for one ID never duplicate stop or replace the owned object', async () => {
  const f = pendingStartupFixture(), scope = new AbortController(); let cleanup;
  const starting = f.api.startAndroidDebugging(undefined, { type: 'android-debug', request: 'attach', name: 'Duplicate', mode: 'native' },
    { serial: 'phone', signal: scope.signal, onStartupCleanup: value => { cleanup = value; } });
  const rejected = assert.rejects(starting, error => error === scope.signal.reason);
  await f.entered.promise;
  const owned = { id: 'same-id', configuration: { ...f.mapped } };
  f.report(owned); f.report({ ...owned }); scope.abort(new Error('duplicate event cancellation'));
  f.report(owned); f.report({ ...owned }); await rejected;
  assert.equal(await settlement(cleanup), 'pending'); assert.deepEqual(f.stops, [owned]);
  f.host.resolve(true); assert.equal(await settlement(cleanup), 'pending');
  f.report({ ...owned }); assert.deepEqual(f.stops, [owned]);
  f.terminate({ ...owned }); await cleanup;
  assert.deepEqual(f.stops, [owned]); assert.equal(f.starts.size, 0); assert.equal(f.ends.size, 0);
});

/** 功能：不接管foreign child及身份不符会话；输入完全同配置但带parent的child和逐字段冲突事件；输出缺少自有会话拒绝、零stop；验证：本文件入口。 */
test('Android startup excludes foreign children and mismatched configuration identities', async () => {
  const f = pendingStartupFixture(); let cleanup;
  const starting = f.api.startAndroidDebugging(undefined, { type: 'android-debug', request: 'attach', name: 'Identity', mode: 'native', packageName: 'com.example.app' },
    { serial: 'phone', pid: 42, onStartupCleanup: value => { cleanup = value; } });
  const rejected = assert.rejects(starting, /did not report a live start/); await f.entered.promise;
  const child = { id: 'foreign-child', parentSession: { id: 'unrelated-parent' }, configuration: { ...f.mapped } };
  f.report(child);
  for (const [key, value] of [['name', 'Other'], ['serial', 'other-phone'], ['packageName', 'com.other.app'], ['pid', 99], ['processId', 99]]) {
    f.report({ id: 'foreign-' + key, configuration: { ...f.mapped, [key]: value } });
  }
  f.host.resolve(true); await rejected; await cleanup;
  assert.deepEqual(f.stops, []); assert.deepEqual(f.events, []);
  assert.equal(f.starts.size, 0); assert.equal(f.ends.size, 0);
});

/** 功能：stop失败不能被前台取消掩盖；输入原始停止错误与宿主结算；输出取消立即拒绝、cleanup传播原错且释放登记；验证：本文件入口。 */
test('Android startup cleanup propagates the exact stop failure after the host settles', async () => {
  const f = pendingStartupFixture(), scope = new AbortController(), failure = new Error('stopDebugging refused'); let cleanup;
  f.vscode.debug.stopDebugging = async session => { f.stops.push(session); throw failure; };
  const starting = f.api.startAndroidDebugging(undefined, { type: 'android-debug', request: 'attach', name: 'Stop failure', mode: 'native' },
    { serial: 'phone', signal: scope.signal, onStartupCleanup: value => { cleanup = value; } });
  const rejected = assert.rejects(starting, error => error === scope.signal.reason);
  const cleanupRejected = assert.rejects(cleanup, error => error === failure);
  await f.entered.promise;
  const owned = { id: 'cannot-stop', configuration: { ...f.mapped } };
  f.report(owned); scope.abort(new Error('foreground cancellation')); await rejected;
  assert.equal(await settlement(cleanup), 'pending'); assert.deepEqual(f.stops, [owned]);
  f.host.resolve(true); await cleanupRejected;
  assert.deepEqual(f.stops, [owned]); assert.equal(f.starts.size, 0); assert.equal(f.ends.size, 0);
  assert.equal(f.startup.debugStartupSignal(f.mapped), undefined);
});
