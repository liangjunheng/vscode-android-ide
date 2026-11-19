const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { transformSync } = require('esbuild');
const source = fs.readFileSync(path.join(__dirname, '../src/android-debugger/native-debugger/nativeToolchain.ts'), 'utf8');

/** 加载真实工具链模块，隔离本机设置/环境，只让文件检查访问测试创建的目录；npm test发现本文件。 */
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-toolchain-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const state = { local: {}, settings: {}, runtime: undefined, sdk: '', adb: 'adb', env: {} };
  const module = { exports: {} };
  const vscode = { Uri: { file: fsPath => ({ fsPath }) }, workspace: { getConfiguration(section, uri) { assert.equal(section, 'android-debug'); state.uri = uri; return { get: key => state.settings[key] }; } } };
  const disk = new Proxy(fs, { get(target, key) { if (key !== 'statSync') return target[key]; return file => { if (file === 'forbidden') throw Object.assign(new Error('permission denied'), { code: 'EACCES' }); return fs.statSync(file); }; } });
  vm.runInNewContext(transformSync(source, { loader: 'ts', format: 'cjs' }).code, { module, exports: module.exports, process: { platform: process.platform, env: state.env }, require(id) {
    if (id === 'vscode') return vscode;
    if (id === 'node:fs') return disk;
    if (id === '../../sdk') return { sdkRoot: () => state.sdk, adbPath: () => state.adb };
    if (id === '../../projectLocalConfig') return { readProjectLocalConfig: () => state.local };
    if (id === '../../runtimeContext') return { getRuntimeContext: () => state.runtime };
    return require(id);
  } });
  return { root, state, api: module.exports };
}

/** 构造真实 NDK LLVM 标记；输入测试根和版本名，返回绝对目录。 */
function ndk(root, name) { const result = path.join(root, name); fs.mkdirSync(path.join(result, 'toolchains', 'llvm'), { recursive: true }); return result; }
/** 构造普通可执行文件占位，不执行伪二进制；路径验证只关心文件归属与类型。 */
function file(filename, content = '') { fs.mkdirSync(path.dirname(filename), { recursive: true }); fs.writeFileSync(filename, content); return filename; }

test('Native toolchain honors project local then runtime and environment', t => {
  const f = fixture(t), localNdk = ndk(f.root, 'local'), configured = ndk(f.root, 'configured'), bundled = ndk(f.root, 'runtime'), env = ndk(f.root, 'environment');
  const localAdb = file(path.join(f.root, 'local-adb')), runtimeAdb = file(path.join(f.root, 'runtime-adb'));
  f.state.local = { sdkPath: f.root, debugger: { ndkPath: localNdk, adbPath: localAdb } };
  const configuredSdk = path.join(f.root, 'configured-sdk'); fs.mkdirSync(configuredSdk);
  f.state.settings = { ndkRoot: configured, sdkRoot: configuredSdk };
  f.state.runtime = { dependencies: { ndkRoot: bundled, adb: runtimeAdb } }; f.state.env.ANDROID_NDK_ROOT = env;
  let result = f.api.resolveNativeToolchain(f.root);
  assert.equal(result.ndkRoot, localNdk); assert.equal(result.adb, localAdb); assert.equal(result.sdkRoot, f.root);
  f.state.local = {}; result = f.api.resolveNativeToolchain(); assert.equal(result.ndkRoot, bundled); assert.equal(result.adb, runtimeAdb); assert.equal(result.sdkRoot, '');
  f.state.runtime = undefined; result = f.api.resolveNativeToolchain(); assert.equal(result.ndkRoot, env); assert.equal(result.adb, 'adb'); assert.equal(result.sdkRoot, '');
});

test('Native toolchain reads Android local.properties for SDK and NDK before runtime fallback', t => {
  const f = fixture(t); const sdk = path.join(f.root, 'android-sdk'); const ndkRoot = ndk(f.root, 'android-ndk');
  fs.mkdirSync(sdk); fs.writeFileSync(path.join(f.root, 'local.properties'), 'sdk.dir=android-sdk\nndk.dir=android-ndk\n');
  const result = f.api.resolveNativeToolchain(f.root);
  assert.equal(result.sdkRoot, sdk); assert.equal(result.ndkRoot, ndkRoot);
});

