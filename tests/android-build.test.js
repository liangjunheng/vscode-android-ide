const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { transformSync } = require('esbuild');
const source = fs.readFileSync(path.join(__dirname, '../src/androidBuild.ts'), 'utf8');
const debuggerSource = fs.readFileSync(path.join(__dirname, '../src/android-debugger/index.ts'), 'utf8');
const tasks = 'app:assembleDebug - APK\n:app:installDebug - install\napp:assembleRelease\napp:installRelease\nassemble - aggregate\napp:test - tests\n';

// 创建临时工程及真实 EventEmitter 子进程替身；可配置tasks供current application ID多模块回归，npm test断言关闭、失败、取消和选择隔离，不执行用户Gradle。
function fixture(t, platform = 'linux') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'device-tools-build-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'settings.gradle.kts'), '');
  for (const name of ['gradlew', 'gradlew.bat']) fs.writeFileSync(path.join(root, name), '');
  const metaDir = path.join(root, 'app', 'build', 'outputs', 'apk', 'debug');
  fs.mkdirSync(metaDir, { recursive: true });
  const metadata = path.join(metaDir, 'output-metadata.json');
  fs.writeFileSync(metadata, JSON.stringify({ variantName: 'debug', applicationId: 'com.example.app', elements: [{ outputFile: 'app.apk' }] }));
  const f = { root, metadata, calls: [], messages: [], notifications: [], configs: [], debugCalls: [], debugTerminationListeners: new Set(), hold: false, closeOnKill: true, fail: null, offline: false, launchOutput: '', debugResult: true, choose: true, pickIndex: undefined, roots: [root], tasks };
  const channel = { text: '', shown: 0, disposed: false, replace(s) { this.text = s; }, show() { this.shown++; }, dispose() { this.disposed = true; } };
  f.channel = channel;
  const cp = { spawn(command, args, options) {
    const child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    child.pid = 100 + f.calls.length; child.exitCode = null; child.signalCode = null;
    child.finish = (code = 0, signal = null) => { child.exitCode = code; child.signalCode = signal; child.emit('close', code, signal); };
    const call = { command, args, options, child }; f.calls.push(call);
    if (command === 'taskkill') {
      queueMicrotask(() => { if (f.closeOnKill) f.held?.finish(null, 'SIGTERM'); child.finish(); });
    } else if (f.hold) { f.held = child; }
    else queueMicrotask(() => {
      if (f.fail) { const failure = f.fail; f.fail = null; child.stderr.emit('data', Buffer.from(failure)); child.finish(1); return; }
      let output = args.includes('get-state') ? (f.offline ? 'offline' : 'device') : args.some(a => String(a).includes('tasks')) ? f.tasks : args.includes('monkey') ? f.launchOutput : '';
      child.stdout.emit('data', Buffer.from(output)); child.finish();
    });
    return child;
  } };
  const vscode = {
    workspace: {
      isTrusted: true,
      findFiles: async () => f.roots.map(r => ({ fsPath: path.join(r, 'settings.gradle.kts') })),
      getWorkspaceFolder: () => ({ uri: { fsPath: root } }),
      getConfiguration: section => ({ get: (key, fallback) => section === 'launch' ? f.configs : fallback }),
    },
    Uri: { file: fsPath => ({ fsPath }) },
    window: { createOutputChannel: () => channel, showQuickPick: async items => f.choose ? items[f.pickIndex ?? (f.configs.length ? items.length - 1 : 0)] : undefined, showInformationMessage: async message => { f.notifications.push(message); return undefined; } },
    commands: { executeCommand: async (...args) => { f.commands ??= []; f.commands.push(args); } },
    debug: {
      onDidStartDebugSession: listener => { (f.debugStartListeners ??= new Set()).add(listener); return { dispose() { f.debugStartListeners.delete(listener); } }; },
      onDidTerminateDebugSession: listener => { f.debugTerminationListeners.add(listener); return { dispose() { f.debugTerminationListeners.delete(listener); } }; },
      startDebugging: async (...args) => {
        f.debugCalls.push(args);
        if (f.debugResult) {
          const session = { configuration: { ...args[1], ...(f.resolvedPackage ? { packageName: f.resolvedPackage } : {}) } };
          f.session = session;
          for (const listener of [...f.debugStartListeners]) listener(session);
          if (f.terminateImmediately) for (const listener of [...f.debugTerminationListeners]) listener(session);
          await f.onDebugStart?.(session);
        }
        return f.debugResult;
      },
      stopDebugging: async session => { assert.equal(session, f.session); f.stoppedDebug = session; for (const listener of [...f.debugTerminationListeners]) listener(session); },
    },
  };
  f.vscode = vscode;
  const modelModule = { exports: {} };
  vm.runInNewContext(transformSync(fs.readFileSync(path.join(__dirname, '../src/androidProjectModel.ts'), 'utf8'), { loader: 'ts', format: 'cjs' }).code, { module: modelModule, exports: modelModule.exports, require, AbortController });
  f.realDiscoverSources = modelModule.exports.discoverVariantSources;
  f.modelCalls = [];
  const projectModel = { discoverVariantSources: async (selection, runner, signal) => {
    f.modelCalls.push({ selection, runner, signal, commandsBefore: f.calls.length });
    if (f.discoverSources) return f.discoverSources(selection, runner, signal);
    return { moduleRoot: path.join(selection.projectRoot, ...selection.modulePath.slice(1).split(':')), roots: [], ...f.sourceModel };
  } };
  const debuggerModule = { exports: {} };
  vm.runInNewContext(transformSync(debuggerSource, { loader: 'ts', format: 'cjs' }).code, { module: debuggerModule, exports: debuggerModule.exports, require: id => id === 'vscode' ? vscode : require(id), Promise });
  const debugApi = { ...debuggerModule.exports, startAndroidDebugging: async (folder, config, target) => {
    (f.debugRequests ??= []).push({ folder, config, target });
    return debuggerModule.exports.startAndroidDebugging(folder, config, target);
  } };
  const module = { exports: {} };
  vm.runInNewContext(transformSync(source, { loader: 'ts', format: 'cjs' }).code, {
    module, exports: module.exports, Buffer, AbortController, console,
    process: { platform, env: {}, kill: pid => { assert.equal(pid, -f.held.pid); if (f.closeOnKill) f.held.finish(null, 'SIGTERM'); } },
    require: id => id === 'vscode' ? vscode : id === 'child_process' ? cp : id === './sdk' ? { adbPath: () => 'sdk adb' } : id === './android-debugger' ? debugApi : id === './androidProjectModel' ? projectModel : require(id),
  });
  f.controller = new module.exports.AndroidBuildController(m => f.messages.push(m));
  f.parse = module.exports.parseGradleTasks;
  f.action = (action, value, serial) => f.controller.handle({ type: 'buildPanel', action, value }, serial);
  f.last = () => f.messages.at(-1);
  return f;
}

