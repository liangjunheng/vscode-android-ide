import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { ChildProcess, spawn } from 'child_process';
import { adbPath } from './sdk';
import { selectAndroidDebugConfiguration, startAndroidDebugging } from './android-debugger';
import { discoverVariantSources, NativeSourceModule } from './androidProjectModel';

interface Project { id: string; label: string; root: string; wrapper: string; tasks: string[]; }
interface ApkMetadata { applicationId: string; elements?: unknown; }
interface Target { id: string; label: string; module: string; variant: string; assemble: string; install: string; }
interface Operation { controller: AbortController; done: Promise<void>; }
interface OwnedProcess { child: ChildProcess; closed: Promise<void>; termination?: Promise<void>; }
/** 当前 Build 选择解析出的调试源码身份，不包含设备或会话状态。 */
export interface AndroidDebugProject { androidProjectRoot: string; androidModuleRoot: string; androidVariant: string; androidSourceRoots: string[]; androidNativeModules?: NativeSourceModule[]; packageName?: string; androidAbiSupported?: string[]; }
const LIMIT = 256 * 1024;
class Cancelled extends Error { constructor() { super('Operation cancelled'); } }

// 解析真实 tasks 输出并标准化模块路径；npm test real task formats 断言两种前缀及聚合项排除。
export function parseGradleTasks(text: string): string[] {
  const tasks = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(:?[\w.-]+(?::[\w.-]+)*)(?:\s+-.*)?\s*$/.exec(line);
    const task = match && ':' + match[1].replace(/^:/, '');
    if (task && /:(assemble|install)[\w.-]+$/.test(task)) tasks.add(task);
  }
  return [...tasks].sort();
}

// 合并真实 assemble/install 模块变体；npm test refresh/selection 断言目标和默认 Debug。
function buildTargets(tasks: string[]): Target[] {
  const found = new Map<string, Target>();
  for (const task of tasks) {
    const match = /^:(?:(.+):)?(assemble|install)([\w.-]+)$/.exec(task);
    if (!match || /AndroidTest|UnitTest/.test(match[3])) continue;
    const module = match[1] || '';
    const id = ':' + (module ? module + ':' : '') + match[3];
    const item = found.get(id) || { id, label: (module || ':') + ' | ' + match[3], module, variant: match[3], assemble: '', install: '' };
    item[match[2] as 'assemble' | 'install'] = task;
    found.set(id, item);
  }
  return [...found.values()].filter(t => t.assemble && t.install).sort((a, b) => a.id.localeCompare(b.id));
}

// 只解析所选项目/模块/变体的APK metadata；匹配缺失返回undefined，坏JSON/非法ID及IO故障原样抛错，不扫描其他模块。
// 回归：Node>=22，node --test tests/android-build.test.js；current application ID两项断言隔离、切换及缺失/损坏区别，metadata and launcher failures断言run/debug仍拒绝缺失。
function apkMetadataFor(project: Project, target: Target): ApkMetadata | undefined {
  const base = path.join(project.root, ...target.module.split(':'), 'build', 'outputs', 'apk');
  // 递归收集所选模块APK目录内metadata路径；目录不存在为空，其他IO异常不吞，current application ID回归覆盖缺失与多变体。
  const visit = (dir: string): string[] => {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
      const file = path.join(dir, entry.name);
      return entry.isDirectory() ? visit(file) : entry.name === 'output-metadata.json' ? [file] : [];
    });
  };
  for (const file of visit(base)) {
    const meta = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (String(meta.variantName || meta.variant || '').toLowerCase() !== target.variant.toLowerCase()) continue;
    if (!/^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)+$/.test(meta.applicationId || '')) throw new Error('Invalid applicationId in ' + file);
    return meta;
  }
  return undefined;
}

// 保留其他调用方的只读包名契约；android-build.test.js验证多根/模块/变体选择与坏metadata传播。
function applicationIdFor(project: Project, target: Target): string | undefined { return apkMetadataFor(project, target)?.applicationId; }

