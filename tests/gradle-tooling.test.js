const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { PassThrough, Writable } = require('node:stream');
const { transformSync } = require('esbuild');
const os = require('node:os');
const { performance } = require('node:perf_hooks');

// 使用当前生产客户端与打包服务；真实工程验证不复制Tooling API实现。
function realClient() {
  const module = { exports: {} };
  vm.runInNewContext(transformSync(fs.readFileSync(path.join(__dirname, '../src/gradleTooling.ts'), 'utf8'), { loader: 'ts', format: 'cjs' }).code,
    { module, exports: module.exports, Buffer, process, require });
  return new module.exports.GradleToolingClient(path.resolve(__dirname, '..'));
}

// 加载真实客户端，仅替换Java进程；验证连接复用、协议边界、取消响应和关闭所有权。
function fixture() {
  const children = [], writes = [];
  const deps = {
    'node:fs': { statSync: () => ({ isFile: () => true }) },
    'node:child_process': { spawn: (...args) => {
      const child = new EventEmitter();
      child.stdout = new PassThrough(); child.stderr = new PassThrough();
      child.stdin = new Writable({ write(chunk, _encoding, done) { writes.push(chunk.toString()); done(); } });
      child.args = args;
      child.exitCode = null; child.signalCode = null;
      child.finish = (code = 0) => { child.exitCode = code; child.stdout.end(); child.stderr.end(); child.emit('close', code); };
      children.push(child); return child;
    } },
  };
  const module = { exports: {} };
  vm.runInNewContext(transformSync(fs.readFileSync(path.join(__dirname, '../src/gradleTooling.ts'), 'utf8'), { loader: 'ts', format: 'cjs' }).code,
    { module, exports: module.exports, Buffer, process, require: id => deps[id] || require(id) });
  const client = new module.exports.GradleToolingClient('/extension');
  const reply = (root, tasks) => children.at(-1).stdout.write('S\t' + Buffer.from(root).toString('base64url') + '\t' + Buffer.from(tasks.join('\n')).toString('base64url') + '\n');
  return { client, children, writes, reply };
}

