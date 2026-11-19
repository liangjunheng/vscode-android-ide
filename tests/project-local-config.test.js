const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { transformSync } = require('esbuild');

const source = fs.readFileSync(path.join(__dirname, '../src/projectLocalConfig.ts'), 'utf8');
const code = transformSync(source, { loader: 'ts', format: 'cjs' }).code;

/** 创建真实临时项目并注册清理；Node>=22执行本文件，所有用例仅在各自目录读写夹具。 */
function projectFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'android-local-config-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, filename: path.join(root, '.vscode', 'android-ide.local.json') };
}

/** 写入指定项目的JSON测试输入，返回原文用于不写回断言；生产模块不获得此辅助函数。 */
function writeConfig(project, value) {
  const content = JSON.stringify(value);
  fs.mkdirSync(path.dirname(project.filename), { recursive: true });
  fs.writeFileSync(project.filename, content);
  return content;
}

/**
 * 以esbuild/VM装载真实入口；仅放行实际fs读取和path，禁止设置访问及任何文件写操作。
 * 传入可控工作区和可选读取错误，输出宿主对象用于严格深比较；下列各用例验证生产行为。
 */
function loadReader(options = {}) {
  const reads = [];
  const forbidden = () => assert.fail('Project local config must not read settings or write files');
  const localFs = new Proxy({
    readFileSync(filename, encoding) {
      reads.push(filename);
      if (options.readError) throw options.readError;
      return fs.readFileSync(filename, encoding);
    },
  }, {
    get(target, key) {
      if (key === '__esModule') return undefined;
      return Object.hasOwn(target, key) ? target[key] : forbidden;
    },
  });
  const vscode = options.vscode ?? {
    window: { activeTextEditor: options.editor },
    workspace: {
      workspaceFolders: options.folders,
      getWorkspaceFolder(uri) {
        assert.equal(uri, options.editor.document.uri);
        return options.activeFolder;
      },
      getConfiguration: forbidden,
    },
  };
  const module = { exports: {} };
  vm.runInNewContext(code, {
    module, exports: module.exports,
    require(id) {
      if (id === 'vscode') return vscode;
      if (id === 'node:fs') return localFs;
      if (id === 'node:path') return path;
      return assert.fail('Unexpected dependency: ' + id);
    },
  });
  return {
    reads,
    read(root) { return JSON.parse(JSON.stringify(module.exports.readProjectLocalConfig(root))); },
  };
}

// 回归入口统一为 node --test tests/project-local-config.test.js；Node>=22，esbuild来自现有开发依赖。
// 索引：readProjectLocalConfig -> configObject/configPath；各用例分别断言缺失/解析/校验/路径/选择/只读/异常。

// 缺少目录或文件均返回{}，不得创建配置、回退设置或读取其他项目文件。
test('absent local config returns empty without creating files or consulting settings', t => {
  const p = projectFixture(t);
  const reader = loadReader();
  assert.deepEqual(reader.read(p.root), {});
  assert.equal(fs.existsSync(path.dirname(p.filename)), false);
  fs.mkdirSync(path.dirname(p.filename));
  assert.deepEqual(reader.read(p.root), {});
  assert.deepEqual(fs.readdirSync(path.dirname(p.filename)), []);
  assert.deepEqual(reader.reads, [p.filename, p.filename]);
});

// 严格JSON拒绝空文件、截断、注释和尾逗号；诊断必须包含准确文件名，不吞解析异常。
test('malformed or non-plain JSON is reported with the local config filename', t => {
  const p = projectFixture(t);
  fs.mkdirSync(path.dirname(p.filename));
  const reader = loadReader();
  for (const content of ['', '{', '{"sdkPath":"sdk",}', '//comment\n{}']) {
    fs.writeFileSync(p.filename, content);
    assert.throws(() => reader.read(p.root), error => {
      assert.ok(error.message.includes(p.filename));
      assert.match(error.message, /invalid JSON/);
      assert.ok(error.cause);
      return true;
    });
  }
});

