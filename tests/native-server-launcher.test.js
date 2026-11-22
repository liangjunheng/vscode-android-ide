/**
 * 功能点：Native设备启动器的编译与监听事件屏障。
 * 受影响对象：compileServerLauncher及设备侧inotify/fork/signalfd生命周期。
 * 复现路径：Node>=22，真实生成C源码与临时目录，替换NDK编译进程边界。
 * 测试范围：全部支持ABI、参数分离、先注册后exec、精确socket身份、编译失败清理。
 * 执行入口：node --test tests/native-server-launcher.test.js；真实设备执行coordinator-reattach-device.test.js。
 * 预期结果：产物归属独立，只有监听后文件事件才发布ready，编译失败不残留。
 * 判据：全部参数、源码顺序和目录断言通过；C运行行为须另由真机验证。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const sync = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { transformSync } = require('esbuild');

/** 功能：加载实际启动器编译逻辑；输入编译过程边界；输出真实生产导出；验证：本文件全部用例。 */
function load(exec) {
  const module = { exports: {} };
  vm.runInNewContext(transformSync(sync.readFileSync('src/android-debugger/native-debugger/serverLauncher.ts', 'utf8'), { loader: 'ts', format: 'cjs' }).code,
    { module, exports: module.exports, require: id => id === 'teen_process' ? { exec } : require(id), process });
  return module.exports;
}

test('launcher registers events before child exec and builds each ABI with argv', async () => {
  const targets = ['armv7a-linux-androideabi23', 'armv7a-linux-androideabi23', 'aarch64-linux-android23', 'i686-linux-android23', 'x86_64-linux-android23'];
  let index = 0;
  const api = load(async (command, args) => {
    assert.equal(path.basename(command), process.platform === 'win32' ? 'clang.exe' : 'clang');
    assert.equal(args[0], '--target=' + targets[index++]);
    const source = await fs.readFile(args[args.indexOf('-Werror') + 1], 'utf8');
    assert.ok(source.indexOf('inotify_add_watch') < source.indexOf('pid_t child = fork()'));
    assert.match(source, /IN_MOVED_TO \| IN_CLOSE_WRITE/);
    assert.match(source, /"--socket-file"/);
    assert.match(source, /strcmp\(socket, argv\[3\]/);
    assert.match(source, /signalfd\(/);
    assert.match(source, /ANDROID_NATIVE_LISTENING/);
    assert.doesNotMatch(source, /sleep\(|usleep\(/);
    await fs.writeFile(args.at(-1), 'fixture executable');
  });
  for (const abi of ['armeabi', 'armeabi-v7a', 'arm64-v8a', 'x86', 'x86_64']) {
    const launcher = await api.compileServerLauncher('NDK path with spaces', abi);
    assert.equal(await fs.readFile(launcher.file, 'utf8'), 'fixture executable');
    await launcher.close(); assert.equal(sync.existsSync(path.dirname(launcher.file)), false);
  }
});

test('launcher rejects unknown ABI and cleans failed compilation output', async () => {
  let directory;
  const api = load(async (_command, args) => { directory = path.dirname(args.at(-1)); throw new Error('compile denied'); });
  await assert.rejects(api.compileServerLauncher('ndk', 'unknown'), /Unsupported/);
  assert.equal(directory, undefined);
  await assert.rejects(api.compileServerLauncher('ndk', 'arm64-v8a'), /compile denied/);
  assert.equal(sync.existsSync(directory), false);
});