// npm test：真实任务格式、模块/变体配对、默认值及刷新保留选择都有结果断言。
test('android-build real task formats and refresh selections', async t => {
  const f = fixture(t);
  assert.deepEqual(Array.from(f.parse(tasks)), [':app:assembleDebug', ':app:assembleRelease', ':app:installDebug', ':app:installRelease']);
  await f.action('refresh');
  assert.equal(f.last().projects.length, 1);
  assert.equal(f.last().target, ':app:Debug');
  assert.deepEqual(Array.from(f.last().targets, x => x.label), ['app | Debug', 'app | Release']);
  await f.action('target', ':app:Release');
  await f.action('refresh');
  assert.equal(f.last().target, ':app:Release');
  await assert.rejects(f.action('project', 'forged'), /Invalid project/);
  await assert.rejects(f.action('target', ':evil:Debug'), /Invalid target/);
  await f.action('project', f.root);
  await f.controller.dispose();
});

// npm test：无项目、缺 wrapper、每次信任变化和非法消息均明确失败，不执行命令。
test('android-build empty workspace and unavailable prerequisites', async t => {
  const f = fixture(t); f.roots = [];
  await f.action('refresh'); assert.equal(f.last().status, 'No Gradle project');
  await assert.rejects(f.action('build'), /Select a Gradle project/);
  f.roots = [f.root]; fs.unlinkSync(path.join(f.root, 'gradlew'));
  await assert.rejects(f.action('refresh'), /No Gradle Wrapper/);
  f.vscode.workspace.isTrusted = false;
  await assert.rejects(f.action('refresh'), /not trusted/);
  await assert.rejects(f.action('garbage'), /Invalid build/);
  assert.equal(f.calls.length, 0);
  await f.controller.dispose();
  await assert.rejects(f.action('refresh'), /disposed/);
});

// npm test：Build 不要求设备，Install 使用独立 install task 和 ANDROID_SERIAL，失败保留日志并恢复 UI。
test('android-build build and targeted install preserve task and error semantics', async t => {
  const f = fixture(t); await f.action('refresh');
  await f.action('build'); assert.ok(f.calls.at(-1).args.includes(':app:assembleDebug'));
  assert.equal(f.last().status, 'Build succeeded');
  await f.action('install', undefined, 'usb-1');
  assert.ok(f.calls.at(-1).args.includes(':app:installDebug'));
  assert.equal(f.calls.at(-1).options.env.ANDROID_SERIAL, 'usb-1');
  const count = f.calls.length;
  await assert.rejects(f.action('install'), /device serial/);
  assert.equal(f.calls.length, count);
  f.offline = true; await assert.rejects(f.action('install', undefined, 'usb-1'), /not online/);
  f.fail = 'Gradle failure'; await assert.rejects(f.action('build'), /Gradle failure/);
  assert.equal(f.last().busy, false); assert.match(f.last().error, /Gradle failure/);
  assert.match(f.channel.text, /Gradle failure/);
  await f.controller.dispose();
});

// npm test：Run 必须先 install，再仅启动所选模块的包；Stop 不随当前设备选择漂移。
test('android-build run installs selected package and stop owns original serial', async t => {
  const f = fixture(t); await f.action('refresh');
  const other = path.join(f.root, 'other', 'build', 'outputs', 'apk', 'debug'); fs.mkdirSync(other, { recursive: true });
  fs.writeFileSync(path.join(other, 'output-metadata.json'), JSON.stringify({ variantName: 'debug', applicationId: 'com.wrong.app' }));
  await f.action('run', undefined, 'phone');
  assert.ok(f.calls.at(-2).args.includes(':app:installDebug'));
  assert.deepEqual(Array.from(f.calls.at(-1).args).slice(0, 7), ['-s', 'phone', 'shell', 'monkey', '-p', 'com.example.app', '-c']);
  assert.equal(f.last().running, true);
  await f.action('stop', undefined, 'other-phone');
  assert.deepEqual(Array.from(f.calls.at(-1).args), ['-s', 'phone', 'shell', 'am', 'force-stop', 'com.example.app']);
  assert.equal(f.last().running, false);
  await f.controller.dispose();
});

// node --test tests/android-build.test.js：面板默认应用项、六个内置项、非法选择及所属会话结束后复位均使用真实消息入口断言。
test('android-build run mode selection routes all six configurations and resets on termination', async t => {
  const f = fixture(t); await f.action('refresh');
  assert.equal(f.last().runMode, 'run');
  assert.equal(f.last().runModes.length, 7);
  assert.equal(f.last().runModes[0].action, 'run');
  await assert.rejects(f.action('runMode', 'debug-6'), /Invalid run mode/);
  const expected = [['native','launch'],['native','attach'],['java','launch'],['java','attach'],['dual','launch'],['dual','attach']];
  for (let index = 0; index < expected.length; index++) {
    const calls = f.calls.length;
    await f.action('runMode', 'debug-' + index);
    assert.equal(f.calls.length, calls);
    await f.action('run', undefined, 'phone');
    assert.equal(f.last().running, true);
    assert.equal(f.debugCalls.at(-1)[1].mode, expected[index][0]);
    assert.equal(f.debugCalls.at(-1)[1].request, expected[index][1]);
    await assert.rejects(f.action('runMode', 'run'), /Stop the current/);
    for (const listener of [...f.debugTerminationListeners]) listener(f.session);
    assert.equal(f.last().running, false);
    assert.equal(f.last().runMode, 'debug-' + index);
    assert.equal(f.last().status, 'Stopped');
    assert.equal(f.debugTerminationListeners.size, 0);
  }
  await f.action('runMode', 'run');
  await f.action('run', undefined, 'phone');
  assert.ok(f.calls.at(-1).args.includes('monkey'));
  await f.action('stop'); await f.controller.dispose();
});

// 所属会话结束释放自身状态，其他会话终止不变；再次Debug无需Stop且监听全部回收。
test('android-build debug termination releases only its owned session and permits reentry', async t => {
  const f = fixture(t); await f.action('refresh');
  await f.action('debug', undefined, 'phone');
  assert.equal(f.last().running, true);
  for (const listener of [...f.debugTerminationListeners]) listener({ configuration: f.session.configuration });
  assert.equal(f.last().running, true);
  await assert.rejects(f.action('debug', undefined, 'phone'), /Stop the current/);
  for (const listener of [...f.debugTerminationListeners]) listener(f.session);
  assert.equal(f.last().running, false);
  assert.equal(f.last().status, 'Stopped');
  assert.equal(f.debugTerminationListeners.size, 0);
  await f.action('debug', undefined, 'phone');
  assert.equal(f.debugCalls.length, 2);
  const before = f.calls.length;
  await f.action('stop');
  assert.equal(f.calls.length, before);
  assert.equal(f.debugStartListeners.size, 0);
  assert.equal(f.debugTerminationListeners.size, 0);
  await f.controller.dispose();
});

