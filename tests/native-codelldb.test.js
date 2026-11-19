const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const vm = require('node:vm');
const { build } = require('esbuild');
const root = path.resolve(__dirname, '..');

/** 加载真实父adapter、原两阶段provider和真实DAP库，只替换设备/VSCode边界；npm test发现本文件。 */
async function fixture(t) {
  const f = { codeLldb: { isActive: true, activated: false, async activate() { this.isActive = true; this.activated = true; } }, input: undefined, toolchainFailure: undefined, seq: 0, trusted: true, starts: new Set(), ends: new Set(), providers: new Map(), commands: new Map(), children: [], servers: [], cleaned: [], stopped: [], notices: [], calls: [], selected: { udid: 'picked' }, accept: true, report: true, currentAbi: undefined, processes: [{ pid: '42', name: 'com.example.app', packages: ['com.example.app'] }, { pid: '77', name: 'com.unrelated', packages: ['com.unrelated'] }] };
  const disposable = set => listener => { set.add(listener); return { dispose: () => set.delete(listener) }; };
  const vscode = {
    Uri: { file: fsPath => ({ fsPath }) },
    DebugConfigurationProviderTriggerKind: {Initial:1,Dynamic:2},
    DebugAdapterInlineImplementation: class { constructor(implementation) { this.implementation = implementation; } },
    workspace: { get isTrusted() { return f.trusted; }, getConfiguration: () => ({ get: key => key === 'abiSupported' ? ['arm64-v8a', 'x86_64'] : key === 'abiMap' ? {} : undefined }) },
    extensions: { getExtension() { return f.codeLldb; } },
    window: { createOutputChannel: () => ({ appendLine() {} }), showErrorMessage: async message => { f.notices.push(message); f.noticeHook?.(message); }, showInputBox: async () => f.input }, commands: { executeCommand: async () => undefined },
    commands: { registerCommand(name, action) { assert.equal(f.commands.has(name), false); f.commands.set(name, action); return { dispose() {} }; } },
    debug: {
      registerDebugAdapterDescriptorFactory() { throw new Error('Descriptor belongs to extension activation'); },
      registerDebugConfigurationProvider(type, provider, trigger) { if(trigger===2) { assert.equal(f.dynamicProvider,undefined); f.dynamicProvider=provider; f.dynamicType=type; } else { assert.equal(f.providers.has(type), false); f.providers.set(type, provider); } return { dispose() {} }; },
      onDidStartDebugSession: disposable(f.starts), onDidTerminateDebugSession: disposable(f.ends),
      async startDebugging(folder, config, options) {
        const provider = f.providers.get('lldb');
        const repeated = await provider.resolveDebugConfiguration(folder, { ...config });
        await provider.resolveDebugConfigurationWithSubstitutedVariables(folder, repeated);
        if (f.startFailure) throw f.startFailure;
        if (!f.accept) return false;
        if (f.startGate) { f.startEntered.resolve(); await f.startGate.promise; }
        const session = { id: 'child-' + f.children.length, type: 'lldb', configuration: config, parentSession: options.parentSession };
        f.children.push(session);
        if (f.report) for (const listener of [...f.starts]) listener(session);
        return true;
      },
      async stopDebugging(session) { f.stopped.push(session); if (f.stopFailure) throw f.stopFailure; if (f.stopGate) await f.stopGate.promise; for (const listener of [...f.ends]) listener(session); },
    },
  };
  const android = {
    async getDeviceFromUDID(udid, projectRoot, overrides) { f.calls.push(['device', udid, projectRoot]); return { udid, ...(overrides ? { androidNativeToolchain: overrides } : {}) }; },
    async installApp(device, apk) { f.calls.push(['install', device, apk]); },
    async launchApp(device, pkg, activity) { f.calls.push(['launch', device, pkg, activity]); },
    async getPackageNameFromApk(apk, projectRoot) { f.calls.push(['apk', apk, projectRoot]); return 'com.example.app'; },
    async getProcessList(device, populatePackageNames) { f.calls.push(['process-list',populatePackageNames]); return f.processes; },
    async resumeJavaDebugger() { if (f.resumeFailure) throw f.resumeFailure; f.calls.push(['resume']); return async () => { f.calls.push(['jdwp-cleanup']); if (f.jdwpGate) await f.jdwpGate.promise; }; },
  };
  const targetCommand = {
    activate() {}, setProcessPickerInfo() {}, resetProcessPickerInfo() {}, resetAbiResolutionInfo() { f.currentAbi = undefined; },
    setAbiResolutionInfo(abi) { f.currentAbi = abi; },
    async getBestAbi() { return f.currentAbi && f.currentAbi !== 'select' ? f.currentAbi : (f.bestAbi || 'arm64-v8a'); },
    async getBestMappedAbi() { return 'aarch64'; }, async pickAndroidProcess() { return '42'; }, async resumeWaitingProcess() {},
    async getPackageNameForPid() { return 'com.example.app'; }, async getPackageNameFromApk() { return 'com.example.app'; },
    async resolvePackageName(args) { return args.packageName || 'com.example.app'; },
    async lldbServer(args) { if (f.serverFailure) throw f.serverFailure; const socket = '/platform-' + f.servers.length; f.servers.push({ socket, args }); return socket; },
    async lldbServerCleanup(socket) { f.cleaned.push(socket); f.serverEntered?.resolve(); if (f.serverGate) await f.serverGate.promise; if (f.cleanupFailure) throw f.cleanupFailure; },
  };
  const targetPicker = { activate() {}, setCurrentTarget() {}, resetCurrentTarget() {}, async pickTarget() { return f.selected; }, async getLastOrPickTarget() { return f.selected; }, async getTargetFromUDID(udid) { return { udid }; } };
  const mocks = { vscode, android, targetCommand, targetPicker,
    nativeToolchain: { resolveNativeToolchain: (projectRoot, overrides) => { if (f.toolchainFailure) { const error = f.toolchainFailure; f.toolchainFailure = undefined; throw error; } return { adb: 'adb', ndkRoot: overrides?.ndkRoot || 'ndk', sdkRoot: overrides?.sdkRoot || 'sdk', projectRoot }; }, nativeToolchainOverrides: native => ({ sdkRoot: native?.sdkRoot, ndkRoot: native?.ndkRoot }), validateNativeAbis() {} },
    nativeTarget: { resolveLauncherActivity: async (adb, serial, pkg) => { f.calls.push(['activity', adb, serial, pkg]); return 'MainActivity'; } },
  };
  const result = await build({ entryPoints: [path.join(root, 'src/android-debugger/native-debugger/adapter.ts')], bundle: true, write: false, platform: 'node', format: 'cjs', external: ['@vscode/debugadapter'], plugins: [{ name: 'native-boundaries', setup(builder) {
    builder.onResolve({ filter: /^vscode$/ }, () => ({ path: 'mock:vscode', external: true }));
    builder.onResolve({ filter: /(?:^|[\/])(?:android|targetCommand|targetPicker|nativeToolchain|nativeTarget)$/ }, args => ({ path: 'mock:' + args.path.split(/[\/]/).at(-1), external: true }));
  } }] });
  const module = { exports: {} };
  vm.runInNewContext(result.outputFiles[0].text, { module, exports: module.exports, require: id => id.startsWith('mock:') ? mocks[id.slice(5)] : require(id), process, console, Buffer, structuredClone });
  f.api = module.exports; f.context = { subscriptions: [] }; f.factory = f.api.createAndroidDebugAdapterFactory(f.context, folder => { f.calls.push(['gradle-package', folder?.uri.fsPath]); if (f.gradleFailure) throw f.gradleFailure; return f.gradlePackage; });
  f.baseEnds = f.ends.size;
  t.after(async () => { for (const owned of [...f.context.subscriptions].reverse()) await owned.dispose?.(); });
  f.parent = async (overrides = {}, resolve = false) => {
    const folder = { uri: { fsPath: root } };
    let config = { type: 'android-tools', name: 'Built-in Native', request: 'attach', androidMode: 'native', mode: 'native', target: 'serial', pid: 42, packageName: 'com.example.app', native: {}, ...overrides };
    if (resolve) { const provider = f.providers.get('android-tools'); config = await provider.resolveDebugConfiguration(folder, config); if (!config) return undefined; config = await provider.resolveDebugConfigurationWithSubstitutedVariables(folder, config); }
    const parent = { id: 'parent-' + f.seq, type: 'android-tools', workspaceFolder: folder, configuration: config };
    const descriptor = f.factory.createDebugAdapterDescriptor(parent); return descriptor.implementation;
  };
  return f;
}

