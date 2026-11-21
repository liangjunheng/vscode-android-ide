const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { builtinModules, createRequire } = require('node:module');
const root = path.resolve(__dirname, '..');

/** 读取当前实际 compile 产物，隔离 VS Code 宿主但不替换打包的 debugger/npm 实现；
 * node --test tests/android-debugger-bundle.test.js 断言仅依赖Node标准库/VSCode，缺少可选sharp不影响扩展装载。 */
test('compiled extension loads without optional image binaries or unpublished dependencies', () => {
  const filename = path.join(root, 'dist/extension.js');
  assert.ok(fs.statSync(filename).size > 0, 'Run npm run compile before artifact validation');
  const external = [], channel = { appendLine() {}, dispose() {} };
  const vscode = { window: { createOutputChannel: () => channel } };
  const nodeRequire = createRequire(filename);
  const module = { exports: {} };
  const context = { module, exports: module.exports, __filename: filename, __dirname: path.dirname(filename), Buffer, process, console,
    setTimeout, clearTimeout, setInterval, clearInterval, setImmediate, clearImmediate, URL, URLSearchParams, AbortController, AbortSignal, TextEncoder, TextDecoder,
    require(id) {
      external.push(id);
      if (id === 'vscode') return vscode;
      assert.notEqual(id, 'sharp', 'Debugger activation must not load optional image binaries');
      assert.ok(builtinModules.includes(id) || id.startsWith('node:'), 'Unpublished external dependency: ' + id);
      return nodeRequire(id);
    },
  };
  context.global = context;
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), context, { filename });
  assert.equal(typeof module.exports.activate, 'function');
  assert.equal(typeof module.exports.deactivate, 'function');
  assert.ok(external.includes('vscode'));
  assert.equal(external.includes('sharp'), false);
  const notices = fs.readFileSync(path.join(root, 'dist/THIRD_PARTY_NOTICES.txt'), 'utf8');
  const originalLicense = fs.readFileSync(path.join(root, 'src/android-debugger/native-debugger/upstream/LICENSE'), 'utf8');
  assert.ok(notices.includes('## Android Native Debugger\n\n' + originalLicense), 'Native complete original license');
  assert.match(notices, /Apache License/);
  assert.doesNotMatch(notices, /Kotlin JVM Runtime Dependencies/);
  const manifest = require('../package.json');
  assert.deepEqual(manifest.contributes.debuggers.map(item => item.type).sort(), ['android-debug', 'android-tools', 'android-jvm', 'lldb'].sort());
  assert.deepEqual(manifest.extensionDependencies, ['redhat.java', 'vscjava.vscode-java-debug', 'vscjava.vscode-gradle', 'vadimcn.vscode-lldb']);
  assert.deepEqual(manifest.contributes.languages, [{ id: 'kotlin', aliases: ['Kotlin', 'kotlin'], extensions: ['.kt', '.kts'] }]);
  assert.equal(manifest.contributes.grammars, undefined);
});