// metadata损坏/启动器失败不发布Running；Run要求metadata，非Android外部Debug缺包名/metadata仍可正常启动。
test('android-build metadata and launcher failures remain visible', async t => {
  const f = fixture(t); await f.action('refresh');
  fs.writeFileSync(f.metadata, '{broken');
  await assert.rejects(f.action('run', undefined, 'phone'), /JSON|Unexpected|property/i);
  fs.unlinkSync(f.metadata);
  await assert.rejects(f.action('run', undefined, 'phone'), /No APK metadata/);
  f.configs = [{ name: 'External', type: 'adapter', request: 'attach' }];
  await f.action('debug', undefined, 'phone');
  assert.equal(f.debugCalls.at(-1)[1].packageName, undefined);
  await f.action('stop');
  fs.writeFileSync(f.metadata, JSON.stringify({ variantName: 'debug', applicationId: 'com.example.app' }));
  f.launchOutput = 'No activities found'; await assert.rejects(f.action('run', undefined, 'phone'), /No activities/);
  assert.equal(f.last().running, false);
  await f.controller.dispose();
});

/** 六个内置组合保持所选mode/request，Debug和Stop均不构建、安装、启动或发现源码。 */
test('android-build all six built-in configurations debug without Gradle installation or source models', async t => {
  const f = fixture(t); await f.action('refresh'); fs.unlinkSync(f.metadata);
  for (let index = 0; index < 6; index++) {
    f.pickIndex = index;
    const before = f.calls.length;
    await f.action('debug', undefined, 'phone');
    const config = f.debugCalls.at(-1)[1];
    assert.equal(config.type, 'android-debug');
    assert.equal(config.mode, ['native', 'java', 'dual'][Math.floor(index / 2)]);
    assert.equal(config.request, index % 2 ? 'attach' : 'launch');
    assert.equal(config.androidMode, undefined);
    assert.equal(config.packageName, undefined); assert.equal(config.serial, 'phone');
    assert.equal(config.apkPath, undefined); assert.equal(config.androidApkInstalled, undefined);
    assert.equal(config.androidSourceRoots, undefined); assert.equal(config.sourcePaths, undefined);
    assert.equal(config.java?.sourcePaths, undefined);
    assert.equal(f.calls.length, before + 1);
    assert.ok(f.calls.at(-1).args.includes('get-state'));
    assert.equal(f.modelCalls.length, 0);
    const stopBefore = f.calls.length;
    await f.action('stop'); assert.equal(f.calls.length, stopBefore);
  }
  await f.controller.dispose();
});

// 显式配置不被metadata覆盖，缺metadata也可启动；立即终止和启动取消不留下所属会话或监听。
test('android-build preserves explicit Android and external options without model discovery', async t => {
  const f = fixture(t); await f.action('refresh');
  for (const type of ['android-debug', 'android-tools', 'kotlin-jvm', 'third-party']) {
    const selected = { name: 'Explicit ' + type, type, request: 'launch', ...(type === 'kotlin-jvm' ? { android: true } : {}),
      mode: type === 'android-tools' ? 'native' : 'dual', packageName: 'com.user.chosen', target: 'explicit-target', serial: 'explicit-serial',
      apkPath: '/explicit/app.apk', androidProjectRoot: '/explicit/root', preLaunchTask: 'user task', sourcePaths: ['top-src'],
      java: { type: 'kotlin-jvm', sourcePaths: ['java-src'] }, native: { abi: 'x86', symbolSearchPaths: ['symbols'] } };
    f.configs = [selected]; fs.writeFileSync(f.metadata, '{invalid metadata must not be read');
    const snapshot = JSON.stringify(selected), before = f.calls.length;
    await f.action('debug', undefined, 'phone');
    const requested = f.debugCalls.at(-1)[1];
    const forwarded = f.debugRequests.at(-1);
    assert.equal(forwarded.config.serial, 'explicit-serial'); assert.equal(forwarded.config.target, 'explicit-target');
    assert.deepEqual(Object.keys(forwarded.target).sort(), ['packageName', 'serial', 'signal']);
    assert.equal(forwarded.target.serial, 'phone'); assert.equal(forwarded.target.packageName, 'com.user.chosen');
    assert.equal(forwarded.target.signal instanceof AbortSignal, true);
    for (const key of ['packageName', 'apkPath', 'androidProjectRoot', 'preLaunchTask', 'request', 'mode']) assert.equal(requested[key], selected[key]);
    assert.deepEqual(JSON.parse(JSON.stringify(requested.java)), selected.java);
    assert.deepEqual(JSON.parse(JSON.stringify(requested.native)), selected.native);
    assert.deepEqual(Array.from(requested.sourcePaths), selected.sourcePaths);
    assert.equal(requested.serial, 'phone');
    assert.equal(JSON.stringify(selected), snapshot);
    assert.equal(f.calls.length, before + 1); assert.equal(f.modelCalls.length, 0);
    await f.action('stop'); assert.equal(f.calls.length, before + 1);
  }
  await f.controller.dispose();
});

// 启动事件和终止事件在startDebugging完成前连续发生也必须释放状态；取消后detach只发生一次。
test('android-build immediate termination and startup cancellation release owned resources', async t => {
  const f = fixture(t); await f.action('refresh'); f.terminateImmediately = true;
  await assert.rejects(f.action('debug', undefined, 'phone'), /terminated during startup/);
  assert.equal(f.controller.debugSession, undefined); assert.equal(f.controller.launched, undefined);
  assert.equal(f.debugStartListeners.size, 0); assert.equal(f.debugTerminationListeners.size, 0);
  assert.equal(f.stoppedDebug, undefined);
  f.terminateImmediately = false;
  f.onDebugStart = () => f.controller.operation.controller.abort();
  await assert.rejects(f.action('debug', undefined, 'phone'), /cancelled/);
  assert.equal(f.stoppedDebug, f.session);
  assert.equal(f.debugTerminationListeners.size, 0); assert.equal(f.debugStartListeners.size, 0);
  f.onDebugStart = undefined; await f.action('debug', undefined, 'phone'); await f.action('stop');
  assert.equal(f.calls.some(call => call.args.includes('force-stop')), false);
  await f.controller.dispose();
});

// Native缺APK metadata时不触发Gradle/AGP model；provider仅在真实调试会话中解析包名，Build不伪造模型字段。
test('android-build Native debug uses metadata and skips Gradle model fallback', async t => {
  const f = fixture(t); await f.action('refresh');
  fs.writeFileSync(f.metadata, JSON.stringify({ variantName: 'debug', applicationId: 'com.metadata.selected', elements: [{ outputFile: 'app.apk', filters: [{ filterType: 'ABI', value: 'arm64-v8a' }] }] }));
  const modelCount = f.modelCalls.length, callsBefore = f.calls.length;
  await f.action('debug', undefined, 'phone');
  assert.deepEqual(f.commands, [['workbench.view.debug']]);
  assert.equal(f.modelCalls.length, modelCount);
  assert.equal(f.calls.some(call => call.args.includes(':app:installDebug')), false);
  assert.equal(f.calls.length, callsBefore + 1);
  const requested = f.debugCalls.at(-1)[1];
  assert.equal(requested.packageName, 'com.metadata.selected');
  assert.equal(requested.androidProjectRoot, f.root);
  assert.equal(requested.androidAbiSupported, undefined);
  await f.action('stop');
  fs.unlinkSync(f.metadata); f.sourceModel = { applicationId: 'com.agp.must-not-be-read' }; f.resolvedPackage = 'com.provider.selected';
  const modelBeforeProvider = f.modelCalls.length, callsBeforeProvider = f.calls.length;
  await f.action('debug', undefined, 'phone');
  assert.equal(f.modelCalls.length, modelBeforeProvider);
  assert.equal(f.calls.length, callsBeforeProvider + 1);
  assert.equal(f.debugCalls.at(-1)[1].packageName, undefined);
  await f.action('stop'); await f.controller.dispose();
});

