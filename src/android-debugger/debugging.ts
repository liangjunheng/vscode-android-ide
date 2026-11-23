import * as path from 'node:path';
import * as fs from 'node:fs';
import * as vscode from 'vscode';
import { DebugDevice } from './device';
import { omitAuto } from './autoConfig';
import { getAndroidDebugConfigurations } from './index';
import { debugCancellationToken, debugStartupSignal, reportDebugConnection } from './startup';
import { NativePackageResolver, prepareNativeConnection } from './native-debugger/adapter';
import type { NativeConnection } from './native-debugger/contracts';
import { getPackageNameFromApk } from './native-debugger/upstream/src/android';

type Mode = 'native' | 'java' | 'dual';

/** 功能：展示实际业务和清理错误；输入异常；输出保留所有原因的诊断。 */
function details(error: unknown): string {
  return error instanceof AggregateError ? error.message + ': ' + error.errors.map(details).join('; ') : String(error);
}

/** 每次运行只持有实际会话、Native连接和JDWP转发，配置和引擎不重复管理应用。 */
class DebugRun {
  readonly controller = new AbortController();
  native?: NativeConnection;
  forward?: { port: number; close(): Promise<void> };
  resumed?: { close(): Promise<void> };
  root?: vscode.DebugSession;
  child?: vscode.DebugSession;
  childConfig?: vscode.DebugConfiguration;
  engineConfig?: vscode.DebugConfiguration;
  pid?: number;
  launched = false;
  ready = false;
  private configured = false;
  private attached = false;
  private continued = false;
  private stopped = false;
  private childAttached = false;
  private childConfigured = false;
  private completed!: () => void;
  private rejected!: (error: unknown) => void;
  readonly connected = new Promise<void>((resolve, reject) => { this.completed = resolve; this.rejected = reject; });
  private connecting?: Promise<void>;
  private closing?: Promise<void>;
  private preparing?: Promise<vscode.DebugConfiguration>;
  private readonly subscriptions: vscode.Disposable[] = [];
  private releaseStartup: () => void;
  private readonly ended = new Set<string>();
  private readonly stopping = new Map<string, Promise<void>>();
  private readonly exits = new Map<string, () => void>();
  private destroy = false;

  /** 功能：绑定一次运行的明确目标；输入配置和依赖；输出取消及退出唯一所有者。 */
  constructor(readonly config: vscode.DebugConfiguration, readonly mode: Mode, readonly device: DebugDevice, readonly folder: vscode.WorkspaceFolder | undefined, private readonly context: vscode.ExtensionContext, private readonly release: () => void) {
    void this.connected.catch(() => undefined);
    const source = debugStartupSignal(config);
    const abort = () => { void this.close(this.launched).catch(error => this.report(error)); };
    source?.addEventListener('abort', abort, { once: true });
    this.releaseStartup = () => source?.removeEventListener('abort', abort);
    this.subscriptions.push({ dispose: this.releaseStartup });
    this.subscriptions.push(vscode.debug.onDidTerminateDebugSession(session => {
      this.ended.add(session.id);
      if (session.id === this.root?.id || session.id === this.child?.id) void this.close(this.destroy).catch(error => this.report(error));
    }));
    if (source?.aborted) this.controller.abort(source.reason);
  }

  /** 功能：按Launch或Attach确定目标并准备真实引擎；输入最终配置；输出直接交给宿主的引擎配置。 */
  prepare(): Promise<vscode.DebugConfiguration> { return this.preparing ??= this.prepareTarget(); }

  /** 功能：按明确请求准备一次目标和连接；输入最终配置；输出真实引擎配置，不重复准备资源。 */
  private async prepareTarget(): Promise<vscode.DebugConfiguration> {
    const signal = this.controller.signal;
    signal.throwIfAborted();
    if (this.config.request === 'launch') {
      this.launched = true;
      this.pid = await this.device.launch(this.config.packageName, this.config.launchActivity, this.config.apkPath, signal);
    } else {
      const rows = await this.device.clients(signal);
      const raw = this.config.pid ?? this.config.processId;
      const matching = rows.filter(row => raw !== undefined ? row.pid === Number(raw) && row.packageName === this.config.packageName : row.packageName === this.config.packageName);
      if (matching.length !== 1) throw new Error('Attach requires one existing process for ' + this.config.packageName);
      this.pid = matching[0].pid;
    }
    signal.throwIfAborted();
    if (this.mode === 'java') return this.javaConfig();
    this.native = await prepareNativeConnection(this.config, this.pid!, this.device, signal, this.folder, this.context.workspaceState);
    signal.throwIfAborted();
    if (this.mode === 'dual' && this.native.config.stopOnEntry) throw new Error('Dual debugging requires Native to continue before Java connects');
    return { ...this.native.config, name: this.config.name, serial: this.device.serial, packageName: this.config.packageName };
  }

