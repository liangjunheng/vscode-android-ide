(function () {
  const vs = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const st = Object.assign({ asc: true, collapsed: {} }, vs.getState() || {});
  let icons = {}, rows = [], sel = st.selected || null, menuEl = null;
  const busy = new Map(); // row id -> { state: 'starting' | 'stopping', timer }
  const setBusy = (id, state) => {
    clearTimeout(busy.get(id)?.timer);
    busy.set(id, { state, timer: setTimeout(() => { busy.delete(id); draw(); }, 120000) });
    draw();
  };

  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const cmd = (c, id) => {
    if (id && (c === 'android-ide.startAvd' || c === 'android-ide.coldBootAvd')) { setBusy(id, 'starting'); }
    else if (id && c === 'android-ide.stopAvd') { setBusy(id, 'stopping'); }
    vs.postMessage({ type: 'cmd', cmd: c, id });
  };
  const codicon = (n) => `<span class="codicon codicon-${n}"></span>`;
  const both = (n) => `<span class="dark-only">${icons[n + '-dark']}</span><span class="light-only">${icons[n + '-light']}</span>`;

  // 构建排序入口；工具按钮由宿主标题栏提供。npm test 布局回归断言无重复按钮、排序有效。
  function buildBar() {
    $('head').innerHTML = '<div class="list-title">Devices</div><button class="sort" id="sort" title="Sort by name">' + codicon(st.asc ? 'chevron-up' : 'chevron-down') + ' Name</button>';
    $('sort').onclick = () => { st.asc = !st.asc; vs.setState(st); buildBar(); draw(); };
  }

  // 输入当前行或空值，持久化选择并通知宿主；npm test 模拟在线、离线、重复点击和移除，断言消息及高亮。
  function selectRow(row) {
    sel = row?.id ?? null;
    st.selected = sel;
    vs.setState(st);
    vs.postMessage({ type: 'select', id: sel });
  }

  // 将设备渲染为可折叠卡片；npm test 无设备模拟列表、折叠和名称转义，断言详情隐藏及按钮状态。
  function draw() {
    const sorted = [...rows].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) * (st.asc ? 1 : -1));
    if (!sorted.length) { $('list').innerHTML = '<div id="empty">No devices.</div>'; return; }
    $('list').innerHTML = sorted.map((r) => {
      const ic = r.type === 'Virtual' ? both('virtual') : both('physical');
      const b = busy.get(r.id);
      const collapsed = !!st.collapsed[r.id];
      const act = r.startable
        ? `<button class="ib${b ? ' off' : ''}" ${b ? 'disabled' : ''} data-a="${r.running ? 'stop' : 'start'}" title="${r.running ? 'Stop' : 'Launch'}">${icons[r.running ? 'stop' : 'run']}</button>`
        : r.type === 'Physical'
          ? `<button class="ib" data-a="${r.mirroring ? 'unmirror' : 'mirror'}" title="${r.mirroring ? 'Stop Mirroring' : 'Show on Running Devices'}">${icons[r.mirroring ? 'mirror-stop' : 'mirror-start']}</button>`
          : '';
      const sub = b ? (b.state === 'starting' ? 'Starting up' : 'Shutting down') : r.sub;
      const lead = b ? '<span class="codicon codicon-loading codicon-modifier-spin spin"></span>' : r.running ? '<div class="dot"></div>' : '';
      return `<article class="device-card${sel === r.id ? ' sel' : ''}" data-id="${esc(r.id)}">
<header class="card-head"><button class="collapse" data-a="toggle" aria-expanded="${!collapsed}" title="${collapsed ? 'Expand' : 'Collapse'}" aria-label="${collapsed ? 'Expand' : 'Collapse'} ${esc(r.name)}">${codicon(collapsed ? 'chevron-right' : 'chevron-down')}</button><div class="lead">${lead}</div><div class="nm">${ic}<div class="t"><b title="${esc(r.name)}">${esc(r.name)}</b><small title="${esc(sub)}">${esc(sub)}</small></div></div><div class="act">${act}<button class="ib" data-a="more" title="More">${codicon('kebab-vertical')}</button></div></header>
<div class="card-details${collapsed ? ' hidden' : ''}"><span>API <b>${esc(r.api || '-')}</b></span><span>Type <b>${esc(r.type)}</b></span></div></article>`;
    }).join('');

  }

  function closeMenu() { if (menuEl) { menuEl.remove(); menuEl = null; } }
  function openMenu(items, x, y) {
    closeMenu();
    const m = document.createElement('div'); m.className = 'menu';
    for (const it of items) {
      if (it === '-') { m.appendChild(document.createElement('hr')); continue; }
      const d = document.createElement('div'); d.textContent = it.label; d.onclick = () => { closeMenu(); it.run(); }; m.appendChild(d);
    }
    document.body.appendChild(m);
    const r = m.getBoundingClientRect();
    m.style.left = Math.max(0, Math.min(x, innerWidth - r.width)) + 'px';
    m.style.top = Math.max(0, Math.min(y, innerHeight - r.height)) + 'px';
    menuEl = m;
  }
  document.addEventListener('mousedown', (e) => { if (menuEl && !menuEl.contains(e.target)) { closeMenu(); } });

  function menuFor(r, x, y) {
    const id = r.id, items = [];
    if (r.type === 'Virtual') {
      if (!r.running) { items.push({ label: 'Cold Boot Now', run: () => cmd('android-ide.coldBootAvd', id) }); }
      if (r.running) { items.push({ label: 'Show on Running Devices', run: () => cmd('android-ide.mirrorDevice', id) }, { label: 'Show Logcat', run: () => cmd('android-ide.showLogcat', id) }, '-'); }
      items.push({ label: 'Edit', run: () => cmd('android-ide.editAvd', id) });
      if (!r.running) { items.push({ label: 'Wipe Data', run: () => cmd('android-ide.wipeAvd', id) }); }
      items.push('-', { label: 'Delete', run: () => cmd('android-ide.deleteAvd', id) });
    } else {
      items.push({ label: 'Show on Running Devices', run: () => cmd('android-ide.mirrorDevice', id) }, { label: 'Show Logcat', run: () => cmd('android-ide.showLogcat', id) });
    }
    openMenu(items, x, y);
  }

  // 卡片点击和操作委托；npm test 执行选择、折叠、启动与停止入口，断言消息及禁用反馈。
  $('list').addEventListener('click', (ev) => {
    const el = ev.target.closest('.device-card'); if (!el) { return; }
    const r = rows.find((x) => x.id === el.dataset.id); if (!r) { return; }
    const a = ev.target.closest('[data-a]')?.dataset.a;
    if (!a && sel !== r.id) { selectRow(r); }
    if (a === 'toggle') { st.collapsed[r.id] = !st.collapsed[r.id]; vs.setState(st); draw(); return; }
    if (a === 'start') { cmd('android-ide.startAvd', r.id); }
    else if (a === 'stop') { cmd('android-ide.stopAvd', r.id); }
    else if (a === 'mirror') { cmd('android-ide.mirrorDevice', r.id); }
    else if (a === 'unmirror') { cmd('android-ide.stopMirror'); }
    else if (a === 'more') { const b = ev.target.closest('button').getBoundingClientRect(); menuFor(r, b.left, b.bottom); ev.stopPropagation(); }
    draw();
  });
  // 保留在线设备双击镜像入口；npm test 的事件回归验证仅在线且非按钮区域触发。
  $('list').addEventListener('dblclick', (ev) => {
    const el = ev.target.closest('.device-card'); const r = el && rows.find((x) => x.id === el.dataset.id);
    if (r && r.running && !ev.target.closest('button')) { cmd('android-ide.mirrorDevice', r.id); }
  });
  // 右键同步选择后打开操作菜单；npm test 的选择桥接回归验证所选设备参数。
  $('list').addEventListener('contextmenu', (ev) => {
    const el = ev.target.closest('.device-card'); if (!el) { return; }
    ev.preventDefault(); const r = rows.find((x) => x.id === el.dataset.id); if (!r) { return; } selectRow(r); draw(); menuFor(r, ev.clientX, ev.clientY);
  });

  // 接收初始化和设备状态；npm test 断言选中设备上下线/移除时同步镜像，普通更新不重启。
  window.addEventListener('message', (ev) => {
    const m = ev.data;
    if (m.type === 'init') { icons = m.icons; buildBar(); draw(); }
    else if (m.type === 'rows') {
      const previous = rows.find((r) => r.id === sel);
      rows = m.rows;
      const current = rows.find((r) => r.id === sel);
      if (sel && (!current || !previous || previous.running !== current.running)) { selectRow(current); }
      for (const r of rows) {
        const b = busy.get(r.id);
        if (b && ((b.state === 'starting' && r.running) || (b.state === 'stopping' && !r.running))) { clearTimeout(b.timer); busy.delete(r.id); }
      }
      draw();
    }
  });
  vs.postMessage({ type: 'ready' });
})();
