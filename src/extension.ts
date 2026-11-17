import * as vscode from 'vscode';
import { registerDeviceManager } from './deviceManager';
import { RunningDeviceView, DeviceViewMode } from './runningDevices';
import { DeviceExplorerController } from './deviceExplorer';
import { LogcatView } from './logcat';
import { openExtendedControls } from './extendedControls';
import { AndroidBuildController } from './androidBuild';

// 注册共享设备区域、构建、日志及Explorer，资源交给扩展；device-view-mode和device-selection-sync回归执行真实激活接线。
export function activate(ctx: vscode.ExtensionContext) {
  // 显式四态配置优先，未配置则兼容旧布尔项；device-view-mode回归验证迁移与设置页同步。
  const readMode = (): DeviceViewMode => {
    const configuration = vscode.workspace.getConfiguration('android');
    const inspected = configuration.inspect<DeviceViewMode>('deviceViewMode');
    const explicit = inspected?.workspaceValue ?? inspected?.globalValue;
    return explicit === 'mirror' || explicit === 'explorer' || explicit === 'processes' || explicit === 'hidden' ? explicit : configuration.get<boolean>('mirrorVisible', true) ? 'mirror' : 'hidden';
  };
  const preference = {
    visible: vscode.workspace.getConfiguration('android').get<boolean>('mirrorVisible', true),
    mode: readMode(),
    // 新按钮保存唯一模式；device-view-mode回归断言目标、保存失败和扩展重建恢复。
    saveMode: async (mode: DeviceViewMode) => {
      const configuration = vscode.workspace.getConfiguration('android');
      const target = configuration.inspect('deviceViewMode')?.workspaceValue !== undefined || configuration.inspect('mirrorVisible')?.workspaceValue !== undefined ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
      await configuration.update('deviceViewMode', mode, target);
    },
    // 保留旧布尔消息的配置入口；mirror-configuration回归验证用户/工作区及失败传播。
    save: async (visible: boolean) => {
      const configuration = vscode.workspace.getConfiguration('android');
      const target = configuration.inspect<boolean>('mirrorVisible')?.workspaceValue !== undefined ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
      await configuration.update('mirrorVisible', visible, target);
    },
  };
  // 提供方同串号幂等阻止回传循环；device-selection-sync回归验证双方选择、隐藏和无设备日志入口。
  // 定位时才读取Build当前包名；缺目标返回undefined交Explorer候选选择，不缓存或吞错。mirror-configuration的wiring回归验证取值时序、切换和错误传播。
  const explorer = new DeviceExplorerController(message => running.publishBuildState(message), () => build.currentApplicationId());
  const running = new RunningDeviceView(ctx.extensionPath, (message, serial) => build.handle(message, serial), preference, serial => logcat.select(serial), explorer);
  const build = new AndroidBuildController(message => running.publishBuildState(message));
  const logcat = new LogcatView(ctx.extensionPath, serial => running.select(serial ? { serial } : undefined));
  const refresh = () => running.refresh().catch(error => vscode.window.showErrorMessage(String(error)));
  ctx.subscriptions.push(
    build, explorer, running,
    // 监听只应用不写回，订阅由ctx释放；device-view-mode/mirror-configuration回归断言过滤和错误展示。
    vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration('android.deviceViewMode') || event.affectsConfiguration('android.mirrorVisible')) {
        running.applyDeviceViewMode(readMode()).catch(error => vscode.window.showErrorMessage(String(error)));
      }
    }),
    vscode.window.registerWebviewViewProvider('android.runningDevice', running, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.window.registerWebviewViewProvider('android.logcat', logcat, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.commands.registerCommand('android.showLogcat', (arg: any) => logcat.show(arg?.kind === 'avd' ? arg.running : arg)),
    vscode.commands.registerCommand('android.extendedControls', (arg: any) => openExtendedControls(ctx.extensionPath, (arg?.kind === 'avd' ? arg.running : arg)?.serial)),
    vscode.commands.registerCommand('android.screenshot', (arg: any) => arg?.serial && running.screenshot(arg.serial)),
    vscode.commands.registerCommand('android.screenRecord', (arg: any) => arg?.serial && running.toggleRecording(arg.serial)),
    vscode.commands.registerCommand('android.refresh', refresh),
    vscode.commands.registerCommand('android.mirroredSerial', () => running.mirroredSerial()),
    vscode.commands.registerCommand('android.stopMirror', () => running.stopMirroring()),
    vscode.commands.registerCommand('android.selectDevice', (device: any) => running.select(device)),
    vscode.commands.registerCommand('android.mirrorDevice', (arg: any) => running.show(arg?.kind === 'avd' ? arg.running : arg)),
  );
  registerDeviceManager(ctx, () => {});
}

export function deactivate() {}
