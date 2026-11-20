import * as net from 'net';
import { scrcpyServerPath } from './runtimeContext';
import { ChildProcess, spawn } from 'child_process';
import { adb, adbPath, freePort, sdkRoot, runBuffer } from './sdk';

// Must match the bundled resources/scrcpy/scrcpy-server.jar
export const SCRCPY_VERSION = '3.3.3';
const REMOTE_JAR = '/data/local/tmp/scrcpy-server-vscode.jar';
const POINTER_MOUSE = 0xffffffffffffffffn;

export type PacketKind = 'config' | 'key' | 'delta';

export interface ScrcpyHandlers {
  onPacket(kind: PacketKind, data: Buffer): void;
  onClose(reason?: string): void;
}

// 沿用服务启动时的连接尝试，仅ECONNREFUSED可接续；视频和控制socket关闭Nagle聚合，取消立即销毁当前句柄和等待计时器。view-idle传输回归验证无迟到重连。
function connectWithRetry(port: number, signal: AbortSignal, attempts = 20, waitForData = true): Promise<{ sock: net.Socket; first?: Buffer }> {
  return new Promise((resolve, reject) => {
    let n = 0, socket: net.Socket | undefined, timer: NodeJS.Timeout | undefined;
    const cleanup = () => { signal.removeEventListener('abort', abort); if (timer) { clearTimeout(timer); timer = undefined; } };
    const abort = () => { cleanup(); const owned = socket; socket = undefined; owned?.destroy(); reject(signal.reason); };
    const attempt = () => {
      if (signal.aborted) { abort(); return; }
      const sock = net.connect(port, '127.0.0.1'); sock.setNoDelay(true); socket = sock; let failure: NodeJS.ErrnoException | undefined;
      const onData = (data: Buffer | string) => { sock.pause(); cleanup(); socket = undefined; resolve({ sock, first: Buffer.isBuffer(data) ? data : Buffer.from(data) }); };
      if (waitForData) { sock.once('data', onData); }
      else { sock.once('connect', () => { cleanup(); socket = undefined; resolve({ sock }); }); }
      sock.once('error', (error: NodeJS.ErrnoException) => { failure = error; });
      sock.once('close', () => {
        if (socket !== sock) { return; } socket = undefined;
        const retryable = !failure || failure.code === 'ECONNREFUSED';
        if (!signal.aborted && retryable && ++n < attempts) { timer = setTimeout(attempt, 100); }
        else { cleanup(); reject(signal.aborted ? signal.reason : failure || new Error('scrcpy server closed before connect')); }
      });
    };
    signal.addEventListener('abort', abort, { once: true }); attempt();
  });
}

function firstData(sock: net.Socket, signal: AbortSignal): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const cleanup = () => signal.removeEventListener('abort', abort);
    const abort = () => { cleanup(); reject(signal.reason); };
    sock.once('data', data => { cleanup(); resolve(Buffer.isBuffer(data) ? data : Buffer.from(data)); });
    sock.once('error', error => { cleanup(); reject(error); });
    sock.once('close', () => { cleanup(); reject(new Error('scrcpy video closed before handshake')); });
    signal.addEventListener('abort', abort, { once: true });
  });
}

export class ScrcpySession {
  private proc?: ChildProcess;
  private video?: net.Socket;
  private control?: net.Socket;
  private listener?: net.Server;
  private stopped = false;
  private port = 0;
  private forwarded = false;
  private closing?: Promise<void>;
  private readonly controller = new AbortController();

  // 读取真实socket/子进程状态，不把停止对象当连接；view-idle传输回归验证关闭和复用检查。
  get connected(): boolean { return !this.stopped && !!this.video && !this.video.destroyed && !!this.control && !this.control.destroyed && this.proc?.exitCode === null; }

  // 创建任务每次异步继续前核对实际取消信号；view-idle回归覆盖push/forward/握手中停止。
  private requireOpen(): void { this.controller.signal.throwIfAborted(); }
  private log = '';

  constructor(private serial: string, private jarPath: string, private h: ScrcpyHandlers, private maxSize = 1920) {}

