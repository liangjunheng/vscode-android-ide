const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { transformSync } = require('esbuild');

function fixture() {
  const calls = [], module = { exports: {} }, proc = new EventEmitter();
  proc.exitCode = null;
  proc.kill = () => { proc.exitCode = 0; proc.emit('exit', 0, null); };
  const deps = { './runtimeContext': {}, './sdk': { adb: async () => {}, adbPath: () => 'adb', freePort: async () => 1234, sdkRoot: () => 'sdk', runBuffer: async () => Buffer.alloc(0) }, child_process: { spawn: (command, args, options) => { calls.push({ command, args, options }); queueMicrotask(() => proc.emit('spawn')); return proc; } } };
  vm.runInNewContext(transformSync(fs.readFileSync(path.join(__dirname, '../src/scrcpy.ts'), 'utf8'), { loader: 'ts', format: 'cjs' }).code, { module, exports: module.exports, require: id => deps[id] || require(id), process, AbortController, Buffer, console, setTimeout, clearTimeout });
  const events = [];
  const session = new module.exports.NativeScrcpySession('phone', { onClose: reason => events.push(reason) }, 'scrcpy.exe');
  return { session, calls, proc, events };
}

test('native scrcpy starts an independent process with the selected device', async () => {
  const f = fixture();
  await f.session.start();
  assert.equal(f.session.connected, true);
  assert.deepEqual(Array.from(f.calls[0].args.slice(0, 2)), ['-s', 'phone']);
  assert.equal(f.calls[0].command, 'scrcpy.exe');
  assert.equal(f.calls[0].options.detached, true);
  f.session.stop();
  assert.equal(f.session.connected, false);
});

test('native scrcpy process exit releases the session without touching VS Code frames', async () => {
  const f = fixture();
  await f.session.start();
  f.proc.emit('exit', 1, null);
  assert.equal(f.session.connected, false);
  assert.deepEqual(f.events, ['scrcpy exited (1)']);
});
