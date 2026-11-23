/**
 * 功能点：公开调试入口测试的宿主和设备边界夹具。
 * 受影响对象：debugging.ts、index.ts、startup.ts、JVM descriptor；不实现生产代理。
 * 复现路径：Node>=22及esbuild；各入口创建独立夹具，设备操作全部记录到内存。
 * 测试范围：真实provider/tracker、配置选择、资源释放及真实Executable配置；不执行ADB或Java。
 * 执行入口：由任务51迁移的tests/*.test.js显式调用。
 * 预期结果：生产公开函数负责所有决策，夹具只提供可控外部结果。
 * 判据：严格依赖白名单、调用参数与资源次数可观测，意外依赖立即失败。
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { transformSync } = require('esbuild');
const root = path.resolve(__dirname, '../..');

/** 功能：隔离加载真实源码；输入相对源码及边界；输出真实导出，未知依赖失败。 */
function source(relative, dependencies = {}) {
  const filename = path.join(root, relative), module = { exports: {} };
  vm.runInNewContext(transformSync(fs.readFileSync(filename, 'utf8'), { loader: 'ts', format: 'cjs', target: 'es2022' }).code, {
    module, exports: module.exports, AbortController, AbortSignal, AggregateError, Error, TypeError, console,
    require(id) { if (Object.hasOwn(dependencies, id)) return dependencies[id]; if (id === 'node:path') return path; throw new Error('未声明依赖：' + relative + ' -> ' + id); },
  }, { filename });
  return module.exports;
}

/** 功能：创建可释放宿主事件；输入监听；输出同步事件及订阅计数。 */
function emitter() {
  const listeners = new Set();
  return { listeners,
    // 功能：登记单个宿主监听；输入回调；输出精确注销。
    event(listener) { listeners.add(listener); return { dispose: () => listeners.delete(listener) }; },
    // 功能：发送宿主事实；输入会话；输出现有监听收到原对象。
    fire(value) { for (const listener of [...listeners]) listener(value); },
  };
}

/** 功能：推进异步生产回调；输入无；输出一个事件循环检查点。 */
function turn() { return new Promise(resolve => setImmediate(resolve)); }

