const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const vm=require('node:vm');const path=require('node:path');
const os=require('node:os');
const processesCss=fs.readFileSync(path.join(__dirname,'../media/device-processes/processes.css'),'utf8');
// 执行真实前端并记录DOM/消息，注入的FileReader与同步ACK仅控制外部事件；上传回归不改写生产函数。
function boot(options={}){const sent=[];const nodes={};const created=[];function el(tag){return {tagName:tag,children:[],style:{setProperty(){}},dataset:{},classList:{add(name){this._names=this._names||new Set();this._names.add(name)},remove(name){if(this._names)this._names.delete(name)},toggle(name,force){const next=force===undefined?!this.contains(name):force;if(next)this.add(name);else this.remove(name);return next},contains(name){return !!(this._names&&this._names.has(name))}},className:'',textContent:'',appendChild(x){this.children.push(x);return x},replaceChildren(...x){this.children=x},addEventListener(type,fn){this['on'+type]=fn},setAttribute(key,value){this[key]=value;},remove(){},querySelectorAll(selector){const found=[];const visit=node=>{for(const child of node.children||[]){if(child.className===selector.slice(1))found.push(child);visit(child);}};visit(this);return found},contains(node){return node===this||this.children.some(child=>child.contains(node))},querySelector(){return null},getBoundingClientRect(){return {width:0,height:0}},select(){},click(){this.onclick?.()}}}const doc={getElementById:id=>nodes[id]||(nodes[id]=el('div')),createElement:tag=>{const node=el(tag);created.push(node);return node;},body:el('body'),addEventListener(){}};nodes['device-explorer']=el('section');const ctx={document:doc,window:{send:m=>sent.push(m),addEventListener(type,fn){if(type==='message')this.message=fn}},navigator:{clipboard:{writeText:async v=>{ctx.copied=v}}},send:m=>{sent.push(m);options.onSend?.(m,ctx);},AbortController,Intl:options.Intl||Intl,FileReader:options.FileReader||UploadReader,innerWidth:1000,innerHeight:800,console,Math,Date,Set,Map,Promise,Uint8Array,ArrayBuffer,btoa:s=>Buffer.from(s,'binary').toString('base64'),setTimeout,clearTimeout};vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../media/device-processes/processes.js'),'utf8'),ctx);vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../media/device-explorer/main.js'),'utf8'),ctx);return {ctx,sent,created,api:ctx.window.__deviceExplorer,root:nodes['device-explorer']}}
// CSS回归直接读取独立Processes资源，验证窄面板左右padding和卡片间距不会只依赖浏览器矩阵。
test('Processes CSS keeps compact balanced list spacing',()=>{assert.match(processesCss,/\.process-list\{[^}]*padding:2px[^}]*scrollbar-gutter:stable\}/);assert.match(processesCss,/\.process-card\{[^}]*margin:0 0 10px;padding:5px/);});

test('Explorer sends ready and preserves expanded tree while safely rendering names',()=>{const b=boot();assert.equal(b.sent[0].type,'explorer');assert.equal(b.sent[0].action,'ready');b.api.receive({type:'explorerState',serial:'s',deviceName:'<Phone>',tab:'files'});b.api.receive({type:'explorerFiles',path:'/',entries:[{path:'/A',name:'A',kind:'directory'},{path:'/z<bad>',name:'<bad>',kind:'file'}]});b.api.state.expanded.add('/A');b.api.receive({type:'explorerFiles',path:'/A',entries:[{path:'/A/x',name:'x',kind:'file'}]});assert.equal(b.api.state.expanded.has('/A'),true);assert.equal(b.root.children[0].children[0].textContent.includes('<Phone>'),true);assert.equal(b.root.children[0].children.length,1)});
test('Explorer protocol exposes tab and process selection ordering',()=>{const b=boot();b.api.receive({type:'explorerState',serial:'s',tab:'processes'});b.api.receive({type:'explorerProcesses',processes:[{pid:2,name:'z'},{pid:1,name:'A'}]});assert.equal(b.api.state.processes[0].pid,2);assert.equal(b.root.children.length>0,true);b.api.state.processSelected=1;b.ctx.document.dispatchEvent?.({})});
// 通过真实文件行事件验证目录单击、空名称回退，以及独立拖放目标保留普通选择，避免无名项或悬停覆盖选择。
test('folder rows toggle on click and select as drag targets',()=>{
  const b=boot(); b.api.receive({type:'explorerState',serial:'s',tab:'files',active:true});
  b.api.receive({type:'explorerFiles',path:'/',entries:[{path:'/named-folder',name:'   ',kind:'directory'},{path:'/empty-name.txt',kind:'file'}]});
  let list=b.root.children[1].children[2], folder=list.children[1], file=list.children[2];
  assert.equal(folder.children[0].children[2].textContent,'named-folder');
  assert.equal(file.children[0].children[2].textContent,'empty-name.txt');
  folder.onclick({shiftKey:false,ctrlKey:false,metaKey:false});
  assert.equal(b.api.state.selected[0],'/named-folder'); assert.equal(b.api.state.expanded.has('/named-folder'),true);
  b.api.receive({type:'explorerFiles',path:'/named-folder',entries:[]});
  list=b.root.children[1].children[2]; folder=list.children[1];
  folder.onclick({shiftKey:false,ctrlKey:false,metaKey:false});
  assert.equal(b.api.state.expanded.has('/named-folder'),false);
  file.onclick({shiftKey:false,ctrlKey:false,metaKey:false});
  list=b.root.children[1].children[2]; folder=list.children[1]; file=list.children[2];
  assert.equal(folder.classList.contains('selected'),false);
  folder.ondragover({preventDefault(){}});
  assert.equal(Array.from(b.api.state.selected).join(','),'/empty-name.txt');
  assert.equal(folder.classList.contains('drop-target'),true);
  assert.equal(file.classList.contains('selected'),true);
  b.root.ondragleave({relatedTarget:null});
  assert.equal(folder.classList.contains('drop-target'),false);
});

// 读取当前CSS断言蓝色拖放和选择样式存在且声明未截断；结合真实DOM类切换回归验证视觉绑定。
test('file selection and drop target have blue visual feedback',()=>{
  const css=fs.readFileSync(path.join(__dirname,'../media/device-explorer/main.css'),'utf8');
  assert.ok(css.includes('.file-row.drop-target,.file-row.drop-target:hover{background:#075fa8;color:#fff;'));
  assert.ok(css.includes('.file-row.selected,.file-row.selected:hover{background:var(--vscode-list-activeSelectionBackground,#094771)'));
  assert.ok(css.includes('.file-list>.state.error{white-space:pre-wrap;overflow-wrap:anywhere;'));
  assert.equal(css.includes('line truncated'),false);
  assert.equal((css.match(/\{/g)||[]).length,(css.match(/\}/g)||[]).length);
});

