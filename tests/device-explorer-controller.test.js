const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { transformSync } = require('esbuild');

const source = fs.readFileSync(path.join(__dirname, '../src/deviceExplorer.ts'), 'utf8');
const debuggerSource = fs.readFileSync(path.join(__dirname, '../src/android-debugger/index.ts'), 'utf8');

/** 功能点：Device Explorer控制器的消息作用域与资源归属，含调试启动交接回归。
 * 受影响对象：DeviceExplorerController、ProcessesController、startAndroidDebugging、startup登记及宿主会话监听。
 * 复现路径：Node>=22，加载真实控制器、临时文件目录与内存设备边界，进入Files/Processes并发送消息；调试边界独立登记start与termination。
 * 测试范围：既有文件/进程/取消回归及三模式Attach、拒绝、配置选择期间失效和宿主监听清理。
 * 执行入口：node --test tests/device-explorer-controller.test.js；完整入口npm test。
 * 预期结果：消息仅作用于拥有的资源，调试会话携带唯一ID，stop只终止精确对象，全部监听在关闭时释放。
 * 判据：快照、字节、错误、调用顺序与监听集合全部符合各用例断言，不使用真实设备。
 */
// 功能：加载真实控制器与可记录后端；输入文件/进程/选择边界；输出临时目录、宿主集合监听及可等待关闭入口，供本文件用例使用。
async function fixture(options = {}) {
  const temp = await fsp.mkdtemp(path.join(os.tmpdir(), 'device-explorer-controller-test-'));
  const posts = [], calls = [], updates = [], debugStarts = new Set(), debugEnds = new Set();
  let stopCount = 0, debugSequence = 0;
  const config = { filter: false, downloadDirectory: temp, launch: [], debuggerExtensions: [] };
  const files = {
    serial: 'phone',
    async stat(remote) { calls.push(['stat', remote]); if (options.permission?.includes(remote)) throw new Error('Permission denied'); if (options.statError?.includes(remote)) throw new Error('adb unavailable'); return { path: remote, name: path.posix.basename(remote) || '/', kind: remote.endsWith('/') ? 'directory' : 'file', permissions: '644', size: 0, modified: 0 }; },
    async list(remote, signal) { calls.push(['list', remote, this.runAs]); if (options.listUnavailable?.includes(remote)) throw new Error('adb unavailable'); if (options.listPermission?.includes(remote) && !this.runAs) throw new Error('Permission denied'); if (options.listError?.includes(remote)) throw new Error('Permission denied'); if(options.directoryEntries)return options.directoryEntries(remote, signal); return [{ path: remote + (remote === '/' ? '' : '/') + 'child.txt', name: 'child.txt', kind: 'file', permissions: '644', size: 3, modified: 0 }]; },
    async listPackages() { calls.push(['packages']); return ['com.example.app', 'com.example.other']; },
    async create(remote, directory, signal) { calls.push(['create', remote, directory]); await options.create?.(remote, directory, signal); },
    async remove(remote) { calls.push(['remove', remote]); await options.remove?.(remote); },
    async push(local, remote, transfer) { calls.push(['push', local, remote]); await options.push?.(local, remote, transfer); await fsp.copyFile(local, path.join(temp, path.posix.basename(remote))); },
    async pull(remote, local, transfer) { calls.push(['pull', remote, local]); await options.pull?.(remote, local, transfer); await fsp.writeFile(local, 'downloaded'); },
  };
  const processState = { rows: [], async watch(onUpdate, onError) { calls.push(['watch']); processState.onUpdate = onUpdate; processState.onError = onError; return async () => { stopCount++; calls.push(['stopWatch']); }; }, async kill(pid) { calls.push(['kill', pid]); }, async forceStop(pkg, uid) { calls.push(['forceStop', pkg, uid]); }, async clearData(pkg, uid) { calls.push(['clearData', pkg, uid]); }, async uninstall(pkg) { calls.push(['uninstall', pkg]); } };
  const vscode = {
    extensions: { all: config.debuggerExtensions },
    workspace: { isTrusted: true, workspaceFolders: [{ name: 'selected-workspace', uri: { fsPath: temp } }], fs: { readFile: async uri => options.workspaceFiles && Object.hasOwn(options.workspaceFiles, uri.path) ? Buffer.from(options.workspaceFiles[uri.path]) : fsp.readFile(uri.fsPath) }, findFiles: async pattern => { options.onFindFiles?.(pattern); return pattern === '**/{output-metadata.json,build.gradle,build.gradle.kts}' ? Object.keys(options.workspaceFiles || {}).map(p => vscode.Uri.file(p)) : []; }, getConfiguration: section => { assert.ok(section === 'android-ide' || section === 'launch'); return ({ get: (key, fallback) => { if (section === 'launch') return config.launch; assert.equal(key, 'explorer.packageFilter', 'Local paths must not be read from VSCode settings'); return config.filter; }, update: async (key, value) => { if (key === 'explorer.packageFilter') config.filter = value; } }); } },
    ConfigurationTarget: { Global: 1 },
    Uri: { file: p => ({ scheme: 'file', fsPath: p, path: p }), parse: value => ({ scheme: value.split(':')[0], fsPath: (value.split('://')[1] || value), path: (value.split('://')[1] || value) }) },
    commands: { executeCommand: async (...args) => calls.push(['command', ...args]) },
    env: { clipboard: { writeText: async value => calls.push(['clipboard', value]) } },
    window: { showErrorMessage: async message => { calls.push(['errorNotification', message]); }, showInformationMessage: async message => { calls.push(['information', message]); }, showInputBox: async () => options.input, showWarningMessage: async (message, opts, ...items) => options.confirm === undefined ? items.at(-1) : options.confirm, showOpenDialog: async opts => options.openDialog === undefined ? [vscode.Uri.file(temp)] : options.openDialog, showQuickPick: async (list, settings) => { calls.push(['picker', Array.from(list), settings]); return options.quickPick ? options.quickPick(list, settings) : list[0]; } },
    debug: {
      // 功能：登记start监听；输入真实入口监听器；输出集合中的精确注销操作，覆盖并发订阅而非单槽覆盖。
      onDidStartDebugSession(listener) { debugStarts.add(listener); return { dispose: () => debugStarts.delete(listener) }; },
      // 功能：登记termination监听；输入真实入口监听器；输出精确注销操作，供取消清理边界使用。
      onDidTerminateDebugSession(listener) { debugEnds.add(listener); return { dispose: () => debugEnds.delete(listener) }; },
      // 功能：接受或拒绝启动；输入宿主配置；输出唯一ID及集合start事件，不省略会话身份。
      async startDebugging(...args) {
        calls.push(['debug', ...args]);
        if (options.debugResult ?? true) {
          const session = { id: 'explorer-session-' + ++debugSequence, configuration: args[1] };
          for (const listener of [...debugStarts]) listener(session);
        }
        return options.debugResult ?? true;
      },
      // 功能：停止精确观察对象；输入会话；输出对应termination事件，不把任意会话视为已退出。
      async stopDebugging(session) { calls.push(['debugStop', session]); for (const listener of [...debugEnds]) listener(session); },
    },
  };
  const debuggerModule = { exports: {} };
  const startup = require('./debug-startup-loader.cjs')();
  vm.runInNewContext(transformSync(debuggerSource, { loader: 'ts', format: 'cjs' }).code, { module: debuggerModule, exports: debuggerModule.exports, AbortController, console, require: id => id === './startup' ? startup : id === 'vscode' ? vscode : id === './autoConfig' ? require('./auto-config-loader.cjs')() : require(id), Promise });
  const deps = { vscode, './projectLocalConfig': { readProjectLocalConfig: function() { return { downloadDirectory: config.downloadDirectory }; } }, './android-debugger': debuggerModule.exports, './deviceExplorerFiles': { DeviceExplorerFiles: class { constructor(serial,access) { Object.assign(this, files); this.runAs=access?.runAs; } } }, './deviceExplorerProcesses': { DeviceExplorerProcesses: class { constructor() { Object.assign(this, processState); } } } };
  const processesModule = { exports: {} };
  vm.runInNewContext(transformSync(fs.readFileSync(path.join(__dirname, '../src/processes.ts'), 'utf8'), { loader: 'ts', format: 'cjs' }).code, { module: processesModule, exports: processesModule.exports, require: id => Object.hasOwn(deps, id) ? deps[id] : require(id), Buffer, process, AbortController, Promise });
  deps['./processes'] = processesModule.exports;
  const module = { exports: {} };
  vm.runInNewContext(transformSync(source, { loader: 'ts', format: 'cjs' }).code, { module, exports: module.exports, require: id => Object.hasOwn(deps, id) ? deps[id] : require(id), Buffer, console, process, AbortController, Promise, Set, Map, URL, URLSearchParams, setTimeout, clearTimeout });
  const Controller = module.exports.DeviceExplorerController;
  const resolveDebugProject = Object.hasOwn(options, 'resolveDebugProject') ? options.resolveDebugProject : async (packageName, workspaceRoot, signal) => { calls.push(['debugProject', packageName, workspaceRoot, signal]); return { androidProjectRoot: temp, androidModuleRoot: path.join(temp, 'app'), androidVariant: 'debug', androidSourceRoots: [path.join(temp, 'generated-sources')], ...(options.nativeModules !== undefined ? { androidNativeModules: options.nativeModules } : {}) }; };
  const controller = new Controller(message => { posts.push(message); options.onPost?.(message, controller); }, Object.hasOwn(options, 'currentApplicationId') ? options.currentApplicationId : () => 'com.example.app', resolveDebugProject);
  return { controller, posts, calls, processState, config, temp, vscode, get stopCount() { return stopCount; }, async close() { await controller.dispose(); await fsp.rm(temp, { recursive: true, force: true }); assert.equal(debugStarts.size, 0, 'start监听泄漏'); assert.equal(debugEnds.size, 0, 'termination监听泄漏'); } };
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
    assert.equal(f.posts.findLast(m => m.type !== 'explorerLoading').serial, undefined);
  } finally { await f.close(); }
});

