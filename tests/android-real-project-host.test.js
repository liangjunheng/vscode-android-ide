const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');
const { transformSync } = require('esbuild');
const runner = require('./fixtures/android-debugger/project-host-runner.cjs');
const shared = require('./fixtures/android-debugger/host-runner.cjs');
const root = path.resolve(__dirname, '..');

/** 输入实际文件，返回证据 SHA256；真实验收记录 APK/source/current extension 身份。 */
function hash(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }

/** 输入当前授权环境，验证全部前置后输出实际文件；opt-in 缺失不触碰设备，显式启用缺前置必须失败。 */
function prerequisites(env) {
  for (const key of ['ANDROID_REAL_PROJECT_ROOT', 'ANDROID_DEBUG_TEST_SERIAL', 'ADB']) assert.ok(env[key], 'Missing ' + key);
  const projectRoot = fs.realpathSync(env.ANDROID_REAL_PROJECT_ROOT);
  const source = fs.realpathSync(path.join(projectRoot, 'ink-demo/src/main/java/com/tcl/ink/demo/MainActivity.kt'));
  const apk = env.ANDROID_REAL_PROJECT_APK || path.join(projectRoot, 'ink-demo/build/outputs/apk/debug/ink-demo-debug.apk');
  const code = env.VSCODE_PATH || path.join(env.LOCALAPPDATA || '', 'Programs/Microsoft VS Code/Code.exe');
  for (const file of [source, apk, code, env.ADB, path.join(root, 'dist/extension.js'), path.join(root, 'dist/android-jvm-debugger.js')]) assert.ok(fs.existsSync(file), 'Missing prerequisite ' + file);
  const text = fs.readFileSync(source, 'utf8');
  return { projectRoot, source, apk, code, breakpointLine: runner.sourceLine(text, 'super.onCreate(savedInstanceState)'), nextLine: runner.sourceLine(text, 'setContent {') };
}

/** 输入真实 producer 模型，按生产 Build provider 过滤不存在根；权限/非目录错误不默认忽略。 */
function existingSourceRoots(model) {
  return model.roots.filter(item => item.kind === 'java' || item.kind === 'kotlin').flatMap(item => {
    try { assert.ok(fs.statSync(item.path).isDirectory(), 'Source root not directory'); return [fs.realpathSync(item.path)]; }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  });
}

/** 输入原生 child，输出真实关闭结果；取消只终止自有进程，等待 close 后才拒绝，保留 stdout/stderr 日志。 */
function childExit(child, signal) {
  return new Promise((resolve, reject) => {
    let failure;
    const abort = () => { failure = signal.reason; child.kill(); };
    const error = cause => { failure = cause; };
    child.on('error', error);
    child.once('close', (code, sig) => {
      signal?.removeEventListener('abort', abort);
      child.removeListener('error', error);
      failure ? reject(failure) : resolve({ code, signal: sig });
    });
    if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
  });
}

/** 加载当前生产 AGP 模型 API，不复制源码发现逻辑或猜 src/main 根；真机回归记录全部 producer provenance。 */
async function discover(projectRoot, run, signal) {
  const loaded = { exports: {} };
  vm.runInNewContext(transformSync(fs.readFileSync(path.join(root, 'src/android-debugger/projectModel.ts'), 'utf8'), { loader: 'ts', format: 'cjs' }).code,
    { module: loaded, exports: loaded.exports, require, AbortController }, { filename: 'projectModel.ts' });
  return loaded.exports.discoverVariantSources({ projectRoot, modulePath: ':ink-demo', variant: 'debug', wrapper: path.join(projectRoot, process.platform === 'win32' ? 'gradlew.bat' : 'gradlew') }, run, signal);
}

/** 输入只读资源快照，拒绝旧的本扩展 native UUID 资源；不删除别的 IDE forward/服务/cache。 */
function assertCleanSnapshot(snapshot) {
  assert.deepEqual(snapshot.ownedRemoteFiles, [], 'stale extension native file');
  assert.deepEqual(snapshot.ownedAppDirectories, [], 'stale extension native app directory');
  assert.deepEqual(snapshot.ownedServerProcesses, [], 'stale extension native server');
}

