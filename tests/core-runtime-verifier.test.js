/**
 * 功能点：四平台 ADB 发布资源的严格校验，与已删除的 Coordinator 服务无关。
 * 受影响对象：verifyCoreRuntime、平台清单、二进制、provenance、许可及目录边界。
 * 复现路径：Node>=22，复制真实 platform-tools 到隔离目录并分别破坏文件、架构或路径。
 * 测试范围：无服务源码/资源时通过，缺失、篡改、错误架构、目录、链接及清单错误时拒绝。
 * 执行入口：node --test tests/core-runtime-verifier.test.js；也由 npm test 发现。
 * 预期结果：仅依赖真实四平台 ADB 资产，现有完整性与路径校验不降低。
 * 判据：完整资产通过，每个损坏场景抛错；不得依赖历史服务文件。
 */
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
  const source = path.resolve(__dirname, '..', 'resources', 'platform-tools');
  const omitted = omittedDirectory && path.join(source, omittedDirectory);
  fs.cpSync(source, path.join(root, 'resources', 'platform-tools'), { recursive: true, filter: candidate => candidate !== omitted });
  change(root);
  assert.throws(() => verifyCoreRuntime(root), message);
}
// 模拟同时更新清单和provenance的错误架构，确保架构门禁独立于哈希存在。
function replaceBinary(root, host, filename, mutate) {
  const directory = path.join(root, 'resources', 'platform-tools', host);
  const file = path.join(directory, filename); const bytes = fs.readFileSync(file);
  mutate(bytes); fs.writeFileSync(file, bytes);
  const digest = b => crypto.createHash('sha256').update(b).digest('hex');
  const provenanceFile = path.join(directory, 'adb-provenance.json');
  const provenance = JSON.parse(fs.readFileSync(provenanceFile));
  provenance.payloads.find(entry => entry.path === filename).sha256 = digest(bytes);
  fs.writeFileSync(provenanceFile, JSON.stringify(provenance));
  const manifestFile = path.join(root, 'resources', 'platform-tools', 'runtime-manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestFile));
  for (const entry of manifest.hosts[host].dependencies.platformTools.files) { const b = fs.readFileSync(path.join(directory, entry.path)); entry.sha256 = digest(b); entry.bytes = b.length; }
  fs.writeFileSync(manifestFile, JSON.stringify(manifest));
}
// Node>=22运行本文件及vsix-content：真实文件通过，以下每个错误必须拒绝。
test('rejects missing Windows companion DLL', t => corrupted(t, root => fs.rmSync(path.join(root, 'resources/platform-tools/win32-x64/AdbWinApi.dll')), /file set mismatch/));
test('rejects modified Windows companion DLL', t => corrupted(t, root => fs.appendFileSync(path.join(root, 'resources/platform-tools/win32-x64/AdbWinUsbApi.dll'), 'corrupt'), /hash[/]size mismatch/));
test('rejects wrong PE machine even with updated hashes', t => corrupted(t, root => replaceBinary(root, 'win32-x64', 'adb.exe', bytes => bytes.writeUInt16LE(0xaa64, bytes.readUInt32LE(0x3c) + 4)), /not PE i386/));
test('rejects wrong ELF machine even with updated hashes', t => corrupted(t, root => replaceBinary(root, 'linux-x64', 'adb', bytes => bytes.writeUInt16LE(183, 18)), /not ELF x86_64/));
test('rejects missing Mach-O target even with updated hashes', t => corrupted(t, root => replaceBinary(root, 'darwin-arm64', 'adb', bytes => { const count = bytes.readUInt32BE(4); for (let i = 0; i < count; i++) bytes.writeUInt32BE(0x01000007, 8 + i * 20); }), /Mach-O architecture/));
test('rejects undeclared runtime subdirectories', t => corrupted(t, root => fs.mkdirSync(path.join(root, 'resources/platform-tools/linux-x64/extra')), /not a regular/));
test('rejects escaped runtime dependency directory', t => corrupted(t, root => {
  const location = path.join(root, 'resources/platform-tools/linux-x64');
  const outside = path.join(root, 'outside'); fs.mkdirSync(outside);
  assert.equal(fs.existsSync(location), false, 'Link must be constructed at a fresh path');
  fs.symlinkSync(outside, location, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(fs.lstatSync(location).isSymbolicLink(), true);
}, /real directory|escapes/, 'linux-x64'));

// 输入两个资源父级位置并构造指向真实资产的链接；Node>=22运行本文件，应在读取清单前拒绝父级链接。
for (const parent of ['resources', 'platform-tools']) {
  test('rejects linked runtime parent ' + parent, t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'android-runtime-parent-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const resources = path.join(root, 'resources');
    if (parent === 'platform-tools') fs.mkdirSync(resources);
    const target = parent === 'resources' ? path.resolve(__dirname, '../resources') : path.resolve(__dirname, '../resources/platform-tools');
    const location = parent === 'resources' ? resources : path.join(resources, 'platform-tools');
    fs.symlinkSync(target, location, process.platform === 'win32' ? 'junction' : 'dir');
    assert.equal(fs.lstatSync(location).isSymbolicLink(), true);
    assert.throws(() => verifyCoreRuntime(root), /parent directory is not a real directory/);
  });
}

// 仅提供 ADB 资产的隔离根，证明发布门禁不读取服务源码、JAR 或服务许可。
test('core runtime verifier accepts platform tools without coordinator assets', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'android-core-only-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.cpSync(path.resolve(__dirname, '../resources/platform-tools'), path.join(root, 'resources/platform-tools'), { recursive: true });
  assert.equal(fs.existsSync(path.join(root, 'src')), false);
  assert.equal(fs.existsSync(path.join(root, 'resources/jvm-debugger')), false);
  const result = verifyCoreRuntime(root);
  assert.deepEqual(result.hosts.sort(), ['darwin-arm64', 'darwin-x64', 'linux-x64', 'win32-x64']);
  assert.equal(result.version, '37.0.1');
  assert.equal(result.files, 18);
});

test('core runtime verifier accepts repository assets', () => {
  const result = verifyCoreRuntime(path.resolve(__dirname, '..'));
  assert.deepEqual(result.hosts.sort(), ['darwin-arm64', 'darwin-x64', 'linux-x64', 'win32-x64']);
  assert.equal(result.version, '37.0.1');
  assert.equal(result.files, 18);
});

test('core runtime verifier rejects changed manifest hashes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'android-core-runtime-'));
  try {
    fs.cpSync(path.resolve(__dirname, '..', 'resources', 'platform-tools'), path.join(root, 'resources', 'platform-tools'), { recursive: true });
    const manifestFile = path.join(root, 'resources/platform-tools/runtime-manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    manifest.hosts['linux-x64'].dependencies.platformTools.files[0].sha256 = '0'.repeat(64);
    fs.writeFileSync(manifestFile, JSON.stringify(manifest));
    assert.throws(() => verifyCoreRuntime(root), error => error instanceof Error && error.message.includes('linux-x64/adb manifest hash/size mismatch'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
