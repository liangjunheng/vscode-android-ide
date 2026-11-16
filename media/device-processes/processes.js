(function () {
  // 独立进程列表按卡片完整展示六项信息，复用操作工厂；UI/layout浏览器回归验证单选、排序、字段与窄面板无横向滚动。
  function renderProcesses({ state, action, renderParent, button, text }) {
    const wrap = document.createElement('div'); wrap.className = 'processes-view';
    const controls = document.createElement('div'); controls.className = 'process-controls';
    const query = document.createElement('input'); query.className = 'process-filter'; query.placeholder = 'Filter';
    query.setAttribute('aria-label', 'Filter processes'); query.value = state.processQuery || '';
    query.addEventListener('input', () => { state.processQuery = query.value; draw(); });
    controls.appendChild(query);
    const columns = [['Package Name', 'packageName'], ['Process Name', 'name'], ['PID', 'pid'], ['ABI', 'abi'], ['VM', 'vm'], ['User ID', 'userId'], ['Debugger', 'debugger']];
    const sort = document.createElement('select'); sort.className = 'process-sort'; sort.title = 'Sort processes'; sort.setAttribute('aria-label', 'Sort processes');
    for (const [label, key] of columns) { const option = text('option', label); option.value = key; sort.appendChild(option); }
    sort.value = state.sort.key;
    sort.addEventListener('change', () => { state.sort = { key: sort.value, asc: state.sort.asc }; renderParent(); });
    controls.appendChild(sort);
    const direction = button(state.sort.asc ? 'Sort descending' : 'Sort ascending', state.sort.asc ? 'arrow-up' : 'arrow-down', () => { state.sort = { ...state.sort, asc: !state.sort.asc }; renderParent(); });
    direction.className += ' process-sort-direction'; controls.appendChild(direction); wrap.appendChild(controls);
    const list = document.createElement('div'); list.className = 'process-list'; list.setAttribute('role', 'list');
    wrap.appendChild(list);
    // 卡片只用textContent，过滤/排序不改原数组；UI/layout回归验证长名称换行、零UID、缺失字段、查询持久与操作归属。
    function draw() {
      list.replaceChildren();
      const queryText = (state.processQuery || '').toLowerCase();
      const rows = state.processes.filter(process => !queryText || [process.name, process.packageName, process.pid].join(' ').toLowerCase().includes(queryText));
      const key = state.sort.key;
      rows.sort((a, b) => { const valueA = a[key] ?? (key === 'packageName' ? a.name : a.packageName) ?? '', valueB = b[key] ?? (key === 'packageName' ? b.name : b.packageName) ?? ''; const invalid = (process, value) => !String(value).trim() || (key === 'packageName' ? !process.packageName || String(process.packageName).toLowerCase() === 'unknown' : ['pid', 'userId', 'abi', 'debugger'].includes(key) && String(value).toLowerCase() === 'error'); const invalidA = invalid(a, valueA), invalidB = invalid(b, valueB); if (invalidA !== invalidB) return invalidA ? 1 : -1; return String(valueA).localeCompare(String(valueB), undefined, { numeric: true, sensitivity: 'base' }) * (state.sort.asc ? 1 : -1); });
      if (state.error) list.appendChild(text('div', state.error, 'state error'));
      for (const process of rows) {
        const card = document.createElement('article'); card.className = 'process-card'; card.tabIndex = 0;
        card.setAttribute('role', 'listitem'); card.setAttribute('aria-current', String(process.pid === state.processSelected));
        card.setAttribute('aria-label', (process.name || process.packageName || '<unknown-pid>') + ', PID ' + process.pid);
        if (process.pid === state.processSelected) card.classList.add('selected');
        // 点击和键盘激活共享选择，重绘保留查询与排序；UI/layout回归断言选择后操作只作用于卡片PID。
        const select = () => { state.processSelected = process.pid; renderParent(); };
        card.addEventListener('click', select);
        card.addEventListener('keydown', event => { if ((!event.target || event.target === card) && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); select(); } });
        const header = document.createElement('div'); header.className = 'process-card-header';
        const name = text('div', process.name || process.packageName || '<unknown-pid>', 'process-name'); name.title = name.textContent;
        header.appendChild(name); header.appendChild(text('span', 'PID ' + process.pid, 'process-pid')); card.appendChild(header);
        const details = document.createElement('dl'); details.className = 'process-details';
        const debuggerState = process.debugger === 'waiting' ? 'Waiting' : process.debugger === 'attached' ? 'Attached' : process.debugger === 'error' ? 'Error' : 'Default';
        for (const [label, value] of [['ABI', process.abi], ['VM', process.vm], ['User ID', process.userId], ['Debugger', debuggerState]]) {
          const field = document.createElement('div'); field.className = 'process-field';
          field.appendChild(text('dt', label)); field.appendChild(text('dd', value == null || value === '' ? '-' : value)); details.appendChild(field);
        }
        card.appendChild(details);
        const actions = document.createElement('div'); actions.className = 'process-actions'; actions.setAttribute('role', 'group'); actions.setAttribute('aria-label', 'Process actions');
        // 每个按钮捕获所属卡片PID且阻止冒泡重绘；UI/layout回归验证五动作、无需先选中、键盘单次发送和禁用状态。
        for (const [title, icon, command] of [['Kill', 'debug-stop', 'kill'], ['Force Stop', 'circle-slash', 'forceStop'], ['Attach Debugger', 'debug-alt', 'debug'], ['Clear Data', 'clear-all', 'clearData'], ['Uninstall', 'trash', 'uninstall']]) {
          const control = button(title, icon, event => { event.stopPropagation(); action(command, { pid: process.pid }); });
          control.disabled = !state.serial || state.active === false || (command === 'debug' && state.capabilities.debug === false);
          actions.appendChild(control);
        }
        card.appendChild(actions); list.appendChild(card);
      }
      if (!rows.length && !state.busy) list.appendChild(text('div', state.serial ? 'No processes' : 'No device selected', 'state'));
    }
    draw(); return wrap;
  }

  // 保留已选进程复制快捷键，当前区域不可见时由共享宿主阻止；UI回归覆盖卡片选择后复制。
  function handleKeyboard(state, event) {
    if (state.tab !== 'processes' || !(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'c' || state.processSelected == null) return false;
    const process = state.processes.find(row => row.pid === state.processSelected);
    if (process) navigator.clipboard?.writeText((process.name || process.packageName || '') + ':' + process.pid);
    return true;
  }
  window.DeviceProcessesView = { render: renderProcesses, handleKeyboard };
})();
