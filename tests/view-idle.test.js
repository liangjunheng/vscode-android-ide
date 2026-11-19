const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {transformSync}=require('esbuild');
const {EventEmitter}=require('node:events');

// 只推进已登记的时钟事件，不睡眠或轮询真实时间；精确断言59999/60000ms及取消后的旧期限。
class Clock {
  constructor(){this.now=0;this.timers=new Map();this.intervals=0;}
  // 返回可unref的真实测试句柄，清理按同一对象完成，不使用代次标识。
  set(fn,ms,repeat=false){const handle={unref(){return this;}};this.timers.set(handle,{fn,at:this.now+ms,ms,repeat});if(repeat)this.intervals++;return handle;}
  // 移除该句柄拥有的唯一事件。
  clear(handle){this.timers.delete(handle);}
  // 执行目标时刻以内的事件队列，回调中的新事件也遵循登记期限。
  advance(ms){const end=this.now+ms;while(true){const next=[...this.timers].filter(([,item])=>item.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];if(!next)break;const [handle,item]=next;this.now=item.at;if(item.repeat)item.at+=item.ms;else this.timers.delete(handle);item.fn();}this.now=end;}
}
// 外部事件Promise用于控制连接创建与清理，不通过增加超时让测试通过。
function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
// 执行真实TS模块，时钟及设备传输仅在宿主依赖边界替换。
function load(file,deps,clock,extra={}){
  const module={exports:{}};
  vm.runInNewContext(transformSync(fs.readFileSync(path.join(__dirname,'../src',file),'utf8'),{loader:'ts',format:'cjs'}).code,{module,exports:module.exports,require:id=>id==='./runtimeContext'?require('./runtime-context-loader.cjs')(deps,extra.process||process):Object.hasOwn(deps,id)?deps[id]:require(id),Buffer,process,console,AbortController,Uint8Array,setTimeout:(fn,ms)=>clock.set(fn,ms),clearTimeout:handle=>clock.clear(handle),setInterval:(fn,ms)=>clock.set(fn,ms,true),clearInterval:handle=>clock.clear(handle),...extra});
  return module.exports;
}
// 真正运行DeviceExplorerController/ProcessesController及调试器配置模块，宿主边界只替换设备/时钟；Node>=22运行node --test tests/view-idle.test.js验证连接归属、60秒期限和取消回收，不以空调试器stub绕过依赖。
function backend(clock,options={}){
  const calls=[],posts=[],watchers=[],errors=[];
  const vscode={workspace:{isTrusted:true,findFiles:async()=>[],getConfiguration:section=>({get:(key,fallback)=>section==='launch'?[]:fallback})},window:{showErrorMessage:error=>errors.push(error),showWarningMessage:async()=>options.confirm?options.confirm.promise:'Continue'}};
  class Files {
    // 每个实例固定设备并记录其实际生命周期归属。
    constructor(serial){this.serial=serial;calls.push(['files',serial,this]);}
    // 列举只产生确定性快照，取消测试可在依赖处注入真正遵循signal的等待。
    async list(remote,signal){calls.push(['list',this.serial,remote]);if(options.list)return options.list(remote,signal);return [{path:remote==='/'?'/data':remote+'/file',name:'data',kind:remote==='/'?'directory':'file'}];}
    // 文件元数据只服务命令前置检查，不替换生产调用链。
    async stat(remote){return {path:remote,kind:'directory'};}
  }
  class Processes {
    // PID后端实例也必须绑定设备，不能跨串号借用连接。
    constructor(serial){this.serial=serial;}
    // 追踪连接的stop是幂等的真实模拟资源，不把回调计数当连接状态。
    watch(onUpdate,onError,signal){const record={serial:this.serial,onUpdate,onError,signal,closed:false,stops:0};record.stop=async()=>{if(record.closed)return;record.closed=true;record.stops++;signal.removeEventListener('abort',record.stop);};signal.addEventListener('abort',record.stop,{once:true});watchers.push(record);calls.push(['watch',this.serial]);return options.watch?options.watch(record):record.stop;}
    // 记录危险命令以验证切走后的旧确认不会继续执行。
    async kill(pid,signal){signal.throwIfAborted();calls.push(['kill',this.serial,pid]);}
  }
  const deps={vscode,'./deviceExplorerFiles':{DeviceExplorerFiles:Files},'./deviceExplorerProcesses':{DeviceExplorerProcesses:Processes}};
  deps['./projectLocalConfig']=load('projectLocalConfig.ts',deps,clock);
  deps['./android-debugger']=load('android-debugger/index.ts',deps,clock);
  deps['./processes']=load('processes.ts',deps,clock);
  const {DeviceExplorerController}=load('deviceExplorer.ts',deps,clock);
  const controller=new DeviceExplorerController(message=>posts.push(message));
  // 等待当前已登记命令收尾，作为显式资源栅栏而非微任务轮询。
  const drain=async()=>{if(controller.scope)await Promise.all([...controller.scope.tasks]);};
  return {controller,calls,posts,watchers,errors,ProcessesController:deps['./processes'].ProcessesController,vscode,drain};
}
// 运行真实镜像提供方和连接状态检查，外部传输记录启动/关闭，不模拟模式实现本身。
function mirror(clock,options={}){
  const records=[],messages=[],errors=[],contexts=[],created=deferred();let reads=0;
  class Session {
    // 将handler与具体会话对象绑定，供断线及迟到事件测试。
    constructor(...args){this.serial=args[0];this.args=args;this.h=args.find(value=>value&&typeof value.onClose==='function');this.closed=false;this.live=false;this.stops=0;this.noDelay=0;records.push(this);created.resolve(this);}
    // 创建期间仍由该对象拥有，停止后完成不得变回可连接状态。
    async start(){if(options.startGate)await options.startGate.promise;if(this.closed)throw Object.assign(new Error('cancelled start'),{name:'AbortError'});this.live=true;}
    // 提供方只能复用真实仍然存活的传输。
    get connected(){return this.live&&!this.closed;}
    // 清理可延迟由外部事件完成，以断言dispose确实等待。
    async stop(){if(!this.closed){this.closed=true;this.live=false;this.stops++;this.h.onClose();}if(options.releaseStarted)options.releaseStarted.resolve();if(options.releaseGate)await options.releaseGate.promise;}
    // 远端关闭事件不是用户切换，不可自动在后台重连。
    fail(){this.closed=true;this.live=false;this.h.onClose('remote disconnected');}
    // 模拟既有gRPC视口接口，保持生产调用语义。
    setViewport(){}
  }
  const catalog=options.catalog||[{serial:'phone',state:'device'},{serial:'two',state:'device'}];
  const sdk={listDevices:async()=>catalog,grpcSupported:()=>false,grpcPortFor:()=>1,grpcTokenFor:()=>undefined,adbPath:()=> 'adb',runBuffer:async(cmd,args,signal)=>{reads++;return options.read?options.read(signal):Buffer.alloc(0);}};
  const vscode={workspace:{getConfiguration:()=>({get:(key,fallback)=>fallback})},commands:{executeCommand:async()=>{}},window:{showErrorMessage:error=>errors.push(error)}};
  const explorer=options.explorer||{setContext:async(...args)=>contexts.push(args),handle:async()=>{}};
  const deps={vscode,'./sdk':sdk,'./scrcpy':{ScrcpySession:Session,bundledJar:()=> 'jar'},'./emulatorGrpc':{EmulatorSession:Session,grpcSupported:()=>false},'./skin':{skinForAvd:()=>undefined}};
  const {RunningDeviceView}=load('runningDevices.ts',deps,clock);
  const view=new RunningDeviceView('',undefined,undefined,undefined,explorer);
  view.view={visible:true,webview:{postMessage:message=>messages.push(message)}};view.serial='phone';view.pickMode=()=>options.mode||'scrcpy';
  return {view,records,messages,errors,contexts,created,catalog,get reads(){return reads;}};
}

