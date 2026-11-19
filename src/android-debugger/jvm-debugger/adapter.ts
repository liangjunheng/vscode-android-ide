import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import * as vscode from 'vscode';
import { findJava } from './java';
import { adbPath, listDevices } from '../../sdk';
import { readProjectLocalConfig } from '../../projectLocalConfig';
import { adbExec, resolveLauncherActivity } from '../native-debugger/nativeTarget';

export const JVM_DEBUG_TYPE = 'kotlin-jvm';
type Message = { type: string; seq: number; command?: string; request_seq?: number; success?: boolean; message?: string; arguments?: Record<string, any>; [key: string]: any };

/** 提供独立普通JVM端口附加配置，Android六项由父入口提供；jvm-debugger.test.js验证副本隔离。 */
export function getJvmDebugConfigurations(): vscode.DebugConfiguration[] {
  return [{ type: JVM_DEBUG_TYPE, request: 'attach', name: 'Kotlin/Java: Attach to JVM', hostName: 'localhost', port: 5005, sourcePaths: [] }];
}

/** 保留上游JVM配置默认值，Android仅选择设备不分配资源；jvm-debugger.test.js覆盖选择、取消及非法端口。 */
export class JvmConfigurationProvider implements vscode.DebugConfigurationProvider {
  /** 仅缺少PID和包名时读取当前构建选择；jvm-debugger.test.js验证惰性解析和错误传播。 */
  constructor(private readonly selectedPackage: (folder?: vscode.WorkspaceFolder) => string | undefined = () => undefined) {}
  /** initial/dynamic入口提供内置名称；jvm-debugger.test.js断言两入口与返回隔离。 */
  provideDebugConfigurations(): vscode.DebugConfiguration[] { return getJvmDebugConfigurations(); }

  /** 归一化源码路径与launch/attach，Android选择取消不启动；jvm-debugger.test.js验证原配置不变与正常/异常路径。 */
  async resolveDebugConfiguration(folder: vscode.WorkspaceFolder | undefined, input: vscode.DebugConfiguration): Promise<vscode.DebugConfiguration | undefined> {
    if (!vscode.workspace.isTrusted) throw new Error('Workspace is not trusted');
    const config = { ...input };
    if (!config.type && !config.request && !config.name) Object.assign(config, { type: JVM_DEBUG_TYPE, request: 'attach', name: 'Attach to JVM (Kotlin/Java)', port: 5005 });
    config.request ??= 'attach';
    if (!['launch', 'attach'].includes(config.request)) throw new Error('JVM request must be launch or attach');
    const root = folder?.uri.fsPath ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    config.projectRoot ??= config.androidProjectRoot ?? root;
    config.sourcePaths ??= config.androidSourceRoots;
    if (config.sourcePaths !== undefined && (!Array.isArray(config.sourcePaths) || config.sourcePaths.some((value: unknown) => typeof value !== 'string'))) throw new Error('JVM sourcePaths must be a string array');
    if (Array.isArray(config.sourcePaths) && root) config.sourcePaths = config.sourcePaths.map((value: string) => path.isAbsolute(value) ? value : path.join(root, value));
    if (config.android) {
      if (config.pid === undefined && config.processId === undefined) config.packageName ??= this.selectedPackage(folder);
      let serial = config.serial ?? config.target;
      if (!serial || serial === 'select') {
        const devices = (await listDevices()).filter(device => device.state === 'device');
        const selected = await vscode.window.showQuickPick(devices.map(device => ({ label: device.name ?? device.serial, serial: device.serial })), { placeHolder: 'Select Android device for Kotlin/Java debugging' });
        if (!selected) return undefined;
        serial = selected.serial;
      }
      if (typeof serial !== 'string' || !/^[\w.:-]+$/.test(serial)) throw new Error('Invalid Android device serial');
      if (config.pid !== undefined && config.processId !== undefined && Number(config.pid) !== Number(config.processId)) throw new Error('Conflicting Android process ids');
      const pid = config.pid ?? config.processId;
      if (pid !== undefined && (!Number.isSafeInteger(Number(pid)) || Number(pid) <= 0)) throw new Error('Invalid Android process id');
      if (config.request === 'launch' && !/^[A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)+$/.test(config.packageName ?? '')) throw new Error('Android JVM launch requires a valid packageName');
      if (config.request === 'attach' && pid === undefined && !config.packageName) throw new Error('Android JVM attach requires pid, processId, or packageName');
      if (config.request === 'launch' && config.apkPath !== undefined && (typeof config.apkPath !== 'string' || !path.isAbsolute(config.apkPath) || !fs.statSync(config.apkPath).isFile())) throw new Error('Android JVM apkPath must be an existing absolute file');
      Object.assign(config, { serial, target: serial, ...(pid !== undefined ? { pid: Number(pid), processId: Number(pid) } : {}) });
    } else if (config.request === 'attach') {
      config.hostName ??= config.host ?? 'localhost';
      const port = Number(config.port);
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('JVM attach requires a port between 1 and 65535');
      config.port = port;
    } else {
      if (!config.mainClass) throw new Error('JVM launch requires mainClass');
      config.cwd ??= config.projectRoot;
    }
    return config;
  }
}

