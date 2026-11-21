import { adbExec } from './native-debugger/nativeTarget';

// 创建指定或动态JDWP forward并校验端口；ADB未返回动态端口时终止本次会话，由用户重试，绝不猜测删除共享映射。
export async function createJdwpForward(adb: string, serial: string, pid: number, requestedPort: number, signal?: AbortSignal): Promise<{ port: number; cleanup: () => Promise<void> }> {
  if (!Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65535) throw new Error('Invalid Android JVM port; use 0 for a dynamic port');
  const output = await adbExec(adb, serial, ['forward', `tcp:${requestedPort}`, `jdwp:${pid}`], signal);
  const port = requestedPort || Number(output.trim());
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('ADB did not return a valid dynamic JDWP port. Stop debugging and retry.');
  return { port, cleanup: async () => { await adbExec(adb, serial, ['forward', '--remove', `tcp:${port}`]); } };
}
