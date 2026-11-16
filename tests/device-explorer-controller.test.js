const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { transformSync } = require('esbuild');

const source = fs.readFileSync(path.join(__dirname, '../src/deviceExplorer.ts'), 'utf8');

// 创建真实临时目录与可记录后端，push/onPost可模拟提交失败/同步下一命令；上传回归断言ACK释放锁及异常清理。
async function fixture(options = {}) {
  const temp = await fsp.mkdtemp(path.join(os.tmpdir(), 'device-explorer-controller-test-'));
  const posts = [], calls = [], updates = [];
  let stopCount = 0;
  const config = { filter: false, downloadLocation: temp, launch: [], debuggerExtensions: [] };
  const files = {
    serial: 'phone',
    async stat(remote) { calls.push(['stat', remote]); if (options.permission?.includes(remote)) throw new Error('Permission denied'); if (options.statError?.includes(remote)) throw new Error('adb unavailable'); return { path: remote, name: path.posix.basename(remote) || '/', kind: remote.endsWith('/') ? 'directory' : 'file', permissions: '644', size: 0, modified: 0 }; },
    async list(remote) { calls.push(['list', remote, this.runAs]); if (options.listUnavailable?.includes(remote)) throw new Error('adb unavailable'); if (options.listPermission?.includes(remote) && !this.runAs) throw new Error('Permission denied'); if (options.listError?.includes(remote)) throw new Error('Permission denied'); if(options.directoryEntries)return options.directoryEntries(remote); return [{ path: remote + (remote === '/' ? '' : '/') + 'child.txt', name: 'child.txt', kind: 'file', permissions: '644', size: 3, modified: 0 }]; },
    async listPackages() { calls.push(['packages']); return ['com.example.app', 'com.example.other']; },
    async create(remote, directory, signal) { calls.push(['create', remote, directory]); await options.create?.(remote, directory, signal); },
    async remove(remote) { calls.push(['remove', remote]); },
    async push(local, remote, transfer) { calls.push(['push', local, remote]); await options.push?.(local, remote, transfer); await fsp.copyFile(local, path.join(temp, path.posix.basename(remote))); },
    async pull(remote, local) { calls.push(['pull', remote, local]); await fsp.writeFile(local, 'downloaded'); },
  };
  const processState = { rows: [], async watch(onUpdate, onError) { calls.push(['watch']); processState.onUpdate = onUpdate; processState.onError = onError; return async () => { stopCount++; calls.push(['stopWatch']); }; }, async kill(pid) { calls.push(['kill', pid]); }, async forceStop(pkg, uid) { calls.push(['forceStop', pkg, uid]); }, async clearData(pkg, uid) { calls.push(['clearData', pkg, uid]); }, async uninstall(pkg) { calls.push(['uninstall', pkg]); } };
  const vscode = {
    extensions: { all: config.debuggerExtensions },
    workspace: { isTrusted: true, workspaceFolders: [{}], fs: { readFile: async uri => fsp.readFile(uri.fsPath) }, findFiles: async () => [], getConfiguration: section => ({ get: (key, fallback) => section === 'launch' ? config.launch : key === 'explorer.downloadLocation' ? config.downloadLocation : config.filter, update: async (key, value) => { if (key === 'explorer.packageFilter') config.filter = value; } }) },
    ConfigurationTarget: { Global: 1 },
    Uri: { file: p => ({ scheme: 'file', fsPath: p, path: p }), parse: value => ({ scheme: value.split(':')[0], fsPath: (value.split('://')[1] || value), path: (value.split('://')[1] || value) }) },
    commands: { executeCommand: async (...args) => calls.push(['command', ...args]) },
    env: { clipboard: { writeText: async value => calls.push(['clipboard', value]) } },
    window: { showInputBox: async () => options.input, showWarningMessage: async (message, opts, ...items) => options.confirm === undefined ? items.at(-1) : options.confirm, showOpenDialog: async opts => options.openDialog === undefined ? [vscode.Uri.file(temp)] : options.openDialog, showQuickPick: async list => list[0] },
    debug: { startDebugging: async (...args) => { calls.push(['debug', ...args]); return options.debugResult ?? true; } },
  };
  const deps = { vscode, './deviceExplorerFiles': { DeviceExplorerFiles: class { constructor(serial,access) { Object.assign(this, files); this.runAs=access?.runAs; } } }, './deviceExplorerProcesses': { DeviceExplorerProcesses: class { constructor() { Object.assign(this, processState); } } } };
  const processesModule = { exports: {} };
  vm.runInNewContext(transformSync(fs.readFileSync(path.join(__dirname, '../src/processes.ts'), 'utf8'), { loader: 'ts', format: 'cjs' }).code, { module: processesModule, exports: processesModule.exports, require: id => Object.hasOwn(deps, id) ? deps[id] : require(id), Buffer, process, AbortController, Promise });
  deps['./processes'] = processesModule.exports;
  const module = { exports: {} };
  vm.runInNewContext(transformSync(source, { loader: 'ts', format: 'cjs' }).code, { module, exports: module.exports, require: id => Object.hasOwn(deps, id) ? deps[id] : require(id), Buffer, console, process, AbortController, Promise, Set, Map, URL, URLSearchParams, setTimeout, clearTimeout });
  const Controller = module.exports.DeviceExplorerController;
  const controller = new Controller(message => { posts.push(message); options.onPost?.(message, controller); });
  return { controller, posts, calls, processState, config, temp, get stopCount() { return stopCount; }, async close() { await controller.dispose(); await fsp.rm(temp, { recursive: true, force: true }); } };
}

