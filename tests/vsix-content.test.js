const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const vsce = require('@vscode/vsce');
const Parse = require('unzipper/lib/parse');

// 使用真实vsce文件收集和ZIP打包器，断言Run Extension所需核心资产保留且本地工具与源码不发布。
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'android-vsix-content-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const manifest = { name: 'android-runtime-fixture', version: '1.0.0', publisher: 'fixture', engines: { vscode: '^1.95.0' }, description: 'Package content regression', main: './dist/extension.js', activationEvents: ['onStartupFinished'], license: 'MIT', repository: { type: 'git', url: 'https://github.com/microsoft/vscode-extension-samples.git' } };
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(manifest));
  fs.copyFileSync(path.join(__dirname, '../.vscodeignore'), path.join(root, '.vscodeignore'));
  const included = ['README.md', 'LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.md', 'dist/extension.js', 'dist/THIRD_PARTY_NOTICES.txt', 'dist/runtime-js-dependencies.json', 'runtime/runtime-manifest.json', 'resources/scrcpy-server.jar', 'resources/scrcpy-LICENSE.txt', 'schemas/android-ide.local.schema.json', 'media/icon.png', 'media/icons/tool.svg', 'media/logcat/main.js', 'media/logcat/fonts/OFL.txt'];
  const excluded = ['.vscode/android-ide.local.json', '.test-artifacts/private.keystore', '.agents/private.json', '.env', 'src/extension.ts', 'tests/private.test.js', 'scripts/verify-runtime.mjs', 'android-profiler/materials/private.bin', 'android-debugger/jvm/src/debugMain.js', 'dist/extension.js.map', 'media/screenshots/private.png', 'unknown-local-folder/private.txt', 'tools/win32-x64/platform-tools/adb.exe', 'android-debugger/jvm/LICENSE'];
  for (const file of included.concat(excluded)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), file === 'README.md' ? '# Package fixture' : file === 'LICENSE' ? 'MIT License - Copyright (c) fixture' : 'fixture');
  }
  return { root, included, excluded };
}

// 直接vsce package必须执行类型检查、生产构建和真实资源完整性门禁，任何失败阻止发布。
test('direct vsce package runs the production build', () => {
  const script = require('../package.json').scripts['vscode:prepublish'];
  assert.equal(script, 'npm run typecheck && node esbuild.js --production && node scripts/verify-core-runtime.cjs');
  assert.equal(script.includes('--if-present'), false);
});

// node --test tests/vsix-content.test.js实际执行当前.vscodeignore的minimatch语义，不只检查规则文本。
test('VSIX file collection includes runtime dependencies and excludes private project files', async t => {
  const f = fixture(t);
  const files = new Set(await vsce.listFiles({ cwd: f.root, packageManager: vsce.PackageManager.None }));
  for (const name of f.included) assert.ok(files.has(name), 'Missing runtime asset: ' + name);
  for (const name of f.excluded) assert.equal(files.has(name), false, 'Private/development file leaked: ' + name);
});

// 生成真实VSIX后读取ZIP目录，断言核心资源在包内且本地工具不进入包。
test('actual VSIX archive retains bundled backends tools resources and notices', async t => {
  const f = fixture(t);
  const output = path.join(f.root, 'fixture.vsix');
  await vsce.createVSIX({ cwd: f.root, packagePath: output, dependencies: false });
  const files = new Set();
  const zip = fs.createReadStream(output).pipe(Parse({ forceStream: true }));
  for await (const entry of zip) {
    files.add(entry.path);
    entry.autodrain();
  }
  assert.ok(files.has('extension.vsixmanifest'));
  // vsce按VSIX规范将根README与LICENSE转换为规范资产名称，其余运行时路径保持原样。
  for (const name of f.included) {
    const archiveName = name === 'README.md' ? 'readme.md' : name === 'LICENSE' ? 'LICENSE.txt' : name;
    assert.ok(files.has('extension/' + archiveName), 'Missing archive asset: ' + name);
  }
  for (const name of f.excluded) assert.equal(files.has('extension/' + name), false, 'Private archive file leaked: ' + name);
});

// 真实仓库 runtime 由 tools 复制而来；校验结构化清单、每文件大小/哈希及四宿主覆盖。
test('repository runtime manifest matches every shipped platform-tools file', () => {
  const root = path.resolve(__dirname, '..');
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'runtime/runtime-manifest.json'), 'utf8'));
  assert.equal(manifest.schemaVersion, 1);
  assert.deepEqual(Object.keys(manifest.hosts).sort(), ['darwin-arm64', 'darwin-x64', 'linux-x64', 'win32-x64']);
  for (const [host, info] of Object.entries(manifest.hosts)) {
    assert.ok(info.platform && info.architecture);
    const files = info.dependencies.platformTools.files;
    assert.ok(files.length >= 4);
    const runtimeDir = path.join(root, 'runtime', host, 'platform-tools');
    const actual = fs.readdirSync(runtimeDir).filter(name => fs.statSync(path.join(runtimeDir, name)).isFile()).sort();
    assert.deepEqual(files.map(entry => entry.path).sort(), actual);
    for (const entry of files) {
      const filename = path.join(runtimeDir, entry.path);
      const bytes = fs.statSync(filename).size;
      const sha256 = crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
      assert.equal(entry.bytes, bytes, host + '/' + entry.path + ' size');
      assert.equal(entry.sha256, sha256, host + '/' + entry.path + ' sha256');
      assert.equal(entry.sourcePath, 'tools/' + host + '/' + entry.path);
    }
  }
  const winFiles = manifest.hosts['win32-x64'].dependencies.platformTools.files.map(entry => entry.path);
  assert.deepEqual(winFiles.sort(), ['AdbWinApi.dll', 'AdbWinUsbApi.dll', 'NOTICE.txt', 'adb-provenance.json', 'adb.exe', 'source.properties'].sort());
});