  // 逐步拥有push/forward/进程/socket，停止后不继续创建；view-idle传输回归覆盖创建中取消及forward清理。
  async start() {
    this.requireOpen();
    const scid = Math.floor(Math.random() * 0x7fffffff).toString(16).padStart(8, '0');
    await runBuffer(adbPath(), ['-s', this.serial, 'push', this.jarPath, REMOTE_JAR], this.controller.signal); this.requireOpen();
    this.port = await freePort(); this.requireOpen();
    await adb(this.serial, 'forward', `tcp:${this.port}`, `localabstract:scrcpy_${scid}`);
    this.forwarded = true;
    if (this.stopped) { await this.removeForward(); this.requireOpen(); }

    this.proc = spawn(adbPath(), ['-s', this.serial, 'shell',
      `CLASSPATH=${REMOTE_JAR}`, 'app_process', '/', 'com.genymobile.scrcpy.Server', SCRCPY_VERSION,
      `scid=${scid}`, 'log_level=debug', 'audio=false', 'tunnel_forward=true',
      `max_size=${this.maxSize}`, 'video_bit_rate=8000000', 'max_fps=60', 'stay_awake=false'],
      { env: { ...process.env, ANDROID_HOME: sdkRoot() } });
    const collect = (d: Buffer) => { this.log = (this.log + d.toString()).slice(-2000); };
    this.proc.stdout?.on('data', collect);
    this.proc.stderr?.on('data', collect);
    this.proc.on('exit', () => this.close(this.log.trim() || 'scrcpy server exited'));
    this.proc.on('error', error => { this.close(error.message); });

    // 正向隧道按Scrcpy协议建立两条连接：第一条video、第二条control；video首包确认server已完成桌面连接。
    const videoConnection = await connectWithRetry(this.port, this.controller.signal, 20, true);
    const sock = videoConnection.sock;
    if (this.stopped || sock.destroyed) { sock.destroy(); this.requireOpen(); throw new Error('scrcpy video closed before startup completed'); }
    this.video = sock;
    const controlConnection = await connectWithRetry(this.port, this.controller.signal, 20, false);
    const ctl = controlConnection.sock;
    this.control = ctl;
    ctl.on('data', () => { /* device messages (clipboard…) ignored */ });
    ctl.on('error', error => { this.close(error.message); });
    ctl.on('close', () => { this.close('control stream closed'); });
    const first = videoConnection.first;
    if (!first) { throw new Error('scrcpy video handshake did not provide an initial byte'); }
    sock.resume();
    this.readVideo(sock, first.subarray(1));
  }

  private readVideo(sock: net.Socket, initial: Buffer) {
    let buf = initial;
    let metaDone = false;
    const parse = () => {
      if (!metaDone) {
        if (buf.length < 76) { return; } // 64 name + 4 codec + 4 w + 4 h
        buf = buf.subarray(76);
        metaDone = true;
      }
      while (buf.length >= 12) {
        const hi = buf.readUInt32BE(0);
        const size = buf.readUInt32BE(8);
        if (buf.length < 12 + size) { return; }
        const kind: PacketKind = hi & 0x80000000 ? 'config' : hi & 0x40000000 ? 'key' : 'delta';
        this.h.onPacket(kind, Buffer.from(buf.subarray(12, 12 + size)));
        buf = buf.subarray(12 + size);
      }
    };
    sock.on('data', (d: Buffer) => { buf = buf.length ? Buffer.concat([buf, d]) : d; parse(); });
    sock.on('close', () => this.close('video stream closed'));
    sock.on('error', () => {});
    parse();
  }

  private send(b: Buffer) { if (this.control && !this.control.destroyed) { this.control.write(b); } }

  key(code: number) {
    for (const action of [0, 1]) {
      const b = Buffer.alloc(14);
      b.writeUInt8(0, 0); b.writeUInt8(action, 1); b.writeUInt32BE(code, 2);
      this.send(b);
    }
  }

  text(t: string) {
    const body = Buffer.from(t, 'utf8');
    const b = Buffer.alloc(5 + body.length);
    b.writeUInt8(1, 0); b.writeUInt32BE(body.length, 1); body.copy(b, 5);
    this.send(b);
  }

  /** action: 0=down 1=up 2=move */
  touch(action: number, x: number, y: number, w: number, h: number) {
    const b = Buffer.alloc(32);
    b.writeUInt8(2, 0); b.writeUInt8(action, 1); b.writeBigUInt64BE(POINTER_MOUSE, 2);
    b.writeInt32BE(Math.round(x), 10); b.writeInt32BE(Math.round(y), 14);
    b.writeUInt16BE(w, 18); b.writeUInt16BE(h, 20);
    b.writeUInt16BE(action === 1 ? 0 : 0xffff, 22);
    b.writeUInt32BE(1, 24); // action button: primary
    b.writeUInt32BE(action === 1 ? 0 : 1, 28);
    this.send(b);
  }