// 验证设备隐藏、同串号复用和串号切换都会关闭旧作用域并发布正确状态。
test('context lifecycle cancels old scope and cleans watchers', async () => {
  const f = await fixture();
  try {
    await f.controller.setContext('phone', true);
    await f.controller.setContext('phone', true, 'processes');
    await Promise.all([...f.controller.scope.tasks]);
    await f.controller.setContext('phone', true);
    await f.controller.setContext('other', true);
    await f.controller.setContext(undefined, false);
    assert.ok(f.posts.some(m => m.type === 'explorerState' && m.serial === 'phone'));
    assert.ok(f.stopCount >= 1);
    assert.equal(f.posts.at(-1).serial, undefined);
  } finally { await f.close(); }
});

// 验证 ready/list、权限拒绝时的虚拟入口、普通错误传播和路径注入拒绝。
test('list fallback and unsafe paths remain visible errors', async () => {
  const f = await fixture({ listError: ['/data'], listUnavailable: ['/broken'] });
  try {
    await f.controller.setContext('phone', true);
    await f.controller.handle({ type: 'explorer', action: 'ready' });
    await f.controller.handle({ type: 'explorer', action: 'list', path: '/data' });
    const fallback = f.posts.find(m => m.type === 'explorerFiles' && m.path === '/data');
    assert.deepEqual(Array.from(fallback.entries, e => e.name), ['data', 'local']);
    await f.controller.handle({ type: 'explorer', action: 'list', path: '/broken' });
    assert.match(f.posts.at(-1).error, /adb unavailable/);
    await f.controller.handle({ type: 'explorer', action: 'copyPath', paths: ['/ok', '/../escape'] });
    assert.match(f.posts.at(-1).error, /Invalid device path/);
  } finally { await f.close(); }
});

// 验证新建取消、删除确认、不可用操作和剪贴板路径都遵守真实消息输入。
test('file commands honor cancel confirmation and path copying', async () => {
  const f = await fixture({ input: undefined, confirm: 'Cancel' });
  try {
    await f.controller.setContext('phone', true);
    await f.controller.handle({ type: 'explorer', action: 'newFile', parent: '/' });
    assert.equal(f.calls.some(c => c[0] === 'create'), false);
    await f.controller.handle({ type: 'explorer', action: 'delete', paths: ['/x'] });
    assert.equal(f.calls.some(c => c[0] === 'remove'), false);
    await f.controller.handle({ type: 'explorer', action: 'copyPath', paths: ['/a', '/b'] });
    assert.deepEqual(f.calls.find(c => c[0] === 'clipboard'), ['clipboard', '/a\n/b']);
    await f.controller.handle({ type: 'explorer', action: 'delete', paths: [] });
    assert.match(f.posts.at(-1).error, /Select a file/);
  } finally { await f.close(); }
});

