const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { transformSync } = require('esbuild');

// 加载真实RuntimeContext并保留调用方的文件系统/环境替身；每个隔离fixture拥有独立上下文。
// 回归：npm test执行SDK、设备选择、配置、scrcpy生命周期及runtime-context测试。
module.exports = function loadRuntimeContext(dependencies = {}, environment = process) {
  const module = { exports: {} };
  const source = fs.readFileSync(path.join(__dirname, '../src/runtimeContext.ts'), 'utf8');
  vm.runInNewContext(transformSync(source, { loader: 'ts', format: 'cjs' }).code, {
    module, exports: module.exports, process: environment,
    require: id => Object.hasOwn(dependencies, id) ? dependencies[id] : Object.hasOwn(dependencies, id.replace('node:', '')) ? dependencies[id.replace('node:', '')] : require(id),
  });
  return module.exports;
};
