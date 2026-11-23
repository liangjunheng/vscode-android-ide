import * as vscode from 'vscode';
import { registerDeviceManager } from './deviceManager';
import { RunningDeviceView, DeviceViewMode } from './runningDevices';
import { DeviceExplorerController } from './deviceExplorer';
import { LogcatView } from './logcat';
import { openExtendedControls } from './extendedControls';
import { AndroidBuildController } from './androidBuild';
import { registerAndroidDebugging } from './android-debugger/debugging';
import { initializeRuntimeContext, resetRuntimeContext } from './runtimeContext';
import { registerJvmDebugger } from './android-debugger/jvm-debugger/adapter';

let closeDebuggers: (() => Promise<void>) | undefined;

/** 无输入，扫描 Gradle 入口并更新设备视图上下文；回归：node --test tests/configuration-prefix.test.js，Manifest 单独存在时不显示。 */
async function refreshGradleProjectContext(): Promise<void> {
  const files = await vscode.workspace.findFiles(
    '**/{build.gradle,build.gradle.kts,settings.gradle,settings.gradle.kts,gradlew,gradlew.bat}',
    '**/{node_modules,.git,.gradle,build}/**',
    1,
  );
  await vscode.commands.executeCommand('setContext', 'android-ide.hasAndroidProject', files.length > 0);
}

