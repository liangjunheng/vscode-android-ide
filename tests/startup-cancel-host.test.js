/**
 * 功能点：显式启用真实VS Code公开调试启动取消宿主入口。
 * 受影响对象：index/startup/debugging、真实宿主provider/tracker和直接引擎启动生命周期。
 * 复现路径：Node>=22、esbuild及VS Code；ANDROID_DEBUG_CANCEL_HOST_TEST=1，可指定绝对VSCODE_PATH。
 * 测试范围：provider挂起、descriptor挂起、真实start同步取消与实际termination；设备全部模拟。
 * 执行入口：ANDROID_DEBUG_CANCEL_HOST_TEST=1 node --test tests/startup-cancel-host.test.js；默认不构建、不启动宿主。
 * 预期结果：独立用户/扩展/工作目录，单bundle，固定context与metadata，原始host/DAP及stdout/stderr证据。
 * 判据：三场景COMPLETED、输入SHA256不变、自有资源归零、日志flush及实际宿主退出均成立。
 * 未覆盖：Build面板、真实JAR/CodeLLDB、Native/Dual和真机；入口迁移不代表本轮已实测。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

/** 功能：对证据文件计算SHA256，输入绝对路径，输出不可变源码身份。 */
function hash(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }

/** 功能：等待自有宿主操作且只设诊断上限，超时不宣称实际操作已经完成。 */
async function deadline(label, promise, ms) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(label + '超时，底层未视为完成')), ms);
    })]);
  } finally { clearTimeout(timer); }
}

/** 功能：创建唯一bundle和空激活manifest，输入源码根及自有目录，输出所有实际输入和产物的固定哈希。 */
async function bundleHost(root, extension) {
  const esbuild = require('esbuild');
  const boundary = path.join(root, 'tests/fixture/startup-cancel-boundaries.cjs');
  const runner = path.join(root, 'tests/startup-cancel-host-runner.cjs');
  const outfile = path.join(extension, 'runner.cjs');
  const hashes = {};
  const replacements = [];
  const result = await esbuild.build({
    absWorkingDir: root, entryPoints: [runner], outfile, bundle: true, platform: 'node', format: 'cjs',
    target: 'node22', external: ['vscode', 'sharp'], metafile: true, sourcemap: false, logLevel: 'silent',
    plugins: [{
      name: 'task51-only-device-boundaries',
      /** 功能：只替换debugging的设备与Native准备边界；输入实际importer；输出固定源码哈希且不加载死模块。 */
      setup(api) {
        api.onResolve({ filter: /^\.\/(?:device|native-debugger\/adapter|native-debugger\/upstream\/src\/android)$/ }, args => {
          if (path.resolve(args.importer) !== path.join(root, 'src/android-debugger/debugging.ts')) return undefined;
          replacements.push({ importer: path.resolve(args.importer), request: args.path, boundary });
          return { path: boundary };
        });
        api.onLoad({ filter: /\.(?:tsx?|jsx?|cjs|mjs|json)$/ }, args => {
          const bytes = fs.readFileSync(args.path), file = path.resolve(args.path);
          hashes[file] = crypto.createHash('sha256').update(bytes).digest('hex');
          const extensionName = path.extname(file).slice(1);
          return { contents: bytes, loader: ['ts', 'tsx', 'jsx', 'json'].includes(extensionName) ? extensionName : 'js', resolveDir: path.dirname(file) };
        });
      },
    }],
  });
  const inputs = Object.keys(result.metafile.inputs).map(file => path.resolve(root, file));
  for (const relative of ['src/android-debugger/index.ts', 'src/android-debugger/startup.ts', 'src/android-debugger/debugging.ts']) {
    assert.ok(inputs.includes(path.join(root, relative)), 'bundle缺少真实生产模块：' + relative);
  }
  assert.equal(inputs.filter(file => file === path.join(root, 'src/android-debugger/startup.ts')).length, 1, 'startup必须只有一个依赖图实例');
  assert.ok(inputs.every(file => !file.startsWith(path.join(root, 'dist') + path.sep)), '禁止加载生产dist');
  assert.ok(!inputs.includes(path.join(root, 'src/extension.ts')), '禁止激活完整生产扩展');
  assert.ok(inputs.every(file => !/(?:coordinator[\\/]|sessionAdapter|[\\/]engines\.ts|[\\/]tasks\.ts|[\\/]device\.ts|adbSmartSocket)/.test(file)), '禁止旧模块或真实设备通信进入bundle');
  assert.equal(replacements.length, 3, '必须精确替换debugging的三个外部边界');
  assert.ok(inputs.includes(boundary), '缺少设备边界替身');
  for (const file of inputs) assert.equal(hash(file), hashes[file], '构建期间输入已变化：' + file);
  const manifest = path.join(extension, 'package.json');
  const activation = path.join(extension, 'activation.cjs');
  fs.writeFileSync(manifest, JSON.stringify({
    name: 'startup-cancel-fixture', publisher: 'task51', version: '0.0.1', engines: { vscode: '^1.95.0' },
    main: './activation.cjs', activationEvents: ['*'],
    contributes: { debuggers: ['android-debug', 'android-jvm', 'lldb'].map(type => ({
      type, label: '任务51隔离 ' + type,
      configurationAttributes: { attach: { properties: {} }, launch: { properties: {} } },
    })) },
  }, null, 2));
  fs.writeFileSync(activation, '/** 功能：空激活只返回真实ExtensionContext供runner注册公开provider，不加载生产extension。 */\nexports.activate = function activate(context) { return context; };\n');
  for (const file of [outfile, manifest, activation, __filename]) hashes[path.resolve(file)] = hash(file);
  fs.writeFileSync(path.join(extension, 'bundle-inputs.json'), JSON.stringify({ hashes, replacements, metafile: result.metafile }, null, 2));
  return { outfile, hashes };
}

