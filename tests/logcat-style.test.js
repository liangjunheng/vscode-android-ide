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

// npm test回归：设备与Format共用原生select箭头且无覆盖层；LOGCAT_BROWSER=1 dropdown断言长名称下箭头几何、深浅主题及键盘选择。
test('Logcat device selector matches the Format arrow', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/logcat.ts'), 'utf8');
  assert.ok(source.includes('<div class="device-select"><select id="dev" title="Device" aria-label="Device"><button type="button"><selectedcontent></selectedcontent></button></select></div>'));
  assert.match(rule('.device-select'), /position:relative/);
  assert.match(rule('.device-select'), /flex:0 1 calc\(220px \* 2 \/ 3\)/);
  assert.match(rule('.device-select #dev'), /width:100%/);
  assert.ok(!source.includes('device-select-arrow'));
  assert.doesNotMatch(rule('.device-select #dev'), /appearance:none|padding-inline-end/);
  const shared = fs.readFileSync(path.join(__dirname, '../media/dropdowns.css'), 'utf8');
  assert.ok(shared.includes('body #header #dev,body #header #fmt{display:flex;align-items:center;gap:8px;padding-inline-end:8px}'));
  assert.ok(shared.includes('#header selectedcontent,body #tabs selectedcontent{display:block;min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}'));
  assert.ok(shared.includes('#header select::picker-icon{position:static;flex:0 0 16px;margin-inline-start:0;pointer-events:none}'));
  assert.ok(js.includes('sel.innerHTML = '));
  assert.ok(js.includes('<selectedcontent></selectedcontent></button>'));
  assert.match(rule('.device-select #dev'), /text-overflow:ellipsis/);
  assert.match(rule('select'), /border-radius:6px/);
  assert.match(rule('select'), /var\(--vscode-dropdown-background/);
  assert.match(rule('.device-select #dev:focus-visible,select:focus-visible'), /box-shadow:0 0 0 1px var\(--vscode-focusBorder/);
  assert.ok(js.includes("$('dev').onchange"));
});

// npm test 执行生产搜索栏构建/开关；断言右侧父容器与 Ctrl+F/Esc 行为，CSS 声明约束左右分区。
test('Logcat search stays inside log content without moving the toolbar', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/logcat.ts'), 'utf8');
  assert.ok(source.includes('<div id="main"><div id="side"></div><div id="log-content"><div id="sc" tabindex="0" aria-label="Log messages">'));
  const nodes = new Map();
  // 最小 DOM 测试对象仅记录父子关系和事件，不模拟浏览器布局或像素结果。
  const element = () => ({style:{}, value:'', classList:{add(){},remove(){},toggle(){}}, handlers:{}, addEventListener(type,handler){this.handlers[type]=handler;}, focus(){},select(){}});
  const get = (id) => { if (!nodes.has(id)) { nodes.set(id,element()); } return nodes.get(id); };
  const side = get('side'), scNode = get('sc'), content = get('log-content');
  content.children = [scNode];
  content.insertBefore = (child, before) => {
    assert.equal(before, scNode);
    content.children.splice(content.children.indexOf(before),0,child);
    child.parentNode=content; nodes.set(child.id,child);
  };
  const events = {};
  const state = {open:false, re:null, rows:[],cur:-1,err:false,timer:0};
  const ctx = vm.createContext({$:get, sc:scNode, S:state,st:{},getSelection:()=>'',scheduleSearch(){},render(){},save(){},go(){},clearTimeout(){},codicon:()=>'',document:{createElement:element,addEventListener:(type,handler)=>{events[type]=handler;}}});
  const start = js.indexOf('  function openSearch() {');
  const end = js.indexOf('  let raf =', start);
  vm.runInContext(js.slice(start,end),ctx);
  assert.equal(get('sbar').parentNode,content);
  assert.equal(content.children.length,2);
  assert.ok(!content.children.includes(side));
  for (let i=0;i<2;i++) {
    events.keydown({ctrlKey:true,metaKey:false,altKey:false,key:'f',preventDefault(){}});
    assert.equal(state.open,true);
    assert.equal(get('sbar').style.display,'flex');
    get('sq').handlers.keydown({key:'Escape',preventDefault(){}});
    assert.equal(state.open,false);
    assert.equal(get('sbar').style.display,'none');
    assert.equal(content.children.length,2);
  }
  assert.match(rule('#log-content'),/display:flex;flex-direction:column/);
  assert.match(rule('#log-content'),/min-height:0/);
  assert.match(rule('#sc'),/min-height:0/);
  assert.match(rule('#sbar'),/flex-shrink:0/);
});

