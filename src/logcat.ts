import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { ChildProcess, spawn } from 'child_process';
import { Device, adb, adbPath, listDevices, sdkRoot } from './sdk';
import { DeviceExplorerProcesses, ExplorerProcess } from './deviceExplorerProcesses';
import { BinaryLogcatParser } from './logcatParser';

const PRIORITIES = ['', '', 'V', 'D', 'I', 'W', 'E', 'A'];

/** 将已校验 logger_entry 秒/纳秒转换为本地年月日毫秒；tests/logcat-visibility.test.js binary records 在无设备条件注入 nsec，断言同毫秒与 .123 格式。 */
function formatLogTime(sec: number, nsec: number): string {
  const date = new Date(sec * 1000 + Math.floor(nsec / 1_000_000));
  const pad = (value: number, width: number) => String(value).padStart(width, '0');
  return `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1, 2)}-${pad(date.getDate(), 2)} ${pad(date.getHours(), 2)}:${pad(date.getMinutes(), 2)}:${pad(date.getSeconds(), 2)}.${pad(date.getMilliseconds(), 3)}`;
}
const DEFAULT_LOGCAT_MAX_BYTES = 1024 * 1024;
const MIN_LOGCAT_MAX_BYTES = 64 * 1024;
const MAX_LOGCAT_MAX_BYTES = 64 * 1024 * 1024;

interface Item { ts: string; pid: number; tid: number; lv: string; tag: string; pkg: string; msg: string; rx: number; system?: boolean; }

export class LogcatView implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  // 空串为待默认选择；undefined 为明确未选择，断开后不得在下一次查询自动切换。
  private serial: string | undefined = '';
  private proc?: ChildProcess;
  private queue: Item[] = [];
  private timer?: NodeJS.Timeout;
  private poll?: NodeJS.Timeout;
  private pkgs = new Map<number, string>();
  private missing = new Set<number>();
  private lastPs = 0;
  private psBusy = false;
  private devices: Device[] = [];
  private projectPackages = new Set<string>();
  private processWatch?: { owner: DeviceExplorerProcesses; stop?: () => Promise<void> };
  private processRows = new Map<number, { pkg: string; started: boolean }>();

  // 输入扩展路径及选择回调，保留未创建视图时的设备；npm test device selection sync 回归覆盖延迟打开。
  constructor(private extPath: string, private selectionChanged?: (serial?: string) => Promise<void> | void) {}

  /**
   * 读取 android-ide.logcat.maxBytes 并校验 Logcat 内存上限；输入为 VS Code 配置，输出为 64 KiB 至 64 MiB 的整数。
   * 前置条件是配置服务可用；默认值与 Android Studio 的 1 MiB 循环缓冲一致，避免无限增长。
   * 回归：tests/logcat-buffer.test.js 与 npm test 断言默认值、边界和初始化字段。
   */
  private maxBytes() {
    const configured = Number(vscode.workspace.getConfiguration('android-ide').get('logcat.maxBytes', DEFAULT_LOGCAT_MAX_BYTES));
    const value = Number.isFinite(configured) ? Math.floor(configured) : DEFAULT_LOGCAT_MAX_BYTES;
    return Math.min(MAX_LOGCAT_MAX_BYTES, Math.max(MIN_LOGCAT_MAX_BYTES, value));
  }

  private icons() {
    const out: Record<string, string> = {};
    for (const n of ['logcat', 'wrap-text', 'filter-history', 'favorite', 'favorite-filled', 'screenshot', 'record', ...['delete', 'pause', 'refresh', 'scroll-end', 'up', 'down', 'softwrap'].map((x) => `lc-${x}`)]) {
      out[n] = fs.readFileSync(path.join(this.extPath, 'media', 'icons', `${n}.svg`), 'utf8');
    }
    return out;
  }

  // 初始化 Logcat Webview 的结构、资源和生命周期；输入为 VS Code 视图，输出为可交互的日志面板。
  // 设备与Format用原生selectedcontent承载可省略标签，箭头为独立布局项；npm test Logcat device selector及LOGCAT_BROWSER=1 dropdown验证文字边界不侵入箭头槽、主题及键盘选择。
  // 设备选择保留原生 select；右侧 log-content 容纳搜索与日志，左侧工具栏不随搜索栏移动。
  // 前提为宿主提供真实 visible；生命周期事件输出 visibility.visible，隐藏释放采集，旧视图事件不得操作新视图。
  // 回归：npm test 中 logcat-visibility.test.js 模拟隐藏/销毁/替换；既有样式和选择同步测试分别断言结构与错误。
  // 下拉共享样式覆盖设备、格式、历史和补全；npm test dropdown 接线、LOGCAT_BROWSER=1 dropdown 断言主题/键盘/窄屏。
  resolveWebviewView(view: vscode.WebviewView) {
    this.view = view;
    const media = vscode.Uri.file(path.join(this.extPath, 'media'));
    const codicons = vscode.Uri.file(path.join(this.extPath, 'media', 'codicons'));
    const w = view.webview;
    w.options = { enableScripts: true, localResourceRoots: [media, codicons] };
    const u = (...p: string[]) => w.asWebviewUri(vscode.Uri.joinPath(media, ...p));
    const csp = `default-src 'none'; style-src ${w.cspSource} 'unsafe-inline'; script-src ${w.cspSource}; font-src ${w.cspSource};`;
    w.html = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}">
