/**
 * 功能点：JVM 真实引擎注册、参数准备与只读协议诊断。
 * 受影响对象：registerJvmDebugger、registerJvmDiagnostics、findJava、android-jvm descriptor、扩展设置与会话日志。
 * 复现路径：Node>=22，VM 加载真实源码，mock vscode/fs/findJava；构造准备完成的 Launch/Attach 会话。
 * 测试范围：唯一 factory、真实 executable 参数、配置优先级、独立日志、缺失 JAR、非法类型、原始错误与只读 trace；保留 JDK 发现回归。
 * 执行入口：node --test tests/jvm-debugger.test.js；本任务仅编写，不执行。
 * 预期结果：真实 JAR 直接处理 DAP，无 provider、代理、设备调用或子会话，诊断不改消息且保留连接错误。
 * 判据：descriptor、设置、原始错误、日志和 JDK 发现全部符合断言；不支持的宿主或模块调用立即失败。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { transformSync } = require('esbuild');

/** 功能：隔离加载真实入口；输入设置及失败条件；输出注册记录、文件操作和可调用 factory，不提供设备 API。 */
function fixture(options = {}) {
  const f = { lines: [], shown: [], registrations: [], trackers: [], settings: [], reads: [], disposed: [], homes: [], checked: [], directories: [], values: options.settings ?? {} };
  const output = { appendLine: line => f.lines.push(line), show: value => f.shown.push(value), dispose: () => f.disposed.push('output') };
  const uri = fsPath => ({ fsPath });
  const vscode = {
    Uri: { joinPath: (base, ...parts) => uri(path.join(base.fsPath, ...parts)) },
    DebugAdapterExecutable: class {
      /** 功能：记录真实 descriptor 构造参数；输入 Java 与参数；输出可断言的 executable。 */
      constructor(command, args) { this.command = command; this.args = Array.from(args); }
    },
    window: { createOutputChannel(name) { assert.equal(name, 'Android Kotlin/Java Debugger'); return output; } },
    workspace: { getConfiguration(section, folder) {
      f.settings.push([section, folder]);
      return { get(key, fallback) { f.reads.push(key); return Object.hasOwn(f.values, key) ? f.values[key] : fallback; } };
    } },
    debug: {
      registerDebugAdapterDescriptorFactory(type, factory) { f.registrations.push([type, factory]); return { dispose: () => f.disposed.push('descriptor') }; },
      registerDebugAdapterTrackerFactory(type, factory) { f.trackers.push([type, factory]); return { dispose: () => f.disposed.push('tracker') }; },
    },
  };
  const deps = {
    vscode,
    fs: {
      existsSync(file) { f.checked.push(file); return options.jarExists !== false; },
      mkdirSync(directory, flags) {
        f.directories.push([directory, flags.recursive]);
        if (options.directoryError) throw options.directoryError;
      },
    },
    './java': { async findJava(home) {
      f.homes.push(home);
      if (options.javaError) throw options.javaError;
      return { java: path.join('/jdk with spaces', 'bin', 'java'), version: 21, source: 'mock' };
    } },
  };
  const module = { exports: {} };
  vm.runInNewContext(transformSync(fs.readFileSync(path.join(__dirname, '../src/android-debugger/jvm-debugger/adapter.ts'), 'utf8'), { loader: 'ts', format: 'cjs' }).code,
    { module, exports: module.exports, require(id) { assert.ok(Object.hasOwn(deps, id), '禁止额外依赖：' + id); return deps[id]; } });
  const context = { subscriptions: [], extensionUri: uri('/extension with spaces'), logUri: uri('/session logs') };
  if (options.diagnosticsOnly) module.exports.registerJvmDiagnostics(context);
  else module.exports.registerJvmDebugger(context);
  return Object.assign(f, { api: module.exports, context, vscode, factory: f.registrations[0]?.[1], trackerFactory: f.trackers[0][1] });
}

/** 功能：构造已完成配置准备的引擎会话；输入覆盖配置与会话 ID；输出不含设备准备行为的会话。 */
function session(configuration = {}, id = 'session-1') {
  return { id, type: 'android-jvm', workspaceFolder: { uri: { fsPath: '/project' } }, configuration: { type: 'android-jvm', name: 'JVM', request: 'attach', hostName: '127.0.0.1', port: 8700, ...configuration } };
}

