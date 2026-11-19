const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { transformSync } = require('esbuild');

/** 执行真实默认Activity解析，仅替换execFile边界，保留错误和signal契约；npm test自动发现。 */
function fixture() {
  const f = { output: '', calls: [] }; const module = { exports: {} };
  vm.runInNewContext(transformSync(fs.readFileSync(path.join(__dirname, '../src/android-debugger/native-debugger/nativeTarget.ts'), 'utf8'), { loader: 'ts', format: 'cjs' }).code, { module, exports: module.exports, require: id => id === 'node:child_process' ? { execFile(command, args, options, callback) { f.calls.push({ command, args, options }); callback(f.error, f.output, f.stderr || ''); } } : require(id) });
  f.api = module.exports; return f;
}

test('Native default Activity resolves exact selected app component through argv and preserves cancellation signal', async () => {
  const f = fixture(); f.output = 'priority=0\r\ncom.other/Other\r\ncom.example.app/.MainActivity\r\n'; const signal = new AbortController().signal;
  assert.equal(await f.api.resolveLauncherActivity('adb with space', 'serial', 'com.example.app', signal), '.MainActivity');
  assert.equal(f.calls[0].command, 'adb with space'); assert.equal(f.calls[0].options.signal, signal); assert.equal(f.calls[0].options.windowsHide, true); assert.equal(f.calls[0].options.timeout, 30000);
  assert.deepEqual(Array.from(f.calls[0].args), ['-s', 'serial', 'shell', 'cmd', 'package', 'resolve-activity', '--brief', '-a', 'android.intent.action.MAIN', '-c', 'android.intent.category.LAUNCHER', 'com.example.app']);
});

test('Native Activity discovery rejects missing launchers and propagates adb diagnostics with original cause', async () => {
  const f = fixture(); f.output = 'No activity found'; await assert.rejects(f.api.resolveLauncherActivity('adb', 'serial', 'com.example.app'), /Unable to resolve launcher/);
  f.error = new Error('spawn failed'); f.stderr = 'device unauthorized'; await assert.rejects(f.api.resolveLauncherActivity('adb', 'serial', 'com.example.app'), error => error.message === 'device unauthorized' && error.cause === f.error);
});
