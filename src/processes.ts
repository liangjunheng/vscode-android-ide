import * as vscode from 'vscode';
import { DeviceExplorerProcesses, ExplorerProcess } from './deviceExplorerProcesses';
import { selectAndroidDebugConfiguration, startAndroidDebugging } from './android-debugger';
import type { NativeSourceModule } from './androidProjectModel';

/** 保留已有调用方的可选Build项目模型类型；Processes调试不调用该提供方，controller回归断言所有模式均零模型查询。 */

// 独立进程视图负责追踪、包过滤、操作与连接释放，Explorer共享区域管理激活及60秒闲置保留。
// 回归：tests/device-explorer-controller.test.js执行真实本模块，覆盖Files/Processes互斥及tracker关闭。
export type DebugProjectResolver = (packageName: string, workspaceRoot: string, signal: AbortSignal) => Promise<{ androidProjectRoot: string; androidModuleRoot: string; androidVariant: string; androidSourceRoots: string[]; androidNativeModules?: NativeSourceModule[] }>;

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

  // 固定设备和作用域signal，不在构造时建立连接；保留旧resolver参数兼容调用方，但调试不调用它。
  // 回归：node --test tests/device-explorer-controller.test.js，验证Files视图零tracker与所有Attach模式零模型。
  constructor(private readonly serial: string, private readonly signal: AbortSignal, private readonly post: (message: unknown) => void, _resolveDebugProject?: DebugProjectResolver) {
    this.backend = new DeviceExplorerProcesses(serial);
  }

  // 精确识别本模块的动作，不能把文件操作混入进程视图；controller回归覆盖旧tab与跨视图消息拒绝。
  static handles(action: string): boolean { return ['processes', 'kill', 'forceStop', 'clearData', 'uninstall', 'debug', 'backup', 'restore'].includes(action); }

  // 调试能力反映本扩展已注册的内置适配器，不依赖用户 launch.json；后端拒绝仍由动作显式报告。
  static capabilities(): { debug: boolean; backup: boolean; restore: boolean; nativeDrag: boolean } {
    return { debug: true, backup: false, restore: false, nativeDrag: false };
  }

  /** 选择调试配置所属 workspace：优先活动编辑器，其次唯一 workspace，多项必须显式选择。 */
  private async debugWorkspaceFolder(signal: AbortSignal): Promise<vscode.WorkspaceFolder | undefined> {
    const folders = vscode.workspace.workspaceFolders || [];
    const activeUri = vscode.window.activeTextEditor?.document.uri;
    const active = activeUri ? vscode.workspace.getWorkspaceFolder(activeUri) : undefined;
    if (active) return active;
    if (folders.length === 1) return folders[0];
    if (!folders.length) throw new Error('Select a workspace folder before debugging');
    const pick = await vscode.window.showQuickPick(folders.map(folder => ({ label: folder.name || folder.uri.fsPath, folder })), { title: 'Select Android workspace' });
    this.check(signal);
    return pick?.folder;
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

  // 选择三个内置Attach或任意外部配置，确认后绑定当前PID并交给设备连接生命周期；视图隐藏不取消已交接启动。
  // 回归：process-attach-start.test.js与device-explorer-controller.test.js验证完整菜单、三模式启动、取消及错误通知。
  async handle(message: any, signal: AbortSignal = this.signal): Promise<void> {
    this.check(signal);
    if (!ProcessesController.handles(message.action)) { throw new Error('Unknown Processes action'); }
    const row = this.rows.find(item => item.pid === message.pid);
    if (!row) { throw new Error('Selected process is no longer available'); }
    if (message.action === 'backup' || message.action === 'restore') { throw new Error('Android Studio BackupService integration is not available in this extension'); }
    if (message.action === 'debug') {
      const folder = await this.debugWorkspaceFolder(signal);
      this.check(signal);
      if (!this.rows.includes(row)) throw new Error('Selected process is no longer available');
      if (!folder) return;
      const config = await selectAndroidDebugConfiguration(folder, 'attach');
      this.check(signal);
      if (!this.rows.includes(row)) throw new Error('Selected process is no longer available');
      if (!config) return;
      const android = config.type === 'android-debug' || config.type === 'android-tools' || (config.type === 'android-jvm' && config.android === true);
      let selected = android ? { ...config, androidProjectRoot: config.androidProjectRoot ?? folder.uri.fsPath } : config;
      // Java默认源码由工作区扫描；Native/Dual仅用真实canonical ABI补缺，不覆盖显式选择，也不查询AGP模型。
      const native = config.type === 'android-tools' || (config.type === 'android-debug' && ['native', 'dual'].includes(config.mode ?? 'native'));
      const abi = row.abi && ['armeabi', 'armeabi-v7a', 'arm64-v8a', 'x86', 'x86_64'].includes(row.abi) ? row.abi : undefined;
      if (native && abi && selected.native?.abi === undefined) selected = { ...selected, native: { ...selected.native, abi } };
      const packageName = config.packageName ?? row.packageName;
      try {
        await startAndroidDebugging(folder, selected, { serial: this.serial, processId: row.pid, pid: row.pid, ...(packageName ? { packageName } : {}), signal: this.signal });
      } catch (error) {
        await vscode.window.showErrorMessage('Android process attach failed: ' + String(error));
        throw error;
      }
      return;
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
