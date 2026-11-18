import * as vscode from 'vscode';
import { DapMessage, DapResponse } from '../dapTransport';
import type { SessionResourceLedger } from '../sessionResources';

/** JVM 已验证的真实进程身份；协调器不发现或猜测 PID。 */
export interface MixedJvmTarget { serial: string; packageName: string; pid: number; }
/** 注入真实 JVM 生命周期；begin 返回准备完成及仍等待配置的实际 attach 响应。 */
export interface MixedJvmAdapter extends vscode.DebugAdapter {
  beginSuspended(args: any, launch: boolean): Promise<{ target: MixedJvmTarget; response: Promise<Partial<DapResponse>>; setup: Promise<void> }>;
  requestBackend(command: string, args?: unknown): Promise<Partial<DapResponse>>;
}
type Owner = 'jvm' | 'native';
type Ref = { owner: Owner; id: number; kind: string };
type Pending = { resolve: (value: DapResponse) => void; reject: (error: Error) => void };

/**
 * 将两个真实 DAP 子适配器组合为一个会话，不制造 VM 状态。
 * 回归入口：node --test tests/android-mixed-adapter.test.js；startup 验证唯一启动/精确 PID/configDone 顺序，
 * routing 验证引用归属、反向请求及真实失败，cleanup 验证两个子适配器均释放。
 */
export class MixedDebugAdapter implements vscode.DebugAdapter {
  private readonly events = new vscode.EventEmitter<DapMessage>();
  readonly onDidSendMessage = this.events.event;
  private readonly listeners: vscode.Disposable[] = [];
  private readonly pending = new Map<string, Pending>();
  private readonly reverse = new Map<number, { owner: Owner; seq: number }>();
  private readonly refs = new Map<number, Ref>();
  private readonly refKeys = new Map<string, number>();
  private sequence = 1;
  private reference = 1;
  private startup?: Promise<void>;
  private cleanup?: Promise<void>;
  private initialized?: DapMessage;
  private closing = false;
  private terminalEvent?: DapMessage;
  private nativeReadyResolve!: () => void;
  private readonly nativeReady = new Promise<void>(resolve => { this.nativeReadyResolve = resolve; });
  private readonly ledgerPromise?: Promise<SessionResourceLedger>;

  /** 输入独占 JVM/Native 子适配器，注册消息所有权；startup/routing 测试验证事件和响应不会串线。 */
  constructor(private readonly jvm: MixedJvmAdapter, private readonly native: vscode.DebugAdapter, private readonly seed: Partial<vscode.DebugConfiguration> = {}, ledgerPromise?: Promise<SessionResourceLedger>) {
    this.ledgerPromise = ledgerPromise;
    this.listeners.push(jvm.onDidSendMessage(message => this.receive('jvm', message as DapMessage)));
    this.listeners.push(native.onDidSendMessage(message => this.receive('native', message as DapMessage)));
  }

  /** 并发处理前端命令，允许 configurationDone 与尚未完成的 attach 同时推进；startup 测试防止死锁。 */
  handleMessage(message: DapMessage): void {
    void this.dispatch(message).catch(error => {
      if (message.type === 'request') this.respond(message, (error as any)?.response || { success: false, message: String(error instanceof Error ? error.message : error) });
      else this.send({ seq: 0, type: 'event', event: 'output', body: { category: 'stderr', output: String(error) + '\n' } });
    });
  }

  /** 清理立即终结等待请求并并行释放两个子适配器，聚合全部错误；cleanup 测试验证幂等与双边失败。 */
  dispose(): Promise<void> {
    if (!this.cleanup) {
      for (const pending of this.pending.values()) pending.reject(new Error('Mixed debug adapter disposed'));
      this.pending.clear();
      this.nativeReadyResolve();
      this.cleanup = (async () => {
        await this.ledgerPromise;
        const results = await Promise.allSettled([Promise.resolve().then(() => this.jvm.dispose()), Promise.resolve().then(() => this.native.dispose())]);
        this.listeners.forEach(listener => listener.dispose());
        this.refs.clear(); this.refKeys.clear(); this.reverse.clear();
        if (this.ledgerPromise) await (await this.ledgerPromise).close();
        const errors = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected').map(result => result.reason);
        if (errors.length) throw new AggregateError(errors, errors.map(String).join('; '));
      })();
    }
    return this.cleanup;
  }

