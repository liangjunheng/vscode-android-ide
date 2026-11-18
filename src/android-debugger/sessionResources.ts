import { promises as fs, constants } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import * as path from 'node:path';

export type IdentityProbeResult = 'alive' | 'dead' | 'unknown';
export type ResourceProof = 'matched' | 'absent' | 'conflict';
export type OwnerIdentity = { host: string; bootId: string; pid: number; startIdentity: string };
export type ResourceDescriptor =
  | { kind: 'dap-child'; pid: number; executable: string; argvHash: string; startIdentity: string }
  | { kind: 'native-server'; serial: string; pid: number; executable: string; socket: string; targetIdentity: string; startIdentity: string }
  | { kind: 'adb-forward'; serial: string; local: string; remote: string; transportIdentity: string }
  | { kind: 'local-directory'; relativePath: string; marker: string };
export type ResourceKind = ResourceDescriptor['kind'];
/** 调用者必须提供精确身份探测；release 必须再次验证身份且允许资源已不存在。 */
export interface ResourceHandler { probe(d: ResourceDescriptor): Promise<ResourceProof>; release(d: ResourceDescriptor): Promise<void>; }
export type LedgerIO = Pick<typeof fs, 'open' | 'lstat' | 'mkdir' | 'rename' | 'opendir'>;
/** root 必须是调用者拥有的扩展私有目录，不应位于 Settings Sync 或用户工程内。 */
export interface LedgerOptions {
  root: string; sessionId: string; mode: 'jvm' | 'native' | 'jvm-native'; ownerIdentity: OwnerIdentity;
  identityProbe(identity: OwnerIdentity): Promise<IdentityProbeResult>;
  handlers?: Partial<Record<ResourceKind, ResourceHandler>>; io?: LedgerIO;
}
interface ResourceRecord { id: string; state: 'claiming' | 'acquired'; descriptor: ResourceDescriptor; ownerIdentity: OwnerIdentity; }
interface LedgerFile { version: 1; sessionId: string; mode: LedgerOptions['mode']; resources: ResourceRecord[]; }
export interface ReconcileResult { released: string[]; retained: string[]; conflicts: { resourceId: string; reason: string }[]; errors: unknown[]; }
const MAX_BYTES = 1024 * 1024;
const MAX_RECORDS = 256;
const MAX_FILES = 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MODES = ['jvm', 'native', 'jvm-native'];