test('Native discovery keeps upstream SDK ndk and ndk-bundle layout with PATH ADB fallback', t => {
  const f = fixture(t); f.state.sdk = f.root;
  const older = ndk(f.root, 'ndk/25.2'), latest = ndk(f.root, 'ndk/27.1');
  assert.equal(f.api.resolveNativeToolchain().ndkRoot, latest);
  const sdkAdb = file(path.join(f.root, 'platform-tools', process.platform === 'win32' ? 'adb.exe' : 'adb'));
  assert.equal(f.api.resolveNativeToolchain().adb, sdkAdb);
  fs.rmSync(path.join(f.root, 'ndk'), { recursive: true });
  const legacy = ndk(f.root, 'ndk-bundle'); assert.equal(f.api.resolveNativeToolchain().ndkRoot, legacy);
  fs.rmSync(legacy, { recursive: true }); assert.throws(() => f.api.resolveNativeToolchain(), /NDK root/);
  assert.notEqual(older, latest);
});

test('Native explicit invalid paths and permission errors fail instead of silently falling back', t => {
  const f = fixture(t); const valid = ndk(f.root, 'valid'); f.state.env.ANDROID_NDK_ROOT = valid;
  assert.throws(() => f.api.resolveNativeToolchain(undefined, { ndkRoot: path.join(f.root, 'missing') }), /valid Android NDK/);
  assert.throws(() => f.api.resolveNativeToolchain(undefined, { sdkRoot: path.join(f.root, 'missing') }), /SDK root/);
  assert.throws(() => f.api.resolveNativeToolchain(undefined, { sdkRoot: 'forbidden' }), /permission denied/);
  f.state.settings = {}; f.state.local = { debugger: { adbPath: path.join(f.root, 'missing-adb') } }; assert.throws(() => f.api.resolveNativeToolchain(), /ENOENT/);
  f.state.local.debugger.adbPath = f.root; assert.throws(() => f.api.resolveNativeToolchain(), /Invalid Android ADB/);
});

test('Native launch overrides take precedence and ABI fields are validated before runtime use', t => {
  const f = fixture(t); const local = ndk(f.root, 'local'); const configured = ndk(f.root, 'configured'); const override = ndk(f.root, 'override');
  const localSdk = path.join(f.root, 'local-sdk'); const overrideSdk = path.join(f.root, 'override-sdk'); fs.mkdirSync(localSdk); fs.mkdirSync(overrideSdk);
  f.state.local = { sdkPath: localSdk, debugger: { ndkPath: local } }; f.state.settings = { sdkRoot: path.join(f.root, 'configured-sdk'), ndkRoot: configured };
  const resolved = f.api.resolveNativeToolchain(f.root, { sdkRoot: overrideSdk, ndkRoot: override }); assert.equal(resolved.sdkRoot, overrideSdk); assert.equal(resolved.ndkRoot, override);
  const parsed = f.api.nativeToolchainOverrides({ sdkRoot: overrideSdk, ndkRoot: override }); assert.equal(parsed.sdkRoot, overrideSdk); assert.equal(parsed.ndkRoot, override);
  assert.throws(() => f.api.nativeToolchainOverrides({ sdkRoot: '' }), /non-empty path/);
  assert.doesNotThrow(() => f.api.validateNativeAbis({ abiSupported: ['arm64-v8a'], abi: 'select' }));
  assert.throws(() => f.api.validateNativeAbis({ abiSupported: ['mips'] }), /abiSupported/);
  assert.throws(() => f.api.validateNativeAbis({ abi: 'mips' }), /Invalid Native ABI/);
});

test('Native lldb-server matches all upstream ABI host tags and clang layouts in original order', t => {
  const f = fixture(t); const root = ndk(f.root, 'ndk');
  for (const [abi, arch] of [['armeabi', 'arm'], ['armeabi-v7a', 'arm'], ['arm64-v8a', 'aarch64'], ['x86', 'i386'], ['x86_64', 'x86_64']]) assert.equal(f.api.lldbServerArch(abi), arch);
  assert.throws(() => f.api.lldbServerArch('mips'), /Unsupported Android ABI/);
  for (const [platform, host] of [['win32', 'windows-x86_64'], ['darwin', 'darwin-x86_64'], ['linux', 'linux-x86_64']]) {
    const llvm = path.join(root, 'toolchains', 'llvm', 'prebuilt', host);
    file(path.join(llvm, 'AndroidVersion.txt'), '18.0.1\r\n');
    const candidates = ['lib64/clang/18.0.1', 'lib/clang/18.0.1', 'lib/clang/18'].map(base => file(path.join(llvm, base, 'lib/linux/aarch64/lldb-server')));
    for (const candidate of candidates) { assert.equal(f.api.findLldbServer(root, 'arm64-v8a', platform), candidate); fs.rmSync(candidate); }
    assert.throws(() => f.api.findLldbServer(root, 'arm64-v8a', platform), /Could not locate/);
  }
  assert.throws(() => f.api.findLldbServer(path.join(f.root, 'absent'), 'arm64-v8a'), /ENOENT/);
});
