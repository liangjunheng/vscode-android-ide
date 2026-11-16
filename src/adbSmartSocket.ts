import * as net from 'node:net';

export interface SmartSocket {
  connecting?: boolean;
  readyState?: string;
  write(data: Buffer | string): boolean;
  destroy(error?: Error): this;
  on(event: string, listener: (...args: any[]) => void): this;
  off(event: string, listener: (...args: any[]) => void): this;
  setTimeout?(timeout: number, callback?: () => void): this;
}
export type SocketFactory = (port: number, host: string) => SmartSocket;
const LIMIT = 8 * 1024 * 1024;

// 生成可识别取消错误；真实模块的分片/取消回归见 device-explorer-processes.test.js。
function cancelled(): Error { const error = new Error('ADB operation cancelled'); error.name = 'AbortError'; return error; }

// TCP 字节读器拥有全部监听和pending读取，先消费完整缓存再报告EOF；协议回归逐字节/合包/截断断言。
export class FrameReader {
  private buffer = Buffer.alloc(0);
  private pending: { size: number; resolve: (data: Buffer) => void; reject: (error: Error) => void }[] = [];
  private failure?: Error;
  private readonly data = (value: Buffer) => { if (this.buffer.length + value.length > LIMIT) { this.socket.destroy(new Error('ADB input exceeds buffer limit')); return; } this.buffer = Buffer.concat([this.buffer, value]); this.drain(); };
  private readonly end = () => this.fail(new Error('ADB socket EOF'));
  private readonly close = () => this.fail(new Error('ADB socket closed'));
  private readonly error = (error: Error) => this.fail(error);
  private readonly abort = () => this.socket.destroy(cancelled());

  // 在任何写入前安装监听，避免同步或同帧响应丢失；协议回归使用真实Duplex执行生产读器。
  constructor(private readonly socket: SmartSocket, private readonly signal?: AbortSignal) {
    socket.on('data', this.data).on('end', this.end).on('close', this.close).on('error', this.error);
    signal?.addEventListener('abort', this.abort, { once: true });
    if (signal?.aborted) { this.abort(); }
  }

  // 只接受有界整数长度，失败后的读取立即拒绝，不留下永不完成的Promise；协议回归覆盖EOF与恶意长度。
  readExact(size: number): Promise<Buffer> {
    if (!Number.isSafeInteger(size) || size < 0 || size > LIMIT) { return Promise.reject(new Error('Invalid ADB read size')); }
    return new Promise((resolve, reject) => { this.pending.push({ size, resolve, reject }); this.drain(); });
  }

  // ADB长度为4位ASCII hex，不是二进制整数；协议回归覆盖空列表、错误hex及分片。
  async readLength(): Promise<Buffer> {
    const text = (await this.readExact(4)).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(text)) { throw new Error('Malformed ADB frame length: ' + text); }
    return this.readExact(parseInt(text, 16));
  }

  // 按队列消费缓存，错误终结不足字节的读取；协议回归验证失败后新读不会挂起。
  private drain(): void {
    while (this.pending.length) {
      const request = this.pending[0];
      if (this.buffer.length >= request.size) { this.pending.shift(); const data = this.buffer.subarray(0, request.size); this.buffer = this.buffer.subarray(request.size); request.resolve(data); }
      else if (this.failure) { this.pending.shift(); request.reject(this.failure); }
      else { break; }
    }
  }

  // 一个终结错误拒绝全部在途读取；协议回归断言关闭和取消时pending清零。
  private fail(error: Error): void { this.failure ??= error; this.drain(); }

  // 关闭后释放自己安装的所有监听和signal引用；协议回归断言没有残留订阅。
  dispose(): void {
    this.fail(new Error('ADB reader disposed'));
    this.socket.off('data', this.data).off('end', this.end).off('close', this.close).off('error', this.error);
    this.signal?.removeEventListener('abort', this.abort);
  }
}

interface Connection { socket: SmartSocket; reader: FrameReader; closed: Promise<void>; dispose: () => Promise<void>; }

// 只实现ADB已提供的smart socket服务，不接管USB/auth；协议回归使用fake socket而非替换生产逻辑。
export class AdbSmartSocket {
  constructor(private readonly factory: SocketFactory = (port, host) => net.createConnection({ port, host })) {}

