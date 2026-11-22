const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { readJarLegalFiles, readPublishedLegalFile, collectCoordinatorLegalFiles } = require('../scripts/build-jvm-debugger.cjs');

/**
 * 功能点：coordinator 实际 runtime JAR 的许可原文收集，不启动 Maven、Java 或设备。
 * 受影响对象：readJarLegalFiles/readPublishedLegalFile/collectCoordinatorLegalFiles 及独立 LICENSE/NOTICE。
 * 复现路径：Node>=22，通过内存构造真实小 ZIP，写入隔离临时目录，HTTP 仅替换请求边界。
 * 测试范围：根及嵌套许可、同名依赖、传递依赖、空集合、空白许可、重复条目、损坏 ZIP、来源摘要及失败传播。
 * 执行入口：node --test tests/coordinator-license.test.js；也由 npm test 发现。
 * 预期结果：原始字节全部保留且来源可追溯，未知无许可依赖阻断。
 * 判据：全部断言通过；不允许以静态正则代替真实 ZIP 解析，不访问网络。
 */

/** 功能：计算 ZIP32 标准 CRC；输入文件字节，输出无符号 CRC，用于真实最小归档。验证：本文件全部解析用例。 */
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** 功能：生成真实 stored ZIP，允许重复路径边界；输入条目列表，输出完整 ZIP 字节。验证：真实 unzipper 解析。 */
function zip(entries) {
  const locals = [], central = [];
  let offset = 0;
  for (const [name, content] of entries) {
    const filename = Buffer.from(name), bytes = Buffer.from(content), crc = crc32(bytes);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(bytes.length, 18);
    local.writeUInt32LE(bytes.length, 22);
    local.writeUInt16LE(filename.length, 26);
    locals.push(local, filename, bytes);
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt16LE(20, 4);
    record.writeUInt16LE(20, 6);
    record.writeUInt32LE(crc, 16);
    record.writeUInt32LE(bytes.length, 20);
    record.writeUInt32LE(bytes.length, 24);
    record.writeUInt16LE(filename.length, 28);
    record.writeUInt32LE(offset, 42);
    central.push(record, filename);
    offset += local.length + filename.length + bytes.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

/** 功能：创建可清理的 Maven 仓库布局夹具；输入测试上下文，输出根目录及 JAR 写入函数。验证：本文件集合用例。 */
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'coordinator-legal-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return {
    directory,
    jar(artifact, entries) {
      const file = path.join(directory, ...artifact.split('/'));
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, zip(entries));
      return file;
    },
  };
}