// 严格动态源码/行/locals 边界：不启动宿主或设备；真实 runner 与此测试共用断言。
test('real project boundary rejects missing prerequisites and wrong source line or typed locals', () => {
  assert.throws(() => prerequisites({}), /ANDROID_REAL_PROJECT_ROOT/);
  const clean = { ownedRemoteFiles: [], ownedAppDirectories: [], ownedServerProcesses: [] };
  assertCleanSnapshot(clean);
  for (const key of Object.keys(clean)) assert.throws(() => assertCleanSnapshot({ ...clean, [key]: ['dta-owned'] }));
  assert.equal(runner.sourceLine('// shifted\n\nsuper.onCreate(savedInstanceState)\nsetContent {'.replaceAll('\\n', '\n'), 'super.onCreate(savedInstanceState)'), 3);
  assert.throws(() => runner.sourceLine('x\nx'.replaceAll('\\n', '\n'), 'x'), /unique/);
  const spec = { source: __filename, packageName: 'p.app', className: 'Screen', methodName: 'onCreate' };
  runner.assertFrame({ source: { path: __filename }, name: 'Screen.onCreate', line: 17 }, spec, 17);
  assert.throws(() => runner.assertFrame({ source: { path: __filename }, name: 'Screen.onCreate', line: 18 }, spec, 17));
  assert.throws(() => runner.assertFrame({ source: { path: path.join(root, 'package.json') }, name: 'Screen.onCreate', line: 17 }, spec, 17));
  const variables = [{ name: 'this', type: 'p.app.Screen', value: 'Screen', variablesReference: 10 }, { name: 'savedInstanceState', type: 'android.os.Bundle', value: 'null', variablesReference: 0 }];
  runner.assertLocals({ variables }, spec);
  for (const changed of [variables.slice(1), [variables[0], { ...variables[1], type: 'java.lang.Object' }], [{ ...variables[0], value: 'null' }, variables[1]], [variables[0], { ...variables[1], value: '' }]]) assert.throws(() => runner.assertLocals({ variables: changed }, spec));
  assert.deepEqual(existingSourceRoots({ roots: [{ kind: 'java', path: __dirname }, { kind: 'java', path: path.join(__dirname, 'missing-source-root') }, { kind: 'jniLibs', path: __dirname }] }), [fs.realpathSync(__dirname)]);
});

// 输入注入 VS Code API，确认内置身份、源码原路径、准确 next、customRequest body 和失败时自有监听/断点释放。
test('real project API boundary verifies exact source roots and cleanup on success and failure', async () => {
  for (const failure of [null, 'variables', 'next']) {
    let tracker;
    let disposed = false;
    let removed = false;
    let stepped = false;
    const requests = [];
    const spec = { source: __filename, projectRoot: root, moduleRoot: path.join(root, 'src'), variant: 'debug', sourceRoots: [__dirname, path.join(root, 'src')], packageName: 'p.app', className: 'Screen', methodName: 'onCreate', serial: 'S', pid: 123, breakpointLine: 17, nextLine: 18, snapshot: async () => ['S tcp:1 jdwp:123'] };
    const session = { configuration: { name: 'host-real-project-jvm' }, async customRequest(command, args) {
      requests.push({ command, args });
      if (command === failure) throw new Error('denied ' + command);
      if (command === 'threads') return { threads: [{ id: 1 }] };
      if (command === 'stackTrace') return { stackFrames: [{ id: 10, source: { path: __filename }, name: 'Screen.onCreate', line: stepped ? 18 : 17 }] };
      if (command === 'scopes') return { scopes: [{ name: 'Local', variablesReference: 9 }] };
      if (command === 'variables') return { variables: [{ name: 'this', type: 'p.app.Screen', value: 'Screen', variablesReference: 10 }, { name: 'savedInstanceState', type: 'android.os.Bundle', value: 'null', variablesReference: 0 }] };
      if (command === 'next') { stepped = true; tracker.onDidSendMessage({ type: 'event', event: 'stopped', body: { reason: 'step', threadId: 1 } }); }
      return {};
    } };
    const fake = { Uri: { file: file => ({ fsPath: file }) }, Position: class { constructor(line) { this.line = line; } }, Location: class { constructor(uri, position) { this.uri = uri; this.position = position; } }, SourceBreakpoint: class { constructor(location) { this.location = location; } }, workspace: { workspaceFolders: [{ uri: { fsPath: root } }] }, debug: {
      registerDebugAdapterTrackerFactory(type, factory) { assert.equal(type, 'android-tools'); tracker = factory.createDebugAdapterTracker(session); return { dispose() { disposed = true; } }; },
      addBreakpoints(items) { assert.equal(items[0].location.uri.fsPath, __filename); assert.equal(items[0].location.position.line, 16); },
      removeBreakpoints() { removed = true; },
      async startDebugging(folder, config) {
        assert.equal(config.type, 'android-tools'); assert.equal(config.androidMode, 'kotlin-java'); assert.deepEqual(config.androidSourceRoots, spec.sourceRoots); assert.equal(config.processId, 123); assert.equal(config.appSrcRoot, root);
        tracker.onDidSendMessage({ type: 'event', event: 'initialized' }); tracker.onDidSendMessage({ type: 'event', event: 'stopped', body: { reason: 'breakpoint', threadId: 1 } }); return true;
      },
    } };
    if (failure) await assert.rejects(runner.runWithApi(fake, spec, () => {}), new RegExp('denied ' + failure));
    else { const result = await runner.runWithApi(fake, spec, () => {}); assert.equal(result.next.line, 18); assert.deepEqual(requests.at(-1), { command: 'disconnect', args: { terminateDebuggee: false } }); }
    assert.equal(disposed, true); assert.equal(removed, true);
  }
});

