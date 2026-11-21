const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { transformSync } = require('esbuild');
const root = path.resolve(__dirname, '..');

/** 隔离构建上下文执行真实 esbuild 配置，捕获完成回调；不构建或覆盖并发构建产物。 */
function loadAndroidDebugConfigurations() {
  const module = { exports: {} };
  const source = transformSync(fs.readFileSync(path.join(root, 'src/android-debugger/index.ts'), 'utf8'), { loader: 'ts', format: 'cjs' }).code;
  vm.runInNewContext(source, { module, exports: module.exports, require(id) {
    if (id === 'vscode') return {
      workspace: { getConfiguration: () => ({ get: () => [] }) },
      window: { showQuickPick: async items => items[0] },
    };
    if (id === './autoConfig') return { omitAuto: config => ({ ...config }) };
    return require(id);
  } });
  return module.exports;
}

function buildFixture(missingLicense = false) {
  const source = fs.readFileSync(path.join(root, 'esbuild.js'), 'utf8');
  const builds = [], writes = new Map();
  const native = fs.readFileSync(path.join(root, 'src/android-debugger/native-debugger/upstream/LICENSE'), 'utf8');
  const jvm = fs.readFileSync(path.join(root, 'src/android-debugger/jvm-debugger/upstream/LICENSE'), 'utf8');
  const localRequire = createRequire(path.join(root, 'esbuild.js'));
  vm.runInNewContext(source, { process: { argv: [], cwd: () => root, exit(code) { throw new Error('exit ' + code); } }, console, require(id) {
    if (id === 'esbuild') return { build(options) { builds.push(options); return Promise.resolve(); } };
    if (id === 'node:fs') return {
      readFileSync(file) {
        assert.ok([ 'src/android-debugger/native-debugger/upstream/LICENSE', 'src/android-debugger/jvm-debugger/upstream/LICENSE', 'resources/gradle-tooling-LICENSE.txt' ].includes(file), file);
        if (missingLicense) throw new Error('license missing');
        if (file === 'resources/gradle-tooling-LICENSE.txt') return 'Gradle Tooling API license';
        return file.includes('jvm-debugger') ? jvm : native;
      },
      writeFileSync(file, content) { writes.set(file, content); },
    };
    if (id === './scripts/build-notices.cjs') return { buildBundledNotices(cwd, metas) { assert.equal(cwd, root); assert.equal(metas.length, 1); return { text: 'runtime notices', packages: [] }; } };
    return localRequire(id);
  } });
  return { builds, writes, native, jvm };
}

