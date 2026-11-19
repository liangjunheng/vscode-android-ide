import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';

/** 项目本机路径配置；仅来自项目内 JSON，不读取或同步 VS Code 设置。 */
export interface ProjectLocalConfig {
  sdkPath?: string;
  downloadDirectory?: string;
  debugger?: {
    adbPath?: string;
    lldbDapPath?: string;
    ndkPath?: string;
    symbolSearchPaths?: string[];
  };
}

/**
 * 校验 JSON 对象及允许的键；输入未知 JSON，返回对象或抛出含文件名和字段位置的错误。
 * 回归：Node>=22 执行 node --test tests/project-local-config.test.js，错误对象和拼写键均须拒绝。
 */
function configObject(value: unknown, keys: readonly string[], filename: string, field: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${filename}: ${field} must be a JSON object`);
  }
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) throw new Error(`${filename}: unknown field ${field}.${key}`);
  }
  return value as Record<string, unknown>;
}

/**
 * 将已提供的字符串路径相对项目根解析；空白视为未指定，绝对路径原样返回，其他类型报错。
 * 回归：Node>=22 执行 node --test tests/project-local-config.test.js，断言所有路径字段、空值及类型错误。
 */
function configPath(value: unknown, root: string, filename: string, field: string): string | undefined {
  if (typeof value !== 'string') throw new Error(`${filename}: ${field} must be a string`);
  if (!value.trim()) return undefined;
  return path.isAbsolute(value) ? value : path.resolve(root, value);
}

/**
 * 只读项目根下 .vscode/android-ide.local.json 并返回已校验的本机路径，不写文件也不读取全局设置。
 * 显式根优先；否则选活动编辑器所属工作区，再选唯一工作区，多根无活动归属或无工作区返回空对象。
 * 文件缺失返回空对象；JSON、类型、未知键和其他 IO 错误均携带文件名抛出，空路径不进入结果。
 * 回归：Node>=22 执行 node --test tests/project-local-config.test.js，断言路径解析、项目隔离、
 * 工作区选择、严格校验、错误传播及不访问设置/不写配置，测试成功以全部断言通过为准。
 */
export function readProjectLocalConfig(projectRoot?: string): ProjectLocalConfig {
  let root = projectRoot;
  if (root === undefined) {
    const editor = vscode.window?.activeTextEditor;
    const activeFolder = editor ? vscode.workspace?.getWorkspaceFolder(editor.document.uri) : undefined;
    const folders = vscode.workspace?.workspaceFolders;
    root = activeFolder?.uri.fsPath ?? (folders?.length === 1 ? folders[0].uri.fsPath : undefined);
  }
  if (root === undefined) return {};

  const filename = path.join(root, '.vscode', 'android-ide.local.json');
  let content: string;
  try {
    content = fs.readFileSync(filename, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw new Error(`${filename}: cannot read project local configuration: ${String(error)}`, { cause: error });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new Error(`${filename}: invalid JSON: ${String(error)}`, { cause: error });
  }
  const config = configObject(parsed, ['sdkPath', 'downloadDirectory', 'debugger'], filename, 'config');
  const result: ProjectLocalConfig = {};
  for (const key of ['sdkPath', 'downloadDirectory'] as const) {
    if (Object.hasOwn(config, key)) {
      const value = configPath(config[key], root, filename, key);
      if (value !== undefined) result[key] = value;
    }
  }
  if (Object.hasOwn(config, 'debugger')) {
    const debuggerConfig = configObject(config.debugger, ['adbPath', 'lldbDapPath', 'ndkPath', 'symbolSearchPaths'], filename, 'debugger');
    const debuggerPaths: NonNullable<ProjectLocalConfig['debugger']> = {};
    for (const key of ['adbPath', 'lldbDapPath', 'ndkPath'] as const) {
      if (Object.hasOwn(debuggerConfig, key)) {
        const value = configPath(debuggerConfig[key], root, filename, `debugger.${key}`);
        if (value !== undefined) debuggerPaths[key] = value;
      }
    }
    const symbolPaths = debuggerConfig.symbolSearchPaths;
    if (symbolPaths !== undefined) {
      if (!Array.isArray(symbolPaths) || symbolPaths.some(value => typeof value !== 'string')) throw new Error(filename + ': debugger.symbolSearchPaths must be a string array');
      debuggerPaths.symbolSearchPaths = symbolPaths.map(value => configPath(value, root, filename, 'debugger.symbolSearchPaths')).filter((value): value is string => value !== undefined);
    }
    if (Object.keys(debuggerPaths).length) result.debugger = debuggerPaths;
  }
  return result;
}