// Node>=22控制并发目录读取及取消，断言ready重放获取态、全部结束才隐藏，失活后无旧消息且切设备归属正确。
test('Explorer loading follows concurrent reads errors ready and cancellation', async () => {
  const pending = new Map();
  const f = await fixture({ directoryEntries: (remote, signal) => remote === '/' ? [] : new Promise((resolve, reject) => {
    const abort = () => { pending.delete(remote); reject(signal.reason); };
    signal.addEventListener('abort', abort, { once: true });
    pending.set(remote, { resolve: () => { signal.removeEventListener('abort', abort); pending.delete(remote); resolve([]); }, reject: () => { signal.removeEventListener('abort', abort); pending.delete(remote); reject(new Error('read failed')); } });
  }) });
  const loading = () => f.posts.filter(m => m.type === 'explorerLoading');
  try {
    await f.controller.setContext('phone', true); await Promise.all([...f.controller.scope.tasks]);
    assert.equal(loading().at(-1).fetching, false);
    const first = f.controller.handle({ type: 'explorer', action: 'list', path: '/one' });
    const second = f.controller.handle({ type: 'explorer', action: 'list', path: '/two' });
    assert.equal(loading().at(-1).fetching, true);
    await f.controller.handle({ type: 'explorer', action: 'ready' });
    assert.equal(f.posts.findLast(m => m.type === 'explorerState').fetching, true);
    pending.get('/one').resolve(); await first; assert.equal(loading().at(-1).fetching, true);
    pending.get('/two').reject(); await second; assert.equal(loading().at(-1).fetching, false);
    assert.match(f.posts.findLast(m => m.type === 'explorerProgress').error, /read failed/);
    const cancelled = f.controller.handle({ type: 'explorer', action: 'list', path: '/cancel' });
    assert.equal(loading().at(-1).fetching, true);
    const count = loading().length; await f.controller.setContext('phone', false); await cancelled;
    assert.equal(pending.size, 0); assert.equal(loading().length, count);
    assert.equal(f.posts.findLast(m => m.type === 'explorerState').fetching, false);
    assert.equal(f.posts.findLast(m => m.type === 'explorerState').active, false);
    await f.controller.setContext('other', true); await Promise.all([...f.controller.scope.tasks]);
    assert.equal(loading().at(-1).serial, 'other'); assert.equal(loading().at(-1).fetching, false);
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
    assert.match(f.posts.findLast(m => m.type !== 'explorerLoading').error, /adb unavailable/); assert.equal(f.posts.findLast(m => m.type !== 'explorerLoading').path, '/broken');
    await f.controller.handle({ type: 'explorer', action: 'copyPath', paths: ['/ok', '/../escape'] });
    assert.match(f.posts.findLast(m => m.type !== 'explorerLoading').error, /Invalid device path/);
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
    assert.match(f.posts.findLast(m => m.type !== 'explorerLoading').error, /Select a file/);
  } finally { await f.close(); }
});

// 前端解析后的父目录进入真实execute/create/list链；文件与目录类型不混淆且名称穿越仍被拒绝。
test('new file and directory commands use the resolved parent and refresh it',async()=>{
  for(const action of ['newFile','newDirectory']){const f=await fixture({input:'new item'});try{await f.controller.setContext('phone',true);await Promise.all([...f.controller.scope.tasks]);await f.controller.handle({type:'explorer',action,parent:'/dest/'});assert.deepEqual(f.calls.find(c=>c[0]==='create'),['create','/dest/new item',action==='newDirectory']);assert.ok(f.calls.some(c=>c[0]==='list'&&c[1]==='/dest/'));}finally{await f.close();}}
  const f=await fixture({input:'../escape'});try{await f.controller.setContext('phone',true);await Promise.all([...f.controller.scope.tasks]);await f.controller.handle({type:'explorer',action:'newFile',parent:'/dest/'});assert.match(f.posts.findLast(m => m.type !== 'explorerLoading').error,/Invalid file name/);assert.equal(f.calls.some(c=>c[0]==='create'),false);}finally{await f.close();}
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
    assert.match(f.posts.findLast(m => m.type !== 'explorerLoading').error, /relative path/);
    await f.controller.handle({ type: 'explorer', serial: 'phone', action: 'uploadBegin', transferId: 't3', target: '/', relativePath: 'x', size: 2 });
    await f.controller.handle({ type: 'explorer', serial: 'phone', action: 'uploadBegin', transferId: 't3', target: '/', relativePath: 'y', size: 1 });
    assert.match(f.posts.findLast(m => m.type !== 'explorerLoading').error, /already exists/);
    await f.controller.handle({ type: 'explorer', serial: 'phone', action: 'uploadEnd', transferId: 't3' });
    assert.match(f.posts.findLast(m => m.type !== 'explorerLoading').error, /not open/);
    assert.equal(f.controller.scope.uploads.has('t3'), false);
    await f.controller.handle({ type: 'explorer', serial: 'phone', action: 'uploadBegin', transferId: 'size-mismatch', target: '/', relativePath: 'mismatch.bin', size: 5 });
    await f.controller.handle({ type: 'explorer', serial: 'phone', action: 'uploadEnd', transferId: 'size-mismatch' });
    assert.match(f.posts.findLast(m => m.type !== 'explorerLoading').error, /size does not match/);
  } finally { await f.close(); }
});

