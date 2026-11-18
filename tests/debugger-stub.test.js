const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { transformSync } = require('esbuild');

// 无设备加载真实接口；仅隔离 VS Code 服务，回归内置未实现提示和外部会话的成功/拒绝及监听释放。
function fixture() {
  const f = { pick: 0, configs: [], starts: [], notices: [], disposed: 0, accept: true };
  const vscode = {
    workspace: { isTrusted: true, getConfiguration: section => { assert.equal(section, 'launch'); return { get: () => f.configs }; } },
    window: { showQuickPick: async items => { f.items = items; return f.pick === undefined ? undefined : items[f.pick]; }, showInformationMessage: async text => { f.notices.push(text); } },
    debug: { onDidStartDebugSession: fn => { f.listener = fn; return { dispose() { f.disposed++; f.listener = undefined; } }; },
      startDebugging: async (folder, config) => { f.starts.push(config); if (f.failure) throw f.failure; if (f.accept) f.listener({ configuration: config, id: 'session' }); return f.accept; } },
  };
  // 编译被测模块，不改变生产 API 或跳过生产分支。
  f.load = file => { const module = { exports: {} }; vm.runInNewContext(transformSync(fs.readFileSync(path.join(__dirname, '../src/android-debugger', file), 'utf8'), { loader: 'ts', format: 'cjs' }).code, { module, exports: module.exports, require: id => id === 'vscode' ? vscode : require(id) }); return module.exports; };
  f.api = f.load('index.ts'); return f;
}

// 三个内置选项保留但不创建任何会话；用户取消保持 undefined。
test('built-in debugger interfaces remain selectable but never start a backend', async () => {
  const f = fixture();
  for (const pick of [0, 1, 2]) { f.pick = pick; const config = await f.api.selectAndroidDebugConfiguration(); assert.equal(config.type, 'android-tools'); assert.equal(await f.api.startAndroidDebugging(undefined, config, { serial: 'phone' }), undefined); }
  assert.equal(f.items.length, 3); assert.equal(f.starts.length, 0); assert.equal(f.notices.length, 3); assert.match(f.notices[0], /暂未实现/);
  f.pick = undefined; assert.equal(await f.api.selectAndroidDebugConfiguration(), undefined);
});

// 外部配置原字段保留，目标设备被传递；会话失败不能伪装成功，订阅始终释放。
test('external debugger still returns real sessions and propagates refusal and errors', async () => {
  const f = fixture(); f.configs = [{ type: 'external', name: 'Attach', request: 'attach', custom: 17 }]; f.pick = 3;
  const config = await f.api.selectAndroidDebugConfiguration(); const session = await f.api.startAndroidDebugging(undefined, config, { serial: 'phone', pid: 42 });
  assert.equal(session.id, 'session'); assert.equal(f.starts[0].custom, 17); assert.equal(f.starts[0].pid, 42); assert.equal(f.disposed, 1);
  f.accept = false; await assert.rejects(f.api.startAndroidDebugging(undefined, config, { serial: 'phone' }), /did not start/); assert.equal(f.disposed, 2);
  f.failure = new Error('adapter failed'); await assert.rejects(f.api.startAndroidDebugging(undefined, config, { serial: 'phone' }), /adapter failed/); assert.equal(f.disposed, 3);
});

// 直接创建内置适配器必须明确失败，不返回丢弃 DAP 请求的空对象。
test('registered built-in factory fails explicitly instead of hanging DAP requests', () => {
  const factory = fixture().load('jvm-debugger/adapter.ts').createAndroidDebugAdapterFactory();
  assert.throws(() => factory.createDebugAdapterDescriptor(), /暂未实现/);
});

// 公共模型解析接口和配置映射接口保留；源码发现的完整行为由 project-model 回归单独验证。
test('debugger configuration and project model public contracts stay available', () => {
  const f = fixture(), api = f.api, model = f.load('projectModel.ts');
  for (const name of ['parseSourceIndex', 'createSourceIndexInitScript', 'discoverVariantSources']) assert.equal(typeof model[name], 'function');
  assert.throws(() => model.parseSourceIndex(null), /Invalid/);
  const original = { name: 'Launch', type: 'external', request: 'launch', custom: 17 };
  const mapped = api.createAndroidDebugConfiguration(original, { serial: 'phone', pid: 42 });
  assert.equal(mapped.request, 'attach'); assert.equal(mapped.processId, 42); assert.equal(original.request, 'launch');
  assert.throws(() => api.createAndroidDebugConfiguration(original, { serial: 'phone', pid: -1 }), /process id/);
  assert.equal(api.getAndroidDebugConfigurations().length, 3);
  assert.equal(api.findAndroidDebugConfiguration(undefined, true).type, 'android-tools');
  assert.equal(api.androidDebugger.startAndroidDebugging, api.startAndroidDebugging);
});