/** 统一返回可见安全冲突；回归 schema/path/proof 用例断言拒绝而非默认成功。 */
function conflict(message: string): never { throw new Error('Session resource conflict: ' + message); }
/** 核对 JSON 对象的精确字段；回归 strict schema 覆盖缺失和多余字段。 */
function fields(x: any, keys: string[]): void {
  if (!x || typeof x !== 'object' || Array.isArray(x) || Object.keys(x).sort().join(',') !== [...keys].sort().join(',')) conflict('invalid schema');
}
/** 校验有界文本，拒绝控制字符和空值；strict schema 用例覆盖各类描述符字段。 */
function text(x: unknown): asserts x is string { if (typeof x !== 'string' || !x.length || x.length > 4096 || /[\x00-\x1f\x7f]/.test(x)) conflict('invalid text'); }
/** 校验精确进程身份字段，不以 PID 单独作为存活证明；PID reuse 用例验证 unknown 保留。 */
function identity(x: any): asserts x is OwnerIdentity {
  fields(x, ['host', 'bootId', 'pid', 'startIdentity']); text(x.host); text(x.bootId); text(x.startIdentity);
  if (!Number.isSafeInteger(x.pid) || x.pid < 1) conflict('invalid owner pid');
}
/** 拒绝绝对路径、跨平台路径穿越和保留路径；path 用例检查每一种非法目录描述。 */
function relative(x: string): void {
  text(x);
  if (path.isAbsolute(x) || path.win32.isAbsolute(x) || x.includes('\\') || x.split('/').some(p => !p || p === '.' || p === '..' || p.includes(':') || /[. ]$/.test(p))) conflict('unsafe relative path');
}
/** 校验四种资源的完整身份字段；descriptors 用例覆盖全部合法类型与缺失字段。 */
function descriptor(d: any): asserts d is ResourceDescriptor {
  if (!d || typeof d !== 'object') conflict('invalid descriptor');
  const extras: Record<ResourceKind, string[]> = {
    'dap-child': ['pid', 'executable', 'argvHash', 'startIdentity'],
    'native-server': ['serial', 'pid', 'executable', 'socket', 'targetIdentity', 'startIdentity'],
    'adb-forward': ['serial', 'local', 'remote', 'transportIdentity'],
    'local-directory': ['relativePath', 'marker']
  };
  if (!Object.hasOwn(extras, d.kind)) conflict('unknown resource kind');
  fields(d, ['kind', ...extras[d.kind as ResourceKind]]);
  for (const [k, v] of Object.entries(d)) if (k !== 'pid') text(v);
  if ('pid' in d && (!Number.isSafeInteger(d.pid) || d.pid < 1)) conflict('invalid resource pid');
  if (d.kind === 'dap-child' && !path.isAbsolute(d.executable)) conflict('executable must be absolute');
  if (d.kind === 'native-server' && (!d.executable.startsWith('/') || !d.socket.startsWith('/'))) conflict('native paths must be absolute');
  if (d.kind === 'adb-forward' && (!/^tcp:[1-9]\d{0,4}$/.test(d.local) || Number(d.local.slice(4)) > 65535)) conflict('invalid exact forward');
  if (d.kind === 'local-directory') relative(d.relativePath);
}
/** 校验账本全量 schema 和重复资源；corruption/duplicate 用例断言不覆盖原始文件。 */
function schema(x: any, o: LedgerOptions): asserts x is LedgerFile {
  fields(x, ['version', 'sessionId', 'mode', 'resources']);
  if (x.version !== 1 || x.sessionId !== o.sessionId || x.mode !== o.mode || !Array.isArray(x.resources) || x.resources.length > MAX_RECORDS) conflict('invalid ledger schema');
  const ids = new Set<string>(); const descriptors = new Set<string>();
  for (const r of x.resources) {
    fields(r, ['id', 'state', 'descriptor', 'ownerIdentity']); identity(r.ownerIdentity); descriptor(r.descriptor);
    const key = canonical(r.descriptor);
    if (!UUID.test(r.id) || ids.has(r.id) || descriptors.has(key) || !['claiming', 'acquired'].includes(r.state)) conflict('duplicate/invalid resource');
    ids.add(r.id); descriptors.add(key);
  }
}
/** JSON 值按键排序产生稳定身份摘要，不是代次过滤；duplicate/lock race 用例验证等价键顺序。 */
function canonical(x: any): string { return JSON.stringify(x, Object.keys(x).sort()); }
/** 计算不可变锁文件内容摘要，后继 wx 文件实现单前任唯一接管；lock race 用例断言唯一胜者。 */
function digest(x: unknown): string { return createHash('sha256').update(JSON.stringify(x)).digest('hex'); }
/** 合并主操作和关闭错误，不吞异常；IO faults 用例断言全部错误可见。 */
async function closeHandle(h: FileHandle, errors: unknown[]): Promise<void> { try { await h.close(); } catch (e) { errors.push(e); } }
/** 检查所有现存祖先及叶路径，拒绝 symlink；path 用例使用真实 root/session/ledger/lock/localdir junction。 */
async function safePath(io: LedgerIO, target: string): Promise<void> {
  const absolute = path.resolve(target); const parsed = path.parse(absolute); let part = parsed.root;
  const segments = absolute.slice(parsed.root.length).split(path.sep).filter(Boolean);
  for (let i = 0; i < segments.length; i++) {
    part = path.join(part, segments[i]);
    let stat;
    try { stat = await io.lstat(part); } catch (e: any) { if (e.code === 'ENOENT') return; throw e; }
    if (stat.isSymbolicLink() || (i < segments.length - 1 && !stat.isDirectory())) conflict('unsafe symlink/path: ' + part);
  }
}
/** 以固定上限读取普通文件并关闭句柄；IO/oversized 用例覆盖 read、stat、close 和有界内存。 */
async function readJson(io: LedgerIO, file: string): Promise<any | undefined> {
  await safePath(io, file);
  let h: FileHandle;
  try { h = await io.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0)); } catch (e: any) { if (e.code === 'ENOENT') return undefined; throw e; }
  const errors: unknown[] = []; let result: any;
  try {
    const stat = await h.stat(); if (!stat.isFile() || stat.size > MAX_BYTES) conflict('not a bounded regular file: ' + file);
    const buffer = Buffer.alloc(MAX_BYTES + 1); let count = 0;
    while (count < buffer.length) { const r = await h.read(buffer, count, buffer.length - count, count); if (!r.bytesRead) break; count += r.bytesRead; }
    if (count > MAX_BYTES) conflict('file exceeds bound');
    result = JSON.parse(buffer.subarray(0, count).toString('utf8'));
  } catch (e) { errors.push(e); }
  await closeHandle(h, errors); if (errors.length) throw new AggregateError(errors, 'Ledger read failed: ' + file);
  return result;
}
/** 写入独占文件并同步关闭，故障残留文件原样保留且路径随错误返回；IO faults/crash 用例覆盖每一边界。 */
async function exclusive(io: LedgerIO, file: string, value: unknown): Promise<void> {
  await safePath(io, file); const data = JSON.stringify(value) + '\n';
  if (Buffer.byteLength(data) > MAX_BYTES) conflict('write exceeds bound');
  const h = await io.open(file, 'wx', 0o600); const errors: unknown[] = [];
  try { await h.writeFile(data, 'utf8'); await h.sync(); } catch (e) { errors.push(e); }
  await closeHandle(h, errors); if (errors.length) throw new AggregateError(errors, 'Incomplete journal file retained: ' + file);
}
/** 在扩展根内创建专属会话目录；并发不同 UUID 用例证明没有全局锁。 */
async function sessionDirectory(io: LedgerIO, o: LedgerOptions): Promise<string> {
  await safePath(io, o.root); if (!(await io.lstat(o.root)).isDirectory()) conflict('root is not directory');
  const dir = path.join(o.root, o.sessionId); await safePath(io, dir);
  try { await io.mkdir(dir, { mode: 0o700 }); } catch (e: any) { if (e.code !== 'EEXIST') throw e; }
  if (!(await io.lstat(dir)).isDirectory()) conflict('session is not directory');
  return dir;
}
/** 枚举有限目录项，保留未知/临时文件并限制锁历史规模；bounded files 用例断言上限拒绝。 */
async function boundFiles(io: LedgerIO, dir: string): Promise<string[]> {
  const entries = await io.opendir(dir); const names: string[] = [];
  for await (const entry of entries) { names.push(entry.name); if (names.length > MAX_FILES) conflict('session file count exceeds bound'); }
  return names;
}
/** 查找锁链末端；遍历已有不可变元数据而非轮询；crash/lock race 用例验证 dead 才接管。 */
async function claimLock(io: LedgerIO, dir: string, o: LedgerOptions): Promise<{ key: string; value: unknown }> {
  let name = '.lock';
  for (let n = 0; n < MAX_FILES; n++) {
    const old = await readJson(io, path.join(dir, name));
    if (old === undefined) {
      const value = { version: 1, ownerIdentity: o.ownerIdentity, nonce: randomUUID() };
      await exclusive(io, path.join(dir, name), value);
      return { key: digest(value), value };
    }
    fields(old, ['version', 'ownerIdentity', 'nonce']); identity(old.ownerIdentity);
    if (old.version !== 1 || !UUID.test(old.nonce)) conflict('corrupt lock');
    const key = digest(old); const successor = '.lock-' + key;
    const child = await readJson(io, path.join(dir, successor));
    if (child !== undefined) { name = successor; continue; }
    const released = await readJson(io, path.join(dir, '.released-' + key));
    if (released !== undefined) { fields(released, ['key']); if (released.key !== key) conflict('corrupt lock release'); }
    const proof = await o.identityProbe(old.ownerIdentity);
    if (!['alive', 'dead', 'unknown'].includes(proof)) conflict('invalid lock identity proof');
    if (!released && proof !== 'dead') conflict('existing owner ' + proof);
    const value = { version: 1, ownerIdentity: o.ownerIdentity, nonce: randomUUID() };
    // 单前任后继只能 wx 一次；失败者绝不删除胜者的锁或重试。
    await exclusive(io, path.join(dir, successor), value);
    return { key: digest(value), value };
  }
  return conflict('lock history exceeds bound');
}

