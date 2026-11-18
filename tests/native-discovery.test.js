const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { transformSync } = require('esbuild');

/** 加载真实Android导出，仅替换Appium/工具链边界；不模拟待验证设备元数据函数。npm test发现本文件。 */
function fixture() {
  const f = { output: '', calls: [], creates: [], properties: {}, propertyReads: [] };
  class ADB {
    constructor(options) { f.creates.push(options); }
    async adbExec() { return ''; }
    async getDeviceProperty(name) { f.propertyReads.push(name); if (f.failure) throw f.failure; return f.properties[name] || ''; }
    clone() { return this; }
    setDevice(device) { this.device = device; }
    async shell(args) { f.calls.push({ args, device: this.device }); if (f.failure) throw f.failure; return f.output; }
  }
  const module = { exports: {} };
  const source = fs.readFileSync(path.join(__dirname, '../src/android-debugger/native-debugger/upstream/src/android.ts'), 'utf8');
  vm.runInNewContext(transformSync(source, { loader: 'ts', format: 'cjs' }).code, { module, exports: module.exports, process, Buffer, console, setTimeout, clearTimeout, require(id) {
    if (id === 'appium-adb') return { ADB };
    if (id === '../../nativeToolchain') return { resolveNativeToolchain: root => ({ adb: 'adb-' + root, sdkRoot: 'sdk-' + root, ndkRoot: 'ndk-' + root }) };
    if (id === './logger') return { logger: { log() {} } };
    if (['./androidPaths', './utils', './jdwp', 'ini', 'teen_process'].includes(id)) return {};
    return require(id);
  } });
  return { ...f, state: f, api: module.exports, device: { udid: 'phone', state: 'device', androidProjectRoot: 'project-root' } };
}

test('device ABI properties use standard list then legacy fields and preserve missing versus query failure', async () => {
  const f = fixture(); f.state.properties = { 'ro.product.cpu.abilist': ' arm64-v8a,armeabi-v7a,arm64-v8a ', 'ro.product.cpu.abi': 'x86' };
  assert.deepEqual(Array.from(await f.api.getDeviceAbiList(f.device)), ['arm64-v8a', 'armeabi-v7a']); assert.deepEqual(f.state.propertyReads, ['ro.product.cpu.abilist']);
  f.state.properties = { 'ro.product.cpu.abi': 'armeabi-v7a', 'ro.product.cpu.abi2': 'armeabi' };
  assert.deepEqual(Array.from(await f.api.getDeviceAbiList(f.device)), ['armeabi-v7a', 'armeabi']);
  f.state.properties = {}; assert.deepEqual(Array.from(await f.api.getDeviceAbiList(f.device)), []);
  f.state.failure = new Error('device offline'); await assert.rejects(f.api.getDeviceAbiList(f.device), error => error === f.state.failure);
});

test('installed Native ABI selects exact package primary ABI rather than phone bitness or another package', async () => {
  const f = fixture(); f.state.output = 'Packages:\n  Package [com.other] (111):\n    primaryCpuAbi=arm64-v8a\n  Package [com.example.app] (222):\n    primaryCpuAbi=armeabi-v7a secondaryCpuAbi=null\n  Package [com.last] (333):\n    primaryCpuAbi=x86_64\n';
  assert.equal(await f.api.getInstalledAppAbi(f.device, 'com.example.app'), 'armeabi-v7a');
  assert.deepEqual(Array.from(f.state.calls[0].args), ['dumpsys', 'package', 'com.example.app']); assert.equal(f.state.calls[0].device.androidProjectRoot, 'project-root'); assert.equal(f.state.creates[0].sdkRoot, 'sdk-project-root');
});

test('installed Native ABI distinguishes normal missing metadata from invalid ABI and query errors', async () => {
  const f = fixture();
  for (const output of ['', 'Packages:\n  Package [com.other] (111):\n    primaryCpuAbi=arm64-v8a', 'Package [com.example.app] (222):\n primaryCpuAbi=null', 'Package [com.example.app] (222):\n no primary ABI']) { f.state.output = output; assert.equal(await f.api.getInstalledAppAbi(f.device, 'com.example.app'), undefined); }
  f.state.output = 'Package [com.example.app] (222):\n primaryCpuAbi=mips'; await assert.rejects(f.api.getInstalledAppAbi(f.device, 'com.example.app'), /Unknown installed Android ABI/);
  await assert.rejects(f.api.getInstalledAppAbi(f.device, 'bad; command'), /Invalid Android package/);
  f.state.failure = new Error('device offline'); await assert.rejects(f.api.getInstalledAppAbi(f.device, 'com.example.app'), error => error === f.state.failure);
});

test('installed Native package candidates use device argv and distinguish empty list invalid output and errors', async () => {
  const f = fixture(); f.state.output = 'package:com.example.app\r\npackage:com.other\r\npackage:com.example.app\r\n';
  assert.deepEqual(Array.from(await f.api.getInstalledPackages(f.device)), ['com.example.app', 'com.other']); assert.deepEqual(Array.from(f.state.calls[0].args), ['pm', 'list', 'packages', '-3']);
  f.state.output = ''; assert.deepEqual(Array.from(await f.api.getInstalledPackages(f.device)), []);
  f.state.output = 'package:../invalid'; await assert.rejects(f.api.getInstalledPackages(f.device), /Invalid Android installed package metadata/);
  f.state.failure = new Error('transport closed'); await assert.rejects(f.api.getInstalledPackages(f.device), error => error === f.state.failure);
});
