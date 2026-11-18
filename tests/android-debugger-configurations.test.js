const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { transformSync } = require('esbuild');

/** 隔离VS Code服务加载实际配置入口；npm test发现本文件，断言真实启动、取消、拒绝和监听释放，不模拟JVM行为。 */
function fixture() {
  const f = { configs: [], pick: 0, starts: [], events: [], disposed: 0, accept: true, trusted: true, reportSession: true };
  const vscode = {
    workspace: { get isTrusted() { return f.trusted; }, getConfiguration: section => { assert.equal(section, 'launch'); return { get: () => f.configs }; } },
    window: { showQuickPick: async items => { f.items = items; return f.pick === undefined ? undefined : items[f.pick]; } },
    commands: { async executeCommand(command) { f.events.push(['view',command]); if(f.navigationFailure) throw f.navigationFailure; await f.onFocus?.(); } },
    debug: {
      onDidStartDebugSession(listener) { f.listener = listener; return { dispose() { f.disposed++; f.listener = undefined; } }; },
      async startDebugging(folder, config) {
        f.events.push(['start',config.type]); f.starts.push(config); if (f.failure) throw f.failure;
        if (f.accept && f.reportSession) f.listener({ id: 'parent-session', configuration: { ...config, ...(f.resolvedPackage ? { packageName: f.resolvedPackage } : {}), ...(f.resolvedPid ? { pid: f.resolvedPid, processId: f.resolvedPid } : {}) } });
        return f.accept;
      },
    },
  };
  const module = { exports: {} };
  vm.runInNewContext(transformSync(fs.readFileSync(path.join(__dirname, '../src/android-debugger/index.ts'), 'utf8'), { loader: 'ts', format: 'cjs' }).code,
    { module, exports: module.exports, require: id => id === 'vscode' ? vscode : require(id) });
  f.api = module.exports; return f;
}

// Native-only：唯一内置选项启动已注册父会话，配置独立且取消不启动。
test('built-in Android Native starts the registered parent with independent options', async () => {
  const f = fixture();
  const config = await f.api.selectAndroidDebugConfiguration();
  assert.equal(config.type, 'android-tools'); assert.equal(config.androidMode, 'native');
  assert.equal(config.java, undefined); assert.equal(config.kotlin, undefined);
  const session = await f.api.startAndroidDebugging(undefined, config, { serial: 'phone', pid: 42 });
  assert.equal(session.id, 'parent-session');
  assert.equal(JSON.stringify(f.events),JSON.stringify([['view','workbench.view.debug'],['start','android-tools']]));
  assert.equal(f.starts[0].request, 'attach'); assert.equal(f.starts[0].pid, 42);
  assert.equal(f.starts[0].processId, 42); assert.equal(f.starts[0].target, 'phone');
  assert.equal(f.starts[0].mode, 'native'); assert.equal(f.disposed, 1); assert.equal(f.items.length, 1);
  const configs = f.api.getAndroidDebugConfigurations(); configs[0].native.symbolSearchPaths = ['changed'];
  assert.equal(f.api.getAndroidDebugConfigurations()[0].native.symbolSearchPaths, undefined);
  f.pick = undefined; assert.equal(await f.api.selectAndroidDebugConfiguration(), undefined); assert.equal(f.starts.length, 1);
  const launch = f.api.createAndroidDebugConfiguration(config, { serial: 'phone', packageName: 'com.demo' });
  assert.equal(launch.request, 'launch'); assert.equal(launch.packageName, 'com.demo');
  for (const mode of ['kotlin-java', 'jvm-native', 'java', 'dual']) {
    assert.throws(() => f.api.createAndroidDebugConfiguration({ ...config, androidMode: mode }, { serial: 'phone' }), /Only Android Native/);
  }
});

// 外部配置保留类型和原始选项；源Android Debug允许的java配置覆盖语义不被宿主强行禁止。
test('Android configurations preserve original external options and never merge Kotlin into Java', async () => {
  const f = fixture();
  const config = { type: 'android-debug', request: 'launch', name: 'Mixed', custom: 17,
    java: { type: 'java', sourcePaths: ['java-src'] }, kotlin: { type: 'kotlin-jvm', port: 5005, sourcePaths: ['kotlin-src'] }, native: { symbolSearchPaths: ['symbols'] } };
  f.configs = [config, config, { type: 'external', request: 'invalid', name: 'Invalid' }];
  f.pick = 1; assert.equal(await f.api.selectAndroidDebugConfiguration(), config); assert.equal(f.items.length, 2);
  const mapped = f.api.createAndroidDebugConfiguration(config, { serial: 'phone', processId: 77, packageName: 'com.demo' });
  assert.equal(mapped.request, 'attach'); assert.equal(mapped.pid, 77); assert.equal(mapped.custom, 17); assert.equal(mapped.packageName, 'com.demo');
  assert.strictEqual(mapped.java, config.java); assert.strictEqual(mapped.kotlin, config.kotlin); assert.strictEqual(mapped.native, config.native);
  assert.equal(mapped.java.type, 'java'); assert.equal(mapped.kotlin.type, 'kotlin-jvm'); assert.equal(mapped.java.port, undefined);
  assert.equal(config.request, 'launch'); assert.equal(config.pid, undefined);
  assert.equal(f.api.findAndroidDebugConfiguration().type, 'android-debug'); assert.equal(f.api.findAndroidDebugConfiguration(undefined, true).type, 'android-tools');
  assert.equal(f.api.createAndroidDebugConfiguration(config, { serial: 'phone' }).request, 'launch');
});

