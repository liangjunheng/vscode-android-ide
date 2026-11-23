import { execFile } from 'node:child_process';
import * as net from 'node:net';
import { AdbSmartSocket, FrameReader } from '../adbSmartSocket';
import { adbPath } from '../sdk';

const PACKAGE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+$/;
const ACTIVITY = /^\.?[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*$/;
type Lease = { close(): Promise<void> };

// 功能：拒绝不安全包名；输入外部包名；输出校验结果；验证：模拟设备注入用例。
function checkPackage(value: string): void {
  if (!PACKAGE.test(value)) { throw new Error('非法包名: ' + value); }
}

// 功能：拒绝非正整数进程号；输入外部PID；输出校验结果；验证：模拟设备注入用例。
function checkPid(pid: number): void {
  if (!Number.isSafeInteger(pid) || pid <= 0) { throw new Error('非法PID'); }
}

// 功能：保留取消原因；输入已取消信号；输出可传播错误；验证：模拟设备取消用例。
function abortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) { return signal.reason; }
  return new Error('设备操作已取消', { cause: signal.reason });
}

// 功能：同时保留业务与清理错误；输入业务错误和资源；输出始终拒绝；验证：模拟设备清理用例。
async function failed(error: unknown, lease: Lease): Promise<never> {
  try { await lease.close(); }
  catch (cleanup) { throw new AggregateError([error, cleanup], '设备操作及清理失败'); }
  throw error;
}

// 功能：规范同包Activity；输入安全包名与短名或组件；输出安全组件；验证：模拟设备启动和注入用例。
function component(packageName: string, activity: string): string {
  const parts = activity.split('/');
  if (parts.length > 2 || (parts.length === 2 && parts[0] !== packageName)) { throw new Error('非法Activity组件'); }
  const name = parts[parts.length - 1];
  if (!ACTIVITY.test(name)) { throw new Error('非法Activity'); }
  return packageName + '/' + (name.startsWith('.') ? packageName + name : name.includes('.') ? name : packageName + '.' + name);
}

// 功能：以参数数组调用ADB并保留退出错误；输入参数与可选信号；输出标准输出；验证：模拟设备命令用例。
function adb(args: string[], signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    execFile(adbPath(), args, { encoding: 'utf8', signal }, (error, stdout, stderr) => {
      if (signal?.aborted) { reject(abortError(signal)); }
      else if (error) { reject(new Error(String(stderr || stdout || error.message).trim(), { cause: error })); }
      else { resolve(String(stdout)); }
    });
  });
}

// 功能：解析唯一PID和精确进程名；输入ps固定列输出；输出进程表；验证：模拟设备客户端和启动用例。
function processes(text: string): { pid: number; name: string }[] {
  const lines = text.trim().split(/\r?\n/);
  if (!/^\s*PID\s+NAME\s*$/.test(lines.shift() || '')) { throw new Error('非法ps列头'); }
  return lines.filter(line => line.trim()).map(line => {
    const match = /^\s*(\d+)\s+(\S+)\s*$/.exec(line);
    if (!match) { throw new Error('非法ps进程行'); }
    const pid = Number(match[1]); checkPid(pid);
    return { pid, name: match[2] };
  });
}

