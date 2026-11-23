/**
 * 功能点：Android 真实调试会话的配置转换、tracker 就绪与资源所有权单元测试。
 * 受影响对象：debugging.ts、device.ts 的设备边界、index.ts、autoConfig.ts、startup.ts 和 NativeConnection 边界。
 * 复现路径：Node>=22、已安装 esbuild；内存加载当前生产模块，注册真实 provider/tracker，手动发送宿主会话事件及 DAP 观测。
 * 测试范围：六模式、Launch/Attach、initialize/attach/configurationDone/continued、取消和迟到资源、root/child termination、destroy/detach、幂等停止、外部端口、别名与非法输入、改写重入、公开启动完成时机；不覆盖设备协议或真实引擎实现。
 * 执行入口：node --test tests/android-debugging.test.js；完整回归使用npm test，不连接设备。
 * 预期结果：所有业务流程执行真实函数，仅替换 DebugDevice、NativeConnection、APK 元数据查询和 vscode 宿主边界，无 DAP 代理。
 * 判据：逐项严格断言配置、事件时序、资源账本和 termination 等待；当前缺陷保持失败，不使用 skip、todo 或放宽断言。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Module } = require('node:module');
const { transformSync } = require('esbuild');

const root = path.resolve(__dirname, '..');
const sourceRoot = path.join(root, 'src', 'android-debugger');
const serial = 'unit-device-50';
const packageName = 'test.android.debugging';
const pid = 501;

/** 功能：建立可控异步边界；输入无；输出完成和拒绝入口，不使用计时等待。 */
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

/** 功能：排空当前异步任务；输入无；输出一个宿主事件循环检查点。 */
async function flush() { await new Promise(resolve => setImmediate(resolve)); }

/** 功能：记录 Promise 是否结算；输入业务 Promise；输出不改变其结果的观测。 */
function observe(promise) {
  const state = { settled: false, value: undefined, error: undefined };
  promise.then(value => { state.settled = true; state.value = value; }, error => { state.settled = true; state.error = error; });
  return state;
}

/** 功能：创建可同步发送的宿主事件；输入无；输出订阅和发送入口。 */
function eventSource() {
  const listeners = new Set();
  return {
    event(listener) { listeners.add(listener); return { dispose: () => listeners.delete(listener) }; },
    fire(value) { for (const listener of [...listeners]) listener(value); },
  };
}