  scroll(x: number, y: number, w: number, h: number, vscroll: number) {
    const b = Buffer.alloc(21);
    b.writeUInt8(3, 0); b.writeInt32BE(Math.round(x), 1); b.writeInt32BE(Math.round(y), 5);
    b.writeUInt16BE(w, 9); b.writeUInt16BE(h, 11);
    b.writeInt16BE(0, 13);
    b.writeInt16BE(Math.max(-0x8000, Math.min(0x7fff, Math.round(vscroll * 0x8000))), 15);
    this.send(b);
  }

  rotate() { this.send(Buffer.from([11])); }
  expandNotifications() { this.send(Buffer.from([5])); }

  // 关闭真实句柄并保留异步forward释放任务，所有失败可观察；view-idle传输回归验证关闭中不再连接。
  private close(reason?: string): Promise<void> {
    if (this.stopped) { return this.closing || Promise.resolve(); }
    this.stopped = true; this.controller.abort(Object.assign(new Error('scrcpy session stopped'), { name: 'AbortError' }));
    this.video?.destroy(); this.control?.destroy(); this.listener?.close(); this.proc?.kill();
    this.closing = this.removeForward();
    void this.closing.catch(error => console.error('scrcpy forward cleanup failed', error));
    this.h.onClose(reason); return this.closing;
  }

  // 只删除实际创建完成的forward，创建期间取消由start在ACK后回收；view-idle回归验证无提前删除/重复删除。
  private async removeForward(): Promise<void> {
    if (!this.forwarded) { return; } this.forwarded = false;
    await adb(this.serial, 'reverse', '--remove', `tcp:${this.port}`);
  }

  // 明确停止返回真实清理Promise，提供方销毁会等待；view-idle回归验证forward关闭完成。
  stop(): Promise<void> { return this.close(); }
}

// scrcpy资源由RuntimeContext统一定位；runtime-context及view-idle回归验证推送文件和清理。
// 独立原生窗口只拥有scrcpy客户端进程，不把视频包送入VS Code Webview；进程退出时通知提供方释放设备状态。
export class NativeScrcpySession {
  private proc?: ChildProcess;
  private stopped = false;

  // 子进程仍存活时才视为独立投屏连接；native窗口回归验证退出后的状态变化。
  get connected(): boolean { return !this.stopped && !!this.proc && this.proc.exitCode === null; }

  constructor(private serial: string, private h: Pick<ScrcpyHandlers, 'onClose'>, private executable = process.platform === 'win32' ? 'scrcpy.exe' : 'scrcpy') {}

  // 启动官方scrcpy原生客户端并等待spawn事件；独立窗口使用原生解码/渲染，不占用Webview渲染链路。
  start(): Promise<void> {
    this.stopped = false;
    const proc = spawn(this.executable, ['-s', this.serial, '--no-audio', '--window-title', `VS Code Android - ${this.serial}`], {
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
      env: { ...process.env, ANDROID_HOME: sdkRoot(), ANDROID_SDK_ROOT: sdkRoot(), ADB: adbPath() },
    });
    this.proc = proc;
    return new Promise((resolve, reject) => {
      let started = false;
      let settled = false;
      proc.once('spawn', () => { started = true; settled = true; resolve(); });
      proc.once('error', error => { if (!started && !settled) { settled = true; reject(error); } });
      proc.once('exit', (code, signal) => {
        this.proc = undefined;
        if (!started && !settled) { settled = true; reject(new Error(this.stopped ? 'scrcpy stopped before startup completed' : `scrcpy exited (${code ?? signal ?? 'unknown'})`)); }
        if (!this.stopped) { this.stopped = true; this.h.onClose(code === 0 ? undefined : `scrcpy exited (${code ?? signal ?? 'unknown'})`); }
      });
    });
  }

  // 仅结束本次原生scrcpy客户端，不触碰ADB或其他设备连接；窗口关闭和扩展停止均复用此清理入口。
  stop(): void {
    this.stopped = true;
    const proc = this.proc;
    this.proc = undefined;
    if (proc && proc.exitCode === null) { proc.kill(); }
  }
}

// scrcpy资源由RuntimeContext统一定位；runtime-context及view-idle回归验证推送文件和清理。
export const bundledJar = (extPath: string) => scrcpyServerPath(extPath);
