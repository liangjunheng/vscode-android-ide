const assert = require('node:assert/strict'); const crypto = require('node:crypto'); const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path'); const test = require('node:test'); const { buildBundledNotices } = require('../scripts/build-notices.cjs');
function fixture() { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bundled-notices-')); const nm = path.join(root, 'node_modules'); fs.mkdirSync(nm, { recursive: true }); return { root, nm }; }
function addPackage(nm, relative, metadata, files) { const dir = path.join(nm, relative); fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(metadata)); for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), body); return dir; }
/** 将工作区 SPDX 补充资源复制到临时项目。输入：临时项目根；输出：无；条件：源资源必须是本次任务提交的官方正文与清单；回归：CC0 正文及来源哈希测试使用。 */
function addSupplementalLicenses(root) { fs.cpSync(path.join(__dirname, '../resources/licenses'), path.join(root, 'resources/licenses'), { recursive: true }); }
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

/** 输入完整 MIT 正文的标准换行版本，输出 README License 章节；断言规范空白折叠等价且版权行保留。 */
test('accepts complete normalized MIT text with copyright', () => {
  const { root, nm } = fixture();
  const readme = '# package\n\n## License\n\nThe MIT License\n\nCopyright(c) 2013 Sergi Mansilla <sergi.mansilla AT gmail.com>\n\nPermission is hereby granted, free of charge, to any person obtaining a copy\nof this software and associated documentation files (the "Software"), to deal\nin the Software without restriction, including without limitation the rights\nto use, copy, modify, merge, publish, distribute, sublicense, and/or sell\ncopies of the Software, and to permit persons to whom the Software is\nfurnished to do so, subject to the following conditions:\n\nThe above copyright notice and this permission notice shall be included in\nall copies or substantial portions of the Software.\n\nTHE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR\nIMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,\nFITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE\nAUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER\nLIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,\nOUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN\nTHE SOFTWARE.\n';
  addPackage(nm, 'mit-complete', { name: 'mit-complete', version: '1.0.0', license: 'MIT' }, { 'README.md': readme, 'index.js': '' });
  const result = buildBundledNotices(root, { inputs: { [input(root, 'mit-complete')]: {} } });
  assert.equal(result.packages[0].notices[0].file, 'README.md#License');
  assert.match(result.text, /Copyright\(c\) 2013 Sergi Mansilla/);
  assert.match(result.text, /THE SOFTWARE IS PROVIDED/);
});

/** 输入真实嵌套 agent-base README，输出完整 MIT 章节；断言 Setext 标题、单引号正文和末尾引用链接均按规范等价处理。 */
test('accepts nested agent-base README with trailing link definitions', () => {
  const { root, nm } = fixture();
  const readme = fs.readFileSync(path.join(__dirname, '../node_modules/axios/node_modules/agent-base/README.md'), 'utf8');
  addPackage(nm, 'agent-base-real', { name: 'agent-base', version: '6.0.2', license: 'MIT' }, { 'README.md': readme, 'index.js': '' });
  const result = buildBundledNotices(root, { inputs: { [input(root, 'agent-base-real')]: {} } });
  assert.equal(result.packages[0].notices[0].file, 'README.md#License');
  assert.match(result.text, /Copyright \(c\) 2013 Nathan Rajlich/);
  assert.match(result.text, /THE SOFTWARE IS PROVIDED 'AS IS'/);
  assert.doesNotMatch(result.text, /\[http-proxy-agent\]:/);
});

/** 输入仅含 MIT 两个关键短句，必须失败；断言不再以短语存在代替完整正文和版权保留。 */
test('rejects MIT sections reduced to two key phrases', () => {
  const { root, nm } = fixture();
  const readme = '# package\n\n## License\n\nThe MIT License\n\nCopyright 2026 Example\n\nPermission is hereby granted.\n\nTHE SOFTWARE IS PROVIDED "AS IS".\n';
  addPackage(nm, 'mit-short', { name: 'mit-short', version: '1.0.0', license: 'MIT' }, { 'README.md': readme, 'index.js': '' });
  assert.throws(() => buildBundledNotices(root, { inputs: { [input(root, 'mit-short')]: {} } }), /no usable license or notice text/i);
});

