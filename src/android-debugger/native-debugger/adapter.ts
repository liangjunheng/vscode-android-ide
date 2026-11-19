import * as fs from 'node:fs';
import * as vscode from 'vscode';
import { getAndroidDebugConfigurations } from '../index';
import * as android from './upstream/src/android';
import * as targetCommand from './upstream/src/targetCommand';
import * as targetPicker from './upstream/src/targetPicker';
import { AndroidDebugConfigurationProvider, LLDBDebugConfigurationProvider } from './upstream/src/debugConfigProvider';
import type { AndroidNativeDebugConfiguration, AndroidNativeDebugAdapterFactory } from './contracts';

import { DebugAdapterDescriptorFactory } from './upstream/src/debugAdapter';
import { findNativeSymbolSearchPaths, nativeToolchainOverrides, resolveNativeToolchain, validateNativeAbis } from './nativeToolchain';

/** 当前选中Gradle项目在对应工作区的只读包名来源；未知返回undefined，真实错误传播。 */
export interface NativeProjectMetadata { packageName?: string; abiSupported?: string[]; }
export type NativePackageResolver = (folder: vscode.WorkspaceFolder | undefined) => string | NativeProjectMetadata | undefined;

/** 校验 Native 启动前置条件；缺失/异常路径、ABI或符号目录可让用户输入并只修正本次会话，失败不创建设备/LLDB资源。 */
export async function validateNativeDebugConfiguration(config: vscode.DebugConfiguration, folder?: vscode.WorkspaceFolder, strictPaths = false, corrected = false): Promise<void> {
  try {
    const native = config.native;
    const overrides = nativeToolchainOverrides(native);
    resolveNativeToolchain(config.androidProjectRoot || folder?.uri.fsPath, overrides);
    validateNativeAbis(native, config.androidAbiSupported);
    const nativeConfig = native && typeof native === 'object' && !Array.isArray(native) ? native as Record<string, unknown> : undefined;
    const automaticSymbols = findNativeSymbolSearchPaths(config.androidProjectRoot || folder?.uri.fsPath, native);
    if (automaticSymbols.length && nativeConfig) nativeConfig.symbolSearchPaths = automaticSymbols;
    if ((!Array.isArray(nativeConfig?.symbolSearchPaths) || nativeConfig.symbolSearchPaths.length === 0) && typeof vscode.window?.showInputBox === 'function') {
      await promptNativeCorrection(config, 'symbolSearchPaths');
    }
    if (config.packageName !== undefined && (typeof config.packageName !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+$/.test(config.packageName))) throw new Error('A valid package name is required.');
    if (config.launchActivity !== undefined && (typeof config.launchActivity !== 'string' || !config.launchActivity.trim())) throw new Error('Invalid Native launchActivity: expected a non-empty activity name');
    if (config.apkPath !== undefined) {
      if (typeof config.apkPath !== 'string' || !config.apkPath.trim()) throw new Error('Invalid Native apkPath: expected a file path');
      if (strictPaths && !config.apkPath.includes('$' + '{')) {
        let stat: fs.Stats;
        try { stat = fs.statSync(config.apkPath); } catch (error) { throw new Error('Invalid Native APK path: ' + config.apkPath, { cause: error }); }
        if (!stat.isFile()) throw new Error('Invalid Native APK path: ' + config.apkPath);
      }
    }
  } catch (error) {
    const field = nativeCorrectionField(error);
    if (!corrected && field && await promptNativeCorrection(config, field)) return validateNativeDebugConfiguration(config, folder, strictPaths, true);
    const detail = error instanceof Error ? error.message : String(error);
    const action = await vscode.window.showErrorMessage('Android Native configuration is invalid: ' + detail + '. Correct launch.json and start again.', 'Open launch.json');
    if (action === 'Open launch.json' && typeof vscode.commands?.executeCommand === 'function') await vscode.commands.executeCommand('workbench.action.debug.configure');
    throw error;
  }
}

/** 将校验错误映射到可交互修正的 launch.json 字段；不可修正错误返回 undefined。 */
function nativeCorrectionField(error: unknown): 'sdkRoot' | 'ndkRoot' | 'abiSupported' | 'abi' | 'apkPath' | undefined {
  const message = error instanceof Error ? error.message : String(error);
  if (/SDK root/i.test(message)) return 'sdkRoot';
  if (/NDK root|Android NDK/i.test(message)) return 'ndkRoot';
  if (/abiSupported/i.test(message)) return 'abiSupported';
  if (/Invalid Native ABI/i.test(message)) return 'abi';
  if (/APK path|apkPath/i.test(message)) return 'apkPath';
  return undefined;
}

