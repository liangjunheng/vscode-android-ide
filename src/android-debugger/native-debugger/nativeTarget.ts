import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

/** 输入由实际进程 ELF 确定的 ABI 和绝对工具路径；仅支持 debuggable 应用，不使用 root/su。 */
export interface NativeTargetOptions {
  adbPath: string;
  serverPath: string;
  serial: string;
  packageName: string;
  pid: number;
  abi: 'arm64-v8a' | 'armeabi-v7a' | 'x86' | 'x86_64';
  signal?: AbortSignal;
  /** 在精确身份已由启动/forward 返回后登记资源；返回值不影响资源清理。 */
  acquireServer?: (identity: NativeServerIdentity) => Promise<void>;
  acquireForward?: (identity: AdbForwardIdentity) => Promise<void>;
  /** 全部物理清理成功后确认精确身份已释放；失败时不调用，账本必须保留记录。 */
  releaseServer?: (identity: NativeServerIdentity) => Promise<void>;
  releaseForward?: (identity: AdbForwardIdentity) => Promise<void>;
}

/** 远端 lldb-server 的完整身份；PID、argv、socket 和目标身份共同证明同一资源。 */
export interface NativeServerIdentity {
  serial: string;
  pid: number;
  executable: string;
  argv: readonly string[];
  socket: string;
  targetIdentity: string;
  startIdentity: string;
}

/** adb forward 的完整传输身份；transportIdentity 必须来自同一次 forward 操作。 */
export interface AdbForwardIdentity {
  serial: string;
  local: string;
  remote: string;
  transportIdentity: string;
}

/** 输出已监听的连接地址及可审计精确身份；dispose 必须 await，重复调用共享同一个结果。 */
export interface NativeTarget {
  endpoint: string;
  serverIdentity?: NativeServerIdentity;
  forwardIdentity?: AdbForwardIdentity;
  dispose(): Promise<void>;
}

/** 输入单个 shell token，输出 POSIX 引用；safe argv 用例覆盖每项及内嵌单引号。 */
function quote(value: string): string { return "'" + value.replace(/'/g, "'\\''") + "'"; }

/** 输入远端 argv，输出逐项引用的命令；safe argv 用例断言不经过本机 shell。 */
function shell(tokens: string[]): string { return tokens.map(quote).join(' '); }

/** 输入选项，纯校验后无输出；invalid inputs 断言错误在全部 IO 之前拒绝。 */
function validate(options: NativeTargetOptions): void {
  if (!options || typeof options !== 'object') throw new Error('Native target options are required');
  for (const key of ['adbPath', 'serverPath'] as const) {
    const value = options[key];
    if (typeof value !== 'string' || /[\x00-\x1f\x7f]/.test(value) || !path.isAbsolute(value)) throw new Error('Invalid ' + key);
  }
  if (typeof options.serial !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:\[\]-]*$/.test(options.serial)) throw new Error('Invalid serial');
  if (typeof options.packageName !== 'string' || !/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/.test(options.packageName)) throw new Error('Invalid packageName');
  if (!Number.isSafeInteger(options.pid) || options.pid <= 0 || options.pid > 2147483647) throw new Error('Invalid pid');
  if (!['arm64-v8a', 'armeabi-v7a', 'x86', 'x86_64'].includes(options.abi)) throw new Error('Invalid process ELF abi');
  if (options.signal !== undefined && !(options.signal instanceof AbortSignal)) throw new Error('Invalid signal');
}

/** 输入工具和实际进程 ABI，核实普通文件和服务端 ELF；ELF 用例断言 32/64 位匹配及句柄关闭错误。 */
async function validateFiles(options: NativeTargetOptions): Promise<void> {
  for (const file of [options.adbPath, options.serverPath]) {
    if (!(await fs.stat(file)).isFile()) throw new Error('Not a regular file: ' + file);
  }
  const handle = await fs.open(options.serverPath, 'r');
  let failure: unknown;
  try {
    const header = Buffer.alloc(20);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    const expected = { 'arm64-v8a': [2, 183], 'armeabi-v7a': [1, 40], x86: [1, 3], x86_64: [2, 62] }[options.abi];
    if (bytesRead !== 20 || header.readUInt32BE(0) !== 0x7f454c46 || header[5] !== 1 || header[4] !== expected[0] || header.readUInt16LE(18) !== expected[1]) throw new Error('lldb-server ELF does not match process ABI ' + options.abi);
  } catch (error) { failure = error; }
  try { await handle.close(); } catch (error) {
    if (failure) throw new AggregateError([failure, error], 'ELF validation and close failed');
    throw error;
  }
  if (failure) throw failure;
}

/** 输入 adb argv，输出成功 stdout；command failures 断言 error/非零状态失败，且等待 close 并保留 stderr。 */
function command(adb: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(adb, args, { shell: false, windowsHide: true, stdio: 'pipe' });
    let output = '';
    let diagnostics = '';
    let failure: Error | undefined;
    child.stdout.on('data', chunk => { output += chunk.toString(); });
    child.stderr.on('data', chunk => { diagnostics += chunk.toString(); });
    child.on('error', error => { failure = error; });
    child.once('close', (code, signal) => {
      if (failure) reject(failure);
      else if (code !== 0) reject(new Error('adb failed (' + code + '/' + signal + '): ' + diagnostics));
      else resolve(output);
    });
    child.stdin.end();
  });
}