// 功能：compile入口在JVM构建完成后构建TS扩展，并将Native/JVM完整许可写入通知；npm test发现本文件。
test('compile builds the extension and includes both debugger licenses', () => {
  const f = buildFixture(); assert.equal(f.builds.length, 1);
  assert.ok(f.jvm.includes('Copyright (c) 2026 Parth Kansara'));
  assert.deepEqual(Array.from(f.builds[0].entryPoints), ['src/extension.ts']);
  assert.deepEqual(Array.from(f.builds[0].external), ['vscode', 'sharp']);
  let complete; f.builds[0].plugins[0].setup({ onEnd(callback) { complete = callback; } });
  complete({ errors: [], metafile: { inputs: {} } });
  assert.equal(f.writes.get(path.join('dist', 'THIRD_PARTY_NOTICES.txt')), 'runtime notices\n## Android Native Debugger\n\n' + f.native + '\n## Kotlin/Java JVM Debugger\n\n' + f.jvm + '\n## Gradle Tooling API\n\nGradle Tooling API license');
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

// 功能：清单提供android-debug六项兜底、动态入口和兼容Native/JVM类型；npm test发现本文件。
test('manifest exposes the unified Android debug fallback and real extension entry', () => {
  const p = require('../package.json');
  assert.equal(p.main, './dist/extension.js');
  assert.match(fs.readFileSync(path.join(root, 'src/extension.ts'), 'utf8'), /export function activate\(/);
  assert.ok(p.activationEvents.includes('workspaceContains:**/{build.gradle,build.gradle.kts,settings.gradle,settings.gradle.kts,gradlew,gradlew.bat,AndroidManifest.xml}'));
  assert.equal(p.activationEvents.includes('*'), false);
  assert.ok(p.activationEvents.includes('onDebugResolve:android-debug'));
  assert.ok(p.activationEvents.includes('onDebugDynamicConfigurations:android-debug'));
  assert.equal(p.contributes.viewsContainers.activitybar[0].when, 'android-ide.hasAndroidProject');
  assert.equal(p.contributes.viewsContainers.panel[0].when, 'android-ide.hasAndroidProject');
  assert.equal(p.contributes.views.androidTools[0].when, 'android-ide.hasAndroidProject');
  assert.equal(p.contributes.views.androidLogcat[0].when, 'android-ide.hasAndroidProject');
  assert.deepEqual(p.contributes.menus.commandPalette, [{ command: 'android-ide.showLogcat', when: 'android-ide.hasAndroidProject' }]);
  assert.deepEqual(p.contributes.debuggers.map(d => d.type), ['android-jvm', 'android-debug', 'android-tools', 'lldb']);
  assert.deepEqual(p.extensionDependencies, ['redhat.java', 'vscjava.vscode-java-debug', 'vscjava.vscode-gradle', 'vadimcn.vscode-lldb']);
  assert.equal(p.scripts['build:jvm'], 'node scripts/build-jvm-debugger.cjs');
  assert.equal(p.scripts['test:jvm'], 'node scripts/build-jvm-debugger.cjs --test');
  assert.equal(p.scripts.compile, 'npm run build:jvm && node esbuild.js');
  assert.equal(p.scripts.watch, 'npm run build:jvm && node esbuild.js --watch');
  assert.equal(p.scripts['vscode:prepublish'], 'npm run typecheck && npm run build:jvm && node esbuild.js --production && node scripts/verify-core-runtime.cjs');
  const jvm = p.contributes.debuggers[0];
  assert.deepEqual(jvm.configurationSnippets, []);
  assert.equal(jvm.initialConfigurations, undefined);
  const parent = p.contributes.debuggers.find(debuggerContribution => debuggerContribution.type === 'android-debug');
  const names = [
    'Android: Android Native Debug Launch', 'Android: Android Native Debug Attach',
    'Android: Android JVM Debug Launch', 'Android: Android JVM Debug Attach',
    'Android: Android Dual(Native and JVM) Debug Launch', 'Android: Android Dual(Native and JVM) Debug Attach',
  ];
  assert.deepEqual(parent.initialConfigurations.map(config => config.name), names);
  assert.deepEqual(parent.configurationSnippets.map(snippet => snippet.label), names);
  const runtime = loadAndroidDebugConfigurations();
  assert.deepEqual(JSON.parse(JSON.stringify(runtime.getAndroidDebugConfigurations().map(config => [config.name, config.mode, config.request]))), parent.initialConfigurations.map(config => [config.name, config.mode, config.request]));
  assert.deepEqual(JSON.parse(JSON.stringify(runtime.getAndroidDebugConfigurations())), parent.initialConfigurations);
  assert.deepEqual(JSON.parse(JSON.stringify(runtime.getAndroidDebugConfigurations().map(config => config.type))), parent.initialConfigurations.map(config => config.type));
  assert.equal(runtime.findAndroidDebugConfiguration().name, names[0]);
  assert.equal(runtime.findAndroidDebugConfiguration(undefined, true).name, names[0]);
  assert.ok(parent.variables.abi === 'android-tools.getBestAbi');
  assert.ok(parent.variables.mappedAbi === 'android-tools.getBestMappedAbi');
  assert.ok(parent.variables.pickAndroidProcess === 'android-tools.pickAndroidProcess');
  const legacyNative = p.contributes.debuggers.find(debuggerContribution => debuggerContribution.type === 'android-tools');
  assert.equal(legacyNative.initialConfigurations, undefined); assert.equal(legacyNative.configurationSnippets, undefined);
  for (const request of ['attach', 'launch']) {
    const properties = parent.configurationAttributes[request].properties;
    assert.deepEqual(properties.mode.enum, ['native', 'java', 'dual']);
    for (const field of ['sdkRoot', 'ndkRoot', 'abiSupported', 'abi', 'abiMap', 'symbolSearchPaths']) assert.ok(properties.native.properties[field]);
    assert.ok(properties.java.properties.type); assert.equal(properties.java.properties.type.const, 'android-jvm');
    for (const field of ['name', 'sourcePaths', 'projectRoot', 'hostName', 'port']) assert.ok(properties.java.properties[field]);
    assert.ok(properties.projectRoot);
    assert.ok(properties.sourcePaths);
    assert.ok(properties.resumeProcess);
  }
  const expectedModes = ['native', 'native', 'java', 'java', 'dual', 'dual'];
  const expectedRequests = ['launch', 'attach', 'launch', 'attach', 'launch', 'attach'];
  const expectedBodyNames = ['Native Debug Launch', 'Native Debug Attach', 'JVM Debug Launch', 'JVM Debug Attach', 'Dual Debug Launch', 'Dual Debug Attach'];
  parent.configurationSnippets.forEach((snippet, index) => {
    const body = snippet.body;
    assert.equal(body.type, 'android-debug'); assert.equal(body.mode, expectedModes[index]); assert.equal(body.request, expectedRequests[index]);
    assert.equal(body.name, expectedBodyNames[index]);
    assert.equal(body.target, 'select'); assert.ok(body.name); assert.equal(body.name.startsWith('Android:'), false);
    if (body.mode === 'native' || body.mode === 'dual') {
      assert.ok(body.native); assert.ok(body.native.abi.includes('select')); assert.ok(body.native.symbolSearchPaths?.length);
    }
    if (body.mode === 'java' || body.mode === 'dual') {
      assert.deepEqual(body.java.type, 'android-jvm'); assert.ok(body.java.name); assert.ok(body.java.sourcePaths?.length);
      assert.equal(body.java.port, undefined); assert.equal(body.java.hostName, undefined); assert.equal(body.java.preLaunchTask, undefined); assert.deepEqual(body.java.adapterJvmArgs, []);
    }
    if (body.request === 'launch') {
      assert.ok(body.apkPath); assert.ok(body.packageName); assert.ok(body.launchActivity);
    } else {
      assert.equal(body.apkPath, undefined); assert.equal(body.launchActivity, undefined);
      assert.equal(body.processId, '^"\\${command:android-tools.pickAndroidProcess}"');
    }
  });
  const snippetText = JSON.stringify(parent.configurationSnippets);
  assert.match(snippetText, /\$\{\d+:app\}/); assert.ok(snippetText.includes('com.example.app'));
  for (const snippet of parent.configurationSnippets) {
    for (const value of [snippet.body.apkPath, ...(snippet.body.native?.symbolSearchPaths ?? []), ...(snippet.body.java?.sourcePaths ?? [])].filter(Boolean)) {
      assert.ok(value.startsWith('^"\\${workspaceFolder}/'), value);
      assert.equal(/\$\{\d+:\^/.test(value), false, value);
    }
  }
  assert.deepEqual(p.contributes.languages, [{ id: 'kotlin', aliases: ['Kotlin', 'kotlin'], extensions: ['.kt', '.kts'] }]);
  const launch = JSON.parse(fs.readFileSync(path.join(root, '.vscode/launch.json'), 'utf8'));
  assert.equal(launch.configurations[0].preLaunchTask, 'npm: compile'); assert.equal(p.scripts.compile, 'npm run build:jvm && node esbuild.js');
  assert.equal(fs.readFileSync(path.join(root, '.vscodeignore'), 'utf8').includes('kotlin-debug-adapter.jar'), false);
});

/** Git按现有opaque-payload规则保留锁定源码和许可证字节，不使用工作区换行伪装提交成功。 */
test('Git attributes preserve upstream source and supplemental license bytes', () => {
  const {execFileSync}=require('node:child_process');
  const paths=['resources/licenses/WTFPL-2.0/legalcode.txt','src/android-debugger/native-debugger/upstream/source/src/android.ts','src/android-debugger/native-debugger/upstream/LICENSE'];
  const output=execFileSync('git',['check-attr','text','--',...paths],{cwd:root,encoding:'utf8'});
  for(const file of paths) assert.ok(output.includes(file+': text: unset'),file);
});
