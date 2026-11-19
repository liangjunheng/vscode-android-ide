import * as fs from 'node:fs';
import * as path from 'node:path';
import { adbPath, sdkRoot } from '../../sdk';
import { readProjectLocalConfig } from '../../projectLocalConfig';
import { getRuntimeContext } from '../../runtimeContext';

export type AndroidAbi = 'armeabi' | 'armeabi-v7a' | 'arm64-v8a' | 'x86' | 'x86_64';
export const androidAbis: readonly AndroidAbi[] = ['armeabi', 'armeabi-v7a', 'arm64-v8a', 'x86', 'x86_64'];
/** launch.json native 字段允许覆盖共享工具链；覆盖值只用于本次 Native 会话。 */
export interface NativeToolchainOverrides { sdkRoot?: string; ndkRoot?: string; }
/** Native 使用与主工具共享的 ADB/SDK 路径，以及已安装 NDK；不包含自研调试后端。 */
export interface NativeToolchain { adb: string; sdkRoot: string; ndkRoot: string; }

/** 只把缺失目录视为候选不可用，权限和其他 IO 错误传播；native-toolchain.test.js 验证缺失与 EACCES。 */
function directory(candidate: string): boolean {
  try { return fs.statSync(candidate).isDirectory(); }
  catch (error) { if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code || '')) return false; throw error; }
}

/** 检查 NDK 的原上游 LLVM 标记；native-toolchain.test.js 验证显式坏路径不能伪成功。 */
function validNdk(candidate: string): boolean { return directory(candidate) && directory(path.join(candidate, 'toolchains', 'llvm')); }

/** 解析 launch.json 覆盖、项目本地配置、Android local.properties 与共享 runtime；显式坏路径报错。
 * 回归：Node>=22，node --test tests/native-toolchain.test.js；断言 launch 覆盖、项目配置、local.properties、无 SDK 的显式 NDK 和 PATH。
 */
export function resolveNativeToolchain(projectRoot?: string, overrides?: NativeToolchainOverrides): NativeToolchain {
  const local = readProjectLocalConfig(projectRoot);
  const gradle = readGradleLocalProperties(projectRoot);
  const runtime = getRuntimeContext()?.dependencies;
  const sdk = overrides?.sdkRoot ?? (local.sdkPath || gradle.sdkRoot || sdkRoot(projectRoot));
  if (sdk && !directory(sdk)) throw new Error('Invalid Android SDK root: ' + sdk);
  const explicitNdk = overrides?.ndkRoot ?? (local.debugger?.ndkPath || gradle.ndkRoot);
  const ndk = explicitNdk || runtime?.ndkRoot || process.env.ANDROID_NDK_ROOT || findNdk(sdk);
  if (!ndk || !validNdk(ndk)) throw new Error('Cannot determine valid Android NDK root' + (ndk ? ': ' + ndk : ''));
  const selectedSdkAdb = sdk ? path.join(sdk, 'platform-tools', process.platform === 'win32' ? 'adb.exe' : 'adb') : undefined;
  const adb = local.debugger?.adbPath || runtime?.adb || (selectedSdkAdb && fs.existsSync(selectedSdkAdb) ? selectedSdkAdb : adbPath());
  if (!adb) throw new Error('Cannot determine Android ADB');
  // 主 sdk.ts 可返回 PATH 命令；显式/绝对路径仍须是普通文件，不能将不存在文件伪装成 PATH 回退。
  if ((path.isAbsolute(adb) || adb.includes('/') || adb.includes('\\')) && !fs.statSync(adb).isFile()) throw new Error('Invalid Android ADB: ' + adb);
  return { adb, sdkRoot: sdk, ndkRoot: path.resolve(ndk) };
}

/** 读取标准 Android local.properties，返回 sdk.dir/ndk.dir；缺失或格式无关项不影响其他工具链来源。
 * 回归：Node>=22 执行 node --test tests/native-toolchain.test.js，断言相对路径解析和 SDK/NDK 选择。 */
function readGradleLocalProperties(projectRoot?: string): { sdkRoot?: string; ndkRoot?: string } {
  if (!projectRoot) return {};
  const filename = path.join(projectRoot, 'local.properties');
  let content: string;
  try { content = fs.readFileSync(filename, 'utf8'); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
  const values: Record<string, string> = {};
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('!')) continue;
    const match = /^([^:=\s]+)\s*[:=]\s*(.*)$/.exec(line);
    if (match) values[match[1]] = match[2].replace(/\\([\\: =])/g, '$1');
  }
  const resolve = (value: string | undefined): string | undefined => value?.trim() ? path.resolve(projectRoot, value.trim()) : undefined;
  return { sdkRoot: resolve(values['sdk.dir']), ndkRoot: resolve(values['ndk.dir']) };
}

/** 复用上游 SDK ndk、ndk-bundle 及逆字典序版本发现，不下载 NDK；native-toolchain.test.js 覆盖两个布局和缺失。 */
function findNdk(sdk: string): string | undefined {
  if (!sdk) return undefined;
  for (const root of [path.join(sdk, 'ndk'), path.join(sdk, 'ndk-bundle')]) {
    if (validNdk(root)) return root;
    if (!directory(root)) continue;
    for (const name of fs.readdirSync(root).sort().reverse()) {
      const candidate = path.join(root, name);
      if (validNdk(candidate)) return candidate;
    }
  }
  return undefined;
}