// 目录分块协议使用已有所有者校验，ACK等待create和父目录刷新；不创建临时文件且拒绝穿越/旧设备。
test('directory upload ACK waits for creation and refresh without staging file resources',async()=>{
  let release,entered;const ready=new Promise(resolve=>{entered=resolve;}),gate=new Promise(resolve=>{release=resolve;});const f=await fixture({create:async()=>{entered();await gate;}});
  try{await f.controller.setContext('phone',true);await Promise.all([...f.controller.scope.tasks]);const message={type:'explorer',serial:'phone',action:'uploadBegin',transferId:'directory',target:'/dest',relativePath:'empty',directory:true};
    const task=f.controller.handle(message);await ready;assert.equal(f.posts.some(m=>m.type==='explorerUploadAck'&&m.transferId==='directory'),false);release();await task;
    const ack=f.posts.findLast(m=>m.type==='explorerUploadAck');assert.equal(ack.transferId,'directory');assert.equal(ack.error,undefined);assert.deepEqual(f.calls.find(c=>c[0]==='create'),['create','/dest/empty',true]);assert.ok(f.calls.some(c=>c[0]==='list'&&c[1]==='/dest'));assert.equal(f.controller.scope.uploads.size,0);assert.equal(f.calls.some(c=>c[0]==='push'),false);
    await f.controller.handle({...message,transferId:'unsafe',relativePath:'../outside'});assert.match(f.posts.findLast(m => m.type !== 'explorerLoading').error,/relative path/);await f.controller.handle({...message,transferId:'other',serial:'other'});assert.match(f.posts.findLast(m => m.type !== 'explorerLoading').error,/context changed/);assert.equal(f.calls.filter(c=>c[0]==='create').length,1);
  }finally{release();await f.close();}
});
// 已存在/权限拒绝等create错误必须原样回ACK，不能继续上传或宣称目录完成。
test('directory upload reports create failures instead of false completion',async()=>{
  const f=await fixture({create:async()=>{throw new Error('directory already exists');}});try{await f.controller.setContext('phone',true);await Promise.all([...f.controller.scope.tasks]);await f.controller.handle({type:'explorer',serial:'phone',action:'uploadBegin',transferId:'failed-directory',target:'/dest',relativePath:'empty',directory:true});assert.match(f.posts.findLast(m => m.type !== 'explorerLoading').error,/directory already exists/);assert.equal(f.posts.some(m=>m.message==='Directory uploaded'),false);assert.equal(f.controller.scope.uploads.size,0);}finally{await f.close();}
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
    assert.match(f.posts.findLast(m => m.type !== 'explorerLoading').error, /no longer available/);
  } finally { await f.close(); }
});

/** Processes只展示Native/Java/Dual Attach，所有模式均直接转发设备身份且零AGP模型。 */
test('Android process attaches all three modes without project models or installation', async () => {
  for (const mode of ['native', 'java', 'dual']) {
    const f = await fixture({ quickPick: items => items.find(item => item.config?.mode === mode), resolveDebugProject: async () => { throw new Error('Debug must not query Gradle'); } });
    try {
      await f.controller.setContext('phone', true, 'processes'); await Promise.all([...f.controller.scope.tasks]);
      f.processState.onUpdate([{ pid: 42, name: 'app', packageName: 'com.example.app', abi: 'arm64-v8a' }]);
      await f.controller.handle({ type: 'explorer', action: 'debug', pid: 42 });
      const config = f.calls.find(call => call[0] === 'debug')[2];
      assert.equal(config.type, 'android-debug'); assert.equal(config.mode, mode);
      assert.equal(config.request, 'attach'); assert.equal(config.pid, 42); assert.equal(config.processId, 42);
      assert.equal(config.serial, 'phone'); assert.equal(config.packageName, 'com.example.app');
      assert.equal(config.androidProjectRoot, f.temp); assert.equal(config.androidVariant, undefined);
      assert.equal(config.java?.sourcePaths, undefined);
      assert.equal(config.native?.abi, mode === 'java' ? undefined : 'arm64-v8a');
      assert.equal(f.calls.some(call => call[0] === 'debugProject'), false);
      assert.deepEqual(f.calls.find(call => call[0] === 'picker')[1].map(item => item.config.request), ['attach', 'attach', 'attach']);
      assert.equal(f.posts.some(message => message.error), false);
    } finally { await f.close(); }
  }
});

// 内置 Native Attach 直接传递真实设备/PID/package/workspace root/canonical ABI；不查询 Build project model。
test('Android attach built-in Native starts direct Run and Debug without project-model lookup', async () => {
  const f = await fixture({ quickPick: items => items.find(item => item.config?.mode === 'native') });
  try {
    await f.controller.setContext('phone', true, 'processes'); await Promise.all([...f.controller.scope.tasks]);
    f.processState.onUpdate([{ pid: 42, name: 'app', packageName: 'com.example.app', abi: 'armeabi-v7a' }]);
    await f.controller.handle({ type: 'explorer', action: 'debug', pid: 42, androidModuleRoot: '/forged', androidVariant: 'release' });
    const picker = f.calls.find(call => call[0] === 'picker');
    assert.deepEqual(picker[1].map(item => item.config.mode), ['native', 'java', 'dual']);
    assert.equal(f.calls.some(call => call[0] === 'debugProject'), false);
    const launched = f.calls.find(call => call[0] === 'debug')[2];
    assert.equal(launched.type, 'android-debug'); assert.equal(launched.request, 'attach');
    assert.equal(launched.mode, 'native'); assert.equal(launched.androidMode, undefined); assert.equal(launched.serial, 'phone');
    assert.equal(launched.pid, 42); assert.equal(launched.processId, 42); assert.equal(launched.packageName, 'com.example.app');
    assert.equal(launched.native.abi, 'armeabi-v7a');
    assert.equal(launched.androidProjectRoot, f.temp);
    assert.equal(launched.androidModuleRoot, undefined); assert.equal(launched.androidVariant, undefined); assert.equal(launched.androidSourceRoots, undefined);
    const commandIndex = f.calls.findIndex(call => call[0] === 'command' && call[1] === 'workbench.view.debug');
    const debugIndex = f.calls.findIndex(call => call[0] === 'debug');
    assert.ok(debugIndex >= 0 && commandIndex > debugIndex);
    assert.equal(f.posts.some(message => message.error || message.message === 'Process action complete'), false);
  } finally { await f.close(); }
});

