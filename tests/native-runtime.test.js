const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const vm = require('node:vm');
const path = require('node:path');
const { transformSync } = require('esbuild');

const root = path.resolve(__dirname, '..');

// 回归：Node>=22执行 node --test tests/native-runtime.test.js，断言加载真实生产模块与边界fixture，不替换待验证函数。
function loadJdwp() {
  const source = fs.readFileSync(path.join(root, 'src/android-debugger/native-debugger/upstream/src/jdwp.ts'), 'utf8');
  const module = { exports: {} };
  const code = transformSync(source, { loader: 'ts', format: 'cjs' }).code;
  vm.runInNewContext(code, { module, exports: module.exports, require(id) { if (id === './logger') return { logger: { log() {} } }; return require(id); }, Buffer, setTimeout, clearTimeout, console });
  return module.exports;
}

// 回归：Node>=22执行 node --test tests/native-runtime.test.js，断言加载真实生产模块与边界fixture，不替换待验证函数。
function packet(id, flags, error = 0) {
  const value = Buffer.alloc(11); value.writeUInt32BE(11, 0); value.writeUInt32BE(id, 4); value[8] = flags; value.writeUInt16BE(error, 9); return value;
}

test('JDWP real socket handshake/resume consumes interleaved packets and awaits close', async () => {
  const JDWP = loadJdwp().JDWP;
  const server = net.createServer(socket => {
    let data = Buffer.alloc(0);
    socket.on('data', chunk => {
      data = Buffer.concat([data, chunk]);
      if (data.subarray(0, 14).toString() === 'JDWP-Handshake') { socket.write('JDWP-Handshake'); data = data.subarray(14); }
      if (data.length >= 11) { socket.write(packet(41, 0)); const reply = packet(0, 0x80); socket.write(reply.subarray(0, 4)); setImmediate(() => socket.write(reply.subarray(4))); data = Buffer.alloc(0); }
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port; const client = new JDWP(port, '127.0.0.1');
  await client.connect(); await client.resume(); await client.disconnect();
  await new Promise(resolve => server.close(resolve));
});

test('runtime sources retain strict toolchain and cleanup contracts', () => {
  const android = fs.readFileSync(path.join(root, 'src/android-debugger/native-debugger/upstream/src/android.ts'), 'utf8');
  const paths = fs.readFileSync(path.join(root, 'src/android-debugger/native-debugger/upstream/src/androidPaths.ts'), 'utf8');
  const target = fs.readFileSync(path.join(root, 'src/android-debugger/native-debugger/upstream/src/targetCommand.ts'), 'utf8');
  assert.match(android, /resolveNativeToolchain/); assert.match(android, /executable:\s*\{path: toolchain\.adb/);
  const lldb = android.slice(android.indexOf('// LLDB server'), android.indexOf('// Simpleperf'));
  assert.doesNotMatch(android, /catch \{\s*\}/); assert.match(lldb, /subprocess\.start\(\);/); assert.doesNotMatch(lldb, /await subprocess\.start\(\)/);
  assert.match(paths, /export async function activate/); assert.doesNotMatch(paths, /await updatePaths/);
  assert.match(target, /throw error;/); assert.match(target, /async function lldbServerCleanup/);
});

// 回归：Node>=22执行 node --test tests/native-runtime.test.js，断言加载真实生产模块与边界fixture，不替换待验证函数。
async function loadAndroidRuntime(options = {}) {
  const state = { timerCallbacks: [], creates: [], calls: [], failCopy: false, failStart: false, stopCalls: 0, stopResolved: false, subprocesses: [], jdwpConnectFail: false, jdwpResumeFail: false, failRemoveForward: false, jdwp: [], processLines: [], processError: null, processStopError: null, processName: 'demo', packageOutput: '', packageError: false, processNameError: false, avdProperties: null, connectedDevices: [{udid:'serial',state:'device'}], deviceError: null, apkInfo: {name:'com.example.app'}, apkError: null, stopGate: undefined, installError: null, shellResult: '', avdId: 'serial', emulatorResult: {code:0,stdout:'Pixel\nINFO    | ignored\n'}, emulatorError: null };
  globalThis.__nativeRuntimeState = state;
  const { build } = require('esbuild');
  const entry = path.join(root, 'src/android-debugger/native-debugger/upstream/src/android.ts');
  const result = await build({ entryPoints: [entry], bundle: true, write: false, platform: 'node', format: 'cjs', absWorkingDir: root, plugins: [{ name: 'runtime-adb-mocks', setup(build) {
    build.onResolve({ filter: /^appium-adb$/ }, () => ({ path: 'appium-adb', namespace: 'runtime-adb-mock' }));
    build.onResolve({ filter: /(?:^|\/)jdwp$/ }, () => ({ path: 'jdwp', namespace: 'runtime-adb-mock' }));
    build.onResolve({ filter: /nativeToolchain|androidPaths|\.\/logger|\.\/utils|^ini$|^teen_process$/ }, args => ({ path: args.path, namespace: 'runtime-adb-mock' }));
    build.onLoad({ filter: /.*/, namespace: 'runtime-adb-mock' }, args => {
      if (args.path === 'jdwp') return { loader: 'js', contents: "const s=globalThis.__nativeRuntimeState; class JDWP { constructor(){ this.closed=false; } async connect(){ s.jdwp.push('connect'); if(s.jdwpConnectFail) throw new Error('connect failed'); } async resume(){ s.jdwp.push('resume'); if(s.jdwpResumeFail) throw new Error('resume failed'); } async disconnect(){ s.jdwp.push('disconnect'); this.closed=true; } } module.exports={JDWP};" };
      if (args.path === 'appium-adb') return { loader: 'js', contents: "const s=globalThis.__nativeRuntimeState; class ADB { constructor(opts){ s.creates.push(opts); this.opts=opts; this.EXEC_OUTPUT_FORMAT={FULL:'full'}; } clone(){ return this; } setDevice(d){ this.device=d; } async getConnectedDevices(options){ s.calls.push(['devices',options,this.opts.sdkRoot]); if(s.deviceError) throw s.deviceError; return s.connectedDevices; } async getApkInfo(apk){ s.calls.push(['apk',apk,this.opts.sdkRoot]); if(s.apkError) throw s.apkError; return s.apkInfo; } async getBinaryFromSdkRoot(name){s.calls.push(['binary',name]);return 'emulator';} async launchAVD(name){s.calls.push(['avd',name]);this.curDeviceId=s.avdId;} async getDeviceProperty(){ return 'arm64-v8a'; } async getNameByPid(){ if(s.processNameError) throw new Error('name failed'); return s.processName; } async getEmuImageProperties(){ return s.avdProperties; } async push(a,b){ s.calls.push(['push',a,b]); } async shell(cmd){ s.calls.push(['shell',cmd]); if(s.failCopy && cmd.includes('cat ')) throw new Error('copy failed'); if(cmd.includes('package list packages')) { if(s.packageError) throw new Error('package permission failed'); return s.packageOutput; } return s.shellResult; } createSubProcess(args){ const listeners={}; const p={args, on(name,fn){ (listeners[name] ||= []).push(fn); return p; }, off(name,fn){ listeners[name]=(listeners[name]||[]).filter(x=>x!==fn); return p; }, listenerCount(name){return (listeners[name]||[]).length;}, emit(name,...values){ for(const fn of listeners[name]||[]) fn(...values); }, async start(){ s.calls.push(['start']); if(s.failStart) throw new Error('start failed'); if(args[0]==='jdwp') queueMicrotask(()=>{ if(s.processError) p.emit('error',s.processError); else if(s.processLines.length) p.emit('lines-stdout',s.processLines); }); }, async stop(){ s.stopCalls++; await s.stopGate; if(s.processStopError) throw s.processStopError; s.stopResolved=true; }}; s.subprocesses.push(p); return p; } async adbExec(args){ s.calls.push(['adbExec',args]); if(args[0]==='install' && s.installError) throw s.installError; return '12345'; } async removePortForward(p){ s.calls.push(['removeForward',p]); if(s.failRemoveForward) throw new Error('remove forward failed'); } } module.exports={ADB};" };
      if (args.path.includes('nativeToolchain')) return { loader: 'js', contents: "module.exports={resolveNativeToolchain(root){return {adb:'adb-'+(root||'default'),sdkRoot:'sdk-'+(root||'default'),ndkRoot:'ndk-'+(root||'default')};},findLldbServer(ndk,abi){return 'lldb-'+ndk+'-'+abi;}}" };
      if (args.path.includes('utils')) return { loader: 'js', contents: "module.exports={randomString(){return 'fixedsocket';}}" };
      if (args.path.includes('logger')) return { loader: 'js', contents: "module.exports={logger:{log(){},warn(){}}}" };
      if (args.path === 'teen_process') return { loader:'js', contents:"const s=globalThis.__nativeRuntimeState;module.exports={async exec(command,args,opts){s.calls.push(['exec',command,args,opts]);if(s.emulatorError)throw s.emulatorError;return s.emulatorResult;}}" };
      if (args.path === 'ini') return { loader: 'js', contents: "module.exports={parse(s){ const m=s.match(/avd\.ini\.displayname\s*=\s*(.*)/); return m ? {'avd.ini.displayname': m[1].trim()} : {}; }}" };
      return { loader: 'js', contents: "module.exports={}" };
    });
  }}] });
  const module = { exports: {} };
  const runtime = { module, exports: module.exports, require, process, console, globalThis };
  if (options.fakeTimers) { runtime.setTimeout = (fn, ms) => { const timer = {fn, ms, active: true}; state.timerCallbacks.push(timer); return timer; }; runtime.clearTimeout = timer => { if (timer) timer.active = false; }; } else { runtime.setTimeout = setTimeout; runtime.clearTimeout = clearTimeout; }
  runtime.queueMicrotask = queueMicrotask; vm.runInNewContext(result.outputFiles[0].text, runtime);
  return { api: module.exports, state, fireTimers(ms) { for (const timer of state.timerCallbacks) { if (timer.active && timer.ms === ms) { timer.active = false; timer.fn(); } } } };
}

test('Android runtime uses project toolchains and preserves ABI selection', async () => {
  const loaded = await loadAndroidRuntime();
  const one = await loaded.api.getAdb('project-one'); const two = await loaded.api.getAdb('project-two'); const again = await loaded.api.getAdb('project-one');
  assert.notEqual(one, two); assert.equal(one, again); assert.equal(loaded.state.creates[0].executable.path, 'adb-project-one'); assert.equal(loaded.state.creates[0].sdkRoot, 'sdk-project-one'); assert.equal(loaded.state.calls[0][0], 'adbExec'); assert.equal(loaded.state.calls[0][1][0], 'start-server');
  assert.equal(await loaded.api.getBestAbi({ androidProjectRoot: 'project-one' }, ['arm64-v8a']), 'arm64-v8a');
});

test('LLDB deployment follows upstream nonblocking startup and awaits stop', async () => {
  const loaded = await loadAndroidRuntime(); const device = { androidProjectRoot: 'project-one', udid: 'serial' };
  const result = await loaded.api.startLldbServer(device, 'com.example.app', 'arm64-v8a');
  assert.deepEqual(loaded.state.calls.slice(1, 4).map(x => x[0]), ['push', 'shell', 'shell']); assert.equal(loaded.state.calls[3][1].includes('chmod 700'), true); assert.equal(result.socket, '/com.example.app/platform-fixedsocket.sock');
  await result.stop(); await result.stop(); assert.equal(loaded.state.stopCalls, 1); assert.equal(loaded.state.stopResolved, true);
  loaded.state.failCopy = true; await assert.rejects(() => loaded.api.startLldbServer(device, 'com.example.app', 'arm64-v8a'), /copy failed/); loaded.state.failCopy = false;
});


/** 验证 JDWP 对端异常会拒绝等待而不是挂起。 */
test('JDWP rejects a peer that closes before resume reply', async () => {
  const JDWP = loadJdwp().JDWP;
  const server = net.createServer(socket => { socket.once('data', chunk => { if (chunk.toString() === 'JDWP-Handshake') { socket.write('JDWP-Handshake'); socket.destroy(); } }); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const client = new JDWP(server.address().port, '127.0.0.1');
  await assert.rejects(async () => { await client.connect(); await client.resume(); }, /closed|ended|read/);
  await new Promise(resolve => server.close(resolve));
});

// 回归：Node>=22执行 node --test tests/native-runtime.test.js，断言加载真实生产模块与边界fixture，不替换待验证函数。
async function loadTargetCommandRuntime() {
  const state = { starts: 0, stops: 0, errors: [], cancelled: false, resumeCalls: 0, cleanupCalls: 0, cleanupPending: false, cleanupError: false };
  globalThis.__targetRuntimeState = state;
  const { build } = require('esbuild');
  const entry = path.join(root, 'src/android-debugger/native-debugger/upstream/src/targetCommand.ts');
  const result = await build({ entryPoints: [entry], bundle: true, write: false, platform: 'node', format: 'cjs', absWorkingDir: root, plugins: [{ name: 'target-mocks', setup(build) {
    build.onResolve({ filter: /^vscode$/ }, () => ({ path: 'vscode', namespace: 'target-mock' }));
    build.onResolve({ filter: /(?:^|\/)android$/ }, () => ({ path: 'android', namespace: 'target-mock' }));
    build.onResolve({ filter: /logger|targetPicker|commonTypes/ }, args => ({ path: args.path, namespace: 'target-mock' }));
    build.onLoad({ filter: /.*/, namespace: 'target-mock' }, args => {
      if (args.path === 'vscode') return { loader: 'js', contents: "const s=globalThis.__targetRuntimeState; module.exports={ProgressLocation:{Notification:1},window:{withProgress(o,fn){return fn({}, {onCancellationRequested(cb){return {dispose(){}}}})},showErrorMessage(m){s.errors.push(m);}},workspace:{}}" };
      if (args.path === 'android') return { loader: 'js', contents: "const s=globalThis.__targetRuntimeState; module.exports={async startLldbServer(){s.starts++; if(s.fail) throw new Error('lldb failed'); return {socket:'/pkg/platform.sock',async stop(){s.stops++;}}}, async resumeJavaDebugger(){s.resumeCalls++; return async function(){s.cleanupCalls++; if(s.cleanupPending) await new Promise((resolve,reject)=>{s.release=resolve; s.rejectCleanup=reject;}); if(s.cleanupError) throw new Error('cleanup failed');};}}" };
      return { loader: 'js', contents: "module.exports={logger:{log(){}},getCurrentOrPickTarget:async()=>({})}" };
    });
  }}] });
  const module = { exports: {} }; vm.runInNewContext(result.outputFiles[0].text, { module, exports: module.exports, require, process, console, globalThis, AggregateError });
  return { api: module.exports, state };
}

test('targetCommand propagates LLDB startup errors and awaits cleanup', async () => {
  const loaded = await loadTargetCommandRuntime(); loaded.state.fail = true;
  await assert.rejects(() => loaded.api.lldbServer({ device: {}, packageName: 'pkg', abi: 'arm64-v8a' }), /lldb failed/); assert.equal(loaded.state.errors.length, 1);
  const context={subscriptions:[]}; loaded.api.activate(context); assert.equal(context.subscriptions.length,1);
  loaded.state.fail = false; const socket = await loaded.api.lldbServer({ device: {}, packageName: 'pkg', abi: 'arm64-v8a' }); assert.equal(socket, '/pkg/platform.sock'); await loaded.api.lldbServerCleanup(socket); assert.equal(loaded.state.stops, 1); await loaded.api.lldbServerCleanup(socket); assert.equal(loaded.state.stops, 1);
  await loaded.api.lldbServer({device:{},packageName:'pkg',abi:'arm64-v8a'}); await context.subscriptions[0].dispose(); assert.equal(loaded.state.stops,2);
});


/** 验证 resumeJavaDebugger 的 setup/cleanup 时序、forward 失败及双错聚合。 */
test('resumeJavaDebugger awaits disconnect and forward cleanup, including setup and double failures', async () => {
  const loaded = await loadAndroidRuntime(); const device = { androidProjectRoot: 'project-one', udid: 'serial' };
  const cleanup = await loaded.api.resumeJavaDebugger(device, '42'); await cleanup();
  assert.deepEqual(loaded.state.jdwp, ['connect', 'resume', 'disconnect']); assert.equal(loaded.state.calls.at(-1)[0], 'removeForward');
  const setup = await loadAndroidRuntime(); setup.state.jdwpConnectFail = true; await assert.rejects(() => setup.api.resumeJavaDebugger(device, '42'), /connect failed/); assert.equal(setup.state.jdwp.includes('disconnect'), true); assert.equal(setup.state.calls.at(-1)[0], 'removeForward');
  const both = await loadAndroidRuntime(); both.state.jdwpResumeFail = true; both.state.failRemoveForward = true; await assert.rejects(() => both.api.resumeJavaDebugger(device, '42'), error => /setup and cleanup failed|cleanup failed/.test(error.message) && error.errors?.length >= 2);
});

/** 验证 androidPaths 激活只注册监听，requireRoot 懒解析并透传工具链错误。 */
test('androidPaths activation is lazy and require roots delegate shared toolchain', async () => {
  const state = { calls: 0, shouldFail: false }; globalThis.__pathsState = state;
  const source = fs.readFileSync(path.join(root, 'src/android-debugger/native-debugger/upstream/src/androidPaths.ts'), 'utf8');
  const code = transformSync(source, { loader: 'ts', format: 'cjs' }).code; const module = { exports: {} };
  const context = { module, exports: module.exports, require(id) {
    if (id === 'vscode') return { workspace: { onDidChangeConfiguration() { return { dispose() {} }; } } };
    if (id === './android') return { handlePathsUpdated: async () => {} };
    if (id === '../../nativeToolchain') return { resolveNativeToolchain(root) { state.calls++; if (state.shouldFail) throw new Error('toolchain failed'); return { sdkRoot: 'sdk-' + (root || 'default'), ndkRoot: 'ndk-' + (root || 'default') }; } };
    return require(id);
  }, console, process, globalThis };
  vm.runInNewContext(code, context); const api = module.exports; const contextObj = { subscriptions: [] }; await api.activate(contextObj); assert.equal(state.calls, 0); assert.equal(contextObj.subscriptions.length, 0); assert.equal(api.requireSdkRoot('p'), 'sdk-p'); assert.equal(api.requireNdkRoot('p'), 'ndk-p'); state.shouldFail = true; assert.throws(() => api.requireNdkRoot('bad'), /toolchain failed/);
});


/** 验证 resumeWaitingProcess 直接等待 cleanup 门闩，并传播 cleanup 错误。 */
test('resumeWaitingProcess awaits cleanup and rejects cleanup failures', async () => {
  const loaded = await loadTargetCommandRuntime(); loaded.state.cleanupPending = true;
  const pending = loaded.api.resumeWaitingProcess({ device: {}, pid: '42' });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(loaded.state.resumeCalls, 1); assert.equal(loaded.state.cleanupCalls, 1);
  let settled = false; pending.then(() => { settled = true; }, () => { settled = true; }); await Promise.resolve(); assert.equal(settled, false); loaded.state.release(); await pending; assert.equal(settled, true);
  const failed = await loadTargetCommandRuntime(); failed.state.cleanupError = true; await assert.rejects(() => failed.api.resumeWaitingProcess({ device: {}, pid: '42' }), /cleanup failed/);
});


/** 验证 JDWP disconnect 只在 close/error 事件后结束，并聚合握手与清理错误。 */
test('JDWP controlled socket waits for close and aggregates handshake cleanup failures', async () => {
  const { EventEmitter } = require('node:events');
  const state = { socket: null, autoClose: false, destroyError: false };
  class FakeSocket extends EventEmitter {
    constructor() { super(); this.destroyed = false; this.readableLength = 0; state.socket = this; }
    connect(_p, _h, cb) { queueMicrotask(cb); }
    write(_data, cb) { if (cb) queueMicrotask(cb); return true; }
    read() { return Buffer.from('invalid-handshake'); }
    end() {}
    destroy() { this.destroyed = true; if (state.destroyError) this.emit('error', new Error('destroy failed')); else if (state.autoClose) queueMicrotask(() => this.emit('close')); }
  }
  const source = fs.readFileSync(path.join(root, 'src/android-debugger/native-debugger/upstream/src/jdwp.ts'), 'utf8');
  const code = transformSync(source, { loader: 'ts', format: 'cjs' }).code; const module = { exports: {} };
  vm.runInNewContext(code, { module, exports: module.exports, Buffer, setTimeout, clearTimeout, console, require(id) { if (id === 'net') return { Socket: FakeSocket }; if (id === './logger') return { logger: { log() {} } }; return require(id); } });
  const JDWP = module.exports.JDWP; const client = new JDWP(1, 'fake'); state.socket.readableLength = 16; state.destroyError = true;
  await assert.rejects(() => client.connect(), error => error?.errors?.length === 2 && error.errors.some(e => /Handshake|handshake/.test(e.message)) && error.errors.some(e => /destroy/.test(e.message)));
  state.destroyError = false; const pending = new JDWP(1, 'fake'); const closing = pending.disconnect(); let settled = false; closing.then(() => { settled = true; }, () => { settled = true; }); await Promise.resolve(); assert.equal(settled, false); state.socket.emit('close'); await closing; assert.equal(settled, true);
});


/** 验证 processList/processInfo 的真实收集窗口、异常传播、可选包缺失语义和 stop 生命周期。 */
test('process runtime closures collect, propagate errors, and cleanup owned subprocess', async () => {
  const loaded = await loadAndroidRuntime({fakeTimers: true}); const device = { androidProjectRoot: 'project-one', udid: 'serial' };
  loaded.state.processLines = ['101', '102']; loaded.state.processName = 'demo';
  const pending = loaded.api.getProcessList(device); await new Promise(resolve => setImmediate(resolve)); loaded.fireTimers(200); const processes = await pending; assert.equal(processes.length, 2); assert.equal(loaded.state.stopResolved, true);
  loaded.state.processLines = []; const emptyPromise = loaded.api.getProcessList(device); await new Promise(resolve => setImmediate(resolve)); loaded.fireTimers(3000); assert.equal((await emptyPromise).length, 0);
  loaded.state.processError = new Error('jdwp permission failed'); await assert.rejects(() => loaded.api.getProcessList(device), /jdwp permission failed/);
  loaded.state.processError = null; loaded.state.packageOutput = 'package:com.example.app\npackage:com.other uid:10001\npackage:com.example.app\n';
  const info = await loaded.api.getProcessInfo(device, '101', true); assert.equal(JSON.stringify(info.packages), JSON.stringify(['com.example.app','com.other']));
  loaded.state.packageOutput = ''; assert.equal((await loaded.api.getProcessInfo(device, '101', true)).packages.length, 0);
  loaded.state.packageError = true; await assert.rejects(() => loaded.api.getProcessInfo(device, '101', true), /package permission failed/);
  loaded.state.packageError = false; loaded.state.processNameError = true; await assert.rejects(() => loaded.api.getProcessInfo(device, '101', false), /name failed/);
  const count = loaded.state.calls.length; await assert.rejects(() => loaded.api.getProcessInfo(device, '1;id', true), /Invalid Android PID/); assert.equal(loaded.state.calls.length, count);
});

/** 验证 getAvdDisplayName 真正解析 config.ini 并在属性缺失时稳定回退。 */
test('AVD display name parses config and falls back without metadata', async () => {
  const loaded = await loadAndroidRuntime(); const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'native-avd-')); fs.writeFileSync(path.join(dir, 'config.ini'), 'avd.ini.displayname=Pixel Friendly\n'); loaded.state.avdProperties = { path: dir }; assert.equal(await loaded.api.getAvdDisplayName('Pixel_API'), 'Pixel Friendly'); loaded.state.avdProperties = null; assert.equal(await loaded.api.getAvdDisplayName('Pixel_API'), 'Pixel API'); fs.rmSync(dir, { recursive: true, force: true });
});


/** 真实进程发现通过可控stop门闩验证结果、单错及双错，不以计时延迟代替资源结算。 */
test('process discovery awaits stop and preserves single and combined failures', async () => {
  const device = {udid:'serial',androidProjectRoot:'project'};
  const ok = await loadAndroidRuntime({fakeTimers:true}); let release;
  ok.state.stopGate = new Promise(resolve => {release=resolve;});
  let settled = false; const pending = ok.api.getProcessList(device).finally(()=>{settled=true;});
  await new Promise(resolve=>setImmediate(resolve)); ok.fireTimers(3000); await new Promise(resolve=>setImmediate(resolve));
  assert.equal(ok.state.stopCalls,1); assert.equal(settled,false); release(); assert.equal((await pending).length,0); assert.equal(settled,true);
  for (const failDiscovery of [false,true]) {
    const f=await loadAndroidRuntime({fakeTimers:true}); const primary=new Error('discovery failure'); const cleanup=new Error('stop failure');
    f.state.processError=failDiscovery ? primary : null; f.state.processStopError=cleanup;
    const promise=f.api.getProcessList(device); const rejected=assert.rejects(promise,error=>failDiscovery ? error.errors?.length===2 && error.errors[0]===primary && error.errors[1]===cleanup : error===cleanup);
    await new Promise(resolve=>setImmediate(resolve)); if(!failDiscovery) f.fireTimers(3000); await rejected;
    assert.equal(f.state.stopCalls,1); assert.equal(f.state.subprocesses[0].listenerCount('error'),0); assert.equal(f.state.subprocesses[0].listenerCount('lines-stdout'),0); const timers=f.state.timerCallbacks.filter(timer=>timer.active); assert.equal(timers.length,0);
  }
  const info=await loadAndroidRuntime({fakeTimers:true}); info.state.processLines=['42']; info.state.processNameError=true; info.state.processStopError=new Error('stop after name failure');
  const rejected=assert.rejects(info.api.getProcessList(device),error=>error.errors?.some(e=>/name failed/.test(e.message)) && error.errors.some(e=>e===info.state.processStopError));
  await new Promise(resolve=>setImmediate(resolve)); info.fireTimers(200); await rejected;
});

/** 执行真实设备导出，Appium仅作为查询边界；精确serial、项目工具链及错误均有结果断言。 */
test('explicit device queries preserve exact serial project roots missing and failure results', async () => {
  const {api,state}=await loadAndroidRuntime(); const wanted={udid:'wanted',state:'device',model:'Expected'};
  state.connectedDevices=[{udid:'wanted-prefix',state:'device'},wanted,{udid:'offline',state:'offline'}];
  assert.equal(await api.getDeviceFromUDID('wanted','project-two'),wanted);
  assert.equal(state.calls.at(-1)[1].verbose,true); assert.equal(state.calls.at(-1)[2],'sdk-project-two');
  await assert.rejects(api.getDeviceFromUDID('missing','project-two'),/Could not find connected device with serial missing/);
  assert.equal(await api.isDeviceConnected('wanted'),true); assert.equal(await api.isDeviceConnected('offline'),false); assert.equal(await api.isDeviceConnected('missing'),false);
  state.deviceError=new Error('device transport failed'); await assert.rejects(api.getDeviceFromUDID('wanted','project-two'),e=>e===state.deviceError); await assert.rejects(api.isDeviceConnected('wanted'),e=>e===state.deviceError);
  const before=await api.getAdb('project-two'); await api.handlePathsUpdated(); assert.notEqual(await api.getAdb('project-two'),before);
});

/** 执行真实APK包名解析，不用provider替身冒充设备函数回归。 */
test('APK metadata query preserves project root success missing metadata and ADB errors', async () => {
  const {api,state}=await loadAndroidRuntime(); assert.equal(await api.getPackageNameFromApk(''), ''); assert.equal(state.creates.length,0);
  assert.equal(await api.getPackageNameFromApk('app with space.apk','project-apk'),'com.example.app');
  assert.deepEqual(Array.from(state.calls.at(-1)),['apk','app with space.apk','sdk-project-apk']);
  state.apkInfo={}; assert.equal(await api.getPackageNameFromApk('no-name.apk','project-apk'),'');
  state.apkError=new Error('APK inspection failed'); await assert.rejects(api.getPackageNameFromApk('broken.apk','project-apk'),e=>e===state.apkError);
});

/** 覆盖Native launch及设备选择调用到的原安装、启动和AVD导出；只模拟Appium/进程边界。 */
test('application and AVD runtime helpers preserve original commands and diagnostics', async () => {
  const {api,state}=await loadAndroidRuntime(); const device={udid:'serial',androidProjectRoot:'project'};
  await api.installApp(device,'app.apk'); assert.equal(JSON.stringify(state.calls.at(-1)),JSON.stringify(['adbExec',['install','-r','app.apk']]));
  state.installError={stderr:'install stderr'}; await assert.rejects(api.installApp(device,'app.apk'),/install stderr/); state.installError=null;
  state.shellResult={stdout:'',stderr:''}; await api.launchApp(device,'com.example.app','.Main'); assert.equal(state.calls.at(-1)[1], 'am start -D -a android.intent.action.MAIN -c android.intent.category.LAUNCHER com.example.app/.Main');
  state.shellResult={stdout:'',stderr:'java.lang.SecurityException'}; await assert.rejects(api.launchApp(device,'com.example.app','.Main'),/permission/);
  assert.equal(JSON.stringify(await api.getAvdList()),JSON.stringify(['Pixel'])); assert.equal(state.calls.at(-1)[3].shell,false);
  state.emulatorError=new Error('emulator unavailable'); assert.equal((await api.getAvdList()).length,0);
  assert.equal((await api.launchAVD('Pixel')).udid,'serial'); state.avdId=undefined; await assert.rejects(api.launchAVD('Pixel'),/Could not launch Android Virtual Device/);
});
