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
  const included = ['README.md', 'LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.md', 'dist/extension.js', 'dist/THIRD_PARTY_NOTICES.txt', 'dist/runtime-js-dependencies.json', 'resources/platform-tools/runtime-manifest.json', 'resources/platform-tools/adb-runtime-provenance.json', 'resources/scrcpy/scrcpy-server.jar', 'resources/scrcpy/scrcpy-LICENSE.txt', 'resources/jvm-debugger/kotlin-debug-adapter.jar', 'resources/jvm-debugger/android-debug-coordinator.jar', 'resources/gradle-tooling-server.jar', 'resources/gradle-tooling-LICENSE.txt', 'resources/jvm-debugger/LICENSE', 'resources/jvm-debugger/coordinator-LICENSE.txt', 'resources/jvm-debugger/coordinator-NOTICE.txt', 'resources/jvm-debugger/coordinator-LICENSE-sources.json', 'schemas/android-ide.local.schema.json', 'media/icon.png', 'media/icons/tool.svg', 'media/logcat/main.js', 'media/logcat/fonts/OFL.txt'];
  const excluded = ['.vscode/android-ide.local.json', '.test-artifacts/private.keystore', '.agents/private.json', '.env', 'src/extension.ts', 'tests/private.test.js', 'scripts/verify-runtime.mjs', 'android-profiler/materials/private.bin', 'android-debugger/native-debugger/upstream/src/debugMain.js', 'dist/extension.js.map', 'dist/kotlin-language-configuration.json', 'dist/kotlin.tmLanguage.json', 'dist/kotlin-debug-adapter.jar', 'media/screenshots/private.png', 'unknown-local-folder/private.txt', 'resources/lldb/win32-x64/bin/lldb-dap.exe', 'resources/lldb/win32-x64/bin/liblldb.dll', 'runtime/win32-x64/platform-tools/adb.exe', 'android-debugger/jvm/LICENSE', 'android-debugger/jvm/adapter.js'];
  for (const file of included.concat(excluded)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), file === 'README.md' ? '# Package fixture' : file === 'LICENSE' ? 'MIT License - Copyright (c) fixture' : 'fixture');
  }
  return { root, included, excluded };
}

// 直接vsce package必须执行类型检查、生产构建和真实资源完整性门禁，任何失败阻止发布。
test('direct vsce package runs the production build', () => {
  const script = require('../package.json').scripts['vscode:prepublish'];
  assert.equal(script, 'npm run typecheck && npm run build:jvm && node esbuild.js --production && node scripts/verify-core-runtime.cjs');
  assert.equal(script.includes('--if-present'), false);
});

// node --test tests/vsix-content.test.js实际执行当前.vscodeignore的minimatch语义，不只检查规则文本。
test('VSIX file collection includes runtime dependencies and excludes private project files', async t => {
  const f = fixture(t);
  const files = new Set(await vsce.listFiles({ cwd: f.root, packageManager: vsce.PackageManager.None }));
  for (const name of f.included) assert.ok(files.has(name), 'Missing runtime asset: ' + name);
  for (const name of f.excluded) assert.equal(files.has(name), false, 'Private/development file leaked: ' + name);
});

/**
 * 功能点：真实 VSIX 保留独立 coordinator LICENSE/NOTICE，不与上游适配器许可混合。
 * 受影响对象：.vscodeignore、fixture、vsce 打包器和独立许可资源。
 * 复现路径：Node>=22，在隔离 fixture 创建不同许可字节，再生成并读取真实 VSIX。
 * 测试范围：运行时资产存在、私有文件排除、原上游许可与 coordinator 两份独立原字节。
 * 执行入口：node --test tests/vsix-content.test.js。
 * 预期结果：三个许可入口及来源清单均在包中且逐字节一致。
 * 判据：归档存在性与原文比较全部通过；不使用构建、Java 或设备。
 */
test('actual VSIX archive retains bundled backends tools resources and notices', async t => {
  const f = fixture(t);
  const legalPaths = ['resources/jvm-debugger/LICENSE', 'resources/jvm-debugger/coordinator-LICENSE.txt', 'resources/jvm-debugger/coordinator-NOTICE.txt', 'resources/jvm-debugger/coordinator-LICENSE-sources.json'];
  for (const name of legalPaths) fs.writeFileSync(path.join(f.root, name), Buffer.from(`${name}\r\n独立许可原文\r\n`));
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
  const contents = await require('unzipper').Open.file(output);
  for (const name of legalPaths) {
    const entry = contents.files.find(file => file.path === 'extension/' + name);
    assert.ok(entry, '独立许可资源未进入 VSIX：' + name);
    assert.deepEqual(await entry.buffer(), fs.readFileSync(path.join(f.root, name)), '许可原字节改变：' + name);
  }
});

