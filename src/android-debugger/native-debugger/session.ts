import * as vscode from 'vscode';
import type { AndroidCoordinator, AndroidDebugSession } from '../coordinator/androidCoordinator';
import { nativeToolchainOverrides } from './nativeToolchain';
import { nativeLibraryCommands } from './nativeSymbols';

export interface NativeSessionServices {
  prepareNative(config: vscode.DebugConfiguration, folder?: vscode.WorkspaceFolder): Promise<vscode.DebugConfiguration>;
  releaseNative(socket?: string): Promise<void>;
}

/** Native 单模式和 Dual 共用的 CodeLLDB 配置、附加及恢复能力。 */
export class NativeSessionCapability {
  private socket?: string;
  private closing?: Promise<void>;

  /** 功能：绑定共享会话资源；输入 Native 服务与实际目标；输出独占 Native 能力；验证：native-codelldb.test.js。 */
  constructor(private readonly services: NativeSessionServices, private readonly coordinator: AndroidCoordinator, private readonly resources: AndroidDebugSession, private readonly parent: vscode.DebugSession) {}

  /** 功能：按真实 Native 配置准备并启动 CodeLLDB；输入目标配置、PID 和统一子会话启动函数；输出附加完成；验证：native-codelldb.test.js、coordinator-device-host.test.js。 */
  async attach(config: vscode.DebugConfiguration, pid: number, start: (config: vscode.DebugConfiguration) => Promise<void>): Promise<void> {
    this.resources.signal.throwIfAborted();
    let child = this.configuration(config, pid);
    child = await this.services.prepareNative(child, this.parent.workspaceFolder);
    this.socket = child.androidLldbServerSocket;
    if (this.resources.signal.aborted) { await this.close(); this.resources.signal.throwIfAborted(); }
    this.resources.own(() => this.close());
    const codeLldb = vscode.extensions.getExtension('vadimcn.vscode-lldb');
    if (!codeLldb) throw new Error('CodeLLDB extension is not installed or enabled');
    if (!codeLldb.isActive) await codeLldb.activate();
    this.resources.signal.throwIfAborted();
    await start(child);
    if (!config.androidNativeLibraries?.length && !config.native?.symbolSearchPaths?.length) void vscode.window.showWarningMessage('Android Native debugger attached, but no project-built .so files with debug information were found for this ABI. Build the project with Native debug information and use the matching APK. External and precompiled libraries are not loaded automatically.');
    this.resources.signal.throwIfAborted();
  }

  /** 功能：仅为 Native 单模式恢复等待 VM；输入同一 PID；输出 JDWP VM.Resume 完成；验证：native-codelldb.test.js 和 Java Coordinator 测试。 */
  async resume(pid: number): Promise<void> {
    const lease = await this.resources.claim(pid);
    await this.coordinator.resume(lease.leaseId, this.resources.signal);
    this.resources.signal.throwIfAborted();
  }

  /** 功能：释放自有 Native server；输入内部 socket；输出幂等回收结果；验证：native-codelldb.test.js。 */
  close(): Promise<void> {
    return this.closing ??= (async () => {
      const socket = this.socket;
      this.socket = undefined;
      if (socket) await this.services.releaseNative(socket);
    })();
  }

  /** 功能：构造 CodeLLDB 独立配置；输入已验证目标和PID；输出隔离副本与精确符号命令；验证：native-codelldb.test.js、native-symbol-selection.test.js。 */
  private configuration(config: vscode.DebugConfiguration, pid: number): vscode.DebugConfiguration {
    const child: vscode.DebugConfiguration = { type: 'lldb', name: 'Native', request: 'attach', pid,
      androidTarget: this.resources.serial, androidAbi: config.native?.abi, androidPackageName: config.packageName,
      androidProjectRoot: config.androidProjectRoot, sourceLanguages: ['c', 'cpp'],
      androidNativeToolchain: config.androidNativeToolchain ?? nativeToolchainOverrides(config.native), signal: this.resources.signal };
    const excluded = new Set(['abi', 'abiSupported', 'abiMap', 'sdkRoot', 'ndkRoot', 'androidNativeToolchain', 'androidLldbServerSocket', 'signal']);
    for (const [key, value] of Object.entries(config.native ?? {})) if (!excluded.has(key)) child[key] = structuredClone(value);
    for (const field of ['preRunCommands', 'postRunCommands']) if (child[field] !== undefined && (!Array.isArray(child[field]) || child[field].some((value: unknown) => typeof value !== 'string'))) throw new Error('Native ' + field + ' must be a string array');
    child.postRunCommands = [...(child.postRunCommands ?? []), ...(config.androidNativeLibraries?.length ? nativeLibraryCommands(config.androidNativeLibraries) : []), 'target modules list', 'image list -o -f'];
    Object.assign(child, { type: 'lldb', request: 'attach', pid, androidTarget: this.resources.serial, androidPackageName: config.packageName, androidProjectRoot: config.androidProjectRoot });
    return child;
  }
}
