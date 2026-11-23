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
const autoModule = { exports: {} };
vm.runInNewContext(transformSync(fs.readFileSync(path.join(__dirname, '../src/android-debugger/autoConfig.ts'), 'utf8'), { loader: 'ts', format: 'cjs' }).code, { module: autoModule, exports: autoModule.exports });
const autoApi = autoModule.exports;
const tasks = 'app:assembleDebug - APK\n:app:installDebug - install\napp:assembleRelease\napp:installRelease\nassemble - aggregate\napp:test - tests\n';

// 功能点：Build 的调试启动取消、清理互斥及 Run 子进程关闭边界。
// 受影响对象：AndroidBuildController.stop/handle/execute、真实 index/startup、宿主启动与终止监听及 OwnedProcess。
// 复现路径：刷新受控工程，显式报告独立 connected，挂起宿主启动，Stop 后报告两个匹配会话，结算宿主并逐个终止；另在 Run 子进程 close 前停止。
// 测试范围：同步和微任务快照、立即取消、cleanup 等待、重叠操作拒绝、重复 Stop、foreign 隔离及 Run 的真实 close 屏障。
// 执行入口：node --test tests/android-build.test.js；npm test。
// 预期结果：Stop 立即发布 busy=false/running=false/stopping=true，清理完成后 Stopped 且监听归零；Run 不提前越过 close。
// 判据：快照、Promise 状态、停止次数和精确对象、监听数及后续命令全部符合断言，不代替真实宿主或设备验证。
// 创建临时工程及真实 EventEmitter 子进程替身；只替换设备和宿主边界，真实启动取消模块保持可执行。
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
      // 功能：模拟宿主会话及独立连接结算；输入映射配置；输出转换后的真实类型事件，终止不等同连接成功。
      startDebugging: async (...args) => {
        f.debugCalls.push(args);
        if (f.debugResult) {
          const config = args[1];
          const session = { id: 'debug-' + f.debugCalls.length, configuration: { ...config, type: config.type === 'android-debug' ? (config.mode === 'java' ? 'android-jvm' : 'android-tools') : config.type, ...(f.resolvedPackage ? { packageName: f.resolvedPackage } : {}) } };
          startup.reportDebugConnection(session.configuration, Promise.resolve());
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
  const startup = require('./debug-startup-loader.cjs')();
  f.startup = startup;
  vm.runInNewContext(transformSync(debuggerSource, { loader: 'ts', format: 'cjs' }).code, { module: debuggerModule, exports: debuggerModule.exports, AbortController, console, require: id => id === './startup' ? startup : id === 'vscode' ? vscode : id === './autoConfig' || id === './android-debugger/autoConfig' ? autoApi : require(id), Promise });
  const debugApi = { ...debuggerModule.exports, startAndroidDebugging: async (folder, config, target) => {
    (f.debugRequests ??= []).push({ folder, config, target });
    return debuggerModule.exports.startAndroidDebugging(folder, config, target);
  } };
  const module = { exports: {} };
  vm.runInNewContext(transformSync(source, { loader: 'ts', format: 'cjs' }).code, {
    module, exports: module.exports, Buffer, AbortController, console,
    process: { platform, env: {}, kill: pid => { assert.equal(pid, -f.held.pid); if (f.closeOnKill) f.held.finish(null, 'SIGTERM'); } },
    require: id => id === 'vscode' ? vscode : id === 'child_process' ? cp : id === './sdk' ? { adbPath: () => 'sdk adb' } : id === './android-debugger' ? debugApi : id === './autoConfig' || id === './android-debugger/autoConfig' ? autoApi : id === './androidProjectModel' ? projectModel : id === './gradleTooling' ? { GradleToolingClient: class {
      async query(root, signal) { if (f.toolingTasks) return f.toolingTasks; return f.parse(await f.controller.run({ controller: { signal } }, 'tooling-api', ['tasks'], root)); }
      async dispose() {}
    } } : require(id),
  });
  f.cache = undefined; f.cacheWrites = [];
  f.storage = { get: () => f.cache, update: async (key, value) => {
    if (f.cacheFailure) throw f.cacheFailure;
    f.cacheWrites.push({ key, value }); f.cache = value;
  } };
  vscode.workspace.workspaceFolders = [{ uri: { fsPath: root } }];
  f.controller = new module.exports.AndroidBuildController(m => f.messages.push(m), '', f.storage);
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
  const calls = f.calls.length;
  await f.action('refresh');
  assert.equal(f.last().target, ':app:Release');
  assert.equal(f.calls.length, calls + 1);
  await assert.rejects(f.action('project', 'forged'), /Invalid project/);
  await assert.rejects(f.action('target', ':evil:Debug'), /Invalid target/);
  await f.action('project', f.root);
  await f.controller.dispose();
});

