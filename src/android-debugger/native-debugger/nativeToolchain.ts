import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { adbPath, sdkRoot } from '../../sdk';
import { readProjectLocalConfig } from '../../projectLocalConfig';
import { getRuntimeContext } from '../../runtimeContext';

export type AndroidAbi = 'armeabi' | 'armeabi-v7a' | 'arm64-v8a' | 'x86' | 'x86_64';
/** Native 使用与主工具共享的 ADB/SDK 路径，以及已安装 NDK；不包含自研调试后端。 */
export interface NativeToolchain { adb: string; sdkRoot: string; ndkRoot: string; }

/** 只把缺失目录视为候选不可用，权限和其他 IO 错误传播；native-toolchain.test.js 验证缺失与 EACCES。 */
function directory(candidate: string): boolean {
  try { return fs.statSync(candidate).isDirectory(); }
  catch (error) { if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code || '')) return false; throw error; }
}

/** 检查 NDK 的原上游 LLVM 标记；native-toolchain.test.js 验证显式坏路径不能伪成功。 */
function validNdk(candidate: string): boolean { return directory(candidate) && directory(path.join(candidate, 'toolchains', 'llvm')); }

/** 解析本机 JSON、原 android-debug 设置和共享 runtime；显式坏路径报错，PATH ADB 保留主工具契约。
 * 回归：Node>=22，node --test tests/native-toolchain.test.js；断言优先级、无 SDK 的显式 NDK、原设置和 PATH。
 */
export function resolveNativeToolchain(projectRoot?: string): NativeToolchain {
  const local = readProjectLocalConfig(projectRoot);
  const config = vscode.workspace.getConfiguration('android-debug', projectRoot ? vscode.Uri.file(projectRoot) : undefined);
  const runtime = getRuntimeContext()?.dependencies;
  const sdk = local.sdkPath || config.get<string>('sdkRoot') || sdkRoot(projectRoot);
  if (sdk && !directory(sdk)) throw new Error('Invalid Android SDK root: ' + sdk);
  const explicitNdk = local.debugger?.ndkPath || config.get<string>('ndkRoot');
  const ndk = explicitNdk || runtime?.ndkRoot || process.env.ANDROID_NDK_ROOT || findNdk(sdk);
  if (!ndk || !validNdk(ndk)) throw new Error('Cannot determine valid Android NDK root' + (ndk ? ': ' + ndk : ''));
  const selectedSdkAdb = sdk ? path.join(sdk, 'platform-tools', process.platform === 'win32' ? 'adb.exe' : 'adb') : undefined;
  const adb = local.debugger?.adbPath || runtime?.adb || (selectedSdkAdb && fs.existsSync(selectedSdkAdb) ? selectedSdkAdb : adbPath());
  if (!adb) throw new Error('Cannot determine Android ADB');
  // 主 sdk.ts 可返回 PATH 命令；显式/绝对路径仍须是普通文件，不能将不存在文件伪装成 PATH 回退。
  if ((path.isAbsolute(adb) || adb.includes('/') || adb.includes('\\')) && !fs.statSync(adb).isFile()) throw new Error('Invalid Android ADB: ' + adb);
  return { adb, sdkRoot: sdk, ndkRoot: path.resolve(ndk) };
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
