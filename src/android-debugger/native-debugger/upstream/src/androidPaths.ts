import * as vscode from 'vscode';

import * as android from './android';
import { resolveNativeToolchain } from '../../nativeToolchain';

/**
 * 懒解析共享 Native 工具链的 SDK 根；激活阶段不访问文件系统，调用方可传项目根。
 * 返回解析结果，工具链缺失或配置错误时传播原始错误。
 */
// 回归：Node>=22执行 node --test tests/native-runtime.test.js，断言懒激活/项目路径透传/错误传播。
export function requireSdkRoot(projectRoot?: string): string {
    return resolveNativeToolchain(projectRoot).sdkRoot;
}

/**
 * 懒解析共享 Native 工具链的 NDK 根；激活阶段不访问文件系统，调用方可传项目根。
 * 返回解析结果，工具链缺失或配置错误时传播原始错误。
 */
// 回归：Node>=22执行 node --test tests/native-runtime.test.js，断言懒激活/项目路径透传/错误传播。
export function requireNdkRoot(projectRoot?: string): string {
    return resolveNativeToolchain(projectRoot).ndkRoot;
}

/**
 * 注册配置变更监听并使按工具链缓存失效；激活本身不探测 SDK/NDK，也不弹错误。
 * 配置变更后的实际解析由下一次运行时调用完成并传播错误。
 */
// 回归：Node>=22执行 node --test tests/native-runtime.test.js，断言懒激活/项目路径透传/错误传播。
export async function activate(context: vscode.ExtensionContext) {
    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(async (e) => {
        if (e.affectsConfiguration("android-debug")) {
            await android.handlePathsUpdated();
        }
    }));
}
