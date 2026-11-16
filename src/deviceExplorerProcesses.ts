import { AdbSmartSocket, SocketFactory } from './adbSmartSocket';

export type DebuggerState = 'default' | 'waiting' | 'attached' | 'error';
export interface ExplorerProcess { pid: number; name?: string; packageName?: string; abi?: string; vm?: string; userId?: number; debugger: DebuggerState; error?: string; }
export interface HeloMetadata { pid: number; name?: string; packageName?: string; abi?: string; vm?: string; userId?: number; }
const PACKAGE = /^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)+$/;

// DDMS长度以UTF-16 code unit计数，所有可选字段只能整段缺省；协议回归覆盖surrogate和截断拒绝。
class DdmsReader {
  private offset = 0;
  constructor(private readonly data: Buffer) {}
  get remaining(): number { return this.data.length - this.offset; }
  integer(): number { if (this.remaining < 4) { throw new Error('Truncated DDMS integer'); } const value = this.data.readInt32BE(this.offset); this.offset += 4; return value; }
  string(units: number): string { if (!Number.isSafeInteger(units) || units < 0 || units > this.remaining / 2) { throw new Error('Truncated DDMS string'); } const value = Buffer.from(this.data.subarray(this.offset, this.offset + units * 2)).swap16().toString('utf16le'); this.offset += units * 2; return value; }
  byte(): number { if (!this.remaining) { throw new Error('Truncated DDMS byte'); } return this.data[this.offset++]; }
}

// HELO reply包含8字节chunk头以及version/pid/两字符串长度；真实协议回归断言字段顺序，不用字符串猜测元数据。
export function parseHelo(body: Buffer): HeloMetadata {
  if (body.length < 8 || body.toString('ascii', 0, 4) !== 'HELO' || body.readUInt32BE(4) !== body.length - 8) { throw new Error('Malformed HELO chunk'); }
  const reader = new DdmsReader(body.subarray(8));
  const version = reader.integer(), pid = reader.integer(), vmLength = reader.integer(), nameLength = reader.integer();
  if (version < 1 || pid <= 0) { throw new Error('Invalid HELO process identity'); }
  const result: HeloMetadata = { pid, vm: reader.string(vmLength), name: reader.string(nameLength) };
  if (reader.remaining) { result.userId = reader.integer(); if (result.userId < 0) { throw new Error('Invalid HELO user'); } }
  if (reader.remaining) { result.abi = reader.string(reader.integer()); }
  if (reader.remaining) { reader.string(reader.integer()); }
  if (reader.remaining) { reader.byte(); }
  if (reader.remaining) { result.packageName = reader.string(reader.integer()); }
  if (reader.remaining) { reader.integer(); }
  if (reader.remaining) { throw new Error('Unexpected HELO trailing bytes'); }
  return result;
}

// PID集合由track-jdwp提供，元数据短连接明确拥有并回收；device-explorer-processes.test.js运行真实模块断言。
export class DeviceExplorerProcesses {
  private readonly adb: AdbSmartSocket;
  constructor(readonly serial: string, socketFactory?: SocketFactory) { this.adb = new AdbSmartSocket(socketFactory); }

  // 首次tracker帧后关闭发现连接，再查询准确元数据；协议回归断言EOF/Abort不返回伪空集合。
  async list(signal?: AbortSignal): Promise<ExplorerProcess[]> {
    let stop: (() => Promise<void>) | undefined;
    try {
      const pids = await new Promise<number[]>((resolve, reject) => { stop = this.adb.trackJdwp(this.serial, resolve, reject, signal); });
      await stop?.(); stop = undefined;
      return await Promise.all(pids.map(pid => this.describe(pid, signal)));
    } finally { await stop?.(); }
  }

