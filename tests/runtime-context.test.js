const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { transformSync } = require('esbuild');

const source = fs.readFileSync(path.join(__dirname, '../src/runtimeContext.ts'), 'utf8');
const runtimeModule = { exports: {} };
const compiled = transformSync(source, { loader: 'ts', format: 'cjs', platform: 'node' }).code;
new Function('module', 'exports', 'require', compiled)(runtimeModule, runtimeModule.exports, require);
const runtime = runtimeModule.exports;

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-context-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const host = runtime.runtimeTarget();
  const platformTools = path.join(root, 'resources', 'platform-tools', host);
  fs.mkdirSync(platformTools, { recursive: true });
  return { root, host, platformTools };
}

// node --test tests/runtime-context.test.js：resources/platform-tools/<host> 是唯一内置 ADB 布局，旧 runtime/<host> 布局必须忽略，Windows 使用 adb.exe。
test('resolves bundled adb from canonical runtime layout', t => {
  const f = fixture(t);
  const adb = path.join(f.platformTools, process.platform === 'win32' ? 'adb.exe' : 'adb');
  fs.writeFileSync(adb, 'adb');
  if (process.platform !== 'win32') fs.chmodSync(adb, 0o755);
  const context = runtime.createRuntimeContext(f.root);
  assert.equal(context.target, f.host);
  assert.equal(context.runtimeRoot, path.join(f.root, 'resources'));
  assert.equal(context.dependencies.platformTools, f.platformTools);
  assert.equal(context.dependencies.adb, fs.realpathSync(adb));
  assert.equal(runtime.resolveBundledExecutable(f.root, 'adb'), fs.realpathSync(adb));
});

// 缺失内置依赖必须显式为 undefined，不伪造路径；上下文初始化对同一根目录保持稳定对象。
test('reports missing bundled dependencies and preserves initialized context', t => {
  const f = fixture(t);
  const legacyAdb = path.join(f.root, 'runtime', f.host, 'platform-tools', runtime.executable('adb'));
  fs.mkdirSync(path.dirname(legacyAdb), { recursive: true });
  fs.writeFileSync(legacyAdb, 'legacy');
  runtime.resetRuntimeContext();
  const first = runtime.initializeRuntimeContext(f.root);
  const second = runtime.initializeRuntimeContext(f.root);
  assert.strictEqual(first, second);
  assert.equal(first.dependencies.adb, undefined);
  assert.equal(fs.existsSync(legacyAdb), true);
  assert.equal(first.dependencies.lldbDap, undefined);
  assert.equal(first.dependencies.lldbServer('arm64-v8a'), undefined);
  assert.equal(first.dependencies.ndkRoot, undefined);
  assert.throws(() => runtime.initializeRuntimeContext(path.join(f.root, 'another')), /already initialized/);
  runtime.resetRuntimeContext();
  assert.equal(runtime.getRuntimeContext(), undefined);
});

// 平台/依赖/文件层级统一管理；每个候选都创建真实文件，断言实际解析路径而非字符串登记。
test('resolves every bundled dependency and platform naming convention', t => {
  const f = fixture(t);
  const base = path.join(f.root, 'resources');
  const candidates = {
    emulator: ['emulator', f.host, runtime.executable('emulator')],
    sdkmanager: ['cmdline-tools', f.host, 'latest', 'bin', runtime.commandScript('sdkmanager')],
    avdmanager: ['cmdline-tools', f.host, 'latest', 'bin', runtime.commandScript('avdmanager')],
    lldbDap: ['lldb', f.host, 'bin', runtime.executable('lldb-dap')],
  };
  for (const parts of Object.values(candidates)) { const filename = path.join(base, ...parts); fs.mkdirSync(path.dirname(filename), { recursive: true }); fs.writeFileSync(filename, 'fixture'); }
  for (const name of ['ndk', 'jdk', 'system-images']) fs.mkdirSync(path.join(base, name, f.host), { recursive: true });
  const ctx = runtime.createRuntimeContext(f.root);
  for (const [name, parts] of Object.entries(candidates)) assert.equal(ctx.dependencies[name], fs.realpathSync(path.join(base, ...parts)));
  assert.equal(ctx.dependencies.ndkRoot, fs.realpathSync(path.join(base, 'ndk', f.host)));
  assert.equal(ctx.dependencies.jdkRoot, fs.realpathSync(path.join(base, 'jdk', f.host)));
  assert.equal(ctx.dependencies.systemImagesRoot, fs.realpathSync(path.join(base, 'system-images', f.host)));
  assert.equal(ctx.dependencies.scrcpyServer, path.join(f.root, 'resources', 'scrcpy', 'scrcpy-server.jar'));
  assert.equal(runtime.bundledRuntimeCandidate(f.root, 'adb').candidate, path.join(f.platformTools, runtime.executable('adb')));
  for (const [platform, arch] of [['win32', 'x64'], ['win32', 'arm64'], ['linux', 'x64'], ['linux', 'arm64'], ['linux', 'arm'], ['darwin', 'x64'], ['darwin', 'arm64']]) assert.equal(runtime.runtimeTarget(platform, arch), platform + '-' + arch);
  assert.equal(runtime.commandScript('avdmanager', 'win32'), 'avdmanager.bat');
  assert.equal(runtime.executable('adb', 'win32'), 'adb.exe');
  assert.equal(runtime.executable('adb', 'linux'), 'adb');
});