// Native直接启动Run and Debug，仅只读包名、不注入APK/ABI/AGP字段；外部选择、取消、停止及拒绝均保留原契约。
test('android-build debug starts built-in sessions with source roots and preserves external session behavior', async t => {
  const f = fixture(t); await f.action('refresh');
  fs.writeFileSync(f.metadata, JSON.stringify({ variantName: 'debug', applicationId: 'com.example.app', elements: [{ outputFile: 'app.apk', filters: [{ filterType: 'ABI', value: 'arm64-v8a' }] }] }));
  for (const pickIndex of [0]) {
    f.pickIndex = pickIndex;
    const commandsBefore = f.calls.length;
    const modelsBefore = f.modelCalls.length;
    await f.action('debug', undefined, 'phone');
    assert.equal(f.debugCalls.length, pickIndex + 1);
    assert.equal(f.modelCalls.length, modelsBefore);
    assert.ok(f.calls.length > commandsBefore);
    assert.deepEqual(f.commands, [['workbench.view.debug']]);
    assert.ok(f.calls.some(call => call.args.includes('get-state')));
    assert.equal(f.calls.some(call => call.args.includes(':app:installDebug')), false);
    const requested = f.debugCalls.at(-1)[1];
    assert.equal(requested.type, 'android-debug');
    assert.equal(requested.request, 'launch');
    assert.equal(requested.androidMode, undefined);
    assert.equal(requested.mode, 'native');
    assert.deepEqual(JSON.parse(JSON.stringify(requested.native)), {});
    assert.equal(requested.androidAbiSupported, undefined);
    assert.equal(requested.serial, 'phone');
    assert.equal(requested.packageName, 'com.example.app');
    assert.equal(requested.androidProjectRoot, f.root);
    assert.equal(requested.androidAbiSupported, undefined);
    assert.equal(requested.androidModuleRoot, undefined);
    assert.equal(requested.androidVariant, undefined);
    assert.equal(requested.androidSourceRoots, undefined);
    assert.equal(f.last().status, 'Debug started');
    assert.equal(f.last().running, true);
    await f.action('stop');
    assert.equal(f.last().running, false);
  }
  f.configs = [{ name: 'One', type: 'adapter', request: 'launch' }, { name: 'Two', type: 'adapter', request: 'attach' }];
  f.pickIndex = undefined;
  const callsBeforeCancel = f.calls.length, debugBeforeCancel = f.debugCalls.length;
  f.choose = false; await f.action('debug', undefined, 'phone'); assert.equal(f.last().status, 'Debug cancelled');
  assert.equal(f.calls.length, callsBeforeCancel); assert.equal(f.debugCalls.length, debugBeforeCancel);
  const modelCount = f.modelCalls.length;
  f.choose = true; await f.action('debug', undefined, 'phone');
  assert.equal(f.modelCalls.length, modelCount);
  assert.equal(f.commands.length, 1);
  assert.equal(f.debugCalls.at(-1)[1].name, 'Two');
  assert.equal(f.debugCalls.at(-1)[1].request, 'attach');
  assert.equal(f.debugCalls.at(-1)[1].androidProjectRoot, undefined);
  assert.equal(f.debugCalls.at(-1)[1].androidModuleRoot, undefined);
  assert.equal(f.debugCalls.at(-1)[1].androidVariant, undefined);
  assert.equal(f.debugCalls.at(-1)[1].serial, 'phone');
  assert.equal(f.debugCalls.at(-1)[1].packageName, undefined);
  await f.action('stop');
  assert.equal(f.stoppedDebug, f.session);
  f.debugResult = false; await assert.rejects(f.action('debug', undefined, 'phone'), /rejected|Android debug session did not start/);
  await f.controller.dispose();
});




// provider selection：Attach 只查询当前选择，无安装/启动；每次请求重新解析，切换变体后不复用旧结果。
test('android-build provider selection resolves matching package without installing or launching', async t => {
  const f = fixture(t); await f.action('refresh'); const before = f.calls.length;
  const signal = new AbortController().signal;
  const first = await f.controller.resolveCurrentDebugProject('com.example.app', f.root, signal);
  assert.equal(first.androidModuleRoot, path.join(f.root, 'app')); assert.equal(first.androidVariant, 'debug'); assert.deepEqual(Array.from(first.androidSourceRoots), []);
  assert.equal(f.calls.length, before); assert.equal(f.debugCalls.length, 0); assert.equal(f.controller.operation, undefined); assert.equal(f.controller.launched, undefined);
  const dir = path.join(f.root, 'app', 'build', 'outputs', 'apk', 'release'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'output-metadata.json'), JSON.stringify({ variantName: 'release', applicationId: 'com.example.release' }));
  await f.action('target', ':app:Release');
  const second = await f.controller.resolveCurrentDebugProject('com.example.release', f.root, signal); assert.equal(second.androidVariant, 'release');
  assert.equal(f.modelCalls.length, 2); assert.notEqual(first, second); assert.equal(f.calls.length, before); await f.controller.dispose();
});

// native graph：独立provider查询保持精确依赖身份；内置Native直接启动且不触发第二次模型解析；外部配置不注入内部native图字段。
test('android-build provider preserves native graph identity while built-in Native debug skips model lookup', async t => {
  const f = fixture(t); await f.action('refresh');
  const graph = [
    { modulePath: ':engine:bridge', moduleRoot: path.join(f.root, 'custom-native-owner'), variant: 'enginePaidRelease' },
    { modulePath: ':', moduleRoot: f.root, variant: 'producerDebug' },
  ];
  for (const nativeModules of [graph, [], undefined]) {
    const before = f.calls.length;
    f.sourceModel = nativeModules === undefined ? {} : { nativeModules };
    const project = await f.controller.resolveCurrentDebugProject('com.example.app', f.root, new AbortController().signal);
    assert.equal(Object.hasOwn(project, 'androidNativeModules'), nativeModules !== undefined);
    if (nativeModules !== undefined) assert.deepEqual(JSON.parse(JSON.stringify(project.androidNativeModules)), nativeModules);
    assert.equal(f.calls.length, before);
    const modelCount = f.modelCalls.length;
    const debugCount = f.debugCalls.length;
    await f.action('debug', undefined, 'phone');
    assert.equal(f.debugCalls.length, debugCount + 1);
    assert.equal(f.modelCalls.length, modelCount);
    assert.ok(f.calls.length > before);
    const requested = f.debugCalls.at(-1)[1];
    assert.equal(requested.type, 'android-debug');
    assert.equal(requested.androidProjectRoot, f.root);
    assert.equal(requested.androidModuleRoot, undefined);
    assert.equal(requested.androidVariant, undefined);
    assert.equal(requested.androidSourceRoots, undefined);
    assert.equal(Object.hasOwn(requested, 'androidNativeModules'), false);
    await f.action('stop');
  }
  const modelCount = f.modelCalls.length;
  f.configs = [{ name: 'External', type: 'third-party', request: 'attach', custom: 'preserved' }];
  await f.action('debug', undefined, 'phone');
  assert.equal(f.modelCalls.length, modelCount); assert.equal(Object.hasOwn(f.debugCalls.at(-1)[1], 'androidNativeModules'), false);
  await f.action('stop'); await f.controller.dispose();
});