  /** 子响应结算自身请求，反向请求映射序号，事件仅改引用；routing 测试断言原错误/body 和事件内容保留。 */
  private receive(owner: Owner, message: DapMessage): void {
    if (message.type === 'response') {
      const key = owner + ':' + message.request_seq;
      const pending = this.pending.get(key);
      if (!pending) return;
      this.pending.delete(key);
      if (message.success) pending.resolve(message as DapResponse);
      else pending.reject(Object.assign(new Error(message.message || 'Child request failed'), { response: message }));
      return;
    }
    if (message.type === 'request') {
      const seq = this.sequence++;
      this.reverse.set(seq, { owner, seq: message.seq });
      this.events.fire({ ...message, seq });
      return;
    }
    if (message.event === 'initialized') {
      // JVM 的 initialized 是 VS Code 配置屏障所需的真实会话事件，不能丢弃；Native 事件仅解除内部 readiness。
      if (owner === 'native') { this.initialized = message; this.nativeReadyResolve(); }
      else this.send(message);
      return;
    }
    if (message.event === 'terminated') {
      if (this.terminalEvent) return;
      this.terminalEvent = message;
      if (this.closing) return;
      void this.dispose().then(() => this.send(message), error => {
        this.send({ seq: 0, type: 'event', event: 'output', body: { category: 'stderr', output: String(error) } });
        this.send(message);
      });
      return;
    }
    const body = this.mapBody(owner, message.body);
    if (body && message.event === 'stopped') body.allThreadsStopped = false;
    if (body && message.event === 'continued') body.allThreadsContinued = false;
    this.send({ ...message, body });
  }

  /** 给单个子适配器发送真实 DAP 请求并关联响应，可与其他命令并发；startup/reverse 测试断言。 */
  private childRequest(owner: Owner, command: string, args?: unknown): Promise<DapResponse> {
    if (this.cleanup) return Promise.reject(new Error('Mixed debug adapter disposed'));
    const seq = this.sequence++;
    return new Promise((resolve, reject) => {
      const key = owner + ':' + seq;
      this.pending.set(key, { resolve, reject });
      try { (owner === 'jvm' ? this.jvm : this.native).handleMessage({ seq, type: 'request', command, arguments: args }); }
      catch (error) { this.pending.delete(key); reject(error); }
    });
  }

  /** 初始化取真实能力交集；支持路由的引用命令不扩大后端能力，未知可选能力不宣称支持。 */
  private async initialize(args: unknown): Promise<Partial<DapResponse>> {
    const [jvm, native] = await Promise.all([this.jvm.requestBackend('initialize', args), this.childRequest('native', 'initialize', args)]);
    const capabilities: Record<string, unknown> = {};
    for (const key of ['supportsConfigurationDoneRequest', 'supportsConditionalBreakpoints', 'supportsHitConditionalBreakpoints', 'supportsLogPoints', 'supportsEvaluateForHovers', 'supportsSetVariable', 'supportsSetExpression', 'supportsTerminateRequest', 'supportsExceptionInfoRequest', 'supportsStepBack', 'supportsSteppingGranularity']) {
      if (jvm.body?.[key] === true && native.body?.[key] === true) capabilities[key] = true;
    }
    return { ...jvm, body: capabilities };
  }

  /** 只由 JVM 启动应用，再对同一验证 PID Native attach；startup/failure 测试覆盖配置屏障和失败回收。 */
  private async start(args: any, launch: boolean): Promise<Partial<DapResponse>> {
    const prepared = await this.jvm.beginSuspended({ ...this.seed, ...args, androidMode: 'kotlin-java' }, launch);
    const jvmResponse = prepared.response;
    const observedJvm = jvmResponse.then(value => ({ value }), error => ({ error }));
    await prepared.setup;
    if (this.cleanup) throw new Error('Mixed debug adapter disposed');
    const target = prepared.target;
    if (!Number.isSafeInteger(target.pid) || target.pid <= 0 || typeof target.serial !== 'string' || typeof target.packageName !== 'string') throw new Error('Invalid verified JVM target');
    const nativeResponse = this.childRequest('native', 'attach', { ...this.seed, ...args, ...target, processId: target.pid, androidMode: 'native' });
    // Native DAP 可能在 attach 成功后不发送 initialized 事件；attach response 本身是可等待的 readiness 屏障，失败也必须解除 configurationDone 等待以便清理。
    void nativeResponse.then(() => this.nativeReadyResolve(), () => this.nativeReadyResolve());
    try {
      const [jvmResult, nativeResult] = await Promise.all([observedJvm.then(result => { if ('error' in result) throw result.error; return result.value; }), nativeResponse]);
      if (jvmResult.success === false) throw Object.assign(new Error(jvmResult.message), { response: jvmResult });
      return { ...jvmResult, success: nativeResult.success === true && jvmResult.success === true };
    } catch (error) {
      try { await this.dispose(); } catch (cleanupError) { throw new AggregateError([error, cleanupError], String(error) + '; ' + String(cleanupError)); }
      throw error;
    }
  }