  // TCP环境配置显式解析，非TCP不偷换server；协议回归断言端口边界与不支持地址。
  static endpoint(): { host: string; port: number } {
    const value = process.env.ADB_SERVER_SOCKET || 'tcp:127.0.0.1:5037';
    const match = /^tcp:(?:\[([^\]]+)\]|([^:]+)):(\d+)$/.exec(value);
    if (!match) { throw new Error('Unsupported ADB_SERVER_SOCKET: ' + value); }
    const port = Number(match[3]); if (port < 1 || port > 65535) { throw new Error('Invalid ADB server port'); }
    return { host: match[1] || match[2], port };
  }

  // 连接拥有reader、关闭Promise和超时监听；失败先等待close再释放，协议回归覆盖各阶段Abort/EOF。
  private async open(signal?: AbortSignal): Promise<Connection> {
    signal?.throwIfAborted();
    const { host, port } = AdbSmartSocket.endpoint(); const socket = this.factory(port, host);
    let close!: () => void; const closed = new Promise<void>(resolve => { close = resolve; });
    socket.on('close', close);
    const reader = new FrameReader(socket, signal);
    const timeout = () => socket.destroy(new Error('ADB request timed out'));
    socket.setTimeout?.(10000, timeout);
    const dispose = async () => { socket.destroy(); await closed; socket.setTimeout?.(0); socket.off('timeout', timeout).off('close', close); reader.dispose(); };
    try {
      if (socket.connecting !== false && socket.readyState !== 'open') {
        await new Promise<void>((resolve, reject) => {
          const clean = () => { socket.off('connect', ready).off('error', failed).off('close', ended); signal?.removeEventListener('abort', abort); };
          const ready = () => { clean(); resolve(); }, failed = (error: Error) => { clean(); reject(error); }, ended = () => failed(new Error('ADB connection closed')), abort = () => failed(cancelled());
          socket.on('connect', ready).on('error', failed).on('close', ended); signal?.addEventListener('abort', abort, { once: true });
          if (signal?.aborted) { abort(); }
        });
      }
      signal?.throwIfAborted(); return { socket, reader, closed, dispose };
    } catch (error) { await dispose(); throw error; }
  }

  // UTF-8字节数构造4hex请求并消费OKAY/FAIL；协议回归严格核对发送内容和错误正文。
  private async request(connection: Connection, command: string): Promise<void> {
    const data = Buffer.from(command); if (data.length > 65535 || command.includes('\0')) { throw new Error('Invalid ADB command'); }
    connection.socket.write(Buffer.concat([Buffer.from(data.length.toString(16).padStart(4, '0')), data]));
    const status = (await connection.reader.readExact(4)).toString('ascii');
    if (status === 'FAIL') { throw new Error((await connection.reader.readLength()).toString('utf8')); }
    if (status !== 'OKAY') { throw new Error('Invalid ADB status: ' + status); }
  }

  // 选transport后再请求服务，串号不能含NUL；协议回归保证设备消息不拼成非法组合命令。
  private async transport(connection: Connection, serial: string, service: string): Promise<void> {
    if (!serial || serial.includes('\0')) { throw new Error('Invalid device serial'); }
    await this.request(connection, 'host:transport:' + serial); await this.request(connection, service);
  }

  // 单次host服务有长度前缀，必须await正文后才关闭；协议回归防止finally提前销毁。
  async command(command: string, signal?: AbortSignal): Promise<Buffer> {
    const connection = await this.open(signal);
    try { await this.request(connection, command); return await connection.reader.readLength(); } finally { await connection.dispose(); }
  }

  // 一次transport长度服务查询，shell应使用下面有退出码的shellV2；协议回归区分两种帧格式。
  async transportCommand(serial: string, service: string, signal?: AbortSignal): Promise<Buffer> {
    const connection = await this.open(signal);
    try { await this.transport(connection, serial, service); return await connection.reader.readLength(); } finally { await connection.dispose(); }
  }

  // shell v2按stdout/stderr/exit独立帧读取，非零退出绝不伪成功；协议回归覆盖空输出force-stop与Failure。
  async shell(serial: string, command: string, signal?: AbortSignal): Promise<Buffer> {
    const connection = await this.open(signal); const output: Buffer[] = [], errors: Buffer[] = []; let size = 0;
    try {
      await this.transport(connection, serial, 'shell,v2,raw:' + command);
      while (true) {
        const header = await connection.reader.readExact(5), id = header[0], length = header.readUInt32LE(1);
        const body = await connection.reader.readExact(length);
        size += length; if (size > LIMIT) { throw new Error('ADB shell output exceeds limit'); }
        if (id === 1) { output.push(body); } else if (id === 2) { errors.push(body); }
        else if (id === 3) { if (body.length !== 1 && body.length !== 4) { throw new Error('Malformed ADB shell exit'); } const code = body.length === 1 ? body[0] : body.readUInt32LE(0); if (code !== 0) { throw new Error(Buffer.concat(errors).toString('utf8') || Buffer.concat(output).toString('utf8') || 'ADB shell exited ' + code); } return Buffer.concat(output); }
        else { throw new Error('Unexpected ADB shell stream ' + id); }
      }
    } finally { await connection.dispose(); }
  }

  // tracker是事件流而非轮询；stop等待所有socket读取结束，协议回归断言切换/取消不残留连接。
  trackJdwp(serial: string, onUpdate: (pids: number[]) => void, onError: (error: Error) => void, signal?: AbortSignal): () => Promise<void> {
    const controller = new AbortController(); const abort = () => controller.abort(signal?.reason || cancelled());
    signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) { abort(); }
    let stopped = false;
    const done = (async () => {
      let connection: Connection | undefined;
      try {
        connection = await this.open(controller.signal); await this.transport(connection, serial, 'track-jdwp');
        // 长连接正常空闲不应触发一次请求的读超时，取消和断开仍由真实连接事件处理。
        connection.socket.setTimeout?.(0);
        while (!controller.signal.aborted) { const text = (await connection.reader.readLength()).toString('ascii'); const values = text.trim() ? text.trim().split(/\s+/) : []; if (values.some(value => !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) <= 0)) { throw new Error('Malformed JDWP process list'); } onUpdate([...new Set(values.map(Number))]); }
      } catch (error) { if (!stopped) { onError(error instanceof Error ? error : new Error(String(error))); } }
      finally { if (connection) { await connection.dispose(); } signal?.removeEventListener('abort', abort); }
    })();
    return async () => { stopped = true; controller.abort(cancelled()); await done; };
  }

  // 独占短JDWP会话，消费事件直到对应request-id回复，完整握手及帧长度有断言；协议回归验证HELO和Exit。
  async jdwp(serial: string, pid: number, packet: Buffer, signal?: AbortSignal, onEvent?: (commandSet: number, command: number, body: Buffer) => void): Promise<Buffer> {
    if (!Number.isSafeInteger(pid) || pid <= 0 || packet.length < 11) { throw new Error('Invalid JDWP request'); }
    const connection = await this.open(signal);
    try {
      await this.transport(connection, serial, 'jdwp:' + pid); connection.socket.write(Buffer.from('JDWP-Handshake'));
      if (!(await connection.reader.readExact(14)).equals(Buffer.from('JDWP-Handshake'))) { throw new Error('JDWP handshake failed'); }
      connection.socket.write(packet);
      while (true) {
        const header = await connection.reader.readExact(11), length = header.readUInt32BE(0);
        if (length < 11 || length > LIMIT) { throw new Error('Malformed JDWP length'); }
        const body = await connection.reader.readExact(length - 11);
        if (header[8] & 0x80) {
          if (header.readUInt32BE(4) !== packet.readUInt32BE(4)) { throw new Error('Unexpected JDWP reply id'); }
          const error = header.readUInt16BE(9); if (error) { throw new Error('JDWP error ' + error); } return body;
        }
        if (!onEvent) { throw new Error('Unexpected JDWP event while awaiting reply'); }
        onEvent(header[9], header[10], body);
      }
    } finally { await connection.dispose(); }
  }

  // JDWP协议id只用于真实请求关联，不作为设备代次过滤；协议回归核对包头与命令正文。
  jdwpRequest(serial: string, pid: number, commandSet: number, command: number, body = Buffer.alloc(0), signal?: AbortSignal, onEvent?: (commandSet: number, command: number, body: Buffer) => void): Promise<Buffer> {
    const packet = Buffer.alloc(11 + body.length); packet.writeUInt32BE(packet.length, 0); packet.writeUInt32BE(1, 4); packet[9] = commandSet; packet[10] = command; body.copy(packet, 11); return this.jdwp(serial, pid, packet, signal, onEvent);
  }
}
