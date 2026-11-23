import type * as vscode from 'vscode';

type Startup = { config: vscode.DebugConfiguration; signal: AbortSignal; connected: Promise<void>; resolve(): void; reject(error: unknown): void };
const pending = new Set<Startup>();

/** 功能：把启动取消传给宿主选择控件；输入取消信号；输出可释放的宿主取消令牌。 */
export function debugCancellationToken(signal: AbortSignal): vscode.CancellationToken {
  return {
    get isCancellationRequested() { return signal.aborted; },
    onCancellationRequested(listener, thisArgs, disposables) {
      const abort = () => listener.call(thisArgs, undefined);
      signal.addEventListener('abort', abort, { once: true });
      const disposable = { dispose: () => signal.removeEventListener('abort', abort) };
      disposables?.push(disposable);
      return disposable;
    },
  };
}

/** 功能：登记一次配置启动调用；输入配置和取消信号；输出注销函数，拒绝重复的在途启动。 */
export function registerDebugStartup(config: vscode.DebugConfiguration, signal: AbortSignal): () => void {
  if (debugStartupSignal(config)) throw new Error('Android debugger is already starting');
  let resolve!: () => void, reject!: (error: unknown) => void;
  const connected = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  void connected.catch(() => undefined);
  const value = { config, signal, connected, resolve, reject };
  const abort = () => reject(signal.reason);
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  pending.add(value);
  return () => { signal.removeEventListener('abort', abort); pending.delete(value); };
}

/** 功能：关联真实调试连接结果；输入启动配置及连接Promise；输出调用方可等待的实际附加结果。 */
export function reportDebugConnection(config: vscode.DebugConfiguration, connected: Promise<void>): void {
  const operation = [...pending].find(value => value.config.name === config.name && value.config.serial === config.serial);
  if (operation) void connected.then(operation.resolve, operation.reject);
}

/** 功能：等待已登记的真实连接；输入配置；输出附加及配置结果，外部调试器由宿主结果负责。 */
export async function waitDebugConnection(config: vscode.DebugConfiguration): Promise<void> {
  if (config.type === 'android-debug' || config.type === 'android-tools' || (config.type === 'android-jvm' && config.android)) {
    const operation = [...pending].find(value => value.config.name === config.name && value.config.serial === config.serial);
    if (!operation) throw new Error('Android startup is not registered');
    await operation.connected;
  }
}

/** 功能：读取配置调用方取消；输入宿主配置；输出对应启动信号，不修改用户字段。 */
export function debugStartupSignal(config: vscode.DebugConfiguration): AbortSignal | undefined {
  return [...pending].find(value => value.config.name === config.name && value.config.serial === config.serial)?.signal;
}