/**
 * 仅提供未接入 adapter 的持久资源所有权基础。无默认 OS/ADB 成功处理器。
 * 回归：node --test tests/android-session-resources.test.js。测试矩阵：schema/path、lock recovery/race、
 * journal IO faults、proof conflicts、partial cleanup、late acquisition/close；均用真实临时 FS 和边界 stub。
 */
export class SessionResourceLedger {
  private metadata: Promise<unknown> = Promise.resolve();
  private lifecycle: 'open' | 'closing' | 'closed' = 'open';
  private readonly pending = new Set<Promise<void>>();
  private readonly acquiring = new Set<string>();
  private closing?: Promise<void>;
  private readonly handlers: Partial<Record<ResourceKind, ResourceHandler>>;
  private constructor(private readonly o: LedgerOptions, private readonly io: LedgerIO, private readonly dir: string,
    private readonly lockKey: string, private state: LedgerFile, readonly artifacts: readonly string[]) { this.handlers = { ...o.handlers }; }

  /** 校验输入后取得 per-session 锁；损坏账本和不完整 IO 保留原文件并显式拒绝；open/schema/lock 用例覆盖。 */
  static async open(options: LedgerOptions): Promise<SessionResourceLedger> {
    if (!options || typeof options.root !== 'string' || !path.isAbsolute(options.root) || !UUID.test(options.sessionId) || !MODES.includes(options.mode) || typeof options.identityProbe !== 'function') conflict('invalid options');
    identity(options.ownerIdentity);
    const o = { ...options, root: path.resolve(options.root), ownerIdentity: { ...options.ownerIdentity } };
    const io = o.io || fs; const dir = await sessionDirectory(io, o); const names = await boundFiles(io, dir);
    const file = path.join(dir, 'resources.json'); const parsed = await readJson(io, file);
    const state = parsed === undefined ? { version: 1, sessionId: o.sessionId, mode: o.mode, resources: [] } : parsed;
    schema(state, o);
    const lock = await claimLock(io, dir, o);
    try {
      const current = await readJson(io, file); const latest = current === undefined ? state : current; schema(latest, o);
      return new SessionResourceLedger(o, io, dir, lock.key, latest, names.filter(name => name.endsWith('.tmp')));
    } catch (primary) {
      const errors: unknown[] = [primary];
      try { await exclusive(io, path.join(dir, '.released-' + lock.key), { key: lock.key }); } catch (e) { errors.push(e); }
      throw new AggregateError(errors, 'Ledger open failed after claiming lock');
    }
  }