// 真实仓库 runtime 由 tools 复制而来；校验结构化清单、每文件大小/哈希及四宿主覆盖。
test('repository runtime manifest matches every shipped platform-tools file', () => {
  const root = path.resolve(__dirname, '..');
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'resources/platform-tools/runtime-manifest.json'), 'utf8'));
  assert.equal(manifest.schemaVersion, 1);
  assert.deepEqual(Object.keys(manifest.hosts).sort(), ['darwin-arm64', 'darwin-x64', 'linux-x64', 'win32-x64']);
  for (const [host, info] of Object.entries(manifest.hosts)) {
    assert.ok(info.platform && info.architecture);
    const files = info.dependencies.platformTools.files;
    assert.ok(files.length >= 4);
    const runtimeDir = path.join(root, 'resources', 'platform-tools', host);
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
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'resources/platform-tools/runtime-manifest.json'), 'utf8'));
  for (const [host, info] of Object.entries(manifest.hosts)) {
    for (const entry of info.dependencies.platformTools.files) assert.ok(files.has('resources/platform-tools/' + host + '/' + entry.path), 'runtime omitted: ' + host + '/' + entry.path);
  }
  assert.ok(files.has('resources/platform-tools/runtime-manifest.json'));
  assert.ok(files.has('resources/platform-tools/adb-runtime-provenance.json'));
  assert.ok(files.has('resources/jvm-debugger/kotlin-debug-adapter.jar'));
  assert.ok(files.has('resources/jvm-debugger/android-debug-coordinator.jar'));
  assert.ok(files.has('resources/gradle-tooling-server.jar'));
  assert.ok(files.has('resources/gradle-tooling-LICENSE.txt'));
  assert.match(fs.readFileSync(path.join(root, 'resources/gradle-tooling-LICENSE.txt'), 'utf8'), /Gradle Tooling API 9\.8\.1/);
  assert.ok(fs.existsSync(path.join(root, 'resources/jvm-debugger/LICENSE')));
  assert.ok(files.has('resources/jvm-debugger/LICENSE'));
  for (const name of ['coordinator-LICENSE.txt', 'coordinator-NOTICE.txt', 'coordinator-LICENSE-sources.json']) {
    const relative = 'resources/jvm-debugger/' + name;
    assert.ok(files.has(relative), '缺失 coordinator 独立许可：' + name);
    assert.ok(fs.statSync(path.join(root, relative)).size > 0, 'coordinator 独立许可为空：' + name);
  }
  assert.deepEqual(fs.readFileSync(path.join(root, 'resources/jvm-debugger/LICENSE')), fs.readFileSync(path.join(root, 'src/android-debugger/jvm-debugger/upstream/LICENSE')));
  assert.equal([...files].some(name => name.startsWith('runtime/')), false);
  assert.equal(files.has('resources/scrcpy-server.jar'), false);
  assert.equal(files.has('resources/scrcpy-LICENSE.txt'), false);
  for (const legacy of ['dist/kotlin-language-configuration.json', 'dist/kotlin.tmLanguage.json', 'dist/kotlin-debug-adapter.jar', 'android-debugger/jvm/adapter.js']) assert.equal(files.has(legacy), false, 'Legacy JVM asset leaked: ' + legacy);
  const output = path.join(os.tmpdir(), 'vscode-android-tools-runtime-' + process.pid + '.vsix');
  t.after(() => fs.rmSync(output, { force: true }));
  await vsce.createVSIX({ cwd: root, packagePath: output, dependencies: false });
  const archive = new Set();
  const zip = fs.createReadStream(output).pipe(Parse({ forceStream: true }));
  for await (const entry of zip) { archive.add(entry.path); entry.autodrain(); }
  for (const [host, info] of Object.entries(manifest.hosts)) {
    for (const entry of info.dependencies.platformTools.files) assert.ok(archive.has('extension/resources/platform-tools/' + host + '/' + entry.path), 'archive omitted: ' + host + '/' + entry.path);
  }
  for (const name of ['LICENSE', 'coordinator-LICENSE.txt', 'coordinator-NOTICE.txt', 'coordinator-LICENSE-sources.json']) assert.ok(archive.has('extension/resources/jvm-debugger/' + name), 'VSIX 缺失独立许可：' + name);
  assert.equal([...archive].some(name => name.startsWith('extension/runtime/')), false);
  for (const legacy of ['dist/kotlin-language-configuration.json', 'dist/kotlin.tmLanguage.json', 'dist/kotlin-debug-adapter.jar', 'android-debugger/jvm/adapter.js']) assert.equal(archive.has('extension/' + legacy), false, 'Legacy JVM archive leaked: ' + legacy);
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
  const development = require('esbuild').buildSync({ entryPoints: [path.join(root, 'src/extension.ts')], bundle: true, write: false, format: 'cjs', platform: 'node', external: ['vscode', 'sharp'] }).outputFiles[0].text;
  const developmentState = await activateBundle(development, root);
  const productionState = await activateBundle(fs.readFileSync(path.join(unpacked, 'dist/extension.js'), 'utf8'), unpacked);
  assert.deepEqual(productionState, developmentState);
  assert.deepEqual(productionState.views, ['android-ide.logcat', 'android-ide.runningDevice']);
  for (const command of require('../package.json').contributes.commands) assert.ok(productionState.commands.includes(command.command), 'Packaged command missing: ' + command.command);
});