/** 功能：搭建独占设备和宿主边界；输入测试上下文；输出真实生产模块及可审计资源账本。 */
function fixture(t) {
  const calls = [], providers = new Map(), trackers = new Map(), cache = new Map();
  const started = eventSource(), terminated = eventSource(), cancelled = eventSource();
  const sessions = new Set(), errors = [], warnings = [];
  const hooks = {};
  const folder = { uri: { fsPath: root } };
  const context = { subscriptions: [], workspaceState: { get: (_key, value) => value, update: async () => undefined, keys: () => [] } };
  let sequence = 0, port = 45000;
  const state = { autoTerminate: true, cancelled: false };
  /** 功能：登记边界调用；输入操作名和参数；输出可精确计数的记录。 */
  function record(name, ...args) { calls.push({ name, args }); }
  /** 功能：建立资源租约；输入明确所有者；输出关闭次数可观测且不隐藏重复关闭的租约。 */
  function lease(name, extra = {}) { return { ...extra, async close() { record(name + '.close'); } }; }
  const nativeServer = lease('native.server');
  const nativeForward = lease('native.forward');
  const native = {
    config: { type: 'lldb', request: 'attach', pid, processId: pid, stopOnEntry: false, androidLldbServerSocket: '/unit/server-50' },
    /** 功能：模拟 NativeConnection 的资源边界；输入无；输出只回收本连接的 server 与 forward。 */
    async close() { record('native.close'); await nativeServer.close(); await nativeForward.close(); },
  };
  class DebugDevice {
    /** 功能：保存设备身份；输入解析后的串号和根目录；输出边界对象。 */
    constructor(value, projectRoot) { this.serial = value; this.projectRoot = projectRoot; record('device.new', value, projectRoot); }
    /** 功能：返回 OS 设备列表；输入取消信号；输出受控枚举结果。 */
    static async devices(signal) { record('devices', signal); return hooks.devices ? hooks.devices(signal) : [{ serial, state: 'device' }, { serial: 'offline-device', state: 'offline' }]; }
    /** 功能：模拟唯一应用启动；输入真实业务传入参数；输出 PID。 */
    async launch(...args) { record('launch', ...args); return hooks.launch ? hooks.launch(...args) : pid; }
    /** 功能：模拟设备进程表；输入取消信号；输出现存目标。 */
    async clients(signal) { record('clients', signal); return hooks.clients ? hooks.clients(signal) : [{ pid, packageName }]; }
    /** 功能：模拟自有 JDWP 转发；输入目标和取消信号；输出独占端口租约。 */
    async forward(...args) { record('forward', ...args); return hooks.forward ? hooks.forward(...args) : lease('java.forward', { port: ++port }); }
    /** 功能：模拟 Native 恢复连接；输入目标和取消信号；输出长寿命恢复租约。 */
    async resume(...args) { record('resume', ...args); return hooks.resume ? hooks.resume(...args) : lease('resume'); }
    /** 功能：记录清除调试应用；输入无；输出设备副作用记录。 */
    async clearDebugApp() { record('clearDebugApp'); if (hooks.clearDebugApp) await hooks.clearDebugApp(); }
    /** 功能：记录强停目标；输入包名；输出设备副作用记录。 */
    async stop(value) { record('app.stop', value); if (hooks.stop) await hooks.stop(value); }
  }
  const vscode = {
    DebugConfigurationProviderTriggerKind: { Dynamic: 2 },
    workspace: { isTrusted: true, getConfiguration: () => ({ get: (_key, fallback) => fallback }) },
    commands: { registerCommand: () => ({ dispose() {} }), executeCommand: async (...args) => { record('command', ...args); } },
    window: {
      showQuickPick: async (...args) => { record('pick', ...args); return hooks.pick ? hooks.pick(...args) : args[0][0]; },
      showErrorMessage: async value => { errors.push(value); },
    },
    debug: {
      onDidStartDebugSession: started.event,
      onDidTerminateDebugSession: terminated.event,
      registerDebugConfigurationProvider(type, provider, trigger) {
        record('provider.register', type, trigger);
        if (trigger === undefined) providers.set(type, provider);
        return { dispose() {} };
      },
      registerDebugAdapterTrackerFactory(type, factory) { trackers.set(type, factory); return { dispose() {} }; },
      async startDebugging(...args) { record('session.start', ...args); return hooks.start ? hooks.start(...args) : true; },
      async stopDebugging(session) { record('session.stop', session); if (hooks.sessionStop) await hooks.sessionStop(session); if (state.autoTerminate) end(session); },
    },
  };
  /** 功能：发送精确会话退出；输入自有或无关会话；输出真实生产订阅收到 termination。 */
  function end(session) { sessions.delete(session); terminated.fire(session); }
  /** 功能：内存加载真实 TS；输入已知模块名；输出夹具内共享的真实业务导出。 */
  function load(name) {
    if (cache.has(name)) return cache.get(name).exports;
    const filename = path.join(sourceRoot, name + '.ts');
    const loaded = new Module(filename, module);
    cache.set(name, loaded);
    loaded.filename = filename;
    loaded.paths = Module._nodeModulePaths(root);
    loaded.require = id => {
      if (id === 'vscode') return vscode;
      if (id === './device') return { DebugDevice };
      if (id === './native-debugger/adapter') return {
        prepareNativeConnection: async (...args) => { record('native.prepare', ...args); return hooks.native ? hooks.native(...args) : native; },
      };
      if (id === './native-debugger/upstream/src/android') return {
        getPackageNameFromApk: async (...args) => { record('apk.package', ...args); return packageName; },
      };
      if (['./debugging', './index', './autoConfig', './startup'].includes(id)) return load(id.slice(2));
      assert.ok(id.startsWith('node:'), '禁止意外加载未隔离的 OS 或设备依赖：' + id);
      return require(id);
    };
    const code = transformSync(fs.readFileSync(filename, 'utf8'), { loader: 'ts', format: 'cjs', target: 'node22' }).code;
    // 只替换日志宿主，不替换真实错误聚合和业务错误路径。
    const consoleBoundary = { warn: (...args) => warnings.push(args) };
    const wrapper = new Function('exports', 'require', 'module', '__filename', '__dirname', 'console', code);
    wrapper(loaded.exports, loaded.require, loaded, filename, path.dirname(filename), consoleBoundary);
    return loaded.exports;
  }
  const api = load('index'), startup = load('startup');
  const owner = load('debugging').registerAndroidDebugging(context, () => ({ packageName }));
  const token = {
    get isCancellationRequested() { return state.cancelled; },
    onCancellationRequested: cancelled.event,
  };
  /** 功能：按生产最终 provider 解析；输入配置及可选令牌；输出真实引擎配置。 */
  function resolve(config, cancellation = token, workspace = folder) {
    return providers.get(config.type).resolveDebugConfigurationWithSubstitutedVariables(workspace, config, cancellation);
  }
  /** 功能：构造宿主实际会话并取得真实 tracker；输入引擎配置和父会话；输出会话与 tracker。 */
  function session(config, parentSession) {
    const value = { id: 'session-' + ++sequence, type: config.type, name: config.name, configuration: config, parentSession, workspaceFolder: folder,
      async customRequest(command, args) { assert.equal(command, 'disconnect'); assert.equal(args.terminateDebuggee, false); return vscode.debug.stopDebugging(this); } };
    const tracker = trackers.get(config.type)?.createDebugAdapterTracker(value);
    sessions.add(value);
    started.fire(value);
    return { session: value, tracker };
  }
  t.after(async () => {
    state.autoTerminate = true;
    for (const value of [...sessions]) end(value);
    await owner.dispose();
    for (const subscription of context.subscriptions) if (subscription !== owner) await subscription.dispose();
  });
  return {
    api, startup, owner, providers, trackers, vscode, context, folder, hooks, state, token, native, calls, errors, warnings,
    lease, resolve, session, end,
    count: name => calls.filter(value => value.name === name).length,
    entries: name => calls.filter(value => value.name === name),
    cancel() { state.cancelled = true; cancelled.fire(); },
  };
}

/** 功能：生成明确身份的输入；输入模式、请求及覆盖；输出不依赖真机的外部配置。 */
function config(mode = 'native', request = 'launch', extra = {}) {
  return { type: 'android-debug', name: '任务50-' + mode + '-' + request, mode, request, serial, packageName,
    ...(request === 'attach' ? { pid } : {}), ...extra };
}

