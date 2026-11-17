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
  const state = { serial: '', deviceName: '', tab: document.body.dataset?.deviceViewMode === 'processes' ? 'processes' : 'files', filter: false, capabilities: {}, busy: false, message: '', error: '', directories: new Map(), expanded: new Set(['/']), processes: [], selected: [], processSelected: null, sort: { key: 'packageName', asc: true }, menu: null, transfer: null, dragTarget: null };
  // 一个视图复用排序器/日期格式器；目录回归断言选择和重复展开不重新构造或排序元数据。
  const fileCollator = new Intl.Collator(undefined, { sensitivity: 'base' });
  const fileDate = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit' });
  const escPath = (p) => p === '/' ? '/' : ('/' + String(p || '').split('/').filter(Boolean).join('/'));
  const parentOf = (p) => { const n = escPath(p); const i = n.lastIndexOf('/'); return i <= 0 ? '/' : n.slice(0, i); };
  const baseName = (p) => escPath(p).split('/').filter(Boolean).pop() || '/';
  // 统一生成文件显示名称；空值或空白回退到路径末段；回归A断言真实行名称非空。
  const entryName = (entry) => { const value = typeof entry.name === 'string' ? entry.name.trim() : ''; return value || baseName(entry.path); };
  const icon = (name) => { const e = document.createElement('span'); e.className = 'codicon codicon-' + name; return e; };
  const button = (title, name, action) => { const b = document.createElement('button'); b.className = 'explorer-icon'; b.title = title; b.setAttribute('aria-label', title); b.appendChild(icon(name)); b.addEventListener('click', action); return b; };
  const text = (tag, value, cls) => { const e = document.createElement(tag); if (cls) e.className = cls; e.textContent = value == null ? '' : String(value); return e; };
  // 发送 Explorer 动作并附加当前设备，所有设备操作均经宿主校验。
  function action(name, extra) { if ((!state.serial || state.active === false) && name !== 'ready') return; post(Object.assign({ type: 'explorer', action: name }, extra || {})); }
  // 将远端路径规范化，避免本地路径和目录遍历污染协议。
  function safeRemote(p) { const parts = String(p || '').replaceAll('\\', '/').split('/'); const out=[]; for (const x of parts) { if (!x || x === '.') continue; if (x === '..') out.pop(); else out.push(x); } return '/' + out.join('/'); }
  // 格式化文件大小和时间，空值使用稳定占位符。
  function formatSize(n) { if (n == null || n === '') return ''; n = Number(n); if (!Number.isFinite(n)) return ''; const u=['B','KB','MB','GB']; let i=0; while(n>=1024&&i<3){n/=1024;i++;} return (i ? n.toFixed(n>=10?0:1) : n.toString())+' '+u[i]; }
  // 文件行以textContent呈现并复用日期格式器，绑定单击选择/目录展开、文件双击打开及独立拖放目标；回归A/B验证名称、选中属性和目标类，目录缓存回归验证格式器复用。
  function fileRow(entry, depth) { const row=document.createElement('div'); row.className='file-row'; row.dataset.path=entry.path; row.style.setProperty('--depth', depth); if(state.selected.includes(entry.path)) row.classList.add('selected'); row.setAttribute('aria-selected', String(state.selected.includes(entry.path))); if(state.dragTarget===entry.path) row.classList.add('drop-target');
    const lead=document.createElement('div'); lead.className='file-name'; const dir=entry.kind==='directory'||entry.directoryLink; const open=state.expanded.has(entry.path); const toggle=document.createElement('button'); toggle.className='twisty'; toggle.title=dir?(open?'Collapse':'Expand'):''; toggle.appendChild(icon(dir?(open?'chevron-down':'chevron-right'):'blank')); toggle.disabled=!dir; toggle.addEventListener('click',(e)=>{e.stopPropagation();toggleDir(entry);}); lead.appendChild(toggle); lead.appendChild(icon(dir?'folder':entry.kind==='symlink'?'file-symlink-file':'file')); lead.appendChild(text('span',entryName(entry),'name')); row.appendChild(lead); row.appendChild(text('div',entry.permissions || '','cell')); row.appendChild(text('div',entry.modified ? fileDate.format(new Date(entry.modified)) : '','cell')); row.appendChild(text('div',entry.kind==='directory'?'':formatSize(entry.size),'cell')); row.addEventListener('click',(e)=>selectFile(entry,e)); row.addEventListener('dblclick',()=>{if(!(entry.kind==='directory'||entry.directoryLink)) action('open',{paths:[entry.path]});}); row.addEventListener('dragover',(e)=>{e.preventDefault();selectDragTarget(entry);}); row.addEventListener('contextmenu',(e)=>{e.preventDefault(); if(!state.selected.includes(entry.path)) selectFile(entry,e); openMenu(e.clientX,e.clientY);}); return row; }
  // 已完成目录快照直接重用，未加载才查询；UI回归验证重复展开零查询及收起后迟到回复不重新展开。
  function toggleDir(entry) {
    const p = safeRemote(entry.path);
    if (state.expanded.has(p)) { state.expanded.delete(p); render(); }
    else { state.expanded.add(p); render(); if (!state.directories.has(p)) action('list', { path: p }); }
  }
  // 处理行事件的Ctrl/Shift单多选并保留锚点，普通点击目录同时展开/折叠；回归A/B断言展开状态和选择路径不被拖放覆盖。
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
  // 构造文件输入和文件列表，上传期间禁用新操作，错误作为alert保留且不替代文件行；回归C/D验证错误可见、列表仍可选和成功清错，原file table回归验证表头与空态。
