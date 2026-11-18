const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { transformSync } = require('esbuild');
const source = fs.readFileSync(path.join(__dirname, '../src/android-debugger/runtimeExecutable.ts'), 'utf8');

/** 输入平台与故障配置，输出真实 helper 及可观察 fs；所有路径是内存 fixture，不接触真实 SDK。 */
function fixture(config = {}) {
  const calls = []; const nodes = new Map([['/owned', { dir: true }], ['/owned/tool', { mode: config.mode ?? 0o100640 }]]);
  const fake = {
    constants: { F_OK: 0, X_OK: 1 },
    /** 输入 IO 操作与参数，故障时抛同一错误，便于严格断言错误不被吞掉。 */
    check(operation, ...args) { calls.push([operation, ...args]); if (config.fail === operation) throw config.error; },
    /** 输入路径，输出 canonical 路径；模拟 root 内与外 symlink。 */
    realpathSync(file) { this.check('realpath', file); return config.realpath?.[file] || file; },
    /** 输入文件，输出普通/目录状态；不存在抛 ENOENT。 */
    statSync(file) { this.check('stat', file); const node = nodes.get(file); if (!node) throw Object.assign(new Error('missing'), { code: 'ENOENT' }); return { mode: node.mode, isFile: () => !node.dir }; },
    /** 输入文件和精确 mode，输出权限副作用；不改变节点的其它信息。 */
    chmodSync(file, mode) { this.check('chmod', file, mode); nodes.get(file).mode = mode; },
    /** 输入文件/访问模式，确保 chmod 在 X_OK 前完成，否则明确失败。 */
    accessSync(file, mode) { this.check('access', file, mode); if (mode === 1 && !(nodes.get(file).mode & 0o111)) throw new Error('not executable'); }
  };
  const module = { exports: {} };
  vm.runInNewContext(transformSync(source, { loader: 'ts', format: 'cjs' }).code, { module, exports: module.exports, require: id => id === 'node:fs' ? fake : id === 'node:path' ? path.posix : require(id), process: { platform: config.platform || 'linux' }, Error });
  return { run: module.exports.runtimeExecutable, calls, nodes };
}

// 输入非执行模式，断言只 OR 0o111 且保留 setgid/read/write 等位；重复调用不再次修改。
test('repairs only owned Unix execute bits before X_OK preserving other bits', () => {
  for (const platform of ['linux', 'darwin']) {
    const f = fixture({ platform, mode: 0o102640 });
    assert.equal(f.run('/owned/tool', '/owned'), '/owned/tool');
    assert.deepEqual(f.calls.filter(call => call[0] === 'chmod'), [['chmod', '/owned/tool', 0o102751]]);
    assert.ok(f.calls.findIndex(call => call[0] === 'chmod') < f.calls.findIndex(call => call[0] === 'access'));
    f.run('/owned/tool', '/owned'); assert.equal(f.calls.filter(call => call[0] === 'chmod').length, 1);
  }
});

// 已有任意 execute 位不补其它位；Windows 无论源 mode 如何均只检查存在，不 chmod。
test('already executable and Windows candidates are never chmod mutated', () => {
  for (const config of [{ mode: 0o100700 }, { platform: 'win32', mode: 0o100600 }]) {
    const f = fixture(config); assert.equal(f.run('/owned/tool', '/owned'), '/owned/tool');
    assert.equal(f.calls.filter(call => call[0] === 'chmod').length, 0);
  }
});

// 非绝对、父级同前缀及 symlink 逃逸不可修改；实际目录必须明确失败而非静默回退。
test('rejects outside symlink escapes nonregular and invalid candidates without chmod', () => {
  for (const [candidate, config] of [['relative', {}], ['/owned-other/tool', {}], ['/owned/tool', { realpath: { '/owned/tool': '/outside/tool' } }]]) {
    const f = fixture(config); assert.throws(() => f.run(candidate, '/owned'), /absolute|escapes/); assert.equal(f.calls.filter(call => call[0] === 'chmod').length, 0);
  }
  const f = fixture(); f.nodes.set('/owned/directory', { dir: true }); assert.throws(() => f.run('/owned/directory', '/owned'), /regular file/);
  assert.equal(f.run('/owned/missing', '/owned'), undefined);
});

// 任一真实 IO 故障按身份传播；权限错误不得变成缺失候选、默认成功或 PATH 回退。
test('realpath stat chmod access permission failures propagate unchanged', () => {
  for (const fail of ['realpath', 'stat', 'chmod', 'access']) {
    const error = Object.assign(new Error('denied ' + fail), { code: 'EACCES' }); const f = fixture({ fail, error });
    assert.throws(() => f.run('/owned/tool', '/owned'), received => received === error);
  }
});

// 使用真实 VSCE API 构造临时 VSIX，检查 resources/<dependency>/<host> ZIP external attributes：Windows 无 +x，故 runtime 必须修复自有 host 文件。
test('VSCE fixture ZIP preserves Windows nonexecutable mode metadata', async t => {
  const { createVSIX } = require('@vscode/vsce'); const unzipper = require('unzipper');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-mode-vsix-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const relative = 'resources/platform-tools/linux-x64/adb'; const binary = path.join(root, relative);
  fs.mkdirSync(path.dirname(binary), { recursive: true }); fs.writeFileSync(binary, 'fixture runtime');
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'runtime-mode-fixture', displayName: 'Runtime Mode Fixture', publisher: 'fixture', version: '1.0.0', description: 'Executable mode regression fixture', engines: { vscode: '^1.95.0' }, repository: 'https://example.com/fixture.git', license: 'MIT' }));
  fs.writeFileSync(path.join(root, 'README.md'), '# Runtime Mode Fixture\n'); fs.writeFileSync(path.join(root, 'LICENSE'), 'MIT\n');
  const output = path.join(root, 'fixture.vsix');
  await createVSIX({ cwd: root, packagePath: output, dependencies: false, skipLicense: true, allowMissingRepository: true });
  const archive = await unzipper.Open.file(output); const entry = archive.files.find(file => file.path === 'extension/' + relative);
  assert.ok(entry); const zippedMode = (entry.externalFileAttributes >>> 16) & 0xffff;
  assert.equal(zippedMode & 0o111, fs.statSync(binary).mode & 0o111);
  if (process.platform === 'win32') assert.equal(zippedMode & 0o111, 0);
  t.diagnostic('VSIX binary mode=' + zippedMode.toString(8) + ' source=' + fs.statSync(binary).mode.toString(8));
});
