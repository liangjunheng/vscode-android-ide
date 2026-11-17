import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { DeviceExplorerFiles, ExplorerEntry } from './deviceExplorerFiles';
import { ProcessesController } from './processes';

interface Upload { local: string; remote: string; handle: fs.FileHandle; expected: number; written: number; }
interface Scope { serial: string; view: 'files' | 'processes'; connection: AbortController; idleTimer?: NodeJS.Timeout; controller: AbortController; files: DeviceExplorerFiles; processes: ProcessesController; tasks: Set<Promise<void>>; uploads: Map<string, Upload>; directories: Map<string, ExplorerEntry[]>; writer?: Promise<void>; }
const PACKAGE = /^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)+$/;

// 输入远端绝对路径，拒绝含 NUL/穿越的消息；回归 device-explorer-controller.test.js 的不可信路径与传输断言。
function remotePath(value: unknown): string {
  if (typeof value !== 'string' || !value.startsWith('/') || value.includes('\0') || value.split('/').includes('..')) { throw new Error('Invalid device path'); }
  return path.posix.normalize(value);
}

// 文件操作与真实设备串号绑定；作用域取消会等待任务及上传句柄回收，避免切换设备后继续写入。
// 回归：npm test，tests/device-explorer-controller.test.js 覆盖菜单、取消、权限、传输和宿主生命周期。
export class DeviceExplorerController {
  private scope?: Scope;
  private serial?: string;
  private readonly scopes = new Map<'files' | 'processes', Scope>();
  private tab: 'files' | 'processes' = 'files';
  private filter = false;
  private applicationIds: string[] = [];
  private cache?: Promise<string>;
  private transition: Promise<void> = Promise.resolve();
  private disposed = false;

  // 输入消息投递器及只读Build当前包名提供方，不主动连接；提供方缺失或返回undefined才读取工作区候选，过滤语义不变。
  // 回归：Node>=22，node --test tests/device-explorer-controller.test.js；locateApp断言有目标零picker、缺目标候选单选/取消、目录结果及错误，生命周期断言隐藏无后端调用。
  constructor(private post: (message: unknown) => void, private currentApplicationId?: () => string | undefined) {}

  // 设备/活动视图切换取消命令，独立连接按用户要求闲置60秒才释放；view-idle/controller回归验证复用、失效及设备归属。
  setContext(serial: string | undefined, visible: boolean, view: 'files' | 'processes' = 'files'): Promise<void> {
    if (view !== 'files' && view !== 'processes') { return Promise.reject(new Error('Invalid device surface')); }
    const task = this.transition.then(() => this.changeContext(serial, visible, view));
    // 队尾只等待释放，返回的原始task仍将失败交还调用方。
    this.transition = task.then(() => undefined, () => undefined);
    return task;
  }

  // 同设备切回复用连接，切换设备关闭旧会话，新会话读取 android 包过滤；输入设备与视图，无返回值。controller/view-idle 回归覆盖配置、生命周期和异常。
  private async changeContext(serial: string | undefined, visible: boolean, view: 'files' | 'processes'): Promise<void> {
    if (serial !== this.serial || this.disposed) { await this.closeScope(); this.serial = serial; }
    const active = visible && serial && !this.disposed ? serial : undefined;
    if (this.scope && (!active || this.scope.view !== view)) { await this.idleScope(this.scope); }
    this.tab = view;
    if (!active) { this.state(); return; }
    if (this.scope?.serial === active && this.scope.view === view) {
      this.state();
      if (view === 'processes' && !this.scope.processes.connected) { await this.handle({ type: 'explorer', action: 'processes' }); }
      return;
    }
    const retained = this.scopes.get(view);
    if (retained) {
      if (retained.idleTimer) { clearTimeout(retained.idleTimer); retained.idleTimer = undefined; }
      retained.controller = new AbortController(); this.scope = retained; this.state();
      if (view === 'processes') {
        if (!retained.processes.connected) { await this.handle({ type: 'explorer', action: 'processes' }); }
        else { retained.processes.publish(); }
      } else if (retained.directories.size) { this.publishDirectories(retained); }
      else { await this.handle({ type: 'explorer', action: 'refresh' }); }
      return;
    }
    const controller = new AbortController(), connection = new AbortController();
    const scope: Scope = { serial: active, view, controller, connection, files: new DeviceExplorerFiles(active),
      processes: new ProcessesController(active, connection.signal, message => { if (!connection.signal.aborted && this.scope === scope) { this.post(message); } }),
      tasks: new Set(), uploads: new Map(), directories: new Map() };
    this.scopes.set(view, scope); this.scope = scope;
    this.filter = vscode.workspace.getConfiguration('android').get<boolean>('explorer.packageFilter', false);
    this.state(); void this.handle({ type: 'explorer', action: 'refresh' });
  }

