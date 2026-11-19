(function () {
  const vs = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const st = Object.assign({ history: [], favs: [], filter: '', fmt: 'standard', wrap: false }, vs.getState() || {});
  const save = () => vs.setState(st);

  let entries = [], rows = [], mine = [], maxBytes = 1024 * 1024;
  let entriesBytes = 0, pendingBytes = 0;
  let paused = false, pending = [], stick = true, serial = '', compiled = null, pkgMap = {};
  const sc = $('sc'), win = $('row-window'), viewport = $('row-viewport'), spacer = $('spacer'), q = $('q'), hl = $('hl');
  let H = parseFloat(getComputedStyle(sc).lineHeight);
  let icons = {}, deviceList = [], statusText = '', statusTimer = 0;
  let offsets = [0], offsetRows = [], rowHeights = new WeakMap(), layoutKey = '';
  let viewportAnchor = null, requestedRow = null;
  const renderedRows = new WeakMap();
  let tailCaret = null, composition = null;
  const S = { open: false, re: null, rows: [], cur: -1, err: false, dirty: false, scroll: false, timer: 0 };

  const esc = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const tagColor = (t) => { let h = 0; for (let i = 0; i < t.length; i++) { h = (h * 31 + t.charCodeAt(i)) >>> 0; } return `hsl(${h % 360},var(--tag-s),var(--tag-l))`; };
  const svg = (n) => icons[n] || '';
  const codicon = (n) => `<span class="codicon codicon-${n}"></span>`;
  const MOD = /Mac/.test(navigator.platform) ? '⌘' : 'Ctrl+';

  function btn(id, title, html, onclick, parent) {
    const b = document.createElement('button');
    b.className = 'ib'; b.id = id; b.title = title; b.innerHTML = html; b.onclick = onclick;
    parent.appendChild(b); return b;
  }

  // 构建 Logcat 工具栏；输入为当前 Webview 控件，输出为清空、暂停、滚动和采集操作入口。
  // 清空重置缓存计数，末尾按钮同步跟随状态；回归：tests/logcat-buffer.test.js 与 tests/logcat-browser.test.js。
  function buildToolbar() {
    const side = $('side'); side.innerHTML = '';
    btn('b-clear', 'Clear Logcat', svg('lc-delete'), () => { resetEditor(); if (logSelection()) { getSelection().removeAllRanges(); } entries = []; rows = []; pending = []; entriesBytes = 0; pendingBytes = 0; S.dirty = true; viewportAnchor = null; requestedRow = null; render(); vs.postMessage({ type: 'clear' }); }, side);
    btn('b-pause', 'Pause Logcat', svg('lc-pause'), togglePause, side);
    btn('b-restart', 'Restart Logcat', svg('lc-refresh'), () => vs.postMessage({ type: 'restart' }), side);
    btn('b-end', 'Scroll to the End', svg('lc-scroll-end'), () => { if (logSelection()) { getSelection().removeAllRanges(); } setFollowing(!stick); render(); }, side);
    setFollowing(stick);
    btn('b-prev', 'Up the Stack Trace', svg('lc-up'), () => jumpStack(-1), side);
    btn('b-next', 'Down the Stack Trace', svg('lc-down'), () => jumpStack(1), side);
    btn('b-wrap', 'Soft-Wrap', svg('lc-softwrap'), () => { st.wrap = !st.wrap; save(); applyWrap(); }, side);
    btn('b-search', `Search (${MOD}F)`, codicon('search'), () => (S.open ? closeSearch() : openSearch()), side).classList.toggle('on', S.open);
    const sep = document.createElement('div'); sep.className = 'hsep'; side.appendChild(sep);
    btn('b-shot', 'Screen Capture', svg('screenshot'), () => vs.postMessage({ type: 'screenshot' }), side);
    btn('b-rec', 'Screen Record', svg('record'), () => vs.postMessage({ type: 'record' }), side);
    $('hist-btn').innerHTML = svg('filter-history');
    updateFav();
  }

  // 切换日志接收状态；输入无，输出为暂停队列转入有界 entries 或继续暂存。
  // 恢复时先清除 pendingBytes 再交给 ingest，避免重复计量；回归：tests/logcat-buffer.test.js。
  function togglePause() {
    paused = !paused;
    const b = $('b-pause');
    b.classList.toggle('on', paused);
    b.innerHTML = paused ? codicon('debug-continue') : svg('lc-pause');
    b.title = paused ? 'Resume Logcat' : 'Pause Logcat';
    if (!paused) { const p = pending; pending = []; pendingBytes = 0; ingest(p); render(); }
  }

  // 切换换行布局并同步按钮状态；输入为 st.wrap，输出保留阅读锚点的布局。
  // 回归：tests/logcat-browser.test.js 覆盖两种格式和窄宽视口，tests/logcat-style.test.js 检查控件。
  function applyWrap() {
    $('b-wrap').classList.toggle('on', st.wrap);
    document.body.classList.toggle('wrap', st.wrap);
    $('b-wrap').setAttribute('aria-pressed', String(st.wrap));
    render();
  }

  // ---- data ----
  // 计算日志项占用的 UTF-8 字节数；输入为含 msg 的 ADB 项，输出含换行预算的字节数。
  // 前置条件是 msg 可转为字符串；回归：tests/logcat-buffer.test.js。
  const itemBytes = (item) => LogcatBuffer.utf8Bytes(item.msg) + 1;

  // 截断超长日志项；输入为 ADB 项和当前上限，输出不超过上限的副本。
  // 前置条件是 maxBytes 已由后端限制；回归：tests/logcat-buffer.test.js。
  const normalizeItem = (item) => ({ ...item, msg: LogcatBuffer.truncateUtf8(item.msg, maxBytes - 1) });

  // 淘汰超出预算的完整旧记录；读取 entries/entriesBytes 并重建 rows，保留存活记录与行索引的稳定关系。
  // 前置条件是 maxBytes 已由后端校验；结果是最旧消息被移除，内存不随时间无限增长。
  // 回归：tests/logcat-buffer.test.js，npm test 执行真实接收函数并断言多行预算及保留内容。
  function trimEntries() {
    while (entriesBytes > maxBytes && entries.length) {
      entriesBytes -= entries.shift().bytes;
    }
    rebuild();
  }

  // 暂停时也限制待处理日志；输入为 pending 队列，输出为保留队列的字节数。
  // 回归：tests/logcat-buffer.test.js，npm test；断言超限后保留最新内容且队列有界。
  function trimPending() {
    pendingBytes = LogcatBuffer.trimOldest(pending, maxBytes, itemBytes);
  }

  const filterView = (e) => ({ tag: e.tag, pkg: e.pkg, lines: e.lines, lv: e.lv, lvn: e.lvn, rx: e.rx, pid: e.pid, tid: e.tid });
  // 系统分隔行与 Studio 一致无条件可见，普通记录执行过滤；buffer/browser 的 system 回归断言不匹配过滤仍保留分隔行。
  const visible = (e) => e.system || e.local || compiled.test(filterView(e));

  // 将消息拆成可见行；输入为保留原文的日志记录，输出不渲染末尾终止换行产生的空行。
  // 前置条件是 e.lines 由原始消息 split 得到；内部空行保留，复制仍读取完整 e.lines。
  // 回归：tests/logcat-buffer.test.js 断言末尾换行不增加 rows、内部空行仍保留且 entries 原文不变。
  function pushRows(e) {
    const count = e.lines.length > 1 && e.lines.at(-1) === '' ? e.lines.length - 1 : e.lines.length;
    for (let i = 0; i < count; i++) { rows.push({ e, i }); }
  }

  // 按输入记录边界接收日志并维护 UTF-8 字节预算；输入为 ADB 日志项，输出更新后的有界 entries。
  // 前置条件是每项为独立日志记录且包含 msg；仅消息内部换行产生续行，不按相同时间或 Tag 合并。
  // 保留 system 标记而非 local，避免尾部输入归并；回归：tests/logcat-buffer.test.js 定向执行真实 ingest，断言分隔行顺序和共用 UTF-8 预算。
  function ingest(items) {
    // 日志与本地输入严格按到达顺序追加，不把输入行置底；无新日志时才由appendInput续写尾local。
    // browser tail input回归断言无日志续写同一行，新日志位于输入之后且再次输入在新的尾部。
    for (const raw of items) {
      const it = normalizeItem(raw);
      const bytes = itemBytes(it);
      const e = { ts: it.ts, pid: it.pid, tid: it.tid, lv: it.lv, lvn: LogFilter.LEVELS[it.lv] || 4, tag: it.tag, pkg: it.pkg || pkgMap[it.pid] || '', lines: it.msg.split('\n'), bytes, rx: it.rx, system: it.system };
      entries.push(e);
      entriesBytes += bytes;
      if (visible(e)) { e.vis = true; pushRows(e); }
    }
    S.dirty = true;
    if (entriesBytes > maxBytes) { trimEntries(); }
  }

  function rebuild() {
    rows = []; S.dirty = true;
    for (const e of entries) { e.vis = visible(e); if (e.vis) { pushRows(e); } }
  }

  function recompile() {
    compiled = LogFilter.compile(st.filter, () => ({ mine, matchCase: !!st.cc }));
    $('filterbox').classList.toggle('error', !!compiled.error);
    $('filterbox').title = compiled.error || '';
    renderHighlight();
    rebuild(); render(); updateFav();
  }

  function renderHighlight() {
    const s = st.filter; let out = '', p = 0;
    for (const t of (compiled.toks || [])) {
      if (t.t !== 'term' || !t.key) { continue; }
      out += esc(s.slice(p, t.s)) + '<span class="kv">' + esc(s.slice(t.s, t.e)) + '</span>'; p = t.e;
    }
    hl.innerHTML = out + esc(s.slice(p)) + ' ';
  }

  // ---- rendering ----
  // 将指定日志行渲染为 HTML；前提是行索引有效，独立记录首行显示完整元数据，续行留空，不跨记录隐藏重复 Tag。
  // 回归：tests/logcat-style.test.js 断言字段及续行，tests/logcat-browser.test.js 断言两种格式实际换行高度。
  function rowHtml(i) {
    const { e, i: li } = rows[i];
    const first = li === 0 && !e.local;
    const msg = hx(e.lines[li]);
    const cur = S.cur >= 0 && S.rows[S.cur] === i ? ' cur' : '';
    // system/local 各保留身份且只输出消息字段，无 Tab/元数据；buffer/browser 回归覆盖系统过滤、两格式、复用、换行及 local 原生光标左缘。
    if (e.system) { return `<div class="row system${cur}" data-i="${i}" style="height:${st.wrap ? 'auto' : H + 'px'}"><span class="m">${msg}</span></div>`; }
    if (e.local) { return `<div class="row local${cur}" data-i="${i}" style="height:${st.wrap ? 'auto' : H + 'px'}"><span class="m">${msg}</span></div>`; }
    if (st.fmt === 'compact') {
      const head = `<span class="ctime">${first ? hx(e.ts.slice(11)) : ''}</span>\t<span class="lvb">${first ? e.lv : ''}</span>`;
      const tg = `<span style="color:${tagColor(e.tag)}">${first ? hx(e.tag) : ''}</span>`;
      return `<div class="row lv-${e.lv}${cur}" data-i="${i}" style="height:${st.wrap ? 'auto' : H + 'px'}">${head}\t<span class="tg-inline">${tg}</span>\t<span class="m">${msg}</span></div>`;
    }
    const lv = `<span class="lvb">${first ? e.lv : ''}</span>`;
    return `<div class="row lv-${e.lv}${cur}" data-i="${i}" style="height:${st.wrap ? 'auto' : H + 'px'}"><span class="ts">${first ? hx(e.ts) : ''}</span>\t<span class="pt">${first ? hx(e.pid + '-' + e.tid) : ''}</span>\t<span class="tg" style="color:${tagColor(e.tag)}" title="${esc(e.tag)}">${first ? hx(e.tag) : ''}</span>\t<span class="pk" title="${esc(e.pkg)}">${first ? hx(e.pkg) : ''}</span>\t${lv}\t<span class="m">${msg}</span></div>`;
  }

  // ---- search in the log (find bar) ----
  function hx(s) {
    const re = S.re;
    if (!re || !s) { return esc(s || ''); }
    re.lastIndex = 0;
    let out = '', p = 0, m;
    while ((m = re.exec(s))) {
      if (!m[0]) { re.lastIndex++; continue; }
      out += esc(s.slice(p, m.index)) + '<mark>' + esc(m[0]) + '</mark>'; p = m.index + m[0].length;
    }
    return out + esc(s.slice(p));
  }

  // 收集有效行索引对应的可见搜索字段，返回字符串数组；首行包含当前格式的元数据，续行只搜索消息，空源值不伪造。
  // 系统行仅搜索消息；回归：tests/logcat-buffer.test.js 与 tests/logcat-browser.test.js 的 system 用例断言元数据不命中、消息命中。
  function rowFields(i) {
    const { e, i: li } = rows[i];
    const f = [];
    if (li === 0 && !e.local && !e.system) {
      if (st.fmt === 'compact') { f.push(e.ts.slice(11)); } else { f.push(e.ts, e.pid + '-' + e.tid, e.pkg); }
      f.push(e.lv, e.tag);
    }
    f.push(e.lines[li]);
    return f;
  }

  function buildRe() {
    S.err = false;
    const t = S.open ? $('sq').value : '';
    if (!t) { return null; }
    try {
      let src = st.srx ? t : t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (st.sw) { src = `\\b(?:${src})\\b`; }
      return new RegExp(src, st.scc ? 'g' : 'gi');
    } catch { S.err = true; return null; }
  }

  function updateCount() {
    const n = S.rows.length;
    $('scount').textContent = !S.re ? '' : n ? `${S.cur + 1}/${n.toLocaleString('en-US')}` : 'No results';
    $('sbox').classList.toggle('error', S.err);
    $('s-up').disabled = $('s-down').disabled = !n;
  }

  // 可见时调度搜索，隐藏时只记录待更新；输入保持匹配与防抖时间，输出可取消任务。回归：tests/logcat-browser.test.js。
  function scheduleSearch(keep, delay) {
    if (!S.open) { return; }
    if (!hostVisible || document.hidden) { S.dirty = true; return; }
    if (S.timer && keep) { return; }
    clearTimeout(S.timer);
    S.timer = setTimeout(() => { S.timer = 0; runSearch(keep); }, delay);
  }

  // 搜索当前过滤结果并更新匹配；隐藏时保持脏状态，不扫描或更新DOM。回归：tests/logcat-browser.test.js。
  function runSearch(keep) {
    if (!hostVisible || document.hidden) { S.dirty = true; return; }
    S.dirty = false;
    const prev = S.rows[S.cur];
    S.re = buildRe();
    const m = [];
    if (S.re) {
      for (let i = 0; i < rows.length; i++) {
        for (const f of rowFields(i)) { if (f) { S.re.lastIndex = 0; if (S.re.test(f)) { m.push(i); break; } } }
      }
    }
    S.rows = m;
    if (!m.length) { S.cur = -1; updateCount(); render(); return; }
    if (keep && prev != null) {
      const k = m.indexOf(prev);
      S.cur = k >= 0 ? k : Math.min(Math.max(S.cur, 0), m.length - 1);
      updateCount(); render();
    } else {
      const top = rowAt(sc.scrollTop);
      const k = m.findIndex((x) => x >= top);
      S.cur = k >= 0 ? k : m.length - 1;
      reveal();
    }
  }

  // 搜索定位请求交给布局层统一处理；输入为当前匹配行，输出退出跟随后的居中位置。
  // 回归：tests/logcat-browser.test.js 搜索首部和末尾日志，验证换行定位。
  function reveal() {
    const r = S.rows[S.cur];
    updateCount();
    if (r == null) { render(); return; }
    setFollowing(false);
    requestedRow = r;
    render();
  }

  function go(dir) {
    if (!S.rows.length) { return; }
    S.cur = (S.cur + dir + S.rows.length) % S.rows.length;
    reveal();
  }

  function openSearch() {
    const bar = $('sbar'), input = $('sq');
    S.open = true; bar.style.display = 'flex';
    $('b-search')?.classList.add('on');
    const sel = String(getSelection() || '').trim();
    if (sel && !sel.includes('\n') && sel.length < 200) { input.value = sel; }
    input.focus(); input.select();
    scheduleSearch(false, 0);
  }

  function closeSearch() {
    S.open = false; S.re = null; S.rows = []; S.cur = -1; S.err = false;
    clearTimeout(S.timer); S.timer = 0;
    $('sbar').style.display = 'none';
    $('b-search')?.classList.remove('on');
    render();
  }

  // 构建右侧日志区的搜索栏；前提是 log-content/sc 已存在，输出为不影响左侧工具栏的搜索控件。
  // 回归：tests/logcat-style.test.js，npm test 执行构建与 Ctrl+F/Esc 开关，断言容器隔离及状态。
  (function buildSearchBar() {
    const bar = document.createElement('div');
    bar.id = 'sbar';
    bar.innerHTML = `<div id="sbox">${codicon('search')}<input id="sq" spellcheck="false" placeholder="Search in logs"><button class="ib" id="sclear" title="Clear">${codicon('close')}</button>` +
      '<button class="ib opt" id="s-cc" title="Match Case">Cc</button><button class="ib opt" id="s-w" title="Words">W</button><button class="ib opt" id="s-rx" title="Regex">.*</button></div>' +
      `<span id="scount"></span><button class="ib" id="s-up" title="Previous Occurrence (Shift+Enter)">${codicon('arrow-up')}</button><button class="ib" id="s-down" title="Next Occurrence (Enter)">${codicon('arrow-down')}</button>` +
      `<button class="ib" id="s-close" title="Close (Esc)">${codicon('close')}</button>`;
    $('log-content').insertBefore(bar, sc);
    const input = $('sq');
    const sync = () => {
      for (const [id, k] of [['s-cc', 'scc'], ['s-w', 'sw'], ['s-rx', 'srx']]) { $(id).classList.toggle('active', !!st[k]); }
      $('sclear').style.visibility = input.value ? 'visible' : 'hidden';
    };
    for (const [id, k] of [['s-cc', 'scc'], ['s-w', 'sw'], ['s-rx', 'srx']]) {
      $(id).onclick = () => { st[k] = !st[k]; save(); sync(); scheduleSearch(false, 0); input.focus(); };
    }
    input.addEventListener('input', () => { sync(); scheduleSearch(false, 120); });
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') { ev.preventDefault(); go(ev.shiftKey ? -1 : 1); }
      else if (ev.key === 'Escape') { ev.preventDefault(); closeSearch(); }
    });
    $('sclear').onclick = () => { input.value = ''; sync(); scheduleSearch(false, 0); input.focus(); };
    $('s-up').onclick = () => go(-1);
    $('s-down').onclick = () => go(1);
    $('s-close').onclick = closeSearch;
    document.addEventListener('keydown', (ev) => {
      if ((ev.metaKey || ev.ctrlKey) && !ev.altKey && ev.key.toLowerCase() === 'f') { ev.preventDefault(); openSearch(); }
      else if (ev.key === 'F3' && S.open) { ev.preventDefault(); go(ev.shiftKey ? -1 : 1); }
    });
    sync();
  })();

  let raf = 0, hostVisible = false;
  // 宿主和页面都可见时才绘制；输入可选宿主状态，输出隐藏任务取消或单次恢复绘制。
  // 不改变接收与缓存上限；回归：tests/logcat-browser.test.js 隐藏DOM零变化、搜索取消和恢复断言。
  function syncVisibility(value = hostVisible) {
    hostVisible = value;
    if (!hostVisible || document.hidden) {
      if (raf) { cancelAnimationFrame(raf); raf = 0; }
      if (S.timer) { clearTimeout(S.timer); S.timer = 0; S.dirty = true; }
      return;
    }
    render();
  }
  document.addEventListener('visibilitychange', () => syncVisibility());
  // 合并可见时同帧布局；无输入，输出单次绘制，隐藏期间不排队，恢复时显示当前状态。
  // 宿主init建立工具栏后才允许首绘；LOGCAT_BROWSER=1 的 format and build controls 验证初始化零异常，原追加/缩放断言覆盖稳定性。
  function render() { if (hostVisible && !document.hidden && !raf) { raf = requestAnimationFrame(() => { raf = 0; draw(); }); } }

  // 以缓存的实际行高构建前缀坐标；输入为当前 rows，输出完整缓存范围的 offsets。
  // 未测量行采用编辑器行高估计，输出 offsetRows 身份快照与 offsets 同步；显示后同次布局更新实测高度，不删除历史行。
  // 回归：tests/logcat-browser.test.js 的 scroll coverage 验证大跳跃/未知换行高度/淘汰覆盖，另验证超过 3000 行搜索和跳转。
  function measureOffsets() {
    offsets = [0]; offsetRows = rows.slice();
    for (const row of rows) {
      const height = st.wrap ? rowHeights.get(row.e)?.get(row.i) ?? H : H;
      offsets.push(offsets[offsets.length - 1] + height);
    }
  }

  // 二分定位滚动坐标所属行；输入为像素坐标，输出有界行索引，空列表返回 0。
  // 前提为 offsets 快照已建立，不依赖可能刚淘汰的新 rows 长度；回归 tests/logcat-style.test.js 边界及 browser 的 scroll coverage。
  function rowAt(top) {
    let low = 0, high = offsets.length - 1;
    while (low < high) {
      const mid = Math.floor((low + high) / 2);
      if (offsets[mid + 1] <= top) { low = mid + 1; } else { high = mid; }
    }
    return Math.min(low, Math.max(0, offsets.length - 2));
  }

  // 保存真实记录、逻辑行内偏移和屏幕相位；输入 painted 表示 draw 已提交布局，无返回值。
  // 前置为 offsets/offsetRows 属于同次已测量快照；淘汰后的新 rows 不得解释旧滚动坐标，绘制后读回实际几何。
  // 跟随也保存快照承接滚轮退出，程序 clamp 在同次 draw 末尾结算；回归 tests/logcat-browser.test.js 的 scroll coverage 和多行溢出矩阵断言覆盖/identity/top/PNG。
  function rememberAnchor(painted = false) {
    if (!offsetRows.length) { return; }
    const scrollTop = sc.scrollTop, index = rowAt(scrollTop), row = offsetRows[index];
    const previous = viewportAnchor ? offsetRows.findIndex((r) => r.e === viewportAnchor.e && r.i === viewportAnchor.i) : -1;
    let top = offsets[index] - scrollTop;
    if (!painted && previous >= 0) {
      top = viewportAnchor.top + (offsets[index] - offsets[previous]) - (scrollTop - viewportAnchor.scrollTop);
    } else if (painted) {
      const node = Array.from(win.children).find((node) => renderedRows.get(node)?.e === row.e && renderedRows.get(node)?.i === row.i);
      if (node) { top = node.getBoundingClientRect().top - sc.getBoundingClientRect().top; }
    }
    viewportAnchor = { e: row.e, i: row.i, offset: scrollTop - offsets[index], top, scrollTop };
  }

  // 同步末尾跟随的唯一状态与按钮；输入布尔值，输出按钮选中和可访问状态。
  // 回归：tests/logcat-browser.test.js 验证切换、向上滚动、点击日志和追加跟随。
  function setFollowing(value) {
    stick = value;
    const button = $('b-end');
    if (button && hostVisible && !document.hidden) { button.classList.toggle('on', stick); button.setAttribute('aria-pressed', String(stick)); }
    if (stick) { viewportAnchor = null; requestedRow = null; } else { rememberAnchor(); }
  }

  // 返回涉及日志区的非空原生选区；无输入，输出 Selection 或 null，不干扰过滤框/页面其他选区。
  // 前提是 Webview Selection API 可用；回归：tests/logcat-browser.test.js 框选、扩选和外部选区。
  function logSelection() {
    const selection = getSelection();
    return selection && !selection.isCollapsed && (sc.contains(selection.anchorNode) || sc.contains(selection.focusNode)) ? selection : null;
  }

  // 复用同一日志记录的行节点；输入可见行范围，输出增删必要节点后的窗口，未变文字不被重建。
  // 记录/行索引是身份，data-i仅是坐标；只写变化字段，不清除既有top，未匹配批次对日志DOM零修改。
  // 回归：tests/logcat-browser.test.js filtered-out batches断言零属性写入、选区保留和新匹配正常追加。
  function updateWindow(a, b) {
    const previous = new Map(), desired = [];
    for (const node of win.children) {
      const row = renderedRows.get(node);
      if (row) { let lines = previous.get(row.e); if (!lines) { lines = new Map(); previous.set(row.e, lines); } lines.set(row.i, node); }
    }
    const template = document.createElement('template');
    let html = ''; for (let i = a; i < b; i++) { html += rowHtml(i); }
    template.innerHTML = html;
    for (const fresh of template.content.children) {
      const row = rows[+fresh.dataset.i], node = previous.get(row.e)?.get(row.i) || fresh;
      if (node !== fresh) {
        if (node.children.length !== fresh.children.length) { node.innerHTML = fresh.innerHTML; }
        else {
          // 包名延迟补全只更新相应字段，不销毁用户正在选择的消息文本节点。
          for (let i = 0; i < node.children.length; i++) {
            const field = node.children[i], next = fresh.children[i];
            if (field.innerHTML !== next.innerHTML) { field.innerHTML = next.innerHTML; }
            if (field.className !== next.className) { field.className = next.className; }
            if (field.style.cssText !== next.style.cssText) { field.style.cssText = next.style.cssText; }
          }
        }
        if (node.className !== fresh.className) { node.className = fresh.className; }
        if (node.style.height !== fresh.style.height) { node.style.height = fresh.style.height; }
        if (node.dataset.i !== fresh.dataset.i) { node.dataset.i = fresh.dataset.i; }
      }
      renderedRows.set(node, row); desired.push(node);
    }
    const keep = new Set(desired);
    for (const node of Array.from(win.children)) { if (!keep.has(node)) { node.remove(); } }
    let cursor = win.firstChild;
    for (const node of desired) { if (node === cursor) { cursor = cursor.nextSibling; } else { win.insertBefore(node, cursor); } }
  }

  // 在固定/可变行高模式共用虚拟窗口；无输入，输出测量后的 DOM、总高度和滚动位置。
  // 前置为可见且非组合输入；draw 独占固定层坐标，原生滚动仅提供范围和用户位移，不以量化目标冒充浏览器实际 scrollTop。
  // 跟随采用距末尾相对坐标，阅读采用距存活锚点相对坐标，避免累计 offset 量化相减改变 glyph 相位；dirty 搜索语义不变。
  // 回归 tests/logcat-browser.test.js 的 scroll coverage 在短窗360/DPR1.25/两种过滤和换行断言逐帧顶边覆盖；多行溢出矩阵严格断言 top/identity/PNG。
  function draw() {
    if (!hostVisible || document.hidden) { return; }
    if (composition) { return; }
    const selection = logSelection();
    const caret = getSelection();
    const retainedSelection = selection || (document.activeElement === viewport && caret?.rangeCount && viewport.contains(caret.anchorNode) ? caret : null);
    if (selection && stick) { setFollowing(false); }
    const n = rows.length;
    drawHeader();
    $('count').textContent = entries.length ? `${n} / ${entries.length}` : '';
    $('empty').textContent = entries.length ? '' : (serial ? 'Waiting for logs...' : 'No device connected');
    const key = [st.wrap, st.fmt, sc.clientWidth, H, getComputedStyle(sc).fontFamily, getComputedStyle(sc).fontWeight].join('|');
    if (layoutKey !== key) { rowHeights = new WeakMap(); layoutKey = key; }
    measureOffsets();
    const anchorIndex = viewportAnchor ? rows.findIndex((r) => r.e === viewportAnchor.e && r.i === viewportAnchor.i) : -1;
    const focus = requestedRow != null && requestedRow < n ? requestedRow : null;
    const box = sc.getBoundingClientRect(), layer = $('win');
    if (layer.style.top !== box.top + 'px') { layer.style.top = box.top + 'px'; }
    if (layer.style.left !== box.left + 'px') { layer.style.left = box.left + 'px'; }
    if (layer.style.width !== sc.clientWidth + 'px') { layer.style.width = sc.clientWidth + 'px'; }
    if (viewport.style.height !== sc.clientHeight + 'px') { viewport.style.height = sc.clientHeight + 'px'; }
    let origin = 0;
    // 布局工作集只测量本次覆盖范围的未知行；每轮必须消耗未知高度，直到当前坐标下的窗口完整可用。
    // 这是同一布局事务而非延时重试：实测改变前缀与原生上限后，范围和固定层均使用重新读回的坐标。
    const measured = new Set();
    for (;;) {
      let target = stick ? offsets[n] - sc.clientHeight : focus != null ? offsets[focus] - sc.clientHeight / 2 + (offsets[focus + 1] - offsets[focus]) / 2
        : anchorIndex >= 0 ? offsets[anchorIndex] + viewportAnchor.offset : viewportAnchor ? 0 : sc.scrollTop;
      if (spacer.style.height !== offsets[n] + 'px') { spacer.style.height = offsets[n] + 'px'; }
      const boundedTarget = Math.max(0, Math.min(target, sc.scrollHeight - sc.clientHeight));
      if (sc.scrollTop !== boundedTarget) { sc.scrollTop = boundedTarget; }
      const scrollTop = sc.scrollTop;
      origin = stick ? offsets[n] - Math.min(sc.clientHeight, offsets[n])
        : focus == null && anchorIndex >= 0 ? offsets[anchorIndex] - viewportAnchor.top - (target - boundedTarget)
          : scrollTop;
      let a = Math.max(0, rowAt(origin) - 10), b = Math.min(n, rowAt(origin + sc.clientHeight) + 11);
      if (retainedSelection) {
        for (const endpoint of [retainedSelection.anchorNode, retainedSelection.focusNode]) {
          const node = (endpoint.nodeType === Node.ELEMENT_NODE ? endpoint : endpoint.parentElement)?.closest('.row');
          const row = node && renderedRows.get(node), index = row ? rows.findIndex((r) => r.e === row.e && r.i === row.i) : -1;
          if (index >= 0) { a = Math.min(a, index); b = Math.max(b, index + 1); }
        }
      }
      updateWindow(a, b);
      let changed = false;
      if (st.wrap) {
        for (const node of win.children) {
          const row = rows[+node.dataset.i];
          if (measured.has(row)) { continue; }
          measured.add(row);
          let heights = rowHeights.get(row.e);
          if (!heights) { heights = new Map(); rowHeights.set(row.e, heights); }
          const height = Math.max(H, node.getBoundingClientRect().height);
          if ((heights.get(row.i) ?? H) !== height) { changed = true; }
          heights.set(row.i, height);
        }
      }
      if (!changed) { break; }
      measureOffsets();
    }
    const width = (st.wrap ? 1 : Array.from(win.children).reduce((size, node) => Math.max(size, node.scrollWidth), sc.clientWidth)) + 'px';
    if (spacer.style.width !== width) { spacer.style.width = width; }
    const left = -sc.scrollLeft + 'px';
    if (win.style.left !== left) { win.style.left = left; }
    for (const node of win.children) {
      const top = offsets[+node.dataset.i] - origin + 'px';
      if (node.style.top !== top) { node.style.top = top; }
    }
    requestedRow = null;
    if (tailCaret) {
      const node = Array.from(win.children).find((node) => renderedRows.get(node)?.e === tailCaret && +node.dataset.i === rows.length - 1);
      if (node) { showInputCaret(node); }
      tailCaret = null;
    }
    rememberAnchor(true);
    if (S.open && S.dirty) { scheduleSearch(true, 500); }
  }

  // 日志文档清空/切换时释放临时组合节点和待定位光标；无输入/输出，旧组合不得提交到新文档。
  // 回归：tests/logcat-browser.test.js 组合输入期间reset，前提为清空、设备切换或reset入口。
  function resetEditor() { composition?.remove(); composition = null; tailCaret = null; }

  // 将原生Range放到已绘制的本地行尾，并把尾端横向纳入sc视口；输入尾行DOM，输出可见、聚焦的collapsed caret。
  // 前提为draw已完成纵向末尾布局；不调用scrollIntoView移动fixed祖先，browser tail input回归检查Range在视口内。
  function showInputCaret(node) {
    const message = node.querySelector('.m');
    const range = document.createRange();
    const walker = document.createTreeWalker(message, NodeFilter.SHOW_TEXT);
    let text, last; while ((text = walker.nextNode())) { last = text; }
    if (last) { range.setStart(last, last.length); }
    else { if (!message.firstChild) { message.appendChild(document.createElement('br')); } range.setStart(message, 0); }
    range.collapse(true);
    viewport.focus({ preventScroll: true });
    const caret = getSelection(); caret.removeAllRanges(); caret.addRange(range);
    const bounds = range.getBoundingClientRect(), box = sc.getBoundingClientRect();
    const x = bounds.height ? bounds.left : message.getBoundingClientRect().right;
    const delta = x < box.left + 2 ? x - box.left - 2 : x > box.left + sc.clientWidth - 2 ? x - box.left - sc.clientWidth + 2 : 0;
    if (delta) {
      spacer.style.width = Math.max(sc.scrollWidth, sc.scrollLeft + delta + sc.clientWidth + 2) + 'px';
      sc.scrollLeft += delta; win.style.left = -sc.scrollLeft + 'px';
    }
  }

  // 每次提交前准备可见文档的尾输入记录并迁移Selection，输入无，输出记录身份；历史日志不参与浏览器插入或IME组合。
  // Studio UserInputHandlers按document.textLength追加，过滤隐藏的原始记录不构成可见换行；不移动缓存中的记录顺序。
  // 回归：browser filtered background/tail input断言隐藏批次不中断续写、可见新日志正常追加、Enter与IME保留换行。
  function prepareTailInput() {
    getSelection().removeAllRanges();
    let entry;
    for (let i = entries.length - 1; i >= 0; i--) { if (visible(entries[i])) { entry = entries[i]; break; } }
    if (!entry?.local) {
      entry = { local: true, ts: '', pid: 0, tid: 0, lv: 'I', lvn: 4, tag: '', pkg: '', lines: [''], bytes: 1, rx: Date.now() };
      entries.push(entry); entriesBytes++;
    }
    trimEntries(); tailCaret = entry; setFollowing(true); draw();
    return entry;
  }

  // 将键盘或粘贴文字提交到有界文档尾部；输入纯文本，输出本地记录，绝不替换光标下的设备日志。
  // 本地输入不伪造ADB元数据，输入完成后恢复末尾跟随和真实光标；回归：tests/logcat-browser.test.js 编辑交互。
  function appendInput(text) {
    if (!text) { return; }
    let entry = prepareTailInput();
    const value = LogcatBuffer.truncateUtf8(text.replace(/\r\n?/g, '\n'), maxBytes - 1);
    const combined = entry?.local ? entry.lines.join('\n') + value : value;
    if (entry?.local && LogcatBuffer.utf8Bytes(combined) + 1 <= maxBytes) {
      const old = entry.bytes;
      const message = combined;
      entry.lines = message.split('\n'); entry.bytes = LogcatBuffer.utf8Bytes(message) + 1; entriesBytes += entry.bytes - old;
      rowHeights.delete(entry);
    } else {
      entry = { local: true, ts: '', pid: 0, tid: 0, lv: 'I', lvn: 4, tag: '', pkg: '', lines: value.split('\n'), bytes: LogcatBuffer.utf8Bytes(value) + 1, rx: Date.now() };
      entries.push(entry); entriesBytes += entry.bytes;
    }
    if (logSelection()) { getSelection().removeAllRanges(); }
    trimEntries(); tailCaret = entry; setFollowing(true); render();
  }

  // 原生可编辑面提供光标、选词和扩选；beforeinput只允许尾部追加，删除/剪切/撤销不改写采集日志。
  // 组合输入由临时尾部文本节点承接，结束后移除临时节点并提交模型；回归：tests/logcat-browser.test.js 输入/粘贴/IME。
  viewport.addEventListener('beforeinput', (event) => {
    if (composition) { return; }
    event.preventDefault();
    if (event.inputType === 'insertText' || event.inputType === 'insertReplacementText') { appendInput(event.data || ''); }
    else if (event.inputType === 'insertParagraph' || event.inputType === 'insertLineBreak') { appendInput('\n'); }
  });
  viewport.addEventListener('paste', (event) => { event.preventDefault(); appendInput(event.clipboardData.getData('text/plain')); });
  viewport.addEventListener('drop', (event) => { event.preventDefault(); appendInput(event.dataTransfer.getData('text/plain')); });
  viewport.addEventListener('cut', (event) => { event.preventDefault(); if (logSelection()) { vs.postMessage({ type: 'copy', text: String(getSelection()) }); } });
  viewport.addEventListener('compositionstart', () => {
    prepareTailInput();
    const message = win.lastElementChild.querySelector('.m');
    const node = document.createElement('span'); node.textContent = ''; message.appendChild(node);
    composition = node; const range = document.createRange(); range.selectNodeContents(node); range.collapse(false); const caret = getSelection(); caret.removeAllRanges(); caret.addRange(range); setFollowing(false);
  });
  viewport.addEventListener('compositionend', (event) => { const node = composition; if (!node) { return; } composition = null; node.remove(); appendInput(event.data || ''); render(); });
  viewport.addEventListener('keydown', (event) => { if (event.key === 'Tab' && !event.ctrlKey && !event.metaKey && !event.altKey) { event.preventDefault(); appendInput('\t'); } });

  document.addEventListener('selectionchange', () => { if (logSelection() && stick) { setFollowing(false); } });
  sc.addEventListener('scroll', () => {
    if (stick && sc.scrollTop + sc.clientHeight < sc.scrollHeight - 2) { setFollowing(false); }
    rememberAnchor();
    render();
  });
  // fixed 文字层不参与祖先的原生滚轮滚动链；输入像素/行/页位移，输出到唯一滚动容器 sc，避免文字区滚轮失效。
  // 仅接管绘制层内事件，空白/滚动条保留原生滚动，Ctrl 缩放不拦截；browser 的 real wheel 回归覆盖上下/横向/换行/过滤及跟随。
  sc.addEventListener('wheel', (ev) => {
    if (ev.ctrlKey || ev.defaultPrevented) { return; }
    if (ev.deltaY < 0) { setFollowing(false); }
    if (!viewport.contains(ev.target)) { return; }
    ev.preventDefault();
    const unit = ev.deltaMode === WheelEvent.DOM_DELTA_LINE ? H : ev.deltaMode === WheelEvent.DOM_DELTA_PAGE ? sc.clientHeight : 1;
    sc.scrollTop += (ev.shiftKey ? 0 : ev.deltaY) * unit;
    sc.scrollLeft += (ev.deltaX + (ev.shiftKey ? ev.deltaY : 0)) * unit;
    rememberAnchor(); render();
  }, { passive: false });
  sc.addEventListener('click', (ev) => { if (ev.target.closest('.row')) { setFollowing(false); } });
  sc.addEventListener('pointerdown', (ev) => { if (ev.target.closest('.row')) { setFollowing(false); } });
  sc.addEventListener('keydown', (ev) => { if (['ArrowUp', 'PageUp', 'Home'].includes(ev.key)) { setFollowing(false); } });
  new ResizeObserver(render).observe(sc);

  // 从编辑器计算样式同步行高；无输入，输出更新后的 H 与布局，阅读锚点由 draw 保留。
  // CSS 将继承字号的 1.5em 行高向上对齐整数像素；H 读取同一实际值，避免 scrollHeight 取整交替偏移。
  // 回归：tests/logcat-style.test.js 行高边界；tests/logcat-browser.test.js 奇数字号持续追加断言基线波动 <0.05px。
  function syncFontMetrics() {
    const height = parseFloat(getComputedStyle(sc).lineHeight);
    if (height === H) { return; }
    H = height;
    render();
  }
  new MutationObserver(syncFontMetrics).observe(document.body, { attributes: true, attributeFilter: ['style', 'class'] });

  // ---- filter input, history, favorites ----
  function setFilter(v, remember) {
    st.filter = v; q.value = v;
    if (remember && v.trim()) { st.history = [v, ...st.history.filter((x) => x !== v)].slice(0, 30); }
    save(); recompile();
  }
  q.addEventListener('input', () => { st.filter = q.value; save(); recompile(); });
  q.addEventListener('scroll', () => { hl.scrollLeft = q.scrollLeft; });
  const STACK = /^\s+at\s+\S+\(.*\)|^Caused by: /;
  function jumpStack(dir) {
    const top = rowAt(sc.scrollTop);
    for (let i = dir > 0 ? top + 1 : top - 1; i >= 0 && i < rows.length; i += dir) {
      const r = rows[i];
      if (STACK.test(r.e.lines[r.i] || '') && (i === 0 || !STACK.test(rows[i - 1].e.lines[rows[i - 1].i] || '') || dir < 0)) {
        setFollowing(false); requestedRow = i; render(); return;
      }
    }
  }
  const cc = document.createElement('button'); cc.className = 'ib cc'; cc.id = 'cc'; cc.textContent = 'Cc'; cc.title = 'Match Case';
  const clr = document.createElement('button'); clr.className = 'ib'; clr.id = 'qclear'; clr.title = 'Clear filter'; clr.innerHTML = codicon('close');
  $('filterbox').insertBefore(clr, $('fav')); $('filterbox').insertBefore(cc, $('fav'));
  const syncQ = () => { cc.classList.toggle('active', !!st.cc); clr.style.visibility = q.value ? 'visible' : 'hidden'; };
  cc.onclick = () => { st.cc = !st.cc; save(); syncQ(); recompile(); };
  clr.onclick = () => { setFilter('', false); q.focus(); };
  q.addEventListener('input', syncQ); syncQ();

  // ---- key completion popup ----
  const TXT = { tag: 'Tag', package: 'Package name', process: 'Process name', message: 'Log message', line: 'Log line', name: 'Tag' };
  const MODE = { '': ['contains string', 'does not contain string'], '=': ['is exactly string', 'is not exactly string'], '~': ['matches string', 'does not match string'] };
  const sugg = [];
  for (const neg of ['', '-']) for (const k of Object.keys(TXT)) for (const m of ['', '=', '~']) {
    sugg.push({ ins: `${neg}${k}${m}:`, desc: `${TXT[k]} ${MODE[m][neg ? 1 : 0]}`.replace(/^(Log message|Log line) (contains|does)/, '$1 $2') });
  }
  sugg.push({ ins: 'level:', desc: 'Log level is at least' }, { ins: 'level=:', desc: 'Log level is exactly' },
    { ins: 'age:', desc: 'Entries newer than, e.g. 5m, 30s, 2h' }, { ins: 'is:crash', desc: 'Crash entries' }, { ins: 'is:stacktrace', desc: 'Stack trace entries' });
  const VALS = { level: ['verbose', 'debug', 'info', 'warn', 'error', 'assert'], is: ['crash', 'stacktrace', 'firebase'] };
  const pop = document.createElement('div');
  pop.id = 'sugg'; document.getElementById('filterbox').appendChild(pop);
  let items = [], sel = 0;
  function wordStart() {
    const c = q.selectionStart, before = q.value.slice(0, c);
    let inQ = false, st0 = 0;
    for (let i = 0; i < before.length; i++) {
      const ch = before[i];
      if (ch === '"') { inQ = !inQ; } else if (!inQ && (ch === ' ' || ch === '(')) { st0 = i + 1; }
    }
    return { st0, word: before.slice(st0), end: c };
  }
  function showSugg() {
    const { word } = wordStart();
    items = [];
    const m = word.match(/^-?(\w+)([=~]?):(.*)$/);
    const key = m && m[1].toLowerCase();
    if (m && (VALS[key] || ['tag', 'name', 'package', 'process'].includes(key))) {
      const typed = m[3].replace(/^"/, '').toLowerCase(), head = word.slice(0, word.indexOf(':') + 1);
      let vals = VALS[key];
      if (!vals) {
        const freq = new Map();
        for (let i = Math.max(0, entries.length - 5000); i < entries.length; i++) {
          const v = key === 'tag' || key === 'name' ? entries[i].tag : entries[i].pkg;
          if (v) { freq.set(v, (freq.get(v) || 0) + 1); }
        }
        vals = [...freq.entries()].sort((a, b) => b[1] - a[1]).map((x) => x[0]);
        if (key === 'package' || key === 'process') { vals = ['mine', ...vals]; }
      }
      items = vals.filter((v) => v.toLowerCase().includes(typed) && v.toLowerCase() !== typed).slice(0, 100)
        .map((v) => ({ ins: head + (/[\s"()|&]/.test(v) ? '"' + v + '"' : v), desc: key === 'package' && v === 'mine' ? 'Packages of the open project' : '' }));
    } else if (word && !word.includes(':')) {
      items = sugg.filter((x) => x.ins.startsWith(word.toLowerCase()));
    }
    sel = 0;
    if (!items.length) { pop.style.display = 'none'; return; }
    pop.innerHTML = items.map((x, i) => `<div class="si${i === 0 ? ' on' : ''}" data-i="${i}"><span>${esc(x.ins)}</span><span class="d">${esc(x.desc)}</span></div>`).join('');
    pop.style.display = 'block';
  }
  function pick(i) {
    const x = items[i]; if (!x) { return; }
    const { st0, end } = wordStart();
    q.value = q.value.slice(0, st0) + x.ins + q.value.slice(end);
    q.selectionStart = q.selectionEnd = st0 + x.ins.length;
    st.filter = q.value; save(); recompile(); showSugg(); q.focus();
  }
  function mark() { [...pop.children].forEach((c, i) => c.classList.toggle('on', i === sel)); pop.children[sel]?.scrollIntoView({ block: 'nearest' }); }
  pop.addEventListener('mousedown', (e) => { e.preventDefault(); const d = e.target.closest('.si'); if (d) { pick(+d.dataset.i); } });
  q.addEventListener('input', showSugg);
  q.addEventListener('click', showSugg);
  q.addEventListener('blur', () => { pop.style.display = 'none'; });
  q.addEventListener('keydown', (ev) => {
    if (pop.style.display !== 'block') { return; }
    if (ev.key === 'ArrowDown') { sel = (sel + 1) % items.length; mark(); ev.preventDefault(); }
    else if (ev.key === 'ArrowUp') { sel = (sel - 1 + items.length) % items.length; mark(); ev.preventDefault(); }
    else if (ev.key === 'Tab' || ev.key === 'Enter') { pick(sel); ev.preventDefault(); ev.stopImmediatePropagation(); }
    else if (ev.key === 'Escape') { pop.style.display = 'none'; ev.preventDefault(); }
  }, true);
  q.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { setFilter(q.value, true); } });
  q.addEventListener('blur', () => { if (q.value.trim()) { st.history = [q.value, ...st.history.filter((x) => x !== q.value)].slice(0, 30); save(); } });

  function updateFav() {
    const f = $('fav'); const on = st.favs.includes(st.filter);
    f.innerHTML = svg(on ? 'favorite-filled' : 'favorite'); f.classList.toggle('active', on);
    f.title = on ? 'Remove from favorites' : 'Add to favorites';
  }
  $('fav').onclick = () => {
    if (!st.filter.trim()) { return; }
    st.favs = st.favs.includes(st.filter) ? st.favs.filter((x) => x !== st.filter) : [st.filter, ...st.favs];
    save(); updateFav();
  };

  let menuEl;
  function closeMenu() { if (menuEl) { menuEl.remove(); menuEl = null; } }
  function openMenu(items, x, y, cls) {
    closeMenu();
    const m = document.createElement('div'); m.className = 'menu ' + (cls || '');
    for (const it of items) {
      if (it === '-') { m.appendChild(document.createElement('hr')); continue; }
      const d = document.createElement('div'); d.textContent = it.label;
      if (it.sec) { d.className = 'sec'; } else { d.onclick = () => { closeMenu(); it.run(); }; }
      m.appendChild(d);
    }
    document.body.appendChild(m);
    const r = m.getBoundingClientRect();
    m.style.left = Math.max(0, Math.min(x, innerWidth - r.width)) + 'px';
    m.style.top = Math.max(0, Math.min(y, innerHeight - r.height)) + 'px';
    menuEl = m;
  }
  document.addEventListener('mousedown', (e) => { if (menuEl && !menuEl.contains(e.target)) { closeMenu(); } });

  function matchCount(f) {
    try {
      const c = LogFilter.compile(f, () => ({ mine, matchCase: !!st.cc }));
      if (c.error) { return 0; }
      let n = 0;
      for (let i = entries.length - 1; i >= 0 && n < 100; i--) { if (c.test(entries[i])) { n++; } }
      return n;
    } catch { return 0; }
  }
  $('hist-btn').onclick = (ev) => {
    closeMenu();
    const r = $('filterbox').getBoundingClientRect();
    const m = document.createElement('div'); m.className = 'menu hist';
    const list = [...st.favs.map((f) => ({ f, fav: true })), ...st.history.filter((f) => !st.favs.includes(f)).map((f) => ({ f }))];
    if (!list.length) { const d = document.createElement('div'); d.className = 'sec'; d.textContent = 'No history yet'; m.appendChild(d); }
    for (const it of list) {
      const d = document.createElement('div'); d.className = 'hrow';
      const n = matchCount(it.f);
      d.innerHTML = (it.fav ? '<span class="star">' + svg('favorite-filled') + '</span>' : '') + '<span class="t">' + esc(it.f) + '</span><span class="n">' + (n >= 100 ? '99+' : n) + '</span><span class="x" title="Remove">' + codicon('trash') + '</span>';
      d.onclick = (e) => {
        if (e.target.closest('.x')) {
          st.history = st.history.filter((h) => h !== it.f); st.favs = st.favs.filter((h) => h !== it.f);
          save(); updateFav(); d.remove(); return;
        }
        closeMenu(); setFilter(it.f, true); q.focus();
      };
      m.appendChild(d);
    }
    document.body.appendChild(m);
    const h = m.getBoundingClientRect();
    m.style.minWidth = r.width + 'px';
    m.style.left = Math.max(0, Math.min(r.left, innerWidth - h.width)) + 'px';
    m.style.top = r.bottom + 2 + 'px';
    menuEl = m;
    ev.stopPropagation();
  };

  // ---- context menu ----
  // 右键复制沿用日志消息/行命令，系统行不附加元数据；browser 的 system 回归通过菜单断言完整分隔行。
  const quote = (v) => (/[\s"()|&]/.test(v) ? '"' + v.replace(/"/g, '\\"') + '"' : v);
  const append = (term) => setFilter((st.filter.trim() ? st.filter.trim() + ' ' : '') + term, true);
  sc.addEventListener('contextmenu', (ev) => {
    const row = ev.target.closest('.row'); if (!row) { return; }
    ev.preventDefault();
    const { e, i } = rows[+row.dataset.i];
    const items = [
      { label: `Show only tag: ${e.tag}`, run: () => append('tag:' + quote(e.tag)) },
      { label: `Hide tag: ${e.tag}`, run: () => append('-tag:' + quote(e.tag)) },
    ];
    if (e.pkg) { items.push('-', { label: `Show only package: ${e.pkg}`, run: () => append('package:' + quote(e.pkg)) }, { label: `Hide package: ${e.pkg}`, run: () => append('-package:' + quote(e.pkg)) }); }
    items.push('-', { label: `Show this level and above (${e.lv})`, run: () => append('level:' + e.lv) });
    items.push('-', { label: 'Copy message', run: () => vs.postMessage({ type: 'copy', text: e.lines.join('\n') }) },
      { label: 'Copy line', run: () => vs.postMessage({ type: 'copy', text: e.system ? e.lines[i] : `${e.ts} ${e.pid}-${e.tid} ${e.tag} ${e.lv}: ${e.lines[i]}` }) });
    openMenu(items, ev.clientX, ev.clientY);
  });

  // ---- header ----
  $('fmt').value = st.fmt;
  $('fmt').onchange = () => { st.fmt = $('fmt').value; save(); scheduleSearch(false, 0); render(); };
  // 鼠标/触摸和键盘展开均查询目录；npm test 的 device-selection-sync.test.js 执行真实绑定，断言每次展开各发一次查询。
  $('dev').onpointerdown = e => { if (e.button === 0) vs.postMessage({ type: 'discoverDevices' }); };
  $('dev').onkeydown = e => { if (['Enter', ' ', 'ArrowDown', 'ArrowUp', 'F4'].includes(e.key)) vs.postMessage({ type: 'discoverDevices' }); };
  $('dev').onchange = () => { resetEditor(); entries = []; rows = []; entriesBytes = 0; vs.postMessage({ type: 'select', serial: $('dev').value }); };

  // 绘制全部设备与状态快照；无输入，在线设备可选，离线/未授权项标注状态并禁用，空选择保留占位。
  // 前提由 draw 保证可见，隐藏消息只更新模型；device-selection-sync.test.js 执行渲染并断言状态、禁用项和空选项。
  // 回归：npm test 的 device-selection-sync.test.js 断言断开且仍有设备时显示明确空选项；logcat-browser.test.js 断言隐藏零DOM更新和显示恢复。
  // 原生selectedcontent随选项目录一并生成，由浏览器同步选中标签；dropdown浏览器回归在刷新目录/长名称/空选择后断言标签省略且与箭头不重叠。
  function drawHeader() {
    const end = $('b-end');
    end.classList.toggle('on', stick); end.setAttribute('aria-pressed', String(stick));
    const sel = $('dev'), sig = JSON.stringify(deviceList) + serial;
    if (sel.dataset.sig !== sig) {
      sel.dataset.sig = sig;
      sel.innerHTML = '<button type="button"><selectedcontent></selectedcontent></button>' + (deviceList.length ? '<option value="">Select Device</option>' + deviceList.map((d) => `<option value="${esc(d.serial)}"${d.state === 'device' ? '' : ' disabled'}>${esc(d.name || d.avdName || d.model || d.serial)} (${esc(d.serial)})${d.state === 'device' ? '' : ' (' + esc(d.state) + ')'}</option>`).join('') : '<option value="">No devices</option>');
      sel.value = serial;
    }
    const status = $('status');
    if (status.textContent !== statusText) { status.textContent = statusText; }
    status.style.display = statusText ? 'block' : 'none';
  }

  // 更新状态模型和原有四秒过期任务；输入文本，输出待绘制状态，定时回调不直接写DOM。
  // 回归：tests/logcat-browser.test.js 隐藏状态与恢复；只保留最新状态的一个过期任务。
  function setStatus(text) {
    statusText = text; clearTimeout(statusTimer); statusTimer = 0;
    if (text) { statusTimer = setTimeout(() => { statusTimer = 0; statusText = ''; render(); }, 4000); }
    render();
  }

  // 接收后端初始化、设备、日志批次和状态消息；输入为 Webview 消息，输出为界面状态及有界缓存更新。
  // init/reset/batch 分支维护 maxBytes、entriesBytes 和 pendingBytes；回归：tests/logcat-buffer.test.js。
  window.addEventListener('message', (ev) => {
    const m = ev.data;
    switch (m.type) {
      case 'visibility': syncVisibility(m.visible); break;
      case 'init': hostVisible = m.visible !== false; icons = m.icons; mine = m.mine || []; maxBytes = Number.isFinite(m.maxBytes) ? m.maxBytes : 1024 * 1024; buildToolbar(); q.value = st.filter; applyWrap(); recompile(); break;
      case 'devices': serial = m.serial || ''; deviceList = m.list; render(); break;
      case 'reset': resetEditor(); if (logSelection()) { getSelection().removeAllRanges(); } entries = []; rows = []; entriesBytes = 0; S.dirty = true; pending = []; pendingBytes = 0; pkgMap = {}; viewportAnchor = null; setFollowing(true); render(); break;
      case 'batch': {
        if (paused) {
          const batch = m.items.map(normalizeItem);
          for (const item of batch) { pending.push(item); }
          pendingBytes += batch.reduce((sum, item) => sum + itemBytes(item), 0);
          trimPending();
        } else { ingest(m.items); render(); }
        break;
      }
      case 'pkgs': {
        Object.assign(pkgMap, m.map);
        let changed = false;
        for (let i = entries.length - 1; i >= 0 && i >= entries.length - 5000; i--) {
          const e = entries[i]; if (!e.pkg && pkgMap[e.pid]) { e.pkg = pkgMap[e.pid]; changed = true; }
        }
        if (changed) { if (/package|is:|mine/.test(st.filter)) { rebuild(); } render(); }
        break;
      }
      case 'status': setStatus(m.text); break;
    }
  });

  vs.postMessage({ type: 'ready' });
  initBuildPanel(message => vs.postMessage(message));
})();
