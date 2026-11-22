import { AndroidDebugCoordinatorClient } from './client';

export interface AndroidClient { pid: number; packageName: string; }

/** 统一设备控制面和会话资源账本，DAP 引擎仍由各自宿主提供。 */
export class AndroidCoordinator {
  private readonly client: AndroidDebugCoordinatorClient;
  private readonly sessions = new Set<AndroidDebugSession>();

  constructor(extensionPath: string) { this.client = new AndroidDebugCoordinatorClient(extensionPath); }

  /** 功能：建立独占调试生命周期；输入设备及失联回调；输出统一资源账本；验证：android-coordinator.test.js。 */
  session(serial: string, lost: (error: Error) => void): AndroidDebugSession {
    const session = new AndroidDebugSession(this, serial, lost, () => this.sessions.delete(session));
    this.sessions.add(session);
    return session;
  }

  /** 功能：订阅控制面事件；输入事件监听器；输出可释放订阅；验证：android-coordinator.test.js。 */
  onEvent(listener: (event: { type: string; value: string }) => void): { dispose(): void } { return this.client.onEvent(listener); }

  /** 功能：查询已完成初始同步的设备；输入取消信号；输出设备快照；验证：android-coordinator.test.js。 */
  async devices(signal?: AbortSignal): Promise<Array<{ serial: string; state: string }>> {
    const text = await this.client.command('devices', [], signal);
    return text.split('\n').filter(Boolean).map(line => { const [serial, state] = line.split('\t'); return { serial, state }; });
  }

  /** 功能：读取官方JDWP进程快照；输入设备和取消信号；输出 PID 与包名；验证：android-coordinator.test.js及coordinator-reattach-device.test.js。 */
  async clients(serial: string, signal?: AbortSignal): Promise<AndroidClient[]> {
    const text = await this.client.command('clients', [serial], signal);
    return text.split('\n').filter(Boolean).map(line => {
      const [pid, ...name] = line.split('\t');
      return { pid: Number(pid), packageName: name.join('\t') };
    });
  }

  /** 功能：申请官方JDWP代理端口；输入设备、PID 和取消信号；输出唯一租约，清理等待代理断开；验证：android-coordinator.test.js及coordinator-reattach-device.test.js。 */
  async claim(serial: string, pid: number, signal?: AbortSignal, received?: (leaseId: string) => void): Promise<{ leaseId: string; port: number; cleanup: () => Promise<void> }> {
    const value = await this.client.command('claim', [serial, String(pid)], signal, text => received?.(text.split('\t')[0]));
    const [leaseId, portText] = value.split('\t');
    const port = Number(portText);
    if (!leaseId || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Coordinator returned an invalid JDWP lease');
    return { leaseId, port, cleanup: async () => { await this.client.command('release', [leaseId]); } };
  }

  /** 功能：安装 APK；输入本机路径而非 shell 文本；输出安装完成；验证：android-coordinator.test.js。 */
  async install(serial: string, apkPath: string, signal?: AbortSignal): Promise<void> { await this.client.command('install', [serial, apkPath], signal); }

  /** 功能：启动调试应用并等待JDWP进程属性；输入设备、包名和可选组件；输出主 PID；验证：android-coordinator.test.js及coordinator-device-host.test.js。 */
  async launch(serial: string, packageName: string, component: string, signal?: AbortSignal): Promise<number> {
    const pid = Number(await this.client.command('launch', [serial, packageName, component], signal));
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Coordinator returned an invalid Android PID');
    return pid;
  }

  /** 功能：经adblib执行设备命令；输入设备、命令和取消信号；输出命令结果；验证：android-coordinator.test.js。 */
  async shell(serial: string, command: string, signal?: AbortSignal): Promise<string> { return this.client.command('shell', [serial, command], signal); }

  /** 功能：查询 Native ABI 候选；输入包名和设备；输出安装包 ABI 及设备列表；验证：android-coordinator.test.js。 */
  async abis(serial: string, packageName: string, signal?: AbortSignal): Promise<string[]> {
    if (!/^[A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)+$/.test(packageName)) throw new Error('Invalid Android package name');
    const metadata = await this.shell(serial, 'dumpsys package ' + packageName, signal);
    let selected = false;
    for (const line of metadata.split(/\r?\n/)) {
      const header = /^\s*Package \[([^\]]+)\]/.exec(line);
      if (header) { selected = header[1] === packageName; continue; }
      const primary = selected ? /(?:^|\s)primaryCpuAbi=([^\s]+)/.exec(line) : undefined;
      if (primary && primary[1] !== 'null') return [primary[1]];
    }
    return (await this.shell(serial, 'getprop ro.product.cpu.abilist', signal)).trim().split(',').filter(Boolean);
  }

