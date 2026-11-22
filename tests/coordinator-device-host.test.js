/** 功能点：授权设备上的 Coordinator 六组合真实宿主验收。
 * 受影响对象：统一父会话、复用的Native/JVM能力、Dual组合、Java控制面及扩展停用。
 * 复现路径：ANDROID_COORDINATOR_DEVICE_TEST=1，显式 SDK/NDK/serial，已编译扩展和已安装 CodeLLDB；每次生成唯一测试包避免签名覆盖。
 * 测试范围：专用 Java/JNI APK 构建、六组合真实线程/断点/变量/单步、断开后精确资源快照。
 * 执行入口：npm test；设备入口需上述显式 opt-in。
 * 预期结果：隔离宿主实际启动六种调试会话，既有 forward 保留且自有 server 退出。
 * 判据：六项通过、forward精确恢复基线、无本次包的lldb-server残留；绝不按快照差集自动删除他人映射。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..');

/** 功能：以前台 argv 执行构建工具；输入命令及参数；输出失败原样抛出。 */
function run(command, args, options = {}) { return execFileSync(command, args, { windowsHide: true, encoding: 'utf8', timeout: 60000, ...options }); }

/** 功能：用本机 Android 工具构建专用 APK；输入已授权 SDK 及自有目录；输出签名 APK。 */
function buildFixture(sdk, ndk, directory, workspace, packageName) {
  const tools = path.join(sdk, 'build-tools', '35.0.0');
  const android = path.join(sdk, 'platforms', 'android-35', 'android.jar');
  const java = process.env.JAVA_HOME;
  assert.ok(java, 'JAVA_HOME required');
  const binary = name => path.join(java, 'bin', name + (process.platform === 'win32' ? '.exe' : ''));
  const fixture = path.join(root, 'tests/fixtures/android-debugger');
  const classes = path.join(directory, 'classes'), dex = path.join(directory, 'dex');
  fs.mkdirSync(classes); fs.mkdirSync(dex);
  const sources = path.join(workspace, 'src', 'dev', 'androidtools', 'debugfixture'); fs.mkdirSync(sources, { recursive: true });
  const source = path.join(sources, 'DebugActivity.java');
  const text = fs.readFileSync(path.join(fixture, 'java/dev/androidtools/debugfixture/DebugActivity.java'), 'utf8');
  fs.writeFileSync(source, text.replace('if (getIntent().getBooleanExtra("native", false))', 'if (true)').replace('output.setOnClickListener(view -> output.setText("Native " + nativeMarker(41)));', 'output.setOnClickListener(view -> output.setText("Native " + nativeMarker(marker(41))));'));
  run(binary('javac'), ['-encoding', 'UTF-8', '-g', '-source', '8', '-target', '8', '-classpath', android, '-d', classes, source]);
  const nativeSource = path.join(workspace, 'debugfixture.c'); fs.copyFileSync(path.join(fixture, 'native/debugfixture.c'), nativeSource);
  const libraries = path.join(workspace, '.cxx', 'debug', 'arm64-v8a'); fs.mkdirSync(libraries, { recursive: true });
  const library = path.join(libraries, 'libdebugfixture.so');
  const clang = path.join(ndk, 'toolchains/llvm/prebuilt/windows-x86_64/bin/clang.exe');
  run(clang, ['--target=aarch64-linux-android23', '--sysroot=' + path.join(ndk, 'toolchains/llvm/prebuilt/windows-x86_64/sysroot'), '-shared', '-fPIC', '-g', '-O0', nativeSource, '-o', library]);
  const packagedLibrary = path.join(dex, 'lib', 'arm64-v8a'); fs.mkdirSync(packagedLibrary, { recursive: true }); fs.copyFileSync(library, path.join(packagedLibrary, 'libdebugfixture.so'));
  const jar = path.join(directory, 'classes.jar');
  run(binary('jar'), ['cf', jar, '-C', classes, '.']);
  run(binary('java'), ['-cp', path.join(tools, 'lib/d8.jar'), 'com.android.tools.r8.D8', '--min-api', '23', '--output', dex, jar]);
  const unsigned = path.join(directory, 'unsigned.apk');
  const manifest = path.join(directory, 'AndroidManifest.xml');
  fs.writeFileSync(manifest, fs.readFileSync(path.join(fixture, 'AndroidManifest.xml'), 'utf8').replace('package="dev.androidtools.debugfixture"', `package="${packageName}"`).replace('android:name=".DebugActivity"', 'android:name="dev.androidtools.debugfixture.DebugActivity"'));
  run(path.join(tools, 'aapt.exe'), ['package', '-f', '-M', manifest, '-I', android, '-F', unsigned]);
  run(path.join(tools, 'aapt.exe'), ['add', unsigned, 'classes.dex', 'lib/arm64-v8a/libdebugfixture.so'], { cwd: dex });
  const keystore = path.join(directory, 'fixture.keystore');
  run(binary('keytool'), ['-genkeypair', '-keystore', keystore, '-storepass', 'android', '-keypass', 'android', '-alias', 'fixture', '-dname', 'CN=Android Tools Fixture', '-keyalg', 'RSA', '-validity', '30']);
  const aligned = path.join(directory, 'aligned.apk');
  run(path.join(tools, 'zipalign.exe'), ['-f', '4', unsigned, aligned]);
  const apk = path.join(directory, 'fixture.apk');
  run(binary('java'), ['-jar', path.join(tools, 'lib/apksigner.jar'), 'sign', '--ks', keystore, '--ks-pass', 'pass:android', '--out', apk, aligned]);
  return apk;
}

