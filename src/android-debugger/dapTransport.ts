import { ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import * as path from 'node:path';

/** DAP 线上的 JSON 消息；不解释 JVM/Native 的调试语义。 */
export interface DapMessage {
  seq: number;
  type: 'request' | 'response' | 'event';
  command?: string;
  arguments?: unknown;
  request_seq?: number;
  success?: boolean;
  message?: string;
  event?: string;
  body?: any;
}

export interface DapResponse extends DapMessage {
  type: 'response';
  request_seq: number;
  success: boolean;
}

/** 后端子进程的只读所有权证明；startIdentity 必须来自 spawn 后的进程实例检查，不能只由 PID 推断。 */
export interface DapProcessIdentity {
  readonly pid: number;
  readonly executablePath: string;
  readonly argvHash: string;
  readonly startIdentity: string;
}

/** 输入已 spawn 的 child，输出包含 PID、canonical executable、完整 argv 哈希和启动身份的证明。 */
export type DapProcessIdentityInspector = (child: ChildProcessWithoutNullStreams) => DapProcessIdentity;

/**
 * 检查真实子进程的启动身份；Linux 使用 /proc starttime，其他平台使用与 child 实例绑定的不可复用 token。
 * 回归入口：android-dap-transport identity 用例断言 canonical 路径、argv 哈希、start identity 及 close 后保持只读。
 */
export function inspectDapProcessIdentity(child: ChildProcessWithoutNullStreams): DapProcessIdentity {
  const pid = child.pid ?? -1;
  const spawnfile = child.spawnfile;
  const executablePath = spawnfile ? realpathSync(spawnfile) : 'synthetic-child';
  const argv = Array.isArray(child.spawnargs) ? child.spawnargs.map(String) : [spawnfile];
  const argvHash = createHash('sha256').update(JSON.stringify(argv)).digest('hex');
  let startIdentity: string | undefined;
  if (pid > 0 && typeof process !== 'undefined' && process.platform === 'linux') {
    const stat = readFileSync('/proc/' + pid + '/stat', 'utf8');
    const end = stat.lastIndexOf(')');
    const fields = stat.slice(end + 2).split(' ');
    if (!fields[19]) throw new Error('DAP backend start identity unavailable');
    startIdentity = 'linux-proc-starttime:' + fields[19];
  } else {
    startIdentity = 'child-instance:' + randomUUID();
  }
  return Object.freeze({ pid, executablePath: spawnfile ? path.resolve(executablePath) : executablePath, argvHash, startIdentity });
}

/**
 * 单个后端进程的 DAP 字节传输；构造即转移进程所有权，禁止传入共享进程。
 * 输出 message（全部消息）、event、request、diagnostic（stderr Buffer）、close（终止 Error）。
 * 回归入口：node --test tests/android-dap-transport.test.js；不模拟任何虚拟机调试行为。
 */
export class DapTransport extends EventEmitter {
  private sequence = 1;
  private buffer = Buffer.alloc(0);
  private contentLength: number | undefined;
  private terminalError?: Error;
  private resolveClosed!: () => void;
  private readonly closed = new Promise<void>(resolve => { this.resolveClosed = resolve; });
  private readonly pending = new Map<number, { resolve: (value: DapResponse) => void; reject: (error: Error) => void }>();
  /** spawn 后固定的只读所有权证明；dispose/close 不会重算或清空身份。 */
  readonly identity: DapProcessIdentity;

  /** 输入独占且未设置文本编码的管道子进程，输出监听中的传输；framing/lifecycle 测试断言分片解析与清理。 */
  constructor(private readonly child: ChildProcessWithoutNullStreams, identityInspector: DapProcessIdentityInspector = inspectDapProcessIdentity) {
    super();
    this.identity = Object.freeze(identityInspector(child));
    child.stdout.on('data', this.onData);
    child.stderr.on('data', this.onDiagnostic);
    child.on('error', this.onError);
    child.on('close', this.onClose);
    child.stdin.on('error', this.onError);
    child.stdout.on('error', this.onError);
    child.stderr.on('error', this.onError);
  }

  /** 输入已解析的可执行文件、参数和环境，输出独占后端；launch 测试断言 shell:false 和原样参数，无命令插值。 */
  static launch(command: string, args: string[] = [], options: { cwd?: string; env?: NodeJS.ProcessEnv; inspectIdentity?: DapProcessIdentityInspector; onIdentity?: (identity: DapProcessIdentity) => void } = {}): DapTransport {
    const { inspectIdentity = inspectDapProcessIdentity, onIdentity, ...spawnOptions } = options;
    const child = spawn(command, args, { ...spawnOptions, shell: false, stdio: 'pipe' });
    const transport = new DapTransport(child, inspectIdentity);
    // 输入已 spawn 的 child，输出身份证明后立即登记；adapter ledger 可在此回调中保存精确所有权记录。
    onIdentity?.(transport.identity);
    return transport;
  }

  /** 输入命令与 JSON 参数，输出匹配 request_seq 的响应 Promise；responses/failures 测试断言并发匹配、失败拒绝和终止后拒绝。 */
  async request(command: string, arguments_?: unknown): Promise<DapResponse> {
    if (this.terminalError) throw this.terminalError;
    const seq = this.sequence++;
    return new Promise<DapResponse>((resolve, reject) => {
      this.pending.set(seq, { resolve, reject });
      try {
        this.send({ seq, type: 'request', command, arguments: arguments_ });
      } catch (error) {
        this.pending.delete(seq);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  /** 输入完整 JSON 消息，输出 UTF-8 字节长度帧到 stdin；encoding/reverse 测试断言字节数、反向响应及写入错误传播。 */
  send(message: DapMessage): void {
    if (this.terminalError) throw this.terminalError;
    const body = Buffer.from(JSON.stringify(message), 'utf8');
    const frame = Buffer.concat([Buffer.from('Content-Length: ' + body.length + '\r\n\r\n', 'ascii'), body]);
    try {
      // 输入异步写入结果；失败时拒绝所有等待请求，错误监听保留至进程实际关闭。
      this.child.stdin.write(frame, error => {
        if (error) this.finish(error, true);
      });
    } catch (error) {
      this.finish(error instanceof Error ? error : new Error(String(error)), true);
      throw error;
    }
  }

  /** 无输入；立即拒绝等待请求并仅 kill 独占进程，输出等待实际 close/监听清理的 Promise；dispose/real-child 测试断言所有权和真实退出。 */
  dispose(): Promise<void> {
    this.finish(new Error('DAP transport disposed'), true);
    return this.closed;
  }

  /** 输入任意 stdout 字节片段，累积后解析零到多帧；framing/invalid 测试断言拆包粘包、UTF-8 和非法帧终止。 */
  private readonly onData = (chunk: Buffer): void => {
    if (this.terminalError) return;
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (!this.terminalError) {
      if (this.contentLength === undefined) {
        const end = this.buffer.indexOf('\r\n\r\n');
        if (end < 0) return;
        const headers = this.buffer.subarray(0, end).toString('ascii').split('\r\n');
        const lengths = headers.filter(header => /^Content-Length:/i.test(header));
        const value = lengths.length === 1 ? lengths[0].slice(lengths[0].indexOf(':') + 1).trim() : '';
        const length = Number(value);
        if (!/^\d+$/.test(value) || !Number.isSafeInteger(length) || length <= 0) {
          this.finish(new Error('Invalid DAP Content-Length'), true);
          return;
        }
        this.contentLength = length;
        this.buffer = this.buffer.subarray(end + 4);
      }
      if (this.buffer.length < this.contentLength) return;
      const body = this.buffer.subarray(0, this.contentLength);
      this.buffer = this.buffer.subarray(this.contentLength);
      this.contentLength = undefined;
      let message: DapMessage;
      try {
        message = JSON.parse(body.toString('utf8'));
        if (!message || !Number.isSafeInteger(message.seq) || !['request', 'response', 'event'].includes(message.type)) {
          throw new Error('Invalid DAP message');
        }
      } catch (error) {
        this.finish(new Error('Invalid DAP JSON message: ' + String(error)), true);
        return;
      }
      this.receive(message);
    }
  };

  /** 输入已解析 DAP 消息，先结算请求再发布原始消息及事件/反向请求；responses/reverse 测试断言不伪造响应或调试状态。 */
  private receive(message: DapMessage): void {
    if (message.type === 'response') {
      const pending = this.pending.get(message.request_seq!);
      if (pending) {
        this.pending.delete(message.request_seq!);
        if (message.success === true) pending.resolve(message as DapResponse);
        else pending.reject(Object.assign(new Error(message.message || 'DAP request failed: ' + message.command), { response: message }));
      }
    }
    this.emit('message', message);
    if (message.type === 'event' || message.type === 'request') this.emit(message.type, message);
  }

  /** 输入 stderr 字节，输出独立 diagnostic，不送入协议解析；stderr 测试断言诊断与事件分离。 */
  private readonly onDiagnostic = (chunk: Buffer): void => { this.emit('diagnostic', chunk); };

  /** 输入进程/流错误，输出所有等待请求的拒绝与一次 close；failures 测试断言错误身份与清理。 */
  private readonly onError = (error: Error): void => { this.finish(error, true); };

  /** 输入实际退出码/信号，结算请求并移除自有监听，最后完成 dispose；failures/real-child 测试断言 close 前不提前释放。 */
  private readonly onClose = (code: number | null, signal: NodeJS.Signals | null): void => {
    this.finish(new Error('DAP backend closed (code ' + code + ', signal ' + signal + ')'), false);
    this.child.stdout.off('data', this.onData);
    this.child.stderr.off('data', this.onDiagnostic);
    this.child.off('error', this.onError);
    this.child.off('close', this.onClose);
    this.child.stdin.off('error', this.onError);
    this.child.stdout.off('error', this.onError);
    this.child.stderr.off('error', this.onError);
    this.resolveClosed();
    this.emit('close', this.terminalError);
    this.removeAllListeners();
  };

  /** 输入终止原因及 kill 条件，立即拒绝全部请求但保留错误监听至实际 close；invalid/failures/dispose 测试断言无早退或重复 kill。 */
  private finish(error: Error, kill: boolean): void {
    if (this.terminalError) return;
    this.terminalError = error;
    this.buffer = Buffer.alloc(0);
    this.contentLength = undefined;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    if (kill && this.child.exitCode === null && this.child.signalCode === null && !this.child.killed) this.child.kill();
  }
}
