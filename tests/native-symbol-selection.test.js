const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { transformSync } = require('esbuild');
const source = fs.readFileSync(path.join(__dirname, '../src/android-debugger/native-debugger/nativeSymbols.ts'), 'utf8');

/** Node>=22 加载真实选择模块；临时磁盘、隔离 UI/workspaceState，允许精确注入 IO/存储错误，不执行伪 .so。 */
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-symbol-selection-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const state = { map: new Map(), calls: [], updates: [], action: 'none', input: undefined, dialog: undefined, statErrors: new Map(), readErrors: new Map() };
  const storage = {
    get(key) { if (state.getError) throw state.getError; return structuredClone(state.map.get(key)); },
    async update(key, value) {
      if (state.updateError) throw state.updateError;
      state.updates.push({ key, value: structuredClone(value) });
      if (value === undefined) state.map.delete(key); else state.map.set(key, structuredClone(value));
    },
  };
  const disk = { promises: {
    async stat(filename) { state.beforeStat?.(filename); if (state.statErrors.has(filename)) throw state.statErrors.get(filename); return fs.promises.stat(filename); },
    async readdir(directory, options) { if (state.readErrors.has(directory)) throw state.readErrors.get(directory); return fs.promises.readdir(directory, options); },
  } };
  const vscode = { window: {
    async showQuickPick(items, options) {
      state.calls.push({ kind: options.canPickMany ? 'pick' : 'menu', items, options });
      if (options.canPickMany) return state.pick ? state.pick(items) : [items[0]];
      return state.menu ? state.menu(items) : items.find(item => item.action === state.action);
    },
    async showInputBox(options) { state.calls.push({ kind: 'input', options }); state.inputOptions = options; return state.input; },
    async showOpenDialog(options) { state.calls.push({ kind: 'dialog', options }); return state.dialog?.map(fsPath => ({ fsPath })); },
  } };
  const module = { exports: {} };
  vm.runInNewContext(transformSync(source, { loader: 'ts', format: 'cjs' }).code, {
    module, exports: module.exports, require: id => id === 'vscode' ? vscode : id === 'node:fs' ? disk : require(id),
  });
  const options = { projectRoot: root, packageName: 'com.example.app', abi: 'arm64-v8a', storage };
  return { root, state, options, api: module.exports };
}

/** 构造真实文件路径和父目录；测试不将文件内容伪装成 ELF 身份证据。 */
function file(f, relative, content = 'unverified library') {
  const filename = path.join(f.root, relative);
  fs.mkdirSync(path.dirname(filename), { recursive: true }); fs.writeFileSync(filename, content); return filename;
}
/** 使用生产记录格式精确核对项目、包名、ABI键，测试多个项目共享 workspaceState 时仍互不影响。 */
function key(f, overrides = {}) {
  const options = { ...f.options, ...overrides };
  return 'androidNative.symbols:' + JSON.stringify([path.resolve(options.projectRoot), options.packageName ?? '', options.abi ?? '']);
}
/** 规范化 VM 数组后比较，既保留严格路径断言又不将跨 realm 原型差异误判为生产失败。 */
function paths(actual, expected) { assert.deepEqual(Array.from(actual), expected); }

// 相同 basename 的两个候选必须展示不同路径；目录去重且不得预选身份不明文件。
test('Native library list distinguishes same names and persists only explicitly selected files', async t => {
  const f = fixture(t); const chosen = file(f, 'app/build/intermediates/cxx/Debug/hash/obj/arm64-v8a/libapp.so');
  const rejected = file(f, 'other/build/intermediates/cxx/Release/hash/obj/arm64-v8a/libapp.so');
  file(f, 'app/build/intermediates/cxx/Debug/hash/obj/arm64-v8a/notes.txt');
  f.state.action = 'scan'; f.state.pick = items => items.filter(item => item.filename === chosen);
  paths(await f.api.selectNativeLibraries([path.dirname(chosen), path.dirname(rejected), path.dirname(chosen)], f.options), [chosen]);
  const pick = f.state.calls.find(call => call.kind === 'pick');
  assert.equal(pick.items.length, 2); assert.equal(pick.options.canPickMany, true); assert.match(pick.options.title, /arm64-v8a/);
  for (const item of pick.items) {
    assert.equal(item.label, 'libapp.so'); assert.equal(item.detail, item.filename);
    assert.equal(item.description, path.relative(f.root, path.dirname(item.filename))); assert.equal(item.picked, undefined);
  }
  assert.deepEqual(f.state.map.get(key(f)), { files: [chosen], directories: [] });
  assert.deepEqual(f.state.calls.map(call => call.kind), ['menu', 'pick']);
});