// npm test 回归：只移除日志容器和编辑区的焦点框，过滤框继续保留宿主焦点颜色。
test('Logcat editor omits its enclosing focus outline without changing other controls', () => {
  const focus = rule('#sc:focus,#sc:focus-visible,#row-viewport:focus,#row-viewport:focus-visible');
  assert.match(focus, /outline:0/);
  assert.match(focus, /box-shadow:none/);
  assert.ok(rule('#filterbox:focus-within').includes('border-color:var(--vscode-focusBorder)'));
});

// npm test 无设备回归：断言 UI 根节点使用宿主字体和字号变量。
test('Logcat UI uses VS Code font variables', () => {
  assert.ok(rule('body').includes('font-family:var(--vscode-font-family)'));
  assert.ok(rule('body').includes('font-size:var(--vscode-font-size)'));
});

// npm test 无设备回归：日志选择器绑定编辑器变量；成功证据为逐项声明断言通过。
test('Logcat rows use editor typography rather than bundled fonts', () => {
  const log = rule('#sc');
  for (const value of ['font-family:var(--vscode-editor-font-family,var(--vscode-font-family))', 'font-size:var(--vscode-editor-font-size,var(--vscode-font-size))', 'font-weight:var(--vscode-editor-font-weight)', 'line-height:round(up,1.5em,1px)']) {
    assert.ok(log.includes(value), value);
  }
  assert.doesNotMatch(css, /JetBrains|@font-face|monospace/);
});

// npm test 无设备回归：等级颜色徽标使用直角，其他控件圆角不由该规则改变。
test('Logcat level badges use square corners', () => {
  assert.match(rule('.lvb'), /border-radius:0/);
});

// npm test 无设备回归：固定顶栏、计数槽和侧栏最小高度，覆盖计数位数变化不抢占设备/筛选框布局。
test('Logcat toolbar reserves stable count space and cannot be squeezed by content', () => {
  assert.match(rule('#header'), /flex-shrink:0/);
  const count = rule('#count');
  for (const value of ['flex:0 0 14ch', 'min-width:14ch', 'max-width:14ch', 'overflow:hidden', 'text-overflow:ellipsis', 'font-variant-numeric:tabular-nums']) {
    assert.ok(count.includes(value), value);
  }
  assert.match(rule('#side'), /flex-shrink:0/);
  assert.match(rule('#side'), /min-height:0/);
  assert.doesNotMatch(css, /(?:^|[;{])\s*(?:zoom|transform|will-change|(?:animation|transition)-delay)\s*:/i);
});

// npm test 验证最低宿主、锁文件与说明同步，避免在不支持 CSS round() 的旧 Webview 安装。
test('Logcat integer line height requires VS Code 1.95 consistently', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '../package.json'), 'utf8'));
  const lock = JSON.parse(fs.readFileSync(path.join(__dirname, '../package-lock.json'), 'utf8'));
  assert.equal(manifest.engines.vscode, '^1.95.0');
  assert.equal(lock.packages[''].engines.vscode, manifest.engines.vscode);
  assert.match(fs.readFileSync(path.join(__dirname, '../README.md'), 'utf8'), /VS Code 1\.95 or later/);
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

// npm test 执行高度前缀、坐标定位与跟随状态函数；边界和空列表断言不依赖浏览器。
test('virtual offsets and follow state use one measured coordinate model', () => {
  const start = js.indexOf('  function measureOffsets() {'), end = js.indexOf('  function draw() {', start);
  const button = {classList:{toggle(name,on){this[name]=on;}},setAttribute(name,value){this[name]=value;}};
  const entry = {};
  const ctx = vm.createContext({button, entry, hostVisible:true, document:{hidden:false}, sc:{scrollTop:35}});
  vm.runInContext("let rows=[{e:entry,i:0},{e:entry,i:1},{e:entry,i:2}],offsets=[0],rowHeights=new WeakMap(),H=20,stick=true,viewportAnchor=null,requestedRow=null;const st={wrap:true};const $=()=>button;rowHeights.set(entry,new Map([[0,30],[1,50]]));\n"+js.slice(start,end),ctx);
  vm.runInContext('measureOffsets()',ctx);
  assert.equal(vm.runInContext('offsets.join()',ctx),'0,30,80,100');
  for (const [top,index] of [[0,0],[29,0],[30,1],[79,1],[80,2],[1000,2]]) {
    assert.equal(vm.runInContext('rowAt('+top+')',ctx),index);
  }
  vm.runInContext('setFollowing(false)',ctx);
  assert.equal(button.classList.on,false);
  assert.equal(button['aria-pressed'],'false');
  assert.equal(vm.runInContext('viewportAnchor.i',ctx),1);
  assert.equal(vm.runInContext('viewportAnchor.offset',ctx),5);
  vm.runInContext('setFollowing(true)',ctx);
  assert.equal(button.classList.on,true);
  assert.equal(button['aria-pressed'],'true');
  assert.equal(vm.runInContext('viewportAnchor',ctx),null);
  vm.runInContext('rows=[];measureOffsets()',ctx);
  assert.equal(vm.runInContext('rowAt(900)',ctx),0);
});