// 顶层/debugger必须是对象，所有路径字段必须为字符串；null/数字/数组/对象不可默认为缺失。
test('invalid objects and non-string path fields are rejected with field diagnostics', t => {
  const p = projectFixture(t);
  const reader = loadReader();
  const invalid = [null, [], 'sdk', 42, true].map(value => [value, 'config']);
  for (const value of [null, [], 'debugger', 42, false]) invalid.push([{ debugger: value }, 'debugger']);
  for (const key of ['sdkPath', 'scrcpyPath', 'downloadDirectory', 'adbPath', 'lldbDapPath', 'ndkPath']) {
    for (const value of [null, false, 1, [], {}]) {
      invalid.push([['sdkPath', 'scrcpyPath', 'downloadDirectory'].includes(key) ? { [key]: value } : { debugger: { [key]: value } }, key]);
    }
  }
  for (const [config, field] of invalid) {
    writeConfig(p, config);
    assert.throws(() => reader.read(p.root), error => {
      assert.ok(error.message.includes(p.filename));
      assert.ok(error.message.includes(field));
      assert.match(error.message, /must be a (JSON object|string)/);
      return true;
    });
  }
});

// 拼写错误及危险键同样拒绝，避免把配置误认为生效或污染返回对象。
test('unknown top-level and debugger keys fail clearly rather than being ignored', t => {
  const p = projectFixture(t);
  const reader = loadReader();
  for (const [value, field] of [
    [{ sdkpath: 'sdk' }, 'sdkpath'],
    [{ adbPath: 'adb' }, 'adbPath'],
    [{ debugger: { lldbDAPPath: 'lldb' } }, 'debugger.lldbDAPPath'],
    [JSON.parse('{"__proto__":{}}'), '__proto__'],
    [{ debugger: { constructor: 'adb' } }, 'debugger.constructor'],
  ]) {
    writeConfig(p, value);
    assert.throws(() => reader.read(p.root), error => {
      assert.ok(error.message.includes(p.filename));
      assert.ok(error.message.includes(field));
      assert.match(error.message, /unknown field/);
      return true;
    });
  }
});

// 所有相对字段基于项目根而非.vscode或cwd；Unicode/空格保留，绝对路径原样保留。
test('relative and absolute paths preserve Unicode and spaces for every supported field', t => {
  const p = projectFixture(t);
  const reader = loadReader();
  const relative = '本机 工具/工具 路径';
  const absolute = path.join(p.root, '绝对 工具', '..', '保留 路径');
  for (const value of [relative, absolute, '../共享 工具']) {
    writeConfig(p, { sdkPath: value, scrcpyPath: value, downloadDirectory: value, debugger: { adbPath: value, lldbDapPath: value, ndkPath: value } });
    const expected = path.isAbsolute(value) ? value : path.resolve(p.root, value);
    assert.deepEqual(reader.read(p.root), { sdkPath: expected, scrcpyPath: expected, downloadDirectory: expected, debugger: { adbPath: expected, lldbDapPath: expected, ndkPath: expected } });
  }
  // 不规范化绝对路径中的点段，也不去掉非空路径首尾可能有意义的空格。
  const preserved = p.root + path.sep + '工具' + path.sep + '..' + path.sep + 'adb';
  writeConfig(p, { sdkPath: preserved, scrcpyPath: preserved, downloadDirectory: ' spaced directory ' });
  assert.deepEqual(reader.read(p.root), { sdkPath: preserved, scrcpyPath: preserved, downloadDirectory: path.resolve(p.root, ' spaced directory ') });
});

// 空/纯空白字符串只表示未指定，空debugger不会生成虚假配置；合法字段仍保留。
test('symbol search paths preserve relative paths and reject non-string entries', t => {
  const p = projectFixture(t); const reader = loadReader();
  writeConfig(p, { debugger: { symbolSearchPaths: ['symbols/one', 'symbols/two'] } });
  assert.deepEqual(reader.read(p.root), { debugger: { symbolSearchPaths: [path.resolve(p.root, 'symbols/one'), path.resolve(p.root, 'symbols/two')] } });
  writeConfig(p, { debugger: { symbolSearchPaths: ['symbols/one', 42] } });
  assert.throws(() => reader.read(p.root), /debugger.symbolSearchPaths must be a string array/);
});

