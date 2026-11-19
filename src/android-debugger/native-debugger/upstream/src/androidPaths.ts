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
 * 保留上游懒激活入口但不再监听已移除的 android-debug settings；工具链按会话配置即时解析。
 * 回归：Node>=22执行 node --test tests/native-runtime.test.js，断言激活不读取设置且项目路径错误仍传播。
 */
export async function activate(_context: { subscriptions?: unknown[] }) {
    return;
}