// 功能：缓冲订阅事件并在取消或断线时终结等待；输入设备和信号；输出单消费者订阅；验证：模拟设备事件用例。
function watch(serial: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const queue: number[][] = [];
  let failure: Error | undefined;
  let pending: { resolve(value: number[]): void; reject(error: Error): void } | undefined;
  // 功能：终结当前及后续读取；输入终结错误；输出等待拒绝；验证：模拟设备取消和断线用例。
  const fail = (error: Error) => { failure ??= error; pending?.reject(failure); pending = undefined; };
  // 功能：传递取消原因；输入所属信号；输出订阅读取失败；验证：模拟设备取消用例。
  const abort = () => fail(abortError(signal!));
  signal?.addEventListener('abort', abort, { once: true });
  let stop: () => Promise<void>;
  try {
    stop = new AdbSmartSocket().trackJdwp(serial, pids => {
      if (failure) { return; }
      if (pending) { const request = pending; pending = undefined; request.resolve([...pids]); }
      else { queue.push([...pids]); }
    }, fail, signal);
  } catch (error) { signal?.removeEventListener('abort', abort); throw error; }
  if (signal?.aborted) { abort(); }
  return {
    // 功能：消费一帧而非轮询；输入事件队列；输出PID集合；验证：模拟设备首帧和启动用例。
    next(): Promise<number[]> {
      if (failure) { return Promise.reject(failure); }
      if (queue.length) { return Promise.resolve(queue.shift()!); }
      return new Promise((resolve, reject) => { pending = { resolve, reject }; });
    },
    // 功能：确认订阅未异常终结；输入当前状态；输出失败时抛错；验证：模拟设备断线用例。
    check(): void { if (failure) { throw failure; } },
    // 功能：等待真实订阅退出；输入自有订阅；输出资源已关闭；验证：模拟设备清理用例。
    async close(): Promise<void> {
      signal?.removeEventListener('abort', abort);
      fail(new Error('JDWP订阅已关闭'));
      await stop();
    },
  };
}

// 功能：提供简单Debug和Attach设备操作；输入设备身份；输出不依赖会话协调器的设备API；验证：七项模拟设备测试。
export class DebugDevice {
  // 功能：保存安全设备身份；输入串号及可选项目根；输出设备对象；验证：模拟设备注入用例。
  constructor(readonly serial: string, readonly projectRoot?: string) {
    if (!serial || /[\s\x00-\x1f\x7f]/.test(serial) || serial.startsWith('-')) { throw new Error('非法设备串号'); }
  }

  // 功能：读取全部连接状态并准确传播取消；输入可选信号；输出串号和状态；验证：模拟设备枚举及取消用例。
  static async devices(signal?: AbortSignal): Promise<{ serial: string; state: string }[]> {
    signal?.throwIfAborted();
    let text: string;
    try { text = (await new AdbSmartSocket().command('host:devices', signal)).toString('utf8'); }
    catch (error) { if (signal?.aborted) { throw abortError(signal); } throw error; }
    signal?.throwIfAborted();
    return text.split(/\r?\n/).filter(line => line.trim()).map(line => {
      const match = /^(\S+)\t([^\t\r\n]+)$/.exec(line);
      if (!match) { throw new Error('非法设备列表'); }
      return { serial: match[1], state: match[2] };
    });
  }

  // 功能：执行有退出码的shell并保留取消和Android错误；输入安全命令及信号；输出正文；验证：模拟设备错误及取消用例。
  private async shell(command: string, signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted();
    let text: string;
    try { text = (await new AdbSmartSocket().shell(this.serial, command, signal)).toString('utf8'); }
    catch (error) { if (signal?.aborted) { throw abortError(signal); } throw error; }
    signal?.throwIfAborted();
    if (/(?:^|\n)\s*(?:Error\b|Exception\b|Status\s*:\s*error\b|Failure\b)|\b[A-Za-z_$][\w.$]*Exception\b/i.test(text)) {
      throw new Error(text.trim());
    }
    return text;
  }

  // 功能：首帧检查终结状态后关闭订阅并匹配ps；输入可选信号；输出合法包客户端；验证：模拟设备客户端及首帧断线用例。
  async clients(signal?: AbortSignal): Promise<{ pid: number; packageName: string }[]> {
    const tracker = watch(this.serial, signal);
    let pids: number[];
    try { pids = await tracker.next(); tracker.check(); signal?.throwIfAborted(); }
    catch (error) { return failed(error, tracker); }
    await tracker.close();
    const members = new Set(pids);
    return processes(await this.shell('ps -A -o PID,NAME', signal)).flatMap(({ pid, name }) => {
      const packageName = name.split(':')[0];
      return members.has(pid) && PACKAGE.test(packageName) ? [{ pid, packageName }] : [];
    });
  }