// 同一服务的两次查询都发送请求，最新任务直接回写，不使用缓存或Wrapper降级。
test('Tooling API reuses one process and requests a fresh model on every query', async () => {
  const f = fixture();
  for (const tasks of [[':app:assembleDebug'], [':feature:installPaidDebug']]) {
    const pending = f.client.query('/project', new AbortController().signal);
    f.reply('/project', tasks);
    assert.deepEqual(Array.from(await pending), tasks);
  }
  const large = [':app:assembleCnPhoneDebug', ':app:installCnPhoneDebug', ...Array.from({ length: 8000 }, (_, i) => ':module:generateAndroidResourceTask' + i)];
  assert.ok(large.join('\n').length > 256 * 1024);
  const pending = f.client.query('/project', new AbortController().signal);
  const response = 'S\t' + Buffer.from('/project').toString('base64url') + '\t' + Buffer.from(large.join('\n')).toString('base64url') + '\n';
  for (let offset = 0; offset < response.length; offset += 16384) f.children[0].stdout.write(response.slice(offset, offset + 16384));
  assert.deepEqual(Array.from(await pending), large);
  assert.equal(f.children.length, 1);
  assert.equal(f.writes.filter(line => line.startsWith('Q\t')).length, 3);
  let closed = false;
  const disposal = f.client.dispose().then(() => { closed = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(closed, false);
  f.children[0].finish(); await disposal;
  await assert.rejects(f.client.query('/project', new AbortController().signal), /disposed/);
});

// 取消仅发送Tooling token请求，必须等待服务结束响应，随后仍可复用同一服务。
test('Tooling API cancellation holds ownership until the model response', async () => {
  const f = fixture(), controller = new AbortController();
  let settled = false;
  const pending = f.client.query('/project', controller.signal);
  const rejected = assert.rejects(pending, /cancelled/).then(() => { settled = true; });
  controller.abort(new Error('cancelled'));
  assert.equal(f.writes.at(-1), 'C\n');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false);
  await assert.rejects(f.client.query('/project', new AbortController().signal), /already running/);
  f.reply('/project', [':app:assembleDebug']); await rejected;
  const next = f.client.query('/project', new AbortController().signal);
  f.reply('/project', [':app:installDebug']); await next;
  const disposal = f.client.dispose(); f.children[0].finish(); await disposal;
});

// 原始Gradle异常、无效响应及进程失败都必须拒绝，不伪装成空任务或重复执行。
test('Tooling API reports query protocol and process errors without fallback', async () => {
  for (const mode of ['gradle', 'root', 'task', 'exit', 'spawn', 'pipe']) {
    const f = fixture();
    const pending = f.client.query('/project', new AbortController().signal);
    const rejected = assert.rejects(pending, /plugin failure|Invalid|exited|spawn failure|pipe failure/);
    const child = f.children[0];
    if (mode === 'gradle') child.stdout.write('E\t' + Buffer.from('plugin failure').toString('base64url') + '\n');
    if (mode === 'root') f.reply('/wrong', [':app:assembleDebug']);
    if (mode === 'task') f.reply('/project', ['not-a-task']);
    if (mode === 'exit') { child.stderr.write('plugin failure'); child.finish(1); }
    if (mode === 'spawn') { child.emit('error', new Error('spawn failure')); child.finish(1); }
    if (mode === 'pipe') child.stdin.emit('error', new Error('pipe failure'));
    await rejected;
    assert.equal(f.children.length, 1);
    const disposal = f.client.dispose(); if (child.exitCode === null) child.finish(); await disposal;
  }
});

// 显式提供已安装Wrapper properties后，实测打包JAR的最新模型、失败恢复、取消与连接关闭；无该环境不冒充真机成功。
test('packaged Tooling API service queries fresh models and recovers from Gradle errors', { skip: !process.env.DSH_GRADLE_TEST_WRAPPER_PROPERTIES }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gradle tooling real '));
  const wrapper = path.join(root, 'gradle', 'wrapper');
  fs.mkdirSync(wrapper, { recursive: true });
  fs.copyFileSync(process.env.DSH_GRADLE_TEST_WRAPPER_PROPERTIES, path.join(wrapper, 'gradle-wrapper.properties'));
  fs.writeFileSync(path.join(root, 'settings.gradle'), "rootProject.name = 'tooling-check'\ninclude ':app', ':feature'\n");
  const build = path.join(root, 'build.gradle');
  const valid = "subprojects {\n  tasks.register('assemblePaidDebug')\n  tasks.register('installPaidDebug')\n}\n";
  const save = text => { fs.writeFileSync(build + '.tmp', text); fs.renameSync(build + '.tmp', build); };
  save(valid);
  const client = realClient();
  t.after(async () => { try { await client.dispose(); } finally { fs.rmSync(root, { recursive: true, force: true }); } });
  const query = () => client.query(root, new AbortController().signal);
  const first = await query();
  for (const module of ['app', 'feature']) for (const task of ['assemblePaidDebug', 'installPaidDebug']) assert.ok(first.includes(':' + module + ':' + task));
  save(valid + "tasks.register('assembleNewDebug')\n");
  assert.ok((await query()).includes(':assembleNewDebug'));
  save("throw new GradleException('fixture plugin failure')\n");
  await assert.rejects(query(), /fixture plugin failure/);
  save(valid);
  assert.ok((await query()).includes(':app:installPaidDebug'));
  const controller = new AbortController();
  const cancelled = client.query(root, controller.signal);
  const rejected = assert.rejects(cancelled, /cancelled/);
  controller.abort(new Error('cancelled'));
  await rejected;
  assert.ok((await query()).includes(':app:assemblePaidDebug'));
  const missing = path.join(root, 'no-wrapper'); fs.mkdirSync(missing);
  await assert.rejects(client.query(missing, new AbortController().signal), /Wrapper properties missing/);
  await client.dispose();
});

// 可选真实Android工程实测通用模型，严格核对实际assemble/install任务，记录首次与稳定查询耗时。
test('packaged Tooling API returns Android tasks from the actual project', { skip: !process.env.DSH_GRADLE_TEST_ANDROID_ROOT }, async t => {
  const client = realClient(); t.after(() => client.dispose());
  const samples = [];
  for (let i = 0; i < 6; i++) {
    const start = performance.now();
    const tasks = await client.query(process.env.DSH_GRADLE_TEST_ANDROID_ROOT, new AbortController().signal);
    samples.push(Math.round(performance.now() - start));
    const expected = JSON.parse(process.env.DSH_GRADLE_TEST_EXPECTED_TASKS || '[":app:assembleDebug",":app:installDebug"]');
    for (const task of expected) assert.ok(tasks.includes(task), task);
  }
  t.diagnostic(JSON.stringify({ firstMs: samples[0], stableMs: samples.slice(1) }));
});
