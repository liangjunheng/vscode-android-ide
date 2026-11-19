const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vsce = require('@vscode/vsce');
const unzipper = require('unzipper');

const mandatoryDependencies = ['redhat.java', 'vscjava.vscode-java-debug', 'vscjava.vscode-gradle', 'vadimcn.vscode-lldb'];

// 功能：输入当前清单，断言 Java、Gradle 和 Native 调试后端均通过运行依赖强制安装。
// 回归：Node>=22执行 node --test tests/extension-pack.test.js；npm test 同样发现本文件，下方 VSIX 用例核对打包后的依赖属性。
test('all companion extensions are mandatory runtime dependencies', () => {
  const manifest = require('../package.json');
  assert.equal(manifest.extensionPack, undefined);
  assert.deepEqual(manifest.extensionDependencies, mandatoryDependencies);
  assert.equal(new Set(manifest.extensionDependencies).size, mandatoryDependencies.length);
  assert.equal(manifest.extensionDependencies.includes(manifest.publisher + '.' + manifest.name), false);
});

// 功能：输入真实清单中的安装声明并用 vsce 生成隔离 VSIX；严格核对 JSON/XML 中的扩展包和运行依赖，不访问市场或修改用户扩展。
test('VSIX preserves companion installation metadata', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'android-extension-pack-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const manifest = require('../package.json');
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
    name: 'android-companion-fixture', version: '1.0.0', publisher: 'fixture',
    engines: manifest.engines, description: 'Companion metadata regression',
    license: 'MIT', repository: manifest.repository,
    extensionDependencies: manifest.extensionDependencies,
  }));
  fs.writeFileSync(path.join(root, 'README.md'), '# Companion fixture');
  fs.writeFileSync(path.join(root, 'LICENSE'), 'MIT License');
  const output = path.join(root, 'fixture.vsix');
  await vsce.createVSIX({ cwd: root, packagePath: output, dependencies: false });
  const archive = await unzipper.Open.file(output);
  const packaged = JSON.parse((await archive.files.find(entry => entry.path === 'extension/package.json').buffer()).toString());
  assert.equal(packaged.extensionPack, undefined);
  assert.deepEqual(packaged.extensionDependencies, mandatoryDependencies);
  const xml = (await archive.files.find(entry => entry.path === 'extension.vsixmanifest').buffer()).toString();
  const { DOMParser } = require('@xmldom/xmldom');
  const document = new DOMParser().parseFromString(xml, 'application/xml');
  const properties = new Map(Array.from(document.getElementsByTagName('Property'), element => [element.getAttribute('Id'), element.getAttribute('Value')]));
  assert.equal(properties.get('Microsoft.VisualStudio.Code.ExtensionPack'), '');
  assert.equal(properties.get('Microsoft.VisualStudio.Code.ExtensionDependencies'), mandatoryDependencies.join(','));
});