  // 切出立即取消命令，连接/缓存保留60秒；view-idle回归验证59秒复用、独立计时及60秒释放，不通过延时掩盖操作未取消。
  private async idleScope(scope: Scope): Promise<void> {
    this.scope = undefined; scope.controller.abort(new Error('Device Explorer view is inactive'));
    if (!scope.idleTimer) {
      scope.idleTimer = setTimeout(() => {
        scope.idleTimer = undefined;
        const task = this.transition.then(async () => { if (this.scope !== scope) { await this.releaseScope(scope); } });
        this.transition = task.then(() => undefined, () => undefined);
        void task.catch(error => vscode.window.showErrorMessage(String(error)));
      }, 60000);
      scope.idleTimer.unref?.();
    }
    await Promise.allSettled([...scope.tasks]);
    for (const id of scope.uploads.keys()) { await this.discardUpload(scope, id); }
  }

  // 快速切回只重放当前设备的目录快照，不重新查询ADB；view-idle/目录回归验证缓存归属和零重复list。
  private publishDirectories(scope: Scope): void {
    this.check(scope);
    for (const [directory, entries] of scope.directories) { this.post({ type: 'explorerFiles', serial: scope.serial, path: directory, entries }); }
  }

  // 只在当前未取消作用域投递，取消任务通过 AbortSignal 结束；controller 回归断言无隐藏后残留进度或成功。
  private check(scope: Scope): void {
    scope.controller.signal.throwIfAborted();
    if (this.scope !== scope || this.disposed) { throw new Error('Device Explorer context is closed'); }
    if (!vscode.workspace.isTrusted) { throw new Error('Workspace is not trusted'); }
  }

  // 发布状态和真实能力，不把未实现的备份/原生拖出伪装启用；controller/UI 回归断言空态及能力禁用。
  private state(): void {
    const retained = this.scopes.get(this.tab);
    this.post({ type: 'explorerState', serial: this.serial, tab: this.tab, active: !!this.scope, connected: !!retained && !retained.connection.signal.aborted && (this.tab === 'files' ? retained.directories.size > 0 : retained.processes.connected), filter: this.filter, applicationIds: this.applicationIds,
      capabilities: ProcessesController.capabilities() });
  }

  // 命令归作用域所有；设置入口使用 android.explorer，输入宿主消息，无返回值。controller 回归核验新命名空间和动作归属、失败及取消；locateApp的writer互斥/取消证据见定位共享回归映射。
  async handle(message: any): Promise<void> {
    if (!message || message.type !== 'explorer' || typeof message.action !== 'string') { throw new Error('Invalid Device Explorer message'); }
    if (message.action === 'ready') {
      this.state();
      if (this.scope) {
        if (this.tab === 'processes') { this.scope.processes.publish(); }
        else { this.publishDirectories(this.scope); }
      }
      return;
    }
    if (message.action === 'settings') { await vscode.commands.executeCommand('workbench.action.openSettings', 'android.explorer'); return; }
    if (message.action === 'cancel') { const serial = this.scope?.serial, view = this.tab; await this.setContext(undefined, false, view); await this.setContext(serial, true, view); return; }
    const scope = this.scope;
    if (!scope) { this.state(); return; }
    const mutation = !['list', 'processes', 'refresh'].includes(message.action);
    if (mutation && scope.writer) {
      const error = 'A Device Explorer operation is already running';
      this.post({ type: 'explorerProgress', serial: scope.serial, busy: true, error, message: error });
      if (message.transferId) { this.post({ type: 'explorerUploadAck', serial: scope.serial, action: message.action, transferId: message.transferId, error }); }
      return;
    }
    let failure: string | undefined;
    const task = this.execute(scope, message).catch(async error => {
      if (scope.controller.signal.aborted) { return; }
      if (message.transferId && message.serial === scope.serial && scope.uploads.has(message.transferId)) {
        try { await this.discardUpload(scope, message.transferId); } catch (cleanup) { error = new AggregateError([error, cleanup], 'Upload and temporary cleanup failed'); }
      }
      failure = String(error);
      this.post({ type: 'explorerProgress', serial: scope.serial, busy: false, message: String(error), error: String(error) });
    });
    scope.tasks.add(task);
    if (mutation) { scope.writer = task; }
    try { await task; } finally { scope.tasks.delete(task); if (scope.writer === task) { scope.writer = undefined; } }
    if (message.transferId && !scope.controller.signal.aborted) {
      this.post({ type: 'explorerUploadAck', serial: scope.serial, action: message.action, transferId: message.transferId, ...(failure ? { error: String(failure) } : {}) });
    }
  }