// 前端解析后的父目录进入真实execute/create/list链；文件与目录类型不混淆且名称穿越仍被拒绝。
test('new file and directory commands use the resolved parent and refresh it',async()=>{
  for(const action of ['newFile','newDirectory']){const f=await fixture({input:'new item'});try{await f.controller.setContext('phone',true);await Promise.all([...f.controller.scope.tasks]);await f.controller.handle({type:'explorer',action,parent:'/dest/'});assert.deepEqual(f.calls.find(c=>c[0]==='create'),['create','/dest/new item',action==='newDirectory']);assert.ok(f.calls.some(c=>c[0]==='list'&&c[1]==='/dest/'));}finally{await f.close();}}
  const f=await fixture({input:'../escape'});try{await f.controller.setContext('phone',true);await Promise.all([...f.controller.scope.tasks]);await f.controller.handle({type:'explorer',action:'newFile',parent:'/dest/'});assert.match(f.posts.at(-1).error,/Invalid file name/);assert.equal(f.calls.some(c=>c[0]==='create'),false);}finally{await f.close();}
});

// 验证分块上传 ACK、字节进度、相对路径、大小不匹配和重复传输的清理结果。
test('upload protocol enforces bytes, relative paths, duplicates and cleanup', async () => {
  const f = await fixture({ confirm: 'Continue' });
  try {
    await f.controller.setContext('phone', true);
    await f.controller.handle({ type: 'explorer', serial: 'phone', action: 'uploadBegin', transferId: 't1', target: '/', relativePath: 'dir/file.bin', size: 3 });
    await f.controller.handle({ type: 'explorer', serial: 'phone', action: 'uploadChunk', transferId: 't1', data: Buffer.from([1, 2]).toString('base64') });
    assert.equal(f.posts.findLast(m => m.type === 'explorerProgress' && m.bytes === 2)?.bytes, 2);
    await f.controller.handle({ type: 'explorer', serial: 'phone', action: 'uploadChunk', transferId: 't1', data: Buffer.from([3]).toString('base64') });
    await f.controller.handle({ type: 'explorer', serial: 'phone', action: 'uploadEnd', transferId: 't1' });
    assert.deepEqual(f.calls.find(c => c[0] === 'push').slice(2), ['/dir/file.bin']);
    await f.controller.handle({ type: 'explorer', serial: 'phone', action: 'uploadBegin', transferId: 't2', target: '/', relativePath: 'bad/../x', size: 1 });
    assert.match(f.posts.at(-1).error, /relative path/);
    await f.controller.handle({ type: 'explorer', serial: 'phone', action: 'uploadBegin', transferId: 't3', target: '/', relativePath: 'x', size: 2 });
    await f.controller.handle({ type: 'explorer', serial: 'phone', action: 'uploadBegin', transferId: 't3', target: '/', relativePath: 'y', size: 1 });
    assert.match(f.posts.at(-1).error, /already exists/);
    await f.controller.handle({ type: 'explorer', serial: 'phone', action: 'uploadEnd', transferId: 't3' });
    assert.match(f.posts.at(-1).error, /not open/);
    assert.equal(f.controller.scope.uploads.has('t3'), false);
    await f.controller.handle({ type: 'explorer', serial: 'phone', action: 'uploadBegin', transferId: 'size-mismatch', target: '/', relativePath: 'mismatch.bin', size: 5 });
    await f.controller.handle({ type: 'explorer', serial: 'phone', action: 'uploadEnd', transferId: 'size-mismatch' });
    assert.match(f.posts.at(-1).error, /size does not match/);
  } finally { await f.close(); }
});

