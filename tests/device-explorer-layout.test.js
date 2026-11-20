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
    + fs.readFileSync(path.join(root, 'media/build-panel.css'), 'utf8') + fs.readFileSync(path.join(root, 'media/device-explorer/main.css'), 'utf8') + fs.readFileSync(path.join(root, 'media/device-processes/processes.css'), 'utf8');
  return html.replace('</head>', '<style>' + css + fs.readFileSync(path.join(root, 'media/dropdowns.css'), 'utf8') + '</style></head>');
}

// 六按钮真实浏览器回归：Node>=22，EXPLORER_PLAYWRIGHT/EXPLORER_BROWSER指向已安装模块/浏览器；node --test tests/device-explorer-layout.test.js。
// 240/333/728px真实点击、文件选择器与FileReader、ACK、定位滚动、禁用及图标矩形/字体均必须断言，宿主消息替身不替换生产函数。
test('Explorer toolbar browser clicks upload and application reveal', {skip:!process.env.EXPLORER_PLAYWRIGHT,timeout:60000},async()=>{
  const {chromium}=require(process.env.EXPLORER_PLAYWRIGHT);
  const browser=await chromium.launch({executablePath:process.env.EXPLORER_BROWSER,headless:true});
  const screenshots=process.env.EXPLORER_SCREENSHOTS||path.join(os.tmpdir(),'explorer-toolbar-regressions');fs.mkdirSync(screenshots,{recursive:true});
  try{for(const width of [240,333,728]){
    const page=await browser.newPage({viewport:{width,height:600}}),errors=[];page.on('pageerror',e=>errors.push(String(e)));
    try{
      await page.setContent(fixture());
      await page.addStyleTag({content:':root{--vscode-font-family:Segoe UI;--vscode-foreground:#ddd;--vscode-descriptionForeground:#aaa;--vscode-editor-background:#1e1e1e;--vscode-list-activeSelectionBackground:#094771}body{background:#1e1e1e}'});
      await page.evaluate(()=>{window.sent=[];window.send=m=>{window.sent.push(m);if(m.transferId)window.dispatchEvent(new MessageEvent('message',{data:{type:'explorerUploadAck',serial:m.serial,transferId:m.transferId,action:m.action}}));};});
      for(const file of ['media/build-panel.js','media/device-processes/processes.js','media/device-explorer/main.js'])await page.addScriptTag({content:fs.readFileSync(path.join(root,file),'utf8')+(file==='media/build-panel.js'?';initBuildPanel(send);':'')});
      await page.evaluate(()=>{const send=data=>window.dispatchEvent(new MessageEvent('message',{data}));send({type:'deviceViewMode',mode:'explorer'});send({type:'explorerState',serial:'phone',tab:'files',active:true});send({type:'explorerFiles',path:'/',entries:[{path:'/file',name:'file',kind:'file'}]});});
      await page.evaluate(()=>document.fonts.ready);
      const bar=page.locator('.files-view .toolbar'),buttons=bar.locator('button');assert.equal(await buttons.count(),6);
      const geometry=await buttons.evaluateAll(buttons=>buttons.map(b=>{const r=b.getBoundingClientRect();return {title:b.title,label:b.getAttribute('aria-label'),x:r.x,right:r.right,width:r.width,height:r.height,icon:getComputedStyle(b.querySelector('.explorer-toolbar-glyph')).maskImage,glyphWidth:b.querySelector('.explorer-toolbar-glyph').getBoundingClientRect().width,glyphHeight:b.querySelector('.explorer-toolbar-glyph').getBoundingClientRect().height};}));
      assert.deepEqual(geometry.map(b=>b.title),['New Directory','Download','Upload','Delete','Refresh','Locate App Data']);
      for(let i=0;i<6;i++){const b=geometry[i];assert.equal(b.label,b.title);assert.equal(b.width,28);assert.equal(b.height,28);assert.ok(b.x>=0&&b.right<=width);assert.ok(b.icon.startsWith('url(')&&b.icon.includes('data:image/svg+xml'));assert.equal(b.glyphWidth,18);assert.equal(b.glyphHeight,18);if(i)assert.ok(b.x>=geometry[i-1].right);}
      assert.equal(await bar.getByRole('button',{name:'Download',exact:true}).isDisabled(),true);
      await page.locator('.file-row').click();
      for(const [name,action]of [['New Directory','newDirectory'],['Download','download'],['Delete','delete'],['Refresh','refresh'],['Locate App Data','locateApp']]){await bar.getByRole('button',{name,exact:true}).click();assert.equal(await page.evaluate(()=>window.sent.at(-1).action),action);}
      const chooser=page.waitForEvent('filechooser');await bar.getByRole('button',{name:'Upload',exact:true}).click();await(await chooser).setFiles({name:'toolbar.txt',mimeType:'text/plain',buffer:Buffer.from('toolbar bytes')});
      await page.waitForFunction(()=>window.sent.some(m=>m.action==='uploadEnd')&&window.__deviceExplorer.state.transfer===null);
      assert.equal(await page.evaluate(()=>atob(window.sent.find(m=>m.action==='uploadChunk').data)),'toolbar bytes');
      await page.evaluate(()=>{const send=data=>window.dispatchEvent(new MessageEvent('message',{data})),chain=['/','/data','/data/data','/data/data/com.example.app'];for(let i=0;i<chain.length;i++)send({type:'explorerFiles',path:chain[i],entries:[...(i===0?Array.from({length:80},(_,n)=>({path:'/aaa-'+n,name:'aaa-'+n,kind:'directory'})):[]),...(i+1<chain.length?[{path:chain[i+1],name:chain[i+1].split('/').pop(),kind:'directory'}]:[])]});send({type:'explorerReveal',serial:'phone',path:chain[3]});});
      const located=page.locator('.file-row[aria-selected="true"]');assert.equal(await located.getAttribute('data-path'),'/data/data/com.example.app');assert.equal(await located.isVisible(),true);assert.equal(await located.evaluate(row=>{const list=row.closest('.file-list'),r=row.getBoundingClientRect(),bounds=list.getBoundingClientRect();return list.scrollTop>0&&Math.abs(r.y-list.parentNode.querySelector('.file-head').getBoundingClientRect().bottom - 2)<1&&r.bottom<=bounds.bottom;}),true);
      await page.screenshot({path:path.join(screenshots,'toolbar-'+width+'.png')});
      await page.evaluate(()=>window.dispatchEvent(new MessageEvent('message',{data:{type:'explorerState',serial:'phone',tab:'files',active:false}})));assert.equal(await buttons.evaluateAll(bs=>bs.every(b=>b.disabled)),true);assert.deepEqual(errors,[]);
    }finally{await page.close();}
  }}finally{await browser.close();}
});