/** 功能：向真实 tracker 交付响应；输入命令及响应覆盖；输出生产状态变化。 */
function response(tracker, command, extra = {}) { tracker.onDidSendMessage({ type: 'response', command, success: true, ...extra }); }

/** 功能：向真实 tracker 交付事件；输入事件名；输出生产状态变化。 */
function event(tracker, name) { tracker.onDidSendMessage({ type: 'event', event: name, body: {} }); }

/** 功能：交付完整引擎就绪序列；输入 tracker 和是否继续；输出实际业务推进。 */
function ready(tracker, continued = false) {
  response(tracker, 'initialize', { body: { supportsConfigurationDoneRequest: true } });
  response(tracker, 'attach');
  response(tracker, 'configurationDone');
  if (continued) event(tracker, 'continued');
}

/** 功能：声明隔离场景；输入中文名称与步骤；输出带超时诊断的独立真实业务测试。 */
function scenario(name, body) { test(name, { timeout: 3000 }, async t => body(fixture(t), t)); }

scenario('注册真实最终 provider/tracker，不注册 DAP 代理，模板独立且包含六模式', async h => {
  assert.deepEqual([...h.providers.keys()], ['android-debug', 'android-tools', 'android-jvm', 'lldb']);
  assert.deepEqual([...h.trackers.keys()], ['lldb', 'android-jvm']);
  assert.equal(h.count('provider.register'), 5);
  const provider = h.providers.get('android-debug');
  const first = provider.provideDebugConfigurations(), second = provider.provideDebugConfigurations();
  assert.deepEqual(first.map(value => value.mode + '/' + value.request), ['native/launch', 'native/attach', 'java/launch', 'java/attach', 'dual/launch', 'dual/attach']);
  first[0].native.abi = 'changed';
  assert.equal(second[0].native.abi, 'auto');
  const input = config();
  assert.deepEqual(provider.resolveDebugConfiguration(h.folder, input), input);
  assert.notEqual(provider.resolveDebugConfiguration(h.folder, input), input);
  assert.equal(h.trackers.get('lldb').createDebugAdapterTracker({ configuration: { name: 'unrelated', serial } }), undefined);
});

for (const mode of ['native', 'java', 'dual']) for (const request of ['launch', 'attach']) {
  scenario('六模式 ' + mode + '/' + request + '：真实转换、单次目标管理与资源归属', async h => {
    const input = config(mode, request), before = structuredClone(input);
    const engine = await h.resolve(input);
    assert.deepEqual(input, before);
    assert.equal(engine.type, mode === 'java' ? 'android-jvm' : 'lldb');
    assert.equal(engine.request, 'attach');
    assert.equal(engine.pid, pid);
    assert.equal(engine.serial, serial);
    assert.equal(engine.packageName, packageName);
    assert.equal(h.count('launch'), request === 'launch' ? 1 : 0);
    assert.equal(h.count('clients'), request === 'attach' ? 1 : 0);
    assert.equal(h.count('native.prepare'), mode === 'java' ? 0 : 1);
    assert.equal(h.count('forward'), mode === 'java' ? 1 : 0);
    if (request === 'launch') assert.deepEqual(h.entries('launch')[0].args.slice(0, 3), [packageName, undefined, undefined]);
    if (mode !== 'java') {
      const args = h.entries('native.prepare')[0].args;
      assert.equal(args[1], pid);
      assert.equal(args[2].serial, serial);
      assert.equal(args[4], h.folder);
      assert.equal(args[5], h.context.workspaceState);
    }
    const rootSession = h.session(engine);
    ready(rootSession.tracker, mode === 'dual');
    await flush();
    if (mode === 'dual') {
      assert.equal(h.count('session.start'), 1);
      const childConfig = h.entries('session.start')[0].args[1];
      assert.equal(childConfig.type, 'android-jvm');
      assert.equal(childConfig.request, 'attach');
      assert.equal(childConfig.pid, pid);
      assert.equal(h.entries('session.start')[0].args[2].parentSession, rootSession.session);
      const child = h.session(childConfig, rootSession.session);
      ready(child.tracker);
    }
    await flush();
    assert.equal(h.count('launch'), request === 'launch' ? 1 : 0);
    assert.equal(h.count('resume'), mode === 'native' && request === 'launch' ? 1 : 0);
    assert.equal(h.count('forward'), mode === 'native' ? 0 : 1);
    await h.owner.dispose();
    await h.owner.dispose();
    assert.equal(h.count('native.close'), mode === 'java' ? 0 : 1);
    assert.equal(h.count('native.server.close'), mode === 'java' ? 0 : 1);
    assert.equal(h.count('native.forward.close'), mode === 'java' ? 0 : 1);
    assert.equal(h.count('java.forward.close'), mode === 'native' ? 0 : 1);
    assert.equal(h.count('resume.close'), mode === 'native' && request === 'launch' ? 1 : 0);
    assert.equal(h.count('clearDebugApp'), request === 'launch' ? 1 : 0);
    assert.equal(h.count('app.stop'), 0, '正常 detach 不强停已就绪应用');
    assert.deepEqual(h.errors, []);
  });
}