  // tracker事件创建/释放真实PID资源，移除会取消查询；协议回归验证PID消失、相同PID重新出现和stop等待全部close。
  watch(onUpdate: (rows: ExplorerProcess[]) => void, onError: (error: Error) => void, signal?: AbortSignal): () => Promise<void> {
    const controller = new AbortController(); const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) { abort(); }
    const records = new Map<number, { controller: AbortController; row: ExplorerProcess; done: Promise<void> }>();
    const owned = new Set<Promise<void>>();
    const publish = () => { if (!controller.signal.aborted) { onUpdate([...records.values()].map(record => record.row)); } };
    const stopTracker = this.adb.trackJdwp(this.serial, pids => {
      const active = new Set(pids);
      for (const [pid, record] of records) { if (!active.has(pid)) { record.controller.abort(); records.delete(pid); } }
      for (const pid of pids) {
        if (records.has(pid)) { continue; }
        const child = new AbortController(); const cancel = () => child.abort(controller.signal.reason); controller.signal.addEventListener('abort', cancel, { once: true });
        const record = { controller: child, row: { pid, debugger: 'error' as DebuggerState }, done: Promise.resolve() };
        records.set(pid, record);
        record.done = this.describe(pid, child.signal).then(row => { child.signal.throwIfAborted(); record.row = row; publish(); }, error => { if (!child.signal.aborted) { onError(error instanceof Error ? error : new Error(String(error))); } }).finally(() => { controller.signal.removeEventListener('abort', cancel); owned.delete(record.done); });
        owned.add(record.done);
      }
      publish();
    }, error => { if (!controller.signal.aborted) { onError(error); } }, controller.signal);
    return async () => { controller.abort(); await stopTracker(); await Promise.allSettled([...owned]); records.clear(); signal?.removeEventListener('abort', abort); };
  }

  // 请求DDMS HELO，不抢占外部调试器，失败保留明确未知/error；协议回归断言请求chunk与元数据身份。
  private async describe(pid: number, signal?: AbortSignal): Promise<ExplorerProcess> {
    let waiting = false;
    const request = Buffer.alloc(12); request.write('HELO', 0, 'ascii'); request.writeUInt32BE(4, 4); request.writeUInt32BE(1, 8);
    try {
      const body = await this.adb.jdwpRequest(this.serial, pid, 0xc7, 1, request, signal, (set, command, event) => {
        if (set === 64 && command === 100) { return; }
        if (set !== 0xc7 || command !== 1 || event.length < 8 || event.readUInt32BE(4) !== event.length - 8) { throw new Error('Malformed DDMS event'); }
        const type = event.toString('ascii', 0, 4);
        if (type === 'WAIT') { if (event.length !== 9) { throw new Error('Malformed WAIT chunk'); } waiting = true; }
        else if (type !== 'APNM') { throw new Error('Unsupported DDMS event ' + type); }
      });
      signal?.throwIfAborted(); const result = parseHelo(body); if (result.pid !== pid) { throw new Error('HELO PID does not match selected process'); }
      return { ...result, debugger: waiting ? 'waiting' : 'default' };
    } catch (error) { signal?.throwIfAborted(); return { pid, debugger: 'error', error: String(error) }; }
  }

  // 精确发送一次VirtualMachine.Exit(1)，不是Unix kill也不是force-stop；协议回归核对命令0x0a和正文。
  async kill(pid: number, signal?: AbortSignal): Promise<void> { await this.adb.jdwpRequest(this.serial, pid, 1, 0x0a, Buffer.from([0, 0, 0, 1]), signal); }

  // 包级停止独立于VM退出，userId必须真实非负整数；协议回归断言准确包/user及退出错误。
  async forceStop(packageName: string, userId?: number, signal?: AbortSignal): Promise<void> { await this.manage(['am', 'force-stop'], packageName, userId, signal); }
  // 清数据仅调用pm clear并等待Success；协议回归防止把普通stdout视为完成。
  async clearData(packageName: string, userId?: number, signal?: AbortSignal): Promise<void> { await this.manage(['pm', 'clear'], packageName, userId, signal, true); }
  // 卸载仅针对明确包名，不运行legacy backup；协议回归验证失败文本及非法输入。
  async uninstall(packageName: string, signal?: AbortSignal): Promise<void> { await this.manage(['pm', 'uninstall'], packageName, undefined, signal, true); }

  // shell v2提供真实退出码，参数均经验证不经过本机shell；协议回归覆盖拒绝注入和非零失败。
  private async manage(command: string[], packageName: string, userId: number | undefined, signal?: AbortSignal, requireSuccess = false): Promise<void> {
    if (typeof packageName !== 'string' || !PACKAGE.test(packageName)) { throw new Error('Invalid package name'); }
    if (userId !== undefined && (!Number.isSafeInteger(userId) || userId < 0)) { throw new Error('Invalid userId'); }
    const args = [...command, ...(userId === undefined ? [] : ['--user', String(userId)]), packageName];
    const output = (await this.adb.shell(this.serial, args.join(' '), signal)).toString('utf8').trim();
    if (/^(?:Failure|Error|Exception)/im.test(output) || (requireSuccess && output !== 'Success')) { throw new Error(output || 'Package manager did not report Success'); }
  }
}
