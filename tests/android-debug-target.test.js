/**
 * 功能点：公开Android目标映射与宿主启动身份。
 * 受影响对象：index.createAndroidDebugConfiguration/startAndroidDebugging及startup配置取消。
 * 复现路径：Node>=22，加载真实index、autoConfig及startup，替换VS Code事件边界。
 * 测试范围：六模式、显式PID、外部配置、输入隔离、非法身份、精确宿主start及失败。
 * 执行入口：node --test tests/android-debug-target.test.js。
 * 预期结果：目标只映射公开字段，不依赖已删除prepareTarget或coordinator会话类。
 * 判据：配置结果、输入不变、宿主调用与返回会话身份全部符合断言。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { transformSync } = require('esbuild');

/** 功能：加载真实公开入口；输入可控宿主启动函数；输出API、事件与调用账本。 */
function fixture() {
  const starts = new Set(), ends = new Set(), f = { calls: [], commands: [] };
  const vscode = { workspace: { isTrusted: true }, commands: { executeCommand: async name => f.commands.push(name) }, window: { showErrorMessage: () => assert.fail('不得隐藏宿主错误') }, debug: {
    onDidStartDebugSession(listener) { starts.add(listener); return { dispose: () => starts.delete(listener) }; },
    onDidTerminateDebugSession(listener) { ends.add(listener); return { dispose: () => ends.delete(listener) }; },
    async startDebugging(folder, config) { f.calls.push([folder, config]); return f.start(folder, config); },
    stopDebugging: async () => assert.fail('成功目标不得被停止'),
  } };
  const startup = require('./debug-startup-loader.cjs')(), deps = { vscode, './startup': startup, './autoConfig': require('./auto-config-loader.cjs')() }, module = { exports: {} };
  vm.runInNewContext(transformSync(fs.readFileSync(path.join(__dirname, '../src/android-debugger/index.ts'), 'utf8'), { loader: 'ts', format: 'cjs' }).code,
    { module, exports: module.exports, AbortController, AggregateError, console, require(id) { assert.ok(Object.hasOwn(deps, id), id); return deps[id]; } });
  return Object.assign(f, { api: module.exports, startup, vscode, starts, ends });
}

// 功能：映射六种内置模式；输入显式目标及auto模板；输出精确Attach并保持模板不变。
test('public mapping preserves all six modes and exact PID without runtime markers', () => {
  const { api } = fixture();
  for (const config of api.getAndroidDebugConfigurations()) {
    const original = JSON.stringify(config), mapped = api.createAndroidDebugConfiguration(config, { serial: 'phone:5555', pid: 42, packageName: 'com.example.app' });
    assert.equal(mapped.request, 'attach'); assert.equal(mapped.pid, 42); assert.equal(mapped.processId, 42);
    assert.equal(mapped.serial, 'phone:5555'); assert.equal(mapped.target, 'phone:5555'); assert.equal(mapped.packageName, 'com.example.app'); assert.equal(mapped.mode, config.mode);
    assert.equal(JSON.stringify(config), original);
    assert.equal(Object.keys(mapped).some(key => /token|signal|registry|parentSession/i.test(key)), false);
    if (mapped.native) assert.notEqual(mapped.native, config.native);
    if (mapped.java) assert.notEqual(mapped.java, config.java);
  }
});

// 功能：外部选项和显式包名不能被覆盖；输入用户LLDB配置与目标；输出原选项和精确身份。
test('public target mapping keeps external adapter options and explicit package name', () => {
  const { api } = fixture(), config = { type: 'lldb', request: 'attach', name: 'User', packageName: 'com.user.app', initCommands: ['user command'], stopOnEntry: true };
  const mapped = api.createAndroidDebugConfiguration(config, { serial: 'phone', processId: 77, packageName: 'com.other.app' });
  assert.equal(mapped.type, 'lldb'); assert.equal(mapped.packageName, 'com.user.app'); assert.equal(mapped.stopOnEntry, true); assert.equal(mapped.initCommands, config.initCommands);
  assert.equal(mapped.pid, 77); assert.equal(mapped.processId, 77); assert.equal(config.serial, undefined);
});

// 功能：在宿主启动前拒绝非法身份；输入串号、PID别名和模式边界；输出明确异常。
test('public target validation rejects unsafe serial PID aliases and unsupported modes', () => {
  const { api } = fixture(), config = { type: 'android-debug', request: 'attach', name: 'Target' };
  for (const serial of ['', 'phone;id', 'bad serial']) assert.throws(() => api.createAndroidDebugConfiguration(config, { serial }), /serial/);
  for (const pid of [0, -1, 1.5, '42', Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => api.createAndroidDebugConfiguration(config, { serial: 'phone', pid }), /process id/);
  assert.throws(() => api.createAndroidDebugConfiguration(config, { serial: 'phone', pid: 41, processId: 42 }), /Conflicting/);
  assert.throws(() => api.createAndroidDebugConfiguration(config, { serial: 'phone', mode: 'invalid' }), /Unsupported/);
  assert.throws(() => api.createAndroidDebugConfiguration({ ...config, type: 'android-tools' }, { serial: 'phone', mode: 'java' }), /Only Android Native/);
  assert.throws(() => api.createAndroidDebugConfiguration({ ...config, request: 'invalid' }, { serial: 'phone' }), /Invalid Android/);
});

// 功能：返回真实主会话而非空父；输入外来事件与精确start；输出所属会话并释放配置登记。
test('public startup returns exact main identity and ignores foreign or child starts', async () => {
  const f = fixture(), config = { type: 'android-debug', request: 'attach', name: 'Target', mode: 'java' }, folder = { uri: { fsPath: '/workspace' } };
  let owned;
  f.start = async (_folder, mapped) => {
    assert.ok(f.startup.debugStartupSignal(mapped));
    owned = { id: 'owned', configuration: mapped };
    for (const listener of f.starts) { listener({ id: 'foreign', configuration: { ...mapped, serial: 'other' } }); listener({ id: 'child', parentSession: owned, configuration: mapped }); listener(owned); }
    return true;
  };
  assert.equal(await f.api.startAndroidDebugging(folder, config, { serial: 'phone', pid: 42, packageName: 'com.example.app' }), owned);
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0][0], folder);
  assert.deepEqual(f.commands, ['workbench.view.debug']); assert.equal(f.starts.size, 0); assert.equal(f.ends.size, 0);
  assert.equal(f.startup.debugStartupSignal(f.calls[0][1]), undefined);
});

// 功能：宿主拒绝不得伪装启动成功；输入false、缺start及不可信工作区；输出可见失败和零残留。
test('public startup rejects host refusal missing start and untrusted workspace', async () => {
  for (const success of [false, true]) {
    const f = fixture(); f.start = async () => success;
    await assert.rejects(f.api.startAndroidDebugging(undefined, { type: 'android-jvm', request: 'attach', name: 'Direct', android: true }, { serial: 'phone' }), success ? /did not report a start event/ : /did not start/);
    assert.equal(f.starts.size, 0); assert.equal(f.ends.size, 0); assert.deepEqual(f.commands, []);
  }
  const f = fixture(); f.vscode.workspace.isTrusted = false;
  await assert.rejects(f.api.startAndroidDebugging(undefined, {}, { serial: 'phone' }), /not trusted/); assert.deepEqual(f.calls, []);
});
