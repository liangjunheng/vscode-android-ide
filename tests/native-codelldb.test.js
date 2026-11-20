const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const vm = require('node:vm');
const { build } = require('esbuild');
const root = path.resolve(__dirname, '..');

/** Node>=22 的 npm test 加载真实父 adapter、两阶段 provider 和 DAP；隔离设备/工具链边界并记录项目库发现输入，验证自动加载、冲突选择、旧记录清理及无外部库输入。 */
async function fixture(t) {
  const f = { codeLldb: { isActive: true, activated: false, async activate() { this.isActive = true; this.activated = true; } }, input: undefined, inputCalls: 0, projectLibraries: [], projectLibraryCalls: [], symbolCalls: [], symbolPicks: [], dialogCalls: 0, symbolStore: new Map(), symbolUpdates: [], toolchainFailure: undefined, seq: 0, trusted: true, starts: new Set(), ends: new Set(), providers: new Map(), commands: new Map(), children: [], servers: [], cleaned: [], stopped: [], notices: [], calls: [], selected: { udid: 'picked' }, accept: true, report: true, currentAbi: undefined, processes: [{ pid: '42', name: 'com.example.app', packages: ['com.example.app'] }, { pid: '77', name: 'com.unrelated', packages: ['com.unrelated'] }] };
  const disposable = set => listener => { set.add(listener); return { dispose: () => set.delete(listener) }; };
  const vscode = {
    Uri: { file: fsPath => ({ fsPath }) },
    DebugConfigurationProviderTriggerKind: {Initial:1,Dynamic:2},
    DebugAdapterInlineImplementation: class { constructor(implementation) { this.implementation = implementation; } },
    workspace: { get isTrusted() { return f.trusted; }, getConfiguration: () => ({ get: key => key === 'abiSupported' ? ['arm64-v8a', 'x86_64'] : key === 'abiMap' ? {} : undefined }) },
    extensions: { getExtension() { return f.codeLldb; } },
    window: { createOutputChannel: () => ({ appendLine() {} }), showErrorMessage: async message => { f.notices.push(message); f.noticeHook?.(message); }, showWarningMessage: async message => { f.notices.push(message); }, showInputBox: async options => { f.inputCalls++; f.inputPrompt = options.prompt; return f.input; }, showQuickPick: async (items, options) => { f.symbolPicks.push({ items, options }); if (f.symbolPickHook) return f.symbolPickHook(items, options); return undefined; }, showOpenDialog: async options => { f.dialogCalls++; f.dialogOptions = options; return f.dialogPaths?.map(fsPath => ({ fsPath })); } }, commands: { executeCommand: async () => undefined },
    commands: { registerCommand(name, action) { assert.equal(f.commands.has(name), false); f.commands.set(name, action); return { dispose() {} }; } },
    debug: {
      registerDebugAdapterDescriptorFactory() { throw new Error('Descriptor belongs to extension activation'); },
      registerDebugConfigurationProvider(type, provider, trigger) { if(trigger===2) { assert.equal(f.dynamicProvider,undefined); f.dynamicProvider=provider; f.dynamicType=type; } else { assert.equal(f.providers.has(type), false); f.providers.set(type, provider); } return { dispose() {} }; },
      onDidStartDebugSession: disposable(f.starts), onDidTerminateDebugSession: disposable(f.ends),
      async startDebugging(folder, config, options) {
        f.calls.push(['start-child', config.type]);
        if (config.type === 'lldb') {
          const provider = f.providers.get('lldb');
          const repeated = await provider.resolveDebugConfiguration(folder, { ...config });
          await provider.resolveDebugConfigurationWithSubstitutedVariables(folder, repeated);
        }
        if (f.childStartHook) await f.childStartHook(config, options);
        if (f.startFailure) throw f.startFailure;
        if (!f.accept) return false;
        if (f.startGate) { f.startEntered.resolve(); await f.startGate.promise; }
        const session = { id: 'child-' + f.children.length, type: config.type, configuration: config, parentSession: options.parentSession };
        f.children.push(session);
        if (f.report && f.reportType !== config.type) for (const listener of [...f.starts]) listener(session);
        if (f.terminateOnStart === config.type) for (const listener of [...f.ends]) listener(session);
        return true;
      },
      async stopDebugging(session) { f.stopped.push(session); f.stopHook?.(session); if (f.stopFailure) throw f.stopFailure; if (f.stopGate) await f.stopGate.promise; for (const listener of [...f.ends]) listener(session); },
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
    async getBestMappedAbi() { return 'aarch64'; }, async pickAndroidProcess() { f.calls.push(['pick-process']); return f.cancelProcess ? undefined : '42'; }, async resumeWaitingProcess() {},
    async getPackageNameForPid() { return 'com.example.app'; }, async getPackageNameFromApk() { return 'com.example.app'; },
    async resolvePackageName(args) { return args.packageName || 'com.example.app'; },
    async lldbServer(args) { if (f.serverFailure) throw f.serverFailure; const socket = '/platform-' + f.servers.length; f.servers.push({ socket, args }); return socket; },
    async lldbServerCleanup(socket) { f.cleaned.push(socket); f.serverEntered?.resolve(); if (f.serverGate) await f.serverGate.promise; if (f.cleanupFailure) throw f.cleanupFailure; },
  };
  const targetPicker = { activate() {}, setCurrentTarget() {}, resetCurrentTarget() {}, async pickTarget() { return f.selected; }, async getLastOrPickTarget() { return f.selected; }, async getTargetFromUDID(udid) { return { udid }; } };
  const mocks = { vscode, android, targetCommand, targetPicker,
    sdk: { adbPath: () => 'sdk-adb', listDevices: async () => { f.calls.push(['sdk-devices']); return [{ serial: 'picked', state: 'device' }]; } },
    projectLocalConfig: { readProjectLocalConfig: () => ({ debugger: { adbPath: 'session-adb' } }) },
    nativeToolchain: { findNativeSymbolSearchPaths: (projectRoot, native) => { f.symbolCalls.push({ projectRoot, paths: native?.symbolSearchPaths }); throw new Error('Legacy Native directory discovery must not be called'); }, resolveNativeToolchain: (projectRoot, overrides) => { if (f.toolchainFailure) { const error = f.toolchainFailure; f.toolchainFailure = undefined; throw error; } return { adb: 'adb', ndkRoot: overrides?.ndkRoot || 'ndk', sdkRoot: overrides?.sdkRoot || 'sdk', projectRoot }; }, nativeToolchainOverrides: native => ({ sdkRoot: native?.sdkRoot, ndkRoot: native?.ndkRoot }), validateNativeAbis() {} },
    projectLibraries: { discoverProjectLibraries: async (projectRoot, abi) => { f.projectLibraryCalls.push({ projectRoot, abi }); return f.projectLibraries; } },
    nativeTarget: {
      resolveLauncherActivity: async (adb, serial, pkg, signal) => { signal?.throwIfAborted(); f.calls.push(['activity', adb, serial, pkg]); return 'MainActivity'; },
      adbExec: async (adb, serial, args, signal) => {
        signal?.throwIfAborted(); f.calls.push(['adb', adb, serial, args, signal]);
        if (f.adbHook) return f.adbHook(adb, serial, args, signal);
        if (args[0] === 'install') { f.calls.push(['install']); return ''; }
        if (args.includes('am')) { f.calls.push(['launch', serial, undefined, args.at(-1).split('/')[1]]); return f.launchOutput || ''; }
        if (args.includes('pidof')) return f.pidOutput ?? f.processes.filter(p => p.name === args.at(-1)).map(p => p.pid).join(' ');
        if (args.includes('ps')) return 'PID NAME\n42 com.example.app\n77 com.unrelated\n';
        if (args.includes('cat')) return 'com.example.app\0';
        throw new Error('Unexpected adb invocation: ' + args.join(' '));
      },
    },
  };
  const result = await build({ entryPoints: [path.join(root, 'src/android-debugger/native-debugger/adapter.ts')], bundle: true, write: false, platform: 'node', format: 'cjs', external: ['@vscode/debugadapter'], plugins: [{ name: 'native-boundaries', setup(builder) {
    builder.onResolve({ filter: /^vscode$/ }, () => ({ path: 'mock:vscode', external: true }));
    builder.onResolve({ filter: /(?:^|[\/])(?:android|targetCommand|targetPicker|nativeToolchain|nativeTarget|sdk|projectLocalConfig|projectLibraries)$/ }, args => ({ path: 'mock:' + args.path.split(/[\/]/).at(-1), external: true }));
  } }] });
  const module = { exports: {} };
  vm.runInNewContext(result.outputFiles[0].text, { module, exports: module.exports, require: id => id.startsWith('mock:') ? mocks[id.slice(5)] : require(id), process, console, Buffer, structuredClone, AbortController });
  f.api = module.exports; f.context = { subscriptions: [], workspaceState: { get: key => structuredClone(f.symbolStore.get(key)), async update(key, value) { f.symbolUpdates.push({ key, value: structuredClone(value) }); if (value === undefined) f.symbolStore.delete(key); else f.symbolStore.set(key, structuredClone(value)); } } }; f.factory = f.api.createAndroidDebugAdapterFactory(f.context, folder => { f.calls.push(['gradle-package', folder?.uri.fsPath]); if (f.gradleFailure) throw f.gradleFailure; return f.gradlePackage; });
  f.baseEnds = f.ends.size;
  t.after(async () => { for (const owned of [...f.context.subscriptions].reverse()) await owned.dispose?.(); });
  f.parent = async (overrides = {}, resolve = false) => {
    const folder = { uri: { fsPath: root } };
    let config = { type: 'android-tools', name: 'Built-in Native', request: 'attach', androidMode: 'native', mode: 'native', target: 'serial', pid: 42, packageName: 'com.example.app', native: {}, ...overrides };
    if (resolve) { const provider = f.providers.get(config.type); config = await provider.resolveDebugConfiguration(folder, config); if (!config) return undefined; config = await provider.resolveDebugConfigurationWithSubstitutedVariables(folder, config); if (!config) return undefined; }
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
  assert.deepEqual([...f.providers.keys()], ['android-tools', 'android-debug', 'lldb']); assert.equal(f.factory.nativeOnly, true);
  assert.deepEqual([...f.commands.keys()], ['android-tools.pickAndroidProcess', 'android-tools.getBestAbi', 'android-tools.getBestMappedAbi', 'android-tools.resumeWaitingProcess']);
  assert.equal(f.calls.length, 0); assert.equal(f.servers.length, 0);
  assert.equal(f.dynamicType,'android-debug');
  assert.equal(f.dynamicProvider, f.providers.get('android-debug'));
  assert.equal(f.providers.get('android-tools').provideDebugConfigurations().length, 0);
  const initial=f.providers.get('android-debug').provideDebugConfigurations();
  const dynamic=f.dynamicProvider.provideDebugConfigurations();
  assert.equal(initial.length,6); assert.equal(dynamic.length,6); assert.equal(dynamic[0].target, 'select');
  assert.deepEqual(Array.from(dynamic, c => c.mode + ':' + c.request).sort(), ['dual:attach','dual:launch','java:attach','java:launch','native:attach','native:launch']);
  assert.equal(dynamic[0].type,'android-debug'); assert.equal(dynamic[0].request,'launch');
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

test('built-in Native real DAP attach loads project-built libraries and owns one CodeLLDB child', async t => {
  const f = await fixture(t); const app = path.join(root, 'build', 'libapp.so'), engine = path.join(root, 'build', 'libengine.so'); f.projectLibraries = [app, engine, app];
  const options = { abi: 'arm64-v8a', initCommands: ['settings set target.foo true'], preRunCommands: ['settings set target.user true'], symbolSearchPaths: ['external/unverified'], pid: 1, androidTarget: 'evil', platform: 'host' };
  const adapter = await f.parent({ native: options }, true);
  assert.equal((await request(f, adapter, 'initialize')).success, true);
  assert.equal((await request(f, adapter, 'attach')).success, true);
  assert.equal(f.children.length, 1); assert.equal(f.servers.length, 1, 'CodeLLDB provider rerun must not create another server');
  const config = f.children[0].configuration;
  assert.equal(config.type, 'lldb'); assert.equal(config.pid, 42); assert.equal(config.androidTarget.udid, 'serial'); assert.equal(config.androidPackageName, 'com.example.app');
  assert.equal(f.servers[0].args.device.androidProjectRoot, root); assert.equal(f.servers[0].args.abi, 'arm64-v8a');
  assert.deepEqual(Array.from(config.initCommands), ['platform select remote-android', 'platform connect unix-abstract-connect://[serial]/platform-0', 'settings set plugin.jit-loader.gdb.enable off', 'process handle SIGBUS SIGSEGV --pass true --stop false --notify false', 'breakpoint set --shlib libart.so --name art_sigsegv_fault', 'breakpoint set --shlib libart.so --name art_sigbus_fault', 'settings set target.foo true']);
  assert.deepEqual(options.initCommands, ['settings set target.foo true']);
  assert.deepEqual(options.symbolSearchPaths, ['external/unverified']);
  assert.deepEqual(Array.from(config.symbolSearchPaths), []);
  assert.deepEqual(Array.from(config.preRunCommands), ['settings set target.user true']);
  assert.deepEqual(Array.from(config.postRunCommands), [[app, engine].map(filename => 'target modules add -- ' + JSON.stringify(filename)), 'target modules list', 'image list -o -f'].flat());
  assert.deepEqual(options.preRunCommands, ['settings set target.user true']); assert.equal(config.androidNativeLibraries, undefined);
  assert.equal(f.inputCalls, 0); assert.equal(f.dialogCalls, 0); assert.equal(f.notices.length, 0); assert.equal(f.symbolUpdates.length, 0);
  assert.equal(f.projectLibraryCalls.length, 1); assert.deepEqual(f.projectLibraryCalls[0], { projectRoot: root, abi: 'arm64-v8a' });
  assert.equal(f.symbolCalls.length, 0); assert.equal(f.symbolPicks.length, 0); assert.equal(f.symbolStore.size, 0);
  assert.equal((await request(f, adapter, 'disconnect')).success, true); assert.equal(f.cleaned.length, 1); assert.equal(f.starts.size, 0); assert.equal(f.ends.size, f.baseEnds);
});

// 缺省native配置、ABI选择及显式ABI均只在第二阶段调用项目库来源；Node测试断言所选ABI和唯一库全集，无外部库UI。
test('Native project-built libraries auto-load only in the second phase using the selected ABI', async t => {
  for (const native of [undefined, { abi: 'select' }, { abi: 'x86_64', symbolSearchPaths: ['external/unverified'] }]) {
    const f = await fixture(t); f.bestAbi = 'x86_64'; const folder = { uri: { fsPath: root } };
    f.projectLibraries = [path.join(root, 'build', 'libapp.so'), path.join(root, 'build', 'libengine.so')];
    const config = { type: 'android-tools', request: 'attach', androidMode: 'native', mode: 'native', target: 'serial', pid: 42, packageName: 'com.example.app', native };
    const provider = f.providers.get('android-tools'); const resolved = await provider.resolveDebugConfiguration(folder, config);
    assert.equal(f.inputCalls, 0); assert.deepEqual(f.projectLibraryCalls, []); assert.equal(f.symbolCalls.length, 0);
    const substituted = await provider.resolveDebugConfigurationWithSubstitutedVariables(folder, resolved);
    assert.deepEqual(f.projectLibraryCalls, [{ projectRoot: root, abi: 'x86_64' }]); assert.deepEqual(Array.from(substituted.androidNativeLibraries), f.projectLibraries);
    assert.deepEqual(Array.from(substituted.native.symbolSearchPaths), []); assert.equal(f.symbolCalls.length, 0); assert.equal(f.symbolPicks.length, 0);
    assert.equal(f.inputCalls, 0); assert.equal(f.dialogCalls, 0); assert.equal(f.servers.length, 0); assert.equal(f.children.length, 0);
  }
});

// 项目唯一库全加载，同名库按真实mtime取最新，精确命令只进入LLDB一次且不弹窗。
test('Native project libraries reach CodeLLDB once using the newest duplicates without UI', async t => {
  const f = await fixture(t); const temp = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'native-project-libraries-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const unique = path.join(temp, 'debug', 'libunique.so');
  const first = path.join(temp, 'debug', 'libsame.so');
  const selected = path.join(temp, 'previous', 'libsame.so');
  const second = path.join(temp, 'debug', 'libsecond.so'), secondAlternative = path.join(temp, 'previous', 'libsecond.so');
  fs.mkdirSync(path.dirname(unique), { recursive: true }); fs.mkdirSync(path.dirname(selected), { recursive: true });
  for (const filename of [unique, first, selected, second, secondAlternative]) fs.writeFileSync(filename, 'project library boundary fixture');
  f.projectLibraries = [unique, first, selected, unique, second, secondAlternative];
  const now = Date.now() / 1000;
  fs.utimesSync(first, now - 20, now - 20); fs.utimesSync(selected, now - 10, now - 10);
  fs.utimesSync(second, now - 10, now - 10); fs.utimesSync(secondAlternative, now - 20, now - 20);
  f.symbolPickHook = () => { throw new Error('Native symbol loading must not ask the user'); };
  const native = { abi: 'arm64-v8a', preRunCommands: ['settings set target.foo true'], symbolSearchPaths: ['external/unverified'] };
  const adapter = await f.parent({ androidProjectRoot: temp, native }, true);
  assert.equal(f.inputCalls, 0); assert.deepEqual(f.projectLibraryCalls, [{ projectRoot: temp, abi: 'arm64-v8a' }]);
  assert.equal(f.symbolPicks.length, 0); assert.equal(f.symbolStore.size, 0); assert.equal(f.symbolUpdates.length, 0);
  assert.equal((await request(f, adapter, 'attach')).success, true);
  const config = f.children[0].configuration;
  assert.deepEqual(Array.from(config.symbolSearchPaths), []);
  assert.deepEqual(Array.from(config.preRunCommands), ['settings set target.foo true']);
  assert.deepEqual(Array.from(config.postRunCommands), [[unique, selected, second].map(filename => 'target modules add -- ' + JSON.stringify(filename)), 'target modules list', 'image list -o -f'].flat());
  assert.deepEqual(native.preRunCommands, ['settings set target.foo true']); assert.equal(config.androidNativeLibraries, undefined);
  assert.deepEqual(Array.from(config.initCommands).filter(command => command.includes('target.exec-search-paths')), []);
  assert.equal(f.projectLibraryCalls.length, 1); assert.equal(f.symbolPicks.length, 0); assert.equal(f.dialogCalls, 0);
  assert.equal(f.servers.length, 1); assert.equal(f.notices.length, 0);
  assert.equal((await request(f, adapter, 'disconnect')).success, true); assert.equal(f.cleaned.length, 1);
  // 下次重新检查产物mtime，新编译库与新增唯一库不能被旧记录屏蔽。
  const added = path.join(temp, 'debug', 'libadded.so'); fs.writeFileSync(added, 'project library boundary fixture'); f.projectLibraries.push(added);
  fs.utimesSync(first, now, now); fs.utimesSync(secondAlternative, now, now);
  const next = await f.parent({ androidProjectRoot: temp, native: { abi: 'arm64-v8a' } }, true);
  assert.equal((await request(f, next, 'attach')).success, true);
  assert.equal(f.children[1].configuration.preRunCommands, undefined);
  assert.deepEqual(Array.from(f.children[1].configuration.postRunCommands), [[unique, first, secondAlternative, added].map(filename => 'target modules add -- ' + JSON.stringify(filename)), 'target modules list', 'image list -o -f'].flat());
  assert.equal(f.projectLibraryCalls.length, 2); assert.equal(f.symbolPicks.length, 0); assert.equal(f.symbolUpdates.length, 0); assert.equal(f.symbolStore.size, 0);
});

// 每次发现都清除当前 project/pkg/abi 的旧手选白名单，保留别项目记录；选择不写回，新库下次仍重新自动加载。
test('Native clears obsolete current selection without persistence and preserves other project records', async t => {
  const f = await fixture(t); const current = 'androidNative.symbols:' + JSON.stringify([root, 'com.example.app', 'arm64-v8a']);
  const other = 'androidNative.symbols:' + JSON.stringify([path.join(root, 'other'), 'com.example.app', 'arm64-v8a']);
  const otherPackage = 'androidNative.symbols:' + JSON.stringify([root, 'com.other.app', 'arm64-v8a']);
  const otherAbi = 'androidNative.symbols:' + JSON.stringify([root, 'com.example.app', 'x86_64']);
  const saved = { files: ['/wrong/prebuilt.so'], directories: ['/old/external'] };
  for (const key of [current, other, otherPackage, otherAbi]) f.symbolStore.set(key, saved);
  const provider = f.providers.get('android-tools'); const folder = { uri: { fsPath: root } };
  const config = { type: 'android-tools', request: 'attach', androidMode: 'native', mode: 'native', target: 'serial', pid: 42, packageName: 'com.example.app', native: { abi: 'arm64-v8a' } };
  f.projectLibraries = [path.join(root, 'build', 'libfirst.so')];
  let resolved = await provider.resolveDebugConfiguration(folder, config); let substituted = await provider.resolveDebugConfigurationWithSubstitutedVariables(folder, resolved);
  assert.deepEqual(Array.from(substituted.androidNativeLibraries), f.projectLibraries); assert.equal(f.symbolPicks.length, 0);
  assert.equal(f.symbolStore.has(current), false);
  for (const key of [other, otherPackage, otherAbi]) assert.deepEqual(f.symbolStore.get(key), saved);
  assert.deepEqual(f.symbolUpdates, [{ key: current, value: undefined }]);
  f.projectLibraries.push(path.join(root, 'build', 'libsecond.so')); f.symbolStore.set(current, saved);
  resolved = await provider.resolveDebugConfiguration(folder, config); substituted = await provider.resolveDebugConfigurationWithSubstitutedVariables(folder, resolved);
  assert.deepEqual(Array.from(substituted.androidNativeLibraries), f.projectLibraries); assert.equal(f.symbolPicks.length, 0);
  assert.equal(f.symbolStore.has(current), false);
  for (const key of [other, otherPackage, otherAbi]) assert.deepEqual(f.symbolStore.get(key), saved);
  assert.equal(f.projectLibraryCalls.length, 2); assert.deepEqual(f.symbolUpdates, [{ key: current, value: undefined }, { key: current, value: undefined }]);
  assert.equal(f.symbolStore.size, 3); assert.equal(f.dialogCalls, 0); assert.equal(f.inputCalls, 0);
});

// 显式取消令牌仍在配置阶段阻止资源分配，同名自动选择不再依赖UI取消。
test('Native cancellation before project discovery never creates server or child', async t => {
  const temp = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'native-conflict-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const files = ['one/libsame.so', 'two/libsame.so', 'one/libsecond.so', 'two/libsecond.so', 'one/libunique.so'].map(file => path.join(temp, file));
  for (const filename of files) { fs.mkdirSync(path.dirname(filename), { recursive: true }); fs.writeFileSync(filename, 'project library boundary fixture'); }
  const f = await fixture(t); f.projectLibraries = files;
  const provider = f.providers.get('android-tools');
  const folder = { uri: { fsPath: temp } };
  const config = { type: 'android-tools', request: 'attach', name: 'Cancelled Native', mode: 'native', target: 'serial', pid: 42, packageName: 'com.example.app', native: { abi: 'arm64-v8a' }, androidProjectRoot: temp };
  const resolved = await provider.resolveDebugConfiguration(folder, config);
  assert.equal(await provider.resolveDebugConfigurationWithSubstitutedVariables(folder, resolved, { isCancellationRequested: true }), null);
  assert.equal(f.projectLibraryCalls.length, 0); assert.equal(f.symbolPicks.length, 0);
  assert.equal(f.servers.length, 0); assert.equal(f.children.length, 0); assert.equal(f.inputCalls, 0); assert.equal(f.dialogCalls, 0);
});

// 用户 preRunCommands 的类型错误必须在创建远程 server 前失败，不能因追加模块命令而掩盖。
test('Native selected libraries preserve preRunCommands validation before server allocation', async t => {
  const f = await fixture(t); const temp = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'native-options-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const filename = path.join(temp, 'libapp.so'); fs.writeFileSync(filename, 'ELF debug fixture'); f.projectLibraries = [filename];
  const adapter = await f.parent({ native: { abi: 'arm64-v8a', preRunCommands: 'not an array' } }, true);
  const response = await request(f, adapter, 'attach');
  assert.equal(response.success, false); assert.match(response.message, /preRunCommands must be a string array/);
  assert.equal(f.servers.length, 0); assert.equal(f.children.length, 0);
});

// 无项目编译记录返回空列表，不提供旧浏览/手填外部库入口；Node测试断言成功attach后才警告，child启动失败不警告。
test('Native missing project-built debug libraries continue with a warning after child attach', async t => {
  const f = await fixture(t); f.projectLibraries = []; const adapter = await f.parent({ native: { abi: 'arm64-v8a', symbolSearchPaths: ['external/unverified'] } }, true);
  assert.equal(f.inputCalls, 0); assert.equal(f.notices.length, 0); assert.equal(f.symbolPicks.length, 0); assert.equal(f.dialogCalls, 0);
  assert.deepEqual(f.projectLibraryCalls, [{ projectRoot: root, abi: 'arm64-v8a' }]);
  f.childStartHook = () => { assert.equal(f.notices.length, 0); };
  assert.equal((await request(f, adapter, 'attach')).success, true); assert.equal(f.inputCalls, 0);
  assert.deepEqual(Array.from(f.children[0].configuration.symbolSearchPaths), []); assert.equal(f.children[0].configuration.preRunCommands, undefined);
  assert.equal(f.symbolUpdates.length, 0); assert.equal(f.symbolStore.size, 0); assert.equal(f.symbolPicks.length, 0); assert.equal(f.dialogCalls, 0);
  assert.equal(f.children.length, 1); assert.equal(f.notices.length, 1); assert.match(f.notices[0], /no project-built \.so files with debug information were found for this ABI/);
  assert.match(f.notices[0], /External and precompiled libraries are not loaded automatically/);
  const rejected = await fixture(t); rejected.projectLibraries = []; rejected.accept = false; const rejectedAdapter = await rejected.parent({ native: { abi: 'arm64-v8a' } }, true);
  assert.equal((await request(rejected, rejectedAdapter, 'attach')).success, false);
  assert.equal(rejected.inputCalls, 0); assert.equal(rejected.notices.some(message => /project-built \.so files with debug information/.test(message)), false);
});

test('Native prompts for a missing NDK and retries the current session', async t => {
  const f = await fixture(t); f.toolchainFailure = new Error('Cannot determine valid Android NDK root'); f.input = 'manual-ndk';
  const folder = { uri: { fsPath: root } };
  const config = { type: 'android-tools', name: 'Built-in Native', request: 'attach', androidMode: 'native', mode: 'native', target: 'serial', pid: 42, packageName: 'com.example.app', native: {} };
  const resolved = await f.providers.get('android-tools').resolveDebugConfiguration(folder, config);
  assert.equal(resolved.native.ndkRoot, 'manual-ndk'); assert.equal(f.notices.length, 0);
});

test('Native launch.json toolchain overrides reach LLDB server without leaking into CodeLLDB child', async t => {
  const f = await fixture(t); f.projectLibraries = []; const overrides = { sdkRoot: 'launch-sdk', ndkRoot: 'launch-ndk' }; const adapter = await f.parent({ native: { ...overrides, abiSupported: ['arm64-v8a'] } }, true);
  assert.equal((await request(f, adapter, 'attach')).success, true);
  assert.equal(f.notices.some(message => /project-built \.so files with debug information/.test(message)), true);
  assert.equal(f.children[0].configuration.sourceLanguages?.[0], 'c'); assert.equal(f.children[0].configuration.sourceLanguages?.[1], 'cpp'); assert.equal(f.children[0].configuration.sdkRoot, undefined); assert.equal(f.children[0].configuration.ndkRoot, undefined); assert.equal(f.children[0].configuration.androidNativeToolchain, undefined);
});

test('original Native provider resolves select and cancellation before descriptor creation', async t => {
  const f = await fixture(t); const adapter = await f.parent({ target: 'select', pid: '42' }, true);
  assert.equal((await request(f, adapter, 'attach')).success, true); assert.equal(f.children[0].configuration.androidTarget.udid, 'picked');
  await adapter.dispose();
  f.selected = undefined; assert.equal(await f.parent({ target: 'select' }, true), undefined);
  f.trusted = false; await assert.rejects(f.providers.get('android-tools').resolveDebugConfiguration(undefined, { type: 'android-tools' }), /not trusted/);
});

test('Native real DAP launch installs explicit APK once and queries the exact package PID', async t => {
  const apkDir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'native-codelldb-apk-')); const apkPath = path.join(apkDir, 'app.apk'); fs.writeFileSync(apkPath, 'fixture'); t.after(() => fs.rmSync(apkDir, { recursive: true, force: true }));
  const f = await fixture(t); f.processes = [{ pid: '42', name: 'com.example.app', packages: ['com.example.app'] }, { pid: '77', name: 'com.unrelated', packages: ['com.unrelated'] }]; const adapter = await f.parent({ request: 'launch', pid: undefined, packageName: undefined, apkPath }, true);
  assert.equal((await request(f, adapter, 'launch')).success, true);
  assert.equal(f.children[0].configuration.pid, 42); assert.equal(f.children[0].configuration.androidPackageName, 'com.example.app');
  for (const name of ['install', 'activity', 'launch', 'resume']) assert.equal(f.calls.filter(call => call[0] === name).length, 1, name);
  assert.equal(f.calls.some(call => call[0] === 'process-list'), false);
  assert.deepEqual(Array.from(f.calls.find(call => call[0] === 'adb' && call[3].includes('pidof'))[3]), ['shell', 'pidof', 'com.example.app']);
  assert.equal(f.calls.find(call => call[0] === 'adb' && call[3].includes('am'))[3].includes('-W'), false);
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

test('Native attach cancels quietly when the package process is absent', async t => {
  const f = await fixture(t); f.adbHook = (adb, serial, args) => args.includes('pidof') ? '' : undefined;
  const result = await f.parent({ type: 'android-debug', mode: 'native', pid: undefined, processId: undefined, packageName: 'com.example.app' }, true);
  assert.equal(result, undefined);
  assert.equal(f.servers.length, 0); assert.equal(f.children.length, 0); assert.match(f.notices[0], /process for com\.example\.app is not running/);
});

test('Native attach preserves actual ADB device errors during pid lookup', async t => {
  const f = await fixture(t); f.adbHook = (adb, serial, args) => args.includes('pidof') ? Promise.reject(new Error('Command failed: adb -s serial shell pidof com.example.app\nerror: device unauthorized')) : undefined;
  await assert.rejects(f.parent({ type: 'android-debug', mode: 'native', pid: undefined, processId: undefined, packageName: 'com.example.app' }, true), /unauthorized/);
});
test('Native server errors invalid PIDs and invalid options become DAP failures without fake children', async t => {
  for (const config of [{ pid: -1 }, { pid: 42, processId: 43 }, { native: { initCommands: 7 } }, { target: 'select' }]) {
    const f = await fixture(t); const adapter = await f.parent(config); assert.equal((await request(f, adapter, 'attach')).success, false); assert.equal(f.children.length, 0); assert.equal(f.servers.length, 0);
  }
  const legacy = await fixture(t);
  await assert.rejects(legacy.parent({ mode: 'dual' }, true), /Only Android Native/);
  const legacyAdapter = await legacy.parent({ mode: 'java' }); assert.equal((await request(legacy, legacyAdapter, 'attach')).success, false);
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

// 六组合必须经真实父 DAP、配置两阶段及 child start；Java 工具链失败保持未消费，证明不读取 NDK/ABI/符号。
test('unified Android three modes times launch and attach wire real children without duplicate resume', async t => {
  for (const mode of ['native', 'java', 'dual']) for (const command of ['launch', 'attach']) {
    const f = await fixture(t);
    const unavailable = new Error('NDK must not be requested');
    if (mode === 'java') { f.toolchainFailure = unavailable; f.codeLldb = undefined; }
    const java = { type: 'kotlin-jvm', name: 'Nested JVM', sourcePaths: ['nested/src'], port: 5005, request: 'launch', android: false, serial: 'evil', pid: 1, processId: 2, packageName: 'com.evil.app', projectRoot: 'evil', options: { enabled: true } };
    const adapter = await f.parent({ type: 'android-debug', mode, request: command, pid: command === 'attach' ? 42 : undefined, java, sourcePaths: ['fallback/src'], resumeProcess: true }, true);
    assert.equal((await request(f, adapter, command)).success, true, mode + ':' + command);
    assert.deepEqual(f.children.map(child => child.type), mode === 'native' ? ['lldb'] : mode === 'java' ? ['kotlin-jvm'] : ['lldb', 'kotlin-jvm']);
    assert.equal(f.calls.filter(call => call[0] === 'resume').length, mode === 'native' ? 1 : 0);
    assert.equal(f.calls.filter(call => call[0] === 'install').length, 0);
    if (command === 'attach') assert.equal(f.calls.filter(call => call[0] === 'launch').length, 0);
    if (mode === 'java') {
      assert.equal(f.toolchainFailure, unavailable); assert.equal(f.symbolCalls.length, 0); assert.equal(f.projectLibraryCalls.length, 0); assert.equal(f.symbolPicks.length, 0); assert.equal(f.servers.length, 0); assert.equal(f.calls.some(call => call[0] === 'device'), false);
      assert.equal(f.symbolUpdates.length, 0); assert.equal(f.dialogCalls, 0); assert.equal(f.inputCalls, 0);
    } else {
      assert.equal(f.projectLibraryCalls.length, 1); assert.equal(f.projectLibraryCalls[0].abi, 'arm64-v8a');
    }
    if (mode !== 'native') {
      const child = f.children.at(-1).configuration;
      assert.equal(child.request, 'attach'); assert.equal(child.android, true); assert.equal(child.serial, 'serial'); assert.equal(child.target, 'serial');
      assert.equal(child.pid, 42); assert.equal(child.processId, 42); assert.equal(child.packageName, 'com.example.app'); assert.equal(child.projectRoot, 'evil');
      assert.deepEqual(Array.from(child.sourcePaths), ['nested/src']); assert.equal(child.port, undefined); assert.equal(child.name, 'Nested JVM');
      child.options.enabled = false; assert.equal(java.options.enabled, true);
    }
    assert.equal((await request(f, adapter, 'disconnect')).success, true); assert.equal(f.stopped.length, f.children.length); assert.equal(f.starts.size, 0);
  }
});

// attach 不得因缺包名/PID读取无关 Build；取消进程和设备选择均在资源分配前结束。
test('attach accepts processId exact package lookup and process picker cancellation without Build', async t => {
  for (const mode of ['native', 'java', 'dual']) {
    const f = await fixture(t); f.gradleFailure = new Error('unrelated Build');
    const explicit = await f.parent({ type: 'android-debug', mode, pid: undefined, processId: '42', packageName: undefined }, true);
    assert.equal((await request(f, explicit, 'attach')).success, true);
    assert.equal(f.children[0].configuration.pid, 42); assert.equal(f.calls.some(call => call[0] === 'gradle-package'), false);
    const pkg = await fixture(t);
    const byPackage = await pkg.parent({ type: 'android-debug', mode, pid: undefined }, true);
    assert.equal((await request(pkg, byPackage, 'attach')).success, true);
    assert.equal(pkg.children[0].configuration.pid, 42);
    assert.equal(pkg.calls.some(call => call[0] === 'pick-process'), false);
  }
  const cancelled = await fixture(t); cancelled.cancelProcess = true;
  assert.equal(await cancelled.parent({ pid: undefined, packageName: undefined }, true), undefined); assert.equal(cancelled.servers.length, 0);
  const java = await fixture(t); java.symbolPickHook = () => undefined;
  assert.equal(await java.parent({ type: 'android-debug', mode: 'java', target: 'select' }, true), undefined);
  assert.equal(java.calls.some(call => call[0] === 'sdk-devices'), true); assert.equal(java.symbolCalls.length, 0); assert.equal(java.projectLibraryCalls.length, 0);
  assert.equal(await java.parent({ type: 'android-debug', mode: 'java', pid: undefined, packageName: undefined }, true), undefined);
  const picked = await fixture(t);
  picked.symbolPickHook = (items, options) => options.placeHolder === 'Pick Android Process' ? items[0] : undefined;
  const selected = await picked.parent({ type: 'android-debug', mode: 'java', pid: undefined, packageName: undefined }, true);
  assert.equal((await request(picked, selected, 'attach')).success, true);
  assert.equal(picked.children[0].configuration.pid, 42); assert.equal(picked.children[0].configuration.packageName, 'com.example.app');
  assert.equal(picked.calls.some(call => call[0] === 'gradle-package'), false);
});

// 启动失败、假 child 或 child 在 start 内退出必须 rollback 两边且不能死锁；生命周期只响应所属父。
test('dual child startup failure absent JVM event and early exits roll back every owned resource', async t => {
  for (const failure of ['refuse', 'throw', 'missing', 'lldb-exit', 'jvm-exit']) {
    const f = await fixture(t);
    if (failure === 'missing') f.reportType = 'kotlin-jvm';
    if (failure === 'lldb-exit') f.terminateOnStart = 'lldb';
    if (failure === 'jvm-exit') f.terminateOnStart = 'kotlin-jvm';
    f.childStartHook = config => {
      if (config.type !== 'kotlin-jvm') return;
      assert.equal(f.children[0].type, 'lldb');
      if (failure === 'refuse') f.accept = false;
      if (failure === 'throw') throw new Error('JVM start failed');
    };
    const adapter = await f.parent({ type: 'android-debug', mode: 'dual' }, true);
    const response = await request(f, adapter, 'attach');
    assert.equal(response.success, false, failure); assert.match(response.message, /JVM|child session terminated/);
    assert.equal(f.cleaned.length, 1); assert.equal(f.calls.some(call => call[0] === 'resume'), false);
    await adapter.dispose(); assert.equal(f.starts.size, 0); assert.equal(f.ends.size, f.baseEnds);
  }
});

// 正常运行时任一必要 child 终止都关闭另一侧；外部 child 终止不影响本父，关闭错误仍发 terminated。
test('either dual child exit terminates the parent and closes the sibling with aggregated errors', async t => {
  for (const type of ['lldb', 'kotlin-jvm']) {
    const f = await fixture(t); const adapter = await f.parent({ type: 'android-debug', mode: 'dual' }, true);
    assert.equal((await request(f, adapter, 'attach')).success, true);
    for (const listener of [...f.ends]) listener({ id: 'foreign', type, parentSession: { id: 'foreign-parent' }, configuration: {} });
    assert.equal(f.stopped.length, 0);
    const terminated = gate(); const subscription = adapter.onDidSendMessage(message => { if (message.event === 'terminated') terminated.resolve(); });
    if (type === 'kotlin-jvm') { f.stopFailure = new Error('sibling stop failed'); f.cleanupFailure = new Error('server stop failed'); }
    for (const listener of [...f.ends]) listener(f.children.find(child => child.type === type));
    await terminated.promise; subscription.dispose(); assert.equal(f.stopped.length, 1); assert.equal(f.cleaned.length, 1);
    if (type === 'kotlin-jvm') assert.ok(f.notices.some(message => /sibling stop failed/.test(message) && /server stop failed/.test(message)));
    assert.equal(f.starts.size, 0);
  }
});

// 唯一 PID、am 错误和顶层源码回退都必须可执行断言，不能误取 JDWP 最后一项。
test('launch rejects ambiguous PID and activity errors and JVM sourcePaths fall back to top level', async t => {
  for (const output of ['', '42 77', 'not-a-pid']) {
    const f = await fixture(t); f.pidOutput = output;
    const adapter = await f.parent({ type: 'android-debug', mode: 'java', request: 'launch', pid: undefined }, true);
    assert.equal((await request(f, adapter, 'launch')).success, false); assert.equal(f.children.length, 0);
  }
  const failed = await fixture(t); failed.launchOutput = 'Error: activity not found';
  const adapter = await failed.parent({ request: 'launch', pid: undefined }, true);
  assert.equal((await request(failed, adapter, 'launch')).success, false); assert.equal(failed.children.length, 0);
  const f = await fixture(t); const fallback = await f.parent({ type: 'android-debug', mode: 'java', sourcePaths: ['top/src'] }, true);
  assert.equal((await request(f, fallback, 'attach')).success, true); assert.deepEqual(Array.from(f.children[0].configuration.sourcePaths), ['top/src']);
});

// 关闭取消的 signal 必须是本次父会话所有，ADB 中断后不得创建 child；另一会话仍能正常启动。
test('closing aborts only this parent launch ADB command and never starts a late child', async t => {
  const f = await fixture(t); const entered = gate();
  f.adbHook = async (_adb, _serial, args, signal) => {
    assert.equal(args.includes('am'), true); entered.resolve(signal);
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  };
  const adapter = await f.parent({ type: 'android-debug', mode: 'java', request: 'launch', launchActivity: '.MainActivity', pid: undefined }, true);
  const starting = request(f, adapter, 'launch'); const signal = await entered.promise;
  const closing = adapter.dispose(); assert.equal(signal.aborted, true); assert.equal((await starting).success, false); await closing;
  assert.equal(f.children.length, 0); assert.equal(f.starts.size, 0);
  f.adbHook = undefined;
  const other = await f.parent({ type: 'android-debug', mode: 'java' }, true); assert.equal((await request(f, other, 'attach')).success, true);
});

// 父生成配置继续进入真实 bundled JVM 适配层，验证动态 JDWP 端口与精确 forward 归属，而不是只检查配置文本。
test('parent JVM child uses bundled dynamic JDWP forwarding and removes its exact allocated port', async t => {
  const f = await fixture(t); const parent = await f.parent({ type: 'android-debug', mode: 'dual', java: { port: 5005 } }, true);
  assert.equal((await request(f, parent, 'attach')).success, true);
  const config = f.children.at(-1).configuration;
  const { EventEmitter } = require('node:events'); const { PassThrough } = require('node:stream');
  class Emitter {
    listeners = new Set();
    event = listener => { this.listeners.add(listener); return { dispose: () => this.listeners.delete(listener) }; };
    fire(value) { for (const listener of this.listeners) listener(value); }
    dispose() { this.listeners.clear(); }
  }
  const calls = [], errors = [], writes = [];
  const module = { exports: {} };
  const dependencies = {
    vscode: { EventEmitter: Emitter }, './java': {}, '../index': {},
    '../../sdk': { adbPath: () => 'sdk-adb' }, '../../projectLocalConfig': { readProjectLocalConfig: () => ({ debugger: { adbPath: 'session-adb' } }) },
    '../native-debugger/nativeTarget': { adbExec: async (adb, serial, args) => { calls.push([adb, serial, Array.from(args)]); return args[1] === 'tcp:0' ? '41873' : ''; } },
  };
  vm.runInNewContext(require('esbuild').transformSync(fs.readFileSync(path.join(root, 'src/android-debugger/jvm-debugger/adapter.ts'), 'utf8'), { loader: 'ts', format: 'cjs' }).code,
    { module, exports: module.exports, require: id => dependencies[id] ?? require(id), Buffer, AbortController, AggregateError });
  const child = new EventEmitter(); Object.assign(child, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill() { this.emit('close', 0); return true; } });
  child.stdin.on('data', value => writes.push(Buffer.from(value)));
  const adapter = new module.exports.AndroidJvmAdapter(child, config, error => errors.push(error));
  adapter.handleMessage({ type: 'request', seq: 1, command: 'attach', arguments: {} });
  await adapter.startup;
  assert.deepEqual(calls, [['session-adb', 'serial', ['forward', 'tcp:0', 'jdwp:42']]]);
  const sent = JSON.parse(writes[0].subarray(writes[0].indexOf('\r\n\r\n') + 4));
  assert.equal(sent.arguments.port, 41873); assert.equal(sent.arguments.pid, 42); assert.equal(sent.command, 'attach');
  await adapter.close(); assert.deepEqual(calls.at(-1), ['session-adb', 'serial', ['forward', '--remove', 'tcp:41873']]); assert.equal(errors.length, 0);
});

// startDebugging 可在收到 child 后等待其关闭；dispose 必须先 stop child 再等 startup，避免互等。
test('dispose releases a reported child while startDebugging is still waiting for child shutdown', async t => {
  const f = await fixture(t); const reported = gate(); const stopped = gate();
  f.childStartHook = async (config, options) => {
    const child = { id: 'starting-child', type: config.type, configuration: config, parentSession: options.parentSession };
    for (const listener of [...f.starts]) listener(child);
    reported.resolve();
    await stopped.promise;
    f.accept = false;
  };
  const adapter = await f.parent(); const starting = request(f, adapter, 'attach');
  await reported.promise;
  f.stopHook = () => stopped.resolve();
  const closing = adapter.dispose();
  assert.equal((await starting).success, false); await closing;
  assert.equal(f.stopped.length, 1); assert.equal(f.cleaned.length, 1); assert.equal(f.starts.size, 0);
});

test('source lock preserves unmodified original snapshot hashes and Native provenance', () => {
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'src/android-debugger/native-debugger/upstream/SOURCE_LOCK.json'), 'utf8'));
  assert.equal(lock.source, 'E:/vscode-android-debug-main'); assert.equal(lock.algorithm, 'sha256'); assert.ok(lock.files.length >= 13);
  for (const file of lock.files) assert.equal(require('node:crypto').createHash('sha256').update(fs.readFileSync(path.join(root, 'src/android-debugger/native-debugger/upstream', file.path))).digest('hex'), file.sha256, file.path);
});
