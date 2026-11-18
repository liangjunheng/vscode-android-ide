const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const Module = require('node:module');
const { randomUUID } = require('node:crypto');
const { transformSync } = require('esbuild');
const source = require('node:fs').readFileSync(path.join(__dirname, '../src/android-debugger/sessionResources.ts'), 'utf8');
const loaded = new Module(__filename, module);
loaded.filename = __filename; loaded.paths = module.paths;
loaded._compile(transformSync(source, { loader: 'ts', format: 'cjs', target: 'node22' }).code, __filename);
const { SessionResourceLedger } = loaded.exports;
const owner = { host: 'host-a', bootId: 'boot-a', pid: 123, startIdentity: 'process-start-a' };
/** 创建精确目录描述符；descriptors/proof 用例不执行任何设备或进程操作。 */
function directory(n) { return { kind: 'local-directory', relativePath: 'owned/' + n, marker: 'marker-' + n }; }
/** 无延时事件门，用于锁竞争、晚到获取与 close 的确定边界。 */
function gate() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
/** 创建真实临时文件系统；每例结束仅移除测试自己创建的根，不触碰用户目录。 */
async function fixture(t, overrides = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dta-resources-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const released = []; const present = new Set(); const probes = [];
  const handler = { probe: async d => { probes.push(d); return present.has(d.marker || d.kind) ? 'matched' : 'absent'; }, release: async d => { released.push(d); present.delete(d.marker || d.kind); } };
  const options = { root, sessionId: randomUUID(), mode: 'jvm-native', ownerIdentity: owner, identityProbe: async () => 'dead', handlers: Object.fromEntries(['local-directory', 'dap-child', 'native-server', 'adb-forward'].map(k => [k, handler])), ...overrides };
  const ledger = await SessionResourceLedger.open(options);
  const file = path.join(root, options.sessionId, 'resources.json');
  return { root, options, ledger, file, released, present, probes, handler };
}
/** 插入可审计资源，外部副作用由集合表示；claim 顺序与 late completion 用例核对磁盘先于副作用。 */
async function acquire(f, n, resource = directory(n)) {
  const id = randomUUID();
  await f.ledger.acquire(id, resource, async () => { const disk = JSON.parse(await fs.readFile(f.file, 'utf8')); assert.equal(disk.resources.find(r => r.id === id).state, 'claiming'); f.present.add(resource.marker || resource.kind); });
  return id;
}
/** 包装真实 IO，仅按指定文件与操作故障；其余调用落到真实临时文件系统。 */
function faultIO(control) {
  return new Proxy(fs, { get(target, key) {
    if (key === 'open') return async (file, flags, mode) => {
      if (control.enabled && control.match(String(file)) && control.stage === 'open') throw new Error('fault-open');
      const handle = await target.open(file, flags, mode);
      return new Proxy(handle, { get(h, op) {
        const value = h[op]; if (typeof value !== 'function') return value;
        return async (...args) => {
          if (control.enabled && control.match(String(file)) && control.stage === op) {
            if (op === 'close') await h.close();
            throw new Error('fault-' + String(op));
          }
          return value.apply(h, args);
        };
      } });
    };
    if (key === 'rename') return async (from, to) => { if (control.enabled && control.stage === 'rename' && control.match(String(from))) throw new Error('fault-rename'); return target.rename(from, to); };
    const value = target[key]; return typeof value === 'function' ? value.bind(target) : value;
  } });
}
/** 展开 AggregateError，断言主错误和句柄错误均没有被吞。 */
function messages(error) { return [String(error), ...(error?.errors || []).flatMap(messages)].join(' | '); }