/** 通过真实DAP response事件等待操作结算，不使用setImmediate/sleep或伪造dispatch。 */
function request(f, adapter, command) {
  const seq = ++f.seq;
  return new Promise(resolve => { const listener = adapter.onDidSendMessage(message => { if (message.type === 'response' && message.request_seq === seq) { listener.dispose(); resolve(message); } }); adapter.handleMessage({ type: 'request', seq, command, arguments: command === 'initialize' ? { adapterID: 'android-tools', pathFormat: 'path', linesStartAt1: true, columnsStartAt1: true } : {} }); });
}
/** 用显式门闩控制资源生命周期；不依赖时钟或轮询。 */
function gate() { return Promise.withResolvers(); }

test('Native factory registers only Native providers once without probing the NDK', async t => {
  const f = await fixture(t); f.api.registerNativeProviders(f.context);
  assert.deepEqual([...f.providers.keys()], ['android-tools', 'lldb']); assert.equal(f.factory.nativeOnly, true);
  assert.deepEqual([...f.commands.keys()], ['android-tools.pickAndroidProcess', 'android-tools.getBestAbi', 'android-tools.getBestMappedAbi', 'android-tools.resumeWaitingProcess']);
  assert.equal(f.calls.length, 0); assert.equal(f.servers.length, 0);
  assert.equal(f.dynamicType,'android-tools');
  assert.equal(f.dynamicProvider, f.providers.get('android-tools'));
  const initial=f.providers.get('android-tools').provideDebugConfigurations();
  const dynamic=f.dynamicProvider.provideDebugConfigurations();
  assert.equal(initial.length,1); assert.equal(dynamic.length,1); assert.equal(dynamic[0].name,'[内置] Android Native'); assert.equal(dynamic[0].target, 'select');
  assert.equal(dynamic[0].type,'android-tools'); assert.equal(dynamic[0].request,'launch');
  initial[0].native.abi='x86'; assert.equal(dynamic[0].native.abi,undefined);
  assert.equal(f.calls.length,0); assert.equal(f.servers.length,0);
  assert.equal(await f.providers.get('lldb').resolveDebugConfiguration(undefined, { type: 'lldb', request: 'launch', name: 'Desktop' }).then(c => c.name), 'Desktop');
});

