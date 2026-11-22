/** 功能点：当前 JVM DAP stdio 传输；受影响对象：AndroidJvmAdapter；复现路径：真实Node管道替换后端；测试范围：分片、多帧、反向请求、错误、关闭；执行入口：npm test；预期结果：保留后端消息且先停引擎后释放；判据：字节、请求与事件精确一致。 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { transformSync } = require('esbuild');

/** 功能：加载真实适配器并绑定可控进程；输入无；输出适配器和消息管道；验证：本文件传输回归。 */
function fixture() {
  class Emitter {
    listeners = new Set();
    event = listener => { this.listeners.add(listener); return { dispose: () => this.listeners.delete(listener) }; };
    fire(value) { for (const listener of this.listeners) listener(value); }
    dispose() { this.listeners.clear(); }
  }
  const module = { exports: {} };
  vm.runInNewContext(transformSync(fs.readFileSync('src/android-debugger/jvm-debugger/adapter.ts', 'utf8'), { loader: 'ts', format: 'cjs' }).code, { module, exports: module.exports, require: id => id === 'vscode' ? { EventEmitter: Emitter } : id === './java' || id === '../coordinator/androidCoordinator' ? {} : id === '../autoConfig' ? require('./auto-config-loader.cjs')() : require(id), Buffer, AbortController, AggregateError });
  const child = new EventEmitter(), messages = [], errors = [], order = [];
  Object.assign(child, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill() { order.push('kill'); this.emit('close', 0); } });
  const adapter = new module.exports.AndroidJvmAdapter(child, {}, error => errors.push(error));
  adapter.onDidSendMessage(message => messages.push(message));
  return { adapter, child, messages, errors, order };
}

/** 功能：编码独立预期帧；输入DAP对象；输出UTF8字节；验证：分片与多帧回归。 */
function frame(message) { const body = Buffer.from(JSON.stringify(message)); return Buffer.concat([Buffer.from('Content-Length: ' + body.length + '\r\n\r\n'), body]); }

test('JVM DAP transport preserves fragmented UTF8 coalesced events reverse requests and backend errors', async () => {
  const f = fixture();
  const values = [{ type: 'event', seq: 1, event: 'output', body: { output: '中文' } }, { type: 'request', seq: 2, command: 'runInTerminal', arguments: { args: ['a b'] } }, { type: 'response', seq: 3, command: 'evaluate', request_seq: 9, success: false, message: 'backend denied', body: { error: { id: 42 } } }];
  const bytes = frame(values[0]); for (const byte of bytes.subarray(0, -1)) f.child.stdout.write(Buffer.from([byte])); assert.equal(f.messages.length, 0);
  f.child.stdout.write(Buffer.concat([bytes.subarray(-1), frame(values[1]), frame(values[2])]));
  assert.deepEqual(JSON.parse(JSON.stringify(f.messages)), values);
  const reply = { type: 'response', seq: 4, request_seq: 2, command: 'runInTerminal', success: true };
  f.adapter.handleMessage(reply); assert.deepEqual(f.child.stdin.read(), frame(reply));
  await f.adapter.close(); assert.deepEqual(f.order, ['kill']);
});

test('malformed transport closes only its owned process and reports actual parse error', async () => {
  const f = fixture(), other = fixture();
  f.child.stdout.write(Buffer.from('Invalid: 2\r\n\r\n{}')); await f.adapter.close();
  assert.match(String(f.errors[0]), /Content-Length/); assert.deepEqual(f.order, ['kill']); assert.deepEqual(other.order, []);
  await other.adapter.close();
});
