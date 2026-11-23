/**
 * 功能点：真实宿主取消入口的设备边界与测试引擎，不模拟生产控制器。
 * 受影响对象：debugging公开provider、index宿主启动及真实VS Code DAP。
 * 复现路径：仅opt-in runner加载；设备全部内存，测试descriptor用受控DAP响应阻塞宿主启动。
 * 测试范围：provider取消、descriptor迟到、真实start事件取消及termination屏障。
 * 执行入口：ANDROID_DEBUG_CANCEL_HOST_TEST=1 node --test tests/startup-cancel-host.test.js。
 * 预期结果：设备无ADB，真实宿主决定start和termination；此替身不用于真实JAR验收。
 * 判据：目标参数、转发所有权及迟到会话停止由runner严格断言，意外操作失败。
 */
const assert = require('node:assert/strict');
const runtime = { phase: undefined, phases: [], record: undefined };

/** 功能：记录边界事实；输入事件与数据；输出runner证据。 */
function record(event, data = {}) { assert.equal(typeof runtime.record, 'function'); runtime.record(event, data); }
/** 功能：创建显式可释放屏障；输入无；输出Promise和释放函数。 */
function gate() { const value = Promise.withResolvers(); return { promise: value.promise, release: value.resolve }; }
/** 功能：设置独立取消场景；输入场景名称；输出设备、descriptor和退出账本。 */
function configure(name) {
  const phase = { name, clientsGate: gate(), descriptorGate: gate(), exitGate: gate(), clients: [], forwards: 0, releases: 0, descriptors: 0, engines: [], holdClients: name === 'provider-pending', holdDescriptor: name === 'descriptor-pending' };
  if (name !== 'late-session') phase.exitGate.release();
  runtime.phase = phase; runtime.phases.push(phase); return phase;
}

/** 功能：只替换当前设备操作；输入明确设备身份；输出内存事实，不包含协调器或Java进程。 */
class DebugDevice {
  // 功能：保存设备身份；输入串号及项目根；输出设备边界实例。
  constructor(serial, projectRoot) { assert.equal(serial, 'task51-device'); this.serial = serial; this.projectRoot = projectRoot; }
  // 功能：提供在线设备；输入取消信号；输出唯一模拟目标。
  static async devices(signal) { signal.throwIfAborted(); return [{ serial: 'task51-device', state: 'device' }]; }
  // 功能：读取受控客户端；输入取消信号；输出明确PID，取消等待门闩结束后原样抛错。
  async clients(signal) {
    const phase = runtime.phase, call = { pending: true, aborted: false }; phase.clients.push(call);
    const abort = () => { call.aborted = true; record('clients-abort', { phase: phase.name }); };
    signal.addEventListener('abort', abort, { once: true }); record('clients-pending', { phase: phase.name });
    try { if (phase.holdClients) await phase.clientsGate.promise; signal.throwIfAborted(); return [{ pid: 5101, packageName: 'dev.task51.fixture' }]; }
    finally { signal.removeEventListener('abort', abort); call.pending = false; record('clients-settled', { phase: phase.name }); }
  }
  // 功能：创建精确内存转发；输入PID及取消；输出唯一资源及幂等释放。
  async forward(pid, signal) {
    assert.equal(pid, 5101); signal.throwIfAborted(); const phase = runtime.phase; phase.forwards++; let closed = false;
    return { port: 45101,
      // 功能：释放本次转发；输入无；输出一次归属记录。
      async close() { if (!closed) { closed = true; phase.releases++; record('forward-close', { phase: phase.name }); } },
    };
  }
  // 功能：禁止越界Launch；输入无；输出明确失败。
  async launch() { throw new Error('取消宿主仅覆盖Attach，不允许Launch'); }
  // 功能：禁止越界应用停止；输入无；输出明确失败。
  async stop() { throw new Error('取消Attach不允许停止设备应用'); }
  // 功能：禁止越界应用设置清理；输入无；输出明确失败。
  async clearDebugApp() { throw new Error('取消Attach不允许清除设备设置'); }
}

/** 功能：阻断Native设备路径；输入无；输出明确越界错误。 */
async function prepareNativeConnection() { throw new Error('取消宿主不允许Native设备操作'); }
/** 功能：阻断APK设备路径；输入无；输出明确越界错误。 */
async function getPackageNameFromApk() { throw new Error('取消宿主不允许APK解析'); }
module.exports = { runtime, configure, record, DebugDevice, prepareNativeConnection, getPackageNameFromApk };
