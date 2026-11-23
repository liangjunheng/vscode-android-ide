import { AdbSmartSocket, SocketFactory } from './adbSmartSocket';

export type DebuggerState = 'unknown' | 'default' | 'waiting' | 'attached' | 'error';
export interface ExplorerProcess { pid: number; name?: string; packageName?: string; abi?: string; vm?: string; userId?: number; debugger: DebuggerState; error?: string; }
export interface HeloMetadata { pid: number; name?: string; packageName?: string; abi?: string; vm?: string; userId?: number; }

export interface ProcessSnapshot { pid: number; name?: string; packageName?: string; abi?: string; vm?: string; userId?: number; }

const PACKAGE = /^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)+$/;

// 从设备ps快照解析进程归属；输入来自shell而非本机shell，缺失字段保持缺失不伪造成功。
export function parseProcessSnapshot(output: string, pid: number): ProcessSnapshot {
  const lines = output.split(/\r?\n/);
  const header = lines.findIndex(line => /\bPID\b/.test(line) && /\bUSER\b/.test(line));
  const row = lines.slice(header + 1).map(line => /^\s*(\d+)\s+(\S+)\s+(\S+)(?:\s+(.*))?$/.exec(line)).find(match => match && Number(match[1]) === pid);
  if (!row) { return { pid }; }
  const [, , owner, name] = row;
  const user = /^(?:u(\d+)(?:_.*)?|(\d+))$/.exec(owner);
  const userId = user ? Number(user[1] ?? user[2]) : undefined;
  const packageName = name && PACKAGE.test(name) ? name : undefined;
  return { pid, name, packageName, ...(userId === undefined ? {} : { userId }) };
}

// 仅将目标进程明确的app_process32/64与对应设备ABI映射为显示文本，未知位数或缺失ABI不猜测；回归见下方元数据共享映射。
function processAbi(executable: string | undefined, abi64: string, abi: string): string | undefined {
  if (!executable) { return undefined; }
  const values64 = abi64.split(',').map(value => value.trim()).filter(Boolean);
  const values = abi.split(',').map(value => value.trim()).filter(Boolean);
  const bitness = /^app_process(32|64)$/.exec(executable.split('/').pop() || '');
  if (!bitness) { return undefined; }
  const is64 = bitness[1] === '64';
  const value = is64 ? values64[0] : values[0];
  if (!value) { return undefined; }
  const label = value.replace(/-v8a$/, '').replace(/^arm64$/, 'arm64');
  return (is64 ? '64-bit' : '32-bit') + ' (' + label + ')';
}

// 元数据共享回归：Node>=22，node --test tests/device-explorer-processes.test.js；使用真实AdbSmartSocket与Duplex协议对端，无真实设备写操作。
// HELO fallback shares one PID-specific snapshot验证单次shell、多PID exe/ABI隔离及VM未知；metadata EOF fallback preserves errors / metadata fallback cancellation releases sockets验证非零/取消与连接关闭。
// watch shell metadata stays fresh for new PIDs 验证后台每批新快照与零 JDWP；track snapshot and HELO metadata survive 验证显式 list 保留 HELO 且不查 shell。
interface DeviceMetadata { ps: string; processes: Map<number, { executable?: string; vm?: string }>; abi64: string; abi: string; }