/** 功能：创建公开provider夹具；输入边界选项；输出真实入口、注册表和设备操作账本。 */
function fixture(options = {}) {
  const f = { calls: [], errors: [], providers: new Map(), trackers: new Map(), factories: new Map(), starts: [], stops: [], picks: [], rows: [{ pid: 42, packageName: 'com.example.app' }] };
  const ended = emitter(), started = emitter();
  f.ended = ended; f.started = started;
  f.folder = { uri: { fsPath: root }, name: '测试工程', index: 0 };
  f.context = { subscriptions: [], extensionPath: root, extensionUri: { fsPath: root }, logUri: { fsPath: path.join(root, '.test-artifacts', 'descriptor') }, workspaceState: {} };
  f.startup = source('src/android-debugger/startup.ts');
  const auto = source('src/android-debugger/autoConfig.ts');
  const vscode = f.vscode = {
    DebugConfigurationProviderTriggerKind: { Dynamic: 2 },
    workspace: { isTrusted: true,
      // 功能：读取内存宿主配置；输入配置域；输出原配置或默认值。
      getConfiguration(section) { return { get: (key, fallback) => section === 'launch' ? (options.configurations ?? []) : options.settings?.[key] ?? fallback }; },
    },
    commands: { registerCommand: () => ({ dispose() {} }), executeCommand: async name => f.calls.push(['command', name]) },
    window: {
      // 功能：记录选择项并返回用户决定；输入宿主项目及令牌；输出可控选择。
      async showQuickPick(items, settings, token) { f.picks.push({ items, settings, token }); return options.pick ? options.pick(items, token) : items[0]; },
      showErrorMessage: async text => f.errors.push(text),
      createOutputChannel: () => ({ appendLine: text => f.calls.push(['log', text]), show() {}, dispose() {} }),
    },
    Uri: { joinPath: (uri, ...segments) => ({ fsPath: path.join(uri.fsPath, ...segments) }) },
    DebugAdapterExecutable: class {
      // 功能：承载生产descriptor参数；输入真实命令和参数；输出不启动进程的宿主值对象。
      constructor(command, args) { this.command = command; this.args = args; }
    },
    debug: {
      onDidStartDebugSession: started.event, onDidTerminateDebugSession: ended.event,
      // 功能：保存真实provider；输入类型与触发方式；输出可释放注册。
      registerDebugConfigurationProvider(type, provider, trigger) { const key = trigger ? type + ':dynamic' : type; f.providers.set(key, provider); return { dispose: () => f.providers.delete(key) }; },
      // 功能：保存只读tracker工厂；输入调试类型；输出可释放注册。
      registerDebugAdapterTrackerFactory(type, factory) { f.trackers.set(type, factory); return { dispose: () => f.trackers.delete(type) }; },
      // 功能：保存真实descriptor工厂；输入调试类型；输出可释放注册。
      registerDebugAdapterDescriptorFactory(type, factory) { f.factories.set(type, factory); return { dispose: () => f.factories.delete(type) }; },
      // 功能：记录宿主启动；输入配置及父会话；输出外部宿主决定。
      async startDebugging(folder, config, settings) { f.starts.push({ folder, config, settings }); return options.start ? options.start(folder, config, settings, f) : true; },
      // 功能：停止指定会话；输入会话；输出宿主termination，不影响其他会话。
      async stopDebugging(session) { f.stops.push(session); if (options.stop) return options.stop(session, f); ended.fire(session); },
    },
  };
  f.index = source('src/android-debugger/index.ts', { vscode, './autoConfig': auto, './startup': f.startup });
  class DebugDevice {
    // 功能：保存设备边界身份；输入串号与根；输出可观测实例。
    constructor(serial, projectRoot) { this.serial = serial; this.projectRoot = projectRoot; f.calls.push(['device', serial, projectRoot]); }
    // 功能：模拟在线设备；输入取消信号；输出受控设备清单。
    static async devices(signal) { signal.throwIfAborted(); f.calls.push(['devices']); return options.devices ?? [{ serial: 'phone', state: 'device' }]; }
    // 功能：模拟客户端事实；输入取消信号；输出PID包名列表。
    async clients(signal) { signal.throwIfAborted(); f.calls.push(['clients']); return options.clients ? options.clients(signal) : f.rows; }
    // 功能：模拟一次设备Launch；输入包、Activity、APK和信号；输出目标PID。
    async launch(pkg, activity, apk, signal) { signal.throwIfAborted(); f.calls.push(['launch', pkg, activity, apk]); if (options.launch) return options.launch(signal); return 42; }
    // 功能：模拟自有转发；输入PID及取消信号；输出独立端口和关闭结果。
    async forward(pid, signal) { signal.throwIfAborted(); f.calls.push(['forward', pid]); if (options.forward) return options.forward(signal); return { port: 4500, close: async () => { f.calls.push(['forward-close']); if (options.closeError) throw options.closeError; } }; }
    // 功能：模拟Native解除等待；输入精确PID；输出长寿命连接租约。
    async resume(pid, signal) { signal.throwIfAborted(); f.calls.push(['resume', pid]); return { close: async () => f.calls.push(['resume-close']) }; }
    // 功能：记录清除设备调试设置；输入无；输出清理记录。
    async clearDebugApp() { f.calls.push(['clear']); }
    // 功能：记录精确包停止；输入包名；输出应用停止记录。
    async stop(pkg) { f.calls.push(['stop', pkg]); }
  }
  const api = source('src/android-debugger/debugging.ts', {
    vscode, 'node:fs': { statSync: () => ({ isFile: () => true }) }, './device': { DebugDevice }, './autoConfig': auto, './index': f.index, './startup': f.startup,
    './native-debugger/upstream/src/android': { getPackageNameFromApk: async () => 'com.example.app' },
    './native-debugger/adapter': {
      // 功能：模拟Native外部准备；输入真实目标与设备；输出直接LLDB配置，不提供代理。
      async prepareNativeConnection(config, pid, device, signal, folder, storage) {
        f.calls.push(['native', pid, device.serial, device.projectRoot, folder, storage]); signal.throwIfAborted();
        if (options.native) return options.native(config, signal);
        return { config: { ...config.native, type: 'lldb', request: 'attach', pid, processId: pid, androidLldbServerSocket: 'fixture-socket', stopOnEntry: config.native?.stopOnEntry ?? false }, close: async () => f.calls.push(['native-close']) };
      },
    },
  });
  f.owner = api.registerAndroidDebugging(f.context, () => 'com.example.app');
  f.provider = f.providers.get('android-debug');
  // 功能：调用真实变量替换后provider；输入配置及宿主token；输出直接引擎配置。
  f.resolve = (changes = {}, token) => f.provider.resolveDebugConfigurationWithSubstitutedVariables(f.folder, { type: 'android-debug', name: '测试调试', request: 'attach', mode: 'java', serial: 'phone', pid: 42, packageName: 'com.example.app', ...changes }, token);
  // 功能：创建真实只读tracker；输入最终配置及可选身份；输出会话和tracker。
  f.track = (config, id = 'root', parentSession) => { const session = { id, name: config.name, type: config.type, configuration: config, parentSession, async customRequest(command, args) { assert.equal(command, 'disconnect'); assert.equal(args.terminateDebuggee, false); return vscode.debug.stopDebugging(this); } }; return { session, tracker: f.trackers.get(config.type).createDebugAdapterTracker(session) }; };
  // 功能：释放本次生产资源及注册；输入无；输出全部订阅已注销。
  f.close = async () => { await f.owner.dispose(); for (const value of [...f.context.subscriptions].reverse()) if (value !== f.owner) await value.dispose(); };
  return f;
}

/** 功能：加载真实JVM注册；输入配置边界选项；输出可直接调用的生产descriptor工厂。 */
function jvmFixture(options = {}) {
  const f = fixture(options);
  const api = source('src/android-debugger/jvm-debugger/adapter.ts', {
    vscode: f.vscode,
    fs: { existsSync: () => options.jar !== false, mkdirSync: directory => f.calls.push(['mkdir', directory]) },
    './java': { findJava: async home => { f.calls.push(['java', home]); if (options.javaError) throw options.javaError; return { java: path.join(root, 'fixture-jdk', 'bin', 'java'), version: 21 }; } },
  });
  api.registerJvmDebugger(f.context); f.descriptor = f.factories.get('android-jvm');
  return f;
}
module.exports = { fixture, jvmFixture, source, emitter, turn, root };
