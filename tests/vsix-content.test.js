const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vsce = require('@vscode/vsce');
const Parse = require('unzipper/lib/parse');

// 使用真实vsce文件收集和ZIP打包器，断言Run Extension所需核心资产保留且本地工具与源码不发布。
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'android-vsix-content-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const manifest = { name: 'android-runtime-fixture', version: '1.0.0', publisher: 'fixture', engines: { vscode: '^1.95.0' }, description: 'Package content regression', main: './dist/extension.js', activationEvents: ['onStartupFinished'], license: 'MIT', repository: { type: 'git', url: 'https://github.com/microsoft/vscode-extension-samples.git' } };
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(manifest));
  fs.copyFileSync(path.join(__dirname, '../.vscodeignore'), path.join(root, '.vscodeignore'));
  const included = ['README.md', 'LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.md', 'dist/extension.js', 'dist/THIRD_PARTY_NOTICES.txt', 'dist/runtime-js-dependencies.json', 'resources/scrcpy-server.jar', 'resources/scrcpy-LICENSE.txt', 'schemas/android-ide.local.schema.json', 'media/icon.png', 'media/icons/tool.svg', 'media/logcat/main.js', 'media/logcat/fonts/OFL.txt'];
  const excluded = ['.vscode/android-ide.local.json', '.test-artifacts/private.keystore', '.agents/private.json', '.env', 'src/extension.ts', 'tests/private.test.js', 'scripts/verify-runtime.mjs', 'android-profiler/materials/private.bin', 'android-debugger/jvm/src/debugMain.js', 'dist/extension.js.map', 'media/screenshots/private.png', 'unknown-local-folder/private.txt', 'tools/win32-x64/platform-tools/adb.exe', 'runtime/runtime-manifest.json', 'android-debugger/jvm/LICENSE'];
  for (const file of included.concat(excluded)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), file === 'README.md' ? '# Package fixture' : file === 'LICENSE' ? 'MIT License - Copyright (c) fixture' : 'fixture');
  }
  return { root, included, excluded };
}

// 直接vsce package必须执行类型检查和生产构建；本地运行时资产由独立校验脚本按需验证。
test('direct vsce package runs the production build', () => {
  const script = require('../package.json').scripts['vscode:prepublish'];
  assert.equal(script, 'npm run typecheck && node esbuild.js --production');
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

// 用户移除可选性能分析功能后，manifest/直接依赖与源/资源目录必须同步缺失；npm test发现执行，保留其余真实VSIX断言。
test('removed profiling feature has no command dependencies or runtime directories', () => {
  const root = path.resolve(__dirname, '..'), manifest = require('../package.json');
  assert.equal(manifest.contributes.commands.some(command => command.command === 'android-ide.openProfiler'), false);
  for (const name of ['csv-parse', 'protobufjs']) assert.equal(Object.hasOwn(manifest.dependencies, name), false);
  for (const name of ['src/android-profiler', 'media/android-profiler']) assert.equal(fs.existsSync(path.join(root, name)), false);
});
