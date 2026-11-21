// 将模板中的auto哨兵移除为未提供字段；边界解析后由当前设备、APK、Gradle和调试会话继续动态获取。
export function omitAuto<T extends Record<string, any>>(config: T): T {
  const result = { ...config };
  for (const key of ['apkPath', 'packageName', 'launchActivity', 'serial', 'target', 'pid', 'processId', 'androidProjectRoot', 'androidAdbPath', 'androidJdwpPort', 'hostName', 'preLaunchTask']) {
    if (result[key] === 'auto') delete result[key];
  }
  const mutable = result as Record<string, any>;
  if (mutable.native && typeof mutable.native === 'object') {
    mutable.native = { ...mutable.native };
    for (const key of ['abi', 'abiSupported', 'sdkRoot', 'ndkRoot']) if (mutable.native[key] === 'auto') delete mutable.native[key];
  }
  if (mutable.java && typeof mutable.java === 'object') {
    mutable.java = { ...mutable.java };
    for (const key of ['sourcePaths', 'projectRoot', 'hostName', 'preLaunchTask', 'postLaunchTask', 'postDebugTask', 'serverReadyAction']) if (mutable.java[key] === 'auto') delete mutable.java[key];
  }
  return result;
}
