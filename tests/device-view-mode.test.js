const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { transformSync } = require('esbuild');

// 执行真实提供方及轻量Explorer，模式测试可无设备运行，断言唯一模式/停止/保存和消息错误。
function fixture(mode = 'mirror') {
  const messages = [], saved = [], context = [], started = [], module = { exports: {} };
  const deps = { vscode: { commands: { executeCommand: async () => {} } }, './sdk': { listDevices: async () => [{ serial: 'phone', state: 'device' }] }, './emulatorGrpc': {}, './scrcpy': {}, './skin': { skinForAvd: () => undefined } };
  vm.runInNewContext(transformSync(fs.readFileSync(path.join(__dirname, '../src/runningDevices.ts'), 'utf8'), { loader: 'ts', format: 'cjs' }).code, { module, exports: module.exports, process, Buffer, AbortController, setTimeout, clearTimeout, clearInterval, require: id => Object.hasOwn(deps, id) ? deps[id] : require(id) });
  const preference = { mode, visible: mode === 'mirror', save: async visible => saved.push(visible), saveMode: async value => saved.push(value) };
  const explorer = { setContext: async (serial, visible, surface = 'files') => context.push([serial, visible, surface]), handle: async m => messages.push({ handled: m.action }) };
  const view = new module.exports.RunningDeviceView('', undefined, preference, undefined, explorer);
  view.view = { visible: true, webview: { postMessage: m => messages.push(m) } }; view.serial = 'phone'; view.pickMode = () => 'screencap'; view.startScreencap = () => { started.push(view.serial); view.loop = {}; };
  return { view, messages, saved, context, started, preference };
}

// 显示互斥但60秒内保留连接，切回不start；明确stop后才重连，握手仍含完整模式，精确计时见view-idle。
test('device view mode owns mutually exclusive surfaces and preserves selected device', async () => {
  const f = fixture(); let stopped = 0; f.view.session = { connected: true, stop: () => stopped++ }; f.view.mirrorConnection = { serial: 'phone', controller: new AbortController() };
  await f.view.onMessage({ type: 'setDeviceViewMode', mode: 'explorer' });
  assert.equal(stopped, 0); assert.equal(f.view.mirrorVisible, false); assert.equal(f.view.serial, 'phone');
  assert.deepEqual(f.saved, ['explorer']); assert.deepEqual(f.context.at(-1), ['phone', true, 'files']);
  assert.equal(f.started.length, 0);
  await f.view.onMessage({ type: 'setDeviceViewMode', mode: 'processes' });
  assert.deepEqual(f.context.at(-1), ['phone', true, 'processes']);
  assert.equal(f.view.mirrorVisible, false); assert.equal(f.started.length, 0);
  await f.view.onMessage({ type: 'getMirrorVisibility' }); assert.equal(f.messages.at(-1).mode, 'processes');
  await f.view.onMessage({ type: 'setDeviceViewMode', mode: 'hidden' });
  assert.deepEqual(f.context.at(-1), ['phone', false, 'files']);
  await f.view.onMessage({ type: 'setDeviceViewMode', mode: 'mirror' });
  assert.deepEqual(f.started, []);
  await f.view.onMessage({ type: 'setDeviceViewMode', mode: 'mirror' }); assert.equal(f.started.length, 0);
  f.view.stopMirroring(); assert.equal(stopped, 1); await f.view.applyDeviceViewMode('mirror'); assert.equal(f.started.length, 1);
  assert.deepEqual(f.saved, ['explorer', 'processes', 'hidden', 'mirror']);
});

// 保存失败不能改变选中项；外部设置不回写，隐藏宿主不会激活Explorer或视频。
test('device view mode restores preference rejects invalid input and propagates save failure', async () => {
  const f = fixture('explorer'); assert.equal(f.view.mirrorVisible, false);
  await f.view.onMessage({ type: 'ready' }); assert.deepEqual(f.context.at(-1), ['phone', true, 'files']);
  f.preference.saveMode = async () => { throw new Error('settings locked'); };
  await assert.rejects(f.view.onMessage({ type: 'setDeviceViewMode', mode: 'mirror' }), /settings locked/);
  assert.equal(f.view.deviceViewMode, 'explorer');
  await f.view.applyDeviceViewMode('hidden'); assert.equal(f.saved.length, 0);
  await assert.rejects(f.view.onMessage({ type: 'setDeviceViewMode', mode: 'both' }), /Invalid device view mode/);
  f.view.view.visible = false; await f.view.applyDeviceViewMode('explorer');
  assert.deepEqual(f.context.at(-1), ['phone', false, 'files']);
  await f.view.onMessage({ type: 'explorer', action: 'ready' }); assert.equal(f.messages.at(-1).handled, 'ready');
});