// 注册共享设备区域及配置监听，以延迟只读闭包将 Build 当前选择提供给 Explorer；输入扩展上下文，订阅交其释放，无返回值。
// 构建状态广播两侧，动作共用一个控制器；node --test tests/build-panel-ui.test.js 断言双向选择/启停接线，tests/device-selection-sync.test.js 断言设备同步；mirror-configuration.test.js覆盖配置接线。
export function activate(ctx: vscode.ExtensionContext) {
  // Android 工作区才显示设备视图；文件增删改名或工作区切换后重新计算上下文。
  refreshGradleProjectContext().catch(error => vscode.window.showErrorMessage(String(error)));
  ctx.subscriptions.push(
    vscode.workspace.onDidCreateFiles(() => refreshGradleProjectContext().catch(error => vscode.window.showErrorMessage(String(error)))),
    vscode.workspace.onDidDeleteFiles(() => refreshGradleProjectContext().catch(error => vscode.window.showErrorMessage(String(error)))),
    vscode.workspace.onDidRenameFiles(() => refreshGradleProjectContext().catch(error => vscode.window.showErrorMessage(String(error)))),
    vscode.workspace.onDidChangeWorkspaceFolders(() => refreshGradleProjectContext().catch(error => vscode.window.showErrorMessage(String(error)))),
  );
  // 初始化唯一运行时上下文，集中管理当前平台和扩展内置依赖。
  initializeRuntimeContext(ctx.extensionPath);
  // 显式四态配置优先，未配置则兼容旧布尔项；device-view-mode回归验证迁移与设置页同步。
  const readMode = (): DeviceViewMode => {
    const configuration = vscode.workspace.getConfiguration('android-ide');
    const inspected = configuration.inspect<DeviceViewMode>('deviceViewMode');
    const explicit = inspected?.workspaceValue ?? inspected?.globalValue;
    return explicit === 'mirror' || explicit === 'explorer' || explicit === 'processes' || explicit === 'hidden' ? explicit : configuration.get<boolean>('mirrorVisible', true) ? 'mirror' : 'hidden';
  };
  const preference = {
    visible: vscode.workspace.getConfiguration('android-ide').get<boolean>('mirrorVisible', true),
    mode: readMode(),
    // 新按钮保存唯一模式；device-view-mode回归断言目标、保存失败和扩展重建恢复。
    saveMode: async (mode: DeviceViewMode) => {
      const configuration = vscode.workspace.getConfiguration('android-ide');
      const target = configuration.inspect('deviceViewMode')?.workspaceValue !== undefined || configuration.inspect('mirrorVisible')?.workspaceValue !== undefined ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
      await configuration.update('deviceViewMode', mode, target);
    },
    // 保留旧布尔消息的配置入口；mirror-configuration回归验证用户/工作区及失败传播。
    save: async (visible: boolean) => {
      const configuration = vscode.workspace.getConfiguration('android-ide');
      const target = configuration.inspect<boolean>('mirrorVisible')?.workspaceValue !== undefined ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
      await configuration.update('mirrorVisible', visible, target);
    },
  };
  // 提供方同串号幂等阻止回传循环；device-selection-sync回归验证双方选择、隐藏和无设备日志入口。
  // 定位时只读Build当前ID，undefined交Explorer候选fallback，不缓存或吞真实故障；Node>=22，node --test tests/mirror-configuration.test.js验证闭包时序/切换/undefined及错误。
  const explorer = new DeviceExplorerController(message => running.publishBuildState(message), () => build.currentApplicationId(), (packageName, workspaceRoot, signal) => build.resolveCurrentDebugProject(packageName, workspaceRoot, signal));
  const nativeMirror = vscode.workspace.getConfiguration('android-ide').get<boolean>('nativeMirror', false);
  const running = new RunningDeviceView(ctx.extensionPath, (message, serial) => build.handle(message, serial), preference, serial => logcat.select(serial), explorer, nativeMirror);
  const build = new AndroidBuildController(message => { running.publishBuildState(message); logcat.publishBuildState(message); }, ctx.extensionPath, ctx.workspaceState);
  registerJvmDebugger(ctx);
  const logcat = new LogcatView(ctx.extensionPath, serial => running.select(serial ? { serial } : undefined), (message, serial) => build.handle(message, serial));
  // Device Tools刷新同时刷新设备列表和Gradle项目/Android variants；任一刷新失败都交给命令入口显示真实错误。
  const refresh = () => Promise.all([
    running.refresh(),
    build.handle({ type: 'buildPanel', action: 'refresh' }),
  ]).catch(error => vscode.window.showErrorMessage(String(error)));
  const debugging = registerAndroidDebugging(ctx, folder => folder ? build.currentNativeDebugMetadata(folder.uri.fsPath) : undefined);
  closeDebuggers = () => debugging.dispose();
  ctx.subscriptions.push(
    build, explorer, running,
    // 监听只应用不写回，订阅由ctx释放；device-view-mode/mirror-configuration回归断言过滤和错误展示。
    vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration('android-ide.deviceViewMode') || event.affectsConfiguration('android-ide.mirrorVisible')) {
        running.applyDeviceViewMode(readMode()).catch(error => vscode.window.showErrorMessage(String(error)));
      }
    }),
    vscode.window.registerWebviewViewProvider('android-ide.runningDevice', running, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.window.registerWebviewViewProvider('android-ide.logcat', logcat, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.commands.registerCommand('android-ide.showLogcat', (arg: any) => logcat.show(arg?.kind === 'avd' ? arg.running : arg)),
    vscode.commands.registerCommand('android-ide.extendedControls', (arg: any) => openExtendedControls(ctx.extensionPath, (arg?.kind === 'avd' ? arg.running : arg)?.serial)),
    vscode.commands.registerCommand('android-ide.screenshot', (arg: any) => arg?.serial && running.screenshot(arg.serial)),
    vscode.commands.registerCommand('android-ide.screenRecord', (arg: any) => arg?.serial && running.toggleRecording(arg.serial)),
    vscode.commands.registerCommand('android-ide.refresh', refresh),
    vscode.commands.registerCommand('android-ide.mirroredSerial', () => running.mirroredSerial()),
    vscode.commands.registerCommand('android-ide.stopMirror', () => running.stopMirroring()),
    vscode.commands.registerCommand('android-ide.selectDevice', (device: any) => running.select(device)),
    vscode.commands.registerCommand('android-ide.mirrorDevice', (arg: any) => running.show(arg?.kind === 'avd' ? arg.running : arg)),
  );
  registerDeviceManager(ctx, () => {});
  // 工程激活即预查询，面板打开只订阅当前快照；build-panel-ui回归验证无面板也初始化且共享工作区缓存。
  build.initialize().catch(error => vscode.window.showErrorMessage(String(error)));
}

/** 功能：停用时等待当前调试连接清理；输入扩展生命周期；输出资源结算结果。 */
export async function deactivate(): Promise<void> {
  try { await closeDebuggers?.(); } finally { closeDebuggers = undefined; resetRuntimeContext(); }
}