// intrinsic紧凑列回归：333/1440px、空/有数据及字体变化，真实DOM Range验证日期/权限标题尺寸和左右2px。
test('compact file columns use intrinsic font widths in empty and populated directories',{skip:!process.env.EXPLORER_PLAYWRIGHT,timeout:60000},async()=>{
  const {chromium}=require(process.env.EXPLORER_PLAYWRIGHT),browser=await chromium.launch({executablePath:process.env.EXPLORER_BROWSER,headless:true});
  try{for(const width of [333,1440]){
    const page=await browser.newPage({viewport:{width,height:700}}),errors=[];page.on('pageerror',error=>errors.push(String(error)));
    try{
      await page.setContent(fixture());await page.evaluate(()=>{window.send=()=>{};window.deliver=data=>window.dispatchEvent(new MessageEvent('message',{data}));});
      await page.addStyleTag({content:':root{--vscode-font-family:Segoe UI}'});
      for(const file of ['media/build-panel.js','media/device-processes/processes.js','media/device-explorer/main.js'])await page.addScriptTag({content:fs.readFileSync(path.join(root,file),'utf8')+(file==='media/build-panel.js'?';initBuildPanel(send);':'')});
      await page.evaluate(()=>{deliver({type:'deviceViewMode',mode:'explorer'});deliver({type:'explorerState',serial:'s',tab:'files',active:true});deliver({type:'explorerFiles',path:'/',entries:[]});});
      // 以同字体的真实文字节点Range量宽，不复用生产样本值或近似像素。
      const inspect=()=>page.evaluate(()=>{
        const head=document.querySelector('.file-head'),cells=[...head.children];
        const measure=(value,cell)=>{const span=document.createElement('span');span.textContent=value;span.style.cssText='position:absolute;white-space:nowrap;visibility:hidden';cell.appendChild(span);const range=document.createRange();range.selectNodeContents(span);const result=range.getBoundingClientRect().width;span.remove();return result;};
        const widths=cells.map(c=>c.getBoundingClientRect().width);
        return {widths,head:head.getBoundingClientRect().width,date:measure('2024-09-09 13:04:05',cells[2])+4,permissions:Math.max(measure('drwxrwxrwx',cells[1]),measure('Permissions',cells[1]))+4,padding:cells.map(c=>[getComputedStyle(c).paddingLeft,getComputedStyle(c).paddingRight]),fits:cells.every(c=>c.scrollWidth<=c.clientWidth),rows:[...document.querySelectorAll('.file-row')].map(row=>[...row.children].map((c,i)=>({width:c.getBoundingClientRect().width,x:c.getBoundingClientRect().x-cells[i].getBoundingClientRect().x,padding:[getComputedStyle(c).paddingLeft,getComputedStyle(c).paddingRight],fits:c.scrollWidth<=c.clientWidth}))),indents:[...document.querySelectorAll('.file-name')].map(c=>parseFloat(getComputedStyle(c).paddingLeft))};
      });
      for(const font of ['Segoe UI','Consolas']){
        await page.addStyleTag({content:'#device-explorer{font-family:'+font+'}'});await page.evaluate(()=>document.fonts.ready);
        const empty=await inspect();
        assert.equal(empty.widths[0],180);assert.ok(Math.abs(empty.widths[1]-empty.permissions)<0.1,JSON.stringify(empty));assert.ok(Math.abs(empty.widths[2]-empty.date)<0.1,JSON.stringify(empty));assert.ok(Math.abs(empty.head-empty.widths.reduce((a,b)=>a+b,0))<0.1);assert.equal(empty.fits,true);assert.deepEqual(empty.padding,Array.from({length:4},()=>['2px','2px']));
        await page.evaluate(()=>{deliver({type:'explorerFiles',path:'/',entries:[{path:'/a',name:'a',kind:'directory',permissions:'drwxrwxrwx',modified:new Date(2024,8,9,13,4,5).getTime()}]});document.querySelector('.twisty').click();deliver({type:'explorerFiles',path:'/a',entries:[{path:'/a/b',name:'b',kind:'directory',permissions:'drwxrwxrwx',modified:new Date(2024,0,2,0,0,0).getTime()}]});document.querySelector('.file-row[data-path="/a/b"] .twisty').click();deliver({type:'explorerFiles',path:'/a/b',entries:[{path:'/a/b/c',name:'c',kind:'file',permissions:'drwxrwxrwx',modified:new Date(2024,0,2,3,4,5).getTime()}]});});
        const full=await inspect();assert.deepEqual(full.widths,empty.widths);assert.deepEqual(full.indents,[0,10,20]);
        for(const row of full.rows)for(let i=0;i<4;i++){assert.ok(Math.abs(row[i].width-full.widths[i])<0.1);assert.ok(Math.abs(row[i].x)<0.1);if(i===1||i===2){assert.deepEqual(row[i].padding,['2px','2px']);assert.equal(row[i].fits,true);}}
        assert.deepEqual(await page.locator('.file-row .cell:nth-child(3)').allTextContents(),['2024-09-09 13:04:05','2024-01-02 00:00:00','2024-01-02 03:04:05']);
        await page.evaluate(()=>deliver({type:'explorerFiles',path:'/',entries:[]}));assert.deepEqual((await inspect()).widths,empty.widths);
      }
      assert.deepEqual(errors,[]);
    }finally{await page.close();}
  }}finally{await browser.close();}
});

