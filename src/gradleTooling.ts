import * as fs from 'node:fs';
import * as path from 'node:path';
import { ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import * as readline from 'node:readline';
import type { Disposable } from 'vscode';

interface Pending { resolve: (line: string) => void; reject: (error: Error) => void; }
interface Session {
  child: ChildProcessWithoutNullStreams;
  reader: readline.Interface;
  closed: Promise<void>;
  pending?: Pending;
  stderr: string;
}

// 独占查询复用长驻Tooling API进程，不缓存模型、不调用AGP API；gradle-tooling.test.js覆盖协议、取消、关闭及错误。
export class GradleToolingClient implements Disposable {
  private session?: Session;
  private disposed = false;

  constructor(private readonly extensionPath: string) {}

  // 输入项目root与操作signal，返回真实任务路径；取消等待服务响应后才释放请求所有权，错误不降级。
  async query(root: string, signal: AbortSignal): Promise<string[]> {
    if (this.disposed) throw new Error('Gradle Tooling API client is disposed');
    signal.throwIfAborted();
    const session = this.session ?? this.start();
    if (session.pending) throw new Error('A Gradle Tooling API query is already running');
    return new Promise<string[]>((resolve, reject) => {
      const abort = () => { session.child.stdin.write('C\n'); };
      const finish = () => { signal.removeEventListener('abort', abort); session.pending = undefined; };
      session.pending = {
        resolve: line => {
          finish();
          try {
            signal.throwIfAborted();
            const parts = line.split('\t');
            if (parts[0] === 'E' && parts.length === 2) throw new Error(Buffer.from(parts[1], 'base64url').toString('utf8'));
            if (parts[0] !== 'S' || parts.length !== 3 || Buffer.from(parts[1], 'base64url').toString('utf8') !== root) throw new Error('Invalid Gradle Tooling API response');
            const tasks = Buffer.from(parts[2], 'base64url').toString('utf8').split('\n').filter(Boolean);
            if (tasks.some(task => !/^:(?:[^:\r\n]+:)*[^:\r\n]+$/.test(task))) throw new Error('Invalid Gradle task path');
            resolve(tasks);
          } catch (error) { reject(error); }
        },
        reject: error => { finish(); reject(error); },
      };
      signal.addEventListener('abort', abort, { once: true });
      session.child.stdin.write('Q\t' + Buffer.from(root, 'utf8').toString('base64url') + '\n');
    });
  }

  // EOF通知服务取消并关闭它拥有的连接，等待进程close；不停止其他IDE拥有的Gradle daemon。
  async dispose(): Promise<void> {
    this.disposed = true;
    const session = this.session;
    if (!session) return;
    session.child.stdin.end();
    await session.closed;
  }

  // 启动打包的独立服务并绑定会话所有权；启动、管道和退出错误均传给当前请求。
  private start(): Session {
    const jar = path.join(this.extensionPath, 'resources', 'gradle-tooling-server.jar');
    if (!fs.statSync(jar).isFile()) throw new Error('Gradle Tooling API server is not a file: ' + jar);
    const javaHome = process.env.JAVA_HOME;
    const java = javaHome ? path.join(javaHome, 'bin', process.platform === 'win32' ? 'java.exe' : 'java') : 'java';
    const child = spawn(java, ['-jar', jar], { stdio: 'pipe', windowsHide: true });
    const reader = readline.createInterface({ input: child.stdout });
    const session: Session = { child, reader, closed: Promise.resolve(), stderr: '' };
    session.closed = new Promise<void>(resolve => child.once('close', code => {
      session.pending?.reject(new Error('Gradle Tooling API server exited (' + code + '): ' + session.stderr));
      reader.close();
      if (this.session === session) this.session = undefined;
      resolve();
    }));
    reader.on('line', line => session.pending?.resolve(line));
    child.stderr.on('data', chunk => { session.stderr = (session.stderr + chunk.toString()).slice(-8192); });
    child.stdin.on('error', error => { session.pending?.reject(error); });
    child.once('error', error => { session.pending?.reject(error); });
    this.session = session;
    return session;
  }
}