/** 功能：在显式opt-in后创建隔离宿主，保留流式证据并仅清理本次spawn的宿主进程。 */
test('真实VS Code宿主Starting取消与迟到根会话精确清理', {
  skip: process.env.ANDROID_DEBUG_CANCEL_HOST_TEST !== '1' && '需显式设置ANDROID_DEBUG_CANCEL_HOST_TEST=1', timeout: 180000,
}, async t => {
  const root = path.resolve(__dirname, '..');
  const code = process.env.VSCODE_PATH || (process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs/Microsoft VS Code/Code.exe'));
  assert.ok(code && path.isAbsolute(code) && fs.existsSync(code), '需要实际VS Code可执行文件；非默认安装请设置绝对VSCODE_PATH');
  const artifacts = path.join(root, '.test-artifacts');
  fs.mkdirSync(artifacts, { recursive: true });
  const directory = fs.mkdtempSync(path.join(artifacts, 'startup-cancel-host-'));
  t.diagnostic('任务51真实宿主证据：' + directory);
  const workspace = path.join(directory, 'workspace');
  const extension = path.join(directory, 'extension');
  const extensions = path.join(directory, 'installed-extensions');
  const userData = path.join(directory, 'user-data');
  for (const folder of [workspace, extension, extensions, userData]) fs.mkdirSync(folder);
  // 固定metadata只供宿主读取；本入口不发现或执行Gradle Wrapper。
  const metadataDirectory = path.join(workspace, 'app/build/outputs/apk/debug');
  fs.mkdirSync(metadataDirectory, { recursive: true });
  const metadata = path.join(metadataDirectory, 'output-metadata.json');
  fs.writeFileSync(metadata, JSON.stringify({ variantName: 'debug', applicationId: 'dev.task51.fixture' }));
  const { outfile, hashes } = await bundleHost(root, extension);
  hashes[metadata] = hash(metadata);
  const spec = {
    extension, workspace, metadata, hashes, events: path.join(directory, 'host-events.dap.jsonl'), result: path.join(directory, 'result.json'),
  };
  const specFile = path.join(directory, 'spec.json');
  fs.writeFileSync(specFile, JSON.stringify(spec, null, 2));
  const stdout = fs.openSync(path.join(directory, 'stdout.log'), 'w');
  const stderr = fs.openSync(path.join(directory, 'stderr.log'), 'w');
  const env = { ...process.env, ANDROID_CANCEL_HOST_SPEC: specFile };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'VSCODE_IPC_HOOK_CLI', 'VSCODE_PID', 'VSCODE_CWD', 'VSCODE_PORTABLE']) delete env[key];
  let child;
  let closed;
  let exit;
  let aborted;
  let failure;
  const lifecycle = [];
  try {
    child = spawn(code, [
      '--new-window', '--user-data-dir', userData, '--extensions-dir', extensions,
      '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', '--disable-updates',
      '--extensionDevelopmentPath', extension, '--extensionTestsPath', outfile, workspace,
    ], { env, windowsHide: false, stdio: ['ignore', stdout, stderr] });
    closed = new Promise(resolve => {
      child.once('error', error => { lifecycle.push({ event: 'spawn-error', error: String(error.stack || error) }); });
      child.once('exit', (code, signal) => {
        exit = { code, signal };
        lifecycle.push({ event: 'exit', ...exit });
        resolve(exit);
      });
    });
    aborted = () => {
      lifecycle.push({ event: 'abort-owned-host', pid: child.pid });
      if (child.exitCode === null && child.signalCode === null) child.kill();
    };
    t.signal.addEventListener('abort', aborted, { once: true });
    lifecycle.push({ event: 'spawn-owned-host', pid: child.pid, extensionTestsPath: outfile, userData });
    await deadline('隔离宿主exit', closed, 150000);
    assert.ok(fs.existsSync(spec.result), '宿主没有产出结果，查看stdout/stderr及host-events');
    const outcome = JSON.parse(fs.readFileSync(spec.result, 'utf8'));
    assert.equal(outcome.status, 'COMPLETED', JSON.stringify(outcome));
    assert.deepEqual(outcome.checks, ['provider-pending', 'descriptor-pending', 'late-session']);
    assert.deepEqual(outcome.notExecuted, []);
    assert.deepEqual(outcome.active, []);
    assert.equal(outcome.pending, 0);
    assert.equal(exit.code, 0, '实际宿主退出失败');
    assert.equal(exit.signal, null);
    assert.ok(fs.statSync(spec.events).size > 0, '原始DAP及host事件为空');
    for (const [file, expected] of Object.entries(hashes)) assert.equal(hash(file), expected, '执行期间输入已改变：' + file);
  } catch (error) {
    failure = error;
  } finally {
    if (aborted) t.signal.removeEventListener('abort', aborted);
    if (child && child.exitCode === null && child.signalCode === null) {
      lifecycle.push({ event: 'finally-kill-owned-host', pid: child.pid });
      child.kill();
    }
    if (closed) {
      try { await deadline('自有宿主最终exit', closed, 10000); }
      catch (error) { lifecycle.push({ event: 'W-owned-host-close-failed', error: String(error) }); failure ??= error; }
    }
    fs.closeSync(stdout);
    fs.closeSync(stderr);
    fs.writeFileSync(path.join(directory, 'launcher.json'), JSON.stringify({ status: failure ? 'FAILED' : 'COMPLETED', lifecycle, hashes, error: failure && String(failure.stack || failure) }, null, 2));
  }
  if (failure) throw failure;
});