scenario('Native 必须等 attach 和 configurationDone；重复事件只恢复一次且不代理消息', async h => {
  const { tracker } = h.session(await h.resolve(config()));
  const message = { type: 'request', command: 'setBreakpoints', arguments: { source: { path: 'Main.kt' }, breakpoints: [{ line: 10 }] } };
  const before = structuredClone(message);
  tracker.onWillReceiveMessage(message);
  assert.deepEqual(message, before);
  response(tracker, 'initialize', { body: { supportsConfigurationDoneRequest: true } });
  response(tracker, 'attach');
  event(tracker, 'continued');
  await flush();
  assert.equal(h.count('resume'), 0);
  response(tracker, 'configurationDone');
  await flush();
  assert.equal(h.count('resume'), 1);
  ready(tracker, true);
  await flush();
  assert.equal(h.count('resume'), 1);
  assert.equal(h.count('session.start'), 0);
});

scenario('initialize 明确不支持 configurationDone 时，attach 后即可恢复', async h => {
  const { tracker } = h.session(await h.resolve(config()));
  response(tracker, 'initialize', { body: { supportsConfigurationDoneRequest: false } });
  await flush();
  assert.equal(h.count('resume'), 0);
  response(tracker, 'attach');
  await flush();
  assert.equal(h.count('resume'), 1);
});

for (const resumeProcess of [false, true]) scenario('Native Attach 的 resumeProcess=' + resumeProcess + ' 被准确保留', async h => {
  const { tracker } = h.session(await h.resolve(config('native', 'attach', { resumeProcess })));
  ready(tracker);
  await flush();
  assert.equal(h.count('resume'), Number(resumeProcess));
  assert.equal(h.count('launch'), 0);
});

scenario('Dual 必须等 Native continued；子配置重入不重复准备且消息重复不重复启动', async h => {
  const { tracker } = h.session(await h.resolve(config('dual')));
  ready(tracker);
  await flush();
  assert.equal(h.count('forward'), 0);
  assert.equal(h.count('session.start'), 0);
  event(tracker, 'continued');
  await flush();
  const childConfig = h.entries('session.start')[0].args[1];
  assert.equal(await h.resolve(childConfig), childConfig);
  event(tracker, 'continued');
  response(tracker, 'configurationDone');
  await flush();
  assert.equal(h.count('session.start'), 1);
  assert.equal(h.count('native.prepare'), 1);
  assert.equal(h.count('forward'), 1);
  assert.equal(h.count('launch'), 1);
  assert.equal(h.count('resume'), 0);
});

for (const phase of ['before', 'during']) scenario('Dual Native 在 JVM 连接' + phase + '停止必须可见失败', async h => {
  const { tracker } = h.session(await h.resolve(config('dual')));
  if (phase === 'before') { event(tracker, 'stopped'); ready(tracker); }
  else { ready(tracker, true); await flush(); event(tracker, 'stopped'); }
  await flush();
  await h.owner.dispose();
  assert.ok(h.errors.some(value => /paused/i.test(value)));
  assert.equal(h.count('resume'), 0);
  assert.equal(h.count('app.stop'), 1);
});

scenario('Dual stopOnEntry 在引擎准备后严格拒绝并回收 Native 所有资源', async h => {
  h.native.config.stopOnEntry = true;
  await assert.rejects(h.resolve(config('dual')), /requires Native to continue/);
  assert.equal(h.count('native.close'), 1);
  assert.equal(h.count('native.server.close'), 1);
  assert.equal(h.count('native.forward.close'), 1);
  assert.equal(h.count('forward'), 0);
  assert.equal(h.count('app.stop'), 1);
});

for (const childState of ['start-true', 'attach-only', 'configured']) scenario('Dual JVM 完成判据：' + childState + '，退出必须区分是否真正就绪', async h => {
  const input = config('dual');
  const rootSession = h.session(await h.resolve(input));
  ready(rootSession.tracker, true);
  await flush();
  assert.equal(h.count('session.start'), 1);
  if (childState !== 'start-true') {
    const child = h.session(h.entries('session.start')[0].args[1], rootSession.session);
    response(child.tracker, 'attach');
    if (childState === 'configured') response(child.tracker, 'configurationDone');
  }
  await flush();
  h.end(rootSession.session);
  await flush();
  await h.owner.dispose();
  assert.equal(h.count('app.stop'), childState === 'configured' ? 0 : 1,
    'startDebugging=true 或仅 attach 不是 JVM 完成；未完成 Launch 必须回滚');
  assert.equal(h.count('java.forward.close'), 1);
  assert.equal(h.count('native.server.close'), 1);
});

for (const command of ['attach', 'configurationDone']) scenario('Dual 子 JVM ' + command + '失败触发真实失败和清理', async h => {
  const parent = h.session(await h.resolve(config('dual')));
  ready(parent.tracker, true);
  await flush();
  const child = h.session(h.entries('session.start')[0].args[1], parent.session);
  response(child.tracker, command, { success: false, message: '任务50 JVM 拒绝' });
  await flush();
  await h.owner.dispose();
  assert.ok(h.errors.some(value => value.includes('任务50 JVM 拒绝')));
  assert.equal(h.count('app.stop'), 1);
  assert.equal(h.count('java.forward.close'), 1);
  assert.equal(h.count('native.close'), 1);
});

scenario('Dual 子 JVM start=false 必须报错而非变为就绪', async h => {
  h.hooks.start = async () => false;
  const { tracker } = h.session(await h.resolve(config('dual')));
  ready(tracker, true);
  await flush();
  await h.owner.dispose();
  assert.ok(h.errors.some(value => /JVM debugger did not attach/.test(value)));
  assert.equal(h.count('app.stop'), 1);
});

