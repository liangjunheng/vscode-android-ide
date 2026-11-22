/**
 * 功能点：任务62，验证普通启动、同PID双轮attach、生产launch换PID及新PID再次attach的Coordinator迁移路径。
 * 受影响对象：java、native、dual三种独立fixture包、各自APK、隔离VS Code宿主、父DAP会话及JVM/JNI子会话；不触碰业务App。
 * 复现路径：设置ANDROID_COORDINATOR_LAUNCH_TEST=1、ANDROID_SDK_ROOT、ANDROID_NDK_ROOT、ANDROID_DEBUG_TEST_SERIAL、JAVA_HOME；每模式构建唯一Java/JNI fixture，普通am start -W一次，宿主内同PID attach两轮并disconnect(false)，生产launch同包APK一次，再对新PID attach一次。
 * 测试范围：每模式独立宿主和包；Java/native/dual实际选定引擎的verified、源码frame、value=41、next后value=42、continue、pause；原始DAP流、start Promise、父子termination、PID迁移、forward基线和TS/JAR/src/dist哈希。
 * 执行入口：ANDROID_COORDINATOR_LAUNCH_TEST=1 node --test tests/coordinator-launch-after-attach-device.test.js。
 * 预期结果：两轮旧PID attach均保留旧PID；生产launch只调用一次、无固定请求总期限且实际错误原样传播，成功后取得不同新PID；launch及新PID attach均命中真实断点并完成调试操作，所有父会话准确发送disconnect(false)并真实结束。
 * 判据：三模式均通过且每模式宿主、父子会话和包资源满足断言；任一模式失败只阻止该模式后续阶段，不阻止其他模式；测试不得删除forward，源码及运行时哈希必须不变。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { execFileSync, spawn } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const artifactRoot = path.join(root, '.test-artifacts');
const modes = ['java', 'native', 'dual'];

/** 功能：执行前台工具命令并保留原始错误；输入命令、参数和可选执行项；输出UTF-8文本。验证：fixture构建、设备预检和资源快照。 */
function run(command, args, options = {}) {
  return execFileSync(command, args, { windowsHide: true, encoding: 'utf8', timeout: 60000, ...options });
}

/** 功能：记录指定目录树的稳定SHA-256；输入目录和可选文件筛选器；输出相对路径哈希映射。验证：宿主运行前后TS、JAR、src和dist未改变。 */
function hashTree(directory, include = () => true) {
  const result = {};
  const visit = current => {
    for (const name of fs.readdirSync(current).sort()) {
      const full = path.join(current, name);
      const stat = fs.statSync(full);
      if (stat.isDirectory()) visit(full);
      else if (include(full)) result[path.relative(root, full).replaceAll('\\', '/')] = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex');
    }
  };
  visit(directory);
  return result;
}

/** 功能：读取唯一fixture的PID；输入adb、serial和包名；输出当前PID或确认的0；验证：只有明确的空pidof结果才代表进程不存在。 */
function fixturePid(adb, serial, packageName) {
  try {
    return Number(run(adb, ['-s', serial, 'shell', 'pidof', '-s', packageName]).trim() || 0);
  } catch (error) {
    if (error.status === 1 && !String(error.stdout || '').trim() && !String(error.stderr || '').trim()) return 0;
    throw error;
  }
}

/** 功能：只读复用正式reattach入口中的唯一Java/JNI fixture构建函数；输入SDK、NDK、隔离目录、workspace和包名；输出APK及源码路径。验证：新包使用现有构建逻辑且不修改正式测试文件。 */
function loadFixtureBuilder() {
  const formal = path.join(root, 'tests', 'coordinator-reattach-device.test.js');
  const source = fs.readFileSync(formal, 'utf8');
  const marker = source.indexOf("test('authorized Coordinator reattach");
  assert.ok(marker > 0, '正式reattach入口结构已改变，无法安全复用fixture构建函数');
  const context = { require: createRequire(formal), __dirname: path.dirname(formal), process, console, module: { exports: {} } };
  vm.runInNewContext(source.slice(0, marker) + '\nmodule.exports = { buildFixture };', context, { filename: formal });
  return context.module.exports.buildFixture;
}

