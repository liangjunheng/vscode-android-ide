import * as vscode from 'vscode';

export interface AndroidDebugTarget {
  serial: string;
  pid?: number;
  processId?: number;
  packageName?: string;
  mode?: string;
  signal?: AbortSignal;
}

// 提供唯一 Native 内置配置，每次返回独立选项，外部配置不受影响。
// 回归：Node>=22，node --test tests/android-debugger-configurations.test.js；断言模式及配置隔离。
export function getAndroidDebugConfigurations(): vscode.DebugConfiguration[] {
  return [{ type: 'android-tools', request: 'launch', name: '[内置] Android Native', androidMode: 'native', mode: 'native', native: {} }];
}

// 读取当前目录有效 launch/attach 配置并按身份去重；只筛选结构，不修改用户选项。
// 回归：android-debugger-configurations.test.js，重复和非法外部项不会增加选择数量。
function externalConfigurations(folder?: vscode.WorkspaceFolder): vscode.DebugConfiguration[] {
  const configs = vscode.workspace.getConfiguration('launch', folder?.uri).get<vscode.DebugConfiguration[]>('configurations', []);
  const seen = new Set<string>();
  return configs.filter(config => {
    if (!config || typeof config.type !== 'string' || typeof config.name !== 'string' || !['launch', 'attach'].includes(config.request)) return false;
    const key = JSON.stringify(config);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// 优先返回用户配置或显式内置 Native 默认项；输入工作区和优先策略，输出配置。
// 回归：android-debugger-configurations.test.js 验证外部优先和内置优先两个入口。
export function findAndroidDebugConfiguration(folder?: vscode.WorkspaceFolder, preferBuiltIn = false): vscode.DebugConfiguration {
  return (!preferBuiltIn && externalConfigurations(folder)[0]) || getAndroidDebugConfigurations()[0];
}

// 将唯一 Native 内置项与有效外部配置供用户选择；取消返回 undefined，不启动会话。
// 回归：android-debugger-configurations.test.js 验证选择、去重和取消；Build/Processes测试验证调用链。
export async function selectAndroidDebugConfiguration(folder?: vscode.WorkspaceFolder): Promise<vscode.DebugConfiguration | undefined> {
  const configurations = [...getAndroidDebugConfigurations(), ...externalConfigurations(folder)];
  const item = await vscode.window.showQuickPick(configurations.map(config => ({ label: config.name, description: config.type, config })), { placeHolder: 'Select Android debug configuration' });
  return item?.config;
}

// 将已选设备和进程映射到配置；仅内置会话限定 Native，非法身份在分配资源前失败，保留外部选项。
// 回归：android-debugger-configurations.test.js 验证launch/attach、模式拒绝、PID冲突及输入不变。
export function createAndroidDebugConfiguration(config: vscode.DebugConfiguration, target: AndroidDebugTarget): vscode.DebugConfiguration {
  if (!config || typeof config.type !== 'string' || !['launch', 'attach'].includes(config.request)) throw new Error('Invalid Android debug configuration');
  if (!target.serial || !/^[\w.:-]+$/.test(target.serial)) throw new Error('Invalid Android device serial');
  for (const pid of [target.pid, target.processId]) {
    if (pid !== undefined && (!Number.isSafeInteger(pid) || pid <= 0)) throw new Error('Invalid Android process id');
  }
  if (target.pid !== undefined && target.processId !== undefined && target.pid !== target.processId) throw new Error('Conflicting Android process ids');
  const pid = target.pid ?? target.processId;
  const mapped = { ...config, serial: target.serial, ...(target.packageName ? { packageName: target.packageName } : {}), ...(pid !== undefined ? { request: 'attach', pid, processId: pid } : {}) };
  if (config.type === 'android-tools') {
    const mode = target.mode ?? config.androidMode ?? config.mode ?? 'native';
    if (mode !== 'native') throw new Error('Only Android Native debugging is available');
    Object.assign(mapped, { mode: 'native', androidMode: 'native', target: target.serial, native: { ...config.native } });
  }
  return mapped;
}

// 内置Native先打开Run and Debug再启动，不运行构建；跳转后复核取消和信任，失败保留并释放本次监听。
// 回归：Node>=22运行node --test tests/android-debugger-configurations.test.js，断言视图先于启动、外部不跳转、导航失败/取消零会话及监听释放。
export async function startAndroidDebugging(folder: vscode.WorkspaceFolder | undefined, config: vscode.DebugConfiguration, target: AndroidDebugTarget): Promise<vscode.DebugSession> {
  if (!vscode.workspace.isTrusted) throw new Error('Workspace is not trusted');
  target.signal?.throwIfAborted();
  const mapped = createAndroidDebugConfiguration(config, target);
  if (mapped.type === 'android-tools') await vscode.commands.executeCommand('workbench.view.debug');
  target.signal?.throwIfAborted();
  if (!vscode.workspace.isTrusted) throw new Error('Workspace is not trusted');
  let started: vscode.DebugSession | undefined;
  const listener = vscode.debug.onDidStartDebugSession(session => {
    const value = session.configuration;
    const requestedPid = target.pid ?? target.processId;
    if (value.type === mapped.type && value.name === mapped.name && value.serial === mapped.serial && (mapped.packageName === undefined || value.packageName === mapped.packageName) && (requestedPid === undefined || Number(value.pid ?? value.processId) === requestedPid)) started = session;
  });
  try {
    if (!await vscode.debug.startDebugging(folder, mapped)) throw new Error('Android debug session did not start');
    if (!started) throw new Error('Android debug session did not report a start event');
    return started;
  } finally { listener.dispose(); }
}

export const androidDebugger = { startAndroidDebugging };
