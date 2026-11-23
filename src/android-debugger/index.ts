import * as vscode from 'vscode';
import { omitAuto } from './autoConfig';
import { debugCancellationToken, registerDebugStartup, waitDebugConnection } from './startup';

export interface AndroidDebugTarget {
  serial: string;
  pid?: number;
  processId?: number;
  packageName?: string;
  mode?: string;
  signal?: AbortSignal;
  onStartupCleanup?: (cleanup: Promise<void>) => void;
}

/** 功能：返回六种内置配置的独立副本；输入无；输出Native/JVM/Dual的Launch与Attach模板。 */
export function getAndroidDebugConfigurations(): vscode.DebugConfiguration[] {
  return ['native', 'java', 'dual'].flatMap(mode => ['launch', 'attach'].map(request => ({
    type: 'android-debug', name: `Android: ${mode === 'native' ? 'Native' : mode === 'java' ? 'JVM' : 'Dual(Native and JVM)'} Debug ${request === 'launch' ? 'Launch' : 'Attach'}`,
    request, mode, target: 'auto', ...(request === 'launch' ? { apkPath: 'auto', packageName: 'auto', launchActivity: 'auto' } : { pid: 'auto' }),
    ...(mode !== 'java' ? { native: { ...(request === 'launch' ? { abi: 'auto', symbolSearchPaths: [] } : {}) } } : {}),
    ...(mode !== 'native' ? { java: { type: 'android-jvm', name: 'Android JVM', adapterJvmArgs: [], ...(request === 'launch' ? { sourcePaths: 'auto' } : {}) } } : {}),
  })));
}

