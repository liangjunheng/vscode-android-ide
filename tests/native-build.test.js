const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const root = path.resolve(__dirname, '..');

/** 隔离构建上下文执行真实 esbuild 配置，捕获完成回调；不构建或覆盖并发构建产物。 */
function buildFixture(missingLicense = false) {
  const source = fs.readFileSync(path.join(root, 'esbuild.js'), 'utf8');
  const builds = [], writes = new Map();
  const native = fs.readFileSync(path.join(root, 'src/android-debugger/native-debugger/upstream/LICENSE'), 'utf8');
  const localRequire = createRequire(path.join(root, 'esbuild.js'));
  vm.runInNewContext(source, { process: { argv: [], cwd: () => root, exit(code) { throw new Error('exit ' + code); } }, console, require(id) {
    if (id === 'esbuild') return { build(options) { builds.push(options); return Promise.resolve(); } };
    if (id === 'node:fs') return {
      readFileSync(file) { assert.equal(file, 'src/android-debugger/native-debugger/upstream/LICENSE'); if (missingLicense) throw new Error('license missing'); return native; },
      writeFileSync(file, content) { writes.set(file, content); },
    };
    if (id === './scripts/build-notices.cjs') return { buildBundledNotices(cwd, metas) { assert.equal(cwd, root); assert.equal(metas.length, 1); return { text: 'runtime notices', packages: [] }; } };
    return localRequire(id);
  } });
  return { builds, writes, native };
}

// 功能：compile入口仅构建TS扩展，绝不启动Maven或读取JVM源；npm test发现本文件。
test('Native compile builds only the extension and includes full upstream license', () => {
  const f = buildFixture(); assert.equal(f.builds.length, 1);
  assert.deepEqual(Array.from(f.builds[0].entryPoints), ['src/extension.ts']);
  assert.deepEqual(Array.from(f.builds[0].external), ['vscode', 'sharp']);
  let complete; f.builds[0].plugins[0].setup({ onEnd(callback) { complete = callback; } });
  complete({ errors: [], metafile: { inputs: {} } });
  assert.equal(f.writes.get(path.join('dist', 'THIRD_PARTY_NOTICES.txt')), 'runtime notices\n## Android Native Debugger\n\n' + f.native);
  assert.deepEqual(JSON.parse(f.writes.get(path.join('dist', 'runtime-js-dependencies.json'))), { schemaVersion: 1, packages: [] });
});

// 功能：构建失败/缺少metadata/许可必须阻断发布，不静默产出伪成功通知。
test('Native notices preserve strict build and missing license failures', () => {
  for (const missing of [false, true]) {
    const f = buildFixture(missing); let complete;
    f.builds[0].plugins[0].setup({ onEnd(callback) { complete = callback; } });
    complete({ errors: [new Error('bundle failed')] }); assert.equal(f.writes.size, 0);
    assert.throws(() => complete({ errors: [] }), /Missing runtime dependency/);
    if (missing) assert.throws(() => complete({ errors: [], metafile: {} }), /license missing/);
  }
});

// 功能：清单只声明已接入后端，扩展开发预启动仍使用compile且无JAR要求。
test('Native manifest and F5 configuration do not require a JVM adapter', () => {
  const p = require('../package.json');
  assert.deepEqual(p.contributes.debuggers.map(d => d.type), ['android-tools', 'lldb']);
  assert.deepEqual(p.extensionDependencies, ['vadimcn.vscode-lldb']);
  const parent = p.contributes.debuggers[0];
  const initial = parent.initialConfigurations[0];
  assert.equal(initial.name, '[内置] Android Native'); assert.equal(initial.request, 'launch'); assert.equal(initial.androidMode, 'native'); assert.equal(initial.mode, 'native'); assert.equal(initial.target, 'select'); assert.deepEqual(initial.native, {});
  const snippet = parent.configurationSnippets[0];
  assert.equal(snippet.label, '[内置] Android Native'); assert.equal(snippet.body.type, 'android-tools'); assert.equal(snippet.body.request, 'launch'); assert.equal(snippet.body.androidMode, 'native'); assert.equal(snippet.body.mode, 'native'); assert.equal(snippet.body.target, 'select'); assert.deepEqual(snippet.body.native, {});
  for (const entry of Object.values(parent.configurationAttributes)) {
    assert.deepEqual(entry.properties.androidMode.enum, ['native']);
    assert.equal(entry.properties.java, undefined); assert.equal(entry.properties.kotlin, undefined);
    assert.ok(entry.properties.native.properties.symbolSearchPaths);
  }
  assert.equal(p.contributes.languages, undefined); assert.equal(p.contributes.grammars, undefined);
  const launch = JSON.parse(fs.readFileSync(path.join(root, '.vscode/launch.json'), 'utf8'));
  assert.equal(launch.configurations[0].preLaunchTask, 'npm: compile'); assert.equal(p.scripts.compile, 'node esbuild.js');
  assert.equal(fs.readFileSync(path.join(root, '.vscodeignore'), 'utf8').includes('kotlin-debug-adapter.jar'), false);
});

/** Git按现有opaque-payload规则保留锁定源码和许可证字节，不使用工作区换行伪装提交成功。 */
test('Git attributes preserve upstream source and supplemental license bytes', () => {
  const {execFileSync}=require('node:child_process');
  const paths=['resources/licenses/WTFPL-2.0/legalcode.txt','src/android-debugger/native-debugger/upstream/source/src/android.ts','src/android-debugger/native-debugger/upstream/LICENSE'];
  const output=execFileSync('git',['check-attr','text','--',...paths],{cwd:root,encoding:'utf8'});
  for(const file of paths) assert.ok(output.includes(file+': text: unset'),file);
});