// 功能：覆盖 Launch/Attach 入口；输入已准备配置；输出唯一真实 executable，不注册 provider 或子会话。
test('JVM registers one real executable factory and one read-only tracker for launch and attach', async () => {
  const f = fixture();
  assert.equal(f.registrations.length, 1); assert.equal(f.registrations[0][0], 'android-jvm');
  assert.equal(f.trackers.length, 1); assert.equal(f.trackers[0][0], 'android-jvm');
  assert.equal(f.api.JVM_DEBUG_TYPE, 'android-jvm');
  for (const request of ['launch', 'attach']) {
    const input = session({ request }, request);
    const before = JSON.stringify(input);
    const descriptor = await f.factory.createDebugAdapterDescriptor(input);
    assert.ok(descriptor instanceof f.vscode.DebugAdapterExecutable);
    assert.equal(descriptor.command, path.join('/jdk with spaces', 'bin', 'java'));
    assert.deepEqual(descriptor.args, ['-Xmx512m', '-jar', path.join('/extension with spaces', 'resources', 'jvm-debugger', 'kotlin-debug-adapter.jar'), '--log-file', path.join('/session logs', `jvm-${request}.log`), '--log-level', 'INFO']);
    assert.equal(JSON.stringify(input), before);
    assert.deepEqual(f.settings.at(-1), ['android-ide.jvmDebugger', input.workspaceFolder.uri]);
  }
  assert.deepEqual(f.homes, [undefined, undefined]);
  assert.deepEqual(f.directories, [['/session logs', true], ['/session logs', true]]);
  assert.equal(f.context.subscriptions.length, 3);
  for (const disposable of f.context.subscriptions) disposable.dispose();
  assert.deepEqual(f.disposed, ['output', 'tracker', 'descriptor']);
});

// 功能：读取所属目录设置；输入带空格参数与 JDK；输出未经 shell 拼接的准确参数及独立会话日志。
test('JVM executable respects workspace settings and isolates session log files', async () => {
  const settings = { javaHome: '/custom jdk', adapterJvmArgs: ['-Xmx1g', '-Dlabel=hello world'], logLevel: 'WARN' };
  const f = fixture({ settings });
  const first = await f.factory.createDebugAdapterDescriptor(session({}, 'one'));
  const second = await f.factory.createDebugAdapterDescriptor(session({}, 'two'));
  assert.deepEqual(first.args.slice(0, 2), settings.adapterJvmArgs);
  assert.equal(first.args.at(-1), 'WARN');
  assert.equal(first.args[first.args.indexOf('--log-file') + 1], path.join(f.context.logUri.fsPath, 'jvm-one.log'));
  assert.equal(second.args[second.args.indexOf('--log-file') + 1], path.join(f.context.logUri.fsPath, 'jvm-two.log'));
  assert.deepEqual(f.homes, ['/custom jdk', '/custom jdk']);
  assert.deepEqual(settings.adapterJvmArgs, ['-Xmx1g', '-Dlabel=hello world']);
});

// 功能：会话参数显式覆盖设置；输入空数组和 TRACE；输出无默认 JVM 参数且不修改用户数组。
test('JVM session arguments override settings including an explicitly empty array', async () => {
  const f = fixture({ settings: { adapterJvmArgs: ['-Xmx1g'], logLevel: 'WARN' } });
  const args = Object.freeze([]);
  const descriptor = await f.factory.createDebugAdapterDescriptor(session({ adapterJvmArgs: args, logLevel: 'TRACE' }));
  assert.equal(descriptor.args[0], '-jar'); assert.equal(descriptor.args.at(-1), 'TRACE');
  const custom = Object.freeze(['-ea']);
  const next = await f.factory.createDebugAdapterDescriptor(session({ adapterJvmArgs: custom }));
  assert.equal(next.args[0], '-ea'); assert.equal(next.args.at(-1), 'WARN');
  assert.deepEqual(Array.from(custom), ['-ea']);
});

// 功能：拒绝缺失 JAR；输入不存在的内置路径；输出明确路径错误且不查找 JDK 或创建日志目录。
test('JVM rejects a missing bundled JAR before runtime preparation', async () => {
  const f = fixture({ jarExists: false });
  await assert.rejects(f.factory.createDebugAdapterDescriptor(session()), /JAR 不存在/);
  assert.deepEqual(f.checked, [path.join('/extension with spaces', 'resources', 'jvm-debugger', 'kotlin-debug-adapter.jar')]);
  assert.deepEqual(f.homes, []); assert.deepEqual(f.directories, []);
});