// 执行真实行事件，单选、Ctrl多选和Shift连选不被拖放悬停覆盖，退出或视图切换清理拖放类。
test('upload drag targets preserve normal single and multiple selection',()=>{
  const b=boot(); b.api.receive({type:'explorerState',serial:'s',tab:'files',active:true});
  b.api.receive({type:'explorerFiles',path:'/',entries:['a','b','c'].map(name=>({path:'/'+name,name,kind:'file'}))});
  const rows=()=>b.root.children[1].children[2].children.slice(1);
  rows()[0].onclick({}); assert.equal(rows()[0]['aria-selected'],'true');
  rows()[1].onclick({ctrlKey:true}); assert.deepEqual(Array.from(b.api.state.selected),['/a','/b']);
  rows()[2].onclick({shiftKey:true}); assert.deepEqual(Array.from(b.api.state.selected),['/a','/b','/c']);
  b.root.ondragover({preventDefault(){},target:{closest:()=>rows()[1]}}); assert.equal(rows()[1].classList.contains('drop-target'),true);
  assert.deepEqual(Array.from(b.api.state.selected),['/a','/b','/c']);
  b.root.ondragleave({relatedTarget:rows()[1].children[0]});
  assert.equal(rows()[1].classList.contains('drop-target'),true);
  b.root.ondragleave({relatedTarget:b.ctx.document.createElement('div')});
  assert.equal(rows()[1].classList.contains('drop-target'),false);
  b.root.ondragover({preventDefault(){},target:{closest:()=>rows()[1]}});
  assert.equal(b.api.state.dragTarget,'/b');
  assert.equal(rows()[1].classList.contains('drop-target'),true);
  b.root.ondragover({preventDefault(){},target:{closest:()=>null}});
  assert.equal(b.api.state.dragTarget,null);
  assert.equal(rows()[1].classList.contains('drop-target'),false);
  rows()[1].ondragover({preventDefault(){}});
  b.root.ondragend(); assert.equal(rows()[1].classList.contains('drop-target'),false);
  rows()[0].ondragover({preventDefault(){}}); b.api.receive({type:'deviceViewMode',mode:'processes'});
  assert.equal(b.api.state.dragTarget,null);
});
// 真实drop与设备ACK错误必须显示具体写入/清理原因，错误不替代文件行，随后仍可正常选择。
test('failed drop keeps file rows selectable and shows all upload causes',async()=>{
  const b=boot({onSend:(m,ctx)=>{if(m.transferId)acknowledge(ctx,m,m.action==='uploadEnd'?'Permission denied: /dest':m.action==='uploadAbort'?'cleanup failed':undefined);}});
  b.api.receive({type:'explorerState',serial:'s',tab:'files',active:true});
  b.api.receive({type:'explorerFiles',path:'/',entries:[{path:'/dest',name:'dest',kind:'directory'}]});
  const folder=b.root.children[1].children[2].children[1]; folder.ondragover({preventDefault(){}});
  await b.root.ondrop(droppedEvent([],[uploadFile(0)],'/dest'));
  assert.equal(b.api.state.dragTarget,null); assert.ok(b.api.state.error.includes('Permission denied: /dest')); assert.match(b.api.state.error,/cleanup failed/);
  let list=b.root.children[1].children[2]; assert.equal(list.children[1].role,'alert'); assert.equal(list.children[2].dataset.path,'/dest');
  list.children[2].onclick({ctrlKey:true}); assert.deepEqual(Array.from(b.api.state.selected),['/dest']);
  b.api.receive({type:'explorerProgress',busy:false,error:'No space left on device',message:'Upload failed'});
  list=b.root.children[1].children[2]; assert.equal(list.children[1].textContent,'No space left on device');
  assert.equal(list.children[2].classList.contains('selected'),true);
});

// 文件输入事件既要展开嵌套本地错误，也要在下一次成功上传时移除旧错误，不影响文件行。
test('upload input displays nested causes and clears old failures on success',async()=>{
  const b=boot({onSend:(m,ctx)=>{if(m.transferId)acknowledge(ctx,m);}});
  b.api.receive({type:'explorerState',serial:'s',tab:'files',active:true});
  b.api.receive({type:'explorerFiles',path:'/',entries:[{path:'/a',name:'a',kind:'file'}]});
  const nested=new AggregateError([new AggregateError([new Error('file locked')],'reader failed')],'upload failed');
  let input=b.created.findLast(node=>node.type==='file');
  input.files=[{name:'bad',size:1,slice(){throw nested;}}]; await input.onchange();
  assert.equal(b.api.state.error,'upload failed: reader failed: file locked');
  assert.equal(b.root.children[1].children[2].children[1].role,'alert');
  input=b.created.findLast(node=>node.type==='file'); input.files=[uploadFile(0)]; await input.onchange();
  assert.equal(b.api.state.error,''); assert.equal(b.api.state.transfer,null);
  const list=b.root.children[1].children[2];assert.equal(list.children.some(node=>node.role==='alert'),false);
  assert.equal(list.children[1].dataset.path,'/a'); assert.equal(b.sent.filter(m=>m.action==='uploadEnd').length,1);
});

// 宿主设备/连接/状态改变必须清理拖放目标；从真实root事件进入，普通选择按宿主生命周期处理。
test('host context events clear hovered upload targets',()=>{
  for(const message of [{type:'devices',serial:'other'},{type:'explorerConnection',serial:'s',view:'files',connected:false},{type:'explorerState',serial:'s',tab:'files',active:false}]){
    const b=boot();b.api.receive({type:'explorerState',serial:'s',tab:'files',active:true});
    b.api.receive({type:'explorerFiles',path:'/',entries:[{path:'/a',name:'a',kind:'file'}]});
    const row=b.root.children[1].children[2].children[1];
    b.root.ondragover({preventDefault(){},target:{closest:()=>row}});
    assert.equal(b.api.state.dragTarget,'/a'); assert.equal(row.classList.contains('drop-target'),true);
    b.api.receive(message);assert.equal(b.api.state.dragTarget,null);assert.equal(row.classList.contains('drop-target'),false);
  }
});

