import * as vscode from 'vscode';
import * as debugadapter from '@vscode/debugadapter';
import type { DebugProtocol } from '@vscode/debugprotocol';
import { AndroidCoordinator, AndroidDebugSession } from './coordinator/androidCoordinator';
import { prepareJvmChild } from './jvm-debugger/session';
import { NativeSessionCapability, NativeSessionServices } from './native-debugger/session';
import { attachDual } from './dual-debugger/session';

export interface AndroidSessionHost extends NativeSessionServices {
  resolveSession(config: vscode.DebugConfiguration): Promise<vscode.DebugConfiguration>;
  processId(config: vscode.DebugConfiguration): number;
  describe(error: unknown): string;
  report(error: unknown): void;
  dispose(): Promise<void>;
}

/** 统一会话宿主只编排生命周期，Native/JVM/Dual 能力分别来自独立模块。 */
export class DebugAdapterDescriptorFactory implements vscode.DebugAdapterDescriptorFactory {
  private readonly active = new Set<AndroidSessionAdapter>();

  /** 功能：绑定共享宿主与控制面；输入扩展上下文；输出工厂生命周期；验证：native-codelldb.test.js。 */
  constructor(context: vscode.ExtensionContext, private readonly host: AndroidSessionHost, private readonly coordinator: AndroidCoordinator) { context.subscriptions.push(this); }

  /** 功能：创建统一父 DAP；输入真实 VS Code 会话；输出内联适配器；验证：native-codelldb.test.js。 */
  createDebugAdapterDescriptor(session: vscode.DebugSession): vscode.DebugAdapterDescriptor {
    const adapter = new AndroidSessionAdapter(session, this.host, this.coordinator, () => this.active.delete(adapter));
    this.active.add(adapter);
    return new vscode.DebugAdapterInlineImplementation(adapter);
  }

  /** 功能：等待全部父会话及Native在途部署清理；输入工厂生命周期；输出聚合错误；验证：native-codelldb.test.js。 */
  async dispose(): Promise<void> {
    const results = await Promise.allSettled([...this.active].map(adapter => adapter.dispose()));
    try { await this.host.dispose(); } catch (reason) { results.push({ status: 'rejected', reason }); }
    const errors = results.filter((value): value is PromiseRejectedResult => value.status === 'rejected').map(value => value.reason);
    if (errors.length) throw new AggregateError(errors, 'Android sessions cleanup failed');
  }
}

class AndroidSessionAdapter extends debugadapter.LoggingDebugSession {
  private config: vscode.DebugConfiguration;
  private readonly childSessions = new Map<string, vscode.DebugSession>();
  private readonly pendingChildren = new Map<string, { session?: vscode.DebugSession; failure?: Error }>();
  private readonly stoppingChildren = new Map<string, Promise<PromiseSettledResult<void>>>();
  private resources?: AndroidDebugSession;
  private native?: NativeSessionCapability;
  private startup?: Promise<void>;
  private closing?: Promise<void>;
  private resourcesClosing?: Promise<void>;
  private earlyChildStop?: Promise<PromiseSettledResult<void>[]>;
  private readonly controller = new AbortController();
  private readonly subscriptions: vscode.Disposable[];
  private childFailure?: Error;
  private terminated = false;

  /** 功能：监听所属子会话；输入父会话及能力宿主；输出独立生命周期；验证：native-codelldb.test.js。 */
  constructor(private readonly session: vscode.DebugSession, private readonly host: AndroidSessionHost, private readonly coordinator: AndroidCoordinator, private readonly released: () => void) {
    super();
    this.config = session.configuration;
    this.subscriptions = [vscode.debug.onDidStartDebugSession(this.childStarted), vscode.debug.onDidTerminateDebugSession(this.childTerminated)];
  }

  /** 功能：登记精确父身份的子会话；输入宿主事件；输出自有子集合；验证：native-codelldb.test.js。 */
  private childStarted = (child: vscode.DebugSession): void => {
    const pending = this.pendingChildren.get(child.type);
    if (child.parentSession?.id !== this.session.id || !pending || pending.session) return;
    pending.session = child;
    this.childSessions.set(child.id, child);
    if (this.controller.signal.aborted) void this.stopOwnedChild(child);
  };

  /** 功能：必要子会话结束时关闭组合；输入宿主事件；输出取消与父终止；验证：native-codelldb.test.js。 */
  private childTerminated = (child: vscode.DebugSession): void => {
    if (!this.childSessions.delete(child.id) || this.controller.signal.aborted || this.resourcesClosing) return;
    const error = new Error(child.type + ' child session terminated');
    const pending = this.pendingChildren.get(child.type);
    if (pending) pending.failure = error;
    this.childFailure = error;
    this.controller.abort(error);
    void this.dispose().then(() => this.sendTerminated(), failure => { this.host.report(failure); this.sendTerminated(); });
  };