/** 功能：创建明确的发布来源及可观察请求边界；输入原文，输出来源和请求函数。验证：本文件来源异常用例。 */
function published(bytes = Buffer.from('原始发布许可\r\n')) {
  const source = { path: 'LICENSE.txt', url: 'https://example.invalid/release/LICENSE.txt', sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
  return { source, request: async url => { assert.equal(url, source.url); return { ok: true, arrayBuffer: async () => bytes }; } };
}

test('真实 JAR 保留根及嵌套 LICENSE NOTICE COPYRIGHT 原字节且不误收 class', async t => {
  const f = fixture(t);
  const original = Buffer.from('\ufeff独立许可\r\n保留结尾  \r\n');
  const jar = f.jar('root.jar', [['LICENSE', original], ['META-INF/LICENSE-other.txt', '另一许可'], ['META-INF/NOTICE.txt', '通知\r\n'], ['legal/COPYRIGHT', '版权'], ['License.class', '字节码'], ['NOTICE.class', '字节码'], ['NotLicense.txt', '非许可']]);
  const records = await readJarLegalFiles(jar);
  assert.deepEqual(records.map(record => record.path), ['legal/COPYRIGHT', 'LICENSE', 'META-INF/LICENSE-other.txt', 'META-INF/NOTICE.txt'].sort((a, b) => a.localeCompare(b, 'en')));
  assert.deepEqual(records.find(record => record.path === 'LICENSE').bytes, original);
  assert.equal(records.filter(record => record.kind === 'license').length, 2);
  assert.equal(records.filter(record => record.kind === 'notice').length, 2);
});

test('真实 runtime 仓库布局遍历全部传递 JAR，同名资源不覆盖且输出顺序稳定', async t => {
  const f = fixture(t);
  const first = 'a/direct/1/direct-1.jar', second = 'z/transitive/2/transitive-2.jar';
  f.jar(second, [['LICENSE', '传递许可\r\n'], ['META-INF/NOTICE', '传递通知\r\n']]);
  f.jar(first, [['LICENSE', '直接许可\r\n'], ['META-INF/NOTICE', '直接通知\r\n']]);
  const legal = await collectCoordinatorLegalFiles(f.directory, []);
  for (const artifact of [first, second]) {
    assert.ok(legal.license.includes(Buffer.from(artifact)));
    assert.ok(legal.notice.includes(Buffer.from(artifact)));
  }
  for (const bytes of ['直接许可\r\n', '传递许可\r\n']) assert.ok(legal.license.includes(Buffer.from(bytes)));
  for (const bytes of ['直接通知\r\n', '传递通知\r\n']) assert.ok(legal.notice.includes(Buffer.from(bytes)));
  assert.ok(legal.license.indexOf(first) < legal.license.indexOf(second));
  assert.deepEqual(await collectCoordinatorLegalFiles(f.directory, []), legal);
});

test('空依赖集合和未知无许可传递 JAR 直接阻断，不按已知依赖名筛选', async t => {
  const f = fixture(t);
  await assert.rejects(collectCoordinatorLegalFiles(f.directory, []), /dependency set is empty/);
  f.jar('unknown/transitive/1/transitive-1.jar', [['META-INF/NOTICE', '仅有通知']]);
  await assert.rejects(collectCoordinatorLegalFiles(f.directory, []), /no verified LICENSE: unknown\/transitive/);
});

test('Maven installer 元数据不当作 runtime JAR，其他未知文件仍阻断', async t => {
  const f = fixture(t);
  f.jar('org/example/1/example-1.jar', [['LICENSE', '原始许可']]);
  fs.writeFileSync(path.join(f.directory, 'org/example/1/_remote.repositories'), '仓库追踪');
  fs.writeFileSync(path.join(f.directory, 'org/example/maven-metadata-local.xml'), '<metadata/>');
  const legal = await collectCoordinatorLegalFiles(f.directory, []);
  assert.ok(legal.license.includes(Buffer.from('org/example/1/example-1.jar')));
  assert.equal(legal.license.includes(Buffer.from('_remote.repositories')), false);
  fs.writeFileSync(path.join(f.directory, 'unknown.bin'), '未知文件');
  await assert.rejects(collectCoordinatorLegalFiles(f.directory, []), /Unexpected runtime dependency entry/);
});

test('空白或重复许可及损坏 ZIP 不被吞掉', async t => {
  const f = fixture(t);
  await assert.rejects(readJarLegalFiles(f.jar('empty.jar', [['LICENSE', '\r\n  ']])), /Empty legal entry/);
  await assert.rejects(readJarLegalFiles(f.jar('duplicate.jar', [['LICENSE', '第一份'], ['LICENSE', '第二份']])), /Duplicate legal entry/);
  const broken = path.join(f.directory, 'broken.jar');
  fs.writeFileSync(broken, '不是ZIP');
  await assert.rejects(readJarLegalFiles(broken));
});

test('缺失归档许可只能使用登记的官方来源，原有 NOTICE 不被替换', async t => {
  const f = fixture(t), p = published();
  const artifact = 'org/example/library/1/library-1.jar';
  f.jar(artifact, [['META-INF/NOTICE', '归档原始通知\r\n']]);
  const sources = [{ artifacts: [artifact], pom: 'https://example.invalid/release/library.pom', files: [p.source] }];
  const legal = await collectCoordinatorLegalFiles(f.directory, sources, p.request);
  assert.ok(legal.license.includes(Buffer.from('原始发布许可\r\n')));
  assert.ok(legal.license.includes(Buffer.from(sources[0].pom)));
  assert.ok(legal.license.includes(Buffer.from(p.source.url)));
  assert.ok(legal.notice.includes(Buffer.from('归档原始通知\r\n')));
  await assert.rejects(collectCoordinatorLegalFiles(f.directory, [{ ...sources[0], artifacts: ['different.jar'] }], p.request), /no verified LICENSE/);
});

test('登记的官方 NOTICE 即使 JAR 自带 LICENSE 也必须保留', async t => {
  const f = fixture(t), p = published(Buffer.from('发布通知\r\n'));
  p.source.path = 'license/NOTICE.txt';
  const artifact = 'org/example/library/1/library-1.jar';
  f.jar(artifact, [['LICENSE', '归档原始许可']]);
  const legal = await collectCoordinatorLegalFiles(f.directory, [{ artifacts: [artifact], files: [p.source] }], p.request);
  assert.ok(legal.notice.includes(Buffer.from('发布通知\r\n')));
  assert.ok(legal.license.includes(Buffer.from('归档原始许可')));
});

test('源码许可注释先校验完整来源摘要，再按登记范围保留原字节', async () => {
  const original = Buffer.from('/* 原始许可\r\n */\nint code;');
  const p = published(original);
  const end = original.indexOf(Buffer.from('*/')) + 2;
  const source = { ...p.source, path: 'src/library.h', kind: 'license', byteRange: [0, end] };
  assert.deepEqual((await readPublishedLegalFile(source, p.request)).bytes, original.subarray(0, end));
  for (const byteRange of [[-1, end], [0, original.length + 1], [end, end], [0.5, end], [0], [0, end, 1]]) {
    await assert.rejects(readPublishedLegalFile({ ...source, byteRange }, p.request), /Invalid legal source byte range/);
  }
  await assert.rejects(readPublishedLegalFile({ ...source, sha256: '0'.repeat(64) }, p.request), /SHA-256 mismatch/);
});

test('发布许可 HTTP、网络、非HTTPS、空正文及摘要不符均阻断', async () => {
  const p = published();
  assert.deepEqual((await readPublishedLegalFile(p.source, p.request)).bytes, Buffer.from('原始发布许可\r\n'));
  await assert.rejects(readPublishedLegalFile(p.source, async () => ({ ok: false, status: 404 })), /HTTP 404/);
  await assert.rejects(readPublishedLegalFile(p.source, async () => { throw new Error('网络中断'); }), /网络中断/);
  await assert.rejects(readPublishedLegalFile({ ...p.source, url: 'http://example.invalid/LICENSE' }, p.request), /HTTPS/);
  const blank = published(Buffer.from('\r\n '));
  await assert.rejects(readPublishedLegalFile(blank.source, blank.request), /Empty legal source/);
  await assert.rejects(readPublishedLegalFile({ ...p.source, sha256: '0'.repeat(64) }, p.request), /SHA-256 mismatch/);
});
