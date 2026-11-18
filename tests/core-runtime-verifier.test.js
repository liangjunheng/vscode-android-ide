const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { verifyCoreRuntime } = require('../scripts/verify-core-runtime.cjs');

// 输入临时副本、变更函数及可选省略目录，断言拒绝损坏资源；链接用例直接在空位置构造，不移动刚复制的Windows目录。
function corrupted(t, change, message, omittedDirectory) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'android-runtime-corrupt-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.resolve(__dirname, '..', 'runtime');
  const omitted = omittedDirectory && path.join(source, omittedDirectory);
  fs.cpSync(source, path.join(root, 'runtime'), { recursive: true, filter: candidate => candidate !== omitted });
  change(root);
  assert.throws(() => verifyCoreRuntime(root), message);
}
// 模拟同时更新清单和provenance的错误架构，确保架构门禁独立于哈希存在。
function replaceBinary(root, host, filename, mutate) {
  const directory = path.join(root, 'runtime', host, 'platform-tools');
  const file = path.join(directory, filename); const bytes = fs.readFileSync(file);
  mutate(bytes); fs.writeFileSync(file, bytes);
  const digest = b => crypto.createHash('sha256').update(b).digest('hex');
  const provenanceFile = path.join(directory, 'adb-provenance.json');
  const provenance = JSON.parse(fs.readFileSync(provenanceFile));
  provenance.payloads.find(entry => entry.path === filename).sha256 = digest(bytes);
  fs.writeFileSync(provenanceFile, JSON.stringify(provenance));
  const manifestFile = path.join(root, 'runtime', 'runtime-manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestFile));
  for (const entry of manifest.hosts[host].dependencies.platformTools.files) { const b = fs.readFileSync(path.join(directory, entry.path)); entry.sha256 = digest(b); entry.bytes = b.length; }
  fs.writeFileSync(manifestFile, JSON.stringify(manifest));
}
// Node>=22运行本文件及vsix-content：真实文件通过，以下每个错误必须拒绝。
test('rejects missing Windows companion DLL', t => corrupted(t, root => fs.rmSync(path.join(root, 'runtime/win32-x64/platform-tools/AdbWinApi.dll')), /file set mismatch/));
test('rejects modified Windows companion DLL', t => corrupted(t, root => fs.appendFileSync(path.join(root, 'runtime/win32-x64/platform-tools/AdbWinUsbApi.dll'), 'corrupt'), /hash[/]size mismatch/));
test('rejects wrong PE machine even with updated hashes', t => corrupted(t, root => replaceBinary(root, 'win32-x64', 'adb.exe', bytes => bytes.writeUInt16LE(0xaa64, bytes.readUInt32LE(0x3c) + 4)), /not PE i386/));
test('rejects wrong ELF machine even with updated hashes', t => corrupted(t, root => replaceBinary(root, 'linux-x64', 'adb', bytes => bytes.writeUInt16LE(183, 18)), /not ELF x86_64/));
test('rejects missing Mach-O target even with updated hashes', t => corrupted(t, root => replaceBinary(root, 'darwin-arm64', 'adb', bytes => { const count = bytes.readUInt32BE(4); for (let i = 0; i < count; i++) bytes.writeUInt32BE(0x01000007, 8 + i * 20); }), /Mach-O architecture/));
test('rejects undeclared runtime subdirectories', t => corrupted(t, root => fs.mkdirSync(path.join(root, 'runtime/linux-x64/platform-tools/extra')), /not a regular/));
test('rejects escaped runtime dependency directory', t => corrupted(t, root => {
  const location = path.join(root, 'runtime/linux-x64/platform-tools');
  const outside = path.join(root, 'outside'); fs.mkdirSync(outside);
  assert.equal(fs.existsSync(location), false, 'Link must be constructed at a fresh path');
  fs.symlinkSync(outside, location, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(fs.lstatSync(location).isSymbolicLink(), true);
}, /real directory|escapes/, 'linux-x64/platform-tools'));

test('core runtime verifier accepts repository assets', () => {
  const result = verifyCoreRuntime(path.resolve(__dirname, '..'));
  assert.deepEqual(result.hosts.sort(), ['darwin-arm64', 'darwin-x64', 'linux-x64', 'win32-x64']);
  assert.equal(result.version, '37.0.1');
  assert.equal(result.files, 18);
});

test('core runtime verifier rejects changed manifest hashes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'android-core-runtime-'));
  try {
    fs.cpSync(path.resolve(__dirname, '..', 'runtime'), path.join(root, 'runtime'), { recursive: true });
    const manifestFile = path.join(root, 'runtime/runtime-manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    manifest.hosts['linux-x64'].dependencies.platformTools.files[0].sha256 = '0'.repeat(64);
    fs.writeFileSync(manifestFile, JSON.stringify(manifest));
    assert.throws(() => verifyCoreRuntime(root), error => error instanceof Error && error.message.includes('linux-x64/adb manifest hash/size mismatch'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