// 未知包名交真实PID的Native provider解析，UI位数标签不能当ABI。
test('Android attach forwards unknown package for device discovery and does not guess ABI display labels', async () => {
  const f = await fixture({ resolveDebugProject: async () => { throw new Error('unknown package must not query an unrelated model'); }, quickPick: items => items.find(item => item.config?.mode === 'native') });
  try {
    await f.controller.setContext('phone', true, 'processes'); await Promise.all([...f.controller.scope.tasks]);
    f.processState.onUpdate([{ pid: 42, name: 'unknown', abi: '64-bit (arm64)' }]);
    await f.controller.handle({ type: 'explorer', action: 'debug', pid: 42 });
    const config = f.calls.find(call => call[0] === 'debug')[2];
    assert.equal(config.pid, 42); assert.equal(config.serial, 'phone'); assert.equal(config.packageName, undefined); assert.equal(config.native.abi, undefined); assert.equal(config.androidProjectRoot, f.temp);
    assert.equal(f.calls.some(call => call[0] === 'debugProject'), false);
  } finally { await f.close(); }
});

// 内置Native Attach直接启动并忽略项目模型提供方；即使提供方缺失或失败，也不阻断真实会话。
test('Android attach Native skips project-model lookup and starts a direct session', async () => {
  const cases = [
    { resolveDebugProject: undefined },
    { resolveDebugProject: async () => { throw new Error('Gradle model must not be queried'); } },
  ];
  for (const options of cases) {
    const f = await fixture({ ...options, quickPick: items => items.find(item => item.config?.mode === 'native') });
    try {
      await f.controller.setContext('phone', true, 'processes'); await Promise.all([...f.controller.scope.tasks]);
      f.processState.onUpdate([{ pid: 42, name: 'app', packageName: 'com.example.app' }]);
      await f.controller.handle({ type: 'explorer', action: 'debug', pid: 42 });
      const launched = f.calls.find(call => call[0] === 'debug')[2];
      assert.equal(f.calls.some(call => call[0] === 'debugProject'), false);
      assert.equal(launched.type, 'android-debug'); assert.equal(launched.request, 'attach');
      assert.equal(launched.mode, 'native'); assert.equal(launched.androidMode, undefined); assert.equal(launched.serial, 'phone');
      assert.equal(launched.pid, 42); assert.equal(launched.processId, 42);
      assert.equal(launched.packageName, 'com.example.app'); assert.equal(launched.androidProjectRoot, f.temp);
      assert.equal(f.posts.some(message => message.error), false);
    } finally { await f.close(); }
  }
  const f = await fixture({ nativeModules: [], quickPick: items => items.find(item => item.config?.mode === 'native') });
  try {
    await f.controller.setContext('phone', true, 'processes'); await Promise.all([...f.controller.scope.tasks]);
    f.processState.onUpdate([{ pid: 42, name: 'app', packageName: 'com.example.app' }]);
    await f.controller.handle({ type: 'explorer', action: 'debug', pid: 42 });
    const launched = f.calls.find(call => call[0] === 'debug')[2];
    assert.equal(f.calls.some(call => call[0] === 'debugProject'), false);
    assert.equal(launched.mode, 'native'); assert.equal(launched.androidMode, undefined); assert.equal(launched.androidProjectRoot, f.temp);
    assert.equal(launched.androidNativeModules, undefined);
  } finally { await f.close(); }
});

// 配置选择仍是异步取消边界：选取期间PID消失、作用域取消或关闭选择，不得继续提示、查询模型或启动过期PID。
test('Attach revalidates process identity and cancellation after configuration selection', async () => {
  for (const outcome of ['process-gone', 'cancel-scope', 'cancel-picker']) {
    let entered, release;
    const started = new Promise(resolve => { entered = resolve; });
    const picked = new Promise(resolve => { release = resolve; });
    let selected;
    const f = await fixture({ quickPick: items => { selected = items[0]; entered(); return picked; } });
    try {
      await f.controller.setContext('phone', true, 'processes'); await Promise.all([...f.controller.scope.tasks]);
      f.processState.onUpdate([{ pid: 42, name: 'app', packageName: 'com.example.app' }]);
      const signal = f.controller.scope.controller.signal;
      const action = f.controller.handle({ type: 'explorer', action: 'debug', pid: 42 }); await started;
      if (outcome === 'cancel-scope') f.controller.scope.controller.abort();
      if (outcome === 'process-gone') f.processState.onUpdate([]);
      release(outcome === 'cancel-picker' ? undefined : selected); await action;
      assert.equal(f.calls.some(call => ['debug', 'debugProject', 'information'].includes(call[0])), false);
      if (outcome === 'process-gone') assert.match(f.posts.findLast(m => m.type !== 'explorerLoading').error, /no longer available/);
      if (outcome === 'cancel-scope') assert.equal(signal.aborted, true);
      if (outcome === 'cancel-picker') assert.equal(f.posts.some(message => message.error), false);
    } finally { release(); await f.close(); }
  }
});

// workspace选择也是异步边界，PID消失或操作取消后不能再弹调试配置选择或启动会话。
test('Attach revalidates row and operation signal after workspace selection', async () => {
  for (const outcome of ['gone', 'cancel']) {
    let enter, release; const entered = new Promise(resolve => { enter = resolve; });
    const pick = new Promise(resolve => { release = resolve; });
    const f = await fixture({ quickPick: () => { enter(); return pick; } });
    try {
      const folder = f.vscode.workspace.workspaceFolders[0];
      f.vscode.workspace.workspaceFolders.push({ name: 'other', uri: { fsPath: f.temp + '-other' } });
      await f.controller.setContext('phone', true, 'processes'); await Promise.all([...f.controller.scope.tasks]);
      f.processState.onUpdate([{ pid: 42, packageName: 'com.example.app' }]);
      const pending = f.controller.handle({ type: 'explorer', action: 'debug', pid: 42 }); await entered;
      if (outcome === 'gone') f.processState.onUpdate([]);
      else f.controller.scope.controller.abort();
      release({ folder }); await pending;
      assert.equal(f.calls.filter(call => call[0] === 'picker').length, 1);
      assert.equal(f.calls.some(call => call[0] === 'debug'), false);
      if (outcome === 'gone') assert.match(f.posts.findLast(m => m.type !== 'explorerLoading').error, /no longer available/);
    } finally { release(); await f.close(); }
  }
});

// Attach project：第三方配置原名和自有字段保留，不调用本扩展的项目模型提供方。
test('Attach project leaves external configurations and their project mapping untouched', async () => {
  const f = await fixture({ resolveDebugProject: async () => { throw new Error('Must not query external project'); }, quickPick: items => items.find(item => item.config?.type === 'external-debugger') });
  try {
    f.config.launch.push({ name: 'Original Custom Attach', type: 'external-debugger', request: 'attach', customField: 17 });
    await f.controller.setContext('phone', true, 'processes'); await Promise.all([...f.controller.scope.tasks]);
    f.processState.onUpdate([{ pid: 42, name: 'app', packageName: 'com.example.app' }]);
    await f.controller.handle({ type: 'explorer', action: 'debug', pid: 42 });
    const launched = f.calls.find(call => call[0] === 'debug')[2];
    assert.equal(launched.name, 'Original Custom Attach'); assert.equal(launched.customField, 17); assert.equal(launched.pid, 42);
    assert.equal(Object.hasOwn(launched, 'androidModuleRoot'), false); assert.equal(Object.hasOwn(launched, 'androidMode'), false);
  } finally { await f.close(); }
});

