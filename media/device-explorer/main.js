(function () {
  const root = document.getElementById('device-explorer');
  if (!root) return;
  // 复用投屏页面唯一的API持有者，禁止二次acquire；UI回归与真实Webview验证消息接线。
  const post = (m) => send(m);
  const state = { serial: '', deviceName: '', tab: document.body.dataset?.deviceViewMode === 'processes' ? 'processes' : 'files', filter: false, capabilities: {}, busy: false, message: '', error: '', directories: new Map(), expanded: new Set(['/']), processes: [], selected: [], processSelected: null, sort: { key: 'packageName', asc: true }, menu: null, transfer: null };
  // 一个视图复用排序器/日期格式器；目录回归断言选择和重复展开不重新构造或排序元数据。
  const fileCollator = new Intl.Collator(undefined, { sensitivity: 'base' });
  const fileDate = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit' });
  const escPath = (p) => p === '/' ? '/' : ('/' + String(p || '').split('/').filter(Boolean).join('/'));
  const parentOf = (p) => { const n = escPath(p); const i = n.lastIndexOf('/'); return i <= 0 ? '/' : n.slice(0, i); };
  const baseName = (p) => escPath(p).split('/').filter(Boolean).pop() || '/';
  const icon = (name) => { const e = document.createElement('span'); e.className = 'codicon codicon-' + name; return e; };
  const button = (title, name, action) => { const b = document.createElement('button'); b.className = 'explorer-icon'; b.title = title; b.setAttribute('aria-label', title); b.appendChild(icon(name)); b.addEventListener('click', action); return b; };
  const text = (tag, value, cls) => { const e = document.createElement(tag); if (cls) e.className = cls; e.textContent = value == null ? '' : String(value); return e; };
  // 发送 Explorer 动作并附加当前设备，所有设备操作均经宿主校验。
  function action(name, extra) { if ((!state.serial || state.active === false) && name !== 'ready') return; post(Object.assign({ type: 'explorer', action: name }, extra || {})); }
  // 将远端路径规范化，避免本地路径和目录遍历污染协议。
  function safeRemote(p) { const parts = String(p || '').replaceAll('\\', '/').split('/'); const out=[]; for (const x of parts) { if (!x || x === '.') continue; if (x === '..') out.pop(); else out.push(x); } return '/' + out.join('/'); }
  // 格式化文件大小和时间，空值使用稳定占位符。
  function formatSize(n) { if (n == null || n === '') return ''; n = Number(n); if (!Number.isFinite(n)) return ''; const u=['B','KB','MB','GB']; let i=0; while(n>=1024&&i<3){n/=1024;i++;} return (i ? n.toFixed(n>=10?0:1) : n.toString())+' '+u[i]; }
  // 文件行复用日期格式器并以textContent呈现，避免每行构造Intl对象；UI目录回归验证重复展开不重新构造格式器，layout回归验证实际DOM。
  function fileRow(entry, depth) { const row=document.createElement('div'); row.className='file-row'; row.dataset.path=entry.path; row.style.setProperty('--depth', depth); if(state.selected.includes(entry.path)) row.classList.add('selected');
    const lead=document.createElement('div'); lead.className='file-name'; const dir=entry.kind==='directory'||entry.directoryLink; const open=state.expanded.has(entry.path); const toggle=document.createElement('button'); toggle.className='twisty'; toggle.title=dir?(open?'Collapse':'Expand'):''; toggle.appendChild(icon(dir?(open?'chevron-down':'chevron-right'):'blank')); toggle.disabled=!dir; toggle.addEventListener('click',(e)=>{e.stopPropagation();toggleDir(entry);}); lead.appendChild(toggle); lead.appendChild(icon(dir?'folder':entry.kind==='symlink'?'file-symlink-file':'file')); lead.appendChild(text('span',entry.name || baseName(entry.path),'name')); row.appendChild(lead); row.appendChild(text('div',entry.permissions || '','cell')); row.appendChild(text('div',entry.modified ? fileDate.format(new Date(entry.modified)) : '','cell')); row.appendChild(text('div',entry.kind==='directory'?'':formatSize(entry.size),'cell')); row.addEventListener('click',(e)=>selectFile(entry,e)); row.addEventListener('dblclick',()=>{if(entry.kind==='directory'||entry.directoryLink) toggleDir(entry); else action('open',{paths:[entry.path]});}); row.addEventListener('contextmenu',(e)=>{e.preventDefault(); if(!state.selected.includes(entry.path)) selectFile(entry,e); openMenu(e.clientX,e.clientY);}); return row; }
  // 已完成目录快照直接重用，未加载才查询；UI回归验证重复展开零查询及收起后迟到回复不重新展开。
  function toggleDir(entry) {
    const p = safeRemote(entry.path);
    if (state.expanded.has(p)) { state.expanded.delete(p); render(); }
    else { state.expanded.add(p); render(); if (!state.directories.has(p)) action('list', { path: p }); }
  }
  // 处理 Ctrl/Shift 单多选并保留锚点，普通点击只选择当前行。
  function selectFile(entry, ev) { const p=safeRemote(entry.path); const all=visibleEntries(); const i=all.findIndex(x=>x.path===p); if(ev.shiftKey&&state.selected.length){const a=all.findIndex(x=>x.path===state.selected[0]); state.selected=all.slice(Math.min(a,i),Math.max(a,i)+1).map(x=>x.path);} else if(ev.ctrlKey||ev.metaKey){state.selected=state.selected.includes(p)?state.selected.filter(x=>x!==p):state.selected.concat(p);} else state.selected=[p]; render(); }
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
  // 目录回复是可刷新的完整快照，排序只做一次并失效已删除子树；UI回归验证刷新删除/空目录及缓存不混设备。
  function updateDirectory(message) {
    const directory = safeRemote(message.path || '/');
    const entries = (message.entries || []).map(entry => ({ ...entry, path: safeRemote(entry.path) }));
    entries.sort((a, b) => {
      const ad = a.kind === 'directory' || a.directoryLink, bd = b.kind === 'directory' || b.directoryLink;
      return ad !== bd ? (ad ? -1 : 1) : fileCollator.compare(a.name || baseName(a.path), b.name || baseName(b.path));
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
  // 构造真实文件输入和共用表头/数据的滚动容器，上传期间禁用新操作；UI上传及layout浏览器回归验证文件事件、禁用状态、列对齐和空态。
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
  if (state.error) list.appendChild(text("div", state.error, "state error"));
  else if (!state.serial) list.appendChild(text("div", "No device selected", "state"));
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
  // 扫描与提交共同拥有设备signal，先登记再读取目录，父目录先创建；UI/controller拖入回归覆盖空目录、跨批读取、失败和扫描取消。
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
  // 设备/视图关闭会中止当前等待与真实读取，不向下一设备发送取消命令；UI回归覆盖pending ACK及FileReader取消。
  function cancelUpload() {
    const error = new Error('Upload cancelled because the device view changed'); error.name = 'AbortError';
    state.transfer?.controller.abort(error);
  }
  // 事件边界把失败呈现到现有错误区，明确的上下文取消不污染新设备；UI回归通过文件输入/拖入断言错误可见。
  function showUploadError(error) { if (error.name !== 'AbortError') { state.error = String(error.message || error); render(); } }

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
  // 同步捕获拖放数据/目标再开始异步扫描，不跨设备续传；UI拖入与真实浏览器回归验证目录行、文件父目录、URI列表及视图取消。
  async function dropUpload(event) {
    event.preventDefault();
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
  // 模式切换只取消操作而保留独立快照，真实断开/设备改变才清缓存；view-idle/UI回归覆盖60秒复用、失效和上传取消。
  function receive(m) {
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
    else if (m.type === 'explorerProgress') { state.busy = !!m.busy; state.message = m.message || ''; render(); }
    else if (m.type === 'explorerUploadAck') uploadAck(m);
  }
  // 独立入口渲染对应标题和唯一内容，不再提供内部标签页；UI回归断言三个视图互斥与无tab动作。
  function render(){root.replaceChildren();const label=state.tab==='processes'?'Processes':'Device Explorer';root.setAttribute('aria-label',label);const title=document.createElement('div'); title.className='explorer-title'; title.appendChild(text('span',state.deviceName?label+' - '+state.deviceName:label)); if(state.tab==='processes'){const refresh=button('Refresh','refresh',()=>action('refresh')); refresh.disabled=!state.serial||state.active===false; title.appendChild(refresh);} root.appendChild(title);root.appendChild(state.tab==='files'?filesView():window.DeviceProcessesView.render({state,action,renderParent:render,button,text}));if(state.busy)root.appendChild(text('div',state.message||'Busy','progress'));}
  // 键盘导航支持上下左右、Enter、进程复制和菜单取消，保持固定行选择。
  function keyboard(e){if(root.hidden)return;if(e.key==='Escape'){closeMenu();return;}if(window.DeviceProcessesView.handleKeyboard(state,e))return;if(state.tab!=='files'||!state.selected.length)return;const all=visibleEntries(),i=all.findIndex(x=>x.path===state.selected[0]),cur=all[i];if(e.key==='ArrowDown'||e.key==='ArrowUp'){e.preventDefault();const n=Math.max(0,Math.min(all.length-1,i+(e.key==='ArrowDown'?1:-1)));state.selected=[all[n].path];render();}else if(e.key==='ArrowRight'&&cur&&(cur.kind==='directory'||cur.directoryLink)){e.preventDefault();if(!state.expanded.has(cur.path))toggleDir(cur);}else if(e.key==='ArrowLeft'&&cur){e.preventDefault();if(state.expanded.has(cur.path))state.expanded.delete(cur.path);else state.selected=[parentOf(cur.path)];render();}else if(e.key==='Enter'&&cur){e.preventDefault();cur.kind==='directory'?toggleDir(cur):action('open',{paths:[cur.path]});}}
  root.addEventListener('dragover',(e)=>e.preventDefault());root.addEventListener('drop',e=>dropUpload(e).catch(showUploadError));window.addEventListener('pagehide',cancelUpload);document.addEventListener('mousedown',(e)=>{if(state.menu&&!state.menu.contains(e.target))closeMenu();});document.addEventListener('keydown',keyboard);window.addEventListener('message',(e)=>receive(e.data||{}));
  render(); post({type:'explorer',action:'ready'});
  window.__deviceExplorer = { state, receive, uploadFiles, readEntry };
})();