// 输入实际bundle文本和安装根，在宿主API边界替换VS Code但禁止访问源码相对模块；返回真实注册项。
// Node>=22执行本文件：生产/开发注册项相同，资源逐字节相同，且停用后释放控制器。
async function activateBundle(source, extensionPath) {
  const state = { commands: [], views: [], debuggers: [], providers: [], dynamicNames: [], contexts: [] };
  const factories = new Map();
  const disposable = () => ({ dispose() {} });
  const vscode = {
    Uri: { file: filename => ({ fsPath: filename }) },
    workspace: {
      isTrusted: true,
      workspaceFolders: [],
      findFiles: async () => [],
      getConfiguration: () => ({ get: (key, fallback) => fallback, inspect: () => undefined }),
      onDidChangeConfiguration: disposable,
      onDidCreateFiles: disposable,
      onDidDeleteFiles: disposable,
      onDidRenameFiles: disposable,
      onDidChangeWorkspaceFolders: disposable,
    },
    window: { createOutputChannel: () => ({ appendLine() {}, dispose() {}, show() {} }), registerWebviewViewProvider: id => { state.views.push(id); return disposable(); }, showErrorMessage: async () => undefined },
    commands: {
      registerCommand: id => { state.commands.push(id); return disposable(); },
      executeCommand: async (id, ...args) => { if (id === 'setContext') state.contexts.push(args); },
    },

    DebugAdapterInlineImplementation: class { constructor(implementation) { this.implementation = implementation; } },
    DebugConfigurationProviderTriggerKind: {Initial:1,Dynamic:2},
    debug: {
      registerDebugAdapterDescriptorFactory: (id, factory) => { state.debuggers.push(id); factories.set(id, factory); return disposable(); },
      registerDebugConfigurationProvider: (id,provider,trigger) => { state.providers.push(id); if(trigger===2) { assert.equal(typeof provider.resolveDebugConfiguration,'function'); state.dynamicNames.push(...provider.provideDebugConfigurations().map(config=>config.name)); } return disposable(); },
      registerDebugAdapterTrackerFactory: (id, tracker) => { assert.equal(id, 'android-jvm'); assert.equal(typeof tracker.createDebugAdapterTracker, 'function'); return disposable(); },
      onDidStartDebugSession: disposable,
      onDidTerminateDebugSession: disposable,
    },
  };
  const module = { exports: {} };
  new Function('module', 'exports', 'require', '__dirname', '__filename', source)(module, module.exports, id => {
    if (id === 'vscode') return vscode;
    assert.notEqual(id, 'sharp', 'Activation must not load optional image binaries');
    assert.equal(id.startsWith('.'), false, 'Bundle tried to import a source module: ' + id);
    return require(id);
  }, path.join(extensionPath, 'dist'), path.join(extensionPath, 'dist/extension.js'));
  const context = { extensionPath, subscriptions: [] };
  module.exports.activate(context);
  // 通过真实 Native 描述符等待异步注册结算，再释放父适配器；不创建后端进程或连接设备。
  const descriptor = await factories.get('android-tools').createDebugAdapterDescriptor({ id: 'packaged-activation-check', configuration: {} });
  await descriptor.implementation.dispose();
  assert.deepEqual(state.debuggers.sort(), ['android-debug', 'android-jvm', 'android-tools']);
  assert.deepEqual(state.providers.sort(), ['android-debug', 'android-debug', 'android-jvm', 'android-jvm', 'android-tools', 'lldb']);
  assert.deepEqual(state.contexts, [['android-ide.hasAndroidProject', false]]);
  assert.deepEqual(state.dynamicNames.sort(), [
    'Android: Native Debug Launch', 'Android: Native Debug Attach',
    'Android: JVM Debug Launch', 'Android: JVM Debug Attach',
    'Android: Dual(Native and JVM) Debug Launch', 'Android: Dual(Native and JVM) Debug Attach',
  ].sort());
  for (const owned of context.subscriptions) await owned?.dispose?.();
  await module.exports.deactivate();
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
