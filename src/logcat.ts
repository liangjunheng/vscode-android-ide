import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { ChildProcess, spawn } from 'child_process';
import { Device, adb, adbPath, listDevices, sdkRoot } from './sdk';

const LINE = /^(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{3})\s+(\d+)\s+(\d+)\s+([VDIWEAF])\s+(.*?)\s*:\s?(.*)$/;
const DEFAULT_LOGCAT_MAX_BYTES = 1024 * 1024;
const MIN_LOGCAT_MAX_BYTES = 64 * 1024;
const MAX_LOGCAT_MAX_BYTES = 64 * 1024 * 1024;

interface Item { ts: string; pid: number; tid: number; lv: string; tag: string; pkg: string; msg: string; rx: number; }

export class LogcatView implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private serial?: string;
  private proc?: ChildProcess;
  private gen = 0;
  private queue: Item[] = [];
  private timer?: NodeJS.Timeout;
  private poll?: NodeJS.Timeout;
  private pkgs = new Map<number, string>();
  private missing = new Set<number>();
  private lastPs = 0;
  private psBusy = false;
  private devices: Device[] = [];

  // 输入扩展路径及选择回调，保留未创建视图时的设备；npm test device selection sync 回归覆盖延迟打开。
  constructor(private extPath: string, private selectionChanged?: (serial?: string) => Promise<void> | void) {}

  /**
   * 读取并校验 Logcat 内存上限；输入为 VS Code 配置，输出为 64 KiB 至 64 MiB 的整数。
   * 前置条件是配置服务可用；默认值与 Android Studio 的 1 MiB 循环缓冲一致，避免无限增长。
   * 回归：tests/logcat-buffer.test.js 与 npm test 断言默认值、边界和初始化字段。
   */
  private maxBytes() {
    const configured = Number(vscode.workspace.getConfiguration('android').get('logcat.maxBytes', DEFAULT_LOGCAT_MAX_BYTES));
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
  // 设备选择保留原生 select；右侧 log-content 容纳搜索与日志，左侧工具栏不随搜索栏移动。
  // 前提为宿主提供真实 visible；生命周期事件输出 visibility.visible，隐藏释放采集，旧视图事件不得操作新视图。
  // 回归：npm test 中 logcat-visibility.test.js 模拟隐藏/销毁/替换；既有样式和选择同步测试分别断言结构与错误。
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
<link rel="stylesheet" href="${u('logcat', 'main.css')}"></head><body>
<div id="header"><div class="device-select"><select id="dev" title="Device" aria-label="Device"></select><span class="device-select-arrow" aria-hidden="true"><span class="codicon codicon-chevron-down"></span></span></div><select id="fmt" title="Format"><option value="standard">Standard</option><option value="compact">Compact</option></select>
<div id="filterbox"><button class="ib" id="hist-btn" title="Filter history"></button><div id="editor"><div id="hl"></div><input id="q" spellcheck="false" placeholder="Filter, e.g. tag:foo level:warn -message:bar"></div><button class="ib" id="fav" title="Favorite"></button></div>
<span id="count"></span></div>
<div id="main"><div id="side"></div><div id="log-content"><div id="sc" tabindex="0" aria-label="Log messages"><div id="win"><div id="row-viewport"><div id="row-window"></div></div></div><div id="spacer"></div><div id="empty"></div><div id="status"></div></div></div></div>
<script src="${u('logcat', 'filter.js')}"></script><script src="${u('logcat', 'buffer.js')}"></script><script src="${u('logcat', 'main.js')}"></script></body></html>`;
    w.onDidReceiveMessage((m) => {
      if (this.view !== view) { return; }
      return this.onMessage(m).catch((error) => vscode.window.showErrorMessage(String(error)));
    });
    view.onDidChangeVisibility(() => {
      if (this.view !== view) { return; }
      this.post({ type: 'visibility', visible: view.visible });
      if (view.visible) { this.startPolling(); } else { this.stopPolling(); this.stopStream(); }
    });
    view.onDidDispose(() => {
      if (this.view !== view) { return; }
      this.view = undefined;
      this.stopPolling(); this.stopStream();
    });
  }

  // 打开日志面板；可不传设备，传入时同步两侧选择，不对同一日志流重复启动。
  // 回归：npm test，tests/device-selection-sync.test.js 断言无设备聚焦、选择保留和重复打开。
  async show(d?: { serial: string }) {
    if (d?.serial) { await this.select(d.serial); }
    await vscode.commands.executeCommand('android.logcat.focus');
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

  // 分派输入消息，选择交给同步入口并将错误交还宿主；ready 在项目扫描后输出当前 init.visible。
  // 前提为消息属于当前视图；扫描期间销毁则不初始化新视图，隐藏则初始化为 false 且不采集。
  // 回归：npm test 的 logcat-visibility.test.js 延迟 mine 并隐藏/销毁，device-selection-sync.test.js 覆盖真实 select。
  private async onMessage(m: any) {
    switch (m.type) {
      case 'ready': {
        const view = this.view;
        const mine = await this.mine();
        if (!view || this.view !== view) { return; }
        this.post({ type: 'init', icons: this.icons(), mine, maxBytes: this.maxBytes(), visible: view.visible });
        this.startPolling();
        break;
      }
      case 'select': await this.select(m.serial); break;
      case 'clear': if (this.serial) { await adb(this.serial, 'logcat', '-c').catch(() => {}); } break;
      case 'restart': this.start(); break;
      case 'screenshot': if (this.serial) { vscode.commands.executeCommand('android.screenshot', { serial: this.serial }); } break;
      case 'record': if (this.serial) { vscode.commands.executeCommand('android.screenRecord', { serial: this.serial }); } break;
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
      try {
        const devices = (await listDevices()).filter((d) => d.state === 'device');
        if (this.view !== view) { return; }
        this.devices = devices;
        if (!view.visible) { return; }
        if (!this.devices.some((d) => d.serial === this.serial)) {
          await this.select(this.devices[0]?.serial);
        }
        if (this.view !== view || !view.visible) { return; }
        this.post({ type: 'devices', list: this.devices, serial: this.serial });
        if (this.serial && !this.proc) { this.start(); }
      } catch (error) { vscode.window.showErrorMessage(String(error)); }
    };
    void tick();
    this.poll = setInterval(tick, 3000);
  }

  private stopPolling() { if (this.poll) { clearInterval(this.poll); this.poll = undefined; } }

  private stopStream() {
    this.gen++;
    this.proc?.kill();
    this.proc = undefined;
    if (this.timer) { clearInterval(this.timer); this.timer = undefined; }
    this.queue = [];
  }

  // 仅在可见视图为所选设备建立日志流，切换先释放旧流；npm test device selection sync 断言启动次数和隐藏零进程。
  private start() {
    this.stopStream();
    const serial = this.serial;
    if (!serial || !this.view?.visible) { return; }
    const gen = this.gen;
    this.pkgs.clear(); this.missing.clear(); this.lastPs = 0;
    this.post({ type: 'reset' });
    const proc = spawn(adbPath(), ['-s', serial, 'logcat', '-v', 'threadtime', '-v', 'year', '-T', '1000'], { env: { ...process.env, ANDROID_HOME: sdkRoot() } });
    this.proc = proc;
    let buf = '';
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk: string) => {
      if (gen !== this.gen) { return; }
      buf += chunk;
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      const now = Date.now();
      for (const raw of lines) {
        const line = raw.replace(/\r$/, '');
        const m = LINE.exec(line);
        if (!m) { continue; }
        const pid = +m[2];
        this.queue.push({ ts: m[1], pid, tid: +m[3], lv: m[4] === 'F' ? 'A' : m[4], tag: m[5], pkg: this.pkgs.get(pid) ?? '', msg: m[6], rx: now });
      }
    });
    proc.on('exit', () => {
      if (gen !== this.gen) { return; }
      this.flush();
      this.proc = undefined;
      this.post({ type: 'status', text: 'Log stream ended' });
    });
    this.timer = setInterval(() => this.flush(), 60);
  }

  private flush() {
    if (!this.queue.length) { return; }
    const items = this.queue;
    this.queue = [];
    if (items.some((i) => !i.pkg && !this.missing.has(i.pid))) { this.refreshPs(); }
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
