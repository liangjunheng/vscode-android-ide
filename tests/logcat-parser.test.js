const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { transformSync } = require('esbuild');

const source = fs.readFileSync(path.join(__dirname, '../src/logcatParser.ts'), 'utf8');
// 无硬件转译真实 parser，输出类供 node:test 注入字节，确保不复制业务解析实现。
function load() {
  const module = { exports: {} };
  vm.runInNewContext(transformSync(source, { loader: 'ts', format: 'cjs' }).code, { module, exports: module.exports, Buffer, Set, String, Math });
  return module.exports.BinaryLogcatParser;
}
// 输入版本与日志字段，输出精确 logger_entry 字节帧；长度由 UTF8 Buffer 计算，供拆包/粘包和坏帧测试。
function frame({ version = 1, pid = 7, tid = 8, sec = 0, nsec = 123000000, priority = 4, tag = 'Tag', message = 'msg' }) {
  const body = Buffer.concat([Buffer.from([priority]), Buffer.from(tag), Buffer.from([0]), Buffer.from(message), Buffer.from([0])]);
  const hdrSize = version === 1 ? 20 : version === 2 || version === 3 ? 24 : 28;
  const out = Buffer.alloc(hdrSize + body.length);
  out.writeUInt16LE(body.length, 0); out.writeUInt16LE(version === 1 ? 0 : hdrSize, 2);
  out.writeInt32LE(pid, 4); out.writeInt32LE(tid, 8); out.writeInt32LE(sec, 12); out.writeInt32LE(nsec, 16);
  body.copy(out, hdrSize); return out;
}
// 输入字节和分片方案，输出真实 parser 回调记录与诊断；EOF 必须显式通知并严格断言。
function parse(bytes, chunks = [bytes]) {
  const records = [], statuses = [], Parser = load();
  const parser = new Parser(r => records.push(r), s => statuses.push(s));
  for (const chunk of chunks) parser.push(chunk); parser.end();
  return { records, statuses };
}

test('binary parser preserves records, embedded headers, multiline and trailing newlines', () => {
  const records = [frame({ message: 'row0\n\nrow2\n' }), frame({ pid: 7, tid: 8, nsec: 123400000, message: 'row3' })];
  const result = parse(Buffer.concat(records));
  assert.equal(result.statuses.length, 0); assert.equal(result.records.length, 2);
  assert.equal(result.records[0].message, 'row0\n\nrow2\n');
  assert.equal(result.records[1].message, 'row3');
});

test('binary parser handles v1/v2/v3/v4 headers and identical fields independently', () => {
  for (const version of [1, 2, 3, 4]) {
    const a = frame({ version, message: 'same' }), b = frame({ version, message: 'same' });
    const result = parse(Buffer.concat([a, b]), [...Buffer.concat([a, b])].map(n => Buffer.from([n])));
    assert.equal(result.statuses.length, 0); assert.deepEqual(result.records.map(r => r.message), ['same', 'same']);
  }
});

test('binary parser retains UTF-8 split at every byte and batch boundaries', () => {
  const bytes = Buffer.concat([frame({ tag: '标签', message: '日志\n空行\n' }), frame({ message: '' })]);
  const result = parse(bytes, [...bytes].map(n => Buffer.from([n])));
  assert.deepEqual(result.records.map(r => [r.tag, r.message]), [['标签', '日志\n空行\n'], ['Tag', '']]);
});

// 输入越界 priority/nsec/头版本与非文本 v4 buffer，必须报告一次错误，不伪造条目或吞掉前面已完成条目。
test('binary parser rejects invalid headers priorities timestamps and non-text buffers', () => {
  for (const priority of [0,1,8,255]) assert.match(parse(frame({priority})).statuses[0],/priority/);
  for (const nsec of [-1,1000000000]) assert.match(parse(frame({nsec})).statuses[0],/nanoseconds/);
  for (const size of [1,19,21,23,25,29,65535]) {
    const bytes=frame({}); bytes.writeUInt16LE(size,2); assert.match(parse(bytes).statuses[0],/header size/);
  }
  for (const lid of [2,5,6]) {
    const bytes=frame({version:4}); bytes.writeUInt32LE(lid,20); assert.match(parse(bytes).statuses[0],/unsupported text buffer/);
  }
  for (const lid of [0,3,4]) {
    const bytes=frame({version:4}); bytes.writeUInt32LE(lid,20); assert.equal(parse(bytes).records.length,1);
  }
});

test('binary parser reports malformed frame and truncated EOF explicitly', () => {
  let result = parse(Buffer.from([3, 0, 20, 0]));
  assert.equal(result.records.length, 0); assert.match(result.statuses[0], /truncated/);
  const malformed = Buffer.alloc(24); malformed.writeUInt16LE(4, 0); malformed.writeUInt16LE(20, 2); [4, 65, 66, 0].forEach((value, index) => { malformed[20 + index] = value; });
  result = parse(malformed); assert.equal(result.records.length, 0); assert.match(result.statuses[0], /NUL-terminated message/);
});
