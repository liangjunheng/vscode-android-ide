const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

// 只读当前仓库的真实文件并保留缺失错误；输入相对路径，输出UTF-8内容，以下移除回归共用。
function read(relative) {
  return fs.readFileSync(path.join(root, relative), 'utf8');
}

// 用户移除Profiler后不得再次声明命令或专用直接依赖；npm test发现执行，结构缺失不能当作空列表通过。
test('removed Profiler has no manifest command or dedicated direct dependencies', () => {
  const manifest = JSON.parse(read('package.json'));
  assert.ok(Array.isArray(manifest.contributes.commands));
  assert.ok(manifest.contributes.commands.length > 0);
  assert.equal(manifest.contributes.commands.some(command => /profiler/i.test(command.command)), false);
  assert.ok(manifest.dependencies && typeof manifest.dependencies === 'object');
  for (const name of ['csv-parse', 'protobufjs']) {
    assert.equal(Object.hasOwn(manifest.dependencies, name), false, name + ' remains a direct dependency');
  }
});

// 核对宿主导入/路由与界面绑定均无旧入口，仍保留Logcat；node --test tests/removed-features.test.js可在纯Git基线运行。
test('removed Profiler has no extension or Device Tools entry wiring', () => {
  for (const relative of ['src/extension.ts', 'src/runningDevices.ts', 'media/build-panel.js']) {
    const source = read(relative);
    assert.doesNotMatch(source, /android-profiler|openProfiler|build-profiler/i, relative);
    assert.doesNotMatch(source, /case\s+['"]profiler['"]|type\s*:\s*['"]profiler['"]/i, relative);
  }
  assert.match(read('src/extension.ts'), /showLogcat/);
  assert.match(read('media/build-panel.js'), /build-logcat/);
});

// 专用源/资源/测试/旧文档必须缺失；不检查或删除用户采集和历史.test-artifacts数据，文件系统错误直接失败。
test('removed Profiler source resources and dedicated tests stay absent', () => {
  for (const relative of ['src/android-profiler', 'media/android-profiler', 'docs/PROFILER-VALIDATION.md']) {
    assert.throws(() => fs.lstatSync(path.join(root, relative)), error => error.code === 'ENOENT', relative + ' must be absent');
  }
  const dedicated = fs.readdirSync(path.join(root, 'tests')).filter(name => /^profiler(?:[.-]).*\.test\.js$|^profiler\.test\.js$/i.test(name));
  assert.deepEqual(dedicated, []);
});

// 工具栏保留统一运行/调试控件并以Logcat结尾；真实模板和CSS五工具槽同时验证，边界缺失严格失败。
test('Device Tools retains combined run debug action and Show Logcat', () => {
  const source = read('src/runningDevices.ts');
  const start = source.indexOf('<div class="build-actions">');
  const end = source.indexOf('<div class="build-status"', start);
  assert.ok(start >= 0 && end > start, 'build action template boundaries must exist');
  const ids = [...source.slice(start, end).matchAll(/<button id="([^"]+)"/g)].map(match => match[1]);
  assert.deepEqual(ids, ['build-run', 'build-build', 'build-install', 'build-refresh', 'build-output', 'build-logcat']);
  assert.match(source.slice(start, end), /id="build-run-mode"/);
  assert.match(read('media/build-panel.css'), /grid-template-columns:minmax\(80px,1fr\) repeat\(5,minmax\(16px,26px\)\)/);
});
