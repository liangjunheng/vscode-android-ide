const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

const root = path.join(__dirname, '..');
const enabled = !!process.env.LOGCAT_BROWSER;
const executable = process.env.LOGCAT_BROWSER_PATH || (/^(1|true)$/i.test(process.env.LOGCAT_BROWSER || '')
  ? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' : process.env.LOGCAT_BROWSER);

// 所有异步 CDP 操作共用运行截止时间；挂起抛错而非轮询或扩大超时。
function bounded(promise, signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

// 连接浏览器发布的内置 WebSocket；输入 endpoint，按 id 输出 CDP 响应并传播协议/连接错误。
async function connect(url, signal) {
  const socket = new WebSocket(url), pending = new Map();
  let sequence = 0;
  const fail = error => { for (const request of pending.values()) request.reject(error); pending.clear(); };
  socket.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data), request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(JSON.stringify(message.error)));
    else request.resolve(message.result);
  });
  socket.addEventListener('close', () => fail(new Error('CDP closed')));
  socket.addEventListener('error', () => fail(new Error('CDP WebSocket error')));
  try {
    await bounded(new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', reject, { once: true });
    }), signal);
  } catch (error) { socket.close(); throw error; }
  return {
    // 输入协议方法、参数和 target session，输出协议结果；真实浏览器调用均受截止时间保护。
    call(method, params = {}, sessionId) {
      return bounded(new Promise((resolve, reject) => {
        const id = ++sequence; pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      }), signal);
    },
    // 回收测试连接并拒绝所有未完成命令，避免失败路径遗留句柄。
    close() { fail(new Error('CDP disposed')); socket.close(); }
  };
}

// 读取真实 w.html 静态模板并剔除 CSP/动态资源链接；原样读取生产脚本、CSS 与实际图标。
async function fixture() {
  const source = await fs.readFile(path.join(root, 'src/logcat.ts'), 'utf8');
  const start = source.indexOf('w.html = `'), end = source.indexOf('`;', start);
  assert.ok(start >= 0 && end > start, 'real w.html template found');
  const html = source.slice(start + 'w.html = `'.length, end)
    .replace(/<meta\b[^>]*http-equiv="Content-Security-Policy"[^>]*>/gi, '')
    .replace(/<link\b[^>]*>/gi, '').replace(/<script\b[^>]*src=[^>]*><\/script>/gi, '');
  assert.ok(!html.includes('${'), 'dynamic resources removed');
  const icons = {};
  for (const name of await fs.readdir(path.join(root, 'media/icons'))) {
    if (name.endsWith('.svg')) icons[name.slice(0, -4)] = await fs.readFile(path.join(root, 'media/icons', name), 'utf8');
  }
  const css = await fs.readFile(path.join(root, 'media/logcat/main.css'), 'utf8') + await fs.readFile(path.join(root, 'media/dropdowns.css'), 'utf8')
    + (await fs.readFile(path.join(root, 'media/codicons/codicon.css'), 'utf8')).replace(/url\([^)]*\)/g, 'url(data:font/ttf;base64,' + (await fs.readFile(path.join(root, 'media/codicons/codicon.ttf'))).toString('base64') + ')');
  const scripts = await Promise.all(['filter.js', 'buffer.js', 'main.js'].map(name => fs.readFile(path.join(root, 'media/logcat', name), 'utf8')));
  return { html, icons, css, scripts };
}

// 仅杀掉本测试启动的独立 Edge 进程树；退出后移除临时 profile，不触碰用户浏览器。
async function dispose(child, profile) {
  try {
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      if (process.platform === 'win32') {
        const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        const [code] = await once(killer, 'exit');
        assert.equal(code, 0, 'owned browser tree killed');
      } else child.kill('SIGKILL');
      if (child.exitCode === null && child.signalCode === null) await once(child, 'exit');
    }
  } finally { await fs.rm(profile, { recursive: true, force: true }); }
}