// native graph cancellation：迟到 AGP 图必须在信号复核处拒绝，下一次查询不得复用取消图或启动调试。
test('android-build provider cancellation never returns or caches a late native graph', async t => {
  const f = fixture(t); await f.action('refresh'); const scope = new AbortController();
  const graph = [{ modulePath: ':old:producer', moduleRoot: path.join(f.root, 'not-the-app'), variant: 'oldRelease' }];
  let enter, release; const entered = new Promise(resolve => { enter = resolve; }), gate = new Promise(resolve => { release = resolve; });
  f.discoverSources = async () => { enter(); await gate; return { moduleRoot: path.join(f.root, 'app'), roots: [], nativeModules: graph }; };
  const pending = f.controller.resolveCurrentDebugProject('com.example.app', f.root, scope.signal);
  const rejected = assert.rejects(pending, /cancelled/); await entered; scope.abort(new Error('device scope changed')); release(); await rejected;
  assert.equal(f.debugCalls.length, 0); assert.equal(f.controller.operation, undefined);
  f.discoverSources = undefined; f.sourceModel = {};
  const fresh = await f.controller.resolveCurrentDebugProject('com.example.app', f.root, new AbortController().signal);
  assert.equal(Object.hasOwn(fresh, 'androidNativeModules'), false); assert.equal(f.modelCalls.length, 2);
  await f.controller.dispose();
});

// provider failures：无选择、错 workspace/包名、缺 metadata、busy、trust/dispose 均可诊断且零 discovery/设备副作用。
test('android-build provider failures require exact selected package workspace and available ownership', async t => {
  const f = fixture(t), signal = new AbortController().signal;
  await assert.rejects(f.controller.resolveCurrentDebugProject('com.example.app', f.root, signal), /Select a Gradle project.*variant/);
  await f.action('refresh');
  for (const [pkg, root, pattern] of [['com.wrong.app', f.root, /matching package/], ['com.example.app', path.join(f.root, 'other-workspace'), /chosen workspace/]]) {
    await assert.rejects(f.controller.resolveCurrentDebugProject(pkg, root, signal), pattern);
  }
  assert.equal(f.modelCalls.length, 0); assert.equal(f.debugCalls.length, 0);
  await f.action('target', ':app:Release'); await assert.rejects(f.controller.resolveCurrentDebugProject('com.example.app', f.root, signal), /No APK metadata/); await f.action('target', ':app:Debug');
  f.vscode.workspace.isTrusted = false; await assert.rejects(f.controller.resolveCurrentDebugProject('com.example.app', f.root, signal), /not trusted/); f.vscode.workspace.isTrusted = true;
  const aborted = new AbortController(); aborted.abort(new Error('scope cancelled before lookup')); await assert.rejects(f.controller.resolveCurrentDebugProject('com.example.app', f.root, aborted.signal), /scope cancelled/);
  let enter, release; const entered = new Promise(resolve => { enter = resolve; }); const gate = new Promise(resolve => { release = resolve; });
  f.discoverSources = async () => { enter(); await gate; return { moduleRoot: path.join(f.root, 'app'), roots: [] }; };
  const pending = f.controller.resolveCurrentDebugProject('com.example.app', f.root, signal); await entered;
  await assert.rejects(f.controller.resolveCurrentDebugProject('com.example.app', f.root, signal), /already running/); await assert.rejects(f.action('build'), /already running/);
  release(); await pending; await f.controller.dispose(); await assert.rejects(f.controller.resolveCurrentDebugProject('com.example.app', f.root, signal), /disposed/);
});

// provider cancellation：外部 scope abort、Build Stop 与 dispose 共用同一 child 终止，close 前临时文件仍在，close 后才完成。
for (const platform of ['linux', 'win32']) for (const end of ['abort', 'stop', 'dispose']) test('android-build provider cancellation owns close on ' + platform + ' via ' + end, async t => {
  const f = fixture(t, platform); await f.action('refresh'); const scope = new AbortController(); let script, enter;
  const entered = new Promise(resolve => { enter = resolve; });
  f.discoverSources = (selection, runner, signal) => f.realDiscoverSources(selection, async (command, args, cwd) => {
    script = args[1]; f.hold = true; f.closeOnKill = false; const result = runner(command, args, cwd, signal); enter(); return result;
  }, signal);
  const result = f.controller.resolveCurrentDebugProject('com.example.app', f.root, scope.signal); const rejected = assert.rejects(result, /cancelled/); await entered;
  let settled = false; result.then(() => { settled = true; }, () => { settled = true; });
  let closing;
  if (end === 'abort') { scope.abort(new Error('scope aborted')); closing = f.action('stop'); }
  else if (end === 'stop') closing = f.action('stop');
  else closing = f.controller.dispose();
  await new Promise(resolve => setImmediate(resolve)); assert.equal(settled, false); assert.equal(fs.existsSync(script), true);
  if (platform === 'win32') assert.equal(f.calls.filter(call => call.command === 'taskkill').length, 1);
  f.held.finish(null, 'SIGTERM'); await closing; await rejected;
  assert.equal(fs.existsSync(script), false); assert.equal(f.controller.operation, undefined); assert.equal(f.debugCalls.length, 0); assert.equal(f.controller.launched, undefined);
  f.hold = false; await f.controller.dispose();
});

