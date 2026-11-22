const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { transformSync } = require('esbuild');

// npm test：Android 工作区通过 Gradle 或 Manifest 文件匹配激活，调试入口仍由专用事件触发，不使用全局启动激活。
test('extension activates for Android workspaces', () => {
  const events = require('../package.json').activationEvents;
  assert.ok(events.includes('workspaceContains:**/{build.gradle,build.gradle.kts,settings.gradle,settings.gradle.kts,gradlew,gradlew.bat,AndroidManifest.xml}'));
  assert.equal(events.includes('*'), false);
  assert.equal(events.includes('onStartupFinished'), false);
});

// 编译输入与rootDir同属src；Node>=22运行node --test tests/configuration-prefix.test.js，通过本机TypeScript CLI的showConfig JSON断言全部扩展源码仍受strict检查，第三方参考源码不被误收。
test('compiler typecheck covers every extension source and excludes external material',()=>{
  const root=path.resolve(__dirname,'..'),source=path.join(root,'src'),compiler=path.join(path.dirname(require.resolve('typescript/package.json')),'bin','tsc');
  const result=require('node:child_process').spawnSync(process.execPath,[compiler,'--showConfig','-p',root],{encoding:'utf8'});assert.equal(result.status,0,result.stderr||result.stdout);
  const config=JSON.parse(result.stdout);assert.equal(config.compilerOptions.strict,true);assert.equal(path.resolve(root,config.compilerOptions.rootDir),source);
  const snapshotRoots = ['src/android-debugger/native-debugger/upstream/'];
  const expected=[...fs.globSync('src/**/*.ts',{cwd:root})].filter(p=>{const normalized=p.replaceAll(String.fromCharCode(92),'/');return !snapshotRoots.some(prefix=>normalized.startsWith(prefix));}).map(p=>path.resolve(root,p)).sort(),files=config.files.map(p=>path.resolve(root,p));
  assert.ok(expected.length>0);assert.deepEqual(files.sort(),expected);
  assert.ok(files.every(file=>{const relative=path.relative(source,file);return !relative.startsWith('..')&&!path.isAbsolute(relative);}));
});

// npm test：清单仅注册新前缀的设置、命令和视图，调试配置归入debugger子空间。
test('android-ide configuration schema replaces command and view identities', () => {
  const p = require('../package.json');
  const properties = p.contributes.configuration.properties;
  assert.deepEqual(Object.keys(properties).filter(key => key.startsWith('android-ide.')).sort(), [
    'android-ide.deviceViewMode', 'android-ide.embeddedEmulator', 'android-ide.explorer.packageFilter',
    'android-ide.fixSoftwareRendering', 'android-ide.logcat.maxBytes', 'android-ide.mirrorIntervalMs', 'android-ide.mirrorVisible', 'android-ide.nativeMirror',
    'android-ide.jvmDebugger.javaHome', 'android-ide.jvmDebugger.adapterJvmArgs', 'android-ide.jvmDebugger.traceProtocol', 'android-ide.jvmDebugger.logLevel',
  ].sort());
  const declaredSettings = new Set();
  for (const key of Object.keys(properties).filter(key => key.startsWith('android-debug.'))) assert.equal(declaredSettings.has(key), true, key);
  assert.deepEqual([...declaredSettings].sort(), Object.keys(properties).filter(key => key.startsWith('android-debug.')).sort());
  assert.ok(p.contributes.commands.some(c => c.command === 'android-ide.refresh'));
  assert.ok(p.contributes.views.androidTools.some(v => v.id === 'android-ide.runningDevice'));
});