  /** 按 DAP 命令和引用归属分派，不以当前焦点猜测后端；routing 测试验证碰撞 ID、断点语言和未知引用拒绝。 */
  private async dispatch(message: DapMessage): Promise<void> {
    if (message.type === 'response') {
      const reverse = this.reverse.get(message.request_seq!);
      if (!reverse) throw new Error('Unknown mixed reverse response');
      this.reverse.delete(message.request_seq!);
      (reverse.owner === 'jvm' ? this.jvm : this.native).handleMessage({ ...message, request_seq: reverse.seq });
      return;
    }
    if (message.type !== 'request') throw new Error('Expected DAP request');
    const args: any = message.arguments || {};
    const command = message.command!;
    if (command === 'initialize') { this.respond(message, await this.initialize(args)); return; }
    if (command === 'launch' || command === 'attach') {
      if (this.startup) throw new Error('Mixed target already configured');
      const started = this.start(args, command === 'launch');
      this.startup = Promise.resolve();
      try { this.respond(message, await started); }
      catch (error) { await this.dispose(); throw error; }
      return;
    }
    if (command === 'configurationDone') {
      if (!this.startup) throw new Error('Mixed target not configured');
      // 直接转发 configurationDone；Native adapter 会等待自身 prepare 完成后发送给 LLDB，不能先等待依赖该命令的 attach response。
      if (this.cleanup) throw new Error('Mixed debug adapter disposed');
      try {
        await this.childRequest('native', command, args);
        this.respond(message, await this.jvm.requestBackend(command, args));
      } catch (error) { await this.dispose(); throw error; }
      return;
    }
    if (command === 'disconnect' || command === 'terminate') {
      this.closing = true;
      let response: Partial<DapResponse> | undefined;
      let failure: unknown;
      const results = await Promise.allSettled([this.childRequest('native', 'disconnect', { ...args, terminateDebuggee: false }), this.childRequest('jvm', command, args)]);
      for (const result of results) { if (result.status === 'rejected') failure = result.reason; else response = result.value; }
      try { await this.dispose(); } catch (error) { failure = failure ? new AggregateError([failure, error]) : error; }
      if (failure) throw failure;
      this.respond(message, response!);
      if (this.terminalEvent) this.send(this.terminalEvent);
      return;
    }
    if (this.cleanup) throw new Error('Mixed debug adapter disposed');
    if (command === 'setExceptionBreakpoints') {
      if (Array.isArray(args.filters) && args.filters.length) throw new Error('Mixed exception filters require explicit backend ownership');
      const responses = await Promise.all([this.jvm.requestBackend(command, args), this.childRequest('native', command, args)]);
      this.respond(message, responses[0]); return;
    }
    if (command === 'threads') {
      const [jvm, native] = await Promise.all([this.jvm.requestBackend(command, args), this.childRequest('native', command, args)]);
      this.respond(message, { ...jvm, body: { threads: [...(jvm.body?.threads || []).map((thread: any) => ({ ...thread, id: this.encode('jvm', 'thread', thread.id) })), ...(native.body?.threads || []).map((thread: any) => ({ ...thread, id: this.encode('native', 'thread', thread.id) }))] } }); return;
    }
    let owner: Owner;
    let routed = { ...args };
    if (command === 'setBreakpoints' || command === 'breakpointLocations') owner = this.sourceOwner(args.source);
    else {
      const field = args.threadId !== undefined ? 'threadId' : args.frameId !== undefined ? 'frameId' : args.variablesReference !== undefined ? 'variablesReference' : args.sourceReference ? 'sourceReference' : undefined;
      if (!field) throw new Error('Mixed command requires an owned reference: ' + command);
      const kind = { threadId: 'thread', frameId: 'frame', variablesReference: 'variable', sourceReference: 'source' }[field]!;
      const ref = this.decode(args[field], kind); owner = ref.owner; routed[field] = ref.id;
    }
    routed = this.unmapArguments(owner, args);
    const response = owner === 'jvm' ? await this.jvm.requestBackend(command, routed) : await this.childRequest(owner, command, routed);
    const body = this.mapBody(owner, response.body, command);
    if (command === 'continue' && body) body.allThreadsContinued = false;
    this.respond(message, { ...response, body });
  }