<link rel="stylesheet" href="${w.asWebviewUri(vscode.Uri.joinPath(codicons, 'codicon.css'))}">
<link rel="stylesheet" href="${u('logcat', 'main.css')}"><link rel="stylesheet" href="${u('dropdowns.css')}"></head><body>
<div id="header"><div class="device-select"><select id="dev" title="Device" aria-label="Device"><button type="button"><selectedcontent></selectedcontent></button></select></div><select id="fmt" title="Format"><button type="button"><selectedcontent></selectedcontent></button><option value="standard">Standard</option><option value="compact">Compact</option></select>
<div id="filterbox"><button class="ib" id="hist-btn" title="Filter history"></button><div id="editor"><div id="hl"></div><input id="q" spellcheck="false" placeholder="Filter, e.g. tag:foo level:warn -message:bar"></div><button class="ib" id="fav" title="Favorite"></button></div>
<span id="count"></span></div>
<div id="main"><div id="side"></div><div id="log-content"><div id="sc" tabindex="0" aria-label="Log messages"><div id="win"><div id="row-viewport" contenteditable="plaintext-only" role="textbox" aria-label="Log messages editor" aria-multiline="true" spellcheck="false"><div id="row-window"></div></div></div><div id="spacer"></div><div id="empty"></div><div id="status"></div></div></div></div>
<script src="${u('logcat', 'filter.js')}"></script><script src="${u('logcat', 'buffer.js')}"></script><script src="${u('logcat', 'main.js')}"></script></body></html>`;
    w.onDidReceiveMessage((m) => {
      if (this.view !== view) { return; }
      return this.onMessage(m).catch((error) => vscode.window.showErrorMessage(String(error)));
    });
    view.onDidChangeVisibility(() => {
      if (this.view !== view) { return; }
      this.post({ type: 'visibility', visible: view.visible });
      if (view.visible) { this.startPolling(); } else { this.stopPolling(); void this.stopStream().catch(error => vscode.window.showErrorMessage(String(error))); }
    });
    view.onDidDispose(() => {
      if (this.view !== view) { return; }
      this.view = undefined;
      this.stopPolling(); void this.stopStream().catch(error => vscode.window.showErrorMessage(String(error)));
    });
  }

  // 打开日志面板；可不传设备，传入时同步两侧选择，不对同一日志流重复启动。
  // 回归：npm test，tests/device-selection-sync.test.js 断言无设备聚焦、选择保留和重复打开。
  async show(d?: { serial: string }) {
    if (d?.serial) { await this.select(d.serial); }
    await vscode.commands.executeCommand('android-ide.logcat.focus');
    if (this.serial && !this.proc) { this.start(); }
    this.post({ type: 'devices', list: this.devices, serial: this.serial });
  }

  // 输入串号或空值，停止旧日志、更新下拉并通知 Device Tools；相同选择不回传或重启。
  // 回归：npm test，tests/device-selection-sync.test.js 覆盖双向同步、隐藏、断开和异常传播。
  async select(serial?: string): Promise<void> {
    serial = serial || undefined;
    if (this.serial === serial) { return; }
    this.serial = serial;
    this.start();
    if (!serial) { this.post({ type: 'reset' }); }
    this.post({ type: 'devices', list: this.devices, serial });
    await this.selectionChanged?.(serial);
  }

  private post(m: any) { this.view?.webview.postMessage(m); }

  // 分派输入消息，选择交给同步入口并将错误交还宿主；ready 保存项目包并补发存活项目 PID 的 STARTED，再输出当前 init.visible。
  // 前提为消息属于当前视图；扫描期间销毁则不初始化新视图，隐藏则初始化为 false 且不采集。
  // 展开消息查询最新设备，不改变轮询调度；npm test 的 device-selection-sync.test.js 覆盖展开/选择/错误，logcat-visibility.test.js 覆盖隐藏/销毁。
  private async onMessage(m: any) {
    switch (m.type) {
      case 'ready': {
        const view = this.view;
        const mine = await this.mine();
        if (!view || this.view !== view) { return; }
        this.projectPackages = new Set(mine);
        for (const [pid, row] of this.processRows) {
          if (!row.started && this.projectPackages.has(row.pkg)) {
            row.started = true;
            this.queue.push(this.processItem(pid, row.pkg, 'STARTED'));
          }
        }
        this.post({ type: 'init', icons: this.icons(), mine, maxBytes: this.maxBytes(), visible: view.visible });
        this.startPolling();
        break;
      }
      case 'discoverDevices': await this.refreshDevices(); break;
      case 'select': await this.select(m.serial); break;
      case 'clear': if (this.serial) { await adb(this.serial, 'logcat', '-c').catch(() => {}); } break;
      case 'restart': this.start(); break;
      case 'screenshot': if (this.serial) { vscode.commands.executeCommand('android-ide.screenshot', { serial: this.serial }); } break;
      case 'record': if (this.serial) { vscode.commands.executeCommand('android-ide.screenRecord', { serial: this.serial }); } break;
      case 'copy': await vscode.env.clipboard.writeText(m.text); break;
    }
  }

  // 仅为当前可见宿主轮询设备；无输入/返回值，发现结果更新目录后，仅存活可见视图可同步选择、投递 DOM 或启动流。
  // listDevices 与 select 均可能跨越隐藏/销毁，续体必须重新核对真实视图所有权与 visible，不改变既有轮询频率。
  // 回归：npm test 的 logcat-visibility.test.js 控制两个异步边界，断言隐藏零投递/零新流与显示恢复；选择同步测试覆盖断开和显式报错。
  private startPolling() {
    this.stopPolling();
    const view = this.view;
    if (!view?.visible) { return; }
    const tick = async () => {
      if (this.view !== view || !view.visible) { return; }
      try { await this.refreshDevices(); }
      catch (error) { vscode.window.showErrorMessage(String(error)); }
    };
    void tick();
    this.poll = setInterval(tick, 3000);
  }

  // 轮询与展开共用目录查询；无输入，输出全部设备状态和选择快照，失败交调用入口报告。
  // 首次选择第一台在线设备，断开清空且不回退；异步边界核对视图所有权和可见性。
  // 回归：npm test 的 device-selection-sync.test.js / logcat-visibility.test.js 断言查询、默认、断开、错误及隐藏零新流。
  private async refreshDevices() {
    const view = this.view;
    if (!view?.visible) { return; }
    const devices = await listDevices();
    if (this.view !== view) { return; }
    this.devices = devices;
    if (!view.visible) { return; }
    if (this.serial && !devices.some((d) => d.serial === this.serial && d.state === 'device')) {
      await this.select(undefined);
    } else if (this.serial === '') {
      const first = devices.find((d) => d.state === 'device');
      if (first) { await this.select(first.serial); }
    }
    if (this.view !== view || !view.visible) { return; }
    this.post({ type: 'devices', list: this.devices, serial: this.serial });
    if (this.serial && !this.proc) { this.start(); }
  }
  private stopPolling() { if (this.poll) { clearInterval(this.poll); this.poll = undefined; } }

  /**
   * 停止当前设备的日志流和进程快照订阅；输入无，输出等待所有底层资源释放的 Promise。
   * 前置条件是可重复调用；隐藏、切换、重启和销毁均不得合成 ENDED，且旧回调只能通过 owner 身份检查退出。
   * 回归：tests/logcat-visibility.test.js 与 tests/device-selection-sync.test.js 断言停止后无串设备 batch、watch 已释放且无虚构结束行。
   */
  private async stopStream(): Promise<void> {
    const proc = this.proc;
    this.proc = undefined;
    proc?.kill();
    if (this.timer) { clearInterval(this.timer); this.timer = undefined; }
    const watch = this.processWatch;
    this.processWatch = undefined;
    this.processRows.clear();
    this.queue = [];
    if (watch) { await watch.stop?.(); }
  }

  /**
   * 在当前可见设备上启动 Logcat 与项目进程追踪；输入为当前 serial，输出无，事件按接收顺序写入共享队列。
   * 二进制通过 exec-out 原样读取 main/system/crash，避免 adb logcat 文本通道将 LF 改成 CRLF 而破坏帧头长度与消息终止符。
   * parser 与当前 proc 闭包同寿命，旧回调由 proc 身份拒绝，close 在 stdout 结束后检查 EOF 并释放资源。
   * 回归：tests/logcat-visibility.test.js 的 raw exec-out 与 tests/logcat-parser.test.js 的 LF bytes 无设备断言参数、头部 LF/CR、消息换行和坏帧拒绝；连接设备后用 exec-out logcat -B -d -t 1000 交给同一 parser，成功为零 status 且恰好 1000 条。
   * 进程归属由 ready 保存的项目包名决定；提前选设备时先保留快照，扫描完成再合成已知项目行，不新增进程轮询或 agent。
   * 回归：node --test tests/logcat-visibility.test.js tests/device-selection-sync.test.js 无硬件注入 Buffer，断言多行/尾换行、同头独立记录、FATAL、本地毫秒、stderr/error、坏帧/EOF 与旧 partial 隔离；同时覆盖隐藏和选择幂等。
   */
  private start() {
    void this.stopStream().catch(error => vscode.window.showErrorMessage(String(error)));
    const serial = this.serial;
    if (!serial || !this.view?.visible) { return; }
    this.pkgs.clear(); this.missing.clear(); this.lastPs = 0;
    this.post({ type: 'reset' });
    const proc = spawn(adbPath(), ['-s', serial, 'exec-out', 'logcat', '-B', '-b', 'main', '-b', 'system', '-b', 'crash', '-T', '1000'], { env: { ...process.env, ANDROID_HOME: sdkRoot() } });
    this.proc = proc;
    let diagnostic = '';
    const parser = new BinaryLogcatParser(record => {
      if (this.proc !== proc) { return; }
      const now = Date.now();
      this.queue.push({ ts: formatLogTime(record.sec, record.nsec), pid: record.pid, tid: record.tid, lv: PRIORITIES[record.priority] ?? 'V', tag: record.tag, pkg: this.pkgs.get(record.pid) ?? '', msg: record.message, rx: now });
    }, text => {
      if (this.proc === proc) {
        diagnostic = text;
        this.post({ type: 'status', text });
        if (this.proc === proc) { proc.kill(); }
      }
    });
    proc.stdout.on('data', (chunk: Buffer) => {
      if (this.proc === proc) { parser.push(chunk); }
    });
    proc.stderr?.on('data', (chunk: Buffer | string) => {
      if (this.proc === proc) { diagnostic = 'Log stream error: ' + Buffer.from(chunk).toString('utf8').trim(); this.post({ type: 'status', text: diagnostic }); }
    });
    proc.on('error', error => {
      if (this.proc === proc) { diagnostic = 'Log stream failed: ' + String(error); this.post({ type: 'status', text: diagnostic }); }
    });
    proc.on('close', (code, signal) => {
      if (this.proc !== proc) { return; }
      parser.end();
      this.flush();
      this.proc = undefined;
      void this.stopStream().catch(error => vscode.window.showErrorMessage(String(error)));
      this.post({ type: 'status', text: diagnostic || (code !== 0 || signal ? `Log stream exited (${code}${signal ? ', ' + signal : ''})` : 'Log stream ended') });
    });
    this.timer = setInterval(() => this.flush(), 60);
    this.startProcessWatch(serial);
  }

  /**
   * 将 tracker 快照转换为 Android Studio 格式的系统分隔行；输入为设备 serial 和快照，输出追加到共享队列。
   * 已确认项目 PID 只产生一次 STARTED，且仅在同一 watch 后续快照移除时产生 ENDED；metadata 未知时保留 PID 而不猜归属。
   * 回归：node --test tests/logcat-visibility.test.js，注入真实快照入口，断言去重、未知移除不结束、:service 推断及错误 status。
   */
  private startProcessWatch(serial: string) {
    const owner = new DeviceExplorerProcesses(serial);
    const record: { owner: DeviceExplorerProcesses; stop?: () => Promise<void> } = { owner };
    this.processWatch = record;
    record.stop = owner.watch(rows => {
      if (this.processWatch !== record || this.serial !== serial) { return; }
      this.onProcessSnapshot(rows);
    }, error => {
      if (this.processWatch !== record || this.serial !== serial) { return; }
      this.post({ type: 'status', text: 'Process tracking failed: ' + String(error) });
    });

  }

  /**
   * 处理单次进程快照并维护 PID 身份；输入为 watcher rows，输出为按快照差异追加的系统 Item。
   * packageName 或 name 去掉 :service 后命中项目包才可发 STARTED；移除只针对已发 STARTED 的 PID，避免未知 metadata 伪造 ENDED。
   * 回归：node --test tests/logcat-visibility.test.js 的项目进程用例注入重复、未知、增删快照，精确断言消息和主机时间。
   */
  private onProcessSnapshot(rows: ExplorerProcess[]) {
    const current = new Set<number>();
    for (const row of rows) {
      const previous = this.processRows.get(row.pid);
      const pkg = row.packageName || row.name?.split(':', 1)[0] || previous?.pkg || '';
      current.add(row.pid);
      if (row.error) { this.post({ type: 'status', text: `Process ${row.pid} metadata failed: ${row.error}` }); }
      if (!previous?.started) {
        const started = Boolean(pkg && this.projectPackages.has(pkg));
        this.processRows.set(row.pid, { pkg, started });
        if (started) { this.queue.push(this.processItem(row.pid, pkg, 'STARTED')); }
      }
    }
    for (const [pid, previous] of this.processRows) {
      if (!current.has(pid)) {
        if (previous.started) { this.queue.push(this.processItem(pid, previous.pkg, 'ENDED')); }
        this.processRows.delete(pid);
      }
    }
  }

  /**
   * 构造一条 Studio 格式进程系统日志；输入为 PID、包名和生命周期，输出字段固定为空 ts/tag、tid 0、I 级别及主机接收时间。
   * 回归：node --test tests/logcat-visibility.test.js 精确断言两侧各 28 个横线、空字段、真实 PID、包名与接收时间。
   */
  private processItem(pid: number, pkg: string, phase: 'STARTED' | 'ENDED'): Item {
    const separator = '-'.repeat(28);
    return { ts: '', pid, tid: 0, lv: 'I', tag: '', pkg, msg: `${separator} PROCESS ${phase} (${pid}) for package ${pkg} ${separator}`, rx: Date.now(), system: true };
  }

  /**
   * 按接收顺序发送普通日志和系统行；输入无，输出一个 batch 消息并触发缺失普通日志的既有包解析。
   * 回归：node --test tests/logcat-visibility.test.js 在系统快照间注入旧设备时间的 stdout，断言 batch 不重排。
   */
  private flush() {
    if (!this.queue.length) { return; }
    const items = this.queue;
    this.queue = [];
    if (items.some((i) => !i.system && !i.pkg && !this.missing.has(i.pid))) { this.refreshPs(); }
    this.post({ type: 'batch', items });
    // late package resolution: tell the webview which pids are now known
  }

  private async refreshPs() {
    const serial = this.serial;
    if (!serial || this.psBusy || Date.now() - this.lastPs < 1500) { return; }
    this.psBusy = true; this.lastPs = Date.now();
    try {
      const out = await adb(serial, 'shell', 'ps', '-A', '-o', 'PID,NAME');
      const map: Record<number, string> = {};
      for (const l of out.split('\n').slice(1)) {
        const m = /^\s*(\d+)\s+(\S+)/.exec(l);
        if (m) { const name = m[2].split(':')[0]; this.pkgs.set(+m[1], name); map[+m[1]] = name; }
      }
      if (serial === this.serial) { this.post({ type: 'pkgs', map }); }
    } catch { /* ignore */ } finally { this.psBusy = false; }
  }

  private async mine(): Promise<string[]> {
    const ids = new Set<string>();
    try {
      const files = await vscode.workspace.findFiles('**/{build.gradle,build.gradle.kts}', '**/{node_modules,build,.git}/**', 30);
      for (const f of files) {
        const txt = fs.readFileSync(f.fsPath, 'utf8');
        for (const m of txt.matchAll(/(?:applicationId|namespace)\s*(?:=)?\s*["']([\w.]+)["']/g)) { ids.add(m[1]); }
      }
    } catch { /* ignore */ }
    return [...ids];
  }
}