// Node>=22执行本文件：路径不注册为VSCode设置，仅项目本地文件承载且不进入版本控制。
test('machine specific paths are absent from VSCode settings', () => {
  const properties = require('../package.json').contributes.configuration.properties;
  for (const key of ['android-ide.debugger.adbPath', 'android-ide.debugger.ndkPath', 'android-ide.debugger.lldbDapPath', 'android-ide.sdkPath', 'android-ide.explorer.downloadLocation']) {
    assert.equal(Object.hasOwn(properties, key), false, key);
  }
  const ignored = fs.readFileSync(path.join(__dirname, '../.gitignore'), 'utf8').split(/\r?\n/);
  assert.ok(ignored.includes('.vscode/android-ide.local.json'));
  const validation = require('../package.json').contributes.jsonValidation;
  assert.ok(validation.some(item => item.fileMatch.includes('/.vscode/android-ide.local.json') && item.url === './schemas/android-ide.local.schema.json'));
  const schema = require('../schemas/android-ide.local.schema.json');
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(Object.keys(schema.properties).sort(), ['debugger', 'downloadDirectory', 'scrcpyPath', 'sdkPath']);
  assert.deepEqual(Object.keys(schema.properties.debugger.properties).sort(), ['adbPath', 'ndkPath', 'symbolSearchPaths']);
  for (const document of ['README.md', 'CONTRIBUTING.md']) {
    const text = fs.readFileSync(path.join(__dirname, '..', document), 'utf8');
    assert.equal(text.includes('android-ide.sdkPath'), false, document);
    assert.ok(text.includes('.vscode/android-ide.local.json'), document);
  }
});

// 执行真实 activate 和设备命令注册；无 VS Code/设备依赖，断言清单引用一致且不存在旧前缀别名。
test('runtime registers only android-ide commands and views', () => {
  const commands = new Set(), views = new Set();
  const vscode = {
    workspace: {
      findFiles: async () => [],
      onDidCreateFiles: () => ({ dispose() {} }),
      onDidDeleteFiles: () => ({ dispose() {} }),
      onDidRenameFiles: () => ({ dispose() {} }),
      onDidChangeWorkspaceFolders: () => ({ dispose() {} }),
      getConfiguration: section => {
      assert.equal(section, 'android-ide');
      return { get: (key, fallback) => fallback, inspect: () => undefined };
      },
      onDidChangeConfiguration: () => ({ dispose() {} }),
    },
    commands: {
      registerCommand: (id, handler) => { assert.equal(typeof handler, 'function'); assert.ok(!commands.has(id)); commands.add(id); return { dispose() {} }; },
      executeCommand: async () => undefined,
    },
    window: { registerWebviewViewProvider: id => { views.add(id); return { dispose() {} }; } },
    debug: { registerDebugAdapterDescriptorFactory: () => ({ dispose() {} }) },
  };
  // 仅隔离外部服务和 UI 提供方，命令注册与清单使用生产实现。
  function load(file, deps) {
    const module = { exports: {} };
    vm.runInNewContext(transformSync(fs.readFileSync(path.join(__dirname, '../src', file), 'utf8'), { loader: 'ts', format: 'cjs' }).code,
      { module, exports: module.exports, require: id => id === './runtimeContext' ? require('./runtime-context-loader.cjs')() : Object.hasOwn(deps, id) ? deps[id] : require(id) });
    return module.exports;
  }
  class Provider { async initialize() {} }
  const deviceManager = load('deviceManager.ts', { vscode, './sdk': {} });
  const extension = load('extension.ts', {
    vscode, './android-debugger/coordinator/androidCoordinator': { AndroidCoordinator: class { async dispose() {} } }, './deviceManager': deviceManager,
    './runningDevices': { RunningDeviceView: Provider }, './deviceExplorer': { DeviceExplorerController: Provider },
    './androidBuild': { AndroidBuildController: Provider }, './logcat': { LogcatView: Provider },
    './extendedControls': {}, './android-debugger/adapter': { createAndroidDebugAdapterFactory: () => ({}) }, './android-debugger/jvm-debugger/adapter': { registerJvmDebugger() {} },
  });
  extension.activate({ extensionPath: '', subscriptions: [] });
  const p = require('../package.json');
  for (const id of commands) assert.ok(id.startsWith('android-ide.'), id);
  for (const c of p.contributes.commands.filter(c => c.command.startsWith('android-ide.'))) assert.ok(commands.has(c.command), c.command);
  const declared = Object.values(p.contributes.views).flat().map(view => view.id).sort();
  assert.deepEqual([...views].sort(), declared);
  for (const id of views) assert.ok(id.startsWith('android-ide.'), id);
  for (const menu of p.contributes.menus['view/title']) {
    assert.ok(commands.has(menu.command));
    assert.equal(menu.when, 'view == android-ide.runningDevice');
  }
});