// 仅从完整ABI split输出集合读取构建约束；universal/缺失保持未知，不用单个split误判整个应用。
// 回归：node --test tests/android-build.test.js验证split、universal、缺失及非法ABI，Native provider再结合设备实际ABI。
function nativeAbisFor(meta: ApkMetadata | undefined): string[] | undefined {
  if (meta?.elements === undefined) return undefined;
  if (!Array.isArray(meta.elements)) throw new Error('Invalid Native APK elements metadata');
  const abis = new Set<string>();
  for (const element of meta.elements) {
    if (!element || typeof element !== 'object') throw new Error('Invalid Native APK output metadata');
    if (element.filters === undefined) return undefined;
    if (!Array.isArray(element.filters)) throw new Error('Invalid Native APK filters metadata');
    const filters = element.filters.filter((filter: any) => filter?.filterType === 'ABI');
    if (!filters.length) return undefined;
    if (filters.length !== 1 || !['armeabi', 'armeabi-v7a', 'arm64-v8a', 'x86', 'x86_64'].includes(filters[0].value)) throw new Error('Invalid Native APK ABI metadata');
    abis.add(filters[0].value);
  }
  return abis.size ? [...abis] : undefined;
}

// 构建运行/外部调试要求所选目标metadata；Native允许先从AGP/设备自动解析。
// 回归：Node>=22，node --test tests/android-build.test.js；metadata and launcher failures验证run/debug缺失报错，run installs selected package验证所选包名及顺序。
function packageFor(project: Project, target: Target): string {
  const applicationId = applicationIdFor(project, target);
  if (applicationId === undefined) throw new Error('No APK metadata for ' + target.label);
  return applicationId;
}

// 管理单一操作、定向安装及输出资源；npm test android-build 回归执行所有动作及生命周期。
export class AndroidBuildController implements vscode.Disposable {
  private projects: Project[] = [];
  private projectId = '';
  private targetId = '';
  private operation?: Operation;
  private child?: OwnedProcess;
  private stopping?: Promise<void>;
  private disposed = false;
  private launched?: { serial: string; packageName: string; cwd: string };
  private debugSession?: vscode.DebugSession;
  private outputText = '';
  private readonly output: vscode.OutputChannel;

  // 保存状态出口并创建输出；npm test output 回归断言显示、截断及释放。
  constructor(private post: (message: any) => void) { this.output = vscode.window.createOutputChannel('Android Build'); }