for (const mode of ['jvm', 'native', 'jvm-native']) test('descriptors persist mode and exact ownership: ' + mode, async t => {
  const f = await fixture(t, { mode });
  const resources = [directory(1), { kind: 'dap-child', pid: 45, executable: process.execPath, argvHash: 'sha256-argv', startIdentity: 'start-45' }, { kind: 'native-server', serial: 'emulator-5554', pid: 99, executable: '/data/app/server', socket: '/data/app/s', targetIdentity: 'target-start', startIdentity: 'server-start' }, { kind: 'adb-forward', serial: 'emulator-5554', local: 'tcp:12345', remote: 'localfilesystem:/data/app/s', transportIdentity: 'adb-transport-7' }];
  for (let n = 0; n < resources.length; n++) await acquire(f, n, resources[n]);
  const disk = JSON.parse(await fs.readFile(f.file, 'utf8')); assert.equal(disk.mode, mode); assert.deepEqual(disk.resources.map(r => r.descriptor), resources); assert.deepEqual(disk.resources[0].ownerIdentity, owner);
  const snap = f.ledger.snapshot(); snap.resources.length = 0; assert.equal(f.ledger.snapshot().resources.length, 4);
  await f.ledger.close();
});

test('strict schema rejects missing descriptor fields before side effects and duplicates', async t => {
  const f = await fixture(t); let effects = 0;
  for (const d of [{ kind: 'dap-child', pid: 1 }, { kind: 'local-directory', relativePath: '../outside', marker: 'm' }, { kind: 'local-directory', relativePath: 'x', marker: '' }, { kind: 'local-directory', relativePath: 'x', marker: 'm', extra: 1 }, { kind: 'adb-forward', serial: 's', local: 'tcp:99999', remote: 'x', transportIdentity: 't' }]) await assert.rejects(f.ledger.acquire(randomUUID(), d, async () => { effects++; }));
  assert.equal(effects, 0); const id = await acquire(f, 1); await assert.rejects(f.ledger.acquire(id, directory(2), async () => {}), /duplicate/); await assert.rejects(f.ledger.acquire(randomUUID(), { marker: 'marker-1', relativePath: 'owned/1', kind: 'local-directory' }, async () => {}), /duplicate/);
  await assert.rejects(SessionResourceLedger.open({ ...f.options, sessionId: randomUUID(), ownerIdentity: {} }), /schema/); await f.ledger.close();
});

test('corrupt/schema/duplicate persisted records remain untouched', async t => {
  const f = await fixture(t); await acquire(f, 1); await f.ledger.close(); const valid = JSON.parse(await fs.readFile(f.file, 'utf8'));
  for (const value of ['{broken', JSON.stringify({ ...valid, extra: true }), JSON.stringify({ ...valid, resources: [valid.resources[0], valid.resources[0]] }), JSON.stringify({ ...valid, resources: [{ ...valid.resources[0], ownerIdentity: {} }] }), 'null']) {
    await fs.writeFile(f.file, value); await assert.rejects(SessionResourceLedger.open(f.options)); assert.equal(await fs.readFile(f.file, 'utf8'), value);
  }
});

test('fresh session keeps first live owner and rejects second opener', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dta-fresh-lock-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sessionId = randomUUID(); const firstOwner = { ...owner, startIdentity: 'first-owner' }; const secondOwner = { ...owner, startIdentity: 'second-owner' };
  const first = await SessionResourceLedger.open({ root, sessionId, mode: 'jvm', ownerIdentity: firstOwner, identityProbe: async () => 'alive' });
  const dir = path.join(root, sessionId); const before = await fs.readdir(dir);
  await assert.rejects(SessionResourceLedger.open({ root, sessionId, mode: 'jvm', ownerIdentity: secondOwner, identityProbe: async identity => { assert.deepEqual(identity, firstOwner); return 'alive'; } }), /existing owner alive/);
  assert.deepEqual(await fs.readdir(dir), before); await first.close();
});