// Processes始终合并三个内置Attach和全部外部配置，选Launch仍绑定当前进程附加且原选项不变。
test('Processes includes external launch and attach configurations alongside built-in attaches', async () => {
  for (const scenario of ['launch-only', 'cancel', 'explicit']) {
    const f = await fixture({ quickPick: items => scenario === 'cancel' ? undefined : items.find(item => item.config.name === 'User config'), resolveDebugProject: async () => { throw new Error('No AGP lookup'); } });
    try {
      const selected = { name: 'User config', type: 'android-debug', request: scenario === 'launch-only' ? 'launch' : 'attach', mode: 'dual',
        packageName: 'com.user.explicit', apkPath: '/explicit.apk', androidProjectRoot: '/root', preLaunchTask: 'prepare',
        sourcePaths: ['top'], java: { type: 'android-jvm', sourcePaths: ['java'] }, native: { abi: 'x86', symbolSearchPaths: ['symbols'] } };
      f.config.launch.push(selected);
      await f.controller.setContext('phone', true, 'processes'); await Promise.all([...f.controller.scope.tasks]);
      f.processState.onUpdate([{ pid: 42, packageName: 'com.row.other', abi: 'arm64-v8a' }]);
      await f.controller.handle({ type: 'explorer', action: 'debug', pid: 42 });
      const debug = f.calls.find(call => call[0] === 'debug');
      const picker = f.calls.find(call => call[0] === 'picker');
      assert.equal(picker[1].length, 4); assert.equal(picker[1][3].config, selected);
      assert.deepEqual(picker[1].slice(0, 3).map(item => item.config.mode), ['native', 'java', 'dual']);
      if (scenario === 'cancel') { assert.equal(debug, undefined); assert.equal(f.posts.some(message => message.error), false); }
      else {
        const config = debug[2];
        assert.equal(config.packageName, selected.packageName); assert.equal(config.mode, 'dual'); assert.equal(config.request, 'attach');
        assert.equal(config.pid, 42); assert.equal(config.processId, 42);
        assert.equal(config.native.abi, 'x86'); assert.deepEqual(Array.from(config.java.sourcePaths), ['java']);
        assert.deepEqual(Array.from(config.sourcePaths), ['top']); assert.equal(config.preLaunchTask, 'prepare');
        assert.equal(config.apkPath, '/explicit.apk'); assert.equal(config.androidProjectRoot, '/root');
        assert.equal(selected.pid, undefined); assert.equal(selected.native.abi, 'x86');
        assert.equal(selected.request, scenario === 'launch-only' ? 'launch' : 'attach');
      }
      assert.equal(f.calls.some(call => call[0] === 'debugProject' || ['kill', 'forceStop'].includes(call[0])), false);
    } finally { await f.close(); }
  }
});

// 旧Android JVM外部配置也不自动AGP索引，用户sourcePaths必须保留，根目录提供默认扫描范围。
test('Processes Android JVM attach preserves sourcePaths without invoking the Build resolver', async () => {
  const f = await fixture({ quickPick: items => items.find(item => item.config?.name === 'JVM'), resolveDebugProject: async () => { throw new Error('No Gradle model'); } });
  try {
    f.config.launch.push({ name: 'JVM', type: 'android-jvm', request: 'attach', android: true, sourcePaths: ['user-source'] });
    await f.controller.setContext('phone', true, 'processes'); await Promise.all([...f.controller.scope.tasks]);
    f.processState.onUpdate([{ pid: 42, packageName: 'com.example.app' }]);
    await f.controller.handle({ type: 'explorer', action: 'debug', pid: 42 });
    const config = f.calls.find(call => call[0] === 'debug')[2];
    assert.deepEqual(Array.from(config.sourcePaths), ['user-source']); assert.equal(config.androidProjectRoot, f.temp);
    assert.equal(config.androidVariant, undefined); assert.equal(f.calls.some(call => call[0] === 'debugProject'), false);
  } finally { await f.close(); }
});

// 匹配注册也不等于会话成功，startDebugging=false须明确报错而非进程操作成功。
test('Android debugger refusal remains a visible error with registered support',async()=>{
  const f=await fixture({debugResult:false,quickPick:items=>items.find(item=>item.config?.type==='android')});try{f.config.launch.push({name:'Attach',type:'android',request:'attach'});f.config.debuggerExtensions.push({packageJSON:{contributes:{debuggers:[{type:'android'}]}}});await f.controller.setContext('phone',true,'processes');await Promise.all([...f.controller.scope.tasks]);f.processState.onUpdate([{pid:42,name:'app'}]);await f.controller.handle({type:'explorer',action:'debug',pid:42});assert.match(f.posts.findLast(m => m.type !== 'explorerLoading').error,/Android debug (?:adapter|session) did not start/);assert.equal(f.posts.some(m=>m.message==='Process action complete'),false);}finally{await f.close();}
});

// 同设备切换只取消活动操作并独立保留连接，Files重放缓存不重复读取；旧tab消息仍拒绝，精确60秒释放见view-idle。
test('independent Processes retains tracker while Files reuses its owned cache',async()=>{
  const f=await fixture();
  try{
    await f.controller.setContext('phone',true,'files');await Promise.all([...f.controller.scope.tasks]);assert.equal(f.calls.some(c=>c[0]==='watch'),false);
    f.calls.length=0;await f.controller.setContext('phone',true,'processes');await Promise.all([...f.controller.scope.tasks]);
    assert.equal(f.calls.filter(c=>c[0]==='watch').length,1);assert.equal(f.calls.some(c=>c[0]==='list'||c[0]==='stat'),false);
    const count=f.stopCount;await f.controller.setContext('phone',true,'processes');assert.equal(f.stopCount,count);
    await f.controller.handle({type:'explorer',action:'list',path:'/'});assert.match(f.posts.findLast(m => m.type !== 'explorerLoading').error,/files view is not active/);
    f.calls.length=0;await f.controller.setContext('phone',true,'files');await Promise.all([...f.controller.scope.tasks]);
    assert.equal(f.calls.some(c=>c[0]==='stopWatch'||c[0]==='list'),false);assert.equal(f.stopCount,count);assert.equal(f.controller.scopes.size,2);assert.equal(f.controller.scopes.get('processes').processes.connected,true);
    await f.controller.handle({type:'explorer',action:'tab',tab:'processes'});assert.match(f.posts.findLast(m => m.type !== 'explorerLoading').error,/Device Tools view controls/);
    await f.controller.handle({type:'explorer',action:'processes'});assert.match(f.posts.findLast(m => m.type !== 'explorerLoading').error,/Processes view is not active/);
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
    assert.equal(f.calls.some(c=>c[0]==='kill'),false);assert.match(f.posts.findLast(m => m.type !== 'explorerLoading').error,/no longer available/);
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
    assert.match(f.posts.findLast(m => m.type !== 'explorerLoading').error,/device context changed/);assert.equal(f.controller.scope.uploads.has('owned'),true);
    for(let i=0;i<2;i++)await f.controller.handle({type:'explorer',serial:'phone',action:'uploadAbort',transferId:'owned'});
    assert.equal(f.posts.findLast(m => m.type !== 'explorerLoading').error,undefined);assert.equal(f.posts.findLast(m => m.type !== 'explorerLoading').action,'uploadAbort');assert.equal(f.controller.scope.uploads.size,0);assert.equal(f.calls.some(c=>c[0]==='push'),false);
  }finally{await f.close();}
});

