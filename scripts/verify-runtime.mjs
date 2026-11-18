import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const TARGETS = ['win32-x64', 'linux-x64', 'darwin-x64', 'darwin-arm64'];
const ABIS = ['arm64-v8a', 'armeabi-v7a', 'x86', 'x86_64'];
const REQUIRED_ROLES = new Set(['adb', 'lldb-dap', 'lldb-server']);
const ABI_MACHINE = {
  'arm64-v8a': { klass: 2, machine: 183 },
  'armeabi-v7a': { klass: 1, machine: 40 },
  x86: { klass: 1, machine: 3 },
  x86_64: { klass: 2, machine: 62 },
};
const TARGET_FORMAT = { win32: 'pe', linux: 'elf', darwin: 'macho' };

/** 统一抛出验证错误；映射 tests/runtime-package-manifest.test.js 的所有 rejects 用例，断言明确失败原因。 */
function fail(message) {
  throw new Error('Runtime package verification failed: ' + message);
}

/** 读取并解析运行时清单；输入为扩展根目录和可选清单对象，输出为结构化清单。 */
// 回归映射：tests/runtime-package-manifest.test.js；Node >=22 运行指定 node --test 命令，正常返回数量、异常抛错为成功证据。
function readManifest(root, supplied) {
  if (supplied !== undefined) return supplied;
  const filename = path.join(root, 'runtime', 'runtime-manifest.json');
  return JSON.parse(fs.readFileSync(filename, 'utf8'));
}

/** 确认清单路径是包内相对 POSIX 路径，并返回规范化文件位置。 */
// 回归映射：tests/runtime-package-manifest.test.js；Node >=22 运行指定 node --test 命令，正常返回数量、异常抛错为成功证据。
function resolvePayload(root, relative) {
  if (typeof relative !== 'string' || !relative || relative.includes('\\') || relative.includes(':') || relative.split('/').some(part => part === '.' || part === '..' || part === '') || path.posix.isAbsolute(relative) || /^[A-Za-z]:/.test(relative)) fail('invalid payload path: ' + String(relative));
  const normalized = path.posix.normalize(relative);
  if (normalized === '..' || normalized.startsWith('../') || normalized.includes('\0')) fail('payload path escapes package: ' + relative);
  const rootReal = fs.realpathSync(root);
  const candidate = path.resolve(root, ...normalized.split('/'));
  const real = fs.realpathSync(candidate);
  if (real !== rootReal && !real.startsWith(rootReal + path.sep)) fail('payload symlink escapes package: ' + relative);
  return { candidate, real };
}

/** 读取薄 Mach-O 的 CPU/子类型；FAT 格式矩阵在 Node >=22 的指定 node --test 命令下验证有效头与错误头。 */
function thinMachInfo(bytes) {
  if (bytes.length < 4) fail('truncated Mach-O header');
  const magic = bytes.readUInt32BE(0);
  if (![0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe].includes(magic)) fail('invalid Mach-O slice header');
  const little = magic === 0xcffaedfe || magic === 0xcefaedfe;
  const is64 = magic === 0xfeedfacf || magic === 0xcffaedfe;
  if (bytes.length < (is64 ? 32 : 28)) fail('truncated Mach-O header');
  const cpu = little ? bytes.readUInt32LE(4) : bytes.readUInt32BE(4);
  const subtype = little ? bytes.readUInt32LE(8) : bytes.readUInt32BE(8);
  if (Boolean(cpu & 0x01000000) !== is64) fail('Mach-O CPU class mismatch');
  return { cpu, subtype };
}

/** 有界解析 FAT32/FAT64（含反字节序），校验表、切片边界/对齐/唯一性及薄头一致性，返回真实 CPU 集合。
 * 回归映射：tests/runtime-package-manifest.test.js 的 FAT 矩阵；Node >=22 指定 node --test 命令断言有效包通过和畸形包拒绝。
 */