for (const command of ['attach', 'configurationDone']) scenario('主 tracker ' + command + '失败保留原诊断并回滚 Launch', async h => {
  const { tracker } = h.session(await h.resolve(config()));
  response(tracker, command, { success: false, message: '任务50 主引擎拒绝' });
  await flush();
  await h.owner.dispose();
  assert.ok(h.errors.some(value => value.includes('任务50 主引擎拒绝')));
  assert.equal(h.count('resume'), 0);
  assert.equal(h.count('app.stop'), 1);
  assert.equal(h.count('native.close'), 1);
});

scenario('provider 已取消不得访问设备', async h => {
  h.cancel();
  await assert.rejects(h.resolve(config()), /cancelled/i);
  assert.equal(h.count('devices'), 0);
  assert.equal(h.count('launch'), 0);
});

scenario('provider 等待设备枚举期间取消：迟到列表不得再启动应用', async h => {
  const gate = deferred();
  h.hooks.devices = () => gate.promise;
  const pending = h.resolve(config());
  const rejected = assert.rejects(pending, /cancelled/i);
  await flush();
  h.cancel();
  gate.resolve([{ serial, state: 'device' }]);
  await rejected;
  assert.equal(h.count('launch'), 0, '取消必须在枚举结束与创建 DebugRun 之间重新检查');
  assert.equal(h.count('native.prepare'), 0);
});

for (const kind of ['forward', 'server']) scenario('provider pending 取消后迟到 ' + kind + ' 必须回收一次并拒绝配置', async h => {
  const gate = deferred();
  const input = config(kind === 'forward' ? 'java' : 'native');
  if (kind === 'forward') h.hooks.forward = () => gate.promise;
  else h.hooks.native = () => gate.promise;
  const pending = h.resolve(input);
  const rejected = assert.rejects(pending, /cancelled/i);
  await flush();
  h.cancel();
  gate.resolve(kind === 'forward' ? h.lease('late.forward', { port: 47001 }) : h.native);
  await rejected;
  assert.equal(h.count(kind === 'forward' ? 'late.forward.close' : 'native.close'), 1);
  if (kind === 'server') {
    assert.equal(h.count('native.server.close'), 1);
    assert.equal(h.count('native.forward.close'), 1);
  }
  assert.equal(h.count('app.stop'), 1);
  assert.equal(h.count('clearDebugApp'), 1);
});

scenario('启动源取消发生在 Native server pending：迟到连接不能逃逸既有 close', async h => {
  const gate = deferred(), controller = new AbortController(), input = config();
  const unregister = h.startup.registerDebugStartup(input, controller.signal);
  h.hooks.native = () => gate.promise;
  const pending = h.resolve(input);
  const rejected = assert.rejects(pending, /Android debugging ended|用户取消|startup failed/);
  try {
    await flush();
    controller.abort(new Error('用户取消'));
    await flush();
    gate.resolve(h.native);
    await rejected;
    assert.equal(h.count('native.close'), 1, '取消时 close 已开始，也必须等待迟到 NativeConnection');
    assert.equal(h.count('native.server.close'), 1);
    assert.equal(h.count('native.forward.close'), 1);
  } finally { gate.resolve(h.native); unregister(); }
});

scenario('provider Attach clients pending 取消不得调用 Native 准备或强停外部应用', async h => {
  const gate = deferred();
  h.hooks.clients = () => gate.promise;
  const pending = h.resolve(config('native', 'attach'));
  const rejected = assert.rejects(pending, /cancelled/i);
  await flush();
  h.cancel();
  gate.resolve([{ pid, packageName }]);
  await rejected;
  assert.equal(h.count('native.prepare'), 0);
  assert.equal(h.count('launch'), 0);
  assert.equal(h.count('app.stop'), 0);
});

for (const endsFirst of ['root', 'child']) scenario('正常 Dual ' + endsFirst + ' termination 只结束另一会话并清理所有者', async h => {
  const parent = h.session(await h.resolve(config('dual')));
  ready(parent.tracker, true);
  await flush();
  const child = h.session(h.entries('session.start')[0].args[1], parent.session);
  ready(child.tracker);
  await flush();
  h.end(endsFirst === 'root' ? parent.session : child.session);
  await flush();
  await h.owner.dispose();
  const stopped = h.entries('session.stop').map(value => value.args[0].id);
  assert.deepEqual(stopped, [endsFirst === 'root' ? child.session.id : parent.session.id]);
  assert.equal(h.count('native.close'), 1);
  assert.equal(h.count('java.forward.close'), 1);
  assert.equal(h.count('app.stop'), 0);
});

/** 功能：复现真实适配器先退出且宿主未发 termination；输入 Dual 任一侧 onExit；输出整组清理且迟到通知幂等；验证：本文件定向运行。 */
for (const side of ['root', 'child']) scenario('Dual ' + side + ' adapter exit 在无宿主 termination 时结束整组', async h => {
  const parent = h.session(await h.resolve(config('dual')));
  ready(parent.tracker, true);
  await flush();
  const child = h.session(h.entries('session.start')[0].args[1], parent.session);
  ready(child.tracker);
  await flush();
  const exited = side === 'root' ? parent : child;
  const peer = side === 'root' ? child : parent;
  exited.tracker.onExit(0);
  await flush();
  assert.deepEqual(h.entries('session.stop').map(value => value.args[0].id), [peer.session.id]);
  assert.equal(h.count('native.close'), 1);
  assert.equal(h.count('java.forward.close'), 1);
  h.end(exited.session);
  exited.tracker.onExit(0);
  await h.owner.dispose();
  assert.equal(h.count('native.close'), 1);
  assert.equal(h.count('app.stop'), 0);
});