// 同时覆盖false、异常和没有实际会话事件；失败不能被空对象或undefined伪装为正常启动。
test('Android session start propagates refusal errors and absent session while always releasing listener', async () => {
  const f = fixture(), config = { type: 'android-tools', name: 'Attach', request: 'attach' };
  f.accept = false;
  await assert.rejects(f.api.startAndroidDebugging(undefined, config, { serial: 'phone' }), /did not start/); assert.equal(f.disposed, 1);
  const failure = new Error('adapter failed'); f.failure = failure;
  await assert.rejects(f.api.startAndroidDebugging(undefined, config, { serial: 'phone' }), error => error === failure); assert.equal(f.disposed, 2);
  f.failure = undefined; f.accept = true; f.reportSession = false;
  await assert.rejects(f.api.startAndroidDebugging(undefined, config, { serial: 'phone' }), /did not report/); assert.equal(f.disposed, 3);
  f.trusted = false;
  await assert.rejects(f.api.startAndroidDebugging(undefined, config, { serial: 'phone' }), /not trusted/); assert.equal(f.disposed, 3); assert.equal(f.starts.length, 3);
});

// provider自动补齐的身份不能使真实start事件被丢弃，已明确请求的身份仍严格匹配。
test('Android startup accepts provider-resolved package and command PID without weakening explicit identity', async () => {
  const f = fixture(); f.resolvedPackage = 'com.device.app'; f.resolvedPid = 81;
  const config = { type: 'android-tools', request: 'attach', name: 'Auto', pid: '${command:pickAndroidProcess}' };
  const session = await f.api.startAndroidDebugging(undefined, config, { serial: 'phone' });
  assert.equal(session.configuration.packageName, 'com.device.app'); assert.equal(session.configuration.pid, 81);
  await assert.rejects(f.api.startAndroidDebugging(undefined, { ...config, packageName: 'com.explicit.app' }, { serial: 'phone' }), /did not report/);
  await assert.rejects(f.api.startAndroidDebugging(undefined, config, { serial: 'phone', pid: 42 }), /did not report/);
});

// 非法配置或设备身份必须在调用宿主之前失败，重复PID字段不允许指向两个进程。
test('Android configuration validation rejects invalid targets before allocating session listeners', async () => {
  const f = fixture(), config = { type: 'android-tools', name: 'Attach', request: 'attach' };
  for (const target of [{ serial: '' }, { serial: 'bad serial' }, { serial: 'phone', pid: -1 }, { serial: 'phone', processId: 1.2 }, { serial: 'phone', pid: 1, processId: 2 }]) {
    assert.throws(() => f.api.createAndroidDebugConfiguration(config, target), /serial|process id/);
  }
  assert.throws(() => f.api.createAndroidDebugConfiguration({ ...config, request: 'invalid' }, { serial: 'phone' }), /Invalid Android debug/);
  await assert.rejects(f.api.startAndroidDebugging(undefined, config, { serial: 'phone', pid: 0 }), /process id/);
  assert.equal(f.disposed, 0); assert.equal(f.starts.length, 0);
  assert.equal(f.api.androidDebugger.startAndroidDebugging, f.api.startAndroidDebugging);
});
/** 内置导航完成后再启动，失败/取消/信任变化不能分配会话；外部配置不改变视图。 */
test('Native opens Run and Debug before start and rechecks navigation cancellation and trust', async()=>{
  const config={type:'android-tools',request:'launch',name:'Native'};
  const external=fixture(); await external.api.startAndroidDebugging(undefined,{type:'external',request:'launch',name:'External'},{serial:'phone'});
  assert.equal(JSON.stringify(external.events),JSON.stringify([['start','external']]));
  const failure=fixture(); failure.navigationFailure=new Error('view unavailable');
  await assert.rejects(failure.api.startAndroidDebugging(undefined,config,{serial:'phone'}),e=>e===failure.navigationFailure);
  assert.equal(failure.starts.length,0); assert.equal(failure.disposed,0);
  const cancelled=fixture(), scope=new AbortController(), reason=new Error('debug cancelled'); cancelled.onFocus=()=>scope.abort(reason);
  await assert.rejects(cancelled.api.startAndroidDebugging(undefined,config,{serial:'phone',signal:scope.signal}),e=>e===reason);
  assert.equal(cancelled.starts.length,0); assert.equal(cancelled.disposed,0);
  const untrusted=fixture(); untrusted.onFocus=()=>{untrusted.trusted=false;};
  await assert.rejects(untrusted.api.startAndroidDebugging(undefined,config,{serial:'phone'}),/not trusted/); assert.equal(untrusted.starts.length,0); assert.equal(untrusted.disposed,0);
});