/** 自动发现本地 Native 调试符号目录；优先 launch/native 本地配置，再扫描 Gradle/NDK 常见输出目录，返回目录而非具体 .so 文件。
 * 回归：Node>=22 执行 node --test tests/native-toolchain.test.js，断言 .cxx/Gradle 输出目录自动发现和显式路径优先。 */
export function findNativeSymbolSearchPaths(projectRoot?: string, native?: unknown): string[] {
  const values = native && typeof native === 'object' && !Array.isArray(native) ? native as Record<string, unknown> : {};
  const configured = Array.isArray(values.symbolSearchPaths) ? values.symbolSearchPaths.filter((value): value is string => typeof value === 'string' && value.trim().length > 0).map(value => path.resolve(value)) : [];
  if (configured.length) return [...new Set(configured)];
  const local = readProjectLocalConfig(projectRoot);
  const localPaths = local.debugger?.symbolSearchPaths ?? [];
  if (localPaths.length) return [...new Set(localPaths)];
  if (!projectRoot) return [];
  const roots = [projectRoot, path.join(projectRoot, 'app'), path.join(projectRoot, '.cxx'), path.join(projectRoot, 'build', 'intermediates', 'cxx'), path.join(projectRoot, 'build', 'intermediates', 'ndkBuild')];
  const result = new Set<string>();
  const visit = (directoryPath: string, depth: number): void => {
    if (depth > 7 || !directory(directoryPath)) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(directoryPath, { withFileTypes: true }); } catch (error) { if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code || '')) return; throw error; }
    let hasSo = false;
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith('.so')) hasSo = true;
      else if (entry.isDirectory() && entry.name !== 'node_modules') visit(path.join(directoryPath, entry.name), depth + 1);
    }
    if (hasSo && (directoryPath.includes('.cxx') || directoryPath.includes('intermediates') || /(?:obj|lib)$/i.test(directoryPath))) result.add(directoryPath);
  };
  for (const root of roots) visit(root, 0);
  return [...result].sort();
}

/** 解析 launch.json 的 native 工具链覆盖，拒绝空路径和错误类型。 */
export function nativeToolchainOverrides(native: unknown): NativeToolchainOverrides {
  if (native === undefined) return {};
  if (!native || typeof native !== 'object' || Array.isArray(native)) throw new Error('Invalid Native configuration: native must be an object');
  const values = native as Record<string, unknown>;
  const result: NativeToolchainOverrides = {};
  for (const key of ['sdkRoot', 'ndkRoot'] as const) {
    if (values[key] !== undefined) {
      if (typeof values[key] !== 'string' || !values[key].trim()) throw new Error('Invalid Native ' + key + ': expected a non-empty path');
      result[key] = values[key];
    }
  }
  return result;
}

/** 校验 launch.json 的 Native ABI 设置，防止非法值进入设备查询和 LLDB。 */
export function validateNativeAbis(native: unknown, androidAbiSupported?: unknown): void {
  const values = native && typeof native === 'object' && !Array.isArray(native) ? native as Record<string, unknown> : {};
  const supported = values.abiSupported ?? androidAbiSupported;
  if (supported !== undefined && (!Array.isArray(supported) || supported.length === 0 || supported.some(value => typeof value !== 'string' || !androidAbis.includes(value as AndroidAbi)))) throw new Error('Invalid Native abiSupported: expected a non-empty list of Android ABIs');
  const selected = values.abi;
  if (selected !== undefined && (typeof selected !== 'string' || (selected !== 'select' && !androidAbis.includes(selected as AndroidAbi)))) throw new Error('Invalid Native ABI: ' + String(selected));
}

/** 使用上游 Android ABI 到 LLVM 目录映射；native-toolchain.test.js 断言全部 ABI 和未知 ABI 拒绝。 */
export function lldbServerArch(abi: string): string {
  if (abi === 'armeabi' || abi === 'armeabi-v7a') return 'arm';
  if (abi === 'arm64-v8a') return 'aarch64';
  if (abi === 'x86') return 'i386';
  if (abi === 'x86_64') return 'x86_64';
  throw new Error('Unsupported Android ABI: ' + abi);
}

/** 复用上游 host 标签和三个 clang 路径的查找顺序，返回已有 server；native-toolchain.test.js 覆盖宿主/布局/失败。
 * 输入已验证 NDK 根、ABI和宿主平台；只跳过缺失文件，其余读取错误传播，不沿用其他 ABI。
 */
export function findLldbServer(ndkRoot: string, abi: string, platform = process.platform): string {
  const host = platform === 'win32' ? 'windows-x86_64' : platform === 'darwin' ? 'darwin-x86_64' : 'linux-x86_64';
  const llvm = path.join(ndkRoot, 'toolchains', 'llvm', 'prebuilt', host);
  const version = fs.readFileSync(path.join(llvm, 'AndroidVersion.txt'), 'utf8').split('\n')[0].trim();
  const arch = lldbServerArch(abi);
  for (const base of ['lib64/clang/' + version, 'lib/clang/' + version, 'lib/clang/' + version.split('.')[0]]) {
    const candidate = path.join(llvm, base, 'lib', 'linux', arch, 'lldb-server');
    try { if (fs.statSync(candidate).isFile()) return candidate; }
    catch (error) { if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code || '')) throw error; }
  }
  throw new Error('Could not locate lldb-server for the device');
}