// 工作区缓存立即回显且保持busy，sync和刷新共用正式查询，完成后才保存新结果并Ready。
test('android-build startup cache stays loading until the authoritative refresh completes', async t => {
  const f = fixture(t);
  f.cache = { projects: [{ root: f.root, tasks: [':cached:assembleDemoDebug', ':cached:installDemoDebug'] }] };
  const cached = f.cache;
  f.hold = true;
  const startup = f.controller.initialize();
  assert.equal(f.controller.initialize(), startup);
  assert.equal(f.controller.currentApplicationId(), undefined);
  assert.equal(f.controller.currentNativeDebugMetadata(), undefined);
  await assert.rejects(f.controller.resolveCurrentDebugProject('com.example.app', f.root, new AbortController().signal), /already running/);
  assert.equal(f.last().busy, true);
  assert.equal(f.last().target, ':cached:DemoDebug');
  assert.notEqual(f.last().status, 'Ready');
  assert.equal(f.cacheWrites.length, 0);
  await f.action('sync');
  assert.equal(f.last().busy, true);
  assert.equal(f.last().target, ':cached:DemoDebug');
  await new Promise(resolve => setImmediate(resolve));
  const concurrent = f.action('refresh');
  assert.equal(f.calls.length, 1);
  await assert.rejects(f.action('build'), /already running/);
  f.hold = false; f.held.stdout.emit('data', Buffer.from(tasks)); f.held.finish();
  await Promise.all([startup, concurrent]);
  assert.equal(f.last().busy, false);
  assert.equal(f.last().target, ':app:Debug');
  assert.equal(f.last().status, 'Ready');
  assert.equal(f.controller.currentApplicationId(), 'com.example.app');
  const reads = f.cacheWrites.length;
  await f.controller.initialize();
  assert.equal(f.cacheWrites.length, reads);
  assert.equal(f.cacheWrites.length, 1);
  assert.notEqual(f.cache, cached);
  assert.ok(f.cache.projects[0].tasks.includes(':app:assembleDebug'));
  assert.ok(f.cache.projects[0].tasks.every(task => /:(assemble|install)/.test(task)));
  f.hold = true;
  const refresh = f.action('refresh');
  assert.equal(f.last().target, ':app:Debug');
  assert.equal(f.last().busy, true);
  await new Promise(resolve => setImmediate(resolve));
  f.hold = false; f.held.stdout.emit('data', Buffer.from(tasks)); f.held.finish();
  await refresh;
  await f.controller.dispose();
  const restored = [];
  const reopened = new f.controller.constructor(message => restored.push(message), '', f.storage);
  f.hold = true;
  const reload = reopened.initialize();
  assert.equal(restored.at(-1).target, ':app:Debug');
  assert.equal(restored.at(-1).busy, true);
  await new Promise(resolve => setImmediate(resolve));
  f.hold = false; f.held.stdout.emit('data', Buffer.from(tasks)); f.held.finish();
  await reload;
  assert.equal(restored.at(-1).busy, false);
  await reopened.dispose();
});

// 正式刷新失败不能以缓存伪成功，也不能污染上次成功缓存；恢复后可正常更新。
test('android-build startup failure ends loading and preserves only the successful cache', async t => {
  const f = fixture(t);
  f.cache = { projects: [{ root: f.root, tasks: [':app:assembleRelease', ':app:installRelease'] }] };
  const cache = f.cache;
  f.fail = 'Gradle startup failed';
  await assert.rejects(f.controller.initialize(), /Gradle startup failed/);
  assert.equal(f.last().busy, false);
  assert.equal(f.last().status, 'Failed');
  assert.match(f.last().error, /Gradle startup failed/);
  assert.equal(f.last().targets.length, 0);
  assert.equal(f.cache, cache);
  assert.equal(f.cacheWrites.length, 0);
  await f.action('refresh');
  assert.equal(f.last().status, 'Ready');
  assert.equal(f.cacheWrites.length, 1);
  await f.controller.dispose();
});

// 查询取消不得写入缓存，持久化未结束时也不能提前结束loading，缓存存储故障需如实报错。
test('android-build startup cancellation and cache persistence preserve loading ownership', async t => {
  const f = fixture(t);
  f.cache = { projects: [{ root: f.root, tasks: [':app:assembleRelease', ':app:installRelease'] }] };
  const cache = f.cache;
  f.hold = true;
  const pending = f.controller.initialize();
  const cancelled = assert.rejects(pending, /cancelled/);
  await new Promise(resolve => setImmediate(resolve));
  await f.action('stop'); await cancelled;
  assert.equal(f.cache, cache);
  assert.equal(f.cacheWrites.length, 0);
  assert.equal(f.last().busy, false);
  f.hold = false;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const update = f.storage.update;
  f.storage.update = async (...args) => { await gate; return update(...args); };
  const refresh = f.action('refresh');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.last().busy, true);
  assert.notEqual(f.last().status, 'Ready');
  release(); await refresh;
  assert.equal(f.last().status, 'Ready');
  f.cacheFailure = new Error('workspace storage failed');
  await assert.rejects(f.action('refresh'), /workspace storage failed/);
  assert.equal(f.last().busy, false);
  assert.match(f.last().error, /workspace storage failed/);
  await f.controller.dispose();
});

// 无缓存仍立即加载，工作区外缓存不回显，空工程的成功结果可以清除旧缓存。
test('android-build initialization isolates workspace cache and persists an empty project result', async t => {
  const f = fixture(t);
  f.cache = { projects: [{ root: path.join(f.root, '..', 'unrelated'), tasks: [':app:assembleDebug', ':app:installDebug'] }] };
  f.roots = [];
  const startup = f.controller.initialize();
  assert.equal(f.last().busy, true);
  assert.equal(f.last().targets.length, 0);
  await startup;
  assert.equal(f.last().status, 'No Gradle project');
  assert.equal(f.last().busy, false);
  assert.equal(f.cache.projects.length, 0);
  await f.controller.dispose();
});

// 空缓存首次启动也发布busy；读取缓存异常必须以Promise拒绝返回，供激活入口统一报告。
test('android-build initialization without cache loads once and cache read errors reject asynchronously', async t => {
  const f = fixture(t); f.hold = true;
  const startup = f.controller.initialize();
  assert.equal(f.last().busy, true);
  assert.equal(f.last().projects.length, 0);
  await f.action('sync');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.calls.length, 1);
  f.hold = false; f.held.stdout.emit('data', Buffer.from(tasks)); f.held.finish();
  await startup;
  assert.equal(f.last().status, 'Ready');
  assert.equal(f.cacheWrites[0].key, 'android-ide.gradleProjects.v1');
  await f.controller.dispose();
  const g = fixture(t);
  g.storage.get = () => { throw new Error('cache read failed'); };
  let pending;
  assert.doesNotThrow(() => { pending = g.controller.initialize(); });
  await assert.rejects(pending, /cache read failed/);
  assert.equal(g.calls.length, 0);
  assert.equal(g.last().status, 'Failed');
  assert.equal(g.last().busy, false);
  assert.equal(g.last().targets.length, 0);
  await g.action('sync');
  assert.match(g.last().error, /cache read failed/);
  await g.controller.dispose();
});

