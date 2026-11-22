const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');

/**
 * 功能点：授权设备上验证 Coordinator 同一 PID 的三模式三轮 reattach。
 * 受影响对象：本测试每个模式的唯一 APK、唯一包名、唯一隔离宿主、父 DAP、JVM/LLDB 子会话及本次测试产生的设备资源。
 * 复现路径：设置 ANDROID_COORDINATOR_REATTACH_TEST=1、ANDROID_SDK_ROOT、ANDROID_NDK_ROOT、ANDROID_DEBUG_TEST_SERIAL、JAVA_HOME；每个模式构建并安装唯一 fixture，普通 am start 一次且不加 -D，连续 attach 三轮。
 * 测试范围：java、native、dual 各自独立宿主；显式广播 pid/java43/native43，真实 verified/source frame/value41，next 后源码下一行/value42，continue/pause，parent disconnect(false)，父子 termination，迟到启动 Promise、同 PID、forward/server 基线和源码运行时哈希。
 * 执行入口：ANDROID_COORDINATOR_REATTACH_TEST=1 node --test tests/coordinator-reattach-device.test.js。
 * 预期结果：每模式宿主 exit 0 且三轮 PASS；三轮 PID 相同；forward 精确恢复基线；本次包的 lldb-server 为零；TS、JAR、src 运行前后哈希一致。
 * 判据：所有模式均满足上述断言才通过；任一超时、pending、active、PID 变化、资源差异或伪造父成功均失败；验证在 force-stop/uninstall 前完成。
 */

const root = path.resolve(__dirname, '..');
const artifactRoot = path.join(root, '.test-artifacts');
const modes = ['java', 'native', 'dual'];

/** 功能：执行前台工具命令；输入命令、参数和可选执行项；输出 UTF-8 文本，失败原样抛出；验证：fixture 构建和 adb 预检。 */
function run(command, args, options = {}) {
  return execFileSync(command, args, { windowsHide: true, encoding: 'utf8', timeout: 60000, ...options });
}

/** 功能：按目录递归记录文件 SHA-256；输入目录；输出相对路径到哈希的稳定映射；验证：宿主运行前后源码和运行时未改变。 */
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

/** 功能：读取目标 fixture PID；输入 adb、serial、包名；输出 PID 或 0；验证：仅接受 pidof 无输出退出 1 为不存在。 */
function fixturePid(adb, serial, packageName) {
  try {
    return Number(run(adb, ['-s', serial, 'shell', 'pidof', '-s', packageName]).trim() || 0);
  } catch (error) {
    if (error.status === 1 && !String(error.stdout || '').trim() && !String(error.stderr || '').trim()) return 0;
    throw error;
  }
}

