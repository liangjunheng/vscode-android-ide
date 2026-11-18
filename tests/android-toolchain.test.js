const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { transformSync } = require('esbuild');

const source = fs.readFileSync(path.join(__dirname, '../src/android-debugger/toolchain.ts'), 'utf8');

// 创建可控的 VS Code 配置和 execFile 替身，验证工具链搜索顺序而不依赖宿主真实 SDK。
function resolverFixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'android-toolchain-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = { sdkPath: options.sdkPath || '', adbPath: options.adbPath || '' };
  const rootsRead = [];
  const vscode = { workspace: { getConfiguration: () => { throw new Error('Machine paths must come from project-local configuration'); } } };
  const execFile = (command, args, opts, callback) => {
    if (options.pathAdb) callback(null, options.pathAdb + '\n', '');
    else callback(new Error('not found'), '', '');
  };
  const module = { exports: {} };
  const runtimeModule = { exports: {} };
  vm.runInNewContext(transformSync(fs.readFileSync(path.join(__dirname, '../src/android-debugger/runtimeExecutable.ts'), 'utf8'), { loader: 'ts', format: 'cjs' }).code, { module: runtimeModule, exports: runtimeModule.exports, require, process });
  vm.runInNewContext(transformSync(source, { loader: 'ts', format: 'cjs' }).code, {
    module,
    exports: module.exports,
    require: id => id === '../runtimeContext' ? require('./runtime-context-loader.cjs')() : id === './runtimeExecutable' ? runtimeModule.exports : id === 'vscode' ? vscode : id === '../projectLocalConfig' ? { readProjectLocalConfig: projectRoot => { rootsRead.push(projectRoot); return { sdkPath: config.sdkPath, debugger: { adbPath: config.adbPath } }; } } : id === 'node:child_process' ? { execFile } : require(id),
    process,
    console,
  });
  return { root, config, rootsRead, resolve: module.exports.resolveAndroidToolchain };
}

// npm test：显式本机adb覆盖自动解析，无效覆盖拒绝而非静默回退。
test('debugger adb override uses project local configuration and rejects invalid paths', async t => {
  const f = resolverFixture(t, { pathAdb: 'automatic-adb' });
  const adb = path.join(f.root, 'custom adb');
  fs.writeFileSync(adb, '');
  f.config.adbPath = adb;
  const result = await f.resolve(undefined, f.root);
  assert.deepEqual(f.rootsRead, [f.root]);
  assert.equal(result.adb, adb);
  assert.equal(result.source, 'configuration');
  for (const invalid of ['relative-adb', path.join(f.root, 'missing-adb'), f.root]) {
    f.config.adbPath = invalid;
    await assert.rejects(f.resolve(), /Invalid project-local debugger[.]adbPath/);
  }
});

// npm test：扩展规范runtime优先于存储；旧tools即使存在也不能影响生产/开发一致性。
test('bundled runtime resolves extension before storage and ignores retired tools', async t => {
  const f = resolverFixture(t, { pathAdb: 'adb-from-path' });
  const extensionRoot = path.join(f.root, 'extension'); const storageRoot = path.join(f.root, 'storage');
  const binary = process.platform === 'win32' ? 'adb.exe' : 'adb';
  const host = process.platform + '-' + process.arch;
  const primary = path.join(extensionRoot, 'runtime', host, 'platform-tools', binary);
  const retired = path.join(extensionRoot, 'tools', host, binary);
  const retiredNested = path.join(extensionRoot, 'tools', host, 'platform-tools', binary);
  const storage = path.join(storageRoot, 'runtime', host, 'platform-tools', binary);
  for (const file of [primary, retired, retiredNested, storage]) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, 'fixture'); }
  const context = { extensionPath: extensionRoot, globalStorageUri: { fsPath: storageRoot } };
  assert.equal((await f.resolve(context)).adb, primary);
  fs.rmSync(primary); const selected = await f.resolve(context);
  assert.equal(selected.adb, storage); assert.equal(selected.source, 'extension');
  fs.rmSync(storage);
  const fallback = await f.resolve(context);
  assert.equal(fallback.adb, 'adb-from-path'); assert.equal(fallback.source, 'path');
});

// npm test：扩展工具优先于 SDK、SDK 优先于 PATH，缺失时保留跨平台诊断。
test('android toolchain resolves extension, SDK, PATH, and missing diagnostics', async t => {
  const extensionRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'android-extension-'));
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'android-storage-'));
  t.after(() => { fs.rmSync(extensionRoot, { recursive: true, force: true }); fs.rmSync(storageRoot, { recursive: true, force: true }); });
  const executable = process.platform === 'win32' ? 'adb.exe' : 'adb';
  const extensionAdb = path.join(extensionRoot, 'runtime', process.platform + '-' + process.arch, 'platform-tools', executable);
  fs.mkdirSync(path.dirname(extensionAdb), { recursive: true }); fs.writeFileSync(extensionAdb, '');
  const sdkRoot = path.join(extensionRoot, 'sdk');
  const sdkAdb = path.join(sdkRoot, 'platform-tools', executable);
  fs.mkdirSync(path.dirname(sdkAdb), { recursive: true }); fs.writeFileSync(sdkAdb, '');

  const extensionFixture = resolverFixture(t, { sdkPath: sdkRoot });
  const extension = await extensionFixture.resolve({ extensionPath: extensionRoot, globalStorageUri: { fsPath: storageRoot } });
  assert.equal(extension.source, 'extension');
  assert.equal(extension.adb, extensionAdb);

  fs.rmSync(extensionAdb);
  const sdk = await extensionFixture.resolve({ extensionPath: extensionRoot, globalStorageUri: { fsPath: storageRoot } });
  assert.equal(sdk.source, 'sdk');
  assert.equal(sdk.adb, sdkAdb);

  fs.rmSync(sdkAdb);
  const pathFixture = resolverFixture(t, { pathAdb: 'adb-from-path' });
  const fromPath = await pathFixture.resolve();
  assert.equal(fromPath.source, 'path');
  assert.equal(fromPath.adb, 'adb-from-path');

  const missingFixture = resolverFixture(t);
  await assert.rejects(missingFixture.resolve(), error => {
    assert.match(String(error), /Android platform tools are unavailable/);
    assert.match(String(error), new RegExp(process.platform + '-' + process.arch));
    return true;
  });
});