// 标准FileReader测试替身保留异步load/error/abort行为，不替换生产分块逻辑。
class UploadReader {
  // 读取Blob测试对象并按浏览器语义触发完成/失败，取消后的空监听不会执行迟到回调。
  readAsArrayBuffer(blob) { blob.arrayBuffer().then(buffer=>{this.result=buffer;this.onload?.();},error=>{this.error=error;this.onerror?.();}); }
  // 记录实际取消路径，生产函数必须同步解除所有事件监听。
  abort() { this.onabort?.(); }
}
// 创建可控事件Promise，不依赖延时、轮询或固定微任务次数。
function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
// 制造真正按slice边界分块的文件，零字节无需读取。
function uploadFile(size=3,name='a.bin'){return {name,size,slice:(start,end)=>({arrayBuffer:async()=>new Uint8Array(end-start).buffer})};}
// 用当前命令的设备、动作与transferId回ACK，测试与真实宿主协议一致。
function acknowledge(ctx,message,error){ctx.window.__deviceExplorer.receive({type:'explorerUploadAck',serial:message.serial,action:message.action,transferId:message.transferId,...(error?{error}: {})});}

// 顶部模式消息渲染独立Processes/Files，无内部tabs，刷新位于Processes标题栏右侧。
test('separate surfaces render Processes and Explorer without internal tabs',()=>{
  const b=boot();b.api.receive({type:'explorerState',serial:'s',tab:'files',deviceName:'Phone'});
  b.api.receive({type:'deviceViewMode',mode:'processes'});assert.equal(b.root.children[0].children[0].textContent,'Processes - Phone');assert.equal(b.root.children[0].children[1].title,'Refresh');assert.equal(b.root.children[1].className,'processes-view');assert.equal(b.root.children.some(e=>e.className==='tabs'),false);
  b.api.receive({type:'explorerState',serial:'s',tab:'processes'});assert.equal(b.root.children[1].className,'processes-view');
  b.api.receive({type:'deviceViewMode',mode:'explorer'});assert.equal(b.root.children[0].children[0].textContent,'Device Explorer - Phone');assert.equal(b.root.children[1].className,'files-view');assert.equal(b.sent.some(m=>m.action==='tab'),false);
});

// 实际加载独立processes.js，排序、单选、操作路由和复制由该文件执行；刷新按钮属于共享标题栏。
test('independent process script owns sorting selection actions and keyboard copy',async()=>{
  const b=boot();b.api.receive({type:'explorerState',serial:'s',tab:'processes',capabilities:{debug:false}});
  b.api.receive({type:'explorerProcesses',processes:[{pid:10,name:'A'},{pid:2,name:'Z'}]});
  let surface=b.root.children[1],list=surface.children[1];assert.equal(list.className,'process-list');assert.equal(list.children[0].className,'process-card');assert.equal(list.children[0].children[0].children[0].textContent,'A');
  const sort=surface.children[0].children[1];sort.value='pid';sort.onchange();surface=b.root.children[1];list=surface.children[1];assert.equal(list.children[0].children[0].children[1].textContent,'PID 2');
  surface.children[0].children[2].onclick();surface=b.root.children[1];list=surface.children[1];assert.equal(list.children[0].children[0].children[1].textContent,'PID 10');
  surface.children[0].children[2].onclick();surface=b.root.children[1];list=surface.children[1];const query=surface.children[0].children[0];query.value='Z';query.oninput();assert.equal(list.children.length,1);list.children[0].onclick();assert.equal(b.api.state.processSelected,2);
  assert.equal(b.root.children[1].children[0].children[0].value,'Z');assert.equal(b.root.children[1].children[1].children[0]['aria-current'],'true');
  surface=b.root.children[1];surface.children[1].children[0].children[2].children[0].onclick({stopPropagation(){}});assert.equal(b.sent.at(-1).action,'kill');assert.equal(b.sent.at(-1).pid,2);
  assert.equal(b.ctx.window.DeviceProcessesView.handleKeyboard(b.api.state,{ctrlKey:true,key:'c'}),true);await Promise.resolve();assert.equal(b.ctx.copied,'Z:2');assert.equal(b.api.state.processes[0].pid,10);
});

// 一张卡片保留完整进程字段；刷新位于标题栏，卡片动作和字段不被改变。
test('process cards retain metadata missing values and empty states safely',()=>{
  const b=boot();b.api.receive({type:'deviceViewMode',mode:'processes'});assert.equal(b.root.children[1].children[1].children[0].textContent,'No device selected');
  b.api.receive({type:'explorerState',serial:'s',tab:'processes'});assert.equal(b.root.children[1].children[1].children[0].textContent,'No processes');
  const long='com.example.'+'long'.repeat(80)+'<img>';b.api.receive({type:'explorerProcesses',processes:[{pid:42,name:long,abi:'arm64-v8a',vm:'ART',userId:0,debugger:'waiting'}]});let card=b.root.children[1].children[1].children[0];assert.equal(card.className,'process-card');
  assert.equal(card.children[0].children[0].textContent,long);assert.equal(card.children[0].children[0].children.length,0);assert.equal(card.children[0].children[1].textContent,'PID 42');assert.deepEqual(Array.from(card.children[1].children,field=>field.children[0].textContent),['ABI','VM','User ID','Debugger']);assert.deepEqual(Array.from(card.children[1].children,field=>field.children[1].textContent),['arm64-v8a','ART','0','Waiting']);
  let prevented=false;card.onkeydown({key:'Enter',preventDefault(){prevented=true;}});assert.equal(prevented,true);assert.equal(b.api.state.processSelected,42);b.api.receive({type:'explorerProcesses',processes:[{pid:9,packageName:'fallback'}]});card=b.root.children[1].children[1].children[0];assert.equal(card.children[0].children[0].textContent,'fallback');assert.deepEqual(Array.from(card.children[1].children,field=>field.children[1].textContent),['-','-','-','Default']);b.api.receive({type:'explorerProcesses',processes:[],error:'Device disconnected'});assert.equal(b.root.children[1].children[1].children[0].textContent,'Device disconnected');
});