// 目录分块协议使用已有所有者校验，ACK等待create和父目录刷新；不创建临时文件且拒绝穿越/旧设备。
test('directory upload ACK waits for creation and refresh without staging file resources',async()=>{
  let release,entered;const ready=new Promise(resolve=>{entered=resolve;}),gate=new Promise(resolve=>{release=resolve;});const f=await fixture({create:async()=>{entered();await gate;}});
  try{await f.controller.setContext('phone',true);await Promise.all([...f.controller.scope.tasks]);const message={type:'explorer',serial:'phone',action:'uploadBegin',transferId:'directory',target:'/dest',relativePath:'empty',directory:true};
    const task=f.controller.handle(message);await ready;assert.equal(f.posts.some(m=>m.type==='explorerUploadAck'&&m.transferId==='directory'),false);release();await task;
    const ack=f.posts.findLast(m=>m.type==='explorerUploadAck');assert.equal(ack.transferId,'directory');assert.equal(ack.error,undefined);assert.deepEqual(f.calls.find(c=>c[0]==='create'),['create','/dest/empty',true]);assert.ok(f.calls.some(c=>c[0]==='list'&&c[1]==='/dest'));assert.equal(f.controller.scope.uploads.size,0);assert.equal(f.calls.some(c=>c[0]==='push'),false);
    await f.controller.handle({...message,transferId:'unsafe',relativePath:'../outside'});assert.match(f.posts.at(-1).error,/relative path/);await f.controller.handle({...message,transferId:'other',serial:'other'});assert.match(f.posts.at(-1).error,/context changed/);assert.equal(f.calls.filter(c=>c[0]==='create').length,1);
  }finally{release();await f.close();}
});
// 已存在/权限拒绝等create错误必须原样回ACK，不能继续上传或宣称目录完成。
test('directory upload reports create failures instead of false completion',async()=>{
  const f=await fixture({create:async()=>{throw new Error('directory already exists');}});try{await f.controller.setContext('phone',true);await Promise.all([...f.controller.scope.tasks]);await f.controller.handle({type:'explorer',serial:'phone',action:'uploadBegin',transferId:'failed-directory',target:'/dest',relativePath:'empty',directory:true});assert.match(f.posts.at(-1).error,/directory already exists/);assert.equal(f.posts.some(m=>m.message==='Directory uploaded'),false);assert.equal(f.controller.scope.uploads.size,0);}finally{await f.close();}
});

// 验证进程行归属、未知 PID 拒绝以及 Kill 与 ForceStop 使用不同后端动作。
test('process actions require owned rows and distinguish kill from force stop', async () => {
  const f = await fixture();
  try {
    await f.controller.setContext('phone', true, 'processes');
    await Promise.all([...f.controller.scope.tasks]);
    await f.processState.onUpdate([{ pid: 42, name: 'app', packageName: 'com.example.app', userId: 10, debugger: 'default' }]);
    await f.controller.handle({ type: 'explorer', action: 'kill', pid: 42 });
    await f.controller.handle({ type: 'explorer', action: 'forceStop', pid: 42 });
    assert.deepEqual(f.calls.filter(c => c[0] === 'kill'), [['kill', 42]]);
    assert.deepEqual(f.calls.filter(c => c[0] === 'forceStop'), [['forceStop', 'com.example.app', 10]]);
    await f.controller.handle({ type: 'explorer', action: 'kill', pid: 99 });
    assert.match(f.posts.at(-1).error, /no longer available/);
  } finally { await f.close(); }
});

// 调试能力同时检查真实注册类型和attach配置，不将Java提供方/孤立配置误报为Android；调用时重新验证卸载状态。
test('Android attach requires both a registered debugger type and matching configuration',async()=>{
  const f=await fixture();try{
    f.config.launch.push({name:'Attach Android',type:'android',request:'attach',custom:'preserved'},{name:'Java only',type:'java',request:'attach'});
    await f.controller.setContext('phone',true,'processes');await Promise.all([...f.controller.scope.tasks]);f.processState.onUpdate([{pid:42,name:'app',packageName:'com.example.app'}]);
    assert.equal(f.posts.findLast(m=>m.type==='explorerState').capabilities.debug,false);
    await f.controller.handle({type:'explorer',action:'debug',pid:42});assert.match(f.posts.at(-1).error,/Android attach debug adapter/);assert.equal(f.calls.some(c=>c[0]==='debug'),false);
    f.config.debuggerExtensions.push({packageJSON:{contributes:{debuggers:[{type:'java'}]}}});await f.controller.handle({type:'explorer',action:'ready'});assert.equal(f.posts.findLast(m=>m.type==='explorerState').capabilities.debug,false);
    f.config.debuggerExtensions.push({packageJSON:{contributes:{debuggers:[{type:'android'}]}}});await f.controller.handle({type:'explorer',action:'ready'});assert.equal(f.posts.findLast(m=>m.type==='explorerState').capabilities.debug,true);
    await f.controller.handle({type:'explorer',action:'debug',pid:42});const launched=f.calls.find(c=>c[0]==='debug')[2];assert.equal(launched.type,'android');assert.equal(launched.request,'attach');assert.equal(launched.serial,'phone');assert.equal(launched.pid,42);assert.equal(launched.processId,42);assert.equal(launched.packageName,'com.example.app');assert.equal(launched.custom,'preserved');
    f.config.debuggerExtensions.pop();await f.controller.handle({type:'explorer',action:'debug',pid:42});assert.match(f.posts.at(-1).error,/Android attach debug adapter/);assert.equal(f.calls.filter(c=>c[0]==='debug').length,1);await f.controller.handle({type:'explorer',action:'ready'});assert.equal(f.posts.findLast(m=>m.type==='explorerState').capabilities.debug,false);
  }finally{await f.close();}
});
// 匹配注册也不等于会话成功，startDebugging=false须明确报错而非进程操作成功。
test('Android debugger refusal remains a visible error with registered support',async()=>{
  const f=await fixture({debugResult:false});try{f.config.launch.push({name:'Attach',type:'android',request:'attach'});f.config.debuggerExtensions.push({packageJSON:{contributes:{debuggers:[{type:'android'}]}}});await f.controller.setContext('phone',true,'processes');await Promise.all([...f.controller.scope.tasks]);f.processState.onUpdate([{pid:42,name:'app'}]);await f.controller.handle({type:'explorer',action:'debug',pid:42});assert.match(f.posts.at(-1).error,/Android debug adapter did not start/);assert.equal(f.posts.some(m=>m.message==='Process action complete'),false);}finally{await f.close();}
});

