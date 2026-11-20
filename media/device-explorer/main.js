(function () {
  const root = document.getElementById('device-explorer');
  if (!root) return;
  // 复用投屏页面唯一的API持有者，禁止二次acquire；UI回归与真实Webview验证消息接线。
  const post = (m) => send(m);
  // 共享回归索引：Node>=22，在VM中执行真实前端与行/root事件，ACK替身控制设备结果。
  // 命令：node --test tests/device-explorer-ui.test.js tests/device-explorer-controller.test.js。
  // 以下A-F均位于tests/device-explorer-ui.test.js，以完整测试名定位，成功以断言通过为证据。
  // A: folder rows toggle on click and select as drag targets；空名称/目录点击后断言名称、展开状态及原选择保留。
  // B: upload drag targets preserve normal single and multiple selection；单/Ctrl/Shift选择后拖入拖离，断言路径、aria-selected和目标类。
  // C: failed drop keeps file rows selectable and shows all upload causes；注入写入/清理ACK错误，断言alert原因、可选行及progress错误。
  // D: upload input displays nested causes and clears old failures on success；输入嵌套读取错误后成功重传，断言完整原因与旧alert消失。
  // E: host context events clear hovered upload targets；拖入后发送设备/连接/状态消息，断言目标为null且类清除。
  // F: upload owns one batch and cancels pending ACK on view or device change / upload aborts owned FileReader before any stale chunk can be sent；断言切换中止且无旧分块。
  const state = { serial: '', deviceName: '', tab: document.body.dataset?.deviceViewMode === 'processes' ? 'processes' : 'files', filter: false, capabilities: {}, busy: false, message: '', directories: new Map(), expanded: new Set(['/']), processes: [], selected: [], processSelected: null, sort: { key: 'packageName', asc: true }, menu: null, transfer: null, dragTarget: null, loading: false, fetching: false, fileColumns: ['180px', 'max-content', 'max-content', '90px'] };
  let fileColumnObserver, observedFileHead, errorTimer, errorText = '';
  // 一个视图复用排序器；目录回归断言选择和重复展开不重新构造或排序元数据。
  const fileCollator = new Intl.Collator(undefined, { sensitivity: 'base' });
  // 输入时间戳/日期字符串，输出本地YYYY-MM-DD HH:mm:ss；缺失/无效返回空白，不改变时区。
  // Node>=22运行node --test tests/device-explorer-ui.test.js tests/device-explorer-layout.test.js；file dates use fixed local验证年/月/日补零、13点、午夜/无效，compact file columns验证真实字体19字符列宽。
  function formatFileDate(value) {
    if (value == null || value === '') return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    const pad = number => String(number).padStart(2, '0');
    return `${String(date.getFullYear()).padStart(4, '0')}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  }
  const escPath = (p) => p === '/' ? '/' : ('/' + String(p || '').split('/').filter(Boolean).join('/'));
  const parentOf = (p) => { const n = escPath(p); const i = n.lastIndexOf('/'); return i <= 0 ? '/' : n.slice(0, i); };
  const baseName = (p) => escPath(p).split('/').filter(Boolean).pop() || '/';
  // 统一生成文件显示名称；空值或空白回退到路径末段；回归A断言真实行名称非空。
  const entryName = (entry) => { const value = typeof entry.name === 'string' ? entry.name.trim() : ''; return value || baseName(entry.path); };
  const icon = (name) => { const e = document.createElement('span'); e.className = 'codicon codicon-' + name; return e; };
  const button = (title, name, action) => { const b = document.createElement('button'); b.className = 'explorer-icon'; b.title = title; b.setAttribute('aria-label', title); b.appendChild(icon(name)); b.addEventListener('click', action); return b; };
  // 六个文件工具栏按钮使用Android Studio原始SVG轮廓，保留统一尺寸、主题颜色与现有事件；Node>=22运行UI六按钮回归与layout图标mask/截图回归验证资源与交互。
  function toolbarButton(title, name, handler) { const control = button(title, name, handler); control.children[0].className = 'explorer-toolbar-glyph explorer-glyph-' + name; return control; }
  // 文本使用textContent安全呈现，表格名称/单元格同时保留完整悬停值；Node>=22的UI六按钮回归及layout长值裁剪回归断言title与内容相同。
  const text = (tag, value, cls) => { const e = document.createElement(tag); if (cls) e.className = cls; e.textContent = value == null ? '' : String(value); if (cls === 'cell' || cls === 'name') e.title = e.textContent; return e; };
  // 清理错误浮层及自动关闭计时器；视图隐藏/断开时调用，不触发额外渲染。
  function clearError() {
    clearTimeout(errorTimer); errorTimer = undefined; errorText = '';
  }
  // 关闭错误浮层并取消自动清除；错误文本可复制，其他操作不改变其生命周期。
  function dismissError() {
    if (!errorText) return;
    clearError(); render();
  }
  // 显示错误并在30秒后自动关闭；新错误替换旧错误时重新开始同一计时，不依赖点击或轮询。
  function setError(value) {
    if (!value) return;
    clearTimeout(errorTimer); errorText = value;
    errorTimer = setTimeout(() => { errorTimer = undefined; if (errorText === value) { errorText = ''; render(); } }, 30000);
  }
  // 发送有效Explorer动作；错误浮层不因其他操作消失，ready握手语义保持不变。
  function action(name, extra) { if ((!state.serial || state.active === false) && name !== 'ready') return; post(Object.assign({ type: 'explorer', action: name }, extra || {})); }
  // 将远端路径规范化，避免本地路径和目录遍历污染协议。
  function safeRemote(p) { const parts = String(p || '').replaceAll('\\', '/').split('/'); const out=[]; for (const x of parts) { if (!x || x === '.') continue; if (x === '..') out.pop(); else out.push(x); } return '/' + out.join('/'); }
  // 格式化文件大小和时间，空值使用稳定占位符。
  function formatSize(n) { if (n == null || n === '') return ''; n = Number(n); if (!Number.isFinite(n)) return ''; const u=['B','KB','MB','GB']; let i=0; while(n>=1024&&i<3){n/=1024;i++;} return (i ? n.toFixed(n>=10?0:1) : n.toString())+' '+u[i]; }
  // 按路径复用文件行外壳，输入条目/深度，输出保留身份与事件的行；日期用固定本地格式，tooltip保留全文。
  // Node>=22执行UI的file dates use fixed local与stable file tree DOM，layout的compact file columns和resize/anchor回归严格验证文本、10px缩进、180px Name、四列及滚动。
  function fileRow(entry, depth, row = document.createElement('div')) {
    row.className = 'file-row'; row.replaceChildren(); row.dataset.path = entry.path;
    row.style.setProperty('--depth', depth);
    const selected = state.selected.includes(entry.path);
    row.classList.toggle('selected', selected); row.setAttribute('aria-selected', String(selected)); row.classList.toggle('drop-target', state.dragTarget === entry.path);
    const lead = document.createElement('div'); lead.className = 'file-name';
    const dir = entry.kind === 'directory' || entry.directoryLink, open = state.expanded.has(entry.path);
    const toggle = document.createElement('button'); toggle.className = 'twisty'; toggle.title = dir ? (open ? 'Collapse' : 'Expand') : ''; toggle.disabled = !dir;
    toggle.appendChild(icon(dir ? (open ? 'chevron-down' : 'chevron-right') : 'blank'));
    toggle.onclick = event => { event.stopPropagation(); toggleDir(entry); };
    lead.appendChild(toggle); lead.appendChild(icon(dir ? 'folder' : entry.kind === 'symlink' ? 'file-symlink-file' : 'file')); lead.appendChild(text('span', entryName(entry), 'name'));
    row.appendChild(lead); row.appendChild(text('div', entry.permissions || '', 'cell')); row.appendChild(text('div', formatFileDate(entry.modified), 'cell')); row.appendChild(text('div', entry.kind === 'directory' ? '' : formatSize(entry.size), 'cell'));
    row.onclick = event => selectFile(entry, event);
    row.ondblclick = () => { if (!dir) action('open', { paths: [entry.path] }); };
    row.ondragover = event => { event.preventDefault(); selectDragTarget(entry); };
    row.oncontextmenu = event => { event.preventDefault(); if (!state.selected.includes(entry.path)) selectFile(entry, event); openMenu(event.clientX, event.clientY); };
    return row;
  }
  // 展开/收起复用已有快照且不重复查询；错误浮层独立显示，不阻断目录操作，目录缓存回归验证零重复请求。
  function toggleDir(entry) {
    const p = safeRemote(entry.path);
    if (state.expanded.has(p)) { state.expanded.delete(p); render(); }
    else { state.expanded.add(p); render(); if (!state.directories.has(p)) action('list', { path: p }); }
  }
  // 用户选择保留Ctrl/Shift锚点，目录点击仍展开/收起；错误浮层不因选择或展开提前关闭，A/B回归验证选择与拖放。
  function selectFile(entry, ev) { const p=safeRemote(entry.path); const all=visibleEntries(); const i=all.findIndex(x=>x.path===p); if(ev.shiftKey&&state.selected.length){const a=all.findIndex(x=>x.path===state.selected[0]); state.selected=all.slice(Math.min(a,i),Math.max(a,i)+1).map(x=>x.path);} else if(ev.ctrlKey||ev.metaKey){state.selected=state.selected.includes(p)?state.selected.filter(x=>x!==p):state.selected.concat(p);} else state.selected=[p]; if(!ev.shiftKey&&!ev.ctrlKey&&!ev.metaKey&&(entry.kind==='directory'||entry.directoryLink)){toggleDir(entry);} else render(); }
  // 在活动文件视图中由条目更新独立拖放目标，空条目清理目标类；回归A/B/C/E断言目标生命周期与原选择保留。
  function selectDragTarget(entry) {
    state.dragTarget = entry && state.serial && state.active !== false && state.tab === 'files' && !root.hidden ? safeRemote(entry.path) : null;
    for (const row of root.querySelectorAll('.file-row')) row.classList.toggle('drop-target', row.dataset.path === state.dragTarget);
  }
  // 按目录快照线性遍历可见文件，不在每次点击时重新扫描/排序；UI目录缓存回归验证深层顺序及零重复比较。
  function visibleEntries() {
    const result = [];
    // 目录自身持有排序后的直接子项，只遍历实际展开路径，不反复扫描整棵树。
    const walk = (directory, depth) => {
      for (const entry of state.directories.get(directory) || []) {
        result.push({ ...entry, depth });
        if ((entry.kind === 'directory' || entry.directoryLink) && state.expanded.has(entry.path)) walk(entry.path, depth + 1);
      }
    };
    walk('/', 0); return result;
  }
  // 接收目录完整快照，用回退名称排序并失效删除子树；回归A验证空名称，directory snapshots回归验证刷新删除/空目录及缓存所有权。
  function updateDirectory(message) {
    const directory = safeRemote(message.path || '/');
    const entries = (message.entries || []).map(entry => ({ ...entry, path: safeRemote(entry.path) }));
    entries.sort((a, b) => {
      const ad = a.kind === 'directory' || a.directoryLink, bd = b.kind === 'directory' || b.directoryLink;
      return ad !== bd ? (ad ? -1 : 1) : fileCollator.compare(entryName(a), entryName(b));
    });
    const retained = new Set(entries.filter(entry => entry.kind === 'directory' || entry.directoryLink).map(entry => entry.path));
    for (const old of state.directories.get(directory) || []) if ((old.kind === 'directory' || old.directoryLink) && !retained.has(old.path)) {
      for (const cached of state.directories.keys()) if (cached === old.path || cached.startsWith(old.path + '/')) { state.directories.delete(cached); state.expanded.delete(cached); }
    }
    state.directories.set(directory, entries);
  }
  // 新建与上传共用目录解析：目录/目录链接取自身，文件取父目录，空选择回根；UI新建/拖入回归断言工具栏、菜单及URI目标一致。
  function targetDirectory(value = state.selected[0] || '/') {
    const remote = safeRemote(value);
    if (remote === '/') return remote;
    const entry = (state.directories.get(parentOf(remote)) || []).find(item => item.path === remote);
    if (!entry) throw new Error('Upload target is no longer available');
    return entry.kind === 'directory' || entry.directoryLink ? remote : parentOf(remote);
  }
  // 同设备复用Files面板、滚动列表和表头，按路径增删/更新行而不重建滚动容器；设备改变重新建立所有权。六按钮回归保持禁用与错误区契约。
  // 回归：Node>=22运行node --test tests/device-explorer-ui.test.js tests/device-explorer-layout.test.js；stable file tree DOM与file tree expansion keeps selected viewport anchor断言展开/回复/进度/定位后节点身份、scrollTop/Left和选中行坐标保持。
  // 回归：Node>=22执行node --test tests/device-explorer-ui.test.js；Explorer toolbar exposes six working actions逐按钮点击断言消息/上传ACK，toolbar disabled states验证禁用；C/D覆盖错误区。
// 复用列表和表头，错误使用独立底部浮层显示；UI/Edge回归验证位置、滚动、复制、关闭和自动消失。
function filesView(previous) {
  const wrap = previous?.className === "files-view" && previous.dataset.serial === state.serial ? previous : document.createElement("div");
  wrap.dataset.serial = state.serial;
  wrap.className = "files-view";
  const bar = document.createElement("div");
  bar.className = "toolbar";
  const disabled = !state.serial || state.active === false || state.busy || !!state.transfer;
  bar.appendChild(toolbarButton("New Directory", "new-folder", () => action("newDirectory", { paths: state.selected, parent: targetDirectory() })));
  bar.appendChild(toolbarButton("Download", "download", () => action("download", { paths: state.selected })));
  const input = document.createElement("input");
  input.type = "file";
  input.multiple = true;
  input.hidden = true;
  bar.appendChild(input);
  bar.appendChild(toolbarButton("Upload", "upload", () => { input.dataset.target = targetDirectory(); input.click(); }));
  input.addEventListener("change", () => uploadFiles([...input.files], input.dataset.target || targetDirectory()).catch(showUploadError));
  bar.appendChild(toolbarButton("Delete", "delete", () => action("delete", { paths: state.selected })));
  bar.appendChild(toolbarButton("Refresh", "refresh", () => action("refresh")));
  bar.appendChild(toolbarButton("Locate App Data", "locate", () => action("locateApp")));
  for (const b of bar.querySelectorAll("button")) b.disabled = disabled || (!state.selected.length && (b.title === "Download" || b.title === "Delete"));
  if (wrap.children[0]) wrap.replaceChild(bar, wrap.children[0]); else wrap.appendChild(bar);
  const header = wrap.children[1]?.className === 'file-header' ? wrap.children[1] : document.createElement('div'); header.className = 'file-header';
  const head = header.children[0] || document.createElement('div'); head.className = 'file-head';
  const list = wrap.children[2]?.className === 'file-list' ? wrap.children[2] : document.createElement('div'); list.className = 'file-list';
  const existing = new Map(Array.from(list.querySelectorAll('.file-row'), row => [row.dataset.path, row]));
  head.style.setProperty('--file-columns', state.fileColumns.join(' '));
  if (observedFileHead !== head) {
    fileColumnObserver?.disconnect(); observedFileHead = head;
    // 固定表头拥有字体测量，滚动行复用实测列宽；浏览器回归验证字体变化、列宽拖动和横向对齐。
    fileColumnObserver = new ResizeObserver(() => list.style.setProperty('--file-columns', getComputedStyle(head).gridTemplateColumns));
    fileColumnObserver.observe(head);
  }
  list.onscroll = () => { head.style.transform = 'translateX(' + -list.scrollLeft + 'px)'; };
  head.style.transform = 'translateX(' + -(list.scrollLeft || 0) + 'px)';
  if (!head.children.length) for (const [index, label] of ['Name', 'Permissions', 'Date', 'Size'].entries()) {
    const cell = text('div', label, 'cell'); cell.dataset.column = String(index);
    // 隐藏样本只参与真实字体intrinsic列宽，空目录也稳定；layout紧凑列回归断言宽度与2px留白。
    if (index === 1 || index === 2) { const sample = text('span', index === 1 ? 'drwxrwxrwx' : '2000-00-00 00:00:00', 'column-sample'); sample.setAttribute('aria-hidden', 'true'); cell.appendChild(sample); }
    const grip = document.createElement('span'); grip.className = 'column-grip'; grip.title = 'Resize column';
    grip.addEventListener('pointerdown', event => resizeColumn(event, index, head)); cell.appendChild(grip); head.appendChild(cell);
  }
  if (!head.parentNode) header.insertBefore(head, header.children[0] || null);
  const children = [];
  if (!state.serial) children.push(text('div', 'No device selected', 'state'));
  else {
    const rows = visibleEntries();
    if (!rows.length && !state.busy && !state.loading) children.push(text('div', 'Empty directory', 'state'));
    for (const entry of rows) children.push(fileRow(entry, entry.depth, existing.get(entry.path)));
  }
  for (let index = 0; index < children.length; index++) if (list.children[index] !== children[index]) list.insertBefore(children[index], list.children[index] || null);
  const retained = new Set(children);
  for (const child of Array.from(list.children)) if (!retained.has(child)) list.removeChild(child);
  if (wrap.children[1] !== header) wrap.insertBefore(header, wrap.children[1] || null);
  if (wrap.children[2] !== list) wrap.insertBefore(list, wrap.children[2] || null);
  return wrap;
}
  // 从实际表头像素宽度开始拖动当前列，捕获指针保证离开手柄仍能完成；同时更新表头/所有文件行，结束或取消即释放监听。
  // 回归：Node>=22及EXPLORER_PLAYWRIGHT/EXPLORER_BROWSER，node --test tests/device-explorer-layout.test.js；file columns resize from measured widths用真实指针拖出手柄，断言列宽变化、行对齐、重绘保持与停止后不变；完整布局矩阵断言表头容纳/双向滚动/顶部固定。
  function resizeColumn(event, index, head) {
    event.preventDefault();
    const grip = event.currentTarget, start = event.clientX;
    const values = Array.from(head.children, cell => cell.getBoundingClientRect().width);
    const minimum = [120, 100, 150, 60];
    const move = current => {
      state.fileColumns = values.map((width, column) => (column === index ? Math.max(minimum[column], width + current.clientX - start) : width) + 'px');
      head.style.setProperty('--file-columns', state.fileColumns.join(' '));
      root.querySelector('.file-list').style.setProperty('--file-columns', state.fileColumns.join(' '));
    };
    const stop = () => {
      grip.removeEventListener('pointermove', move); grip.removeEventListener('pointerup', stop); grip.removeEventListener('pointercancel', stop); grip.removeEventListener('lostpointercapture', stop);
      if (grip.hasPointerCapture(event.pointerId)) grip.releasePointerCapture(event.pointerId);
    };
    grip.addEventListener('pointermove', move); grip.addEventListener('pointerup', stop); grip.addEventListener('pointercancel', stop); grip.addEventListener('lostpointercapture', stop);
    grip.setPointerCapture(event.pointerId);
  }

  // 打开菜单使用真实目标目录；错误浮层不改变菜单动作，菜单回归验证路径和八项操作。
  function openMenu(x, y) {
    closeMenu();
    const menu = document.createElement('div'); menu.className = 'explorer-menu';
    const items = [['New File','newFile'],['New Directory','newDirectory'],['Open','open'],['Save As','download'],['Upload','upload'],['Delete','delete'],['Synchronize','refresh'],['Copy Path(s)','copyPath']];
    for (const [label, name] of items) {
      const control = text('button', label);
      control.disabled = !state.serial || (!state.selected.length && !['newFile','newDirectory','upload'].includes(name));
      control.addEventListener('click', () => {
        closeMenu();
        if (name === 'copyPath') copyPaths();
        else if (name === 'upload') action(name, { target: targetDirectory() });
        else action(name, { paths: state.selected, parent: name === 'newFile' || name === 'newDirectory' ? targetDirectory() : state.selected[0] || '/' });
      });
      menu.appendChild(control);
    }
    document.body.appendChild(menu);
    menu.style.left = Math.max(0, Math.min(x, innerWidth - 180)) + 'px';
    menu.style.top = Math.max(0, Math.min(y, innerHeight - 260)) + 'px';
    state.menu = menu;
  }
  // 关闭当前上下文菜单并释放菜单节点。
  function closeMenu(){if(state.menu){state.menu.remove();state.menu=null;}}
  // 复制选择路径到剪贴板，失败时不伪造成功消息。
  async function copyPaths(){const value=state.selected.join('\n'); action('copyPath',{paths:state.selected});}
  // 单命令先登记等待者再发送，ACK后才释放等待；UI上传回归覆盖同步回包、动作关联、最终ACK与取消清理。
  function uploadRequest(job, id, name, extra = {}) {
    const signal = job.controller.signal;
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      // 一个命令拥有一次等待和取消监听，任何完成路径都立即解除关联。
      const settle = (error) => {
        signal.removeEventListener('abort', abort);
        job.pending = null;
        error ? reject(error) : resolve();
      };
      const abort = () => settle(signal.reason);
      job.pending = { id, action: name, resolve: () => settle(), reject: settle };
      signal.addEventListener('abort', abort, { once: true });
      try { post({ type: 'explorer', action: name, serial: job.serial, transferId: id, ...extra }); }
      catch (error) { settle(error); }
    });
  }
  // FileReader由当前上传signal实际中止；UI上传回归验证读取错误、切换设备及迟到读完均不发送分块。
  function readUploadChunk(file, start, end, signal) {
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      const settle = (error) => {
        signal.removeEventListener('abort', abort);
        reader.onload = reader.onerror = reader.onabort = null;
        error ? reject(error) : resolve(reader.result);
      };
      const abort = () => { reader.onload = reader.onerror = reader.onabort = null; reader.abort(); settle(signal.reason); };
      reader.onload = () => settle();
      reader.onerror = () => settle(reader.error || new Error('Cannot read upload file'));
      reader.onabort = () => settle(signal.reason || new Error('Upload file read aborted'));
      signal.addEventListener('abort', abort, { once: true });
      try { reader.readAsArrayBuffer(file.slice(start, end)); } catch (error) { settle(error); }
    });
  }
  // 文件输入复用同一批次执行器；UI上传回归验证多文件、零字节及最终提交ACK。
  async function uploadFiles(files, target) { return uploadBatch(files, target); }
  // 批次接收文件读取器与目标目录，共同拥有设备signal，开始时清错、父目录先创建并等待提交；回归C/D验证失败原因与成功清错，原目录拖入回归覆盖空目录和扫描取消。
  async function uploadBatch(readFiles, target) {
    if (!state.serial || state.active === false || state.tab !== 'files' || root.hidden) throw new Error('Select an active device file view before uploading');
    if (state.transfer) throw new Error('An upload is already running');
    const job = { serial: state.serial, controller: new AbortController(), pending: null };
    state.transfer = job; render();
    try {
      const files = typeof readFiles === 'function' ? await readFiles(job.controller.signal) : readFiles;
      job.controller.signal.throwIfAborted();
      for (const item of files) {
        const id = Math.random().toString(36).slice(2);
        if (item.directory === true) {
          await uploadRequest(job, id, 'uploadBegin', { relativePath: item.relativePath, target, directory: true });
          continue;
        }
        const file = item.file || item;
        if (!Number.isSafeInteger(file.size) || file.size < 0 || typeof file.slice !== 'function') throw new Error('Invalid upload file');
        job.controller.signal.throwIfAborted();
        try {
          await uploadRequest(job, id, 'uploadBegin', { relativePath: item.relativePath || file.name, target, size: file.size });
          for (let offset = 0; offset < file.size;) {
            const end = Math.min(offset + 256 * 1024, file.size);
            const buffer = await readUploadChunk(file, offset, end, job.controller.signal);
            job.controller.signal.throwIfAborted();
            if (buffer.byteLength !== end - offset) throw new Error('Upload file size changed while reading');
            let data = ''; for (const byte of new Uint8Array(buffer)) data += String.fromCharCode(byte);
            await uploadRequest(job, id, 'uploadChunk', { data: btoa(data) });
            offset = end;
          }
          await uploadRequest(job, id, 'uploadEnd');
        } catch (error) {
          if (!job.controller.signal.aborted) {
            try { await uploadRequest(job, id, 'uploadAbort'); }
            catch (cleanup) { throw new AggregateError([error, cleanup], 'Upload and remote cleanup failed'); }
          }
          throw error;
        }
      }
    } finally { state.transfer = null; render(); }
  }
  // 设备/视图关闭清理拖放目标并中止当前等待与真实读取，不向下一设备发送取消；回归E/F验证目标清理、pending ACK及FileReader中止。
  function cancelUpload() {
    selectDragTarget(null);
    const error = new Error('Upload cancelled because the device view changed'); error.name = 'AbortError';
    state.transfer?.controller.abort(error);
  }
  // 将文件输入或拖放失败写入错误区，AbortError不污染新设备；回归C/D/F断言具体原因、列表可选及上下文取消。
  function showUploadError(error) { if (error?.name !== 'AbortError') { setError(uploadErrorMessage(error)); render(); } }
  // 将错误递归转为可显示字符串，保留AggregateError的本地/设备/清理原因；回归C/D断言写入和清理原因及嵌套完整消息。
  // 将错误浮层文本复制到系统剪贴板，不关闭浮层且不伪造复制成功提示；按钮点击不触发文件操作。
  async function copyError() { if (errorText) { await navigator.clipboard.writeText(errorText); } }
  // 将错误递归转为可显示字符串，保留AggregateError的本地/设备/清理原因；回归C/D断言写入和清理原因及嵌套完整消息。
  function uploadErrorMessage(error) { return error?.errors ? [error.message, ...Array.from(error.errors, uploadErrorMessage)].join(': ') : String(error?.message || error); }

  // 浏览器目录API无法中止底层读取，但signal立即解除本批等待；迟到回调无写入副作用，UI拖入回归验证取消及时及无旧设备命令。
  function readDroppedValue(start, signal) {
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const finish = (error, value) => { signal.removeEventListener('abort', abort); error ? reject(error) : resolve(value); };
      const abort = () => finish(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
      try { start(value => finish(undefined, value), error => finish(error)); } catch (error) { finish(error); }
    });
  }
  // 保留每个目录含空目录，readEntries真正返回空数组才结束，读取失败不伪装完成；UI拖入回归覆盖多批、空目录、错误与取消。
  async function readEntry(entry, prefix, files, signal) {
    signal.throwIfAborted();
    if (entry.isFile) {
      const file = await readDroppedValue((resolve, reject) => entry.file(resolve, reject), signal);
      signal.throwIfAborted(); files.push({ file, relativePath: prefix + file.name });
    } else if (entry.isDirectory) {
      const relativePath = prefix + entry.name;
      files.push({ directory: true, relativePath });
      const reader = entry.createReader();
      while (true) {
        const batch = await readDroppedValue((resolve, reject) => reader.readEntries(resolve, reject), signal);
        signal.throwIfAborted();
        if (!batch.length) break;
        for (const child of batch) await readEntry(child, relativePath + '/', files, signal);
      }
    } else { throw new Error('Unsupported dropped file entry'); }
  }
  // 接收drop事件，清理悬停并同步捕获数据/目标后扫描，不跨设备续传；回归C/F验证失败清理与取消，原file drops回归验证目录、文件父目录与URI目标。
  async function dropUpload(event) {
    event.preventDefault();
    selectDragTarget(null);
    if (!state.serial || state.active === false || state.tab !== 'files' || root.hidden) throw new Error('Select an active device file view before uploading');
    if (state.transfer) throw new Error('An upload is already running');
    const data = event.dataTransfer, target = targetDirectory(event.target?.closest?.('.file-row')?.dataset.path);
    const entries = [...(data.items || [])].map(item => item.webkitGetAsEntry?.()).filter(Boolean), localFiles = [...data.files];
    if (!entries.length && !localFiles.length && data.types.includes('text/uri-list')) {
      const uris = data.getData('text/uri-list').split(/\r?\n/).map(uri => uri.trim()).filter(uri => uri && !uri.startsWith('#'));
      if (uris.length) action('uploadUris', { uris, target });
      return;
    }
    await uploadBatch(async signal => {
      if (!entries.length) return localFiles;
      const files = [];
      for (const entry of entries) await readEntry(entry, '', files, signal);
      return files;
    }, target);
  }
  // ACK仅结算当前命令，设备或动作不匹配明确失败；UI上传回归断言无提前成功及无跨设备续传。
  function uploadAck(message) {
    const job = state.transfer, pending = job?.pending;
    if (!pending || message.transferId !== pending.id) return;
    if (message.serial !== job.serial || message.action !== pending.action) { pending.reject(new Error('Upload acknowledgement does not match the pending command')); return; }
    message.error ? pending.reject(new Error(message.error)) : pending.resolve();
  }
  // 根据宿主快照展开并选中应用目录，在表头下方独立滚动区置顶；尾部留足视口空间，UI/浏览器定位回归核验节点及选中坐标。
  // 回归：Node>=22运行node --test tests/device-explorer-ui.test.js，app directory reveal expands ancestors and preserves ownership投递快照/reveal，断言祖先、行选择、滚动和无额外list；跨设备/非活动/缺失目录不定位。
  function revealAppDirectory(message) {
    if (message.serial !== state.serial || state.active === false || state.tab !== 'files' || root.hidden) return;
    const remote = safeRemote(message.path);
    const entry = (state.directories.get(parentOf(remote)) || []).find(item => item.path === remote);
    if (!entry || !(entry.kind === 'directory' || entry.directoryLink) || !state.directories.has(remote)) { showUploadError(new Error('Application data directory is no longer available')); return; }
    state.selected = [remote];
    for (let current = remote; current !== '/'; current = parentOf(current)) state.expanded.add(current);
    state.expanded.add('/'); render();
    const row = Array.from(root.querySelectorAll('.file-row')).find(item => item.dataset.path === remote);
    if (row) {
      const list = root.querySelector('.file-list');
      list.style.setProperty('padding-bottom', Math.max(0, list.clientHeight - row.getBoundingClientRect().height) + 'px');
      row.scrollIntoView({ block: 'start', inline: 'nearest' });
    }
  }
  // 处理宿主状态/进度/ACK和定位，获取结束或取消清除加载态；npm test 的 Explorer loading、B/C/E/F及app directory reveal回归核验接线。
  function receive(m) {
    if (['devices', 'deviceViewMode', 'explorerConnection', 'explorerState'].includes(m.type)) selectDragTarget(null);
    if (state.transfer && ((m.type === 'deviceViewMode' && m.mode !== 'explorer') || (m.type === 'devices' && m.serial !== state.transfer.serial) || (m.type === 'explorerState' && (m.active === false || m.serial !== state.transfer.serial || (m.tab && m.tab !== 'files'))))) cancelUpload();
    if (m.type === 'devices') { if (m.serial !== state.serial) { state.active = false; state.fetching = false; state.loading = false; render(); } return; }
    if (m.type === 'explorerConnection') {
      if (m.serial !== state.serial || m.connected !== false) return;
      if (m.view === 'files') { clearError(); state.fetching = false; state.loading = false; state.busy = false; state.directories.clear(); state.expanded = new Set(['/']); state.selected = []; }
      else { state.processes = []; state.processSelected = null; }
      render(); return;
    }
    if (m.type === 'deviceViewMode') {
      closeMenu();
      if (m.mode === 'explorer' || m.mode === 'processes') { state.tab = m.mode === 'processes' ? 'processes' : 'files'; render(); }
      else { clearError(); state.active = false; render(); }
      return;
    }
    if (m.type === 'explorerState') {
      if (m.serial !== state.serial) { state.directories.clear(); state.expanded = new Set(['/']); state.selected = []; state.processes = []; state.processSelected = null; }
      if (m.tab !== state.tab || m.serial !== state.serial) { closeMenu(); clearError(); state.busy = false; }
      if (m.serial !== state.serial || m.active === false) { clearError(); state.fetching = false; state.loading = false; }
      Object.assign(state, m); state.capabilities = m.capabilities || {}; state.tab = m.tab || state.tab;
      // Files切入且当前设备尚未收到根目录快照时先显示Loading，避免把未加载状态误报为空目录；收到/缓存根快照后交给真实进度消息结束加载。
      if (state.tab === 'files' && state.serial && state.active !== false && !state.directories.has('/')) { state.loading = true; }
      render();
    } else if (m.type === 'explorerLoading') { if (m.serial !== state.serial || state.active === false) return; state.fetching = !!m.fetching; if (!state.fetching) state.loading = false; render(); }
    else if (m.type === 'explorerReveal') { revealAppDirectory(m); }
    else if (m.type === 'explorerFiles') { if (m.error) setError(m.error); if (!m.error) { updateDirectory(m); if (safeRemote(m.path || '/') === '/') state.loading = false; } render(); }
    else if (m.type === 'explorerProcesses') { if (m.error) setError(m.error); state.processes = m.processes || []; render(); }
    else if (m.type === 'explorerProgress') {
      state.busy = !!m.busy; state.message = m.message || '';
      if (m.error) { if (m.path) state.expanded.delete(safeRemote(m.path)); setError(m.error); state.loading = false; }
      render();
    }
    else if (m.type === 'explorerUploadAck') uploadAck(m);
  }
  // 原位更新标题与活动内容，Files原有面板不从root移除，进度独立增删；stable file tree DOM及浏览器anchor回归覆盖展开/异步快照/定位后的稳定位置，原surface回归保持视图互斥。
  // 表头下沿不确定进度绑定真实请求，伪元素动画不重建列表；npm test 的 Explorer loading/UI及浏览器回归验证位置、开始、结束和取消。
  function render() {
    root.setAttribute('aria-busy', String(!!state.serial && state.active !== false && state.tab === 'files' && (state.fetching || state.loading)));
    const label = state.tab === 'processes' ? 'Processes' : 'Device Explorer'; root.setAttribute('aria-label', label);
    let title = root.children[0];
    if (!title) { title = document.createElement('div'); title.className = 'explorer-title'; root.appendChild(title); }
    title.replaceChildren(text('span', state.deviceName ? label + ' - ' + state.deviceName : label));
    if (state.tab === 'processes') { const refresh = button('Refresh', 'refresh', () => action('refresh')); refresh.disabled = !state.serial || state.active === false; title.appendChild(refresh); }
    if (state.tab !== 'files') { fileColumnObserver?.disconnect(); observedFileHead = undefined; }
    const previous = root.children[1];
    const surface = state.tab === 'files' ? filesView(previous) : window.DeviceProcessesView.render({ state, action, renderParent: render, button, text });
    if (!previous) root.appendChild(surface); else if (previous !== surface) root.replaceChild(surface, previous);
    let error = root.querySelector('.explorer-error-toast');
    if (errorText) {
      if (!error) {
        error = document.createElement('div'); error.className = 'explorer-error-toast'; error.setAttribute('role', 'alert');
        const body = document.createElement('div'); body.className = 'explorer-error-text';
        const actions = document.createElement('div'); actions.className = 'explorer-error-actions';
        const copy = button('Copy error', 'copy', () => void copyError()); copy.classList.add('explorer-error-action');
        const close = button('Close error', 'close', dismissError); close.classList.add('explorer-error-action');
        actions.append(copy, close); error.append(body, actions); root.appendChild(error);
      }
      error.querySelector('.explorer-error-text').textContent = errorText;
    } else { error?.remove(); }
    const progress = root.querySelector('.progress');
    if (state.busy || state.loading) { if (progress) progress.textContent = state.message || (state.loading ? 'Loading' : 'Busy'); else root.appendChild(text('div', state.message || (state.loading ? 'Loading' : 'Busy'), 'progress')); }
    else progress?.remove();
  }
  // 文件键盘导航保持行选择且不关闭错误浮层；键盘回归验证箭头选择、菜单取消及进程复制。
  function keyboard(e){if(root.hidden)return;if(e.key==='Escape'){closeMenu();return;}if(window.DeviceProcessesView.handleKeyboard(state,e))return;if(state.tab!=='files'||!state.selected.length)return;const all=visibleEntries(),i=all.findIndex(x=>x.path===state.selected[0]),cur=all[i];if(e.key==='ArrowDown'||e.key==='ArrowUp'){e.preventDefault();const n=Math.max(0,Math.min(all.length-1,i+(e.key==='ArrowDown'?1:-1)));state.selected=[all[n].path];render();}else if(e.key==='ArrowRight'&&cur&&(cur.kind==='directory'||cur.directoryLink)){e.preventDefault();if(!state.expanded.has(cur.path))toggleDir(cur);}else if(e.key==='ArrowLeft'&&cur){e.preventDefault();if(state.expanded.has(cur.path))state.expanded.delete(cur.path);else state.selected=[parentOf(cur.path)];render();}else if(e.key==='Enter'&&cur){e.preventDefault();cur.kind==='directory'?toggleDir(cur):action('open',{paths:[cur.path]});}}
  // 根拖放事件解析行目标，内部移动保留、移到空白/外部或结束清理；错误浮层由关闭按钮或30秒生命周期管理。

  root.addEventListener('dragover',(e)=>{e.preventDefault();const row=e.target?.closest?.('.file-row');if(row){const entry=(state.directories.get(parentOf(row.dataset.path))||[]).find(item=>item.path===row.dataset.path);selectDragTarget(entry);}else selectDragTarget(null);});root.addEventListener('dragleave',e=>{if(!e.relatedTarget||!root.contains(e.relatedTarget))selectDragTarget(null);});root.addEventListener('dragend',()=>selectDragTarget(null));root.addEventListener('drop',e=>dropUpload(e).catch(showUploadError));window.addEventListener('pagehide',cancelUpload);document.addEventListener('mousedown',(e)=>{if(state.menu&&!state.menu.contains(e.target))closeMenu();});document.addEventListener('keydown',keyboard);window.addEventListener('message',(e)=>receive(e.data||{}));
  window.addEventListener('pagehide', () => fileColumnObserver?.disconnect());
  render(); post({type:'explorer',action:'ready'});
  window.__deviceExplorer = { state, receive, uploadFiles, readEntry };
})();
