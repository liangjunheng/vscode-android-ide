import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';

/** 仅工作区状态中的项目级记录；同时保存精确文件与用户手选目录，供 native-symbol-selection.test.js 验证任一来源失效即清除。 */
interface NativeSymbolRecord { files: string[]; directories: string[]; }
/** 父会话已解析的项目/包名/ABI与当前 workspaceState；不接收 globalState，native-codelldb.test.js 验证多根项目隔离。 */
interface NativeSymbolOptions {
  projectRoot?: string;
  packageName?: string;
  abi?: string;
  storage: vscode.Memento;
  token?: vscode.CancellationToken;
}

/** 只将缺失/路径类型变化视为失效，权限等 IO 错误传播；Node>=22 的 native-symbol-selection.test.js 验证失效清理与 EACCES 不清记录。 */
async function existsAs(filename: string, kind: 'file' | 'directory'): Promise<boolean> {
  try {
    const stat = await fs.promises.stat(filename);
    return kind === 'directory' ? stat.isDirectory() : stat.isFile() && filename.endsWith('.so');
  } catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code || '')) return false;
    throw error;
  }
}

/** 已发现目录仅列直接 .so，手选目录递归列文件但不跟随子链接；缺失返回空，真实 IO 错误传播。
 * Node>=22 执行 node --test tests/native-symbol-selection.test.js，断言重复路径、目录输入、缺失/空目录、链接及权限错误。 */
async function libraryFiles(directories: readonly string[], recursive: boolean): Promise<string[]> {
  const files = new Set<string>();
  for (const directory of new Set(directories.map(value => path.resolve(value)))) {
    let entries: fs.Dirent[];
    try { entries = await fs.promises.readdir(directory, { withFileTypes: true }); } catch (error) {
      if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code || '')) continue;
      throw error;
    }
    for (const entry of entries) {
      const filename = path.join(directory, entry.name);
      if (entry.isFile() && entry.name.endsWith('.so')) files.add(filename);
      else if (recursive && entry.isDirectory() && !entry.isSymbolicLink()) {
        for (const child of await libraryFiles([filename], true)) files.add(child);
      }
    }
  }
  return [...files].sort();
}

/** 为未确认身份/同名冲突的候选显示模块/variant/ABI所在相对目录和完整路径，不预选任何文件。
 * 前置：候选均为绝对 .so 路径；native-symbol-selection.test.js 验证选择/取消/冲突，native-codelldb.test.js 验证一次选择进入 child。 */
async function pickLibraries(files: string[], options: NativeSymbolOptions): Promise<string[] | undefined> {
  const items = files.map(filename => ({
    label: path.basename(filename),
    description: options.projectRoot ? path.relative(options.projectRoot, path.dirname(filename)) : path.dirname(filename),
    detail: filename,
    filename,
  }));
  const selected = await vscode.window.showQuickPick(items, {
    title: 'Android Native: Select .so files' + (options.abi ? ' (' + options.abi + ')' : ''),
    placeHolder: 'Select .so files',
    canPickMany: true, matchOnDescription: true, matchOnDetail: true, ignoreFocusOut: true,
  }, options.token);
  return selected?.map(item => item.filename);
}

/** 手填一个文件或目录，相对路径基于当前 Android 项目；输入框内校验存在性，保留带空格路径，不分割字符。
 * Node>=22 执行 node --test tests/native-symbol-selection.test.js，断言相对文件/目录、取消和无效路径，不吞权限错误。 */
async function manualSource(options: NativeSymbolOptions): Promise<NativeSymbolRecord | undefined> {
  const resolve = (value: string): string => path.resolve(options.projectRoot ?? '.', value.trim());
  const input = await vscode.window.showInputBox({
    title: 'Android Native: Symbol Path', prompt: 'Native .so file or directory', ignoreFocusOut: true,
    validateInput: async value => {
      if (!value.trim()) return 'Enter a .so file or directory path';
      const filename = resolve(value);
      return await existsAs(filename, 'file') || await existsAs(filename, 'directory') ? undefined : 'Path must be an existing .so file or directory';
    },
  }, options.token);
  if (input === undefined) return undefined;
  const filename = resolve(input);
  if (await existsAs(filename, 'directory')) return { files: [], directories: [filename] };
  if (await existsAs(filename, 'file')) return { files: [filename], directories: [] };
  throw new Error('Invalid Native symbol path: ' + filename);
}

/** 记录结构须为非空文件数组与目录数组，不信任损坏/旧版工作区状态；native-symbol-selection.test.js 验证损坏记录清除及项目隔离。 */
function isRecord(value: unknown): value is NativeSymbolRecord {
  if (!value || typeof value !== 'object') return false;
  const record = value as NativeSymbolRecord;
  return Array.isArray(record.files) && record.files.length > 0 && Array.isArray(record.directories)
    && [...record.files, ...record.directories].every(item => typeof item === 'string' && path.isAbsolute(item));
}

