const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { transformSync } = require('esbuild');
const root = path.join(__dirname, '..');

// 生成真实RunningDeviceView模板并内联实际CSS；只替代VS Code消息端，不改生产布局或暴露测试API。
function fixture() {
  const module = { exports: {} };
  const vscode = { Uri: { file: value => value, joinPath: (...parts) => parts.join('/') } };
  vm.runInNewContext(transformSync(fs.readFileSync(path.join(root, 'src/runningDevices.ts'), 'utf8'), { loader: 'ts', format: 'cjs' }).code, {
    module, exports: module.exports, Buffer, process,
    require: id => id === 'vscode' ? vscode : id.startsWith('./') ? {} : require(id)
  });
  const view = new module.exports.RunningDeviceView(root, undefined, { visible: false, mode: 'processes', save: async () => {} });
  const webview = { cspSource: 'test:', asWebviewUri: value => value, postMessage() {}, onDidReceiveMessage() {} };
  view.resolveWebviewView({ webview, onDidDispose() {}, onDidChangeVisibility() {} });
  const html = webview.html.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/g, '').replace(/<link[^>]*>/g, '').replace(/<script[\s\S]*?<\/script>/g, '');
  const font = fs.readFileSync(path.join(root, 'media/codicons/codicon.ttf')).toString('base64');
  const css = fs.readFileSync(path.join(root, 'media/codicons/codicon.css'), 'utf8').replace(/url\([^)]*\)/g, 'url(data:font/ttf;base64,' + font + ')')
    + fs.readFileSync(path.join(root, 'media/build-panel.css'), 'utf8') + fs.readFileSync(path.join(root, 'media/device-explorer/main.css'), 'utf8');
  return html.replace('</head>', '<style>' + css + '</style></head>');
}