/** 功能：构建含显式广播控制面的唯一 Java/JNI APK；输入 SDK、NDK、隔离目录和包名；输出 APK、源码及工作区路径；验证：签名 APK 可供真实宿主 attach。 */
function buildFixture(sdk, ndk, directory, workspace, packageName) {
  const tools = path.join(sdk, 'build-tools', '35.0.0');
  const androidJar = path.join(sdk, 'platforms', 'android-35', 'android.jar');
  const javaHome = process.env.JAVA_HOME;
  assert.ok(javaHome, 'JAVA_HOME required');
  const binary = name => path.join(javaHome, 'bin', name + (process.platform === 'win32' ? '.exe' : ''));
  const sourceRoot = path.join(workspace, 'src', 'dev', 'androidtools', 'debugfixture');
  const classes = path.join(directory, 'classes');
  const dex = path.join(directory, 'dex');
  const libraries = path.join(workspace, '.cxx', 'debug', 'arm64-v8a');
  fs.mkdirSync(sourceRoot, { recursive: true });
  fs.mkdirSync(classes, { recursive: true });
  fs.mkdirSync(dex, { recursive: true });
  fs.mkdirSync(libraries, { recursive: true });
  const javaSource = path.join(sourceRoot, 'DebugActivity.java');
  const receiverSource = path.join(sourceRoot, 'TriggerReceiver.java');
  const nativeSource = path.join(workspace, 'debugfixture.c');
  fs.writeFileSync(javaSource, `package dev.androidtools.debugfixture;\n\nimport android.app.Activity;\nimport android.os.Bundle;\nimport android.widget.TextView;\n\n/** 隔离 reattach Activity：普通启动不触发 marker，显式广播在原 PID 中执行 Java/JNI marker。 */\npublic class DebugActivity extends Activity {\n    private int counter;\n    private TextView output;\n    static DebugActivity current;\n\n    /** 初始化唯一 fixture；输入系统 saved state；输出可见文本和广播控制面，不启动额外 Activity。 */\n    @Override public void onCreate(Bundle savedInstanceState) {\n        super.onCreate(savedInstanceState);\n        System.loadLibrary("debugfixture");\n        current = this;\n        output = new TextView(this);\n        output.setTextSize(24);\n        output.setText("Reattach fixture ready");\n        setContentView(output);\n    }\n\n    /** 显式广播执行入口；输入无；输出原 PID 与 Java/JNI 结果 43，供三轮 attach 触发。 */\n    String trigger() { return "pid=" + android.os.Process.myPid() + ";java=" + marker(41) + ";native=" + nativeMarker(41); }\n\n    /** Java 断点锚点；输入初始值 41；输出加二结果 43；验证：真实 JVM frame/value41 与 next 后 value42。 */\n    private int marker(int initial) {\n        int value = initial; // JAVA_BREAKPOINT\n        value++;\n        counter = helper(value);\n        return counter;\n    }\n\n    /** Java 单步目标；输入 marker 加一后的值；输出最终值 43；验证：next 后源码下一行及 value42。 */\n    private int helper(int value) {\n        return value + 1; // JAVA_STEP_TARGET\n    }\n\n    /** JNI 入口；输入初始值 41；输出加二结果 43；验证：真实 Native frame/value41 与 next 后 value42。 */\n    private static native int nativeMarker(int value);\n}\n`);
  fs.writeFileSync(receiverSource, `package dev.androidtools.debugfixture;\n\n/** 唯一显式广播接收器；输入测试 action；输出原 PID 与 Java/JNI marker 结果，不启动 Activity。 */\npublic class TriggerReceiver extends android.content.BroadcastReceiver {\n    @Override public void onReceive(android.content.Context context, android.content.Intent intent) {\n        if (DebugActivity.current == null) { setResultCode(1); setResultData("activity-not-ready"); return; }\n        setResultCode(0);\n        setResultData(DebugActivity.current.trigger());\n    }\n}\n`);
  fs.writeFileSync(nativeSource, `#include <jni.h>\n\n/* Native 断点锚点；每次显式广播调用一次。 */\nJNIEXPORT jint JNICALL Java_dev_androidtools_debugfixture_DebugActivity_nativeMarker(\n        JNIEnv *env, jclass activity, jint initial) {\n    volatile int value = initial; /* NATIVE_BREAKPOINT */\n    value++;\n    return value + 1;\n}\n`);
  const manifest = path.join(directory, 'AndroidManifest.xml');
  fs.writeFileSync(manifest, `<?xml version="1.0" encoding="utf-8"?>\n<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="${packageName}">\n  <uses-sdk android:minSdkVersion="23" android:targetSdkVersion="35" />\n  <application android:debuggable="true" android:label="Coordinator Reattach Fixture" android:extractNativeLibs="true" android:theme="@android:style/Theme.Material.Light.NoActionBar">\n    <activity android:name="dev.androidtools.debugfixture.DebugActivity" android:exported="true">\n      <intent-filter>\n        <action android:name="android.intent.action.MAIN" />\n        <category android:name="android.intent.category.LAUNCHER" />\n      </intent-filter>\n    </activity>\n    <receiver android:name="dev.androidtools.debugfixture.TriggerReceiver" android:exported="true" />\n  </application>\n</manifest>\n`);
  run(binary('javac'), ['-encoding', 'UTF-8', '-g', '-source', '8', '-target', '8', '-classpath', androidJar, '-d', classes, javaSource, receiverSource]);
  const clang = path.join(ndk, 'toolchains', 'llvm', 'prebuilt', 'windows-x86_64', 'bin', 'clang.exe');
  const sysroot = path.join(ndk, 'toolchains', 'llvm', 'prebuilt', 'windows-x86_64', 'sysroot');
  const library = path.join(libraries, 'libdebugfixture.so');
  run(clang, ['--target=aarch64-linux-android23', '--sysroot=' + sysroot, '-shared', '-fPIC', '-g', '-O0', nativeSource, '-o', library]);
  const packagedLibrary = path.join(dex, 'lib', 'arm64-v8a');
  fs.mkdirSync(packagedLibrary, { recursive: true });
  fs.copyFileSync(library, path.join(packagedLibrary, 'libdebugfixture.so'));
  const jar = path.join(directory, 'classes.jar');
  run(binary('jar'), ['cf', jar, '-C', classes, '.']);
  run(binary('java'), ['-cp', path.join(tools, 'lib', 'd8.jar'), 'com.android.tools.r8.D8', '--min-api', '23', '--output', dex, jar]);
  const unsigned = path.join(directory, 'unsigned.apk');
  run(path.join(tools, 'aapt.exe'), ['package', '-f', '-M', manifest, '-I', androidJar, '-F', unsigned]);
  run(path.join(tools, 'aapt.exe'), ['add', unsigned, 'classes.dex', 'lib/arm64-v8a/libdebugfixture.so'], { cwd: dex });
  const keystore = path.join(directory, 'fixture.keystore');
  run(binary('keytool'), ['-genkeypair', '-keystore', keystore, '-storepass', 'android', '-keypass', 'android', '-alias', 'fixture', '-dname', 'CN=Coordinator Reattach Fixture', '-keyalg', 'RSA', '-validity', '30']);
  const aligned = path.join(directory, 'aligned.apk');
  run(path.join(tools, 'zipalign.exe'), ['-f', '4', unsigned, aligned]);
  const apk = path.join(directory, 'fixture.apk');
  run(binary('java'), ['-jar', path.join(tools, 'lib', 'apksigner.jar'), 'sign', '--ks', keystore, '--ks-pass', 'pass:android', '--out', apk, aligned]);
  return { apk, workspace, sourceRoot: path.join(workspace, 'src'), javaSource, nativeSource, manifest };
}

