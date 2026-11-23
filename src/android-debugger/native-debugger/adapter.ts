import * as path from 'node:path';
import * as vscode from 'vscode';
import type { DebugDevice } from '../device';
import * as android from './upstream/src/android';
import type { NativeConnection } from './contracts';
import { nativeToolchainOverrides, resolveNativeToolchain, validateNativeAbis } from './nativeToolchain';
import { nativeLibraryCommands, selectNativeLibraries } from './nativeSymbols';
import { NativeForwardLease } from './forwardLease';

/** 当前项目的只读包名与 ABI 来源；未知返回 undefined，读取错误直接传播。 */
export type NativePackageResolver = (folder?: vscode.WorkspaceFolder) => string | { packageName?: string; abiSupported?: string[] } | undefined;

/** 功能：解析最终路径；输入路径及明确基目录；输出绝对路径，拒绝控制字符、变量和隐式工作目录。 */
function absolutePath(value: unknown, base?: string): string {
  if (typeof value !== 'string' || !value.trim() || /[\x00-\x1f\x7f]/.test(value) || value.includes('${')) throw new Error('Invalid or unresolved Native path');
  if (path.isAbsolute(value)) return path.normalize(value);
  if (!base || !path.isAbsolute(base)) throw new Error('Relative Native path requires an absolute project root');
  // Windows 盘符相对路径与根相对路径不能借项目根解释。
  if (path.win32.parse(value).root) throw new Error('Invalid Native relative path');
  return path.resolve(base, value);
}

/** 功能：检查引擎字符串列表；输入配置值与字段名；输出结构错误，不改变用户命令语义。 */
function stringArray(value: unknown, name: string): asserts value is string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || /[\0\r\n]/.test(item))) throw new Error('Invalid Native ' + name + ': expected a string array without command separators');
}

/** 功能：桥接取消通知；输入当前连接信号；输出只供符号发现使用的宿主令牌，不进入引擎配置。 */
function cancellationToken(signal: AbortSignal): vscode.CancellationToken {
  return {
    get isCancellationRequested() { return signal.aborted; },
    // 订阅者显式释放监听，连接本身不留下额外取消资源。
    onCancellationRequested(listener, thisArgs, disposables) {
      const notify = (): void => { listener.call(thisArgs, undefined); };
      signal.addEventListener('abort', notify, { once: true });
      const subscription = { dispose: () => signal.removeEventListener('abort', notify) };
      disposables?.push(subscription);
      return subscription;
    },
  };
}

/** 功能：提供本次符号选择的临时存储；输入无持久化存储的连接；输出独立 Memento，不共享项目或连接资源。 */
function symbolStorage(): vscode.Memento {
  const values = new Map<string, unknown>();
  return {
    // 读取本次符号记录，缺失遵循 Memento 的默认值契约。
    get: <T>(key: string, defaultValue?: T): T | undefined => values.has(key) ? values.get(key) as T : defaultValue,
    // 仅更新本次连接的符号记录，不伪造工作区持久化。
    update: async (key, value) => { if (value === undefined) values.delete(key); else values.set(key, value); },
    // 返回本次存储键，不持有 server 或转发。
    keys: () => [...values.keys()],
  };
}

/** 功能：规范化用户 PID；输入数字或十进制数字字符串；输出正安全整数，拒绝隐式类型转换。 */
function processId(value: unknown): number {
  const result = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (typeof result !== 'number' || !Number.isSafeInteger(result) || result <= 0) throw new Error('Invalid Native PID: expected a positive safe integer');
  return result;
}

/** 功能点：为确定的 Android 进程准备独立 Native 连接。
 * 受影响对象：prepareNativeConnection、工具链、ABI、项目符号、LLDB 命令、server 与转发租约。
 * 复现路径：主会话完成 Debug/Attach 身份解析后传入 PID、DebugDevice、最终配置及取消信号；Java 不调用此入口。
 * 测试范围：身份与路径边界、SDK/NDK、ABI 交集、真实库命令、用户引擎选项、迟到取消、失败聚合及幂等关闭。
 * 执行入口：node --test tests/native-codelldb.test.js。
 * 预期结果：返回可交给 CodeLLDB 的 attach 配置，关闭与回滚只回收本次 server 和转发，不管理应用或 JVM。
 * 判据：目标不可被用户选项覆盖；无私有字段及 signal 泄露；资源只关闭一次且全部错误可见。
 * 功能：顺序准备连接；输入已解析目标与可选 workspaceState；输出真实 LLDB 配置及显式 close，失败统一回滚。 */
