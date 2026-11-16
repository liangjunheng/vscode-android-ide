import * as vscode from 'vscode';
import { DeviceExplorerProcesses, ExplorerProcess } from './deviceExplorerProcesses';

// 独立进程视图负责追踪、包过滤、操作与连接释放，Explorer共享区域管理激活及60秒闲置保留。
// 回归：tests/device-explorer-controller.test.js执行真实本模块，覆盖Files/Processes互斥及tracker关闭。
export class ProcessesController {
  private readonly backend: DeviceExplorerProcesses;
  private rows: ExplorerProcess[] = [];
  private filter = false;
  private applicationIds: string[] = [];
  private stopWatching?: () => void | Promise<void>;
  private starting?: Promise<void>;
  private failure?: Error;

  // 真实追踪句柄存在且未失败/取消才可复用；view-idle回归验证返回时不重复watch及错误后重连。
  get connected(): boolean { return !!this.stopWatching && !this.failure && !this.signal.aborted; }

  // 固定设备和作用域signal，不在构造时建立连接；controller回归断言Files视图零tracker。
  constructor(private readonly serial: string, private readonly signal: AbortSignal, private readonly post: (message: unknown) => void) {
    this.backend = new DeviceExplorerProcesses(serial);
  }

  // 精确识别本模块的动作，不能把文件操作混入进程视图；controller回归覆盖旧tab与跨视图消息拒绝。
  static handles(action: string): boolean { return ['processes', 'kill', 'forceStop', 'clearData', 'uninstall', 'debug', 'backup', 'restore'].includes(action); }

  // 调试同时要求已注册适配器和attach配置，未实现BackupService与原生拖出不伪装启用；controller与UI回归覆盖禁用能力。
  static capabilities(): { debug: boolean; backup: boolean; restore: boolean; nativeDrag: boolean } {
    return { debug: ProcessesController.debugConfigurations().length > 0, backup: false, restore: false, nativeDrag: false };
  }

  // 只启用有实际注册调试器的Android attach配置，不把Java适配器或孤立配置当作Android支持；controller调试回归验证缺失、匹配、卸载与启动失败。
  private static debugConfigurations(): vscode.DebugConfiguration[] {
    const configurations = vscode.workspace.getConfiguration('launch').get<vscode.DebugConfiguration[]>('configurations', []).filter(config => config.request === 'attach' && config.type === 'android');
    if (!configurations.length) { return configurations; }
    return configurations.filter(config => vscode.extensions.all.some(extension => {
      const debuggers = extension.packageJSON?.contributes?.debuggers;
      return Array.isArray(debuggers) && debuggers.some(debuggerType => debuggerType.type === config.type);
    }));
  }

  // 每个异步操作继续前检查实际signal和信任，不使用代次过滤；controller回归断言切换/取消无后继命令。
  private check(signal: AbortSignal = this.signal): void { this.signal.throwIfAborted(); signal.throwIfAborted(); if (!vscode.workspace.isTrusted) { throw new Error('Workspace is not trusted'); } }

  // 当前可见设备的最新rows可以在Webview ready后重新发布，过滤不改变底层JDWP集合；controller回归覆盖消息初始化。
  publish(): void {
    this.check();
    const rows = this.filter && this.applicationIds.length ? this.rows.filter(row => !!row.packageName && this.applicationIds.includes(row.packageName)) : this.rows;
    this.post({ type: 'explorerProcesses', serial: this.serial, processes: rows, ...(this.failure ? { error: String(this.failure) } : {}) });
  }

  // 显式刷新重建tracker，创建中请求共用Promise，普通切回直接publish；view-idle/controller回归验证单连接及筛选。
  async start(filter: boolean, applicationIds: readonly string[]): Promise<void> {
    this.check(); this.filter = filter; this.applicationIds = [...applicationIds];
    if (this.starting) { return this.starting; }
    const task = this.openTracker(); this.starting = task;
    try { await task; } finally { this.starting = undefined; }
  }

  // 建立单个追踪所有者，所有并发start共用这个创建任务；view-idle/controller回归覆盖创建中切换和失败清理。
  private async openTracker(): Promise<void> {
    await this.stopTracker(); this.check(); this.failure = undefined;
    this.stopWatching = await this.backend.watch(rows => { this.check(); this.rows = rows; this.publish(); }, error => {
      if (!this.signal.aborted) { this.failure = error; this.post({ type: 'explorerProcesses', serial: this.serial, processes: this.rows, error: String(error) }); }
    }, this.signal);
    if (this.signal.aborted) { await this.stopTracker(); this.check(); }
  }

  // 只释放自己已有的tracker，不等待当前创建任务自身；view-idle回归验证stop只执行一次。
  private async stopTracker(): Promise<void> { const stop = this.stopWatching; this.stopWatching = undefined; await stop?.(); }

  // 动作使用激活signal，切走立即取消而保留tracker；确认后核对行；view-idle/controller回归验证取消和PID归属。
  async handle(message: any, signal: AbortSignal = this.signal): Promise<void> {
    this.check(signal);
    if (!ProcessesController.handles(message.action)) { throw new Error('Unknown Processes action'); }
    const row = this.rows.find(item => item.pid === message.pid);
    if (!row) { throw new Error('Selected process is no longer available'); }
    if (message.action === 'backup' || message.action === 'restore') { throw new Error('Android Studio BackupService integration is not available in this extension'); }
    if (message.action === 'debug') {
      const options = ProcessesController.debugConfigurations();
      if (!options.length) { throw new Error('Configure an Android attach debug adapter before attaching'); }
      const selected = await vscode.window.showQuickPick(options.map(config => ({ label: config.name, config })), { title: 'Attach Android debugger' });
      this.check(signal); if (!selected) { return; }
      if (!this.rows.includes(row)) { throw new Error('Selected process is no longer available'); }
      const accepted = await vscode.debug.startDebugging(vscode.workspace.workspaceFolders?.[0], { ...selected.config, serial: this.serial, processId: row.pid, pid: row.pid, packageName: row.packageName });
      if (!accepted) { throw new Error('Android debug adapter did not start'); } return;
    }
    const answer = await vscode.window.showWarningMessage(message.action + ' ' + (row.name || row.pid) + '?', { modal: true }, 'Continue');
    this.check(signal); if (answer !== 'Continue') { return; }
    if (!this.rows.includes(row)) { throw new Error('Selected process is no longer available'); }
    if (message.action === 'kill') { await this.backend.kill(row.pid, signal); }
    else {
      if (!row.packageName) { throw new Error('Package name is unavailable for this process'); }
      if (message.action === 'forceStop') { await this.backend.forceStop(row.packageName, row.userId, signal); }
      else if (message.action === 'clearData') { await this.backend.clearData(row.packageName, row.userId, signal); }
      else if (message.action === 'uninstall') { await this.backend.uninstall(row.packageName, signal); }
    }
    this.check(signal); this.post({ type: 'explorerProgress', serial: this.serial, busy: false, message: 'Process action complete' });
  }

  // 到期或销毁时等待本视图拥有的追踪连接关闭，不停止设备应用；view-idle/controller回归断言创建中取消、单次stop及闲置期限。
  async dispose(): Promise<void> {
    try { if (this.starting) { await this.starting; } }
    catch (error) { if (!this.signal.aborted || error !== this.signal.reason) { throw error; } }
    finally { await this.stopTracker(); }
  }
}