// npm test dropdown：检查四类Webview资源接线、原生语义和主题覆盖；实际级联与键盘由LOGCAT_BROWSER=1 dropdown浏览器回归验证。
test('dropdown styles connect every Webview and retain native selection semantics', () => {
  const shared = fs.readFileSync(path.join(__dirname, '../media/dropdowns.css'), 'utf8');
  for (const name of ['logcat', 'deviceManagerView', 'extendedControls']) {
    const source = fs.readFileSync(path.join(__dirname, '../src/' + name + '.ts'), 'utf8');
    assert.ok(source.includes("u('dropdowns.css')"), name);
    assert.ok(source.includes('localResourceRoots: [media, codicons]'), name);
  }
  const running = fs.readFileSync(path.join(__dirname, '../src/runningDevices.ts'), 'utf8');
  assert.ok(running.includes("dropdownStyle: art('../dropdowns.css')"));
  assert.ok(running.includes('href="${art.dropdownStyle}"'));
  for (const selector of ['.menu', '#menu', '.explorer-menu', '#sugg', 'select::picker(select)', 'option::checkmark']) assert.ok(shared.includes(selector), selector);
  for (const token of ['--vscode-menu-background', '--vscode-menu-foreground', '--vscode-focusBorder', 'vscode-light', 'vscode-dark', 'vscode-high-contrast-light', 'forced-colors:active', '@supports (appearance:base-select)', 'appearance:auto']) assert.ok(shared.includes(token), token);
  assert.ok(shared.includes('max-width:calc(100vw - 8px)'));
  assert.ok(shared.includes('body :is(button,select,input):focus:not(:focus-visible){outline:0!important;box-shadow:none!important}'));
  assert.ok(shared.includes('option:disabled'));
  assert.ok(shared.includes('overflow-wrap:anywhere'));
});

// npm test 执行实际同步函数；模拟计算行高，断言行高变化与重复通知，滚动位置由布局层统一管理。
test('font changes update height without direct scroll writes', () => {
  const start = js.indexOf('  function syncFontMetrics() {');
  const end = js.indexOf('  new MutationObserver', start);
  assert.ok(start >= 0 && end > start);
  const ctx = vm.createContext({ sc: { scrollTop: 240, style: {} }, st: { wrap: false }, height: '36px', calls: 0 });
  vm.runInContext('let H = 24; const getComputedStyle = () => ({lineHeight: height}); const render = () => calls++;\n' + js.slice(start, end), ctx);
  vm.runInContext('syncFontMetrics()', ctx);
  assert.equal(vm.runInContext('H', ctx), 36);
  assert.equal(ctx.sc.scrollTop, 240);
  assert.equal(ctx.calls, 1);
  vm.runInContext('syncFontMetrics()', ctx);
  assert.equal(ctx.calls, 1);
  ctx.height = '18px';
  vm.runInContext('syncFontMetrics()', ctx);
  assert.equal(ctx.sc.scrollTop, 240);
  assert.equal(vm.runInContext('H', ctx), 18);
  ctx.st.wrap = true;
  ctx.height = '30px';
  vm.runInContext('syncFontMetrics()', ctx);
  assert.equal(ctx.sc.scrollTop, 240);
  assert.equal(vm.runInContext('H', ctx), 30);
  assert.ok(js.includes('new MutationObserver(syncFontMetrics).observe(document.body'));
  assert.ok(js.includes('let H = parseFloat(getComputedStyle(sc).lineHeight)'));
});