/** Android会话拥有JAR进程与唯一ADB转发，DAP内容仍由上游处理；jvm-debugger.test.js验证帧转发、启动失败与清理。 */
export class AndroidJvmAdapter implements vscode.DebugAdapter {
  private readonly emitter = new vscode.EventEmitter<Message>();
  readonly onDidSendMessage = this.emitter.event;
  private readonly controller = new AbortController();
  private readonly requests = new Map<number, string>();
  private buffer = Buffer.alloc(0);
  private forwarding?: { adb: string; serial: string; port: number };
  private startup?: Promise<void>;
  private closing?: Promise<void>;
  private readonly exited: Promise<void>;
  private terminated?: Message;

  /** 创建已验证JDK/JAR的stdio进程并绑定关闭事件；jvm-debugger.test.js验证原始DAP响应及异常。 */
  constructor(private readonly child: ChildProcessWithoutNullStreams, private readonly config: vscode.DebugConfiguration, private readonly report: (error: unknown) => void) {
    this.exited = new Promise(resolve => child.once('close', () => resolve()));
    child.stdout.on('data', chunk => this.receive(Buffer.from(chunk)));
    child.stderr.on('data', chunk => this.emitter.fire({ type: 'event', seq: 0, event: 'output', body: { category: 'stderr', output: String(chunk) } }));
    child.on('error', error => { this.report(error); void this.close().catch(this.report); });
    child.stdin.on('error', error => { this.report(error); void this.close().catch(this.report); });
    child.once('close', () => { void this.close().then(() => this.emitter.fire(this.terminated ?? { type: 'event', seq: 0, event: 'terminated' }), this.report); });
  }

  /** 仅将Android launch改写为上游attach，其余DAP原样转发；jvm-debugger.test.js覆盖启动和提前断开。 */
  handleMessage(message: Message): void {
    if (message.type === 'request' && ['launch', 'attach'].includes(message.command!)) {
      if (this.startup || this.closing) { this.failure(message, new Error('Android JVM session already started or closed')); return; }
      this.startup = this.start(message).catch(async error => {
        let failure = error;
        try { await this.releaseForward(); } catch (cleanup) { failure = new AggregateError([error, cleanup], 'JVM startup and cleanup failed'); }
        this.failure(message, failure);
        this.child.stdin.end();
      });
    } else if (this.closing) {
      if (message.type === 'request') this.failure(message, new Error('Android JVM session is closing'));
    } else {
      if (message.type === 'request' && ['disconnect', 'terminate'].includes(message.command!)) this.controller.abort();
      this.send(message);
    }
  }

  /** 以准确PID建立临时JDWP端口，断开时取消启动命令；jvm-debugger.test.js覆盖launch/attach、多PID拒绝和forward失败。 */
  private async start(message: Message): Promise<void> {
    const signal = this.controller.signal;
    const config = { ...this.config, ...message.arguments };
    const serial = config.serial as string;
    if (!serial || !/^[\w.:-]+$/.test(serial)) throw new Error('Invalid Android device serial');
    if (message.command === 'launch' && !/^[A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)+$/.test(config.packageName ?? '')) throw new Error('Invalid Android package name');
    const configuredPid = config.pid ?? config.processId;
    if (message.command === 'attach' && configuredPid === undefined && !/^[A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)+$/.test(config.packageName ?? '')) throw new Error('Android attach requires pid or a valid packageName');
    if (message.command === 'attach' && configuredPid !== undefined && (!Number.isSafeInteger(Number(configuredPid)) || Number(configuredPid) <= 0)) throw new Error('Invalid Android process id');
    const adb = readProjectLocalConfig(config.androidProjectRoot ?? config.projectRoot).debugger?.adbPath ?? adbPath();
    let pid = config.pid ?? config.processId;
    if (message.command === 'attach' && pid === undefined) {
      const pids = (await adbExec(adb, serial, ['shell', 'pidof', '-s', config.packageName], signal)).trim();
      if (!/^\d+$/.test(pids)) throw new Error('No unique Android process found for ' + config.packageName);
      pid = Number(pids);
    }
    if (message.command === 'launch') {
      if (config.apkPath && !config.androidApkInstalled) await adbExec(adb, serial, ['install', '-r', config.apkPath], signal);
      const activity = config.launchActivity ?? await resolveLauncherActivity(adb, serial, config.packageName, signal);
      const component = `${config.packageName}/${activity}`;
      if (!/^[\w.$]+\/[\w.$]+$/.test(component)) throw new Error('Invalid Android launch component');
      const output = await adbExec(adb, serial, ['shell', 'am', 'start', '-D', '-n', component], signal);
      if (/Error:|Exception|Status:\s*(?!ok\b)\S+/i.test(output)) throw new Error('Android launch failed: ' + output.trim());
      const pids = (await adbExec(adb, serial, ['shell', 'pidof', config.packageName], signal)).trim();
      if (!/^\d+$/.test(pids)) throw new Error('Expected exactly one Android process for ' + config.packageName + ', got: ' + pids);
      pid = Number(pids);
    }
    signal.throwIfAborted();
    const port = Number((await adbExec(adb, serial, ['forward', 'tcp:0', `jdwp:${pid}`])).trim());
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('ADB returned an invalid JDWP forwarding port');
    this.forwarding = { adb, serial, port };
    signal.throwIfAborted();
    this.requests.set(message.seq, message.command!);
    this.send({ ...message, command: 'attach', arguments: { ...config, hostName: '127.0.0.1', port, projectRoot: config.projectRoot ?? config.androidProjectRoot } });
  }