// 同设备切换只取消活动操作并独立保留连接，Files重放缓存不重复读取；旧tab消息仍拒绝，精确60秒释放见view-idle。
test('independent Processes retains tracker while Files reuses its owned cache',async()=>{
  const f=await fixture();
  try{
    await f.controller.setContext('phone',true,'files');await Promise.all([...f.controller.scope.tasks]);assert.equal(f.calls.some(c=>c[0]==='watch'),false);
    f.calls.length=0;await f.controller.setContext('phone',true,'processes');await Promise.all([...f.controller.scope.tasks]);
    assert.equal(f.calls.filter(c=>c[0]==='watch').length,1);assert.equal(f.calls.some(c=>c[0]==='list'||c[0]==='stat'),false);
    const count=f.stopCount;await f.controller.setContext('phone',true,'processes');assert.equal(f.stopCount,count);
    await f.controller.handle({type:'explorer',action:'list',path:'/'});assert.match(f.posts.at(-1).error,/files view is not active/);
    f.calls.length=0;await f.controller.setContext('phone',true,'files');await Promise.all([...f.controller.scope.tasks]);
    assert.equal(f.calls.some(c=>c[0]==='stopWatch'||c[0]==='list'),false);assert.equal(f.stopCount,count);assert.equal(f.controller.scopes.size,2);assert.equal(f.controller.scopes.get('processes').processes.connected,true);
    await f.controller.handle({type:'explorer',action:'tab',tab:'processes'});assert.match(f.posts.at(-1).error,/Device Tools view controls/);
    await f.controller.handle({type:'explorer',action:'processes'});assert.match(f.posts.at(-1).error,/Processes view is not active/);
    await assert.rejects(f.controller.setContext('phone',true,'both'),/Invalid device surface/);
  }finally{await f.close();}
});
// 取消操作仍恢复当前Processes，而隐藏必须真正关闭tracker，不悄悄变为Files。
test('Processes cancellation preserves its view and hiding closes discovery',async()=>{
  const f=await fixture();
  try{
    await f.controller.setContext('phone',true,'processes');await Promise.all([...f.controller.scope.tasks]);
    const old=f.controller.scope;await f.controller.handle({type:'explorer',action:'cancel'});await Promise.all([...f.controller.scope.tasks]);
    assert.equal(old.controller.signal.aborted,true);assert.equal(f.posts.findLast(m=>m.type==='explorerState').tab,'processes');assert.equal(f.calls.some(c=>c[0]==='list'),false);
    const count=f.stopCount;await f.controller.setContext(undefined,false,'processes');assert.equal(f.stopCount,count+1);assert.equal(f.controller.scope,undefined);
  }finally{await f.close();}
});

// 独立进程模块确认期间收到PID消失事件，不能把旧选择应用到已消失或复用的PID。
test('process module revalidates selected row after asynchronous confirmation',async()=>{
  const f=await fixture();
  try{
    await f.controller.setContext('phone',true,'processes');await Promise.all([...f.controller.scope.tasks]);
    f.processState.onUpdate([{pid:42,name:'app',packageName:'com.example.app',debugger:'default'}]);
    const pending=f.controller.handle({type:'explorer',action:'kill',pid:42});f.processState.onUpdate([]);await pending;
    assert.equal(f.calls.some(c=>c[0]==='kill'),false);assert.match(f.posts.at(-1).error,/no longer available/);
  }finally{await f.close();}
});