test('CodeLLDB dependency activation is awaited and missing/failed dependencies are visible', async t => {
  const pending = await fixture(t); pending.codeLldb = { isActive: false, activated: false, async activate() { this.isActive = true; this.activated = true; } };
  const pendingAdapter = await pending.parent(); const pendingResponse = await request(pending, pendingAdapter, 'attach');
  assert.equal(pendingResponse.success, true); assert.equal(pending.codeLldb.activated, true);
  const missing = await fixture(t); missing.codeLldb = undefined; const missingAdapter = await missing.parent();
  const missingResponse = await request(missing, missingAdapter, 'attach'); assert.equal(missingResponse.success, false); assert.match(missingResponse.message, /not installed or enabled/); assert.equal(missing.children.length, 0); assert.equal(missing.cleaned.length, 1);
  const failed = await fixture(t); failed.codeLldb = { isActive: false, async activate() { throw new Error('activation failed'); } };
  const failedAdapter = await failed.parent(); const failedResponse = await request(failed, failedAdapter, 'attach');
  assert.equal(failedResponse.success, false); assert.match(failedResponse.message, /activation failed/); assert.equal(failed.children.length, 0); assert.equal(failed.cleaned.length, 1);
});

test('built-in Native real DAP attach resolves original remote commands and owns one CodeLLDB child', async t => {
  const f = await fixture(t); const options = { abi: 'arm64-v8a', initCommands: ['settings set target.foo true'], symbolSearchPaths: ['native symbols'], pid: 1, androidTarget: 'evil', platform: 'host' };
  const adapter = await f.parent({ native: options }, true);
  assert.equal((await request(f, adapter, 'initialize')).success, true);
  assert.equal((await request(f, adapter, 'attach')).success, true);
  assert.equal(f.children.length, 1); assert.equal(f.servers.length, 1, 'CodeLLDB provider rerun must not create another server');
  const config = f.children[0].configuration;
  assert.equal(config.type, 'lldb'); assert.equal(config.pid, 1); assert.equal(config.androidTarget.udid, 'evil'); assert.equal(config.androidPackageName, 'com.example.app');
  assert.equal(f.servers[0].args.device.androidProjectRoot, root); assert.equal(f.servers[0].args.abi, 'arm64-v8a');
  assert.deepEqual(Array.from(config.initCommands), ['platform select remote-android', 'platform connect unix-abstract-connect://[evil]/platform-0', 'settings set plugin.jit-loader.gdb.enable off', 'process handle SIGBUS SIGSEGV --pass true --stop false --notify false', 'breakpoint set --shlib libart.so --name art_sigsegv_fault', 'breakpoint set --shlib libart.so --name art_sigbus_fault', 'settings set target.foo true', "settings append target.exec-search-paths 'native symbols'"]);
  assert.deepEqual(options.initCommands, ['settings set target.foo true']);
  assert.equal((await request(f, adapter, 'disconnect')).success, true); assert.equal(f.cleaned.length, 1); assert.equal(f.starts.size, 0); assert.equal(f.ends.size, f.baseEnds);
});