// 执行真实面板脚本：三个图标共用模式，任意顺序切换都互斥，再点选中项隐藏，日志仍可用。
test('grouped view toggles route three states without resizing controls', () => {
  const nodes = {}, sent = []; let receive;
  const get = id => nodes[id] ||= { value: '', children: [], classList: { toggle() {} }, setAttribute(k,v) { this[k] = v; }, replaceChildren() { this.children = []; }, appendChild(v) { this.children.push(v); } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../media/build-panel.js'), 'utf8'), { document: { body: { dataset: { deviceViewMode: 'explorer' }, classList: { toggle() {} } }, getElementById: get, createElement: () => ({}) }, send: m => sent.push(m), addEventListener: (t, fn) => { receive = m => fn({ data: m }); } });
  assert.equal(get('build-explorer')['aria-pressed'], 'true'); assert.equal(get('build-mirror')['aria-pressed'], 'false'); assert.equal(get('device-explorer').hidden, false);
  get('build-explorer').onclick(); assert.equal(sent.at(-1).mode, 'hidden');
  receive({ type: 'deviceViewMode', mode: 'hidden' }); assert.equal(get('device-explorer').hidden, true);
  get('build-mirror').onclick(); assert.equal(sent.at(-1).mode, 'mirror');
  receive({ type: 'deviceViewMode', mode: 'mirror' }); assert.equal(get('build-mirror')['aria-pressed'], 'true'); assert.equal(get('build-explorer')['aria-pressed'], 'false');
  get('build-processes').onclick(); assert.equal(sent.at(-1).mode, 'processes');
  receive({ type: 'deviceViewMode', mode: 'processes' });
  assert.equal(get('build-processes')['aria-pressed'], 'true'); assert.equal(get('build-explorer')['aria-pressed'], 'false'); assert.equal(get('build-mirror')['aria-pressed'], 'false');
  assert.equal(get('device-explorer').hidden, false);
  get('build-processes').onclick(); assert.equal(sent.at(-1).mode, 'hidden');
  receive({ type: 'deviceViewMode', mode: 'hidden' });
  for (const id of ['build-mirror','build-explorer','build-processes']) assert.equal(get(id)['aria-pressed'], 'false');
  assert.equal(get('device-explorer').hidden, true);
  assert.equal(get('build-logcat').disabled, false);
});

// Processes重建后恢复独立进程区域，清除设备和隐藏宿主不改模式，也不启动镜像。
test('independent Processes mode restores and routes device changes without mirror',async()=>{
  const f=fixture('processes');await f.view.onMessage({type:'ready'});
  assert.deepEqual(f.context.at(-1),['phone',true,'processes']);assert.equal(f.started.length,0);
  assert.equal(f.messages.findLast(m=>m.type==='mirrorVisibility').mode,'processes');
  await f.view.select();assert.deepEqual(f.context.at(-1),[undefined,true,'processes']);assert.equal(f.view.deviceViewMode,'processes');
  f.view.view.visible=false;await f.view.refresh();assert.deepEqual(f.context.at(-1),[undefined,false,'files']);assert.equal(f.started.length,0);
});
// 模板必须按顺序包含三图标和分隔组；枚举包含processes而不是仅在前端加按钮。
test('Processes icon follows Explorer inside the separated group and setting schema',()=>{
  const html=fs.readFileSync(path.join(__dirname,'../src/runningDevices.ts'),'utf8');
  assert.ok(html.indexOf('id="build-explorer"')<html.indexOf('id="build-processes"'));
  assert.ok(html.indexOf('class="build-view-separator"')<html.indexOf('class="build-view-modes"'));
  assert.ok(html.includes('codicon-server-process'));
  assert.deepEqual(require('../package.json').contributes.configuration.properties['android.deviceViewMode'].enum,['mirror','explorer','processes','hidden']);
});