  // 功能：强停安装并调试启动唯一主进程；输入包名、Activity、APK和取消信号；输出PID；验证：模拟设备启动和错误用例。
  async launch(packageName: string, activity: string | undefined, apkPath: string | undefined, signal: AbortSignal): Promise<number> {
    checkPackage(packageName);
    let target = activity === undefined ? undefined : component(packageName, activity);
    if (apkPath !== undefined && (!apkPath || apkPath.startsWith('-') || apkPath.includes('\0'))) { throw new Error('非法APK路径'); }
    signal.throwIfAborted();
    await this.shell('am force-stop ' + packageName, signal);
    if (apkPath !== undefined) {
      const output = await adb(['-s', this.serial, 'install', '-r', apkPath], signal);
      if (!/^Success\s*$/m.test(output) || /\b(?:Failure|Error|Exception)\b/i.test(output)) { throw new Error('安装失败: ' + output.trim()); }
    }
    if (target === undefined) {
      const output = await this.shell('cmd package resolve-activity --brief -a android.intent.action.MAIN -c android.intent.category.LAUNCHER ' + packageName, signal);
      const candidates = output.split(/\r?\n/).map(line => line.trim()).filter(line => line.includes('/'));
      if (candidates.length !== 1) { throw new Error('无法解析唯一Launcher Activity'); }
      target = component(packageName, candidates[0]);
    }
    const tracker = watch(this.serial, signal);
    let pid: number;
    try {
      let snapshot = await tracker.next();
      // 启动成功是消费PID的门；首帧确认订阅已建立，期间事件均保留。
      await this.shell('am start -D -n ' + target, signal);
      while (true) {
        signal.throwIfAborted();
        const members = new Set(snapshot);
        const matches = processes(await this.shell('ps -A -o PID,NAME', signal)).filter(value => value.name === packageName && members.has(value.pid));
        tracker.check();
        if (matches.length > 1) { throw new Error('发现多个主进程PID'); }
        if (matches.length === 1) { pid = matches[0].pid; break; }
        snapshot = await tracker.next();
      }
    } catch (error) { return failed(error, tracker); }
    await tracker.close();
    signal.throwIfAborted();
    return pid;
  }

  // 功能：强停指定包；输入安全包名；输出命令完成；验证：模拟设备停止和错误用例。
  async stop(packageName: string): Promise<void> {
    checkPackage(packageName);
    await this.shell('am force-stop ' + packageName);
  }

  // 功能：清除设备调试应用设置；输入当前设备；输出命令完成；验证：模拟设备停止和错误用例。
  async clearDebugApp(): Promise<void> { await this.shell('am clear-debug-app'); }

  // 功能：分配自有动态转发且取消后精确回收；输入PID和信号；输出端口租约；验证：模拟设备转发用例。
  async forward(pid: number, signal: AbortSignal): Promise<{ port: number; close(): Promise<void> }> {
    checkPid(pid); signal.throwIfAborted();
    // 分配不杀子进程，确保取消竞态仍能取得端口；未知结果绝不批量删除。
    const output = (await adb(['-s', this.serial, 'forward', 'tcp:0', 'jdwp:' + pid])).trim();
    if (!/^\d+$/.test(output) || Number(output) < 1 || Number(output) > 65535) { throw new Error('非法ADB转发端口: ' + output); }
    const port = Number(output);
    let closing: Promise<void> | undefined;
    const lease = { port,
      // 功能：幂等移除唯一自有端口；输入租约；输出删除完成；验证：模拟设备转发清理用例。
      close: () => closing ??= adb(['-s', this.serial, 'forward', '--remove', 'tcp:' + port]).then(() => undefined),
    };
    if (signal.aborted) { return failed(abortError(signal), lease); }
    return lease;
  }

