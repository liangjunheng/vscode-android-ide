const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildSync } = require('esbuild');

// 执行真实native工具链和RuntimeContext闭包，仅隔离PATH查询；不运行调试后端或设备操作。
// Node>=22执行node --test tests/android-native-toolchain.test.js，精确断言runtime路径、旧目录拒绝和NDK覆盖。
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'android-native-toolchain-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const extension = path.join(root, 'extension'); const storage = path.join(root, 'storage');
  fs.mkdirSync(extension); fs.mkdirSync(storage);
  const host = process.platform + '-' + process.arch;
  const binary = process.platform === 'win32' ? 'lldb-dap.exe' : 'lldb-dap';
  const context = { extensionPath: extension, globalStorageUri: { fsPath: storage } };
  const compiled = buildSync({ entryPoints: [path.join(__dirname, '../src/android-debugger/native-debugger/nativeToolchain.ts')], bundle: true, write: false, platform: 'node', format: 'cjs' }).outputFiles[0].text;
  const module = { exports: {} }; const calls = [];
  new Function('module', 'exports', 'require', compiled)(module, module.exports, id => id === 'node:child_process' ? { execFile: (exe, args, options, callback) => { calls.push([exe, args]); callback(Object.assign(new Error('not found'), { code: 1 }), ''); } } : require(id));
  // 写入有执行位的fixture文件，验证路径不执行这些内容。
  const put = file => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, 'fixture'); fs.chmodSync(file, 0o755); return fs.realpathSync(file); };
  return { root, extension, storage, host, binary, context, put, calls, ...module.exports };
}

// 扩展和global storage只使用runtime/<host>/lldb/bin；停用后端缓存不会被读取。
test('native host resolver uses canonical runtime and never retired tools', async t => {
  const f = fixture(t);
  const primary = f.put(path.join(f.extension, 'runtime', f.host, 'lldb', 'bin', f.binary));
  const storage = f.put(path.join(f.storage, 'runtime', f.host, 'lldb', 'bin', f.binary));
  f.put(path.join(f.extension, 'tools', f.host, 'llvm', 'bin', f.binary));
  const options = { context: f.context, sdkRoot: '' };
  assert.equal((await f.resolveNativeHostToolchain(options)).lldbDap, primary);
  fs.rmSync(primary);
  assert.equal((await f.resolveNativeHostToolchain(options)).lldbDap, storage);
  fs.rmSync(storage);
  await assert.rejects(f.resolveNativeHostToolchain(options), /lldb-dap is unavailable/);
  assert.ok(f.calls.some(([exe, args]) => exe === (process.platform === 'win32' ? 'where.exe' : 'which') && args[0] === f.binary));
  const configured = f.put(path.join(f.root, f.binary));
  assert.equal((await f.resolveNativeHostToolchain({ ...options, overrides: { lldbDapPath: configured } })).lldbDap, configured);
});

// Android端server按设备ABI解析，文件名始终无.exe；旧tools/android不再作为回退。
test('native server resolver uses canonical runtime ABI files and ignores retired cache', async t => {
  const f = fixture(t);
  for (const abi of ['arm64-v8a', 'armeabi-v7a', 'x86', 'x86_64']) {
    const primary = f.put(path.join(f.extension, 'runtime', f.host, 'lldb-server', abi, 'lldb-server'));
    const storage = f.put(path.join(f.storage, 'runtime', f.host, 'lldb-server', abi, 'lldb-server'));
    f.put(path.join(f.extension, 'tools', 'android', 'lldb-server', abi, 'lldb-server'));
    const options = { context: f.context, abi };
    assert.equal(await f.resolveNativeServer(options), primary);
    fs.rmSync(primary); assert.equal(await f.resolveNativeServer(options), storage);
    fs.rmSync(storage); await assert.rejects(f.resolveNativeServer(options), /no packaged server or NDK/);
  }
  await assert.rejects(f.resolveNativeServer({ context: f.context, abi: '../escape' }), /Unsupported target ABI/);
});

// 显式NDK覆盖仍保持最高优先级；移除旧tools不改变外部SDK行为。
test('native explicit NDK server selection remains isolated from bundled runtime', async t => {
  const f = fixture(t);
  const ndk = path.join(f.root, 'ndk'); fs.mkdirSync(ndk);
  fs.writeFileSync(path.join(ndk, 'source.properties'), 'Pkg.Revision=27.0.0');
  const ndkHost = ({ win32: 'windows-x86_64', linux: 'linux-x86_64', darwin: 'darwin-x86_64' })[process.platform];
  const server = f.put(path.join(ndk, 'toolchains', 'llvm', 'prebuilt', ndkHost, 'lib', 'clang', '20', 'lib', 'linux', 'aarch64', 'lldb-server'));
  f.put(path.join(f.extension, 'runtime', f.host, 'lldb-server', 'arm64-v8a', 'lldb-server'));
  assert.equal(await f.resolveNativeServer({ context: f.context, abi: 'arm64-v8a', overrides: { ndkPath: ndk } }), server);
  fs.rmSync(server);
  await assert.rejects(f.resolveNativeServer({ context: f.context, abi: 'arm64-v8a', overrides: { ndkPath: ndk } }), /unavailable in NDK/);
});