/** 功能：读取工作区有效外部配置；输入工作区；输出按内容去重的Launch与Attach配置。 */
function external(folder?: vscode.WorkspaceFolder): vscode.DebugConfiguration[] {
  const seen = new Set<string>();
  return vscode.workspace.getConfiguration('launch', folder?.uri).get<vscode.DebugConfiguration[]>('configurations', []).filter(config => {
    if (!config || typeof config.type !== 'string' || typeof config.name !== 'string' || !['launch', 'attach'].includes(config.request)) return false;
    const key = JSON.stringify(config);
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
}

/** 功能：取得默认Native配置或同名用户配置；输入工作区及内置选择；输出独立配置选择。 */
export function findAndroidDebugConfiguration(folder?: vscode.WorkspaceFolder, builtIn = false): vscode.DebugConfiguration {
  const initial = getAndroidDebugConfigurations()[0];
  return !builtIn ? external(folder).find(config => config.name === initial.name) ?? initial : initial;
}

/** 功能：选择内置或外部调试配置；输入请求筛选和取消信号；输出所选原配置，取消不启动。 */
export async function selectAndroidDebugConfiguration(folder?: vscode.WorkspaceFolder, request?: 'launch' | 'attach', signal?: AbortSignal): Promise<vscode.DebugConfiguration | undefined> {
  signal?.throwIfAborted();
  const builtIn = getAndroidDebugConfigurations(), configured = external(folder);
  const matching = configured.filter(config => builtIn.some(item => item.name === config.name) && (!request || config.request === request));
  const configs = request === 'attach' ? [...builtIn.filter(config => config.request === 'attach'), ...configured] : (matching.length ? matching : builtIn).filter(config => !request || config.request === request);
  const selected = await vscode.window.showQuickPick(configs.map(config => ({ label: config.name, description: config.type, config })), { placeHolder: 'Select Android debug configuration' }, signal ? debugCancellationToken(signal) : undefined);
  signal?.throwIfAborted(); return selected?.config;
}

/** 功能：绑定明确设备与可选进程；输入用户配置和目标；输出不改变原配置的启动副本。 */
export function createAndroidDebugConfiguration(input: vscode.DebugConfiguration, target: AndroidDebugTarget): vscode.DebugConfiguration {
  const config = omitAuto(input), pid = target.pid ?? target.processId;
  if (!config.type || !['launch', 'attach'].includes(config.request)) throw new Error('Invalid Android debug configuration');
  if (!target.serial || !/^[\w.:-]+$/.test(target.serial)) throw new Error('Invalid Android device serial');
  if ([target.pid, target.processId].some(value => value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) || (target.pid !== undefined && target.processId !== undefined && target.pid !== target.processId)) throw new Error('Invalid Android process id');
  for (const key of ['pid', 'processId']) {
    const value = config[key];
    if (value !== undefined && !String(value).includes('${') && (!/^\d+$/.test(String(value)) || !Number.isSafeInteger(Number(value)) || Number(value) <= 0)) throw new Error('Invalid Android process id');
  }
  if (config.pid !== undefined && config.processId !== undefined && !String(config.pid).includes('${') && !String(config.processId).includes('${') && Number(config.pid) !== Number(config.processId)) throw new Error('Conflicting Android process ids');
  const mode = target.mode ?? config.mode ?? config.androidMode ?? 'native';
  if (['android-debug', 'android-tools'].includes(config.type) && (!['native', 'java', 'dual'].includes(mode) || (config.type === 'android-tools' && mode !== 'native'))) throw new Error('Unsupported Android debug mode');
  return { ...config, serial: target.serial, ...(target.packageName && !config.packageName ? { packageName: target.packageName } : {}),
    ...(['android-debug', 'android-tools'].includes(config.type) ? { target: target.serial, mode } : {}),
    ...(pid !== undefined ? { request: 'attach', pid, processId: pid } : {}) };
}

/** 功能：启动真实调试会话并处理取消后的迟到会话；输入配置和设备；输出真实会话，清理通过独立Promise观察。 */
export async function startAndroidDebugging(folder: vscode.WorkspaceFolder | undefined, config: vscode.DebugConfiguration, target: AndroidDebugTarget): Promise<vscode.DebugSession> {
  if (!vscode.workspace.isTrusted) throw new Error('Workspace is not trusted');
  const signal = target.signal ?? new AbortController().signal;
  signal.throwIfAborted();
  const mapped = createAndroidDebugConfiguration(config, target), unregister = registerDebugStartup(mapped, signal);
  const owned = new Map<string, { session: vscode.DebugSession; ended: boolean; stopped?: Promise<void>; exit: Promise<void>; end(): void }>();
  let started: vscode.DebugSession | undefined;
  const stop = () => {
    for (const value of owned.values()) if (!value.ended && !value.stopped) {
      value.stopped = Promise.resolve(vscode.debug.stopDebugging(value.session)).then(() => value.exit);
      void value.stopped.catch(error => console.warn('W: Android startup cleanup failed', error));
    }
  };
  const startListener = vscode.debug.onDidStartDebugSession(session => {
    const resolved = session.configuration;
    const explicit = target.pid ?? target.processId ?? mapped.pid ?? mapped.processId;
    const pid = explicit !== undefined && /^\d+$/.test(String(explicit)) ? Number(explicit) : undefined;
    if (resolved.pid !== undefined && resolved.processId !== undefined && Number(resolved.pid) !== Number(resolved.processId)) return;
    if (session.parentSession || resolved.name !== mapped.name || resolved.serial !== mapped.serial || (mapped.packageName && resolved.packageName !== mapped.packageName) || (pid !== undefined && Number(resolved.pid ?? resolved.processId) !== pid) || owned.has(session.id)) return;
    let end!: () => void;
    owned.set(session.id, { session, ended: false, exit: new Promise(resolve => { end = resolve; }), end: () => end() });
    started ??= session; if (signal.aborted) stop();
  });
  const endListener = vscode.debug.onDidTerminateDebugSession(session => { const value = owned.get(session.id); if (value) { value.ended = true; value.end(); } });
  let abort!: () => void;
  const cancelled = new Promise<never>((_, reject) => { abort = () => { stop(); reject(signal.reason); }; signal.addEventListener('abort', abort, { once: true }); });
  const starting = Promise.resolve().then(async () => {
    signal.throwIfAborted();
    if (!await vscode.debug.startDebugging(folder, mapped)) throw new Error('Android debug session did not start');
    await waitDebugConnection(mapped);
    signal.throwIfAborted();
    if (!started || owned.get(started.id)?.ended) throw new Error('Android debug session did not report a live start');
  });
  const cleanup = starting.catch(() => { stop(); }).then(async () => {
    let size = -1;
    while (size !== owned.size) { size = owned.size; await Promise.all([...owned.values()].map(value => value.stopped)); }
  }).finally(() => {
    signal.removeEventListener('abort', abort); startListener.dispose(); endListener.dispose(); unregister();
  });
  void cleanup.catch(error => console.warn('W: Android startup cleanup failed', error));
  target.onStartupCleanup?.(cleanup);
  await Promise.race([starting, cancelled]); await cleanup;
  try { await vscode.commands.executeCommand('workbench.view.debug'); }
  catch (error) { console.warn('W: Debug session started but Run and Debug could not be opened', error); }
  return started!;
}

export const androidDebugger = { startAndroidDebugging };
