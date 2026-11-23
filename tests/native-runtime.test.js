const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const vm = require('node:vm');
const path = require('node:path');
const { transformSync } = require('esbuild');

const root = path.resolve(__dirname, '..');

// 功能点：Native lldb-server 启动就绪与生命周期回归。
// 受影响对象：android.ts 的 startLldbServer 依赖准备、并行传输、部署回滚、socket-file 事件就绪、earlyExit、隔离 stop；本测试的 ADB/SubProcess mock。
// 复现路径：以可控门闩分别阻塞ADB、编译和两路push，注入准备/传输/部署/清理错误；同设备同包连续启动，再分别停止。
// 测试范围：准备重叠、两push重叠、全结算后清理/部署、全部异常保留、两push一shell顺序、真实启动信号、无假echo、路径隔离、earlyExit和幂等stop。
// 执行入口：Node.js >= 22 执行 node --test tests/native-runtime.test.js。
// 预期结果：依赖完成后才部署，任一路失败均等待其他工作后回滚并保留清理异常；只有设备启动器确认匹配socket身份才完成启动。
// 判据：门闩未释放不得清理/部署；精确断言调用数、命令顺序、错误身份、产物和进程归属；未执行不视为通过。
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
  assert.doesNotMatch(android, /catch \{\s*\}/); assert.match(lldb, /await Promise\.race\(\[started, earlyExit\]\)/); assert.match(lldb, /compileServerLauncher/); assert.match(lldb, /ANDROID_NATIVE_LISTENING/); assert.doesNotMatch(lldb, /ANDROID_NATIVE_STARTED/);
  assert.match(paths, /export async function activate/); assert.doesNotMatch(paths, /await updatePaths/);
  assert.match(target, /throw error;/); assert.match(target, /async function lldbServerCleanup/);
});

