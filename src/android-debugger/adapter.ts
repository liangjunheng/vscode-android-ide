import type * as vscode from 'vscode';
import { AndroidCoordinator } from './coordinator/androidCoordinator';
import { DebugAdapterDescriptorFactory } from './sessionAdapter';
import { createAndroidSessionHost, registerNativeProviders, NativePackageResolver } from './native-debugger/adapter';

/** 功能：装配统一 Android 调试入口而不将 Dual 工厂放在 Native 模块。
 * 输入：扩展上下文、项目元数据来源和共享 Coordinator。
 * 输出：三模式共用的父适配器工厂；Native/JVM 引擎保持独立。
 * 验证：npm test 中 native-codelldb.test.js、vsix-content.test.js 和 coordinator-device-host.test.js。
 */
export function createAndroidDebugAdapterFactory(context: vscode.ExtensionContext, selectedPackage: NativePackageResolver | undefined, coordinator: AndroidCoordinator): DebugAdapterDescriptorFactory {
  const native = registerNativeProviders(context, selectedPackage, coordinator);
  return new DebugAdapterDescriptorFactory(context, createAndroidSessionHost(native, coordinator), coordinator);
}