// 迟到的Files消息不能在同串号Processes作用域创建上传，拒绝后Files仍能正常使用。
test('upload commands cannot create resources in the Processes surface',async()=>{
  const f=await fixture();try{
    await f.controller.setContext('phone',true,'processes');await Promise.all([...f.controller.scope.tasks]);f.calls.length=0;
    await f.controller.handle({type:'explorer',serial:'phone',action:'uploadBegin',transferId:'stale',target:'/',relativePath:'x',size:0});
    assert.match(f.posts.findLast(m => m.type !== 'explorerLoading').error,/files view is not active/);assert.equal(f.controller.scope.uploads.size,0);assert.equal(f.calls.some(c=>c[0]==='stat'||c[0]==='create'),false);
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
    f.calls.length=0;await f.controller.handle({type:'explorer',action:'list',path:'/broken'});assert.match(f.posts.findLast(m => m.type !== 'explorerLoading').error,/adb unavailable/);assert.equal(f.calls.filter(c=>c[0]==='list').length,1);
  }finally{await f.close();}
});

// 构造定位链的真实父快照；空应用目录仍可定位，只有父快照声明存在的目录/目录链接才可下钻。
function applicationTree(packages = ['com.example.app']) {
  return remote => {
    const paths = remote === '/' ? ['/data'] : remote === '/data' ? ['/data/data'] : remote === '/data/data' ? packages.map(pkg => '/data/data/' + pkg) : [];
    return paths.map(p => ({ path: p, name: path.posix.basename(p), kind: p === '/data/data' ? 'link' : 'directory', directoryLink: p === '/data/data', permissions: '755', size: 0, modified: 0 }));
  };
}

// Node>=22 的 VM 与后端替身：使用Build provider唯一ID，断言祖先/目标查询顺序和最终reveal，不接受消息中的pkg/path。
test('locateApp reveals the selected Build application after listing every ancestor and target', async () => {
  const f = await fixture({ workspaceFiles: { '/app/output-metadata.json': JSON.stringify({ applicationId: 'com.example.app' }) }, directoryEntries: applicationTree() });
  try {
    await f.controller.setContext('phone', true); await Promise.all([...f.controller.scope.tasks]); f.calls.length = 0; f.posts.length = 0;
    await f.controller.handle({ type: 'explorer', action: 'locateApp', pkg: 'com.evil.app', path: '/sdcard' });
    assert.deepEqual(f.calls.filter(c => c[0] === 'list').map(c => c[1]), ['/', '/data', '/data/data', '/data/data/com.example.app']);
    assert.equal(f.calls.some(c => c[0] === 'stat' || c[0] === 'picker'), false);
    assert.deepEqual(f.posts.filter(m => m.type === 'explorerFiles').map(m => m.path), ['/', '/data', '/data/data', '/data/data/com.example.app']);
    assert.deepEqual(JSON.parse(JSON.stringify(f.posts.findLast(m => m.type !== 'explorerLoading'))), { type: 'explorerReveal', serial: 'phone', path: '/data/data/com.example.app' });
    assert.equal(f.controller.scope.writer, undefined);
  } finally { await f.close(); }
});

// 工作区含无关包和变体ID时仍只按Build当前选择定位；下一次点击取新选择，且不再次扫描、不弹QuickPick、不改变过滤器ID集合。
test('locateApp uses the current Build selection without scanning or picking', async () => {
  let selected = 'com.example.other', scans = 0;
  const f = await fixture({ currentApplicationId: () => selected, onFindFiles: () => { scans++; }, workspaceFiles: { '/app/build.gradle': 'applicationId "com.example.app"', '/other/output-metadata.json': '{"applicationId":"com.other.release"}' }, directoryEntries: applicationTree(['com.example.app', 'com.example.other']) });
  try {
    await f.controller.setContext('phone', true); await Promise.all([...f.controller.scope.tasks]);
    const initialScans = scans, filterIds = Array.from(f.controller.applicationIds);
    assert.ok(initialScans > 0); assert.deepEqual(filterIds, ['com.example.app', 'com.other.release']);
    for (const expected of ['com.example.other', 'com.example.app']) {
      selected = expected; f.calls.length = 0; f.posts.length = 0;
      await f.controller.handle({ type: 'explorer', action: 'locateApp', pkg: 'com.evil.app' });
      assert.deepEqual(f.calls.filter(c => c[0] === 'list').map(c => c[1]), ['/', '/data', '/data/data', '/data/data/' + expected]);
      assert.equal(f.posts.findLast(m => m.type !== 'explorerLoading').type, 'explorerReveal'); assert.equal(f.posts.findLast(m => m.type !== 'explorerLoading').path, '/data/data/' + expected);
      assert.equal(f.calls.some(c => c[0] === 'picker'), false); assert.equal(scans, initialScans);
      assert.deepEqual(Array.from(f.controller.applicationIds), filterIds);
    }
  } finally { await f.close(); }
});

// provider缺失/返回undefined时复用工作区字面ID及metadata候选；0项报错，1项直达，多项单选第二项或取消，取消零list/reveal。
test('locateApp fallback handles zero one and multiple workspace IDs with single selection and cancellation', async () => {
  for (const provider of [undefined, () => undefined]) for (const count of [0, 1, 2]) for (const cancel of count === 2 ? [false, true] : [false]) {
    let scans = 0;
    const workspaceFiles = count === 0 ? {} : { '/app/build.gradle': 'applicationId "com.example.app"', ...(count === 2 ? { '/other/output-metadata.json': '{"applicationId":"com.example.other"}' } : {}) };
    const f = await fixture({ currentApplicationId: provider, workspaceFiles, onFindFiles: () => { scans++; }, directoryEntries: applicationTree(['com.example.app', 'com.example.other']), quickPick: items => cancel ? undefined : items[1] });
    try {
      await f.controller.setContext('phone', true); await Promise.all([...f.controller.scope.tasks]);
      const before = scans; f.calls.length = 0; f.posts.length = 0;
      await f.controller.handle({ type: 'explorer', action: 'locateApp', pkg: 'com.evil.app', path: '/sdcard' });
      assert.equal(scans, before + 1);
      const picks = f.calls.filter(c => c[0] === 'picker'); assert.equal(picks.length, count === 2 ? 1 : 0);
      if (count === 2) { assert.deepEqual(picks[0][1], ['com.example.app', 'com.example.other']); assert.equal(picks[0][2].canPickMany, false); }
      if (!count || cancel) {
        assert.equal(f.calls.some(c => c[0] === 'list'), false); assert.equal(f.posts.some(m => m.type === 'explorerReveal'), false);
        if (!count) assert.match(f.posts.findLast(m => m.type !== 'explorerLoading').error, /No application ID found/);
        else assert.equal(f.posts.some(m => m.error), false);
      } else {
        const expected = count === 1 ? 'com.example.app' : 'com.example.other';
        assert.equal(f.posts.findLast(m => m.type !== 'explorerLoading').type, 'explorerReveal'); assert.equal(f.posts.findLast(m => m.type !== 'explorerLoading').path, '/data/data/' + expected);
        assert.deepEqual(f.calls.filter(c => c[0] === 'list').map(c => c[1]), ['/', '/data', '/data/data', '/data/data/' + expected]);
      }
      assert.equal(f.controller.scope.writer, undefined);
    } finally { await f.close(); }
  }
});