  /** 功能：生成JVM实际端口配置；输入既定PID；输出真实Attach配置，仅关闭自建转发。 */
  private async javaConfig(): Promise<vscode.DebugConfiguration> {
    const java = this.config.type === 'android-jvm' ? { ...this.config } : { ...this.config.java };
    const port = java.port ?? 0;
    if (!Number.isInteger(port) || typeof port !== 'number' || port < 0 || port > 65535) throw new Error('Invalid JVM debug port');
    const external = port > 0 && typeof java.preLaunchTask === 'string' && java.preLaunchTask.trim();
    if (!external) this.forward = await this.device.forward(this.pid!, this.controller.signal);
    this.controller.signal.throwIfAborted();
    return { ...java, type: 'android-jvm', android: true, request: 'attach', name: this.mode === 'dual' ? this.config.name + ' · JVM' : this.config.name,
      serial: this.device.serial, pid: this.pid, processId: this.pid, packageName: this.config.packageName,
      port: external ? port : this.forward!.port, hostName: external ? java.hostName ?? '127.0.0.1' : '127.0.0.1',
      projectRoot: java.projectRoot ?? this.config.projectRoot ?? this.config.androidProjectRoot,
      postDebugTask: java.postDebugTask ?? (this.mode === 'dual' ? undefined : this.config.postDebugTask),
      sourcePaths: java.sourcePaths ?? this.config.sourcePaths ?? this.config.androidSourceRoots };
  }

  /** 功能：观察真实调试器响应；输入精确宿主会话；输出只读追踪，不代理断点或线程消息。 */
  tracker(session: vscode.DebugSession, child: boolean): vscode.DebugAdapterTracker {
    if (child) this.child = session; else this.root = session;
    const signal = this.controller.signal;
    const abort = () => { void this.stopSession(session).catch(error => this.report(error)); };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    return {
      onWillReceiveMessage: message => {
        if (message.type === 'request' && ['disconnect', 'terminate'].includes(message.command) && !this.closing) this.destroy ||= message.command === 'terminate' || message.arguments?.terminateDebuggee === true;
      },
      onDidSendMessage: message => {
        if (this.closing) return;
        if (child) {
          if (message.type === 'response' && ['attach', 'launch', 'configurationDone'].includes(message.command) && message.success === false) { this.fail(new Error(message.message ?? 'JVM connection failed')); return; }
          if (message.type === 'response' && ['attach', 'launch'].includes(message.command) && message.success) this.childAttached = true;
          if (message.type === 'response' && message.command === 'configurationDone' && message.success) this.childConfigured = true;
          if (message.type === 'response' && message.command === 'initialize' && message.success && message.body?.supportsConfigurationDoneRequest !== true) this.childConfigured = true;
          if (this.childAttached && this.childConfigured) { this.ready = true; this.releaseStartup(); this.completed(); }
          return;
        }
        if (message.type === 'event' && message.event === 'continued') { this.continued = true; this.stopped = false; }
        if (message.type === 'event' && message.event === 'stopped') {
          this.stopped = true;
          if (this.mode === 'dual' && this.connecting && !this.childAttached) { this.fail(new Error('Native paused the process while JVM was connecting')); return; }
        }
        if (message.type === 'response') {
          if (['attach', 'launch', 'configurationDone'].includes(message.command) && message.success === false) { this.fail(new Error(message.message ?? 'Debugger connection failed')); return; }
          if (['attach', 'launch'].includes(message.command) && message.success) this.attached = true;
          if (message.command === 'configurationDone' && message.success) this.configured = true;
          if (message.command === 'initialize' && message.success && message.body?.supportsConfigurationDoneRequest !== true) this.configured = true;
        }
        if (this.attached && this.configured && !this.connecting) {
          if (this.mode === 'dual' && this.stopped) { this.fail(new Error('Native paused the process before JVM attachment')); return; }
          if (this.mode === 'dual' && !this.continued) return;
          this.connecting = this.finishConnection().catch(error => this.fail(error));
        }
      },
      onError: error => this.fail(error),
      onExit: () => {
        signal.removeEventListener('abort', abort);
        this.ended.add(session.id);
        this.exits.get(session.id)?.();
        void this.close(this.destroy).catch(error => this.report(error));
      },
    };
  }