test('surviving crash lock resumes with dead proof and incomplete claim', async t => {
  const f = await fixture(t); const id = randomUUID(); await assert.rejects(f.ledger.acquire(id, directory(1), async () => { f.present.add('marker-1'); throw new Error('crash-boundary'); }), /crash/);
  const original = await fs.readFile(path.join(path.dirname(f.file), '.lock'), 'utf8');
  // 不调用旧实例 close，模拟扩展宿主崩溃后仅有磁盘状态；probe 提供该精确旧身份已死的证据。
  const resumed = await SessionResourceLedger.open({ ...f.options, ownerIdentity: { ...owner, startIdentity: 'new-start' } });
  assert.equal(resumed.snapshot().resources[0].state, 'claiming'); const result = await resumed.reconcile(); assert.deepEqual(result.released, [id]); assert.equal(f.present.size, 0); assert.equal(await fs.readFile(path.join(path.dirname(f.file), '.lock'), 'utf8'), original); await resumed.close();
});

for (const proof of ['alive', 'unknown', 'invalid']) test('lock preserves live or unproven owner: ' + proof, async t => {
  const f = await fixture(t); const before = await fs.readdir(path.dirname(f.file));
  await assert.rejects(SessionResourceLedger.open({ ...f.options, identityProbe: async identity => { assert.deepEqual(identity, owner); return proof; } }), /owner|proof/);
  assert.deepEqual(await fs.readdir(path.dirname(f.file)), before); await f.ledger.close();
});

test('two dead-lock contenders cannot unlink or replace winning owner', async t => {
  const f = await fixture(t); const both = gate(); let arrivals = 0;
  const identityProbe = async () => { if (++arrivals === 2) both.resolve(); await both.promise; return 'dead'; };
  const results = await Promise.allSettled([1, 2].map(n => SessionResourceLedger.open({ ...f.options, ownerIdentity: { ...owner, startIdentity: 'contender-' + n }, identityProbe })));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1); assert.equal(results.filter(r => r.status === 'rejected').length, 1);
  const winner = results.find(r => r.status === 'fulfilled').value; await winner.close();
});

test('unrelated UUID remains active while another acquisition is pending', async t => {
  const f = await fixture(t); const entered = gate(); const finish = gate();
  const work = f.ledger.acquire(randomUUID(), directory(1), async () => { entered.resolve(); await finish.promise; }); await entered.promise;
  const other = await SessionResourceLedger.open({ ...f.options, sessionId: randomUUID() }); await other.acquire(randomUUID(), directory(2), async () => {}); assert.equal(other.snapshot().resources.length, 1); await other.close(); finish.resolve(); await work; await f.ledger.close();
});

for (const proof of ['alive', 'unknown', 'invalid']) test('PID reuse owner proof preserves resources: ' + proof, async t => {
  const f = await fixture(t); await acquire(f, 1); await f.ledger.close();
  let calls = 0; const resumed = await SessionResourceLedger.open({ ...f.options, identityProbe: async () => ++calls === 1 ? 'dead' : proof }); const result = await resumed.reconcile(); assert.equal(result.released.length, 0); assert.equal(f.released.length, 0); assert.equal(resumed.snapshot().resources.length, 1); if (proof === 'alive') assert.equal(result.retained.length, 1); else assert.equal(result.conflicts.length, 1); await resumed.close();
});

for (const proof of ['matched', 'absent', 'conflict', 'unknown', 'dead']) test('resource proof is distinct from owner death: ' + proof, async t => {
  const f = await fixture(t); await acquire(f, 1); f.handler.probe = async () => proof; const result = await f.ledger.reconcile();
  assert.equal(f.released.length, proof === 'matched' ? 1 : 0); assert.equal(f.ledger.snapshot().resources.length, ['matched', 'absent'].includes(proof) ? 0 : 1); assert.equal(result.conflicts.length, ['matched', 'absent'].includes(proof) ? 0 : 1); await f.ledger.close();
});

test('missing handler/probe never invents successful release', async t => {
  const f = await fixture(t, { handlers: {} }); await acquire(f, 1); const result = await f.ledger.reconcile(); assert.equal(result.errors.length, 1); assert.match(result.conflicts[0].reason, /handler missing/); assert.equal(f.ledger.snapshot().resources.length, 1); await f.ledger.close();
});