  /** 写入Content-Length帧，不自行实现断点或求值；jvm-debugger.test.js断言UTF8字节长度和请求正文。 */
  private send(message: Message): void {
    const body = Buffer.from(JSON.stringify(message));
    this.child.stdin.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]));
  }

  /** 拆分任意分片/合并DAP帧并还原launch响应名称；jvm-debugger.test.js验证两种分片和后端错误透传。 */
  private receive(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    try {
      while (true) {
        const end = this.buffer.indexOf('\r\n\r\n');
        if (end < 0) return;
        const match = /^Content-Length:\s*(\d+)$/im.exec(this.buffer.subarray(0, end).toString('ascii'));
        if (!match) throw new Error('Invalid JVM DAP Content-Length header');
        const length = Number(match[1]);
        if (this.buffer.length < end + 4 + length) return;
        const message: Message = JSON.parse(this.buffer.subarray(end + 4, end + 4 + length).toString('utf8'));
        this.buffer = this.buffer.subarray(end + 4 + length);
        if (message.type === 'response' && this.requests.has(message.request_seq!)) {
          message.command = this.requests.get(message.request_seq!);
          this.requests.delete(message.request_seq!);
        }
        if (message.event === 'terminated') {
          this.terminated = message;
          this.child.stdin.end();
          void this.close().catch(this.report);
        } else {
          this.emitter.fire(message);
          if (message.type === 'response' && ['disconnect', 'terminate'].includes(message.command!)) {
            this.child.stdin.end();
            void this.close().catch(this.report);
          }
        }
      }
    } catch (error) { this.report(error); void this.close().catch(this.report); }
  }

  /** 将准备失败返回对应DAP请求，包含聚合清理错误；jvm-debugger.test.js断言不伪造启动成功。 */
  private failure(request: Message, error: unknown): void {
    const text = error instanceof AggregateError ? error.errors.map(String).join('; ') : String(error);
    this.emitter.fire({ type: 'response', seq: 0, command: request.command, request_seq: request.seq, success: false, message: text });
  }

  /** 仅删除本会话分配的forward；jvm-debugger.test.js断言精确端口及清理错误传播。 */
  private async releaseForward(): Promise<void> {
    if (!this.forwarding) return;
    const { adb, serial, port } = this.forwarding;
    await adbExec(adb, serial, ['forward', '--remove', `tcp:${port}`]);
    this.forwarding = undefined;
  }

  /** 取消未完成准备、终止自有JAR并等待退出与forward回收；jvm-debugger.test.js验证幂等关闭。 */
  close(): Promise<void> {
    return this.closing ??= (async () => {
      this.controller.abort();
      await this.startup;
      this.child.kill();
      const results = await Promise.allSettled([this.exited, this.releaseForward()]);
      const errors = results.filter((value): value is PromiseRejectedResult => value.status === 'rejected').map(value => value.reason);
      if (errors.length) throw new AggregateError(errors, 'JVM cleanup failed');
    })();
  }

  /** VS Code同步释放入口显式报告异步清理错误；jvm-debugger.test.js覆盖释放失败通知。 */
  dispose(): void { void this.close().catch(this.report).finally(() => this.emitter.dispose()); }
}