export async function prepareNativeConnection(input: vscode.DebugConfiguration, pid: number, device: DebugDevice, signal: AbortSignal, folder?: vscode.WorkspaceFolder, storage?: vscode.Memento): Promise<NativeConnection> {
  signal.throwIfAborted();
  if (input.type === 'android-jvm' || input.mode === 'java') throw new Error('Java configuration must not prepare a Native connection');
  if (typeof pid !== 'number' || processId(pid) !== pid) throw new Error('Native connection requires a positive integer PID');
  // 先验证原始结构，所有用户 PID 别名均须与已解析目标一致。
  nativeToolchainOverrides(input.native);
  const native = { ...input.native };
  for (const source of [input, native]) for (const key of ['pid', 'processId']) {
    if (source[key] !== undefined && processId(source[key]) !== pid) throw new Error('Invalid or conflicting Native PID');
  }
  const serial = device.serial;
  if (typeof serial !== 'string' || !/^[\w.:-]+$/.test(serial) || ['auto', 'select', 'last-selected'].includes(serial)) throw new Error('Invalid Native device serial');
  if (input.serial !== undefined && input.serial !== serial) throw new Error('Conflicting Native device serial');
  const packageName = input.packageName;
  if (typeof packageName !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+$/.test(packageName)) throw new Error('A valid package name is required');
  const base = folder ? absolutePath(folder.uri.fsPath) : undefined;
  const androidRoot = device.projectRoot === undefined
    ? input.androidProjectRoot === undefined ? base : absolutePath(input.androidProjectRoot, base)
    : absolutePath(device.projectRoot, base);
  for (const source of [input, native]) {
    if (source.androidProjectRoot !== undefined && absolutePath(source.androidProjectRoot, base ?? androidRoot) !== androidRoot) throw new Error('Conflicting Native Android project root');
  }
  // Android 根用于设备和工具链；显式 Native 根用于源码、符号与相对路径，不要求与 Java 根相同。
  const explicitRoot = native.projectRoot ?? input.projectRoot;
  const projectRoot = explicitRoot === undefined ? androidRoot : absolutePath(explicitRoot, base ?? androidRoot);
  const options = { ...input, ...native };
  for (const key of ['initCommands', 'exitCommands', 'postRunCommands', 'sourcePaths', 'symbolSearchPaths']) {
    for (const source of [input, native]) if (source[key] !== undefined) stringArray(source[key], key);
    if (options[key] !== undefined) options[key] = [...options[key]];
  }
  for (const key of ['sourcePaths', 'symbolSearchPaths']) {
    if (options[key] !== undefined) options[key] = options[key].map((value: string) => absolutePath(value, projectRoot));
  }
  if (options.sourceMap !== undefined) {
    if (!options.sourceMap || typeof options.sourceMap !== 'object' || Array.isArray(options.sourceMap)) throw new Error('Invalid Native sourceMap');
    options.sourceMap = Object.fromEntries(Object.entries(options.sourceMap).map(([from, to]) => [absolutePath(from, projectRoot), absolutePath(to, projectRoot)]));
  }
  const stopOnEntry = options.stopOnEntry ?? false;
  if (typeof stopOnEntry !== 'boolean') throw new Error('Native stopOnEntry must be a boolean');
  const overrides = nativeToolchainOverrides(native);
  for (const key of ['sdkRoot', 'ndkRoot'] as const) if (overrides[key] !== undefined) overrides[key] = absolutePath(overrides[key], projectRoot);
  validateNativeAbis(native);
  const toolchain = resolveNativeToolchain(androidRoot, overrides);
  const supported = await device.abis(packageName, signal);
  signal.throwIfAborted();
  validateNativeAbis({ abiSupported: supported });
  const candidates = supported.filter((abi: string) => !native.abiSupported || native.abiSupported.includes(abi));
  const abi = native.abi === undefined || native.abi === 'select' ? candidates[0] : native.abi;
  if (!abi || !candidates.includes(abi)) throw new Error('Cannot find appropriate ABI to use');
  const selected = await android.getDeviceFromUDID(serial, androidRoot, toolchain);
  if (selected.state !== 'device') throw new Error('Android device is not online: ' + serial);
  const target = { ...selected, udid: serial, androidProjectRoot: androidRoot, androidNativeToolchain: toolchain };
  let server: Awaited<ReturnType<typeof android.startLldbServer>> | undefined;
  let forwarding: NativeForwardLease | undefined;
  let closing: Promise<void> | undefined;
  /** 功能：一次结算两项明确资源；输入无；输出共享关闭Promise，保留每项清理失败。 */
  const close = (): Promise<void> => closing ??= Promise.resolve().then(async () => {
    const results = await Promise.allSettled([Promise.resolve().then(() => server?.stop()), Promise.resolve().then(() => forwarding?.close())]);
    const errors = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected').map(result => result.reason);
    if (errors.length) throw new AggregateError(errors, 'Native server and forward cleanup failed');
  });
  const symbols = selectNativeLibraries(options.symbolSearchPaths ?? [], { projectRoot, packageName, abi, storage: storage ?? symbolStorage(), token: cancellationToken(signal) });
  const deployment = android.startLldbServer(target, packageName, abi);
  const forwardingPreparation = android.getDeviceAdb(target).then(adb => NativeForwardLease.create(serial, adb));
  try {
    const [symbolResult, deploymentResult, forwardingResult] = await Promise.allSettled([symbols, deployment, forwardingPreparation]);
    if (deploymentResult.status === 'fulfilled') server = deploymentResult.value;
    if (forwardingResult.status === 'fulfilled') forwarding = forwardingResult.value;
    const failures = [symbolResult, deploymentResult, forwardingResult].filter((result): result is PromiseRejectedResult => result.status === 'rejected').map(result => result.reason);
    if (failures.length) throw failures.length === 1 ? failures[0] : new AggregateError(failures, 'Native preparation failed');
    signal.throwIfAborted();
    const libraries = symbolResult.status === 'fulfilled' ? symbolResult.value : undefined;
    if (!libraries || !server) throw new Error('Native preparation did not produce required resources');
    if (typeof server.socket !== 'string' || !/^\/?[\w./-]+$/.test(server.socket)) throw new Error('Invalid Native server socket');
    const libraryCommands = nativeLibraryCommands(libraries);
    if (!libraries.length) void vscode.window.showWarningMessage('未找到当前项目和 ABI 的 Native 调试库，不会加载项目符号；尚未确认调试器连接成功。');
    signal.throwIfAborted();
    if (!forwarding) throw new Error('Native forwarding preparation did not produce a lease');
    const config: vscode.DebugConfiguration = {
      ...options, type: 'lldb', request: 'attach', pid, processId: pid, serial, packageName, androidPackageName: packageName,
      projectRoot, androidProjectRoot: androidRoot, androidAbi: abi, androidLldbServerSocket: server.socket,
      platform: 'remote-android', stopOnEntry,
      initCommands: [forwarding.command, 'platform select remote-android', `platform connect unix-abstract-connect://[${serial}]${server.socket}`,
        'settings set plugin.jit-loader.gdb.enable off', ...(options.initCommands ?? [])],
      preRunCommands: ['process handle SIGBUS SIGSEGV --pass true --stop false --notify false',
        'breakpoint set --shlib libart.so --name art_sigsegv_fault', 'breakpoint set --shlib libart.so --name art_sigbus_fault', ...(options.preRunCommands ?? [])],
      postRunCommands: [...libraryCommands, ...(options.postRunCommands ?? [])],
      exitCommands: [...(options.exitCommands ?? []), 'platform disconnect', 'log disable lldb platform'],
    };
    for (const key of ['signal', 'native', 'java', 'android', 'mode', 'androidMode', 'target', 'androidTarget', 'apkPath', 'launchActivity', 'resumeProcess',
      'androidNativeToolchain', 'androidNativeLibraries', 'androidAbiSupported', 'androidAbiMap', 'androidSourceRoots', 'androidJdwpPort', 'androidLaunchPrepared',
      'abi', 'abiSupported', 'abiMap', 'sdkRoot', 'ndkRoot', 'hostName', 'port', 'adapterJvmArgs', 'classPaths', 'modulePaths', 'projectName', 'stepFilters']) delete config[key];
    return { config, close };
  } catch (error) {
    try { await close(); } catch (cleanup) { throw new AggregateError([error, cleanup], 'Native connection preparation and rollback failed'); }
    throw error;
  }
}
