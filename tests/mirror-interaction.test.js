const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { transformSync } = require('esbuild');
const source = fs.readFileSync(path.join(__dirname, '../src/runningDevices.ts'), 'utf8');

// 转译真实投屏类并创建 Webview 入口，仅替换 VS Code 和设备依赖；返回页面、消息入口与 ADB 调用记录。
function fixture() {
  const calls = [], messages = [], module = { exports: {} };
  let receive, failure, packetHandler;
  const receives = [];
  const sdk = { adb: async (...args) => { calls.push(args); if (failure) throw failure; }, listDevices: async () => [{ serial: 'phone', state: 'device' }], grpcSupported: () => false, grpcPortFor: () => undefined, grpcTokenFor: () => undefined, adbPath: () => 'adb', runBuffer: async () => Buffer.alloc(0) };
  const vscode = { Uri: { file: p => p, joinPath: (...p) => p.join('/') } };
  class Scrcpy {
    constructor(serial, jar, handlers) { packetHandler = handlers; this.connected = true; this.events = []; }
    async start() {}
    stop() {}
    touch(...args) { this.events.push(['touch', ...args]); }
    scroll(...args) { this.events.push(['scroll', ...args]); }
    key(...args) { this.events.push(['key', ...args]); }
    text(...args) { this.events.push(['text', ...args]); }
  }
  const dependencies = { vscode, './sdk': sdk, './emulatorGrpc': { grpcSupported: () => false, grpcPortFor: () => undefined }, './scrcpy': { ScrcpySession: Scrcpy, bundledJar: () => 'jar' }, './skin': { skinForAvd: () => undefined } };
  vm.runInNewContext(transformSync(source, { loader: 'ts', format: 'cjs' }).code, {
    module, exports: module.exports, Buffer, process, console, AbortController,
    require: id => Object.hasOwn(dependencies, id) ? dependencies[id] : require(id),
  });
  const mirror = new module.exports.RunningDeviceView('');
  mirror.icons = () => ({});
  const webview = { cspSource: 'test:', asWebviewUri: p => p, postMessage: m => messages.push(m), onDidReceiveMessage: fn => { receive = fn; receives.push(fn); } };
  mirror.resolveWebviewView({ visible: true, webview, onDidChangeVisibility() {}, onDidDispose() {} });
  return { mirror, calls, messages, receives, html: webview.html, receive: m => receive(m), fail: e => { failure = e; }, packet: (kind, data) => packetHandler.onPacket(kind, Buffer.from(data)) };
}