// 多根查询第二项失败不能保存半份新缓存；工作区内嵌套根可回显，相邻前缀目录不能混入。
test('android-build multi-root startup preserves the previous cache when a later root fails', async t => {
  const f = fixture(t);
  const nested = path.join(f.root, 'nested'); fs.mkdirSync(nested);
  for (const file of ['gradlew', 'gradlew.bat']) fs.writeFileSync(path.join(nested, file), '');
  f.roots = [f.root, nested];
  f.cache = { projects: [f.root, nested, f.root + '-other'].map(root => ({ root, tasks: [':app:assembleDebug', ':app:installDebug'] })) };
  const cached = f.cache;
  f.hold = true;
  const startup = f.controller.initialize();
  const failed = assert.rejects(startup, /second root failed/);
  assert.deepEqual(Array.from(f.last().projects, project => project.id), [f.root, nested]);
  await new Promise(resolve => setImmediate(resolve));
  f.held.stdout.emit('data', Buffer.from(tasks)); f.held.finish();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.calls.length, 2);
  f.held.stderr.emit('data', Buffer.from('second root failed')); f.held.finish(1);
  await failed;
  assert.equal(f.cache, cached);
  assert.equal(f.cacheWrites.length, 0);
  assert.equal(f.last().busy, false);
  assert.equal(f.last().projects.length, 0);
  f.hold = false; await f.controller.dispose();
});

// 多工作区缓存经过序列化重开后仍可回显；新查询移除的工程及已消失变体不能留在正式结果中。
test('android-build serialized multi-workspace cache is replaced by the authoritative project list', async t => {
  const f = fixture(t);
  const other = path.join(f.root, 'second'); fs.mkdirSync(other);
  for (const file of ['gradlew', 'gradlew.bat']) fs.writeFileSync(path.join(other, file), '');
  f.vscode.workspace.workspaceFolders = [{ uri: { fsPath: f.root } }, { uri: { fsPath: other } }];
  f.cache = JSON.parse(JSON.stringify({ projects: [
    { root: f.root, tasks: [':app:assembleOldDebug', ':app:installOldDebug'] },
    { root: other, tasks: [':feature:assemblePaidDebug', ':feature:installPaidDebug'] },
  ] }));
  f.roots = [other]; f.hold = true;
  const startup = f.controller.initialize();
  assert.equal(f.last().projects.length, 2);
  assert.equal(f.last().target, ':app:OldDebug');
  assert.equal(f.last().busy, true);
  await new Promise(resolve => setImmediate(resolve));
  f.hold = false; f.held.stdout.emit('data', Buffer.from('feature:assemblePaidDebug\nfeature:installPaidDebug\n')); f.held.finish();
  await startup;
  assert.deepEqual(Array.from(f.last().projects, project => project.id), [other]);
  assert.equal(f.last().target, ':feature:PaidDebug');
  assert.equal(f.last().busy, false);
  assert.deepEqual(Array.from(f.cache.projects, project => project.root), [other]);
  assert.equal(f.last().targets.some(target => target.variant === 'OldDebug'), false);
  await f.controller.dispose();
});

// 缓存不能绕过工作区信任；未受信任时不查询、不写缓存，错误快照可供晚订阅回放。
test('android-build cached startup respects workspace trust and does not query Gradle', async t => {
  const f = fixture(t);
  f.cache = { projects: [{ root: f.root, tasks: [':app:assembleDebug', ':app:installDebug'] }] };
  f.vscode.workspace.isTrusted = false;
  await assert.rejects(f.controller.initialize(), /not trusted/);
  assert.equal(f.calls.length, 0);
  assert.equal(f.cacheWrites.length, 0);
  assert.equal(f.last().busy, false);
  assert.equal(f.last().status, 'Unavailable');
  assert.equal(f.last().projects.length, 0);
  assert.equal(f.last().targets.length, 0);
  await f.action('sync');
  assert.match(f.last().error, /not trusted/);
  await f.controller.dispose();
});

// 损坏的持久化缓存必须发布失败快照，不能把旧快照留给后来打开的面板或触发真实查询。
test('android-build invalid cache publishes a failed state without using stale projects', async t => {
  for (const cached of [{}, { projects: null }, { projects: [{ root: 'relative', tasks: [] }] },
    { projects: [{ root: os.tmpdir(), tasks: [null] }] }]) {
    const f = fixture(t); f.cache = cached;
    await assert.rejects(f.controller.initialize(), /Invalid Gradle project cache/);
    assert.equal(f.last().status, 'Failed');
    assert.equal(f.last().busy, false);
    assert.equal(f.last().projects.length, 0);
    assert.equal(f.last().targets.length, 0);
    assert.equal(f.calls.length, 0);
    assert.equal(f.cacheWrites.length, 0);
    const failed = f.last(); await f.action('sync'); assert.equal(f.last(), failed);
    await f.controller.dispose();
  }
});

