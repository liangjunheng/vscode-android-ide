const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { transformSync } = require('esbuild');

// 加载真实投屏类，只替换宿主和视频源；npm test controls 回归验证当前设备、资源和显示生命周期。
function fixture(preference) {
  const calls = [], messages = [], started = [], module = { exports: {} };
  const deps = {
    vscode: { commands: { executeCommand: (...args) => calls.push(args) } },
    './sdk': { listDevices: async () => [{ serial: 'phone', state: 'device' }, { serial: 'two', state: 'device' }] },
    './emulatorGrpc': {}, './scrcpy': {}, './skin': { skinForAvd: () => undefined },
  };
  const source = fs.readFileSync(path.join(__dirname, '../src/runningDevices.ts'), 'utf8');
  vm.runInNewContext(transformSync(source, { loader: 'ts', format: 'cjs' }).code, { module, exports: module.exports, Buffer, process, require: id => Object.hasOwn(deps, id) ? deps[id] : require(id) });
  const view = new module.exports.RunningDeviceView(path.join(__dirname, '..'), undefined, preference);
  view.view = { visible: true, webview: { postMessage: m => messages.push(m) } };
  view.pickMode = () => 'screencap';
  view.startScreencap = () => started.push(view.serial);
  return { view, calls, messages, started };
}

// npm test：Logcat 复用打包的 Android Studio 图标，只打开当前设备，命令失败向调用方传播。
test('mirror controls use bundled Android Studio Logcat icon and selected device', async () => {
  const f = fixture();
  assert.equal(f.view.icons().logcat, fs.readFileSync(path.join(__dirname, '../media/icons/logcat.svg'), 'utf8'));
  await f.view.onMessage({ type: 'logcat' });
  assert.equal(f.calls[0][0], 'android.showLogcat');
  assert.equal(f.calls[0][1], undefined);
  f.view.serial = 'phone';
  await f.view.onMessage({ type: 'logcat' });
  assert.equal(f.calls[0][0], 'android.showLogcat');
  assert.equal(f.calls[1][1].serial, 'phone');
});

// npm test：隐藏释放视频源但保留设备，设备切换仍更新目录，显示后恢复最新设备，不重复启动或改变构建。
test('mirror controls hide stop preserve selection and resume the latest device', async () => {
  const f = fixture(); let stops = 0;
  f.view.serial = 'phone'; f.view.session = { stop: () => stops++ };
  await f.view.onMessage({ type: 'setMirrorVisibility', visible: false });
  assert.equal(stops, 1);
  assert.equal(f.view.serial, 'phone');
  assert.equal(f.messages.at(-1).visible, false);
  await f.view.onMessage({ type: 'setMirrorVisibility', visible: false });
  assert.equal(stops, 1);
  await f.view.onMessage({ type: 'select', serial: 'two' });
  assert.equal(f.view.serial, 'two'); assert.equal(f.started.length, 0);
  assert.equal(f.messages.filter(m => m.type === 'devices').at(-1).serial, 'two');
  await f.view.onMessage({ type: 'setMirrorVisibility', visible: true });
  assert.deepEqual(f.started, ['two']);
  await f.view.onMessage({ type: 'setMirrorVisibility', visible: true });
  assert.equal(f.started.length, 1);
  await assert.rejects(f.view.onMessage({ type: 'setMirrorVisibility', visible: 'false' }), /Invalid mirror/);
  assert.equal(f.view.mirrorVisible, true);
  await f.view.onMessage({ type: 'setMirrorVisibility', visible: false });
  await f.view.onMessage({ type: 'ready' });
  assert.equal(f.messages.findLast(m => m.type === 'mirrorVisibility').visible, false);
  assert.equal(f.started.length, 1);
});

// npm test：保存按钮状态后重建投屏类，ready 仍回传隐藏；保存失败不变更 UI，设置页同步不会重复写入。
test('mirror preference persists and restores visibility without false success', async () => {
  const saved = [], setting = { visible: false, save: async value => { saved.push(value); setting.visible = value; } };
  const f = fixture(setting);
  await f.view.onMessage({ type: 'getMirrorVisibility' });
  assert.equal(f.messages.at(-1).visible, false);
  f.view.serial = 'phone';
  await f.view.onMessage({ type: 'ready' });
  assert.equal(f.messages.find(m => m.type === 'mirrorVisibility').visible, false);
  assert.equal(f.started.length, 0);
  await f.view.onMessage({ type: 'setMirrorVisibility', visible: true });
  assert.deepEqual(saved, [true]);
  assert.equal(f.started.length, 1);
  await f.view.onMessage({ type: 'setMirrorVisibility', visible: false });
  assert.deepEqual(saved, [true, false]);
  const restored = fixture(setting);
  await restored.view.onMessage({ type: 'ready' });
  assert.equal(restored.messages.find(m => m.type === 'mirrorVisibility').visible, false);
  await restored.view.applyMirrorVisibility(true);
  assert.deepEqual(saved, [true, false]);
  assert.equal(restored.view.mirrorVisible, true);
  setting.save = async () => { throw new Error('Settings write failed'); };
  await assert.rejects(restored.view.onMessage({ type: 'setMirrorVisibility', visible: false }), /Settings write failed/);
  assert.equal(restored.view.mirrorVisible, true);
  assert.notEqual(restored.messages.at(-1)?.visible, false);
});
