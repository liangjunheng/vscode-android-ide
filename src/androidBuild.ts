import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { ChildProcess, spawn } from 'child_process';
import { adbPath } from './sdk';
import { getAndroidDebugConfigurations, selectAndroidDebugConfiguration, startAndroidDebugging } from './android-debugger';
import { discoverVariantSources, NativeSourceModule } from './androidProjectModel';
import { GradleToolingClient } from './gradleTooling';

interface Project { id: string; label: string; root: string; wrapper: string; tasks: string[]; }
interface ApkMetadata { applicationId: string; elements?: unknown; }
interface Target { id: string; label: string; module: string; variant: string; assemble: string; install: string; }
interface RunMode { id: string; label: string; action: 'run' | 'debug'; config?: vscode.DebugConfiguration; }
interface Operation { controller: AbortController; done: Promise<void>; action?: string; }
interface OwnedProcess { child: ChildProcess; closed: Promise<void>; termination?: Promise<void>; }
interface GradleProjectCache { projects: { root: string; tasks: string[] }[]; }
const GRADLE_CACHE_KEY = 'android-ide.gradleProjects.v1';
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

// 为Gradle项目发现错误补充根目录、Wrapper命令和原始输出；回归由android-build.test.js的失败重试用例断言。
function gradleDiscoveryError(root: string, wrapper: string, error: unknown): Error {
  const detail = error instanceof Error ? error.message : String(error);
  return new Error('Gradle Project discovery failed in ' + root + ' via Tooling API (' + path.basename(wrapper) + ' distribution): ' + detail);
}

// 只解析所选项目/模块/变体的APK metadata；匹配缺失返回undefined，坏JSON/非法ID及IO故障原样抛错，不扫描其他模块。
// 回归：Node>=22，node --test tests/android-build.test.js；current application ID两项断言隔离、切换及缺失/损坏区别，metadata and launcher failures断言Run拒绝缺失而Debug不强制要求metadata。
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

// 显式Run和精确项目模型查询要求所选目标metadata；Debug不依赖此必填契约。
// 回归：node --test tests/android-build.test.js；metadata and launcher failures验证Run缺失报错而外部Debug不受影响，run installs selected package验证定向包名。
function packageFor(project: Project, target: Target): string {
  const applicationId = applicationIdFor(project, target);
  if (applicationId === undefined) throw new Error('No APK metadata for ' + target.label);
  return applicationId;
}

// 管理单一操作、定向安装及输出资源；npm test android-build 回归执行所有动作及生命周期。
export class AndroidBuildController implements vscode.Disposable {
  private projects: Project[] = [];
  private cachedProjects?: Project[];
  private initialization?: Promise<void>;
  private projectId = '';
  private targetId = '';
  private operation?: Operation;
  private child?: OwnedProcess;
  private stopping?: Promise<void>;
  private disposed = false;
  private launched?: { serial: string; packageName: string; cwd: string };
  private debugSession?: vscode.DebugSession;
  private debugTermination?: vscode.Disposable;
  private runModeId = 'run';
  private outputText = '';
  private snapshot?: Record<string, any>;
  private readonly output: vscode.OutputChannel;
  private readonly tooling: GradleToolingClient;

  // 保存状态出口；调试会话监听在启动前建立并在所属会话终止后释放，避免错过立即终止事件。
  // 回归：node --test tests/android-build.test.js，验证立即终止后可重入且不误停其他会话。
  constructor(private post: (message: any) => void, extensionPath: string, private readonly workspaceState?: vscode.Memento) {
    this.output = vscode.window.createOutputChannel('Android Build');
    this.tooling = new GradleToolingClient(extensionPath);
  }

  // 一次性初始化共享Promise，重复调用不重新读取旧缓存或启动查询；android-build初始化重复调用回归验证。
  initialize(): Promise<void> {
    return this.initialization ??= this.restoreAndRefresh();
  }

