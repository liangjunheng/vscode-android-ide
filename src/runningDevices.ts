import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { ChildProcess, spawn } from 'child_process';
import { Device, adb, sdkRoot, adbPath, grpcPortFor, grpcTokenFor, listDevices, runBuffer } from './sdk';
import { EmulatorSession, grpcSupported } from './emulatorGrpc';
import { ScrcpySession, bundledJar } from './scrcpy';
import { Skin, skinForAvd } from './skin';

type Mode = 'emulator' | 'scrcpy' | 'screencap';
export type DeviceViewMode = 'mirror' | 'explorer' | 'processes' | 'hidden';
// 独立文件/进程视图共用宿主区域，view决定唯一活动资源；device-view-mode及controller回归验证切换关闭。
interface ExplorerSurface { setContext(serial: string | undefined, visible: boolean, view?: 'files' | 'processes'): Promise<void>; handle(message: any): Promise<void>; }

export class RunningDeviceView implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  // 空串表示尚未发现默认设备；undefined 表示用户清空或设备断开，禁止自动切到其他设备。
  private serial: string | undefined = '';
  private deviceViewMode: DeviceViewMode = 'mirror';
  // 派生旧投屏状态，不引入第二个模式源；tests/device-view-mode.test.js 断言三个视图与隐藏模式互斥。
  private get mirrorVisible() { return this.deviceViewMode === 'mirror'; }
  private forced?: Mode; // set after a failure to skip a mode that does not work
  private session?: ScrcpySession;
  private emu?: EmulatorSession;
  private inflight = false;
  private pending?: { w: number; h: number; data: Uint8Array };
  private viewport = { w: 1080, h: 2200 };
  private mirrorConnection?: { serial: string; controller: AbortController; starting?: Promise<void> };
  private mirrorIdle?: NodeJS.Timeout;
  private readonly mirrorStarts = new Set<Promise<void>>();
  private readonly mirrorReleases = new Set<Promise<void>>();
  private capturing = false;
  private loop?: NodeJS.Timeout;
  private size = { w: 0, h: 0 };
  private skin?: Skin;

  private rec?: { proc: ChildProcess; serial: string; stopping: boolean };

  // 输入路径、构建处理器、可选偏好及选择回调；恢复投屏状态并保留同步入口。
  // 回归：npm test mirror preference / device selection sync 断言重建隐藏、ready 回传和双向接线。
  constructor(private extPath: string, private buildAction?: (message: any, serial?: string) => Promise<void>,
    private mirrorPreference?: { visible: boolean; save: (visible: boolean) => PromiseLike<void>; mode?: DeviceViewMode; saveMode?: (mode: DeviceViewMode) => PromiseLike<void> },
    private selectionChanged?: (serial?: string) => Promise<void> | void,
    private explorer?: ExplorerSurface) {
    this.deviceViewMode = mirrorPreference?.mode ?? (mirrorPreference?.visible === false ? 'hidden' : 'mirror');
  }

  // 将构建状态交给当前 Webview；npm test build panel bridge 验证快照投递。
  publishBuildState(message: unknown) { this.post(message); }

  private icons(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const n of ['back', 'home', 'overview', 'power', 'volume-up', 'volume-down', 'rotate', 'screenshot', 'record', 'rotate-left', 'rotate-right', 'virtual-dark', 'virtual-light', 'physical-dark', 'physical-light', 'pair-over-wifi', 'logcat']) {
      out[n] = fs.readFileSync(path.join(this.extPath, 'media', 'icons', `${n}.svg`), 'utf8');
    }
    return out;
  }

  async toggleRecording(serial: string) {
    if (this.rec) {
      this.rec.stopping = true;
      // SIGINT lets screenrecord finalize the mp4
      await adb(this.rec.serial, 'shell', 'pkill', '-2', 'screenrecord').catch(() => adb(this.rec!.serial, 'shell', 'killall', '-2', 'screenrecord'));
      return;
    }
    const remote = `/sdcard/vscode-rec-${Date.now()}.mp4`;
    const proc = spawn(adbPath(), ['-s', serial, 'shell', 'screenrecord', '--bit-rate', '8000000', '--time-limit', '180', remote], { env: { ...process.env, ANDROID_HOME: sdkRoot() } });
    this.rec = { proc, serial, stopping: false };
    this.post({ type: 'recording', on: true });
    proc.on('exit', async () => {
      this.rec = undefined;
      this.post({ type: 'recording', on: false });
      try {
        await new Promise((r) => setTimeout(r, 500));
        const tmp = path.join(os.tmpdir(), path.basename(remote));
        await adb(serial, 'pull', remote, tmp);
        const uri = await vscode.window.showSaveDialog({ filters: { MP4: ['mp4'] }, defaultUri: vscode.Uri.file(path.join(os.homedir(), `recording-${Date.now()}.mp4`)) });
        if (uri) { await vscode.workspace.fs.copy(vscode.Uri.file(tmp), uri, { overwrite: true }); }
        fs.rmSync(tmp, { force: true });
      } catch (e: any) {
        vscode.window.showErrorMessage(`Screen recording failed: ${e.message}`);
      } finally { adb(serial, 'shell', 'rm', '-f', remote).catch(() => {}); }
    });
  }

  // 输入 VS Code 视图，安装消息与生命周期监听并输出带配置初始状态的 HTML。
  // 回归：npm test 的 build panel bridge / initial mirror state 及 mirror preference 断言初始隐藏和握手。
  // 下拉主题随资源传递且不改变 CSP；npm test dropdown 接线断言检查 resolveWebviewView 与 html 调用链。
  resolveWebviewView(view: vscode.WebviewView) {
    this.view = view;
    const media = vscode.Uri.file(path.join(this.extPath, 'media', 'codicons'));
    view.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.file(path.join(this.extPath, 'media')), media, vscode.Uri.file(path.join(this.extPath, 'media', 'icons'))] };
    const art = (n: string) => view.webview.asWebviewUri(vscode.Uri.file(path.join(this.extPath, 'media', 'icons', n))).toString();
    view.webview.html = html(view.webview, view.webview.asWebviewUri(vscode.Uri.joinPath(media, 'codicon.css')), this.icons(), { dark: art('devices-lineup-dark.png'), light: art('devices-lineup-light.png'), panel: art('../build-panel.js'), style: art('../build-panel.css'), dropdownStyle: art('../dropdowns.css'), mirrorVisible: this.mirrorVisible, deviceViewMode: this.deviceViewMode, processesScript: art('../device-processes/processes.js'), processesStyle: art('../device-processes/processes.css'), explorerScript: art('../device-explorer/main.js'), explorerStyle: art('../device-explorer/main.css') });
    view.webview.onDidReceiveMessage((m) => this.onMessage(m).catch((e) => this.post({ type: 'error', text: e.message })));
    view.onDidChangeVisibility(() => this.restart());
    view.onDidDispose(() => { if (this.view !== view) { return; } this.view = undefined; void this.dispose().catch(error => vscode.window.showErrorMessage(String(error))); });
  }

  // 输入设备或空值同步选择并通知 Logcat，不抢焦点；相同串号不重复启动。
  // 回归：npm test，tests/device-selection-sync.test.js 断言双向切换、空选择、隐藏及无回传循环。
  async select(d?: Pick<Device, 'serial'>) {
    const serial = d?.serial || undefined;
    if (this.serial === serial) { return; }
    this.serial = serial;
    this.forced = undefined;
    this.post({ type: 'devices', devices: [], serial });
    this.stop();
    await this.explorer?.setContext(serial, false);
    await this.selectionChanged?.(this.serial);
    return this.restart();
  }

  // 标题栏刷新当前镜像，不自动选择其他设备；npm test 标题栏回归验证错误由命令入口展示。
  async refresh() { return this.restart(); }

  // 输入在线设备并聚焦镜像，选择变化时通知日志侧，等待连接结果；npm test 选择器与 device selection sync 断言同步和失败传播。
  async show(d?: Device) {
    await vscode.commands.executeCommand('android-ide.runningDevice.focus');
    if (d && d.serial !== this.serial) { return this.select(d); }
    this.post({ type: 'select', serial: this.serial });
    return this.restart();
  }

  mirroredSerial(): string | undefined {
    return this.mirrorVisible && this.view?.visible && (this.session || this.emu || this.loop) ? this.serial : undefined;
  }

  stopMirroring() {
    this.stop();
    this.post({ type: 'error', text: 'Mirroring stopped. Select a device or refresh to resume.' });
  }

  private post(m: unknown) { this.view?.webview.postMessage(m); }

  // 明确停止/设备切换/销毁立即取消真实连接所有者；view-idle回归验证清计时器及创建中取消不重新泄漏连接。
  private stop() {
    this.cancelMirrorIdle();
    this.mirrorConnection?.controller.abort(new Error('Mirroring connection closed')); this.mirrorConnection = undefined;
    if (this.loop) { clearInterval(this.loop); this.loop = undefined; }
    const session = this.session, emu = this.emu; this.session = undefined; this.emu = undefined;
    this.trackMirrorRelease(session?.stop()); emu?.stop(); this.pending = undefined; this.inflight = false;
  }

  // 异步forward清理由提供方持有并报告失败，销毁等待它结束；view-idle回归验证释放任务不遗留。
  private trackMirrorRelease(task: Promise<void> | undefined | void): void {
    if (!task) { return; } this.mirrorReleases.add(task);
    void task.then(() => { this.mirrorReleases.delete(task); }, error => { this.mirrorReleases.delete(task); vscode.window.showErrorMessage(String(error)); });
  }

  // 只在首次切出时安排60秒断开，反复切其他视图不重置期限；view-idle回归精确验证59999/60000ms边界。
  private idleMirror(): void {
    if (this.mirrorIdle || !(this.mirrorConnection || this.session || this.emu || this.loop)) { return; }
    this.mirrorIdle = setTimeout(() => { this.mirrorIdle = undefined; if (!this.mirrorVisible || !this.view?.visible) { this.stop(); this.post({ type: 'loading' }); } }, 60000);
    this.mirrorIdle.unref?.();
  }

  // 切回活动投屏会撤销闲置释放，不重建已连接/正在创建的资源；view-idle回归验证提前返回后旧期限失效。
  private cancelMirrorIdle(): void { if (this.mirrorIdle) { clearTimeout(this.mirrorIdle); this.mirrorIdle = undefined; } }

  // 连接状态来自实际会话/截图循环，关闭过的对象不能被当作已连接；view-idle回归验证异常关闭后的重连。
  private mirrorConnected(): boolean { return !!(this.session?.connected || this.emu?.connected || this.loop); }

  // 提供方销毁立即关闭投屏并等待创建任务结束，清理Explorer所有闲置会话；view-idle与activate回归验证全资源回收。
  async dispose(): Promise<void> {
    this.view = undefined; this.stop();
    const results = await Promise.allSettled([...this.mirrorStarts, ...this.mirrorReleases, this.explorer?.setContext(undefined, false)]);
    const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failures.length) { throw new AggregateError(failures.map(result => result.reason), 'Device view cleanup failed'); }
  }

  // 刷新设备目录并恢复唯一活动视图；device-view-mode与mirror visibility回归断言Files/Processes路由及隐藏零新流。
  private async restart() {
    if (!this.view?.visible) { this.idleMirror(); await this.explorer?.setContext(this.serial, false); return; }
    await this.refreshDevices();
    if (!this.view?.visible) { this.idleMirror(); await this.explorer?.setContext(this.serial, false); return; }
    if (this.mirrorConnection && this.mirrorConnection.serial !== this.serial) { this.stop(); }
    await this.explorer?.setContext(this.serial, this.deviceViewMode === 'explorer' || this.deviceViewMode === 'processes', this.deviceViewMode === 'processes' ? 'processes' : 'files');
    if (!this.serial || !this.mirrorVisible || !this.view?.visible) { this.idleMirror(); return; }
    this.cancelMirrorIdle();
    const current = this.mirrorConnection;
    if (current?.starting) { await current.starting; return; }
    if (current && !current.controller.signal.aborted && this.mirrorConnected()) { this.flush(); return; }
    this.stop();
    if (this.mirrorStarts.size) { await Promise.allSettled([...this.mirrorStarts]); }
    if (!this.serial || !this.mirrorVisible || !this.view?.visible) { return; }
    const resumed = this.mirrorConnection;
    if (resumed?.starting) { await resumed.starting; return; }
    if (resumed && !resumed.controller.signal.aborted && this.mirrorConnected()) { return; }
    const connection = { serial: this.serial, controller: new AbortController(), starting: undefined as Promise<void> | undefined };
    this.mirrorConnection = connection;
    const task = this.connectMirror(connection); connection.starting = task; this.mirrorStarts.add(task);
    try { await task; } finally { connection.starting = undefined; this.mirrorStarts.delete(task); }
  }

  // 创建任务只有一个真实所有者，快速切回共用它，不使用代次标记；view-idle回归验证并发ready/切换零重复start。
  private async connectMirror(connection: { serial: string; controller: AbortController }): Promise<void> {
    connection.controller.signal.throwIfAborted();
    const mode = this.pickMode(connection.serial);
    if (mode === 'emulator') { await this.startEmulator(connection.serial); }
    else if (mode === 'scrcpy') { await this.startScrcpy(); }
    else { this.startScreencap(); }
  }

  // 用户按钮先保存配置，失败不改变显示状态；npm test mirror preference 回归断言持久化、幂等和失败传播。
  private async setMirrorVisible(visible: boolean): Promise<void> {
    if (this.mirrorVisible !== visible) { await this.mirrorPreference?.save(visible); }
    await this.applyMirrorVisibility(visible);
  }

  // 应用设置页或按钮状态，不重复写回配置；npm test mirror preference/visibility 回归断言实时同步、停止与恢复。
  async applyMirrorVisibility(visible: boolean): Promise<void> {
    return this.applyDeviceViewMode(visible ? 'mirror' : 'hidden');
  }

  // 唯一显示模式互斥，非活动连接保留60秒，切回先检查真实状态；view-idle/device-view-mode回归覆盖复用、超时及保存失败。
  async applyDeviceViewMode(mode: DeviceViewMode): Promise<void> {
    if (!['mirror', 'explorer', 'processes', 'hidden'].includes(mode)) { throw new Error('Invalid device view mode'); }
    const changed = this.deviceViewMode !== mode;
    this.deviceViewMode = mode;
    this.postViewMode();
    if (!changed && mode !== 'mirror') { return; }
    if (mode !== 'mirror') { this.idleMirror(); }
    await this.explorer?.setContext(this.serial, (mode === 'explorer' || mode === 'processes') && !!this.view?.visible, mode === 'processes' ? 'processes' : 'files');
    if (mode === 'mirror') { await this.restart(); }
  }

  // 旧消息同时携带四态值，前端监听注册后可恢复选中状态；tests/device-view-mode.test.js 验证握手。
  private postViewMode(): void {
    this.post({ type: 'deviceViewMode', mode: this.deviceViewMode });
    this.post({ type: 'mirrorVisibility', visible: this.mirrorVisible, mode: this.deviceViewMode });
  }

  // 用户动作保存成功后才更新状态，失败不伪装成功；tests/device-view-mode.test.js 断言保存拒绝与重启恢复。
  private async setDeviceViewMode(mode: DeviceViewMode): Promise<void> {
    if (!['mirror', 'explorer', 'processes', 'hidden'].includes(mode)) { throw new Error('Invalid device view mode'); }
    if (mode !== this.deviceViewMode) {
      if (this.mirrorPreference?.saveMode) { await this.mirrorPreference.saveMode(mode); }
      else { await this.mirrorPreference?.save(mode === 'mirror'); }
    }
    await this.applyDeviceViewMode(mode);
  }

  private pickMode(serial: string): Mode {
    const order: Mode[] = ['emulator', 'scrcpy', 'screencap'];
    const usable = (m: Mode) => m === 'screencap' || m === 'scrcpy' || (grpcSupported() && grpcPortFor(serial) !== undefined);
    const start = this.forced ? order.indexOf(this.forced) : 0;
    return order.slice(start).find(usable)!;
  }

  // gRPC会话回调绑定实际AbortSignal所有者，不用代次过滤；view-idle回归验证创建/断线/重入及失效后无帧。
  private async startEmulator(serial: string) {
    const connection = this.mirrorConnection; if (!connection) { throw new Error('Mirror connection owner is missing'); }
    this.post({ type: 'mode', mode: 'emulator' });
    const emu = new EmulatorSession(grpcPortFor(serial)!, {
      onFrame: (f) => {
        if (connection.controller.signal.aborted) { return; }
        this.pending = { w: f.w, h: f.h, data: new Uint8Array(f.rgba.buffer, f.rgba.byteOffset, f.rgba.length) };
        this.flush();
      },
      onClose: (reason) => {
        if (connection.controller.signal.aborted) { return; }
        this.emu = undefined;
        if (reason) { this.fallback('scrcpy', `Emulator stream stopped (${reason}); switching to scrcpy`); }
      },
    }, this.viewport, grpcTokenFor(serial));
    this.emu = emu;
    try { await emu.start(); } catch (e: any) {
      if (!connection.controller.signal.aborted) { this.fallback('scrcpy', `Emulator gRPC failed (${e.message}); switching to scrcpy`); }
    }
  }

  // Only one frame in flight: the webview acks each frame, newer frames replace the pending one.
  private flush() {
    if (!this.mirrorVisible || !this.view?.visible || this.inflight || !this.pending) { return; }
    const f = this.pending;
    this.pending = undefined;
    this.inflight = true;
    this.post({ type: 'rgba', ...f });
  }

  // scrcpy创建与回调归单一连接所有者，闲置期可复用；view-idle回归验证单start、关闭状态及超时。
  private async startScrcpy() {
    const connection = this.mirrorConnection; if (!connection) { throw new Error('Mirror connection owner is missing'); }
    const serial = this.serial!;
    this.post({ type: 'mode', mode: 'scrcpy' });
    const session = new ScrcpySession(serial, bundledJar(this.extPath), {
      onPacket: (kind, data) => { if (!connection.controller.signal.aborted) { this.post({ type: 'video', kind, data: new Uint8Array(data) }); } },
      onClose: (reason) => {
        if (connection.controller.signal.aborted) { return; }
        this.session = undefined; this.trackMirrorRelease(session.stop());
        if (reason) { this.post({ type: 'error', text: `Stream stopped: ${reason}` }); }
      },
    });
    this.session = session;
    try {
      await session.start();
    } catch (e: any) {
      if (connection.controller.signal.aborted) { if (e.name !== 'AbortError') { vscode.window.showErrorMessage(String(e)); } return; }
      this.fallback('screencap', `scrcpy failed (${e.message}); using screenshot mode`);
    }
  }

  private fallback(mode: Mode, reason: string) {
    this.stop();
    this.forced = mode;
    // 回退成功后由 mode=screencap 重新进入加载态；不要把启动诊断再次覆盖到投屏画面。
    if (this.mirrorVisible && this.view?.visible) { void this.restart().catch(error => this.post({ type: 'error', text: String(error) })); }
  }

  // 按 android-ide.mirrorIntervalMs 启动截图计时器；需活动镜像会话，无返回值，停止逻辑拥有计时器。配置前缀回归核验读取位置。
  private startScreencap() {
    this.post({ type: 'mode', mode: 'screencap' });
    const every = vscode.workspace.getConfiguration('android-ide').get<number>('mirrorIntervalMs', 150);
    this.loop = setInterval(() => this.capture(), every);
  }

  // 查询全部设备并发布快照；初次发现选第一台在线设备，断开则清空并同步日志，已清空不自动回退。
  // 无输入，查询失败向消息入口传播；npm test 的 device-selection-sync.test.js 断言重复展开查询、默认选择、断开和错误。
  private async refreshDevices() {
    const devs = await listDevices();
    if (this.serial && !devs.some((d) => d.serial === this.serial && d.state === 'device')) {
      this.serial = undefined; this.stop();
      await this.explorer?.setContext(undefined, false);
      await this.selectionChanged?.(undefined);
    } else if (this.serial === '') {
      const first = devs.find((d) => d.state === 'device');
      if (first) { this.serial = first.serial; await this.selectionChanged?.(this.serial); }
    }
    this.post({ type: 'devices', devices: devs.map((d) => ({ serial: d.serial, label: d.name || d.avdName || d.model || d.serial, state: d.state, physical: !d.serial.startsWith('emulator-') })), serial: this.serial });
    this.skin = skinForAvd(devs.find((d) => d.serial === this.serial)?.avdName);
    this.post({ type: 'skin', skin: this.skin ? this.skinPayload(this.skin) : null });
  }

  private skinPayload(k: Skin) {
    const url = (f?: string) => (f ? `data:image/${path.extname(f).slice(1)};base64,${fs.readFileSync(f).toString('base64')}` : '');
    return { back: url(k.back), mask: url(k.mask), lw: k.lw, lh: k.lh, dx: k.dx, dy: k.dy, dw: k.dw, dh: k.dh, radius: k.radius };
  }

  // 截图循环闲置时不发ADB，明确断开中止正在读取的进程；view-idle回归验证信号、串号及非活动零读取。
  private async capture() {
    const connection = this.mirrorConnection;
    if (this.capturing || !connection || !this.mirrorVisible || !this.view?.visible) { return; }
    this.capturing = true;
    try {
      const png = await runBuffer(adbPath(), ['-s', connection.serial, 'exec-out', 'screencap', '-p'], connection.controller.signal);
      if (connection.controller.signal.aborted || !this.mirrorVisible || !this.view?.visible) { return; }
      if (png.length > 24 && png.readUInt32BE(12) === 0x49484452) { // IHDR
        this.size = { w: png.readUInt32BE(16), h: png.readUInt32BE(20) };
      }
      this.post({ type: 'frame', data: png.toString('base64'), ...this.size });
    } catch (e: any) {
      if (connection.controller.signal.aborted) { return; }
      this.post({ type: 'error', text: e.message });
      await this.refreshDevices();
    } finally { this.capturing = false; }
  }

  // 分派 Webview 输入；wake 对当前设备发送只亮屏不切换电源的命令，失败交由消息入口报告。
  // 回归：npm test，无设备/三种模式/失败均由 tests/mirror-interaction.test.js 断言。
  // 处理下拉切换和空态入口；npm test 的下拉回归断言设备选择消息及 openDM 委托。
  // 配置握手/保存回归见 mirror preference；设备展开走幂等恢复，刷新目录但不重启在线投屏。
  // npm test 的 device-selection-sync.test.js 严格断言展开查询次数、默认/断开选择、双向同步及无设备日志入口。
  // 仅分派现存设备工具入口；build-panel-ui的bridge回归断言工具栏与Logcat/构建接线一致。
  private async onMessage(m: any) {
    const s = this.serial;
    switch (m.type) {
      case 'buildPanel': if (this.buildAction) { return this.buildAction(m, s); } return;
      case 'pairDevice': return vscode.commands.executeCommand('android-ide.pairDevice');
      case 'explorer': if (!this.explorer) { throw new Error('Device Explorer is unavailable'); } return this.explorer.handle(m);
      case 'setDeviceViewMode': return this.setDeviceViewMode(m.mode);
      case 'getMirrorVisibility': this.postViewMode(); return;
      case 'setMirrorVisibility':
        if (typeof m.visible !== 'boolean') { throw new Error('Invalid mirror visibility'); }
        return this.setMirrorVisible(m.visible);
      case 'ready': this.postViewMode(); return this.restart();
      case 'discoverDevices': return this.restart();
      case 'select': return this.select(m.serial ? { serial: m.serial } : undefined);
      case 'refresh': this.forced = undefined; return this.restart();
      case 'ext': if (s) { vscode.commands.executeCommand('android-ide.extendedControls', { serial: s }); } return;
      case 'logcat': return vscode.commands.executeCommand('android-ide.showLogcat', s ? { serial: s } : undefined);
      case 'reboot': if (s) { return this.reboot(s); } return;
      case 'wake': if (s) { await adb(s, 'shell', 'input', 'keyevent', 'KEYCODE_WAKEUP'); } return;
      case 'openDM': vscode.commands.executeCommand('android-ide.addDevice'); return;
      case 'viewport': this.viewport = { w: Math.max(200, m.w), h: Math.max(200, m.h) }; if (this.mirrorVisible && this.view?.visible) { this.emu?.setViewport(this.viewport); } return;
      case 'ack': this.inflight = false; return this.flush();
      case 'rotate': if (this.emu) { this.emu.rotate(m.dir); return; } if (s) { return this.rotate(s, m.dir); } return;
      case 'record': if (s) { return this.toggleRecording(s); } return;
      case 'noDecoder': return this.fallback('screencap', 'Video decoding unavailable in this VS Code; using screenshot mode');
      case 'decodeError': return this.fallback('screencap', `Decoder error: ${m.text}; using screenshot mode`);
      default: if (!s) { return; }
    }
    if (this.emu) { return this.onEmulatorInput(this.emu, m, s); }
    if (this.session) { return this.onScrcpyInput(this.session, m, s); }

    const x = Math.round(m.x * this.size.w), y = Math.round(m.y * this.size.h);
    switch (m.type) {
      case 'tap': await adb(s, 'shell', 'input', 'tap', `${x}`, `${y}`); break;
      case 'swipe': {
        const x2 = Math.round(m.x2 * this.size.w), y2 = Math.round(m.y2 * this.size.h);
        await adb(s, 'shell', 'input', 'swipe', `${x}`, `${y}`, `${x2}`, `${y2}`, `${Math.max(50, Math.min(m.ms, 2000))}`);
        break;
      }
      case 'key': await adb(s, 'shell', 'input', 'keyevent', String(m.code)); break;
      case 'text': await adb(s, 'shell', 'input', 'text', String(m.text).replace(/ /g, '%s').replace(/[^\w%@.,:/+-]/g, '')); break;
      case 'screenshot': return this.screenshot(s);
    }
  }

  private async onEmulatorInput(emu: EmulatorSession, m: any, serial: string) {
    switch (m.type) {
      case 'touch': emu.touch(m.action, m.x, m.y, m.w, m.h); break;
      case 'scroll': emu.swipe(m.x, m.y, m.x, Math.min(0.95, Math.max(0.05, m.y + m.v * 0.25)), m.w, m.h, 120); break;
      case 'text': emu.key(String(m.text)); break;
      case 'key': await adb(serial, 'shell', 'input', 'keyevent', String(m.code)); break;
      case 'screenshot': return this.screenshot(serial);
    }
  }

  private async onScrcpyInput(sess: ScrcpySession, m: any, serial: string) {
    switch (m.type) {
      case 'touch': sess.touch(m.action, m.x * m.w, m.y * m.h, m.w, m.h); break;
      case 'scroll': sess.scroll(m.x * m.w, m.y * m.h, m.w, m.h, m.v); break;
      case 'key': sess.key(Number(m.code)); break;
      case 'text': sess.text(String(m.text)); break;
      case 'screenshot': return this.screenshot(serial);
    }
  }

  private async reboot(serial: string) {
    this.post({ type: 'error', text: 'Restarting device…' });
    await adb(serial, 'reboot');
    this.stop();
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      if ((await listDevices()).some((d) => d.serial === serial && d.state === 'device') && (await adb(serial, 'shell', 'getprop', 'sys.boot_completed').catch(() => '')).trim() === '1') {
        this.forced = undefined;
        return this.restart();
      }
    }
  }

  private async rotate(serial: string, dir: number) {
    const cur = parseInt((await adb(serial, 'shell', 'settings', 'get', 'system', 'user_rotation')).trim(), 10) || 0;
    const step = dir < 0 ? 3 : 1;
    let n = (cur + step) % 4;
    if (n === 2) { n = (n + step) % 4; } // phones ignore 180°, which would make the click look dead
    const next = String(n);
    await adb(serial, 'shell', 'cmd', 'window', 'user-rotation', 'lock', next).catch(async () => {
      await adb(serial, 'shell', 'settings', 'put', 'system', 'accelerometer_rotation', '0');
      await adb(serial, 'shell', 'settings', 'put', 'system', 'user_rotation', next);
    });
  }

  async screenshot(serial: string) {
    const png = await runBuffer(adbPath(), ['-s', serial, 'exec-out', 'screencap', '-p']);
    let out: Buffer = png;
    if (this.skin && this.view && this.serial === serial) {
      const pick = await vscode.window.showQuickPick(
        [{ label: 'Rectangular', id: 'rect' }, { label: 'Display Shape', id: 'shape' }, { label: 'Show Device Frame', id: 'frame' }],
        { placeHolder: 'Screenshot type' });
      if (!pick) { return; }
      if (pick.id !== 'rect') {
        const composed = await this.compose(pick.id, png);
        if (composed) { out = composed; }
      }
    }
    const uri = await vscode.window.showSaveDialog({ filters: { PNG: ['png'] }, defaultUri: vscode.Uri.file(`${process.env.HOME}/screenshot-${Date.now()}.png`) });
    if (uri) { await vscode.workspace.fs.writeFile(uri, out); }
  }

  // The webview has a canvas, so it does the compositing (frame / rounded display).
  private compose(mode: string, png: Buffer): Promise<Buffer | undefined> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => { sub.dispose(); resolve(undefined); }, 15000);
      const sub = this.view!.webview.onDidReceiveMessage((m) => {
        if (m.type !== 'composed') { return; }
        clearTimeout(timer); sub.dispose();
        resolve(m.data ? Buffer.from(m.data, 'base64') : undefined);
      });
      this.post({ type: 'compose', mode, png: png.toString('base64') });
    });
  }
}