function filesView() {
  const wrap = document.createElement("div");
  wrap.className = "files-view";
  const bar = document.createElement("div");
  bar.className = "toolbar";
  const disabled = !state.serial || state.active === false || state.busy || !!state.transfer;
  bar.appendChild(button("New Directory", "new-folder", () => action("newDirectory", { paths: state.selected, parent: targetDirectory() })));
  bar.appendChild(button("Download", "cloud-download", () => action("download", { paths: state.selected })));
  const input = document.createElement("input");
  input.type = "file";
  input.multiple = true;
  input.hidden = true;
  bar.appendChild(input);
  bar.appendChild(button("Upload", "cloud-upload", () => { input.dataset.target = targetDirectory(); input.click(); }));
  input.addEventListener("change", () => uploadFiles([...input.files], input.dataset.target || targetDirectory()).catch(showUploadError));
  bar.appendChild(button("Delete", "trash", () => action("delete", { paths: state.selected })));
  bar.appendChild(button("Refresh", "refresh", () => action("refresh")));
  const filter = document.createElement("button");
  filter.className = "filter-toggle";
  filter.title = "Package filter"; filter.disabled = state.active === false;
  filter.setAttribute("aria-pressed", String(state.filter));
  filter.appendChild(icon("filter"));
  filter.addEventListener("click", () => {
    state.filter = !state.filter;
    action("filter", { enabled: state.filter });
    render();
  });
  bar.appendChild(filter);
  for (const b of bar.querySelectorAll("button")) if (disabled && b !== filter) b.disabled = true;
  wrap.appendChild(bar);
  const pathbar = document.createElement("div");
  pathbar.className = "pathbar";
  pathbar.textContent = state.serial ? state.deviceName || state.serial : "No device selected";
  wrap.appendChild(pathbar);
  const head = document.createElement("div");
  head.className = "file-head";
  for (const h of ["Name", "Permissions", "Date", "Size"]) head.appendChild(text("div", h, "cell"));
  const list = document.createElement("div");
  list.className = "file-list";
  list.appendChild(head);
  if (state.error) { const error = text('div', state.error, 'state error'); error.setAttribute('role', 'alert'); list.appendChild(error); }
  if (!state.serial) list.appendChild(text("div", "No device selected", "state"));
  else {
    const rows = visibleEntries();
    if (!rows.length && !state.busy) list.appendChild(text("div", "Empty directory", "state"));
    for (const e of rows) list.appendChild(fileRow(e, e.depth));
  }
  wrap.appendChild(list);
  return wrap;
}
  // 菜单新建与上传共用真实目标目录，其他命令保持选择路径；UI新建回归验证文件父目录，layout回归验证八项文字及边界。
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
    state.error = ''; state.transfer = job; render();
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
  function showUploadError(error) { if (error?.name !== 'AbortError') { state.error = uploadErrorMessage(error); render(); } }
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
  // 处理宿主状态/进度/ACK消息，切换上下文清理目标，进度错误保留具体原因；回归B/C/E/F验证切换、progress错误和取消，原目录缓存回归验证快照所有权。
  function receive(m) {
    if (['devices', 'deviceViewMode', 'explorerConnection', 'explorerState'].includes(m.type)) selectDragTarget(null);
    if (state.transfer && ((m.type === 'deviceViewMode' && m.mode !== 'explorer') || (m.type === 'devices' && m.serial !== state.transfer.serial) || (m.type === 'explorerState' && (m.active === false || m.serial !== state.transfer.serial || (m.tab && m.tab !== 'files'))))) cancelUpload();
    if (m.type === 'devices') { if (m.serial !== state.serial) { state.active = false; render(); } return; }
    if (m.type === 'explorerConnection') {
      if (m.serial !== state.serial || m.connected !== false) return;
      if (m.view === 'files') { state.directories.clear(); state.expanded = new Set(['/']); state.selected = []; }
      else { state.processes = []; state.processSelected = null; }
      render(); return;
    }
    if (m.type === 'deviceViewMode') {
      closeMenu();
      if (m.mode === 'explorer' || m.mode === 'processes') { state.tab = m.mode === 'processes' ? 'processes' : 'files'; render(); }
      return;
    }
    if (m.type === 'explorerState') {
      if (m.serial !== state.serial) { state.directories.clear(); state.expanded = new Set(['/']); state.selected = []; state.processes = []; state.processSelected = null; }
      if (m.tab !== state.tab || m.serial !== state.serial) { closeMenu(); state.error = ''; state.message = ''; state.busy = false; }
      Object.assign(state, m); state.capabilities = m.capabilities || {}; state.tab = m.tab || state.tab; render();
    } else if (m.type === 'explorerFiles') { state.error = m.error || ''; if (!m.error) updateDirectory(m); render(); }
    else if (m.type === 'explorerProcesses') { state.error = m.error || ''; state.processes = m.processes || []; render(); }
    else if (m.type === 'explorerProgress') { state.busy = !!m.busy; state.message = m.message || ''; if(m.error) state.error = m.error; render(); }
    else if (m.type === 'explorerUploadAck') uploadAck(m);
  }
  // 独立入口渲染对应标题和唯一内容，不再提供内部标签页；UI回归断言三个视图互斥与无tab动作。
  function render(){root.replaceChildren();const label=state.tab==='processes'?'Processes':'Device Explorer';root.setAttribute('aria-label',label);const title=document.createElement('div'); title.className='explorer-title'; title.appendChild(text('span',state.deviceName?label+' - '+state.deviceName:label)); if(state.tab==='processes'){const refresh=button('Refresh','refresh',()=>action('refresh')); refresh.disabled=!state.serial||state.active===false; title.appendChild(refresh);} root.appendChild(title);root.appendChild(state.tab==='files'?filesView():window.DeviceProcessesView.render({state,action,renderParent:render,button,text}));if(state.busy)root.appendChild(text('div',state.message||'Busy','progress'));}
  // 键盘导航支持上下左右、Enter、进程复制和菜单取消，保持固定行选择。
  function keyboard(e){if(root.hidden)return;if(e.key==='Escape'){closeMenu();return;}if(window.DeviceProcessesView.handleKeyboard(state,e))return;if(state.tab!=='files'||!state.selected.length)return;const all=visibleEntries(),i=all.findIndex(x=>x.path===state.selected[0]),cur=all[i];if(e.key==='ArrowDown'||e.key==='ArrowUp'){e.preventDefault();const n=Math.max(0,Math.min(all.length-1,i+(e.key==='ArrowDown'?1:-1)));state.selected=[all[n].path];render();}else if(e.key==='ArrowRight'&&cur&&(cur.kind==='directory'||cur.directoryLink)){e.preventDefault();if(!state.expanded.has(cur.path))toggleDir(cur);}else if(e.key==='ArrowLeft'&&cur){e.preventDefault();if(state.expanded.has(cur.path))state.expanded.delete(cur.path);else state.selected=[parentOf(cur.path)];render();}else if(e.key==='Enter'&&cur){e.preventDefault();cur.kind==='directory'?toggleDir(cur):action('open',{paths:[cur.path]});}}
  // 根拖放事件解析行目标，内部移动保留、移到空白/外部或结束清理；回归B/C/E验证类与选择路径及drop失败。
  root.addEventListener('dragover',(e)=>{e.preventDefault();const row=e.target?.closest?.('.file-row');if(row){const entry=(state.directories.get(parentOf(row.dataset.path))||[]).find(item=>item.path===row.dataset.path);selectDragTarget(entry);}else selectDragTarget(null);});root.addEventListener('dragleave',e=>{if(!e.relatedTarget||!root.contains(e.relatedTarget))selectDragTarget(null);});root.addEventListener('dragend',()=>selectDragTarget(null));root.addEventListener('drop',e=>dropUpload(e).catch(showUploadError));window.addEventListener('pagehide',cancelUpload);document.addEventListener('mousedown',(e)=>{if(state.menu&&!state.menu.contains(e.target))closeMenu();});document.addEventListener('keydown',keyboard);window.addEventListener('message',(e)=>receive(e.data||{}));
  render(); post({type:'explorer',action:'ready'});
  window.__deviceExplorer = { state, receive, uploadFiles, readEntry };
})();
