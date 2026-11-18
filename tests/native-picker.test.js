const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const vm = require('node:vm');
const { build } = require('esbuild');
const root = path.resolve(__dirname, '..');

/** native-picker回归：Node>=22执行本文件，真实pickTarget路径覆盖设备/虚拟设备排序、root、取消和错误。 */
async function loadPicker() {
  const state = { picks: [], pickIndex: undefined, items: undefined, calls: [], connected: true, devices: [{udid:'phone',state:'device'},{udid:'offline',state:'offline'}], avds:['Pixel'], error: undefined };
  globalThis.__nativePickerState = state;
  const entry = path.join(root, 'src/android-debugger/native-debugger/upstream/src/targetPicker.ts');
  const result = await build({entryPoints:[entry],bundle:true,write:false,platform:'node',format:'cjs',absWorkingDir:root,plugins:[{name:'picker-mocks',setup(build){
    build.onResolve({filter:/^vscode$/},()=>({path:'vscode',namespace:'picker-mock'}));
    build.onResolve({filter:/(?:^|\/)android$/},()=>({path:'android',namespace:'picker-mock'}));
    build.onResolve({filter:/logger|commonTypes/},args=>({path:args.path,namespace:'picker-mock'}));
    build.onLoad({filter:/.*/,namespace:'picker-mock'},args=>{
      if(args.path==='vscode') return {loader:'js',contents:"const s=globalThis.__nativePickerState;module.exports={QuickPickItemKind:{Separator:-1},window:{async showQuickPick(items){const list=await items;s.items=list;s.calls.push(['quickPick',list.map(i=>i.label)]);return s.pickIndex === undefined ? s.picks.shift() : list[s.pickIndex];}},}"};
      if(args.path==='android') return {loader:'js',contents:"const s=globalThis.__nativePickerState;module.exports={async getAdb(root){s.calls.push(['adb',root]);return {async getConnectedDevices(){if(s.error)throw s.error;return s.devices;}}},async getAvdList(){s.calls.push(['avdList']);return s.avds.slice();},async getDeviceAdb(d){s.calls.push(['deviceAdb',d.udid,d.androidProjectRoot]);return {async getModel(){return d.udid==='phone'?'Phone':'Offline';},async sendTelnetCommand(){return 'Pixel';}}},async getAvdDisplayName(n){return 'Virtual '+n;},async launchAVD(n){s.calls.push(['launch',n]);return {udid:'emulator-1',state:'device'};},async isDeviceConnected(){return s.connected;},async getDeviceFromUDID(id,root){s.calls.push(['udid',id,root]);if(s.error)throw s.error;return {udid:id,androidProjectRoot:root};}}"};
      if(args.path.includes('logger')) return {loader:'js',contents:"module.exports={logger:{log(){}}}"};
      return {loader:'js',contents:"module.exports={}"};
    });
  }}]});
  const module={exports:{}};vm.runInNewContext(result.outputFiles[0].text,{module,exports:module.exports,require,console,globalThis});return {api:module.exports,state};
}

test('picker preserves connected/virtual ordering and project root', async()=>{
  const loaded=await loadPicker(); loaded.state.pickIndex=1; const picked=await loaded.api.pickTarget('root-one'); const items=loaded.state.items;
  assert.equal(items.length,4); assert.equal(items[0].kind,-1); assert.match(items[1].label,/Phone/); assert.equal(picked.androidProjectRoot,'root-one'); assert.match(items[3].label,/Virtual Pixel/); assert.equal(JSON.stringify(loaded.state.calls.slice(0,3)),JSON.stringify([['adb','root-one'],['avdList'],['deviceAdb','phone','root-one']]));
});

test('pickTarget returns selected target and cancellation', async()=>{
  const loaded=await loadPicker(); loaded.state.pickIndex=1; assert.equal((await loaded.api.pickTarget()).udid,'phone'); loaded.state.pickIndex=undefined; loaded.state.picks.push(undefined); assert.equal(await loaded.api.pickTarget(),undefined);
});

test('current and last target paths honor connection state', async()=>{
  const loaded=await loadPicker(); assert.equal(loaded.api.getCurrentTarget(),undefined); const current={udid:'current'}; loaded.api.setCurrentTarget(current); assert.equal(loaded.api.getCurrentTarget(),current); assert.equal((await loaded.api.getCurrentOrPickTarget('root')).udid,'current'); loaded.api.resetCurrentTarget(); assert.equal(loaded.api.getCurrentTarget(),undefined); loaded.state.pickIndex=1; await loaded.api.pickTarget(); assert.equal((await loaded.api.getLastOrPickTarget('root')).udid,'phone'); loaded.state.connected=false; loaded.state.pickIndex=undefined; loaded.state.picks.push(undefined); assert.equal(await loaded.api.getLastOrPickTarget(),undefined);
});

test('picker device errors propagate', async()=>{const loaded=await loadPicker();loaded.state.error=new Error('adb failed');await assert.rejects(()=>loaded.api.pickTarget('root'),/adb failed/);});

/** 激活仅记录上下文，不访问ADB或创建选择资源。 */
test('picker activation has no device allocation side effects', async()=>{
  const {api,state}=await loadPicker(); const subscriptions=[]; api.activate({subscriptions});
  assert.equal(state.calls.length,0); assert.equal(subscriptions.length,0); assert.equal(api.getCurrentTarget(),undefined);
});

/** 执行真实serial包装函数，仅在android边界替身记录参数，断言结果及原错误。 */
test('explicit serial wrapper forwards exact root returns device and propagates errors', async()=>{
  const {api,state}=await loadPicker();
  const target=await api.getTargetFromUDID('phone-serial','project-root');
  assert.equal(target.udid,'phone-serial'); assert.equal(target.androidProjectRoot,'project-root');
  assert.equal(JSON.stringify(state.calls),JSON.stringify([['udid','phone-serial','project-root']]));
  state.calls.length=0; state.error=new Error('explicit serial transport failed');
  await assert.rejects(api.getTargetFromUDID('other-serial','other-root'),error=>error===state.error);
  assert.equal(JSON.stringify(state.calls),JSON.stringify([['udid','other-serial','other-root']]));
});