test('aggregate independent releases and resume only remaining records', async t => {
  const f = await fixture(t); const first = await acquire(f, 1); const second = await acquire(f, 2); let failures = true; const attempted = [];
  f.handler.release = async d => { attempted.push(d.marker); if (failures) throw new Error('release-' + d.marker); f.present.delete(d.marker); };
  const one = await f.ledger.reconcile(); assert.equal(one.errors.length, 2); assert.deepEqual(attempted, ['marker-1', 'marker-2']); failures = false;
  f.handler.release = async d => { if (d.marker === 'marker-1') throw new Error('still-failed'); f.present.delete(d.marker); };
  const two = await f.ledger.reconcile(); assert.deepEqual(two.released, [second]); assert.equal(two.errors.length, 1); await f.ledger.close();
  f.handler.release = async d => f.present.delete(d.marker); const resumed = await SessionResourceLedger.open(f.options); const three = await resumed.reconcile(); assert.deepEqual(three.released, [first]); assert.equal(resumed.snapshot().resources.length, 0); await resumed.close();
});

for (const stage of ['open', 'writeFile', 'sync', 'close', 'rename']) test('claim journal fault boundary retains ownership: ' + stage, async t => {
  const control = { stage, enabled: false, match: file => file.endsWith('.tmp') }; const f = await fixture(t, { io: faultIO(control) }); let effects = 0; control.enabled = true;
  await assert.rejects(f.ledger.acquire(randomUUID(), directory(1), async () => { effects++; }), error => messages(error).includes('fault-' + stage)); assert.equal(effects, 0); assert.equal(f.ledger.snapshot().resources.length, 0); control.enabled = false;
  await acquire(f, 1); assert.equal(f.ledger.snapshot().resources.length, 1); await f.ledger.close();
});

test('acquired persist failure retains claim, side effect and visible temp artifact', async t => {
  const control = { stage: 'rename', enabled: false, match: file => file.endsWith('.tmp') }; const f = await fixture(t, { io: faultIO(control) }); const id = randomUUID();
  await assert.rejects(f.ledger.acquire(id, directory(1), async () => { f.present.add('marker-1'); control.enabled = true; }), /fault-rename/); assert.equal(f.ledger.snapshot().resources[0].state, 'claiming'); control.enabled = false; await f.ledger.close();
  const resumed = await SessionResourceLedger.open(f.options); assert.ok(resumed.artifacts.length > 0); const result = await resumed.reconcile(); assert.deepEqual(result.released, [id]); await resumed.close();
});

test('release rename failure preserves record; absent proof avoids duplicate release on resume', async t => {
  const control = { stage: 'rename', enabled: false, match: file => file.endsWith('.tmp') }; const f = await fixture(t, { io: faultIO(control) }); const id = await acquire(f, 1); control.enabled = true;
  await assert.rejects(f.ledger.release(id), /fault-rename/); assert.equal(f.ledger.snapshot().resources.length, 1); assert.equal(JSON.parse(await fs.readFile(f.file, 'utf8')).resources.length, 1); assert.equal(f.released.length, 1); control.enabled = false; await f.ledger.release(id); assert.equal(f.released.length, 1); assert.equal(f.ledger.snapshot().resources.length, 0); await f.ledger.close();
});

test('metadata races keep all records and close awaits late acquisition', async t => {
  const f = await fixture(t); const entered = gate(); const late = gate(); const id1 = randomUUID(); const id2 = randomUUID();
  const first = f.ledger.acquire(id1, directory(1), async () => { entered.resolve(); await late.promise; }); await entered.promise;
  await f.ledger.acquire(id2, directory(2), async () => {}); assert.equal(f.ledger.snapshot().resources.length, 2); let finished = false; const closing = f.ledger.close().then(() => { finished = true; });
  await assert.rejects(f.ledger.acquire(randomUUID(), directory(3), async () => {}), /closing/); await assert.rejects(f.ledger.release(id2), /closing/); assert.equal(finished, false); late.resolve(); await first; await closing; assert.equal(f.ledger.snapshot().resources.every(r => r.state === 'acquired'), true); assert.equal(f.ledger.close(), f.ledger.close());
});

