import * as vscode from 'vscode';
import { registerDeviceManager } from './deviceManager';
import { RunningDeviceView } from './runningDevices';
import { LogcatView } from './logcat';
import { openExtendedControls } from './extendedControls';
import { AndroidBuildController } from './androidBuild';

// 注册紧凑运行面板、构建控制器及镜像；npm test build panel integration 回归断言动作、状态和生命周期接线。
export function activate(ctx: vscode.ExtensionContext) {
  const running = new RunningDeviceView(ctx.extensionPath, (message, serial) => build.handle(message, serial));
  const build = new AndroidBuildController((message) => running.publishBuildState(message));
  const logcat = new LogcatView(ctx.extensionPath);
  const refresh = () => running.refresh().catch((error) => vscode.window.showErrorMessage(String(error)));

  ctx.subscriptions.push(
    build,
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
