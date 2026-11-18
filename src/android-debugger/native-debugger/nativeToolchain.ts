import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import type * as vscode from 'vscode';
import { getRuntimeContext, resolveBundledPath, resolveBundledLldbServer, runtimeHostRoot } from '../../runtimeContext';

/** 输入 SDK 根、实际目标 ABI、扩展上下文及调用方提供的项目本地覆盖值；不读取 VS Code 设置。 */
export interface NativeToolchainOptions {
  context?: vscode.ExtensionContext;
  sdkRoot: string;
  abi: string;
  overrides?: { lldbDapPath?: string; ndkPath?: string };
}

/** 输出已验证的官方 stdio lldb-dap、目标 lldb-server 及所选 NDK 根绝对路径。 */
export interface NativeToolchain { lldbDap: string; server: string; ndkRoot?: string; }

/**
 * 共享回归映射：Node >=22 执行 node --test tests/android-native-toolchain.test.js。
 * 每个函数均由隔离 fs/host/env/execFile fixture 经公开入口验证，不触碰用户 SDK。
 * 成功判据：精确路径、numeric 排序、ABI、优先级和 argv 断言通过；异常路径保留原始 IO 错误。
 */

/** 输入文件系统错误，输出是否仅为路径缺失；权限与其他 IO 错误必须传播。共享回归覆盖缺失与 EACCES/EIO。 */
function missing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/** 输入候选绝对路径，输出 stat 或缺失；相对/控制字符路径不允许隐式解析至 cwd。共享回归覆盖非法路径。 */
function stat(candidate: string): fs.Stats | undefined {
  if (typeof candidate !== 'string' || !path.isAbsolute(candidate) || /[\x00-\x1f\x7f]/.test(candidate)) throw new Error('Invalid absolute tool path: ' + candidate);
  try { return fs.statSync(candidate); } catch (error) { if (missing(error)) return undefined; throw error; }
}

/** 输入宿主工具候选，输出普通且可执行的文件或缺失；POSIX 检查 X_OK，权限错误不静默忽略。共享回归覆盖文件/目录/权限。 */
/** 输入外部/配置候选，输出现有 executable；只检查，不修改 SDK/PATH/device server 文件。 */
function executable(candidate: string): string | undefined {
  if (!stat(candidate)?.isFile()) return undefined;
  fs.accessSync(candidate, process.platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK);
  return candidate;
}

/** 输入 numeric 点分版本，输出整数段；拒绝预览名和非 numeric 名。共享回归覆盖 9/10/17/21 与非法段。 */
function revision(value: string): number[] | undefined {
  if (!/^\d+(?:\.\d+)*$/.test(value)) return undefined;
  const result = value.split('.').map(Number);
  return result.every(Number.isSafeInteger) ? result : undefined;
}

/** 输入两组 numeric 版本，输出降序比较结果；缺少尾段等于零。共享回归验证 source.properties 而非文件夹排序。 */
function descending(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const difference = (b[i] || 0) - (a[i] || 0);
    if (difference) return difference;
  }
  return 0;
}

/** 输入目录绝对路径，输出子项或缺失时空数组；非缺失 IO 错误传播。共享回归覆盖可选 SDK 缺失和读取错误。 */
function entries(directory: string): string[] {
  stat(directory);
  try { return fs.readdirSync(directory); } catch (error) { if (missing(error)) return []; throw error; }
}

/** 输入 NDK 根，输出 source.properties 的 numeric Pkg.Revision；缺失或无效内容不算安装。共享回归覆盖真实版本元数据。 */
function ndkRevision(root: string): number[] | undefined {
  const properties = path.join(root, 'source.properties');
  if (!stat(properties)?.isFile()) return undefined;
  const text = fs.readFileSync(properties, 'utf8');
  const value = text.match(/^\s*Pkg\.Revision\s*=\s*([^\r\n]+)\s*$/m)?.[1].trim();
  return value ? revision(value) : undefined;
}

/** 输入自动搜索目录，输出 source.properties 版本最高的安装根；支持目录本身是 bundled NDK。共享回归覆盖 SDK/bundle 与 numeric 排序。 */
function installedNdk(roots: string[]): string | undefined {
  const installed: Array<{ root: string; version: number[] }> = [];
  for (const base of roots) {
    const direct = ndkRevision(base);
    if (direct) installed.push({ root: base, version: direct });
    else for (const name of entries(base)) {
      const root = path.join(base, name);
      const version = ndkRevision(root);
      if (version) installed.push({ root, version });
    }
  }
  installed.sort((a, b) => descending(a.version, b.version));
  return installed[0]?.root;
}

/** 输入选定 NDK、NDK host 和进程 triple，输出最高 numeric clang 的普通 server；缺失时明确失败，不降级其他 NDK。共享回归覆盖四 ABI/clang/缺失。 */
function serverPath(ndkRoot: string, ndkHost: string, triple: string, abi: string): string {
  const clang = path.join(ndkRoot, 'toolchains', 'llvm', 'prebuilt', ndkHost, 'lib', 'clang');
  const versions = entries(clang).map(name => ({ name, version: revision(name) })).filter(item => item.version !== undefined);
  versions.sort((a, b) => descending(a.version!, b.version!));
  for (const version of versions) {
    const candidate = path.join(clang, version.name, 'lib', 'linux', triple, 'lldb-server');
    if (stat(candidate)?.isFile()) return candidate;
  }
  throw new Error('lldb-server for target ABI ' + abi + ' is unavailable in NDK ' + ndkRoot);
}