// 从 stderr DevTools listening 事件建立 CDP，不用固定端口或睡眠轮询；注册清理后才启动浏览器。
async function browser(t, data, signal) {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'logcat-edge-profile-'));
  let child, cdp;
  // 浏览器先按协议关闭并等待自有进程退出，再断开CDP和移除profile；dropdown/Logcat真实浏览器回归同时覆盖清理，避免taskkill与自然退出竞争。
  t.after(async () => {
    try {
      if (cdp && child.exitCode === null && child.signalCode === null) {
        await cdp.call('Browser.close');
        if (child.exitCode === null && child.signalCode === null) await once(child, 'exit');
      }
    } finally { cdp?.close(); await dispose(child, profile); }
  });
  const endpoint = new Promise((resolve, reject) => {
    // Edge 的兼容层重启会脱离 child 及 stderr；禁止该重启以保留进程所有权和 CDP endpoint 事件。
    child = spawn(executable, ['--edge-skip-compat-layer-relaunch', '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
      '--disable-extensions', '--disable-background-networking', '--remote-debugging-port=0', '--user-data-dir=' + profile, 'about:blank'],
    { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => {
      stderr = (stderr + chunk).slice(-16384);
      const match = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match) resolve(match[1]);
    });
    child.once('error', reject);
    child.once('exit', code => reject(new Error('Edge exited before CDP: ' + code + '\n' + stderr)));
  });
  cdp = await connect(await bounded(endpoint, signal), signal);
  // 创建独立 target 并附加，所有 Page/Runtime/Input 命令仅发送给该真实页面。
  const { targetId } = await cdp.call('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.call('Target.attachToTarget', { targetId, flatten: true });
  const call = (method, params) => cdp.call(method, params, sessionId);
  await call('Page.enable'); await call('Runtime.enable');
  const { frameTree } = await call('Page.getFrameTree');
  await call('Page.setDocumentContent', { frameId: frameTree.frame.id, html: data.html });
  // 输入 JS 表达式并等待 Promise；浏览器异常直接失败，不访问或导出生产闭包函数。
  async function evaluate(expression) {
    const result = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    assert.ok(!result.exceptionDetails, JSON.stringify(result.exceptionDetails));
    return result.result.value;
  }
  await evaluate(`(() => {
    const style=document.createElement('style');style.textContent=${JSON.stringify(data.css)};document.head.append(style);
    document.body.classList.add('vscode-dark');
    document.body.style.cssText='--vscode-font-family:Arial;--vscode-font-size:13px;--vscode-editor-font-family:Consolas;--vscode-editor-font-size:14px;--vscode-editor-font-weight:400;--vscode-editor-background:#1e1e1e;--vscode-foreground:#ddd;--vscode-input-foreground:#ddd;--vscode-input-background:#333;--vscode-toolbar-activeBackground:#555;--vscode-icon-foreground:#ddd';
    let state;window.__hostMessages=[];
    window.acquireVsCodeApi=()=>({getState:()=>state,setState:value=>{state=structuredClone(value)},postMessage:message=>window.__hostMessages.push(message)});
  })()`);
  for (const script of data.scripts) await evaluate(script);
  assert.equal(await evaluate('window.__hostMessages[0].type'), 'ready');
  // 两个动画帧边界分别提交生产 render 和读取布局，禁止 setTimeout 睡眠轮询。
  async function frames() { await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))'); }
  // 用公开 window.postMessage 投递真实后端协议，等待消息分发和布局完成。
  async function post(message) {
    await evaluate(`new Promise(resolve=>{const message=${JSON.stringify(message)};window.addEventListener('message',function received(event){if(event.data.type!==message.type)return;window.removeEventListener('message',received);resolve()});window.postMessage(message,'*')})`);
    await frames();
  }
  // CDP 设置宽窄屏 viewport，返回前等待页面布局。
  async function viewport(width, deviceScaleFactor = 1, height = 720) { await call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor, mobile: false }); await frames(); }
  // 只点击公开 DOM 控件，输出为提交后的真实页面状态。
  async function click(id) { await evaluate(`document.getElementById(${JSON.stringify(id)}).click()`); await frames(); }
  // 用真实 CDP 键盘事件触发 Ctrl+F 和 Escape，并等待布局。
  async function key(key, modifiers = 0) {
    const code = { Escape:27, Enter:13, Backspace:8, Delete:46, Tab:9, ArrowLeft:37, ArrowRight:39, ArrowUp:38, ArrowDown:40 }[key] || key.toUpperCase().charCodeAt(0);
    await call('Input.dispatchKeyEvent', { type: 'keyDown', key, modifiers, windowsVirtualKeyCode: code, ...(key === 'Enter' ? {text:'\r'} : {}) });
    await call('Input.dispatchKeyEvent', { type: 'keyUp', key, modifiers, windowsVirtualKeyCode: code }); await frames();
  }
  // 发送原生鼠标事件验证真实拖选/双击，输入类型、CSS坐标和点击次数，输出协议完成。
  async function mouse(type, x, y, clickCount = 1) {
    await call('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount });
  }
  // select#fmt 派发真实 change 事件，不绕过生产格式处理器。
  async function format(value) { await evaluate(`(()=>{const select=document.querySelector('select#fmt');select.value=${JSON.stringify(value)};select.dispatchEvent(new Event('change',{bubbles:true}))})()`); await frames(); }
  // 搜索用 MutationObserver 等待计数更新，保留生产防抖时序；无结果更新由运行 deadline 失败。
  async function search(text) {
    await key('f', 2);
    await evaluate(`new Promise(resolve=>{const count=document.getElementById('scount');const observer=new MutationObserver(()=>{observer.disconnect();resolve()});observer.observe(count,{childList:true,characterData:true,subtree:true});const input=document.getElementById('sq');input.value=${JSON.stringify(text)};input.dispatchEvent(new Event('input',{bubbles:true}))})`);
    await frames();
  }
  // PNG 临时证据目录独立于 profile，输出绝对路径供主代理 read_image；由证据使用者清理。
  let shots;
  async function screenshot(name) {
    shots ||= process.env.LOGCAT_BROWSER_ARTIFACT_DIR || await fs.mkdtemp(path.join(os.tmpdir(), 'logcat-browser-shots-'));
    await fs.mkdir(shots, { recursive: true });
    const output=path.resolve(shots,name+'.png');
    const { data: png }=await call('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
    await fs.writeFile(output,Buffer.from(png,'base64'));t.diagnostic('Logcat screenshot: '+output);
  }
  // 截取同一CSS坐标区域的原生PNG，供相同日志内容逐像素比较，不缩放生产页面。
  async function region(clip) { return (await call('Page.captureScreenshot',{format:'png',captureBeyondViewport:false,clip:{...clip,scale:1}})).data; }
  await viewport(1440);
  await post({type:'init',icons:data.icons,mine:['com.browser.fixture'],maxBytes:1048576});
  await post({type:'devices',list:[{serial:'browser-fixture',model:'Browser fixture',state:'device'}],serial:'browser-fixture'});
  await post({type:'reset'});
  return {evaluate,frames,post,viewport,click,key,mouse,format,search,screenshot,region};
}

// 构造真实 batch 记录；同毫秒元数据复现独立首行与 msg 内换行边界。
function item(msg) { return {ts:'2026-11-16 18:00:00.001',pid:123,tid:456,lv:'I',tag:'SharedTag',pkg:'com.browser.fixture',rx:1,msg}; }

// 断言末尾按钮选中样式和 aria-pressed 同步反映跟随状态。
async function follows(page, expected) {
  assert.deepEqual(await page.evaluate(`(()=>{const b=document.getElementById('b-end');return[b.classList.contains('on'),b.getAttribute('aria-pressed')]})()`),[expected,String(expected)]);
}

// 验证最后消息真实出现在 viewport 内且滚动到底，不能只用 DOM 存在作为成功证据。
async function atEnd(page, text) {
  const result=await page.evaluate(`(()=>{const sc=document.getElementById('sc'),rect=sc.getBoundingClientRect();const last=[...document.querySelectorAll('#win .row')].find(row=>row.querySelector('.m').textContent===${JSON.stringify(text)});if(!last)return{exists:false};const box=last.getBoundingClientRect();return{exists:true,gap:sc.scrollHeight-sc.clientHeight-sc.scrollTop,bottom:box.bottom,viewportTop:rect.top,viewportBottom:rect.bottom}})()`);
  assert.equal(result.exists,true,'last record rendered');
  assert.ok(result.gap<=2,JSON.stringify(result));
  assert.ok(result.bottom<=result.viewportBottom+1&&result.bottom>result.viewportTop,JSON.stringify(result));
}

// npm test 自动发现；LOGCAT_BROWSER 启用真实 Edge，45 秒统一截止保护挂起，不扩大超时掩盖布局错误。
test('Logcat real browser regressions',{skip:enabled?false:'Set LOGCAT_BROWSER=1 (or Edge executable path) to run headless CDP',timeout:60000},async t=>{
  const controller=new AbortController();
  const deadline=setTimeout(()=>controller.abort(new Error('Logcat browser runtime deadline exceeded (45s)')),45000);
  t.after(()=>clearTimeout(deadline));
  try {
  const page=await browser(t,await fixture(),controller.signal);
  await follows(page,true);

  // CtrlF/Esc 多次开关：右侧可见，#side 和全部按钮 top 不变。
  await t.test('Ctrl+F stays isolated from the left toolbar',async()=>{
    const positions=`['side',...Array.from(document.querySelectorAll('#side button'),b=>b.id)].map(id=>[id,document.getElementById(id).getBoundingClientRect().top])`;
    const before=await page.evaluate(positions);
    for(let repeat=0;repeat<4;repeat++){
      await page.key('f',2);assert.deepEqual(await page.evaluate(positions),before);
      assert.equal(await page.evaluate(`(()=>{const bar=document.getElementById('sbar'),sc=document.getElementById('sc'),side=document.getElementById('side');return getComputedStyle(bar).display!=='none'&&bar.getBoundingClientRect().left>=side.getBoundingClientRect().right&&bar.getBoundingClientRect().bottom<=sc.getBoundingClientRect().top+1})()`),true);
      await page.key('Escape');assert.equal(await page.evaluate("getComputedStyle(document.getElementById('sbar')).display"),'none');
      assert.deepEqual(await page.evaluate(positions),before);
    }
  });

  // 宿主隐藏及模拟document.hidden分别取消已排队帧/搜索；在途消息只改模型，恢复时显示最新状态。
  await t.test('hidden Logcat makes no DOM updates and resumes from latest state',async()=>{
    for(const mode of ['host','document']){
      await page.post({type:'reset'});await page.post({type:'batch',items:[item('visible-before-hide')]});
      await page.key('f',2);await page.frames();
      await page.evaluate("(()=>{window.__hiddenMutations=0;window.__hiddenObserver=new MutationObserver(records=>window.__hiddenMutations+=records.length);for(const id of ['win','count','dev','status','scount','side'])window.__hiddenObserver.observe(document.getElementById(id),{subtree:true,childList:true,characterData:true,attributes:true});const input=document.getElementById('sq');input.value='hidden-final';input.dispatchEvent(new Event('input',{bubbles:true}));window.dispatchEvent(new MessageEvent('message',{data:{type:'batch',items:["+JSON.stringify(item('queued-before-hide'))+"]}}));"+(mode==='host'?"window.dispatchEvent(new MessageEvent('message',{data:{type:'visibility',visible:false}}));":"Object.defineProperty(document,'hidden',{configurable:true,value:true});document.dispatchEvent(new Event('visibilitychange')); ")+"})()");
      await page.post({type:'reset'});
      await page.post({type:'devices',list:[{serial:'hidden-device',model:'Hidden latest',state:'device'}],serial:'hidden-device'});
      await page.post({type:'status',text:'hidden status latest'});
      await page.post({type:'batch',items:[...Array.from({length:15},(_,i)=>({...item('hidden-'+i),pid:777,pkg:''})),item('hidden-final')]});
      await page.post({type:'pkgs',map:{777:'com.hidden.latest'}});
      assert.equal(await page.evaluate('window.__hiddenMutations'),0,'hidden DOM mutation count, '+mode);
      assert.equal(await page.evaluate("document.querySelector('#win .row:last-child .m').textContent"),'visible-before-hide');
      await page.evaluate("window.__hiddenObserver.disconnect()");
      // 在恢复事件之前订阅真实搜索计数变更，不用睡眠等待防抖。
      await page.evaluate("new Promise(resolve=>{const observer=new MutationObserver(()=>{observer.disconnect();resolve()});observer.observe(document.getElementById('scount'),{childList:true,characterData:true,subtree:true});"+(mode==='host'?"window.postMessage({type:'visibility',visible:true},'*');":"delete document.hidden;document.dispatchEvent(new Event('visibilitychange'));")+"})");
      await page.frames();
      assert.equal(await page.evaluate("document.querySelector('#win .row:last-child .m').textContent"),'hidden-final');
      assert.equal(await page.evaluate("document.getElementById('dev').selectedOptions[0].textContent"),'Hidden latest (hidden-device)');
      assert.equal(await page.evaluate("document.getElementById('status').textContent"),'hidden status latest');
      assert.equal(await page.evaluate("document.getElementById('scount').textContent"),'1/1');
      await page.key('Escape');
    }
  });

  // 两种 fmt、宽窄 viewport 和 wrap 开关：行矩形不重叠，wrap 不横向溢出，末行仍可见。
  await t.test('soft wrap preserves row bounds across formats and viewports',async()=>{
    await page.post({type:'reset'});
    const last='WRAP-LAST '+'last '.repeat(60);
    await page.post({type:'batch',items:[...Array.from({length:80},(_,i)=>item('long-'+i+' '+'unbroken_'.repeat(100))),item(last)]});
    for(const width of [1440,480]){
      await page.viewport(width);
      for(const fmt of ['standard','compact']){
        await page.format(fmt);
        for(const wrap of [true,false,true]){
          if(await page.evaluate("document.body.classList.contains('wrap')")!==wrap)await page.click('b-wrap');
          const geometry=await page.evaluate(`(()=>{const sc=document.getElementById('sc'),rows=[...document.querySelectorAll('#win .row')];return{overlaps:rows.slice(1).some((row,i)=>rows[i].getBoundingClientRect().bottom>row.getBoundingClientRect().top+1),width:sc.clientWidth,scrollWidth:sc.scrollWidth}})()`);
          if(wrap)await page.screenshot('wrap-'+width+'-'+fmt);
          assert.equal(geometry.overlaps,false,JSON.stringify({width,fmt,wrap,geometry}));
          if(wrap)assert.ok(geometry.scrollWidth<=geometry.width+1,JSON.stringify({width,fmt,geometry}));
          await atEnd(page,last);
        }
      }
    }
  });

  // 初始 true、click 切 false/true；禁用追加不动，启用追加到底，点击日志和上滚退出跟随。
  await t.test('end-follow toggle controls append and user scrolling',async()=>{
    await page.viewport(1440);await page.post({type:'reset'});await follows(page,true);
    await page.post({type:'batch',items:Array.from({length:100},(_,i)=>item('follow-'+i))});
    await page.click('b-end');await follows(page,false);
    const top=await page.evaluate("document.getElementById('sc').scrollTop");
    await page.post({type:'batch',items:[item('follow-disabled')]});
    assert.equal(await page.evaluate("document.getElementById('sc').scrollTop"),top);await follows(page,false);
    await page.click('b-end');await follows(page,true);
    await page.post({type:'batch',items:[item('follow-enabled')]});await atEnd(page,'follow-enabled');await follows(page,true);
    // 连续帧读取同一末行位置；没有新日志时不允许布局/滚动反馈造成往返抖动。
    const positions = await page.evaluate("new Promise(resolve=>{const values=[];function frame(){values.push(document.querySelector('#win .row:last-child').getBoundingClientRect().bottom);if(values.length===12)resolve(values);else requestAnimationFrame(frame)}requestAnimationFrame(frame)})");
    assert.ok(Math.max(...positions)-Math.min(...positions)<=1,JSON.stringify(positions));
    await page.evaluate("document.querySelector('#win .row:last-child .m').click()");await page.frames();await follows(page,false);
    await page.click('b-end');await follows(page,true);
    await page.evaluate("document.getElementById('sc').scrollTop-=120");await page.frames();await follows(page,false);
  });

  // 原生拖选时持续追加：选中文字、端点节点和屏幕位置不变，释放/清空不自动恢复，末尾按钮显式恢复。
  await t.test('text selection keeps its nodes and viewport stable while logs append',async()=>{
    await page.viewport(1600);
    for(const wrap of [false,true]){
      await page.post({type:'reset'});await page.format('standard');
      if(await page.evaluate("document.body.classList.contains('wrap')")!==wrap)await page.click('b-wrap');
      await page.post({type:'batch',items:Array.from({length:120},(_,i)=>item('selection word '+String(i).padStart(3,'0')))});
      const points=await page.evaluate("(()=>{const nodes=[...document.querySelectorAll('#win .row .m')].slice(-5,-2);return [nodes[0],nodes[2]].map(m=>{const r=document.createRange();r.setStart(m.firstChild,0);r.setEnd(m.firstChild,9);const b=r.getBoundingClientRect();return{x:b.left+2,y:(b.top+b.bottom)/2,end:b.right-1}})})()");
      await page.mouse('mousePressed',points[0].x,points[0].y);
      await page.mouse('mouseMoved',points[1].end,points[1].y);await page.frames();
      await follows(page,false);
      const before=await page.evaluate("(()=>{const s=getSelection();window.__selectedNode=s.anchorNode;return{text:String(s),top:document.getElementById('sc').scrollTop,y:s.getRangeAt(0).getBoundingClientRect().top}})()");
      assert.ok(before.text.includes('selection'),before.text);
      for(let i=0;i<4;i++){
        await page.post({type:'batch',items:[item('selection-new-'+i)]});
        const after=await page.evaluate("(()=>{const s=getSelection();return{text:String(s),top:document.getElementById('sc').scrollTop,same:s.anchorNode===window.__selectedNode,y:s.rangeCount?s.getRangeAt(0).getBoundingClientRect().top:null}})()");
        assert.equal(after.text,before.text);assert.equal(after.top,before.top);assert.equal(after.same,true);assert.ok(Math.abs(after.y-before.y)<0.05);
      }
      await page.mouse('mouseReleased',points[1].end,points[1].y);
      await page.evaluate('getSelection().removeAllRanges()');await page.frames();
      await page.post({type:'batch',items:[item('selection-cleared')]});await follows(page,false);
      assert.equal(await page.evaluate("document.getElementById('sc').scrollTop"),before.top);
      await page.click('b-end');await follows(page,true);await atEnd(page,'selection-cleared');
      // 非鼠标创建的反向选区也必须停止跟随，且按钮可清除选区并显式恢复。
      await page.evaluate("(()=>{const m=document.querySelector('#win .row:last-child .m').firstChild;getSelection().setBaseAndExtent(m,9,m,0)})()");await page.frames();await follows(page,false);
      await page.post({type:'batch',items:[item('selection-reverse')]});
      assert.equal(await page.evaluate('String(getSelection())'),'selection');
      await page.click('b-end');await follows(page,true);assert.equal(await page.evaluate('String(getSelection())'),'');await atEnd(page,'selection-reverse');
      // 原生双击选词之后追加仍保留单词，包名后到不应销毁消息字段。
      await page.post({type:'batch',items:[{...item('doubleclick selection word'),pid:987,pkg:''}]});
      const word=await page.evaluate("(()=>{const m=document.querySelector('#win .row:last-child .m'),r=document.createRange();r.setStart(m.firstChild,0);r.setEnd(m.firstChild,5);const b=r.getBoundingClientRect();return{x:(b.left+b.right)/2,y:(b.top+b.bottom)/2}})()");
      await page.mouse('mousePressed',word.x,word.y,2);await page.mouse('mouseReleased',word.x,word.y,2);await page.frames();await follows(page,false);
      const chosen=await page.evaluate('String(getSelection())');assert.match(chosen,/^doubleclick ?$/);
      await page.post({type:'pkgs',map:{987:'com.resolved.later'}});
      await page.post({type:'batch',items:[item('doubleclick-after')]});assert.equal(await page.evaluate('String(getSelection())'),chosen);
      await page.click('b-end');await follows(page,true);
      // 日志外的页面选区不得退出自动跟随。
      await page.evaluate("(()=>{const m=document.getElementById('count').firstChild;getSelection().setBaseAndExtent(m,0,m,m.length)})()");await page.frames();await follows(page,true);
      await page.evaluate('getSelection().removeAllRanges()');
      // reset 创建新日志文档，不能让已删除文档的旧选区再次关闭跟随。
      await page.evaluate("(()=>{const m=document.querySelector('#win .row:last-child .m').firstChild;getSelection().setBaseAndExtent(m,0,m,5)})()");await page.frames();await follows(page,false);
      await page.post({type:'reset'});await follows(page,true);assert.equal(await page.evaluate('String(getSelection())'),'');
    }
  });

  // 用户复现：过滤后的记录未变，后台只追加不匹配日志；日志节点、样式、滚动和像素必须完全不变。
  await t.test('filtered-out batches never mutate or reposition unchanged visible logs',async()=>{
    await page.viewport(1600);await page.format('standard');
    for(const wrap of [false,true]){
      await page.post({type:'reset'});
      if(await page.evaluate("document.body.classList.contains('wrap')")!==wrap)await page.click('b-wrap');
      await page.evaluate("(()=>{const q=document.getElementById('q');q.value='tag:Keep';q.dispatchEvent(new Event('input',{bubbles:true}))})()");await page.frames();
      await page.post({type:'batch',items:Array.from({length:100},(_,i)=>({...item('retained message '+i),tag:'Keep'}))});
      const before=await page.evaluate("(()=>{const sc=document.getElementById('sc'),row=document.querySelector('#win .row:last-child');window.__keptRow=row;window.__filteredMutations=0;window.__filteredObserver=new MutationObserver(r=>window.__filteredMutations+=r.length);window.__filteredObserver.observe(document.getElementById('win'),{subtree:true,attributes:true,childList:true,characterData:true});return{top:sc.scrollTop,y:row.getBoundingClientRect().top}})()");
      const clip=await page.evaluate("(()=>{const r=document.querySelector('#win .row:last-child .m').getBoundingClientRect();return{x:r.left,y:r.top,width:r.width,height:r.height}})()");
      const pixels=await page.region(clip);
      for(let i=0;i<8;i++)await page.post({type:'batch',items:Array.from({length:30},()=>({...item('unmatched background'),tag:'Other'}))});
      assert.equal(await page.region(clip),pixels,'filtered-out background altered glyph pixels');
      const after=await page.evaluate("(()=>{const sc=document.getElementById('sc'),row=document.querySelector('#win .row:last-child');return{mutations:window.__filteredMutations,same:row===window.__keptRow,top:sc.scrollTop,y:row.getBoundingClientRect().top}})()");
      await page.evaluate('window.__filteredObserver.disconnect()');
      assert.equal(after.mutations,0,JSON.stringify({wrap,after}));assert.equal(after.same,true);assert.equal(after.top,before.top);assert.equal(after.y,before.y);
      // 新匹配仍应显示，不能通过停止接收来使静止断言伪通过。
      await page.post({type:'batch',items:[{...item('new matching record'),tag:'Keep'}]});await atEnd(page,'new matching record');
    }
    await page.evaluate("(()=>{const q=document.getElementById('q');q.value='';q.dispatchEvent(new Event('input',{bubbles:true}))})()");await page.frames();
  });

  // 用户视频复现回归：package:mine 下后台不匹配项持续增长并触发真实 1MiB 淘汰；输入为两种 DPR/换行布局，输出为每帧几何和 glyph PNG 严格不变。
  // 前置条件是 fixture 的 mine 包已初始化；成功判据同时要求 entries 计数继续变化、匹配 row DOM 身份保留、scrollTop/row top 连续帧恒定且截图字节完全一致。
  await t.test('package mine keeps visible glyphs fixed while background buffer evicts',async()=>{
    const background=Array.from({length:1600},(_,i)=>({...item(('background-'+String(i).padStart(4,'0')+' ').padEnd(650+(i%11)*17,'x')),tag:'Other',pkg:'com.other.fixture'}));
    for(const dpr of [1,1.25]) for(const wrap of [false,true]){
      await page.viewport(1600,dpr,480);await page.post({type:'reset'});
      if(await page.evaluate("document.body.classList.contains('wrap')")!==wrap)await page.click('b-wrap');
      await page.evaluate("(()=>{const q=document.getElementById('q');q.value='package:mine';q.dispatchEvent(new Event('input',{bubbles:true}))})()");await page.frames();
      await page.post({type:'batch',items:background.slice(0,1400)});
      await page.post({type:'batch',items:[item('KEEP-GLYPH-IDENTITY')]});
      const baseline=await page.evaluate("(()=>{const sc=document.getElementById('sc'),row=document.querySelector('#win .row:last-child'),m=row.querySelector('.m'),r=m.getBoundingClientRect();window.__jitterRow=row;return{count:document.getElementById('count').textContent,top:row.getBoundingClientRect().top,scrollTop:sc.scrollTop,clip:{x:r.x,y:r.y,width:r.width,height:r.height}}})()");
      const pixels=await page.region(baseline.clip);
      let previousCount=baseline.count;
      for(const batch of [background.slice(1400),background.slice(0,400)]){
        await page.post({type:'batch',items:batch});
        const samples=await page.evaluate("new Promise(resolve=>{const values=[];function frame(){const sc=document.getElementById('sc'),row=document.querySelector('#win .row:last-child');values.push({same:row===window.__jitterRow,top:row.getBoundingClientRect().top,scrollTop:sc.scrollTop,text:row.querySelector('.m').textContent});if(values.length===4)resolve(values);else requestAnimationFrame(frame)}requestAnimationFrame(frame)})");
        const count=await page.evaluate("document.getElementById('count').textContent");
        assert.notEqual(count,previousCount,JSON.stringify({dpr,wrap,count,previousCount}));previousCount=count;
        assert.equal(await page.region(baseline.clip),pixels,JSON.stringify({dpr,wrap,count},null,2));
        for(const sample of samples){assert.equal(sample.same,true,JSON.stringify({dpr,wrap,sample}));assert.equal(sample.text,'KEEP-GLYPH-IDENTITY');assert.equal(sample.top,baseline.top,JSON.stringify({dpr,wrap,sample,baseline}));assert.equal(sample.scrollTop,baseline.scrollTop,JSON.stringify({dpr,wrap,sample,baseline}));}
      }
      const retained=await page.evaluate("Number(document.getElementById('count').textContent.split('/')[1].trim())");
      assert.ok(retained<3200&&retained>1000,JSON.stringify({dpr,wrap,retained}));
    }
    await page.evaluate("(()=>{const q=document.getElementById('q');q.value='';q.dispatchEvent(new Event('input',{bubbles:true}))})()");await page.frames();
  });

  // 相同末行在追加前后应有相同像素，不只比较DOM矩形；字体真实改为13/14/15px，模拟宿主DPI而非页面zoom。
  await t.test('identical streamed rows retain identical glyph pixels',async()=>{
    await page.viewport(1600,1.25);await page.format('standard');
    if(await page.evaluate("document.body.classList.contains('wrap')"))await page.click('b-wrap');
    for(const size of [13,14,15]){
      await page.evaluate("document.body.style.setProperty('--vscode-editor-font-size',"+JSON.stringify(size+'px')+")");await page.frames();
      await page.post({type:'reset'});
      const fixed=item('stable baseline ABC 0123456789');
      await page.post({type:'batch',items:Array.from({length:120},()=>({...fixed}))});
      // 只比较消息字形，避免把相邻级别徽标圆角的亚像素抗锯齿当作文字位移。
      const clip=await page.evaluate("(()=>{const r=document.querySelector('#win .row:last-child .m').getBoundingClientRect();return{x:r.left,y:r.top,width:r.width,height:r.height}})()");
      const before=await page.region(clip);
      for(let i=0;i<5;i++){
        await page.post({type:'batch',items:Array.from({length:[1,2,7,3,5][i]},()=>({...fixed}))});
        const after=await page.region(clip);
        if(after!==before){
          const directory=await fs.mkdtemp(path.join(os.tmpdir(),'logcat-jitter-pixels-'));
          await fs.writeFile(path.join(directory,'before.png'),Buffer.from(before,'base64'));
          await fs.writeFile(path.join(directory,'after.png'),Buffer.from(after,'base64'));
          const geometry=await page.evaluate("(()=>{const sc=document.getElementById('sc'),win=document.getElementById('row-window'),r=win.lastElementChild.getBoundingClientRect();return{top:r.top,height:r.height,scrollTop:sc.scrollTop,winTop:win.style.top,lineHeight:getComputedStyle(sc).lineHeight,dpr:devicePixelRatio}})()");
          t.diagnostic('Jitter pixels: '+directory+' '+JSON.stringify({size,i,clip,geometry}));
        }
        assert.ok(after===before,'glyph pixels changed on identical row, size='+size+', append='+i);
      }
    }
    await page.evaluate("document.body.style.setProperty('--vscode-editor-font-size','14px')");await page.frames();
  });

  // 分离文字绘制层后，横向原生滚动范围和内容坐标仍需一致，且不能覆盖工具栏或底部滚动条。
  await t.test('local text viewport preserves native horizontal scrolling',async()=>{
    await page.viewport(480);await page.post({type:'reset'});
    if(await page.evaluate("document.body.classList.contains('wrap')"))await page.click('b-wrap');
    await page.post({type:'batch',items:[item('horizontal '+ 'long '.repeat(150))]});
    const before=await page.evaluate("(()=>{const sc=document.getElementById('sc'),m=document.querySelector('#win .m');return{width:sc.scrollWidth,client:sc.clientWidth,x:m.getBoundingClientRect().left}})()");assert.ok(before.width>before.client);
    await page.evaluate("document.getElementById('sc').scrollLeft=120");await page.frames();
    const after=await page.evaluate("(()=>{const sc=document.getElementById('sc'),m=document.querySelector('#win .m'),r=document.getElementById('row-viewport').getBoundingClientRect();return{left:sc.scrollLeft,x:m.getBoundingClientRect().left,clipLeft:r.left,scLeft:sc.getBoundingClientRect().left,height:r.height,client:sc.clientHeight}})()");
    assert.equal(after.left,120);assert.ok(Math.abs(before.x-after.x-120)<0.05);assert.equal(after.clipLeft,after.scLeft);assert.equal(after.height,after.client);
    await page.evaluate("document.getElementById('sc').scrollLeft=0");await page.frames();
  });

  // 奇数字号产生分数行高；持续单条追加时末行基线必须稳定，不能只检查静止帧。
  await t.test('streaming rows keep a stable baseline with odd editor font sizes',async()=>{
    await page.viewport(1440,1.25);
    for(const size of [13,15]){
      await page.evaluate("document.body.style.setProperty('--vscode-editor-font-size',"+JSON.stringify(size+'px')+")");await page.frames();
      for(const fmt of ['standard','compact']) for(const wrap of [false,true]){
        await page.format(fmt);
        await page.post({type:'reset'});
        if(await page.evaluate("document.body.classList.contains('wrap')")!==wrap)await page.click('b-wrap');
        await page.post({type:'batch',items:Array.from({length:100},(_,i)=>item('stream-'+i))});
        const bottoms=[];
        for(let i=0;i<12;i++){
          const message=item('stream-new-'+String(i).padStart(2,'0')+(wrap?' long-message'.repeat(35*(i%3+1)):''));
          // 生产 message 监听先注册；其 render 回调之后同帧采样，再采样后续帧，禁止等待稳定后才测。
          const samples=await page.evaluate("new Promise(resolve=>{window.addEventListener('message',function received(){window.removeEventListener('message',received);const values=[];function frame(){const sc=document.getElementById('sc'),m=document.querySelector('#win .row:last-child .m');values.push({bottom:m.getBoundingClientRect().bottom,text:m.textContent,gap:sc.scrollHeight-sc.clientHeight-sc.scrollTop});if(values.length===3)resolve(values);else requestAnimationFrame(frame)}requestAnimationFrame(frame)});window.postMessage({type:'batch',items:["+JSON.stringify(message)+"]},'*')})");
          for(const sample of samples){assert.equal(sample.text,message.msg);assert.ok(sample.gap<=1,JSON.stringify(sample));bottoms.push(sample.bottom);}
          await follows(page,true);
        }
        assert.ok(Math.max(...bottoms)-Math.min(...bottoms)<0.05,JSON.stringify({size,fmt,wrap,bottoms}));
      }
    }
    await page.evaluate("document.body.style.setProperty('--vscode-editor-font-size','14px')");await page.frames();
  });

  // 超过 3000 行但仍在 byte budget 内：搜索首部必须实际可见，恢复跟随后能到新末尾。
  await t.test('wrapped cache beyond 3000 rows remains searchable',async()=>{
    await page.post({type:'reset'});
    if(!await page.evaluate("document.body.classList.contains('wrap')"))await page.click('b-wrap');
    await page.post({type:'batch',items:[item('CACHE-FIRST-UNIQUE'),...Array.from({length:3400},(_,i)=>item('cache-'+i)),item('CACHE-LAST-UNIQUE')]});
    await page.search('CACHE-FIRST-UNIQUE');assert.equal(await page.evaluate("document.getElementById('scount').textContent"),'1/1');
    assert.equal(await page.evaluate(`(()=>{const row=document.querySelector('#win .row.cur'),sc=document.getElementById('sc');if(!row)return false;const a=row.getBoundingClientRect(),b=sc.getBoundingClientRect();return row.textContent.includes('CACHE-FIRST-UNIQUE')&&a.top>=b.top-1&&a.bottom<=b.bottom+1})()`),true);
    await page.key('Escape');
    if(!await page.evaluate("document.getElementById('b-end').classList.contains('on')"))await page.click('b-end');
    await page.post({type:'batch',items:[item('CACHE-APPENDED-LAST')]});await atEnd(page,'CACHE-APPENDED-LAST');
  });

  // 虚拟和 wrap 均覆盖：非跟随追加及真实 1MiB 前部淘汰后，存活锚点仍位于相同屏幕位置。
  await t.test('surviving scroll anchors stay stable through append and prefix eviction',async()=>{
    for(const wrap of [false,true]){
      await page.post({type:'reset'});
      if(await page.evaluate("document.body.classList.contains('wrap')")!==wrap)await page.click('b-wrap');
      await page.post({type:'batch',items:Array.from({length:4500},(_,i)=>item(('anchor-'+String(i).padStart(4,'0')+' ').padEnd(220,'x')))});
      await page.evaluate("document.getElementById('sc').scrollTop=document.getElementById('sc').scrollHeight/2");await page.frames();await follows(page,false);
      const anchor=await page.evaluate(`(()=>{const y=document.getElementById('sc').getBoundingClientRect().top,row=[...document.querySelectorAll('#win .row')].find(row=>row.getBoundingClientRect().top>=y);return{text:row.querySelector('.m').textContent,top:row.getBoundingClientRect().top}})()`);
      for(const count of [10,800]){
        await page.post({type:'batch',items:Array.from({length:count},(_,i)=>item(('new-'+count+'-'+i+' ').padEnd(220,'y')))});
        const after=await page.evaluate(`(()=>{const row=[...document.querySelectorAll('#win .row')].find(row=>row.querySelector('.m').textContent===${JSON.stringify(anchor.text)});return row?row.getBoundingClientRect().top:null})()`);
        assert.notEqual(after,null,'surviving anchor rendered after '+count+' appends, wrap='+wrap);
        assert.ok(Math.abs(after-anchor.top)<=1,JSON.stringify({wrap,count,anchor,after}));
      }
      const retained=await page.evaluate("Number(document.getElementById('count').textContent.split('/')[1].trim())");
      assert.ok(retained<5310&&retained>4000,'byte budget really evicted oldest records: '+retained);
    }
  });

  // 同毫秒 header 各首行完整，只有真正 msg 内 newline 的续行可空；两种格式逐字段断言。
  await t.test('same-millisecond records keep independent first-line metadata',async()=>{
    await page.post({type:'reset'});
    await page.post({type:'batch',items:[item('same-first'),item('same-second'),item('same-third\nreal-continuation')]});
    for(const fmt of ['standard','compact']){
      await page.format(fmt);
      const rows=await page.evaluate("[...document.querySelectorAll('#win .row')].map(row=>[...row.children].map(span=>span.textContent))");
      assert.equal(rows.length,4);
      const head=fmt==='standard'?['2026-11-16 18:00:00.001','123-456','SharedTag','com.browser.fixture','I']:['18:00:00.001','I','SharedTag'];
      for(let i=0;i<3;i++)assert.deepEqual(rows[i],[...head,['same-first','same-second','same-third'][i]]);
      assert.deepEqual(rows[3],[...head.map(()=>''),'real-continuation']);
    }
  });
  } catch (error) { console.error('Logcat browser failure before cleanup:', error); throw error; }
});

// LOGCAT_BROWSER=1 node --test --test-name-pattern=dropdown tests/logcat-browser.test.js：真实CSS级联、鼠标展开/键盘选择、主题切换、长文本与滚动上限断言，无ADB设备依赖。
test('dropdown browser themes native choices and bounded menus', {skip:!enabled,timeout:60000}, async t => {
  const controller=new AbortController();
  const deadline=setTimeout(()=>controller.abort(new Error('Dropdown browser deadline exceeded')),45000);
  t.after(()=>clearTimeout(deadline));
  const page=await browser(t,await fixture(),controller.signal);
  assert.equal(await page.evaluate('CSS.supports("appearance","base-select")'),true);
  // 生产页面的设备列表走真实消息协议；第一项较长、第二项离线，其余项覆盖滚动。
  await page.post({type:'devices',list:Array.from({length:24},(_,i)=>({serial:'dropdown-'+i,model:i===0?'Android development device with a long readable name':i===1?'Offline device':'Device '+i,state:i===1?'offline':'device'})),serial:'dropdown-0'});
  for(const theme of ['dark','light','high-contrast','high-contrast-light']) for(const width of [240,283,800]) {
    const light=theme==='light'||theme==='high-contrast-light';
    const bg=light?'rgb(255, 255, 255)':'rgb(37, 37, 38)', fg=light?'rgb(32, 32, 32)':'rgb(204, 204, 204)';
    await page.viewport(width);
    await page.evaluate(`(()=>{
      document.body.className='vscode-'+${JSON.stringify(theme)};
      for(const [key,value] of Object.entries({'menu-background':${JSON.stringify(bg)},'menu-foreground':${JSON.stringify(fg)},'dropdown-background':${JSON.stringify(bg)},'dropdown-foreground':${JSON.stringify(fg)},'descriptionForeground':${JSON.stringify(fg)},'focusBorder':'#007acc','menu-border':${JSON.stringify(light?'#b8b8b8':'#454545')},'list-hoverBackground':${JSON.stringify(light?'#e8e8e8':'#37373d')}}))document.body.style.setProperty('--vscode-'+key,value);
      document.body.style.backgroundColor=${JSON.stringify(bg)};document.body.style.color=${JSON.stringify(fg)};
      document.body.style.setProperty('--vscode-editor-background',${JSON.stringify(bg)});
      document.getElementById('dev').value='dropdown-0';
      const dev=document.getElementById('dev');dev.focus();
    })()`);
    const rect=await page.evaluate("(()=>{const r=document.getElementById('dev').getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2,height:r.height}})()");
    assert.equal(rect.height,28);
    // 箭头对齐回归：真实长设备名下，与Format逐属性和中心位置比较，不以CSS声明存在代替视觉几何。
    const arrowStyles=await page.evaluate("(()=>['dev','fmt'].map(id=>{const el=document.getElementById(id),s=getComputedStyle(el,'::picker-icon'),r=el.getBoundingClientRect();return {style:Object.fromEntries(['content','fontFamily','fontSize','color','width','height','position','insetInlineEnd','top','translate','pointerEvents'].map(k=>[k,s[k]])),padding:getComputedStyle(el).paddingInlineEnd,center:r.y+r.height/2,width:r.width,overlay:document.querySelectorAll('.device-select-arrow').length}}))()");
    assert.deepEqual(arrowStyles[0].style,arrowStyles[1].style);
    assert.equal(arrowStyles[0].style.position,'static');
    assert.equal(arrowStyles[0].style.width,'16px');
    assert.equal(arrowStyles[0].style.fontSize,'16px');
    assert.ok(parseFloat(arrowStyles[0].style.height)>0&&parseFloat(arrowStyles[0].style.height)<rect.height);
    assert.equal(arrowStyles[0].style.fontFamily,'codicon');
    assert.equal(arrowStyles[0].padding,arrowStyles[1].padding);
    assert.equal(arrowStyles[0].padding,'8px');
    assert.ok(Math.abs(arrowStyles[0].center-arrowStyles[1].center)<1,JSON.stringify(arrowStyles));
    assert.equal(arrowStyles[0].overlay,0);
    const labelBounds=await page.evaluate("(()=>['dev','fmt'].map(id=>{const s=document.getElementById(id),label=s.querySelector('selectedcontent'),r=s.getBoundingClientRect(),a=getComputedStyle(s,'::picker-icon'),c=getComputedStyle(s),l=label.getBoundingClientRect();return {id,left:l.left,right:l.right,width:l.width,arrowLeft:r.right-parseFloat(c.borderRightWidth)-parseFloat(c.paddingRight)-parseFloat(a.width),clip:getComputedStyle(label).overflow,textOverflow:getComputedStyle(label).textOverflow,text:label.textContent,selected:s.selectedOptions[0].textContent,scroll:label.scrollWidth,client:label.clientWidth}}))()");
    for(const label of labelBounds){assert.ok(label.width>0,JSON.stringify(label));assert.ok(label.right+7<=label.arrowLeft,JSON.stringify(label));assert.equal(label.clip,'hidden');assert.equal(label.textOverflow,'ellipsis');assert.equal(label.text,label.selected);}
    assert.ok(labelBounds[0].scroll>labelBounds[0].client,JSON.stringify(labelBounds[0]));

    if(width===800&&(theme==='dark'||theme==='light'))await page.screenshot('arrow-aligned-'+theme);

    await page.mouse('mousePressed',rect.x,rect.y); await page.mouse('mouseReleased',rect.x,rect.y); await page.frames();
    assert.equal(await page.evaluate("document.getElementById('dev').matches(':open')"),true);
    const actual=await page.evaluate(`(()=>{const dev=document.getElementById('dev'),popup=getComputedStyle(dev,'::picker(select)'),first=dev.selectedOptions[0],r=first.getBoundingClientRect();return {appearance:getComputedStyle(dev).appearance,bg:popup.backgroundColor,fg:popup.color,radius:popup.borderRadius,maxHeight:parseFloat(popup.maxHeight),scroll:popup.overflowY,icon:getComputedStyle(first,'::before').fontFamily,check:getComputedStyle(first,'::checkmark').fontFamily,x:r.x,right:r.right,height:r.height,disabled:dev.querySelector('[value=dropdown-1]').disabled}})()`);
    assert.equal(actual.appearance,'base-select');assert.equal(actual.bg,bg);assert.equal(actual.fg,fg);assert.equal(actual.radius,'6px');assert.ok(actual.maxHeight<=320);assert.equal(actual.scroll,'auto');assert.equal(actual.icon,'codicon');assert.equal(actual.check,'codicon');assert.ok(actual.x>=0&&actual.right<=width,JSON.stringify(actual));assert.ok(actual.height>=32);assert.equal(actual.disabled,true);
    if(width===800&&(theme==='dark'||theme==='light'))await page.screenshot('dropdown-'+theme);
    await page.key('Escape');assert.equal(await page.evaluate("document.getElementById('dev').matches(':open')"),false);
    await page.key('ArrowDown');
    assert.equal(await page.evaluate("document.getElementById('dev').matches(':open')"),true);
    await page.key('ArrowDown');await page.key('Enter');
    assert.equal(await page.evaluate("document.getElementById('dev').value"),'dropdown-2');
    assert.deepEqual(await page.evaluate("window.__hostMessages.filter(m=>m.type==='select').at(-1)"),{type:'select',serial:'dropdown-2'});
    // 用真实共享CSS覆盖所有弹窗选择器，比较背景、圆角和滚动约束；不替代原生select的交互断言。
    const menus=await page.evaluate(`(()=>{const results=[];for(const selector of ['.menu','#menu','.explorer-menu','#sugg']){const menu=document.createElement('div');if(selector[0]==='#')menu.id=selector.slice(1);else menu.className=selector.slice(1);menu.style.cssText='display:block;position:fixed;left:4px;top:80px;width:180px';const row=document.createElement(selector==='.explorer-menu'?'button':'div');if(selector==='#sugg')row.className='si';row.textContent='Available action';menu.append(row);document.body.append(menu);const s=getComputedStyle(menu),r=getComputedStyle(row);results.push({selector,bg:s.backgroundColor,fg:s.color,radius:s.borderRadius,padding:s.padding,maxHeight:parseFloat(s.maxHeight),overflow:s.overflowY,rowHeight:parseFloat(r.minHeight)});menu.remove()}return results})()`);
    for(const menu of menus){assert.equal(menu.bg,bg,menu.selector);assert.equal(menu.fg,fg,menu.selector);assert.equal(menu.radius,'6px');assert.equal(menu.padding,'4px');assert.ok(menu.maxHeight<=320);assert.equal(menu.overflow,'auto');assert.equal(menu.rowHeight,30);}
  }
  // 目录刷新、断开空态和重连均保留唯一selectedcontent；复现用户设备名，比较实际文本右边界与箭头左边界。
  for(const list of [[{serial:'short',model:'Pixel',state:'device'}],[],[{serial:'VKH6IFDMBUKJ8XXC',model:'9566X API 35',state:'device'}]]){
    await page.viewport(283);
    await page.post({type:'devices',list,serial:list[0]?.serial||''});
    const fresh=await page.evaluate("(()=>{const s=document.getElementById('dev'),label=s.querySelector('selectedcontent'),r=s.getBoundingClientRect(),a=getComputedStyle(s,'::picker-icon'),c=getComputedStyle(s),l=label.getBoundingClientRect();return {count:s.querySelectorAll('selectedcontent').length,width:l.width,right:l.right,arrowLeft:r.right-parseFloat(c.borderRightWidth)-parseFloat(c.paddingRight)-parseFloat(a.width),text:label.textContent,expected:s.selectedOptions[0].textContent}})()");
    assert.equal(fresh.count,1);assert.ok(fresh.width>0);assert.ok(fresh.right+7<=fresh.arrowLeft,JSON.stringify(fresh));assert.equal(fresh.text,fresh.expected);
  }
  // 其余视图使用各自真实样式与同一份共享CSS，覆盖项目/变体、进程排序及动态扩展设置选择器的级联和原生键盘。
  for(const [file,id,className] of [['build-panel.css','build-project',''],['build-panel.css','build-target',''],['device-processes/processes.css','sort-test','process-sort'],['extended/main.css','setting-test','']]) {
    const style=await fs.readFile(path.join(root,'media',file),'utf8')+await fs.readFile(path.join(root,'media/dropdowns.css'),'utf8');
    await page.viewport(240);
    await page.evaluate('(function(css,id,className){document.getElementById("dropdown-companion-style")?.remove();document.getElementById("dropdown-companion")?.remove();const style=document.createElement("style");style.id="dropdown-companion-style";style.textContent=css;document.head.append(style);const host=document.createElement("div");host.id="dropdown-companion";host.style.cssText="position:fixed;left:8px;bottom:20px;width:200px;z-index:100";const select=document.createElement("select");select.id=id;select.className=className;select.setAttribute("aria-label","Dropdown verification");select.style.width="200px";for(const [value,label,disabled] of [["first","First item",false],["disabled","Unavailable",true],["next","Next item with a long descriptive label",false]]){const option=document.createElement("option");option.value=value;option.textContent=label;option.disabled=disabled;select.append(option)}host.append(select);document.body.append(host);select.focus()})('+JSON.stringify(style)+','+JSON.stringify(id)+','+JSON.stringify(className)+')');
    const expression='document.getElementById('+JSON.stringify(id)+')';
    assert.equal(await page.evaluate('getComputedStyle('+expression+').appearance'),'base-select',file);
    await page.key('ArrowDown');assert.equal(await page.evaluate(expression+".matches(':open')"),true);
    const box=await page.evaluate('(()=>{const s='+expression+',p=getComputedStyle(s,"::picker(select)"),r=s.options[0].getBoundingClientRect();return {x:r.x,right:r.right,bottom:r.bottom,radius:p.borderRadius,bg:p.backgroundColor,selectedBg:getComputedStyle(s.options[0]).backgroundColor}})()');
    assert.equal(box.radius,'6px');assert.equal(box.bg,'rgb(255, 255, 255)');assert.equal(box.selectedBg,'rgb(232, 232, 232)');assert.ok(box.x>=0&&box.right<=240&&box.bottom<=720,JSON.stringify({file,box}));
    await page.key('ArrowDown');await page.key('Enter');assert.equal(await page.evaluate(expression+'.value'),'next');
    await page.evaluate('document.getElementById("dropdown-companion").remove();document.getElementById("dropdown-companion-style").remove()');
  }

  // 真实Explorer脚本经消息生成文件行，右键事件打开八项菜单；240/800px边缘定位、内边距、标签完整和Escape关闭均执行断言。
  const explorerCSS=await fs.readFile(path.join(root,'media/device-explorer/main.css'),'utf8')+await fs.readFile(path.join(root,'media/dropdowns.css'),'utf8');
  await page.evaluate('(function(css){const style=document.createElement("style");style.textContent=css;document.head.append(style);const root=document.createElement("section");root.id="device-explorer";root.style.cssText="position:fixed;inset:100px 0 0;height:auto;z-index:30;background:var(--popup-bg)";document.body.append(root);window.send=m=>window.__hostMessages.push(m)})('+JSON.stringify(explorerCSS)+')');
  for(const file of ['media/device-processes/processes.js','media/device-explorer/main.js'])await page.evaluate(await fs.readFile(path.join(root,file),'utf8'));
  await page.post({type:'explorerState',serial:'dropdown-phone',tab:'files',capabilities:{}});
  await page.post({type:'explorerFiles',path:'/',entries:[{path:'/example',name:'example',kind:'file',permissions:'-rw-r--r--',size:24}]});
  for(const theme of ['dark','light'])for(const width of [240,800]){
    await page.viewport(width);
    await page.evaluate('document.body.className='+JSON.stringify('vscode-'+theme)+';document.body.style.setProperty("--vscode-menu-background",'+JSON.stringify(theme==='light'?'#fff':'#252526')+');document.body.style.setProperty("--vscode-menu-foreground",'+JSON.stringify(theme==='light'?'#202020':'#ccc')+')');
    await page.evaluate('document.querySelector(".file-row").dispatchEvent(new MouseEvent("contextmenu",{bubbles:true,cancelable:true,clientX:innerWidth-2,clientY:innerHeight-2}))');
    const menu=await page.evaluate('(()=>{const menu=document.querySelector(".explorer-menu"),r=menu.getBoundingClientRect(),s=getComputedStyle(menu);return{x:r.x,right:r.right,bottom:r.bottom,width:r.width,inner:menu.clientWidth,padding:parseFloat(s.paddingLeft),radius:s.borderRadius,labels:[...menu.children].map(row=>({width:row.clientWidth,fits:row.scrollWidth<=row.clientWidth,text:row.textContent}))}})()');
    assert.ok(menu.x>=0&&menu.right<=width&&menu.bottom<=720,JSON.stringify(menu));assert.equal(menu.width,180);assert.equal(menu.radius,'6px');assert.equal(menu.labels.length,8);assert.ok(menu.labels.every(row=>row.width===menu.inner-2*menu.padding&&row.fits));
    await page.key('Escape');assert.equal(await page.evaluate('document.querySelectorAll(".explorer-menu").length'),0);
  }
});
