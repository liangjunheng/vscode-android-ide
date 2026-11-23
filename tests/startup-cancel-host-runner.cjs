/**
 * 功能点：真实VS Code直接调试启动的宿主取消及迟到会话清理。
 * 受影响对象：index/startup/debugging公开入口、真实provider/tracker与宿主start/termination。
 * 复现路径：opt-in launcher生成单bundle及固定metadata，runner注册真实provider和测试引擎descriptor。
 * 测试范围：provider挂起、descriptor挂起、真实start事件同步取消、外来会话隔离与实际termination。
 * 执行入口：ANDROID_DEBUG_CANCEL_HOST_TEST=1 node --test tests/startup-cancel-host.test.js。
 * 预期结果：前台取消保留原原因，迟到根会话精确停止；设备全部模拟，无ADB/JDK/Gradle。
 * 判据：三场景完成、全部自有Promise和资源结算、SHA256不变、原始host/DAP日志flush后才COMPLETED。
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { finished } = require('node:stream/promises');
const vscode = require('vscode');
const dap = require('@vscode/debugadapter');
const index = require('../src/android-debugger/index.ts');
const startup = require('../src/android-debugger/startup.ts');
const { registerAndroidDebugging } = require('../src/android-debugger/debugging.ts');
const boundary = require('./fixture/startup-cancel-boundaries.cjs');

/** 功能：限定宿主诊断等待；输入实际Promise；输出原结果或明确超时。 */
async function deadline(label, operation, ms = 20000) {
  let timer;
  try { return await Promise.race([operation, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label + '宿主诊断超时')), ms); })]); }
  finally { clearTimeout(timer); }
}
/** 功能：核对固定实际输入；输入SHA256清单；输出逐项身份断言。 */
function verifyHashes(spec) { for (const [file, hash] of Object.entries(spec.hashes)) assert.equal(crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'), hash, '执行输入变化：' + file); }

/** 功能：真实宿主执行公开启动取消；输入launcher固定spec；输出证据与明确未执行项。 */
exports.run = async function run() {
  assert.equal(process.env.ANDROID_DEBUG_CANCEL_HOST_TEST, '1');
  const spec = JSON.parse(fs.readFileSync(process.env.ANDROID_CANCEL_HOST_SPEC, 'utf8'));
  const log = fs.createWriteStream(spec.events), flushed = finished(log).then(() => undefined, error => error);
  const names = ['provider-pending', 'descriptor-pending', 'late-session'];
  const outcome = { status: 'RUNNING', checks: [], notExecuted: [], coverage: '真实index/startup/debugging和VS Code宿主；设备与外部引擎为替身', omitted: ['Build面板控制器', '真实JAR/CodeLLDB', 'Native/Dual', '真机'] };
  const events = [], subscribers = new Set(), active = new Map(), resources = [], pending = [], controllers = [];
  let context, owner, foreign, sequence = 0;
  // 功能：保存原始宿主事实；输入事件与数据；输出顺序日志并唤醒等待者。
  function record(event, data = {}) { const item = { sequence: ++sequence, event, ...data }; events.push(item); log.write(JSON.stringify(item) + '\n'); for (const notify of [...subscribers]) notify(); }
  boundary.runtime.record = record;
  // 功能：事件驱动等待宿主事实；输入标签与条件；输出匹配结果并释放监听。
  async function waitFor(label, predicate) {
    let notify;
    const ready = new Promise(resolve => { notify = () => { const value = predicate(); if (value) resolve(value); }; subscribers.add(notify); notify(); });
    try { return await deadline(label, ready); } finally { subscribers.delete(notify); }
  }
  // 功能：记录原始Promise结果；输入实际操作；输出不会制造成功的结算账本。
  function observe(label, operation) {
    const item = { label, state: 'pending' }; pending.push(item);
    item.done = Promise.resolve(operation).then(value => { item.state = 'fulfilled'; item.value = value; record('promise-fulfilled', { label }); }, error => { item.state = 'rejected'; item.error = error; record('promise-rejected', { label, error: String(error.stack || error) }); });
    return item;
  }

  /** 功能：模拟外部引擎DAP，仅用于真实宿主启动时序；输入标准请求；输出真实宿主可见响应。 */
  class HostEngine extends dap.DebugSession {
    // 功能：保存场景归属；输入可选阶段；输出独立引擎资源账本。
    constructor(phase) { super(); this.phase = phase; this.closed = false; phase?.engines.push(this); }
    // 功能：公布测试引擎配置能力；输入initialize；输出标准响应和initialized。
    initializeRequest(response) { response.body = { supportsConfigurationDoneRequest: true }; this.sendResponse(response); this.sendEvent(new dap.InitializedEvent()); }
    // 功能：完成测试外部附加；输入attach；输出标准成功，不模拟设备。
    attachRequest(response) { this.sendResponse(response); }
    // 功能：完成配置；输入configurationDone；输出标准成功。
    configurationDoneRequest(response) { this.sendResponse(response); }
    // 功能：返回线程列表；输入threads；输出空列表，取消测试不假装断点验收。
    threadsRequest(response) { response.body = { threads: [] }; this.sendResponse(response); }
    // 功能：等待测试引擎实际退出屏障；输入disconnect；输出唯一terminated。
    async disconnectRequest(response) {
      record('engine-disconnect-pending', { phase: this.phase?.name });
      if (this.phase) await this.phase.exitGate.promise;
      this.sendResponse(response);
      if (!this.closed) { this.closed = true; this.sendEvent(new dap.TerminatedEvent()); record('engine-terminated', { phase: this.phase?.name }); }
    }
  }

  // 功能：执行一个取消场景；输入阶段；输出前台原原因、迟到会话及清理完成断言。
  async function scenario(name) {
    const phase = boundary.configure(name), controller = new AbortController(), reason = new Error('任务51取消：' + name); controllers.push(controller);
    const config = { type: 'android-debug', name: '任务51-' + name, request: 'attach', mode: 'java', packageName: 'dev.task51.fixture', pid: 5101 };
    let cleanup;
    const startedCancellation = vscode.debug.onDidStartDebugSession(session => {
      if (name === 'late-session' && session.configuration.name === config.name && session.configuration.serial === 'task51-device' && !session.parentSession) { record('cancel-on-real-start', { id: session.id }); controller.abort(reason); }
    });
    resources.push(startedCancellation);
    const operation = observe(name + ':start', index.startAndroidDebugging(vscode.workspace.workspaceFolders[0], config, {
      serial: 'task51-device', signal: controller.signal,
      // 功能：观察生产启动清理Promise；输入公开回调；输出独立清理账本。
      onStartupCleanup(value) { cleanup = observe(name + ':cleanup', value); },
    }));
    if (phase.holdClients) await waitFor('provider挂起', () => phase.clients[0]?.pending);
    else if (phase.holdDescriptor) await waitFor('descriptor挂起', () => phase.descriptors === 1);
    else await waitFor('真实start触发取消', () => controller.signal.aborted);
    assert.equal(startup.debugStartupSignal({ name: config.name, serial: 'task51-device' }), controller.signal);
    if (!controller.signal.aborted) controller.abort(reason);
    await deadline('前台取消', operation.done); assert.equal(operation.state, 'rejected'); assert.equal(operation.error, reason);
    assert.ok(cleanup); assert.equal(cleanup.state, 'pending', '底层尚未结束不能宣称清理完成');
    assert.ok(active.has(foreign.id), '不得停止foreign');
    assert.throws(() => startup.registerDebugStartup({ name: config.name, serial: 'task51-device' }, new AbortController().signal), /already starting/);
    if (phase.holdClients) { assert.equal(phase.clients[0].aborted, true); phase.clientsGate.release(); }
    if (phase.holdDescriptor) phase.descriptorGate.release();
    if (name === 'late-session') { await waitFor('真实disconnect等待退出', () => events.some(value => value.event === 'engine-disconnect-pending' && value.phase === name)); assert.equal(cleanup.state, 'pending'); phase.exitGate.release(); }
    await deadline('实际启动清理', cleanup.done); assert.equal(cleanup.state, 'fulfilled', String(cleanup.error));
    await owner.dispose();
    await waitFor('所属会话全部termination', () => [...active.values()].every(value => value.id === foreign.id));
    assert.equal(startup.debugStartupSignal({ name: config.name, serial: 'task51-device' }), undefined);
    assert.equal(phase.releases, phase.forwards); assert.ok(active.has(foreign.id));
    if (name === 'provider-pending') { assert.equal(phase.descriptors, 0); assert.equal(phase.forwards, 0); }
    else {
      assert.equal(phase.descriptors, 1); assert.equal(phase.forwards, 1);
      assert.ok(phase.engines.every(value => value.closed), '真实宿主必须结束每个已创建测试引擎');
    }
    if (name === 'late-session') { assert.ok(events.some(value => value.event === 'cancel-on-real-start')); assert.ok(phase.engines.every(value => value.closed)); }
    outcome.checks.push(name); record('scenario-completed', { name }); startedCancellation.dispose();
  }

  resources.push(vscode.debug.onDidStartDebugSession(session => { active.set(session.id, session); record('vscode-start', { id: session.id, type: session.type, configuration: session.configuration }); }));
  resources.push(vscode.debug.onDidTerminateDebugSession(session => { active.delete(session.id); record('vscode-terminate', { id: session.id, type: session.type }); }));
  resources.push(vscode.debug.registerDebugAdapterTrackerFactory('*', {
    // 功能：只读记录真实双向DAP；输入实际会话；输出证据，不参与取消决定。
    createDebugAdapterTracker(session) { return { onWillReceiveMessage: message => record('dap-client', { id: session.id, message }), onDidSendMessage: message => record('dap-engine', { id: session.id, message }), onError: error => record('adapter-error', { id: session.id, error: String(error) }) }; },
  }));
  try {
    verifyHashes(spec); const extension = vscode.extensions.getExtension('task51.startup-cancel-fixture'); assert.ok(extension);
    assert.equal(path.relative(fs.realpathSync(spec.extension), fs.realpathSync(extension.extensionPath)), '');
    assert.equal(vscode.extensions.getExtension('liangjunheng.vscode-android-ide'), undefined);
    context = await extension.activate(); assert.ok(vscode.workspace.isTrusted);
    assert.equal(path.resolve(vscode.workspace.workspaceFolders[0].uri.fsPath), path.resolve(spec.workspace));
    const metadata = JSON.parse(fs.readFileSync(spec.metadata, 'utf8')); assert.deepEqual(metadata, { variantName: 'debug', applicationId: 'dev.task51.fixture' });
    owner = registerAndroidDebugging(context, () => metadata.applicationId);
    resources.push(vscode.debug.registerDebugAdapterDescriptorFactory('android-jvm', {
      // 功能：控制外部引擎创建时机；输入宿主会话；输出仅取消入口使用的测试DAP。
      async createDebugAdapterDescriptor(session) {
        assert.equal(session.configuration.serial, 'task51-device'); const phase = boundary.runtime.phase; phase.descriptors++; record('descriptor-pending', { phase: phase.name });
        if (phase.holdDescriptor) await phase.descriptorGate.promise;
        return new vscode.DebugAdapterInlineImplementation(new HostEngine(phase));
      },
    }));
    resources.push(vscode.debug.registerDebugAdapterDescriptorFactory('lldb', {
      // 功能：创建无关外部会话；输入无；输出不涉及Android设备的测试DAP。
      createDebugAdapterDescriptor() { return new vscode.DebugAdapterInlineImplementation(new HostEngine()); },
    }));
    assert.equal(await deadline('foreign启动', vscode.debug.startDebugging(vscode.workspace.workspaceFolders[0], { type: 'lldb', name: '任务51-foreign', request: 'attach' })), true);
    foreign = await waitFor('foreign真实start', () => [...active.values()].find(value => value.name === '任务51-foreign'));
    for (const name of names) await scenario(name);
    assert.ok(events.some(value => value.event === 'dap-client' && value.message.command === 'initialize'));
    assert.ok(events.some(value => value.event === 'dap-engine' && value.message.event === 'terminated'));
    outcome.status = 'COMPLETED';
  } catch (error) { outcome.status = 'FAILED'; outcome.error = String(error.stack || error); outcome.notExecuted = names.filter(name => !outcome.checks.includes(name)); record('failure', { error: outcome.error }); }
  finally {
    for (const phase of boundary.runtime.phases) { phase.clientsGate.release(); phase.descriptorGate.release(); phase.exitGate.release(); }
    for (const controller of controllers) if (!controller.signal.aborted) controller.abort(new Error('宿主finally取消'));
    const failures = [];
    // 功能：保留每项清理失败继续关闭其余资源；输入标签和操作；输出警告证据与最终失败。
    async function cleanup(label, operation) { try { await deadline(label, Promise.resolve().then(operation)); } catch (error) { failures.push(label + ': ' + String(error.stack || error)); record('W-cleanup-failed', { label, error: failures.at(-1) }); } }
    await cleanup('启动Promise', () => Promise.all(pending.map(value => value.done)));
    for (const session of [...active.values()]) await cleanup('精确宿主停止', () => vscode.debug.stopDebugging(session));
    await cleanup('实际termination', () => waitFor('全部termination', () => active.size === 0));
    if (owner) await cleanup('生产调试资源', () => owner.dispose());
    for (const resource of [...(context?.subscriptions ?? [])].reverse()) if (resource !== owner) await cleanup('生产注册', () => resource.dispose());
    for (const resource of resources.reverse()) await cleanup('测试宿主注册', () => resource.dispose());
    await cleanup('固定输入哈希', () => verifyHashes(spec));
    outcome.active = [...active.keys()]; outcome.pending = pending.filter(value => value.state === 'pending').length;
    if (failures.length || outcome.active.length || outcome.pending) { outcome.status = 'FAILED'; outcome.cleanupErrors = failures; }
    record('host-finally', { status: outcome.status }); log.end(); const error = await flushed;
    if (error) { outcome.status = 'FAILED'; outcome.logError = String(error); }
    fs.writeFileSync(spec.result, JSON.stringify(outcome, null, 2) + '\n');
  }
  assert.equal(outcome.status, 'COMPLETED', JSON.stringify(outcome));
};
