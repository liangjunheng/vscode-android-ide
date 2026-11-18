import * as vscode from 'vscode';

/** 保留内置适配器工厂接口及注册形状；输入扩展上下文，返回不分配资源的工厂。直接启动内置会话时明确拒绝，避免静默 DAP 挂起；stub 回归断言未实现错误。 */
export function createAndroidDebugAdapterFactory(_context?: vscode.ExtensionContext): vscode.DebugAdapterDescriptorFactory {
  return {
    // 暂无内置后端，不能返回丢弃请求的伪适配器。
    createDebugAdapterDescriptor() { throw new Error('Android 内置调试功能暂未实现'); },
  };
}
