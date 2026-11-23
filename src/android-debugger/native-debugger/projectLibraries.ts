import * as fs from 'node:fs/promises';
import * as path from 'node:path';

const IGNORED_DIRECTORIES = new Set(['.git', '.gradle', 'node_modules', '.idea', '.test-artifacts', '.qoder']);
const NATIVE_OUTPUTS = new Set(['.cxx', 'cxx', 'cmake', 'ndkBuild']);
const MAX_METADATA_BYTES = 16 * 1024 * 1024;

function missing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

async function realDirectory(value: string): Promise<string | undefined> {
  try {
    const stat = await fs.stat(value);
    if (!stat.isDirectory()) return undefined;
    return await fs.realpath(value);
  } catch (error) {
    if (missing(error)) return undefined;
    throw error;
  }
}

async function directoryEntries(directory: string): Promise<import('node:fs').Dirent[]> {
  try {
    return await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (missing(error)) return [];
    throw error;
  }
}

interface ScanCancellation { readonly isCancellationRequested: boolean; }
// 限制在途文件系统请求及 ELF 句柄，避免大项目一次打开全部产物。
const SCAN_CONCURRENCY = 16;

/** 功能：在文件系统边界检查取消；输入当前扫描状态；输出取消错误；验证：native-project-libraries.test.js。 */
function checkCancelled(cancellation?: ScanCancellation): void {
  if (cancellation?.isCancellationRequested) throw new Error('Native symbol discovery cancelled', { cause: cancellation });
}

/** 功能：有界执行同批 I/O 并等待全部结算；输入任务和取消状态；输出结果或原始失败，不遗留句柄；验证：扫描并发、错误与取消回归。 */
async function scanBatch<T>(jobs: (() => Promise<T>)[], cancellation?: ScanCancellation): Promise<T[]> {
  checkCancelled(cancellation);
  const results = await Promise.allSettled(jobs.map(job => job()));
  const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
  if (failures.length === 1) throw failures[0].reason;
  if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'Native symbol scan failed');
  checkCancelled(cancellation);
  return results.map(result => (result as PromiseFulfilledResult<T>).value);
}

/** 功能：并行枚举项目目录；输入真实项目根及取消状态；输出 Native 普通库路径，不跟随链接；验证：全集、边界及取消回归。 */
async function scanProject(root: string, cancellation?: ScanCancellation): Promise<Set<string>> {
  const outputs = new Set<string>();
  const queue = [{ directory: root, native: false }];
  for (let index = 0; index < queue.length;) {
    const batch = queue.slice(index, index + SCAN_CONCURRENCY);
    index += batch.length;
    const rows = await scanBatch(batch.map(item => async () => ({ item, entries: await directoryEntries(item.directory) })), cancellation);
    for (const { item, entries } of rows) {
      for (const entry of entries) {
        if (entry.isSymbolicLink()) continue;
        const filename = path.join(item.directory, entry.name);
        if (entry.isDirectory() && !IGNORED_DIRECTORIES.has(entry.name)) {
          queue.push({ directory: filename, native: item.native || NATIVE_OUTPUTS.has(entry.name) });
        } else if (item.native && entry.isFile() && entry.name.endsWith('.so')) {
          outputs.add(filename);
        }
      }
    }
  }
  return outputs;
}

function machineForAbi(abi: string | undefined): Set<number> | undefined {
  if (abi === undefined) return undefined;
  const machines: Record<string, number[]> = {
    armeabi: [40],
    'armeabi-v7a': [40],
    'arm64-v8a': [183],
    x86: [3],
    x86_64: [62],
  };
  return machines[abi] ? new Set(machines[abi]) : new Set();
}

async function readAt(handle: import('node:fs/promises').FileHandle, position: number, size: number): Promise<Buffer | undefined> {
  if (size < 0 || size > MAX_METADATA_BYTES) return undefined;
  const buffer = Buffer.alloc(size);
  const result = await handle.read(buffer, 0, size, position);
  return result.bytesRead === size ? buffer : undefined;
}

function sectionName(strings: Buffer, offset: number): string | undefined {
  if (offset < 0 || offset >= strings.length) return undefined;
  const end = strings.indexOf(0, offset);
  if (end < 0) return undefined;
  return strings.toString('utf8', offset, end);
}