/** 功能：启动一个独立VS Code宿主并保存宿主原始输出；输入宿主路径、spec、workspace、证据目录、结果文件和模式信号；输出退出码及结果。验证：每模式只拥有自己的宿主树。 */
async function runHost(code, specPath, workspace, directory, resultFile, signal) {
  const env = {
    ...process.env,
    COORDINATOR_LAUNCH_HOST_SPEC: specPath,
    COORDINATOR_LAUNCH_HOST_RESULT: resultFile,
    COORDINATOR_LAUNCH_HOST_WORKSPACE: workspace,
  };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'VSCODE_IPC_HOOK_CLI', 'VSCODE_PID', 'VSCODE_CWD']) delete env[key];
  const child = spawn(code, [
    '--user-data-dir', path.join(directory, 'user-data'),
    '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes',
    '--extensionDevelopmentPath', root,
    '--extensionTestsPath', path.join(root, 'tests', 'coordinator-launch-after-attach-host-runner.cjs'),
    workspace,
  ], { env, windowsHide: false });
  child.stdout.on('data', data => fs.appendFileSync(path.join(directory, 'host-stdout.log'), data));
  child.stderr.on('data', data => fs.appendFileSync(path.join(directory, 'host-stderr.log'), data));
  const exited = new Promise(resolve => child.once('close', resolve));
  const abort = () => { if (child.exitCode === null) child.kill(); };
  signal.addEventListener('abort', abort, { once: true });
  let timer;
  try {
    const exit = await new Promise((resolve, reject) => {
      timer = setTimeout(() => { abort(); reject(new Error('隔离宿主超过330秒诊断上限')); }, 330000);
      child.once('error', reject);
      child.once('close', resolve);
      if (signal.aborted) { abort(); reject(signal.reason); }
    });
    return { exit, outcome: fs.existsSync(resultFile) ? JSON.parse(fs.readFileSync(resultFile, 'utf8')) : null };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', abort);
    abort();
    await exited;
  }
}

/** 功能：读取本次包的设备资源基线；输入adb、serial和包名；输出PID、forward及本包lldb-server行。验证：宿主结束后且精确包清理前资源未越界。 */
function snapshot(adb, serial, packageName) {
  const text = args => run(adb, ['-s', serial, ...args]).trim();
  return {
    pid: fixturePid(adb, serial, packageName),
    forward: text(['forward', '--list']),
    servers: text(['shell', 'ps', '-A', '-o', 'PID,ARGS']).split(/\r?\n/).filter(line => line.includes('/' + packageName + '/') && line.includes('/lldb-server')),
  };
}

/** 功能：仅清理当前模式创建的包；输入adb、serial和包名；输出无；验证：不删除forward、不触碰其他包和进程。 */
function cleanupFixture(adb, serial, packageName) {
  const text = args => run(adb, ['-s', serial, ...args]).trim();
  const errors = [];
  try { text(['shell', 'am', 'force-stop', packageName]); } catch (error) { errors.push(error); }
  try { text(['uninstall', packageName]); } catch (error) { errors.push(error); }
  if (errors.length) throw new AggregateError(errors, '唯一fixture清理失败');
}

