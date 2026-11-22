/**
 * 功能点：Coordinator 协议、租约及统一会话资源生命周期。
 * 受影响对象：AndroidDebugCoordinatorClient、AndroidCoordinator、AndroidDebugSession。
 * 复现路径：Node>=22，替换 Java 子进程边界，执行真实请求、取消、事件及资源清理。
 * 测试范围：并发响应、迟到响应、失联、独占租约释放、逆序清理及异常聚合。
 * 执行入口：npm test -- --test-name-pattern=Coordinator；完整入口 npm test。
 * 预期结果：响应不串线，失联关闭所属会话，精确释放且不删除共享代理。
 * 判据：实际协议字段与资源结算顺序全部匹配，任何异常必须显式报告。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { transformSync } = require('esbuild');

/** 功能：加载真实 TypeScript 模块；输入依赖边界；输出生产导出对象。 */
function load(file, dependencies) {
  const module = { exports: {} };
  vm.runInNewContext(transformSync(fs.readFileSync(file, 'utf8'), { loader: 'ts', format: 'cjs' }).code,
    { module, exports: module.exports, require: id => dependencies[id] ?? require(id), Buffer, process, console, AbortController, AggregateError });
  return module.exports;
}

/** 功能：仅模拟 Java 进程与 JDK 探测；输出真实协议客户端及管道。 */
function clientFixture() {
  const child = new EventEmitter();
  Object.assign(child, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
  child.stdin.on('finish', () => child.emit('close', 0));
  const { AndroidDebugCoordinatorClient } = load('src/android-debugger/coordinator/client.ts', {
    'node:fs': { existsSync: () => true },
    'node:child_process': { spawn: () => child },
    '../jvm-debugger/java': { findJava: async () => ({ java: 'java' }) },
  });
  const lines = [];
  child.stdin.on('data', value => lines.push(value.toString().trimEnd().split('\t')));
  const client = new AndroidDebugCoordinatorClient('/extension');
  return { client, child, lines, reply(id, value, status = 'OK') { child.stdout.write(`${id}\t${status}\t${Buffer.from(value).toString('base64url')}\n`); } };
}

/** 功能：等待请求实际写入；输入客户端请求；输出下一微任务后的协议状态。 */
async function written() { await new Promise(resolve => setImmediate(resolve)); }

test('Coordinator concurrent requests preserve IDs and encoded arguments', async () => {
  const f = clientFixture();
  const first = f.client.command('install', ['S', 'C:/APK with spaces/a.apk']);
  const second = f.client.command('devices', []);
  await written();
  assert.equal(f.lines.length, 2);
  assert.equal(Buffer.from(f.lines[0][3], 'base64url').toString(), 'C:/APK with spaces/a.apk');
  f.reply(f.lines[1][0], 'second'); f.reply(f.lines[0][0], 'first');
  assert.equal(await first, 'first'); assert.equal(await second, 'second');
  await f.client.dispose();
});

test('Coordinator registers lease before a following loss event in the same stdout chunk', async () => {
  const f = clientFixture();
  const api = load('src/android-debugger/coordinator/androidCoordinator.ts', { './client': { AndroidDebugCoordinatorClient: class { constructor() { return f.client; } } } });
  const coordinator = new api.AndroidCoordinator('/extension'), losses = [];
  const session = coordinator.session('S', error => losses.push(error));
  const claim = session.claim(42); const rejected = assert.rejects(claim);
  await written();
  const id = f.lines[0][0], encode = value => Buffer.from(value).toString('base64url');
  f.child.stdout.write(`${id}\tOK\t${encode('19\t8700')}\n0\tEVENT\t${encode('lease.lost')}\t${encode('19')}\n`);
  await written(); f.reply(f.lines.at(-1)[0], ''); await rejected;
  assert.equal(losses.length, 1); assert.equal(session.signal.aborted, true);
  await session.close(); await coordinator.dispose();
});

test('Coordinator cancellation reclaims exact request and ignores late response', async () => {
  const f = clientFixture(), controller = new AbortController();
  const request = f.client.command('claim', ['S', '42'], controller.signal);
  const rejected = assert.rejects(request, /cancelled/);
  await written(); controller.abort(new Error('cancelled'));
  const cancel = f.lines.at(-1);
  assert.equal(cancel[1], 'cancel'); assert.equal(Buffer.from(cancel[2], 'base64url').toString(), f.lines[0][0]);
  f.reply(f.lines[0][0], 'late'); f.reply(cancel[0], ''); await rejected;
  const next = f.client.command('devices', []); await written(); f.reply(f.lines.at(-1)[0], 'next');
  assert.equal(await next, 'next'); await f.client.dispose();
});

test('Coordinator process failure broadcasts loss and rejects all pending requests', async () => {
  const f = clientFixture(), events = [];
  f.client.onEvent(event => events.push(event));
  const request = f.client.command('devices', []); const rejected = assert.rejects(request, /exited/);
  await written(); f.child.emit('close', 7); await rejected;
  assert.equal(events.length, 1); assert.equal(events[0].type, 'coordinator.lost');
  await assert.rejects(f.client.dispose(), /shutdown failed/);
});

/** 功能：替换协议传输保留真实 facade 和会话；输出可注入失联事件。 */
function coordinatorFixture() {
  const calls = [], listeners = new Set();
  class Client {
    onEvent(listener) { listeners.add(listener); return { dispose: () => listeners.delete(listener) }; }
    async command(operation, args, signal) {
      calls.push({ operation, args: Array.from(args), signal });
      if (operation === 'claim') return '19\t8700';
      if (operation === 'launch') return '42';
      return '';
    }
    async dispose() {}
  }
  const api = load('src/android-debugger/coordinator/androidCoordinator.ts', { './client': { AndroidDebugCoordinatorClient: Client } });
  const coordinator = new api.AndroidCoordinator('/extension');
  return { coordinator, calls, listeners, event(type, value) { for (const listener of [...listeners]) listener({ type, value }); } };
}

test('Coordinator session owns engines server and lease in reverse cleanup order', async () => {
  const f = coordinatorFixture(), order = [];
  const session = f.coordinator.session('S', () => assert.fail('unexpected loss'));
  assert.equal((await session.claim(42)).port, 8700);
  session.own(async () => { order.push('server'); });
  session.own(async () => { order.push('engine'); });
  const close = session.close(); assert.equal(close, session.close()); await close;
  assert.deepEqual(order, ['engine', 'server']);
  assert.deepEqual(f.calls.at(-1).args, ['19']); assert.equal(f.calls.at(-1).operation, 'release');
  assert.equal(f.listeners.size, 0); await f.coordinator.dispose();
});

test('Coordinator lease and device loss affect only owning sessions', async () => {
  for (const [type, value] of [['lease.lost', '19'], ['device.lost', 'S'], ['coordinator.lost', 'exited']]) {
    const f = coordinatorFixture(), losses = [];
    const session = f.coordinator.session('S', error => losses.push(error));
    await session.claim(42);
    f.event('lease.lost', 'foreign'); f.event('device.lost', 'foreign'); assert.equal(losses.length, 0);
    f.event(type, value); f.event(type, value);
    assert.equal(losses.length, 1); assert.equal(session.signal.aborted, true);
    await session.close(); await f.coordinator.dispose();
  }
});

test('Coordinator cleanup aggregates failures without skipping remaining resources', async () => {
  const f = coordinatorFixture(), order = [];
  const session = f.coordinator.session('S', () => {});
  await session.claim(42);
  session.own(async () => { order.push('server'); throw new Error('server failed'); });
  session.own(async () => { order.push('engine'); throw new Error('engine failed'); });
  await assert.rejects(session.close(), error => error.errors.length === 2);
  assert.deepEqual(order, ['engine', 'server']); assert.equal(f.calls.at(-1).operation, 'release');
  await f.coordinator.dispose();
});
