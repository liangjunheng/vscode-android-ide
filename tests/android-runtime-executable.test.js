/** 功能点：当前运行时路径所有权；受影响对象：resolveBundledPath；复现路径：真实临时资源树；测试范围：缺失、越界、目录、链接与外部权限；执行入口：npm test；预期结果：只接受所属普通文件；判据：路径和错误精确匹配，不恢复已删除helper。 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const load = require('./runtime-context-loader.cjs');

test('runtime executable ownership rejects adjacent paths directory and escaping links', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coordinator-runtime-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const api = load(), host = api.runtimeTarget(), owned = path.join(root, 'resources', 'platform-tools', host);
  fs.mkdirSync(owned, { recursive: true }); const binary = path.join(owned, api.executable('adb')); fs.writeFileSync(binary, 'fixture');
  assert.equal(api.resolveBundledExecutable(root, 'adb'), fs.realpathSync(binary));
  assert.throws(() => api.resolveBundledPath(root, ['platform-tools', '..', '..', 'outside']), /escapes/);
  fs.mkdirSync(path.join(owned, 'directory')); assert.throws(() => api.resolveBundledPath(root, ['platform-tools', 'directory']), /regular file/);
  assert.equal(api.resolveBundledPath(root, ['platform-tools', 'missing']), undefined);
  const outside = path.join(root, 'outside'); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'file'), 'fixture'); fs.symlinkSync(outside, path.join(owned, 'linked'), 'junction');
  assert.throws(() => api.resolveBundledPath(root, ['platform-tools', 'linked', 'file']), /escapes/);
});
