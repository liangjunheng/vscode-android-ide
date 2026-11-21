const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { transformSync } = require('esbuild');
const loaded = { exports: {} };
vm.runInNewContext(transformSync(fs.readFileSync(path.join(__dirname, '../src/android-debugger/autoConfig.ts'), 'utf8'), { loader: 'ts', format: 'cjs' }).code,
  { module: loaded, exports: loaded.exports });
const { omitAuto } = loaded.exports;

test('auto configuration values are removed before dynamic resolution', () => {
  const input = { apkPath: 'auto', packageName: 'auto', launchActivity: 'auto', target: 'auto', serial: 'auto',
    native: { abi: 'auto', sdkRoot: 'auto', symbolSearchPaths: [] }, java: { sourcePaths: 'auto', port: 'auto' }, custom: 'keep' };
  const result = omitAuto(input);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), { native: { symbolSearchPaths: [] }, java: { port: 'auto' }, custom: 'keep' });
  assert.equal(input.packageName, 'auto');
});

test('invalid dynamic forward output asks the user to retry without deleting shared mappings', async () => {
  const source = transformSync(fs.readFileSync(path.join(__dirname, '../src/android-debugger/jdwpForward.ts'), 'utf8'), { loader: 'ts', format: 'cjs' }).code;
  const module = { exports: {} }, calls = [];
  vm.runInNewContext(source, { module, exports: module.exports, require: id => {
    assert.equal(id, './native-debugger/nativeTarget');
    return { adbExec: async (_adb, _serial, args) => { calls.push(Array.from(args)); return 'unexpected output'; } };
  } });
  await assert.rejects(module.exports.createJdwpForward('adb', 'serial', 42, 0), /Stop debugging and retry/);
  assert.deepEqual(calls, [['forward', 'tcp:0', 'jdwp:42']]);
});