/** 输入单项旧 npm licenses 数组与 UNLICENSE 文件，保持兼容；多项数组必须显式失败而非静默取首项。 */
test('keeps UNLICENSE and single npm licenses compatibility without selecting multiple', () => {
  const single = fixture();
  addPackage(single.nm, 'unlicense-package', { name: 'unlicense-package', version: '1.0.0', licenses: [{ type: 'MIT' }] }, { UNLICENSE: 'Copyright 2026\nPermission text\n', 'index.js': '' });
  const result = buildBundledNotices(single.root, { inputs: { [input(single.root, 'unlicense-package')]: {} } });
  assert.equal(result.packages[0].notices[0].file, 'UNLICENSE');

  const multiple = fixture();
  addPackage(multiple.nm, 'multi-license', { name: 'multi-license', version: '1.0.0', licenses: [{ type: 'MIT' }, { type: 'Apache-2.0' }] }, { UNLICENSE: 'text\n', 'index.js': '' });
  assert.throws(() => buildBundledNotices(multiple.root, { inputs: { [input(multiple.root, 'multi-license')]: {} } }), /multiple license entries/i);
});

/** 输入明确 CC0 metadata 与 README deed 声明，输出官方完整正文及来源 URL/哈希；断言正文哈希与来源绑定且不使用 README 链接作正文。 */
test('uses the exact CC0 supplemental license with provenance', () => {
  const { root, nm } = fixture();
  addSupplementalLicenses(root);
  const readme = '# package\n\n## License\n\n[Creative Commons Zero v1.0 Universal](https://creativecommons.org/publicdomain/zero/1.0/deed)\n';
  addPackage(nm, 'cc0-package', { name: 'cc0-package', version: '1.0.0', license: 'CC0-1.0' }, { 'README.md': readme, 'index.js': '' });
  const resource = fs.readFileSync(path.join(root, 'resources/licenses/CC0-1.0/legalcode.txt'));
  const hash = crypto.createHash('sha256').update(resource).digest('hex');
  const result = buildBundledNotices(root, { inputs: { [input(root, 'cc0-package')]: {} } });

  assert.deepEqual(result.packages[0].notices, [{ file: 'resources/licenses/CC0-1.0/legalcode.txt', sha256: hash, sourceSha256: hash, sourceUrl: 'https://creativecommons.org/publicdomain/zero/1.0/legalcode.txt' }]);
  assert.match(result.text, /Creative Commons Legal Code/);
  assert.match(result.text, /CC0 1\.0 Universal/);
  assert.doesNotMatch(result.text, /publicdomain\/zero\/1\.0\/deed/);
});

/** 输入缺 metadata、错误 CC0 声明或 MIT URL-only 声明，输出失败；断言 SPDX 与 README 不匹配时不触发补充正文。 */
test('rejects missing metadata, wrong CC0 declaration, and URL-only MIT', () => {
  const cases = [
    ['missing metadata', { name: 'bad', version: '1.0.0' }, '# package\n\n## License\n\n[Creative Commons Zero v1.0 Universal](https://creativecommons.org/publicdomain/zero/1.0/deed)\n', /metadata/i],
    ['wrong CC0 declaration', { name: 'bad', version: '1.0.0', license: 'CC0-1.0' }, '# package\n\n## License\n\nhttps://creativecommons.org/publicdomain/zero/1.0/deed\n', /no usable license or notice text/i],
    ['URL-only MIT', { name: 'bad', version: '1.0.0', license: 'MIT' }, '# package\n\n## License\n\nhttps://opensource.org/license/mit\n', /no usable license or notice text/i]
  ];
  for (const [label, metadata, readme, error] of cases) {
    const { root, nm } = fixture();
    addPackage(nm, 'bad', metadata, { 'README.md': readme, 'index.js': '' });
    assert.throws(() => buildBundledNotices(root, { inputs: { [input(root, 'bad')]: {} } }), error, label);
  }
});