// 从真实宽度拖动所有列并离开手柄；验证表头/数据同步、渲染保持、pointerup和pointercancel释放，不改生产函数。
test('file columns resize from measured widths and keep rows aligned', {skip:!process.env.EXPLORER_PLAYWRIGHT,timeout:60000},async()=>{
  const {chromium}=require(process.env.EXPLORER_PLAYWRIGHT),browser=await chromium.launch({executablePath:process.env.EXPLORER_BROWSER,headless:true});
  try{
    const page=await browser.newPage({viewport:{width:1000,height:700}});
    await page.setContent(fixture());await page.evaluate(()=>{window.send=()=>{};});
    for(const file of ['media/build-panel.js','media/device-processes/processes.js','media/device-explorer/main.js'])await page.addScriptTag({content:fs.readFileSync(path.join(root,file),'utf8')+(file==='media/build-panel.js'?';initBuildPanel(send);':'')});
    await page.evaluate(()=>{const send=data=>window.dispatchEvent(new MessageEvent('message',{data}));send({type:'deviceViewMode',mode:'explorer'});send({type:'explorerState',serial:'s',tab:'files',active:true});send({type:'explorerFiles',path:'/',entries:[{path:'/a',name:'very-long-name-'.repeat(40),kind:'file',permissions:'permissions-'.repeat(30),modified:1700000000000,size:1e30}]});});
    const widths=()=>page.locator('.file-head').evaluate(head=>[...head.children].map(c=>c.getBoundingClientRect().width));
    const aligned=()=>page.evaluate(()=>{const head=[...document.querySelector('.file-head').children],cells=[...document.querySelector('.file-row').children];return head.every((h,i)=>{const a=h.getBoundingClientRect(),b=cells[i].getBoundingClientRect();return Math.abs(a.x-b.x)<1&&Math.abs(a.width-b.width)<1;});});
    assert.equal(await page.locator('.column-grip').count(),4);
    for(let index=0;index<4;index++){
      const before=await widths(),grip=page.locator('.column-grip').nth(index);await grip.scrollIntoViewIfNeeded();const box=await grip.boundingBox();assert.ok(box);
      await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();await page.mouse.move(box.x+box.width/2-30,box.y+box.height/2,{steps:3});await page.mouse.up();
      const after=await widths();assert.ok(Math.abs(after[index]-Math.max([120,100,150,60][index],before[index]-30))<1,JSON.stringify({index,before,after,box}));for(let i=0;i<4;i++)if(i!==index)assert.ok(Math.abs(after[i]-before[i])<1);assert.equal(await aligned(),true);
      await page.mouse.move(10,10);assert.deepEqual(await widths(),after);
    }
    const retained=await widths();await page.locator('.file-row').click();assert.deepEqual(await widths(),retained);assert.equal(await aligned(),true);
    const grip=page.locator('.column-grip').first(),box=await grip.boundingBox();await page.mouse.move(box.x+4,box.y+10);await page.mouse.down();await page.mouse.move(box.x+34,box.y+10);const canceled=await widths();
    await grip.dispatchEvent('pointercancel',{pointerId:1});await page.mouse.move(box.x+64,box.y+10);await page.mouse.up();assert.deepEqual(await widths(),canceled);assert.equal(await aligned(),true);
    const containment=await page.locator('.file-row').evaluate(row=>{const cells=[...row.children],name=row.querySelector('.name');return {clipped:cells.every(cell=>getComputedStyle(cell).overflowX==='hidden'),nowrap:cells.slice(1).every(cell=>getComputedStyle(cell).whiteSpace==='nowrap'),ellipsis:cells.slice(1).every(cell=>getComputedStyle(cell).textOverflow==='ellipsis')&&getComputedStyle(name).textOverflow==='ellipsis',nameLong:name.scrollWidth>name.clientWidth,tooltips:[name,...cells.slice(1)].every(cell=>cell.title===cell.textContent),hits:cells.slice(0,-1).every((cell,i)=>{const next=cells[i+1],a=cell.getBoundingClientRect(),b=next.getBoundingClientRect();return a.right<=b.x+1&&next.contains(document.elementFromPoint(b.x+3,b.y+b.height/2));})};});
    assert.deepEqual(containment,{clipped:true,nowrap:true,ellipsis:true,nameLong:true,tooltips:true,hits:true});
    const directory=process.env.EXPLORER_SCREENSHOTS||path.join(os.tmpdir(),'explorer-toolbar-regressions');fs.mkdirSync(directory,{recursive:true});await page.screenshot({path:path.join(directory,'columns-contained.png')});
  }finally{await browser.close();}
});