  /** 功能：只发送一次终止；输出父 DAP 事件；验证：native-codelldb.test.js。 */
  private sendTerminated(): void { if (!this.terminated) { this.terminated = true; this.sendEvent(new debugadapter.TerminatedEvent()); } }

  /** 功能：确认当前会话仍可启动；输出实际取消错误；验证：native-codelldb.test.js。 */
  private checkOpen(): void { if (this.childFailure) throw this.childFailure; this.controller.signal.throwIfAborted(); if (this.closing) throw new Error('Android session is closing'); }

  /** 功能：启动并等待实际子注册；输入能力生成的配置；输出成功或具体拒绝；验证：native-codelldb.test.js。 */
  private async startChild(config: vscode.DebugConfiguration): Promise<void> {
    this.checkOpen();
    const pending: { session?: vscode.DebugSession; failure?: Error } = {};
    this.pendingChildren.set(config.type, pending);
    try {
      const success = await vscode.debug.startDebugging(this.session.workspaceFolder, config, { parentSession: this.session });
      if (pending.failure) throw pending.failure;
      const name = config.type === 'lldb' ? 'CodeLLDB' : 'JVM';
      if (!success) throw new Error(name + (this.controller.signal.aborted ? ' child startup was cancelled.' : ' rejected the child configuration. Check the child debugger output.'));
      if (!pending.session) throw new Error(name + ' did not report a child session');
      this.checkOpen();
    } finally { this.pendingChildren.delete(config.type); }
  }

  /** 功能：复用独立能力附加同一目标；输入唯一 PID；输出所选模式就绪；验证：native-codelldb.test.js、coordinator-device-host.test.js。 */
  private async attachChildren(pid: number): Promise<void> {
    const mode = this.config.mode ?? 'native';
    const jvm = async (): Promise<void> => this.startChild(await prepareJvmChild(this.config, pid, this.session, this.resources!));
    const native = async (): Promise<void> => {
      this.native = new NativeSessionCapability(this.host, this.coordinator, this.resources!, this.session);
      await this.native.attach(this.config, pid, config => this.startChild(config));
    };
    if (mode === 'dual') { await attachDual(native, jvm, error => this.cancelStartup(error)); return; }
    if (mode === 'java') { await jvm(); return; }
    await native();
    if (this.config.resumeProcess ?? this.config.request === 'launch') await this.native!.resume(pid);
  }

  /** 功能：附加已解析的现有进程；输入 DAP 请求；输出能力启动响应；验证：native-codelldb.test.js。 */
  protected async attachRequest(response: DebugProtocol.AttachResponse): Promise<void> { await this.begin(response, () => this.attachChildren(this.host.processId(this.config))); }

  /** 功能：只启动一次应用并将同一 PID 交给所选能力；输入 DAP 请求；输出启动结果；验证：native-codelldb.test.js、coordinator-device-host.test.js。 */
  protected async launchRequest(response: DebugProtocol.LaunchResponse): Promise<void> {
    await this.begin(response, async () => {
      const config = this.config, serial = this.resources!.serial, signal = this.resources!.signal;
      if (!/^[A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)+$/.test(config.packageName ?? '')) throw new Error('A valid package name is required.');
      if (config.apkPath) await this.coordinator.install(serial, config.apkPath, signal);
      const component = config.launchActivity ? config.packageName + '/' + config.launchActivity : '';
      if (component && !/^[\w.$]+\/[\w.$]+$/.test(component)) throw new Error('Invalid Android launch component');
      const pid = await this.coordinator.launch(serial, config.packageName, component, signal);
      this.checkOpen();
      await this.attachChildren(this.host.processId({ ...config, pid, processId: pid }));
    });
  }

