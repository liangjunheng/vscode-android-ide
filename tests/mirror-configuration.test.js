const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { transformSync } = require('esbuild');

// 执行真实 activate 配置接线，模拟 VS Code 有效值及更新目标；npm test 回归断言重启恢复、工作区优先和资源释放。
function fixture() {
  const f = { value: false, workspaceValue: undefined, writes: [], applied: [], errors: [], instances: [], subscriptions: [], fail: false };
  const listener = { disposed: false, dispose() { this.disposed = true; } };
  const vscode = {
    ConfigurationTarget: { Global: 1, Workspace: 2 },
    workspace: {
      getConfiguration: () => ({
        get: (key, fallback) => key === 'mirrorVisible' ? f.value : fallback,
        inspect: () => ({ workspaceValue: f.workspaceValue }),
        update: async (key, value, target) => { if (f.fail) throw new Error('read-only settings'); f.writes.push({ key, value, target }); f.value = value; },
      }),
      onDidChangeConfiguration: fn => { f.listener = fn; return listener; },
    },
    commands: { registerCommand() {} }, window: { registerWebviewViewProvider() {}, showErrorMessage: error => f.errors.push(error) },
  };
  class Running {
    constructor(ext, action, preference) { this.preference = preference; f.instances.push(this); }
    async applyMirrorVisibility(visible) { if (f.rejectApply) throw new Error('stream failed'); f.applied.push(visible); }
  }
  const deps = { vscode, './runningDevices': { RunningDeviceView: Running }, './androidBuild': { AndroidBuildController: class { dispose() {} } }, './logcat': { LogcatView: class {} }, './deviceManager': { registerDeviceManager() {} }, './extendedControls': {} };
  const module = { exports: {} };
  vm.runInNewContext(transformSync(fs.readFileSync(path.join(__dirname, '../src/extension.ts'), 'utf8'), { loader: 'ts', format: 'cjs' }).code, { module, exports: module.exports, require: id => deps[id] });
  f.activate = () => module.exports.activate({ extensionPath: '', subscriptions: f.subscriptions });
  f.disposable = listener;
  return f;
}

// npm test：按钮默认写用户配置，已有工作区覆盖时只更新覆盖值，配置写入失败向按钮传播。
test('mirror configuration remembers visibility and respects workspace overrides', async () => {
  const f = fixture(); f.activate();
  assert.equal(f.instances[0].preference.visible, false);
  await f.instances[0].preference.save(true);
  assert.equal(f.writes[0].key, 'mirrorVisible');
  assert.equal(f.writes[0].target, 1);
  f.workspaceValue = false;
  await f.instances[0].preference.save(false);
  assert.equal(f.writes[1].target, 2);
  f.activate();
  assert.equal(f.instances[1].preference.visible, false);
  f.fail = true;
  await assert.rejects(f.instances[1].preference.save(true), /read-only/);
  assert.equal(f.value, false);
});

// npm test：设置页只同步相关项，错误可见且监听加入 subscriptions，不产生配置写回循环。
test('mirror configuration changes sync live and own the settings subscription', async () => {
  const f = fixture(); f.activate();
  f.listener({ affectsConfiguration: key => false });
  assert.deepEqual(f.applied, []);
  f.value = true;
  f.listener({ affectsConfiguration: key => key === 'android.mirrorVisible' });
  assert.deepEqual(f.applied, [true]);
  assert.equal(f.writes.length, 0);
  f.rejectApply = true;
  f.listener({ affectsConfiguration: () => true });
  await new Promise(resolve => setImmediate(resolve));
  assert.match(f.errors[0], /stream failed/);
  assert.ok(f.subscriptions.includes(f.disposable));
  f.disposable.dispose(); assert.equal(f.disposable.disposed, true);
});

// npm test：VS Code 布尔配置与 CSS 专用 20px 图标声明可被现有运行器发现并严格断言。
test('mirror configuration schema and enlarged Logcat icon are registered', () => {
  const schema = require('../package.json').contributes.configuration.properties['android.mirrorVisible'];
  assert.equal(schema.type, 'boolean'); assert.equal(schema.default, true); assert.equal(schema.scope, 'window');
  const css = fs.readFileSync(path.join(__dirname, '../media/build-panel.css'), 'utf8');
  assert.match(css, /#build-logcat svg\{width:20px;height:20px;max-width:100%;flex:none\}/);
});
