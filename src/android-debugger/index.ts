import * as vscode from 'vscode';

export interface AndroidDebugTarget {
  serial: string;
  pid?: number;
  processId?: number;
  packageName?: string;
  mode?: string;
  signal?: AbortSignal;
}

// 提供Native/JVM/Dual各Launch/Attach六项兜底，每次返回独立选项；android-debugger-configurations.test.js断言矩阵与隔离。
// 回归：Node>=22，node --test tests/android-debugger-configurations.test.js；断言模式及配置隔离。
export function getAndroidDebugConfigurations(): vscode.DebugConfiguration[] {
  const java = { type: 'kotlin-jvm', name: 'Android JVM' };
  return [
    { type: 'android-debug', request: 'launch', name: 'Android: Android Native Debug Launch', mode: 'native', target: 'select', native: {} },
    { type: 'android-debug', request: 'attach', name: 'Android: Android Native Debug Attach', mode: 'native', target: 'select', native: {} },
    { type: 'android-debug', request: 'launch', name: 'Android: Android JVM Debug Launch', mode: 'java', target: 'select', java: { ...java } },
    { type: 'android-debug', request: 'attach', name: 'Android: Android JVM Debug Attach', mode: 'java', target: 'select', java: { ...java } },
    { type: 'android-debug', request: 'launch', name: 'Android: Android Dual(Native and JVM) Debug Launch', mode: 'dual', target: 'select', native: {}, java: { ...java } },
    { type: 'android-debug', request: 'attach', name: 'Android: Android Dual(Native and JVM) Debug Attach', mode: 'dual', target: 'select', native: {}, java: { ...java } },
  ];
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

// Build优先外部配置并以内置兜底；Processes展示三个内置Attach与全部有效外部项，取消不启动。回归：android-debugger-configurations.test.js及Processes调用链。
export async function selectAndroidDebugConfiguration(folder?: vscode.WorkspaceFolder, request?: 'launch' | 'attach'): Promise<vscode.DebugConfiguration | undefined> {
  const external = externalConfigurations(folder);
  const configurations = request === 'attach'
    ? [...getAndroidDebugConfigurations().filter(config => config.request === 'attach'), ...external]
    : (external.length ? external : getAndroidDebugConfigurations()).filter(config => !request || config.request === request);
  if (!configurations.length) throw new Error('No ' + request + ' debug configuration in launch.json');
  const item = await vscode.window.showQuickPick(configurations.map(config => ({ label: config.name, description: config.type, config })), { placeHolder: request === 'attach' ? 'Select Android attach configuration' : external.length ? 'Select launch.json debug configuration' : 'Select built-in Android debug configuration' });
  return item?.config;
}

// 映射设备进程且保留外部选项与显式包名，Android统一入口隔离Native/JVM选项；android-debugger-configurations.test.js覆盖六模式、非法身份和输入不变。
export function createAndroidDebugConfiguration(config: vscode.DebugConfiguration, target: AndroidDebugTarget): vscode.DebugConfiguration {
  if (!config || typeof config.type !== 'string' || !['launch', 'attach'].includes(config.request)) throw new Error('Invalid Android debug configuration');
  if (!target.serial || !/^[\w.:-]+$/.test(target.serial)) throw new Error('Invalid Android device serial');
  for (const pid of [target.pid, target.processId]) {
    if (pid !== undefined && (!Number.isSafeInteger(pid) || pid <= 0)) throw new Error('Invalid Android process id');
  }
  if (target.pid !== undefined && target.processId !== undefined && target.pid !== target.processId) throw new Error('Conflicting Android process ids');
  const pid = target.pid ?? target.processId;
  const mapped: vscode.DebugConfiguration = { ...config, serial: target.serial, ...(!config.packageName && target.packageName ? { packageName: target.packageName } : {}), ...(pid !== undefined ? { request: 'attach', pid, processId: pid } : {}) };
  if (config.type === 'android-tools' || config.type === 'android-debug') {
    const mode = target.mode ?? config.androidMode ?? config.mode ?? 'native';
    if (config.type === 'android-tools' && mode !== 'native') throw new Error('Only Android Native debugging is available');
    if (config.type === 'android-debug' && !['native', 'java', 'dual'].includes(mode)) throw new Error('Unsupported Android debug mode');
    Object.assign(mapped, { mode, target: target.serial });
    if (config.type === 'android-tools') Object.assign(mapped, { androidMode: 'native', native: { ...config.native } });
    else {
      if (config.native !== undefined) mapped.native = { ...config.native };
      if (config.java !== undefined) mapped.java = { ...config.java };
    }
  }
  return mapped;
}

// 先启动会话再导航，避免Processes隐藏时取消尚未开始的附加；导航失败提示但不撤销已启动会话。
// 回归：android-debugger-configurations.test.js覆盖三模式导航取消、启动拒绝及监听释放；Processes回归验证隐藏视图不阻止附加。
export async function startAndroidDebugging(folder: vscode.WorkspaceFolder | undefined, config: vscode.DebugConfiguration, target: AndroidDebugTarget): Promise<vscode.DebugSession> {
  if (!vscode.workspace.isTrusted) throw new Error('Workspace is not trusted');
  target.signal?.throwIfAborted();
  const mapped = createAndroidDebugConfiguration(config, target);
  let started: vscode.DebugSession | undefined;
  const listener = vscode.debug.onDidStartDebugSession(session => {
    const value = session.configuration;
    const requestedPid = target.pid ?? target.processId;
    if (value.type === mapped.type && value.name === mapped.name && value.serial === mapped.serial && (mapped.packageName === undefined || value.packageName === mapped.packageName) && (requestedPid === undefined || Number(value.pid ?? value.processId) === requestedPid)) started = session;
  });
  try {
    if (!await vscode.debug.startDebugging(folder, mapped)) throw new Error('Android debug session did not start');
    if (!started) throw new Error('Android debug session did not report a start event');
  } finally { listener.dispose(); }
  if (mapped.type === 'android-tools' || mapped.type === 'android-debug' || (mapped.type === 'kotlin-jvm' && mapped.android)) {
    try { await vscode.commands.executeCommand('workbench.view.debug'); }
    catch (error) { await vscode.window.showErrorMessage('Debug session started, but Run and Debug could not be opened: ' + String(error)); }
  }
  return started;
}

export const androidDebugger = { startAndroidDebugging };