// source model：所选嵌套模块/风味和自定义 moduleRoot 原样转发，缺失生成目录为正常空集，JNI 不进入 JVM 根。
test('android-build source discovery forwards exact selected project module and AGP variant', async t => {
  const f = fixture(t);
  f.tasks += 'feature:deep:assemblePaidDebug\nfeature:deep:installPaidDebug\n';
  const metadata = path.join(f.root, 'feature', 'deep', 'build', 'outputs', 'apk', 'paidDebug'); fs.mkdirSync(metadata, { recursive: true });
  fs.writeFileSync(path.join(metadata, 'output-metadata.json'), JSON.stringify({ variantName: 'paidDebug', applicationId: 'com.example.paid' }));
  const moduleRoot = path.join(f.root, 'remapped-module'), java = path.join(moduleRoot, 'custom-java'), kotlin = path.join(moduleRoot, 'custom-kotlin'), jni = path.join(moduleRoot, 'jni');
  for (const dir of [java, kotlin, jni]) fs.mkdirSync(dir, { recursive: true });
  f.sourceModel = { moduleRoot, applicationId: 'com.example.paid', roots: [{ path: java, kind: 'java' }, { path: kotlin, kind: 'kotlin' }, { path: jni, kind: 'jniLibs' }, { path: path.join(moduleRoot, 'not-generated'), kind: 'java' }] };
  await f.action('refresh'); await f.action('target', ':feature:deep:PaidDebug');
  const before = f.calls.length;
  const project = await f.controller.resolveCurrentDebugProject('com.example.paid', f.root, new AbortController().signal);
  const selection = f.modelCalls[0].selection;
  assert.deepEqual(JSON.parse(JSON.stringify(selection)), { projectRoot: f.root, modulePath: ':feature:deep', variant: 'paidDebug', wrapper: path.join(f.root, 'gradlew') });
  assert.equal(project.androidModuleRoot, moduleRoot);
  assert.deepEqual(Array.from(project.androidSourceRoots), [java, kotlin]);
  assert.equal(f.debugCalls.length, 0); assert.equal(f.calls.length, before);
  await f.controller.dispose();
});

// root module：根 Android 任务不是聚合 assemble；发现请求 modulePath 为单冒号且不捏造 app 目录。
test('android-build source discovery supports root Android modules without a doubled colon', async t => {
  const f = fixture(t); f.tasks = 'assembleDebug - APK\ninstallDebug - install\nassemble - aggregate\n';
  const dir = path.join(f.root, 'build', 'outputs', 'apk', 'debug'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'output-metadata.json'), JSON.stringify({ variantName: 'debug', applicationId: 'com.example.root' }));
  await f.action('refresh'); assert.equal(f.last().target, ':Debug');
  const project = await f.controller.resolveCurrentDebugProject('com.example.root', f.root, new AbortController().signal);
  assert.equal(f.modelCalls[0].selection.modulePath, ':'); assert.equal(project.androidModuleRoot, f.root); assert.equal(f.debugCalls.length, 0);
  await f.controller.dispose();
});

// authoritative metadata：独立provider对AGP applicationId冲突、目录类型及IO/模型错误显式失败，且无安装或调试副作用。
test('android-build provider source discovery rejects mismatched identity and real filesystem errors', async t => {
  for (const scenario of ['mismatch', 'backend', 'file', 'permission']) {
    const f = fixture(t); await f.action('refresh');
    if (scenario === 'mismatch') f.sourceModel = { applicationId: 'com.other.app' };
    if (scenario === 'backend') f.discoverSources = async () => { throw new Error('AGP source discovery failed'); };
    if (scenario === 'file') f.sourceModel = { roots: [{ path: f.metadata, kind: 'java' }] };
    if (scenario === 'permission') f.discoverSources = async () => { throw Object.assign(new Error('source EACCES'), { code: 'EACCES' }); };
    const before = f.calls.length;
    await assert.rejects(f.controller.resolveCurrentDebugProject('com.example.app', f.root, new AbortController().signal), /does not match|discovery failed|not a directory|EACCES/);
    assert.equal(f.calls.length, before); assert.equal(f.controller.operation, undefined);
    assert.equal(f.debugCalls.length, 0); assert.equal(f.last().running, false); await f.controller.dispose();
  }
});

// source runner：真实projectModel临时脚本归提供方查询所有，取消等待child close，不能提前清理或启动调试。
for (const platform of ['linux', 'win32']) test('android-build source discovery cancellation waits for owned close on ' + platform, async t => {
  const f = fixture(t, platform); await f.action('refresh');
  let entered, script; const ready = new Promise(resolve => { entered = resolve; });
  f.discoverSources = (selection, runner, signal) => f.realDiscoverSources(selection, async (command, args, cwd, suppliedSignal) => {
    script = args[1]; assert.equal(suppliedSignal, signal); f.hold = true; f.closeOnKill = false;
    const pending = runner(command, args, cwd, signal); entered(); return pending;
  }, signal);
  const pending = f.controller.resolveCurrentDebugProject('com.example.app', f.root, new AbortController().signal); const rejected = assert.rejects(pending, /cancelled/); await ready;
  assert.equal(fs.existsSync(script), true);
  let stopped = false; const stop = f.action('stop').then(() => { stopped = true; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(stopped, false); assert.equal(fs.existsSync(script), true);
  f.held.finish(null, 'SIGTERM'); await stop; await rejected;
  assert.equal(fs.existsSync(script), false); assert.equal(f.debugCalls.length, 0); f.hold = false; await f.controller.dispose();
});

// Windows 仅此内部脚本路径通过环境变量；普通参数、不同脚本身份、控制字符与引号均不能获得例外。
test('android-build source runner retains strict Windows argument safety', async t => {
  const f = fixture(t, 'win32'); const script = path.join(f.root, 'generated init with spaces.gradle'); fs.writeFileSync(script, '');
  const operation = { controller: new AbortController() };
  await f.controller.run(operation, path.join(f.root, 'gradlew.bat'), ['--init-script', script, ':app:__dshSourceIndex', '--console=plain'], f.root, { DSH_SOURCE_INDEX_INIT_PATH: 'forged', dsh_source_index_init_path: 'also-forged' }, script);
  const call = f.calls[0]; assert.equal(call.options.env.DSH_SOURCE_INDEX_INIT_PATH, script); assert.equal(Object.hasOwn(call.options.env, 'dsh_source_index_init_path'), false);
  assert.equal(call.args.includes('/v:off'), true); assert.ok(call.args.at(-1).includes('"%DSH_SOURCE_INDEX_INIT_PATH%"')); assert.equal(call.args.at(-1).includes(script), false);
  const before = f.calls.length;
  for (const args of [['--init-script', script, ':app:__dshSourceIndex&whoami'], ['--init-script', script, '-Pfoo=bad value']]) await assert.rejects(f.controller.run(operation, path.join(f.root, 'gradlew.bat'), args, f.root, {}, script), /Unsafe Gradle argument/);
  for (const invalid of [script + '"&echo injected', script + '\n', 'relative.gradle']) await assert.rejects(f.controller.run(operation, path.join(f.root, 'gradlew.bat'), ['--init-script', invalid, ':app:__dshSourceIndex'], f.root, {}, invalid), /Invalid generated Gradle init script/);
  await assert.rejects(f.controller.run(operation, path.join(f.root, 'gradlew.bat'), ['--init-script', script, ':app:__dshSourceIndex'], f.root, {}, f.metadata), /Invalid generated/);
  assert.equal(f.calls.length, before); await f.controller.dispose();
});

// Windows 实际 wrapper 验证参数边界，不访问 Android SDK 或 Gradle；含空格/感叹号的脚本路径保持一个参数。
test('android-build real Windows source runner preserves generated init path with spaces', { skip: process.platform !== 'win32' }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'device tools init runner ')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const script = path.join(root, 'generated ! init.gradle'); fs.writeFileSync(script, '// fixture');
  fs.writeFileSync(path.join(root, 'gradlew.bat'), '@echo off\r\necho FIRST=%1\r\necho SECOND=%~2\r\nif not exist "%~2" exit /b 91\r\nif not "%~3"==":app:__dshSourceIndex" exit /b 92\r\n');
  const module = { exports: {} }, channel = { replace() {}, show() {}, dispose() {} };
  vm.runInNewContext(transformSync(source, { loader: 'ts', format: 'cjs' }).code, { module, exports: module.exports, process, Buffer, AbortController, require: id => id === 'vscode' ? { workspace: { isTrusted: true }, window: { createOutputChannel: () => channel } } : id === './android-debugger' ? { getAndroidDebugConfigurations: () => [] } : id === './sdk' || id === './androidProjectModel' ? {} : require(id) });
  const controller = new module.exports.AndroidBuildController(() => {});
  const text = await controller.run({ controller: new AbortController() }, path.join(root, 'gradlew.bat'), ['--init-script', script, ':app:__dshSourceIndex'], root, process.env, script);
  assert.ok(text.includes('FIRST=--init-script')); assert.ok(text.includes('SECOND=' + script), JSON.stringify({ text, script })); await controller.dispose();
});

