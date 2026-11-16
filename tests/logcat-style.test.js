const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const css = fs.readFileSync(path.join(__dirname, '../media/logcat/main.css'), 'utf8');
const js = fs.readFileSync(path.join(__dirname, '../media/logcat/main.js'), 'utf8');

// 读取本文件的平面规则声明；输入选择器，输出声明，缺失立即失败；不模拟浏览器级联。
function rule(selector) {
  const match = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].find((m) => m[1].trim() === selector);
  assert.ok(match, 'Missing selector: ' + selector);
  return match[2];
}

// npm test 回归：设备选择的箭头独立定位，文字为其预留宽度，原生 select 保留焦点和选择行为。
test('Logcat device selector reserves a separate arrow area', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/logcat.ts'), 'utf8');
  assert.ok(source.includes('<div class="device-select"><select id="dev" title="Device" aria-label="Device"></select><span class="device-select-arrow" aria-hidden="true"><span class="codicon codicon-chevron-down"></span></span></div>'));
  assert.match(rule('.device-select'), /position:relative/);
  assert.match(rule('.device-select'), /flex:0 1 220px/);
  assert.match(rule('.device-select #dev'), /width:100%/);
  assert.match(rule('.device-select #dev'), /appearance:none/);
  assert.match(rule('.device-select #dev'), /background-image:none/);
  assert.ok(rule('.device-select #dev').includes('padding-inline-end:calc(1.5em + 8px)'));
  assert.match(rule('.device-select #dev'), /text-overflow:ellipsis/);
  assert.match(rule('.device-select-arrow'), /width:1\.5em/);
  assert.match(rule('.device-select-arrow'), /pointer-events:none/);
  assert.match(rule('.device-select-arrow'), /inset-inline-end:1px/);
  assert.ok(js.includes("$('dev').onchange"));
});

// npm test 无设备回归：断言 UI 根节点使用宿主字体和字号变量。
test('Logcat UI uses VS Code font variables', () => {
  assert.ok(rule('body').includes('font-family:var(--vscode-font-family)'));
  assert.ok(rule('body').includes('font-size:var(--vscode-font-size)'));
});

// npm test 无设备回归：日志选择器绑定编辑器变量；成功证据为逐项声明断言通过。
test('Logcat rows use editor typography rather than bundled fonts', () => {
  const log = rule('#sc');
  for (const value of ['font-family:var(--vscode-editor-font-family,var(--vscode-font-family))', 'font-size:var(--vscode-editor-font-size,var(--vscode-font-size))', 'font-weight:var(--vscode-editor-font-weight)', 'line-height:1.5']) {
    assert.ok(log.includes(value), value);
  }
  assert.doesNotMatch(css, /JetBrains|@font-face|monospace/);
});