function fatMachInfo(bytes, magic) {
  if (bytes.length < 8) fail('truncated FAT header');
  const little = magic === 0xbebafeca || magic === 0xbfbafeca;
  const wide = magic === 0xcafebabf || magic === 0xbfbafeca;
  const read32 = little ? Buffer.prototype.readUInt32LE : Buffer.prototype.readUInt32BE;
  const read64 = little ? Buffer.prototype.readBigUInt64LE : Buffer.prototype.readBigUInt64BE;
  const count = read32.call(bytes, 4);
  const stride = wide ? 32 : 20;
  const tableEnd = 8 + count * stride;
  if (!count || count > 64 || tableEnd > bytes.length) fail('invalid FAT architecture table');
  const slices = [];
  const cpus = new Set();
  for (let index = 0; index < count; index++) {
    const at = 8 + index * stride;
    const cpu = read32.call(bytes, at);
    const subtype = read32.call(bytes, at + 4);
    const offset = wide ? read64.call(bytes, at + 8) : BigInt(read32.call(bytes, at + 8));
    const size = wide ? read64.call(bytes, at + 16) : BigInt(read32.call(bytes, at + 12));
    const align = read32.call(bytes, at + (wide ? 24 : 16));
    if (cpus.has(cpu)) fail('duplicate FAT architecture');
    if (offset < BigInt(tableEnd) || size < 28n || offset + size > BigInt(bytes.length)) fail('FAT slice out of bounds');
    if (align > 63 || offset % (1n << BigInt(align)) !== 0n) fail('invalid FAT slice alignment');
    if (wide && read32.call(bytes, at + 28) !== 0) fail('invalid FAT reserved field');
    const start = Number(offset);
    const end = Number(offset + size);
    for (const slice of slices) {
      if (start < slice.end && end > slice.start) fail('overlapping FAT slices');
    }
    const thin = thinMachInfo(bytes.subarray(start, end));
    if (thin.cpu !== cpu || thin.subtype !== subtype) fail('FAT slice architecture mismatch');
    cpus.add(cpu);
    slices.push({ start, end });
  }
  return { format: 'macho', cpus: [...cpus] };
}

/** 识别 ELF/PE/Mach-O 原生字节并返回格式及实际架构集合。 */
// 回归映射：tests/runtime-package-manifest.test.js；Node >=22 运行指定 node --test 命令，正常返回数量、异常抛错为成功证据。
function nativeInfo(bytes) {
  if (bytes.length >= 4 && bytes[0] === 0x7f && bytes[1] === 0x45 && bytes[2] === 0x4c && bytes[3] === 0x46) {
    if (bytes.length < 52 || bytes[5] !== 1 || bytes[6] !== 1) fail('invalid ELF header');
    return { format: 'elf', klass: bytes[4], machine: bytes.readUInt16LE(18) };
  }
  if (bytes.length >= 2 && bytes[0] === 0x4d && bytes[1] === 0x5a) {
    if (bytes.length < 0x40) fail('truncated PE header');
    const pe = bytes.readUInt32LE(0x3c);
    if (pe + 6 > bytes.length || bytes.toString('ascii', pe, pe + 4) !== 'PE\0\0') fail('invalid PE header');
    return { format: 'pe', machine: bytes.readUInt16LE(pe + 4) };
  }
  if (bytes.length >= 8) {
    const magic = bytes.readUInt32BE(0);
    if ([0xcafebabe, 0xcafebabf, 0xbebafeca, 0xbfbafeca].includes(magic)) return fatMachInfo(bytes, magic);
    if ([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe].includes(magic)) return { format: 'macho', cpus: [thinMachInfo(bytes).cpu] };
  }
  fail('unrecognized native executable format');
}