test('Native prompts for a missing NDK and retries the current session', async t => {
  const f = await fixture(t); f.toolchainFailure = new Error('Cannot determine valid Android NDK root'); f.input = 'manual-ndk';
  const folder = { uri: { fsPath: root } };
  const config = { type: 'android-tools', name: 'Built-in Native', request: 'attach', androidMode: 'native', mode: 'native', target: 'serial', pid: 42, packageName: 'com.example.app', native: {} };
  const resolved = await f.providers.get('android-tools').resolveDebugConfiguration(folder, config);
  assert.equal(resolved.native.ndkRoot, 'manual-ndk'); assert.equal(f.notices.length, 0);
});

test('Native launch.json toolchain overrides reach LLDB server without leaking into CodeLLDB child', async t => {
  const f = await fixture(t); const overrides = { sdkRoot: 'launch-sdk', ndkRoot: 'launch-ndk' }; const adapter = await f.parent({ native: { ...overrides, abiSupported: ['arm64-v8a'] } }, true);
  assert.equal((await request(f, adapter, 'attach')).success, true);
  assert.equal(f.children[0].configuration.sdkRoot, undefined); assert.equal(f.children[0].configuration.ndkRoot, undefined); assert.equal(f.children[0].configuration.androidNativeToolchain, undefined);
});

test('original Native provider resolves select and cancellation before descriptor creation', async t => {
  const f = await fixture(t); const adapter = await f.parent({ target: 'select', pid: '42' }, true);
  assert.equal((await request(f, adapter, 'attach')).success, true); assert.equal(f.children[0].configuration.androidTarget.udid, 'picked');
  await adapter.dispose();
  f.selected = undefined; assert.equal(await f.parent({ target: 'select' }, true), undefined);
  f.trusted = false; await assert.rejects(f.providers.get('android-tools').resolveDebugConfiguration(undefined, { type: 'android-tools' }), /not trusted/);
});