  /** 绑定合法调用方的具体 proof/release；函数不持久化；missing handler 用例断言无默认成功。 */
  register(kind: ResourceKind, handler: ResourceHandler): void {
    if (this.lifecycle !== 'open' || !['dap-child', 'native-server', 'adb-forward', 'local-directory'].includes(kind) || typeof handler?.probe !== 'function' || typeof handler?.release !== 'function') conflict('invalid handler/lifecycle');
    this.handlers[kind] = handler;
  }

  /** 仅序列化元数据事务，外部获取可并行；metadata race/late acquisition 用例断言不丢记录、不先关锁。 */
  private transaction<T>(work: () => Promise<T>): Promise<T> {
    const run = this.metadata.then(work); this.metadata = run.then(() => undefined, () => undefined); return run;
  }

  /** 固定描述符先 claim 后副作用；取消和晚到结果仍写 acquired，随后精确释放或保留错误；cancellation/IO 用例覆盖。 */
  acquire(id: string, resource: ResourceDescriptor, acquire: () => Promise<void>, signal?: AbortSignal): Promise<void> {
    if (this.lifecycle !== 'open') return Promise.reject(new Error('Ledger closing/closed'));
    const descriptorCopy = structuredClone(resource); const task = this.acquireResource(id, descriptorCopy, acquire, signal);
    this.pending.add(task); task.then(() => this.pending.delete(task), () => this.pending.delete(task)); return task;
  }

  /** 持久化 claim 后调用获取，所有路径保留确定所有权；claim/acquired write fault 和 late acquisition 用例覆盖。 */
  private async acquireResource(id: string, resource: ResourceDescriptor, acquire: () => Promise<void>, signal?: AbortSignal): Promise<void> {
    descriptor(resource); if (!UUID.test(id) || typeof acquire !== 'function') conflict('invalid acquisition'); signal?.throwIfAborted();
    await this.checkLocalPath(resource);
    await this.transaction(async () => {
      if (this.state.resources.some(r => r.id === id || canonical(r.descriptor) === canonical(resource))) conflict('duplicate resource');
      const record: ResourceRecord = { id, state: 'claiming', descriptor: resource, ownerIdentity: this.o.ownerIdentity };
      await this.commit({ ...this.state, resources: [...this.state.resources, record] }); this.acquiring.add(id);
    });
    try {
      await acquire();
      await this.transaction(() => this.commit({ ...this.state, resources: this.state.resources.map(r => r.id === id ? { ...r, state: 'acquired' } : r) }));
    } finally { this.acquiring.delete(id); }
    if (signal?.aborted) {
      const errors: unknown[] = [signal.reason]; try { await this.transaction(() => this.releaseRecord(id)); } catch (e) { errors.push(e); }
      throw new AggregateError(errors, 'Acquisition cancelled; cleanup outcome retained');
    }
  }