/** 将目标键映射为原生平台与架构，供包内跨平台文件校验使用。 */
// 回归映射：tests/runtime-package-manifest.test.js；Node >=22 运行指定 node --test 命令，正常返回数量、异常抛错为成功证据。
function targetInfo(target) {
  const match = /^(win32|linux|darwin)-(x64|arm64)$/.exec(target);
  if (!match) fail('unsupported target: ' + target);
  return { platform: match[1], arch: match[2], format: TARGET_FORMAT[match[1]] };
}

/** 校验单个原生载荷的格式、架构和 POSIX 可执行位，失败时抛出明确错误。 */
// 回归映射：tests/runtime-package-manifest.test.js；Node >=22 运行指定 node --test 命令，正常返回数量、异常抛错为成功证据。
function validateNative(file, target, role, abi) {
  const bytes = fs.readFileSync(file.real);
  if (!bytes.length) fail('empty native file: ' + file.path);
  const stat = fs.statSync(file.real);
  if (process.platform !== 'win32' && targetInfo(target).platform !== 'win32' && (stat.mode & 0o111) === 0) fail('native file is not executable: ' + file.path);
  const info = nativeInfo(bytes);
  const expected = targetInfo(target);
  if (role === 'lldb-server') {
    if (info.format !== 'elf') fail('lldb-server must be ELF: ' + file.path);
    const wanted = ABI_MACHINE[abi];
    if (info.klass !== wanted.klass || info.machine !== wanted.machine) fail('lldb-server ABI mismatch for ' + abi);
    return;
  }
  if (info.format !== expected.format) fail(role + ' format does not match target ' + target);
  if (expected.platform === 'win32' && info.machine !== 0x8664 && !(role === 'adb' && expected.arch === 'x64' && info.machine === 0x14c)) {
    fail(role + ' architecture mismatch for ' + target);
  } else if (expected.platform === 'linux' && (info.klass !== 2 || info.machine !== (expected.arch === 'arm64' ? 183 : 62))) {
    fail(role + ' architecture mismatch for ' + target);
  } else if (expected.platform === 'darwin' && !info.cpus.includes(expected.arch === 'arm64' ? 0x0100000c : 0x01000007)) {
    fail(role + ' architecture mismatch for ' + target);
  }
}

/** 校验包根目录的固定运行时文件均为非空普通文件。 */
// 回归映射：tests/runtime-package-manifest.test.js；Node >=22 运行指定 node --test 命令，正常返回数量、异常抛错为成功证据。
function validateRequiredFiles(root) {
  for (const relative of ['dist/extension.js', 'dist/THIRD_PARTY_NOTICES.txt', 'schemas/android-ide.local.schema.json']) {
    const filename = path.join(root, ...relative.split('/'));
    const stat = fs.statSync(filename);
    if (!stat.isFile() || stat.size === 0) fail('required file missing or empty: ' + relative);
  }
}