  /** 根据明确源码语言后缀决定断点后端，含 Rust；routing 测试覆盖 Java/Kotlin/C++/Rust 与不明确路径。 */
  private sourceOwner(source: any): Owner {
    const filename = String(source?.path || source?.name || '').toLowerCase();
    if (/[.](java|kt|kts)$/.test(filename)) return 'jvm';
    if (/[.](c|cc|cpp|cxx|h|hh|hpp|hxx|s|asm|rs)$/.test(filename)) return 'native';
    if (source?.sourceReference) return this.decode(source.sourceReference, 'source').owner;
    throw new Error('Unknown mixed source language: ' + filename);
  }

  /** 将子引用转为稳定且不碰撞的前端引用；零值仍为 DAP 的无引用，routing 测试覆盖相同子 ID。 */
  private encode(owner: Owner, kind: string, id: number): number {
    if (id === 0 && (kind === 'variable' || kind === 'source')) return 0;
    if (!Number.isSafeInteger(id) || id < 0) throw new Error('Invalid child ' + kind + ' reference');
    const key = owner + ':' + kind + ':' + id;
    let value = this.refKeys.get(key);
    if (!value) { value = this.reference++; this.refKeys.set(key, value); this.refs.set(value, { owner, kind, id }); }
    return value;
  }
  /** 解码时同时核对引用种类，未知/跨种类引用不发往任何后端；routing 测试断言拒绝。 */
  private decode(id: number, kind: string): Ref { const ref = this.refs.get(id); if (!ref || ref.kind !== kind) throw new Error('Unknown mixed ' + kind + ' reference: ' + id); return ref; }

  /** 递归还原请求中的所有引用，拒绝单个请求混用不同子后端；routing 测试覆盖 nested source 和错归属。 */
  private unmapArguments(owner: Owner, value: any): any {
    if (!value || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map(item => this.unmapArguments(owner, item));
    const result: any = {};
    for (const [key, child] of Object.entries(value)) {
      const kind = key === 'threadId' ? 'thread' : key === 'frameId' ? 'frame' : key === 'variablesReference' ? 'variable' : key === 'sourceReference' ? 'source' : undefined;
      if (kind && typeof child === 'number' && !(child === 0 && (kind === 'variable' || kind === 'source'))) {
        const ref = this.decode(child, kind);
        if (ref.owner !== owner) throw new Error('Mixed request combines different backend references');
        result[key] = ref.id;
      } else result[key] = this.unmapArguments(owner, child);
    }
    return result;
  }

  /** 递归改写 DAP 明确引用字段，frame/breakpoint 的 id 按所属数组上下文处理；routing 测试覆盖完整引用链。 */
  private mapBody(owner: Owner, value: any, context = ''): any {
    if (!value || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map(item => context === 'hitBreakpointIds' && typeof item === 'number' ? this.encode(owner, 'breakpoint', item) : this.mapBody(owner, item, context));
    const result: any = {};
    for (const [key, child] of Object.entries(value)) {
      const kind = key === 'threadId' ? 'thread' : key === 'frameId' ? 'frame' : key === 'variablesReference' ? 'variable' : key === 'sourceReference' ? 'source' : key === 'id' && context === 'stackFrames' ? 'frame' : key === 'id' && (context === 'breakpoints' || context === 'breakpoint') ? 'breakpoint' : undefined;
      result[key] = kind && typeof child === 'number' ? this.encode(owner, kind, child) : this.mapBody(owner, child, key);
    }
    return result;
  }
  /** 保留真实响应内容并还原前端 request_seq；startup/routing 测试核对失败正文和序号。 */
  private respond(request: DapMessage, response: Partial<DapResponse>): void { this.send({ ...response, seq: 0, type: 'response', request_seq: request.seq, command: request.command }); }
  /** 只重新分配传输序号，不制造调试事件；routing 测试核对 child 事件。 */
  private send(message: DapMessage): void { this.events.fire({ ...message, seq: this.sequence++ }); }
}