test('authorized Coordinator launch after attach migrates PID in all modes', {
  skip: process.env.ANDROID_COORDINATOR_LAUNCH_TEST !== '1' && 'explicit launch-after-attach device authorization required',
  timeout: 1200000,
}, async t => {
  const sdk = process.env.ANDROID_SDK_ROOT;
  const ndk = process.env.ANDROID_NDK_ROOT;
  const serial = process.env.ANDROID_DEBUG_TEST_SERIAL;
  const javaHome = process.env.JAVA_HOME;
  assert.ok(sdk && ndk && serial && javaHome, 'explicit SDK NDK serial and JAVA_HOME required');
  const code = process.env.VSCODE_PATH || path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Microsoft VS Code', 'Code.exe');
  const adb = path.join(root, 'resources', 'platform-tools', 'win32-x64', 'adb.exe');
  assert.ok(fs.existsSync(code), 'VSCODE_PATH or default Code.exe required');
  assert.equal(run(adb, ['-s', serial, 'get-state']).trim(), 'device', 'authorized device must be online');
  assert.equal(run(adb, ['-s', serial, 'shell', 'getprop', 'ro.product.cpu.abi']).trim(), 'arm64-v8a', 'fixture requires arm64-v8a');

  fs.mkdirSync(artifactRoot, { recursive: true });
  for (const protectedPath of [path.join(root, 'src'), path.join(root, 'dist'), path.join(root, 'resources', 'jvm-debugger')]) {
    assert.ok(fs.existsSync(protectedPath), '运行时保护路径必须存在：' + protectedPath);
  }
  const runtimeBefore = {
    ts: hashTree(path.join(root, 'src'), file => file.endsWith('.ts')),
    jar: hashTree(path.join(root, 'resources', 'jvm-debugger'), file => file.endsWith('.jar')),
    src: hashTree(path.join(root, 'src')),
    dist: hashTree(path.join(root, 'dist')),
  };
  const hashEvidence = path.join(artifactRoot, 'coordinator-launch-runtime-hashes-' + Date.now() + '.json');
  fs.writeFileSync(hashEvidence, JSON.stringify({ before: runtimeBefore }, null, 2) + '\n');
  const buildFixture = loadFixtureBuilder();
  const completed = [];
  const failedModes = [];

  t.after(() => {
    const runtimeAfter = {
      ts: hashTree(path.join(root, 'src'), file => file.endsWith('.ts')),
      jar: hashTree(path.join(root, 'resources', 'jvm-debugger'), file => file.endsWith('.jar')),
      src: hashTree(path.join(root, 'src')),
      dist: hashTree(path.join(root, 'dist')),
    };
    fs.writeFileSync(hashEvidence, JSON.stringify({ before: runtimeBefore, after: runtimeAfter }, null, 2) + '\n');
    assert.deepEqual(runtimeAfter, runtimeBefore, 'TS/JAR/src/dist hashes must remain unchanged across all modes');
  });

  for (const mode of modes) {
    try {
      await t.test(mode, { timeout: 360000 }, async modeTest => {
        const directory = fs.mkdtempSync(path.join(artifactRoot, 'coordinator-launch-' + mode + '-'));
        const workspace = path.join(directory, 'workspace');
        fs.mkdirSync(workspace, { recursive: true });
        const packageName = 'dev.androidtools.fixture.l' + crypto.randomUUID().replaceAll('-', '');
        const resultFile = path.join(directory, 'result.json');
        const specFile = path.join(directory, 'spec.json');
        const baseline = run(adb, ['-s', serial, 'forward', '--list']).trim();
        let installed = false;
        let failure;
        try {
          const fixture = buildFixture(sdk, ndk, directory, workspace, packageName);
          assert.equal(fixturePid(adb, serial, packageName), 0, 'unique fixture must not already run');
          run(adb, ['-s', serial, 'install', '-r', fixture.apk]);
          installed = true;
          assert.ok(run(adb, ['-s', serial, 'shell', 'pm', 'path', packageName]).trim(), 'fixture package must be installed');
          const startOutput = run(adb, ['-s', serial, 'shell', 'am', 'start', '-W', '-n', packageName + '/dev.androidtools.debugfixture.DebugActivity']).trim();
          assert.match(startOutput, /Starting:/, 'fixture must use one ordinary am start -W');
          const pid = fixturePid(adb, serial, packageName);
          assert.ok(pid > 0, 'fixture PID must exist after ordinary start');
          const afterStart = snapshot(adb, serial, packageName);
          assert.equal(afterStart.pid, pid, 'ordinary start PID must be stable before attach');
          fs.writeFileSync(specFile, JSON.stringify({
            mode, sdk, ndk, serial, adb, packageName,
            activity: 'dev.androidtools.debugfixture.DebugActivity',
            pid, apk: fixture.apk, workspace,
            extensionRoot: root, sourceRoot: fixture.sourceRoot,
            javaSource: fixture.javaSource, nativeSource: fixture.nativeSource,
            hostBudgetMs: 330000, launchDiagnosticBudgetMs: 45000, baseline, runtimeBefore,
          }, null, 2) + '\n');
          modeTest.diagnostic('任务62模式证据目录：' + directory);
          const host = await runHost(code, specFile, workspace, directory, resultFile, modeTest.signal);
          assert.equal(host.exit, 0, mode + ' host must exit 0');
          assert.ok(host.outcome, mode + ' host must write result');
          assert.equal(host.outcome.status, 'COMPLETED', mode + ' must complete attach-launch-reattach path: ' + JSON.stringify({ stage: host.outcome.stage, error: host.outcome.error }));
          assert.equal(host.outcome.mode, mode);
          assert.equal(host.outcome.oldPid, pid);
          assert.ok(host.outcome.newPid > 0 && host.outcome.newPid !== pid, mode + ' launch must create a different PID');
          assert.equal(host.outcome.attachRounds?.length, 2, mode + ' must execute two old-PID attach rounds');
          assert.ok(host.outcome.attachRounds.every(item => item.status === 'PASS' && item.afterDisconnect?.pid === pid), mode + ' old-PID attach rounds must preserve PID');
          assert.equal(host.outcome.launch?.status, 'PASS', mode + ' production launch must pass');
          assert.equal(host.outcome.launch.afterDisconnect?.pid, host.outcome.newPid, mode + ' launch disconnect must preserve new PID');
          assert.equal(host.outcome.reattach?.status, 'PASS', mode + ' new-PID attach must pass');
          assert.equal(host.outcome.reattach.afterDisconnect?.pid, host.outcome.newPid, mode + ' new-PID attach must preserve new PID');
          assert.ok(host.outcome.starts && Object.values(host.outcome.starts).every(item => item.state !== 'pending'), mode + ' every raw start Promise must settle');
          assert.ok(host.outcome.disconnects.every(item => item.terminateDebuggee === false), mode + ' every parent disconnect must use terminateDebuggee=false');
          const afterHost = snapshot(adb, serial, packageName);
          assert.deepEqual(afterHost.forward.split(/\r?\n/).filter(Boolean).sort(), baseline.split(/\r?\n/).filter(Boolean).sort(), mode + ' must preserve exact forward baseline');
          assert.deepEqual(afterHost.servers, [], mode + ' must leave no lldb-server for this package before cleanup');
          assert.equal(afterHost.pid, host.outcome.newPid, mode + ' new PID must survive host completion before cleanup');
          completed.push({ mode, directory, packageName, oldPid: pid, newPid: host.outcome.newPid });
        } catch (error) {
          failure = error;
        } finally {
          if (installed) {
            try { cleanupFixture(adb, serial, packageName); }
            catch (cleanup) { failure = failure ? new AggregateError([failure, cleanup], '业务验证及fixture清理失败') : cleanup; }
          }
        }
        if (failure) {
          failedModes.push({ mode, error: String(failure.stack || failure) });
          throw failure;
        }
      });
    } catch (error) {
      failedModes.push({ mode, error: String(error.stack || error) });
      t.diagnostic(mode + '子测试已失败，继续独立执行其他模式：' + String(error.stack || error));
    }
  }

  assert.deepEqual(failedModes, [], '存在失败模式：' + JSON.stringify(failedModes));
  t.diagnostic(JSON.stringify({ modes: completed, hashEvidence }));
});
