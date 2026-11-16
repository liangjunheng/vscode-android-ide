const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { transformSync } = require('esbuild');
const source = fs.readFileSync(path.join(__dirname, '../src/androidBuild.ts'), 'utf8');
const tasks = 'app:assembleDebug - APK\n:app:installDebug - install\napp:assembleRelease\napp:installRelease\nassemble - aggregate\napp:test - tests\n';

// 创建临时工程及真实 EventEmitter 子进程替身；npm test 覆盖关闭、失败、取消和多监听器语义，不执行用户 Gradle。
function fixture(t, platform = 'linux') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'device-tools-build-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'settings.gradle.kts'), '');
  for (const name of ['gradlew', 'gradlew.bat']) fs.writeFileSync(path.join(root, name), '');
  const metaDir = path.join(root, 'app', 'build', 'outputs', 'apk', 'debug');
  fs.mkdirSync(metaDir, { recursive: true });
  const metadata = path.join(metaDir, 'output-metadata.json');
  fs.writeFileSync(metadata, JSON.stringify({ variantName: 'debug', applicationId: 'com.example.app', elements: [{ outputFile: 'app.apk' }] }));
  const f = { root, metadata, calls: [], messages: [], configs: [], debugCalls: [], hold: false, closeOnKill: true, fail: null, offline: false, launchOutput: '', debugResult: true, choose: true, roots: [root] };
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
      let output = args.includes('get-state') ? (f.offline ? 'offline' : 'device') : args.some(a => String(a).includes('tasks')) ? tasks : args.includes('monkey') ? f.launchOutput : '';
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
    window: { createOutputChannel: () => channel, showQuickPick: async items => f.choose ? items[items.length - 1] : undefined },
    debug: {
      onDidStartDebugSession: listener => { f.debugListener = listener; return { dispose() { f.debugListener = undefined; } }; },
      startDebugging: async (...args) => { f.debugCalls.push(args); if (f.debugResult) { const session = { configuration: args[1] }; f.debugListener?.(session); f.session = session; } return f.debugResult; },
      stopDebugging: async session => { assert.equal(session, f.session); f.stoppedDebug = session; },
    },
  };
  f.vscode = vscode;
  const module = { exports: {} };
  vm.runInNewContext(transformSync(source, { loader: 'ts', format: 'cjs' }).code, {
    module, exports: module.exports, Buffer, AbortController, console,
    process: { platform, env: {}, kill: pid => { assert.equal(pid, -f.held.pid); if (f.closeOnKill) f.held.finish(null, 'SIGTERM'); } },
    require: id => id === 'vscode' ? vscode : id === 'child_process' ? cp : id === './sdk' ? { adbPath: () => 'sdk adb' } : require(id),
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

// npm test：metadata 损坏/缺失和启动器失败均不发布 Running 成功。
test('android-build metadata and launcher failures remain visible', async t => {
  const f = fixture(t); await f.action('refresh');
  fs.writeFileSync(f.metadata, '{broken');
  await assert.rejects(f.action('run', undefined, 'phone'), /JSON|Unexpected|property/i);
  fs.unlinkSync(f.metadata);
  await assert.rejects(f.action('run', undefined, 'phone'), /No APK metadata/);
  fs.writeFileSync(f.metadata, JSON.stringify({ variantName: 'debug', applicationId: 'com.example.app' }));
  f.launchOutput = 'No activities found'; await assert.rejects(f.action('run', undefined, 'phone'), /No activities/);
  assert.equal(f.last().running, false);
  await f.controller.dispose();
});

// npm test：Debug 通过原生配置 API 与选择器，缺配置/取消在安装前结束，适配器拒绝不伪成功。
test('android-build debug uses selected native launch configuration', async t => {
  const f = fixture(t); await f.action('refresh');
  const count = f.calls.length;
  await assert.rejects(f.action('debug', undefined, 'phone'), /debug adapter/);
  assert.equal(f.calls.length, count);
  f.configs = [{ name: 'One', type: 'adapter', request: 'launch' }, { name: 'Two', type: 'adapter', request: 'attach' }];
  f.choose = false; await f.action('debug', undefined, 'phone'); assert.equal(f.last().status, 'Debug cancelled');
  assert.equal(f.calls.length, count);
  f.choose = true; await f.action('debug', undefined, 'phone');
  assert.equal(f.debugCalls.at(-1)[1].name, 'Two');
  assert.equal(f.debugCalls.at(-1)[1].serial, 'phone');
  assert.equal(f.debugCalls.at(-1)[1].packageName, 'com.example.app');
  await f.action('stop');
  assert.equal(f.stoppedDebug, f.session);
  f.debugResult = false; await assert.rejects(f.action('debug', undefined, 'phone'), /rejected/);
  await f.controller.dispose();
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
  vm.runInNewContext(transformSync(source, { loader: 'ts', format: 'cjs' }).code, { module, exports: module.exports, process, Buffer, AbortController, require: id => id === 'vscode' ? vscode : id === './sdk' ? {} : require(id) });
  const states = [], controller = new module.exports.AndroidBuildController(m => states.push(m));
  await controller.handle({ type: 'buildPanel', action: 'refresh' });
  assert.equal(states.at(-1).target, ':app:Debug');
  await controller.handle({ type: 'buildPanel', action: 'build' });
  assert.match(channel.text, /EXECUTED :app:assembleDebug --console=plain/);
  assert.equal(states.at(-1).status, 'Build succeeded');
  await controller.dispose();
});
