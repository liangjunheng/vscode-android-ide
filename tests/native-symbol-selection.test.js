const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { transformSync } = require('esbuild');

/** 执行真实选择逻辑，仅替换已经独立验证来源/ELF的发现边界与VSCode UI；Node runner自动发现。 */
function fixture() {
  const f = { files: [], map: new Map(), calls: [], updates: [], modified: new Map(), written: new Map(), renamed: [] };
  f.options = { projectRoot: path.resolve('project'), packageName: 'com.example.app', abi: 'arm64-v8a', storage: {
    get(key) { if (f.storageError) throw f.storageError; return f.map.get(key); },
    async update(key, value) { if (f.writeError) throw f.writeError; f.updates.push([key, value]); if (value === undefined) f.map.delete(key); else f.map.set(key, value); },
  } };
  const module = { exports: {} };
  vm.runInNewContext(transformSync(fs.readFileSync('src/android-debugger/native-debugger/nativeSymbols.ts', 'utf8'), { loader: 'ts', format: 'cjs' }).code, {
    module, exports: module.exports, require(id) {
      if (id === 'vscode') return { window: { async showQuickPick(items, options, token) { f.calls.push({ items, options, token }); return f.pick ? f.pick(items, options) : items[0]; } } };
      if (id === 'node:fs') return { promises: {
        async stat(filename) { if (f.statError) throw f.statError; return { mtimeMs: f.modified.get(filename) ?? 0 }; },
        async mkdir(directory) { f.directory = directory; },
        async writeFile(filename, content, options) { if (f.fileError) throw f.fileError; assert.equal(options.flag, 'wx'); f.written.set(filename, content); },
        async rename(from, to) { f.renamed.push(to); f.written.set(to, f.written.get(from)); f.written.delete(from); },
        async rm(filename) { f.written.delete(filename); },
      } };
      if (id === './projectLibraries') return { async discoverProjectLibraries(root, abi) { f.discovery = { root, abi }; if (f.failure) throw f.failure; await f.onDiscover?.(); return f.files; } };
      return require(id);
    },
  });
  f.api = module.exports; return f;
}

/** 记录键只用于清除当前项目旧白名单，不允许删除其他项目/ABI记录。 */
function key(options) { return 'androidNative.symbols:' + JSON.stringify([path.resolve(options.projectRoot), options.packageName, options.abi]); }

/** 以宿主数组核验VM返回路径，避免跨realm原型干扰严格内容断言。 */
function paths(actual, expected) { assert.deepEqual(Array.from(actual), expected); }

test('Native automatically loads every unique project-built debug library without prompting or saving', async () => {
  const f = fixture(); f.files = ['one/libengine.so', 'two/libpredict.so'].map(file => path.join(f.options.projectRoot, file));
  paths(await f.api.selectNativeLibraries(['/external/unverified'], f.options), f.files);
  assert.equal(f.calls.length, 0); assert.equal(f.updates.length, 0);
  assert.deepEqual(f.discovery, { root: f.options.projectRoot, abi: 'arm64-v8a' });
  f.files.push(path.join(f.options.projectRoot, 'new/libnew.so'));
  paths(await f.api.selectNativeLibraries([], f.options), f.files); assert.equal(f.calls.length, 0);
});

test('Native selects the latest same-name build and keeps every unique project library without prompting', async () => {
  const f = fixture(), root = f.options.projectRoot;
  const a = path.join(root, 'debug/libsame.so'), b = path.join(root, 'old/libsame.so'), unique = path.join(root, 'debug/libunique.so');
  f.files = [unique, a, b, unique]; f.modified.set(a, 10); f.modified.set(b, 20);
  paths(await f.api.selectNativeLibraries([], f.options), [unique, b]);
  assert.equal(f.calls.length, 0); assert.equal(f.updates.length, 0);
});

test('Native reevaluates duplicate timestamps on every session and breaks ties deterministically', async () => {
  const f = fixture(), root = f.options.projectRoot;
  const a = path.join(root, 'one/libsame.so'), b = path.join(root, 'two/libsame.so'); f.files = [b, a];
  paths(await f.api.selectNativeLibraries([], f.options), [a]);
  f.modified.set(b, 30); paths(await f.api.selectNativeLibraries([], f.options), [b]);
  f.modified.set(a, 40); paths(await f.api.selectNativeLibraries([], f.options), [a]);
  assert.equal(f.calls.length, 0); assert.equal(f.updates.length, 0);
});

