const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { transformSync } = require('esbuild');

/** 功能点：隔离夹具内共享真实启动取消及连接登记。
 * 受影响对象：startup.ts、index.ts、调试提供方及直接加载它们的 VM 夹具。
 * 复现路径：每个夹具加载一次，共享导出；登记启动后显式 reportDebugConnection，再通过门闩结算连接。
 * 测试范围：真实 registry、取消信号、连接成功/失败/等待及注销，不替换启动或连接实现。
 * 执行入口：由相关 tests/*.test.js 夹具调用本加载函数。
 * 预期结果：同一夹具共享真实登记，不同夹具隔离；start 事件不等于 connected。
 * 判据：连接结算、取消信号身份、重叠启动拒绝与清理断言一致；不得加载 noop 或已删除模块。
 */
// 功能：加载真实 startup.ts；输入无；输出夹具专属的取消和连接 API，供相关测试显式控制连接 Promise。
module.exports = function loadDebugStartup() {
  const module = { exports: {} };
  const source = fs.readFileSync(path.join(__dirname, '../src/android-debugger/startup.ts'), 'utf8');
  vm.runInNewContext(transformSync(source, { loader: 'ts', format: 'cjs' }).code,
    { module, exports: module.exports, AbortController, console });
  return module.exports;
};