/** 显式 opt-in 的真实项目验收，使用生产 AGP model 与本扩展内置 adapter；不改用户源码/launch.json，不清数据。
 * 命令：ANDROID_REAL_PROJECT_HOST_TEST=1 ANDROID_REAL_PROJECT_ROOT=E:/inkengine11 ANDROID_DEBUG_TEST_SERIAL=<授权串号> ADB=<bundled> node --test tests/android-real-project-host.test.js。
 * 证据：source-index/spec/DAP/result/resources，APK/source/current extension hash、same PID alive、baseline 与 owned forward 生命周期。
 */
test('authorized real project VS Code JVM debugging', { skip: process.env.ANDROID_REAL_PROJECT_HOST_TEST !== '1' && 'ANDROID_REAL_PROJECT_HOST_TEST=1 required', timeout: 180000 }, async t => {
  const env = process.env;
  const info = prerequisites(env);
  const serial = env.ANDROID_DEBUG_TEST_SERIAL;
  const adb = env.ADB;
  const run = fs.mkdtempSync(path.join(root, '.test-artifacts/android-debugger/inkengine11-'));
  t.diagnostic('Evidence: ' + run);
  const resources = { projectRoot: info.projectRoot, serial, cleanupErrors: [], hashes: {} };
  let child;
  let pid;
  let touched = false;
  let launchedByTest = false;
  const text = args => execFileSync(adb, ['-s', serial, ...args], { encoding: 'utf8', timeout: 15000, windowsHide: true }).trim();
  const forwards = () => shared.parseForwardLines(text(['forward', '--list']));
  const result = path.join(run, 'result.json');
  // Native 自有身份来自 nativeTarget 的 dta-UUID；只读列表不按普通 server/lldb 名称删除别人的资源。
  const ownedName = /^dta-[0-9a-f]{8}-[0-9a-f-]{27}$/i;
  const snapshot = () => ({
    forwards: forwards(),
    ownedRemoteFiles: text(['shell', 'ls', '-1', '/data/local/tmp']).split(/\r?\n/).filter(line => ownedName.test(line)),
    ownedAppDirectories: text(['shell', 'run-as', 'com.tcl.ink.demo', 'ls', '-1']).split(/\r?\n/).filter(line => ownedName.test(line)),
    ownedServerProcesses: text(['shell', 'ps', '-A', '-o', 'PID,ARGS']).split(/\r?\n/).filter(line => /\/dta-[0-9a-f-]+\/server(?:\s|$)/i.test(line)),
  });
  try {
    for (const [label, file] of Object.entries({ apk: info.apk, source: info.source, extension: path.join(root, 'dist/extension.js'), backend: path.join(root, 'dist/android-jvm-debugger.js'), model: path.join(root, 'src/android-debugger/projectModel.ts') })) resources.hashes[label] = { path: file, sha256: hash(file) };
    const model = await discover(info.projectRoot, async (command, args, cwd, signal) => {
      const windows = process.platform === 'win32';
      const joined = args.map(arg => /\s/.test(arg) ? '"' + arg + '"' : arg).join(' ');
      const gradle = windows ? spawn('cmd.exe', ['/d', '/s', '/c', 'gradlew.bat ' + joined], { cwd, windowsVerbatimArguments: true, env }) : spawn(command, args, { cwd, env });
      let output = '';
      gradle.stdout.on('data', chunk => { output += chunk; fs.appendFileSync(path.join(run, 'gradle.log'), chunk); });
      gradle.stderr.on('data', chunk => { output += chunk; fs.appendFileSync(path.join(run, 'gradle.log'), chunk); });
      const exit = await childExit(gradle, signal); assert.equal(exit.code, 0, output); return output;
    }, t.signal);
    fs.writeFileSync(path.join(run, 'source-index.json'), JSON.stringify(model, null, 2));
    assert.equal(model.applicationId, 'com.tcl.ink.demo');
    for (const producer of [':ink-demo', ':ink-engine-sdk', ':ink-predict-sdk']) assert.ok(model.roots.some(item => item.modulePath === producer && (item.kind === 'java' || item.kind === 'kotlin')), 'missing producer ' + producer);
    const sourceRoots = existingSourceRoots(model);
    assert.ok(sourceRoots.length >= 3);
    resources.before = snapshot();
    assertCleanSnapshot(resources.before);
    resources.baseline = resources.before.forwards;
    assert.deepEqual(resources.baseline, [], 'clean-start requires no existing forwards; do not remove unowned rows');
    assert.equal(text(['get-state']), 'device');
    touched = true;
    assert.match(text(['install', '-r', info.apk]), /Success/);
    text(['shell', 'am', 'force-stop', model.applicationId]);
    const component = text(['shell', 'cmd', 'package', 'resolve-activity', '--brief', '-a', 'android.intent.action.MAIN', '-c', 'android.intent.category.LAUNCHER', model.applicationId]).split(/\r?\n/).find(line => line.startsWith(model.applicationId + '/'));
    assert.ok(component);
    assert.match(text(['shell', 'am', 'start', '-D', '-n', component]), /Starting:/);
    launchedByTest = true;
    pid = Number(text(['shell', 'pidof', '-s', model.applicationId]));
    assert.ok(Number.isInteger(pid) && pid > 0);
    resources.pid = pid;
    const spec = { ...info, adb, serial, pid, sourceRoots, result, moduleRoot: model.moduleRoot, variant: model.variant, packageName: model.applicationId, className: 'MainActivity', methodName: 'onCreate' };
    const specFile = path.join(run, 'spec.json'); fs.writeFileSync(specFile, JSON.stringify(spec, null, 2));
    const hostEnv = { ...env, HOST_PROJECT_SPEC: specFile }; delete hostEnv.ELECTRON_RUN_AS_NODE;
    child = spawn(info.code, ['--user-data-dir', path.join(run, 'user-data'), '--extensions-dir', path.join(run, 'extensions'), '--disable-workspace-trust', '--extensionDevelopmentPath', root, '--extensionTestsPath', path.join(__dirname, 'fixtures/android-debugger/project-host-runner.cjs'), info.projectRoot], { cwd: root, env: hostEnv, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', chunk => fs.appendFileSync(path.join(run, 'stdout.log'), chunk));
    child.stderr.on('data', chunk => fs.appendFileSync(path.join(run, 'stderr.log'), chunk));
    const exit = await childExit(child, t.signal); child = undefined;
    assert.equal(exit.code, 0, 'Host failed; see ' + result);
    const outcome = JSON.parse(fs.readFileSync(result, 'utf8'));
    assert.equal(outcome.ok, true, JSON.stringify(outcome.error));
    resources.during = outcome.during;
    resources.after = forwards();
    assert.ok(shared.ownedJdwpForwards(resources.baseline, outcome.during, serial, pid).length > 0);
    assert.equal(shared.ownedJdwpForwards(resources.baseline, resources.after, serial, pid).length, 0);
    assert.ok(resources.baseline.every(row => resources.after.includes(row)));
    assert.equal(text(['shell', 'pidof', '-s', model.applicationId]), String(pid));
    resources.detachedPidAlive = true;
    resources.afterSnapshot = snapshot();
    assertCleanSnapshot(resources.afterSnapshot);
    assert.equal(hash(info.source), resources.hashes.source.sha256);
  } catch (error) {
    fs.writeFileSync(path.join(run, 'failure.json'), JSON.stringify({ message: error.message, stack: error.stack }, null, 2));
    throw error;
  } finally {
    if (child && child.exitCode === null) { const closed = childExit(child); child.kill(); try { await closed; } catch (error) { resources.cleanupErrors.push(String(error)); } }
    if (touched) {
      try {
        if (launchedByTest) text(['shell', 'am', 'force-stop', 'com.tcl.ink.demo']);
      } catch (error) { resources.cleanupErrors.push(String(error)); }
      try {
        for (const row of shared.ownedJdwpForwards(resources.baseline, forwards(), serial, pid)) text(['forward', '--remove', row.split(/\s+/)[1]]);
        resources.finalForwards = forwards();
        assert.ok(resources.baseline.every(row => resources.finalForwards.includes(row)));
        assert.equal(shared.ownedJdwpForwards(resources.baseline, resources.finalForwards, serial, pid).length, 0);
      } catch (error) { resources.cleanupErrors.push(String(error)); }
    }
    fs.writeFileSync(path.join(run, 'resources.json'), JSON.stringify(resources, null, 2));
    assert.deepEqual(resources.cleanupErrors, [], 'resource cleanup failed');
  }
});