// 每卡片五个图标动作捕获该行PID，不依赖已选卡片；刷新位于标题栏。
test('each process card exposes five owned icon actions without prior selection',()=>{
  const b=boot();b.api.receive({type:'explorerState',serial:'s',tab:'processes',active:true,capabilities:{debug:true}});b.api.receive({type:'explorerProcesses',processes:[{pid:1,name:'A'},{pid:2,name:'B'}]});b.api.state.processSelected=1;
  const cards=b.root.children[1].children[1].children,commands=['kill','forceStop','debug','clearData','uninstall'],titles=['Kill','Force Stop','Attach Debugger','Clear Data','Uninstall'];assert.equal(b.root.children[0].children[1].title,'Refresh');
  for(const card of cards){assert.equal(card.role,'listitem');const controls=card.children[2].children;assert.equal(controls.length,5);for(let i=0;i<5;i++){const control=controls[i];assert.equal(control.title,titles[i]);assert.equal(control['aria-label'],titles[i]);assert.equal(control.children.length,1);assert.ok(control.children[0].className.startsWith('codicon codicon-'));assert.equal(control.disabled,false);let stopped=false;control.onclick({stopPropagation(){stopped=true;}});assert.equal(stopped,true);assert.equal(b.sent.at(-1).action,commands[i]);assert.equal(b.sent.at(-1).pid,card===cards[0]?1:2);}}
  assert.equal(b.api.state.processSelected,1);b.api.receive({type:'explorerState',serial:'s',tab:'processes',active:true,capabilities:{debug:false}});let controls=b.root.children[1].children[1].children[0].children[2].children;assert.deepEqual(Array.from(controls,e=>e.disabled),[false,false,true,false,false]);b.api.receive({type:'explorerState',serial:'s',tab:'processes',active:false});controls=b.root.children[1].children[1].children[0].children[2].children;assert.ok(controls.every(e=>e.disabled));
});

// 新建与上传共用目录解析；文件选中时在父目录创建，目录/目录链接保留自身，无选择使用根。
test('new item toolbar and context menu resolve the same directory as upload',()=>{
  for(const [selected,parent] of [['/dest/existing','/dest'],['/dest','/dest'],['/link','/link'],[undefined,'/']]){
    const b=boot();b.api.receive({type:'explorerState',serial:'s',tab:'files'});b.api.receive({type:'explorerFiles',path:'/',entries:[{path:'/dest',name:'dest',kind:'directory'},{path:'/link',name:'link',kind:'symlink',directoryLink:true}]});b.api.state.expanded.add('/dest');b.api.receive({type:'explorerFiles',path:'/dest',entries:[{path:'/dest/existing',name:'existing',kind:'file'}]});b.api.state.selected=selected?[selected]:[];
    b.root.children[1].children[0].children[0].onclick();assert.equal(b.sent.at(-1).action,'newDirectory');assert.equal(b.sent.at(-1).parent,parent);
    for(const name of ['New File','New Directory','Upload']){const row=b.root.children[1].children[2].children.find(node=>node.dataset.path===(selected||'/dest/existing'));row.oncontextmenu({preventDefault(){},clientX:10,clientY:10});if(!selected)b.api.state.selected=[];const menu=b.api.state.menu,control=menu.children.find(node=>node.textContent===name);assert.ok(control);control.onclick();assert.equal(b.sent.at(-1).action,name==='New File'?'newFile':name==='New Directory'?'newDirectory':'upload');assert.equal(b.sent.at(-1)[name==='Upload'?'target':'parent'],parent);}
  }
});

// 默认排序按packageName而非显示进程名；缺少包名时回退到name，排序菜单仍可切换其他字段。
test('processes default to package name ordering',()=>{
  const b=boot();b.api.receive({type:'explorerState',serial:'s',tab:'processes'});b.api.receive({type:'explorerProcesses',processes:[{pid:1,name:'Alpha',packageName:'z.pkg'},{pid:2,name:'Zulu',packageName:'a.pkg'},{pid:3,name:'No package'}]});
  let surface=b.root.children[1];assert.equal(surface.children[0].children[1].value,'packageName');let list=surface.children[1];assert.equal(list.children[0].children[0].children[0].textContent,'Zulu');assert.equal(list.children[1].children[0].children[0].textContent,'Alpha');assert.equal(list.children[2].children[0].children[0].textContent,'No package');
  b.api.receive({type:'explorerProcesses',processes:[{pid:'error',name:'Error PID',packageName:'same.pkg'},{pid:10,name:'Valid PID',packageName:'same.pkg'}]});surface=b.root.children[1];const sort=surface.children[0].children[1];sort.value='pid';sort.onchange();let rows=b.root.children[1].children[1].children;assert.equal(rows[0].children[0].children[0].textContent,'Valid PID');assert.equal(rows[1].children[0].children[0].textContent,'Error PID');
  b.api.receive({type:'explorerProcesses',processes:[{pid:1,name:'Valid ABI',abi:'arm64'},{pid:2,name:'Error ABI',abi:'error'}]});surface=b.root.children[1];surface.children[0].children[1].value='abi';surface.children[0].children[1].onchange();rows=b.root.children[1].children[1].children;assert.equal(rows[0].children[0].children[0].textContent,'Valid ABI');assert.equal(rows[1].children[0].children[0].textContent,'Error ABI');
  assert.deepEqual(Array.from(surface.children[0].children[1].children,e=>e.textContent),['Package Name','Process Name','PID','ABI','VM','User ID','Debugger']);
});

// Files表头和行必须由同一个列表持有，空态也保留表头；npm test 无设备执行实际渲染。
test('file table owns header and rows in one scroll container including empty state',()=>{
  const b=boot();b.api.receive({type:'explorerState',serial:'s',tab:'files'});
  let list=b.root.children[1].children[2];assert.equal(list.className,'file-list');
  assert.equal(list.children[0].className,'file-head');assert.equal(list.children[1].textContent,'Empty directory');
  b.api.receive({type:'explorerFiles',path:'/',entries:[{path:'/a',name:'a',kind:'file'}]});
  list=b.root.children[1].children[2];assert.equal(list.children[0].className,'file-head');assert.equal(list.children[1].className,'file-row');
  assert.equal(list.children.filter(e=>e.className==='file-head').length,1);
});