  // 按远端权限选择普通或 run-as 访问；只处理确实的权限拒绝，其他故障不被替换为空目录。
  // controller 回归断言 debuggable 包访问、不可调试拒绝和普通错误传播。
  private async access(scope: Scope, remote: string): Promise<{ files: DeviceExplorerFiles; entry: ExplorerEntry }> {
    try { return { files: scope.files, entry: await scope.files.stat(remote, scope.controller.signal) }; }
    catch (error) {
      const match = /^\/data\/(?:data|user\/\d+)\/([^/]+)/.exec(remote);
      if (!/permission denied|not permitted/i.test(String(error)) || !match || !PACKAGE.test(match[1])) { throw error; }
      const files = new DeviceExplorerFiles(scope.serial, { runAs: match[1] });
      return { files, entry: await files.stat(remote, scope.controller.signal) };
    }
  }

  // 展开只发一次list而不预先stat，仅权限拒绝时切身份/虚拟入口；父快照删除时失效子缓存；controller回归验证往返、run-as及刷新删除不查询旧子树；定位目录/链接与权限步骤见定位共享回归映射。
  private async list(scope: Scope, remote: string): Promise<void> {
    this.check(scope);
    let entries: ExplorerEntry[];
    try {
      try { entries = await scope.files.list(remote, scope.controller.signal); }
      catch (error) {
        const match = /^\/data\/(?:data|user\/\d+)\/([^/]+)/.exec(remote);
        if (!/permission denied|not permitted/i.test(String(error)) || !match || !PACKAGE.test(match[1])) { throw error; }
        const files = new DeviceExplorerFiles(scope.serial, { runAs: match[1] });
        entries = await files.list(remote, scope.controller.signal);
      }
    }
    catch (error) {
      if (!/permission denied|not permitted/i.test(String(error))) { throw error; }
      if (remote === '/data') { entries = ['data', 'local'].map(name => ({ path: '/data/' + name, name, kind: 'directory' as const, permissions: '', size: 0, modified: 0 })); }
      else if (remote === '/data/data') { entries = (await scope.files.listPackages(scope.controller.signal)).map(name => ({ path: remote + '/' + name, name, kind: 'directory' as const, permissions: '', size: 0, modified: 0 })); }
      else { throw error; }
    }
    this.check(scope);
    if (this.filter && this.applicationIds.length && remote === '/data/data') { entries = entries.filter(entry => this.applicationIds.includes(entry.name)); }
    const retained = new Set(entries.filter(entry => entry.kind === 'directory' || entry.directoryLink).map(entry => entry.path));
    for (const old of scope.directories.get(remote) || []) if ((old.kind === 'directory' || old.directoryLink) && !retained.has(old.path)) {
      for (const cached of scope.directories.keys()) if (cached === old.path || cached.startsWith(old.path + '/')) { scope.directories.delete(cached); }
    }
    scope.directories.set(remote, entries);
    this.post({ type: 'explorerFiles', serial: scope.serial, path: remote, entries });
  }

