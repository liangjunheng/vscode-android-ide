const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const vm = require('node:vm');
const { build } = require('esbuild');

const root = path.resolve(__dirname, '..');

/** 以真实targetCommand生产函数连接vscode/android边界桩，覆盖包名与ABI自动解析的调用顺序。 */
async function loadTargetCommand() {
  const state = { quickPicks: [], processInfo: { name: 'com.example.app', packages: ['com.example.app'] }, installed: ['com.example.app'], installedAbi: undefined, deviceAbis: ['arm64-v8a', 'armeabi-v7a'], processList: [], calls: [], error: undefined };
  globalThis.__nativeResolutionState = state;
  const entry = path.join(root, 'src/android-debugger/native-debugger/upstream/src/targetCommand.ts');
  const result = await build({ entryPoints: [entry], bundle: true, write: false, platform: 'node', format: 'cjs', absWorkingDir: root, plugins: [{ name: 'native-resolution-mocks', setup(build) {
    build.onResolve({ filter: /^vscode$/ }, () => ({ path: 'vscode', namespace: 'native-resolution-mock' }));
    build.onResolve({ filter: /(?:^|\/)android$/ }, () => ({ path: 'android', namespace: 'native-resolution-mock' }));
    build.onResolve({ filter: /logger|targetPicker|commonTypes/ }, args => ({ path: args.path, namespace: 'native-resolution-mock' }));
    build.onLoad({ filter: /.*/, namespace: 'native-resolution-mock' }, args => {
      if (args.path === 'vscode') return { loader: 'js', contents: "const s=globalThis.__nativeResolutionState; module.exports={ProgressLocation:{Notification:1},window:{async showQuickPick(items){const list=await items;s.calls.push(['quickPick',list.map(x=>x.label)]);return s.quickPicks.shift();},withProgress(o,fn){return fn({}, {onCancellationRequested(){return {dispose(){}}}})},showErrorMessage(){}},workspace:{}}" };
      if (args.path === 'android') return { loader: 'js', contents: "const s=globalThis.__nativeResolutionState; module.exports={async getPackageNameFromApk(apk,root){s.calls.push(['apk',apk,root]);if(s.error)throw s.error;return 'com.example.apk';},async forwardJdwpPort(d,p){s.calls.push(['forward',d,p]);return '123';},async removeTcpForward(d,p){s.calls.push(['remove',d,p]);return 'removed';},async getProcessList(d,p){s.calls.push(['processList',d,p]);if(s.error)throw s.error;return s.processList;},async getProcessInfo(d,p){s.calls.push(['process',p]);if(s.error)throw s.error;return s.processInfo;},async getInstalledPackages(){s.calls.push(['packages']);if(s.error)throw s.error;return s.installed;},async getInstalledAppAbi(d,p){s.calls.push(['primary',p]);if(s.error)throw s.error;return s.installedAbi;},async getDeviceAbiList(){s.calls.push(['deviceAbi']);if(s.error)throw s.error;return s.deviceAbis;}}" };
      if (args.path.includes('logger')) return { loader: 'js', contents: "module.exports={logger:{log(){}}}" };
      if (args.path.includes('targetPicker')) return { loader: 'js', contents: "module.exports={getCurrentOrPickTarget:async()=>({udid:'serial'})}" };
      return { loader: 'js', contents: "module.exports={}" };
    });
  }}] });
  const module = { exports: {} };
  vm.runInNewContext(result.outputFiles[0].text, { module, exports: module.exports, require, console, globalThis, AggregateError });
  return { api: module.exports, state };
}

test('known package and primary ABI avoid package/ABI quickpicks', async () => {
  const loaded = await loadTargetCommand();
  loaded.state.installedAbi = 'armeabi-v7a';
  loaded.api.setAbiResolutionInfo(undefined, ['armeabi-v7a', 'arm64-v8a'], {});
  assert.equal(await loaded.api.resolvePackageName({device:{}, packageName:'com.example.app'}), 'com.example.app');
  assert.equal(await loaded.api.getBestAbi({device:{}, packageName:'com.example.app'}), 'armeabi-v7a');
  assert.equal(JSON.stringify(loaded.state.calls), JSON.stringify([['primary','com.example.app']]));
});