test('cancellation after side effect releases exact late resource and waits', async t => {
  const f = await fixture(t); const controller = new AbortController(); const id = randomUUID(); await assert.rejects(f.ledger.acquire(id, directory(1), async () => { f.present.add('marker-1'); controller.abort(new Error('cancelled')); }, controller.signal), /cancelled/); assert.equal(f.present.size, 0); assert.equal(f.ledger.snapshot().resources.length, 0); await f.ledger.close();
});

for (const site of ['root', 'session', 'ledger', 'lock', 'local-directory']) test('real symlink/junction rejection: ' + site, async t => {
  const f = await fixture(t); const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'dta-outside-')); t.after(() => fs.rm(outside, { recursive: true, force: true })); await fs.writeFile(path.join(outside, 'sentinel'), 'keep');
  if (site === 'local-directory') { const id = await acquire(f, 1); await fs.mkdir(path.join(f.root, 'owned')); await fs.symlink(outside, path.join(f.root, 'owned', '1'), 'junction'); await assert.rejects(f.ledger.acquire(randomUUID(), directory(1), async () => assert.fail('unsafe side effect')), /symlink/); await assert.rejects(f.ledger.release(id), /symlink/); assert.equal(f.released.length, 0); }
  else {
    const link = path.join(f.root, 'linked');
    if (site === 'root') { await fs.symlink(outside, link, 'junction'); await assert.rejects(SessionResourceLedger.open({ ...f.options, root: link }), /symlink/); }
    if (site === 'session') { const sid = randomUUID(); await fs.symlink(outside, path.join(f.root, sid), 'junction'); await assert.rejects(SessionResourceLedger.open({ ...f.options, sessionId: sid }), /symlink/); }
    if (site === 'ledger' || site === 'lock') { const sid = randomUUID(); const dir = path.join(f.root, sid); await fs.mkdir(dir); await fs.symlink(outside, path.join(dir, site === 'ledger' ? 'resources.json' : '.lock'), 'junction'); await assert.rejects(SessionResourceLedger.open({ ...f.options, sessionId: sid }), /symlink/); }
  }
  assert.equal(await fs.readFile(path.join(outside, 'sentinel'), 'utf8'), 'keep'); await f.ledger.close();
});

test('bounded files and bounded ledger reject without overwriting', async t => {
  const f = await fixture(t); await f.ledger.close(); await fs.writeFile(f.file, ' '.repeat(1024 * 1024 + 1)); await assert.rejects(SessionResourceLedger.open(f.options), error => /bounded/.test(messages(error)));
  await fs.unlink(f.file); const dir = path.dirname(f.file); for (let n = 0; n < 1025; n++) await fs.writeFile(path.join(dir, 'entry-' + n), ''); await assert.rejects(SessionResourceLedger.open(f.options), /count exceeds/);
});

/** 读取与目录 IO 故障不得伪造空账本；全部边界在真实 FS 上注入且原数据保持不变。 */
for (const stage of ['open', 'stat', 'read', 'close']) test('existing ledger read IO boundary: ' + stage, async t => {
  const f = await fixture(t); await acquire(f, 1); await f.ledger.close(); const before = await fs.readFile(f.file, 'utf8');
  const control = { stage, enabled: true, match: file => file === f.file };
  await assert.rejects(SessionResourceLedger.open({ ...f.options, io: faultIO(control) }), error => messages(error).includes('fault-' + stage)); assert.equal(await fs.readFile(f.file, 'utf8'), before);
});