// ACK中立即提交下一命令，begin/chunk/end必须连续成功且writer已经释放。
test('upload ACK releases writer before a synchronous next command',async()=>{
  const acks=[],tasks=[];let complete;const done=new Promise(resolve=>{complete=resolve;});
  const f=await fixture({onPost:(m,controller)=>{
    if(m.type!=='explorerUploadAck'||m.transferId!=='chain')return;
    acks.push({m,writer:controller.scope.writer});
    const action=m.action==='uploadBegin'?'uploadChunk':m.action==='uploadChunk'?'uploadEnd':undefined;
    if(action)tasks.push(controller.handle({type:'explorer',serial:'phone',action,transferId:'chain',...(action==='uploadChunk'?{data:Buffer.from([1,2,3]).toString('base64')}: {})}));else complete();
  }});
  try{
    await f.controller.setContext('phone',true);await Promise.all([...f.controller.scope.tasks]);
    await f.controller.handle({type:'explorer',serial:'phone',action:'uploadBegin',transferId:'chain',target:'/',relativePath:'chain.bin',size:3});await done;await Promise.all(tasks);
    assert.deepEqual(acks.map(x=>x.m.action),['uploadBegin','uploadChunk','uploadEnd']);assert.ok(acks.every(x=>x.writer===undefined&&!x.m.error&&x.m.serial==='phone'));
    assert.deepEqual([...await fsp.readFile(path.join(f.temp,'chain.bin'))],[1,2,3]);assert.equal(f.controller.scope.uploads.size,0);
  }finally{await f.close();}
});
// 最后push未结束不能回ACK，提交失败必须带设备/动作并清理真实临时文件。
test('upload final ACK waits for remote push and reports commit failure',async()=>{
  let entered,release;const started=new Promise(resolve=>{entered=resolve;});const push=new Promise((resolve,reject)=>{release=reject;});
  const f=await fixture({push:async()=>{entered();await push;}});
  try{
    await f.controller.setContext('phone',true);await Promise.all([...f.controller.scope.tasks]);
    await f.controller.handle({type:'explorer',serial:'phone',action:'uploadBegin',transferId:'commit',target:'/',relativePath:'empty.bin',size:0});
    const task=f.controller.handle({type:'explorer',serial:'phone',action:'uploadEnd',transferId:'commit'});await started;
    assert.equal(f.posts.some(m=>m.type==='explorerUploadAck'&&m.action==='uploadEnd'),false);release(new Error('device disk full'));await task;
    const ack=f.posts.findLast(m=>m.type==='explorerUploadAck');assert.equal(ack.serial,'phone');assert.equal(ack.action,'uploadEnd');assert.match(ack.error,/device disk full/);
    assert.equal(f.controller.scope.uploads.size,0);assert.equal(f.controller.scope.writer,undefined);
    const local=f.calls.find(c=>c[0]==='push')[1];await assert.rejects(fsp.stat(local),{code:'ENOENT'});assert.equal(f.posts.some(m=>m.message==='Upload complete'),false);
  }finally{await f.close();}
});
// 旧设备命令不能清理当前设备的上传；重复Abort均只回收，不触发push。
test('upload rejects another device without discarding its owned transfer',async()=>{
  const f=await fixture();try{
    await f.controller.setContext('phone',true);await Promise.all([...f.controller.scope.tasks]);
    await f.controller.handle({type:'explorer',serial:'phone',action:'uploadBegin',transferId:'owned',target:'/',relativePath:'owned.bin',size:0});
    await f.controller.handle({type:'explorer',serial:'other',action:'uploadEnd',transferId:'owned'});
    assert.match(f.posts.at(-1).error,/device context changed/);assert.equal(f.controller.scope.uploads.has('owned'),true);
    for(let i=0;i<2;i++)await f.controller.handle({type:'explorer',serial:'phone',action:'uploadAbort',transferId:'owned'});
    assert.equal(f.posts.at(-1).error,undefined);assert.equal(f.posts.at(-1).action,'uploadAbort');assert.equal(f.controller.scope.uploads.size,0);assert.equal(f.calls.some(c=>c[0]==='push'),false);
  }finally{await f.close();}
});