// 生成投屏页面：工具栏与画面共用宽度，组内紧凑、组间分隔且首尾贴边，三键导航等宽紧贴画面，图标始终按投屏宽度比例缩放，上下各留白 4px，首帧前显示黑色加载占位；npm test 的 mirror layout/navigation 回归断言结构、尺寸和按键。
// 生成当前设备名称和全设备下拉 UI；npm test 的 DOM 回归执行 renderDevices 并断言状态、禁用项和空态。
// 输入资源和模式，在设备选择框后输出投屏/Explorer/Processes图标组，不生成Wi-Fi按钮；build-panel-ui与device-view-mode回归验证同排顺序、移除绑定与四态恢复。
// 输入资源和 mirrorVisible 配置，输出含初始 mirror-hidden/data-mirror-visible 的页面；npm test build panel initial mirror state 与 bridge 回归验证初始状态和资源传递。
// 共享下拉资源随页面生成；npm test 的 dropdown 接线断言及 LOGCAT_BROWSER=1 dropdown 回归验证图标、主题和原生选择。
// 构建动作栏以Show Logcat结尾；build-panel-ui回归严格断言七个按钮及已移除入口不再渲染。
function html(webview: vscode.Webview, codicons: vscode.Uri, icons: Record<string, string>, art: { dark: string; light: string; panel: string; style: string; mirrorVisible: boolean; deviceViewMode: DeviceViewMode; processesScript: string; processesStyle: string; explorerScript: string; explorerStyle: string; dropdownStyle: string }) {
  return /* html */ `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: ${webview.cspSource}; style-src 'unsafe-inline' ${webview.cspSource}; font-src ${webview.cspSource}; script-src 'unsafe-inline' ${webview.cspSource};">
<link rel="stylesheet" href="${codicons}"><link rel="stylesheet" href="${art.processesStyle}"><style>
body{margin:0;padding:0;gap:0;font-family:var(--vscode-font-family);color:var(--vscode-foreground);display:flex;flex-direction:column;align-items:center;gap:0;height:100vh;box-sizing:border-box}
#tabs{display:flex;flex:none;width:100%;padding:6px 8px;border-bottom:1px solid var(--vscode-panel-border,#444);box-sizing:border-box}
#tab{position:relative;display:flex;align-items:center;gap:8px;padding:4px 9px;border:1px solid var(--vscode-dropdown-border,var(--vscode-input-border,var(--vscode-panel-border,#555)));background:var(--vscode-dropdown-background,var(--vscode-input-background));border-radius:6px;width:100%;min-width:0;height:34px;box-sizing:border-box}
#tab svg{width:18px;height:18px}
#tab .dot{display:none}
#chev{display:block;pointer-events:none;font-size:14px;opacity:.8;flex:none}
#tab.multi #chev{display:block}
#tab.multi select{padding-right:0}
#tab select{background:transparent;border:0;color:var(--vscode-dropdown-foreground,var(--vscode-input-foreground));font:inherit;appearance:none;-webkit-appearance:none;cursor:pointer;padding:0 4px;text-overflow:ellipsis;min-width:0;width:100%;height:100%;border-radius:0;transition:box-shadow .12s ease}#tab select:hover,#tab select:active{background:transparent}
#tab select:focus:not(:focus-visible){outline:0!important;box-shadow:none!important}#tab select:focus-visible{outline:0;box-shadow:0 0 0 1px var(--vscode-focusBorder)}
#tab select option{background:var(--vscode-dropdown-background);color:var(--vscode-dropdown-foreground)}
.dk,.lt{display:none}body:not(.vscode-light) .dk{display:flex}body.vscode-light .lt{display:flex}
#bar{display:flex;flex:none;justify-content:space-between;gap:4px;flex-wrap:nowrap;width:100%;height:43px;padding:6px 0;border-bottom:1px solid var(--vscode-panel-border,#444);box-sizing:border-box;align-items:center}
#bar .tool-group{display:flex;flex:0 1 auto;min-width:0;gap:2px}
#bar .sep{width:1px;height:22px;flex:none;background:var(--vscode-panel-border,#555)}
#bar button{flex:0 1 30px;min-width:0}
#bar button svg{max-width:100%;height:auto;max-height:20px}
#bar button .codicon{max-width:100%;overflow:hidden}
button{background:transparent;color:var(--vscode-icon-foreground);border:0;width:30px;height:30px;padding:0;cursor:pointer;border-radius:5px;display:inline-flex;align-items:center;justify-content:center;font-size:16px}
button:hover{background:var(--vscode-toolbar-hoverBackground)}
button svg{width:20px;height:20px}
#rec.on{background:#db3b4b33}
#timer{font-size:11px;color:#db3b4b;align-self:center}
#status{display:flex;flex:none;align-items:center;justify-content:center;gap:8px;max-width:100%;min-height:18px}
#wrap{flex:1;min-height:0;display:flex;align-items:flex-start;justify-content:center;width:100%;padding:0 8px 8px;box-sizing:border-box}
#screen,#cv{max-width:100%;max-height:100%;object-fit:contain;object-position:top center;border-radius:8px;cursor:default;user-select:none;outline:none}
#screen{display:none}
#stage{display:flex;flex-direction:column;flex:none;min-width:0;gap:0}
#navigation{--nav-icon-ratio:0.064;--nav-padding:4px;--nav-icon-size:0px;display:grid;grid-template-columns:repeat(3,minmax(0,1fr));width:100%;height:auto;flex:none}
#navigation button{width:100%;height:auto;min-width:0;border-radius:0;padding:var(--nav-padding) 0}
#navigation button svg{width:var(--nav-icon-size);height:var(--nav-icon-size);max-width:100%;flex:none}
#frame{display:block;position:relative;flex:none;background:#000}
#placeholder{position:absolute;inset:0;z-index:2;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:12px;background:#000;color:#fff;text-align:center;padding:12px;box-sizing:border-box;overflow:hidden}
#placeholder[hidden]{display:none}
#placeholder .codicon{font-size:28px;flex:none}
#placeholder-text{max-width:100%;overflow-wrap:anywhere;font-size:13px}
#frame[data-state="error"] #placeholder .codicon{display:none}
#frame:not([data-state="live"]) #cv,#frame:not([data-state="live"]) #screen,#frame:not([data-state="live"]) #bk,#frame:not([data-state="live"]) #fg{visibility:hidden}
#frame #cv,#frame #screen{width:100%;height:100%}
#bk,#fg{display:none}
#frame.skin{display:block;position:relative;flex:none}
#frame.skin #bk,#frame.skin #fg{display:block;position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none}
#frame.skin #cv,#frame.skin #screen{position:absolute;max-width:none;max-height:none;border-radius:0;object-fit:fill}
#menu{display:none;position:fixed;z-index:10;min-width:160px;padding:6px 0;background:var(--vscode-menu-background,var(--vscode-editorWidget-background));color:var(--vscode-menu-foreground,var(--vscode-foreground));border:1px solid var(--vscode-menu-border,var(--vscode-widget-border,#555));border-radius:6px;box-shadow:0 8px 24px #0005,0 2px 6px #0003;font-size:12px;overflow:hidden}
#menu div{min-height:30px;padding:7px 14px;display:flex;align-items:center;cursor:pointer;transition:background-color .12s ease,color .12s ease}#menu div:hover,#menu div:focus-visible{background:var(--vscode-menu-selectionBackground,var(--vscode-list-hoverBackground));color:var(--vscode-menu-selectionForeground,var(--vscode-foreground));outline:0}
#msg{font-size:11px;opacity:.7;padding:2px 8px}
#empty{display:none;flex:1;flex-direction:column;align-items:center;justify-content:center;gap:24px;padding:16px 24px;text-align:center;opacity:.9;font-size:13px;line-height:1.6;color:var(--vscode-descriptionForeground)}
#empty img{width:225px;height:150px}
#empty a{color:var(--vscode-textLink-foreground);cursor:pointer;text-decoration:none}#empty a:hover{text-decoration:underline}
body.empty #bar,body.empty #wrap{display:none}
body.empty #empty{display:flex}
</style><link rel="stylesheet" href="${art.style}"><link rel="stylesheet" href="${art.explorerStyle}"><link rel="stylesheet" href="${art.dropdownStyle}"></head><body class="empty${art.mirrorVisible ? '' : ' mirror-hidden'}" data-mirror-visible="${art.mirrorVisible}" data-device-view-mode="${art.deviceViewMode}">
<div id="tabs" aria-label="Android run configuration">
<div class="build-project-row"><i class="codicon codicon-project" aria-hidden="true"></i><select id="build-project" aria-label="Gradle project" title="Gradle project"><option value="">No Gradle project</option></select><small id="build-root-count">0 Gradle roots</small></div>
<div class="build-surface">
<div class="build-target-row"><i class="codicon codicon-package" aria-hidden="true"></i><select id="build-target" aria-label="Module and build variant" title="Module and build variant"><option value="">No Android variants</option></select></div>
<div class="build-device-row"><div id="tab"><i class="dot" id="tdot"></i><select id="dev" aria-label="Device" title="Select Device"><button type="button"><span class="dk" id="tic-d">${icons['virtual-dark']}</span><span class="lt" id="tic-l">${icons['virtual-light']}</span><selectedcontent></selectedcontent></button><option value="">Select Device</option></select><i class="codicon codicon-chevron-down" id="chev"></i></div><span class="build-view-separator" role="separator" aria-orientation="vertical"></span><div class="build-view-modes" role="group" aria-label="Device view"><button id="build-mirror" title="Show mirroring" aria-label="Show mirroring" aria-pressed="false"><i class="codicon codicon-device-desktop"></i></button><button id="build-explorer" title="Show Device Explorer" aria-label="Show Device Explorer" aria-pressed="false"><i class="codicon codicon-folder-opened"></i></button><button id="build-processes" title="Show Processes" aria-label="Show Processes" aria-pressed="false"><i class="codicon codicon-server-process"></i></button></div></div>
<div class="build-actions"><button id="build-run" title="Build, install and run"><i id="build-run-icon" class="codicon codicon-play"></i><span id="build-run-label">Run</span></button><button id="build-build" title="Build APK" aria-label="Build APK"><i class="codicon codicon-tools"></i></button><button id="build-install" title="Install APK" aria-label="Install APK"><i class="codicon codicon-cloud-download"></i></button><button id="build-debug" title="Debug app" aria-label="Debug app"><i class="codicon codicon-debug-alt"></i></button><button id="build-refresh" title="Refresh Gradle projects" aria-label="Refresh Gradle projects"><i class="codicon codicon-refresh"></i></button><button id="build-output" title="Show build output" aria-label="Show build output"><i class="codicon codicon-output"></i></button><button id="build-logcat" title="Show Logcat" aria-label="Show Logcat">${icons['logcat']}</button></div>
<div class="build-status" role="status" aria-live="polite"><i id="build-progress" class="codicon"></i><span id="build-status">No Gradle project</span></div>
</div></div>
<section id="device-explorer" hidden></section>
<div id="menu"><div id="m-frame">Show Device Frame</div><div id="m-ext">Extended Controls</div><div id="m-log">Show Logcat</div></div>
<div id="empty"><img class="dk" src="${art.dark}" alt=""><img class="lt" src="${art.light}" alt="">
<div>To mirror a physical device, connect it via USB cable or over Wi-Fi.<br>To launch a virtual device, start one from <a id="open-dm">Select Device</a>.</div></div>
<div id="wrap"><div id="stage"><div id="bar"><div class="tool-group" role="group" aria-label="Power and volume">
<button data-k="26" title="Power">${icons['power']}</button>
<button data-k="24" title="Volume up">${icons['volume-up']}</button>
<button data-k="25" title="Volume down">${icons['volume-down']}</button>
</div><span class="sep" aria-hidden="true"></span><div class="tool-group" role="group" aria-label="Rotation">
<button id="rotl" title="Rotate left">${icons['rotate-left']}</button>
<button id="rotr" title="Rotate right">${icons['rotate-right']}</button>
</div><span class="sep" aria-hidden="true"></span><div class="tool-group" role="group" aria-label="Capture">
<button id="shot" title="Take screenshot">${icons['screenshot']}</button>
<button id="rec" title="Record screen">${icons['record']}</button>
</div><span class="sep" aria-hidden="true"></span><div class="tool-group" role="group" aria-label="Device tools">
<button id="ref" title="Restart device"><i class="codicon codicon-debug-restart"></i></button>
<button id="more" title="More"><i class="codicon codicon-kebab-vertical"></i></button></div></div>
<div id="frame" data-state="loading"><div id="placeholder" role="status" aria-live="polite"><i class="codicon codicon-loading codicon-modifier-spin" aria-hidden="true"></i><span id="placeholder-text">正在加载...</span></div><img id="screen" tabindex="0" draggable="false"><canvas id="cv" tabindex="0"></canvas><img id="bk" draggable="false" alt=""><img id="fg" draggable="false" alt=""></div><div id="navigation" role="group" aria-label="Android navigation">
<button data-k="4" title="Back" aria-label="Back">${icons['back']}</button>
<button data-k="3" title="Home" aria-label="Home">${icons['home']}</button>
<button data-k="187" title="Overview" aria-label="Overview">${icons['overview']}</button>
</div></div></div><div id="status"><div id="msg">No device</div><span id="timer"></span></div>
<script>
const vs=acquireVsCodeApi(),img=document.getElementById('screen'),cv=document.getElementById('cv'),dev=document.getElementById('dev'),msg=document.getElementById('msg');
const ctx=cv.getContext('2d');let tm;
const send=m=>vs.postMessage(m);
let mode='emulator',target=cv,fw=0,fh=0;
document.getElementById('open-dm').onclick=()=>send({type:'openDM'});
const frame=document.getElementById('frame'),bk=document.getElementById('bk'),fg=document.getElementById('fg'),wrapEl=document.getElementById('wrap'),stage=document.getElementById('stage'),navigation=document.getElementById('navigation'),barEl=document.getElementById('bar');
let skin=null,frameOn=(vs.getState()||{}).frame!==false,skinOn=false,fScale=1;
const place=(el,x,y,w,h)=>{el.style.setProperty('left',x*100+'%','important');el.style.setProperty('top',y*100+'%','important');el.style.setProperty('width',w*100+'%','important');el.style.setProperty('height',h*100+'%','important')};
// 输入容器、帧和皮肤尺寸，首帧前按 1080x1920 占位；扣除顶部工具栏后，按 CSS 图标比例和留白同时约束画面/导航高度，无需迭代测量。
// 回归：npm test，tests/mirror-interaction.test.js 的 mirror layout/navigation 覆盖上下工具栏同宽、顶部首尾对齐、图标缩放、4px 留白、横竖屏和皮肤开关。
function layout(){
 const r=wrapEl.getBoundingClientRect(),W=Math.max(0,r.width-16),H=Math.max(0,r.height-8-barEl.offsetHeight);
 const live=frame.dataset.state==='live',on=live&&!!skin&&frameOn&&!(fw&&fh&&fw>fh);
 if(on!==skinOn||on){skinOn=on;frame.classList.toggle('skin',on)}
 const w=on?skin.lw:live?(fw||cv.width):1080,h=on?skin.lh:live?(fh||cv.height):1920;
 const css=getComputedStyle(navigation),padding=2*parseFloat(css.getPropertyValue('--nav-padding'));
 const ratio=parseFloat(css.getPropertyValue('--nav-icon-ratio'));
 // 图标始终按投屏宽度比例缩放，同时用上下留白约束整体高度。
 const s=w&&h?Math.min(W/w,Math.max(0,H-padding)/(h+w*ratio)):0;
 const icon=w*s*ratio,availableH=Math.max(0,H-padding-icon);
 const iconSize=icon+'px';
 navigation.style.setProperty('--nav-icon-size',iconSize);
 navigation.querySelectorAll('svg').forEach((svg) => { svg.style.width=iconSize; svg.style.height=iconSize; });
 frame.style.width=stage.style.width=w*s+'px';frame.style.height=h*s+'px';
 if(!on){for(const el of[cv,img])for(const k of['left','top','width','height','border-radius'])el.style.removeProperty(k);
  return W>0&&availableH>0?{w:W,h:availableH}:null}
 fScale=s;
 const f=[skin.dx/skin.lw,skin.dy/skin.lh,skin.dw/skin.lw,skin.dh/skin.lh];
 place(cv,...f);place(img,...f);place(fg,...f);for(const el of[cv,img])el.style.setProperty('border-radius',(skin.radius/skin.dw*100)+'% / '+(skin.radius/skin.dh*100)+'%','important');
 return{w:skin.dw*fScale,h:skin.dh*fScale};
}
// 同步加载/首帧/失败的展示状态；加载时清空帧尺寸，布局按 1080x1920 占位，live 仅由实际绘制成功触发。
// 回归：npm test，tests/mirror-interaction.test.js 的 mirror loading 验证占位比例、状态切换、首帧和异常。
function setPresentation(state,text){
 const changed=frame.dataset.state!==state;frame.dataset.state=state;
 document.getElementById('placeholder').hidden=state==='live';
 document.getElementById('placeholder-text').textContent=state==='error'?text:'正在加载...';
 if(state==='loading'){fw=0;fh=0}
 if(changed||state==='loading')layout();
}
let vpT;const sendVp=()=>{const s=layout(),d=devicePixelRatio||1;if(s)send({type:'viewport',w:Math.round(s.w*d),h:Math.round(s.h*d)})};
new ResizeObserver(()=>{layout();clearTimeout(vpT);vpT=setTimeout(sendVp,250)}).observe(wrapEl);
function setSkin(k){skin=k;if(k){bk.src=k.back;fg.src=k.mask||''}fg.style.visibility=k&&k.mask?'visible':'hidden';sendVp()}
document.getElementById('m-frame').onclick=()=>{frameOn=!frameOn;vs.setState({frame:frameOn});sendVp()};
const loadImg=u=>new Promise(r=>{const i=new Image();i.onload=()=>r(i);i.onerror=()=>r(null);i.src=u});
async function compose(m){
 try{
  const shot=await loadImg('data:image/png;base64,'+m.png);if(!shot||!skin)throw 0;
  const s=shot.width/skin.dw,c=document.createElement('canvas'),x=c.getContext('2d');
  if(m.mode==='frame'){
   c.width=Math.round(skin.lw*s);c.height=Math.round(skin.lh*s);
   x.save();x.beginPath();x.roundRect(skin.dx*s,skin.dy*s,skin.dw*s,skin.dh*s,skin.radius*s);x.clip();
   x.drawImage(shot,skin.dx*s,skin.dy*s,skin.dw*s,skin.dh*s);x.restore();
   const b=await loadImg(skin.back);if(b)x.drawImage(b,0,0,c.width,c.height);
   if(skin.mask){const k=await loadImg(skin.mask);if(k)x.drawImage(k,skin.dx*s,skin.dy*s,skin.dw*s,skin.dh*s)}
  }else{
   c.width=shot.width;c.height=shot.height;
   x.drawImage(shot,0,0);const k=skin.mask&&await loadImg(skin.mask);
   if(k){x.globalCompositeOperation='destination-out';x.drawImage(k,0,0,c.width,c.height)}
   else{x.clearRect(0,0,c.width,c.height);x.beginPath();x.roundRect(0,0,c.width,c.height,skin.radius*s);x.clip();x.drawImage(shot,0,0)}
  }
  send({type:'composed',data:c.toDataURL('image/png').split(',')[1]});
 }catch(e){send({type:'composed'})}
}
// 每次鼠标/触摸或键盘展开请求最新目录；device-selection-sync.test.js 执行真实绑定并断言查询消息。
dev.onpointerdown=e=>{if(e.button===0)send({type:'discoverDevices'})};
dev.onkeydown=e=>{if(['Enter',' ','ArrowDown','ArrowUp','F4'].includes(e.key))send({type:'discoverDevices'})};
dev.onchange=()=>send({type:'select',serial:dev.value});
document.querySelectorAll('[data-k]').forEach(b=>b.onclick=()=>send({type:'key',code:b.dataset.k}));
rec.onclick=()=>send({type:'record'});rotl.onclick=()=>send({type:'rotate',dir:-1});rotr.onclick=()=>send({type:'rotate',dir:1});shot.onclick=()=>send({type:'screenshot'});ref.onclick=()=>send({type:'reboot'});
more.onclick=e=>{const r=more.getBoundingClientRect();menu.style.left=Math.max(0,r.right-160)+'px';menu.style.top=r.bottom+'px';menu.style.display='block';e.stopPropagation()};
document.addEventListener('click',()=>menu.style.display='none');
document.getElementById('m-ext').onclick=()=>send({type:'ext'});document.getElementById('m-log').onclick=()=>send({type:'logcat'});;

// ---- video decoding (scrcpy H.264 annex-B) ----
let decoder,configData,spsKey,needKey=true;
// 创建视频解码器并在实际绘制首帧后退出加载；npm test 的 mirror loading 和 navigation frame updates 验证真实回调。
function newDecoder(){
 if(decoder&&decoder.state!=='closed')decoder.close();
 decoder=new VideoDecoder({
  // 解码帧尺寸变化时同步画面和底部导航；npm test 的 mirror navigation frame updates 执行 output 并断言横屏尺寸更新。
  output:f=>{const changed=fw!==f.displayWidth||fh!==f.displayHeight;if(cv.width!==f.displayWidth||cv.height!==f.displayHeight){cv.width=f.displayWidth;cv.height=f.displayHeight}fw=f.displayWidth;fh=f.displayHeight;if(changed)layout();ctx.drawImage(f,0,0);f.close();setPresentation('live');msg.textContent=fw+'×'+fh},
  error:e=>send({type:'decodeError',text:String(e.message||e)})});
 needKey=true;
}
function onConfig(d){
 const key=Array.from(d.slice(0,16)).join();
 configData=d;
 const i=d.findIndex((b,k)=>k>=3&&d[k-3]===0&&d[k-2]===0&&d[k-1]===1&&(b&31)===7);
 const hex=x=>x.toString(16).padStart(2,'0');
 const codec=i>=0?'avc1.'+hex(d[i+1])+hex(d[i+2])+hex(d[i+3]):'avc1.640033';
 if(key!==spsKey||!decoder||decoder.state==='closed'){spsKey=key;newDecoder();decoder.configure({codec,optimizeForLatency:true})}
}
function onVideo(kind,raw){
 const d=raw instanceof Uint8Array?raw:new Uint8Array(raw);
 if(kind==='config'){onConfig(d);return}
 if(!decoder||decoder.state!=='configured')return;
 if(needKey&&kind!=='key')return;
 let data=d;
 if(kind==='key'&&configData){data=new Uint8Array(configData.length+d.length);data.set(configData);data.set(d,configData.length)}
 if(kind==='key')needKey=false;
 if(decoder.decodeQueueSize>8&&kind!=='key')return;
 decoder.decode(new EncodedVideoChunk({type:kind==='key'?'key':'delta',timestamp:performance.now()*1000,data}));
}

// ---- input ----
const rel=e=>{const r=target.getBoundingClientRect();return{x:Math.min(1,Math.max(0,(e.clientX-r.left)/r.width)),y:Math.min(1,Math.max(0,(e.clientY-r.top)/r.height))}};
let down=null;
// 绑定画面输入；主键按下发送幂等唤醒并保留各模式触摸/拖动，右键不触发唤醒。
// 回归：npm test，tests/mirror-interaction.test.js 的 mirror wake 执行 canvas/img 三模式按下、移动和释放并断言消息。
function bind(el){
 el.onmousedown=e=>{if(e.button!==0)return;e.preventDefault();el.focus();send({type:'wake'});const p=rel(e);down={...p,t:Date.now()};
  if(mode!=='screencap')send({type:'touch',action:0,...p,w:fw,h:fh})};
 el.onmousemove=e=>{if(down&&mode!=='screencap'&&e.buttons)send({type:'touch',action:2,...rel(e),w:fw,h:fh})};
 const up=e=>{if(!down)return;const u=rel(e);
  if(mode!=='screencap')send({type:'touch',action:1,...u,w:fw,h:fh});
  else if(Math.hypot(u.x-down.x,u.y-down.y)<0.015)send({type:'tap',x:u.x,y:u.y});
  else send({type:'swipe',x:down.x,y:down.y,x2:u.x,y2:u.y,ms:Date.now()-down.t});
  down=null};
 el.onmouseup=up;el.onmouseleave=e=>{if(down&&mode!=='screencap')up(e)};
 el.onwheel=e=>{e.preventDefault();const p=rel(e);
  if(mode!=='screencap')send({type:'scroll',...p,w:fw,h:fh,v:-Math.sign(e.deltaY)*Math.min(1,Math.abs(e.deltaY)/100)});
  else{const s=e.deltaY>0?[.5,.65,.5,.35]:[.5,.35,.5,.65];send({type:'swipe',x:s[0],y:s[1],x2:s[2],y2:s[3],ms:200})}};
 el.onkeydown=e=>{const map={Backspace:67,Enter:66,Escape:4,ArrowUp:19,ArrowDown:20,ArrowLeft:21,ArrowRight:22,Tab:61};
  if(map[e.key]){send({type:'key',code:map[e.key]});e.preventDefault()}
  else if(e.key.length===1&&!e.metaKey&&!e.ctrlKey){send({type:'text',text:e.key});e.preventDefault()}};
}
bind(img);bind(cv);

// 模式启动或回退时恢复加载占位；截图仅在图片加载成功后退出，失败保留黑底错误；npm test 的 mirror loading 覆盖三模式。
function setMode(m){mode=m;const c=m!=='screencap';target=c?cv:img;cv.style.display=c?'block':'none';img.style.display=c?'none':'block';setPresentation('loading')}
// 图片加载完成代表截图首帧可显示；npm test 的 mirror loading 验证未完成、成功及图片错误状态。
img.onload=()=>{if(mode==='screencap')setPresentation('live')};
img.onerror=()=>{if(mode==='screencap'){const text='投屏画面加载失败';msg.textContent=text;setPresentation('error',text)}};
// 绘制模拟器 RGBA 帧后退出加载，尺寸/方向变化同步布局视口；npm test 的 mirror loading/navigation frame updates 验证。
function onRgba(m){const d=m.data instanceof Uint8Array?m.data:new Uint8Array(m.data);
 const changed=fw!==m.w||fh!==m.h;if(cv.width!==m.w||cv.height!==m.h){cv.width=m.w;cv.height=m.h}const wasLand=fw>fh;fw=m.w;fh=m.h;if(changed)layout();if((fw>fh)!==wasLand)sendVp();
 ctx.putImageData(new ImageData(new Uint8ClampedArray(d.buffer,d.byteOffset,m.w*m.h*4),m.w,m.h),0,0);
 setPresentation('live');msg.textContent=fw+'×'+fh+' · emulator';send({type:'ack'})}
// 输入设备快照，保留原生按钮并安全更新完整名称；device-manager-ui 的 device dropdown 回归断言选项/空态，LOGCAT_BROWSER=1 的 Device Tools browser 回归在深浅主题及窄屏断言标签省略、箭头分隔和刷新后结构。
function renderDevices(m){
 const selected=m.devices.find(d=>d.serial===m.serial&&d.state==='device');
 document.body.classList.toggle('empty',!selected);
 dev.replaceChildren(dev.querySelector('button'));
 const placeholder=document.createElement('option');placeholder.value='';placeholder.textContent=m.devices.length?'Select Device':'No devices';dev.appendChild(placeholder);
 for(const d of m.devices){const option=document.createElement('option');option.value=d.serial;option.textContent=d.label+' ('+d.serial+')'+(d.state==='device'?'':' ('+d.state+')');option.disabled=d.state!=='device';option.title=d.serial;dev.appendChild(option)}
 dev.value=selected?selected.serial:'';dev.title=selected?selected.label+' ('+selected.serial+')':'Select Device';tdot.style.display=selected?'block':'none';
 const physical=selected&&selected.physical;document.getElementById('tic-d').innerHTML=physical?${JSON.stringify(icons['physical-dark'])}:${JSON.stringify(icons['virtual-dark'])};document.getElementById('tic-l').innerHTML=physical?${JSON.stringify(icons['physical-light'])}:${JSON.stringify(icons['virtual-light'])};
 if(!selected){msg.textContent=m.devices.length?'Select a device.':'No devices connected.';img.removeAttribute('src');ctx.clearRect(0,0,cv.width,cv.height)}
}
addEventListener('message',({data:m})=>{
 // 接收帧消息并同步截图模式画面与底部导航；npm test 的 mirror navigation frame updates 验证尺寸和布局调用。
 if(m.type==='video')onVideo(m.kind,m.data);
 else if(m.type==='rgba')onRgba(m);
 else if(m.type==='recording'){rec.classList.toggle('on',m.on);rec.title=m.on?'Stop recording':'Record screen';clearInterval(tm);timer.textContent='';if(m.on){const t0=Date.now();tm=setInterval(()=>{const s=Math.floor((Date.now()-t0)/1000);timer.textContent=Math.floor(s/60)+':'+String(s%60).padStart(2,'0')},500)}}
 else if(m.type==='frame'){fw=m.w;fh=m.h;img.src='data:image/png;base64,'+m.data;layout();msg.textContent=m.w+'×'+m.h}
 else if(m.type==='mode'){setMode(m.mode);spsKey=undefined;if(m.mode==='scrcpy'&&typeof VideoDecoder==='undefined')send({type:'noDecoder'})}
 else if(m.type==='loading')setPresentation('loading');
  else if(m.type==='devices')renderDevices(m);
 else if(m.type==='select'){dev.value=m.serial}
 else if(m.type==='skin')setSkin(m.skin);
 else if(m.type==='compose')compose(m);
 else if(m.type==='error'){msg.textContent=m.text;if(frame.dataset.state!=='live')setPresentation('error',m.text)};});
send({type:'ready'});
</script><script src="${art.panel}"></script><script src="${art.processesScript}"></script><script src="${art.explorerScript}"></script></body></html>`;
}
