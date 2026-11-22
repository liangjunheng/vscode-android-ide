const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { transformSync } = require('esbuild');

/** 隔离VS Code服务加载实际配置入口；npm test发现本文件，断言真实启动、取消、拒绝和监听释放，不模拟JVM行为。 */
function fixture() {
  const f = { configs: [], pick: 0, starts: [], events: [], disposed: 0, accept: true, trusted: true, reportSession: true };
  const vscode = {
    workspace: { get isTrusted() { return f.trusted; }, getConfiguration: section => { assert.equal(section, 'launch'); return { get: () => f.configs }; } },
    window: { showErrorMessage: async message => { (f.notices ??= []).push(message); }, showQuickPick: async items => { f.items = items; return f.pick === undefined ? undefined : items[f.pick]; } },
    commands: { async executeCommand(command) { f.events.push(['view',command]); if(f.navigationFailure) throw f.navigationFailure; await f.onFocus?.(); } },
    debug: {
      onDidStartDebugSession(listener) { f.listener = listener; return { dispose() { f.disposed++; f.listener = undefined; } }; },
      async startDebugging(folder, config) {
        f.events.push(['start',config.type]); f.starts.push(config); if (f.failure) throw f.failure;
        if (f.accept && f.reportSession) f.listener({ id: 'parent-session', configuration: { ...config, ...(f.resolvedPackage ? { packageName: f.resolvedPackage } : {}), ...(f.resolvedPid ? { pid: f.resolvedPid, processId: f.resolvedPid } : {}) } });
        return f.accept;
      },
    },
  };
  const module = { exports: {} };
  vm.runInNewContext(transformSync(fs.readFileSync(path.join(__dirname, '../src/android-debugger/index.ts'), 'utf8'), { loader: 'ts', format: 'cjs' }).code,
    { module, exports: module.exports, require: id => id === 'vscode' ? vscode : id === './autoConfig' ? { omitAuto: config => { const result = { ...config }; for (const key of ['apkPath','packageName','launchActivity','serial','target','pid','processId','androidProjectRoot','androidAdbPath','androidJdwpPort','hostName','preLaunchTask']) if (result[key] === 'auto') delete result[key]; return result; } } : require(id) });
  f.api = module.exports; return f;
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
  await assert.rejects(f.api.startAndroidDebugging(undefined, config, { serial: 'phone' }), /did not report/); assert.equal(f.disposed, 3);
  f.trusted = false;
  await assert.rejects(f.api.startAndroidDebugging(undefined, config, { serial: 'phone' }), /not trusted/); assert.equal(f.disposed, 3); assert.equal(f.starts.length, 3);
});

// provider自动补齐的身份不能使真实start事件被丢弃，已明确请求的身份仍严格匹配。
test('Android startup accepts provider-resolved package and command PID without weakening explicit identity', async () => {
  const f = fixture(); f.resolvedPackage = 'com.device.app'; f.resolvedPid = 81;
  const config = { type: 'android-tools', request: 'attach', name: 'Auto', pid: '${command:pickAndroidProcess}' };
  const session = await f.api.startAndroidDebugging(undefined, config, { serial: 'phone' });
  assert.equal(session.configuration.packageName, 'com.device.app'); assert.equal(session.configuration.pid, 81);
  await assert.rejects(f.api.startAndroidDebugging(undefined, { ...config, packageName: 'com.explicit.app' }, { serial: 'phone' }), /did not report/);
  await assert.rejects(f.api.startAndroidDebugging(undefined, config, { serial: 'phone', pid: 42 }), /did not report/);
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
/** 导航引发Processes隐藏取消时，三个Attach会话已经启动；失败或未启动不导航，显式取消仍阻止启动。 */
test('all built-in attaches start before navigation can cancel the Processes view', async () => {
  for (const config of fixture().api.getAndroidDebugConfigurations().filter(config => config.request === 'attach')) {
    const f = fixture(), scope = new AbortController();
    f.onFocus = () => scope.abort(new Error('Device Explorer view is inactive'));
    const session = await f.api.startAndroidDebugging(undefined, config, { serial: 'phone', pid: 42, signal: scope.signal });
    assert.equal(session.id, 'parent-session'); assert.equal(f.starts.length, 1); assert.equal(scope.signal.aborted, true);
    assert.deepEqual(f.events, [['start', 'android-debug'], ['view', 'workbench.view.debug']]); assert.equal(f.disposed, 1);
  }
  const external = fixture(); await external.api.startAndroidDebugging(undefined, { type: 'external', request: 'launch', name: 'External' }, { serial: 'phone' });
  assert.deepEqual(external.events, [['start', 'external']]);
  const failure = fixture(); failure.navigationFailure = new Error('view unavailable');
  const session = await failure.api.startAndroidDebugging(undefined, { type: 'android-debug', request: 'attach', name: 'Native', mode: 'native' }, { serial: 'phone', pid: 42 });
  assert.equal(session.id, 'parent-session'); assert.match(failure.notices[0], /view unavailable/);
  const cancelled = fixture(), scope = new AbortController(); scope.abort(new Error('user cancelled'));
  await assert.rejects(cancelled.api.startAndroidDebugging(undefined, { type: 'android-debug', request: 'attach', name: 'Attach' }, { serial: 'phone', signal: scope.signal }), /user cancelled/);
  assert.equal(cancelled.starts.length, 0);
  const refused = fixture(); refused.accept = false;
  await assert.rejects(refused.api.startAndroidDebugging(undefined, { type: 'android-debug', request: 'attach', name: 'Attach' }, { serial: 'phone' }), /did not start/);
  assert.deepEqual(refused.events, [['start', 'android-debug']]);
});
