import { execFile } from 'node:child_process';

/** ADB使用argv、30秒命令边界和调用方取消信号；native-target.test.js验证超时参数、取消及原始错误cause。 */
export function adbExec(adb: string, serial: string, args: string[], signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(adb, ['-s', serial, ...args], { windowsHide: true, maxBuffer: 64 * 1024 * 1024, timeout: 30000, signal }, (error, stdout, stderr) => {
      if (error) reject(new Error(String(stderr || stdout || error.message).trim(), { cause: error })); else resolve(String(stdout));
    });
  });
}

/** 按上游 launchApp 的 MAIN/LAUNCHER 语义解析默认 Activity；显式 activity 不访问解析命令。
 * 回归：node --test tests/native-target.test.js验证真实解析，native-codelldb.test.js验证解析结果用于lldb child。 */
export async function resolveLauncherActivity(adb: string, serial: string, packageName: string, signal?: AbortSignal): Promise<string> {
  const output = await adbExec(adb, serial, ['shell', 'cmd', 'package', 'resolve-activity', '--brief', '-a', 'android.intent.action.MAIN', '-c', 'android.intent.category.LAUNCHER', packageName], signal);
  const line = output.split(/\r?\n/).map(value => value.trim()).find(value => value.startsWith(packageName + '/'));
  if (!line) throw new Error('Unable to resolve launcher activity for ' + packageName);
  return line.slice(packageName.length + 1);
}