/** 功能：启动单模式隔离VS Code宿主并绑定取消和期限；输入spec、目录和测试信号；输出退出码与结果，结束后回收自有宿主；验证：本文件三模式入口。 */
async function runHost(code, specPath, workspace, directory, result, signal) {
  const userData = path.join(directory, 'user-data');
  const env = {
    ...process.env,
    COORDINATOR_REATTACH_HOST_SPEC: specPath,
    COORDINATOR_REATTACH_HOST_RESULT: result,
    COORDINATOR_REATTACH_HOST_WORKSPACE: workspace,
  };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'VSCODE_IPC_HOOK_CLI', 'VSCODE_PID', 'VSCODE_CWD']) delete env[key];
  const child = spawn(code, ['--user-data-dir', userData, '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', '--extensionDevelopmentPath', root, '--extensionTestsPath', path.join(root, 'tests', 'coordinator-reattach-host-runner.cjs'), workspace], { env, windowsHide: false });
  child.stdout.on('data', data => fs.appendFileSync(path.join(directory, 'host-stdout.log'), data));
  child.stderr.on('data', data => fs.appendFileSync(path.join(directory, 'host-stderr.log'), data));
  let timer;
  const exited = new Promise(resolve => child.once('close', resolve));
  const abort = () => { if (child.exitCode === null) child.kill(); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    const exit = await new Promise((resolve, reject) => {
      timer = setTimeout(() => { abort(); reject(new Error('隔离宿主超过330秒诊断上限')); }, 330000);
      child.once('error', reject);
      child.once('close', resolve);
      if (signal.aborted) { abort(); reject(signal.reason); }
    });
    return { exit, outcome: fs.existsSync(result) ? JSON.parse(fs.readFileSync(result, 'utf8')) : null };
  } finally { clearTimeout(timer); signal.removeEventListener('abort', abort); abort(); await exited; }
}

/** 功能：获取本次包的资源快照；输入 adb、serial、包名；输出 PID、forward 和本包 lldb-server 行；验证：宿主结束后在清理前精确断言。 */
function snapshot(adb, serial, packageName) {
  const text = args => run(adb, ['-s', serial, ...args]).trim();
  return {
    pid: fixturePid(adb, serial, packageName),
    forward: text(['forward', '--list']),
    servers: text(['shell', 'ps', '-A', '-o', 'PID,ARGS']).split(/\r?\n/).filter(line => line.includes('/' + packageName + '/') && line.includes('/lldb-server')),
  };
}

/** 功能：卸载本测试唯一fixture；输入adb、serial和已安装包名；输出精确清理或聚合错误；验证：本入口不删除forward、不终止无关进程。 */
function cleanupFixture(adb, serial, packageName) {
  const text = args => run(adb, ['-s', serial, ...args]).trim();
  const errors = [];
  try { text(['shell', 'am', 'force-stop', packageName]); } catch (error) { errors.push(error); }
  try { text(['uninstall', packageName]); } catch (error) { errors.push(error); }
  if (errors.length) throw new AggregateError(errors, '唯一fixture清理失败');
}