test('Native same-name multi-selection fails without choosing by directory order or recording', async t => {
  const f = fixture(t); const a = file(f, 'one/libsame.so'), b = file(f, 'two/libsame.so');
  f.state.action = 'scan'; f.state.pick = items => items;
  await assert.rejects(f.api.selectNativeLibraries([path.dirname(a), path.dirname(b)], f.options), /Conflicting Native libraries.*libsame\.so/);
  assert.equal(f.state.map.size, 0); assert.equal(f.state.updates.length, 0);
});

// 手填相对路径以 Android 项目为根，输入校验允许文件/目录并拒绝缺失、空白或非 .so。
test('Native manual paths preserve spaces and validate relative files and directories', async t => {
  const f = fixture(t); const chosen = file(f, 'native symbols/libapp.so'); const text = file(f, 'notes.txt');
  f.state.action = 'manual'; f.state.input = path.join('native symbols', 'libapp.so');
  paths(await f.api.selectNativeLibraries([], f.options), [chosen]);
  assert.equal(await f.state.inputOptions.validateInput(f.state.input), undefined);
  assert.equal(await f.state.inputOptions.validateInput('native symbols'), undefined);
  assert.match(await f.state.inputOptions.validateInput(''), /Enter/);
  assert.match(await f.state.inputOptions.validateInput('missing.so'), /existing/);
  assert.match(await f.state.inputOptions.validateInput(text), /existing/);
  assert.deepEqual(f.state.map.get(key(f)), { files: [chosen], directories: [] });
});

test('Native manual directory recursively selects libraries without following child links', async t => {
  const f = fixture(t); const a = file(f, 'symbols/one/liba.so'), b = file(f, 'symbols/two/libb.so');
  const directory = path.join(f.root, 'symbols'); fs.symlinkSync(f.root, path.join(directory, 'loop'), 'junction');
  file(f, 'symbols/notes.txt'); f.state.action = 'manual'; f.state.input = 'symbols';
  paths(await f.api.selectNativeLibraries([], f.options), [a, b].sort());
  assert.deepEqual(f.state.map.get(key(f)), { files: [a, b].sort(), directories: [directory] });
  assert.deepEqual(f.state.calls.map(call => call.kind), ['menu', 'input']);
});

test('Native directory name conflicts require selecting exact files before saving', async t => {
  const f = fixture(t); const a = file(f, 'symbols/arm64-v8a/libapp.so'), b = file(f, 'symbols/x86_64/libapp.so');
  f.state.action = 'directory'; f.state.dialog = [path.join(f.root, 'symbols')];
  f.state.pick = items => { assert.deepEqual(Array.from(items, item => item.filename), [a, b].sort()); return items.filter(item => item.filename === a); };
  paths(await f.api.selectNativeLibraries([], f.options), [a]);
  assert.deepEqual(f.state.calls.map(call => call.kind), ['menu', 'dialog', 'pick']);
  assert.deepEqual(f.state.map.get(key(f)), { files: [a], directories: [path.join(f.root, 'symbols')] });
});

test('Native browsing supports multiple distinct files and a directory source', async t => {
  const files = fixture(t); const a = file(files, 'a/liba.so'), b = file(files, 'b/libb.so');
  files.state.action = 'files'; files.state.dialog = [a, b];
  paths(await files.api.selectNativeLibraries([], files.options), [a, b]);
  const fileDialog = files.state.calls.find(call => call.kind === 'dialog').options;
  assert.equal(fileDialog.canSelectFiles, true); assert.equal(fileDialog.canSelectFolders, false); assert.equal(fileDialog.canSelectMany, true);
  paths(fileDialog.filters['Native libraries'], ['so']);
  const folders = fixture(t); const c = file(folders, 'symbols/libc.so'); folders.state.action = 'directory'; folders.state.dialog = [path.dirname(c)];
  paths(await folders.api.selectNativeLibraries([], folders.options), [c]);
  const folderDialog = folders.state.calls.find(call => call.kind === 'dialog').options;
  assert.equal(folderDialog.canSelectFiles, false); assert.equal(folderDialog.canSelectFolders, true);
  assert.deepEqual(folders.state.map.get(key(folders)), { files: [c], directories: [path.dirname(c)] });
});

// 有效记录不再弹窗；同一 workspaceState 里的项目根、包名、ABI均独立，不能误复用或误删除别的项目。
test('Native remembered choices are reused only within their project package and ABI', async t => {
  const f = fixture(t); const chosen = file(f, 'libapp.so'); const saved = { files: [chosen], directories: [] }; f.state.map.set(key(f), saved);
  paths(await f.api.selectNativeLibraries([], f.options), [chosen]); assert.equal(f.state.calls.length, 0);
  for (const overrides of [{ projectRoot: path.join(f.root, 'other-project') }, { packageName: 'com.other.app' }, { abi: 'x86_64' }]) {
    paths(await f.api.selectNativeLibraries([], { ...f.options, ...overrides }), []);
    assert.equal(f.state.map.size, 1); assert.deepEqual(f.state.map.get(key(f)), saved);
  }
  assert.equal(f.state.calls.length, 3); assert.equal(f.state.updates.length, 0);
});