// 读取生产 CSS 的导航参数，供真实 layout 的 getComputedStyle 使用；避免测试仍模拟旧固定栏高。
function navigationStyle() {
  const values = Object.fromEntries(source.match(/#navigation\{([^}]+)\}/)[1].split(';').filter(Boolean).map(d => { const i = d.indexOf(':'); return [d.slice(0, i), d.slice(i + 1)]; }));
  return { getPropertyValue: name => values[name] };
}

// 保留实际布局写入的图标大小，供窄窗、横竖屏和加载占位的断言读取。
function navigationElement() {
  const svgs = [{ style: {} }, { style: {} }, { style: {} }];
  return { style: { setProperty(name, value) { this[name] = value; } }, svgs, querySelectorAll: () => svgs };
}

// 按输出几何独立断言约束、比例、图标大小及上下 4px 留白；至少宽度或总高度必须贴合可用边界。
function assertNavigationFit(c, width, height, ratio) {
  const w = parseFloat(c.frame.style.width), h = parseFloat(c.frame.style.height);
  const icon = parseFloat(c.navigation.style['--nav-icon-size']);
  const W = Math.max(0, width - 16), H = Math.max(0, height - 8 - c.barEl.offsetHeight);
  assert.equal(c.stage.style.width, c.frame.style.width);
  assert.ok(Math.abs(icon - w * 0.064) < 0.001);
  assert.ok(c.navigation.svgs.every(svg => svg.style.width === `${icon}px` && svg.style.height === `${icon}px`));
  assert.ok(w >= 0 && w <= W + 0.001);
  assert.ok(h >= 0 && h + icon + 8 <= Math.max(H, 8) + 0.001);
  assert.ok(Math.abs(w - W) < 0.001 || Math.abs(h + icon + 8 - H) < 0.001);
  if (h) assert.ok(Math.abs(w / h - ratio) < 0.001);
  return { w, h, icon };
}

// 无设备/三种传输模式下调用真实消息入口，断言只对所选设备发送 WAKEUP，重复点击不使用电源切换，错误可见。
test('mirror wake routes idempotent wake independently of transport and reports failures', async () => {
  const f = fixture();
  await f.receive({ type: 'wake' });
  assert.equal(f.calls.length, 0);
  f.mirror.serial = 'selected-phone';
  for (const mode of ['emulator', 'scrcpy', 'screencap']) {
    f.mirror.emu = mode === 'emulator' ? {} : undefined;
    f.mirror.session = mode === 'scrcpy' ? {} : undefined;
    await f.receive({ type: 'wake' });
    await f.receive({ type: 'wake' });
  }
  assert.equal(f.calls.length, 6);
  for (const call of f.calls) assert.deepEqual(call, ['selected-phone', 'shell', 'input', 'keyevent', 'KEYCODE_WAKEUP']);
  f.fail(new Error('device offline'));
  await f.receive({ type: 'wake' });
  assert.equal(f.messages.at(-1).type, 'error');
  assert.equal(f.messages.at(-1).text, 'device offline');
});

// 嵌入式scrcpy的触摸、滚轮、按键和文本消息必须统一进入当前session，不能落入截图ADB分支。
test('embedded scrcpy input events dispatch to the active session', async () => {
  const f = fixture(), events = [];
  f.mirror.serial = 'phone';
  f.mirror.session = {
    touch: (...args) => events.push(['touch', ...args]),
    scroll: (...args) => events.push(['scroll', ...args]),
    key: (...args) => events.push(['key', ...args]),
    text: (...args) => events.push(['text', ...args]),
  };
  await f.receive({ type: 'touch', action: 2, x: 0.25, y: 0.5, w: 1000, h: 2000 });
  await f.receive({ type: 'scroll', x: 0.25, y: 0.5, v: -1, w: 1000, h: 2000 });
  await f.receive({ type: 'key', code: '3' });
  await f.receive({ type: 'text', text: 'abc' });
  assert.deepEqual(events, [
    ['touch', 2, 250, 1000, 1000, 2000],
    ['scroll', 250, 1000, 1000, 2000, -1],
    ['key', 3],
    ['text', 'abc'],
  ]);
});

// 旧Webview重建后继续发送的输入事件不得进入当前投屏session，避免事件错发到新设备。
test('stale webview events are ignored after the view is replaced', async () => {
  const f = fixture(), first = f.receives[0];
  const events = [];
  f.mirror.serial = 'phone';
  f.mirror.session = { touch: (...args) => events.push(args) };
  const webview = { cspSource: 'test:', asWebviewUri: p => p, postMessage() {}, onDidReceiveMessage: fn => f.receives.push(fn) };
  f.mirror.resolveWebviewView({ visible: true, webview, onDidChangeVisibility() {}, onDidDispose() {} });
  await first({ type: 'touch', action: 0, x: 0.5, y: 0.5, w: 100, h: 200 });
  assert.deepEqual(events, []);
});

// 视频包未收到Webview ACK前不继续发送，待发delta只保留最新包，关键帧优先于过期delta。
test('scrcpy video flow applies latest-frame backpressure', async () => {
  const f = fixture();
  f.mirror.serial = 'phone';
  f.mirror.pickMode = () => 'scrcpy';
  await f.mirror.restart();
  await new Promise(resolve => setImmediate(resolve));
  f.messages.length = 0;
  f.packet('config', [1]);
  f.packet('delta', [2]);
  f.packet('delta', [3]);
  assert.deepEqual(f.messages.map(m => [m.type, m.kind]), [['video', 'config'], ['video', 'delta'], ['video', 'delta']]);
  await f.receive({ type: 'videoAck' });
  f.packet('key', [4]);
  f.packet('delta', [5]);
  await f.receive({ type: 'videoAck' });
  assert.deepEqual(f.messages.map(m => [m.type, m.kind]), [['video', 'config'], ['video', 'delta'], ['video', 'delta'], ['video', 'key'], ['video', 'delta']]);
});

// 执行生成页面的真实 bind/rel 函数；canvas 和 img 分别覆盖主键点击、拖动、右键和释放消息。
test('mirror wake preserves click and drag input in every rendering mode', () => {
  const html = fixture().html;
  const input = html.slice(html.indexOf('const rel='), html.indexOf('bind(img);bind(cv);'));
  for (const mode of ['emulator', 'scrcpy', 'screencap']) {
    for (const tag of ['canvas', 'img']) {
      const sent = [];
      const el = { tag, focus() {}, getBoundingClientRect: () => ({ left: 0, top: 0, width: 200, height: 400 }) };
      const context = { mode, target: el, fw: 1000, fh: 2000, requestAnimationFrame: f => { f(); return 1; }, cancelAnimationFrame: () => {}, send: m => sent.push(JSON.parse(JSON.stringify(m))) };
      vm.runInNewContext(input + ';this.bindElement=bind;', context);
      context.bindElement(el);
      const event = { button: 0, buttons: 1, clientX: 100, clientY: 200, preventDefault() {} };
      el.onmousedown({ ...event, button: 2 });
      el.onmouseup(event);
      assert.equal(sent.length, 0);
      el.onmousedown(event);
      el.onmouseup(event);
      assert.equal(sent[0].type, 'wake');
      if (mode === 'screencap') assert.deepEqual(sent[1], { type: 'tap', x: 0.5, y: 0.5 });
      else assert.deepEqual(sent.slice(1).map(m => [m.type, m.action, m.x, m.y, m.w, m.h]), [['touch', 0, 0.5, 0.5, 1000, 2000], ['touch', 1, 0.5, 0.5, 1000, 2000]]);
      sent.length = 0;
      el.onmousedown(event);
      el.onmousemove({ ...event, clientY: 300 });
      el.onmouseup({ ...event, clientY: 300 });
      assert.equal(sent.filter(m => m.type === 'wake').length, 1);
      if (mode === 'screencap') {
        assert.equal(sent[1].type, 'swipe');
        assert.equal(sent[1].y2, 0.75);
      } else assert.deepEqual(sent.slice(1).map(m => m.action), [0, 2, 1]);
    }
  }
});

// 从真实页面断言响应式图标与上下 4px 留白、上方图标不变，并验证画面与导航共用边界。
test('mirror layout keeps controls immediately above a top-centered screen', () => {
  const html = fixture().html;
  const css = html.slice(html.indexOf('<style>') + 7, html.indexOf('</style>'));
  // 当前样式为平面规则，按声明读取最终属性，避免只匹配到被后续声明覆盖的值。
  const rule = selector => Object.fromEntries(css.split('}').filter(s => s.slice(0, s.indexOf('{')).trim() === selector).flatMap(s => s.slice(s.indexOf('{') + 1).split(';').filter(Boolean).map(d => { const i = d.indexOf(':'); return [d.slice(0, i), d.slice(i + 1)]; })));
  assert.equal(rule('body').gap, '0');
  assert.equal(rule('#bar')['justify-content'], 'space-between');
  assert.equal(rule('#bar')['flex-wrap'], 'nowrap');
  assert.equal(rule('#bar').flex, 'none');
  assert.equal(rule('#bar').width, '100%');
  assert.equal(rule('#bar').padding, '6px 0');
  assert.equal(rule('#bar').height, '43px');
  assert.equal(rule('#bar button').flex, '0 1 30px');
  assert.equal(rule('#bar .tool-group').gap, '2px');
  assert.equal(rule('#bar .tool-group').flex, '0 1 auto');
  assert.equal(rule('#bar .sep').width, '1px');
  assert.equal(rule('#bar .sep').flex, 'none');
  assert.ok(2 * parseFloat(rule('#bar').gap) + parseFloat(rule('#bar .sep').width) > parseFloat(rule('#bar .tool-group').gap));
  assert.equal(rule('#bar button')['min-width'], '0');
  assert.equal(rule('#tabs').flex, 'none');
  assert.equal(rule('#wrap')['align-items'], 'flex-start');
  assert.equal(rule('#wrap')['justify-content'], 'center');
  assert.equal(rule('#wrap').padding, '0 8px 8px');
  assert.equal(rule('#screen,#cv')['object-position'], 'top center');
  assert.equal(rule('#stage')['flex-direction'], 'column');
  assert.equal(rule('#stage').gap, '0');
  assert.equal(rule('#navigation')['grid-template-columns'], 'repeat(3,minmax(0,1fr))');
  assert.equal(rule('#navigation').width, '100%');
  assert.equal(rule('#navigation').height, 'auto');
  assert.equal(rule('#navigation')['--nav-icon-ratio'], '0.064');
  assert.equal(parseFloat(rule('#navigation')['--nav-padding']), 6 * 2 / 3);
  assert.equal(rule('#navigation button').padding, 'var(--nav-padding) 0');
  assert.equal(rule('#navigation button svg').width, 'var(--nav-icon-size)');
  assert.equal(rule('#navigation button svg').height, 'var(--nav-icon-size)');
  assert.equal(rule('button svg').width, '20px');
  assert.equal(rule('button svg').height, '20px');
  assert.equal(rule('#navigation button').width, '100%');
  assert.ok(html.indexOf('id="wrap"') < html.indexOf('id="bar"'));
  assert.ok(html.indexOf('id="bar"') < html.indexOf('id="frame"'));
  const layout = html.slice(html.indexOf('function layout(){'), html.indexOf('let vpT;'));
  for (const [width, height] of [[320, 600], [1200, 900], [600, 240]]) {
    const style = { removeProperty() {}, setProperty() {} };
    const context = { wrapEl: { getBoundingClientRect: () => ({ width, height }) }, skin: null, frameOn: true, skinOn: false, fw: 100, fh: 200, stage: { style: {} }, barEl: { offsetHeight: 43 }, navigation: navigationElement(), getComputedStyle: navigationStyle, frame: { dataset: { state: 'live' }, style: {}, classList: { toggle() {} } }, cv: { width: 100, height: 200, style }, img: { style }, fg: {}, mode: 'emulator', devicePixelRatio: 1, place() {} };
    vm.runInNewContext(layout + ';this.runLayout=layout;', context);
    let result = context.runLayout();
    const plain = assertNavigationFit(context, width, height, 0.5);
    assert.equal(result.w, width - 16);
    assert.ok(Math.abs(result.h - (height - 8 - context.barEl.offsetHeight - 8 - plain.icon)) < 0.001);
    context.skin = { lw: 200, lh: 400, dx: 10, dy: 20, dw: 180, dh: 360, radius: 8 };
    result = context.runLayout();
    const skinned = assertNavigationFit(context, width, height, 0.5);
    assert.ok(Math.abs(result.w - skinned.w * 0.9) < 0.001);
    assert.ok(Math.abs(result.h - skinned.h * 0.9) < 0.001);
    context.frameOn = false;
    context.runLayout();
    assertNavigationFit(context, width, height, 0.5);
  }
});

// 从真实页面提取导航和既有按键绑定，断言三键只出现在画面后、无重复，且发送正确 Android 键码。
test('mirror navigation sits below the frame and retains key commands', async () => {
  const f = fixture(), html = f.html;
  const top = html.slice(html.indexOf('<div id="bar">'), html.indexOf('<div id="frame"'));
  const nav = html.slice(html.indexOf('<div id="navigation"'), html.indexOf('<div id="msg">'));
  const buttons = Array.from(nav.matchAll(/<button data-k="(\d+)"/g), m => ({ dataset: { k: m[1] } }));
  assert.deepEqual(buttons.map(b => b.dataset.k), ['4', '3', '187']);
  for (const b of buttons) {
    assert.ok(!top.includes('data-k="' + b.dataset.k + '"'));
    assert.equal(html.split('data-k="' + b.dataset.k + '"').length - 1, 1);
  }
  assert.match(html, /id="fg"[^>]*><\/div><div id="navigation"/);
  const sent = [];
  const binding = html.split('\n').find(line => line.startsWith("document.querySelectorAll('[data-k]')"));
  vm.runInNewContext(binding, { document: { querySelectorAll: () => buttons }, send: m => sent.push(m) });
  buttons.forEach(b => b.onclick());
  assert.deepEqual(sent.map(m => [m.type, m.code]), [['key', '4'], ['key', '3'], ['key', '187']]);
  f.mirror.serial = 'phone';
  for (const message of sent) await f.receive(message);
  assert.deepEqual(f.calls, ['4', '3', '187'].map(code => ['phone', 'shell', 'input', 'keyevent', code]));
  f.mirror.emu = {};
  for (const message of sent) await f.receive(message);
  assert.equal(f.calls.length, 6);
  f.mirror.emu = undefined;
  const keys = [];
  f.mirror.session = { key: code => keys.push(code) };
  for (const message of sent) await f.receive(message);
  assert.deepEqual(keys, [4, 3, 187]);
});

// 执行三个真实帧入口，验证画面尺寸改变及方向切换都会同步布局，而非等窗口缩放后才更新导航。
test('mirror navigation frame updates follow emulator, video and screenshot dimensions', () => {
  const html = fixture().html;
  let layouts = 0, viewports = 0, output, listener;
  const context = {
    fw: 0, fh: 0, cv: { width: 0, height: 0 }, img: {}, msg: {}, decoder: undefined, setPresentation() {},
    ctx: { putImageData() {}, drawImage() {} }, layout: () => layouts++, sendVp: () => viewports++, send() {},
    ImageData: class {}, VideoDecoder: class { constructor(options) { output = options.output; } },
    addEventListener: (event, fn) => { listener = fn; },
  };
  vm.runInNewContext(html.slice(html.indexOf('function onRgba(m){'), html.indexOf("addEventListener('message',")) + ';this.rgba=onRgba;', context);
  context.rgba({ w: 2, h: 4, data: new Uint8Array(32) });
  assert.equal(layouts, 1);
  context.rgba({ w: 4, h: 2, data: new Uint8Array(32) });
  assert.equal(layouts, 2);
  assert.equal(viewports, 1);
  context.rgba({ w: 4, h: 2, data: new Uint8Array(32) });
  assert.equal(layouts, 2);
  vm.runInNewContext(html.slice(html.indexOf('function newDecoder(){'), html.indexOf('function onConfig(d){')) + ';newDecoder();', context);
  output({ displayWidth: 8, displayHeight: 4, close() {} });
  assert.equal(context.fw, 8);
  assert.equal(layouts, 3);
  vm.runInNewContext(html.slice(html.indexOf("addEventListener('message',"), html.indexOf("send({type:'ready'});")), context);
  listener({ data: { type: 'frame', w: 3, h: 6, data: 'png' } });
  assert.equal(context.fw, 3);
  assert.equal(context.fh, 6);
  assert.equal(context.img.src, 'data:image/png;base64,png');
  assert.equal(layouts, 4);
});


// 真实布局在每种模式和横竖屏下保留导航高度，极小容器不产生负尺寸，皮肤关闭后恢复帧比例。
test('mirror navigation shares exact screen width across rotations and small viewports', () => {
  const html = fixture().html;
  const layout = html.slice(html.indexOf('function layout(){'), html.indexOf('let vpT;'));
  for (const mode of ['emulator', 'scrcpy', 'screencap']) {
    for (const [width, height, fw, fh, skin] of [[320, 600, 1080, 2400, null], [600, 240, 2400, 1080, null], [100, 120, 1080, 2400, { lw: 200, lh: 400, dx: 10, dy: 20, dw: 180, dh: 360, radius: 8 }], [8, 20, 2400, 1080, null]]) {
      const style = { removeProperty() {}, setProperty() {} };
      const context = { wrapEl: { getBoundingClientRect: () => ({ width, height }) }, skin, frameOn: true, skinOn: false, fw, fh, frame: { dataset: { state: 'live' }, style: {}, classList: { toggle() {} } }, stage: { style: {} }, barEl: { offsetHeight: 43 }, navigation: navigationElement(), getComputedStyle: navigationStyle, cv: { style }, img: { style }, fg: {}, mode, place() {} };
      vm.runInNewContext(layout + ';this.runLayout=layout;', context);
      context.runLayout();
      assertNavigationFit(context, width, height, skin ? skin.lw / skin.lh : fw / fh);
      context.frameOn = false;
      context.runLayout();
      assertNavigationFit(context, width, height, fw / fh);
    }
  }
});


// 在 VM 中执行真实布局、状态函数和帧入口，返回可观察 DOM 与回调；仅替换浏览器绘图和宿主。
function loadingFixture() {
  const html = fixture().html;
  const nodes = { placeholder: { hidden: false }, 'placeholder-text': { textContent: '' } };
  const style = { removeProperty() {}, setProperty() {} };
  let output, listener, decoderInstance;
  const decoderState = { queue: 0, decoded: [] };
  const context = {
    document: { getElementById: id => nodes[id] },
    frame: { dataset: { state: 'loading' }, style: {}, classList: { toggle() {} } }, stage: { style: {} },
    barEl: { offsetHeight: 43 }, navigation: navigationElement(), getComputedStyle: navigationStyle, wrapEl: { getBoundingClientRect: () => ({ width: 800, height: 600 }) },
    skin: { lw: 200, lh: 400, dw: 180, dh: 360, dx: 10, dy: 20, radius: 8 }, frameOn: true, skinOn: false,
    fw: 0, fh: 0, cv: { width: 300, height: 150, style }, img: { style }, fg: {}, msg: {}, mode: 'emulator',
    ctx: { putImageData() {}, drawImage() {} }, send() {}, sendVp() {}, place() {},
    ImageData: class {}, EncodedVideoChunk: class { constructor(value) { Object.assign(this, value); } }, performance: { now: () => 1 }, decoder: undefined,
    VideoDecoder: class { constructor(options) { output = options.output; decoderInstance = this; this.state = 'unconfigured'; } configure() { this.state = 'configured'; } close() { this.state = 'closed'; } get decodeQueueSize() { return decoderState.queue; } decode(chunk) { decoderState.decoded.push(chunk); } },
    addEventListener: (event, fn) => { listener = fn; },
  };
  vm.createContext(context);
  vm.runInContext(html.slice(html.indexOf('function layout(){'), html.indexOf('let vpT;')), context);
  vm.runInContext(html.slice(html.indexOf('function setMode(m){'), html.indexOf("addEventListener('message',")), context);
  vm.runInContext(html.slice(html.indexOf('function newDecoder(){'), html.indexOf('function onConfig(d){')), context);
  vm.runInContext(html.slice(html.indexOf('function onConfig(d){'), html.indexOf('// ---- input')), context);
  vm.runInContext(html.slice(html.indexOf("addEventListener('message',"), html.indexOf("send({type:'ready'});")), context);
  return { html, context, nodes, output: f => output(f), message: m => listener({ data: m }), decoder: () => decoderInstance, decoderState };
}

// 加载占位须为黑底、居中图标/文案、1080x1920比例，已有皮肤和上次帧尺寸不得影响占位。
test('mirror loading placeholder is black, centered and fits 1080x1920', () => {
  const f = loadingFixture(), c = f.context;
  assert.match(f.html, /id="frame" data-state="loading"/);
  assert.match(f.html, /codicon-loading codicon-modifier-spin/);
  assert.match(f.html, /id="placeholder-text">正在加载\.\.\./);
  assert.match(f.html, /#placeholder\{[^}]*background:#000/);
  assert.match(f.html, /#placeholder\{[^}]*align-items:center;justify-content:center/);
  assert.match(f.html, /#placeholder\[hidden\]\{display:none\}/);
  for (const mode of ['emulator', 'scrcpy', 'screencap']) {
    c.fw = 1080; c.fh = 2400;
    c.setMode(mode);
    assert.equal(c.frame.dataset.state, 'loading');
    assert.equal(f.nodes.placeholder.hidden, false);
    assert.equal(f.nodes['placeholder-text'].textContent, '正在加载...');
    assert.equal(c.fw, 0);
    assert.equal(c.fh, 0);
    assert.equal(c.skinOn, false);
    assert.equal(parseFloat(c.frame.style.width) / parseFloat(c.frame.style.height), 1080 / 1920);
    assert.equal(c.frame.style.width, c.stage.style.width);
    assertNavigationFit(c, 800, 600, 1080 / 1920);
  }
});

// 只有实际绘制/图片onload可退出占位；未加载及失败不能伪装首帧成功，重连恢复loading，正常首帧恢复皮肤与比例。
test('mirror loading ends on actual first frames and handles errors and reconnects', () => {
  const f = loadingFixture(), c = f.context;
  c.setMode('emulator');
  c.ctx.putImageData = () => assert.equal(c.frame.dataset.state, 'loading');
  c.onRgba({ w: 2, h: 4, data: new Uint8Array(32) });
  assert.equal(c.frame.dataset.state, 'live');
  assert.equal(f.nodes.placeholder.hidden, true);
  assert.equal(c.skinOn, true);
  c.setMode('scrcpy');
  c.newDecoder();
  c.ctx.drawImage = () => assert.equal(c.frame.dataset.state, 'loading');
  f.output({ displayWidth: 4, displayHeight: 2, close() {} });
  assert.equal(c.frame.dataset.state, 'live');
  assert.equal(c.skinOn, false);
  assert.equal(parseFloat(c.frame.style.width) / parseFloat(c.frame.style.height), 2);
  c.setMode('screencap');
  f.message({ type: 'frame', w: 4, h: 2, data: 'png' });
  assert.equal(c.frame.dataset.state, 'loading');
  c.img.onload();
  assert.equal(c.frame.dataset.state, 'live');
  assert.equal(f.nodes.placeholder.hidden, true);
  c.setMode('screencap');
  c.img.onerror();
  assert.equal(c.frame.dataset.state, 'error');
  assert.equal(f.nodes['placeholder-text'].textContent, '投屏画面加载失败');
  assert.equal(f.nodes.placeholder.hidden, false);
  c.setMode('emulator');
  f.message({ type: 'error', text: 'connection failed' });
  assert.equal(c.frame.dataset.state, 'error');
  assert.equal(f.nodes['placeholder-text'].textContent, 'connection failed');
  assert.match(f.html, /#frame\[data-state="error"\] #placeholder \.codicon\{display:none\}/);
  c.setMode('emulator');
  assert.equal(c.frame.dataset.state, 'loading');
  assert.equal(f.nodes['placeholder-text'].textContent, '正在加载...');
  f.message({ type: 'loading' });
  assert.equal(c.frame.dataset.state, 'loading');
  assert.equal(f.nodes.placeholder.hidden, false);
});

// 低延时视频限制解码积压，队列超过两帧时丢弃过期delta，关键帧仍可恢复显示。
test('scrcpy decoder drops queued deltas but accepts recovery key frames', () => {
  const f = loadingFixture();
  f.message({ type: 'mode', mode: 'scrcpy' });
  f.message({ type: 'video', kind: 'config', data: new Uint8Array([0, 0, 0, 1, 0x67, 0x64, 0, 0]) });
  assert.equal(f.decoder().state, 'configured');
  assert.deepEqual(f.decoderState.decoded, []);
  f.decoderState.queue = 3;
  f.message({ type: 'video', kind: 'delta', data: new Uint8Array([2]) });
  assert.equal(f.decoderState.decoded.length, 0);
  f.message({ type: 'video', kind: 'key', data: new Uint8Array([1]) });
  assert.equal(f.decoderState.decoded.length, 1);
  assert.equal(f.decoderState.decoded[0].type, 'key');
  f.decoderState.queue = 0;
  f.message({ type: 'video', kind: 'delta', data: new Uint8Array([3]) });
  assert.equal(f.decoderState.decoded.length, 2);
  assert.equal(f.decoderState.decoded[1].type, 'delta');
});


// 图标在当前宽度下缩小五分之一，不设固定上限；缩到半宽时仍缩半，上下各 4px 留白。
test('mirror navigation icons shrink by one fifth and vertical padding by one third', () => {
  const { context: c } = loadingFixture();
  c.frame.dataset.state = 'live';c.skin = null;c.fw = 100;c.fh = 200;
  c.wrapEl.getBoundingClientRect = () => ({ width: 316, height: 1000 });
  c.layout();
  const wide = assertNavigationFit(c, 316, 1000, 0.5);
  assert.equal(wide.w, 300);assert.ok(Math.abs(wide.icon - wide.w * 0.064) < 0.001);
  c.wrapEl.getBoundingClientRect = () => ({ width: 166, height: 1000 });
  c.layout();
  const narrow = assertNavigationFit(c, 166, 1000, 0.5);
  assert.equal(narrow.w, 150);assert.ok(Math.abs(narrow.icon - narrow.w * 0.064) < 0.001);
  assert.equal(narrow.icon / wide.icon, narrow.w / wide.w);
  c.wrapEl.getBoundingClientRect = () => ({ width: 800, height: 2000 });
  c.layout();
  const uncapped = assertNavigationFit(c, 800, 2000, 0.5);
  assert.equal(uncapped.w, 784);
  assert.ok(Math.abs(uncapped.icon - uncapped.w * 0.064) < 0.001);
});


// 真实 HTML 保证工具栏在 stage 内且紧接画面前，九个按钮保留四个紧凑组和三条分隔，计时不占工具栏；执行既有按键及工具绑定验证操作不变。
test('mirror toolbar shares frame width with edge buttons and keeps all tool commands', () => {
  const html = fixture().html;
  assert.match(html, /<div id="wrap"><div id="stage"><div id="bar">/);
  const bar = html.slice(html.indexOf('<div id="bar">'), html.indexOf('<div id="frame"'));
  const buttons = Array.from(bar.matchAll(/<button[^>]*>/g), m => m[0]);
  assert.equal(buttons.length, 9);
  assert.match(buttons[0], /data-k="26"/);
  assert.match(buttons.at(-1), /id="more"/);
  assert.equal(bar.split('class="sep"').length - 1, 3);
  const groups = Array.from(bar.matchAll(new RegExp('<div class="tool-group" role="group" aria-label="([^"]+)">(.*?)</div>', 'gs')));
  assert.deepEqual(groups.map(g => g[1]), ['Power and volume', 'Rotation', 'Capture', 'Device tools']);
  assert.deepEqual(groups.map(g => Array.from(g[2].matchAll(/<button[^>]*(?:data-k|id)="([^"]+)"/g), m => m[1])), [['26', '24', '25'], ['rotl', 'rotr'], ['shot', 'rec'], ['ref', 'more']]);
  assert.ok(!bar.includes('id="timer"'));
  assert.match(html, /id="status"><div id="msg">No device<\/div><span id="timer"><\/span>/);
  const sent = [], keys = ['26', '24', '25'].map(k => ({ dataset: { k } }));
  const c = { document: { querySelectorAll: () => keys }, send: m => sent.push(JSON.parse(JSON.stringify(m))), rec: {}, rotl: {}, rotr: {}, shot: {}, ref: {}, menu: { style: {} }, more: { getBoundingClientRect: () => ({ right: 300, bottom: 43 }) } };
  vm.createContext(c);
  vm.runInContext(html.split(String.fromCharCode(10)).find(line => line.startsWith("document.querySelectorAll('[data-k]')")), c);
  keys.forEach(k => k.onclick());
  vm.runInContext(html.split(String.fromCharCode(10)).find(line => line.startsWith('rec.onclick=')), c);
  c.rec.onclick();c.rotl.onclick();c.rotr.onclick();c.shot.onclick();c.ref.onclick();
  assert.deepEqual(sent, [{ type: 'key', code: '26' }, { type: 'key', code: '24' }, { type: 'key', code: '25' }, { type: 'record' }, { type: 'rotate', dir: -1 }, { type: 'rotate', dir: 1 }, { type: 'screenshot' }, { type: 'reboot' }]);
  vm.runInContext(html.split(String.fromCharCode(10)).find(line => line.startsWith('more.onclick=')), c);
  let stopped = false;
  c.more.onclick({ stopPropagation() { stopped = true; } });
  assert.equal(stopped, true);
  assert.equal(c.menu.style.display, 'block');
  assert.equal(c.menu.style.left, '140px');
  assert.equal(c.menu.style.top, '43px');
});

// 录屏计时移至独立状态行后，实际消息入口仍更新计时且不改变顶部栏/画面宽度。
test('mirror toolbar recording timer remains functional outside the button row', () => {
  const { context: c, message } = loadingFixture();
  c.layout();
  const width = c.stage.style.width;
  let tick, now = 0, cleared;
  c.timer = { textContent: '' };c.rec = { classList: { toggle() {} } };c.tm = undefined;
  c.Date = class { static now() { return now; } };
  c.setInterval = fn => { tick = fn; return 7; };
  c.clearInterval = id => { cleared = id; };
  message({ type: 'recording', on: true });
  assert.equal(c.rec.title, 'Stop recording');
  now = 61000;tick();
  assert.equal(c.timer.textContent, '1:01');
  assert.equal(c.stage.style.width, width);
  message({ type: 'recording', on: false });
  assert.equal(c.rec.title, 'Record screen');
  assert.equal(c.timer.textContent, '');
  assert.equal(cleared, 7);
});
