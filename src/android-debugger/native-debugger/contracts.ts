import type * as vscode from 'vscode';
import type { Device } from 'appium-adb';

/** 统一 Android 三模式配置；android-tools 兼容 Native-only，android-debug 由父会话接线 CodeLLDB/JVM children。 */
export interface AndroidNativeDebugConfiguration extends vscode.DebugConfiguration {
  type: 'android-tools' | 'android-debug';
  androidMode?: 'native';
  mode?: 'native' | 'java' | 'dual';
  java?: { type?: 'android-jvm'; name?: string; sourcePaths?: string[]; [option: string]: unknown };
  sourcePaths?: string[];
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