// 功能：校验设置和会话参数；输入非法数组、日志级别与 javaHome；输出类型错误且无准备副作用。
test('JVM rejects malformed user arguments and settings without preparing the runtime', async () => {
  for (const value of ['-Xmx1g', null, 1, {}, [1], ['-ea', null]]) {
    for (const source of ['settings', 'session']) {
      const f = fixture({ settings: source === 'settings' ? { adapterJvmArgs: value } : {} });
      await assert.rejects(f.factory.createDebugAdapterDescriptor(session(source === 'session' ? { adapterJvmArgs: value } : {})), /adapterJvmArgs 必须是字符串数组/);
      assert.deepEqual(f.homes, []); assert.deepEqual(f.checked, []); assert.deepEqual(f.directories, []);
    }
  }
  for (const value of [null, 1, [], 'debug', 'VERBOSE', '']) {
    for (const source of ['settings', 'session']) {
      const f = fixture({ settings: source === 'settings' ? { logLevel: value } : {} });
      await assert.rejects(f.factory.createDebugAdapterDescriptor(session(source === 'session' ? { logLevel: value } : {})), /logLevel 必须是/);
      assert.deepEqual(f.homes, []); assert.deepEqual(f.directories, []);
    }
  }
  for (const value of [null, 17, [], {}]) {
    const f = fixture({ settings: { javaHome: value } });
    await assert.rejects(f.factory.createDebugAdapterDescriptor(session()), /javaHome 必须是字符串/);
    assert.deepEqual(f.homes, []);
  }
});

// 功能：保留准备失败原始对象；输入 JDK 与目录错误；输出同一错误而非包装、吞掉或替换。
test('JVM preserves original runtime and log directory errors', async () => {
  for (const key of ['javaError', 'directoryError']) {
    const error = Object.assign(new Error('original failure'), { code: 'EACCES' });
    const f = fixture({ [key]: error });
    await assert.rejects(f.factory.createDebugAdapterDescriptor(session()), actual => actual === error);
    assert.deepEqual(f.lines, []);
  }
});

// 功能：默认保护协议内容；输入冻结的双向消息；输出零协议日志且不改变报文。
test('JVM diagnostics are read-only and default to private protocol tracing', () => {
  const f = fixture(), input = session();
  const tracker = f.trackerFactory.createDebugAdapterTracker(input);
  const request = Object.freeze({ type: 'request', seq: 1, command: 'evaluate', arguments: Object.freeze({ expression: 'secret' }) });
  const response = Object.freeze({ type: 'response', seq: 2, request_seq: 1, command: 'evaluate', success: true });
  const before = JSON.stringify([request, response]);
  tracker.onWillReceiveMessage(request); tracker.onDidSendMessage(response); tracker.onExit(0, undefined);
  assert.equal(JSON.stringify([request, response]), before);
  assert.deepEqual(f.lines, []); assert.deepEqual(f.shown, []);
  assert.deepEqual(f.settings, [['android-ide.jvmDebugger', input.workspaceFolder.uri]]);
});

// 功能：显式追踪保留连接失败报文；输入冻结的失败响应与反向请求；输出原始 JSON 和错误，不修改响应。
test('JVM diagnostics log both directions and preserve original connection errors', () => {
  const f = fixture({ settings: { traceProtocol: true } }), tracker = f.trackerFactory.createDebugAdapterTracker(session());
  const request = Object.freeze({ type: 'request', seq: 3, command: 'runInTerminal', arguments: Object.freeze({ args: Object.freeze(['中文']) }) });
  const response = Object.freeze({ type: 'response', seq: 4, request_seq: 2, command: 'attach', success: false, message: 'java.net.ConnectException: Connection refused', body: Object.freeze({ error: Object.freeze({ id: 42, format: 'original JVM connection error' }) }) });
  const before = JSON.stringify([request, response]);
  assert.equal(tracker.onWillReceiveMessage(request), undefined);
  assert.equal(tracker.onDidSendMessage(response), undefined);
  tracker.onError(new Error('transport failed')); tracker.onExit(2, 'SIGTERM');
  assert.equal(JSON.stringify([request, response]), before);
  assert.deepEqual(f.lines, ['--> ' + JSON.stringify(request), '<-- ' + JSON.stringify(response), 'Adapter error: transport failed', 'Adapter exited: 2 SIGTERM']);
  assert.deepEqual(f.shown, [true]);
  assert.equal(typeof tracker.onDidStartDebugSession, 'undefined');
});