/** 功能：加载真实Android模块并仅替换外部边界；输入可选假时钟；输出API、调用/资源状态及门闩钩子；验证：本文件Native部署和既有运行时用例。 */
async function loadAndroidRuntime(options = {}) {
  const state = { deploymentHooks: {}, launcherFiles: new Set(), remoteFiles: new Set(), toolchainCalls: [], timerCallbacks: [], creates: [], calls: [], failCopy: false, failStart: false, nativeExitBeforeReady: false, nativeReadyEvents: [], stopCalls: 0, stopResolved: false, subprocesses: [], jdwpConnectFail: false, jdwpResumeFail: false, failRemoveForward: false, jdwp: [], processLines: [], processError: null, processStopError: null, processName: 'demo', packageOutput: '', packageError: false, processNameError: false, avdProperties: null, connectedDevices: [{udid:'serial',state:'device'}], deviceError: null, apkInfo: {name:'com.example.app'}, apkError: null, stopGate: undefined, installError: null, shellResult: '', avdId: 'serial', emulatorResult: {code:0,stdout:'Pixel\nINFO    | ignored\n'}, emulatorError: null };
  globalThis.__nativeRuntimeState = state;
  const { build } = require('esbuild');
  const entry = path.join(root, 'src/android-debugger/native-debugger/upstream/src/android.ts');
  const result = await build({ entryPoints: [entry], bundle: true, write: false, platform: 'node', format: 'cjs', absWorkingDir: root, plugins: [{ name: 'runtime-adb-mocks', setup(build) {
    build.onResolve({ filter: /^appium-adb$/ }, () => ({ path: 'appium-adb', namespace: 'runtime-adb-mock' }));
    build.onResolve({ filter: /(?:^|\/)jdwp$/ }, () => ({ path: 'jdwp', namespace: 'runtime-adb-mock' }));
    build.onResolve({ filter: /serverLauncher$/ }, () => ({ path: 'serverLauncher', namespace: 'runtime-adb-mock' }));
    build.onResolve({ filter: /nativeToolchain|androidPaths|\.\/logger|\.\/utils|^ini$|^teen_process$/ }, args => ({ path: args.path, namespace: 'runtime-adb-mock' }));
    build.onLoad({ filter: /.*/, namespace: 'runtime-adb-mock' }, args => {
      if (args.path === 'jdwp') return { loader: 'js', contents: "const s=globalThis.__nativeRuntimeState; class JDWP { constructor(){ this.closed=false; } async connect(){ s.jdwp.push('connect'); if(s.jdwpConnectFail) throw new Error('connect failed'); } async resume(){ s.jdwp.push('resume'); if(s.jdwpResumeFail) throw new Error('resume failed'); } async disconnect(){ s.jdwp.push('disconnect'); this.closed=true; } } module.exports={JDWP};" };
      if (args.path === 'appium-adb') return { loader: 'js', contents: "const s=globalThis.__nativeRuntimeState; class ADB { constructor(opts){ s.creates.push(opts); this.opts=opts; this.EXEC_OUTPUT_FORMAT={FULL:'full'}; } clone(){ return this; } setDevice(d){ this.device=d; } async getConnectedDevices(options){ s.calls.push(['devices',options,this.opts.sdkRoot]); if(s.deviceError) throw s.deviceError; return s.connectedDevices; } async getApkInfo(apk){ s.calls.push(['apk',apk,this.opts.sdkRoot]); if(s.apkError) throw s.apkError; return s.apkInfo; } async getBinaryFromSdkRoot(name){s.calls.push(['binary',name]);return 'emulator';} async launchAVD(name){s.calls.push(['avd',name]);this.curDeviceId=s.avdId;} async getDeviceProperty(){ return 'arm64-v8a'; } async getNameByPid(){ if(s.processNameError) throw new Error('name failed'); return s.processName; } async getEmuImageProperties(){ return s.avdProperties; } async push(a,b){ s.calls.push(['push',a,b]); s.remoteFiles.add(b); await s.deploymentHooks.push?.(a,b); s.calls.push(['pushDone',a,b]); } async shell(cmd){ s.calls.push(['shell',cmd]); if(cmd.includes('rm -rf')) { await s.deploymentHooks.remove?.(cmd); const dir=cmd.split('rm -rf ')[1].split(' ')[0]; const tmp=cmd.split('rm -f ')[1].split(' '); for(const file of [...s.remoteFiles]) if(tmp.includes(file) || file.startsWith(dir+'/')) s.remoteFiles.delete(file); } if(s.failCopy && cmd.includes('cat ')) { s.remoteFiles.add(cmd.split('cat > ')[1].split(' ')[0]); throw new Error('copy failed'); } if(cmd.includes('mkdir -p')) { for(const match of cmd.matchAll(/cat > ([^ ]+)/g)) s.remoteFiles.add(match[1]); } if(cmd.includes('package list packages')) { if(s.packageError) throw new Error('package permission failed'); return s.packageOutput; } return s.shellResult; } createSubProcess(args){ const listeners={}; const p={args, on(name,fn){ (listeners[name] ||= []).push(fn); return p; }, off(name,fn){ listeners[name]=(listeners[name]||[]).filter(x=>x!==fn); return p; }, listenerCount(name){return (listeners[name]||[]).length;}, emit(name,...values){ for(const fn of listeners[name]||[]) fn(...values); }, async start(detector){ s.calls.push(['start']); if(s.failStart) throw new Error('start failed'); if(args[0]==='shell' && detector){ const command=args[1]; const socket=command.split(' ').find(value=>value.startsWith('unix-abstract://'))?.slice('unix-abstract://'.length); const event=s.nativeReadyEvent ?? `ANDROID_NATIVE_LISTENING\\t${socket}\\n`; if(s.nativeExitBeforeReady){ await new Promise(()=>{ queueMicrotask(()=>{ if(s.nativeReadyEvent) detector(event,''); p.emit('exit',1,null); }); }); } else { s.nativeReadyEvents.push(event); await new Promise((resolve,reject)=>queueMicrotask(()=>{try{if(detector(event,''))resolve();else reject(new Error('unexpected readiness output'));}catch(error){reject(error);}})); } } if(args[0]==='jdwp') queueMicrotask(()=>{ if(s.processError) p.emit('error',s.processError); else if(s.processLines.length) p.emit('lines-stdout',s.processLines); }); }, async stop(){ s.stopCalls++; await s.stopGate; if(s.processStopError) throw s.processStopError; s.stopResolved=true; }}; s.subprocesses.push(p); return p; } async adbExec(args){ s.calls.push(['adbExec',args]); if(args[0]==='start-server') await s.deploymentHooks.adb?.(); if(args[0]==='install' && s.installError) throw s.installError; return '12345'; } async removePortForward(p){ s.calls.push(['removeForward',p]); if(s.failRemoveForward) throw new Error('remove forward failed'); } } module.exports={ADB};" };
      if (args.path === 'serverLauncher') return { loader: 'js', contents: "const s=globalThis.__nativeRuntimeState;module.exports={async compileServerLauncher(ndk,abi){s.calls.push(['compile',ndk,abi]);await s.deploymentHooks.compile?.();s.launcherFiles.add('launcher');return {file:'launcher',async close(){s.calls.push(['launcherClose']);await s.deploymentHooks.close?.();s.launcherFiles.delete('launcher');}};}}" };
      if (args.path.includes('nativeToolchain')) return { loader: 'js', contents: "const s=globalThis.__nativeRuntimeState;module.exports={resolveNativeToolchain(root,overrides){s.toolchainCalls.push([root,overrides]);return {adb:'adb-'+(root||'default'),sdkRoot:overrides?.sdkRoot??'sdk-'+(root||'default'),ndkRoot:overrides?.ndkRoot??'ndk-'+(root||'default')};},findLldbServer(ndk,abi){s.calls.push(['findLldbServer',ndk,abi]);return 'lldb-'+ndk+'-'+abi;}}" };
      if (args.path.includes('utils')) return { loader: 'js', contents: "let sequence=0;module.exports={randomString(){return 'session'+(++sequence);}}" };
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

/** 功能：取得可控异步门闩；输入无；输出promise和显式释放/拒绝函数；验证：Native准备与传输并发用例，不使用睡眠判时。 */
function nativeGate() {
  return Promise.withResolvers();
}

/** 功能：验证完整部署依赖及命令；输入一次启动的边界调用，输出本次部署路径；验证：两push一shell、管道权限边界和随机隔离路径。 */
function assertNativeDeployment(calls) {
  const pushes = calls.filter(call => call[0] === 'push');
  assert.equal(pushes.length, 2);
  const server = pushes.find(call => call[1].startsWith('lldb-'));
  const launcher = pushes.find(call => call[1] === 'launcher');
  assert.ok(server); assert.ok(launcher);
  assert.match(server[2], /^\/data\/local\/tmp\/android-debug-session\d+$/);
  assert.equal(launcher[2], `${server[2]}-launcher`);
  const shells = calls.filter(call => call[0] === 'shell');
  assert.equal(shells.length, 1);
  const dir = `/data/data/com.example.app/android-debug/${server[2].split('android-debug-')[1]}`;
  assert.equal(shells[0][1], `run-as com.example.app mkdir -p ${dir} && cat ${server[2]} | run-as com.example.app sh -c 'cat > ${dir}/lldb-server && chmod 700 ${dir}/lldb-server' && cat ${launcher[2]} | run-as com.example.app sh -c 'cat > ${dir}/server-launcher && chmod 700 ${dir}/server-launcher'`);
  const completed = calls.filter(call => call[0] === 'pushDone');
  assert.equal(completed.length, 2);
  for (const call of completed) assert.ok(calls.indexOf(call) < calls.indexOf(shells[0]));
  assert.equal(calls.filter(call => call[0] === 'launcherClose').length, 1);
  assert.ok(calls.findIndex(call => call[0] === 'launcherClose') > calls.indexOf(shells[0]));
  assert.ok(calls.findIndex(call => call[0] === 'start') > calls.findIndex(call => call[0] === 'launcherClose'));
  return { dir, serverTmp: server[2], launcherTmp: launcher[2] };
}

/** 功能：验证准备重叠及配置透传；输入阻塞ADB/编译和显式工具链；输出成功句柄及释放后的空资源；验证：本用例断言两准备同时进入且只解析两次工具链。 */
test('Native preparation overlaps ADB and compilation while preserving toolchain overrides', { timeout: 5000 }, async () => {
  const { api, state } = await loadAndroidRuntime();
  const adb = nativeGate(), compile = nativeGate(), adbStarted = nativeGate(), compileStarted = nativeGate();
  state.deploymentHooks.adb = async () => { adbStarted.resolve(); await adb.promise; };
  state.deploymentHooks.compile = async () => { compileStarted.resolve(); await compile.promise; };
  const overrides = { sdkRoot: 'custom-sdk', ndkRoot: 'custom-ndk' };
  let settled = false;
  const pending = api.startLldbServer({ udid: 'serial', androidProjectRoot: 'project', androidNativeToolchain: overrides }, 'com.example.app', 'arm64-v8a');
  pending.then(() => { settled = true; }, () => { settled = true; });
  await Promise.all([adbStarted.promise, compileStarted.promise]);
  assert.equal(state.calls.some(call => call[0] === 'push'), false);
  compile.resolve(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(state.launcherFiles.size, 1); assert.equal(settled, false);
  assert.equal(state.calls.some(call => call[0] === 'push' || call[0] === 'launcherClose'), false);
  adb.resolve(); const server = await pending;
  assertNativeDeployment(state.calls);
  assert.equal(state.toolchainCalls.length, 2);
  for (const [project, actual] of state.toolchainCalls) { assert.equal(project, 'project'); assert.equal(actual, overrides); }
  assert.equal(state.creates[0].sdkRoot, 'custom-sdk');
  assert.equal(state.calls.find(call => call[0] === 'findLldbServer')[1], 'custom-ndk');
  assert.equal(state.calls.find(call => call[0] === 'compile')[1], 'custom-ndk');
  assert.equal(state.launcherFiles.size, 0);
  await server.stop(); assert.equal(state.remoteFiles.size, 0);
});

/** 功能：证明两次push重叠且全部成功后才部署；输入独立传输门闩；输出两push一shell和精确资源释放；验证：任一路未释放时不得安装、关闭launcher或启动。 */
test('Native pushes begin together and deployment waits for both transfers', { timeout: 5000 }, async () => {
  const { api, state } = await loadAndroidRuntime();
  const gates = { server: nativeGate(), launcher: nativeGate() };
  const entered = { server: nativeGate(), launcher: nativeGate() };
  state.deploymentHooks.push = async (file) => { const role = file === 'launcher' ? 'launcher' : 'server'; entered[role].resolve(); await gates[role].promise; };
  const pending = api.startLldbServer({ udid: 'serial' }, 'com.example.app', 'arm64-v8a');
  await Promise.all([entered.server.promise, entered.launcher.promise]);
  assert.equal(state.calls.filter(call => call[0] === 'push').length, 2);
  gates.server.resolve(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(state.calls.some(call => ['shell', 'launcherClose', 'start'].includes(call[0])), false);
  gates.launcher.resolve(); const server = await pending;
  assertNativeDeployment(state.calls); assert.equal(state.remoteFiles.size, 4); assert.equal(state.launcherFiles.size, 0);
  await server.stop(); await server.stop();
  assert.equal(state.remoteFiles.size, 0); assert.equal(state.stopCalls, 1);
});

/** 功能：失败传输等待另一传输退出后回滚；输入两种失败方向及独立门闩；输出原始异常且不遗留成功产物；验证：清理前不得close/删除，完成后删除两暂存文件且不启动。 */
test('Native failed push waits for the other transfer before cleanup in either direction', { timeout: 5000 }, async () => {
  for (const failedRole of ['server', 'launcher']) {
    const { api, state } = await loadAndroidRuntime();
    const gates = { server: nativeGate(), launcher: nativeGate() };
    const entered = { server: nativeGate(), launcher: nativeGate() };
    const failure = new Error(`${failedRole} transfer failed`);
    state.deploymentHooks.push = async file => { const role = file === 'launcher' ? 'launcher' : 'server'; entered[role].resolve(); await gates[role].promise; };
    let settled = false;
    const pending = api.startLldbServer({ udid: 'serial' }, 'com.example.app', 'arm64-v8a');
    pending.then(() => { settled = true; }, () => { settled = true; });
    const rejected = assert.rejects(pending, error => error === failure);
    await Promise.all([entered.server.promise, entered.launcher.promise]);
    gates[failedRole].reject(failure); await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, false);
    assert.equal(state.calls.some(call => ['shell', 'launcherClose', 'start'].includes(call[0])), false);
    assert.equal(state.launcherFiles.size, 1); assert.equal(state.remoteFiles.size, 2);
    gates[failedRole === 'server' ? 'launcher' : 'server'].resolve(); await rejected;
    const removals = state.calls.filter(call => call[0] === 'shell');
    assert.equal(removals.length, 1); assert.match(removals[0][1], /rm -rf/);
    assert.equal(state.calls.filter(call => call[0] === 'launcherClose').length, 1);
    assert.ok(state.calls.findIndex(call => call[0] === 'pushDone') < state.calls.indexOf(removals[0]));
    assert.equal(state.launcherFiles.size, 0); assert.equal(state.remoteFiles.size, 0); assert.equal(state.subprocesses.length, 0);
  }
});

/** 功能：准备失败等待并清理成功launcher；输入ADB拒绝、延迟编译和可选close拒绝；输出所有异常且无远端副作用；验证：ADB失败不提前结束，成功编译后必调用close。 */
test('Native ADB preparation failure waits for compilation and closes its launcher', { timeout: 5000 }, async () => {
  for (const failClose of [false, true]) {
    const { api, state } = await loadAndroidRuntime();
    const compile = nativeGate(), entered = nativeGate();
    const adbError = new Error('ADB preparation failed'), closeError = new Error('launcher close failed');
    state.deploymentHooks.adb = async () => { throw adbError; };
    state.deploymentHooks.compile = async () => { entered.resolve(); await compile.promise; };
    // 清理边界可在完成删除后报告错误，以同时断言异常保留和没有成功产物遗留。
    state.deploymentHooks.close = async () => { state.launcherFiles.delete('launcher'); if (failClose) throw closeError; };
    let settled = false;
    const pending = api.startLldbServer({ udid: 'serial' }, 'com.example.app', 'arm64-v8a');
    pending.then(() => { settled = true; }, () => { settled = true; });
    const rejected = assert.rejects(pending, error => failClose ? error.errors?.length === 2 && error.errors[0] === adbError && error.errors[1] === closeError : error === adbError);
    await entered.promise; await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, false); compile.resolve(); await rejected;
    assert.equal(state.calls.filter(call => call[0] === 'launcherClose').length, 1);
    assert.equal(state.calls.some(call => ['push', 'shell', 'start'].includes(call[0])), false);
    assert.equal(state.launcherFiles.size, 0); assert.equal(state.remoteFiles.size, 0);
  }
});

/** 功能：编译失败不能越过正在传输的server提前清理；输入编译拒绝和server传输门闩；输出两原始错误及无残留；验证：传输结算前启动调用未结束、无shell，随后回滚。 */
test('Native compile failure waits for an active server transfer and preserves both errors', { timeout: 5000 }, async () => {
  const { api, state } = await loadAndroidRuntime();
  const transfer = nativeGate(), entered = nativeGate();
  const compileError = new Error('compile failed while pushing'), pushError = new Error('push failed after compile');
  state.deploymentHooks.compile = async () => { throw compileError; };
  state.deploymentHooks.push = async () => { entered.resolve(); await transfer.promise; };
  let settled = false;
  const pending = api.startLldbServer({ udid: 'serial' }, 'com.example.app', 'arm64-v8a');
  pending.then(() => { settled = true; }, () => { settled = true; });
  const rejected = assert.rejects(pending, error => error.errors?.length === 2 && error.errors[0] === pushError && error.errors[1] === compileError);
  await entered.promise; await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false); assert.equal(state.calls.some(call => call[0] === 'shell'), false);
  transfer.reject(pushError); await rejected;
  assert.equal(state.calls.filter(call => call[0] === 'push').length, 1);
  assert.equal(state.calls.filter(call => call[0] === 'shell' && call[1].includes('rm -rf')).length, 1);
  assert.equal(state.calls.some(call => call[0] === 'launcherClose'), false);
  assert.equal(state.remoteFiles.size, 0); assert.equal(state.launcherFiles.size, 0); assert.equal(state.subprocesses.length, 0);
});

/** 功能：聚合独立准备/传输及清理全部异常；输入编译与server push双错、两push双错或部署错误；输出按身份完整保留错误；验证：不被finally覆盖，关闭失败仍回滚部署且不启动。 */
test('Native preparation deployment and cleanup retain every failure', { timeout: 5000 }, async () => {
  for (const scenario of ['compile-push', 'both-push', 'copy', 'close-only', 'prepare-both']) {
    const { api, state } = await loadAndroidRuntime();
    const serverError = new Error('server transfer failed'), launcherError = new Error('launcher transfer failed');
    const compileError = new Error('compilation failed'), adbError = new Error('ADB preparation failed');
    const closeError = new Error('launcher cleanup failed'), removeError = new Error('deployment cleanup failed');
    const expected = [];
    if (scenario === 'prepare-both') {
      state.deploymentHooks.adb = async () => { throw adbError; };
      state.deploymentHooks.compile = async () => { throw compileError; };
      expected.push(adbError, compileError);
    } else {
      if (scenario === 'compile-push' || scenario === 'both-push') {
        state.deploymentHooks.push = async file => { throw file === 'launcher' ? launcherError : serverError; };
        expected.push(serverError);
        if (scenario === 'compile-push') { state.deploymentHooks.compile = async () => { throw compileError; }; expected.push(compileError); }
        else expected.push(launcherError);
      }
      if (scenario === 'copy') state.failCopy = true;
      if (scenario !== 'compile-push') {
        state.deploymentHooks.close = async () => { state.launcherFiles.delete('launcher'); throw closeError; };
        expected.push(closeError);
      }
      // 模拟删除已完成但命令返回错误，保证仍检查成功产物均已释放。
      state.deploymentHooks.remove = async () => { state.remoteFiles.clear(); throw removeError; };
      expected.push(removeError);
    }
    await assert.rejects(api.startLldbServer({ udid: 'serial' }, 'com.example.app', 'arm64-v8a'), error => {
      assert.equal(error.errors?.length, expected.length + (scenario === 'copy' ? 1 : 0));
      for (const original of expected) assert.ok(error.errors.includes(original));
      if (scenario === 'copy') assert.equal(error.errors.filter(value => value.message === 'copy failed').length, 1);
      return true;
    });
    assert.equal(state.calls.filter(call => call[0] === 'launcherClose').length, ['compile-push', 'prepare-both'].includes(scenario) ? 0 : 1);
    assert.equal(state.calls.filter(call => call[0] === 'shell' && call[1].includes('rm -rf')).length, scenario === 'prepare-both' ? 0 : 1);
    assert.equal(state.remoteFiles.size, 0); assert.equal(state.launcherFiles.size, 0); assert.equal(state.subprocesses.length, 0);
  }
});

test('Native deployment rejects shell metacharacters before device operations', async () => {
  const loaded = await loadAndroidRuntime();
  for (const name of ['com.app;id', 'com.app\nother', '', 'com.app/other']) await assert.rejects(loaded.api.startLldbServer({ udid: 'serial' }, name, 'arm64-v8a'), /valid package/);
  assert.equal(loaded.state.calls.length, 0);
});

test('Native startup rejection is observed and rolls back the owned subprocess', async () => {
  const loaded = await loadAndroidRuntime(); loaded.state.failStart = true;
  await assert.rejects(loaded.api.startLldbServer({ udid: 'serial' }, 'com.example.app', 'arm64-v8a'), /start failed/);
  assert.equal(loaded.state.stopCalls, 1);
  assert.ok(loaded.state.calls.some(call => call[0] === 'shell' && call[1].includes('rm -rf')));
});

/** 功能点：Native server 在真实 socket-file 事件前退出时拒绝启动；受影响对象：startLldbServer 的 earlyExit、stop 和部署清理；复现路径：部署成功后让 SubProcess 在就绪事件前发出 exit；测试范围：提前退出异常、一次 stop、部署目录清理；执行入口：node --test tests/native-runtime.test.js；预期结果：不把进程退出误报为就绪，且等待立即拒绝并清理；判据：断言 Native server exited、已退出进程不重复stop且存在 rm -rf 调用。 */
test('Native startup rejects an early server exit before socket-file readiness', async () => {
  const loaded = await loadAndroidRuntime(); loaded.state.nativeExitBeforeReady = true;
  await assert.rejects(loaded.api.startLldbServer({ udid: 'serial' }, 'com.example.app', 'arm64-v8a'), /Native server exited before startup/);
  assert.equal(loaded.state.stopCalls, 0);
  assert.ok(loaded.state.calls.some(call => call[0] === 'shell' && call[1].includes('rm -rf')));
});

/** 功能点：忽略不匹配的目录事件；受影响对象：startLldbServer 的 socket-file 事件过滤和 earlyExit；复现路径：先输出错误文件名事件，再让服务退出；测试范围：错误事件不就绪、提前退出和清理；执行入口：node --test tests/native-runtime.test.js；预期结果：错误事件不能完成启动；判据：断言仍收到 earlyExit，而不是返回服务句柄。 */
test('Native startup ignores unrelated inotify directory events', async () => {
  const loaded = await loadAndroidRuntime(); loaded.state.nativeReadyEvent = 'mn\t/data/data/com.example.app/android-debug/session1\tother-file\n'; loaded.state.nativeExitBeforeReady = true;
  await assert.rejects(loaded.api.startLldbServer({ udid: 'serial' }, 'com.example.app', 'arm64-v8a'), /Native server exited before startup/);
  assert.equal(loaded.state.stopCalls, 0);
});

/** 功能：确认同包两会话不覆盖忙碌二进制；输入首服务存活时的第二次启动；输出独立路径/socket及各自stop；验证：精确两组部署命令、仅删自身产物和完整资源释放。 */
// 入口范围：同设备同包Attach后Launch路径隔离；node --test tests/native-runtime.test.js，不执行设备操作。
test('Attach then Launch keeps both Native deployments isolated while the first server is alive', async () => {
  const loaded = await loadAndroidRuntime(), device = { udid: 'serial', androidProjectRoot: 'project-one' };
  const first = await loaded.api.startLldbServer(device, 'com.example.app', 'arm64-v8a');
  const firstDeployment = assertNativeDeployment(loaded.state.calls);
  const boundary = loaded.state.calls.length;
  const second = await loaded.api.startLldbServer(device, 'com.example.app', 'arm64-v8a');
  const secondDeployment = assertNativeDeployment(loaded.state.calls.slice(boundary));
  assert.notEqual(firstDeployment.serverTmp, secondDeployment.serverTmp);
  assert.notEqual(firstDeployment.launcherTmp, secondDeployment.launcherTmp);
  assert.notEqual(firstDeployment.dir, secondDeployment.dir);
  assert.match(firstDeployment.dir, /android-debug\/session1$/); assert.match(secondDeployment.dir, /android-debug\/session3$/);
  assert.notEqual(first.socket, second.socket); assert.equal(loaded.state.stopCalls, 0);
  assert.doesNotMatch(loaded.state.calls.filter(call => call[0] === 'shell').map(call => call[1]).join('\n'), /android-debug\/lldb\/bin/);
  assert.equal(loaded.state.remoteFiles.size, 8); assert.equal(loaded.state.launcherFiles.size, 0);
  await second.stop(); assert.equal(loaded.state.stopCalls, 1);
  const removed = loaded.state.calls.filter(call => call[0] === 'shell' && call[1].includes('rm -rf'));
  assert.equal(removed.length, 1);
  assert.equal(removed[0][1], `run-as com.example.app rm -rf ${secondDeployment.dir} && rm -f ${secondDeployment.serverTmp} ${secondDeployment.launcherTmp}`);
  assert.doesNotMatch(removed[0][1], /android-debug\/session1/);
  assert.equal(loaded.state.remoteFiles.size, 4);
  assert.ok(loaded.state.remoteFiles.has(`${firstDeployment.dir}/lldb-server`));
  await first.stop(); assert.equal(loaded.state.stopCalls, 2); assert.equal(loaded.state.remoteFiles.size, 0);
});

test('Android runtime uses project toolchains and preserves ABI selection', async () => {
  const loaded = await loadAndroidRuntime();
  const one = await loaded.api.getAdb('project-one'); const two = await loaded.api.getAdb('project-two'); const again = await loaded.api.getAdb('project-one');
  assert.notEqual(one, two); assert.equal(one, again); assert.equal(loaded.state.creates[0].executable.path, 'adb-project-one'); assert.equal(loaded.state.creates[0].sdkRoot, 'sdk-project-one'); assert.equal(loaded.state.calls[0][0], 'adbExec'); assert.equal(loaded.state.calls[0][1][0], 'start-server');
  assert.equal(await loaded.api.getBestAbi({ androidProjectRoot: 'project-one' }, ['arm64-v8a']), 'arm64-v8a');
});

/** 功能：保留真实就绪、stop幂等及部署失败回滚；输入正常事件后再次注入copy失败；输出匹配socket和无残留资源；验证：精确部署调用、一次stop和失败清理。 */
test('LLDB deployment waits for startup acknowledgement and awaits stop', async () => {
  const loaded = await loadAndroidRuntime(); const device = { androidProjectRoot: 'project-one', udid: 'serial' };
  const result = await loaded.api.startLldbServer(device, 'com.example.app', 'arm64-v8a');
  assertNativeDeployment(loaded.state.calls); assert.equal(result.socket, '/com.example.app/platform-session2.sock');
  assert.equal(loaded.state.nativeReadyEvents[0], `ANDROID_NATIVE_LISTENING\t${result.socket}\n`);
  await result.stop(); await result.stop(); assert.equal(loaded.state.stopCalls, 1); assert.equal(loaded.state.stopResolved, true);
  assert.equal(loaded.state.remoteFiles.size, 0); assert.equal(loaded.state.launcherFiles.size, 0);
  loaded.state.failCopy = true; await assert.rejects(() => loaded.api.startLldbServer(device, 'com.example.app', 'arm64-v8a'), /copy failed/); loaded.state.failCopy = false;
  assert.equal(loaded.state.remoteFiles.size, 0); assert.equal(loaded.state.launcherFiles.size, 0);
  assert.equal(loaded.state.subprocesses.length, 1);
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


/** 功能：确认旧恢复及forward接口已退出；输入真实模块；输出无旧API；验证：npm test，恢复协议由Coordinator Java测试覆盖。 */
test('retired Android forward and resume APIs are absent', async () => {
  const loaded = await loadAndroidRuntime();
  for (const name of ['resumeJavaDebugger', 'forwardJdwpPort', 'removeTcpForward']) assert.equal(loaded.api[name], undefined);
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


/** 功能：拒绝旧手动恢复路径；输入旧命令参数；输出明确迁移错误且无旧资源副作用；验证：npm test。 */
test('retired manual resume cannot allocate another JDWP path', async () => {
  const loaded = await loadTargetCommandRuntime();
  await assert.rejects(loaded.api.resumeWaitingProcess({ device: {}, pid: '42' }), /Coordinator/);
  assert.equal(loaded.state.resumeCalls, 0);
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
