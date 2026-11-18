const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
let verifyRuntime;

// 在现有 CommonJS runner 的 before 钩子中加载 ESM，不改变项目模块类型。
test.before(async () => { ({ verifyRuntime } = await import('../scripts/verify-runtime.mjs')); });

// 执行 node --test tests/runtime-package-manifest.test.js；正常矩阵断言数量，异常路径断言具体错误，CLI 断言真实退出码。
const abis = ['arm64-v8a', 'armeabi-v7a', 'x86', 'x86_64'];
const targets = ['win32-x64', 'linux-x64', 'darwin-x64', 'darwin-arm64'];

/** 创建最小可识别原生文件头，并按目标平台和 ABI 写入架构字段。 */
function nativeHeader(target, abi, role) {
  const platform = target.split('-')[0];
  const bytes = Buffer.alloc(128, 0);
  if (role === 'lldb-server') {
    bytes.set([0x7f, 0x45, 0x4c, 0x46, (abi === 'arm64-v8a' || abi === 'x86_64') ? 2 : 1], 0);
    bytes[5] = 1; bytes[6] = 1; bytes.writeUInt16LE({ 'arm64-v8a': 183, 'armeabi-v7a': 40, x86: 3, x86_64: 62 }[abi], 18);
  } else if (platform === 'win32') {
    bytes.set([0x4d, 0x5a], 0); bytes.writeUInt32LE(0x40, 0x3c); bytes.set([0x50, 0x45, 0, 0], 0x40); bytes.writeUInt16LE(target.endsWith('arm64') ? 0xaa64 : 0x8664, 0x44);
  } else if (platform === 'darwin') {
    bytes.writeUInt32LE(0xfeedfacf, 0); bytes.writeUInt32LE(target.endsWith('arm64') ? 0x0100000c : 0x01000007, 4);
  } else {
    bytes.set([0x7f, 0x45, 0x4c, 0x46, target.endsWith('arm64') ? 2 : 2], 0); bytes[5] = 1; bytes[6] = 1; bytes.writeUInt16LE(target.endsWith('arm64') ? 183 : 62, 18);
  }
  return bytes;
}