test('Native real DAP launch installs APK resolves default Activity and selects matching app PID', async t => {
  const apkDir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'native-codelldb-apk-')); const apkPath = path.join(apkDir, 'app.apk'); fs.writeFileSync(apkPath, 'fixture'); t.after(() => fs.rmSync(apkDir, { recursive: true, force: true }));
  const f = await fixture(t); f.processes = [{ pid: '77', name: 'com.unrelated', packages: ['com.unrelated'] }, { pid: '42', name: 'com.example.app', packages: ['com.example.app'] }]; const adapter = await f.parent({ request: 'launch', pid: undefined, packageName: undefined, apkPath }, true);
  assert.equal((await request(f, adapter, 'launch')).success, true);
  assert.equal(f.children[0].configuration.pid, 42); assert.equal(f.children[0].configuration.androidPackageName, 'com.example.app');
  for (const name of ['install', 'activity', 'launch', 'resume']) assert.equal(f.calls.filter(call => call[0] === name).length, 1, name);
  assert.equal(f.calls.find(call => call[0] === 'process-list')[1], false);
  assert.equal(f.calls.find(call => call[0] === 'launch')[3], 'MainActivity');
  assert.equal((await request(f, adapter, 'disconnect')).success, true); assert.equal(f.calls.filter(call => call[0] === 'jdwp-cleanup').length, 1);
});

// 缺省Launch身份懒读当前Gradle选择；显式包/APK/Attach不被Build选择覆盖。
test('Native Launch uses lazy selected Gradle package and preserves explicit identity', async t => {
  const f = await fixture(t); f.gradlePackage = { packageName: 'com.gradle.selected', abiSupported: ['armeabi-v7a'] }; f.bestAbi = 'armeabi-v7a'; f.processes = [{ pid: '42', name: 'com.gradle.selected', packages: ['com.gradle.selected'] }];
  const automatic = await f.parent({ request: 'launch', pid: undefined, packageName: undefined }, true);
  assert.equal((await request(f, automatic, 'launch')).success, true); assert.equal(f.children[0].configuration.androidPackageName, 'com.gradle.selected');
  assert.equal(f.children[0].configuration.androidAbiSupported, undefined); assert.equal(f.children[0].configuration.androidAbi, 'armeabi-v7a');
  assert.equal(f.calls.filter(call => call[0] === 'gradle-package').length, 1); assert.equal(f.calls.find(call => call[0] === 'gradle-package')[1], root);
  const explicit = await fixture(t); explicit.gradlePackage = 'com.wrong.app'; const adapter = await explicit.parent({ request: 'launch', pid: undefined }, true);
  assert.equal((await request(explicit, adapter, 'launch')).success, true); assert.equal(explicit.children[0].configuration.androidPackageName, 'com.example.app'); assert.equal(explicit.calls.some(call => call[0] === 'gradle-package'), false);
  const failed = await fixture(t); failed.gradleFailure = new Error('selected Gradle metadata invalid');
  await assert.rejects(failed.parent({ request: 'launch', pid: undefined, packageName: undefined }, true), /Gradle metadata invalid/); assert.equal(failed.servers.length, 0);
});

test('Native start refusal exception absent child event and resume failure roll back owned server and listeners', async t => {
  for (const kind of ['refuse', 'throw', 'no-event', 'resume']) {
    const f = await fixture(t); if (kind === 'refuse') f.accept = false; if (kind === 'throw') f.startFailure = new Error('start exploded'); if (kind === 'no-event') f.report = false; if (kind === 'resume') f.resumeFailure = new Error('resume exploded');
    const adapter = await f.parent({ resumeProcess: kind === 'resume' });
    const response = await request(f, adapter, 'attach'); assert.equal(response.success, false, kind); assert.match(response.message, /CodeLLDB|exploded/);
    assert.equal(f.cleaned.length, 1, kind); assert.equal(f.starts.size, 0); assert.equal(f.ends.size, f.baseEnds);
  }
});