/** 功能：清理期间另一适配器仅报告退出也须结束等待；输入无宿主 termination 的退出；输出资源不悬挂；验证：本文件。 */
scenario('Dual 清理等待以真实 adapter exit 结算且不依赖宿主 termination', async h => {
  const parent = h.session(await h.resolve(config('dual')));
  ready(parent.tracker, true);
  await flush();
  const child = h.session(h.entries('session.start')[0].args[1], parent.session);
  ready(child.tracker);
  await flush();
  h.state.autoTerminate = false;
  parent.tracker.onExit(0);
  await flush();
  assert.equal(h.count('session.stop'), 1);
  child.tracker.onExit(0);
  await h.owner.dispose();
  assert.equal(h.count('native.close'), 1);
  assert.equal(h.count('java.forward.close'), 1);
});

for (const action of [
  { command: 'disconnect', args: { terminateDebuggee: false }, destroy: false },
  { command: 'disconnect', args: { terminateDebuggee: true }, destroy: true },
  { command: 'terminate', args: {}, destroy: true },
]) scenario('就绪会话 ' + action.command + '/' + action.destroy + '：destroy 与 detach 分离', async h => {
  const value = h.session(await h.resolve(config()));
  ready(value.tracker);
  await flush();
  value.tracker.onWillReceiveMessage({ type: 'request', command: action.command, arguments: action.args });
  h.end(value.session);
  await flush();
  await h.owner.dispose();
  assert.equal(h.count('app.stop'), Number(action.destroy));
  assert.equal(h.count('clearDebugApp'), 1);
  assert.equal(h.count('session.stop'), 0);
  assert.equal(h.count('resume.close'), 1);
});

scenario('真实会话 stop 必须等待匹配 termination；重复 dispose 不重复 stop 或提前关闭资源', async h => {
  const value = h.session(await h.resolve(config()));
  ready(value.tracker);
  await flush();
  h.state.autoTerminate = false;
  const first = h.owner.dispose(), second = h.owner.dispose();
  const a = observe(first), b = observe(second);
  await flush();
  assert.equal(h.count('session.stop'), 1);
  assert.equal(a.settled, false);
  assert.equal(b.settled, false);
  assert.equal(h.count('native.close'), 0);
  assert.equal(h.count('resume.close'), 0);
  h.end({ id: 'unrelated-termination' });
  await flush();
  assert.equal(a.settled, false);
  h.end(value.session);
  await Promise.all([first, second]);
  assert.equal(h.count('native.close'), 1);
  assert.equal(h.count('resume.close'), 1);
  assert.equal(h.count('app.stop'), 0);
});

scenario('Dual 两个真实会话都 termination 后才能完成 dispose，stop 返回不能提前释放', async h => {
  const parent = h.session(await h.resolve(config('dual')));
  ready(parent.tracker, true);
  await flush();
  const child = h.session(h.entries('session.start')[0].args[1], parent.session);
  ready(child.tracker);
  await flush();
  h.state.autoTerminate = false;
  const closing = h.owner.dispose(), status = observe(closing);
  await flush();
  assert.equal(status.settled, false);
  assert.equal(h.count('native.close'), 0);
  assert.equal(h.count('java.forward.close'), 0);
  assert.ok(h.entries('session.stop').some(value => value.args[0] === child.session));
  h.end(child.session);
  await flush();
  assert.equal(status.settled, false);
  assert.ok(h.entries('session.stop').some(value => value.args[0] === parent.session));
  assert.equal(h.count('native.close'), 0);
  h.end(parent.session);
  await closing;
  assert.equal(h.count('session.stop'), 2);
  assert.equal(h.count('native.close'), 1);
  assert.equal(h.count('java.forward.close'), 1);
});

scenario('外部 JVM 端口和 preLaunchTask 不归运行所有，不创建或删除 forward', async h => {
  const engine = await h.resolve(config('java', 'attach', { java: { port: 5005, hostName: 'localhost', preLaunchTask: 'external-jdwp' } }));
  assert.equal(engine.port, 5005);
  assert.equal(engine.hostName, 'localhost');
  assert.equal(engine.preLaunchTask, 'external-jdwp');
  ready(h.session(engine).tracker);
  await flush();
  await h.owner.dispose();
  assert.equal(h.count('forward'), 0);
  assert.equal(h.count('java.forward.close'), 0);
  assert.equal(h.count('app.stop'), 0);
});

scenario('仅配置 JVM port 而无外部任务仍由本次运行分配并拥有动态 forward', async h => {
  const engine = await h.resolve(config('java', 'attach', { java: { port: 5005 } }));
  assert.notEqual(engine.port, 5005);
  assert.equal(h.count('forward'), 1);
  await h.owner.dispose();
  assert.equal(h.count('java.forward.close'), 1);
});

for (const kind of ['native', 'java', 'external-java']) scenario('最终 type 改写重入 ' + kind + ' 必须原样返回且不重复 prepare', async h => {
  const input = config(kind === 'native' ? 'native' : 'java', 'attach', kind === 'external-java' ? { java: { port: 5005, preLaunchTask: 'external-jdwp' } } : {});
  const engine = await h.resolve(input), counts = h.calls.length;
  assert.equal(await h.resolve(engine), engine);
  assert.equal(h.calls.length, counts, '最终引擎 provider 重入不得重新枚举设备或分配资源');
});