test('Native lost files clear the entire current record before cancellation or replacement', async t => {
  const f = fixture(t); const kept = file(f, 'libkept.so'), missing = path.join(f.root, 'missing.so');
  const otherKey = key(f, { projectRoot: path.join(f.root, 'other-project') }); const other = { files: [kept], directories: [] };
  f.state.map.set(key(f), { files: [kept, missing], directories: [] }); f.state.map.set(otherKey, other);
  f.state.menu = () => { assert.equal(f.state.map.has(key(f)), false); assert.deepEqual(f.state.map.get(otherKey), other); return undefined; };
  assert.equal(await f.api.selectNativeLibraries([], f.options), undefined);
  assert.equal(f.state.updates.length, 1); assert.deepEqual(f.state.updates[0], { key: key(f), value: undefined });
  f.state.menu = undefined; f.state.action = 'manual'; f.state.input = kept;
  paths(await f.api.selectNativeLibraries([], f.options), [kept]);
  assert.deepEqual(f.state.map.get(key(f)), other); assert.deepEqual(f.state.map.get(otherKey), other);
});

test('Native lost directories and path-type changes invalidate saved choices', async t => {
  for (const failure of ['directory-missing', 'file-becomes-directory', 'directory-becomes-file']) {
    const f = fixture(t); const chosen = file(f, 'libapp.so'); const directory = path.join(f.root, 'symbols'); fs.mkdirSync(directory);
    f.state.map.set(key(f), { files: [chosen], directories: [directory] });
    if (failure === 'directory-missing') fs.rmdirSync(directory);
    if (failure === 'file-becomes-directory') { fs.rmSync(chosen); fs.mkdirSync(chosen); }
    if (failure === 'directory-becomes-file') { fs.rmdirSync(directory); fs.writeFileSync(directory, 'not a directory'); }
    f.state.menu = () => { assert.equal(f.state.map.has(key(f)), false); return undefined; };
    assert.equal(await f.api.selectNativeLibraries([], f.options), undefined);
    assert.equal(f.state.map.size, 0); assert.equal(f.state.updates.length, 1);
  }
});

test('Native malformed saved records are removed without affecting another project', async t => {
  for (const malformed of [null, 'old-format', { files: [], directories: [] }, { files: ['relative.so'], directories: [] }]) {
    const f = fixture(t); const chosen = file(f, 'libapp.so'); const otherKey = key(f, { packageName: 'com.other.app' });
    f.state.map.set(key(f), malformed); f.state.map.set(otherKey, { files: [chosen], directories: [] });
    paths(await f.api.selectNativeLibraries([], f.options), []);
    assert.equal(f.state.map.has(key(f)), false); assert.equal(f.state.map.has(otherKey), true);
    assert.equal(f.state.updates.length, 1); assert.equal(f.state.updates[0].key, key(f));
  }
});

// 用户取消任何交互都不能写入新记录；没有候选也保留手填/浏览，不把“无符号继续”保存为假成功。
test('Native cancellation at source list picker browser or manual input never saves', async t => {
  for (const action of [undefined, 'scan', 'files', 'directory', 'manual']) {
    const f = fixture(t); const chosen = file(f, 'libapp.so'); f.state.action = action;
    f.state.pick = () => undefined; f.state.dialog = undefined; f.state.input = undefined;
    assert.equal(await f.api.selectNativeLibraries([f.root], f.options), undefined);
    assert.equal(f.state.map.size, 0); assert.equal(f.state.updates.length, 0);
  }
});

test('Native missing and empty candidates retain manual browse and explicit no-symbol actions', async t => {
  const f = fixture(t); file(f, 'notes.txt'); fs.mkdirSync(path.join(f.root, 'not-a-file.so'));
  paths(await f.api.selectNativeLibraries([f.root, path.join(f.root, 'missing')], f.options), []);
  paths(await f.api.selectNativeLibraries([], f.options), []);
  for (const menu of f.state.calls) {
    assert.deepEqual(Array.from(menu.items, item => item.action), ['files', 'directory', 'manual', 'none']);
  }
  assert.equal(f.state.calls.length, 2); assert.equal(f.state.map.size, 0);
  f.state.action = 'directory'; f.state.dialog = [f.root];
  await assert.rejects(f.api.selectNativeLibraries([], f.options), /No Native \.so files/);
  assert.equal(f.state.map.size, 0);
});