/** 输入固定工具名，输出 PATH 中经过绝对路径/普通文件/执行权限核验的结果；无 shell，非查无结果错误传播。共享回归覆盖 where/which argv 和诊断。 */
function pathDap(name: string): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    execFile(process.platform === 'win32' ? 'where.exe' : 'which', [name], { windowsHide: true, shell: false }, (error, stdout) => {
      if (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as unknown as { code: number }).code === 1) resolve(undefined);
        else reject(error);
        return;
      }
      try {
        for (const line of stdout.split(/\r?\n/)) {
          const candidate = line.trim();
          if (!candidate || !path.isAbsolute(candidate)) continue;
          const found = executable(candidate);
          if (found) { resolve(found); return; }
        }
        resolve(undefined);
      } catch (failure) { reject(failure); }
    });
  });
}

/** 输入 host 阶段选项，输出官方 stdio lldb-dap 与可验证的可选 NDK 根；不要求 ABI、NDK 或 server 存在。 */
export interface NativeHostToolchainOptions {
  context?: vscode.ExtensionContext;
  sdkRoot: string;
  overrides?: { lldbDapPath?: string; ndkPath?: string };
}

/** 输入设备阶段选项，输出目标 ABI 对应的实际 lldb-server；优先使用打包共享 server。 */
export interface NativeServerOptions {
  context?: vscode.ExtensionContext;
  ndkRoot?: string;
  abi: string;
  sdkRoot?: string;
  overrides?: { lldbDapPath?: string; ndkPath?: string };
}

/** 输入 host 平台，输出工具 bundle host 与 NDK prebuilt host；不支持的平台立即诊断。 */
function platformHosts(): { bundle: string; ndk: string; name: string } {
  const supported = process.platform === 'darwin' ? ['x64', 'arm64'] : ['x64'];
  if (!['win32', 'linux', 'darwin'].includes(process.platform) || !supported.includes(process.arch)) {
    throw new Error('Unsupported native debugger host: ' + process.platform + '-' + process.arch);
  }
  return {
    bundle: process.platform + '-' + process.arch,
    ndk: ({ win32: 'windows-x86_64', linux: 'linux-x86_64', darwin: 'darwin-x86_64' } as Record<string, string>)[process.platform],
    name: process.platform === 'win32' ? 'lldb-dap.exe' : 'lldb-dap'
  };
}

/** 输入上下文，输出扩展与全局存储工具根；上下文缺失时输出空数组。 */
function toolRoots(context?: vscode.ExtensionContext): string[] {
  return context ? [context.extensionPath, context.globalStorageUri.fsPath].map(root => {
    stat(root);
    return runtimeHostRoot(root);
  }) : [];
}

/** 输入上下文和 ABI，输出打包共享 lldb-server；实际普通文件缺失时返回 undefined。 */
function packagedServer(context: vscode.ExtensionContext | undefined, abi: string): string | undefined {
  const runtime = getRuntimeContext();
  const activeServer = runtime && (!context || context.extensionPath === runtime.extensionRoot) ? runtime.dependencies.lldbServer(abi) : undefined;
  if (activeServer) return activeServer;
  if (!context) return undefined;
  for (const root of [context.extensionPath, context.globalStorageUri.fsPath]) {
    stat(root);
    const bundled = resolveBundledLldbServer(root, abi);
    if (bundled) return bundled;
  }
  return undefined;
}

/**
 * 输入绝对 SDK 根、扩展上下文和项目本地 override，输出 host lldb-dap 及可选 NDK 根。
 * 前置条件：仅 lldb-dap override 需是实际可执行文件；ndkPath 若提供需是含 numeric source.properties 的实际目录。
 * 回归：node --test tests/android-native-toolchain.test.js，host 阶段无 SDK/NDK 仍由 bundled lldb-dap 成功。
 */