// fallback单选挂起时切设备/视图必须先取消旧signal；选择返回后零定位list/reveal，且等待期间writer仍拒绝另一写操作。
test('locateApp fallback picker respects scope cancellation and writer exclusion', async () => {
  for (const view of ['files', 'processes']) {
    let entered, release; const started = new Promise(resolve => { entered = resolve; }), picked = new Promise(resolve => { release = resolve; });
    const f = await fixture({ currentApplicationId: () => undefined, workspaceFiles: { '/app/build.gradle': 'applicationId "com.example.app" applicationId "com.example.other"' }, directoryEntries: applicationTree(), quickPick: () => { entered(); return picked; } });
    try {
      await f.controller.setContext('phone', true); await Promise.all([...f.controller.scope.tasks]); f.calls.length = 0; f.posts.length = 0;
      const locate = f.controller.handle({ type: 'explorer', action: 'locateApp' }); await started;
      assert.equal(f.calls.find(c => c[0] === 'picker')[2].canPickMany, false);
      await f.controller.handle({ type: 'explorer', action: 'newDirectory', parent: '/' });
      assert.match(f.posts.findLast(m => m.type !== 'explorerLoading').error, /already running/); assert.equal(f.calls.some(c => c[0] === 'create'), false);
      const old = f.controller.scope, aborted = new Promise(resolve => old.controller.signal.addEventListener('abort', resolve, { once: true }));
      const change = f.controller.setContext(view === 'files' ? 'other' : 'phone', true, view); await aborted;
      release('com.example.app'); await locate;
      assert.equal(f.calls.some(c => c[0] === 'list'), false); assert.equal(f.posts.some(m => m.type === 'explorerReveal'), false);
      await change; await Promise.all([...f.controller.scope.tasks]);
      assert.equal(f.posts.some(m => m.type === 'explorerReveal'), false);
    } finally { release(); await f.close(); }
  }
});

// 无provider且零候选明确失败；disposed/trust/坏JSON等真实provider故障与非法ID不得fallback，目录/ADB/run-as错误不伪造成功。
test('locateApp rejects unavailable selection invalid IDs missing directories non-directories and backend failures', async () => {
  const app = '/data/data/com.example.app', workspaceFiles = { '/app/output-metadata.json': '{"applicationId":"com.example.app"}' };
  const scenarios = [
    [{ currentApplicationId: undefined }, /No application ID found/],
    [{ workspaceFiles, currentApplicationId: () => { throw new Error('Android build controller is disposed'); } }, /disposed/],
    [{ workspaceFiles, currentApplicationId: () => { throw new Error('Workspace is not trusted'); } }, /not trusted/],
    [{ workspaceFiles, currentApplicationId: () => { throw new SyntaxError('Invalid JSON metadata'); } }, /Invalid JSON metadata/],
    [{ currentApplicationId: () => '../evil' }, /Invalid current application ID/],
    [{ workspaceFiles, directoryEntries: applicationTree([]) }, /missing or not a directory: \/data\/data\/com.example.app/],
    [{ workspaceFiles, directoryEntries: remote => remote === '/' ? [{ path: '/data', kind: 'file' }] : [] }, /missing or not a directory: \/data/],
    [{ workspaceFiles, directoryEntries: applicationTree(), listUnavailable: ['/data'] }, /adb unavailable/],
    [{ workspaceFiles, directoryEntries: applicationTree(), listError: [app] }, /Permission denied/],
  ];
  for (const [options, error] of scenarios) {
    const f = await fixture(options);
    try {
      await f.controller.setContext('phone', true); await Promise.all([...f.controller.scope.tasks]); f.posts.length = 0;
      await f.controller.handle({ type: 'explorer', action: 'locateApp' });
      assert.match(f.posts.findLast(m => m.type !== 'explorerLoading').error, error);
      assert.equal(f.posts.some(m => m.type === 'explorerReveal'), false);
    } finally { await f.close(); }
  }
});

// 父目录仅权限拒绝时复用虚拟入口，目标仅权限拒绝时run-as；空目标目录是合法成功结果。
test('locateApp reuses virtual parents and run-as without masking permission errors', async () => {
  const app = '/data/data/com.example.app';
  const f = await fixture({ workspaceFiles: { '/app/output-metadata.json': '{"applicationId":"com.example.app"}' }, directoryEntries: applicationTree(), listPermission: [app], listError: ['/data', '/data/data'] });
  try {
    await f.controller.setContext('phone', true); await Promise.all([...f.controller.scope.tasks]); f.calls.length = 0;
    await f.controller.handle({ type: 'explorer', action: 'locateApp' });
    assert.deepEqual(f.calls.filter(c => c[0] === 'list'), [['list', '/', undefined], ['list', '/data', undefined], ['list', '/data/data', undefined], ['list', app, undefined], ['list', app, 'com.example.app']]);
    assert.equal(f.calls.filter(c => c[0] === 'packages').length, 1);
    assert.equal(f.posts.findLast(m => m.type !== 'explorerLoading').type, 'explorerReveal');
    assert.equal(f.posts.findLast(m => m.type !== 'explorerLoading').path, app);
  } finally { await f.close(); }
});

// 目录读取挂起时切设备/视图先取消旧signal；释放读取后不继续目录链或投递旧定位，writer阻止另一写操作，且无QuickPick。
test('locateApp pending directory read respects scope cancellation and existing writer exclusion', async () => {
  for (const view of ['files', 'processes']) {
    let entered, release; const started = new Promise(resolve => { entered = resolve; }), pendingRead = new Promise(resolve => { release = resolve; });
    const tree = applicationTree();
    const f = await fixture({ directoryEntries: async remote => { if (remote === '/data') { entered(); await pendingRead; } return tree(remote); } });
    try {
      await f.controller.setContext('phone', true); await Promise.all([...f.controller.scope.tasks]); f.calls.length = 0; f.posts.length = 0;
      const locate = f.controller.handle({ type: 'explorer', action: 'locateApp' }); await started;
      await f.controller.handle({ type: 'explorer', action: 'newDirectory', parent: '/' });
      assert.match(f.posts.findLast(m => m.type !== 'explorerLoading').error, /already running/);
      assert.equal(f.calls.some(c => c[0] === 'create'), false);
      const old = f.controller.scope, aborted = new Promise(resolve => old.controller.signal.addEventListener('abort', resolve, { once: true }));
      const change = f.controller.setContext(view === 'files' ? 'other' : 'phone', true, view); await aborted;
      const before = f.calls.filter(c => c[0] === 'list').length; release(); await locate;
      assert.equal(f.calls.some(c => c[0] === 'picker'), false);
      assert.equal(f.calls.filter(c => c[0] === 'list').length, before);
      assert.equal(f.posts.some(m => m.type === 'explorerReveal'), false);
      await change; await Promise.all([...f.controller.scope.tasks]);
      assert.equal(f.posts.some(m => m.type === 'explorerReveal'), false);
    } finally { release(); await f.close(); }
  }
});

