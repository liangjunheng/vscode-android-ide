import * as vscode from 'vscode';
import { registerDeviceManager } from './deviceManager';
import { RunningDeviceView } from './runningDevices';
import { LogcatView } from './logcat';
import { openExtendedControls } from './extendedControls';
import { AndroidBuildController } from './androidBuild';

// 注册紧凑运行面板、构建控制器及镜像；npm test build panel integration 回归断言动作、状态和生命周期接线。
export function activate(ctx: vscode.ExtensionContext) {
  // 从 VS Code 配置恢复状态，按钮更新现有工作区覆盖或用户设置；npm test mirror configuration 回归断言目标与重启恢复。
  const preference = {
    visible: vscode.workspace.getConfiguration('android').get<boolean>('mirrorVisible', true),
    save: async (visible: boolean) => {
      const configuration = vscode.workspace.getConfiguration('android');
      const target = configuration.inspect<boolean>('mirrorVisible')?.workspaceValue !== undefined
        ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
      await configuration.update('mirrorVisible', visible, target);
    },
  };
  // 两侧选择变化直接同步，提供方相同串号幂等避免循环；npm test device selection sync 执行真实 activate 接线。
  const running = new RunningDeviceView(ctx.extensionPath, (message, serial) => build.handle(message, serial), preference, (serial) => logcat.select(serial));
  const build = new AndroidBuildController((message) => running.publishBuildState(message));
  const logcat = new LogcatView(ctx.extensionPath, (serial) => running.select(serial ? { serial } : undefined));
  const refresh = () => running.refresh().catch((error) => vscode.window.showErrorMessage(String(error)));

  ctx.subscriptions.push(
    build,
    // 设置页变化只同步显示，不重新保存；npm test mirror configuration 验证过滤、异常提示与监听释放所有权。
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('android.mirrorVisible')) {
        running.applyMirrorVisibility(vscode.workspace.getConfiguration('android').get<boolean>('mirrorVisible', true))
          .catch((error) => vscode.window.showErrorMessage(String(error)));
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
    vscode.commands.registerCommand('android.mirrorDevice', (arg: any) => {
      const d = arg?.kind === 'avd' ? arg.running : arg;
      return running.show(d);
    }),
  );
  registerDeviceManager(ctx, () => {});
}

export function deactivate() {}
