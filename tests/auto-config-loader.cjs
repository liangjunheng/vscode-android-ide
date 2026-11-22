const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { transformSync } = require('esbuild');

/** 功能：加载真实配置归一化模块供隔离夹具使用；输入无；输出生产导出；验证：npm test 的 Build、Explorer 和配置回归。 */
module.exports = function loadAutoConfig() {
  const module = { exports: {} };
  vm.runInNewContext(transformSync(fs.readFileSync(path.join(__dirname, '../src/android-debugger/autoConfig.ts'), 'utf8'), { loader: 'ts', format: 'cjs' }).code, { module, exports: module.exports });
  return module.exports;
};
