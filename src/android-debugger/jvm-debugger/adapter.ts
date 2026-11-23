/**
 * 功能点：注册直接运行真实 JAR 的 JVM 调试引擎与只读诊断。
 * 受影响对象：registerJvmDebugger、registerJvmDiagnostics、findJava、android-jvm descriptor 与会话日志。
 * 复现路径：主会话完成 Launch/Attach 配置后注册入口，使用有效 JDK、内置 JAR 和所属目录设置创建 descriptor。
 * 测试范围：真实 executable 参数、配置优先级、独立日志、缺失 JAR、非法参数、原始错误及双向只读追踪。
 * 执行入口：registerJvmDebugger；测试入口为 tests/jvm-debugger.test.js，本任务不执行测试。
 * 预期结果：VS Code 直接启动 Java/JAR 处理 DAP，不创建 provider、代理、设备操作或子会话。
 * 判据：唯一 descriptor factory 返回真实 executable，错误不包装，trace 不改变协议消息。
 */
import * as fs from 'fs';
import * as vscode from 'vscode';
import { findJava } from './java';

export const JVM_DEBUG_TYPE = 'android-jvm';

/** 功能：为已准备的会话注册真实 JAR 引擎；输入扩展上下文；输出可释放的 factory 与诊断，覆盖于 jvm-debugger.test.js。 */
export function registerJvmDebugger(context: vscode.ExtensionContext): void {
  registerJvmDiagnostics(context);
  context.subscriptions.push(vscode.debug.registerDebugAdapterDescriptorFactory(JVM_DEBUG_TYPE, {
    /** 功能：校验会话及设置并查找 JDK；输入已准备配置；输出真实 executable，准备错误原样传播。 */
    async createDebugAdapterDescriptor(session) {
      const settings = vscode.workspace.getConfiguration('android-ide.jvmDebugger', session.workspaceFolder?.uri);
      const configuredHome = settings.get<unknown>('javaHome');
      const jvmArgs: unknown = session.configuration.adapterJvmArgs !== undefined
        ? session.configuration.adapterJvmArgs : settings.get<unknown>('adapterJvmArgs', ['-Xmx512m']);
      const logLevel: unknown = session.configuration.logLevel !== undefined
        ? session.configuration.logLevel : settings.get<unknown>('logLevel', 'INFO');
      if (configuredHome !== undefined && typeof configuredHome !== 'string') {
        throw new TypeError('android-ide.jvmDebugger.javaHome 必须是字符串');
      }
      if (!Array.isArray(jvmArgs) || jvmArgs.some(arg => typeof arg !== 'string')) {
        throw new TypeError('adapterJvmArgs 必须是字符串数组');
      }
      if (typeof logLevel !== 'string' || !['ERROR', 'WARN', 'INFO', 'DEBUG', 'TRACE'].includes(logLevel)) {
        throw new TypeError('logLevel 必须是 ERROR、WARN、INFO、DEBUG 或 TRACE');
      }
      const jar = vscode.Uri.joinPath(context.extensionUri, 'resources', 'jvm-debugger', 'kotlin-debug-adapter.jar').fsPath;
      if (!fs.existsSync(jar)) {
        throw new Error('JVM 调试引擎 JAR 不存在：' + jar);
      }
      const runtime = await findJava(configuredHome);
      fs.mkdirSync(context.logUri.fsPath, { recursive: true });
      const logFile = vscode.Uri.joinPath(context.logUri, `jvm-${session.id}.log`).fsPath;
      return new vscode.DebugAdapterExecutable(runtime.java, [...jvmArgs, '-jar', jar, '--log-file', logFile, '--log-level', logLevel]);
    },
  }));
}

/** 功能：为真实 JVM 协议提供可选诊断；输入扩展上下文；输出只读追踪器，不参与 Android 运行生命周期。 */
export function registerJvmDiagnostics(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('Android Kotlin/Java Debugger');
  context.subscriptions.push(output, vscode.debug.registerDebugAdapterTrackerFactory(JVM_DEBUG_TYPE, {
    /** 功能：读取所属目录的追踪开关；输入宿主会话；输出仅记录原始消息、错误和退出的追踪器。 */
    createDebugAdapterTracker(session) {
      const trace = vscode.workspace.getConfiguration('android-ide.jvmDebugger', session.workspaceFolder?.uri).get<boolean>('traceProtocol', false);
      return {
        onWillReceiveMessage: message => { if (trace) output.appendLine('--> ' + JSON.stringify(message)); },
        onDidSendMessage: message => { if (trace) output.appendLine('<-- ' + JSON.stringify(message)); },
        onError: error => output.appendLine('Adapter error: ' + error.message),
        onExit: (code, signal) => { if (code) { output.appendLine('Adapter exited: ' + code + ' ' + (signal ?? '')); output.show(true); } },
      };
    },
  }));
}
