/** 功能点：NDK原生server解析；受影响对象：findLldbServer；复现路径：真实临时NDK目录；测试范围：当前ABI、缺失、非法ABI；执行入口：npm test；预期结果：只定位所选NDK的server；判据：准确路径或明确失败，不使用停用后端。 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { transformSync } = require('esbuild');

test('Native server resolves exact NDK ABI without a bundled custom DAP backend', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coordinator-ndk-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const module = { exports: {} }, deps = { '../../sdk': {}, '../../projectLocalConfig': {}, '../../runtimeContext': {} };
  vm.runInNewContext(transformSync(fs.readFileSync('src/android-debugger/native-debugger/nativeToolchain.ts', 'utf8'), { loader: 'ts', format: 'cjs' }).code, { module, exports: module.exports, require: id => deps[id] ?? require(id), process });
  const host = process.platform === 'win32' ? 'windows-x86_64' : process.platform === 'darwin' ? 'darwin-x86_64' : 'linux-x86_64';
  const llvm = path.join(root, 'toolchains', 'llvm', 'prebuilt', host); fs.mkdirSync(llvm, { recursive: true }); fs.writeFileSync(path.join(llvm, 'AndroidVersion.txt'), '18.0.0');
  const server = path.join(llvm, 'lib', 'clang', '18.0.0', 'lib', 'linux', 'aarch64', 'lldb-server'); fs.mkdirSync(path.dirname(server), { recursive: true }); fs.writeFileSync(server, 'fixture');
  assert.equal(module.exports.findLldbServer(root, 'arm64-v8a'), server);
  assert.throws(() => module.exports.findLldbServer(root, 'x86'), /Could not locate/);
  assert.throws(() => module.exports.findLldbServer(root, '../escape'), /ABI/);
});