/** 弹出字段输入并写回当前会话配置副本；支持逗号分隔 symbolSearchPaths，取消返回 false，不写 settings 或 launch.json。 */
async function promptNativeCorrection(config: vscode.DebugConfiguration, field: 'sdkRoot' | 'ndkRoot' | 'abiSupported' | 'abi' | 'apkPath' | 'symbolSearchPaths'): Promise<boolean> {
  if (typeof vscode.window?.showInputBox !== 'function') return false;
  const native = (config.native && typeof config.native === 'object' && !Array.isArray(config.native)) ? { ...config.native } : {};
  const current = native[field];
  const value = await vscode.window.showInputBox({
    prompt: field === 'abiSupported' ? 'Enter supported Android ABIs separated by commas' : field === 'symbolSearchPaths' ? 'Enter unstripped native symbol directories separated by commas (optional)' : 'Enter Android Native ' + field,
    value: Array.isArray(current) ? current.join(',') : typeof current === 'string' ? current : '',
    ignoreFocusOut: true,
  });
  if (!value?.trim()) return false;
  if (field === 'abiSupported') native.abiSupported = value.split(',').map(item => item.trim()).filter(Boolean);
  else if (field === 'symbolSearchPaths') native.symbolSearchPaths = value.split(',').map(item => item.trim()).filter(Boolean);
  else if (field === 'abi') native.abi = value.trim();
  else { native[field] = value.trim(); if (field === 'apkPath') config.apkPath = value.trim(); }
  config.native = native;
  return true;
}

const registrations = new WeakMap<vscode.ExtensionContext, NativeLldbConfigurationProvider>();

/** 只初始化原设备/命令上下文，不在扩展激活时探测SDK/NDK；native-codelldb.test.js验证无工具链也可激活。 */
export function initializeNativeUpstream(context: vscode.ExtensionContext): void {
  targetPicker.activate(context);
  targetCommand.activate(context);
}

/** 将已解析设备变成真实serial；native-codelldb.test.js验证非法身份在启动child前失败。 */
export function targetSerial(config: AndroidNativeDebugConfiguration): string {
  const serial = config.serial || (typeof config.target === 'object' ? config.target.udid : config.target);
  if (!serial || ['select', 'last-selected'].includes(serial) || !/^[\w.:-]+$/.test(serial)) throw new Error('Select a valid Android device serial');
  return serial;
}

/** 校验可替换变量后的PID及重复字段一致性；native-codelldb.test.js验证正整数和冲突拒绝。 */
export function processId(config: AndroidNativeDebugConfiguration): number {
  const raw = config.pid ?? config.processId;
  if (!/^\d+$/.test(String(raw)) || !Number.isSafeInteger(Number(raw)) || Number(raw) <= 0 || (config.pid !== undefined && config.processId !== undefined && Number(config.pid) !== Number(config.processId))) throw new Error('Attach requires one valid Android process id');
  return Number(raw);
}

/** 使用原LLDB provider生成远程命令，并持有其创建的socket；native-codelldb.test.js验证重复解析不重复开server及失败清理。 */
export class NativeLldbConfigurationProvider implements vscode.DebugConfigurationProvider {
  private readonly delegate = new LLDBDebugConfigurationProvider();
  private readonly servers = new Map<string, Promise<void> | undefined>();

  /** 普通lldb原样通过；已准备且仍由本provider拥有的Android连接不重复解析。回归同文件外部/重复provider用例。 */
  async resolveDebugConfiguration(folder: vscode.WorkspaceFolder | undefined, config: vscode.DebugConfiguration, token?: vscode.CancellationToken): Promise<vscode.DebugConfiguration | null> {
    if (!config.androidTarget) return config;
    if (config.androidLldbServerSocket) {
      if (!this.servers.has(config.androidLldbServerSocket)) throw new Error('Android LLDB server is not owned by this provider');
      return config;
    }
    return this.delegate.resolveDebugConfiguration(folder, config, token!);
  }

  /** 启动原NDK server并记录所有权；后续配置失败回滚已经创建的socket，错误聚合。回归同文件provider失败用例。 */
  async resolveDebugConfigurationWithSubstitutedVariables(folder: vscode.WorkspaceFolder | undefined, config: vscode.DebugConfiguration, token?: vscode.CancellationToken): Promise<vscode.DebugConfiguration | null> {
    if (!config.androidTarget) return config;
    for (const name of ['initCommands', 'symbolSearchPaths']) if (config[name] !== undefined && (!Array.isArray(config[name]) || config[name].some((value: unknown) => typeof value !== 'string'))) throw new Error('Native ' + name + ' must be a string array');
    if (config.androidLldbServerSocket && this.servers.has(config.androidLldbServerSocket)) return config;
    try {
      const result = await this.delegate.resolveDebugConfigurationWithSubstitutedVariables(folder, config, token!);
      if (result?.androidLldbServerSocket) this.servers.set(result.androidLldbServerSocket, undefined);
      return result;
    } catch (error) {
      if (config.androidLldbServerSocket) {
        this.servers.set(config.androidLldbServerSocket, undefined);
        try { await this.release(config.androidLldbServerSocket); } catch (cleanup) { throw new AggregateError([error, cleanup], 'Native provider and server cleanup failed'); }
      }
      throw error;
    }
  }