// 已验证的真实结果进入不可取消存储提交后，Stop等待落盘；界面不发布Ready，下一次启动可重新验证该成功结果。
test('android-build stop during cache commit waits for storage and never publishes Ready', async t => {
  const f = fixture(t);
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const update = f.storage.update;
  f.storage.update = async (...args) => { entered(); await gate; return update(...args); };
  const pending = f.controller.initialize();
  const cancelled = assert.rejects(pending, /cancelled/);
  await started;
  assert.equal(f.controller.currentApplicationId(), undefined);
  let stopped = false;
  const stop = f.action('stop').then(() => { stopped = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(stopped, false);
  assert.equal(f.last().busy, false);
  assert.equal(f.last().running, false);
  assert.equal(f.last().stopping, true);
  assert.equal(f.messages.some(message => message.status === 'Ready'), false);
  release(); await stop; await cancelled;
  assert.equal(f.last().status, 'Stopped');
  assert.equal(f.last().busy, false);
  assert.equal(f.last().targets.length, 0);
  assert.equal(f.controller.currentApplicationId(), undefined);
  assert.equal(f.cacheWrites.length, 1);
  assert.ok(f.cache.projects[0].tasks.includes(':app:assembleDebug'));
  await f.controller.dispose();
});

// 大型工程的任务模型不经过256KiB日志缓冲；四组风味与安装任务完整保留。
test('android-build discovers flavored variants from models larger than the log limit', async t => {
  const f = fixture(t);
  const variants = ['CnPhoneDebug', 'CnTabletDebug', 'GlobalPhoneDebug', 'GlobalTabletDebug'];
  f.toolingTasks = variants.flatMap(variant => [':app:assemble' + variant, ':app:install' + variant]);
  f.toolingTasks.push(...Array.from({ length: 8000 }, (_, i) => ':module:generateUnrelatedAndroidResourceTask' + i));
  assert.ok(f.toolingTasks.join('\n').length > 256 * 1024);
  await f.action('refresh');
  assert.deepEqual(Array.from(f.last().targets, target => target.variant), variants);
  assert.equal(f.calls.length, 0);
  assert.equal(f.last().busy, false);
  await f.controller.dispose();
});

// 实际Controller连接打包Tooling服务；显式工程环境断言多风味选择，不启动安装、构建或设备命令。
test('android-build actual Tooling API discovers the selected project variants', { skip: !process.env.DSH_GRADLE_TEST_ANDROID_ROOT }, async t => {
  const root = process.env.DSH_GRADLE_TEST_ANDROID_ROOT;
  const toolingModule = { exports: {} };
  vm.runInNewContext(transformSync(fs.readFileSync(path.join(__dirname, '../src/gradleTooling.ts'), 'utf8'), { loader: 'ts', format: 'cjs' }).code, { module: toolingModule, exports: toolingModule.exports, process, Buffer, require });
  const states = [];
  const vscode = {
    workspace: { isTrusted: true, findFiles: async () => [{ fsPath: path.join(root, 'settings.gradle.kts') }] },
    window: { createOutputChannel: () => ({ replace() {}, dispose() {} }) },
  };
  const module = { exports: {} };
  vm.runInNewContext(transformSync(source, { loader: 'ts', format: 'cjs' }).code, { module, exports: module.exports, Buffer, process, AbortController,
    require: id => id === 'vscode' ? vscode : id === './gradleTooling' ? toolingModule.exports : id === './android-debugger' ? { getAndroidDebugConfigurations: () => [] } : id === './autoConfig' || id === './android-debugger/autoConfig' ? autoApi : id === './sdk' || id === './androidProjectModel' ? {} : require(id) });
  const controller = new module.exports.AndroidBuildController(state => states.push(state), path.resolve(__dirname, '..'));
  t.after(() => controller.dispose());
  const times = [];
  for (let i = 0; i < 6; i++) {
    const start = performance.now();
    await controller.handle({ type: 'buildPanel', action: 'refresh' });
    times.push(Math.round(performance.now() - start));
    const expected = JSON.parse(process.env.DSH_GRADLE_TEST_EXPECTED_VARIANTS || '["Debug"]');
    assert.deepEqual(Array.from(states.at(-1).targets, target => target.variant), expected);
    assert.equal(states.at(-1).busy, false);
  }
  t.diagnostic(JSON.stringify({ firstMs: times[0], stableMs: times.slice(1), targets: Array.from(states.at(-1).targets, target => target.id) }));
  if (process.env.DSH_GRADLE_TEST_STATE_OUTPUT) fs.writeFileSync(process.env.DSH_GRADLE_TEST_STATE_OUTPUT, JSON.stringify(states.at(-1)));
});

// npm test：并发Gradle刷新共享同一模型查询，不重复执行，也不把相同请求误报为busy。
test('android-build concurrent refreshes share the active discovery', async t => {
  const f = fixture(t); f.hold = true;
  const first = f.action('refresh');
  await new Promise(resolve => setImmediate(resolve));
  const second = f.action('refresh');
  assert.equal(f.calls.length, 1);
  f.hold = false; f.held.stdout.emit('data', Buffer.from(tasks)); f.held.finish();
  await Promise.all([first, second]);
  assert.equal(f.last().target, ':app:Debug');
  await f.controller.dispose();
});

// npm test：双面板sync在发现、运行、失败和停止阶段只回放同一快照，不重入任务或清除选择。
test('android-build sync replays shared state without repeating discovery or losing lifecycle', async t => {
  const f = fixture(t);
  f.hold = true;
  const initial = f.action('sync');
  await new Promise(resolve => setImmediate(resolve));
  const count = f.calls.length;
  await f.action('sync');
  assert.equal(f.last().busy, true);
  assert.equal(f.calls.length, count);
  f.hold = false; f.held.stdout.emit('data', Buffer.from(tasks)); f.held.finish();
  await initial;
  await f.action('target', ':app:Release');
  await f.action('runMode', 'debug-0');
  assert.equal(f.last().gradleLoading, false);
  const selected = f.last();
  await f.action('sync'); assert.equal(f.last(), selected);
  await f.action('target', ':app:Debug'); await f.action('runMode', 'run');
  await f.action('run', undefined, 'phone');
  const running = f.last(); await f.action('sync'); assert.equal(f.last(), running); assert.equal(f.last().running, true);
  await f.action('stop'); const stopped = f.last(); await f.action('sync'); assert.equal(f.last(), stopped); assert.equal(f.last().running, false);
  f.fail = 'Gradle sync failure'; await assert.rejects(f.action('build'), /Gradle sync failure/);
  const failed = f.last(), commands = f.calls.length;
  await f.action('sync'); assert.equal(f.last(), failed); assert.match(f.last().error, /Gradle sync failure/); assert.equal(f.calls.length, commands);
  await f.controller.dispose();
});

// npm test：Gradle Wrapper失败需带项目根和原始输出，失败清空旧选择，下一次显式刷新可重新获取项目和变体。
test('android-build Gradle discovery failure is diagnosable and recoverable', async t => {
  const f = fixture(t);
  await f.action('refresh');
  assert.equal(f.last().projects.length, 1);
  fs.appendFileSync(path.join(f.root, 'settings.gradle.kts'), '\n// changed\n');
  f.fail = 'Could not resolve plugin';
  await assert.rejects(f.action('refresh'), error => {
    assert.ok(error.message.includes('Gradle Project discovery failed in ' + f.root));
    assert.match(error.message, /Could not resolve plugin/);
    return true;
  });
  assert.deepEqual(Array.from(f.last().projects), []);
  assert.deepEqual(Array.from(f.last().targets), []);
  await f.action('refresh');
  assert.equal(f.last().projects.length, 1);
  assert.equal(f.last().target, ':app:Debug');
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
  f.configs = [{ name: 'Android: Native Debug Launch', type: 'adapter', request: 'attach' }];
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
    assert.equal(config.native?.abi, undefined);
    if (config.native) assert.deepEqual(JSON.parse(JSON.stringify(config.native.symbolSearchPaths ?? [])), []);
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
  for (const type of ['android-debug', 'android-tools', 'android-jvm', 'third-party']) {
    const selected = { name: 'Android: Native Debug Launch', type, request: 'launch', ...(type === 'android-jvm' ? { android: true } : {}),
      mode: type === 'android-tools' ? 'native' : 'dual', packageName: 'com.user.chosen', target: 'explicit-target', serial: 'explicit-serial',
      apkPath: '/explicit/app.apk', androidProjectRoot: '/explicit/root', preLaunchTask: 'user task', sourcePaths: ['top-src'],
      java: { type: 'android-jvm', sourcePaths: ['java-src'] }, native: { abi: 'x86', symbolSearchPaths: ['symbols'] } };
    f.configs = [selected]; fs.writeFileSync(f.metadata, '{invalid metadata must not be read');
    const snapshot = JSON.stringify(selected), before = f.calls.length;
    await f.action('debug', undefined, 'phone');
    const requested = f.debugCalls.at(-1)[1];
    const forwarded = f.debugRequests.at(-1);
    assert.equal(forwarded.config.serial, 'explicit-serial'); assert.equal(forwarded.config.target, 'explicit-target');
    assert.deepEqual(Object.keys(forwarded.target).sort(), ['onStartupCleanup', 'packageName', 'serial', 'signal']);
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

// 启动事件与真实连接分开报告；立即终止和启动取消仍必须释放状态，取消后 detach 只发生一次。
test('android-build immediate termination and startup cancellation release owned resources', async t => {
  const f = fixture(t); await f.action('refresh'); f.terminateImmediately = true;
  await assert.rejects(f.action('debug', undefined, 'phone'), /did not report a live start/);
  assert.equal(f.controller.debugSession, undefined); assert.equal(f.controller.launched, undefined);
  assert.equal(f.debugStartListeners.size, 0); assert.equal(f.debugTerminationListeners.size, 0);
  assert.equal(f.stoppedDebug, undefined);
  f.terminateImmediately = false;
  let cancelledCleanup;
  f.onDebugStart = () => { cancelledCleanup = f.controller.operation; cancelledCleanup.controller.abort(); };
  await assert.rejects(f.action('debug', undefined, 'phone'), error => error?.name === 'AbortError' || /cancelled/.test(String(error)));
  await cancelledCleanup.debugCleanup;
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
    assert.deepEqual(JSON.parse(JSON.stringify(requested.native)), { symbolSearchPaths: [] });
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
  f.configs = [{ name: 'Android: Native Debug Launch', type: 'adapter', request: 'launch' }, { name: 'Android: Native Debug Attach', type: 'adapter', request: 'attach' }];
  f.pickIndex = undefined;
  const callsBeforeCancel = f.calls.length, debugBeforeCancel = f.debugCalls.length;
  f.choose = false; await f.action('debug', undefined, 'phone'); assert.equal(f.last().status, 'Debug cancelled');
  assert.equal(f.calls.length, callsBeforeCancel); assert.equal(f.debugCalls.length, debugBeforeCancel);
  const modelCount = f.modelCalls.length, navigationCount = f.commands.length;
  f.choose = true; await f.action('debug', undefined, 'phone');
  assert.equal(f.modelCalls.length, modelCount);
  assert.equal(f.commands.length, navigationCount + 1);
  assert.equal(f.debugCalls.at(-1)[1].name, 'Android: Native Debug Attach');
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
  f.configs = [{ name: 'Android: Native Debug Launch', type: 'third-party', request: 'attach', custom: 'preserved' }];
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
  vm.runInNewContext(transformSync(source, { loader: 'ts', format: 'cjs' }).code, { module, exports: module.exports, process, Buffer, AbortController, require: id => id === 'vscode' ? { workspace: { isTrusted: true }, window: { createOutputChannel: () => channel } } : id === './android-debugger' ? { getAndroidDebugConfigurations: () => [] } : id === './autoConfig' || id === './android-debugger/autoConfig' ? autoApi : id === './gradleTooling' ? { GradleToolingClient: class { async dispose() {} } } : id === './sdk' || id === './androidProjectModel' ? {} : require(id) });
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

// 以一次事件循环检查点观察 Promise 状态，不结算外部门闩，也不等待定时器或轮询。
async function pendingState(promise) {
  return Promise.race([promise.then(() => 'fulfilled', () => 'rejected'), new Promise(resolve => setImmediate(() => resolve('pending')))]);
}

// 永久 pending 的宿主不能阻塞 UI 取消；清理仍独占操作且逐个等待精确会话退出。
test('android-build pending debug stop releases UI immediately but owns host and every exact termination', async t => {
  const f = fixture(t); await f.action('refresh');
  const entered = Promise.withResolvers(), host = Promise.withResolvers(), stoppedFirst = Promise.withResolvers(), stoppedSecond = Promise.withResolvers();
  const stopped = [];
  // 功能：只挂起宿主接受；输入启动配置；输出真实 registry 的连接报告及可控宿主门闩，终止仍由独立事件驱动。
  f.vscode.debug.startDebugging = (_folder, config) => {
    f.pendingConfig = config; f.startup.reportDebugConnection(config, Promise.resolve());
    entered.resolve(); return host.promise;
  };
  f.vscode.debug.stopDebugging = async session => { stopped.push(session); (stopped.length === 1 ? stoppedFirst : stoppedSecond).resolve(); };
  const starting = f.action('debug', undefined, 'phone');
  const rejected = assert.rejects(starting, /cancelled/);
  await entered.promise;
  const calls = f.calls.length;
  const first = { id: 'pending-first', configuration: { ...f.pendingConfig } }, second = { id: 'pending-second', configuration: { ...f.pendingConfig } };
  const foreign = { id: 'foreign', configuration: { ...f.pendingConfig, serial: 'other-phone' } };
  const report = session => { for (const listener of [...f.debugStartListeners]) listener(session); };
  const terminate = session => { for (const listener of [...f.debugTerminationListeners]) listener(session); };
  const stop = f.action('stop');
  assert.equal(f.last().busy, false); assert.equal(f.last().running, false); assert.equal(f.last().stopping, true);
  await Promise.resolve();
  assert.equal(f.last().busy, false); assert.equal(f.last().running, false); assert.equal(f.last().stopping, true);
  assert.equal(await pendingState(starting), 'rejected'); await rejected;
  assert.equal(await pendingState(stop), 'pending');
  report(first); await stoppedFirst.promise;
  report(second); report(second); report(foreign); await stoppedSecond.promise;
  const duplicate = f.action('stop');
  for (const action of ['debug', 'run', 'build', 'refresh', 'runMode']) await assert.rejects(f.action(action, 'run', 'phone'), /already running/);
  assert.deepEqual(stopped, [first, second]);
  assert.equal(f.calls.length, calls);
  terminate(foreign); assert.equal(await pendingState(stop), 'pending');
  host.resolve(true); assert.equal(await pendingState(stop), 'pending');
  terminate(second); assert.equal(await pendingState(stop), 'pending');
  terminate(first); await Promise.all([stop, duplicate]);
  assert.deepEqual(stopped, [first, second]);
  assert.equal(f.last().status, 'Stopped'); assert.equal(f.last().stopping, false);
  assert.equal(f.last().busy, false); assert.equal(f.last().running, false);
  assert.equal(f.debugStartListeners.size, 0); assert.equal(f.debugTerminationListeners.size, 0);
  await f.controller.dispose();
});

/** 功能：验证已运行调试的停止也等待真实termination；输入已返回的stopDebugging与延迟终止事件；输出前台立即停止且清理完成后才解除互斥；验证：本文件定向入口。 */
test('android-build running debug stop waits for the exact termination rather than stop request completion', async t => {
  const f = fixture(t); await f.action('refresh'); await f.action('debug', undefined, 'phone');
  const entered = Promise.withResolvers();
  f.vscode.debug.stopDebugging = async session => { assert.equal(session, f.session); entered.resolve(); };
  const stopping = f.action('stop');
  assert.equal(f.last().running, false); assert.equal(f.last().busy, false); assert.equal(f.last().stopping, true);
  await entered.promise; assert.equal(await pendingState(stopping), 'pending');
  for (const listener of [...f.debugTerminationListeners]) listener({ id: 'foreign', configuration: {} });
  assert.equal(await pendingState(stopping), 'pending');
  for (const listener of [...f.debugTerminationListeners]) listener(f.session);
  await stopping;
  assert.equal(f.last().status, 'Stopped'); assert.equal(f.last().stopping, false);
  assert.equal(f.debugTerminationListeners.size, 0); await f.controller.dispose();
});

// Run 的 UI 停止不代表底层 child 已退出，重复 Stop 与重叠 Run 均不得绕过 close 屏障。
for (const platform of ['linux', 'win32']) test('android-build Run stop retains the real child close barrier on ' + platform, async t => {
  const f = fixture(t, platform); await f.action('refresh'); f.hold = true; f.closeOnKill = false;
  const starting = f.action('run', undefined, 'phone'); const rejected = assert.rejects(starting, /cancelled/);
  // Run 的首个设备探测同步登记 child，后续安装和启动必须在取消后保持未执行。
  const child = f.held; assert.ok(child);
  const stop = f.action('stop'), duplicate = f.action('stop');
  assert.equal(f.last().busy, false); assert.equal(f.last().running, false); assert.equal(f.last().stopping, true);
  await assert.rejects(f.action('run', undefined, 'phone'), /already running/);
  assert.equal(await pendingState(stop), 'pending'); assert.equal(await pendingState(starting), 'pending');
  child.finish(null, 'SIGTERM'); await Promise.all([stop, duplicate, rejected]);
  assert.equal(f.calls.some(call => call.args.includes(':app:installDebug') || call.args.includes('monkey')), false);
  if (platform === 'win32') assert.equal(f.calls.filter(call => call.command === 'taskkill').length, 1);
  assert.equal(f.last().status, 'Stopped'); assert.equal(f.last().stopping, false);
  f.hold = false; await f.controller.dispose();
});

// 功能点：Windows 本地真实子进程上的同一 Run 停止与进程归属隔离，不验证真实 ADB 或设备 Run 端到端。
// 受影响对象：AndroidBuildController.handle/execute/stop、OwnedProcess、真实 taskkill、index/startup 及前台快照。
// 复现路径：仅 Windows；唯一临时 wrapper 经 refresh 初始化，Run 首个 sdk-adb get-state 换为 Node helper，owned/foreign 均输出 READY 后连续 Stop 两次。
// 测试范围：同步释放 busy/running、保留 stopping、重复停止、原生 close 先于 Stopped、取消拒绝、foreign 存活和禁止后续 install/monkey。
// 执行入口：node --test --test-name-pattern="real Windows Run stop kills only its owned child" tests/android-build.test.js；npm test。
// 预期结果：真实 taskkill 只终止精确 owned PID 一次，Stop 等待其退出，foreign 前台进程仍可探测；所有自建句柄最终关闭。
// 判据：快照、命令/PID/次数、原生事件顺序、Promise 结果及退出码全部断言；超时只作失败诊断，finally 清理自建进程后再 dispose 和删除临时目录。
/** 功能：验证真实 Windows Run 取消；输入受控任务数组和两个 stdin 长驻 helper；输出精确停止及隔离断言；验证：上述定向入口，非 Windows 才跳过。 */
test('android-build real Windows Run stop kills only its owned child', { skip: process.platform !== 'win32' }, async () => {
  const realCp = require('node:child_process');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'device tools real run stop '));
  const children = [], calls = [], states = [], events = [];
  const helper = "process.stdin.resume(); process.stdout.write('READY\\n');";
  let controller, owned, channel;
  let toolingDisposed = false;

  /** 功能：限制诊断等待；输入待结算 Promise 和阶段名；输出原结果或超时失败，由外层 finally 清理自建进程；验证：本测试所有异步阶段。 */
  async function deadline(promise, stage) {
    let timer;
    try {
      return await Promise.race([promise, new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('本地 Run 停止诊断超时：' + stage)), 15000);
      })]);
    } finally { clearTimeout(timer); }
  }

  /** 功能：立即观察异步拒绝但不丢失失败；输入操作 Promise；输出显式成功或失败记录供断言；验证：Run 和两次 Stop 的结算断言。 */
  function outcome(promise) {
    return promise.then(value => ({ status: 'fulfilled', value }), error => ({ status: 'rejected', error }));
  }

  /** 功能：登记真实句柄及原生关闭事件；输入本测试 spawn 的 child 和标签；输出 close/READY 屏障及退出记录；验证：事件顺序、退出状态和 finally 清理。 */
  function track(child, label) {
    const closed = Promise.withResolvers(), ready = Promise.withResolvers();
    const record = { child, label, closed: closed.promise, ready: ready.promise, close: undefined, error: undefined };
    children.push(record);
    let stdout = '';
    child.stdout?.on('data', chunk => {
      stdout += chunk.toString();
      if (stdout.includes('READY\n')) ready.resolve({ ready: true });
    });
    child.once('error', error => { record.error = error; ready.resolve({ ready: false, error }); });
    child.once('close', (code, signal) => {
      record.close = { code, signal };
      events.push(label + ':close');
      ready.resolve({ ready: false, error: record.error ?? new Error(label + ' 在 READY 前关闭') });
      closed.resolve(record.close);
    });
    return record;
  }

  /** 功能：加载真实 TypeScript 到独立 VM；输入源码相对路径及显式边界依赖；输出真实模块导出，fs/process 保持原生；验证：本测试通过正式 controller 入口调用。 */
  function loadTs(relative, dependencies) {
    const module = { exports: {} };
    vm.runInNewContext(transformSync(fs.readFileSync(path.join(__dirname, '../src', relative), 'utf8'), { loader: 'ts', format: 'cjs' }).code, {
      module, exports: module.exports, process, Buffer, AbortController, console,
      require: id => Object.hasOwn(dependencies, id) ? dependencies[id] : require(id),
    });
    return module.exports;
  }

  /** 功能：仅替换首个设备探测并透传真实 taskkill；输入生产 spawn 命令和参数；输出登记的真实 child，其他命令立即失败；验证：精确命令、PID 和零安装/启动断言。 */
  function spawn(command, args, options) {
    calls.push({ command, args: Array.from(args), options });
    if (command === 'sdk-adb' && owned === undefined && args.length === 3 && args[2] === 'get-state') {
      assert.equal(owned, undefined, '只能替换 Run 的首个 get-state');
      assert.deepEqual(Array.from(args), ['-s', 'local-run-stop', 'get-state']);
      assert.equal(options.cwd, root); assert.equal(options.shell, false); assert.equal(options.detached, false);
      owned = track(realCp.spawn(process.execPath, ['-e', helper], options), 'owned');
      return owned.child;
    }
    if (command === 'taskkill') {
      assert.ok(owned?.child.pid);
      assert.equal(calls.filter(call => call.command === 'taskkill').length, 1, '重复 Stop 不得重复终止');
      assert.deepEqual(Array.from(args), ['/pid', String(owned.child.pid), '/t', '/f']);
      assert.equal(options.shell, false);
      return track(realCp.spawn(command, args, options), 'taskkill').child;
    }
    assert.fail('取消后不得执行安装、monkey 或其他命令：' + command + ' ' + args.join(' '));
  }

  try {
    const wrapper = path.join(root, 'gradlew.bat');
    fs.writeFileSync(wrapper, '@exit /b 97\r\n');
    // 通道仅记录宿主输出生命周期；输入真实日志，输出保留文本和销毁状态；验证：清理阶段 dispose 断言。
    channel = { text: '', disposed: false, replace(text) { this.text = text; }, show() { assert.fail('Run 停止不应打开输出面板'); }, dispose() { this.disposed = true; } };
    // 工作区仅暴露此临时 wrapper；输入发现请求，输出唯一工程；验证：refresh 的项目和目标断言。
    const vscode = {
      workspace: { isTrusted: true, workspaceFolders: [{ uri: { fsPath: root } }], findFiles: async () => [{ fsPath: wrapper }] },
      window: { createOutputChannel: () => channel },
    };
    const startup = require('./debug-startup-loader.cjs')();
    const debugApi = loadTs('android-debugger/index.ts', { vscode, './startup': startup, './autoConfig': autoApi });
    const projectModel = loadTs('androidProjectModel.ts', {});
    let queried = 0;
    const tooling = { GradleToolingClient: class {
      /** 功能：提供初始化任务边界；输入唯一工程和未取消信号；输出真实格式任务字符串数组；验证：refresh 仅查询一次且选择 Debug。 */
      async query(projectRoot, signal) {
        assert.equal(projectRoot, root); assert.equal(signal.aborted, false); queried++;
        return [':app:assembleDebug', ':app:installDebug'];
      }
      /** 功能：记录 Tooling 释放；输入 controller 销毁请求；输出已释放标志；验证：finally 的资源断言。 */
      async dispose() { toolingDisposed = true; }
    } };
    const api = loadTs('androidBuild.ts', {
      vscode, child_process: { spawn }, './sdk': { adbPath: () => 'sdk-adb' },
      './android-debugger': debugApi, './android-debugger/autoConfig': autoApi,
      './androidProjectModel': projectModel, './gradleTooling': tooling,
    });
    // 状态出口只记录原始快照和 Stopped 发布顺序，不修改控制器内部 operation/child；验证：同步快照及 close 顺序断言。
    controller = new api.AndroidBuildController(message => {
      states.push(message);
      if (message.status === 'Stopped') events.push('Stopped');
    }, '');
    await deadline(controller.handle({ type: 'buildPanel', action: 'refresh' }), 'refresh');
    assert.equal(queried, 1); assert.equal(states.at(-1).projects.length, 1);
    assert.equal(states.at(-1).project, root); assert.equal(states.at(-1).target, ':app:Debug');
    assert.equal(states.at(-1).status, 'Ready'); assert.equal(calls.length, 0);

    const foreign = track(realCp.spawn(process.execPath, ['-e', helper], { cwd: root, shell: false, windowsHide: true, detached: false }), 'foreign');
    const starting = controller.handle({ type: 'buildPanel', action: 'run' }, 'local-run-stop');
    const startingResult = outcome(starting);
    assert.ok(owned, '正常 Run 入口必须登记首个真实 child');
    const ready = await deadline(Promise.all([owned.ready, foreign.ready]), 'owned/foreign READY');
    for (const result of ready) assert.equal(result.ready, true, String(result.error));
    assert.ok(owned.child.pid); assert.ok(foreign.child.pid); assert.notEqual(owned.child.pid, foreign.child.pid);
    assert.equal(owned.close, undefined); assert.equal(foreign.close, undefined);
    assert.equal(states.at(-1).busy, true);

    const stopResult = outcome(controller.handle({ type: 'buildPanel', action: 'stop' }));
    assert.equal(states.at(-1).busy, false); assert.equal(states.at(-1).running, false); assert.equal(states.at(-1).stopping, true);
    const duplicateResult = outcome(controller.handle({ type: 'buildPanel', action: 'stop' }));
    assert.equal(states.at(-1).busy, false); assert.equal(states.at(-1).running, false); assert.equal(states.at(-1).stopping, true);
    assert.equal(owned.close, undefined); assert.equal(events.includes('Stopped'), false);
    const results = await deadline(Promise.all([startingResult, stopResult, duplicateResult, owned.closed]), 'Run 取消及两次 Stop');
    assert.equal(results[0].status, 'rejected');
    await assert.rejects(starting, /cancelled/);
    assert.equal(results[1].status, 'fulfilled', String(results[1].error));
    assert.equal(results[2].status, 'fulfilled', String(results[2].error));
    assert.ok(owned.child.exitCode !== null || owned.child.signalCode !== null, 'owned 必须确实退出');
    assert.deepEqual(owned.close, { code: owned.child.exitCode, signal: owned.child.signalCode });
    assert.ok(events.indexOf('owned:close') >= 0);
    assert.ok(events.indexOf('Stopped') > events.indexOf('owned:close'), JSON.stringify(events));
    assert.equal(states.at(-1).status, 'Stopped'); assert.equal(states.at(-1).stopping, false);
    assert.equal(states.at(-1).busy, false); assert.equal(states.at(-1).running, false);
    const kills = calls.filter(call => call.command === 'taskkill');
    assert.equal(kills.length, 1); assert.deepEqual(kills[0].args, ['/pid', String(owned.child.pid), '/t', '/f']);
    assert.equal(children.find(record => record.label === 'taskkill').close.code, 0);
    assert.equal(calls.length, 2);
    assert.equal(calls.some(call => call.args.includes(':app:installDebug') || call.args.includes('monkey')), false);
    assert.equal(foreign.close, undefined); assert.equal(foreign.child.exitCode, null); assert.equal(foreign.child.signalCode, null);
    assert.equal(process.kill(foreign.child.pid, 0), true, '前台 foreign helper 必须仍存活');
  } finally {
    try {
      // 输入仅限本测试保存的 child 句柄；输出逐个 kill 并等待原生 close；验证：超时和断言失败也不能遗留长驻 helper。
      const cleaned = await Promise.allSettled(children.map(async record => {
        if (record.child.pid && record.child.exitCode === null && record.child.signalCode === null) record.child.kill('SIGKILL');
        await deadline(record.closed, record.label + ' 清理 close');
      }));
      const failures = cleaned.filter(result => result.status === 'rejected').map(result => result.reason);
      if (failures.length) throw new AggregateError(failures, '本地 Run 停止进程清理失败');
    } finally {
      try {
        if (controller) {
          await deadline(controller.dispose(), 'controller dispose');
          assert.equal(channel.disposed, true);
          assert.equal(toolingDisposed, true);
        }
      } finally { fs.rmSync(root, { recursive: true, force: true }); }
    }
  }
});

// npm test：Windows wrapper 在带空格 cwd 执行，adb 保留绝对命令名且不经过 cmd。
test('android-build Windows wrapper and adb have distinct safe command paths', async t => {
  const f = fixture(t, 'win32'); await f.action('refresh');
  assert.equal(f.calls[0].command, 'tooling-api');
  await f.action('build');
  assert.equal(f.calls.at(-1).command, 'cmd.exe');
  assert.equal(f.calls.at(-1).args.at(-1), 'gradlew.bat :app:assembleDebug --console=plain');
  assert.equal(f.calls.at(-1).options.cwd, f.root);
  assert.equal(f.calls.at(-1).options.shell, false);
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
  vm.runInNewContext(transformSync(source, { loader: 'ts', format: 'cjs' }).code, { module, exports: module.exports, process, Buffer, AbortController, require: id => id === 'vscode' ? vscode : id === './sdk' ? {} : id === './android-debugger' ? { getAndroidDebugConfigurations: () => [] } : id === './autoConfig' || id === './android-debugger/autoConfig' ? autoApi : id === './androidProjectModel' ? {} : id === './gradleTooling' ? { GradleToolingClient: class { async query() { return [':app:assembleDebug', ':app:installDebug']; } async dispose() {} } } : require(id) });
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
    assert.equal(posts.findLast(m => m.type === 'explorerReveal').path, '/data/data/com.example.other');
    const release = path.join(f.root, 'app', 'build', 'outputs', 'apk', 'release'); fs.mkdirSync(release, { recursive: true });
    for (const invalid of ['{broken', JSON.stringify({ variantName: 'release', applicationId: '../evil' })]) {
      fs.writeFileSync(path.join(release, 'output-metadata.json'), invalid); scans = 0; picks = 0; lists.length = 0; posts.length = 0;
      await explorer.handle({ type: 'explorer', action: 'locateApp' });
      assert.match(posts.findLast(m => m.type === 'explorerProgress').error, /JSON|Unexpected|property|Invalid applicationId/i);
      assert.equal(scans, 0); assert.equal(picks, 0); assert.equal(lists.length, 0);
      assert.equal(posts.some(m => m.type === 'explorerReveal'), false);
    }
    assert.equal(f.calls.length, commands);
  } finally { await explorer.dispose(); await f.controller.dispose(); }
});