test('missing launch package uses installed package picker once', async () => {
  const loaded = await loadTargetCommand(); loaded.state.quickPicks.push({label:'com.example.app'});
  assert.equal(await loaded.api.resolvePackageName({device:{}}), 'com.example.app');
  assert.equal(JSON.stringify(loaded.state.calls), JSON.stringify([['packages'], ['quickPick',['com.example.app']]]));
});

test('cancelled package picker returns undefined and no ABI query', async () => {
  const loaded = await loadTargetCommand(); loaded.state.quickPicks.push(undefined);
  assert.equal(await loaded.api.resolvePackageName({device:{}}), undefined);
  assert.equal(JSON.stringify(loaded.state.calls), JSON.stringify([['packages'], ['quickPick',['com.example.app']]]));
});

test('shared UID ambiguity presents PID candidates instead of selecting first', async () => {
  const loaded = await loadTargetCommand(); loaded.state.processInfo = {name:'com.shared:worker', packages:['com.shared.one','com.shared.two']}; loaded.state.quickPicks.push({label:'com.shared.two'});
  assert.equal(await loaded.api.resolvePackageName({device:{}, pid:'42'}), 'com.shared.two');
  assert.equal(JSON.stringify(loaded.state.calls), JSON.stringify([['process','42'], ['quickPick',['com.shared.one','com.shared.two']]]));
});

test('Android remote process base package avoids picker', async () => {
  const loaded = await loadTargetCommand(); loaded.state.processInfo = {name:'com.shared.one:remote', packages:['com.shared.one','com.shared.two']};
  assert.equal(await loaded.api.resolvePackageName({device:{}, pid:'43'}), 'com.shared.one');
  assert.equal(JSON.stringify(loaded.state.calls), JSON.stringify([['process','43']]));
});

test('device ABI query errors propagate without package picker', async () => {
  const loaded = await loadTargetCommand(); loaded.state.error = new Error('adb offline');
  await assert.rejects(() => loaded.api.resolvePackageName({device:{}}), /adb offline/);
  assert.equal(JSON.stringify(loaded.state.calls), JSON.stringify([['packages']]));
});

test('empty device ABI uses unique app candidate automatically', async () => {
  const loaded = await loadTargetCommand(); loaded.state.installedAbi = undefined; loaded.state.deviceAbis = []; loaded.api.setAbiResolutionInfo(undefined, ['armeabi-v7a'], {});
  assert.equal(await loaded.api.getBestAbi({device:{}, packageName:'com.example.app'}), 'armeabi-v7a');
});

test('empty device ABI with multiple app candidates uses ABI picker', async () => {
  const loaded = await loadTargetCommand(); loaded.state.installedAbi = undefined; loaded.state.deviceAbis = []; loaded.api.setAbiResolutionInfo(undefined, ['armeabi-v7a','arm64-v8a'], {}); loaded.state.quickPicks.push({label:'arm64-v8a'});
  assert.equal(await loaded.api.getBestAbi({device:{}, packageName:'com.example.app'}), 'arm64-v8a');
});

test('unsupported ABI intersection is an explicit error', async () => {
  const loaded = await loadTargetCommand(); loaded.state.installedAbi = undefined; loaded.state.deviceAbis = ['arm64-v8a']; loaded.api.setAbiResolutionInfo(undefined, ['x86'], {});
  await assert.rejects(() => loaded.api.getBestAbi({device:{}, packageName:'com.example.app'}), /appropriate ABI/);
});