scenario('原生非 Android LLDB 配置直接透传且不碰设备', async h => {
  const input = { type: 'lldb', name: '普通 LLDB', request: 'attach', pid: 10 };
  assert.equal(await h.resolve(input), input);
  assert.equal(h.count('devices'), 0);
});

scenario('同身份原始配置再次启动必须拒绝，不能重复管理应用', async h => {
  const input = config();
  await h.resolve(input);
  await assert.rejects(h.resolve(input), /already running/);
  assert.equal(h.count('launch'), 1);
  assert.equal(h.count('native.prepare'), 1);
});

scenario('配置 alias、auto 与相对路径通过真实解析，原始配置不变', async h => {
  const input = config('java', 'attach', {
    serial: 'auto', target: { udid: serial }, mode: undefined, androidMode: 'java',
    packageName: undefined, androidPackageName: packageName, pid: undefined, processId: String(pid),
    projectRoot: 'app', sourcePaths: ['src/main/java'], java: { sourcePaths: ['app/src/main/kotlin'] },
  });
  const before = structuredClone(input), engine = await h.resolve(input);
  assert.deepEqual(input, before);
  assert.equal(engine.type, 'android-jvm');
  assert.equal(engine.pid, pid);
  assert.equal(engine.processId, pid);
  assert.equal(engine.projectRoot, path.resolve(root, 'app'));
  assert.deepEqual(engine.sourcePaths, [path.resolve(root, 'app', 'app/src/main/kotlin')]);
  assert.equal(h.entries('device.new')[0].args[1], path.resolve(root, 'app'));
  assert.equal(h.count('launch'), 0);
});

scenario('android-tools Native 和 android-jvm 直接入口使用同一真实业务', async h => {
  const native = await h.resolve(config('native', 'attach', { type: 'android-tools', name: 'tools' }));
  const java = await h.resolve(config('java', 'attach', { type: 'android-jvm', android: true, name: 'jvm', port: 5005, preLaunchTask: 'external' }));
  assert.equal(native.type, 'lldb');
  assert.equal(java.type, 'android-jvm');
  assert.equal(java.port, 5005);
  assert.equal(h.count('native.prepare'), 1);
  assert.equal(h.count('forward'), 0);
  assert.equal(h.count('launch'), 0);
});

scenario('target=last-selected 复用上次在线设备而不是再次弹选', async h => {
  await h.resolve(config('java', 'attach', { serial: undefined, target: 'select', name: 'first' }));
  await h.resolve(config('java', 'attach', { serial: undefined, target: 'last-selected', name: 'second' }));
  assert.equal(h.count('pick'), 1);
  assert.deepEqual(h.entries('device.new').map(value => value.args[0]), [serial, serial]);
});

scenario('无 PID 的 Attach 从真实 clients 选定目标而不启动应用', async h => {
  const engine = await h.resolve(config('java', 'attach', { pid: 'auto' }));
  assert.equal(engine.pid, pid);
  assert.equal(h.count('clients'), 2, 'provider 选定目标后 prepare 必须重新确认目标仍存在');
  assert.equal(h.count('launch'), 0);
});

scenario('用户取消设备选择返回 undefined，不创建运行', async h => {
  h.hooks.pick = async () => undefined;
  assert.equal(await h.resolve(config('java', 'attach', { serial: undefined, target: 'select' })), undefined);
  assert.equal(h.count('launch'), 0);
  assert.equal(h.count('forward'), 0);
  assert.equal(h.count('device.new'), 0);
});

const invalid = [
  ['非法模式', { mode: 'mixed' }, /Unsupported Android debug mode/],
  ['tools 不支持 Dual', { type: 'android-tools', mode: 'dual' }, /Unsupported Android debug mode/],
  ['包名注入', { packageName: 'bad;stop' }, /valid Android packageName/],
  ['离线设备', { serial: 'offline-device' }, /not online/],
  ['非法 sourcePaths', { sourcePaths: 'bad' }, /sourcePaths must be a string array/],
  ['sourcePaths 非字符串元素', { sourcePaths: [false] }, /sourcePaths must be a string array/],
  ['嵌套 sourcePaths 非法', { java: { sourcePaths: [1] } }, /sourcePaths must be a string array/],
  ...[-1, 65536, 1.5, '5005', NaN, Infinity].map(port => ['非法 JVM 端口 ' + port, { mode: 'java', java: { port } }, /Invalid JVM debug port/]),
];
for (const [label, extra, expected] of invalid) scenario('非法配置：' + label, async h => {
  await assert.rejects(h.resolve(config('native', 'attach', extra)), expected);
  assert.equal(h.count('launch'), 0);
  assert.equal(h.count('native.prepare'), 0);
  assert.equal(h.count('forward'), 0);
});

scenario('不可信工作区拒绝 provider 和公开启动，不读取设备', async h => {
  h.vscode.workspace.isTrusted = false;
  await assert.rejects(h.resolve(config()), /not trusted/);
  await assert.rejects(h.api.startAndroidDebugging(h.folder, config(), { serial }), /not trusted/);
  assert.equal(h.count('devices'), 0);
  assert.equal(h.count('session.start'), 0);
});