  /** 功能：管理统一启动和失败回滚；输入请求及模式操作；输出实际 DAP 结果；验证：native-codelldb.test.js。 */
  private async begin(response: DebugProtocol.Response, action: () => Promise<void>): Promise<void> {
    if (this.startup || this.closing) { response.success = false; response.message = 'Android session has already started or closed'; this.sendResponse(response); return; }
    this.startup = (async () => {
      try {
        const target = this.config.target;
        const serial = this.config.serial ?? (typeof target === 'object' ? target.udid : target);
        this.resources = this.coordinator.session(serial, error => {
          this.childFailure = error; this.controller.abort(error);
          void this.dispose().then(() => this.sendTerminated(), failure => { this.host.report(failure); this.sendTerminated(); });
        });
        this.controller.signal.addEventListener('abort', () => this.resources!.cancel(this.controller.signal.reason), { once: true });
        this.checkOpen();
        this.config = await this.host.resolveSession({ ...this.config, signal: this.resources.signal });
        this.checkOpen(); await action(); response.success = true;
      } catch (error) {
        let failure = error;
        try { await this.closeResources(); } catch (cleanup) { failure = new AggregateError([error, cleanup], 'Android startup and cleanup failed'); }
        response.success = false; response.message = this.host.describe(failure); this.releaseListeners();
      }
      this.sendResponse(response);
      if (!response.success) this.sendTerminated();
    })();
    await this.startup;
  }

  /** 功能：停止组合会话；输入断开请求；输出清理响应与终止；验证：native-codelldb.test.js。 */
  protected async disconnectRequest(response: DebugProtocol.DisconnectResponse): Promise<void> {
    try { await this.dispose(); response.success = true; } catch (error) { response.success = false; response.message = this.host.describe(error); }
    this.sendResponse(response); this.sendTerminated();
  }

  /** 功能：失败时立即停止已登记子会话以解除启动互等；输入错误；输出共享取消与停止任务；验证：native-codelldb.test.js。 */
  private cancelStartup(error: unknown): void {
    this.controller.abort(error);
    for (const child of this.childSessions.values()) void this.stopOwnedChild(child);
  }

  /** 功能：为每个自有子会话登记唯一停止结果；输入子会话；输出不会产生未观察拒绝的结果；验证：native-codelldb.test.js。 */
  private stopOwnedChild(child: vscode.DebugSession): Promise<PromiseSettledResult<void>> {
    let stopping = this.stoppingChildren.get(child.id);
    if (!stopping) {
      stopping = this.stopChild(child).then(() => ({ status: 'fulfilled' as const, value: undefined }), reason => ({ status: 'rejected' as const, reason }));
      this.stoppingChildren.set(child.id, stopping);
    }
    return stopping;
  }

  /** 功能：请求停止并等待精确子会话终止；输入自有子会话；输出实际退出屏障，失败释放监听；验证：native-codelldb.test.js迟到终止回归。 */
  private async stopChild(child: vscode.DebugSession): Promise<void> {
    let terminated!: () => void;
    const exited = new Promise<void>(resolve => { terminated = resolve; });
    const subscription = vscode.debug.onDidTerminateDebugSession(session => { if (session.id === child.id) terminated(); });
    try { await vscode.debug.stopDebugging(child); await exited; }
    finally { subscription.dispose(); }
  }

  /** 功能：先停止已出现子会话解除启动等待，再结算全部资源；输出幂等关闭；验证：native-codelldb.test.js。 */
  override dispose(): Promise<void> {
    this.controller.abort(this.childFailure ?? new Error('Android session is closing'));
    return this.closing ??= Promise.resolve().then(async () => {
      const errors: unknown[] = [];
      try {
        const children = [...this.childSessions.values()]; this.childSessions.clear();
        this.earlyChildStop = Promise.all(children.map(child => this.stopOwnedChild(child)));
        const results = await this.earlyChildStop;
        errors.push(...results.filter((value): value is PromiseRejectedResult => value.status === 'rejected').map(value => value.reason));
        await this.startup;
        try { await this.closeResources(); } catch (error) { errors.push(error); }
        if (errors.length) throw new AggregateError(errors, 'Android sessions cleanup failed');
      } finally { this.releaseListeners(); super.dispose(); }
    });
  }

  /** 功能：引擎先退出后关闭 Native 和共享租约；输出全部清理错误；验证：native-codelldb.test.js。 */
  private closeResources(): Promise<void> {
    return this.resourcesClosing ??= Promise.resolve().then(async () => {
      await this.earlyChildStop;
      const children = [...this.childSessions.values()]; this.childSessions.clear();
      for (const child of children) void this.stopOwnedChild(child);
      const results = await Promise.all(this.stoppingChildren.values());
      const cleanup = await Promise.allSettled([this.native?.close(), this.resources?.close()]);
      const errors = [...results, ...cleanup].filter((value): value is PromiseRejectedResult => value.status === 'rejected').map(value => value.reason);
      if (errors.length) throw new AggregateError(errors, 'Android child/server/JDWP cleanup failed');
    });
  }

  /** 功能：释放会话自有监听；输出从工厂移除；验证：native-codelldb.test.js。 */
  private releaseListeners(): void { for (const subscription of this.subscriptions.splice(0)) subscription.dispose(); this.released(); }
}
