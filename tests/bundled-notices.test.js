const assert = require('node:assert/strict'); const crypto = require('node:crypto'); const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path'); const test = require('node:test'); const { buildBundledNotices } = require('../scripts/build-notices.cjs');
function fixture() { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bundled-notices-')); const nm = path.join(root, 'node_modules'); fs.mkdirSync(nm, { recursive: true }); return { root, nm }; }
function addPackage(nm, relative, metadata, files) { const dir = path.join(nm, relative); fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(metadata)); for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), body); return dir; }
function input(root, relative) { return path.join(root, 'node_modules', relative, 'index.js'); }
/** 输入合成的作用域/嵌套 metafile，输出稳定包索引；断言重复输入去重、排序和未打包依赖排除。 */
test('collects bundled scoped and nested packages deterministically', () => { const { root, nm } = fixture(); addPackage(nm, '@scope/z', { name: '@scope/z', version: '2.0.0', license: 'MIT' }, { LICENSE: 'z license\n', 'NOTICE.txt': 'z notice\n', 'index.js': '' }); addPackage(nm, 'outer/node_modules/a', { name: 'a', version: '1.0.0', license: { type: 'Apache-2.0' } }, { LICENCE: 'a license\n', 'index.js': '' }); addPackage(nm, 'unused', { name: 'unused', version: '9.0.0', license: 'MIT' }, { LICENSE: 'unused\n', 'index.js': '' }); const result = buildBundledNotices(root, [{ inputs: { [input(root, '@scope/z')]: {}, [input(root, 'outer/node_modules/a')]: {} } }, { inputs: { [input(root, '@scope/z')]: {} } }]); assert.deepEqual(result.packages.map(({ name, version }) => ({ name, version })), [{ name: '@scope/z', version: '2.0.0' }, { name: 'a', version: '1.0.0' }]); assert.equal(result.packages[0].notices.length, 2); assert.match(result.text, /## @scope\/z 2\.0\.0/); assert.doesNotMatch(result.text, /unused/); });
/** 输入真实许可证/通知文件，输出文件哈希和完整文本；断言字节哈希与换行内容没有被截断。 */
test('preserves full notice text and exact sha256', () => { const { root, nm } = fixture(); const body = 'Copyright 2026\r\nPermission granted.\r\n'; addPackage(nm, 'pkg', { name: 'pkg', version: '1.2.3', license: 'BSD-2-Clause' }, { 'COPYING.md': body, 'index.js': '' }); const result = buildBundledNotices(root, { inputs: { [input(root, 'pkg')]: {} } }); assert.deepEqual(result.packages[0].notices, [{ file: 'COPYING.md', sha256: crypto.createHash('sha256').update(body).digest('hex') }]); assert.match(result.text, /Copyright 2026\nPermission granted\./); });
/** 输入无根许可证但 README 含明确 License 章节，输出完整章节和精确哈希；断言 SPDX 与嵌入正文一致且普通 README 文本不混入。 */
test('extracts an explicit README license section', () => {
  const { root, nm } = fixture();
  const installedReadme = fs.readFileSync(path.join(__dirname, '../node_modules/isarray/README.md'), 'utf8');
  const section = installedReadme.slice(installedReadme.indexOf('## License')).trim() + '\n';
  const readme = '# package\n\nDescription.\n\n' + section + '\n## Usage\n\nUsage text.\n';
  addPackage(nm, 'readme-license', { name: 'readme-license', version: '1.0.0', license: 'MIT' }, { 'README.md': readme, 'index.js': '' });
  const result = buildBundledNotices(root, { inputs: { [input(root, 'readme-license')]: {} } });

  assert.deepEqual(result.packages[0].notices, [{ file: 'README.md#License', sha256: crypto.createHash('sha256').update(section).digest('hex'), sourceSha256: crypto.createHash('sha256').update(readme).digest('hex') }]);
  assert.match(result.text, /Permission is hereby granted/);
  assert.doesNotMatch(result.text, /Usage text/);
});

/** 输入 README 仅提供 License URL，输出失败；断言 URL 不会被当作许可证正文。 */
test('rejects URL-only README license sections', () => {
  const { root, nm } = fixture();
  addPackage(nm, 'readme-url', { name: 'readme-url', version: '1.0.0', license: 'MIT' }, { 'README.md': '# package\n\n## License\n\nhttps://example.test/license\n', 'index.js': '' });
  assert.throws(() => buildBundledNotices(root, { inputs: { [input(root, 'readme-url')]: {} } }), /no usable license or notice text/i);
});

/** 输入缺失、空白、坏 JSON、URL-only metadata、URL-only notice 和非法路径，输出明确失败而非猜测许可证。 */
test('fails closed for incomplete metadata, notices, and escaped paths', () => { const cases = [['missing license', { name: 'bad', version: '1' }, { LICENSE: 'text' }], ['empty notice', { name: 'bad', version: '1', license: 'MIT' }, { LICENSE: '  ' }], ['url license', { name: 'bad', version: '1', license: 'https://example.test/license' }, { LICENSE: 'text' }], ['url notice', { name: 'bad', version: '1', license: 'MIT' }, { NOTICE: 'https://example.test/license' }]]; for (const [label, metadata, files] of cases) { const { root, nm } = fixture(); addPackage(nm, 'bad', metadata, { ...files, 'index.js': '' }); assert.throws(() => buildBundledNotices(root, { inputs: { [input(root, 'bad')]: {} } }), /no usable|metadata/i, label); } const { root, nm } = fixture(); const dir = addPackage(nm, 'good', { name: 'good', version: '1', license: 'MIT' }, { LICENSE: 'ok', 'index.js': '' }); fs.writeFileSync(path.join(dir, 'package.json'), '{'); assert.throws(() => buildBundledNotices(root, { inputs: { [input(root, 'good')]: {} } }), /JSON|Unexpected/i); const outside = path.join(root, 'outside.js'); fs.writeFileSync(outside, ''); assert.throws(() => buildBundledNotices(root, { inputs: { [root + path.sep + 'node_modules' + path.sep + '..' + path.sep + 'outside.js']: {} } }), /node_modules|escapes/i); });