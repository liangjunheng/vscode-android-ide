const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vsce = require('@vscode/vsce');
const unzipper = require('unzipper');

const companions = ['redhat.java', 'vscjava.vscode-java-debug', 'vscjava.vscode-gradle'];

// 功能：安装扩展时由VS Code原生扩展包机制安装配套项，不让设备功能依赖其激活。
// 回归：Node>=22执行node --test tests/extension-pack.test.js，精确断言清单及实际VSIX中的扩展包属性。
test('development companions auto-install without hard activation dependencies', () => {
  const manifest = require('../package.json');
  assert.deepEqual(manifest.extensionPack, companions);
  assert.equal(new Set(manifest.extensionPack).size, companions.length);
  assert.deepEqual(manifest.extensionDependencies ?? [], []);
  assert.equal(manifest.extensionPack.includes(manifest.publisher + '.' + manifest.name), false);
});

// 功能：真实vsce生成的VSIX必须保留扩展包元数据；不访问Marketplace，也不安装用户扩展。
test('VSIX preserves companion installation metadata', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'android-extension-pack-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const manifest = require('../package.json');
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
    name: 'android-companion-fixture', version: '1.0.0', publisher: 'fixture',
    engines: manifest.engines, description: 'Companion metadata regression',
    license: 'MIT', repository: manifest.repository, extensionPack: manifest.extensionPack,
  }));
  fs.writeFileSync(path.join(root, 'README.md'), '# Companion fixture');
  fs.writeFileSync(path.join(root, 'LICENSE'), 'MIT License');
  const output = path.join(root, 'fixture.vsix');
  await vsce.createVSIX({ cwd: root, packagePath: output, dependencies: false });
  const archive = await unzipper.Open.file(output);
  const packaged = JSON.parse((await archive.files.find(entry => entry.path === 'extension/package.json').buffer()).toString());
  assert.deepEqual(packaged.extensionPack, companions);
  const xml = (await archive.files.find(entry => entry.path === 'extension.vsixmanifest').buffer()).toString();
  assert.match(xml, /Microsoft.VisualStudio.Code.ExtensionPack/);
  for (const id of companions) assert.ok(xml.includes(id), 'Missing companion in VSIX metadata: ' + id);
});