// 三种投屏传输都必须在60秒内复用，旧释放事件不能杀掉已恢复的连接，60秒后只重连一次。
test('mirror grace period reuses each live transport and expires at sixty seconds',async()=>{
  for(const mode of ['scrcpy','emulator','screencap']){
    const clock=new Clock(),f=mirror(clock,{mode});
    try{
      await f.view.restart();const owner=f.view.mirrorConnection,initial=f.records.length,intervals=clock.intervals;
      if(mode==='scrcpy') assert.equal(f.records[0].args.at(-1),1280);
      await f.view.applyDeviceViewMode('explorer');assert.equal(f.view.mirroredSerial(),undefined);clock.advance(59999);assert.equal(owner.controller.signal.aborted,false);
      await f.view.applyDeviceViewMode('mirror');assert.equal(f.view.mirrorConnection,owner,mode);assert.equal(f.records.length,initial);assert.equal(clock.intervals,intervals);
      clock.advance(1);assert.equal(owner.controller.signal.aborted,false);
      await f.view.applyDeviceViewMode('explorer');clock.advance(60000);assert.equal(owner.controller.signal.aborted,true);assert.equal(f.view.mirrorConnection,undefined);assert.equal(f.messages[f.messages.length-1].type,'loading');
      await f.view.applyDeviceViewMode('mirror');assert.notEqual(f.view.mirrorConnection,owner);assert.equal(f.records.length,mode==='screencap'?0:initial+1);assert.equal(clock.intervals,intervals);
    }finally{await f.view.dispose();assert.equal(clock.timers.size,0);}
  }
});
// 创建尚未完成时再进入投屏应等待同一连接，不得再次push/forward/start。
test('mirror connection creation is shared across rapid reentry',async()=>{
  const clock=new Clock(),gate=deferred(),f=mirror(clock,{startGate:gate});
  try{const first=f.view.restart();await f.created.promise;await f.view.applyDeviceViewMode('explorer');const returned=f.view.applyDeviceViewMode('mirror');gate.resolve();await Promise.all([first,returned]);assert.equal(f.records.length,1);assert.equal(f.records[0].connected,true);}
  finally{gate.resolve();await f.view.dispose();assert.equal(clock.timers.size,0);}
});
// 超时发生在创建中也要取消真正所有者，迟到完成不能把旧资源重新连上。
test('idle expiry cancels a pending mirror start without a late connection',async()=>{
  const clock=new Clock(),gate=deferred(),f=mirror(clock,{startGate:gate});
  try{const first=f.view.restart();await f.created.promise;const owner=f.view.mirrorConnection;await f.view.applyDeviceViewMode('explorer');clock.advance(60000);assert.equal(owner.controller.signal.aborted,true);gate.resolve();await first;assert.equal(f.records[0].connected,false);await f.view.applyDeviceViewMode('mirror');assert.equal(f.records.length,2);assert.equal(f.records[1].connected,true);}
  finally{gate.resolve();await f.view.dispose();}
});
// 已被远端关闭的对象不能复用，后台不自动重连，真正切回才创建下一会话。
test('mirror reentry reconnects a broken transport but never reconnects while inactive',async()=>{
  const clock=new Clock(),f=mirror(clock);try{await f.view.restart();await f.view.applyDeviceViewMode('explorer');f.records[0].fail();assert.equal(f.records.length,1);await f.view.applyDeviceViewMode('mirror');assert.equal(f.records.length,2);assert.equal(f.records[1].connected,true);}finally{await f.view.dispose();}
});
// 提供方销毁必须取消计时并等待真实清理Promise，不能把已发stop当作清理完成。
test('mirror dispose cancels idle timers and awaits transport cleanup',async()=>{
  const clock=new Clock(),gate=deferred(),started=deferred(),f=mirror(clock,{releaseGate:gate,releaseStarted:started});
  await f.view.restart();await f.view.applyDeviceViewMode('explorer');let finished=false;const closing=f.view.dispose().then(()=>{finished=true;});await started.promise;assert.equal(finished,false);assert.equal(clock.timers.size,0);gate.resolve();await closing;assert.equal(finished,true);
});
// 连接保留期允许截图循环存在，但非活动不发读取，超时取消仍在执行的旧设备读取。
test('inactive screenshot view stops reading and expiry aborts an owned capture',async()=>{
  const clock=new Clock(),started=deferred();let signal;
  const f=mirror(clock,{mode:'screencap',read:input=>new Promise((resolve,reject)=>{signal=input;input.addEventListener('abort',()=>reject(input.reason),{once:true});started.resolve();})});
  try{await f.view.restart();clock.advance(150);await started.promise;await f.view.applyDeviceViewMode('explorer');clock.advance(59999);assert.equal(f.reads,1);assert.equal(signal.aborted,false);clock.advance(1);assert.equal(signal.aborted,true);assert.equal(f.view.loop,undefined);}
  finally{await f.view.dispose();}
});
// 文件上下文与进程追踪独立倒计时，回文件不list，回进程不watch，过期后才重新建立。
test('Explorer and Processes retain independent scopes and exact idle deadlines',async()=>{
  const clock=new Clock(),f=backend(clock);try{
    await f.controller.setContext('phone',true,'files');await f.drain();const files=f.controller.scope;
    await f.controller.setContext('phone',true,'processes');await f.drain();const processes=f.controller.scope;assert.equal(f.watchers.length,1);
    clock.advance(59999);await f.controller.transition;assert.equal(f.watchers[0].closed,false);const lists=f.calls.filter(c=>c[0]==='list').length;
    await f.controller.setContext('phone',true,'files');assert.equal(f.controller.scope,files);assert.equal(f.calls.filter(c=>c[0]==='list').length,lists);
    clock.advance(1);await f.controller.transition;assert.equal(files.connection.signal.aborted,false);
    await f.controller.setContext('phone',false,'files');clock.advance(59999);await f.controller.transition;assert.equal(processes.connection.signal.aborted,true);assert.equal(files.connection.signal.aborted,false);
    clock.advance(1);await f.controller.transition;assert.equal(files.connection.signal.aborted,true);assert.equal(f.controller.scopes.size,0);
    await f.controller.setContext('phone',true,'processes');await f.drain();assert.equal(f.watchers.length,2);
  }finally{await f.controller.dispose();assert.equal(clock.timers.size,0);}
});
// 保留期间追踪继续更新自己的缓存，但不能把进程消息发给Files；回进程重放最新缓存而不再watch。
test('retained process tracker updates its cache without overwriting another view',async()=>{
  const clock=new Clock(),f=backend(clock);try{
    await f.controller.setContext('phone',true,'processes');await f.drain();await f.controller.setContext('phone',true,'files');await f.drain();f.posts.length=0;
    f.watchers[0].onUpdate([{pid:42,name:'new app',debugger:'default'}]);assert.equal(f.posts.some(m=>m.type==='explorerProcesses'),false);
    await f.controller.setContext('phone',true,'processes');assert.equal(f.watchers.length,1);assert.equal(f.posts.findLast(m=>m.type==='explorerProcesses').processes[0].pid,42);
  }finally{await f.controller.dispose();}
});
// 保留连接已经失败时必须关闭旧tracker并重连，不因stop函数仍存在就伪装连接成功。
test('retained process scope reconnects after a tracker failure',async()=>{
  const clock=new Clock(),f=backend(clock);try{await f.controller.setContext('phone',true,'processes');await f.drain();await f.controller.setContext('phone',true,'files');await f.drain();f.watchers[0].onError(new Error('socket closed'));await f.controller.setContext('phone',true,'processes');assert.equal(f.watchers.length,2);assert.equal(f.watchers[0].closed,true);assert.equal(f.controller.scope.processes.connected,true);}finally{await f.controller.dispose();}
});
// 三视图各自计时，切换第三个视图不能延长第一个视图的闲置期限。
test('all three views expire independently without disconnecting the active view',async()=>{
  const clock=new Clock(),f=backend(clock),m=mirror(clock,{explorer:f.controller});try{
    await m.view.restart();const first=m.view.mirrorConnection;await m.view.applyDeviceViewMode('explorer');await f.drain();const files=f.controller.scope;
    clock.advance(30000);await m.view.applyDeviceViewMode('processes');await f.drain();clock.advance(30000);await f.controller.transition;assert.equal(first.controller.signal.aborted,true);assert.equal(files.connection.signal.aborted,false);
    await m.view.applyDeviceViewMode('explorer');assert.equal(f.controller.scope,files);clock.advance(30000);await f.controller.transition;assert.equal(files.connection.signal.aborted,false);
    await m.view.applyDeviceViewMode('mirror');assert.equal(m.records.length,2);clock.advance(30000);await f.controller.transition;assert.equal(f.watchers[0].closed,true);assert.equal(m.records[1].connected,true);
  }finally{await m.view.dispose();await f.controller.dispose();assert.equal(clock.timers.size,0);}
});
// 真实Scrcpy模块的依赖边界：每个外部异步阶段都有可控完成事件，断言无迟到资源创建。
function scrcpy(clock,options={}){
  const calls=[],sockets=[],socketReady=deferred(),pushReady=deferred(),forwardReady=deferred();let closes=0,kills=0;
  class Socket extends EventEmitter {
    // 关闭同一真实模拟句柄只产生一次close事件。
    setNoDelay(){return this;}
    destroy(){if(!this.destroyed){this.destroyed=true;this.emit('close');}return this;}
  }
  const sdk={adbPath:()=> 'adb',sdkRoot:()=> 'sdk',freePort:async()=>31415,
    runBuffer:async(cmd,args,signal)=>{calls.push(['push',...args]);pushReady.resolve(signal);if(options.push)return options.push(signal);return Buffer.alloc(0);},
    adb:async(serial,...args)=>{calls.push(args);if(args[0]==='forward'&&args[1]!=='--remove'){forwardReady.resolve();if(options.forward)await options.forward.promise;}if(args[1]==='--remove'&&options.remove)await options.remove.promise;}};
  const deps={'./sdk':sdk,net:{connect:()=>{const socket=new Socket();sockets.push(socket);socketReady.resolve(socket);return socket;}},child_process:{spawn:()=>{calls.push(['spawn']);const proc=new EventEmitter();proc.stdout=new EventEmitter();proc.stderr=new EventEmitter();proc.exitCode=null;proc.kill=()=>{kills++;proc.exitCode=0;proc.emit('exit');};return proc;}}};
  const {ScrcpySession}=load('scrcpy.ts',deps,clock);
  const session=new ScrcpySession('phone','jar',{onPacket(){},onClose(){closes++;}});
  return {session,calls,sockets,socketReady,pushReady,forwardReady,get closes(){return closes;},get kills(){return kills;}};
}
// push取消信号到达执行层，取消后不取得端口、不建立forward或子进程。
test('actual scrcpy push cancellation prevents every later startup resource',async()=>{
  const clock=new Clock(),f=scrcpy(clock,{push:signal=>new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}))});
  const starting=f.session.start(),failed=assert.rejects(starting,{name:'AbortError'});const signal=await f.pushReady.promise;await f.session.stop();await failed;assert.equal(signal.aborted,true);assert.equal(f.calls.length,1);assert.equal(f.session.connected,false);assert.equal(clock.timers.size,0);
});
// forward ACK之后才能移除；停止后迟到ACK必须回收且不能继续spawn。
test('actual scrcpy cancels startup during forward and removes its acknowledged forward once',async()=>{
  const clock=new Clock(),gate=deferred(),f=scrcpy(clock,{forward:gate});const starting=f.session.start(),failed=assert.rejects(starting,{name:'AbortError'});
  await f.forwardReady.promise;await f.session.stop();assert.equal(f.calls.some(c=>c[1]==='--remove'),false);gate.resolve();await failed;await f.session.stop();assert.equal(f.calls.filter(c=>c[1]==='--remove').length,1);assert.equal(f.calls.some(c=>c[0]==='spawn'),false);assert.equal(f.session.connected,false);
});
// 握手socket或ECONNREFUSED重试计时器都属于该连接，取消后推进时钟不能再connect。
test('actual scrcpy handshake cancellation destroys sockets and clears retry timer',async()=>{
  for(const refused of [false,true]){const clock=new Clock(),f=scrcpy(clock);const starting=f.session.start(),failed=assert.rejects(starting,{name:'AbortError'});const socket=await f.socketReady.promise;
    if(refused){socket.emit('error',Object.assign(new Error('not ready'),{code:'ECONNREFUSED'}));socket.destroy();assert.equal(clock.timers.size,1);}
    await f.session.stop();await failed;clock.advance(10000);assert.equal(socket.destroyed,true);assert.equal(f.sockets.length,1);assert.equal(clock.timers.size,0);assert.equal(f.kills,1);assert.equal(f.closes,1);assert.equal(f.calls.filter(c=>c[1]==='--remove').length,1);}
});
// 非启动拒绝错误不重试，失败对调用方可见，finally仍释放已拥有资源。
test('actual scrcpy propagates fatal handshake errors without retry',async()=>{
  const clock=new Clock(),f=scrcpy(clock),error=Object.assign(new Error('denied'),{code:'EACCES'});const starting=f.session.start(),failed=assert.rejects(starting,e=>e===error);const socket=await f.socketReady.promise;socket.emit('error',error);socket.destroy();await failed;await f.session.stop();assert.equal(clock.timers.size,0);assert.equal(f.sockets.length,1);
});
// 正常启动后根据实际socket判断连接；关闭control立即断线，stop等待forward移除。
test('actual scrcpy connected state follows sockets and stop awaits forward cleanup',async()=>{
  const clock=new Clock(),remove=deferred(),f=scrcpy(clock,{remove});const starting=f.session.start();const video=await f.socketReady.promise;video.emit('data',Buffer.from([0]));await starting;assert.equal(f.session.connected,true);assert.equal(f.sockets.length,2);
  f.sockets[1].destroy();assert.equal(f.session.connected,false);let done=false;const closing=f.session.stop().then(()=>{done=true;});await Promise.resolve();assert.equal(done,false);remove.resolve();await closing;assert.equal(done,true);assert.equal(video.destroyed,true);assert.equal(f.closes,1);assert.equal(f.kills,1);
});
// 真实EmulatorSession以外部gRPC回调控制启动阶段，验证关闭后不再调用下一阶段。
function emulator(clock){
  const ready=deferred(),status=deferred(),streams=[];let client,closes=0;
  class Client {
    // 只记录gRPC客户端归属，不替代生产会话生命周期。
    constructor(){client=this;this.closed=0;}
    // 就绪事件由测试明确交付，不能用睡眠或微任务轮询。
    waitForReady(deadline,callback){ready.resolve(callback);}
    // 状态事件亦由测试交付。
    getStatus(request,callback){status.resolve(callback);}
    // 流是实际EventEmitter句柄，关闭次数可被严格断言。
    streamScreenshot(){const stream=new EventEmitter();stream.cancelled=0;stream.cancel=()=>{stream.cancelled++;};streams.push(stream);return stream;}
    // 每次客户端释放都必须可观察。
    close(){this.closed++;}
  }
  const deps={'./sdk':{sdkRoot:()=> 'sdk'},'@grpc/grpc-js':{credentials:{createInsecure:()=>({})},loadPackageDefinition:()=>({android:{emulation:{control:{EmulatorController:Client}}}})},'@grpc/proto-loader':{loadSync:()=>({})}};
  const {EmulatorSession}=load('emulatorGrpc.ts',deps,clock);const session=new EmulatorSession(8554,{onFrame(){},onClose(){closes++;}},{w:400,h:800});
  return {session,ready,status,streams,get client(){return client;},get closes(){return closes;}};
}
// readiness/status期间停止后，旧回调成功也不得打开截图流；正常流关闭后不能再复用。
test('actual emulator startup cancellation and healthy stream state follow owned client',async()=>{
  for(const phase of ['ready','status','live']){const f=emulator(new Clock()),starting=f.session.start();const failure=phase==='live'?undefined:assert.rejects(starting,{name:'AbortError'});const ready=await f.ready.promise;
    if(phase==='ready'){f.session.stop();ready();await failure;assert.equal(f.streams.length,0);}
    else{ready();const status=await f.status.promise;if(phase==='status')f.session.stop();status(undefined,{hardwareConfig:{entry:[]}});if(phase==='status'){await failure;assert.equal(f.streams.length,0);}else{await starting;assert.equal(f.session.connected,true);f.session.stop();assert.equal(f.streams[0].cancelled,1);}}
    assert.equal(f.session.connected,false);assert.equal(f.client.closed,1);assert.equal(f.closes,1);f.session.stop();assert.equal(f.client.closed,1);}
});
// 关闭失败不会阻止其他视图回收，最终仍将真实错误交还调用方。
test('mirror dispose releases Explorer even when transport cleanup fails',async()=>{
  const clock=new Clock(),gate=deferred(),f=mirror(clock,{releaseGate:gate});await f.view.restart();const closing=f.view.dispose(),failure=assert.rejects(closing,error=>error.name==='AggregateError'&&error.errors.some(e=>e.message==='remove failed'));gate.reject(new Error('remove failed'));await failure;assert.ok(f.contexts.some(c=>c[0]===undefined&&c[1]===false));assert.ok(f.errors.some(e=>e.includes('remove failed')));assert.equal(clock.timers.size,0);
});
// 进程创建任务共用；生命周期取消后即便watch迟到返回，也只清理一次且dispose等待。
test('process tracker shares startup and waits for cancellation cleanup',async()=>{
  const clock=new Clock(),gate=deferred(),entered=deferred(),f=backend(clock,{watch:record=>{entered.resolve(record);return gate.promise.then(()=>record.stop);}}),owner=new AbortController();
  const tracker=new f.ProcessesController('phone',owner.signal,()=>{}),first=tracker.start(false,[]),second=tracker.start(false,[]);const record=await entered.promise;assert.equal(f.watchers.length,1);const failed=Promise.all([assert.rejects(first,e=>e===owner.signal.reason),assert.rejects(second,e=>e===owner.signal.reason)]);owner.abort(new Error('closed'));let done=false;const closing=tracker.dispose().then(()=>{done=true;});await Promise.resolve();assert.equal(done,false);gate.resolve();await failed;await closing;assert.equal(record.stops,1);assert.equal(tracker.connected,false);
});
// 切走只取消待确认动作而保留真实tracker，确认迟到不能kill旧PID。
test('leaving Processes cancels pending confirmation while retaining its tracker',async()=>{
  const clock=new Clock(),confirm=deferred(),f=backend(clock,{confirm});try{await f.controller.setContext('phone',true,'processes');await f.drain();const scope=f.controller.scope;f.watchers[0].onUpdate([{pid:42,name:'app'}]);const action=scope.processes.handle({action:'kill',pid:42},scope.controller.signal),failure=assert.rejects(action,e=>e===scope.controller.signal.reason);await f.controller.setContext('phone',true,'files');confirm.resolve('Continue');await failure;assert.equal(f.calls.some(c=>c[0]==='kill'),false);assert.equal(f.watchers[0].closed,false);await f.controller.setContext('phone',true,'processes');assert.equal(f.watchers.length,1);}finally{confirm.resolve('Continue');await f.controller.dispose();}
});
// 已停止创建尚未收尾时先等待旧任务，避免同设备push/启动重叠；回归restart资源栅栏。
test('mirror reentry after expiry waits for the cancelled startup before reconnecting',async()=>{
  const clock=new Clock(),gate=deferred(),f=mirror(clock,{startGate:gate});try{const first=f.view.restart();await f.created.promise;await f.view.applyDeviceViewMode('explorer');clock.advance(60000);const resumed=f.view.applyDeviceViewMode('mirror');assert.equal(f.records.length,1);gate.resolve();await Promise.all([first,resumed]);assert.equal(f.records.length,2);assert.equal(f.records[0].connected,false);assert.equal(f.records[1].connected,true);}finally{gate.resolve();await f.view.dispose();}
});
// 设备从目录消失立即取消旧连接，而不是等闲置计时结束。
test('device catalog invalidation immediately stops retained mirror resources',async()=>{
  const clock=new Clock(),f=mirror(clock);try{await f.view.restart();await f.view.applyDeviceViewMode('explorer');f.catalog.length=0;await f.view.refreshDevices();assert.equal(f.records[0].connected,false);assert.equal(f.view.mirrorConnection,undefined);assert.equal(clock.timers.size,0);assert.ok(f.contexts.some(c=>c[0]===undefined&&c[1]===false));}finally{await f.view.dispose();}
});
// 共享二进制执行器保持原字节结果和错误，同时将真实连接signal原样交给execFile。
test('SDK runBuffer preserves bytes errors and child-process cancellation signal',async()=>{
  const calls=[],clock=new Clock(),deps={vscode:{},child_process:{execFile:(cmd,args,options,callback)=>{calls.push({cmd,args,options,callback});}}};
  deps['./projectLocalConfig']=load('projectLocalConfig.ts',deps,clock);
  const sdk=load('sdk.ts',deps,clock);
  const bytes=Buffer.from([0,255,13,10]),plain=sdk.runBuffer('adb',['version']);assert.equal(calls[0].options.signal,undefined);assert.equal(calls[0].options.encoding,'buffer');calls[0].callback(null,bytes);assert.equal(await plain,bytes);
  const owner=new AbortController(),pending=sdk.runBuffer('adb',['push'],owner.signal);assert.equal(calls[1].options.signal,owner.signal);const failed=assert.rejects(pending,e=>e===owner.signal.reason);owner.abort(new Error('cancelled child'));calls[1].callback(owner.signal.reason);await failed;
});
// 改设备与销毁不适用闲置宽限，所有旧设备计时、tracker与快照立即关闭。
test('device selection and disposal immediately close all retained backend sessions',async()=>{
  const clock=new Clock(),f=backend(clock);try{await f.controller.setContext('phone',true,'processes');await f.drain();await f.controller.setContext('phone',true,'files');await f.drain();const old=[...f.controller.scopes.values()];await f.controller.setContext('two',true,'files');await f.drain();assert.ok(old.every(scope=>scope.connection.signal.aborted));assert.equal(f.watchers[0].closed,true);assert.equal(clock.timers.size,0);assert.equal(f.controller.scope.serial,'two');}finally{await f.controller.dispose();assert.equal(clock.timers.size,0);}
});

// scrcpy失败后回退到截图模式只进入加载态，不把失败诊断重新覆盖到投屏占位。
test('scrcpy fallback does not replay startup error over screenshot loading state',async()=>{
  const clock=new Clock(),f=mirror(clock);f.view.restart=async()=>{f.messages.push({type:'mode',mode:'screencap'});};
  f.view.fallback('screencap','scrcpy failed (handshake closed); using screenshot mode');
  await Promise.resolve();
  assert.deepEqual(f.messages,[{type:'mode',mode:'screencap'}]);
});