/** 校验清单结构、载荷哈希、角色唯一性、ABI 完整性及目标平台原生文件；跨目标仅复用完全相同身份的载荷并按规范化路径计数。 */
// 回归映射：tests/runtime-package-manifest.test.js；Node >=22 运行指定 node --test tests/runtime-package-manifest.test.js，验证共享 server/license、冲突元数据、同目标重复、哈希和 symlink 拒绝。
function verifyTargets(root, manifest) {
  if (!manifest || manifest.schemaVersion !== 1 || !manifest.targets || typeof manifest.targets !== 'object' || Array.isArray(manifest.targets)) fail('manifest schemaVersion 1 and targets object are required');
  const actual = Object.keys(manifest.targets);
  if (actual.length !== TARGETS.length || TARGETS.some(target => !Object.prototype.hasOwnProperty.call(manifest.targets, target))) fail('manifest must contain exactly all supported targets');
  let count = 0;
  const sharedPaths = new Map();
  for (const target of TARGETS) {
    const entries = manifest.targets[target]?.files;
    if (!Array.isArray(entries) || entries.length === 0) fail('target files must be a non-empty array: ' + target);
    const paths = new Set();
    const declaredPaths = new Set();
    const roleKeys = new Set();
    const native = new Map();
    for (const entry of entries) {
      if (!entry || typeof entry !== 'object' || typeof entry.path !== 'string' || typeof entry.sha256 !== 'string' || typeof entry.role !== 'string') fail('invalid manifest entry in ' + target);
      if (!/^[0-9a-fA-F]{64}$/.test(entry.sha256)) fail('invalid sha256 for ' + entry.path);
      const portable = path.posix.normalize(entry.path).toLowerCase();
      if (declaredPaths.has(portable)) fail('duplicate payload path: ' + entry.path);
      declaredPaths.add(portable);
      const roleKey = entry.role + ':' + (entry.abi ?? '');
      if (REQUIRED_ROLES.has(entry.role) && roleKeys.has(roleKey)) fail('ambiguous duplicate role: ' + roleKey);
      roleKeys.add(roleKey);
      const identity = JSON.stringify([portable, entry.role, entry.abi ?? null, entry.sha256.toLowerCase()]);
      const prior = sharedPaths.get(portable);
      if (prior && prior !== identity) fail('conflicting shared payload metadata: ' + entry.path);
      const resolved = resolvePayload(root, entry.path);
      if (paths.has(resolved.real.toLowerCase())) fail('duplicate payload path alias: ' + entry.path);
      paths.add(resolved.real.toLowerCase());
      const stat = fs.statSync(resolved.real);
      if (!stat.isFile() || stat.size === 0) fail('payload missing or empty: ' + entry.path);
      const digest = crypto.createHash('sha256').update(fs.readFileSync(resolved.real)).digest('hex');
      if (digest !== entry.sha256.toLowerCase()) fail('sha256 mismatch: ' + entry.path);
      if (!prior) { sharedPaths.set(portable, identity); count++; }
      if (REQUIRED_ROLES.has(entry.role)) {
        if (entry.role === 'lldb-server' && !ABIS.includes(entry.abi)) fail('lldb-server requires supported ABI: ' + entry.path);
        if (entry.role !== 'lldb-server' && entry.abi !== undefined) fail('ABI is only valid for lldb-server: ' + entry.path);
        if (entry.role === 'lldb-server') native.set(entry.abi, { ...resolved, path: entry.path });
        else validateNative({ ...resolved, path: entry.path }, target, entry.role, entry.abi);
      } else if (entry.role !== 'license' && entry.role !== 'library') fail('invalid role: ' + entry.role);
    }
    for (const role of ['adb', 'lldb-dap']) {
      if (!roleKeys.has(role + ':')) fail('missing required role ' + role + ' for ' + target);
    }
    if (!entries.some(entry => entry.role === 'license')) fail('target requires a license payload: ' + target);
    for (const abi of ABIS) {
      if (!native.has(abi)) fail('missing lldb-server ABI ' + abi + ' for ' + target);
      validateNative(native.get(abi), target, 'lldb-server', abi);
    }
  }
  return count;
}

/** 验证完整扩展根目录并返回已确认的目标和载荷数量；不访问 SDK、PATH 或网络。 */
// 回归映射：tests/runtime-package-manifest.test.js；Node >=22 运行指定 node --test 命令，正常返回数量、异常抛错为成功证据。
export function verifyRuntime(root, manifest) {
  if (typeof root !== 'string' || !root) throw new TypeError('root must be a non-empty string');
  const packageRoot = fs.realpathSync(root);
  validateRequiredFiles(packageRoot);
  const parsed = readManifest(packageRoot, manifest);
  const count = verifyTargets(packageRoot, parsed);
  return { targets: TARGETS.length, files: count };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  try {
    const result = verifyRuntime(process.cwd());
    process.stdout.write(JSON.stringify(result) + '\n');
  } catch (error) {
    process.stderr.write((error instanceof Error ? error.message : String(error)) + '\n');
    process.exitCode = 1;
  }
}