/** 通过生产命令入口断言进程排序、取消和错误，不替换pickAndroidProcess。 */
test('process picker preserves package ordering PID mapping cancellation and query errors', async () => {
  const {api, state} = await loadTargetCommand();
  const device = {udid:'serial', androidProjectRoot:'root'};
  state.processList = [{pid:'3',name:'a.other',packages:[]},{pid:'9',name:'z.app',packages:['com.example.app']}];
  api.setProcessPickerInfo('com.example.app'); state.quickPicks.push({pid:'9'});
  assert.equal(await api.pickAndroidProcess({device}), '9');
  assert.equal(JSON.stringify(state.calls), JSON.stringify([['processList',device,true],['quickPick',['z.app','a.other']]]));
  state.calls.length = 0; api.resetProcessPickerInfo();
  assert.equal(await api.pickAndroidProcess({device}), undefined);
  assert.equal(JSON.stringify(state.calls), JSON.stringify([['processList',device,false],['quickPick',['a.other','z.app']]]));
  state.calls.length = 0; state.error = new Error('process transport closed');
  await assert.rejects(api.pickAndroidProcess({device}), error => error === state.error);
  assert.equal(JSON.stringify(state.calls), JSON.stringify([['processList',device,false]]));
});


test('explicit ABI override mapping reset and invalid values preserve query boundaries', async () => {
  const {api,state} = await loadTargetCommand();
  api.setAbiResolutionInfo('x86', ['arm64-v8a'], {x86:'i386'});
  assert.equal(await api.getBestMappedAbi({device:{}}), 'i386'); assert.equal(state.calls.length, 0);
  api.setAbiResolutionInfo('bad-abi'); await assert.rejects(api.getBestAbi({device:{}}), /Invalid Android ABI/); assert.equal(state.calls.length, 0);
  api.resetAbiResolutionInfo(); state.installedAbi = 'armeabi-v7a';
  assert.equal(await api.getBestMappedAbi({device:{},packageName:'com.example.app'}), 'armeabi-v7a');
  assert.equal(JSON.stringify(state.calls), JSON.stringify([['primary','com.example.app']]));
});

test('ABI query failures and installed incompatibility never open fallback pickers', async () => {
  const {api,state} = await loadTargetCommand(); state.error = new Error('ABI transport closed');
  await assert.rejects(api.getBestAbi({device:{},packageName:'com.example.app'}), error => error === state.error);
  assert.equal(JSON.stringify(state.calls), JSON.stringify([['primary','com.example.app']]));
  state.calls.length = 0;
  await assert.rejects(api.getBestAbi({device:{}}), error => error === state.error);
  assert.equal(JSON.stringify(state.calls), JSON.stringify([['deviceAbi']]));
  state.error = undefined; state.calls.length = 0; state.installedAbi = 'armeabi-v7a'; api.setAbiResolutionInfo(undefined,['arm64-v8a']);
  await assert.rejects(api.getBestAbi({device:{},packageName:'com.example.app'}), /not supported/);
  assert.equal(JSON.stringify(state.calls), JSON.stringify([['primary','com.example.app']]));
});

test('ambiguous ABI cancellation returns undefined without choosing first device ABI', async () => {
  const {api,state} = await loadTargetCommand(); api.setAbiResolutionInfo('select');
  assert.equal(await api.getBestAbi({device:{},packageName:'com.example.app'}), undefined);
  assert.equal(JSON.stringify(state.calls), JSON.stringify([['primary','com.example.app'],['deviceAbi'],['quickPick',['arm64-v8a','armeabi-v7a']]]));
});


/** 通过实际包装函数确认参数、当前设备回退和错误传播。 */
test('command wrappers preserve APK root PID ownership current device and forwarding', async () => {
  const {api,state}=await loadTargetCommand();
  assert.equal(await api.getPackageNameFromApk('app.apk','project'),'com.example.apk');
  assert.equal(await api.getPackageNameForPid({device:{udid:'serial'},pid:'42'}),'com.example.app');
  assert.equal(await api.resolvePackageName({packageName:'com.explicit'}),'com.explicit');
  assert.equal(api.forwardJdwpPort, undefined);
  assert.equal(api.removeTcpForward, undefined);
  assert.equal(JSON.stringify(state.calls),JSON.stringify([['apk','app.apk','project'],['process','42']]));
  state.error=new Error('APK failed'); await assert.rejects(api.getPackageNameFromApk('bad.apk','project'),error=>error===state.error);
});