  /** 功能：恢复 Native 等待中的 VM；输入独占租约；输出 JDWP 恢复完成；验证：android-coordinator.test.js。 */
  async resume(leaseId: string, signal?: AbortSignal): Promise<void> { await this.client.command('resume', [leaseId], signal); }

  /** 功能：依次结束全部会话和控制面；输出聚合清理错误；验证：android-coordinator.test.js。 */
  async dispose(): Promise<void> {
    const results = await Promise.allSettled([...this.sessions].map(session => session.close()));
    try { await this.client.dispose(); } catch (error) { results.push({ status: 'rejected', reason: error }); }
    const errors = results.filter((value): value is PromiseRejectedResult => value.status === 'rejected').map(value => value.reason);
    if (errors.length) throw new AggregateError(errors, 'Android Coordinator cleanup failed');
  }
}

/** 同一设备调试会话按逆序释放引擎、server 和 JDWP；失联只通知所属会话。 */
export class AndroidDebugSession {
  private readonly controller = new AbortController();
  readonly signal = this.controller.signal;
  private readonly resources: Array<() => Promise<void>> = [];
  private readonly leases = new Set<string>();
  private readonly subscription: { dispose(): void };
  private closing?: Promise<void>;

  /** 功能：订阅设备和租约失效；输入协调器及宿主回调；输出可取消会话；验证：android-coordinator.test.js。 */
  constructor(private readonly coordinator: AndroidCoordinator, readonly serial: string, lost: (error: Error) => void, private readonly released: () => void) {
    this.subscription = coordinator.onEvent(event => {
      if (this.signal.aborted) return;
      if ((event.type === 'lease.lost' && this.leases.has(event.value)) || (event.type === 'device.lost' && event.value === serial) || event.type === 'coordinator.lost') {
        const error = new Error('Android debug target lost: ' + event.type + ' ' + event.value);
        this.controller.abort(error);
        lost(error);
      }
    });
  }

  /** 功能：登记唯一资源释放者；输入自有资源清理函数；输出资源归入逆序账本；验证：android-coordinator.test.js。 */
  own(cleanup: () => Promise<void>): void { this.signal.throwIfAborted(); this.resources.push(cleanup); }

  /** 功能：以会话取消信号申请租约；输入目标 PID；输出代理端口和租约 ID；验证：android-coordinator.test.js。 */
  async claim(pid: number): Promise<{ leaseId: string; port: number }> {
    const lease = await this.coordinator.claim(this.serial, pid, this.signal, id => this.leases.add(id));
    if (this.signal.aborted) { await lease.cleanup(); this.signal.throwIfAborted(); }
    this.leases.add(lease.leaseId);
    this.resources.push(lease.cleanup);
    return lease;
  }

  /** 功能：取消进行中的准备；输入取消原因；输出后续异步步骤中断；验证：android-coordinator.test.js。 */
  cancel(reason?: Error): void { this.controller.abort(reason); }

  /** 功能：按逆序结算所有已登记资源；输出幂等关闭结果及聚合错误；验证：android-coordinator.test.js。 */
  close(): Promise<void> {
    this.cancel();
    return this.closing ??= Promise.resolve().then(async () => {
      const errors: unknown[] = [];
      try {
        for (const cleanup of this.resources.splice(0).reverse()) {
          try { await cleanup(); } catch (error) { errors.push(error); }
        }
        if (errors.length) throw new AggregateError(errors, 'Android session cleanup failed');
      } finally { this.leases.clear(); this.subscription.dispose(); this.released(); }
    });
  }
}