  // 从结构化APK metadata和字面applicationId收集过滤ID，不执行Gradle；输入活动scope并发布已验证ID，也供无当前Build目标时的定位候选复用。
  // 回归：Node>=22，node --test tests/device-explorer-controller.test.js；过滤用例断言工作区ID，locateApp uses the current Build selection without scanning or picking 断言定位不再次扫描。
  private async readApplicationIds(scope: Scope): Promise<void> {
    const ids = new Set<string>();
    const files = await vscode.workspace.findFiles('**/{output-metadata.json,build.gradle,build.gradle.kts}', '**/{node_modules,.git,.gradle}/**');
    for (const uri of files) {
      this.check(scope);
      const text = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
      if (uri.path.endsWith('output-metadata.json')) {
        const id = JSON.parse(text).applicationId; if (typeof id === 'string' && PACKAGE.test(id)) { ids.add(id); }
      } else {
        for (const match of text.matchAll(/\bapplicationId\s*(?:=)?\s*["']([\w.]+)["']/g)) { if (PACKAGE.test(match[1])) { ids.add(match[1]); } }
      }
    }
    this.check(scope); this.applicationIds = [...ids]; this.state();
  }

  // 输入活动Files作用域，优先定位Build当前项目/模块/变体ID；仅缺当前ID时扫描候选，0项报错/1项直达/多项单选，取消不定位，不接受前端包名/路径。
  // 定位共享回归映射：Node>=22，node --test tests/device-explorer-controller.test.js，VM+工作区/ADB/provider替身。
  // uses the current Build selection without scanning or picking：切换provider后仅查询对应包，零findFiles/QuickPick；reveals the selected Build application：四级快照先于reveal且忽略前端pkg/path。
  // fallback handles zero one and multiple workspace IDs：无provider/undefined时0项error、1项直达、多项canPickMany:false及取消零list/reveal；fallback picker respects scope cancellation断言选择后检查旧scope与writer。
  // rejects unavailable selection invalid IDs missing directories non-directories and backend failures：真实provider故障、非法ID及设备失败明确error且零reveal；tests/android-build.test.js的Build-to-Explorer fallback断言仅缺metadata回退，坏metadata不扫描。
  // reuses virtual parents and run-as：权限拒绝使用虚拟父级/run-as且空目录成功；pending directory read respects scope cancellation：切设备/视图后零reveal，writer拒绝并发写。
  // Files surface 与 initial automatic refresh 两项：Processes拒绝定位，初始根list挂起不阻塞定位独立目录链。Build metadata隔离与前置错误另见tests/android-build.test.js current application ID。
  private async locateApp(scope: Scope): Promise<void> {
    this.check(scope);
    let packageName = this.currentApplicationId?.();
    if (packageName === undefined) {
      await this.readApplicationIds(scope);
      this.check(scope);
      if (!this.applicationIds.length) { throw new Error('No application ID found in workspace'); }
      if (this.applicationIds.length === 1) { packageName = this.applicationIds[0]; }
      else {
        packageName = await vscode.window.showQuickPick(this.applicationIds, { title: 'Select application to locate', canPickMany: false });
        this.check(scope);
        if (packageName === undefined) { return; }
      }
    }
    if (!PACKAGE.test(packageName)) { throw new Error('Invalid current application ID'); }

    const appDirectory = '/data/data/' + packageName;
    const parents = ['/', '/data', '/data/data', appDirectory];
    for (let index = 0; index < parents.length; index++) {
      const directory = parents[index];
      await this.list(scope, directory);
      if (index === parents.length - 1) { continue; }
      const entries = scope.directories.get(directory) || [];
      const next = parents[index + 1];
      const child = entries.find(entry => entry.path === next);
      if (!child || (child.kind !== 'directory' && !child.directoryLink)) { throw new Error('Required application parent is missing or not a directory: ' + next); }
    }
    this.check(scope);
    this.post({ type: 'explorerReveal', serial: scope.serial, path: appDirectory });
  }

  // 共享区域只激活独立Processes模块；controller回归断言File视图不会启动tracker。
  private async processes(scope: Scope): Promise<void> {
    this.check(scope); await scope.processes.start(this.filter, this.applicationIds);
  }

  // 发布真实进度，传输绑定 scope.signal；controller 回归断言取消后无成功及字节数不是伪造百分比。
  private progress(scope: Scope, message: string, busy: boolean, bytes?: number): void {
    this.check(scope); this.post({ type: 'explorerProgress', serial: scope.serial, busy, message, bytes });
  }

  // 只接受列出的远端绝对路径；controller 回归覆盖空选择、路径穿越及多选目录。
  private paths(message: any): string[] {
    if (!Array.isArray(message.paths) || !message.paths.length) { throw new Error('Select a file or directory'); }
    return [...new Set<string>(message.paths.map(remotePath))];
  }

  // 在活动作用域执行文件/进程动作，过滤偏好写入 android；输入作用域和消息，无返回值。定位Files限定步骤见定位共享回归映射。
  // 五按钮共享映射：Node>=22 VM+后端替身，node --test tests/device-explorer-controller.test.js；toolbar file commands publish created uploaded deleted refreshed and downloaded results触发新建目录/上传/下载/删除/刷新，断言父快照、落地字节及完成状态；toolbar file commands preserve cancellation and surface operation failures断言对话框取消零写入、后端错误可见及无伪完成。
  private async execute(scope: Scope, message: any): Promise<void> {
    this.check(scope);
    if (message.action === 'tab') { throw new Error('Select a surface using the Device Tools view controls'); }
    const processAction = ProcessesController.handles(message.action);
    if (processAction && this.tab !== 'processes') { throw new Error('Processes view is not active'); }
    if (!processAction && !['refresh', 'filter'].includes(message.action) && this.tab !== 'files') { throw new Error('Device Explorer files view is not active'); }
    if (message.action.startsWith('upload') && message.action !== 'upload' && message.action !== 'uploadUris') { await this.uploadMessage(scope, message); return; }
    if (message.action === 'refresh' || message.action === 'filter') {
      if (message.action === 'filter') {
        if (typeof message.enabled !== 'boolean') { throw new Error('Invalid package filter'); }
        await vscode.workspace.getConfiguration('android').update('explorer.packageFilter', message.enabled, vscode.ConfigurationTarget.Global);
        this.check(scope); this.filter = message.enabled;
      }
      await this.readApplicationIds(scope);
      if (this.tab === 'processes') { await this.processes(scope); }
      else {
        const directories = message.action === 'filter' || !scope.directories.size ? ['/'] : scope.directories.keys();
        for (const directory of directories) { await this.list(scope, directory); }
      }
      return;
    }
    if (message.action === 'list') { await this.list(scope, remotePath(message.path)); return; }
    if (message.action === 'locateApp') { await this.locateApp(scope); return; }
    if (message.action === 'processes') { await this.processes(scope); return; }
    if (ProcessesController.handles(message.action)) { await scope.processes.handle(message, scope.controller.signal); return; }
    if (message.action === 'copyPath') { await vscode.env.clipboard.writeText(this.paths(message).join('\n')); return; }
    if (message.action === 'newFile' || message.action === 'newDirectory') {
      const parent = remotePath(message.parent || this.paths(message)[0]);
      const name = await vscode.window.showInputBox({ title: message.action === 'newFile' ? 'New File' : 'New Directory', validateInput: value => !value || /[\/\0]/.test(value) || value === '.' || value === '..' ? 'Enter a single file name' : undefined });
      this.check(scope); if (name === undefined) { return; }
      if (!name || /[\/\0]/.test(name) || name === '.' || name === '..') { throw new Error('Invalid file name'); }
      const found = await this.access(scope, parent); await found.files.create(path.posix.join(parent, name), message.action === 'newDirectory', scope.controller.signal); await this.list(scope, parent); return;
    }
    if (message.action === 'delete') {
      const paths = this.paths(message);
      const answer = await vscode.window.showWarningMessage('Delete ' + paths.length + ' selected device item(s)?', { modal: true, detail: paths.join('\n') }, 'Delete');
      this.check(scope); if (answer !== 'Delete') { return; }
      for (const remote of paths) { if (remote === '/') { throw new Error('Cannot delete device root'); } const found = await this.access(scope, remote); await found.files.remove(remote, scope.controller.signal); }
      await this.list(scope, path.posix.dirname(paths[0])); return;
    }
    if (message.action === 'open' || message.action === 'download') { await this.download(scope, this.paths(message), message.action === 'open'); return; }
    if (message.action === 'upload' || message.action === 'uploadUris') {
      const target = remotePath(message.target || message.parent || this.paths(message)[0]);
      const uris = message.action === 'uploadUris' ? this.sourceUris(message.uris) : await vscode.window.showOpenDialog({ canSelectMany: true, canSelectFiles: true, canSelectFolders: true, title: 'Upload to device' });
      this.check(scope); if (!uris) { return; }
      const found = await this.access(scope, target);
      for (const uri of uris) { if (uri.scheme !== 'file') { throw new Error('Uploads require a local file URI'); } this.progress(scope, 'Uploading ' + path.basename(uri.fsPath), true); await found.files.push(uri.fsPath, path.posix.join(target, path.basename(uri.fsPath)), { signal: scope.controller.signal, progress: bytes => this.progress(scope, 'Uploading', true, bytes) }); }
      this.progress(scope, 'Upload complete', false); await this.list(scope, target); return;
    }
    throw new Error('Unknown Device Explorer action: ' + message.action);
  }

  // 标准 URI-list 只接受 file URI，拒绝网页任意协议；controller 回归断言恶意 URI 不触发本地读取。
  private sourceUris(values: unknown): vscode.Uri[] {
    if (!Array.isArray(values) || !values.length || values.some(value => typeof value !== 'string')) { throw new Error('Invalid upload URI list'); }
    return values.map(value => { const uri = vscode.Uri.parse(value); if (uri.scheme !== 'file') { throw new Error('Only local file uploads are supported'); } return uri; });
  }

  // 下载或打开选中项，下载目录读取 android 配置；输入活动作用域、远端路径和打开标志，无返回值。下载落地字节/完成状态、取消与错误步骤见execute五按钮共享映射。
  private async download(scope: Scope, paths: string[], open: boolean): Promise<void> {
    let directory: string | undefined;
    if (open) { directory = await this.cacheDirectory(); }
    else {
      const configured = vscode.workspace.getConfiguration('android').get<string>('explorer.downloadLocation', '');
      if (configured && !(await fs.stat(configured)).isDirectory()) { throw new Error('Download location must be an existing directory'); }
      const selected = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, canSelectMany: false, title: 'Save device files to', defaultUri: vscode.Uri.file(configured || path.join(os.homedir(), 'Downloads')) });
      this.check(scope); directory = selected?.[0]?.fsPath;
    }
    if (!directory) { return; }
    for (const remote of paths) {
      const found = await this.access(scope, remote);
      if (open && (found.entry.kind === 'directory' || found.entry.directoryLink)) { throw new Error('Select a regular file to open'); }
      const base = path.posix.basename(remote);
      if (!base || /[<>:"\\|?*\x00-\x1f]/.test(base) || /[. ]$/.test(base) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(base)) { throw new Error('Device name is not a safe local file name'); }
      const parent = open ? await fs.mkdtemp(path.join(directory, 'open-')) : directory;
      const local = path.join(parent, base);
      this.progress(scope, 'Downloading ' + base, true);
      await found.files.pull(remote, local, { signal: scope.controller.signal, progress: bytes => this.progress(scope, 'Downloading', true, bytes) });
      this.check(scope);
      if (open) { await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(local)); }
    }
    this.progress(scope, 'Download complete', false);
  }

  // 只创建拥有的缓存根，保存打开副本直至控制器销毁；controller 回归验证创建与清理边界。
  private cacheDirectory(): Promise<string> { return this.cache ??= fs.mkdtemp(path.join(os.tmpdir(), 'android-device-explorer-')); }

  // 传输失败或取消立即关闭拥有的句柄并删临时副本；controller回归断言异常与隐藏清理。
  private async discardUpload(scope: Scope, id: string): Promise<void> {
    const upload = scope.uploads.get(id); if (!upload) { return; }
    scope.uploads.delete(id);
    try { await upload.handle.close(); } finally { await fs.rm(path.dirname(upload.local), { recursive: true, force: true }); }
  }

  // 上传校验设备归属，文件持有句柄并等最终push/清理，目录等create及父快照刷新后回ACK；controller目录/分块回归验证空目录、错误、字节、清理与幂等Abort。
  private async uploadMessage(scope: Scope, message: any): Promise<void> {
    const id = message.transferId;
    if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(id)) { throw new Error('Invalid upload transfer'); }
    if (message.serial !== scope.serial) { throw new Error('Upload device context changed'); }
    if (message.action === 'uploadAbort') { await this.discardUpload(scope, id); return; }
    if (message.action === 'uploadBegin') {
      if (scope.uploads.has(id)) { throw new Error('Upload transfer already exists'); }
      const target = remotePath(message.target), relative = message.relativePath;
      if (typeof relative !== 'string' || !relative || relative.startsWith('/') || relative.includes('\\') || relative.split('/').some(part => !part || part === '.' || part === '..' || part.includes('\0'))) { throw new Error('Invalid upload relative path'); }
      const remote = path.posix.join(target, relative);
      const found = await this.access(scope, target);
      if (message.directory === true) { await found.files.create(remote, true, scope.controller.signal); await this.list(scope, path.posix.dirname(remote)); this.progress(scope, 'Directory uploaded', false); return; }
      if (!Number.isSafeInteger(message.size) || message.size < 0) { throw new Error('Invalid upload size'); }
      const directory = await fs.mkdtemp(path.join(await this.cacheDirectory(), 'upload-'));
      const local = path.join(directory, 'content'); const handle = await fs.open(local, 'wx');
      scope.uploads.set(id, { local, remote, handle, expected: message.size, written: 0 });
    } else {
      const upload = scope.uploads.get(id); if (!upload) { throw new Error('Upload transfer is not open'); }
      if (message.action === 'uploadChunk') {
        if (typeof message.data !== 'string' || message.data.length > 350000 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(message.data)) { throw new Error('Invalid upload chunk'); }
        const data = Buffer.from(message.data, 'base64');
        if (upload.written + data.length > upload.expected) { throw new Error('Upload exceeds declared size'); }
        await upload.handle.writeFile(data); upload.written += data.length;
        this.progress(scope, 'Uploading', true, upload.written);
      } else if (message.action === 'uploadEnd') {
        scope.uploads.delete(id); await upload.handle.close();
        try {
          if (upload.written !== upload.expected) { throw new Error('Upload size does not match'); }
          const found = await this.access(scope, path.posix.dirname(upload.remote));
          await found.files.push(upload.local, upload.remote, { signal: scope.controller.signal });
          await this.list(scope, path.posix.dirname(upload.remote)); this.progress(scope, 'Upload complete', false);
        } finally { await fs.rm(path.dirname(upload.local), { recursive: true, force: true }); }
      } else { throw new Error('Invalid upload action'); }
    }
    this.check(scope);
  }

  // 取消并等待所有任务及原生句柄关闭，清理拥有的上传副本；controller回归断言切换/隐藏/dispose后无资源遗留。
  private async closeScope(): Promise<void> {
    const results = await Promise.allSettled([...this.scopes.values()].map(scope => this.releaseScope(scope)));
    const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failures.length) { throw new AggregateError(failures.map(result => result.reason), 'Device session cleanup failed'); }
  }

  // 真实释放指定会话且清除其计时器，关闭其他视图不会错误释放活动资源；view-idle回归覆盖超时/设备切换/dispose及命令等待。
  private async releaseScope(scope: Scope): Promise<void> {
    if (scope.idleTimer) { clearTimeout(scope.idleTimer); scope.idleTimer = undefined; }
    if (this.scope === scope) { this.scope = undefined; }
    scope.controller.abort(new Error('Device Explorer connection closed')); scope.connection.abort(new Error('Device Explorer connection closed'));
    try { await scope.processes.dispose(); }
    finally {
      await Promise.allSettled([...scope.tasks]);
      for (const id of scope.uploads.keys()) { await this.discardUpload(scope, id); }
      if (this.scopes.get(scope.view) === scope) { this.scopes.delete(scope.view); }
      this.post({ type: 'explorerConnection', serial: scope.serial, view: scope.view, connected: false });
    }
  }

  // 扩展销毁只回收自己拥有的连接和缓存，不停止设备应用；controller回归断言不发送force-stop。
  async dispose(): Promise<void> { this.disposed = true; await this.setContext(undefined, false); if (this.cache) { await fs.rm(await this.cache, { recursive: true, force: true }); this.cache = undefined; } }
}
