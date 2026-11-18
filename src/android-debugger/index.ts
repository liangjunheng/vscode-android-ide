import * as vscode from 'vscode';

/** Android 调试模式；名称与用户可见模式保持一致。 */
export type AndroidDebugMode = 'kotlin-java' | 'native' | 'jvm-native';

/** 由 Gradle 变体、设备和进程解析出的调试目标。 */
export interface AndroidDebugTarget {
  serial: string;
  packageName?: string;
  pid?: number;
  processId?: number;
  mode?: AndroidDebugMode;
}

/**
 * 统一校验并扩展 Android 调试配置。
 * 前置条件：调用方已从 Gradle/设备模型得到真实 serial 和目标 PID；输出保留用户配置并注入本次目标身份。
 * 功能点与回归：Node>=22 执行 node --test tests/android-debug-configuration.test.js，断言无 PID 保留 Launch、有 PID 使用 Attach，且不修改输入配置；构建/进程面板测试断言启动目标。
 */
export function createAndroidDebugConfiguration(config: vscode.DebugConfiguration, target: AndroidDebugTarget): vscode.DebugConfiguration {
  if (!config || typeof config.type !== 'string' || !['attach', 'launch'].includes(String(config.request))) {
    throw new Error('Invalid Android debug configuration');
  }
  if (!/^\w[\w.:-]*$/.test(target.serial)) throw new Error('Invalid Android device serial');
  if (target.pid !== undefined && (!Number.isSafeInteger(target.pid) || target.pid <= 0)) throw new Error('Invalid Android process id');
  if (target.processId !== undefined && (!Number.isSafeInteger(target.processId) || target.processId <= 0)) throw new Error('Invalid Android process id');
  return {
    ...config,
    request: target.pid !== undefined || target.processId !== undefined ? 'attach' : config.request,
    serial: target.serial,
    ...(target.pid === undefined ? {} : { pid: target.pid, processId: target.processId ?? target.pid }),
    ...(target.processId === undefined ? {} : { processId: target.processId }),
    ...(target.packageName ? { packageName: target.packageName } : {}),
    ...(target.mode ? { androidMode: target.mode } : {})
  };
}

const BUILT_IN_DEBUG_CONFIGURATIONS: readonly vscode.DebugConfiguration[] = [
  { name: '[内置] Android Kotlin/Java', type: 'android-tools', request: 'launch', androidMode: 'kotlin-java' },
  { name: '[内置] Android Native', type: 'android-tools', request: 'launch', androidMode: 'native' },
  { name: '[内置] Android JVM+Native', type: 'android-tools', request: 'launch', androidMode: 'jvm-native' },
];

/** 读取当前文件夹的合法 launch 配置，并保留第三方配置的原始字段和请求语义。 */
function externalAndroidDebugConfigurations(folder?: vscode.WorkspaceFolder): vscode.DebugConfiguration[] {
  const configs = vscode.workspace.getConfiguration('launch', folder?.uri).get<vscode.DebugConfiguration[]>('configurations', []);
  return configs.filter(config => typeof config.type === 'string' && ['attach', 'launch'].includes(String(config.request)) && config.type !== 'android-tools');
}

/**
 * 返回可用的调试配置；内置适配器始终可用，外部配置仅在其适配器已注册时展示。
 * 前置条件：调用方已确认 workspace 信任；结果包含三项内置模式及去重后的第三方原配置。
 */
export function getAndroidDebugConfigurations(folder?: vscode.WorkspaceFolder): vscode.DebugConfiguration[] {
  const seen = new Set<string>();
  const custom = externalAndroidDebugConfigurations(folder).filter(config => {
    const key = JSON.stringify([config.name, config.type, config.request, config]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return [...BUILT_IN_DEBUG_CONFIGURATIONS.map(config => ({ ...config })), ...custom];
}

/**
 * 统一弹出 Debug/Attach 选择器并返回用户选择；取消返回 undefined，不触发宿主调试。
 * 前置条件：调用方已传入当前/唯一 workspace；结果保留内置模式和外部配置的原始字段。
 */
export async function selectAndroidDebugConfiguration(folder?: vscode.WorkspaceFolder): Promise<vscode.DebugConfiguration | undefined> {
  const items = getAndroidDebugConfigurations(folder).map(config => ({
    label: String(config.name),
    description: config.type === 'android-tools' ? '内置 Android 调试器' : String(config.type) + ' ' + String(config.request),
    config,
  }));
  const pick = await vscode.window.showQuickPick(items, { title: 'Android Debug Configuration' });
  return pick?.config;
}

/**
 * 兼容无 picker 的能力/默认配置查询；androidOnly 不再依赖用户 launch.json 或外部扩展。
 * 前置条件：folder 可选；返回首个已注册外部配置，否则返回内置 JVM 配置。
 */
export function findAndroidDebugConfiguration(folder?: vscode.WorkspaceFolder, androidOnly = false): vscode.DebugConfiguration {
  const configs = getAndroidDebugConfigurations(folder);
  if (androidOnly) return configs[0];
  return configs.find(config => config.type !== 'android-tools') || configs[0];
}

/**
 * 启动扩展已注册的调试后端；内置 android-tools 模式暂时只提示未实现并返回 undefined。
 * 前置条件：配置已通过 findAndroidDebugConfiguration，调用方已确认目标仍然存在；外部配置返回 false 时抛出拒绝错误。
 * 功能点与回归：node --test tests/debugger-stub.test.js 断言内置三模式提示/零启动，外部成功、拒绝与失败及订阅回收。
 */
export async function startAndroidDebugging(folder: vscode.WorkspaceFolder | undefined, config: vscode.DebugConfiguration, target: AndroidDebugTarget): Promise<vscode.DebugSession | undefined> {
  // 内置调试器暂时保留源码但不启动后端；点击内置 Debug/Attach 只给出明确通知，不访问设备或创建调试资源。
  if (config?.type === 'android-tools') {
    await vscode.window.showInformationMessage('Android 内置调试功能暂未实现');
    return undefined;
  }
  if (!vscode.workspace.isTrusted) throw new Error('Workspace is not trusted');
  const requested = createAndroidDebugConfiguration(config, target);
  let session: vscode.DebugSession | undefined;
  const listener = vscode.debug.onDidStartDebugSession(value => {
    if (value.configuration.name === requested.name && value.configuration.type === requested.type && value.configuration.serial === requested.serial) session = value;
  });
  try {
    if (!await vscode.debug.startDebugging(folder, requested)) throw new Error('Android debug adapter did not start (rejected)');
    return session;
  } finally {
    listener.dispose();
  }
}

/** 统一导出调试入口，避免构建和进程模块分别拼装调试配置。 */
export const androidDebugger = { createAndroidDebugConfiguration, findAndroidDebugConfiguration, getAndroidDebugConfigurations, selectAndroidDebugConfiguration, startAndroidDebugging };