// 对真实仓库执行 vsce 收集和 ZIP 打包，确保 runtime 进入 VSIX 且 tools 源目录不泄漏。
test('repository VSIX contains runtime assets and excludes source tools', async t => {
  const root = path.resolve(__dirname, '..');
  const files = new Set(await vsce.listFiles({ cwd: root, packageManager: vsce.PackageManager.None }));
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'runtime/runtime-manifest.json'), 'utf8'));
  for (const [host, info] of Object.entries(manifest.hosts)) {
    for (const entry of info.dependencies.platformTools.files) assert.ok(files.has('runtime/' + host + '/platform-tools/' + entry.path), 'runtime omitted: ' + host + '/' + entry.path);
  }
  assert.ok(files.has('runtime/runtime-manifest.json'));
  assert.equal([...files].some(name => name.startsWith('tools/')), false);
  const output = path.join(os.tmpdir(), 'vscode-android-tools-runtime-' + process.pid + '.vsix');
  t.after(() => fs.rmSync(output, { force: true }));
  await vsce.createVSIX({ cwd: root, packagePath: output, dependencies: false });
  const archive = new Set();
  const zip = fs.createReadStream(output).pipe(Parse({ forceStream: true }));
  for await (const entry of zip) { archive.add(entry.path); entry.autodrain(); }
  for (const [host, info] of Object.entries(manifest.hosts)) {
    for (const entry of info.dependencies.platformTools.files) assert.ok(archive.has('extension/runtime/' + host + '/platform-tools/' + entry.path), 'archive omitted: ' + host + '/' + entry.path);
  }
  assert.equal([...archive].some(name => name.startsWith('extension/tools/')), false);
  const unpacked = fs.mkdtempSync(path.join(os.tmpdir(), 'android-packaged-root-'));
  t.after(() => fs.rmSync(unpacked, { recursive: true, force: true }));
  const contents = await require('unzipper').Open.file(output);
  for (const entry of contents.files.filter(file => file.path.startsWith('extension/') && file.type === 'File')) {
    const relative = entry.path.slice('extension/'.length);
    const destination = path.join(unpacked, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    const bytes = await entry.buffer(); fs.writeFileSync(destination, bytes);
    if (relative.startsWith('runtime/') || relative.startsWith('media/') || relative.startsWith('resources/') || relative.startsWith('schemas/')) assert.deepEqual(bytes, fs.readFileSync(path.join(root, relative)), 'Development/package resource mismatch: ' + relative);
  }
  // 无源码、node_modules或SDK的临时安装根，执行真正生产bundle的激活，比较开发构建注册结果。
  const development = require('esbuild').buildSync({ entryPoints: [path.join(root, 'src/extension.ts')], bundle: true, write: false, format: 'cjs', platform: 'node', external: ['vscode'] }).outputFiles[0].text;
  const developmentState = await activateBundle(development, root);
  const productionState = await activateBundle(fs.readFileSync(path.join(unpacked, 'dist/extension.js'), 'utf8'), unpacked);
  assert.deepEqual(productionState, developmentState);
  assert.deepEqual(productionState.views, ['android-ide.logcat', 'android-ide.runningDevice']);
  for (const command of require('../package.json').contributes.commands) assert.ok(productionState.commands.includes(command.command), 'Packaged command missing: ' + command.command);
});

// 输入实际bundle文本和安装根，在宿主API边界替换VS Code但禁止访问源码相对模块；返回真实注册项。
// Node>=22执行本文件：生产/开发注册项相同，资源逐字节相同，且停用后释放控制器。
async function activateBundle(source, extensionPath) {
  const state = { commands: [], views: [], debuggers: [] };
  const disposable = () => ({ dispose() {} });
  const vscode = {
    Uri: { file: filename => ({ fsPath: filename }) },
    workspace: { isTrusted: true, workspaceFolders: [], getConfiguration: () => ({ get: (key, fallback) => fallback, inspect: () => undefined }), onDidChangeConfiguration: disposable },
    window: { createOutputChannel: () => ({ appendLine() {}, dispose() {}, show() {} }), registerWebviewViewProvider: id => { state.views.push(id); return disposable(); } },
    commands: { registerCommand: id => { state.commands.push(id); return disposable(); } },
    debug: { registerDebugAdapterDescriptorFactory: id => { state.debuggers.push(id); return disposable(); } },
  };
  const module = { exports: {} };
  new Function('module', 'exports', 'require', '__dirname', '__filename', source)(module, module.exports, id => {
    if (id === 'vscode') return vscode;
    assert.equal(id.startsWith('.'), false, 'Bundle tried to import a source module: ' + id);
    return require(id);
  }, path.join(extensionPath, 'dist'), path.join(extensionPath, 'dist/extension.js'));
  const context = { extensionPath, subscriptions: [] };
  module.exports.activate(context);
  for (const owned of context.subscriptions) await owned?.dispose?.();
  module.exports.deactivate();
  for (const entries of Object.values(state)) entries.sort();
  return state;
}

// 用户移除可选性能分析功能后，manifest/直接依赖与源/资源目录必须同步缺失；npm test发现执行，保留其余真实VSIX断言。
test('removed profiling feature has no command dependencies or runtime directories', () => {
  const root = path.resolve(__dirname, '..'), manifest = require('../package.json');
  assert.equal(manifest.contributes.commands.some(command => command.command === 'android-ide.openProfiler'), false);
  for (const name of ['csv-parse', 'protobufjs']) assert.equal(Object.hasOwn(manifest.dependencies, name), false);
  for (const name of ['src/android-profiler', 'media/android-profiler']) assert.equal(fs.existsSync(path.join(root, name)), false);
});