  /** 功能：完成Native恢复或Dual的Java连接；输入真实主引擎就绪；输出运行状态，不再启动应用。 */
  private async finishConnection(): Promise<void> {
    this.controller.signal.throwIfAborted();
    if (this.mode === 'dual') {
      this.childConfig = await this.javaConfig();
      if (!await vscode.debug.startDebugging(this.folder, this.childConfig, { parentSession: this.root })) throw new Error('JVM debugger did not attach');
    } else if (this.mode === 'native' && (this.config.resumeProcess ?? this.config.request === 'launch')) {
      this.resumed = await this.device.resume(this.pid!, this.controller.signal);
    }
    this.controller.signal.throwIfAborted();
    if (this.mode !== 'dual') { this.ready = true; this.releaseStartup(); this.completed(); }
  }

  /** 功能：判断配置是否为本次真实引擎；输入宿主配置；输出主连接或Dual子连接匹配。 */
  matches(config: vscode.DebugConfiguration): boolean { return config.serial === this.device.serial && config.name === this.config.name; }
  /** 功能：判断已经准备的Dual子配置；输入配置；输出不重复分配转发的精确匹配。 */
  matchesChild(config: vscode.DebugConfiguration): boolean { return !!this.childConfig && config.name === this.childConfig.name && config.serial === this.device.serial && config.port === this.childConfig.port && Number(config.pid) === this.pid; }

  /** 功能：停止本次会话并释放明确资源；输入是否停止应用；输出唯一清理结果，错误完整聚合。 */
  close(destroy: boolean): Promise<void> {
    this.destroy ||= destroy;
    if (!this.ready) {
      this.controller.abort(new Error('Android debugging ended'));
      this.rejected(this.controller.signal.reason);
    }
    return this.closing ??= Promise.resolve().then(async () => {
      const errors: unknown[] = [];
      for (const session of [this.child, this.root]) if (session && !this.ended.has(session.id)) {
        try { await this.stopSession(session); } catch (error) { errors.push(error); }
      }
      if (this.preparing) await Promise.allSettled([this.preparing]);
      if (this.connecting) await this.connecting;
      if (this.child && !this.ended.has(this.child.id)) { try { await this.stopSession(this.child); } catch (error) { errors.push(error); } }
      for (const resource of [this.resumed, this.forward, this.native]) {
        try { await resource?.close(); } catch (error) { errors.push(error); }
      }
      if (this.launched) {
        try { await this.device.clearDebugApp(); } catch (error) { errors.push(error); }
      }
      if (this.destroy || (this.launched && !this.ready)) {
        try { await this.device.stop(this.config.packageName); } catch (error) { errors.push(error); }
      }
      this.controller.abort(new Error('Android debugging ended'));
      for (const subscription of this.subscriptions.splice(0)) subscription.dispose();
      this.release();
      if (errors.length) throw new AggregateError(errors, 'Android debug cleanup failed');
    });
  }

  /** 功能：等待具体会话真实退出；输入自有会话；输出停止请求和termination均结束。 */
  private stopSession(session: vscode.DebugSession): Promise<void> {
    const existing = this.stopping.get(session.id);
    if (existing) return existing;
    const stopping = Promise.resolve().then(async () => {
      if (this.ended.has(session.id)) return;
      let ended!: () => void;
      const exited = new Promise<void>(resolve => { ended = resolve; });
      this.exits.set(session.id, ended);
      const listener = vscode.debug.onDidTerminateDebugSession(value => { if (value.id === session.id) ended(); });
      try { if (!this.ended.has(session.id)) { await session.customRequest('disconnect', { terminateDebuggee: false }); await exited; } }
      finally { this.exits.delete(session.id); listener.dispose(); }
    });
    this.stopping.set(session.id, stopping);
    return stopping;
  }

