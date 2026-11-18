import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { AdbSmartSocket } from '../../adbSmartSocket';
import { DapTransport, DapMessage, DapResponse } from '../dapTransport';
import { prepareNativeTarget, type NativeTargetOptions } from './nativeTarget';
import { readProjectLocalConfig } from '../../projectLocalConfig';
import { sdkRoot } from '../../sdk';
import * as nativeToolchain from './nativeToolchain';
import { resolveAndroidToolchain } from '../toolchain';
import { discoverNativeSymbols, validateNativeSymbolFile } from './nativeSymbols';
import { openAdapterLedger, reconcileAdapterLedger } from '../adapterLedger';
import type { SessionResourceLedger, ResourceDescriptor } from '../sessionResources';

type Abi = 'arm64-v8a' | 'armeabi-v7a' | 'x86' | 'x86_64';
type NativeModule = { modulePath: string; moduleRoot: string; variant: string };
type Target = { adbPath: string; serial: string; packageName: string; pid: number; abi: Abi; endpoint?: string; program?: string; symbolFiles?: string[]; symbolDirs?: string[]; owned: boolean; dispose?: () => Promise<void> };

/**
 * Native DAP 代理：初始化只启动真实 lldb-dap，不生成线程、变量或停止事件。
 * 所有函数共享回归入口：Node>=22，node --test tests/android-native-adapter.test.js。
 * host/proxy 对应构造、分派、宿主解析、消息响应与转发；attach/launch 对应准备、身份、ELF、ADB 与事件发现；
 * symbols/validation 对应命令引用和运行时目录；cleanup/cancel 对应 dispose、disconnect、回滚及实际 close。
 * 各用例仅模拟主机/传输/ADB/target 边界，成功证据是实际响应、精确参数、错误与资源生命周期断言全部通过。
 * launch 为运行中 native 附加，不承诺入口前暂停；attach 不要求 JDWP，仅要求 run-as debuggable。
 */
export class NativeDebugAdapter implements vscode.DebugAdapter {
  private readonly events = new vscode.EventEmitter<DapMessage>();
  private readonly cancellation = new AbortController();
  private readonly config: any;
  private readonly root?: string;
  private transport?: DapTransport;
  private backendPromise?: Promise<DapTransport>;
  private hostPromise?: Promise<{ lldbDap: string; ndkRoot?: string }>;
  private startup?: Promise<Target>;
  private attachBarrier?: Promise<unknown>;
  private cleanup?: Promise<void>;
  private sequence = 1;
  private readonly reverse = new Map<number, number>();
  private readonly nativeBreakpoints = new Map<string, { source: any; breakpoints: any[] }>();
  private breakpointReplay: Promise<void> = Promise.resolve();
  private readonly resources: Array<() => Promise<void>> = [];
  private target?: Target;
  private programDirectory?: string;
  private programResourceId?: string;
  private readonly ledgerPromise?: Promise<SessionResourceLedger>;
  private readonly ownsLedger: boolean;

  /** 保存上下文、种子配置与显式工作区根；factory 可在后续接入时直接传入同一会话数据。 */
  constructor(private readonly context?: vscode.ExtensionContext, seedConfiguration: Partial<vscode.DebugConfiguration> = {}, workspaceRoot?: string, ledgerPromise?: Promise<SessionResourceLedger>, ownsLedger = true) {
    this.config = { ...seedConfiguration };
    this.root = workspaceRoot;
    this.ledgerPromise = ledgerPromise;
    this.ownsLedger = ownsLedger;
  }
  readonly onDidSendMessage = this.events.event;

  /** 并发处理前端 DAP 消息，错误响应保留后端真实 body；不吞掉反向请求或事件。 */
  handleMessage(message: DapMessage): void { void this.dispatch(message).catch(error => { if (message.type === 'request') this.respond(message, (error as any)?.response || { success: false, message: String(error instanceof Error ? error.message : error) }); else this.send({ type: 'event', seq: 0, event: 'output', body: { category: 'stderr', output: String(error) + '\n' } }); }); }

  /** 取消未完成启动并等待全部自有资源关闭；重复调用返回同一 Promise。 */
  dispose(): Promise<void> { return this.cleanup ||= this.closeAll(); }