// 解析设备查询分段与PID记录，exe/VM仅归属对应PID，缺失字段保持未知；回归见元数据共享映射。
function parseDeviceMetadata(text: string): DeviceMetadata {
  const exeMarker = '__DEX_EXE__';
  const vmMarker = '__DEX_VM__';
  const abi64Marker = '__DEX_ABI64__';
  const abiMarker = '__DEX_ABI__';
  const exeAt = text.indexOf(exeMarker);
  const ps = exeAt < 0 ? text : text.slice(0, exeAt);
  const exeEnd = exeAt < 0 ? -1 : text.indexOf(vmMarker, exeAt);
  const vmAt = exeEnd < 0 ? -1 : exeEnd;
  const vmEnd = vmAt < 0 ? -1 : text.indexOf(abi64Marker, vmAt);
  const abi64At = text.indexOf(abi64Marker);
  const abiAt = text.indexOf(abiMarker, abi64At < 0 ? 0 : abi64At + abi64Marker.length);
  const processes = new Map<number, { executable?: string; vm?: string }>();
  const add = (line: string, field: 'executable' | 'vm') => {
    const match = /^\s*(\d+)\t(.*)\s*$/.exec(line);
    if (!match) { return; }
    const pid = Number(match[1]);
    if (!Number.isSafeInteger(pid) || pid <= 0) { return; }
    const record = processes.get(pid) || {};
    const value = match[2].trim();
    if (value) { record[field] = value; }
    processes.set(pid, record);
  };
  if (exeAt >= 0) {
    for (const line of text.slice(exeAt + exeMarker.length, exeEnd < 0 ? text.length : exeEnd).split(/\r?\n/)) { add(line, 'executable'); }
  }
  if (vmAt >= 0) {
    for (const line of text.slice(vmAt + vmMarker.length, vmEnd < 0 ? text.length : vmEnd).split(/\r?\n/)) { add(line, 'vm'); }
  }
  const abi64 = abi64At < 0 ? '' : text.slice(abi64At + abi64Marker.length, abiAt < 0 ? text.length : abiAt).trim();
  const abi = abiAt < 0 ? '' : text.slice(abiAt + abiMarker.length).trim();
  return { ps, processes, abi64, abi };
}

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

  // 首次tracker帧后关闭发现连接，同批HELO失败PID共享一次真实元数据查询；元数据共享回归验证零重复shell与EOF/Abort不返回伪空集合。
  async list(signal?: AbortSignal): Promise<ExplorerProcess[]> {
    let stop: (() => Promise<void>) | undefined;
    try {
      const pids = await new Promise<number[]>((resolve, reject) => { stop = this.adb.trackJdwp(this.serial, resolve, reject, signal); });
      await stop?.(); stop = undefined;
      let metadata: Promise<string> | undefined; const loadMetadata = () => metadata ??= this.loadDeviceMetadata(signal); return await Promise.all(pids.map(pid => this.describe(pid, signal, loadMetadata)));
    } finally { await stop?.(); }
  }

  // 功能：后台仅按批读取 shell 元数据，不建立 JDWP；输入 tracker PID，先发布未知行再补充真实字段。
  // 输出：查询失败保留行错误并通知 onError，取消/移除/stop 回收连接；验证见后台 watch 协议回归。
  watch(onUpdate: (rows: ExplorerProcess[]) => void, onError: (error: Error) => void, signal?: AbortSignal): () => Promise<void> {
    const controller = new AbortController(); const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) { abort(); }
    const records = new Map<number, { controller: AbortController; row: ExplorerProcess; done: Promise<void> }>();
    const owned = new Set<Promise<void>>();
    const publish = () => { if (!controller.signal.aborted) { onUpdate([...records.values()].map(record => record.row)); } };
    const stopTracker = this.adb.trackJdwp(this.serial, pids => {
      let metadata: Promise<DeviceMetadata> | undefined;
      const batch = new AbortController(), children: AbortController[] = [];
      // 同批仍有存活 PID 时保留共享读取，全部移除或取消才中止 shell。
      const cancelMetadata = () => { if (children.every(child => child.signal.aborted)) { batch.abort(); } };
      const active = new Set(pids);
      for (const [pid, record] of records) { if (!active.has(pid)) { record.controller.abort(); records.delete(pid); } }
      for (const pid of pids) {
        if (records.has(pid)) { continue; }
        const child = new AbortController(); const cancel = () => child.abort(controller.signal.reason); controller.signal.addEventListener('abort', cancel, { once: true });
        children.push(child); child.signal.addEventListener('abort', cancelMetadata, { once: true });
        const record = { controller: child, row: { pid, debugger: 'unknown' } as ExplorerProcess, done: Promise.resolve() };
        records.set(pid, record);
        record.done = (metadata ??= this.loadDeviceMetadata(batch.signal).then(parseDeviceMetadata)).then(snapshot => {
          if (child.signal.aborted) { return; }
          const process = snapshot.processes.get(pid);
          record.row = { ...parseProcessSnapshot(snapshot.ps, pid), abi: processAbi(process?.executable, snapshot.abi64, snapshot.abi), vm: process?.vm, debugger: 'unknown' };
          publish();
        }, error => {
          if (child.signal.aborted) { return; }
          record.row = { pid, debugger: 'error', error: String(error) }; publish();
          onError(error instanceof Error ? error : new Error(String(error)));
        }).finally(() => { child.signal.removeEventListener('abort', cancelMetadata); controller.signal.removeEventListener('abort', cancel); owned.delete(record.done); });
        owned.add(record.done);
      }
      publish();
    }, error => { if (!controller.signal.aborted) { onError(error); } }, controller.signal);
    return async () => { controller.abort(); await stopTracker(); await Promise.allSettled([...owned]); records.clear(); signal?.removeEventListener('abort', abort); };
  }

  /**
   * 从所选设备读取一次进程快照，返回供 parseDeviceMetadata 解析的 UTF-8 文本。
   * signal 取消由 shell v2 回收连接，非零退出向调用方传播；无权限的可选 /proc exe 保持缺失，不猜测 VM。
   * 元数据共享回归分别模拟HELO失败、shell非零与取消，断言PID身份/单次查询/原始错误及全部连接关闭；可选exe权限拒绝不伪造VM。
   */
  private async loadDeviceMetadata(signal?: AbortSignal): Promise<string> {
    const command = 'ps -A -o PID,USER,NAME,ARGS && { '
      + "printf '__DEX_EXE__\n'; "
      + 'for entry in /proc/[0-9]*/exe; do '
      + 'if executable=$(readlink "$entry" 2>/dev/null); then '
      + "pid=${entry#/proc/}; pid=${pid%/exe}; printf '%s\\t%s\\n' \"$pid\" \"$executable\"; fi; done; "
      + "printf '__DEX_VM__\n__DEX_ABI64__\n'; "
      + "getprop ro.product.cpu.abilist64 && printf '__DEX_ABI__\n' && getprop ro.product.cpu.abilist32; }";
    return (await this.adb.shell(this.serial, command, signal)).toString('utf8');
  }

  // 请求DDMS HELO，失败时按PID读取共享设备快照且仍保留原始调试错误；元数据共享回归断言字段隔离、未知值和失败可见。
  private async describe(pid: number, signal?: AbortSignal, loadMetadata?: () => Promise<string>): Promise<ExplorerProcess> {
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
    } catch (error) {
      signal?.throwIfAborted();
      try {
        const text = await (loadMetadata ? loadMetadata() : this.loadDeviceMetadata(signal));
        const metadata = parseDeviceMetadata(text);
        const process = metadata.processes.get(pid);
        const row = parseProcessSnapshot(metadata.ps, pid);
        return { ...row, abi: processAbi(process?.executable, metadata.abi64, metadata.abi), vm: process?.vm, debugger: 'error', error: String(error) };
      } catch (fallbackError) {
        signal?.throwIfAborted();
        return { pid, debugger: 'error', error: String(error) + '; metadata fallback: ' + String(fallbackError) };
      }
    }
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