/** 输入正确 CC0 声明但篡改正文或来源 URL，输出失败；断言正文哈希与官方来源清单始终绑定。 */
test('rejects tampered CC0 body and source binding', () => {
  const readme = '# package\n\n## License\n\n[Creative Commons Zero v1.0 Universal](https://creativecommons.org/publicdomain/zero/1.0/deed)\n';
  const first = fixture();
  addSupplementalLicenses(first.root);
  addPackage(first.nm, 'cc0-package', { name: 'cc0-package', version: '1.0.0', license: 'CC0-1.0' }, { 'README.md': readme, 'index.js': '' });
  const legalcode = path.join(first.root, 'resources/licenses/CC0-1.0/legalcode.txt');
  fs.appendFileSync(legalcode, 'tampered');
  assert.throws(() => buildBundledNotices(first.root, { inputs: { [input(first.root, 'cc0-package')]: {} } }), /hash does not match source/i);

  const second = fixture();
  addSupplementalLicenses(second.root);
  addPackage(second.nm, 'cc0-package', { name: 'cc0-package', version: '1.0.0', license: 'CC0-1.0' }, { 'README.md': readme, 'index.js': '' });
  const manifestPath = path.join(second.root, 'resources/licenses/index.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest['CC0-1.0'].sourceUrl = 'https://example.test/legalcode.txt';
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  assert.throws(() => buildBundledNotices(second.root, { inputs: { [input(second.root, 'cc0-package')]: {} } }), /Invalid supplemental license declaration/i);
});

/** 输入真实 spdx-exceptions 的 CC-BY metadata 与 README 声明，输出官方完整正文和来源哈希；断言引用声明不被误当作正文。 */
test('uses the exact CC-BY supplemental license declaration', () => {
  const { root, nm } = fixture();
  addSupplementalLicenses(root);
  const readme = fs.readFileSync(path.join(__dirname, '../node_modules/spdx-exceptions/README.md'), 'utf8');
  addPackage(nm, 'spdx-exceptions', { name: 'spdx-exceptions', version: '2.5.0', license: 'CC-BY-3.0' }, { 'README.md': readme, 'index.js': '' });
  const resource = fs.readFileSync(path.join(root, 'resources/licenses/CC-BY-3.0/legalcode.txt'));
  const hash = crypto.createHash('sha256').update(resource).digest('hex');
  const result = buildBundledNotices(root, { inputs: { [input(root, 'spdx-exceptions')]: {} } });

  assert.deepEqual(result.packages[0].notices, [{ file: 'resources/licenses/CC-BY-3.0/legalcode.txt', sha256: hash, sourceSha256: hash, sourceUrl: 'https://creativecommons.org/licenses/by/3.0/legalcode.txt' }]);
  assert.match(result.text, /Attribution 3\.0 Unported/);
  assert.doesNotMatch(result.text, /From version 2\.0 of the SPDX specification/);
});

/** 输入缺失、空白、坏 JSON、URL-only metadata、URL-only notice 和非法路径，输出明确失败而非猜测许可证。 */
test('fails closed for incomplete metadata, notices, and escaped paths', () => { const cases = [['missing license', { name: 'bad', version: '1' }, { LICENSE: 'text' }], ['empty notice', { name: 'bad', version: '1', license: 'MIT' }, { LICENSE: '  ' }], ['url license', { name: 'bad', version: '1', license: 'https://example.test/license' }, { LICENSE: 'text' }], ['url notice', { name: 'bad', version: '1', license: 'MIT' }, { NOTICE: 'https://example.test/license' }]]; for (const [label, metadata, files] of cases) { const { root, nm } = fixture(); addPackage(nm, 'bad', metadata, { ...files, 'index.js': '' }); assert.throws(() => buildBundledNotices(root, { inputs: { [input(root, 'bad')]: {} } }), /no usable|metadata/i, label); } const { root, nm } = fixture(); const dir = addPackage(nm, 'good', { name: 'good', version: '1', license: 'MIT' }, { LICENSE: 'ok', 'index.js': '' }); fs.writeFileSync(path.join(dir, 'package.json'), '{'); assert.throws(() => buildBundledNotices(root, { inputs: { [input(root, 'good')]: {} } }), /JSON|Unexpected/i); const outside = path.join(root, 'outside.js'); fs.writeFileSync(outside, ''); assert.throws(() => buildBundledNotices(root, { inputs: { [root + path.sep + 'node_modules' + path.sep + '..' + path.sep + 'outside.js']: {} } }), /node_modules|escapes/i); });

/** 建立真实WTFPL包metadata与官方补充资源的隔离fixture；每个用例结束清理，供身份/来源成功及拒绝矩阵使用。 */
function wtfplFixture(t) {
  const f=fixture(); t.after(()=>fs.rmSync(f.root,{recursive:true,force:true})); addSupplementalLicenses(f.root);
  const name='truncate-utf8-bytes'; const dir=addPackage(f.nm,name,{name,version:'1.0.2',license:'WTFPL'},{'index.js':''});
  fs.copyFileSync(path.join(__dirname,'../node_modules',name,'package.json'),path.join(dir,'package.json'));
  const manifestPath=path.join(f.root,'resources/licenses/index.json'); const manifest=JSON.parse(fs.readFileSync(manifestPath,'utf8'));
  return {...f,dir,name,manifestPath,manifest,generate:()=>buildBundledNotices(f.root,{inputs:{[input(f.root,name)]:{}}})};
}

/** 真实生成器执行package-specific分支，断言完整WTFPL正文、包身份及每个输出provenance字段。 */
test('WTFPL package provenance preserves complete body identity and source evidence', t=>{
  const f=wtfplFixture(t); const declaration=f.manifest['WTFPL-2.0']; const evidence=declaration.package;
  const metadataBytes=fs.readFileSync(path.join(f.dir,'package.json'));
  assert.equal(crypto.createHash('sha256').update(metadataBytes).digest('hex'),evidence.packageJsonSha256);
  const body=fs.readFileSync(path.join(f.root,'resources/licenses',declaration.file)); const hash=crypto.createHash('sha256').update(body).digest('hex');
  const result=f.generate(); assert.equal(result.packages.length,1);
  const pkg=result.packages[0]; assert.equal(pkg.name,evidence.name); assert.equal(pkg.version,evidence.version); assert.equal(pkg.license,evidence.license);
  assert.deepEqual(pkg.notices,[{file:'resources/licenses/'+declaration.file,sha256:hash,sourceUrl:declaration.sourceUrl,sourceSha256:hash,metadataSourceUrl:evidence.packageJsonSourceUrl,metadataSourceSha256:evidence.packageJsonSourceSha256,sourceCommit:evidence.sourceCommit}]);
  assert.ok(result.text.includes(body.toString('utf8').replaceAll('\r\n','\n').trim()));
});

/** 逐项破坏包身份、metadata字节哈希、来源commit/URL或SHA格式；必须由真实生成器明确拒绝，不能输出伪成功许可。 */
test('WTFPL package provenance rejects identity metadata hash and invalid source bindings', t=>{
  const cases=[
    ['name',{name:'other-package'}],['version',{version:'0.0.0'}],['license',{license:'MIT'}],
    ['metadata hash',{packageJsonSha256:'0'.repeat(64)}],['missing commit',{sourceCommit:undefined}],['invalid commit',{sourceCommit:17}],
    ['commit URL mismatch',{sourceCommit:'unrelated-commit'}],['missing source URL',{packageJsonSourceUrl:undefined}],
    ['source URL mismatch',{packageJsonSourceUrl:'https://example.test/other/package.json'}],
    ['missing source SHA',{packageJsonSourceSha256:undefined}],['invalid source SHA',{packageJsonSourceSha256:'g'.repeat(64)}]
  ];
  for(const [label,change] of cases){
    const f=wtfplFixture(t); Object.assign(f.manifest['WTFPL-2.0'].package,change); fs.writeFileSync(f.manifestPath,JSON.stringify(f.manifest));
    assert.throws(f.generate,/Supplemental package declaration does not match installed metadata/,label);
  }
});