  /** 路由请求、后端反向响应和生命周期命令；configurationDone 等待启动与真实 attach 屏障。 */
  private async dispatch(message: DapMessage): Promise<void> {
    if (message.type === 'response') { const backend = this.reverse.get(message.request_seq!); if (backend === undefined) throw new Error('Unknown backend reverse response'); this.reverse.delete(message.request_seq!); (await this.backendReady()).send({ ...message, seq: 0, request_seq: backend }); return; }
    if (message.type !== 'request') throw new Error('Expected DAP request or reverse response');
    if (message.command === 'disconnect' || message.command === 'terminate') { await this.disconnect(message); return; }
    this.cancellation.signal.throwIfAborted();
    await this.ledgerPromise;
    if (message.command === 'initialize') { const response = await (await this.backendReady()).request('initialize', message.arguments); this.respond(message, response); return; }
    if (message.command === 'launch' || message.command === 'attach') {
      if (this.startup) throw new Error('Native target is already configured');
      this.startup = this.prepare({ ...this.config, ...(message.arguments as object || {}) }, message.command === 'launch');
      try {
        const target = await this.startup; this.target = target;
        const transport = await this.backendReady();
        const pending = transport.request('attach', this.attachArguments(target, { ...this.config, ...(message.arguments as object || {}) }));
        // configurationDone 必须等待 LLDB attach 的真实响应，确保目标/模块已就绪后再释放配置屏障。
        this.attachBarrier = pending;
        const response = await pending; this.respond(message, response);
      } catch (error) {
        try { await this.dispose(); } catch (cleanupError) { throw new AggregateError([error, cleanupError], errorText(error) + '; ' + errorText(cleanupError)); }
        throw error;
      }
      return;
    }
    if (message.command === 'configurationDone') { if (!this.startup) throw new Error('Native target is not configured'); await this.startup; await this.attachBarrier; const response = await (await this.backendReady()).request(message.command, message.arguments); this.respond(message, response); return; }
    if (message.command === 'setBreakpoints') this.rememberNativeBreakpoints(message.arguments);
    const response = await (await this.backendReady()).request(message.command!, message.arguments); this.respond(message, response);
  }

  /** 记录前端最后一次真实 native 断点请求；空断点请求会移除对应源码状态。 */
  private rememberNativeBreakpoints(arguments_: unknown): void {
    const args = arguments_ as any;
    const source = args?.source;
    const key = source?.path || source?.name || (source?.sourceReference === undefined ? undefined : String(source.sourceReference));
    if (!key) return;
    const breakpoints = Array.isArray(args?.breakpoints) ? args.breakpoints : [];
    if (!breakpoints.length) this.nativeBreakpoints.delete(key);
    else this.nativeBreakpoints.set(key, { source: JSON.parse(JSON.stringify(source)), breakpoints: JSON.parse(JSON.stringify(breakpoints)) });
  }

  /** LLDB 模块加载后重新提交真实断点，并仅转发后端返回的 breakpoint changed 事件。 */
  private observeNativeEvent(message: DapMessage): void {
    const reason = message.body?.reason;
    const moduleLoaded = message.event === 'module' && !!message.body?.module;
    const processReady = message.event === 'process' && (reason === 'started' || reason === 'attached');
    if (!moduleLoaded && !processReady) return;
    this.breakpointReplay = this.breakpointReplay.then(async () => {
      for (const pending of this.nativeBreakpoints.values()) {
        const response = await (await this.backendReady()).request('setBreakpoints', { source: pending.source, breakpoints: pending.breakpoints });
        const breakpoints = response.body?.breakpoints;
        if (!Array.isArray(breakpoints)) continue;
        for (const breakpoint of breakpoints) this.send({ type: 'event', seq: 0, event: 'breakpoint', body: { reason: 'changed', breakpoint } });
      }
    }).catch(error => {
      this.send({ type: 'event', seq: 0, event: 'output', body: { category: 'stderr', output: 'Native breakpoint resubmission failed: ' + errorText(error) + '\n' } });
    });
  }

