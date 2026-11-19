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

/** 递归扫描项目内指定 Native 目录，只记录普通 .so 文件路径，不跟随目录或文件链接。 */
async function scanNativeTree(root: string, projectRoot: string, outputs: Set<string>): Promise<void> {
  const entries = await directoryEntries(root);
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const filename = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (IGNORED_DIRECTORIES.has(entry.name)) continue;
      await scanNativeTree(filename, projectRoot, outputs);
    } else if (entry.isFile() && entry.name.endsWith('.so')) {
      const actual = await fs.realpath(filename);
      if (inside(projectRoot, actual) && path.basename(actual).endsWith('.so')) outputs.add(actual);
    }
  }
}

/** 递归查找当前项目内 .cxx/cxx/cmake/ndkBuild 目录并收集其中的 Native 库。 */
async function scanProject(root: string): Promise<Set<string>> {
  const outputs = new Set<string>();
  const visit = async (directory: string): Promise<void> => {
    const entries = await directoryEntries(directory);
    for (const entry of entries) {
      if (entry.isSymbolicLink() || !entry.isDirectory() || IGNORED_DIRECTORIES.has(entry.name)) continue;
      const child = path.join(directory, entry.name);
      if (NATIVE_OUTPUTS.has(entry.name)) await scanNativeTree(child, root, outputs);
      else await visit(child);
    }
  };
  await visit(root);
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

/** 读取项目内扫描到的普通 .so，统一执行项目边界、ABI 和 DWARF 校验。 */
export async function discoverProjectLibraries(projectRoot: string, abi?: string): Promise<string[]> {
  const project = await realDirectory(path.resolve(projectRoot));
  if (!project) return [];
  const candidates = await scanProject(project);
  const result = new Set<string>();
  for (const filename of candidates) {
    if (await hasDwarf(filename, abi)) result.add(filename);
  }
  return [...result].sort();
}