// 等待每个文件的最终设备提交ACK，多分块及零字节文件也不可提前开启下一项。
test('upload waits for every ACK and final commit before the next file',async()=>{
  const ends=[deferred(),deferred()];let count=0;
  const b=boot({onSend:(m,ctx)=>{if(!m.transferId)return;if(m.action==='uploadEnd')ends[count++].resolve(m);else acknowledge(ctx,m);}});
  b.api.receive({type:'explorerState',serial:'s',tab:'files'});
  let finished=false;const task=b.api.uploadFiles([uploadFile(256*1024+3),uploadFile(0,'empty')],'/');task.then(()=>{finished=true;});
  const first=await ends[0].promise;
  assert.equal(finished,false);assert.equal(b.sent.filter(m=>m.action==='uploadBegin').length,1);
  const chunks=b.sent.filter(m=>m.action==='uploadChunk');assert.deepEqual(chunks.map(m=>Buffer.from(m.data,'base64').length),[256*1024,3]);
  acknowledge(b.ctx,first);const last=await ends[1].promise;
  assert.equal(finished,false);assert.equal(b.sent.filter(m=>m.action==='uploadBegin').length,2);
  assert.equal(b.sent.filter(m=>m.action==='uploadChunk').length,2);acknowledge(b.ctx,last);await task;
  assert.equal(finished,true);assert.equal(b.api.state.transfer,null);assert.ok(b.sent.filter(m=>m.transferId).every(m=>m.serial==='s'));
});
// 最后设备push失败必须拒绝整批、确认清理且不启动下一文件；本地读取失败走同一清理路径。
test('upload final commit and local read errors abort without false success',async()=>{
  const b=boot({onSend:(m,ctx)=>{if(m.transferId)acknowledge(ctx,m,m.action==='uploadEnd'?'disk full':undefined);}});
  b.api.receive({type:'explorerState',serial:'s',tab:'files'});
  await assert.rejects(b.api.uploadFiles([uploadFile(),uploadFile(0,'next')],'/'),/disk full/);
  assert.equal(b.sent.filter(m=>m.action==='uploadBegin').length,1);assert.equal(b.sent.filter(m=>m.action==='uploadAbort').length,1);assert.equal(b.api.state.transfer,null);
  const c=boot({onSend:(m,ctx)=>{if(m.transferId)acknowledge(ctx,m);}});c.api.receive({type:'explorerState',serial:'s',tab:'files'});
  const bad={name:'bad',size:1,slice:()=>({arrayBuffer:async()=>{throw new Error('cannot read');}})};
  await assert.rejects(c.api.uploadFiles([bad],'/'),/cannot read/);assert.equal(c.sent.some(m=>m.action==='uploadChunk'||m.action==='uploadEnd'),false);
  assert.equal(c.sent.filter(m=>m.action==='uploadAbort').length,1);assert.equal(c.api.state.transfer,null);
  await c.api.uploadFiles([uploadFile(0)],'/');assert.equal(c.sent.filter(m=>m.action==='uploadEnd').length,1);
});
// ACK等待中关闭视图立即拒绝，第二批不可覆盖现有所有者；同设备状态快照不能误取消。
test('upload owns one batch and cancels pending ACK on view or device change',async()=>{
  for(const message of [{type:'deviceViewMode',mode:'processes'},{type:'devices',serial:'other'},{type:'explorerState',serial:undefined,tab:'files'}]){
    const b=boot();b.api.receive({type:'explorerState',serial:'s',tab:'files'});
    const task=b.api.uploadFiles([uploadFile()],'/');const rejection=assert.rejects(task,e=>e.name==='AbortError');
    await assert.rejects(b.api.uploadFiles([uploadFile()],'/'),/already running/);
    b.api.receive({type:'explorerState',serial:'s',tab:'files'});assert.ok(b.api.state.transfer);
    b.api.receive(message);await rejection;assert.equal(b.api.state.transfer,null);assert.equal(b.sent.filter(m=>m.transferId).length,1);
  }
});
// FileReader实际收到abort，监听立即解除，迟到读完不得产生旧设备分块。
test('upload aborts owned FileReader before any stale chunk can be sent',async()=>{
  const reading=deferred(),late=deferred();let reader,aborts=0;
  class ControlledReader extends UploadReader {
    // 保持读取直到测试释放，以事件而非轮询控制取消时序。
    readAsArrayBuffer(){reader=this;reading.resolve();late.promise.then(()=>{this.result=new ArrayBuffer(3);this.onload?.();});}
    // 模拟原生abort并记录资源中止证据。
    abort(){aborts++;super.abort();}
  }
  const b=boot({FileReader:ControlledReader,onSend:(m,ctx)=>{if(m.transferId)acknowledge(ctx,m);}});b.api.receive({type:'explorerState',serial:'s',tab:'files'});
  const task=b.api.uploadFiles([uploadFile()],'/'),rejection=assert.rejects(task,e=>e.name==='AbortError');await reading.promise;
  b.api.receive({type:'devices',serial:'next'});await rejection;
  assert.equal(aborts,1);assert.equal(reader.onload,null);assert.equal(reader.onerror,null);assert.equal(reader.onabort,null);
  late.resolve();await late.promise;assert.equal(b.sent.some(m=>m.action==='uploadChunk'||m.action==='uploadEnd'||m.action==='uploadAbort'),false);
});
// 无设备/隐藏视图不得启动上传；同transferId错误动作ACK不能让文件进入读取或提交阶段。
test('upload validates active view and command correlation',async()=>{
  const b=boot();await assert.rejects(b.api.uploadFiles([uploadFile()],'/'),/active device/);
  b.api.receive({type:'explorerState',serial:'s',tab:'files'});b.root.hidden=true;await assert.rejects(b.api.uploadFiles([uploadFile()],'/'),/active device/);b.root.hidden=false;
  const c=boot({onSend:(m,ctx)=>{if(!m.transferId)return;if(m.action==='uploadBegin')acknowledge(ctx,{...m,action:'uploadChunk'});else acknowledge(ctx,m);}});c.api.receive({type:'explorerState',serial:'s',tab:'files'});
  await assert.rejects(c.api.uploadFiles([uploadFile()],'/'),/does not match/);assert.equal(c.sent.some(m=>m.action==='uploadChunk'||m.action==='uploadEnd'),false);assert.equal(c.api.state.transfer,null);
});
// 实际文件输入事件消费失败并呈现错误，不能留下未处理Promise或把错误当作成功。
test('upload input event displays local read failures',async()=>{
  const b=boot({onSend:(m,ctx)=>{if(m.transferId)acknowledge(ctx,m);}});b.api.receive({type:'explorerState',serial:'s',tab:'files'});
  const input=b.created.findLast(node=>node.type==='file');input.files=[{name:'bad',size:1,slice(){throw new Error('file disappeared');}}];
  await input.onchange();assert.equal(b.api.state.error,'file disappeared');assert.equal(b.api.state.transfer,null);
});