  // 功能：为纯原生调试解除Java等待并保留连接；输入PID和信号；输出长寿命租约；验证：模拟设备JDWP协议用例。
  async resume(pid: number, signal: AbortSignal): Promise<Lease> {
    const forwarding = await this.forward(pid, signal);
    const socket = new net.Socket();
    const frames = new FrameReader(socket);
    let endReads!: (error: Error) => void;
    const terminal = new Promise<Error>(resolve => { endReads = resolve; });
    // 功能：独立于帧读器的close支持结算读取；输入所需字节数；输出帧或准确终结原因；验证：模拟设备提前close用例。
    const reader = { readExact: (size: number): Promise<Buffer> => Promise.race([
      frames.readExact(size), terminal.then(error => { throw error; }),
    ]) } as FrameReader;
    let failure: Error | undefined, closing = false;
    let cleanup: Promise<unknown> | undefined;
    const closed = new Promise<void>(resolve => socket.once('close', resolve));
    // 功能：先让帧读器收到关闭，再卸载监听并回收转发；输入自有资源；输出聚合清理结果；验证：模拟设备清理用例。
    const dispose = (): Promise<unknown> => {
      if (!cleanup) {
        closing = true;
        cleanup = (async () => {
          const errors: unknown[] = [];
          try { socket.destroy(); await closed; }
          catch (error) { errors.push(error); }
          try { frames.dispose(); }
          catch (error) { errors.push(error); }
          socket.off('error', onError).off('end', onEnd).off('close', onClose);
          signal.removeEventListener('abort', onAbort);
          try { await forwarding.close(); }
          catch (error) { errors.push(error); }
          if (errors.length === 1) { throw errors[0]; }
          if (errors.length > 1) { throw new AggregateError(errors, 'JDWP资源清理失败'); }
        })().then(() => undefined, error => error);
      }
      return cleanup;
    };
    // 功能：结算所有读取后销毁socket并启动清理；输入终结错误；输出无悬挂读取；验证：模拟设备断线和取消用例。
    const terminate = (error: Error) => { failure ??= error; endReads(failure); socket.destroy(error); void dispose(); };
    // 功能：传递网络错误；输入socket错误；输出终结状态；验证：模拟设备网络错误用例。
    const onError = (error: Error) => terminate(error);
    // 功能：传递远端EOF；输入结束事件；输出终结状态；验证：模拟设备EOF用例。
    const onEnd = () => terminate(new Error('JDWP连接EOF'));
    // 功能：识别非主动关闭；输入关闭事件；输出终结状态；验证：模拟设备关闭用例。
    const onClose = () => { if (!closing) { terminate(new Error('JDWP连接已关闭')); } };
    // 功能：取消连接并回收转发；输入取消信号；输出终结状态；验证：模拟设备取消用例。
    const onAbort = () => terminate(abortError(signal));
    socket.on('error', onError).on('end', onEnd).on('close', onClose);
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      signal.throwIfAborted();
      await new Promise<void>((resolve, reject) => {
        // 功能：结算连接并卸载临时监听；输入连接事件；输出连接结果；验证：模拟设备连接取消用例。
        const finish = (error?: Error) => { socket.off('connect', ready).off('error', broken).off('close', ended); error ? reject(error) : resolve(); };
        // 功能：接受连接成功；输入connect事件；输出连接完成；验证：模拟设备握手用例。
        const ready = () => finish();
        // 功能：拒绝连接错误；输入error事件；输出连接失败；验证：模拟设备网络错误用例。
        const broken = (error: Error) => finish(error);
        // 功能：拒绝提前关闭；输入close事件；输出连接失败；验证：模拟设备取消用例。
        const ended = () => finish(failure || new Error('JDWP连接提前关闭'));
        socket.once('connect', ready).once('error', broken).once('close', ended);
        socket.connect(forwarding.port, '127.0.0.1');
      });
      socket.write('JDWP-Handshake');
      if (!(await reader.readExact(14)).equals(Buffer.from('JDWP-Handshake'))) { throw new Error('JDWP握手错误'); }
      const sizes = await jdwpCommand(socket, reader, 1, 7);
      if (sizes.length !== 20 || [0, 4, 8, 12, 16].some(offset => ![1, 2, 4, 8].includes(sizes.readInt32BE(offset)))) { throw new Error('非法JDWP IDSizes回复'); }
      const reply = await jdwpCommand(socket, reader, 2, 9);
      if (reply.length !== 0) { throw new Error('非法JDWP Resume回复'); }
      signal.throwIfAborted();
      if (failure) { throw failure; }
    } catch (error) {
      const primary = signal.aborted ? abortError(signal) : failure ?? error;
      const cleanupError = await dispose();
      if (cleanupError !== undefined) { throw new AggregateError([primary, cleanupError], 'JDWP操作及清理失败'); }
      throw primary;
    }
    return {
      // 功能：完成保留连接并报告终结或清理错误；输入自有租约；输出全部资源关闭；验证：模拟设备JDWP清理用例。
      async close(): Promise<void> {
        const cleanupError = await dispose();
        if (failure && cleanupError !== undefined) { throw new AggregateError([failure, cleanupError], 'JDWP连接及清理失败'); }
        if (failure) { throw failure; }
        if (cleanupError !== undefined) { throw cleanupError; }
      },
    };
  }

  // 功能：仅读取目标Package段主次ABI；输入安全包名及信号；输出去重非null ABI；验证：模拟设备ABI隔离用例。
  async abis(packageName: string, signal?: AbortSignal): Promise<string[]> {
    checkPackage(packageName);
    const lines = (await this.shell('dumpsys package ' + packageName, signal)).split(/\r?\n/);
    const sections = lines.flatMap((line, index) => {
      const header = /^([ \t]*)Package \[([^\]]+)\](?: \([^)]*\))?:[ \t]*$/.exec(line);
      return header?.[2] === packageName ? [{ index, indent: header[1].length }] : [];
    });
    if (sections.length !== 1) { throw new Error('无法定位唯一已安装包段: ' + packageName); }
    const { index, indent } = sections[0];
    const values: string[] = [];
    const fields = new Set<string>();
    for (const line of lines.slice(index + 1)) {
      if (!line.trim()) { continue; }
      if (/^[ \t]*/.exec(line)![0].length <= indent) { break; }
      const field = /^[ \t]*(primaryCpuAbi|secondaryCpuAbi)=([^\s]+)[ \t]*$/.exec(line);
      if (!field) { continue; }
      if (fields.has(field[1])) { throw new Error('重复包ABI字段'); }
      fields.add(field[1]);
      if (field[2] === 'null') { continue; }
      if (!/^[A-Za-z0-9_-]+$/.test(field[2])) { throw new Error('非法包ABI'); }
      values.push(field[2]);
    }
    return [...new Set(values)];
  }
}

// 功能：严格读取对应JDWP回复并允许交错VM事件；输入已握手连接及命令；输出回复体；验证：模拟设备协议用例。
async function jdwpCommand(socket: net.Socket, reader: FrameReader, id: number, command: number): Promise<Buffer> {
  const packet = Buffer.alloc(11);
  packet.writeUInt32BE(11, 0); packet.writeUInt32BE(id, 4); packet[9] = 1; packet[10] = command;
  socket.write(packet);
  while (true) {
    const header = await reader.readExact(11), length = header.readUInt32BE(0);
    if (length < 11 || length > 8 * 1024 * 1024) { throw new Error('非法JDWP包长'); }
    const body = await reader.readExact(length - 11);
    if (header[8] === 0 && header[9] === 64 && header[10] === 100 && body.length >= 5 && body[0] <= 2) { continue; }
    if (header[8] !== 0x80 || header.readUInt32BE(4) !== id) { throw new Error('JDWP回复标志或ID不匹配'); }
    if (header.readUInt16BE(9) !== 0) { throw new Error('JDWP命令错误: ' + header.readUInt16BE(9)); }
    return body;
  }
}