  /** 停止自有server；并发释放共享清理Promise，非本provider的socket不触碰。回归同文件断开/重复释放门闩。 */
  async release(socket?: string): Promise<void> {
    if (!socket || !this.servers.has(socket)) return;
    let task = this.servers.get(socket);
    if (!task) {
      task = (async () => { try { await targetCommand.lldbServerCleanup(socket); } finally { this.servers.delete(socket); } })();
      this.servers.set(socket, task);
    }
    await task;
  }

  /** 扩展停用时结算所有剩余server，不丢失任一失败；native-codelldb.test.js验证释放归属。 */
  async dispose(): Promise<void> {
    const results = await Promise.allSettled([...this.servers.keys()].map(socket => this.release(socket)));
    const errors = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected').map(result => result.reason);
    if (errors.length) throw new AggregateError(errors, 'Native server cleanup failed');
  }
}

/** 复用原Android设备/进程/ABI两阶段provider，仅把后端限定为Native；native-codelldb.test.js覆盖select与两阶段变量解析。 */
export class NativeAndroidConfigurationProvider implements vscode.DebugConfigurationProvider {
  private readonly delegate = new AndroidDebugConfigurationProvider();

  /** 只在Launch缺省包名和APK时懒读Gradle选择；native-codelldb.test.js断言覆盖、未知与错误。 */
  constructor(private readonly selectedPackage: NativePackageResolver = () => undefined) {}

  /** 返回独立内置Native配置供Run and Debug显示名称，不探测工具链；native-codelldb.test.js直接调用initial/dynamic入口断言名称、复制隔离和零设备调用。 */
  provideDebugConfigurations(_folder?: vscode.WorkspaceFolder, _token?: vscode.CancellationToken): vscode.DebugConfiguration[] { return getAndroidDebugConfigurations().filter(config => config.type === 'android-tools'); }

  /** 建立原设备选择与命令变量上下文，拒绝不可信或非Native模式；回归同文件provider选择/取消用例。 */
  async resolveDebugConfiguration(folder: vscode.WorkspaceFolder | undefined, config: vscode.DebugConfiguration, token?: vscode.CancellationToken): Promise<vscode.DebugConfiguration | null> {
    if (!vscode.workspace.isTrusted) throw new Error('Workspace is not trusted');
    if ((config.androidMode ?? config.mode ?? 'native') !== 'native') throw new Error('Only Android Native debugging is available');
    await validateNativeDebugConfiguration(config, folder);
    const selected = !config.packageName && config.request === 'launch' && !config.apkPath ? this.selectedPackage(folder) : undefined;
    const metadata: NativeProjectMetadata | undefined = typeof selected === 'string' ? { packageName: selected } : selected;
    const packageName = config.packageName || metadata?.packageName;
    const native = { ...config.native };
    const supported = native.abiSupported ?? config.androidAbiSupported ?? metadata?.abiSupported;
    if (supported !== undefined) native.abiSupported = supported;
    validateNativeAbis(native, config.androidAbiSupported);
    const resolved = await this.delegate.resolveDebugConfiguration(folder, { ...config, ...(packageName ? { packageName } : {}), mode: 'native', androidMode: 'native', native, target: config.serial || config.target || 'select', androidProjectRoot: config.androidProjectRoot || folder?.uri.fsPath }, token!);
    const toolchain = nativeToolchainOverrides(native);
    if (resolved) {
      (resolved as Record<string, unknown>).androidNativeToolchain = toolchain;
      if (resolved.target && typeof resolved.target === 'object') (resolved.target as Record<string, unknown>).androidNativeToolchain = toolchain;
    }
    return resolved;
  }

  /** 变量替换后沿用原包名/ABI和resume默认值，规范化进程身份；回归同文件launch/attach解析断言。 */
  async resolveDebugConfigurationWithSubstitutedVariables(folder: vscode.WorkspaceFolder | undefined, config: vscode.DebugConfiguration, token?: vscode.CancellationToken): Promise<vscode.DebugConfiguration | null> {
    await validateNativeDebugConfiguration(config, folder, true);
    const result = await this.delegate.resolveDebugConfigurationWithSubstitutedVariables(folder, config, token!);
    if (result?.request === 'attach') { result.pid = processId(result as AndroidNativeDebugConfiguration); result.processId = result.pid; }
    return result;
  }
}