/** 选择/浏览/手填具体 .so 或目录；身份未知不能自动认定唯一候选正确。按项目/包名/ABI记住用户确认的精确文件及来源目录。
 * 前置：工作区可信且目录变量已替换；每次先验证记录，任何文件/目录丢失或类型变化先删除整条记录再交互，取消不恢复旧记录。
 * Node>=22 执行 node --test tests/native-symbol-selection.test.js，断言选择/手填/浏览、冲突、取消、重用/失效清理/隔离、IO/存储失败；
 * native-codelldb.test.js 验证内置流程仅一次交互、取消无 server/child，以及精确文件 preRunCommands。
 * 无项目根时只在本次会话使用，不把记录错误归入扩展进程 CWD；没有候选也保留手填/浏览入口。 */
export async function selectNativeLibraries(searchPaths: readonly string[], options: NativeSymbolOptions): Promise<string[] | undefined> {
  if (options.token?.isCancellationRequested) return undefined;
  const key = options.projectRoot ? 'androidNative.symbols:' + JSON.stringify([path.resolve(options.projectRoot), options.packageName ?? '', options.abi ?? '']) : undefined;
  const stored: unknown = key ? options.storage.get(key) : undefined;
  if (stored !== undefined) {
    let valid = isRecord(stored);
    if (isRecord(stored)) {
      for (const filename of stored.files) if (!await existsAs(filename, 'file')) valid = false;
      for (const directory of stored.directories) if (!await existsAs(directory, 'directory')) valid = false;
      if (valid) return options.token?.isCancellationRequested ? undefined : [...stored.files];
    }
    await options.storage.update(key!, undefined);
  }
  const candidates = await libraryFiles(searchPaths, false);
  const actions = [
    ...(candidates.length ? [{ label: '$(list-selection) Project .so files', action: 'scan' }] : []),
    { label: '$(file-binary) Browse .so files', action: 'files' },
    { label: '$(folder-opened) Browse symbol directory', action: 'directory' },
    { label: '$(edit) Enter file or directory path', action: 'manual' },
    ...(!candidates.length ? [{ label: '$(debug-continue) Continue without local symbols', action: 'none' }] : []),
  ];
  const choice = await vscode.window.showQuickPick(actions, {
    title: 'Android Native: Symbols' + (options.abi ? ' (' + options.abi + ')' : ''),
    placeHolder: 'Select symbol source', ignoreFocusOut: true,
  }, options.token);
  if (!choice || options.token?.isCancellationRequested) return undefined;
  if (choice.action === 'none') return [];
  let record: NativeSymbolRecord | undefined;
  if (choice.action === 'scan') {
    const files = await pickLibraries(candidates, options);
    if (files) record = { files, directories: [] };
  } else if (choice.action === 'manual') {
    record = await manualSource(options);
  } else {
    const directory = choice.action === 'directory';
    const uris = await vscode.window.showOpenDialog({
      title: directory ? 'Android Native: Symbol Directory' : 'Android Native: .so Files',
      canSelectFiles: !directory, canSelectFolders: directory, canSelectMany: !directory,
      ...(!directory ? { filters: { 'Native libraries': ['so'] } } : {}),
    });
    if (uris) record = { files: directory ? [] : uris.map(uri => path.resolve(uri.fsPath)), directories: directory ? uris.map(uri => path.resolve(uri.fsPath)) : [] };
  }
  if (!record || options.token?.isCancellationRequested) return undefined;
  for (const directory of record.directories) if (!await existsAs(directory, 'directory')) throw new Error('Invalid Native symbol directory: ' + directory);
  if (record.directories.length) {
    record.files = await libraryFiles(record.directories, true);
    if (new Set(record.files.map(filename => path.basename(filename))).size !== record.files.length) {
      const files = await pickLibraries(record.files, options);
      if (!files || options.token?.isCancellationRequested) return undefined;
      record.files = files;
    }
  }
  record.files = [...new Set(record.files)];
  if (!record.files.length) throw new Error('No Native .so files selected or found in the chosen directory.');
  const names = new Set<string>();
  for (const filename of record.files) {
    const name = path.basename(filename);
    if (names.has(name)) throw new Error('Conflicting Native libraries selected: ' + name + '. Select only one file for each library name.');
    names.add(name);
    if (!await existsAs(filename, 'file')) throw new Error('Invalid Native .so file: ' + filename);
  }
  nativeLibraryCommands(record.files);
  if (options.token?.isCancellationRequested) return undefined;
  if (key) await options.storage.update(key, record);
  return [...record.files];
}

/** 生成精确文件的 LLDB 模块命令，放入 CodeLLDB preRunCommands，不能用目录搜索替代文件选择。
 * 前置：已选择 .so；拒绝命令换行/NUL，转义反斜杠及双引号。Node>=22 执行 node --test tests/native-symbol-selection.test.js，
 * 断言 Windows/空格/引号路径及控制字符；native-codelldb.test.js 验证命令只进入 child 一次并保留用户 preRunCommands。 */
export function nativeLibraryCommands(files: readonly string[]): string[] {
  return files.map(filename => {
    if (/[\r\n\0]/.test(filename)) throw new Error('Invalid Native library path: control characters are not allowed');
    return 'target modules add -- "' + filename.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
  });
}