/**
 * 输入私有 server/socket 和应用 PID，输出持有子进程的监督脚本；stdin/EOF 只终止服务器，不杀应用。
 * safe argv/cancellation/awaited close 用例断言脚本、关闭顺序；143 为受控 SIGTERM 的 wait 状态。
 */
function serverScript(server: string, socket: string, pid: number, startIdentity: string): string {
  return [
    'exec 4<&0',
    shell([server, 'gdbserver', '--pipe', '3', 'unix://' + socket, '--attach', String(pid)]) + ' 3>&1 1>&2 &',
    'server=$!',
    'printf %s\\0%s\\0%s\\0 ' + quote(socket) + ' \"$server\" ' + quote(startIdentity),
    '( ' + shell(['read', '-r', 'stop']) + ' <&4; ' + shell(['kill', '-TERM']) + ' "$server" ) <&4 &',
    'controller=$!',
    shell(['wait']) + ' "$server"',
    'status=$?',
    'if ' + shell(['test']) + ' "$status" ' + shell(['-eq', '143']) + '; then',
    '  ' + shell(['wait']) + ' "$controller" || ' + shell(['exit', '70']),
    '  ' + shell(['exit', '0']),
    'fi',
    shell(['kill', '-TERM']) + ' "$controller" || ' + shell(['exit', '70']),
    shell(['wait']) + ' "$controller"',
    shell(['exit']) + ' "$status"'
  ].join('\n');
}

/**
 * 输入目标身份和实际进程 ELF ABI，输出就绪 endpoint 与 awaited dispose；run-as pwd 核实 debuggable 私有目录。
 * UUID 仅标识资源所有权；tcp:0 原子分配端口；失败/取消逆序清理并聚合错误，无轮询/重试。
 * 回归：node --test tests/android-native-target.test.js，断言 argv/ELF/隔离/回滚/取消/关闭/聚合错误。
 * 真机前置：已运行可调试应用、调用方已读取实际 PID 的 ELF 并选择对应服务端，不查询 device abilist。
 */