  // 受信任工作区的成功缓存仅用于界面loading回显，坏缓存明确失败；android-build缓存隔离与异常状态回归验证。
  private async restoreAndRefresh(): Promise<void> {
    if (this.disposed) throw new Error('Android build controller is disposed');
    if (!vscode.workspace.isTrusted) return this.handle({ type: 'buildPanel', action: 'refresh' });
    try {
      const cached = this.workspaceState?.get<GradleProjectCache>(GRADLE_CACHE_KEY);
      if (cached !== undefined) {
        if (!cached || !Array.isArray(cached.projects) || cached.projects.some(project => !project || typeof project.root !== 'string' || !path.isAbsolute(project.root)
          || !Array.isArray(project.tasks) || project.tasks.some(task => typeof task !== 'string' || !/^:(?:[^:\r\n]+:)*[^:\r\n]+$/.test(task)))) throw new Error('Invalid Gradle project cache');
        const folders = vscode.workspace.workspaceFolders?.map(folder => path.resolve(folder.uri.fsPath)) || [];
        this.cachedProjects = cached.projects.filter(project => folders.some(folder => {
          const relative = path.relative(folder, project.root);
          return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep));
        })).map(project => ({ id: project.root, label: path.basename(project.root), root: project.root,
          wrapper: path.join(project.root, process.platform === 'win32' ? 'gradlew.bat' : 'gradlew'), tasks: project.tasks }));
        this.projectId = this.cachedProjects[0]?.id || '';
        this.chooseDefault(this.cachedProjects);
      }
    } catch (error) {
      this.cachedProjects = undefined;
      this.projects = [];
      this.projectId = ''; this.targetId = '';
      this.state('Failed', String(error));
      throw error;
    }
    return this.handle({ type: 'buildPanel', action: 'refresh' });
  }

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

  // 发布并保存两侧共用的项目、风味和运行快照；node --test tests/android-build.test.js 的 sync 回归断言晚订阅、忙碌、错误和停止原样回放。
  private state(status: string, error?: string): void {
    const projects = this.cachedProjects ?? this.projects;
    const project = projects.find(p => p.id === this.projectId);
    const targets = buildTargets(project?.tasks || []);
    const target = targets.find(item => item.id === this.targetId);
    const applicationLabel = target ? (target.module || ':').replace(/^:/, '') + ' | ' + target.variant : project?.label || 'Application';
    const runModes = getAndroidDebugConfigurations().map((config, index) => ({ id: 'debug-' + index, label: config.name, action: 'debug' as const }));
    this.snapshot = { type: 'buildState', projects: projects.map(p => ({ id: p.id, label: p.label })), project: this.projectId,
      targets, target: this.targetId, runMode: this.runModeId, runModes: [{ id: 'run', label: applicationLabel, action: 'run' as const }, ...runModes], busy: !!this.operation, running: !!this.launched || !!this.debugSession, status, ...(error ? { error } : {}) };
    this.post(this.snapshot);
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

  // 通过长驻Tooling API读取通用项目任务，每次刷新查询真实模型；android-build与gradle-tooling测试验证复用、失败和取消。
  private async discover(operation: Operation): Promise<void> {
    const files = await vscode.workspace.findFiles('**/{settings.gradle,settings.gradle.kts,gradlew,gradlew.bat}', '**/{node_modules,.git,.gradle,build}/**');
    this.check(operation);
    const roots = [...new Set(files.map(uri => path.dirname(uri.fsPath)))].sort();
    const projects: Project[] = [];
    for (const root of roots) {
      const wrapper = path.join(root, process.platform === 'win32' ? 'gradlew.bat' : 'gradlew');
      try {
        if (!fs.existsSync(wrapper)) throw new Error('No Gradle Wrapper in ' + root);
        const tasks = await this.tooling.query(root, operation.controller.signal);
        this.check(operation);
        projects.push({ id: root, label: path.basename(root), root, wrapper, tasks });
      } catch (error) {
        this.check(operation);
        throw gradleDiscoveryError(root, wrapper, error);
      }
    }
    this.check(operation);
    // 成功模型验证后进入不可取消的存储提交；停止需等待update完成，绝不写入失败或未完成的查询结果。
    await this.workspaceState?.update(GRADLE_CACHE_KEY, { projects: projects.map(project => ({ root: project.root,
      tasks: project.tasks.filter(task => /:(assemble|install)[\w.-]+$/.test(task)) })) });
    this.check(operation);
    this.projects = projects;
    this.cachedProjects = undefined;
    if (!projects.some(p => p.id === this.projectId)) this.projectId = projects[0]?.id || '';
    this.chooseDefault();
  }

  // 只选择真实变体，优先 Debug；npm test refresh/selection 断言默认项和非法输入。
  private chooseDefault(projects = this.projects): void {
    const targets = buildTargets(projects.find(p => p.id === this.projectId)?.tasks || []);
    if (!targets.some(t => t.id === this.targetId)) this.targetId = targets.find(t => t.variant.toLowerCase() === 'debug')?.id || targets[0]?.id || '';
  }

  // 由统一调试选择器展示内置Native和外部配置；取消不触发安装或调试。回归：android-build.test.js。
  private async debugConfiguration(project: Project): Promise<vscode.DebugConfiguration | undefined> {
    const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(project.root));
    return selectAndroidDebugConfiguration(folder);
  }

  // 将面板选择的六个内置项映射为稳定调试配置；默认run项保持普通应用启动链。
  private selectedRunMode(): RunMode {
    if (this.runModeId === 'run') return { id: 'run', label: 'Application', action: 'run' };
    const index = Number(this.runModeId.slice('debug-'.length));
    const config = getAndroidDebugConfigurations()[index];
    if (!config) throw new Error('Invalid run mode selection');
    return { id: this.runModeId, label: config.name, action: 'debug', config };
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

  // Debug 只转发用户选中的配置，不隐式安装、启动、解析AGP源码或注入APK；Build/Install/Run继续使用原有显式流程。
  // 内置配置缺包名时仅从所选metadata读取可选身份，缺失仍交给provider选择；只为本扩展调试类型补工作区根。
  // 回归：node --test tests/android-build.test.js，验证六种模式、零Gradle/零模型、显式字段保留、取消及会话终止后可重入。
  private async execute(operation: Operation, action: string, serial?: string): Promise<string> {
    if (action === 'refresh') { await this.discover(operation); return this.projects.length ? 'Ready' : 'No Gradle project'; }
    const project = this.projects.find(p => p.id === this.projectId);
    const target = buildTargets(project?.tasks || []).find(t => t.id === this.targetId);
    if (!project || !target) throw new Error('Select a Gradle project and Android variant first.');
    if (action === 'build') { await this.run(operation, project.wrapper, [target.assemble, '--console=plain'], project.root); return 'Build succeeded'; }
    if (!serial || !/^[\w.:-]+$/.test(serial)) throw new Error('Select an online device serial first.');
    const selectedMode = action === 'run' ? this.selectedRunMode() : undefined;
    const effectiveAction = selectedMode?.action ?? action;
    const config = effectiveAction === 'debug' ? selectedMode?.config ?? await this.debugConfiguration(project) : undefined;
    this.check(operation);
    if (effectiveAction === 'debug' && !config) return 'Debug cancelled';
    const online = await this.run(operation, adbPath(), ['-s', serial, 'get-state'], project.root);
    if (online.trim() !== 'device') throw new Error('Device is not online: ' + serial);
    if (action === 'install' || effectiveAction === 'run') {
      this.state('Installing selected APK');
      await this.run(operation, project.wrapper, [target.install, '--console=plain'], project.root, { ...process.env, ANDROID_SERIAL: serial });
      if (action === 'install') return 'Install succeeded';
      const packageName = packageFor(project, target);
      const result = await this.run(operation, adbPath(), ['-s', serial, 'shell', 'monkey', '-p', packageName, '-c', 'android.intent.category.LAUNCHER', '1'], project.root);
      if (/monkey aborted|no activities found|error:/i.test(result)) throw new Error(result);
      this.launched = { serial, packageName, cwd: project.root };
      return 'Running';
    }

    const builtIn = config!.type === 'android-debug' || config!.type === 'android-tools' || (config!.type === 'kotlin-jvm' && config!.android === true);
    const metadata = builtIn && !config!.packageName ? apkMetadataFor(project, target) : undefined;
    const packageName = config!.packageName ?? metadata?.applicationId;
    this.check(operation);
    const debugProjectRoot = builtIn && !config!.androidProjectRoot ? { androidProjectRoot: project.root } : {};
    const debugConfig = { ...config!, ...debugProjectRoot, ...(config!.packageName === undefined && packageName ? { packageName } : {}) };
    const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(project.root));
    this.state('Starting Android debugger');
    let started: vscode.DebugSession | undefined;
    let owned: vscode.DebugSession | undefined;
    let terminated = false;
    const startListener = vscode.debug.onDidStartDebugSession(session => {
      if (session.configuration.name === debugConfig.name && session.configuration.type === debugConfig.type && session.configuration.serial === serial && (packageName === undefined || session.configuration.packageName === packageName)) started = session;
    });
    const termination = vscode.debug.onDidTerminateDebugSession(session => {
      if (session !== started && session !== owned) return;
      terminated = true;
      if (session === owned) {
        this.debugSession = undefined;
        this.debugTermination?.dispose();
        this.debugTermination = undefined;
        if (!this.disposed) this.state('Stopped');
      }
    });
    try {
      const session = await startAndroidDebugging(folder, debugConfig, { serial, ...(packageName ? { packageName } : {}), signal: operation.controller.signal });
      this.check(operation);
      if (terminated) throw new Error('Android debug session terminated during startup');
      owned = session;
      this.debugSession = owned;
      this.debugTermination?.dispose();
      this.debugTermination = termination;
      return 'Debug started';
    } catch (error) {
      // 启动事件之后取消/拒绝也要回收已创建的所属会话，立即终止的会话则不能重复detach。
      if (started && !terminated) await vscode.debug.stopDebugging(started);
      if (this.debugSession === owned) this.debugSession = undefined;
      throw error;
    } finally {
      startListener.dispose();
      if (this.debugTermination !== termination) termination?.dispose();
    }
  }

  // 校验动作并独占执行；相同Gradle刷新共享进行中的Promise，sync回放快照，其他动作继续互斥。
  // 回归：node --test tests/android-build.test.js，覆盖每次刷新查询真实模型、并发合并、失败传播和取消。
  async handle(message: any, serial?: string): Promise<void> {
    if (this.disposed) throw new Error('Android build controller is disposed');
    if (!message || message.type !== 'buildPanel' || !['sync', 'refresh', 'project', 'target', 'build', 'install', 'run', 'runMode', 'debug', 'stop', 'output'].includes(message.action)) throw new Error('Invalid build panel action');
    if (message.action === 'sync') {
      if (this.snapshot) { this.post(this.snapshot); return; }
      return this.handle({ type: 'buildPanel', action: 'refresh' });
    }
    if (message.action === 'output') { this.output.show(true); return; }
    if (message.action === 'stop') { return this.stop(); }
    if (message.action === 'refresh' && !this.stopping && !this.operation?.controller.signal.aborted && this.operation?.action === 'refresh') return this.operation.done;
    if (this.operation || this.stopping) throw new Error('An Android operation is already running');
    if (!vscode.workspace.isTrusted) {
      const error = 'Workspace is not trusted';
      this.cachedProjects = undefined; this.projects = []; this.projectId = ''; this.targetId = '';
      this.state('Unavailable', error); throw new Error(error);
    }
    if (message.action === 'project' || message.action === 'target') {
      const project = this.projects.find(p => p.id === message.value);
      if (message.action === 'project') { if (!project) throw new Error('Invalid project selection'); this.projectId = project.id; this.chooseDefault(); }
      else { const targets = buildTargets(this.projects.find(p => p.id === this.projectId)?.tasks || []); if (!targets.some(t => t.id === message.value)) throw new Error('Invalid target selection'); this.targetId = message.value; }
      this.state('Ready'); return;
    }
    if ((this.launched || this.debugSession) && ['run', 'debug'].includes(message.action)) throw new Error('Stop the current app before starting another run.');
    if (message.action === 'runMode') {
      if (this.launched || this.debugSession) throw new Error('Stop the current app before changing run mode.');
      const modes = ['run', ...getAndroidDebugConfigurations().map((_, index) => 'debug-' + index)];
      if (!modes.includes(message.value)) throw new Error('Invalid run mode selection');
      this.runModeId = message.value;
      this.state('Ready');
      return;
    }
    const operation: Operation = { controller: new AbortController(), done: Promise.resolve(), action: message.action };
    this.operation = operation;
    this.state(message.action === 'refresh' ? 'Discovering Gradle tasks' : message.action + ': ' + this.targetId);
    operation.done = (async () => {
      try { const status = await this.execute(operation, message.action, serial); this.check(operation); this.operation = undefined; this.state(status); }
      catch (error) {
        if (message.action === 'refresh') { this.projects = []; this.cachedProjects = undefined; this.projectId = ''; this.targetId = ''; }
        this.operation = undefined;
        this.state(error instanceof Cancelled ? 'Cancelled' : 'Failed', error instanceof Cancelled ? undefined : String(error));
        throw error;
      }
    })();
    return operation.done;
  }

  // 并发停止共享清理Promise；Debug只detach，只有Run写入launched才force-stop自己启动的包。
  // 回归：node --test tests/android-build.test.js，验证Attach/Stop零force-stop、Run保留定向停止以及启动中取消回收会话。
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
      this.debugTermination?.dispose();
      this.debugTermination = undefined;
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
  async dispose(): Promise<void> {
    this.disposed = true;
    try { await this.stop(); }
    finally { try { await this.tooling.dispose(); } finally { this.output.dispose(); } }
  }
}