test('authorized Coordinator six debug combinations run in a real VS Code host', {
  skip: process.env.ANDROID_COORDINATOR_DEVICE_TEST !== '1' && 'explicit device authorization required', timeout: 300000,
}, async t => {
  const sdk = process.env.ANDROID_SDK_ROOT, ndk = process.env.ANDROID_NDK_ROOT, serial = process.env.ANDROID_DEBUG_TEST_SERIAL;
  assert.ok(sdk && ndk && serial, 'explicit SDK NDK and serial required');
  const code = process.env.VSCODE_PATH || path.join(process.env.LOCALAPPDATA, 'Programs/Microsoft VS Code/Code.exe');
  const adb = path.join(root, 'resources/platform-tools/win32-x64/adb.exe');
  const artifacts = path.join(root, '.test-artifacts');
  const directory = fs.mkdtempSync(path.join(artifacts, 'coordinator-host-'));
  t.diagnostic('真实宿主证据：' + directory);
  const workspace = path.join(directory, 'workspace'); fs.mkdirSync(workspace);
  const packageName = 'dev.androidtools.fixture.r' + require('node:crypto').randomUUID().replaceAll('-', '');
  const apk = buildFixture(sdk, ndk, directory, workspace, packageName);
  const text = args => run(adb, ['-s', serial, ...args]).trim();
  const baseline = text(['forward', '--list']);
  const result = path.join(directory, 'result.json');
  const spec = path.join(directory, 'spec.json');
  fs.writeFileSync(spec, JSON.stringify({ sdk, ndk, serial, adb, apk, packageName, activity: 'dev.androidtools.debugfixture.DebugActivity', sources: path.join(workspace, 'src'), nativeSource: path.join(workspace, 'debugfixture.c') }));
  let child;
  try {
    const env = { ...process.env, COORDINATOR_HOST_SPEC: spec, COORDINATOR_HOST_RESULT: result, COORDINATOR_HOST_WORKSPACE: workspace };
    for (const key of ['ELECTRON_RUN_AS_NODE', 'VSCODE_IPC_HOOK_CLI', 'VSCODE_PID', 'VSCODE_CWD']) delete env[key];
    child = spawn(code, ['--user-data-dir', path.join(directory, 'user-data'), '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', '--extensionDevelopmentPath', root, '--extensionTestsPath', path.join(root, 'tests/coordinator-host-runner.cjs'), workspace], { env, windowsHide: false });
    child.stdout.on('data', data => fs.appendFileSync(path.join(directory, 'stdout.log'), data));
    child.stderr.on('data', data => fs.appendFileSync(path.join(directory, 'stderr.log'), data));
    const abort = () => child.kill(); t.signal.addEventListener('abort', abort, { once: true });
    const exit = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', code => resolve(code)); });
    t.signal.removeEventListener('abort', abort);
    assert.ok(fs.existsSync(result), 'host did not produce result, exit=' + exit);
    const outcome = JSON.parse(fs.readFileSync(result, 'utf8'));
    assert.equal(outcome.success, true, JSON.stringify(outcome)); assert.equal(outcome.checks.length, 6);
    assert.equal(exit, 0);
    const after = text(['forward', '--list']);
    assert.deepEqual(after.split(/\r?\n/).filter(Boolean).sort(), baseline.split(/\r?\n/).filter(Boolean).sort(), 'Native forward lifecycle must restore the exact baseline');
    const servers = text(['shell', 'ps', '-A', '-o', 'PID,ARGS']).split(/\r?\n/).filter(line => line.includes('/' + packageName + '/') && line.includes('/lldb-server'));
    assert.deepEqual(servers, []);
  } finally {
    if (child?.exitCode === null) child.kill();
    text(['shell', 'am', 'force-stop', packageName]);
    if (text(['shell', 'pm', 'path', packageName])) text(['uninstall', packageName]);
    fs.writeFileSync(path.join(directory, 'resources.json'), JSON.stringify({ baseline, after: text(['forward', '--list']) }));
  }
});
