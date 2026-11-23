/** 功能点：独立 Native 连接的配置、命令与资源契约。
 * 受影响对象：prepareNativeConnection、contracts、工具链校验、nativeSymbols、NativeForwardLease。
 * 复现路径：Node>=22，临时项目提供 SDK/NDK 和真实库文件，只替换宿主、设备部署及项目库发现边界，直接调用公开连接函数。
 * 测试范围：七项覆盖 PID/身份、独立项目根、工具链/ABI、真实命令、无库提示、取消及聚合回收。
 * 执行入口：node --test tests/native-codelldb.test.js。
 * 预期结果：配置指向确定目标，未知引擎字段保留，信号不泄露，关闭只回收自有 server 和转发。
 * 判据：全部断言成立；不包含配置 provider、应用生命周期、实际 CodeLLDB 连接或真机验收。 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { build } = require('esbuild');
const root = path.resolve(__dirname, '..');

/** 功能：复制跨 VM 配置；输入纯配置；输出本地断言值。 */
function plain(value) { return JSON.parse(JSON.stringify(value)); }

/** 功能：读取实际日志命令；输入引擎配置；输出反转义的日志文件路径。 */
function logFile(config) { return /^log enable -f "(.*)" lldb platform$/.exec(config.initCommands[0])[1].replace(/\\(["\\])/g, '$1'); }

/** 功能：装配真实连接、校验和租约；输入测试上下文；输出可控设备边界及临时工具链。 */
async function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'native-connection-test-'));
  const sdk = path.join(directory, 'sdk'), ndk = path.join(directory, 'ndk');
  fs.mkdirSync(sdk);
  fs.mkdirSync(path.join(ndk, 'toolchains', 'llvm'), { recursive: true });
  const adb = path.join(directory, process.platform === 'win32' ? 'adb.exe' : 'adb');
  fs.writeFileSync(adb, 'unused-device-boundary');
  const library = path.join(directory, 'libproject.so');
  fs.writeFileSync(library, 'project-library');
  const f = { directory, sdk, ndk, adb, library, calls: [], notices: [], servers: [], stopped: [], removed: [], forwards: [], libraries: [library], supported: ['arm64-v8a'], connections: [], expectedCloseErrors: new Set() };
  const mocks = {
    vscode: { window: {
      // 仅记录警告，不替代调试器的实际连接结果。
      async showWarningMessage(message) { f.notices.push(message); },
    } },
    sdk: { sdkRoot: () => sdk, adbPath: () => adb },
    projectLocalConfig: { readProjectLocalConfig: () => ({ sdkPath: sdk, debugger: { ndkPath: ndk, adbPath: adb } }) },
    runtimeContext: { getRuntimeContext: () => undefined },
    projectLibraries: {
      // 项目产物发现仍由真实符号算法分组和生成命令。
      async discoverProjectLibraries(projectRoot, abi) { f.calls.push(['libraries', projectRoot, abi]); if (f.libraryFailure) throw f.libraryFailure; return f.libraries; },
    },
    android: {
      async getDeviceFromUDID(udid) { return { udid, state: 'device' }; },
      // 模拟迟到部署，所有 stop 都对应一个明确的 server。
      async startLldbServer(target, packageName, abi) {
        f.calls.push(['server', target, packageName, abi]);
        if (f.serverFailure) throw f.serverFailure;
        const socket = f.socket ?? 'platform-' + f.servers.length;
        const server = { socket,
          // 保留每次停止及原始错误，供幂等与聚合断言。
          async stop() { f.stopped.push(socket); if (f.stopFailure) throw f.stopFailure; },
        };
        f.servers.push(server);
        f.serverEntered?.resolve();
        if (f.serverGate) await f.serverGate.promise;
        return server;
      },
      // 转发由真实租约持有，不建立实际 ADB 连接。
      async getDeviceAdb(target) {
        f.calls.push(['adb', target]);
        if (f.adbFailure) throw f.adbFailure;
        return {
          // 可控制转发准备迟到；关闭时读取同一真实快照边界。
          async getForwardList() {
            if (f.forwardFailure) throw f.forwardFailure;
            const pending = f.forwardGate;
            f.forwardGate = undefined;
            f.forwardEntered?.resolve();
            if (pending) await pending.promise;
            return f.forwards;
          },
          // 仅移除本串号的精确端口，保留其他映射。
          async removePortForward(port) { f.removed.push(port); f.forwards = f.forwards.filter(row => !row.startsWith('serial tcp:' + port + ' ')); },
        };
      },
    },
  };
  const bundle = await build({ stdin: { contents: "export * from './src/android-debugger/native-debugger/adapter';", resolveDir: root, loader: 'ts' }, bundle: true, write: false, platform: 'node', format: 'cjs', plugins: [{ name: 'native-connection-boundaries',
    // 只替换外部宿主和发现来源，不替换连接、结构校验、工具链选择、符号命令及租约。
    setup(builder) {
      builder.onResolve({ filter: /^vscode$/ }, () => ({ path: 'mock:vscode', external: true }));
      builder.onResolve({ filter: /(?:^|\/)(?:android|sdk|projectLocalConfig|runtimeContext|projectLibraries)$/ }, args => ({ path: 'mock:' + args.path.split('/').at(-1), external: true }));
    },
  }] });
  const module = { exports: {} };
  vm.runInNewContext(bundle.outputFiles[0].text, { module, exports: module.exports, require: id => id.startsWith('mock:') ? mocks[id.slice(5)] : require(id), process, console, Buffer, AbortController, AbortSignal });
  f.api = module.exports;
  f.folder = { uri: { fsPath: directory } };
  f.device = { serial: 'serial', projectRoot: directory,
    // 严格复刻 DebugDevice.abis 的包名、信号契约，不接受旧 Coordinator 参数。
    async abis(packageName, signal) {
      assert.equal(packageName, 'com.example.app');
      assert.ok(signal instanceof AbortSignal);
      f.calls.push(['abis', packageName, signal]);
      f.abiEntered?.resolve();
      if (f.abiGate) await f.abiGate.promise;
      signal.throwIfAborted();
      if (f.abiFailure) throw f.abiFailure;
      return f.supported;
    },
  };
  // 提供最终已替换配置，不注册旧 provider 或生命周期管理器。
  f.config = overrides => ({ type: 'android-debug', name: 'Native', request: 'attach', mode: 'native', pid: 42, packageName: 'com.example.app', native: { abi: 'arm64-v8a' }, ...overrides });
  // 直接调用新公开函数，并记录成功返回的资源以便测试清理。
  f.connect = async (config = f.config(), signal = new AbortController().signal) => {
    const connection = await f.api.prepareNativeConnection(config, 42, f.device, signal, f.folder);
    f.connections.push(connection);
    return connection;
  };
  // 清理本用例资源；预期之外的关闭失败仍使测试失败。
  t.after(async () => {
    const results = await Promise.allSettled(f.connections.map(connection => connection.close()));
    for (const connection of f.connections) fs.rmSync(path.dirname(logFile(connection.config)), { recursive: true, force: true });
    fs.rmSync(directory, { recursive: true, force: true });
    for (let index = 0; index < results.length; index++) if (results[index].status === 'rejected' && !f.expectedCloseErrors.has(f.connections[index])) throw results[index].reason;
  });
  return f;
}

// 前置：目标 PID 为 42；数字字符串须规范化，所有用户别名及已解析身份须一致。
test('一、规范化数字字符串 PID 并严格拒绝冲突与非法身份', async t => {
  const f = await fixture(t);
  assert.deepEqual(Object.keys(f.api), ['prepareNativeConnection']);
  for (const pid of [42, '42', '0042']) {
    const connection = await f.connect(f.config({ pid, processId: '42', native: { pid: '42', processId: 42 } }));
    assert.equal(connection.config.pid, 42);
    assert.equal(connection.config.processId, 42);
    await connection.close();
  }
  const before = f.calls.length;
  for (const value of ['', ' 42 ', '4.2e1', '0x2a', '42.0', '0', '-42', '9007199254740993', '${command:pid}', true, null, 42.5, Infinity]) {
    await assert.rejects(f.connect(f.config({ pid: value })), /PID/);
  }
  for (const overrides of [{ processId: '43' }, { native: { pid: '43' } }, { native: { processId: '43' } }, { serial: 'other' }, { packageName: 'invalid' }, { type: 'android-jvm' }, { mode: 'java' }, { native: [] }]) await assert.rejects(f.connect(f.config(overrides)));
  await assert.rejects(f.api.prepareNativeConnection(f.config(), '42', f.device, new AbortController().signal, f.folder), /positive integer PID/);
  assert.equal(f.calls.length, before);
});

// 前置：Android、公共源码、Java 与 Native 可各有项目根；只校验 Android 根与设备归属一致。
test('二、保留显式源码项目根语义并校验路径和命令结构', async t => {
  const f = await fixture(t);
  const input = f.config({ androidProjectRoot: f.directory, projectRoot: 'common', java: { projectRoot: 'java' }, native: { projectRoot: 'native', sourcePaths: ['src'], symbolSearchPaths: ['obj'], sourceMap: { old: 'new' }, sdkRoot: f.sdk, ndkRoot: f.ndk } });
  const original = plain(input), connection = await f.connect(input);
  const nativeRoot = path.join(f.directory, 'native');
  assert.equal(connection.config.projectRoot, nativeRoot);
  assert.equal(connection.config.androidProjectRoot, f.directory);
  assert.deepEqual(plain(connection.config.sourcePaths), [path.join(nativeRoot, 'src')]);
  assert.deepEqual(plain(connection.config.symbolSearchPaths), [path.join(nativeRoot, 'obj')]);
  assert.deepEqual(plain(connection.config.sourceMap), { [path.join(nativeRoot, 'old')]: path.join(nativeRoot, 'new') });
  assert.equal(f.calls.find(call => call[0] === 'libraries')[1], nativeRoot);
  assert.equal(f.calls.find(call => call[0] === 'server')[1].androidProjectRoot, f.directory);
  assert.deepEqual(plain(input), original);
  await connection.close();
  const common = await f.connect(f.config({ projectRoot: 'common', java: { projectRoot: 'java' }, native: {} }));
  assert.equal(common.config.projectRoot, path.join(f.directory, 'common'));
  await common.close();
  const before = f.servers.length;
  for (const overrides of [{ androidProjectRoot: 'other' }, { native: { androidProjectRoot: 'other' } }, { projectRoot: '${workspaceFolder}' }, { native: { sourcePaths: ['bad\npath'] } }, { native: { sourceMap: [] } }, { native: { sourceMap: { old: 7 } } }, { initCommands: 'not-array' }, { native: { exitCommands: ['bad\ncommand'] } }, { native: { stopOnEntry: 'false' } }]) await assert.rejects(f.connect(f.config(overrides)));
  await assert.rejects(f.api.prepareNativeConnection(f.config({ projectRoot: 'relative' }), 42, { ...f.device, projectRoot: undefined }, new AbortController().signal), /absolute project root/);
  assert.equal(f.servers.length, before);
});

// 前置：真实文件系统工具链检查与真实 ABI 校验保持启用；失败不部署 server。
test('三、保留工具链必要检查和包 ABI 交集及库发现错误', async t => {
  const f = await fixture(t);
  for (const native of [{ sdkRoot: '' }, { ndkRoot: 7 }, { sdkRoot: path.join(f.directory, 'missing-sdk') }, { ndkRoot: path.join(f.directory, 'missing-ndk') }, { abi: 'invalid' }, { abiSupported: [] }, { abiSupported: ['arm64-v8a', 'invalid'] }]) await assert.rejects(f.connect(f.config({ native })));
  for (const supported of [[], ['invalid']]) { f.supported = supported; await assert.rejects(f.connect(), /abiSupported/); }
  f.supported = ['x86'];
  await assert.rejects(f.connect(), /appropriate ABI/);
  f.supported = ['arm64-v8a', 'x86'];
  const connection = await f.connect(f.config({ native: { abi: 'select', abiSupported: ['x86'] } }));
  assert.equal(connection.config.androidAbi, 'x86');
  assert.deepEqual(plain(f.calls.find(call => call[0] === 'server')[1].androidNativeToolchain), { adb: f.adb, sdkRoot: f.sdk, ndkRoot: f.ndk });
  await connection.close();
  const before = f.servers.length;
  f.abiFailure = new Error('package ABI read failed');
  await assert.rejects(f.connect(), error => error === f.abiFailure);
  f.abiFailure = undefined;
  f.libraryFailure = new Error('project library read failed');
  await assert.rejects(f.connect(), error => error === f.libraryFailure);
  assert.equal(f.servers.length, before);
});

// 前置：直接输入最终配置；真实符号算法和租约生成 CodeLLDB 命令，目标字段不可被 Native 选项替换。
test('四、生成真实 CodeLLDB 命令并保留未知选项且不泄露信号', async t => {
  const f = await fixture(t), controller = new AbortController();
  f.forwards = ['serial tcp:4000 localabstract:old', 'other tcp:5000 localabstract:foreign'];
  const input = f.config({ signal: controller.signal, vendorTop: 7, native: { type: 'other', request: 'launch', platform: 'host', serial: 'intruder', packageName: 'com.intruder.app', androidPackageName: 'com.intruder.app', androidTarget: 'intruder', signal: controller.signal, vendorOption: { keep: true }, stopOnEntry: true, initCommands: ['custom init'], postRunCommands: ['custom post'], exitCommands: ['custom exit'] } });
  const connection = await f.connect(input, controller.signal), config = connection.config;
  assert.equal(config.type, 'lldb');
  assert.equal(config.request, 'attach');
  assert.equal(config.platform, 'remote-android');
  assert.equal(config.serial, 'serial');
  assert.equal(config.packageName, 'com.example.app');
  assert.equal(config.androidPackageName, 'com.example.app');
  assert.equal(config.stopOnEntry, true);
  assert.equal(config.vendorTop, 7);
  assert.deepEqual(plain(config.vendorOption), { keep: true });
  for (const key of ['signal', 'native', 'java', 'androidTarget', 'androidNativeToolchain', 'sdkRoot', 'ndkRoot', 'mode']) assert.equal(config[key], undefined);
  assert.equal(JSON.stringify(config).includes('signal'), false);
  assert.equal(f.calls.find(call => call[0] === 'abis')[2], controller.signal);
  assert.equal(config.initCommands[1], 'platform select remote-android');
  assert.equal(config.initCommands[2], 'platform connect unix-abstract-connect://[serial]platform-0');
  assert.deepEqual(Array.from(config.initCommands).slice(3), ['settings set plugin.jit-loader.gdb.enable off', 'process handle SIGBUS SIGSEGV --pass true --stop false --notify false', 'breakpoint set --shlib libart.so --name art_sigsegv_fault', 'breakpoint set --shlib libart.so --name art_sigbus_fault', 'custom init']);
  const escaped = f.library.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  assert.deepEqual(Array.from(config.postRunCommands), ['target modules add -- "' + escaped + '"', 'custom post']);
  assert.deepEqual(Array.from(config.exitCommands), ['custom exit', 'platform disconnect', 'log disable lldb platform']);
  f.forwards.push('serial tcp:41873 localabstract:platform-0');
  fs.writeFileSync(logFile(config), 'Connected to Android device "serial"\nForwarding remote socket "platform-0" to local TCP port 41873\n');
  const closing = connection.close();
  assert.equal(connection.close(), closing);
  await closing;
  assert.deepEqual(f.stopped, ['platform-0']);
  assert.deepEqual(f.removed, [41873]);
  assert.deepEqual(f.forwards, ['serial tcp:4000 localabstract:old', 'other tcp:5000 localabstract:foreign']);
  assert.equal(fs.existsSync(logFile(config)), false);
});

// 前置：项目无库；允许返回待引擎使用的配置，但警告不得宣称连接成功。
test('五、无库仅警告且默认不暂停而不冒充连接成功', async t => {
  const f = await fixture(t);
  f.libraries = [];
  const connection = await f.connect(f.config({ native: {} }));
  assert.equal(connection.config.stopOnEntry, false);
  assert.deepEqual(Array.from(connection.config.postRunCommands), []);
  assert.equal(f.notices.length, 1);
  assert.match(f.notices[0], /未找到.*Native.*库/);
  assert.match(f.notices[0], /尚未确认调试器连接成功/);
  await connection.close();
});

// 前置：以门闩控制 ABI、部署和转发迟到；取消后不得返回配置或遗留本次资源。
test('六、取消传播至包 ABI 并回滚迟到 server 与转发', async t => {
  const f = await fixture(t), early = new AbortController();
  early.abort(new Error('cancel before preparation'));
  await assert.rejects(f.connect(f.config(), early.signal), /cancel before preparation/);
  assert.equal(f.calls.length, 0);
  const abi = new AbortController();
  f.abiEntered = Promise.withResolvers(); f.abiGate = Promise.withResolvers();
  const reading = f.connect(f.config(), abi.signal);
  await f.abiEntered.promise;
  abi.abort(new Error('cancel ABI read')); f.abiGate.resolve();
  await assert.rejects(reading, /cancel ABI read/);
  assert.equal(f.servers.length, 0);
  f.abiGate = undefined;
  const late = new AbortController();
  f.serverEntered = Promise.withResolvers(); f.serverGate = Promise.withResolvers();
  const deploying = f.connect(f.config(), late.signal);
  await f.serverEntered.promise;
  late.abort(new Error('cancel late server')); f.serverGate.resolve();
  await assert.rejects(deploying, /cancel late server/);
  assert.deepEqual(f.stopped, ['platform-0']);
  f.serverGate = undefined;
  const forwarding = new AbortController();
  f.forwardEntered = Promise.withResolvers(); f.forwardGate = Promise.withResolvers();
  const pendingGate = f.forwardGate, preparing = f.connect(f.config(), forwarding.signal);
  await f.forwardEntered.promise;
  forwarding.abort(new Error('cancel late forward')); pendingGate.resolve();
  await assert.rejects(preparing, /cancel late forward/);
  assert.deepEqual(f.stopped, ['platform-0', 'platform-1']);
  assert.deepEqual(f.removed, []);
  assert.equal(f.connections.length, 0);
});

// 前置：逐个注入部署、转发与关闭错误；原始错误必须保留，任一清理失败不得跳过另一资源。
test('七、准备失败显式回滚且幂等关闭聚合全部资源错误', async t => {
  const f = await fixture(t);
  f.serverFailure = new Error('server deployment failed');
  await assert.rejects(f.connect(), error => error === f.serverFailure);
  assert.deepEqual(f.stopped, []);
  f.serverFailure = undefined;
  f.adbFailure = new Error('forward preparation failed');
  await assert.rejects(f.connect(), error => error === f.adbFailure);
  assert.deepEqual(f.stopped, ['platform-0']);
  f.adbFailure = undefined;
  f.socket = 'bad;socket';
  await assert.rejects(f.connect(), /Invalid Native server socket/);
  assert.deepEqual(f.stopped, ['platform-0', 'bad;socket']);
  f.socket = undefined;
  f.forwardFailure = new Error('baseline read failed');
  await assert.rejects(f.connect(), error => error === f.forwardFailure);
  assert.deepEqual(f.stopped, ['platform-0', 'bad;socket', 'platform-2']);
  f.forwardFailure = undefined;
  const connection = await f.connect();
  f.stopFailure = new Error('server stop failed');
  f.forwardFailure = new Error('forward close failed');
  f.expectedCloseErrors.add(connection);
  const first = connection.close();
  assert.equal(connection.close(), first);
  await assert.rejects(first, error => { assert.match(error.message, /server and forward cleanup/); assert.deepEqual(Array.from(error.errors, String), ['Error: server stop failed', 'Error: forward close failed']); return true; });
  f.forwardFailure = undefined;
  f.adbFailure = new Error('rollback trigger');
  await assert.rejects(f.connect(), error => { assert.match(error.message, /preparation and rollback/); assert.equal(error.errors[0], f.adbFailure); assert.equal(error.errors[1].errors[0], f.stopFailure); return true; });
  assert.equal(f.stopped.filter(socket => socket === 'platform-3').length, 1);
  assert.equal(f.stopped.filter(socket => socket === 'platform-4').length, 1);
});