// 越界路径/目录/权限错误不可伪装成依赖缺失；失败保留原始错误。
test('rejects escaped paths, non-files and IO failures', t => {
  const f = fixture(t);
  assert.throws(() => runtime.resolveBundledPath(f.root, ['..', 'escape']), /escapes/);
  assert.throws(() => runtime.resolveBundledPath(f.root, ['platform-tools', '..', '..', 'lldb', f.host, 'bin']), /escapes/);
  const name = runtime.executable('adb');
  fs.mkdirSync(path.join(f.platformTools, name));
  assert.throws(() => runtime.resolveBundledExecutable(f.root, 'adb'), /not a regular file/);
  const error = Object.assign(new Error('denied'), { code: 'EACCES' });
  const isolated = require('./runtime-context-loader.cjs')({ 'node:fs': { ...fs, realpathSync: () => { throw error; } } });
  assert.throws(() => isolated.resolveBundledExecutable(f.root, 'adb'), e => e === error);
});

// 真实junction/symlink越界必须拒绝，不向扩展目录外文件授予执行权限。
test('rejects a platform dependency symlink escaping its owned root', t => {
  const f = fixture(t);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-outside-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.rmSync(f.platformTools, { recursive: true });
  fs.writeFileSync(path.join(outside, runtime.executable('adb')), 'outside');
  fs.symlinkSync(outside, f.platformTools, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => runtime.resolveBundledExecutable(f.root, 'adb'), /symlink escapes/);
});

// 执行真实SDK模块，断言所有核心功能共享内置ADB，残缺SDK继续回退PATH。
test('SDK consumers share bundled paths and fallback from an incomplete SDK', t => {
  const f = fixture(t);
  const isolated = require('./runtime-context-loader.cjs')();
  const sdkRoot = path.join(f.root, 'sdk'); fs.mkdirSync(sdkRoot);
  const sdkModule = { exports: {} };
  const sdkSource = fs.readFileSync(path.join(__dirname, '../src/sdk.ts'), 'utf8');
  new Function('module', 'exports', 'require', transformSync(sdkSource, { loader: 'ts', format: 'cjs' }).code)(sdkModule, sdkModule.exports, id => id === './runtimeContext' ? isolated : id === './projectLocalConfig' ? { readProjectLocalConfig: () => ({ sdkPath: sdkRoot }) } : require(id));
  const sdk = sdkModule.exports;
  assert.equal(sdk.adbPath(), runtime.executable('adb'));
  const sdkAdb = path.join(sdkRoot, 'platform-tools', runtime.executable('adb'));
  fs.mkdirSync(path.dirname(sdkAdb)); fs.writeFileSync(sdkAdb, 'SDK adb');
  assert.equal(sdk.adbPath(), sdkAdb);
  const bundled = path.join(f.platformTools, runtime.executable('adb')); fs.writeFileSync(bundled, 'bundled adb');
  isolated.initializeRuntimeContext(f.root);
  assert.equal(sdk.adbPath(), fs.realpathSync(bundled));
  isolated.resetRuntimeContext(); fs.rmSync(sdkAdb);
  assert.equal(sdk.adbPath(), runtime.executable('adb'));
  assert.equal(sdk.emulatorPath(), runtime.sdkToolPath(sdkRoot, 'emulator'));
  const avd = path.join(sdkRoot, 'cmdline-tools', 'latest', 'bin', runtime.commandScript('avdmanager'));
  fs.mkdirSync(path.dirname(avd), { recursive: true }); fs.writeFileSync(avd, 'avdmanager');
  assert.equal(sdk.avdmanagerPath(), avd);
});

// lldb-server 按设备 ABI 从 resources/lldb-server/<host>/<abi> 解析，越界链接和目录均不视为成功。
test('resolves ABI-specific bundled lldb-server safely', t => {
  const f = fixture(t);
  const dir = path.join(f.root, 'resources', 'lldb-server', f.host, 'arm64-v8a');
  fs.mkdirSync(dir, { recursive: true });
  const server = path.join(dir, 'lldb-server');
  fs.writeFileSync(server, 'server');
  if (process.platform !== 'win32') fs.chmodSync(server, 0o755);
  assert.equal(runtime.resolveBundledLldbServer(f.root, 'arm64-v8a'), fs.realpathSync(server));
  assert.equal(runtime.resolveBundledLldbServer(f.root, 'x86'), undefined);
  fs.rmSync(server);
  fs.mkdirSync(server);
  assert.throws(() => runtime.resolveBundledLldbServer(f.root, 'arm64-v8a'), /not a regular file/);
});

// Unix仅修复扩展自有文件的执行位；Windows不修改权限。
test('repairs owned executable bits on Unix', { skip: process.platform === 'win32' }, t => {
  const f = fixture(t);
  const adb = path.join(f.platformTools, 'adb');
  fs.writeFileSync(adb, 'adb');
  fs.chmodSync(adb, 0o644);
  assert.equal(runtime.resolveBundledExecutable(f.root, 'adb'), fs.realpathSync(adb));
  assert.notEqual(fs.statSync(adb).mode & 0o111, 0);
});