// npm test 无设备回归：Standard 和 Compact 行模板使用实际 Tab 分隔时间、进程线程、Tag、包名、级别和消息。
test('Logcat row fields use tab separators', () => {
  const rowStart = js.indexOf('  function rowHtml(i) {');
  const rowEnd = js.indexOf('  // ---- search in the log', rowStart);
  const row = js.slice(rowStart, rowEnd);
  const entry = { ts: '2026-11-16 17:00:00.000', pid: 12, tid: 34, tag: 'Tag', pkg: 'com.app', lv: 'I', lines: ['message', 'continued'] };
  const ctx = vm.createContext({ rows: [{ e: entry, i: 0 }, { e: entry, i: 1 }], st: { fmt: 'standard', wrap: false }, S: {cur: -1}, H: 24, hx: (s) => s, esc: (s) => s, tagColor: () => 'red' });
  vm.runInContext(row, ctx);
  const standard = vm.runInContext('rowHtml(0)', ctx).replace(/<[^>]*>/g, '');
  assert.equal(standard, [entry.ts, '12-34', 'Tag', 'com.app', 'I', 'message'].join('\t'));
  assert.equal(vm.runInContext('rowHtml(1)', ctx).replace(/<[^>]*>/g, ''), ['', '', '', '', '', 'continued'].join('\t'));
  ctx.st.fmt = 'compact';
  const compact = vm.runInContext('rowHtml(0)', ctx).replace(/<[^>]*>/g, '');
  assert.equal(compact, ['17:00:00.000', 'I', 'Tag', 'message'].join('\t'));
  assert.equal(vm.runInContext('rowHtml(1)', ctx).replace(/<[^>]*>/g, ''), ['', '', '', 'continued'].join('\t'));
  assert.match(css, /\.row\{white-space:pre;display:block/);
  assert.match(css, /tab-size:4/);
});

// npm test 执行实际渲染与搜索函数；断言独立记录保留重复 Tag，续行省略元数据且只搜索消息。
test('Logcat keeps independent record metadata and omits continuation metadata', () => {
  const start = js.indexOf('  function rowHtml(i) {');
  const end = js.indexOf('  function buildRe()', start);
  const entry = {ts:'2026-11-16 17:00:00.000', pid:1, tid:2, tag:'RepeatedTag', pkg:'pkg', lv:'I', lines:['first', 'continued']};
  const ctx = vm.createContext({ rows:[{e:entry,i:0},{e:entry,i:1},{e:{...entry,lines:['next']},i:0}], st:{fmt:'standard',wrap:false}, S:{cur:-1,re:null}, H:24, esc:(s)=>s, tagColor:()=> 'red' });
  vm.runInContext(js.slice(start, end), ctx);
  for (const fmt of ['standard', 'compact']) {
    ctx.st.fmt = fmt;
    for (const i of [0,1,2]) {
      const html = vm.runInContext('rowHtml(' + i + ')', ctx);
      assert.equal(html.replace(/<[^>]*>/g, '').split('\t')[2], i === 1 ? '' : entry.tag);
      const fields = vm.runInContext('rowFields(' + i + ')', ctx);
      for (const value of (fmt === 'standard' ? [entry.ts, '1-2', entry.pkg, entry.lv, entry.tag] : [entry.ts.slice(11), entry.lv, entry.tag])) {
        assert.equal(fields.includes(value), i !== 1, value);
      }
    }
    ctx.S.re = /RepeatedTag/g;
    assert.ok(vm.runInContext('rowHtml(2)', ctx).includes('<mark>RepeatedTag</mark>'));
    assert.ok(!vm.runInContext('rowHtml(1)', ctx).includes('<mark>RepeatedTag</mark>'));
    assert.equal(vm.runInContext('rowFields(1).join()', ctx), 'continued');
    ctx.S.re = null;
    ctx.rows = [{e:{...entry,tag:''},i:0}];
    assert.equal(vm.runInContext('rowHtml(0)',ctx).replace(/<[^>]*>/g,'').split('\t')[2], '');
    ctx.rows = [{e:entry,i:0},{e:entry,i:1},{e:{...entry,lines:['next']},i:0}];
  }
});

// npm test 回归表单、菜单、补全和历史继承；固定字体大小仅允许图标例外。
test('Logcat controls inherit typography and only icons retain fixed font size', () => {
  for (const selector of ['select', '#editor', '#hl,#q', '.ib', '.menu', '#hist .h', '#sugg', '#sugg .si', '#sugg .si .d', '.menu.hist .hrow', '#cc', '#sq', '#sbox .opt']) {
    assert.match(rule(selector), /(?:^|;)font:inherit(?:;|$)/, selector);
  }
  for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (match[1].trim() === '.ib .codicon') { continue; }
    assert.doesNotMatch(match[2], /font-size:\s*[\d.]+(?:px|pt|em|rem|%)/, match[1]);
  }
  assert.equal(rule('.ib .codicon'), 'font-size:16px');
});

// npm test 执行实际同步函数；模拟计算行高，断言变大、变小、重复通知与换行定位。
test('font changes update virtual row height and preserve scroll position', () => {
  const start = js.indexOf('  function syncFontMetrics() {');
  const end = js.indexOf('  new MutationObserver', start);
  assert.ok(start >= 0 && end > start);
  const ctx = vm.createContext({ sc: { scrollTop: 240 }, st: { wrap: false }, height: '36px', calls: 0 });
  vm.runInContext('let H = 24; const getComputedStyle = () => ({lineHeight: height}); const render = () => calls++;\n' + js.slice(start, end), ctx);
  vm.runInContext('syncFontMetrics()', ctx);
  assert.equal(vm.runInContext('H', ctx), 36);
  assert.equal(ctx.sc.scrollTop, 360);
  assert.equal(ctx.calls, 1);
  vm.runInContext('syncFontMetrics()', ctx);
  assert.equal(ctx.calls, 1);
  ctx.height = '18px';
  vm.runInContext('syncFontMetrics()', ctx);
  assert.equal(ctx.sc.scrollTop, 180);
  assert.equal(vm.runInContext('H', ctx), 18);
  ctx.st.wrap = true;
  ctx.height = '30px';
  vm.runInContext('syncFontMetrics()', ctx);
  assert.equal(ctx.sc.scrollTop, 180);
  assert.equal(vm.runInContext('H', ctx), 30);
  assert.ok(js.includes('new MutationObserver(syncFontMetrics).observe(document.body'));
  assert.ok(js.includes('let H = parseFloat(getComputedStyle(sc).lineHeight)'));
});
