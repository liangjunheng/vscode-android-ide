import type * as vscode from 'vscode';
import type { Device } from 'appium-adb';

/** Native-only Android 调试配置；父会话把它转换为 CodeLLDB 子会话。 */
export interface AndroidNativeDebugConfiguration extends vscode.DebugConfiguration {
  type: 'android-tools';
  androidMode?: 'native';
  mode?: 'native';
  target?: string | (Device & { androidProjectRoot?: string });
  serial?: string;
  pid?: number | string;
  processId?: number | string;
  packageName?: string;
  launchActivity?: string;
  apkPath?: string;
  native?: Record<string, unknown>;
  resumeProcess?: boolean;
}

/** CodeLLDB 只接收父会话生成的受信字段；用户 native 选项作为隔离副本附加。 */
export interface NativeChildConfiguration extends vscode.DebugConfiguration {
  type: 'lldb';
  request: 'attach';
  pid: number;
  androidTarget: string;
  androidPackageName: string;
  androidAbi?: string;
  androidLldbServerSocket?: string;
  platform?: string;
}

/** Native provider/factory 暴露给 index 的公开契约。 */
export interface AndroidNativeDebugAdapterFactory extends vscode.DebugAdapterDescriptorFactory {
  readonly nativeOnly: true;
}