  /** 初始化宿主后创建 DAP transport；返回真实 capabilities，允许没有 ABI/PID。 */
  private ensureBackend(): Promise<DapTransport> { return this.backendPromise ||= this.createBackend(); }

  /** 输入已验证配置，创建唯一宿主后端；取消解析时不得启动 child。 */
  private async createBackend(): Promise<DapTransport> {
    if (this.transport) return this.transport;
    if (!this.context) throw new Error('Native debugger extension context is unavailable');
    const root = this.root || this.config.androidProjectRoot;
    const local = readProjectLocalConfig(root).debugger;
    const sdk = sdkRoot(root);
    const resolver = (nativeToolchain as any).resolveNativeHostToolchain;
    if (typeof resolver !== 'function') throw new Error('Native host toolchain resolver is unavailable');
    const host = await (this.hostPromise ||= resolver({ context: this.context, sdkRoot: sdk, overrides: local }));
    this.cancellation.signal.throwIfAborted();
    this.transport = DapTransport.launch(host.lldbDap, [], { cwd: root, env: { ...process.env } });
    this.transport.on('event', m => {
      this.send(m);
      this.observeNativeEvent(m);
    });
    this.transport.on('request', m => { const seq = this.sequence++; this.reverse.set(seq, m.seq); this.events.fire({ ...m, seq }); });
    this.transport.on('diagnostic', (chunk: Buffer) => this.send({ type: 'event', seq: 0, event: 'output', body: { category: 'stderr', output: chunk.toString() } }));
    this.transport.on('close', error => { if (!this.cancellation.signal.aborted) this.send({ type: 'event', seq: 0, event: 'output', body: { category: 'stderr', output: errorText(error) + '\n' } }); });
    return this.transport;
  }

  /** 统一获取异步后端，同时让所有普通 DAP 命令只代理真实响应。 */
  private backendReady(): Promise<DapTransport> { return this.ensureBackend(); }

  /** 将 DAP 请求映射为响应，保留真实 command、body 和错误字段。 */
  private respond(request: DapMessage, response: Partial<DapResponse>): void { this.send({ ...response, type: 'response', seq: 0, command: request.command, request_seq: request.seq } as DapMessage); }
  /** 为前端重编号消息，不改变后端消息语义。 */
  private send(message: DapMessage): void { this.events.fire({ ...message, seq: this.sequence++ }); }