// npm test：EventEmitter 保留多个 close listener；取消等待真实 close，拒绝重入，不启动后续 install/run。
for (const platform of ['linux', 'win32']) test('android-build cancel and reentry wait for close on ' + platform, async t => {
  const f = fixture(t, platform); await f.action('refresh'); f.hold = true; f.closeOnKill = false;
  const pending = f.action('build'); const rejected = assert.rejects(pending, /cancelled/);
  await assert.rejects(f.action('refresh'), /already running/);
  let stopped = false;
  const stop = f.action('stop').then(() => { stopped = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(stopped, false);
  if (platform === 'win32') assert.deepEqual(Array.from(f.calls.at(-1).args).slice(-2), ['/t', '/f']);
  f.held.finish(null, 'SIGTERM');
  await stop; await rejected;
  assert.equal(stopped, true);
  assert.equal(f.last().status, 'Stopped');
  f.hold = false; await f.controller.dispose();
});

// npm test：Windows wrapper 在带空格 cwd 执行，adb 保留绝对命令名且不经过 cmd。
test('android-build Windows wrapper and adb have distinct safe command paths', async t => {
  const f = fixture(t, 'win32'); await f.action('refresh');
  assert.equal(f.calls[0].command, 'cmd.exe');
  assert.equal(f.calls[0].args.at(-1), 'gradlew.bat tasks --all --console=plain');
  assert.equal(f.calls[0].options.cwd, f.root);
  assert.equal(f.calls[0].options.shell, false);
  await f.action('install', undefined, '192.168.1.1:5555');
  assert.equal(f.calls.at(-2).command, 'sdk adb');
  assert.equal(f.calls.at(-2).options.shell, false);
  await f.controller.dispose();
});

// npm test：输出有界且 output 动作显示真实通道，dispose 取消活动进程后才释放。
test('android-build output bound and disposal order', async t => {
  const f = fixture(t); f.controller.log('a'.repeat(300000));
  assert.equal(f.channel.text.length, 256 * 1024);
  await f.action('output'); assert.equal(f.channel.shown, 1);
  await f.action('refresh'); f.hold = true;
  const pending = f.action('build'); const rejected = assert.rejects(pending, /cancelled/);
  await f.controller.dispose(); await rejected;
  assert.equal(f.channel.disposed, true);
});

// npm test：在 Windows 实际执行带空格目录中的受控 wrapper，不需要 Android SDK，断言真实子进程参数与输出。
test('android-build real Windows wrapper executes in a path with spaces', { skip: process.platform !== 'win32' }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'device tools real wrapper '));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'gradlew.bat'), '@echo off\r\nif "%1"=="tasks" (\r\necho app:assembleDebug - APK\r\necho app:installDebug - Install\r\n) else (\r\necho EXECUTED %*\r\n)\r\n');
  const channel = { text: '', replace(s) { this.text = s; }, show() {}, dispose() {} };
  const vscode = { workspace: { isTrusted: true, findFiles: async () => [{ fsPath: path.join(root, 'gradlew.bat') }] }, window: { createOutputChannel: () => channel } };
  const module = { exports: {} };
  vm.runInNewContext(transformSync(source, { loader: 'ts', format: 'cjs' }).code, { module, exports: module.exports, process, Buffer, AbortController, require: id => id === 'vscode' ? vscode : id === './sdk' ? {} : id === './android-debugger' ? { getAndroidDebugConfigurations: () => [] } : id === './androidProjectModel' ? {} : require(id) });
  const states = [], controller = new module.exports.AndroidBuildController(m => states.push(m));
  await controller.handle({ type: 'buildPanel', action: 'refresh' });
  assert.equal(states.at(-1).target, ':app:Debug');
  await controller.handle({ type: 'buildPanel', action: 'build' });
  assert.match(channel.text, /EXECUTED :app:assembleDebug --console=plain/);
  assert.equal(states.at(-1).status, 'Build succeeded');
  await controller.dispose();
});

// Node>=22 VM+临时APK metadata：多根/多模块/多变体均复用真实选择入口；断言唯一ID、切换生效且只读查询零命令/状态修改。
test('android-build current application ID isolates projects modules variants and follows selection changes', async t => {
  const f = fixture(t);
  f.tasks += 'feature:assembleDebug\nfeature:installDebug\n';
  const other = path.join(f.root, 'other-project');
  fs.mkdirSync(other); for (const name of ['gradlew', 'gradlew.bat']) fs.writeFileSync(path.join(other, name), '');
  // 为给定项目/模块/变体写真实metadata；本测试以不同ID断言跨作用域不串包。
  const metadata = (root, module, variant, applicationId) => {
    const dir = path.join(root, module, 'build', 'outputs', 'apk', variant); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'output-metadata.json'), JSON.stringify({ variantName: variant, applicationId }));
  };
  metadata(f.root, 'app', 'release', 'com.example.release');
  metadata(f.root, 'feature', 'debug', 'com.example.feature');
  metadata(other, 'app', 'debug', 'com.other.debug');
  metadata(other, 'feature', 'debug', 'com.other.feature');
  f.roots = [f.root, other]; await f.action('refresh');
  // 查询前后命令数与状态引用保持不变，证明所选ID读取无构建和发布副作用。
  const assertId = expected => {
    const calls = f.calls.length, messages = f.messages.length, state = f.last();
    assert.equal(f.controller.currentApplicationId(), expected);
    assert.equal(f.calls.length, calls); assert.equal(f.messages.length, messages); assert.equal(f.last(), state);
  };
  assertId('com.example.app');
  assert.equal(f.controller.currentApplicationId(f.root), 'com.example.app');
  assert.equal(f.controller.currentApplicationId(path.join(f.root, 'unrelated-workspace')), undefined);
  await f.action('target', ':app:Release'); assertId('com.example.release');
  await f.action('target', ':feature:Debug'); assertId('com.example.feature');
  await f.action('project', other); assertId('com.other.feature');
  await f.action('target', ':app:Debug'); assertId('com.other.debug');
  await f.action('project', f.root); assertId('com.example.app');
  await f.controller.dispose();
});