// 空/纯空白字符串只表示未指定，空debugger不会生成虚假配置；合法字段仍保留。
test('empty values are unspecified without losing non-empty debugger fields', t => {
  const p = projectFixture(t);
  const reader = loadReader();
  for (const value of ['', '  ', '\t\r\n']) {
    writeConfig(p, { sdkPath: value, downloadDirectory: value, debugger: { adbPath: value, lldbDapPath: value, ndkPath: value } });
    assert.deepEqual(reader.read(p.root), {});
  }
  writeConfig(p, { debugger: {} });
  assert.deepEqual(reader.read(p.root), {});
  writeConfig(p, { debugger: { adbPath: '', ndkPath: 'ndk' } });
  assert.deepEqual(reader.read(p.root), { debugger: { ndkPath: path.resolve(p.root, 'ndk') } });
});

// 显式项目根不触碰工作区API，不在不同项目间缓存/串用配置，不读settings/local.properties等回退。
test('explicit roots are isolated from active workspace and each other with no settings fallback or writes', t => {
  const first = projectFixture(t);
  const second = projectFixture(t);
  const original = writeConfig(first, { sdkPath: 'first sdk' });
  writeConfig(second, { debugger: { adbPath: 'second adb' } });
  fs.writeFileSync(path.join(first.root, 'local.properties'), 'sdk.dir=must-not-read');
  fs.writeFileSync(path.join(first.root, '.vscode', 'settings.json'), '{"android-ide.sdkPath":"must-not-read"}');
  const reader = loadReader({ vscode: {
    get window() { assert.fail('Explicit root must not access VS Code window'); },
    get workspace() { assert.fail('Explicit root must not access VS Code workspace'); },
  } });
  assert.deepEqual(reader.read(first.root), { sdkPath: path.resolve(first.root, 'first sdk') });
  assert.deepEqual(reader.read(second.root), { debugger: { adbPath: path.resolve(second.root, 'second adb') } });
  assert.equal(fs.readFileSync(first.filename, 'utf8'), original);
  fs.unlinkSync(first.filename);
  assert.deepEqual(reader.read(first.root), {});
  assert.deepEqual(reader.reads, [first.filename, second.filename, first.filename]);
});

// 活动编辑器归属优先于工作区排序；无归属只允许唯一根，无工作区或多根歧义时不读取文件。
test('workspace selection supports active, sole, absent, and ambiguous multi-root contexts', t => {
  const first = projectFixture(t);
  const second = projectFixture(t);
  writeConfig(first, { sdkPath: 'first' });
  writeConfig(second, { sdkPath: 'second' });
  const folders = [first, second].map(p => ({ uri: { fsPath: p.root } }));
  const editor = { document: { uri: { fsPath: path.join(second.root, 'Main.kt') } } };
  assert.deepEqual(loadReader({ folders, editor, activeFolder: folders[1] }).read(), { sdkPath: path.resolve(second.root, 'second') });
  assert.deepEqual(loadReader({ folders: [folders[0]] }).read(), { sdkPath: path.resolve(first.root, 'first') });
  assert.deepEqual(loadReader({ folders: [folders[0]], editor }).read(), { sdkPath: path.resolve(first.root, 'first') });
  for (const options of [{}, { folders: [] }, { folders }, { folders, editor }, { vscode: {} }]) {
    const reader = loadReader(options);
    assert.deepEqual(reader.read(), {});
    assert.deepEqual(reader.reads, []);
  }
});

// 使用真实目录读取错误和明确EACCES/EIO替身，验证只有ENOENT被当成缺失，其他错误携带cause。
test('non-ENOENT IO errors surface with filename and original cause', t => {
  const p = projectFixture(t);
  fs.mkdirSync(p.filename, { recursive: true });
  assert.throws(() => loadReader().read(p.root), error => {
    assert.ok(error.message.includes(p.filename));
    assert.match(error.message, /cannot read/);
    assert.ok(error.cause.code);
    assert.notEqual(error.cause.code, 'ENOENT');
    return true;
  });
  for (const code of ['EACCES', 'EIO']) {
    const failure = Object.assign(new Error('test IO failure'), { code });
    const reader = loadReader({ readError: failure });
    assert.throws(() => reader.read(p.root), error => {
      assert.ok(error.message.includes(p.filename));
      assert.equal(error.cause, failure);
      return true;
    });
  }
});