  // 只读所选项目/模块/变体applicationId，可限定所属workspace；未知交Native/Explorer后备解析，真实故障不吞。
  // 回归：Node>=22，node --test tests/android-build.test.js；current application ID两项断言多根/模块/变体隔离、切换、零副作用、缺失undefined及真实故障抛错。
  private currentApkMetadata(workspaceRoot?: string): ApkMetadata | undefined {
    if (this.disposed) throw new Error('Android build controller is disposed');
    if (!vscode.workspace.isTrusted) throw new Error('Workspace is not trusted');
    const project = this.projects.find(p => p.id === this.projectId);
    const target = buildTargets(project?.tasks || []).find(t => t.id === this.targetId);
    if (!project || !target) return undefined;
    if (workspaceRoot !== undefined) {
      const owner = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(project.root));
      if (!owner || path.resolve(owner.uri.fsPath) !== path.resolve(workspaceRoot)) return undefined;
    }
    return apkMetadataFor(project, target);
  }

  // 只读包名，不因Native ABI筛选改变Explorer行为；android-build.test.js验证当前ID与workspace隔离。
  currentApplicationId(workspaceRoot?: string): string | undefined { return this.currentApkMetadata(workspaceRoot)?.applicationId; }

  // 给Native提供一次读取的所选Gradle包名/ABI约束；android-build.test.js验证split/universal与错误传播。
  currentNativeDebugMetadata(workspaceRoot?: string): { packageName: string; abiSupported?: string[] } | undefined {
    const metadata = this.currentApkMetadata(workspaceRoot);
    if (!metadata) return undefined;
    const abiSupported = nativeAbisFor(metadata);
    return { packageName: metadata.applicationId, ...(abiSupported ? { abiSupported } : {}) };
  }

  // 发布后端拥有的完整快照；npm test refresh/install/run/error 断言选择和状态。
  private state(status: string, error?: string): void {
    const project = this.projects.find(p => p.id === this.projectId);
    this.post({ type: 'buildState', projects: this.projects.map(p => ({ id: p.id, label: p.label })), project: this.projectId,
      targets: buildTargets(project?.tasks || []), target: this.targetId, busy: !!this.operation, running: !!this.launched, status, ...(error ? { error } : {}) });
  }

  // 有界保留日志并更新真实通道；npm test output 回归断言长度和失败诊断。
  private log(text: string): void { this.outputText = (this.outputText + text).slice(-LIMIT); this.output.replace(this.outputText); }

  // 每个异步阶段校验取消和信任；npm test trust/cancel 断言无后续命令及伪成功。
  private check(operation: Operation): void {
    if (operation.controller.signal.aborted) throw new Cancelled();
    if (!vscode.workspace.isTrusted) throw new Error('Workspace is not trusted');
  }

  // adb 保持 argv；Windows 仅允许内部生成的 init-script 路径经固定环境变量传递，其余参数继续严格白名单。
  // 回归：node --test tests/android-build.test.js；source runner/real Windows 验证空格、精确脚本、注入拒绝和 close 后清理。
  private async run(operation: Operation, command: string, args: string[], cwd: string, env = process.env, generatedInitScript?: string): Promise<string> {
    this.check(operation);
    const bat = process.platform === 'win32' && path.basename(command).toLowerCase() === 'gradlew.bat';
    if (generatedInitScript !== undefined && (args[0] !== '--init-script' || args[1] !== generatedInitScript || args.filter(arg => arg === '--init-script').length !== 1 || !path.isAbsolute(generatedInitScript) || /[\x00-\x1f\x7f"]/.test(generatedInitScript) || !fs.lstatSync(generatedInitScript).isFile())) throw new Error('Invalid generated Gradle init script');
    if (bat && args.some((arg, index) => !(generatedInitScript !== undefined && index === 1) && !/^[\w:=-]+$/.test(arg))) throw new Error('Unsafe Gradle argument');
    const tokens = args.map((arg, index) => generatedInitScript !== undefined && index === 1 ? '"%DSH_SOURCE_INDEX_INIT_PATH%"' : arg);
    const childEnv = generatedInitScript === undefined ? env : { ...Object.fromEntries(Object.entries(env).filter(([key]) => key.toUpperCase() !== 'DSH_SOURCE_INDEX_INIT_PATH')), DSH_SOURCE_INDEX_INIT_PATH: generatedInitScript };
    const child = bat
      ? spawn('cmd.exe', ['/d', '/v:off', '/s', '/c', 'gradlew.bat ' + tokens.join(' ')], { cwd, env: childEnv, shell: false, windowsHide: true, windowsVerbatimArguments: true })
      : spawn(command, args, { cwd, env: childEnv, shell: false, windowsHide: true, detached: process.platform !== 'win32' });
    let text = '', launchError: Error | undefined;
    const closed = new Promise<void>(resolve => child.once('close', () => resolve()));
    const owned = { child, closed };
    this.child = owned;
    this.log('> ' + path.basename(command) + ' ' + args.join(' ') + '\n');
    try {
      return await new Promise<string>((resolve, reject) => {
        const append = (chunk: Buffer | string) => { const value = chunk.toString(); text = (text + value).slice(-LIMIT); this.log(value); };
        child.stdout?.on('data', append); child.stderr?.on('data', append);
        child.once('error', error => { launchError = error; });
        child.once('close', code => {
          if (operation.controller.signal.aborted) reject(new Cancelled());
          else if (launchError) reject(launchError);
          else if (code !== 0) reject(new Error('Command failed (' + code + '): ' + text));
          else resolve(text);
        });
      });
    } finally { if (this.child === owned) this.child = undefined; }
  }

  // 终止拥有的进程树并等待 close；npm test cancel/Windows 用 EventEmitter 断言关闭前不完成。
  private terminate(owned: OwnedProcess): Promise<void> { return owned.termination ||= this.terminateProcess(owned); }

  // 同一 child 的停止由 terminate 共享；provider abort/Stop/dispose 并发时只发一次 kill 并等待真实 close。
  // 回归：node --test tests/android-build.test.js；provider cancellation 与原 cancel/Windows 断言关闭前不完成。
  private async terminateProcess(owned: OwnedProcess): Promise<void> {
    const child = owned.child;
    if (child.exitCode === null && child.signalCode == null) {
      if (!child.pid) throw new Error('Cannot cancel process without pid');
      if (process.platform === 'win32') {
        await new Promise<void>((resolve, reject) => {
          const killer = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { shell: false, windowsHide: true });
          killer.once('error', reject);
          killer.once('close', code => code === 0 || child.exitCode !== null ? resolve() : reject(new Error('taskkill failed: ' + code)));
        });
      } else { process.kill(-child.pid, 'SIGTERM'); }
    }
    await owned.closed;
  }

  // 发现工作区 wrapper 并读取实际 task 集合；npm test refresh 覆盖空项目、多根及有效选择保留。
  private async discover(operation: Operation): Promise<void> {
    const files = await vscode.workspace.findFiles('**/{settings.gradle,settings.gradle.kts,gradlew,gradlew.bat}', '**/{node_modules,.git,.gradle,build}/**');
    this.check(operation);
    const roots = [...new Set(files.map(uri => path.dirname(uri.fsPath)))].sort();
    const projects: Project[] = [];
    for (const root of roots) {
      const wrapper = path.join(root, process.platform === 'win32' ? 'gradlew.bat' : 'gradlew');
      if (!fs.existsSync(wrapper)) throw new Error('No Gradle Wrapper in ' + root);
      const text = await this.run(operation, wrapper, ['tasks', '--all', '--console=plain'], root);
      projects.push({ id: root, label: path.basename(root), root, wrapper, tasks: parseGradleTasks(text) });
    }
    this.check(operation);
    this.projects = projects;
    if (!projects.some(p => p.id === this.projectId)) this.projectId = projects[0]?.id || '';
    this.chooseDefault();
  }

  // 只选择真实变体，优先 Debug；npm test refresh/selection 断言默认项和非法输入。
  private chooseDefault(): void {
    const targets = buildTargets(this.projects.find(p => p.id === this.projectId)?.tasks || []);
    if (!targets.some(t => t.id === this.targetId)) this.targetId = targets.find(t => t.variant.toLowerCase() === 'debug')?.id || targets[0]?.id || '';
  }

  // 由统一调试选择器展示内置Native和外部配置；取消不触发安装或调试。回归：android-build.test.js。
  private async debugConfiguration(project: Project): Promise<vscode.DebugConfiguration | undefined> {
    const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(project.root));
    return selectAndroidDebugConfiguration(folder);
  }

  /**
   * 读取精确AGP模型的applicationId、源码根、moduleRoot和Native图；已知APK包名必须匹配，未知时优先AGP包名。
   * nativeModules 缺失保持未知/旧契约，显式 [] 保持已知无 Native 模块；不构建、不安装、不猜约定目录。
   * 回归：node --test tests/android-build.test.js；source discovery/provider native graph 用例验证精确身份、缺失/空图、ID冲突、IO失败与取消。
   */
  private async discoverDebugProject(operation: Operation, project: Project, target: Target, packageName?: string): Promise<AndroidDebugProject> {
    const variant = target.variant[0].toLowerCase() + target.variant.slice(1);
    const model = await discoverVariantSources({ projectRoot: project.root, modulePath: target.module ? ':' + target.module : ':', variant, wrapper: project.wrapper },
      (command: string, args: string[], cwd: string) => this.run(operation, command, args, cwd, process.env, args[1]), operation.controller.signal);
    this.check(operation);
    if (packageName !== undefined && model.applicationId !== undefined && model.applicationId !== packageName) throw new Error('Source index applicationId does not match selected APK metadata');
    const androidSourceRoots = model.roots.filter(root => root.kind === 'java' || root.kind === 'kotlin').flatMap(root => {
      try { if (!fs.statSync(root.path).isDirectory()) throw new Error('Android source root is not a directory: ' + root.path); return [root.path]; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
    });
    const androidAbiSupported = nativeAbisFor(apkMetadataFor(project, target));
    return { androidProjectRoot: project.root, androidModuleRoot: model.moduleRoot, androidVariant: variant, androidSourceRoots,
      ...(androidAbiSupported ? { androidAbiSupported } : {}),
      ...((model.applicationId ?? packageName) ? { packageName: model.applicationId ?? packageName } : {}),
      ...(model.nativeModules === undefined ? {} : { androidNativeModules: model.nativeModules }) };
  }

  /**
   * 为 Attach 解析当前 Build 选择的源码身份；必须匹配调用方 workspace 与 APK 包名，无选择/错包时明确要求用户选择。
   * 独占 Operation 桥接外部取消，等待 child close 后释放临时脚本；不安装/启动/缓存项目结果。
   * 回归：node --test tests/android-build.test.js；provider selection/failures/cancellation/native graph 验证精确身份、可选图转发、取消无旧图、互斥及释放。
   */
  async resolveCurrentDebugProject(packageName: string, workspaceRoot: string, signal: AbortSignal): Promise<AndroidDebugProject> {
    if (this.disposed) throw new Error('Android build controller is disposed');
    if (!vscode.workspace.isTrusted) throw new Error('Workspace is not trusted');
    signal.throwIfAborted();
    if (this.operation || this.stopping) throw new Error('An Android operation is already running');
    const project = this.projects.find(item => item.id === this.projectId);
    const target = buildTargets(project?.tasks || []).find(item => item.id === this.targetId);
    if (!project || !target) throw new Error('Select a Gradle project and Android variant in Build before Attach.');
    const owner = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(project.root));
    if (!path.isAbsolute(workspaceRoot) || !owner || path.resolve(owner.uri.fsPath) !== path.resolve(workspaceRoot)) throw new Error('Select a Build project and Android variant in the chosen workspace before Attach.');
    if (packageFor(project, target) !== packageName) throw new Error('Select the Build project and Android variant matching package ' + packageName + ' before Attach.');
    const operation: Operation = { controller: new AbortController(), done: Promise.resolve() };
    this.operation = operation;
    let result: AndroidDebugProject | undefined;
    let cancellation: Promise<{ error?: unknown }> | undefined;
    // 取消回调只请求拥有的 child 终止，结果由方法末尾观察，避免异步事件抛错或提前释放资源。
    const abort = (): void => {
      operation.controller.abort(signal.reason);
      if (this.child) cancellation = this.terminate(this.child).then(() => ({}), error => ({ error }));
    };
    signal.addEventListener('abort', abort, { once: true });
    operation.done = (async () => { this.check(operation); result = await this.discoverDebugProject(operation, project, target, packageName); this.check(operation); })();
    let failure: unknown;
    try { await operation.done; }
    catch (error) { failure = error; }
    finally {
      signal.removeEventListener('abort', abort);
      const closed = await cancellation;
      if (closed?.error) failure = failure ? new AggregateError([failure, closed.error], String(failure) + '; ' + String(closed.error)) : closed.error;
      if (this.operation === operation) this.operation = undefined;
    }
    if (failure) throw failure;
    return result!;
  }

  // 内置Native直接调试现有应用，只读metadata且不运行Gradle安装/源码发现；其他动作保留原流程。
  // 回归：Node>=22运行node --test tests/android-build.test.js，断言内置零Gradle/零模型、准确设备包名/ABI、缺metadata设备解析及取消/停止。
  private async execute(operation: Operation, action: string, serial?: string): Promise<string> {
    if (action === 'refresh') { await this.discover(operation); return this.projects.length ? 'Ready' : 'No Gradle project'; }
    const project = this.projects.find(p => p.id === this.projectId);
    const target = buildTargets(project?.tasks || []).find(t => t.id === this.targetId);
    if (!project || !target) throw new Error('Select a Gradle project and Android variant first.');
    if (action === 'build') { await this.run(operation, project.wrapper, [target.assemble, '--console=plain'], project.root); return 'Build succeeded'; }
    if (!serial || !/^[\w.:-]+$/.test(serial)) throw new Error('Select an online device serial first.');
    const config = action === 'debug' ? await this.debugConfiguration(project) : undefined;
    this.check(operation);
    if (action === 'debug' && !config) return 'Debug cancelled';
    const online = await this.run(operation, adbPath(), ['-s', serial, 'get-state'], project.root);
    if (online.trim() !== 'device') throw new Error('Device is not online: ' + serial);
    const nativeDebug = action === 'debug' && config?.type === 'android-tools';
    if (!nativeDebug) await this.run(operation, project.wrapper, [target.install, '--console=plain'], project.root, { ...process.env, ANDROID_SERIAL: serial });
    if (action === 'install') return 'Install succeeded';
    const metadata = nativeDebug ? apkMetadataFor(project, target) : undefined;
    let packageName = nativeDebug ? config!.packageName ?? metadata?.applicationId : packageFor(project, target);
    this.check(operation);
    if (action === 'run') {
      if (!packageName) throw new Error('No applicationId for selected variant');
      const result = await this.run(operation, adbPath(), ['-s', serial, 'shell', 'monkey', '-p', packageName, '-c', 'android.intent.category.LAUNCHER', '1'], project.root);
      if (/monkey aborted|no activities found|error:/i.test(result)) throw new Error(result);
    } else {
      const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(project.root));
      let debugConfig = config!;
      if (nativeDebug) {
        const abiSupported = config!.androidAbiSupported ?? nativeAbisFor(metadata);
        debugConfig = { ...config!, androidProjectRoot: config!.androidProjectRoot ?? project.root, ...(abiSupported ? { androidAbiSupported: abiSupported } : {}) };
      }
      packageName ||= debugConfig.packageName;
      const requested = { ...debugConfig, serial, packageName };
      const listener = vscode.debug.onDidStartDebugSession(session => {
        if (session.configuration.name === requested.name && session.configuration.type === requested.type && session.configuration.serial === serial && (packageName === undefined || session.configuration.packageName === packageName)) this.debugSession = session;
      });
      try {
        const mode = config!.androidMode === 'kotlin-java' || config!.androidMode === 'native' || config!.androidMode === 'jvm-native'
          ? config!.androidMode
          : undefined;
        this.debugSession = await startAndroidDebugging(folder, debugConfig, { serial, packageName, signal: operation.controller.signal, ...(mode ? { mode } : {}) });
        const ok = !!this.debugSession;
        if (!ok) throw new Error('Debug adapter rejected the configuration.');
        packageName ||= this.debugSession?.configuration.packageName;
        if (!packageName) throw new Error('Debug session did not resolve applicationId');
        this.check(operation);
      } catch (error) {
        if (this.debugSession) { await vscode.debug.stopDebugging(this.debugSession); this.debugSession = undefined; }
        throw error;
      } finally { listener.dispose(); }
    }
    if (!packageName) throw new Error('No applicationId for selected variant');
    this.launched = { serial, packageName, cwd: project.root };
    return action === 'debug' ? 'Debug started' : 'Running';
  }

  // 用 operation 所有权拒绝重入，状态始终反馈；npm test reentry/stop/dispose 回归验证取消与失败。
  async handle(message: any, serial?: string): Promise<void> {
    if (this.disposed) throw new Error('Android build controller is disposed');
    if (!message || message.type !== 'buildPanel' || !['refresh', 'project', 'target', 'build', 'install', 'run', 'debug', 'stop', 'output'].includes(message.action)) throw new Error('Invalid build panel action');
    if (message.action === 'output') { this.output.show(true); return; }
    if (message.action === 'stop') { return this.stop(); }
    if (this.operation || this.stopping) throw new Error('An Android operation is already running');
    if (!vscode.workspace.isTrusted) { const error = 'Workspace is not trusted'; this.state('Unavailable', error); throw new Error(error); }
    if (message.action === 'project' || message.action === 'target') {
      const project = this.projects.find(p => p.id === message.value);
      if (message.action === 'project') { if (!project) throw new Error('Invalid project selection'); this.projectId = project.id; this.chooseDefault(); }
      else { const targets = buildTargets(this.projects.find(p => p.id === this.projectId)?.tasks || []); if (!targets.some(t => t.id === message.value)) throw new Error('Invalid target selection'); this.targetId = message.value; }
      this.state('Ready'); return;
    }
    if (this.launched && ['run', 'debug'].includes(message.action)) throw new Error('Stop the current app before starting another run.');
    const operation: Operation = { controller: new AbortController(), done: Promise.resolve() };
    this.operation = operation;
    this.state(message.action === 'refresh' ? 'Discovering Gradle tasks' : message.action + ': ' + this.targetId);
    operation.done = (async () => {
      try { const status = await this.execute(operation, message.action, serial); this.check(operation); this.operation = undefined; this.state(status); }
      catch (error) { this.operation = undefined; this.state(error instanceof Cancelled ? 'Cancelled' : 'Failed', error instanceof Cancelled ? undefined : String(error)); throw error; }
    })();
    return operation.done;
  }

  // 并发停止共享清理 Promise；npm test stop/cancel 断言指定进程/应用包且取消不启动下一步骤。
  private stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.stopping = (async () => {
      const operation = this.operation;
      if (operation) {
        operation.controller.abort();
        if (this.child) await this.terminate(this.child);
        try { await operation.done; } catch (error) { if (!(error instanceof Cancelled)) throw error; }
      }
      if (this.debugSession) { await vscode.debug.stopDebugging(this.debugSession); this.debugSession = undefined; }
      if (this.launched) {
        const app = this.launched;
        const cleanup: Operation = { controller: new AbortController(), done: Promise.resolve() };
        await this.run(cleanup, adbPath(), ['-s', app.serial, 'shell', 'am', 'force-stop', app.packageName], app.cwd);
        this.launched = undefined;
      }
      this.state('Stopped');
    })().finally(() => { this.stopping = undefined; });
    return this.stopping;
  }

  // 停用等待本控制器拥有的进程关闭再释放输出；npm test dispose 回归断言关闭及资源顺序。
  async dispose(): Promise<void> { this.disposed = true; try { await this.stop(); } finally { this.output.dispose(); } }
}