  /** 验证包/PID并复制实际可执行ELF到独占缓存；解析四ABI及精确符号文件后准备远端。回归：adapter 的 executable/cache/producer 用例及 opt-in android-native-device.test.js，断言真实JNI断点、41->42和detach保留PID。 */
  private async prepare(args: any, launch: boolean): Promise<Target> {
    if (typeof args.serial !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:\[\]-]*$/.test(args.serial)) throw new Error('Select a valid Android device serial');
    if (typeof args.packageName !== 'string' || !/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/.test(args.packageName)) throw new Error('Invalid Android package name');
    const projectRoot = args.androidProjectRoot || this.root;
    if (!vscode.workspace.isTrusted) throw new Error('Native debugging requires a trusted workspace');
    if (!projectRoot || !path.isAbsolute(projectRoot) || /[\x00-\x1f\x7f]/.test(projectRoot) || !fs.statSync(projectRoot).isDirectory()) throw new Error('Invalid Android project root');
    const owner = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(projectRoot));
    if (!owner || (this.root && path.resolve(owner.uri.fsPath) !== path.resolve(this.root))) throw new Error('Android project root is outside the owned workspace');
    const explicitSymbols = args.runtimeandroidNativeSymbolDirs ?? args.androidNativeSymbolDirs;
    if (explicitSymbols !== undefined) this.validateSymbolDirs(explicitSymbols);
    const local = readProjectLocalConfig(projectRoot).debugger;
    const android = await resolveAndroidToolchain(this.context, projectRoot);
    this.cancellation.signal.throwIfAborted();
    const target: Target = { adbPath: android.adb, serial: args.serial, packageName: args.packageName, pid: 0, abi: 'arm64-v8a', owned: false };
    const directory = (await this.adb(target, ['shell', 'run-as', target.packageName, 'pwd'])).trim();
    if (!/^\/(?:data\/user\/\d+|data\/data)\/[A-Za-z0-9_.]+$/.test(directory) || directory.split('/').pop() !== target.packageName) throw new Error('Package is not run-as debuggable');
    if (launch) {
      const activity = await this.adb(target, ['shell', 'cmd', 'package', 'resolve-activity', '--brief', '-a', 'android.intent.action.MAIN', '-c', 'android.intent.category.LAUNCHER', target.packageName]);
      const component = activity.split(/\r?\n/).map(x => x.trim()).find(x => x.startsWith(target.packageName + '/') && !x.includes('No activity'));
      if (!component) throw new Error('Unable to resolve launcher activity for ' + target.packageName);
      const table = await this.adb(target, ['shell', 'ps', '-A', '-o', 'PID,NAME']);
      const previous = new Set<number>();
      for (const line of table.trim().split(/\r?\n/)) { const match = /^\s*(\d+)\s+(\S+)\s*$/.exec(line); if (match?.[2] === target.packageName) previous.add(Number(match[1])); }
      if (previous.size) await this.adb(target, ['shell', 'am', 'force-stop', target.packageName]);
      target.pid = await this.discover(target, previous, async () => {
        const output = await this.adb(target, ['shell', 'am', 'start', '-n', component]);
        if (/Error:|Exception|Warning: Activity not started/i.test(output)) throw new Error('Native Android launch failed: ' + output.trim());
      });
      target.owned = true;
      this.target = target;
    } else {
      const raw = args.pid ?? args.processId;
      if (!/^\d+$/.test(String(raw)) || !Number.isSafeInteger(Number(raw)) || Number(raw) <= 0) throw new Error('Attach requires an Android process id');
      target.pid = Number(raw); await this.verifyPackage(target); target.owned = false;
    }
    const executable = await this.adbBuffer(target, ['exec-out', 'run-as', target.packageName, 'dd', 'if=/proc/' + target.pid + '/exe']);
    target.abi = elfAbi(executable);
    // 会话独占目录先登记所有权再写入；取消、写入失败和后端退出均走 closeAll。
    this.programDirectory = await this.createProgramDirectory();
    target.program = path.join(this.programDirectory, 'process-executable');
    this.cancellation.signal.throwIfAborted();
    await fs.promises.writeFile(target.program, executable, { flag: 'wx', mode: 0o600 });
    const explicitDirs = args.runtimeandroidNativeSymbolDirs ?? args.androidNativeSymbolDirs;
    if (explicitDirs !== undefined) {
      if (!Array.isArray(explicitDirs)) throw new Error('Invalid runtime native symbol directories');
      target.symbolDirs = explicitDirs;
    } else if (args.androidNativeModules !== undefined) {
      if (!Array.isArray(args.androidNativeModules) || args.androidNativeModules.length === 0) throw new Error('Native symbol producer modules are required');
      // producer graph 回归：实际 ABI 逐项发现，规范化文件后检查同名冲突，无应用模块猜测。
      const files: string[] = [];
      const dirs: string[] = [];
      for (const producer of args.androidNativeModules as NativeModule[]) {
        if (!producer || Array.isArray(producer) || typeof producer.modulePath !== 'string' || !/^:(?:[A-Za-z0-9_.-]+(?::[A-Za-z0-9_.-]+)*)?$/.test(producer.modulePath) || typeof producer.moduleRoot !== 'string' || !path.isAbsolute(producer.moduleRoot) || typeof producer.variant !== 'string' || !/^[A-Za-z][A-Za-z0-9_.-]*$/.test(producer.variant)) throw new Error('Invalid native symbol producer module');
        const symbols = discoverNativeSymbols({ projectRoot, moduleRoot: producer.moduleRoot, variant: producer.variant, abi: target.abi });
        files.push(...symbols.symbolFiles.map(file => fs.realpathSync(file))); dirs.push(...symbols.symbolDirs.map(directory => fs.realpathSync(directory)));
      }
      const byName = new Map<string, string>();
      for (const file of new Set(files)) { const name = path.basename(file), prior = byName.get(name); if (prior && path.resolve(prior) !== path.resolve(file)) throw new Error('Native symbol basename collision: ' + name); byName.set(name, file); }
      target.symbolFiles = [...new Set(files)];
      target.symbolDirs = [...new Set(dirs)];
    } else {
      if (typeof args.androidModuleRoot !== 'string' || typeof args.androidVariant !== 'string') throw new Error('Native symbol discovery requires selected Android module and variant');
      const symbols = discoverNativeSymbols({ projectRoot, moduleRoot: args.androidModuleRoot, variant: args.androidVariant, abi: target.abi });
      target.symbolDirs = symbols.symbolDirs;
      target.symbolFiles = symbols.symbolFiles;
    }
    if (explicitDirs !== undefined) target.symbolFiles = explicitDirs.flatMap((directory: string) => fs.readdirSync(directory).filter(file => file.endsWith('.so')).map(file => path.join(directory, file)));
    const byName = new Map<string, string>();
    target.symbolFiles = [...new Set((target.symbolFiles || []).map(file => {
      const real = fs.realpathSync(file);
      if (!fs.statSync(real).isFile()) throw new Error('Invalid native symbol file: ' + file);
      validateNativeSymbolFile(real, target.abi);
      const prior = byName.get(path.basename(real));
      if (prior && prior !== real) throw new Error('Native symbol basename collision: ' + path.basename(real));
      byName.set(path.basename(real), real);
      return real;
    }))];
    await this.backendReady();
    const host = await this.hostPromise!;
    const server = await (nativeToolchain as any).resolveNativeServer({ context: this.context, ndkRoot: host.ndkRoot, sdkRoot: sdkRoot(projectRoot), abi: target.abi, overrides: local });
    const ledger = await this.ledgerPromise;
    const callbacks = ledger ? this.nativeLedgerCallbacks(ledger) : {};
    if (ledger) await reconcileAdapterLedger(ledger);
    const remote = await prepareNativeTarget({ adbPath: target.adbPath, serverPath: server, serial: target.serial, packageName: target.packageName, pid: target.pid, abi: target.abi, signal: this.cancellation.signal, ...callbacks });
    this.resources.push(() => remote.dispose());
    if (ledger && (!remote.serverIdentity || !remote.forwardIdentity)) throw new Error('Exact native resource identities unavailable');
    target.endpoint = remote.endpoint; target.dispose = remote.dispose;
    this.target = target;
    this.cancellation.signal.throwIfAborted();
    return target;
  }

  /** 输入已打开账本，输出精确 server/forward 回调；仅接受 target 在物理清理成功后的确认。回归：Node>=22，adapter ledger 用例断言完整描述、身份缺失拒绝和失败保留。 */
  private nativeLedgerCallbacks(ledger: SessionResourceLedger): Pick<NativeTargetOptions, 'acquireServer' | 'acquireForward' | 'releaseServer' | 'releaseForward'> {
    const records = new Map<string, string>();
    const released = new Set<string>();
    // 输入描述符并以完整字段生成键；proof 只承认本次 target 已确认清理的同一资源。
    const key = (resource: ResourceDescriptor): string => JSON.stringify(resource, Object.keys(resource).sort());
    for (const kind of ['native-server', 'adb-forward'] as const) ledger.register(kind, {
      probe: async resource => released.has(key(resource)) ? 'absent' : 'conflict',
      release: async () => { throw new Error('Native resource cleanup must be confirmed by its target'); },
    });
    // 输入 target 的精确身份，无额外副作用；claim/acquired 由账本持久化，失败必须向 target 回滚传播。
    const acquire = async (resource: ResourceDescriptor): Promise<void> => {
      const identity = key(resource); const id = randomUUID(); records.set(identity, id);
      await ledger.acquire(id, resource, async () => undefined);
    };
    // 输入物理释放后的完整身份，输出账本释放结果；未知身份不能按 PID 或端口退化匹配。
    const release = async (resource: ResourceDescriptor): Promise<void> => {
      const identity = key(resource); const id = records.get(identity);
      if (!id) throw new Error('Native resource release identity is not recorded');
      released.add(identity); await ledger.release(id);
    };
    // 输入 server 身份，输出账本严格 schema；argv 不属于持久化描述符，不能额外写入。
    const server = (identity: Parameters<NonNullable<NativeTargetOptions['acquireServer']>>[0]): ResourceDescriptor => ({ kind: 'native-server', serial: identity.serial, pid: identity.pid, executable: identity.executable, socket: identity.socket, targetIdentity: identity.targetIdentity, startIdentity: identity.startIdentity });
    // 输入同一次 forward 返回的完整身份，输出保留 transportIdentity 的精确描述符。
    const forward = (identity: Parameters<NonNullable<NativeTargetOptions['acquireForward']>>[0]): ResourceDescriptor => ({ kind: 'adb-forward', serial: identity.serial, local: identity.local, remote: identity.remote, transportIdentity: identity.transportIdentity });
    return { acquireServer: identity => acquire(server(identity)), acquireForward: identity => acquire(forward(identity)), releaseServer: identity => release(server(identity)), releaseForward: identity => release(forward(identity)) };
  }

  /** 创建独占可执行缓存；启用账本时放在扩展存储根下并以 wx marker 证明所有权。回归：adapter ledger cache 用例在 Node>=22 下断言路径、marker、冲突拒绝和后端关闭后释放。 */
  private async createProgramDirectory(): Promise<string> {
    const ledger = await this.ledgerPromise;
    const root = ledger ? this.context?.globalStorageUri?.fsPath : os.tmpdir();
    if (!root || !path.isAbsolute(root)) throw new Error('Native executable ledger storage is unavailable');
    this.programDirectory = await fs.promises.mkdtemp(path.join(root, 'android-native-'));
    if (!ledger) return this.programDirectory;
    const directory = this.programDirectory; const marker = randomUUID(); const markerFile = path.join(directory, '.owner');
    await fs.promises.writeFile(markerFile, marker, { flag: 'wx', mode: 0o600 });
    const resource: ResourceDescriptor = { kind: 'local-directory', relativePath: path.relative(root, directory).split(path.sep).join('/'), marker };
    // 输入账本描述符，仅普通 marker 内容完全相等才证明拥有目录；缺失、链接和篡改均失败关闭。
    const proof = async (candidate: ResourceDescriptor): Promise<'matched' | 'conflict'> => {
      if (candidate.kind !== 'local-directory' || candidate.relativePath !== resource.relativePath || candidate.marker !== marker) return 'conflict';
      const stat = await fs.promises.lstat(markerFile);
      return stat.isFile() && !stat.isSymbolicLink() && await fs.promises.readFile(markerFile, 'utf8') === marker ? 'matched' : 'conflict';
    };
    ledger.register('local-directory', {
      probe: proof,
      release: async candidate => { if (await proof(candidate) !== 'matched') throw new Error('Native executable cache marker conflict'); await fs.promises.rm(directory, { recursive: true }); },
    });
    this.programResourceId = randomUUID();
    await ledger.acquire(this.programResourceId, resource, async () => undefined);
    return directory;
  }

  /** 基于 track-jdwp 事件等待新进程，并以 /proc/cmdline 精确匹配包名，无固定延迟或轮询。 */
  private async discover(target: Target, previous: Set<number>, start: () => Promise<void>): Promise<number> {
    const signal = this.cancellation.signal;
    let wake: (() => void) | undefined;
    let failure: unknown;
    const updates: number[][] = [];
    const abort = (): void => { failure = signal.reason; wake?.(); };
    signal.addEventListener('abort', abort, { once: true });
    const stop = new AdbSmartSocket().trackJdwp(target.serial, pids => { updates.push(pids); wake?.(); }, error => { failure = error; wake?.(); }, signal);
    try {
      signal.throwIfAborted(); await start();
      while (true) {
        signal.throwIfAborted(); if (failure) throw failure;
        if (!updates.length) { await new Promise<void>(resolve => { wake = resolve; }); continue; }
        const matches: number[] = [];
        for (const pid of updates.shift()!) {
          if (previous.has(pid)) continue;
          const text = await this.adb(target, ['shell', 'cat', '/proc/' + pid + '/cmdline']);
          if (text.split('\0')[0].trim() === target.packageName) matches.push(pid);
        }
        if (matches.length > 1) throw new Error('Ambiguous native Android target PID');
        if (matches.length === 1) return matches[0];
      }
    } finally { signal.removeEventListener('abort', abort); await stop(); }
  }
  /** 验证 attach PID 的真实 cmdline，防止调试错误包或子进程。 */
  private async verifyPackage(target: Target): Promise<void> { const text = await this.adb(target, ['shell', 'cat', '/proc/' + target.pid + '/cmdline']); if (text.split('\0')[0].trim() !== target.packageName) throw new Error('PID does not match Android package ' + target.packageName); }
  /** 使用 shell:false 的本地 argv 执行 adb，取消信号绑定子进程。 */
  private adb(target: Target, args: string[]): Promise<string> { this.cancellation.signal.throwIfAborted(); const argv = [args[0], args.slice(1).map(shellQuote).join(' ')]; return new Promise((resolve, reject) => execFile(target.adbPath, ['-s', target.serial, ...argv], { shell: false, windowsHide: true, signal: this.cancellation.signal }, (e, out, err) => e ? reject(new Error(String(err || out || e.message).trim())) : resolve(String(out)))); }
  /** 读取 exec-out 完整原始ELF，禁止文本转码；64MiB为有界程序大小上限。回归：adapter executable 用例逐字节比较缓存、核对PID和无截断dd参数。 */
  private adbBuffer(target: Target, args: string[]): Promise<Buffer> { this.cancellation.signal.throwIfAborted(); const argv = [args[0], args.slice(1).map(shellQuote).join(' ')]; return new Promise((resolve, reject) => execFile(target.adbPath, ['-s', target.serial, ...argv], { shell: false, windowsHide: true, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024, signal: this.cancellation.signal }, (e, out, err) => e ? reject(new Error(String(err || e.message).trim())) : resolve(Buffer.from(out)))); }
  /** 用实际主程序创建LLDB target，按四ABI设置triple并加载精确模块；只连接自有endpoint。ART默认传递隐式空检查SIGSEGV，调用方可用标准postRunCommands显式覆盖。回归：adapter executable/symbols/cache用例断言命令、转义和覆盖；真机inline用例验证源断点。 */
  private attachArguments(target: Target, args: any): any {
    const dirs = args?.runtimeandroidNativeSymbolDirs ?? args?.androidNativeSymbolDirs ?? target.symbolDirs ?? [];
    this.validateSymbolDirs(dirs);
    const initCommands = dirs.map((directory: unknown) => {
      if (typeof directory !== 'string' || /[\x00-\x1f\x7f]/.test(directory) || !path.isAbsolute(directory) || !fs.statSync(directory).isDirectory()) throw new Error('Invalid native symbol directory: ' + String(directory));
      return 'settings append target.exec-search-paths ' + lldbQuote(directory);
    });
    if (!/^connect:\/\/127\.0\.0\.1:[1-9]\d{0,4}$/.test(target.endpoint!) || Number(target.endpoint!.split(':').pop()) > 65535) throw new Error('Invalid native target endpoint');
    const triples: Record<Abi, string> = { 'arm64-v8a': 'aarch64-unknown-linux-android', 'armeabi-v7a': 'armv7-unknown-linux-android', x86: 'i386-unknown-linux-android', x86_64: 'x86_64-unknown-linux-android' };
    if (!target.program || !path.isAbsolute(target.program)) throw new Error('Native executable cache is unavailable');
    const postRunCommands = args.postRunCommands ?? ['process handle --stop false --notify false --pass true SIGSEGV'];
    if (!Array.isArray(postRunCommands) || postRunCommands.some((command: unknown) => typeof command !== 'string' || /[\x00-\x1f\x7f]/.test(command))) throw new Error('Invalid native postRunCommands');
    return { program: target.program, targetTriple: triples[target.abi], platformName: 'remote-android', preRunCommands: (target.symbolFiles || []).map(file => 'target modules add ' + lldbQuote(file)), postRunCommands, attachCommands: ['process connect --plugin gdb-remote ' + lldbQuote(target.endpoint!)], initCommands };
  }
  /** 只校验符号目录数组，失败发生在任何设备 IO 之前。 */
  private validateSymbolDirs(dirs: unknown): asserts dirs is string[] {
    if (!Array.isArray(dirs)) throw new Error('Invalid runtime native symbol directories');
    for (const directory of dirs) if (typeof directory !== 'string' || /[\x00-\x1f\x7f]/.test(directory) || !path.isAbsolute(directory) || !fs.statSync(directory).isDirectory()) throw new Error('Invalid native symbol directory: ' + String(directory));
  }

  /** 断开时先 detach 后等待远端 dispose 与后端 close；terminate 只杀本次 launch 且复核身份。 */
  private async disconnect(message: DapMessage): Promise<void> {
    const errors: unknown[] = [];
    let response: Partial<DapResponse> = { success: true };
    try {
      if (this.transport) response = await this.transport.request('disconnect', { ...(message.arguments as object || {}), terminateDebuggee: false });
      if (message.command === 'terminate' && this.target?.owned) {
        await this.verifyPackage(this.target);
        await this.adb(this.target, ['shell', 'run-as', this.target.packageName, 'kill', '-9', String(this.target.pid)]);
      }
    } catch (error) { errors.push(error); response = (error as any).response || { success: false, message: String(error) }; }
    try { await this.dispose(); } catch (error) { errors.push(error); }
    if (errors.length) response = { ...response, success: false, message: errors.map(errorText).join('; ') };
    this.respond(message, response);
    this.events.dispose();
  }
  /** 等待准备结束，逆序释放远端，再关闭后端，最后删除独占主程序缓存；各阶段失败仍尝试其余释放并聚合诊断。回归：adapter cache/cleanup/cancel用例断言顺序、晚到资源、写入失败和幂等。 */
  private async closeAll(): Promise<void> {
    this.cancellation.abort(new Error('Native debug adapter disposed'));
    const errors: unknown[] = [];
    const preparing = [this.backendPromise, this.startup].filter((promise): promise is Promise<any> => !!promise);
    await Promise.allSettled(preparing);
    for (const release of this.resources.reverse()) { try { await release(); } catch (error) { errors.push(error); } }
    if (this.transport) { try { await this.transport.dispose(); } catch (error) { errors.push(error); } }
    if (this.programDirectory) { try { if (this.programResourceId) await (await this.ledgerPromise!).release(this.programResourceId); else await fs.promises.rm(this.programDirectory, { recursive: true }); } catch (error) { errors.push(error); } }
    this.reverse.clear();
    if (this.ownsLedger && this.ledgerPromise) { try { await (await this.ledgerPromise).close(); } catch (error) { errors.push(error); } }
    if (errors.length) throw new AggregateError(errors, 'Native debug adapter cleanup failed: ' + errors.map(errorText).join('; '));
  }
}

