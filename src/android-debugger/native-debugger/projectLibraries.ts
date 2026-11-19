import * as fs from 'node:fs/promises';
import * as path from 'node:path';

type JsonObject = Record<string, unknown>;

const IGNORED_DIRECTORIES = new Set(['.git', '.gradle', 'node_modules', '.idea', '.test-artifacts', '.qoder']);
const NATIVE_OUTPUTS = new Set(['cxx', 'cmake', 'ndkBuild']);
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

async function readJson(filename: string): Promise<JsonObject | undefined> {
  let content: string;
  try {
    content = await fs.readFile(filename, 'utf8');
  } catch (error) {
    if (missing(error)) return undefined;
    throw error;
  }
  try {
    const value: unknown = JSON.parse(content);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('expected an object');
    return value as JsonObject;
  } catch (error) {
    throw new Error(`Invalid JSON in ${filename}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function jsonArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function isReplyDirectory(directory: string): boolean {
  return path.basename(directory) === 'reply'
    && path.basename(path.dirname(directory)) === 'v1'
    && path.basename(path.dirname(path.dirname(directory))) === 'api'
    && path.basename(path.dirname(path.dirname(path.dirname(directory)))) === '.cmake';
}

async function directoryEntries(directory: string): Promise<import('node:fs').Dirent[]> {
  try {
    return await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (missing(error)) return [];
    throw error;
  }
}

interface DiscoveryFiles {
  indexes: Map<string, string[]>;
  gradleBuilds: Array<{ filename: string; buildRoot: string }>;
}

async function scanNativeTree(root: string, allowGradleBuild: boolean, files: DiscoveryFiles): Promise<void> {
  const entries = await directoryEntries(root);
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const filename = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (IGNORED_DIRECTORIES.has(entry.name)) continue;
      await scanNativeTree(filename, allowGradleBuild, files);
      continue;
    }
    if (!entry.isFile()) continue;
    if (isReplyDirectory(root) && /^index-.*\.json$/i.test(entry.name)) {
      const indexes = files.indexes.get(root) ?? [];
      indexes.push(filename);
      files.indexes.set(root, indexes);
    } else if (allowGradleBuild && entry.name === 'android_gradle_build.json') {
      files.gradleBuilds.push({ filename, buildRoot: root });
    }
  }
}

async function scanProject(root: string): Promise<DiscoveryFiles> {
  const files: DiscoveryFiles = { indexes: new Map(), gradleBuilds: [] };

  // 只进入模块的 .cxx 和 build/intermediates Native 输出，避免把打包目录当作编译来源。
  const visitModule = async (directory: string): Promise<void> => {
    const entries = await directoryEntries(directory);
    for (const entry of entries) {
      if (entry.isSymbolicLink() || !entry.isDirectory() || IGNORED_DIRECTORIES.has(entry.name)) continue;
      const child = path.join(directory, entry.name);
      if (entry.name === '.cxx') {
        await scanNativeTree(child, false, files);
      } else if (entry.name === 'build') {
        const intermediates = path.join(child, 'intermediates');
        for (const output of NATIVE_OUTPUTS) {
          const nativeOutput = path.join(intermediates, output);
          await scanNativeTree(nativeOutput, output === 'ndkBuild', files);
        }
      } else {
        await visitModule(child);
      }
    }
  };

  await visitModule(root);
  return files;
}

async function latestIndex(filenames: string[]): Promise<string | undefined> {
  const candidates: Array<{ filename: string; modified: number }> = [];
  for (const filename of filenames) {
    try {
      const stat = await fs.stat(filename);
      if (stat.isFile()) candidates.push({ filename, modified: stat.mtimeMs });
    } catch (error) {
      if (!missing(error)) throw error;
    }
  }
  candidates.sort((a, b) => b.modified - a.modified || a.filename.localeCompare(b.filename));
  return candidates[0]?.filename;
}

function resolvedPath(root: string, value: string): string {
  return path.isAbsolute(value) ? path.normalize(value) : path.resolve(root, value);
}

async function canonicalSource(root: string, projectRoot: string, value: unknown): Promise<string | undefined> {
  if (typeof value !== 'string' || !value) return undefined;
  try {
    const actual = await fs.realpath(resolvedPath(root, value));
    return inside(root, actual) && inside(projectRoot, actual) ? actual : undefined;
  } catch (error) {
    if (missing(error)) return undefined;
    throw error;
  }
}

async function canonicalOutput(root: string, projectRoot: string, value: unknown): Promise<string | undefined> {
  if (typeof value !== 'string' || !value || !value.endsWith('.so')) return undefined;
  const filename = resolvedPath(root, value);
  try {
    const link = await fs.lstat(filename);
    if (!link.isFile() || link.isSymbolicLink()) return undefined;
    const actual = await fs.realpath(filename);
    if (!inside(root, actual) || !inside(projectRoot, actual)) return undefined;
    return actual;
  } catch (error) {
    if (missing(error)) return undefined;
    throw error;
  }
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

async function inspectCmakeIndex(indexFilename: string, projectRoot: string, abi: string | undefined, result: Set<string>): Promise<void> {
  const index = await readJson(indexFilename);
  if (!index) return;
  const codemodel = jsonArray(index.objects).find(value => {
    if (!value || typeof value !== 'object') return false;
    const object = value as JsonObject;
    const version = object.version;
    return object.kind === 'codemodel' && version && typeof version === 'object' && (version as JsonObject).major === 2;
  }) as JsonObject | undefined;
  if (!codemodel) return;
  if (typeof codemodel.jsonFile !== 'string') throw new Error(`Invalid CMake codemodel reference in ${indexFilename}`);
  const codemodelFilename = path.resolve(path.dirname(indexFilename), codemodel.jsonFile);
  const model = await readJson(codemodelFilename);
  if (!model) throw new Error(`Missing CMake codemodel ${codemodelFilename}`);
  const modelPaths = model.paths;
  if (!modelPaths || typeof modelPaths !== 'object') return;
  const sourceValue = (modelPaths as JsonObject).source;
  const buildValue = (modelPaths as JsonObject).build;
  if (typeof sourceValue !== 'string' || typeof buildValue !== 'string') return;
  const sourceRoot = await realDirectory(sourceValue);
  const buildRoot = await realDirectory(buildValue);
  const project = await fs.realpath(projectRoot);
  if (!sourceRoot || !buildRoot || !inside(project, sourceRoot) || !inside(project, buildRoot)) return;
  for (const configuration of jsonArray(model.configurations)) {
    if (!configuration || typeof configuration !== 'object') continue;
    for (const targetReference of jsonArray((configuration as JsonObject).targets)) {
      if (!targetReference || typeof targetReference !== 'object') continue;
      const jsonFile = (targetReference as JsonObject).jsonFile;
      if (typeof jsonFile !== 'string') continue;
      const targetFilename = path.resolve(path.dirname(codemodelFilename), jsonFile);
      const target = await readJson(targetFilename);
      if (!target) throw new Error(`Missing CMake target ${targetFilename}`);
      if (target.type !== 'SHARED_LIBRARY' || target.isImported === true || target.imported === true) continue;
      const compileGroups = target.compileGroups;
      const sources = jsonArray(target.sources);
      if (!Array.isArray(compileGroups) || !sources.some(source => source && typeof source === 'object' && Number.isInteger((source as JsonObject).compileGroupIndex) && (source as JsonObject).compileGroupIndex as number >= 0 && ((source as JsonObject).compileGroupIndex as number) < compileGroups.length)) continue;
      const sourceRoots = await Promise.all(sources.map(source => {
        if (!source || typeof source !== 'object') return Promise.resolve(undefined);
        const object = source as JsonObject;
        const group = object.generated === true ? buildRoot : sourceRoot;
        return canonicalSource(group, project, object.path);
      }));
      if (!sourceRoots.some(Boolean)) continue;
      for (const artifact of jsonArray(target.artifacts)) {
        if (!artifact || typeof artifact !== 'object') continue;
        const output = await canonicalOutput(buildRoot, project, (artifact as JsonObject).path);
        if (output && await hasDwarf(output, abi)) result.add(output);
      }
    }
  }
}

async function inspectGradleBuild(filename: string, buildRoot: string, projectRoot: string, abi: string | undefined, result: Set<string>): Promise<void> {
  const metadata = await readJson(filename);
  if (!metadata) return;
  for (const library of jsonArray(metadata.libraries)) {
    if (!library || typeof library !== 'object') continue;
    for (const file of jsonArray((library as JsonObject).files)) {
      if (!file || typeof file !== 'object') continue;
      const output = await canonicalOutput(buildRoot, projectRoot, (file as JsonObject).src);
      if (output && await hasDwarf(output, abi)) result.add(output);
    }
  }
}

/** 只从本项目 CMake/ndkBuild 编译记录取得有 DWARF 的 .so；不触发构建、不扫描预编译或打包目录，并把模块/ABI/ELF 校验映射到 native-project-libraries.test.js 的真实磁盘回归。 */
export async function discoverProjectLibraries(projectRoot: string, abi?: string): Promise<string[]> {
  const project = await realDirectory(path.resolve(projectRoot));
  if (!project) return [];
  const files = await scanProject(project);
  const result = new Set<string>();
  for (const [reply, indexes] of files.indexes) {
    const index = await latestIndex(indexes);
    if (index) await inspectCmakeIndex(index, project, abi, result);
  }
  for (const gradle of files.gradleBuilds) {
    const buildRoot = await fs.realpath(gradle.buildRoot);
    if (inside(project, buildRoot)) await inspectGradleBuild(gradle.filename, buildRoot, project, abi, result);
  }
  return [...result].sort();
}
