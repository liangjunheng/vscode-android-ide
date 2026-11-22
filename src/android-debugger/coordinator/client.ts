import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import * as readline from 'node:readline';
import { findJava } from '../jvm-debugger/java';

type CoordinatorEvent = { type: string; value: string };
interface Pending { resolve: (value: string) => void; reject: (error: Error) => void; }
interface Session {
  child: ChildProcessWithoutNullStreams;
  reader: readline.Interface;
  closed: Promise<void>;
  pending: Map<string, Pending>;
  stderr: string;
  failure?: Error;
  exitCode?: number | null;
}

/** 功能：按请求ID复用Coordinator控制面，分离响应、异步事件和取消后的迟到响应；验证：android-coordinator.test.js。 */
export class AndroidDebugCoordinatorClient {
  private session?: Session;
  private starting?: Promise<Session>;
  private sequence = 0;
  private disposed = false;
  private readonly eventListeners = new Set<(event: CoordinatorEvent) => void>();

  constructor(private readonly extensionPath: string) {}

  /** 功能：发送独立请求并按ID结算；取消向Java回收同一请求拥有的租约；验证：android-coordinator.test.js。 */
  async command(operation: string, args: string[], signal?: AbortSignal, received?: (value: string) => void): Promise<string> {
    if (this.disposed) throw new Error('Android debug Coordinator is disposed');
    signal?.throwIfAborted();
    const session = await (this.starting ??= this.start().finally(() => { this.starting = undefined; }));
    if (this.disposed) throw new Error('Android debug Coordinator is disposed');
    signal?.throwIfAborted();
    return this.request(session, operation, args, signal, received);
  }

  /** 功能：订阅设备和Client事件，空闲时也可接收；输出可释放的订阅；验证：android-coordinator.test.js。 */
  onEvent(listener: (event: CoordinatorEvent) => void): { dispose: () => void } {
    this.eventListeners.add(listener);
    return { dispose: () => { this.eventListeners.delete(listener); } };
  }

  /** 功能：通过EOF结束自有Java服务，等待其释放租约，不停止共享ADB server；验证：android-coordinator.test.js。 */
  async dispose(): Promise<void> {
    this.disposed = true;
    const session = this.session ?? (this.starting ? await this.starting : undefined);
    if (!session) return;
    this.fail(session, new Error('Android debug Coordinator is disposed'));
    session.child.stdin.end();
    await session.closed;
    this.eventListeners.clear();
    if (session.exitCode !== 0) throw new Error('Android debug Coordinator shutdown failed (' + session.exitCode + '): ' + session.stderr);
  }

  /** 功能：为一次控制请求登记响应和取消处理，参数以Base64URL编码；验证：android-coordinator.test.js。 */
  private request(session: Session, operation: string, args: string[], signal?: AbortSignal, received?: (value: string) => void): Promise<string> {
    if (session.failure) return Promise.reject(session.failure);
    signal?.throwIfAborted();
    const id = String(++this.sequence);
    return new Promise<string>((resolve, reject) => {
      const finish = (error?: Error, value?: string) => {
        if (!session.pending.delete(id)) return;
        signal?.removeEventListener('abort', abort);
        if (error) reject(error); else resolve(value!);
      };
      let cancelling = false;
      const abort = () => {
        cancelling = true;
        const reason = signal?.reason;
        const error = reason instanceof Error ? reason : new Error('Android debug Coordinator request cancelled');
        void this.request(session, 'cancel', [id]).then(() => finish(error), cleanup => finish(new AggregateError([error, cleanup], 'Android cancellation cleanup failed')));
      };
      session.pending.set(id, { resolve: value => {
        if (cancelling) return;
        try { received?.(value); finish(undefined, value); } catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
      }, reject: error => { if (!cancelling || session.failure) finish(error); } });
      signal?.addEventListener('abort', abort, { once: true });
      session.child.stdin.write([id, operation, ...args.map(arg => Buffer.from(arg, 'utf8').toString('base64url'))].join('\t') + '\n', error => {
        if (error) this.fail(session, error);
      });
    });
  }

  /** 功能：使同一进程的全部未完成请求显式失败；验证：android-coordinator.test.js。 */
  private fail(session: Session, error: Error): void {
    const first = !session.failure;
    session.failure ??= error;
    for (const pending of [...session.pending.values()]) pending.reject(session.failure);
    if (first && !this.disposed) for (const listener of this.eventListeners) listener({ type: 'coordinator.lost', value: error.message });
  }

  /** 功能：检查逐行协议并按请求ID或事件类型分发，不将迟到响应交给后续请求；验证：android-coordinator.test.js。 */
  private receive(session: Session, line: string): void {
    const fields = line.split('\t');
    const decode = (text: string): string => {
      if (!/^[A-Za-z0-9_-]*$/.test(text)) throw new Error('Invalid Android Coordinator Base64URL payload');
      return Buffer.from(text, 'base64url').toString('utf8');
    };
    try {
      if (fields.length === 4 && fields[0] === '0' && fields[1] === 'EVENT') {
        const event = { type: decode(fields[2]), value: decode(fields[3]) };
        for (const listener of this.eventListeners) listener(event);
        return;
      }
      if (fields.length !== 3 || !/^[1-9]\d*$/.test(fields[0]) || !['OK', 'ERROR'].includes(fields[1])) throw new Error('Invalid Android Coordinator response');
      const value = decode(fields[2]);
      const pending = session.pending.get(fields[0]);
      if (!pending) return;
      if (fields[1] === 'ERROR') pending.reject(new Error(value)); else pending.resolve(value);
    } catch (error) {
      this.fail(session, error instanceof Error ? error : new Error(String(error)));
      session.child.stdin.end();
    }
  }

  /** 功能：使用已验证JDK启动独占服务并关联管道、错误和退出；验证：android-coordinator.test.js。 */
  private async start(): Promise<Session> {
    if (this.session) return this.session;
    const jar = path.join(this.extensionPath, 'resources', 'jvm-debugger', 'android-debug-coordinator.jar');
    if (!fs.existsSync(jar)) throw new Error('Android debug Coordinator JAR is missing: ' + jar);
    const runtime = await findJava(process.env.JAVA_HOME);
    if (this.disposed) throw new Error('Android debug Coordinator is disposed');
    const child = spawn(runtime.java, ['-jar', jar], { stdio: 'pipe', windowsHide: true });
    const reader = readline.createInterface({ input: child.stdout });
    const session: Session = { child, reader, closed: Promise.resolve(), pending: new Map(), stderr: '' };
    this.session = session;
    session.closed = new Promise(resolve => child.once('close', code => {
      session.exitCode = code;
      this.fail(session, new Error('Android debug Coordinator exited (' + code + '): ' + session.stderr));
      reader.close();
      resolve();
    }));
    reader.on('line', line => this.receive(session, line));
    child.stderr.on('data', chunk => {
      const text = String(chunk);
      session.stderr = (session.stderr + text).slice(-8192);
      console.warn('[Android debug Coordinator] ' + text.trimEnd());
    });
    child.stdin.on('error', error => this.fail(session, error));
    child.on('error', error => this.fail(session, error));
    return session;
  }
}