/** 构造完整临时包和真实哈希清单，供成功与拒绝路径共享。 */
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-package-'));
  for (const relative of ['dist/extension.js', 'dist/android-jvm-debugger.js', 'dist/THIRD_PARTY_NOTICES.txt', 'android-debugger/jvm/LICENSE', 'schemas/android-ide.local.schema.json']) { const filename = path.join(root, relative); fs.mkdirSync(path.dirname(filename), { recursive: true }); fs.writeFileSync(filename, 'required'); }
  const manifest = { schemaVersion: 1, targets: {} };
  for (const target of targets) {
    manifest.targets[target] = { files: [] };
    for (const role of ['adb', 'lldb-dap']) { const relative = 'runtime/' + target + '/' + role; const filename = path.join(root, relative); fs.mkdirSync(path.dirname(filename), { recursive: true }); fs.writeFileSync(filename, nativeHeader(target, undefined, role)); fs.chmodSync(filename, 0o755); manifest.targets[target].files.push({ path: relative, sha256: crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex'), role }); }
    for (const abi of abis) { const relative = 'runtime/' + target + '/lldb-server-' + abi; const filename = path.join(root, relative); fs.writeFileSync(filename, nativeHeader(target, abi, 'lldb-server')); fs.chmodSync(filename, 0o755); manifest.targets[target].files.push({ path: relative, sha256: crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex'), role: 'lldb-server', abi }); }
    const license = 'runtime/' + target + '/LICENSE.txt'; const licenseFile = path.join(root, license); fs.writeFileSync(licenseFile, 'license'); manifest.targets[target].files.push({ path: license, sha256: crypto.createHash('sha256').update('license').digest('hex'), role: 'license' });
  }
  fs.mkdirSync(path.join(root, 'runtime'), { recursive: true }); fs.writeFileSync(path.join(root, 'runtime/runtime-manifest.json'), JSON.stringify(manifest));
  return { root, manifest };
}

/** 为每个拒绝路径断言验证器抛出失败，覆盖清单、文件、安全和原生检查。 */
function rejectsCase(name, mutate, pattern) {
  test(name, () => { const f = fixture(); try { mutate(f); assert.throws(() => verifyRuntime(f.root, f.useManifest === false ? undefined : f.manifest), pattern); } finally { fs.rmSync(f.root, { recursive: true, force: true }); } });
}

test('verifies all targets and payload hashes', () => { const f = fixture(); try { assert.deepEqual(verifyRuntime(f.root, f.manifest), { targets: 4, files: 28 }); } finally { fs.rmSync(f.root, { recursive: true, force: true }); } });

// 跨目标共享仅允许同一规范化路径、角色、ABI和哈希；计数按实际唯一路径而非清单条目统计。
test('allows identical shared servers and licenses across targets', () => {
  const f = fixture();
  try {
    const sharedDir = path.join(f.root, 'runtime/shared'); fs.mkdirSync(sharedDir, { recursive: true });
    const sharedLicense = path.join(sharedDir, 'LICENSE.txt'); fs.writeFileSync(sharedLicense, 'license');
    const licenseHash = crypto.createHash('sha256').update('license').digest('hex');
    for (const target of targets) {
      const license = f.manifest.targets[target].files.find(entry => entry.role === 'license');
      license.path = 'runtime/shared/LICENSE.txt'; license.sha256 = licenseHash;
      for (const abi of abis) {
        const entry = f.manifest.targets[target].files.find(item => item.role === 'lldb-server' && item.abi === abi);
        const relative = 'runtime/shared/lldb-server-' + abi;
        const filename = path.join(f.root, relative);
        if (!fs.existsSync(filename)) { fs.writeFileSync(filename, nativeHeader('linux-x64', abi, 'lldb-server')); fs.chmodSync(filename, 0o755); }
        entry.path = relative; entry.sha256 = crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
      }
    }
    assert.deepEqual(verifyRuntime(f.root, f.manifest), { targets: 4, files: 13 });
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('rejects conflicting shared role, ABI, and hash metadata', () => {
  for (const conflict of ['role', 'abi', 'hash']) {
    const f = fixture();
    try {
      const first = f.manifest.targets['win32-x64'].files.find(entry => entry.role === 'license');
      const second = f.manifest.targets['linux-x64'].files.find(entry => entry.role === 'license');
      second.path = first.path;
      if (conflict === 'role') second.role = 'library';
      if (conflict === 'hash') second.sha256 = '0'.repeat(64);
      if (conflict === 'abi') {
        const server = f.manifest.targets['linux-x64'].files.find(entry => entry.role === 'lldb-server' && entry.abi === 'arm64-v8a');
        const shared = f.manifest.targets['win32-x64'].files.find(entry => entry.role === 'lldb-server' && entry.abi === 'arm64-v8a');
        server.path = shared.path;
        server.abi = 'x86_64';
      }
      assert.throws(() => verifyRuntime(f.root, f.manifest), conflict === 'hash' ? /sha256 mismatch|conflicting shared payload metadata/ : /conflicting shared payload metadata/);
    } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
  }
});
rejectsCase('rejects missing manifest', f => { fs.rmSync(path.join(f.root, 'runtime/runtime-manifest.json')); f.useManifest = false; }, /ENOENT/);
rejectsCase('rejects missing required file', f => fs.rmSync(path.join(f.root, 'dist/extension.js')), /ENOENT|required file/);
rejectsCase('rejects empty payload', f => fs.writeFileSync(path.join(f.root, f.manifest.targets['win32-x64'].files[0].path), ''), /payload missing or empty|sha256/);
rejectsCase('rejects hash mismatch', f => fs.writeFileSync(path.join(f.root, f.manifest.targets['win32-x64'].files[0].path), 'changed'), /sha256 mismatch/);
rejectsCase('rejects duplicate path', f => f.manifest.targets['win32-x64'].files.push({ ...f.manifest.targets['win32-x64'].files[0] }), /duplicate payload path/);
rejectsCase('rejects invalid role', f => { f.manifest.targets['win32-x64'].files[0].role = 'adb-copy'; }, /invalid role/);
rejectsCase('rejects missing target', f => { delete f.manifest.targets['linux-x64']; }, /exactly all supported/);
rejectsCase('rejects missing ABI', f => { f.manifest.targets['linux-x64'].files = f.manifest.targets['linux-x64'].files.filter(e => e.abi !== 'x86'); }, /missing lldb-server ABI x86/);
rejectsCase('rejects traversal path', f => { const e = f.manifest.targets['win32-x64'].files[0]; e.path = '../outside'; }, /invalid payload path|escapes package/);
// 使用真实目录链接，Windows 以 junction 验证同一 realpath 逃逸契约而无需提升权限。
test('rejects symlink escape', () => {
  const f = fixture();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-outside-'));
  try {
    fs.writeFileSync(path.join(outside, 'payload'), 'outside');
    fs.symlinkSync(outside, path.join(f.root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
    const e = f.manifest.targets['win32-x64'].files[0];
    e.path = 'escape/payload';
    e.sha256 = crypto.createHash('sha256').update('outside').digest('hex');
    assert.throws(() => verifyRuntime(f.root, f.manifest), /symlink escapes/);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});
rejectsCase('rejects wrong ELF target', f => { const e = f.manifest.targets['linux-x64'].files.find(x => x.role === 'lldb-server' && x.abi === 'arm64-v8a'); const filename = path.join(f.root, e.path); fs.writeFileSync(filename, nativeHeader('linux-x64', 'x86_64', 'lldb-server')); e.sha256 = crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex'); }, /ABI mismatch/);
rejectsCase('rejects host executable machine', f => { const host = process.platform === 'win32' ? 'win32-x64' : process.platform === 'darwin' ? 'darwin-x64' : 'linux-x64'; const e = f.manifest.targets[host].files.find(x => x.role === 'adb'); const filename = path.join(f.root, e.path); const bytes = nativeHeader(host.endsWith('arm64') ? host : host.replace(/x64$/, 'arm64'), undefined, 'adb'); fs.writeFileSync(filename, bytes); e.sha256 = crypto.createHash('sha256').update(bytes).digest('hex'); }, /architecture mismatch/);
test('rejects non-executable native file', { skip: process.platform === 'win32' }, () => { const f = fixture(); try { const e = f.manifest.targets['linux-x64'].files.find(x => x.role === 'adb'); fs.chmodSync(path.join(f.root, e.path), 0o644); assert.throws(() => verifyRuntime(f.root, f.manifest), /not executable/); } finally { fs.rmSync(f.root, { recursive: true, force: true }); } });
test('CLI fails with nonzero status for missing manifest', () => { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-cli-')); try { const result = spawnSync(process.execPath, [path.resolve('scripts/verify-runtime.mjs')], { cwd: root, encoding: 'utf8' }); assert.notEqual(result.status, 0); assert.match(result.stderr, /ENOENT/); } finally { fs.rmSync(root, { recursive: true, force: true }); } });

// 以下结构、角色和路径用例均从完整包出发，仅破坏单一前置条件并断言拒绝原因。
rejectsCase('rejects malformed hash', f => { f.manifest.targets['win32-x64'].files[0].sha256 = 'g'.repeat(64); }, /invalid sha256/);
rejectsCase('rejects unsupported schema', f => { f.manifest.schemaVersion = 2; }, /schemaVersion/);
rejectsCase('rejects targets list', f => { f.manifest.targets = []; }, /targets object/);
rejectsCase('rejects empty target files', f => { f.manifest.targets['linux-x64'].files = []; }, /non-empty array/);
rejectsCase('rejects missing adb role', f => { f.manifest.targets['win32-x64'].files.shift(); }, /missing required role adb/);
rejectsCase('rejects missing lldb-dap role', f => { f.manifest.targets['win32-x64'].files.splice(1, 1); }, /missing required role lldb-dap/);
rejectsCase('rejects missing license', f => { f.manifest.targets['win32-x64'].files.pop(); }, /requires a license/);
rejectsCase('rejects ambiguous native role', f => { const list = f.manifest.targets['win32-x64'].files; list[1].role = 'adb'; }, /ambiguous duplicate role/);
rejectsCase('rejects unsupported server ABI', f => { f.manifest.targets['win32-x64'].files[2].abi = 'mips'; }, /supported ABI/);
rejectsCase('rejects missing payload file', f => { fs.rmSync(path.join(f.root, f.manifest.targets['win32-x64'].files[0].path)); }, /ENOENT/);
rejectsCase('rejects directory payload', f => { const file = path.join(f.root, f.manifest.targets['win32-x64'].files[0].path); fs.rmSync(file); fs.mkdirSync(file); }, /payload missing or empty/);
rejectsCase('rejects modified license hash', f => { fs.writeFileSync(path.join(f.root, f.manifest.targets['win32-x64'].files.at(-1).path), 'changed'); }, /sha256 mismatch/);
for (const bad of ['/absolute', 'C:/drive', 'C:relative', '\\server\\share', 'https://remote/payload', 'runtime/../escape']) {
  rejectsCase('rejects unsafe path ' + JSON.stringify(bad), f => { f.manifest.targets['win32-x64'].files[0].path = bad; }, /invalid payload path|escapes package/);
}

// 库和多个许可证均为显式清单载荷，允许重复角色但不能绕过逐文件哈希。
test('verifies extra libraries and licenses and hashes every payload', () => {
  const f = fixture();
  try {
    for (const [name, role] of [['one.so', 'library'], ['two.so', 'library'], ['extra-license', 'license']]) {
      const relative = 'runtime/win32-x64/' + name;
      fs.writeFileSync(path.join(f.root, relative), name);
      f.manifest.targets['win32-x64'].files.push({ path: relative, role, sha256: crypto.createHash('sha256').update(name).digest('hex') });
    }
    assert.deepEqual(verifyRuntime(f.root, f.manifest), { targets: 4, files: 31 });
    fs.writeFileSync(path.join(f.root, 'runtime/win32-x64/two.so'), 'tampered');
    assert.throws(() => verifyRuntime(f.root, f.manifest), /sha256 mismatch/);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

/** 写入单一目标角色的新字节并同步测试哈希；前提为完整 fixture，PE/FAT 矩阵验证架构规则而非哈希拒绝。 */
function replaceNative(f, target, role, bytes) {
  const entry = f.manifest.targets[target].files.find(file => file.role === role);
  fs.writeFileSync(path.join(f.root, entry.path), bytes);
  entry.sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
}

/** 按 Mach-O fat_arch/fat_arch_64 的真实字段布局生成双架构容器，支持两种表字节序；FAT 矩阵断言有效结构通过。 */
function fatHeader(wide = false, little = false, arches = ['darwin-x64', 'darwin-arm64']) {
  const bytes = Buffer.alloc(512);
  const write32 = little ? Buffer.prototype.writeUInt32LE : Buffer.prototype.writeUInt32BE;
  const write64 = little ? Buffer.prototype.writeBigUInt64LE : Buffer.prototype.writeBigUInt64BE;
  write32.call(bytes, wide ? 0xcafebabf : 0xcafebabe, 0);
  write32.call(bytes, arches.length, 4);
  for (let index = 0; index < arches.length; index++) {
    const at = 8 + index * (wide ? 32 : 20);
    const offset = 128 + index * 128;
    const thin = nativeHeader(arches[index], undefined, 'adb');
    write32.call(bytes, thin.readUInt32LE(4), at);
    write32.call(bytes, thin.readUInt32LE(8), at + 4);
    if (wide) { write64.call(bytes, BigInt(offset), at + 8); write64.call(bytes, BigInt(thin.length), at + 16); }
    else { write32.call(bytes, offset, at + 8); write32.call(bytes, thin.length, at + 12); }
    write32.call(bytes, 7, at + (wide ? 24 : 16));
    thin.copy(bytes, offset);
  }
  return bytes;
}

// Google Windows ADB 的 x86 PE 可经 WOW64 运行，但 LLDB-DAP 继续要求本机 x64。
test('accepts official-compatible x86 Windows adb only', () => {
  const f = fixture();
  try {
    const bytes = nativeHeader('win32-x64', undefined, 'adb');
    bytes.writeUInt16LE(0x14c, 0x44);
    replaceNative(f, 'win32-x64', 'adb', bytes);
    assert.deepEqual(verifyRuntime(f.root, f.manifest), { targets: 4, files: 28 });
    replaceNative(f, 'win32-x64', 'lldb-dap', bytes);
    assert.throws(() => verifyRuntime(f.root, f.manifest), /lldb-dap architecture mismatch/);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

for (const wide of [false, true]) {
  for (const little of [false, true]) {
    test('accepts universal Mach-O FAT' + (wide ? '64' : '32') + (little ? ' LE' : ' BE'), () => {
      const f = fixture();
      try {
        const bytes = fatHeader(wide, little);
        for (const target of ['darwin-x64', 'darwin-arm64']) {
          replaceNative(f, target, 'adb', bytes);
          replaceNative(f, target, 'lldb-dap', bytes);
        }
        assert.deepEqual(verifyRuntime(f.root, f.manifest), { targets: 4, files: 28 });
      } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
    });
  }
  const stride = wide ? 32 : 20;
  for (const kind of ['empty table', 'table bounds', 'slice bounds', 'table overlap', 'slice overlap', 'duplicate CPU', 'CPU mismatch', 'subtype mismatch', 'bad slice magic', 'misaligned slice', 'missing host CPU', 'truncated slice']) {
    rejectsCase('rejects FAT' + (wide ? '64 ' : '32 ') + kind, f => {
      const bytes = fatHeader(wide);
      const second = 8 + stride;
      if (kind === 'empty table') bytes.writeUInt32BE(0, 4);
      if (kind === 'table bounds') bytes.writeUInt32BE(65, 4);
      if (kind === 'slice bounds') { if (wide) bytes.writeBigUInt64BE(0xffffffffffffffffn, 16); else bytes.writeUInt32BE(0xffffffff, 16); }
      if (kind === 'table overlap') { if (wide) bytes.writeBigUInt64BE(0n, 16); else bytes.writeUInt32BE(0, 16); }
      if (kind === 'slice overlap') { if (wide) bytes.writeBigUInt64BE(128n, second + 8); else bytes.writeUInt32BE(128, second + 8); }
      if (kind === 'duplicate CPU') bytes.writeUInt32BE(0x01000007, second);
      if (kind === 'CPU mismatch') bytes.writeUInt32LE(0x0100000c, 132);
      if (kind === 'subtype mismatch') bytes.writeUInt32BE(3, 12);
      if (kind === 'bad slice magic') bytes.writeUInt32LE(0, 128);
      if (kind === 'misaligned slice') bytes.writeUInt32BE(8, 8 + (wide ? 24 : 16));
      if (kind === 'missing host CPU') bytes.writeUInt32BE(1, 4);
      if (kind === 'truncated slice') { if (wide) bytes.writeBigUInt64BE(28n, 24); else bytes.writeUInt32BE(28, 20); }
      replaceNative(f, 'darwin-arm64', 'adb', bytes);
    }, /FAT|Mach-O|architecture mismatch/);
  }
}
rejectsCase('rejects FAT64 nonzero reserved', f => { const bytes = fatHeader(true); bytes.writeUInt32BE(1, 36); replaceNative(f, 'darwin-arm64', 'adb', bytes); }, /reserved field/);
rejectsCase('rejects FAT64 oversized declared size', f => { const bytes = fatHeader(true); bytes.writeBigUInt64BE(0xffffffffffffffffn, 24); replaceNative(f, 'darwin-arm64', 'adb', bytes); }, /out of bounds/);