/** 无DAP请求可承载的后台清理失败必须可见，不能吞错；native-codelldb.test.js验证错误通知。 */
function reportCleanup(error: unknown): void { void vscode.window.showErrorMessage('Native debugger cleanup failed: ' + describeFailure(error)); }

/** 展开聚合错误中的每个实际失败，保留DAP/通知诊断；native-codelldb.test.js验证启动与多重清理错误均可见。 */
function describeFailure(error: unknown): string { return error instanceof AggregateError ? error.message + ': ' + error.errors.map(describeFailure).join('; ') : String(error); }

/** factory创建即注册Native provider，descriptor唯一注册权留给extension；同文件验证注册幂等/无NDK激活。 */
export function createAndroidDebugAdapterFactory(context: vscode.ExtensionContext, selectedPackage?: NativePackageResolver): AndroidNativeDebugAdapterFactory {
  const lldb = registerNativeProviders(context, selectedPackage);
  const factory = new DebugAdapterDescriptorFactory(context, {
    processId: config => processId(config as AndroidNativeDebugConfiguration),
    describe: describeFailure,
    report: reportCleanup,
    releaseNative: socket => lldb.release(socket),
    async resolveSession(config) {
      if (!vscode.workspace.isTrusted) throw new Error('Workspace is not trusted');
      if ((config.androidMode ?? config.mode ?? 'native') !== 'native') throw new Error('Only Android Native debugging is available');
      const serial = targetSerial(config as AndroidNativeDebugConfiguration);
      const selected = typeof config.target === 'object' ? config.target : await android.getDeviceFromUDID(serial, config.androidProjectRoot, nativeToolchainOverrides(config.native));
      const target = { ...selected, udid: serial, androidProjectRoot: config.androidProjectRoot, androidNativeToolchain: (selected as Record<string, unknown>).androidNativeToolchain ?? nativeToolchainOverrides(config.native) };
      const result: vscode.DebugConfiguration = { ...config, target, native: { ...config.native } };
      if (result.request === 'attach') {
        result.pid = processId(result as AndroidNativeDebugConfiguration);
        result.packageName ||= await targetCommand.getPackageNameForPid({device: target, pid: String(result.pid)});
        if (!result.packageName || !/^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+$/.test(result.packageName)) throw new Error('A valid package name is required.');
      }
      return result;
    },
    async prepareNative(config, folder) {
      const resolved = await lldb.resolveDebugConfiguration(folder, config);
      if (!resolved) throw new Error('Android Native target selection was cancelled');
      const ready = await lldb.resolveDebugConfigurationWithSubstitutedVariables(folder, resolved);
      if (!ready) throw new Error('Android Native server configuration was rejected');
      delete ready.androidNativeToolchain;
      return ready;
    },
  });
  return Object.assign(factory, { nativeOnly: true as const });
}

/** 注册原设备/ABI解析器和仅提供配置的动态入口，让Run and Debug显示内置名；native-codelldb.test.js验证唯一动态项、解析不重复及注册幂等。 */
export function registerNativeProviders(context: vscode.ExtensionContext, selectedPackage?: NativePackageResolver): NativeLldbConfigurationProvider {
  const existing = registrations.get(context); if (existing) return existing;
  initializeNativeUpstream(context);
  const lldb = new NativeLldbConfigurationProvider();
  const androidProvider = new NativeAndroidConfigurationProvider(selectedPackage);
  context.subscriptions.push(vscode.debug.registerDebugConfigurationProvider('android-tools', androidProvider),
    vscode.debug.registerDebugConfigurationProvider('android-tools', androidProvider, vscode.DebugConfigurationProviderTriggerKind.Dynamic), vscode.debug.registerDebugConfigurationProvider('lldb', lldb), lldb,
    vscode.debug.onDidTerminateDebugSession(session => { if (session.type === 'lldb') void lldb.release(session.configuration.androidLldbServerSocket).catch(reportCleanup); }),
    vscode.commands.registerCommand('android-tools.pickAndroidProcess', targetCommand.pickAndroidProcess),
    vscode.commands.registerCommand('android-tools.getBestAbi', targetCommand.getBestAbi),
    vscode.commands.registerCommand('android-tools.getBestMappedAbi', targetCommand.getBestMappedAbi),
    vscode.commands.registerCommand('android-tools.resumeWaitingProcess', targetCommand.resumeWaitingProcess));
  registrations.set(context, lldb);
  return lldb;
}