// 真实浏览器文件输入使用原生FileReader，消息端仅模拟设备ACK；事件Promise/MutationObserver验证背压和最终失败，不暴露测试API。
test('upload browser input uses real FileReader and waits for final device ACK', {skip:!process.env.EXPLORER_PLAYWRIGHT,timeout:60000},async()=>{
  const {chromium}=require(process.env.EXPLORER_PLAYWRIGHT);
  const browser=await chromium.launch({executablePath:process.env.EXPLORER_BROWSER,headless:true});
  try{
    const page=await browser.newPage();const errors=[];page.on('pageerror',error=>errors.push(String(error)));
    await page.setContent('<body data-device-view-mode="explorer"><section id="device-explorer"></section></body>');
    await page.evaluate(()=>{
      const deliver=data=>window.dispatchEvent(new MessageEvent('message',{data}));
      window.messages=[];window.ends=[];window.deliver=deliver;
      let first,second;window.firstEnd=new Promise(resolve=>{first=resolve;});window.secondEnd=new Promise(resolve=>{second=resolve;});
      window.ack=message=>deliver({type:'explorerUploadAck',serial:message.serial,transferId:message.transferId,action:message.action});
      window.send=message=>{
        window.messages.push(message);if(!message.transferId)return;
        if(message.action==='uploadEnd'){
          if(window.failCommit){deliver({type:'explorerUploadAck',serial:message.serial,transferId:message.transferId,action:message.action,error:'device write failed'});return;}
          window.ends.push(message);(window.ends.length===1?first:second)();
        }else window.ack(message);
      };
    });
    for(const file of ['processes.js','main.js'])await page.addScriptTag({content:fs.readFileSync(path.join(__dirname,'../media/device-explorer',file),'utf8')});
    await page.evaluate(()=>window.deliver({type:'explorerState',serial:'s',tab:'files'}));
    await page.setInputFiles('input[type=file]',[{name:'large.bin',mimeType:'application/octet-stream',buffer:Buffer.alloc(256*1024+7,42)},{name:'empty.bin',mimeType:'application/octet-stream',buffer:Buffer.alloc(0)}]);
    await page.evaluate(()=>window.firstEnd);
    const pending=await page.evaluate(()=>({begins:window.messages.filter(m=>m.action==='uploadBegin').length,chunks:window.messages.filter(m=>m.action==='uploadChunk').map(m=>atob(m.data).length),disabled:document.querySelector('[title="Upload"]').disabled}));
    assert.equal(pending.begins,1);assert.deepEqual(pending.chunks,[256*1024,7]);assert.equal(pending.disabled,true);
    await page.evaluate(()=>window.ack(window.ends[0]));await page.evaluate(()=>window.secondEnd);
    assert.equal(await page.evaluate(()=>window.messages.filter(m=>m.action==='uploadBegin').length),2);
    await page.evaluate(()=>{
      window.idle=new Promise(resolve=>{
        const observer=new MutationObserver(()=>{if(!document.querySelector('[title="Upload"]').disabled){observer.disconnect();resolve();}});
        observer.observe(document.getElementById('device-explorer'),{childList:true,subtree:true});
      });window.ack(window.ends[1]);
    });await page.evaluate(()=>window.idle);
    assert.equal(await page.evaluate(()=>window.messages.filter(m=>m.action==='uploadEnd').length),2);
    await page.evaluate(()=>{
      window.failCommit=true;window.failed=new Promise(resolve=>{
        const observer=new MutationObserver(()=>{if(document.querySelector('.state.error')?.textContent==='device write failed'){observer.disconnect();resolve();}});
        observer.observe(document.getElementById('device-explorer'),{childList:true,subtree:true});
      });
    });
    await page.setInputFiles('input[type=file]',[{name:'failure.bin',mimeType:'application/octet-stream',buffer:Buffer.from([1])},{name:'must-not-start.bin',mimeType:'application/octet-stream',buffer:Buffer.from([2])}]);
    await page.evaluate(()=>window.failed);
    assert.equal(await page.evaluate(()=>window.messages.filter(m=>m.action==='uploadBegin').length),3);
    assert.equal(await page.evaluate(()=>window.messages.filter(m=>m.action==='uploadAbort').length),1);
    assert.equal(await page.locator('[title="Upload"]').isDisabled(),false);assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});

// 最终ACK仍未到达时隐藏也要拒绝，不向新上下文发送Abort；清理失败须保留原始和清理两个原因。
test('upload cancellation during commit and cleanup failure stay explicit',async()=>{
  const end=deferred();const b=boot({onSend:(m,ctx)=>{if(!m.transferId)return;if(m.action==='uploadEnd')end.resolve();else acknowledge(ctx,m);}});b.api.receive({type:'explorerState',serial:'s',tab:'files'});
  const task=b.api.uploadFiles([uploadFile(0)],'/'),cancelled=assert.rejects(task,error=>error.name==='AbortError');await end.promise;b.api.receive({type:'deviceViewMode',mode:'hidden'});await cancelled;
  assert.equal(b.sent.some(m=>m.action==='uploadAbort'),false);assert.equal(b.api.state.transfer,null);
  const c=boot({onSend:(m,ctx)=>{if(m.transferId)acknowledge(ctx,m,m.action==='uploadEnd'?'write failed':m.action==='uploadAbort'?'cleanup failed':undefined);}});c.api.receive({type:'explorerState',serial:'s',tab:'files'});
  await assert.rejects(c.api.uploadFiles([uploadFile(0)],'/'),error=>error.name==='AggregateError'&&error.errors.length===2&&/write failed/.test(String(error.errors[0]))&&/cleanup failed/.test(String(error.errors[1])));
  assert.equal(c.api.state.transfer,null);
});
// drop事件边界必须把本地读取错误显示出来，防止未处理拒绝。
test('upload drop event displays local read failure',async()=>{
  const b=boot({onSend:(m,ctx)=>{if(m.transferId)acknowledge(ctx,m);}});b.api.receive({type:'explorerState',serial:'s',tab:'files'});
  let prevented=false;await b.root.ondrop({preventDefault(){prevented=true;},dataTransfer:{types:[],items:[],files:[{name:'bad',size:1,slice(){throw new Error('dropped file vanished');}}]}});
  assert.equal(prevented,true);assert.equal(b.api.state.error,'dropped file vanished');assert.equal(b.api.state.transfer,null);
});

// 文件系统entry替身按浏览器readEntries多批结束协议返回，不替代实际drop/上传调用链。
function droppedDirectory(name,batches){return {isDirectory:true,name,createReader(){let index=0;return {readEntries(resolve,reject){const batch=batches[index++]||[];batch instanceof Error?reject(batch):resolve(batch);}};}};}
// 通过真实root drop监听发起操作，可选择目录行；DataTransfer数据在事件当轮同步取出。
function droppedEvent(entries=[],files=[],remote){return {preventDefault(){},target:remote?{closest:()=>({dataset:{path:remote}})}:undefined,dataTransfer:{types:[],items:entries.map(entry=>({webkitGetAsEntry:()=>entry})),files}};}
// 拖入目录保留空目录及超过100项的后续批，父目录ACK后才创建子项；所有项写入选中目录而非根。
test('directory drops preserve empty folders and all browser entry batches at the chosen target',async()=>{
  const b=boot({onSend:(m,ctx)=>{if(m.transferId)acknowledge(ctx,m);}});b.api.receive({type:'explorerState',serial:'s',tab:'files'});b.api.receive({type:'explorerFiles',path:'/',entries:[{path:'/dest',kind:'directory'}]});
  const fileEntry=i=>({isFile:true,name:'f'+i,file:resolve=>resolve(uploadFile(0,'f'+i))});
  const directory=droppedDirectory('tree',[[droppedDirectory('empty',[])],Array.from({length:100},(_,i)=>fileEntry(i)),[fileEntry(100)],[]]);
  await b.root.ondrop(droppedEvent([directory],[],'/dest'));
  const begin=b.sent.filter(m=>m.action==='uploadBegin');assert.equal(begin.length,103);assert.equal(begin[0].directory,true);assert.equal(begin[0].relativePath,'tree');assert.equal(begin[1].relativePath,'tree/empty');assert.equal(begin[1].directory,true);assert.equal(begin.at(-1).relativePath,'tree/f100');assert.ok(begin.every(m=>m.target==='/dest'&&m.serial==='s'));assert.equal(b.sent.filter(m=>m.action==='uploadEnd').length,101);assert.equal(b.sent.some(m=>m.action==='uploadAbort'),false);assert.equal(b.api.state.transfer,null);
});
// 目录读取失败是整批错误，扫描完整之前不创建远端目录；空目录不能以dt.files为空而被忽略。
test('directory drop read errors never become partial successful uploads',async()=>{
  const b=boot({onSend:(m,ctx)=>{if(m.transferId)acknowledge(ctx,m);}});b.api.receive({type:'explorerState',serial:'s',tab:'files'});
  await b.root.ondrop(droppedEvent([droppedDirectory('bad',[[droppedDirectory('empty',[])],new Error('cannot read directory')])]));assert.equal(b.api.state.error,'cannot read directory');assert.equal(b.sent.some(m=>m.transferId),false);assert.equal(b.api.state.transfer,null);
  await b.root.ondrop(droppedEvent([droppedDirectory('empty',[])]));const begin=b.sent.find(m=>m.action==='uploadBegin');assert.equal(begin.directory,true);assert.equal(begin.relativePath,'empty');assert.equal(b.sent.some(m=>m.action==='uploadEnd'),false);
});
// 扫描属于一个上传所有者；切走立即结束等待且迟到回调不能向新设备发命令或清掉其新批次。
test('switching device during dropped directory enumeration cancels the owned batch',async()=>{
  for(const message of [{type:'devices',serial:'next'},{type:'deviceViewMode',mode:'processes'},{type:'explorerState',serial:'s',tab:'files',active:false}]){
    const entered=deferred();let late;const b=boot();b.api.receive({type:'explorerState',serial:'s',tab:'files'});
    const entry={isDirectory:true,name:'held',createReader:()=>({readEntries(resolve){late=resolve;entered.resolve();}})};
    const task=b.root.ondrop(droppedEvent([entry]));await entered.promise;assert.ok(b.api.state.transfer);await assert.rejects(b.api.uploadFiles([uploadFile(0)],'/'),/already running/);b.api.receive(message);await task;assert.equal(b.api.state.transfer,null);assert.equal(b.sent.some(m=>m.transferId),false);late([]);await Promise.resolve();assert.equal(b.sent.some(m=>m.transferId),false);
  }
});
// 目录行/文件父目录/工具栏/URI列表共享目标解析，且开始时固定目标不受后来选择影响。
test('file drops toolbar uploads and URI lists honor directory selection',async()=>{
  const b=boot({onSend:(m,ctx)=>{if(m.transferId)acknowledge(ctx,m);}});b.api.receive({type:'explorerState',serial:'s',tab:'files'});b.api.receive({type:'explorerFiles',path:'/',entries:[{path:'/dest',kind:'directory'},{path:'/link',kind:'symlink',directoryLink:true}]});b.api.receive({type:'explorerFiles',path:'/dest',entries:[{path:'/dest/existing',kind:'file'}]});b.api.state.selected=['/dest/existing'];
  await b.root.ondrop(droppedEvent([],[uploadFile(0)],'/dest/existing'));assert.equal(b.sent.findLast(m=>m.action==='uploadBegin').target,'/dest');
  const bar=b.root.children[1].children[0],input=bar.children[2];bar.children[3].onclick();assert.equal(input.dataset.target,'/dest');input.files=[uploadFile(0)];b.api.state.selected=[];await input.onchange();assert.equal(b.sent.findLast(m=>m.action==='uploadBegin').target,'/dest');
  const event=droppedEvent([],[],'/link');event.dataTransfer.types=['text/uri-list'];event.dataTransfer.getData=()=> '# source\r\nfile:///C:/one\r\nfile:///C:/two\r\n';await b.root.ondrop(event);assert.equal(b.sent.at(-1).action,'uploadUris');assert.equal(b.sent.at(-1).target,'/link');assert.deepEqual(Array.from(b.sent.at(-1).uris),['file:///C:/one','file:///C:/two']);
});

// CDP原生文件拖放传递真实本地目录，浏览器生成FileSystemEntry；不替换readEntries或FileReader，只模拟设备ACK。
test('native browser directory drop preserves empty folders and actual bytes at the hovered destination',{skip:!process.env.EXPLORER_PLAYWRIGHT,timeout:60000},async t=>{
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'explorer-native-drop-')),folder=path.join(temp,'bundle'),bytes=Buffer.from([0,255,13,10,42]);fs.mkdirSync(path.join(folder,'empty'),{recursive:true});fs.writeFileSync(path.join(folder,'bytes.bin'),bytes);
  const {chromium}=require(process.env.EXPLORER_PLAYWRIGHT);let browser;
  try{
    browser=await chromium.launch({executablePath:process.env.EXPLORER_BROWSER,headless:true});t.after(async()=>{await browser.close();fs.rmSync(temp,{recursive:true,force:true});});const page=await browser.newPage();const errors=[];page.on('pageerror',error=>errors.push(String(error)));
    // FileSystemEntry需要非opaque origin；route只供应测试页面，保留原生目录API及本地文件读取权限检查。
    await page.route('http://explorer.test/',route=>route.fulfill({contentType:'text/html',body:'<body data-device-view-mode="explorer"><section id="device-explorer"></section></body>'}));await page.goto('http://explorer.test/');
    await page.evaluate(()=>{const deliver=data=>window.dispatchEvent(new MessageEvent('message',{data}));window.messages=[];let completed;window.completed=new Promise(resolve=>{completed=resolve;});window.deliver=deliver;window.send=message=>{window.messages.push(message);if(message.transferId){deliver({type:'explorerUploadAck',serial:message.serial,action:message.action,transferId:message.transferId});if(message.action==='uploadEnd')completed();}};document.addEventListener('drop',event=>{window.dropped={types:[...event.dataTransfer.types],files:[...event.dataTransfer.files].map(file=>file.name),entries:[...event.dataTransfer.items].map(item=>{const e=item.webkitGetAsEntry();return e?{name:e.name,directory:e.isDirectory}:null;})};},true);const observer=new MutationObserver(()=>{if(document.querySelector('.state.error')){observer.disconnect();completed();}});observer.observe(document.getElementById('device-explorer'),{subtree:true,childList:true});});
    for(const file of ['processes.js','main.js'])await page.addScriptTag({content:fs.readFileSync(path.join(__dirname,'../media/device-explorer',file),'utf8')});
    await page.evaluate(()=>{window.deliver({type:'explorerState',serial:'s',tab:'files',active:true});window.deliver({type:'explorerFiles',path:'/',entries:[{path:'/destination',name:'destination',kind:'directory'}]});});
    const box=await page.locator('.file-row').boundingBox();assert.ok(box);const cdp=await page.context().newCDPSession(page),data={items:[],files:[folder],dragOperationsMask:1},position={x:box.x+box.width/2,y:box.y+box.height/2};
    for(const type of ['dragEnter','dragOver','drop'])await cdp.send('Input.dispatchDragEvent',{type,...position,data});const native=await page.evaluate(()=>window.dropped);assert.deepEqual(native.types,['Files']);assert.deepEqual(native.entries,[{name:'bundle',directory:true}]);await page.evaluate(()=>window.completed);assert.equal(await page.locator('.state.error').count(),0);
    const messages=await page.evaluate(()=>window.messages),begin=messages.filter(m=>m.action==='uploadBegin');assert.deepEqual(begin.map(m=>m.relativePath).sort(),['bundle','bundle/bytes.bin','bundle/empty']);assert.equal(begin.filter(m=>m.directory===true).length,2);assert.ok(begin.every(m=>m.target==='/destination'&&m.serial==='s'));assert.deepEqual(Buffer.concat(messages.filter(m=>m.action==='uploadChunk').map(m=>Buffer.from(m.data,'base64'))),bytes);assert.equal(messages.filter(m=>m.action==='uploadEnd').length,1);assert.equal(messages.some(m=>m.action==='uploadAbort'),false);assert.deepEqual(errors,[]);await cdp.detach();
  }finally{if(browser)await browser.close();fs.rmSync(temp,{recursive:true,force:true});}
});

