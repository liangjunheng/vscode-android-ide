'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// 共享回归：Node >=22 执行 node --test tests/core-runtime-verifier.test.js tests/vsix-content.test.js；
// 成功证据为真实四平台资源通过，缺文件、篡改 DLL、架构错误、目录和链接均拒绝。
// 此门禁仅校验 ADB 发布资产；无服务源码及 JVM 资源的隔离根也须通过，见 core-runtime-verifier 测试。
const ROOT = path.resolve(__dirname, '..');
const EXPECTED = {
  'win32-x64': { platform: 'windows', architecture: 'x64', executable: 'adb.exe', companion: ['AdbWinApi.dll', 'AdbWinUsbApi.dll'] },
  'linux-x64': { platform: 'linux', architecture: 'x64', executable: 'adb', companion: [] },
  'darwin-x64': { platform: 'macos', architecture: 'x64', executable: 'adb', companion: [] },
  'darwin-arm64': { platform: 'macos', architecture: 'arm64', executable: 'adb', companion: [] }
};

/** 输入错误信息，抛出统一发布门禁错误。 */
function fail(message) { throw new Error('Core runtime verification failed: ' + message); }
/** 输入 JSON 文件，输出解析对象；文件缺失或格式错误立即失败。 */
function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) { fail(file + ': ' + error.message); } }
/** 输入普通文件，输出 SHA-256 十六进制摘要。 */
function sha256(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
/** 输入平台目录，输出严格普通文件集合；拒绝目录、symlink 和特殊文件。 */
function regularFiles(dir) {
  const names = fs.readdirSync(dir).sort();
  for (const name of names) {
    const info = fs.lstatSync(path.join(dir, name));
    if (!info.isFile() || info.isSymbolicLink()) fail('runtime entry is not a regular non-symlink file: ' + path.join(dir, name));
  }
  return names;
}
/** 输入可信父级、目标目录和是否检查文件，确认 realpath containment；父级拒绝链接，宿主目录额外拒绝子目录。回归见 core-runtime-verifier 的宿主和父级链接拒绝用例。 */
function verifyContainedDirectory(runtime, dir, host, checkFiles = true) {
  const dirInfo = fs.lstatSync(dir);
  if (!dirInfo.isDirectory() || dirInfo.isSymbolicLink()) fail(host + ' directory is not a real directory');
  const runtimeReal = fs.realpathSync(runtime);
  const dirReal = fs.realpathSync(dir);
  const relative = path.relative(runtimeReal, dirReal);
  if (!relative || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) fail(host + ' directory escapes runtime root');
  if (checkFiles) regularFiles(dir);
}
/** 输入真实二进制、宿主和文件名，核对 PE machine、ELF machine 或 Mach-O/FAT 架构。 */
function verifyFormat(file, host, executable) {
  const bytes = fs.readFileSync(file);
  if (host === 'win32-x64') {
    const peOffset = bytes.length >= 0x40 ? bytes.readUInt32LE(0x3c) : 0;
    if (bytes.length < peOffset + 6 || bytes.toString('ascii', 0, 2) !== 'MZ' || bytes.toString('ascii', peOffset, peOffset + 4) !== 'PE\0\0' || bytes.readUInt16LE(peOffset + 4) !== 0x014c) fail(host + '/' + executable + ' is not PE i386 (Android Platform-Tools host payload)');
  } else if (host === 'linux-x64') {
    if (bytes.length < 20 || bytes.toString('ascii', 0, 4) !== '\x7fELF' || bytes[4] !== 2 || bytes.readUInt16LE(18) !== 0x3e) fail(host + '/' + executable + ' is not ELF x86_64');
  } else {
    const magic = bytes.length >= 4 ? bytes.readUInt32BE(0) : 0;
    const wanted = host === 'darwin-x64' ? 0x01000007 : 0x0100000c;
    if (magic === 0xcafebabe) {
      if (bytes.length < 8) fail(host + '/' + executable + ' truncated Mach-O FAT');
      const count = bytes.readUInt32BE(4); const cpus = [];
      for (let offset = 8; offset + 20 <= bytes.length && cpus.length < count; offset += 20) cpus.push(bytes.readInt32BE(offset));
      if (cpus.length !== count || !cpus.includes(wanted)) fail(host + '/' + executable + ' missing required Mach-O architecture');
    } else if (magic === 0xfeedfacf || magic === 0xcffaedfe) {
      const cpu = bytes.readInt32LE(4);
      if (cpu !== wanted) fail(host + '/' + executable + ' is wrong Mach-O architecture');
    } else fail(host + '/' + executable + ' is not Mach-O');
  }
}
/** 输入仓库根目录，验证真实 core ADB 资产、架构、provenance、许可和哈希；供 prepublish 调用。 */
function verifyCoreRuntime(root = ROOT) {
  // 中文职责：验证 resources/platform-tools 下的四宿主发布资产及根清单，确保布局迁移不削弱完整性与路径约束。
  const runtime = path.join(root, 'resources', 'platform-tools');
  verifyContainedDirectory(root, path.join(root, 'resources'), 'resources parent', false);
  verifyContainedDirectory(path.join(root, 'resources'), runtime, 'platform-tools parent', false);
  const manifest = readJson(path.join(runtime, 'runtime-manifest.json'));
  if (manifest.schemaVersion !== 1 || manifest.component !== 'Android Platform-Tools' || manifest.version !== '37.0.1') fail('manifest identity/version');
  if (!manifest.hosts || Object.keys(manifest.hosts).sort().join(',') !== Object.keys(EXPECTED).sort().join(',')) fail('manifest host set');
  for (const [host, expected] of Object.entries(EXPECTED)) {
    const info = manifest.hosts[host];
    if (info.platform !== expected.platform || info.architecture !== expected.architecture) fail(host + ' platform/architecture');
    const dependency = info.dependencies?.platformTools;
    if (!dependency || dependency.version !== manifest.version || !Array.isArray(dependency.files)) fail(host + ' platform-tools dependency');
    const dir = path.join(runtime, host);
    if (!fs.existsSync(dir)) fail(host + ' directory missing');
    verifyContainedDirectory(runtime, dir, host);
    const actual = regularFiles(dir);
    const declared = dependency.files.map(entry => entry.path).sort();
    if (actual.join(',') !== declared.join(',')) fail(host + ' manifest/file set mismatch');
    const provenance = readJson(path.join(dir, 'adb-provenance.json'));
    if (provenance.component !== 'Android Debug Bridge' || provenance.version !== manifest.version || provenance.host !== host) fail(host + ' provenance identity/version');
    const payloads = new Map((provenance.payloads || []).map(entry => [entry.path, entry]));
    for (const entry of dependency.files) {
      if (!/^\w[\w.-]*$/.test(entry.path)) fail(host + ' unsafe manifest path ' + entry.path);
      const file = path.join(dir, entry.path);
      const actualBytes = fs.statSync(file).size;
      const actualHash = sha256(file);
      if (entry.bytes !== actualBytes || entry.sha256 !== actualHash) fail(host + '/' + entry.path + ' manifest hash/size mismatch');
      if (entry.sourcePath !== 'tools/' + host + '/' + entry.path) fail(host + '/' + entry.path + ' source path mismatch');
      if (entry.path !== 'adb-provenance.json') {
        const upstream = payloads.get(entry.path);
        if (!upstream || upstream.bytes !== actualBytes || upstream.sha256 !== actualHash || upstream.exactUpstreamBytes !== true) fail(host + '/' + entry.path + ' provenance mismatch');
      }
    }
    if (payloads.size !== actual.filter(name => name !== 'adb-provenance.json').length) fail(host + ' provenance payload set mismatch');
    if (!provenance.notices || provenance.notices.path !== 'NOTICE.txt' || provenance.notices.versionMetadata !== 'source.properties') fail(host + ' license/version metadata declaration');
    if (!fs.readFileSync(path.join(dir, 'source.properties'), 'utf8').match(/^\s*Pkg\.Revision\s*=\s*37\.0\.1\s*$/m)) fail(host + ' source.properties version');
    if (fs.statSync(path.join(dir, 'NOTICE.txt')).size === 0) fail(host + ' NOTICE.txt empty');
    verifyFormat(path.join(dir, expected.executable), host, expected.executable);
    for (const companion of expected.companion) verifyFormat(path.join(dir, companion), host, companion);
  }
  return { hosts: Object.keys(EXPECTED), version: manifest.version, files: Object.values(manifest.hosts).reduce((n, host) => n + host.dependencies.platformTools.files.length, 0) };
}

if (require.main === module) {
  try { const result = verifyCoreRuntime(); console.log('Core runtime verified: ' + result.hosts.join(', ') + ' (' + result.files + ' files, Platform-Tools ' + result.version + ')'); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}

module.exports = { verifyCoreRuntime };