for (const stage of ['open', 'writeFile', 'sync', 'close']) test('initial lock IO boundary preserves crash evidence: ' + stage, async t => {
  const f = await fixture(t); await f.ledger.close(); const sid = randomUUID(); const dir = path.join(f.root, sid);
  const control = { stage, enabled: true, match: file => file === path.join(dir, '.lock') };
  await assert.rejects(SessionResourceLedger.open({ ...f.options, sessionId: sid, io: faultIO(control) }), error => messages(error).includes('fault-' + stage));
  if (stage === 'open') assert.equal((await fs.readdir(dir)).length, 0);
  else {
    assert.ok((await fs.readdir(dir)).includes('.lock'));
    if (stage === 'writeFile') await assert.rejects(SessionResourceLedger.open({ ...f.options, sessionId: sid }));
    else { const resumed = await SessionResourceLedger.open({ ...f.options, sessionId: sid }); await resumed.close(); }
  }
});

for (const stage of ['lstat', 'mkdir', 'opendir']) test('directory IO boundary is visible: ' + stage, async t => {
  const f = await fixture(t); const io = new Proxy(fs, { get(target, key) { if (key === stage) return async () => { throw new Error('directory-' + stage); }; const value = target[key]; return typeof value === 'function' ? value.bind(target) : value; } });
  await assert.rejects(SessionResourceLedger.open({ ...f.options, sessionId: randomUUID(), io }), new RegExp('directory-' + stage)); await f.ledger.close();
});

test('simultaneous write and close failures aggregate without swallowing either error', async t => {
  const io = new Proxy(fs, { get(target, key) {
    if (key === 'open') return async (file, flags, mode) => { const h = await target.open(file, flags, mode); if (!String(file).endsWith('.tmp')) return h; return new Proxy(h, { get(handle, op) { if (op === 'writeFile') return async () => { throw new Error('primary-write'); }; if (op === 'close') return async () => { await handle.close(); throw new Error('secondary-close'); }; const value = handle[op]; return typeof value === 'function' ? value.bind(handle) : value; } }); };
    const value = target[key]; return typeof value === 'function' ? value.bind(target) : value;
  } });
  const f = await fixture(t, { io }); await assert.rejects(f.ledger.acquire(randomUUID(), directory(1), async () => assert.fail('side effect must not run')), error => messages(error).includes('primary-write') && messages(error).includes('secondary-close')); assert.equal(f.ledger.snapshot().resources.length, 0); await f.ledger.close();
});

test('resource probe throws but independent cleanup continues and proof mismatch remains visible', async t => {
  const f = await fixture(t); const one = await acquire(f, 1); const two = await acquire(f, 2);
  const original = f.handler.probe; f.handler.probe = async d => { if (d.marker === 'marker-1') throw new Error('probe-denied'); return original(d); };
  const result = await f.ledger.reconcile(); assert.equal(result.errors.length, 1); assert.deepEqual(result.released, [two]); assert.equal(f.ledger.snapshot().resources[0].id, one); await f.ledger.close();
});

test('cancelled late acquisition with failed release keeps exact unresolved resource', async t => {
  const f = await fixture(t); const controller = new AbortController(); f.handler.release = async () => { throw new Error('cleanup-failed'); };
  await assert.rejects(f.ledger.acquire(randomUUID(), directory(1), async () => { f.present.add('marker-1'); controller.abort(new Error('cancelled')); }, controller.signal), error => messages(error).includes('cancelled') && messages(error).includes('cleanup-failed'));
  assert.equal(f.ledger.snapshot().resources[0].state, 'acquired'); assert.equal(f.present.size, 1); await f.ledger.close();
});

test('close waits rejected late acquisition and reports unresolved claim without losing record', async t => {
  const f = await fixture(t); const entered = gate(); const finish = gate();
  const task = f.ledger.acquire(randomUUID(), directory(1), async () => { entered.resolve(); await finish.promise; throw new Error('late-failure'); }); const rejected = assert.rejects(task, /late-failure/); await entered.promise;
  const closing = assert.rejects(f.ledger.close(), error => messages(error).includes('late-failure')); finish.resolve(); await rejected; await closing; assert.equal(f.ledger.snapshot().resources[0].state, 'claiming');
});
