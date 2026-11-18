import * as fs from 'node:fs';
import { runtimeExecutable } from './runtimeExecutable';
import { adbRuntimeCandidates, sdkCandidates as runtimeSdkCandidates, sdkToolPath, executable } from '../runtimeContext';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import * as vscode from 'vscode';
import { readProjectLocalConfig } from '../projectLocalConfig';

/** 自动解析扩展、Android SDK 和 PATH 中的调试工具，不要求用户填写工具路径。 */
export interface AndroidToolchain {
  adb: string;
  source: 'configuration' | 'extension' | 'sdk' | 'path';
  platform: string;
}



/** 返回与 VSIX 清单一致的宿主根目录候选，并保留旧 platform-tools 布局；android-toolchain bundled layout 回归断言扩展/存储优先级。 */
function extensionToolCandidates(context?: vscode.ExtensionContext): Array<{ candidate: string; root: string }> {
  if (!context) return [];
  return [context.extensionPath, context.globalStorageUri.fsPath].flatMap(adbRuntimeCandidates);
}

/** 返回 Android SDK 中的 adb 候选路径；回归由 tests/android-toolchain.test.js 验证 SDK 解析。 */
function sdkCandidates(projectRoot?: string): string[] {
  const configured = readProjectLocalConfig(projectRoot).sdkPath;
  return runtimeSdkCandidates(configured).map(root => sdkToolPath(root, 'adb'));
}

/** 查找可执行文件是否存在且为普通文件；回归由 tests/android-toolchain.test.js 覆盖存在和缺失分支。 */
/** 输入候选路径，输出 regular file existence; SDK/config/PATH remain unmodified and use legacy validation. */
function existing(candidates: string[]): string | undefined { return candidates.find(candidate => fs.existsSync(candidate) && fs.statSync(candidate).isFile()); }

/**
 * 解析 adb 并返回来源和平台信息；缺少时抛出带搜索范围的诊断。
 * 前置条件：工作区可读取，扩展已激活；结果不会静默回退到未验证路径。
 * 功能点与回归：Node>=22 执行 node --test tests/android-toolchain.test.js，断言项目本地 debugger.adbPath 覆盖及非法路径拒绝，空值自动解析；configuration-prefix 回归断言路径不注册为VSCode设置。
 */
export async function resolveAndroidToolchain(context?: vscode.ExtensionContext, projectRoot?: string): Promise<AndroidToolchain> {
  const configured = readProjectLocalConfig(projectRoot).debugger?.adbPath;
  if (configured) {
    if (!path.isAbsolute(configured) || !existing([configured])) throw new Error('Invalid project-local debugger.adbPath: ' + configured);
    return { adb: configured, source: 'configuration', platform: process.platform + '-' + process.arch };
  }
  for (const { candidate, root } of extensionToolCandidates(context)) {
    const extension = runtimeExecutable(candidate, root);
    if (extension) return { adb: extension, source: 'extension', platform: process.platform + '-' + process.arch };
  }
  const sdk = existing(sdkCandidates(projectRoot));
  if (sdk) return { adb: sdk, source: 'sdk', platform: process.platform + '-' + process.arch };
  const pathAdb = await new Promise<string | undefined>(resolve => {
    execFile(process.platform === 'win32' ? 'where.exe' : 'which', [executable('adb')], { windowsHide: true }, (error, stdout) => resolve(error ? undefined : stdout.split(/\r?\n/)[0].trim() || undefined));
  });
  if (pathAdb) return { adb: pathAdb, source: 'path', platform: process.platform + '-' + process.arch };
  throw new Error('Android platform tools are unavailable. Searched extension tools, Android SDK (ANDROID_HOME/ANDROID_SDK_ROOT), and PATH on ' + process.platform + '-' + process.arch);
}