export async function prepareNativeTarget(options: NativeTargetOptions): Promise<NativeTarget> {
  validate(options);
  // 输入取消信号，在不可分割的资源登记边界抛出；cancellation 用例断言未丢失已产生的副作用。
  const check = (): void => { options.signal?.throwIfAborted(); };
  check();
  await validateFiles(options);
  check();
  const base = ['-s', options.serial];
  // 输入本地 argv，输出命令结果；safe argv/rollback 用例断言串号选择及每个副作用。
  const run = (args: string[]): Promise<string> => command(options.adbPath, [...base, ...args]);
  // 输入远端 argv，输出引用后执行结果；safe argv 用例核实 token 编码。
  const remote = (tokens: string[]): Promise<string> => run(['shell', shell(tokens)]);
  // 输入应用命令，输出 run-as 结果；not debuggable 用例断言失败不会尝试提权。
  const asApp = (tokens: string[]): Promise<string> => remote(['run-as', options.packageName, ...tokens]);
  const appDirectory = (await asApp(['pwd'])).trim();
  if (!/^\/(?:data\/user\/\d+|data\/data)\/[A-Za-z0-9_.]+$/.test(appDirectory) || appDirectory.split('/').pop() !== options.packageName) throw new Error('Invalid run-as application directory: ' + appDirectory);
  check();
  const id = randomUUID();
  const pushed = '/data/local/tmp/dta-' + id;
  const directory = appDirectory + '/dta-' + id;
  const server = directory + '/server';
  const socket = directory + '/s';
  if (Buffer.byteLength(socket) > 107) throw new Error('Application socket path exceeds Unix socket limit');
  const cleanup: Array<() => Promise<unknown>> = [];
  const confirmations: Array<() => Promise<void>> = [];
  let disposal: Promise<void> | undefined;
  // 输入无参数，输出共享 Promise；rollback/dispose 断言逆序、全部尝试、聚合错误和幂等。
  const dispose = (): Promise<void> => {
    if (!disposal) disposal = (async () => {
      const errors: unknown[] = [];
      for (const release of cleanup.reverse()) { try { await release(); } catch (error) { errors.push(error); } }
      // ledger confirmation 回归：全部物理清理成功后才确认释放；任一失败均保留账本所有权。
      if (!errors.length) for (const confirm of confirmations.reverse()) { try { await confirm(); } catch (error) { errors.push(error); } }
      if (errors.length) throw new AggregateError(errors, 'Native target cleanup failed');
    })();
    return disposal;
  };
  try {
    cleanup.push(() => remote(['rm', '-f', pushed]));
    await run(['push', options.serverPath, pushed]);
    check();
    await asApp(['mkdir', '-m', '700', directory]);
    cleanup.push(() => asApp(['rm', '-rf', directory]));
    check();
    await asApp(['cp', pushed, server]);
    check();
    await asApp(['chmod', '700', server]);
    check();
    const child = spawn(options.adbPath, [...base, 'shell', shell(['run-as', options.packageName, 'sh', '-c', serverScript(server, socket, options.pid, id)])], { shell: false, windowsHide: true, stdio: 'pipe' });
    let closed = false;
    let processError: Error | undefined;
    let stderr = '';
    let readyData = Buffer.alloc(0);
    let serverIdentity: NativeServerIdentity | undefined;
    let forwardIdentity: AdbForwardIdentity | undefined;
    let readyResolve!: () => void;
    let readyReject!: (error: unknown) => void;
    const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
    // 输入 stdout 字节，收到匹配的 NUL 结尾 socket 才输出就绪；split readiness 用例覆盖分片/错误 socket。
    const onData = (chunk: Buffer): void => {
      readyData = Buffer.concat([readyData, chunk]);
      const end = readyData.indexOf(0);
      if (end < 0) return;
      // Windows ADB shell may normalize line endings before NUL framing; remove only the transport CR, never alter the socket identity itself.
      const announcedSocket = readyData.subarray(0, end).toString().replace(/\r$/, '');
      if (announcedSocket !== socket) { child.stdout.off('data', onData); readyReject(new Error('Unexpected lldb-server readiness socket')); return; }
      const pidEnd = readyData.indexOf(0, end + 1);
      const startEnd = pidEnd < 0 ? -1 : readyData.indexOf(0, pidEnd + 1);
      if (pidEnd >= 0 && startEnd >= 0) {
        const remotePid = Number(readyData.subarray(end + 1, pidEnd).toString());
        const startIdentity = readyData.subarray(pidEnd + 1, startEnd).toString();
        if (Number.isSafeInteger(remotePid) && remotePid > 0 && startIdentity) serverIdentity = { serial: options.serial, pid: remotePid, executable: server, argv: [server, 'gdbserver', '--pipe', '3', 'unix://' + socket, '--attach', String(options.pid)], socket, targetIdentity: options.packageName + ':' + options.pid, startIdentity };
      }
      child.stdout.off('data', onData);
      readyResolve();
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.on('error', error => { processError = error; });
    const close = new Promise<Error | undefined>(resolve => child.once('close', (code, signal) => {
      closed = true;
      child.stdout.off('data', onData);
      const error = processError || (code === 0 ? undefined : new Error('lldb-server closed (' + code + '/' + signal + '): ' + stderr));
      readyReject(error || new Error('lldb-server closed before readiness'));
      resolve(error);
    }));
    cleanup.push(async () => {
      if (!closed) child.stdin.end('stop\n');
      const error = await close;
      if (error) throw error;
    });
    // 输入 abort，只拒绝准备等待；外层 await dispose 负责关闭；cancellation 用例断言回滚完成后才拒绝。
    const onAbort = (): void => readyReject(options.signal!.reason);
    options.signal?.addEventListener('abort', onAbort, { once: true });
    try { check(); await ready; check(); }
    finally { options.signal?.removeEventListener('abort', onAbort); }
    if (options.acquireServer) {
      if (!serverIdentity) throw new Error('Exact lldb-server identity unavailable');
      await options.acquireServer(serverIdentity);
      if (options.releaseServer) confirmations.push(() => options.releaseServer!(serverIdentity!));
    }
    const portText = (await run(['forward', 'tcp:0', 'localfilesystem:' + socket])).trim();
    if (!/^[1-9]\d{0,4}$/.test(portText) || Number(portText) > 65535) throw new Error('Invalid adb allocated port: ' + portText);
    forwardIdentity = { serial: options.serial, local: 'tcp:' + portText, remote: 'localfilesystem:' + socket, transportIdentity: createHash('sha256').update(JSON.stringify({ serial: options.serial, local: 'tcp:' + portText, remote: 'localfilesystem:' + socket, allocated: portText })).digest('hex') };
    cleanup.push(() => run(['forward', '--remove', forwardIdentity!.local]));
    if (options.acquireForward) {
      await options.acquireForward(forwardIdentity);
      if (options.releaseForward) confirmations.push(() => options.releaseForward!(forwardIdentity!));
    }
    check();
    if (closed) throw new Error('lldb-server closed during forwarding');
    return { endpoint: 'connect://127.0.0.1:' + portText, serverIdentity, forwardIdentity, dispose };
  } catch (error) {
    try { await dispose(); } catch (cleanupError) {
      throw new AggregateError([error, ...(cleanupError as AggregateError).errors], 'Native target preparation and cleanup failed');
    }
    throw error;
  }
}