/** 保留上游JAR/JDK启动契约，非Android使用原生Executable；jvm-debugger.test.js覆盖JAR缺失和参数。 */
export class JvmAdapterFactory implements vscode.DebugAdapterDescriptorFactory {
  private readonly active = new Set<AndroidJvmAdapter>();
  /** 工厂归扩展所有；jvm-debugger.test.js验证注册与关闭。 */
  constructor(private readonly context: vscode.ExtensionContext) {}

  /** 找到JDK17+/JDI后启动bundled JAR，不依赖外部Kotlin插件；jvm-debugger.test.js断言stdio及完整参数。 */
  async createDebugAdapterDescriptor(session: vscode.DebugSession): Promise<vscode.DebugAdapterDescriptor> {
    if (!vscode.workspace.isTrusted) throw new Error('Workspace is not trusted');
    const jar = this.context.asAbsolutePath('resources/jvm-debugger/kotlin-debug-adapter.jar');
    if (!fs.existsSync(jar)) throw new Error('JVM debug adapter is missing; run npm run compile: ' + jar);
    const settings = vscode.workspace.getConfiguration('android-ide.jvmDebugger', session.workspaceFolder?.uri);
    const runtime = await findJava(settings.get<string>('javaHome') || undefined);
    const logFile = path.join(os.tmpdir(), 'android-kotlin-debugger', session.id + '.log');
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    const args = [...settings.get<string[]>('adapterJvmArgs', ['-Xmx512m']), '-jar', jar, '--log-level', session.configuration.logLevel ?? settings.get<string>('logLevel', 'INFO'), '--log-file', logFile];
    if (!session.configuration.android) return new vscode.DebugAdapterExecutable(runtime.java, args);
    const adapter = new AndroidJvmAdapter(spawn(runtime.java, args, { windowsHide: true, stdio: 'pipe' }), session.configuration, error => { void vscode.window.showErrorMessage('JVM debugger: ' + String(error)); });
    this.active.add(adapter);
    adapter.onDidSendMessage(message => { if (message.event === 'terminated') this.active.delete(adapter); });
    return new vscode.DebugAdapterInlineImplementation(adapter);
  }

  /** 扩展停用时结算所有活动Android会话；jvm-debugger.test.js验证双会话释放。 */
  async dispose(): Promise<void> {
    const results = await Promise.allSettled([...this.active].map(adapter => adapter.close()));
    this.active.clear();
    const errors = results.filter((value): value is PromiseRejectedResult => value.status === 'rejected').map(value => value.reason);
    if (errors.length) throw new AggregateError(errors, 'JVM sessions cleanup failed');
  }
}

/** 保留上游可选DAP追踪与崩溃诊断；jvm-debugger.test.js验证输出与退出错误。 */
export class JvmTrackerFactory implements vscode.DebugAdapterTrackerFactory {
  /** 日志通道归扩展所有；jvm-debugger.test.js验证trace开关。 */
  constructor(private readonly output: vscode.OutputChannel) {}
  /** 不修改协议消息，仅按设置记录请求/响应和异常；jvm-debugger.test.js断言完整正文。 */
  createDebugAdapterTracker(): vscode.DebugAdapterTracker {
    const trace = vscode.workspace.getConfiguration('android-ide.jvmDebugger').get<boolean>('traceProtocol', false);
    return {
      onWillReceiveMessage: message => { if (trace) this.output.appendLine('--> ' + JSON.stringify(message)); },
      onDidSendMessage: message => { if (trace) this.output.appendLine('<-- ' + JSON.stringify(message)); },
      onError: error => this.output.appendLine('Adapter error: ' + error.message),
      onExit: (code, signal) => { if (code) { this.output.appendLine('Adapter exited with code ' + code + (signal ? ' (' + signal + ')' : '')); this.output.show(true); } },
    };
  }
}

/** 注册独立JVM类型及initial/dynamic内置项，保留Native唯一工厂；jvm-debugger.test.js验证注册表。 */
export function registerJvmDebugger(context: vscode.ExtensionContext, selectedPackage?: (folder?: vscode.WorkspaceFolder) => string | undefined): void {
  const provider = new JvmConfigurationProvider(selectedPackage);
  const factory = new JvmAdapterFactory(context);
  const output = vscode.window.createOutputChannel('Android Kotlin/Java Debugger');
  context.subscriptions.push(output, vscode.debug.registerDebugAdapterTrackerFactory(JVM_DEBUG_TYPE, new JvmTrackerFactory(output)), factory, vscode.debug.registerDebugAdapterDescriptorFactory(JVM_DEBUG_TYPE, factory),
    vscode.debug.registerDebugConfigurationProvider(JVM_DEBUG_TYPE, provider),
    vscode.debug.registerDebugConfigurationProvider(JVM_DEBUG_TYPE, provider, vscode.DebugConfigurationProviderTriggerKind.Dynamic));
}
