import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { discoverProjectLibraries } from './projectLibraries';

/** 项目身份与ABI限定自动符号发现；不使用跨项目或全局符号记录。 */
interface NativeSymbolOptions {
  projectRoot?: string;
  packageName?: string;
  abi?: string;
  storage: vscode.Memento;
  token?: vscode.CancellationToken;
}

/** 每次按项目编译记录与ELF信息发现库，清除旧白名单；同名自动取mtime最新产物，同时间按路径排序稳定选择。
 * native-symbol-selection.test.js验证唯一全集、同名最新、时间相同、取消与旧记录隔离；native-codelldb.test.js验证精确LLDB命令。 */
export async function selectNativeLibraries(_searchPaths: readonly string[], options: NativeSymbolOptions): Promise<string[] | undefined> {
  if (options.token?.isCancellationRequested) return undefined;
  if (!options.projectRoot) return [];
  const root = path.resolve(options.projectRoot);
  const key = 'androidNative.symbols:' + JSON.stringify([root, options.packageName ?? '', options.abi ?? '']);
  if (options.storage.get(key) !== undefined) await options.storage.update(key, undefined);
  let files: string[];
  try { files = await discoverProjectLibraries(root, options.abi, options.token); }
  catch (error) { if (error instanceof Error && error.cause === options.token && options.token?.isCancellationRequested) return undefined; throw error; }
  if (options.token?.isCancellationRequested) return undefined;
  const groups = new Map<string, string[]>();
  for (const filename of new Set(files)) {
    const name = path.basename(filename);
    const candidates = groups.get(name) ?? [];
    candidates.push(filename);
    groups.set(name, candidates);
  }
  const selected: string[] = [];
  for (const candidates of groups.values()) {
    if (options.token?.isCancellationRequested) return undefined;
    if (candidates.length === 1) { selected.push(candidates[0]); continue; }
    const builds = await Promise.all(candidates.map(async filename => ({ filename, modified: (await fs.promises.stat(filename)).mtimeMs })));
    builds.sort((a, b) => b.modified - a.modified || (a.filename < b.filename ? -1 : a.filename > b.filename ? 1 : 0));
    if (options.token?.isCancellationRequested) return undefined;
    selected.push(builds[0].filename);
  }
  nativeLibraryCommands(selected);
  if (options.token?.isCancellationRequested) return undefined;
  return selected;
}

/** 仅将已核验项目产物生成精确LLDB模块命令；native-symbol-selection.test.js验证路径转义及控制字符拒绝。 */
export function nativeLibraryCommands(files: readonly string[]): string[] {
  return files.map(filename => {
    if (/[\r\n\0]/.test(filename)) throw new Error('Invalid Native library path: control characters are not allowed');
    return 'target modules add -- "' + filename.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
  });
}
