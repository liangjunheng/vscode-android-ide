const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const LogcatBuffer = require('../media/logcat/buffer.js');
const vm = require('node:vm');
const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, '../package.json'), 'utf8'));
const main = fs.readFileSync(path.join(__dirname, '../media/logcat/main.js'), 'utf8');
const source = fs.readFileSync(path.join(__dirname, '../src/logcat.ts'), 'utf8');

// 回归 Android Studio 默认容量和 VS Code 配置边界；npm test 无设备依赖，断言当前清单与后端初始化契约。
test('Logcat uses a bounded configurable buffer matching Android Studio by default', () => {
  const setting = packageJson.contributes.configuration.properties['android.logcat.maxBytes'];
  assert.equal(setting.default, 1024 * 1024);
  assert.equal(setting.minimum, 64 * 1024);
  assert.equal(setting.maximum, 64 * 1024 * 1024);
  assert.match(setting.description, /Android Studio/);
  assert.match(source, /logcat\.maxBytes/);
  assert.match(source, /DEFAULT_LOGCAT_MAX_BYTES = 1024 \* 1024/);
  assert.match(main, /maxBytes = Number\.isFinite\(m\.maxBytes\)/);
});

// 执行后端配置读取函数；断言默认、无效数字、负数、超大值和小数的实际输出。
test('backend clamps configuration to finite integer bounds', () => {
  const start = source.indexOf('  private maxBytes() {');
  const end = source.indexOf('\n  private icons()', start);
  assert.ok(start >= 0 && end > start);
  const method = source.slice(start, end).replace('private maxBytes()', 'function maxBytes()');
  const constants = source.slice(source.indexOf('const DEFAULT_LOGCAT_MAX_BYTES'), source.indexOf('interface Item'));
  const ctx = vm.createContext({ configured: undefined });
  vm.runInContext(constants + "const vscode = {workspace:{getConfiguration: () => ({get: (key, fallback) => configured === undefined ? fallback : configured})}};" + method, ctx);
  for (const [input, expected] of [[undefined, 1048576], [NaN, 1048576], [Infinity, 1048576], [-1, 65536], [0, 65536], [1e20, 67108864], [70000.9, 70000]]) {
    ctx.configured = input;
    assert.equal(vm.runInContext('maxBytes()', ctx), expected);
  }
});

// 回归 UTF-8 计量与超长消息；成功条件是多字节文本截断后仍不超过配置字节数。
test('Logcat buffer measures UTF-8 and truncates oversized messages', () => {
  const text = '日志'.repeat(100);
  const clipped = LogcatBuffer.truncateUtf8(text, 17);
  assert.ok(LogcatBuffer.utf8Bytes(clipped) <= 17);
  assert.equal(LogcatBuffer.truncateUtf8('abc', 3), 'abc');
});

// 回归循环淘汰；输入按时间顺序排列，成功条件是旧项淘汰、最新项保留且总量受限。
test('Logcat buffer evicts oldest entries at the byte limit', () => {
  const items = [{ id: 1, size: 4 }, { id: 2, size: 4 }, { id: 3, size: 4 }];
  const total = LogcatBuffer.trimOldest(items, 8, (item) => item.size);
  assert.deepEqual(items.map((item) => item.id), [2, 3]);
  assert.equal(total, 8);
});

// 执行生产 ingest/trimEntries/trimPending；输入批量、多行和超长消息，断言实际保留的最新内容。
test('actual ingestion and paused queues remain bounded', () => {
  const start = main.indexOf('  const itemBytes =');
  const end = main.indexOf('  function recompile()', start);
  const ctx = vm.createContext({ LogcatBuffer, LogFilter: require('../media/logcat/filter.js') });
  vm.runInContext("let entries = [], rows = [], maxBytes = 12, entriesBytes = 0, pending = [], pendingBytes = 0, pkgMap = {}; const S = {}; const compiled = {test: () => true};\n" + main.slice(start, end), ctx);
  vm.runInContext("ingest([{msg:'aaaa', ts:'1', pid:1, tid:1, lv:'I', tag:'t'}, {msg:'bbbb', ts:'2', pid:1, tid:1, lv:'I', tag:'t'}, {msg:'cccc', ts:'3', pid:1, tid:1, lv:'I', tag:'t'}])", ctx);
  assert.equal(vm.runInContext('entriesBytes', ctx), 10);
  assert.equal(vm.runInContext("entries.map(e => e.lines.join('')).join(',')", ctx), 'bbbb,cccc');
  vm.runInContext("entries=[]; rows=[]; entriesBytes=0; ingest(Array.from({length:20}, () => ({msg:'abc', ts:'1', pid:1, tid:1, lv:'I', tag:'t'})))", ctx);
  assert.equal(vm.runInContext('entriesBytes', ctx), 12);
  assert.equal(vm.runInContext('entries[0].lines.length', ctx), 3);
  assert.equal(vm.runInContext('rows.length', ctx), 3);
  vm.runInContext("pending = [{msg:'aaaa'}, {msg:'bbbb'}, {msg:'cccc'}]; trimPending()", ctx);
  assert.equal(vm.runInContext('pendingBytes', ctx), 10);
  assert.equal(vm.runInContext("pending.map(i => i.msg).join(',')", ctx), 'bbbb,cccc');
  vm.runInContext("ingest([{msg:'x'.repeat(100), ts:'9', pid:2, tid:2, lv:'E', tag:'t'}])", ctx);
  assert.equal(vm.runInContext('entriesBytes', ctx), 12);
  assert.equal(vm.runInContext('entries[0].lines[0].length', ctx), 11);
});

// 回归暂停队列接入；正常和暂停路径必须引用同一上限与淘汰函数，避免暂停时无限增长。
test('Logcat applies the byte cap to normal and paused ingestion paths', () => {
  assert.match(main, /if \(entriesBytes > maxBytes\) \{ trimEntries\(\); \}/);
  assert.match(main, /pendingBytes \+= batch\.reduce/);
  assert.match(main, /pendingBytes = LogcatBuffer\.trimOldest\(pending, maxBytes, itemBytes\)/);
  assert.match(main, /entriesBytes = 0; pendingBytes = 0/);
});