// 初始自动刷新是独立读取：阻塞第一次根list后定位仍能执行，不通过扩大串行化规避并发。
test('locateApp works while the initial automatic refresh is pending', async () => {
  let entered, release, rootReads = 0; const started = new Promise(resolve => { entered = resolve; }), firstRoot = new Promise(resolve => { release = resolve; }), tree = applicationTree();
  const f = await fixture({ workspaceFiles: { '/app/output-metadata.json': '{"applicationId":"com.example.app"}' }, directoryEntries: async remote => { if (remote === '/' && ++rootReads === 1) { entered(); await firstRoot; } return tree(remote); } });
  try {
    await f.controller.setContext('phone', true); await started;
    assert.equal(f.controller.scope.writer, undefined);
    await f.controller.handle({ type: 'explorer', action: 'locateApp' });
    assert.equal(f.posts.findLast(m => m.type !== 'explorerLoading').type, 'explorerReveal');
    assert.equal(f.posts.findLast(m => m.type !== 'explorerLoading').path, '/data/data/com.example.app');
    assert.deepEqual(f.calls.filter(c => c[0] === 'list').map(c => c[1]), ['/', '/', '/data', '/data/data', '/data/data/com.example.app']);
    release(); await Promise.all([...f.controller.scope.tasks]);
    assert.equal(f.posts.filter(m => m.type === 'explorerReveal').length, 1);
    assert.equal(f.controller.scope.directories.has('/data/data/com.example.app'), true);
  } finally { release(); await f.close(); }
});

// 迟到的Files工具栏消息不得在Processes读取工作区或设备目录。
test('locateApp is restricted to the Files surface', async () => {
  const f = await fixture();
  try {
    await f.controller.setContext('phone', true, 'processes'); await Promise.all([...f.controller.scope.tasks]); f.calls.length = 0;
    await f.controller.handle({ type: 'explorer', action: 'locateApp' });
    assert.match(f.posts.findLast(m => m.type !== 'explorerLoading').error, /files view is not active/);
    assert.equal(f.calls.some(c => c[0] === 'picker' || c[0] === 'list'), false);
    assert.equal(f.posts.some(m => m.type === 'explorerReveal'), false);
  } finally { await f.close(); }
});

// 保留五个按钮的结果回归：创建/上传/删除改变父快照，下载验证真实文件字节与完成状态，刷新发布新内容。
test('toolbar file commands publish created uploaded deleted refreshed and downloaded results', async () => {
  const entries = new Set(['/keep.txt']);
  const options = { input: 'new directory', confirm: 'Delete', directoryEntries: remote => remote === '/' ? [...entries].map(p => ({ path: p, name: p.slice(1), kind: p === '/new directory' ? 'directory' : 'file' })) : [], create: async remote => { entries.add(remote); }, remove: async remote => { entries.delete(remote); }, push: async (local, remote) => { entries.add(remote); } };
  const f = await fixture(options);
  try {
    await f.controller.setContext('phone', true); await Promise.all([...f.controller.scope.tasks]);
    await f.controller.handle({ type: 'explorer', action: 'newDirectory', parent: '/' });
    assert.equal(f.posts.findLast(m => m.type === 'explorerFiles').entries.some(e => e.path === '/new directory' && e.kind === 'directory'), true);
    const sourceDirectory = path.join(f.temp, 'source'); await fsp.mkdir(sourceDirectory);
    const upload = path.join(sourceDirectory, 'local.txt'); await fsp.writeFile(upload, 'uploaded bytes'); options.openDialog = [{ scheme: 'file', fsPath: upload }];
    await f.controller.handle({ type: 'explorer', action: 'upload', target: '/' });
    assert.equal(await fsp.readFile(path.join(f.temp, 'local.txt'), 'utf8'), 'uploaded bytes');
    assert.equal(f.posts.findLast(m => m.type === 'explorerFiles').entries.some(e => e.path === '/local.txt'), true);
    assert.equal(f.posts.some(m => m.message === 'Upload complete' && m.busy === false), true);
    options.openDialog = [{ scheme: 'file', fsPath: f.temp }];
    await f.controller.handle({ type: 'explorer', action: 'download', paths: ['/keep.txt'] });
    assert.equal(await fsp.readFile(path.join(f.temp, 'keep.txt'), 'utf8'), 'downloaded');
    assert.equal(f.posts.findLast(m => m.type !== 'explorerLoading').message, 'Download complete'); assert.equal(f.posts.findLast(m => m.type !== 'explorerLoading').busy, false);
    await f.controller.handle({ type: 'explorer', action: 'delete', paths: ['/keep.txt'] });
    assert.equal(f.posts.findLast(m => m.type === 'explorerFiles').entries.some(e => e.path === '/keep.txt'), false);
    entries.add('/external.txt');
    await f.controller.handle({ type: 'explorer', action: 'refresh' });
    assert.equal(f.posts.findLast(m => m.type === 'explorerFiles').entries.some(e => e.path === '/external.txt'), true);
  } finally { await f.close(); }
});

// 取消各原生对话框时无落地/远端更改；后端失败必须可见且无下载/上传伪完成，刷新不伪造快照。
test('toolbar file commands preserve cancellation and surface operation failures', async () => {
  const cancel = await fixture({ openDialog: null, confirm: 'Cancel' });
  try {
    await cancel.controller.setContext('phone', true); await Promise.all([...cancel.controller.scope.tasks]); cancel.calls.length = 0; cancel.posts.length = 0;
    for (const message of [{ action: 'newDirectory', parent: '/' }, { action: 'upload', target: '/' }, { action: 'download', paths: ['/x'] }, { action: 'delete', paths: ['/x'] }]) { await cancel.controller.handle({ type: 'explorer', ...message }); }
    assert.equal(cancel.calls.some(c => ['create', 'push', 'pull', 'remove'].includes(c[0])), false);
    assert.equal(cancel.posts.some(m => /complete/.test(m.message || '')), false);
  } finally { await cancel.close(); }
  const actions = ['newDirectory', 'upload', 'download', 'delete', 'refresh'];
  for (const action of actions) {
    const options = { input: 'new', confirm: 'Delete', create: async () => { throw new Error('create failed'); }, push: async () => { throw new Error('push failed'); }, pull: async () => { throw new Error('pull failed'); }, remove: async () => { throw new Error('remove failed'); } };
    const f = await fixture(options);
    try {
      await f.controller.setContext('phone', true); await Promise.all([...f.controller.scope.tasks]); f.posts.length = 0;
      if (action === 'refresh') { options.listUnavailable = ['/']; }
      await f.controller.handle({ type: 'explorer', action, parent: '/', target: '/', paths: ['/x'] });
      assert.match(f.posts.findLast(m => m.type !== 'explorerLoading').error, /failed|adb unavailable/);
      assert.equal(f.posts.some(m => m.message === 'Upload complete' || m.message === 'Download complete' || m.type === 'explorerFiles'), false);
      if (action === 'download') { await assert.rejects(fsp.stat(path.join(f.temp, 'x')), { code: 'ENOENT' }); }
    } finally { await f.close(); }
  }
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
