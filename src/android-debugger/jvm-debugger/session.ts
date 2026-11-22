import type * as vscode from 'vscode';
import type { AndroidDebugSession } from '../coordinator/androidCoordinator';

/** 功能：为单独 JVM 与 Dual 生成同一附加配置并申请所属租约。
 * 输入：已解析的 Android 配置、唯一 PID、父会话和资源账本；端口必须为数字。
 * 输出：交给 android-jvm 工厂的配置，不安装、不再次启动应用。
 * 验证：npm test 中 native-codelldb.test.js、jvm-debugger.test.js 与 coordinator-device-host.test.js。
 */
export async function prepareJvmChild(config: vscode.DebugConfiguration, pid: number, parent: vscode.DebugSession, resources: AndroidDebugSession): Promise<vscode.DebugConfiguration> {
  const java = structuredClone(config.java ?? {});
  const requestedPort = java.port === undefined ? 0 : java.port;
  if (typeof requestedPort !== 'number' || !Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65535) throw new Error('Invalid Android JVM port; use 0 for a dynamic port');
  const externalTask = typeof java.preLaunchTask === 'string' && java.preLaunchTask.trim() ? java.preLaunchTask : undefined;
  const external = !!externalTask && requestedPort > 0;
  const hostName = external ? java.hostName ?? '127.0.0.1' : '127.0.0.1';
  const port = external ? requestedPort : (await resources.claim(pid)).port;
  for (const field of ['port', 'host', 'hostName', 'androidTarget', 'androidPid', 'apkPath', 'launchActivity', 'signal']) delete java[field];
  if (!externalTask) for (const field of ['preLaunchTask', 'postLaunchTask', 'postDebugTask', 'serverReadyAction']) delete java[field];
  return { ...java, type: 'android-jvm', name: java.name ?? 'Android JVM', request: 'attach', android: true,
    serial: resources.serial, target: resources.serial, pid, processId: pid, sessionId: parent.id, packageName: config.packageName,
    hostName, port, androidJdwpPort: port, ...(external ? { preLaunchTask: externalTask, androidJdwpExternal: true } : {}),
    androidProjectRoot: config.androidProjectRoot, projectRoot: java.projectRoot ?? config.projectRoot ?? config.androidProjectRoot ?? parent.workspaceFolder?.uri.fsPath,
    sourcePaths: structuredClone(java.sourcePaths ?? config.sourcePaths ?? config.androidSourceRoots) };
}