// 迟到的Files消息不能在同串号Processes作用域创建上传，拒绝后Files仍能正常使用。
test('upload commands cannot create resources in the Processes surface',async()=>{
  const f=await fixture();try{
    await f.controller.setContext('phone',true,'processes');await Promise.all([...f.controller.scope.tasks]);f.calls.length=0;
    await f.controller.handle({type:'explorer',serial:'phone',action:'uploadBegin',transferId:'stale',target:'/',relativePath:'x',size:0});
    assert.match(f.posts.at(-1).error,/files view is not active/);assert.equal(f.controller.scope.uploads.size,0);assert.equal(f.calls.some(c=>c[0]==='stat'||c[0]==='create'),false);
  }finally{await f.close();}
});

// 隐藏发生在设备push期间时，必须中止拥有的signal、清理临时文件且不回最终成功ACK。
test('hiding during upload commit cancels push and waits for staging cleanup',async()=>{
  let entered;const started=new Promise(resolve=>{entered=resolve;});
  const f=await fixture({push:(local,remote,{signal})=>new Promise((resolve,reject)=>{
    signal.addEventListener('abort',()=>reject(signal.reason),{once:true});entered();
  })});
  try{
    await f.controller.setContext('phone',true);await Promise.all([...f.controller.scope.tasks]);
    await f.controller.handle({type:'explorer',serial:'phone',action:'uploadBegin',transferId:'closing',target:'/',relativePath:'closing.bin',size:0});
    const end=f.controller.handle({type:'explorer',serial:'phone',action:'uploadEnd',transferId:'closing'});await started;
    await f.controller.setContext(undefined,false);await end;
    const local=f.calls.find(c=>c[0]==='push')[1];await assert.rejects(fsp.stat(local),{code:'ENOENT'});
    assert.equal(f.controller.scope,undefined);assert.equal(f.posts.some(m=>m.type==='explorerUploadAck'&&m.action==='uploadEnd'),false);assert.equal(f.posts.some(m=>m.message==='Upload complete'),false);
  }finally{await f.close();}
});

// 普通目录只进行一次list；权限拒绝才使用同设备run-as，不能预先stat或吞掉普通ADB故障。
test('directory expansion avoids preliminary stat and retains run-as permission fallback',async()=>{
  const f=await fixture({listPermission:['/data/data/com.example.app'],listUnavailable:['/broken']});try{
    await f.controller.setContext('phone',true);await Promise.all([...f.controller.scope.tasks]);f.calls.length=0;
    await f.controller.handle({type:'explorer',action:'list',path:'/sdcard'});
    assert.deepEqual(f.calls.filter(c=>c[0]==='list'),[['list','/sdcard',undefined]]);assert.equal(f.calls.some(c=>c[0]==='stat'),false);
    f.calls.length=0;await f.controller.handle({type:'explorer',action:'list',path:'/data/data/com.example.app'});
    assert.deepEqual(f.calls.filter(c=>c[0]==='list'),[['list','/data/data/com.example.app',undefined],['list','/data/data/com.example.app','com.example.app']]);assert.equal(f.calls.some(c=>c[0]==='stat'),false);
    f.calls.length=0;await f.controller.handle({type:'explorer',action:'list',path:'/broken'});assert.match(f.posts.at(-1).error,/adb unavailable/);assert.equal(f.calls.filter(c=>c[0]==='list').length,1);
  }finally{await f.close();}
});

// 刷新父目录发现子目录已删除后，不能再查询/重放删除的旧缓存，也不能让空目录回复恢复旧行。
test('directory refresh invalidates removed subtrees before refreshing cached children',async()=>{
  let root=[{path:'/A',name:'A',kind:'directory'}];const f=await fixture({directoryEntries:remote=>remote==='/'?root:[{path:'/A/file',name:'file',kind:'file'}]});try{
    await f.controller.setContext('phone',true);await Promise.all([...f.controller.scope.tasks]);await f.controller.handle({type:'explorer',action:'list',path:'/A'});
    assert.equal(f.controller.scope.directories.has('/A'),true);root=[];f.calls.length=0;
    await f.controller.handle({type:'explorer',action:'refresh'});assert.equal(f.controller.scope.directories.has('/A'),false);
    assert.deepEqual(f.calls.filter(c=>c[0]==='list').map(c=>c[1]),['/']);
    f.posts.length=0;await f.controller.handle({type:'explorer',action:'ready'});assert.equal(f.posts.some(m=>m.type==='explorerFiles'&&m.path==='/A'),false);
  }finally{await f.close();}
});