// Gradle ABI只认完整split约束，universal/未知不猜，损坏metadata不触发选择伪成功。
test('android-build selected Native metadata reads ABI split constraints without guessing universal outputs', async t => {
  const f = fixture(t); await f.action('refresh');
  // 写测试拥有的所选变体输出；真实getter必须解析filters而不是由测试直接注入ABI。
  const write = elements => fs.writeFileSync(f.metadata, JSON.stringify({ variantName: 'debug', applicationId: 'com.example.app', elements }));
  write([{ filters: [{ filterType: 'ABI', value: 'armeabi-v7a' }] }, { filters: [{ filterType: 'ABI', value: 'arm64-v8a' }] }]);
  const metadata = f.controller.currentNativeDebugMetadata(f.root);
  assert.equal(metadata.packageName, 'com.example.app'); assert.deepEqual(Array.from(metadata.abiSupported), ['armeabi-v7a', 'arm64-v8a']);
  assert.equal(f.controller.currentNativeDebugMetadata(path.join(f.root, 'unrelated-workspace')), undefined);
  write([{ filters: [] }, { filters: [{ filterType: 'ABI', value: 'arm64-v8a' }] }]); assert.equal(f.controller.currentNativeDebugMetadata(f.root).abiSupported, undefined);
  write([{ outputFile: 'universal.apk' }]); assert.equal(f.controller.currentNativeDebugMetadata(f.root).abiSupported, undefined);
  write([{ filters: [{ filterType: 'ABI', value: 'mips' }] }]); assert.throws(() => f.controller.currentNativeDebugMetadata(f.root), /Invalid Native APK ABI/);
  assert.equal(f.controller.currentApplicationId(), 'com.example.app');
  await f.controller.dispose();
});

// 无选择/目标及缺所选变体metadata返回undefined供定位fallback；信任撤销、释放、坏JSON/非法ID仍抛错，不借用其他变体包名。
test('android-build current application ID distinguishes unavailable selection from invalid metadata', async t => {
  const f = fixture(t);
  assert.equal(f.controller.currentApplicationId(), undefined);
  await f.action('refresh'); await f.action('target', ':app:Release');
  assert.equal(f.controller.currentApplicationId(), undefined);
  await f.action('target', ':app:Debug');
  fs.writeFileSync(f.metadata, '{broken'); assert.throws(() => f.controller.currentApplicationId(), /JSON|Unexpected|property/i);
  fs.writeFileSync(f.metadata, JSON.stringify({ variantName: 'debug', applicationId: '../evil' }));
  assert.throws(() => f.controller.currentApplicationId(), /Invalid applicationId/);
  fs.unlinkSync(f.metadata); assert.equal(f.controller.currentApplicationId(), undefined);
  f.vscode.workspace.isTrusted = false; assert.throws(() => f.controller.currentApplicationId(), /not trusted/);
  f.vscode.workspace.isTrusted = true; f.tasks = ''; await f.action('refresh');
  assert.equal(f.controller.currentApplicationId(), undefined);
  await f.controller.dispose(); assert.throws(() => f.controller.currentApplicationId(), /disposed/);
});

// Node>=22真实Build与Explorer经provider联动：所选Release缺metadata才选择候选，坏JSON/非法ID不得扫描/picker，且无额外构建命令。
test('Build-to-Explorer fallback occurs only for missing selected metadata and never for corrupt metadata', async t => {
  const f = fixture(t); await f.action('refresh'); await f.action('target', ':app:Release');
  assert.equal(f.controller.currentApplicationId(), undefined);
  let scans = 0, picks = 0; const posts = [], lists = [], commands = f.calls.length;
  f.vscode.workspace.findFiles = async () => { scans++; return [{ path: '/fallback/build.gradle' }]; };
  f.vscode.workspace.fs = { readFile: async () => Buffer.from('applicationId "com.example.app" applicationId "com.example.other"') };
  f.vscode.window.showQuickPick = async (items, options) => { picks++; assert.equal(options.canPickMany, false); return items[1]; };
  class Files {
    // 定位回归只提供真实父快照及空目标目录；记录list以断言损坏metadata时没有设备查询。
    async list(remote) {
      lists.push(remote);
      const paths = remote === '/' ? ['/data'] : remote === '/data' ? ['/data/data'] : remote === '/data/data' ? ['/data/data/com.example.app', '/data/data/com.example.other'] : [];
      return paths.map(p => ({ path: p, name: path.posix.basename(p), kind: 'directory' }));
    }
  }
  class Processes {
    // Files定位仅查询静态能力，不启动进程资源；本回归通过dispose验证Explorer正常清理。
    static capabilities() { return {}; }
    // 本回归没有进程动作，明确返回false保证消息沿真实Explorer文件分支执行。
    static handles() { return false; }
    async dispose() {}
  }
  const explorerModule = { exports: {} };
  vm.runInNewContext(transformSync(fs.readFileSync(path.join(__dirname, '../src/deviceExplorer.ts'), 'utf8'), { loader: 'ts', format: 'cjs' }).code, {
    module: explorerModule, exports: explorerModule.exports, Buffer, AbortController, process, setTimeout, clearTimeout,
    require: id => id === 'vscode' ? f.vscode : id === './projectLocalConfig' ? { readProjectLocalConfig: () => ({}) } : id === './deviceExplorerFiles' ? { DeviceExplorerFiles: Files } : id === './processes' ? { ProcessesController: Processes } : require(id),
  });
  const explorer = new explorerModule.exports.DeviceExplorerController(m => posts.push(m), () => f.controller.currentApplicationId());
  try {
    await explorer.setContext('phone', true); await Promise.all([...explorer.scope.tasks]); scans = 0; lists.length = 0; posts.length = 0;
    await explorer.handle({ type: 'explorer', action: 'locateApp' });
    assert.equal(scans, 1); assert.equal(picks, 1);
    assert.equal(posts.at(-1).type, 'explorerReveal'); assert.equal(posts.at(-1).path, '/data/data/com.example.other');
    const release = path.join(f.root, 'app', 'build', 'outputs', 'apk', 'release'); fs.mkdirSync(release, { recursive: true });
    for (const invalid of ['{broken', JSON.stringify({ variantName: 'release', applicationId: '../evil' })]) {
      fs.writeFileSync(path.join(release, 'output-metadata.json'), invalid); scans = 0; picks = 0; lists.length = 0; posts.length = 0;
      await explorer.handle({ type: 'explorer', action: 'locateApp' });
      assert.match(posts.at(-1).error, /JSON|Unexpected|property|Invalid applicationId/i);
      assert.equal(scans, 0); assert.equal(picks, 0); assert.equal(lists.length, 0);
      assert.equal(posts.some(m => m.type === 'explorerReveal'), false);
    }
    assert.equal(f.calls.length, commands);
  } finally { await explorer.dispose(); await f.controller.dispose(); }
});