// 功能：隔离追踪开关快照；输入不同会话创建时的配置；输出只记录启用会话。
test('JVM tracing choice belongs to each session', () => {
  const f = fixture(), silent = f.trackerFactory.createDebugAdapterTracker(session());
  f.values.traceProtocol = true;
  const traced = f.trackerFactory.createDebugAdapterTracker(session({}, 'second'));
  silent.onDidSendMessage({ seq: 1 }); traced.onDidSendMessage({ seq: 2 });
  assert.deepEqual(f.lines, ['<-- {"seq":2}']);
});

// 功能：保留纯日志入口；输入仅诊断注册；输出零 descriptor factory、零文件操作及零 JDK 查询。
test('JVM diagnostics can still be registered without registering an engine', () => {
  const f = fixture({ diagnosticsOnly: true });
  assert.equal(f.registrations.length, 0); assert.equal(f.trackers.length, 1);
  assert.equal(f.context.subscriptions.length, 2);
  assert.deepEqual(f.checked, []); assert.deepEqual(f.directories, []); assert.deepEqual(f.homes, []);
});

// 功能：验证扩展自有命名空间；输入公开贡献及现有源码；输出无上游设置冲突。
test('JVM settings use extension-owned namespace at the engine boundary', () => {
  const properties = require('../package.json').contributes.configuration.properties;
  assert.equal(Object.keys(properties).some(key => key.startsWith('kotlinDebugger.')), false);
  for (const key of ['javaHome', 'adapterJvmArgs', 'traceProtocol', 'logLevel']) assert.ok(Object.hasOwn(properties, 'android-ide.jvmDebugger.' + key));
  for (const file of ['src/android-debugger/jvm-debugger/java.ts', 'src/android-debugger/jvm-debugger/adapter.ts']) {
    const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    assert.equal(source.includes('kotlinDebugger'), false, file);
    assert.ok(source.includes('android-ide.jvmDebugger'), file);
  }
});

// 功能：保留真实 JDK 发现边界；输入旧 Java、缺 JDI 与受支持 JDK；输出精确接受结果及缓存，不调用真实进程。
test('JDK discovery requires Java 17 and jdk.jdi without invoking shells', async () => {
  const source = transformSync(fs.readFileSync(path.join(__dirname, '../src/android-debugger/jvm-debugger/java.ts'), 'utf8'), { loader: 'ts', format: 'cjs' }).code;
  for (const [version, jdi, accepted] of [[8, true, false], [17, false, false], [17, true, true], [21, true, true]]) {
    const module = { exports: {} }, calls = [];
    const deps = {
      fs: { existsSync: file => file === path.join('/jdk', 'bin', process.platform === 'win32' ? 'java.exe' : 'java') },
      child_process: { execFile(command, args, options, callback) { calls.push({ command, args }); callback(null, args[0] === '-version' ? `openjdk version "${version}.0.1"` : jdi ? `jdk.jdi@${version}` : 'java.base@17', ''); } },
    };
    vm.runInNewContext(source, { module, exports: module.exports, require: id => deps[id] ?? require(id), process: { platform: process.platform, env: { JAVA_HOME: '/jdk', PATH: '' } } });
    assert.equal(module.exports.parseJavaVersion('java version "1.8.0_402"'), 8);
    assert.equal(module.exports.parseJavaVersion('openjdk version "21.0.4"'), 21);
    assert.equal(module.exports.parseJavaVersion('not java'), 0);
    if (accepted) {
      assert.equal((await module.exports.findJava(undefined)).version, version);
      await module.exports.findJava(undefined); assert.equal(calls.length, 2);
    } else await assert.rejects(module.exports.findJava(undefined), /No suitable JDK/);
    assert.ok(calls.every(call => call.command.endsWith(process.platform === 'win32' ? 'java.exe' : 'java')));
  }
});