// 无设备执行真实启动参数函数，输入新配置的开/关状态；断言读取命名空间、GPU开关及内嵌参数。
test('emulator launch arguments read android-ide configuration', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/deviceManager.ts'), 'utf8');
  const start = source.indexOf('async function launchArgs(');
  const end = source.indexOf(String.fromCharCode(10) + 'const avdOf', start);
  assert.ok(start >= 0 && end > start);
  const values = { fixSoftwareRendering: true, embeddedEmulator: true }, gpu = [];
  const ctx = vm.createContext({
    vscode: { workspace: { getConfiguration: section => {
      assert.equal(section, 'android-ide');
      return { get: key => { assert.ok(Object.hasOwn(values, key)); return values[key]; } };
    } } },
    listAvds: () => [{ name: 'Pixel', dir: '/avd' }],
    enableHostGpu: dir => gpu.push(dir), freePort: async () => 8554,
  });
  vm.runInContext(transformSync(source.slice(start, end), { loader: 'ts' }).code, ctx);
  assert.deepEqual(Array.from(await vm.runInContext("launchArgs('Pixel')", ctx)), ['-avd', 'Pixel', '-qt-hide-window', '-grpc', '8554']);
  assert.deepEqual(gpu, ['/avd']);
  values.fixSoftwareRendering = false; values.embeddedEmulator = false;
  assert.deepEqual(Array.from(await vm.runInContext("launchArgs('Pixel')", ctx)), ['-avd', 'Pixel']);
  assert.deepEqual(gpu, ['/avd']);
});

// 无设备执行截图定时器入口，输入新配置的间隔；断言立即首帧、定时周期及句柄归属，不运行真实计时器。
test('screenshot fallback reads android-ide capture interval', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/runningDevices.ts'), 'utf8');
  const start = source.indexOf('  private startScreencap() {');
  const end = source.indexOf(String.fromCharCode(10) + '  }', start);
  assert.ok(start >= 0 && end > start);
  const method = source.slice(start, end + 4).replace('private startScreencap()', 'function startScreencap()');
  let interval, callback;
  const ctx = vm.createContext({
    vscode: { workspace: { getConfiguration: section => {
      assert.equal(section, 'android-ide');
      return { get: (key, fallback) => { assert.equal(key, 'mirrorIntervalMs'); assert.equal(fallback, 0); return 321; } };
    } } },
    setInterval: (fn, ms) => { callback = fn; interval = ms; return 7; },
  });
  vm.runInContext(transformSync(method, { loader: 'ts' }).code, ctx);
  let captures = 0;
  const messages = [], owner = { post: m => messages.push(m.type), capture: () => { captures++; } };
  ctx.owner = owner;
  vm.runInContext('startScreencap.call(owner)', ctx);
  assert.equal(interval, 321); assert.equal(owner.loop, 7); assert.deepEqual(messages, ['mode']);
  assert.equal(captures, 1);
  callback(); assert.equal(captures, 2);

  let immediateCaptures = 0, immediateInterval = false;
  const immediate = vm.createContext({
    vscode: { workspace: { getConfiguration: () => ({ get: (key, fallback) => { assert.equal(key, 'mirrorIntervalMs'); assert.equal(fallback, 0); return 0; } }) } },
    setInterval: () => { immediateInterval = true; return 8; },
  });
  vm.runInContext(transformSync(method, { loader: 'ts' }).code, immediate);
  immediate.owner = { post() {}, capture: () => { immediateCaptures++; } };
  vm.runInContext('startScreencap.call(owner)', immediate);
  assert.equal(immediateCaptures, 1); assert.equal(immediateInterval, false);
});