scenario('无工作区的相对路径和非文件 APK 被真实路径/文件边界拒绝', async h => {
  await assert.rejects(h.resolve(config('native', 'attach', { projectRoot: 'relative' }), h.token, null), /Relative path requires/);
  await assert.rejects(h.resolve(config('native', 'attach', { apkPath: root })), /APK is not a file/);
  assert.equal(h.count('launch'), 0);
});

scenario('Attach 目标消失或同 PID 包名不符必须拒绝，不强停外部应用', async h => {
  h.hooks.clients = async () => [{ pid, packageName: 'another.package' }];
  await assert.rejects(h.resolve(config('native', 'attach')), /requires one existing process/);
  assert.equal(h.count('native.prepare'), 0);
  assert.equal(h.count('app.stop'), 0);
});

scenario('真实 createAndroidDebugConfiguration 拒绝非法 PID 和冲突 alias', async h => {
  for (const target of [{ serial, pid: 0 }, { serial, pid: 1.5 }, { serial, pid: NaN }, { serial, pid: -1 }, { serial, pid: 1, processId: 2 }]) {
    assert.throws(() => h.api.createAndroidDebugConfiguration(config(), target), /Invalid Android process id/);
  }
  assert.throws(() => h.api.createAndroidDebugConfiguration(config(), { serial: 'bad serial' }), /Invalid Android device serial/);
  assert.throws(() => h.api.createAndroidDebugConfiguration(config('native', 'invalid'), { serial }), /Invalid Android debug configuration/);
  const original = config('native', 'launch', { packageName: 'auto' });
  const mapped = h.api.createAndroidDebugConfiguration(original, { serial, processId: pid, packageName });
  assert.equal(mapped.request, 'attach');
  assert.equal(mapped.pid, pid);
  assert.equal(mapped.processId, pid);
  assert.equal(mapped.packageName, packageName);
  assert.equal(original.request, 'launch');
  assert.equal(original.packageName, 'auto');
});

scenario('清理失败聚合全部原因，同时继续回收后续资源并只执行一次', async h => {
  const { tracker } = h.session(await h.resolve(config()));
  ready(tracker);
  await flush();
  h.native.close = async () => { h.calls.push({ name: 'native.close', args: [] }); throw new AggregateError([new Error('server-close-error'), new Error('forward-close-error')], 'native cleanup'); };
  h.hooks.clearDebugApp = async () => { throw new Error('clear-debug-error'); };
  await assert.rejects(h.owner.dispose(), error => {
    assert.ok(error instanceof AggregateError);
    const text = JSON.stringify(error, (_key, value) => value instanceof Error ? { message: value.message, errors: value.errors } : value);
    assert.match(text, /server-close-error/);
    assert.match(text, /forward-close-error/);
    assert.match(text, /clear-debug-error/);
    return true;
  });
  assert.equal(h.count('resume.close'), 1);
  assert.equal(h.count('clearDebugApp'), 1);
  await h.owner.dispose();
  assert.equal(h.count('native.close'), 1);
});

for (const mode of ['native', 'java', 'dual']) scenario('公开 startAndroidDebugging ' + mode + '：宿主 start=true 不等于引擎连接完成', async h => {
  let parent, child;
  h.hooks.start = async (_folder, input, options) => {
    if (options?.parentSession) { child = h.session(input, options.parentSession); return true; }
    parent = h.session(await h.resolve(input));
    return true;
  };
  const pending = h.api.startAndroidDebugging(h.folder, config(mode), { serial, packageName });
  const status = observe(pending);
  await flush();
  const premature = status.settled;
  const viewPremature = h.count('command');
  ready(parent.tracker, mode === 'dual');
  await flush();
  if (mode === 'dual') ready(child.tracker);
  assert.equal((await pending).id, parent.session.id);
  assert.equal(premature, false, '公开启动 Promise 必须等实际 tracker 就绪，不能仅有宿主 start 事件');
  assert.equal(viewPremature, 0, '调试视图成功交付不得早于引擎连接完成');
});

scenario('公开 start=true 却没有实际会话 start 事件必须拒绝', async h => {
  await assert.rejects(h.api.startAndroidDebugging(h.folder, config(), { serial }), /did not report a live start/);
});

scenario('公开启动取消后的迟到真实会话必须 stop，并等 termination 才结束 startup cleanup', async h => {
  const gate = deferred(), controller = new AbortController();
  let cleanup, late;
  h.state.autoTerminate = false;
  h.hooks.start = async (_folder, input) => {
    await gate.promise;
    // 只模拟宿主迟到交付会话；取消登记、归属判断、stop 和退出等待均执行真实 index.ts。
    late = h.session({ ...input, type: 'lldb', request: 'attach' });
    return true;
  };
  const pending = h.api.startAndroidDebugging(h.folder, config('native', 'attach'), {
    serial, pid, packageName, signal: controller.signal, onStartupCleanup: value => { cleanup = value; },
  });
  const rejected = assert.rejects(pending, /用户取消/);
  await flush();
  controller.abort(new Error('用户取消'));
  await rejected;
  const status = observe(cleanup);
  gate.resolve();
  await flush();
  assert.ok(late?.session);
  assert.equal(h.count('session.stop'), 1);
  assert.equal(status.settled, false);
  h.end(late.session);
  await cleanup;
  assert.equal(h.count('command'), 0);
  assert.equal(h.count('app.stop'), 0);
});