test('Native server errors invalid PIDs and invalid options become DAP failures without fake children', async t => {
  for (const config of [{ pid: -1 }, { pid: 42, processId: 43 }, { native: { initCommands: 7 } }, { target: 'select' }]) {
    const f = await fixture(t); const adapter = await f.parent(config); assert.equal((await request(f, adapter, 'attach')).success, false); assert.equal(f.children.length, 0); assert.equal(f.servers.length, 0);
  }
  const invalid = await fixture(t); const badLaunch = await invalid.parent({ request: 'launch', packageName: 'bad; id' }); assert.equal((await request(invalid, badLaunch, 'launch')).success, false); assert.equal(invalid.calls.some(call => call[0] === 'launch'), false);
  const f = await fixture(t); f.serverFailure = new Error('run-as denied'); const adapter = await f.parent(); const response = await request(f, adapter, 'attach'); assert.equal(response.success, false); assert.match(response.message, /run-as denied/);
});

test('Native disconnect awaits child then server and JDWP cleanup and duplicate dispose is idempotent', async t => {
  const f = await fixture(t); const adapter = await f.parent({ resumeProcess: true }); assert.equal((await request(f, adapter, 'attach')).success, true);
  f.serverGate = gate(); f.serverEntered = gate(); f.jdwpGate = gate(); let done = false;
  const closing = request(f, adapter, 'disconnect').then(result => { done = true; return result; });
  await f.serverEntered.promise; assert.equal(done, false); assert.equal(f.stopped.length, 1);
  f.serverGate.resolve(); f.jdwpGate.resolve(); assert.equal((await closing).success, true);
  await adapter.dispose(); assert.equal(f.cleaned.length, 1); assert.equal(f.stopped.length, 1);
});

test('Native dispose during child startup prevents VM resume and settles startup resources', async t => {
  const f = await fixture(t); f.startGate = gate(); f.startEntered = gate(); const adapter = await f.parent({ resumeProcess: true });
  const starting = request(f, adapter, 'attach'); await f.startEntered.promise; const closing = adapter.dispose(); f.startGate.resolve();
  assert.equal((await starting).success, false); await closing; assert.equal(f.calls.some(call => call[0] === 'resume'), false); assert.equal(f.cleaned.length, 1); assert.equal(f.starts.size, 0);
});

test('Native startup and cleanup failures retain every diagnostic and background failures are visible', async t => {
  const f = await fixture(t); f.accept = false; f.cleanupFailure = new Error('server stop refused'); const failed = await f.parent();
  const start = await request(f, failed, 'attach'); assert.equal(start.success, false); assert.match(start.message, /CodeLLDB rejected/); assert.match(start.message, /server stop refused/);
  const g = await fixture(t); const adapter = await g.parent(); assert.equal((await request(g, adapter, 'attach')).success, true);
  g.stopFailure = new Error('child stop refused'); g.cleanupFailure = new Error('server stop refused');
  const stop = await request(g, adapter, 'disconnect'); assert.equal(stop.success, false); assert.match(stop.message, /child stop refused/); assert.match(stop.message, /server stop refused/);
  const h = await fixture(t); const background = await h.parent(); assert.equal((await request(h, background, 'attach')).success, true);
  h.cleanupFailure = new Error('external server cleanup failed'); const noticed = gate(); h.noticeHook = noticed.resolve;
  for (const listener of [...h.ends]) listener(h.children[0]); assert.match(await noticed.promise, /external server cleanup failed/);
});

test('source lock preserves unmodified original snapshot hashes and Native provenance', () => {
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'src/android-debugger/native-debugger/upstream/SOURCE_LOCK.json'), 'utf8'));
  assert.equal(lock.source, 'E:/vscode-android-debug-main'); assert.equal(lock.algorithm, 'sha256'); assert.ok(lock.files.length >= 13);
  for (const file of lock.files) assert.equal(require('node:crypto').createHash('sha256').update(fs.readFileSync(path.join(root, 'src/android-debugger/native-debugger/upstream', file.path))).digest('hex'), file.sha256, file.path);
});
