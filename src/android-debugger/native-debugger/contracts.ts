import type * as vscode from 'vscode';
import type { Device } from 'appium-adb';

/** 公开 Android 配置契约；统一入口只解析目标与选项，生命周期由运行控制器独立持有。 */
export interface AndroidNativeDebugConfiguration extends vscode.DebugConfiguration {
  type: 'android-tools' | 'android-debug' | 'android-jvm';
  android?: true;
  androidMode?: 'native' | 'java' | 'dual';
  mode?: 'native' | 'java' | 'dual';
  java?: { type?: 'android-jvm'; name?: string; port?: number; sourcePaths?: string[] | 'auto'; [option: string]: unknown };
  sourcePaths?: string[] | 'auto';
  androidSourceRoots?: string[];
  /** 用户源码项目根可独立于 Android 根；Native 内层 projectRoot 优先，Java 内层根由 Java 引擎解析。 */
  projectRoot?: string;
  /** 设备部署与工具链所属 Android 根，不约束 Java 或 Native 的源码项目根。 */
  androidProjectRoot?: string;
  target?: string | (Device & { androidProjectRoot?: string });
  serial?: string;
  /** 已替换变量后的十进制数字字符串与正安全整数等价，两种别名必须指向同一 PID。 */
  pid?: number | string;
  processId?: number | string;
  packageName?: string;
  launchActivity?: string;
  apkPath?: string;
  native?: Record<string, unknown>;
  resumeProcess?: boolean;
}

/** Native 连接明确拥有 server 与自有转发；配置可交给 CodeLLDB，取消信号不序列化。 */
export interface NativeConnection {
  config: vscode.DebugConfiguration;
  /** 功能：幂等释放自有 server 和转发；输入无；输出聚合清理结果，不终止应用。 */
  close(): Promise<void>;
}