test('Native invalid manual and disappeared selected files cannot become saved choices', async t => {
  const f = fixture(t); f.state.action = 'manual'; f.state.input = 'missing.so';
  await assert.rejects(f.api.selectNativeLibraries([], f.options), /Invalid Native symbol path/);
  const chosen = file(f, 'libapp.so'); f.state.action = 'scan'; f.state.pick = items => { fs.rmSync(chosen); return [items[0]]; };
  await assert.rejects(f.api.selectNativeLibraries([f.root], f.options), /Invalid Native \.so file/);
  assert.equal(f.state.map.size, 0); assert.equal(f.state.updates.length, 0);
});

test('Native cancelled tokens stop before interaction or before writing a selection', async t => {
  const f = fixture(t); const token = { isCancellationRequested: true };
  assert.equal(await f.api.selectNativeLibraries([], { ...f.options, token }), undefined); assert.equal(f.state.calls.length, 0);
  const chosen = file(f, 'libapp.so'); token.isCancellationRequested = false; f.state.action = 'scan';
  f.state.pick = items => { token.isCancellationRequested = true; return [items[0]]; };
  assert.equal(await f.api.selectNativeLibraries([f.root], { ...f.options, token }), undefined);
  assert.equal(f.state.map.size, 0); assert.equal(f.state.updates.length, 0);
  f.state.map.set(key(f), { files: [chosen], directories: [] }); token.isCancellationRequested = false;
  f.state.beforeStat = () => { token.isCancellationRequested = true; };
  assert.equal(await f.api.selectNativeLibraries([], { ...f.options, token }), undefined);
});

// 权限/存储错误必须传播，不能当作“路径不存在”删除仍有效记录或继续启动。
test('Native filesystem permission errors propagate without deleting valid records', async t => {
  const f = fixture(t); const chosen = file(f, 'libapp.so'); const denied = Object.assign(new Error('denied'), { code: 'EACCES' });
  f.state.map.set(key(f), { files: [chosen], directories: [] }); f.state.statErrors.set(chosen, denied);
  await assert.rejects(f.api.selectNativeLibraries([], f.options), { code: 'EACCES' });
  assert.equal(f.state.map.size, 1); assert.equal(f.state.updates.length, 0); assert.equal(f.state.calls.length, 0);
  f.state.map.clear(); f.state.statErrors.clear(); f.state.readErrors.set(f.root, denied);
  await assert.rejects(f.api.selectNativeLibraries([f.root], f.options), { code: 'EACCES' });
  assert.equal(f.state.calls.length, 0); assert.equal(f.state.map.size, 0);
});

test('Native storage failures prevent use or replacement instead of claiming persistence', async t => {
  const f = fixture(t); const chosen = file(f, 'libapp.so'); f.state.getError = new Error('storage read failed');
  await assert.rejects(f.api.selectNativeLibraries([], f.options), /storage read failed/); assert.equal(f.state.calls.length, 0);
  f.state.getError = undefined; f.state.action = 'manual'; f.state.input = chosen; f.state.updateError = new Error('storage write failed');
  await assert.rejects(f.api.selectNativeLibraries([], f.options), /storage write failed/); assert.equal(f.state.map.size, 0);
  f.state.calls.length = 0; f.state.map.set(key(f), { files: [path.join(f.root, 'missing.so')], directories: [] });
  await assert.rejects(f.api.selectNativeLibraries([], f.options), /storage write failed/);
  assert.equal(f.state.calls.length, 0); assert.equal(f.state.map.size, 1);
});

test('Native without a project root never writes selections under process CWD', async t => {
  const f = fixture(t); const chosen = file(f, 'libapp.so'); f.state.action = 'manual'; f.state.input = chosen; f.state.getError = new Error('must not access storage');
  paths(await f.api.selectNativeLibraries([], { ...f.options, projectRoot: undefined }), [chosen]);
  assert.equal(f.state.map.size, 0); assert.equal(f.state.updates.length, 0);
});

// 精确文件在目标创建后的 preRunCommands 加载；验证 Windows/空格/引号与命令分隔控制字符。
test('Native module commands quote exact paths and reject command separators', t => {
  const f = fixture(t); const windows = path.win32.join('C:/', 'native symbols', 'module "quoted"', 'libapp.so');
  paths(f.api.nativeLibraryCommands([windows, "/tmp/O'Brien/libapp.so"]), [
    'target modules add -- ' + JSON.stringify(windows), 'target modules add -- "/tmp/O\'Brien/libapp.so"',
  ]);
  for (const character of ['\r', '\n', '\0']) assert.throws(() => f.api.nativeLibraryCommands(['/tmp/a' + character + '.so']), /control characters/);
});