export async function resolveNativeHostToolchain(options: NativeHostToolchainOptions): Promise<{ lldbDap: string; ndkRoot?: string }> {
  if (!options || typeof options !== 'object' || typeof options.sdkRoot !== 'string' || (options.sdkRoot !== '' && !path.isAbsolute(options.sdkRoot))) {
    throw new Error('Invalid absolute sdkRoot: ' + String(options?.sdkRoot));
  }
  const hosts = platformHosts();
  if (options.sdkRoot) stat(options.sdkRoot);
  const roots = toolRoots(options.context);
  const runtime = getRuntimeContext();
  if (runtime && options.context?.extensionPath === runtime.extensionRoot && runtime.dependencies.ndkRoot) roots.unshift(runtime.runtimeRoot);
  const configuredDap = options.overrides?.lldbDapPath;
  const configuredNdk = options.overrides?.ndkPath;
  let lldbDap: string | undefined;
  if (configuredDap !== undefined && configuredDap !== '') {
    lldbDap = executable(configuredDap);
    if (!lldbDap) throw new Error('Invalid lldbDapPath: ' + configuredDap);
  }
  let ndkRoot: string | undefined;
  if (configuredNdk !== undefined && configuredNdk !== '') {
    if (!stat(configuredNdk)?.isDirectory() || !ndkRevision(configuredNdk)) throw new Error('Invalid ndkPath: ' + configuredNdk);
    ndkRoot = configuredNdk;
  } else {
    const ndkRoots = options.sdkRoot ? [path.join(options.sdkRoot, 'ndk')] : [];
    ndkRoot = installedNdk([...ndkRoots, ...roots.map(root => path.join(root, 'ndk'))]);
  }
  if (!lldbDap) {
    const bundledDap = runtime && options.context?.extensionPath === runtime.extensionRoot ? runtime.dependencies.lldbDap : undefined;
    if (bundledDap) lldbDap = bundledDap;
    for (const root of options.context ? [options.context.extensionPath, options.context.globalStorageUri.fsPath] : []) {
      if (lldbDap) break;
      lldbDap = resolveBundledPath(root, ['lldb', 'bin', hosts.name]);
    }
    if (!lldbDap && ndkRoot) lldbDap = executable(path.join(ndkRoot, 'toolchains', 'llvm', 'prebuilt', hosts.ndk, 'bin', hosts.name));
    if (!lldbDap) lldbDap = await pathDap(hosts.name);
  }
  if (!lldbDap) throw new Error('Official stdio lldb-dap is unavailable for host ' + hosts.bundle + '; searched extension, global storage, matching NDK and PATH');
  return ndkRoot ? { lldbDap, ndkRoot } : { lldbDap };
}

/**
 * 输入实际设备 ABI、可选 NDK 根和项目本地 override，输出实际普通 lldb-server。
 * 显式 ndkPath 禁止共享或其他 NDK fallback；无显式覆盖时优先 extension/storage/runtime/<host>/lldb-server/<abi>，再回退 NDK。
 * 回归：node --test tests/android-native-toolchain.test.js，四 ABI 共享 server 与显式 NDK 错误均有断言。
 */
export async function resolveNativeServer(options: NativeServerOptions): Promise<string> {
  if (!options || typeof options !== 'object') throw new Error('Native server options are required');
  const triples: Record<string, string> = { 'arm64-v8a': 'aarch64', 'armeabi-v7a': 'arm', x86: 'i386', x86_64: 'x86_64' };
  if (!Object.hasOwn(triples, options.abi)) throw new Error('Unsupported target ABI: ' + String(options.abi));
  const hosts = platformHosts();
  const configuredNdk = options.overrides?.ndkPath;
  if (configuredNdk !== undefined && configuredNdk !== '') {
    if (!stat(configuredNdk)?.isDirectory() || !ndkRevision(configuredNdk)) throw new Error('Invalid ndkPath: ' + configuredNdk);
    return serverPath(configuredNdk, hosts.ndk, triples[options.abi], options.abi);
  }
  const packaged = packagedServer(options.context, options.abi);
  if (packaged) return packaged;
  let ndkRoot = options.ndkRoot;
  if (!ndkRoot && options.sdkRoot) {
    if (!path.isAbsolute(options.sdkRoot)) throw new Error('Invalid sdkRoot: ' + options.sdkRoot);
    ndkRoot = installedNdk([path.join(options.sdkRoot, 'ndk'), ...toolRoots(options.context).map(root => path.join(root, 'ndk'))]);
  }
  if (!ndkRoot) throw new Error('lldb-server for target ABI ' + options.abi + ' is unavailable: no packaged server or NDK');
  if (!stat(ndkRoot)?.isDirectory() || !ndkRevision(ndkRoot)) throw new Error('Invalid ndkRoot: ' + ndkRoot);
  return serverPath(ndkRoot, hosts.ndk, triples[options.abi], options.abi);
}

/**
 * 输入 host 与实际设备阶段选项，输出兼容的完整 native toolchain；host 不因未知设备 ABI 而启动。
 * 显式 ndkPath 贯穿 server 阶段并要求真实目标 server，自动阶段可使用打包 server。
 * 回归：node --test tests/android-native-toolchain.test.js，保留旧组合 API 的版本/ABI/覆盖断言。
 */
export async function resolveNativeToolchain(options: NativeToolchainOptions): Promise<NativeToolchain> {
  if (!options || typeof options !== 'object') throw new Error('Native toolchain options are required');
  if (!['arm64-v8a', 'armeabi-v7a', 'x86', 'x86_64'].includes(options.abi)) throw new Error('Unsupported target ABI: ' + String(options.abi));
  const host = await resolveNativeHostToolchain(options);
  const server = await resolveNativeServer({ context: options.context, sdkRoot: options.sdkRoot, ndkRoot: host.ndkRoot, abi: options.abi, overrides: options.overrides });
  return { ...host, server };
}
