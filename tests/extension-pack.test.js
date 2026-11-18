const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vsce = require('@vscode/vsce');
const unzipper = require('unzipper');

const companions = ['redhat.java', 'vscjava.vscode-java-debug', 'vscjava.vscode-gradle'];
const nativeDependencies = ['vadimcn.vscode-lldb'];

// 功能：输入当前清单，断言 Java/Gradle 按扩展包安装，Native 后端 CodeLLDB 按运行依赖安装并参与激活约束。
// 回归：Node>=22执行 node --test tests/extension-pack.test.js；npm test 同样发现本文件，下方 VSIX 用例核对打包后的两类属性。
test('Java companions remain a pack while CodeLLDB is a required runtime dependency', () => {
  const manifest = require('../package.json');
  assert.deepEqual(manifest.extensionPack, companions);
  assert.equal(new Set(manifest.extensionPack).size, companions.length);
  assert.deepEqual(manifest.extensionDependencies, nativeDependencies);
  assert.equal(new Set(manifest.extensionDependencies).size, nativeDependencies.length);
  assert.equal(manifest.extensionPack.includes('vadimcn.vscode-lldb'), false);
  assert.equal(manifest.extensionPack.includes(manifest.publisher + '.' + manifest.name), false);
});

// 功能：输入真实清单中的安装声明并用 vsce 生成隔离 VSIX；严格核对 JSON/XML 中的扩展包和运行依赖，不访问市场或修改用户扩展。
test('VSIX preserves companion installation metadata', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'android-extension-pack-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const manifest = require('../package.json');
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
    name: 'android-companion-fixture', version: '1.0.0', publisher: 'fixture',
    engines: manifest.engines, description: 'Companion metadata regression',
    license: 'MIT', repository: manifest.repository, extensionPack: manifest.extensionPack,
    extensionDependencies: manifest.extensionDependencies,
  }));
  fs.writeFileSync(path.join(root, 'README.md'), '# Companion fixture');
  fs.writeFileSync(path.join(root, 'LICENSE'), 'MIT License');
  const output = path.join(root, 'fixture.vsix');
  await vsce.createVSIX({ cwd: root, packagePath: output, dependencies: false });
  const archive = await unzipper.Open.file(output);
  const packaged = JSON.parse((await archive.files.find(entry => entry.path === 'extension/package.json').buffer()).toString());
  assert.deepEqual(packaged.extensionPack, companions);
  assert.deepEqual(packaged.extensionDependencies, nativeDependencies);
  const xml = (await archive.files.find(entry => entry.path === 'extension.vsixmanifest').buffer()).toString();
  const { DOMParser } = require('@xmldom/xmldom');
  const document = new DOMParser().parseFromString(xml, 'application/xml');
  const properties = new Map(Array.from(document.getElementsByTagName('Property'), element => [element.getAttribute('Id'), element.getAttribute('Value')]));
  assert.equal(properties.get('Microsoft.VisualStudio.Code.ExtensionPack'), companions.join(','));
  assert.equal(properties.get('Microsoft.VisualStudio.Code.ExtensionDependencies'), nativeDependencies.join(','));
});