// 可重复真实浏览器回归：设置EXPLORER_PLAYWRIGHT为已安装playwright模块路径、EXPLORER_BROWSER为浏览器路径。
// 240/320/728px深浅主题各100项：Files保留表格对齐/滚动，Processes卡片完整字段、长名称换行、筛选排序单选且无横向滚动。
test('Explorer files scroll in aligned columns and process cards never scroll horizontally', { skip: !process.env.EXPLORER_PLAYWRIGHT, timeout: 60000 }, async () => {
  const { chromium } = require(process.env.EXPLORER_PLAYWRIGHT);
  const html = fixture();
  const screenshots = process.env.EXPLORER_SCREENSHOTS || path.join(os.tmpdir(), 'explorer-layout-regressions');
  fs.mkdirSync(screenshots, { recursive: true });
  const browser = await chromium.launch({ executablePath: process.env.EXPLORER_BROWSER, headless: true });
  try {
    for (const theme of ['dark', 'light']) for (const width of [240, 320, 728]) for (const mode of ['explorer', 'processes']) {
      const page = await browser.newPage({ viewport: { width, height: 800 } });
      const errors = [];
      page.on('pageerror', error => errors.push(String(error)));
      try {
        await page.setContent(html);
        await page.addStyleTag({ content: ':root{--vscode-font-family:Segoe UI;--vscode-font-size:13px;--vscode-editor-background:' + (theme === 'dark' ? '#202124' : '#fff') + ';--vscode-foreground:' + (theme === 'dark' ? '#ddd' : '#222') + ';--vscode-icon-foreground:var(--vscode-foreground);--vscode-descriptionForeground:var(--vscode-foreground);--vscode-input-foreground:var(--vscode-foreground);--vscode-dropdown-foreground:var(--vscode-foreground);--vscode-dropdown-background:var(--vscode-editor-background)}body{background:var(--vscode-editor-background)}' });
        await page.evaluate(theme => { window.sent = []; window.send = message => window.sent.push(message); document.body.classList.toggle('vscode-light', theme === 'light'); }, theme);
        for (const file of ['media/build-panel.js', 'media/device-explorer/processes.js', 'media/device-explorer/main.js']) await page.addScriptTag({ content: fs.readFileSync(path.join(root, file), 'utf8') });
        await page.evaluate(mode => {
          const deliver = data => window.dispatchEvent(new MessageEvent('message', { data }));
          deliver({ type: 'deviceViewMode', mode });
          deliver({ type: 'explorerState', serial: 'phone', deviceName: 'Phone', tab: mode === 'processes' ? 'processes' : 'files', capabilities: { debug: false } });
          deliver({ type: 'explorerFiles', path: '/', entries: Array.from({ length: 100 }, (_, i) => ({ path: '/file-' + i, name: 'file-' + i, kind: 'file', permissions: '-rw-r--r--', size: 1234, modified: 1700000000000 })) });
          deliver({ type: 'explorerProcesses', processes: Array.from({ length: 100 }, (_, i) => ({ pid: 1000 + i, name: 'com.example.app' + i + (i === 0 ? '.verylongprocessname'.repeat(6) : ''), abi: i === 0 ? 'arm64-v8a_' + 'extended'.repeat(6) : 'arm64', vm: 'ART', userId: 0, debugger: 'default' })) });
        }, mode);
        await page.evaluate(() => document.fonts.ready);
        if (mode === 'processes') {
          // 真正检查卡片及全部文本的矩形/滚动尺寸，不能只用overflow:hidden掩盖横向裁切。
          const geometry = await page.evaluate(() => {
            const list = document.querySelector('.process-list'), cards = [...list.querySelectorAll('.process-card')];
            const first = cards[0], name = first.querySelector('.process-name'), pid = first.querySelector('.process-pid');
            const bounds = element => { const r = element.getBoundingClientRect(); return { x:r.x, right:r.right, y:r.y, bottom:r.bottom, height:r.height }; };
            return { count:cards.length, card:bounds(first), name:bounds(name), pid:bounds(pid), details:bounds(first.querySelector('.process-details')), fields:[...first.querySelectorAll('.process-field')].map(bounds), labels:[...first.querySelectorAll('dt')].map(e=>e.textContent), values:[...first.querySelectorAll('dd')].map(e=>e.textContent), fits:cards.every(card=>card.scrollWidth<=card.clientWidth&&[...card.querySelectorAll('.process-name,dd')].every(e=>e.scrollWidth<=e.clientWidth)), noOverlap:cards.every((card,i)=>i===0||cards[i-1].getBoundingClientRect().bottom<=card.getBoundingClientRect().y), horizontal:list.scrollWidth>list.clientWidth, vertical:list.scrollHeight>list.clientHeight, pageOverflow:document.documentElement.scrollWidth>innerWidth||document.documentElement.scrollHeight>innerHeight, headCount:document.querySelectorAll('.process-head').length };
          });
          assert.equal(geometry.count,100); assert.equal(geometry.headCount,0);
          const controls=await page.evaluate(()=>{const select=document.querySelector('.process-sort'),query=document.querySelector('.process-filter'),direction=document.querySelector('.process-sort-direction');const canvas=document.createElement('canvas'),context=canvas.getContext('2d');context.font=getComputedStyle(select).font;return {text:context.measureText(select.options[select.selectedIndex].text).width,available:select.clientWidth-32,ordered:query.getBoundingClientRect().right<=select.getBoundingClientRect().x&&select.getBoundingClientRect().right<=direction.getBoundingClientRect().x,right:direction.getBoundingClientRect().right};});
          assert.ok(controls.text<=controls.available&&controls.ordered&&controls.right<=width);
          assert.equal(geometry.horizontal,false); assert.equal(geometry.pageOverflow,false); assert.equal(geometry.fits,true); assert.equal(geometry.noOverlap,true); assert.equal(geometry.vertical,true);
          assert.ok(geometry.card.x>=0&&geometry.card.right<=width);
          assert.ok(geometry.name.height>18&&geometry.name.right<=geometry.pid.x&&geometry.details.y>=geometry.name.bottom);
          assert.ok(geometry.fields[0].right<=geometry.fields[1].x&&geometry.fields[0].bottom<=geometry.fields[2].y);
          assert.deepEqual(geometry.labels,['ABI','VM','User ID','Debugger']); assert.equal(geometry.values[2],'0'); assert.equal(geometry.values[3],'Default');
          // 每卡片五图标在窄面板完整可见、无重叠且有名称；真实键盘激活只发所属PID一次。
          const actions=await page.locator('.process-card').first().evaluate(card=>{const group=card.querySelector('.process-actions'),buttons=[...group.querySelectorAll('button')],bounds=card.getBoundingClientRect();return {count:buttons.length,titles:buttons.map(b=>b.title),labels:buttons.map(b=>b.getAttribute('aria-label')),disabled:buttons.map(b=>b.disabled),fits:buttons.every((b,i)=>{const r=b.getBoundingClientRect(),previous=buttons[i-1]?.getBoundingClientRect();return r.width===28&&r.height===28&&r.x>=bounds.x&&r.right<=bounds.right&&r.bottom<=bounds.bottom&&(!previous||r.y>=previous.bottom||r.x>=previous.right);}),icons:buttons.every(b=>getComputedStyle(b.querySelector('.codicon'),'::before').content!=='none')};});
          assert.equal(actions.count,5);assert.deepEqual(actions.titles,['Kill','Force Stop','Attach Debugger','Clear Data','Uninstall']);assert.deepEqual(actions.labels,actions.titles);assert.deepEqual(actions.disabled,[false,false,true,false,false]);assert.equal(actions.fits,true);assert.equal(actions.icons,true);
          await page.locator('.process-card').nth(1).click();
          const before=await page.evaluate(()=>window.sent.length);await page.locator('.process-card').first().getByRole('button',{name:'Kill',exact:true}).press('Enter');
          assert.equal(await page.evaluate(()=>window.sent.length),before+1);assert.equal((await page.evaluate(()=>window.sent.at(-1))).pid,1000);assert.equal(await page.locator('.process-card[aria-current="true"] .process-pid').textContent(),'PID 1001');
          await page.locator('.process-card').first().getByRole('button',{name:'Force Stop',exact:true}).press('Space');assert.equal(await page.evaluate(()=>window.sent.length),before+2);assert.equal((await page.evaluate(()=>window.sent.at(-1))).action,'forceStop');assert.equal((await page.evaluate(()=>window.sent.at(-1))).pid,1000);
          await page.screenshot({path:path.join(screenshots,'process-cards-'+width+'-'+theme+'-start.png')});
          await page.locator('.process-filter').fill('app99'); assert.equal(await page.locator('.process-card').count(),1);
          await page.locator('.process-card').click(); assert.equal(await page.locator('.process-card[aria-current="true"]').count(),1);
          assert.equal(await page.locator('.process-filter').inputValue(),'app99');
          await page.locator('.processes-view [title="Kill"]').click();
          const command=await page.evaluate(()=>window.sent.at(-1)); assert.equal(command.action,'kill'); assert.equal(command.pid,1099);
          await page.locator('.process-filter').fill(''); await page.locator('.process-sort').selectOption('pid');
          await page.locator('.process-sort-direction').click(); assert.equal(await page.locator('.process-pid').first().textContent(),'PID 1099');
          await page.locator('.process-list').evaluate(list=>{list.scrollLeft=list.scrollWidth;list.scrollTop=list.scrollHeight;});
          const scroll=await page.locator('.process-list').evaluate(list=>({x:list.scrollLeft,y:list.scrollTop,horizontal:list.scrollWidth>list.clientWidth}));
          assert.equal(scroll.x,0);assert.equal(scroll.horizontal,false);assert.ok(scroll.y>0);
          await page.screenshot({path:path.join(screenshots,'process-cards-'+width+'-'+theme+'-end.png')}); assert.deepEqual(errors,[]);
          continue;
        }
        const prefix = 'file';
        // 读取真实布局矩形而非静态CSS字符串；列宽、视口边界和文字可容纳性均由浏览器计算。
        const inspect = () => page.evaluate(prefix => {
          const list = document.querySelector('.' + prefix + '-list'), head = list.querySelector('.' + prefix + '-head'), row = list.querySelector('.' + prefix + '-row');
          const rect = element => { const r = element.getBoundingClientRect(); return { x: r.x, right: r.right, y: r.y, bottom: r.bottom, width: r.width, height: r.height }; };
          return { list: rect(list), head: rect(head), columns: [...head.children].map(rect), cells: [...row.children].map(rect), readable: [...head.children].every(e => e.scrollWidth <= e.clientWidth && getComputedStyle(e).whiteSpace === 'nowrap'), headCount: list.querySelectorAll('.' + prefix + '-head').length, scrollWidth: list.scrollWidth, clientWidth: list.clientWidth, scrollHeight: list.scrollHeight, clientHeight: list.clientHeight, scrollLeft: list.scrollLeft, scrollTop: list.scrollTop, overflow: document.documentElement.scrollWidth > innerWidth, pageOverflow: document.documentElement.scrollHeight > innerHeight };
        }, prefix);
        let actual = await inspect();
        assert.equal(actual.readable, true, mode + ' header labels fit');
        assert.equal(actual.headCount, 1);
        assert.equal(actual.overflow, false); assert.equal(actual.pageOverflow, false);
        assert.ok(actual.list.height > 100 && actual.list.bottom <= 800 && actual.scrollHeight > actual.clientHeight);
        for (let i = 0; i < actual.columns.length; i++) { assert.ok(Math.abs(actual.columns[i].x - actual.cells[i].x) < 1); assert.ok(Math.abs(actual.columns[i].width - actual.cells[i].width) < 1); }
        await page.locator('.' + prefix + '-list').evaluate(list => { list.scrollLeft = 0; list.scrollTop = 0; });
        actual = await inspect();
        assert.ok(Math.abs(actual.columns[0].x - actual.list.x) < 1, 'first column is readable at scroll origin');
        if (mode === 'explorer') {
          await page.locator('.file-row').first().click({ button: 'right' });
          const menu = await page.locator('.explorer-menu').evaluate(element => {
            const r = element.getBoundingClientRect();
            return { x: r.x, right: r.right, bottom: r.bottom, labels: [...element.querySelectorAll('button')].map(button => ({ width: button.clientWidth, fits: button.scrollWidth <= button.clientWidth, nowrap: getComputedStyle(button).whiteSpace === 'nowrap' })) };
          });
          assert.ok(menu.x >= 0 && menu.right <= width && menu.bottom <= 800, JSON.stringify({ theme, width, menu }));
          assert.equal(menu.labels.length, 8); assert.ok(menu.labels.every(label => label.width >= 178 && label.fits && label.nowrap));
          await page.keyboard.press('Escape'); assert.equal(await page.locator('.explorer-menu').count(), 0);
        }
        await page.screenshot({ path: path.join(screenshots, mode + '-' + width + '-' + theme + '-start.png') });
        await page.locator('.' + prefix + '-list').evaluate(list => { list.scrollLeft = list.scrollWidth; list.scrollTop = list.scrollHeight; });
        actual = await inspect();
        assert.equal(actual.headCount, 1); assert.ok(actual.scrollTop > 0);
        assert.ok(Math.abs(actual.head.y - actual.list.y) < 1, 'sticky header stays at scroller top');
        assert.ok(actual.columns.at(-1).right <= actual.list.right + 1 && actual.columns.at(-1).x >= actual.list.x, 'last column is reachable');
        for (let i = 0; i < actual.columns.length; i++) assert.ok(Math.abs(actual.columns[i].x - actual.cells[i].x) < 1, 'header follows horizontal scroll');
        if (width < 630) assert.ok(actual.scrollLeft > 0);
        await page.screenshot({ path: path.join(screenshots, mode + '-' + width + '-' + theme + '-end.png') });
        // 在真实DOM中展开200项目录，回复后反复开合不再发list且不重新排序全树。
        await page.evaluate(()=>window.dispatchEvent(new MessageEvent('message',{data:{type:'explorerFiles',path:'/',entries:[{path:'/folder',name:'folder',kind:'directory'}]}})));
        await page.locator('.twisty').first().click();
        assert.equal(await page.evaluate(()=>window.sent.filter(m=>m.action==='list'&&m.path==='/folder').length),1);
        await page.evaluate(()=>window.dispatchEvent(new MessageEvent('message',{data:{type:'explorerFiles',path:'/folder',entries:Array.from({length:200},(_,i)=>({path:'/folder/file-'+i,name:'file-'+i,kind:'file',modified:1700000000000}))}})));
        assert.equal(await page.locator('.file-row').count(),201);
        const cached=await page.evaluate(()=>{const start=performance.now();for(let i=0;i<4;i++)document.querySelector('.twisty').click();return {ms:performance.now()-start,requests:window.sent.filter(m=>m.action==='list'&&m.path==='/folder').length};});
        assert.equal(cached.requests,1);assert.ok(cached.ms<1000,JSON.stringify(cached));assert.equal(await page.locator('.file-row').count(),201);
        assert.deepEqual(errors, []);
      } finally { await page.close(); }
    }
  } finally { await browser.close(); }
});