test('authorized Coordinator reattach keeps one PID across java/native/dual modes', {
  skip: process.env.ANDROID_COORDINATOR_REATTACH_TEST !== '1' && 'explicit reattach device authorization required',
  timeout: 1100000,
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
  const runtimeBefore = {
    ts: hashTree(path.join(root, 'src'), file => file.endsWith('.ts')),
    jar: hashTree(path.join(root, 'resources', 'jvm-debugger'), file => file.endsWith('.jar')),
    src: hashTree(path.join(root, 'src')),
    dist: hashTree(path.join(root, 'dist')),
  };
  const hashEvidence = path.join(artifactRoot, 'coordinator-reattach-runtime-hashes-' + Date.now() + '.json');
  fs.writeFileSync(hashEvidence, JSON.stringify({ before: runtimeBefore }, null, 2) + '\n');
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
  const completed = [];

  for (const mode of modes) await t.test(mode, { timeout: 360000 }, async modeTest => {
    const directory = fs.mkdtempSync(path.join(artifactRoot, 'coordinator-reattach-' + mode + '-'));
    const workspace = path.join(directory, 'workspace');
    fs.mkdirSync(workspace, { recursive: true });
    const packageName = 'dev.androidtools.fixture.r' + crypto.randomUUID().replaceAll('-', '');
    const fixture = buildFixture(sdk, ndk, directory, workspace, packageName);
    const result = path.join(directory, 'result.json');
    const spec = path.join(directory, 'spec.json');
    const text = args => run(adb, ['-s', serial, ...args]).trim();
    const baseline = text(['forward', '--list']);
    let installed = false;
    try {
      assert.equal(fixturePid(adb, serial, packageName), 0, 'unique fixture must not already run');
      run(adb, ['-s', serial, 'install', '-r', fixture.apk]);
      installed = true;
      assert.ok(text(['shell', 'pm', 'path', packageName]), 'fixture package must be installed');
      const startOutput = text(['shell', 'am', 'start', '-W', '-n', packageName + '/dev.androidtools.debugfixture.DebugActivity']);
      assert.match(startOutput, /Starting:/, 'fixture must use one ordinary am start');
      const pid = fixturePid(adb, serial, packageName);
      assert.ok(pid > 0, 'fixture PID must exist after ordinary start');
      const preflight = text(['shell', 'am', 'broadcast', '--receiver-foreground', '-n', packageName + '/dev.androidtools.debugfixture.TriggerReceiver', '-a', packageName + '.TRIGGER']);
      assert.match(preflight, new RegExp('pid=' + pid + ';java=43;native=43'), 'explicit broadcast preflight must return both markers');
      const afterStart = snapshot(adb, serial, packageName);
      assert.equal(afterStart.pid, pid, 'preflight must not change PID');
      fs.writeFileSync(spec, JSON.stringify({ mode, sdk, ndk, serial, adb, packageName, activity: 'dev.androidtools.debugfixture.DebugActivity', pid, apk: fixture.apk, workspace, extensionRoot: root, sourceRoot: fixture.sourceRoot, javaSource: fixture.javaSource, nativeSource: fixture.nativeSource, hostBudgetMs: 330000, baseline, runtimeBefore }, null, 2) + '\n');
      t.diagnostic('同PID真实宿主证据：' + directory);
      const host = await runHost(code, spec, workspace, directory, result, modeTest.signal);
      assert.equal(host.exit, 0, mode + ' host must exit 0');
      assert.ok(host.outcome, mode + ' host must write result');
      assert.equal(host.outcome.success, true, mode + ' must pass all rounds: ' + JSON.stringify({ checks: host.outcome.checks?.map(item => ({ round: item.round, status: item.status, pid: item.afterDisconnect?.pid, error: item.error, terminationError: item.terminationError })) }));
      assert.equal(host.outcome.checks.length, 3, mode + ' must execute three rounds');
      assert.ok(host.outcome.checks.every(item => item.status === 'PASS'), mode + ' every round must PASS');
      assert.equal(new Set(host.outcome.checks.map(item => item.afterDisconnect?.pid)).size, 1, mode + ' rounds must keep one PID');
      assert.equal(host.outcome.checks[0].afterDisconnect.pid, pid, mode + ' PID must equal ordinary-start PID');
      assert.ok(host.outcome.checks.every(item => item.startRaw?.state !== 'pending'), mode + ' start Promise must settle');
      assert.ok(host.outcome.checks.every(item => item.disconnect?.sent?.message?.arguments?.terminateDebuggee === false), mode + ' parent disconnect must use false');
      const afterHost = snapshot(adb, serial, packageName);
      assert.deepEqual(afterHost.forward.split(/\r?\n/).filter(Boolean).sort(), baseline.split(/\r?\n/).filter(Boolean).sort(), mode + ' must restore exact forward baseline before cleanup');
      assert.deepEqual(afterHost.servers, [], mode + ' must leave no lldb-server for this package before cleanup');
      assert.equal(afterHost.pid, pid, mode + ' fixture PID must survive all parent disconnects before cleanup');
      completed.push({ mode, directory, packageName, pid, hostExit: host.exit, checks: host.outcome.checks.map(item => ({ round: item.round, status: item.status })) });
    } finally {
      if (installed) cleanupFixture(adb, serial, packageName);
    }
  });

  t.diagnostic(JSON.stringify({ modes: completed, hashEvidence }));
});