async function hasDwarf(filename: string, abi: string | undefined): Promise<boolean> {
  const machines = machineForAbi(abi);
  if (machines && machines.size === 0) return false;
  let handle: import('node:fs/promises').FileHandle | undefined;
  try {
    handle = await fs.open(filename, 'r');
    const stat = await handle.stat();
    if (stat.size < 20) return false;
    const header = await readAt(handle, 0, Math.min(64, stat.size));
    if (!header || header[0] !== 0x7f || header[1] !== 0x45 || header[2] !== 0x4c || header[3] !== 0x46) return false;
    const elfClass = header[4];
    const data = header[5];
    if ((elfClass !== 1 && elfClass !== 2) || (data !== 1 && data !== 2)) return false;
    const little = data === 1;
    const u16 = (offset: number): number => little ? header.readUInt16LE(offset) : header.readUInt16BE(offset);
    const u32 = (offset: number): number => little ? header.readUInt32LE(offset) : header.readUInt32BE(offset);
    const u64 = (offset: number): number => {
      const value = little ? header.readBigUInt64LE(offset) : header.readBigUInt64BE(offset);
      return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : Number.MAX_SAFE_INTEGER;
    };
    const expectedHeader = elfClass === 1 ? 52 : 64;
    if (header.length < expectedHeader || u16(16) !== 3 || (machines && !machines.has(u16(18)))) return false;
    const sectionOffset = elfClass === 1 ? u32(32) : u64(40);
    const sectionEntrySize = u16(elfClass === 1 ? 46 : 58);
    const sectionCount = u16(elfClass === 1 ? 48 : 60);
    const stringIndex = u16(elfClass === 1 ? 50 : 62);
    const expectedSectionSize = elfClass === 1 ? 40 : 64;
    if (!sectionOffset || !sectionEntrySize || sectionEntrySize < expectedSectionSize || !sectionCount || stringIndex >= sectionCount) return false;
    const tableSize = sectionEntrySize * sectionCount;
    if (!Number.isSafeInteger(tableSize) || sectionOffset > stat.size || tableSize > stat.size - sectionOffset) return false;
    const sectionTable = await readAt(handle, sectionOffset, tableSize);
    if (!sectionTable) return false;
    const section = (index: number): { name: number; offset: number; size: number } => {
      const base = index * sectionEntrySize;
      if (elfClass === 1) return { name: little ? sectionTable.readUInt32LE(base) : sectionTable.readUInt32BE(base), offset: little ? sectionTable.readUInt32LE(base + 16) : sectionTable.readUInt32BE(base + 16), size: little ? sectionTable.readUInt32LE(base + 20) : sectionTable.readUInt32BE(base + 20) };
      const read64 = (at: number): number => {
        const value = little ? sectionTable.readBigUInt64LE(base + at) : sectionTable.readBigUInt64BE(base + at);
        return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : Number.MAX_SAFE_INTEGER;
      };
      return { name: little ? sectionTable.readUInt32LE(base) : sectionTable.readUInt32BE(base), offset: read64(24), size: read64(32) };
    };
    const stringsSection = section(stringIndex);
    if (stringsSection.offset > stat.size || stringsSection.size > stat.size - stringsSection.offset) return false;
    const strings = await readAt(handle, stringsSection.offset, stringsSection.size);
    if (!strings) return false;
    for (let index = 0; index < sectionCount; index++) {
      const current = section(index);
      const name = sectionName(strings, current.name);
      if ((name === '.debug_info' || name === '.zdebug_info') && current.size > 0) return true;
    }
    return false;
  } catch (error) {
    if (missing(error)) return false;
    throw error;
  } finally {
    await handle?.close();
  }
}

/** 功能：有界校验项目库；输入根、ABI及取消状态；输出完整排序全集，失败或取消不返回部分结果；验证：native-project-libraries.test.js。 */
export async function discoverProjectLibraries(projectRoot: string, abi?: string, cancellation?: ScanCancellation): Promise<string[]> {
  checkCancelled(cancellation);
  const project = await realDirectory(path.resolve(projectRoot));
  checkCancelled(cancellation);
  if (!project) return [];
  const candidates = [...await scanProject(project, cancellation)];
  const result = new Set<string>();
  for (let index = 0; index < candidates.length; index += SCAN_CONCURRENCY) {
    const valid = await scanBatch(candidates.slice(index, index + SCAN_CONCURRENCY).map(filename => async () => {
      const actual = await fs.realpath(filename);
      if (!inside(project, actual) || !path.basename(actual).endsWith('.so')) return undefined;
      return await hasDwarf(actual, abi) ? actual : undefined;
    }), cancellation);
    for (const filename of valid) if (filename) result.add(filename);
  }
  return [...result].sort();
}