test('Native removes only the current obsolete selection and does not let it hide new project libraries', async () => {
  const f = fixture(); const current = key(f.options), other = key({ ...f.options, packageName: 'com.other.app' });
  f.map.set(current, { files: ['/wrong/prebuilt.so'], directories: [] }); f.map.set(other, { files: ['/other.so'], directories: [] });
  f.files = [path.join(f.options.projectRoot, 'liba.so'), path.join(f.options.projectRoot, 'libb.so')];
  paths(await f.api.selectNativeLibraries([], f.options), f.files);
  assert.equal(f.map.has(current), false); assert.equal(f.map.has(other), true);
  assert.deepEqual(f.updates, [[current, undefined]]); assert.equal(f.calls.length, 0);
});

test('Native missing project outputs do not ask for external libraries or manufacture symbols', async () => {
  const f = fixture(); paths(await f.api.selectNativeLibraries(['/external'], f.options), []);
  assert.equal(f.calls.length, 0); assert.equal(f.updates.length, 0);
  f.storageError = new Error('must not access storage');
  paths(await f.api.selectNativeLibraries([], { ...f.options, projectRoot: undefined }), []);
});

test('Native timestamp read failures are visible rather than selecting a stale duplicate', async () => {
  const f = fixture(); f.files = ['a/libsame.so', 'b/libsame.so'].map(file => path.join(f.options.projectRoot, file));
  f.statError = Object.assign(new Error('denied'), { code: 'EACCES' });
  await assert.rejects(f.api.selectNativeLibraries([], f.options), { code: 'EACCES' });
  assert.equal(f.calls.length, 0); assert.equal(f.updates.length, 0);
});

test('Native cancellation before discovery or during discovery creates no UI or record', async () => {
  const f = fixture(), token = { isCancellationRequested: true }; const options = { ...f.options, token };
  assert.equal(await f.api.selectNativeLibraries([], options), undefined); assert.equal(f.discovery, undefined);
  token.isCancellationRequested = false; f.onDiscover = () => { token.isCancellationRequested = true; };
  assert.equal(await f.api.selectNativeLibraries([], options), undefined); assert.equal(f.calls.length, 0); assert.equal(f.updates.length, 0);
});

test('Native project discovery and storage failures remain explicit', async () => {
  const f = fixture(); f.failure = Object.assign(new Error('build record denied'), { code: 'EACCES' });
  await assert.rejects(f.api.selectNativeLibraries([], f.options), { code: 'EACCES' }); assert.equal(f.calls.length, 0);
  f.failure = undefined; f.storageError = new Error('storage unavailable');
  await assert.rejects(f.api.selectNativeLibraries([], f.options), /storage unavailable/);
  f.storageError = undefined; f.map.set(key(f.options), {}); f.writeError = new Error('cannot clear obsolete record');
  await assert.rejects(f.api.selectNativeLibraries([], f.options), /cannot clear/); assert.equal(f.map.size, 1);
});

test('Native same-name automatic selection never invokes a file picker', async () => {
  const f = fixture(); f.files = ['a/libsame.so', 'b/libsame.so'].map(file => path.join(f.options.projectRoot, file));
  f.pick = () => { throw new Error('No manual picker is permitted'); };
  paths(await f.api.selectNativeLibraries(['/external'], f.options), [f.files[0]]);
  assert.equal(f.calls.length, 0);
});

test('Native module commands preserve exact paths and reject command separators', () => {
  const f = fixture(), windows = path.win32.join('C:/', 'native symbols', 'module "quoted"', 'libapp.so');
  paths(f.api.nativeLibraryCommands([windows, "/tmp/O'Brien/libapp.so"]), [
    'target modules add -- ' + JSON.stringify(windows), 'target modules add -- "/tmp/O\'Brien/libapp.so"',
  ]);
  for (const character of ['\r', '\n', '\0']) assert.throws(() => f.api.nativeLibraryCommands(['/tmp/a' + character + '.so']), /control characters/);
});
