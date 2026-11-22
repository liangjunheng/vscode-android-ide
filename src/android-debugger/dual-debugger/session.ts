/** 功能：组合 JVM 和 Native 已有附加能力，失败时取消双方并等待全部结算。
 * 输入：两种能力的启动函数及共享取消操作；二者必须针对同一已解析设备和 PID。
 * 输出：两边均成功，或聚合实际启动失败；不实现设备、端口、DAP 或符号逻辑。
 * 验证：npm test 中 native-codelldb.test.js、android-mixed-adapter.test.js 和 coordinator-device-host.test.js。
 */
export async function attachDual(native: () => Promise<void>, jvm: () => Promise<void>, cancel: (error: unknown) => void): Promise<void> {
  const attach = async (start: () => Promise<void>): Promise<void> => {
    try { await start(); } catch (error) { cancel(error); throw error; }
  };
  const results = await Promise.allSettled([attach(native), attach(jvm)]);
  const errors = results.filter((value): value is PromiseRejectedResult => value.status === 'rejected').map(value => value.reason);
  if (errors.length) throw new AggregateError(errors, 'Android Dual startup failed');
}