// 已读目录重新展开不访问设备、不重复排序/格式器构造；刷新快照删除项和空目录也必须正确。
test('directory snapshots reopen without requests or repeated sorting and refresh authoritatively',()=>{
  let comparisons=0,dateFormats=0;
  class Collator extends Intl.Collator { constructor(...args){super(...args);const original=this.compare;Object.defineProperty(this,'compare',{value:(a,b)=>{comparisons++;return original(a,b);}});} }
  class DateFormat extends Intl.DateTimeFormat { constructor(...args){super(...args);dateFormats++;} }
  const b=boot({Intl:{Collator,DateTimeFormat:DateFormat}});b.api.receive({type:'explorerState',serial:'s',tab:'files'});
  b.api.receive({type:'explorerFiles',path:'/',entries:[{path:'/A',name:'A',kind:'directory'}]});
  let list=b.root.children[1].children[2];list.children[1].children[0].children[0].onclick({stopPropagation(){}});
  assert.equal(b.sent.filter(m=>m.action==='list').length,1);
  b.api.receive({type:'explorerFiles',path:'/A',entries:[{path:'/A/z',name:'z',kind:'file',modified:1700000000000},{path:'/A/a',name:'a',kind:'file'}]});const sorted=comparisons;
  list=b.root.children[1].children[2];assert.deepEqual(Array.from(list.children.slice(1),row=>row.dataset.path),['/A','/A/a','/A/z']);
  for(let i=0;i<4;i++){list=b.root.children[1].children[2];list.children[1].children[0].children[0].onclick({stopPropagation(){}});}
  assert.equal(b.sent.filter(m=>m.action==='list').length,1);assert.equal(comparisons,sorted);assert.equal(dateFormats,1);
  b.api.receive({type:'explorerFiles',path:'/A',entries:[]});assert.equal(b.root.children[1].children[2].children.length,2);
  b.api.receive({type:'explorerFiles',path:'/',entries:[]});assert.equal(b.api.state.directories.has('/A'),false);assert.equal(b.root.children[1].children[2].children[1].textContent,'Empty directory');
});
// 收起状态保留且错误不变成空快照；普通切换保留缓存，真正断开或设备变化才失效，其他设备断开不能污染当前数据。
test('directory replies preserve collapse and cache ownership across errors and view changes',()=>{
  const b=boot();b.api.receive({type:'explorerState',serial:'s',tab:'files'});b.api.receive({type:'explorerFiles',path:'/',entries:[{path:'/A',kind:'directory'}]});
  for(let i=0;i<2;i++)b.root.children[1].children[2].children[1].children[0].children[0].onclick({stopPropagation(){}});
  b.api.receive({type:'explorerFiles',path:'/A',entries:[]});assert.equal(b.api.state.expanded.has('/A'),false);
  b.api.receive({type:'explorerFiles',path:'/broken',error:'Permission denied'});assert.equal(b.api.state.directories.has('/broken'),false);assert.equal(b.api.state.error,'Permission denied');
  b.api.receive({type:'deviceViewMode',mode:'processes'});assert.equal(b.api.state.directories.size,2);
  b.api.receive({type:'explorerConnection',serial:'other',view:'files',connected:false});assert.equal(b.api.state.directories.size,2);
  b.api.receive({type:'explorerConnection',serial:'s',view:'files',connected:false});assert.equal(b.api.state.directories.size,0);
  b.api.receive({type:'deviceViewMode',mode:'explorer'});b.api.receive({type:'explorerFiles',path:'/',entries:[]});
  b.api.receive({type:'explorerState',serial:'next',tab:'files'});assert.equal(b.api.state.directories.size,0);assert.deepEqual(Array.from(b.api.state.expanded),['/']);
});