  /** 资源 proof 为 matched 才 release，absent 仅移除记录，其他结果保留；release proof/partial IO 用例覆盖。 */
  release(id: string): Promise<void> {
    if (this.lifecycle !== 'open') return Promise.reject(new Error('Ledger closing/closed'));
    return this.transaction(() => this.releaseRecord(id));
  }

  /** 内部释放不重复进入队列，提交成功才变更内存；reconcile/rename failure 用例断言无死锁和丢记录。 */
  private async releaseRecord(id: string): Promise<void> {
    if (this.acquiring.has(id)) conflict('resource acquisition in flight');
    const record = this.state.resources.find(r => r.id === id); if (!record) conflict('resource not recorded');
    if (canonical(record.ownerIdentity) !== canonical(this.o.ownerIdentity)) {
      const owner = await this.o.identityProbe(structuredClone(record.ownerIdentity));
      if (owner !== 'dead') conflict('resource owner alive/unknown');
    }
    await this.checkLocalPath(record.descriptor);
    const handler = this.handlers[record.descriptor.kind]; if (!handler || typeof handler.probe !== 'function' || typeof handler.release !== 'function') conflict('resource proof handler missing');
    const proof = await handler.probe(structuredClone(record.descriptor));
    if (proof !== 'matched' && proof !== 'absent') conflict('resource identity unknown/conflicting');
    if (proof === 'matched') await handler.release(structuredClone(record.descriptor));
    await this.commit({ ...this.state, resources: this.state.resources.filter(r => r.id !== id) });
  }

  /** 每条记录先验证原 owner dead，再做独立资源 proof；live/unknown/exception 保留并汇总；proof/aggregate 用例覆盖。 */
  reconcile(): Promise<ReconcileResult> {
    if (this.lifecycle !== 'open') return Promise.reject(new Error('Ledger closing/closed'));
    return this.transaction(async () => {
      const result: ReconcileResult = { released: [], retained: [], conflicts: [], errors: [] };
      for (const record of [...this.state.resources]) {
        try {
          const owner = await this.o.identityProbe(structuredClone(record.ownerIdentity));
          if (owner === 'alive') { result.retained.push(record.id); continue; }
          if (owner !== 'dead') { result.conflicts.push({ resourceId: record.id, reason: 'owner proof unknown/invalid' }); continue; }
          await this.releaseRecord(record.id); result.released.push(record.id);
        } catch (e) { result.errors.push(e); result.conflicts.push({ resourceId: record.id, reason: String(e) }); }
      }
      return result;
    });
  }

  /** 返回隔离快照，调用者不能改变账本所有权；snapshot mutation 用例验证。 */
  snapshot(): Readonly<LedgerFile> { return structuredClone(this.state); }

  /** 等待已接收获取与元数据后记录本锁释放；不自动删除资源，失败不伪装成功；close/late 用例覆盖。 */
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.lifecycle = 'closing';
    this.closing = (async () => {
      const results = await Promise.allSettled([...this.pending]);
      await this.transaction(() => exclusive(this.io, path.join(this.dir, '.released-' + this.lockKey), { key: this.lockKey }));
      this.lifecycle = 'closed';
      const errors = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected').map(r => r.reason);
      if (errors.length) throw new AggregateError(errors, 'Acquisitions failed while closing; records retained');
    })();
    return this.closing;
  }

  /** 本地目录的每级路径均不得是 symlink；local directory junction 用例保证不会向根外释放。 */
  private async checkLocalPath(d: ResourceDescriptor): Promise<void> {
    if (d.kind === 'local-directory') {
      relative(d.relativePath); const target = path.join(this.o.root, d.relativePath);
      if (target === this.dir || target.startsWith(this.dir + path.sep)) conflict('local resource overlaps ledger metadata');
      await safePath(this.io, target);
    }
  }

  /** 事务写入 wx 临时文件、fsync/close/rename 后才更新状态；IO fault 用例验证每个边界失败保留原记录。 */
  private async commit(next: LedgerFile): Promise<void> {
    schema(next, this.o); await safePath(this.io, this.dir); await boundFiles(this.io, this.dir);
    const file = path.join(this.dir, 'resources.json'); const temp = file + '.' + randomUUID() + '.tmp';
    await exclusive(this.io, temp, next); await safePath(this.io, file); await this.io.rename(temp, file); this.state = next;
  }
}
