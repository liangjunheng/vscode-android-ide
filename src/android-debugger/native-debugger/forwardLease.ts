import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

interface ForwardBackend {
  getForwardList(): Promise<string[]>;
  removePortForward(port: number): Promise<unknown>;
}
interface Forward { serial: string; local: string; remote: string; }

/** 功能：解析ADB快照为精确三元组；输入逐行设备映射；输出映射列表；验证：native-forward-lease.test.js。 */
function forwards(lines: string[]): Forward[] {
  return lines.flatMap(line => line.split(/\r?\n/)).filter(line => line.trim()).map(line => {
    const fields = line.trim().split(/\s+/);
    if (fields.length !== 3 || !/^tcp:\d+$/.test(fields[1])) throw new Error('Invalid ADB forward row: ' + line);
    return { serial: fields[0], local: fields[1], remote: fields[2] };
  });
}

/** CodeLLDB自己创建转发；独立平台日志只记录该实例的所有权证明。 */
export class NativeForwardLease {
  private closing?: Promise<void>;

  /** 功能：保存会话基线及独占日志目录；输入设备与ADB边界；输出自有转发账本；验证：native-forward-lease.test.js。 */
  private constructor(private readonly serial: string, private readonly backend: ForwardBackend, private readonly baseline: Forward[], private readonly directory: string, readonly logFile: string) {}

  /** 功能：在CodeLLDB启动前取得基线并创建独占空日志；输入设备与ADB；输出资源所有者；验证：native-forward-lease.test.js。 */
  static async create(serial: string, backend: ForwardBackend): Promise<NativeForwardLease> {
    const baseline = forwards(await backend.getForwardList());
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'android-native-forward-'));
    const logFile = path.join(directory, 'platform.log');
    try { await fs.writeFile(logFile, ''); }
    catch (error) { await fs.rm(directory, { recursive: true }); throw error; }
    return new NativeForwardLease(serial, backend, baseline, directory, logFile);
  }

  /** 功能：生成当前适配器独占日志命令；输出带转义路径的LLDB命令；验证：native-forward-lease.test.js。 */
  get command(): string { return 'log enable -f "' + this.logFile.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '" lldb platform'; }

  /** 功能：仅释放日志证明且当前仍匹配的自有映射；输出幂等结果和全部错误，失败保留日志证据；验证：native-forward-lease.test.js及真机精确基线断言。 */
  close(): Promise<void> {
    return this.closing ??= (async () => {
      const text = await fs.readFile(this.logFile, 'utf8');
      const owned = new Map<string, Forward>();
      let device: string | undefined;
      for (const line of text.split(/\r?\n/)) {
        const connected = /Connected to Android device "([^"]+)"/.exec(line);
        if (/Connected to Android device/.test(line) && !connected) throw new Error('Unrecognized Native device ownership record; evidence: ' + this.logFile);
        if (connected) device = connected[1];
        const socket = /Forwarding remote socket "([^"]+)" to local TCP port (\d+)/.exec(line);
        const tcp = /Forwarding remote TCP port (\d+) to local TCP port (\d+)/.exec(line);
        if (device === this.serial && /Forwarding remote/.test(line) && !socket && !tcp) throw new Error('Unrecognized Native forward ownership record; evidence: ' + this.logFile);
        if ((!socket && !tcp) || device !== this.serial) continue;
        const port = Number((socket ?? tcp)![2]);
        if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid owned Native forward port');
        const local = 'tcp:' + port;
        if (this.baseline.some(row => row.serial === this.serial && row.local === local)) continue;
        const remote = socket ? 'localabstract:' + socket[1] : 'tcp:' + tcp![1];
        const existing = owned.get(local);
        if (existing && existing.remote !== remote) throw new Error('Native forward reused within one session: ' + local);
        owned.set(local, { serial: this.serial, local, remote });
      }
      if (owned.size === 0) {
        const current = forwards(await this.backend.getForwardList());
        const unproven = current.filter(row => row.serial === this.serial && !this.baseline.some(previous => previous.serial === row.serial && previous.local === row.local && previous.remote === row.remote));
        if (unproven.length) throw new Error('Native forward ownership evidence is missing; no mappings removed; evidence: ' + this.logFile);
      }
      const errors: unknown[] = [];
      for (const row of owned.values()) {
        try {
          const current = forwards(await this.backend.getForwardList()).find(item => item.serial === row.serial && item.local === row.local);
          if (!current) continue;
          if (current.remote !== row.remote) throw new Error('Native forward ownership changed: ' + row.local);
          await this.backend.removePortForward(Number(row.local.slice(4)));
        } catch (error) { errors.push(error); }
      }
      if (errors.length) throw new AggregateError(errors, 'Native forward cleanup failed; evidence: ' + this.logFile);
      await fs.rm(this.directory, { recursive: true });
    })();
  }
}