/** 将 ELF ident/class 与 e_machine 映射为实际目标 ABI；不读取设备 abilist。 */
export function elfAbi(header: Buffer): Abi { if (header.length < 20 || header.readUInt32BE(0) !== 0x7f454c46 || header[5] !== 1) throw new Error('Invalid process ELF header'); const key = header[4] + ':' + header.readUInt16LE(18); const map: Record<string, Abi> = { '2:183': 'arm64-v8a', '1:40': 'armeabi-v7a', '1:3': 'x86', '2:62': 'x86_64' }; const abi = map[key]; if (!abi) throw new Error('Unsupported process ELF ABI: ' + key); return abi; }
/** 用双引号及转义编码 LLDB 参数，拒绝控制字符；node --test tests/android-native-adapter.test.js 的命令转义回归校验路径与 endpoint 不被拆分。 */
function lldbQuote(value: string): string {
  if (/[\x00-\x1f\x7f]/.test(value)) throw new Error('Invalid LLDB argument');
  return '"' + value.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}
/** 将远端 token 编码为 Android shell 单引号字符串；safe argv 回归逐项核对。 */
function shellQuote(value: string): string { return "'" + value.replace(/'/g, "'\\''") + "'"; }
/** 将聚合清理错误保留为可读诊断；cleanup 回归断言全部释放失败均出现。 */
function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error); }