// 原生浏览器在视口中部展开及Locate置顶后回复/折叠/再展开，必须维持同一个scroll容器与选中行坐标；没有延时补滚动或放宽位置断言。
test('file tree expansion keeps selected viewport anchor after locate and async replies',{skip:!process.env.EXPLORER_PLAYWRIGHT,timeout:60000},async()=>{
  const {chromium}=require(process.env.EXPLORER_PLAYWRIGHT),browser=await chromium.launch({executablePath:process.env.EXPLORER_BROWSER,headless:true});
  try{
    const page=await browser.newPage({viewport:{width:333,height:600}});await page.setContent(fixture());await page.evaluate(()=>{window.sent=[];window.send=m=>window.sent.push(m);window.deliver=data=>window.dispatchEvent(new MessageEvent('message',{data}));});
    for(const file of ['media/build-panel.js','media/device-processes/processes.js','media/device-explorer/main.js'])await page.addScriptTag({content:fs.readFileSync(path.join(root,file),'utf8')+(file==='media/build-panel.js'?';initBuildPanel(send);':'')});
    await page.evaluate(()=>{deliver({type:'deviceViewMode',mode:'explorer'});deliver({type:'explorerState',serial:'s',tab:'files',active:true});deliver({type:'explorerFiles',path:'/',entries:[...Array.from({length:80},(_,i)=>({path:'/a'+i,name:'a'+i,kind:'directory'})),{path:'/target',name:'target',kind:'directory'}]});});
    const row=page.locator('.file-row[data-path="/target"]');await row.scrollIntoViewIfNeeded();await row.click();
    await page.evaluate(()=>{window.originalList=document.querySelector('.file-list');window.originalRow=document.querySelector('.file-row[data-path="/target"]');});
    const measure=()=>row.evaluate(r=>{const list=r.closest('.file-list');return {y:r.getBoundingClientRect().y,top:list.scrollTop,left:list.scrollLeft,sameList:list===window.originalList,sameRow:r===window.originalRow,selected:r.getAttribute('aria-selected')};});
    let before=await measure();await page.evaluate(()=>deliver({type:'explorerFiles',path:'/target',entries:Array.from({length:40},(_,i)=>({path:'/target/file'+i,name:'file'+i,kind:'file'}))}));let after=await measure();assert.ok(Math.abs(after.y-before.y)<1,JSON.stringify({before,after}));assert.equal(after.sameList,true);assert.equal(after.sameRow,true);assert.equal(after.selected,'true');
    await page.evaluate(()=>deliver({type:'explorerReveal',serial:'s',path:'/target'}));before=await measure();
    for(const busy of [true,false]){await page.evaluate(busy=>deliver({type:'explorerProgress',busy,message:'Loading'}),busy);after=await measure();assert.ok(Math.abs(after.y-before.y)<1,JSON.stringify({before,after,busy}));}
    await row.click();after=await measure();assert.ok(Math.abs(after.y-before.y)<1,JSON.stringify({before,after,step:'collapse'}));await row.click();after=await measure();assert.ok(Math.abs(after.y-before.y)<1,JSON.stringify({before,after,step:'reopen'}));
    await page.evaluate(()=>{document.querySelector('.file-list').scrollLeft=50;deliver({type:'explorerFiles',path:'/target',entries:Array.from({length:70},(_,i)=>({path:'/target/file'+i,name:'file'+i,kind:'file'}))});});after=await measure();assert.equal(after.left,50);assert.equal(after.sameList,true);assert.equal(after.sameRow,true);assert.ok(Math.abs(after.y-before.y)<1);
    assert.equal(await row.evaluate(r=>Math.abs(r.getBoundingClientRect().y-r.closest('.file-list').parentNode.querySelector('.file-head').getBoundingClientRect().bottom - 2)<1),true);
  }finally{await browser.close();}
});

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
        for (const file of ['media/build-panel.js', 'media/device-processes/processes.js', 'media/device-explorer/main.js']) await page.addScriptTag({ content: fs.readFileSync(path.join(root, file), 'utf8') + (file === 'media/build-panel.js' ? ';initBuildPanel(send);' : '') });
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
            return { count:cards.length, list:bounds(list), card:bounds(first), nextCard:bounds(cards[1]), name:bounds(name), pid:bounds(pid), details:bounds(first.querySelector('.process-details')), actions:bounds(first.querySelector('.process-actions')), fields:[...first.querySelectorAll('.process-field')].map(bounds), labels:[...first.querySelectorAll('dt')].map(e=>e.textContent), values:[...first.querySelectorAll('dd')].map(e=>e.textContent), fits:cards.every(card=>card.scrollWidth<=card.clientWidth&&[...card.querySelectorAll('.process-name,dd')].every(e=>e.scrollWidth<=e.clientWidth)), noOverlap:cards.every((card,i)=>i===0||cards[i-1].getBoundingClientRect().bottom<=card.getBoundingClientRect().y), horizontal:list.scrollWidth>list.clientWidth, vertical:list.scrollHeight>list.clientHeight, pageOverflow:document.documentElement.scrollWidth>innerWidth||document.documentElement.scrollHeight>innerHeight, headCount:document.querySelectorAll('.process-head').length };
          });
          assert.equal(geometry.count,100); assert.equal(geometry.headCount,0);
          const controls=await page.evaluate(()=>{const select=document.querySelector('.process-sort'),query=document.querySelector('.process-filter'),direction=document.querySelector('.process-sort-direction');const canvas=document.createElement('canvas'),context=canvas.getContext('2d');context.font=getComputedStyle(select).font;return {text:context.measureText(select.options[select.selectedIndex].text).width,available:select.clientWidth-32,ordered:query.getBoundingClientRect().right<=select.getBoundingClientRect().x&&select.getBoundingClientRect().right<=direction.getBoundingClientRect().x,right:direction.getBoundingClientRect().right};});
          assert.ok(controls.text<=controls.available&&controls.ordered&&controls.right<=width);
          assert.equal(geometry.horizontal,false); assert.equal(geometry.pageOverflow,false); assert.equal(geometry.fits,true); assert.equal(geometry.noOverlap,true); assert.equal(geometry.vertical,true);
          assert.ok(geometry.card.x>=0&&geometry.card.right<=width); assert.ok(Math.abs((geometry.card.x-geometry.list.x)-(geometry.list.right-geometry.card.right))<1,JSON.stringify({width,theme,geometry})); assert.ok(Math.abs((geometry.nextCard.y-geometry.card.bottom)-10)<1);
          assert.ok(geometry.name.height>18&&geometry.name.right<=geometry.pid.x&&geometry.details.y>=geometry.name.bottom); assert.ok(geometry.actions.y>=geometry.details.bottom&&geometry.actions.right<=geometry.card.right);
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
          const list = document.querySelector('.' + prefix + '-list'), head = list.parentNode.querySelector('.' + prefix + '-head'), row = list.querySelector('.' + prefix + '-row');
          const rect = element => { const r = element.getBoundingClientRect(); return { x: r.x, right: r.right, y: r.y, bottom: r.bottom, width: r.width, height: r.height }; };
          return { list: rect(list), head: rect(head), columns: [...head.children].map(rect), cells: [...row.children].map(rect), readable: [...head.children].every(e => e.scrollWidth <= e.clientWidth && getComputedStyle(e).whiteSpace === 'nowrap'), cellsReadable:[...row.querySelectorAll('.cell')].every(e=>e.scrollHeight<=e.clientHeight&&getComputedStyle(e).whiteSpace==='nowrap'), headCount: list.parentNode.querySelectorAll('.' + prefix + '-head').length, scrollWidth: list.scrollWidth, clientWidth: list.clientWidth, scrollHeight: list.scrollHeight, clientHeight: list.clientHeight, scrollLeft: list.scrollLeft, scrollTop: list.scrollTop, overflow: document.documentElement.scrollWidth > innerWidth, pageOverflow: document.documentElement.scrollHeight > innerHeight };
        }, prefix);
        let actual = await inspect();
        assert.equal(actual.readable, true, mode + ' header labels fit');assert.equal(actual.cellsReadable,true,mode+' metadata stays within a single centered row');
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
            return { x: r.x, right: r.right, bottom: r.bottom, width:r.width, innerWidth:element.clientWidth, padding:parseFloat(getComputedStyle(element).paddingLeft), labels: [...element.querySelectorAll('button')].map(button => ({ width: button.clientWidth, fits: button.scrollWidth <= button.clientWidth, nowrap: getComputedStyle(button).whiteSpace === 'nowrap' })) };
          });
          assert.ok(menu.x >= 0 && menu.right <= width && menu.bottom <= 800, JSON.stringify({ theme, width, menu }));
          assert.equal(menu.width,180); assert.equal(menu.labels.length, 8); assert.ok(menu.labels.every(label => label.width === menu.innerWidth - 2 * menu.padding && label.fits && label.nowrap));
          await page.keyboard.press('Escape'); assert.equal(await page.locator('.explorer-menu').count(), 0);
        }
        await page.screenshot({ path: path.join(screenshots, mode + '-' + width + '-' + theme + '-start.png') });
        await page.locator('.' + prefix + '-list').evaluate(list => { list.scrollLeft = list.scrollWidth; list.scrollTop = list.scrollHeight; });
        actual = await inspect();
        assert.equal(actual.headCount, 1); assert.ok(actual.scrollTop > 0);
        assert.ok(Math.abs(actual.head.bottom + 2 - actual.list.y) < 1, 'fixed header stays above scroller with progress track');
        assert.ok(actual.columns.at(-1).right <= actual.list.right + 1 && actual.columns.at(-1).x >= actual.list.x, 'last column is reachable');
        for (let i = 0; i < actual.columns.length; i++) assert.ok(Math.abs(actual.columns[i].x - actual.cells[i].x) < 1, 'header follows horizontal scroll');
        if (actual.scrollWidth > actual.clientWidth) assert.ok(actual.scrollLeft > 0); else assert.equal(actual.scrollLeft,0);
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