  /** 功能：报告连接错误并启动本次清理；输入原始错误；输出可见失败，不切换模式或重试。 */
  private fail(error: unknown): void { this.rejected(error); this.report(error); void this.close(this.launched && !this.ready).catch(failure => this.report(failure)); }
  /** 功能：输出可见调试诊断；输入错误；输出警告日志和错误提示。 */
  private report(error: unknown): void { console.warn('W: Android debugger', error); void vscode.window.showErrorMessage(details(error)); }
}

/** 功能：注册公开配置并直连真实调试器；输入上下文及项目包来源；输出可等待的调试生命周期管理。 */
export function registerAndroidDebugging(context: vscode.ExtensionContext, selectedPackage?: NativePackageResolver): vscode.Disposable & { dispose(): Promise<void> } {
  const runs = new Set<DebugRun>();
  const recent: { serial?: string } = {};
  /** 功能：为命令变量确定设备；输入宿主命令配置；输出在线设备，不启动应用或调试器。 */
  const commandDevice = async (input: vscode.DebugConfiguration): Promise<DebugDevice | undefined> => {
    const config = omitAuto(input ?? {} as vscode.DebugConfiguration);
    let serial = config.serial ?? config.target ?? config.androidTarget;
    if (typeof serial === 'object') serial = serial.udid;
    if (serial === 'last-selected') serial = recent.serial;
    const online = (await DebugDevice.devices()).filter(device => device.state === 'device');
    if (!serial || serial === 'select') serial = (await vscode.window.showQuickPick(online.map(device => ({ label: device.serial, serial: device.serial })), { placeHolder: 'Select Android device' }))?.serial;
    if (!serial) return undefined;
    if (!online.some(device => device.serial === serial)) throw new Error('Android device is not online: ' + serial);
    recent.serial = serial;
    return new DebugDevice(serial, config.androidProjectRoot ?? config.projectRoot);
  };
  /** 功能：为ABI变量选取明确候选；输入公开Native配置；输出设备包支持的唯一选择。 */
  const commandAbi = async (input: vscode.DebugConfiguration): Promise<string | undefined> => {
    const config = omitAuto(input), native = config.native ?? {};
    if (native.abi && native.abi !== 'select') return native.abi;
    const device = await commandDevice(config);
    if (!device) return undefined;
    if (!config.packageName) throw new Error('ABI command requires packageName');
    const values = (await device.abis(config.packageName)).filter(abi => !native.abiSupported || native.abiSupported.includes(abi));
    return values.length === 1 ? values[0] : (await vscode.window.showQuickPick(values, { placeHolder: 'Select Android ABI' }));
  };
  context.subscriptions.push(
    vscode.commands.registerCommand('android-tools.pickAndroidProcess', async input => {
      const device = await commandDevice(input);
      if (!device) return undefined;
      const rows = await device.clients();
      const selected = await vscode.window.showQuickPick(rows.map(row => ({ label: row.packageName, description: String(row.pid), row })), { placeHolder: 'Pick Android Process' });
      return selected ? String(selected.row.pid) : undefined;
    }),
    vscode.commands.registerCommand('android-tools.getBestAbi', commandAbi),
    vscode.commands.registerCommand('android-tools.getBestMappedAbi', async input => {
      const abi = await commandAbi(input);
      return abi === undefined ? undefined : input.native?.abiMap?.[abi] ?? abi;
    }),
  );
  const provider: vscode.DebugConfigurationProvider = {
    provideDebugConfigurations: () => getAndroidDebugConfigurations(),
    resolveDebugConfiguration: (_folder, input) => {
      const config = omitAuto(input);
      const options = config.type === 'android-jvm' || (config.mode ?? config.androidMode) === 'java' ? config.java : config.native;
      if (options?.preLaunchTask && config.preLaunchTask && options.preLaunchTask !== config.preLaunchTask) throw new Error('Use one preLaunchTask at the top level or in the selected debugger configuration');
      if (options?.preLaunchTask !== undefined) config.preLaunchTask ??= options.preLaunchTask;
      return config;
    },
    async resolveDebugConfigurationWithSubstitutedVariables(folder, input, token) {
      if ([...runs].some(run => run.matchesChild(input) || (run.matches(input) && run.engineConfig?.type === input.type && run.engineConfig?.port === input.port && run.engineConfig?.androidLldbServerSocket === input.androidLldbServerSocket))) return input;
      if (input.type === 'lldb' && !input.androidTarget) return input;
      if (!vscode.workspace.isTrusted) throw new Error('Workspace is not trusted');
      const config = omitAuto(input);
      config.packageName ??= config.androidPackageName;
      if (config.type === 'lldb') config.native = { ...config.native, ...(config.androidAbi !== undefined ? { abi: config.androidAbi } : {}), ...(config.androidAbiSupported !== undefined ? { abiSupported: config.androidAbiSupported } : {}), ...(config.androidAbiMap !== undefined ? { abiMap: config.androidAbiMap } : {}) };
      if (!['launch', 'attach'].includes(config.request)) throw new Error('Android request must be launch or attach');
      if (config.pid !== undefined || config.processId !== undefined) {
        const pid = Number(config.pid ?? config.processId);
        if (!/^\d+$/.test(String(config.pid ?? config.processId)) || !Number.isSafeInteger(pid) || pid <= 0 || (config.pid !== undefined && config.processId !== undefined && Number(config.pid) !== Number(config.processId))) throw new Error('Invalid or conflicting Android process id');
        config.pid = pid; config.processId = pid;
      }
      if (config.type === 'android-jvm' && config.android !== true) throw new Error('android-jvm requires android: true');
      for (const key of ['native', 'java']) if (config[key] !== undefined && (!config[key] || typeof config[key] !== 'object' || Array.isArray(config[key]))) throw new Error(key + ' must be an object');
      if (config.androidMode !== undefined && config.mode !== undefined && config.androidMode !== config.mode) throw new Error('Conflicting Android debug modes');
      const mode: Mode = config.type === 'android-jvm' ? 'java' : config.mode ?? config.androidMode ?? 'native';
      if (!['native', 'java', 'dual'].includes(mode) || (config.type === 'android-tools' && mode !== 'native')) throw new Error('Unsupported Android debug mode');
      config.androidProjectRoot ??= config.projectRoot ?? folder?.uri.fsPath;
      config.sourcePaths ??= config.androidSourceRoots;
      for (const key of ['androidProjectRoot', 'projectRoot', 'apkPath']) if (typeof config[key] === 'string' && !path.isAbsolute(config[key])) {
        if (!folder) throw new Error('Relative path requires a workspace folder');
        config[key] = path.resolve(folder.uri.fsPath, config[key]);
      }
      for (const options of [config, config.java]) if (options) {
        if (options.projectRoot && !path.isAbsolute(options.projectRoot)) {
          if (!folder) throw new Error('Relative projectRoot requires a workspace folder');
          options.projectRoot = path.resolve(folder.uri.fsPath, options.projectRoot);
        }
        if (options.sourcePaths !== undefined) {
          if (!Array.isArray(options.sourcePaths) || options.sourcePaths.some((value: unknown) => typeof value !== 'string')) throw new Error('sourcePaths must be a string array');
          options.sourcePaths = options.sourcePaths.map((value: string) => {
            if (path.isAbsolute(value)) return value;
            const root = options.projectRoot ?? config.androidProjectRoot;
            if (!root) throw new Error('Relative sourcePaths require a project root');
            return path.resolve(root, value);
          });
        }
      }
      const source = debugStartupSignal(config), scope = new AbortController();
      const abort = () => scope.abort(source?.reason ?? new Error('Debug configuration cancelled'));
      source?.addEventListener('abort', abort, { once: true });
      const subscription = token?.onCancellationRequested(abort);
      if (source?.aborted || token?.isCancellationRequested) abort();
      let run: DebugRun | undefined;
      try {
        scope.signal.throwIfAborted();
        const devices = (await DebugDevice.devices(scope.signal)).filter(device => device.state === 'device');
        scope.signal.throwIfAborted();
        let serial = config.serial ?? config.target ?? config.androidTarget;
        if (typeof serial === 'object') serial = serial.udid;
        if (serial === 'last-selected') serial = recent.serial;
        if (!serial || serial === 'select') serial = (await vscode.window.showQuickPick(devices.map(device => ({ label: device.serial, serial: device.serial })), { placeHolder: 'Select Android device' }, debugCancellationToken(scope.signal)))?.serial;
        if (!serial) return undefined;
        scope.signal.throwIfAborted();
        if (!devices.some(device => device.serial === serial)) throw new Error('Android device is not online: ' + serial);
        recent.serial = serial; config.serial = serial;
        const device = new DebugDevice(serial, config.androidProjectRoot);
        config.packageName ??= config.androidPackageName;
        if (config.request === 'launch' && !config.packageName) config.packageName = config.apkPath ? await getPackageNameFromApk(config.apkPath, config.androidProjectRoot) : (() => { const metadata = selectedPackage?.(folder); return typeof metadata === 'string' ? metadata : metadata?.packageName; })();
        if (config.request === 'attach' && (!config.pid && !config.processId || !config.packageName)) {
          const rows = await device.clients(scope.signal);
          const raw = config.pid ?? config.processId;
          const matches = raw !== undefined ? rows.filter(row => row.pid === Number(raw)) : config.packageName ? rows.filter(row => row.packageName === config.packageName) : [];
          const candidates = matches.length ? matches : raw === undefined ? rows : [];
          const selected = candidates.length === 1 ? candidates[0] : (await vscode.window.showQuickPick(candidates.map(row => ({ label: row.packageName, description: String(row.pid), detail: 'PID ' + row.pid, row })), { placeHolder: 'Pick Android Process' }, debugCancellationToken(scope.signal)))?.row;
          if (!selected) { if (!candidates.length) throw new Error('No attachable Android processes found'); return undefined; }
          Object.assign(config, { pid: selected.pid, processId: selected.pid, packageName: selected.packageName });
        }
        scope.signal.throwIfAborted();
        if (typeof config.packageName !== 'string' || !/^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)+$/.test(config.packageName)) throw new Error('A valid Android packageName is required');
        if (config.apkPath && !fs.statSync(config.apkPath).isFile()) throw new Error('APK is not a file');
        if ([...runs].some(value => value.matches(config))) throw new Error('This Android debug configuration is already running');
        run = new DebugRun(config, mode, device, folder, context, () => runs.delete(run!));
        runs.add(run);
        reportDebugConnection(config, run.connected);
        const cancel = () => run!.controller.abort(scope.signal.reason);
        scope.signal.addEventListener('abort', cancel, { once: true });
        try { const engine = await run.prepare(); scope.signal.throwIfAborted(); run.engineConfig = engine; return engine; }
        finally { scope.signal.removeEventListener('abort', cancel); }
      } catch (error) {
        if (run) { try { await run.close(run.launched); } catch (cleanup) { throw new AggregateError([error, cleanup], 'Android startup failed'); } }
        throw error;
      } finally { subscription?.dispose(); source?.removeEventListener('abort', abort); }
    },
  };
  for (const type of ['android-debug', 'android-tools', 'android-jvm', 'lldb']) context.subscriptions.push(vscode.debug.registerDebugConfigurationProvider(type, provider));
  context.subscriptions.push(vscode.debug.registerDebugConfigurationProvider('android-debug', { provideDebugConfigurations: () => getAndroidDebugConfigurations() }, vscode.DebugConfigurationProviderTriggerKind.Dynamic));
  for (const type of ['lldb', 'android-jvm']) context.subscriptions.push(vscode.debug.registerDebugAdapterTrackerFactory(type, {
    createDebugAdapterTracker(session) {
      const child = [...runs].find(run => run.matchesChild(session.configuration));
      const root = child ?? [...runs].find(run => run.matches(session.configuration));
      return root?.tracker(session, !!child);
    },
  }));
  const owner = { async dispose() {
    const results = await Promise.allSettled([...runs].map(run => run.close(false)));
    const errors = results.filter((value): value is PromiseRejectedResult => value.status === 'rejected').map(value => value.reason);
    if (errors.length) throw new AggregateError(errors, 'Android debugger shutdown failed');
  } };
  context.subscriptions.push(owner);
  return owner;
}
