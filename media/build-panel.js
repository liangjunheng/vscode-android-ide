// 初始化两侧共用构建控件，输入消息出口；node --test tests/build-panel-ui.test.js 验证选择、启停、空态和忙碌，LOGCAT_BROWSER=1 验证真实控件交互。
function initBuildPanel(send) {
  const get = (id) => document.getElementById(id);
  const project = get('build-project'), target = get('build-target');
  const status = get('build-status'), run = get('build-run'), runMode = get('build-run-mode');
  const debugMode = get('build-debug-mode'), debugLaunch = get('build-debug-launch'), debugAttach = get('build-debug-attach');
  const deviceTools = !!get('build-mirror');
  let state = { busy: false, deviceLoading: true, targets: [], runModes: [], debugMode: 'dual' }, serial = '';
  let viewMode = document.body.dataset.deviceViewMode || (document.body.dataset.mirrorVisible === 'false' ? 'hidden' : 'mirror');

  // 输入宿主选项与选择值，保留下拉按钮及其加载图标；npm test 的 build panel UI 回归验证转义、空列表和选择。
  function options(select, items, value, empty) {
    const button = select.querySelector('button');
    select.replaceChildren(button);
    if (!items.length) { const option = document.createElement('option'); option.value = ''; option.textContent = empty; select.appendChild(option); }
    for (const item of items) { const option = document.createElement('option'); option.value = item.id; option.textContent = item.label; select.appendChild(option); }
    select.value = value || '';
  }

  // 功能：根据宿主快照刷新 Run、调试模式和 Launch/Attach 控件。
  // 输入：构建状态、当前设备、变体和调试模式；前置条件是共享控件已初始化。
  // 输出：更新控件文字、图标、禁用状态和动作入口，不执行宿主任务。
  // 验证：node --test tests/build-panel-ui.test.js；LOGCAT_BROWSER=1 node --test tests/logcat-browser.test.js。
  function render() {
    const stoppable = state.busy || state.running || state.stopping;
    const selectedMode = runMode ? (state.runModes || []).find(mode => mode.id === (runMode.value || state.runMode)) || { action: 'run' } : { action: 'run' };
    const modeAction = selectedMode.action;
    const activeAction = state.activeAction || (!debugMode && stoppable ? 'run' : undefined);
    const activeRun = activeAction === 'run';
    const activeLaunch = activeAction === 'debugLaunch';
    const activeAttach = activeAction === 'debugAttach';
    if (runMode) runMode.disabled = stoppable;
    if (debugMode) {
      debugMode.value = state.debugMode || 'dual';
      debugMode.disabled = stoppable;
      const selected = debugMode.querySelector('selectedcontent');
      const labels = { dual: 'Dual', jvm: 'Jvm', native: 'Native' };
      if (selected) selected.textContent = labels[debugMode.value] || 'Dual';
    }
    if (debugLaunch) debugLaunch.disabled = stoppable && !activeLaunch || (!stoppable && (!serial || !state.target));
    if (debugAttach) debugAttach.disabled = stoppable && !activeAttach || (!stoppable && (!serial || !state.target));
    run.disabled = stoppable && !activeRun || (!stoppable && (!serial || !state.target));
    run.title = activeRun && stoppable ? 'Stop task or app' : 'Build, install and run';
    run.setAttribute('aria-label', activeRun && stoppable ? 'Stop task or app' : 'Run app');
    run.setAttribute('data-mode', activeRun && stoppable ? 'stop' : 'run');
    get('build-run-icon').className = 'codicon codicon-' + (activeRun && stoppable ? 'debug-pause' : modeAction === 'debug' ? 'debug-alt' : 'play');
    if (debugLaunch) { debugLaunch.title = activeLaunch && stoppable ? 'Stop debug launch' : 'Debug launch'; debugLaunch.setAttribute('aria-label', debugLaunch.title); debugLaunch.setAttribute('data-mode', activeLaunch && stoppable ? 'stop' : 'debugLaunch'); }
    if (debugAttach) { debugAttach.title = activeAttach && stoppable ? 'Stop debug attach' : 'Debug attach'; debugAttach.setAttribute('aria-label', debugAttach.title); debugAttach.setAttribute('data-mode', activeAttach && stoppable ? 'stop' : 'debugAttach'); }
    if (debugLaunch) get('build-debug-launch-icon').className = 'codicon codicon-' + (activeLaunch && stoppable ? 'debug-pause' : 'debug');
    if (debugAttach) {
      const attachActive = activeAttach && stoppable;
      get('build-debug-attach-image').hidden = attachActive;
      get('build-debug-attach-icon').hidden = !attachActive;
      get('build-debug-attach-icon').className = 'codicon codicon-debug-pause';
    }
    if (deviceTools) {
      project.disabled = state.busy || state.stopping;
      target.disabled = state.busy || state.stopping || !state.targets.length;
      for (const action of ['build', 'install']) get('build-' + action).disabled = state.busy || state.stopping || !state.target || (action !== 'build' && !serial);
      const gradleLoading = state.gradleLoading ?? (state.busy && !state.running);
      get('build-project-loading').hidden = !gradleLoading;
      get('build-target-loading').hidden = !gradleLoading;
      get('build-logcat').disabled = false;
      get('build-device-loading').hidden = !state.deviceLoading;
      const mirrorVisible = viewMode === 'mirror';
      get('build-mirror').setAttribute('aria-pressed', String(mirrorVisible));
      get('build-explorer').setAttribute('aria-pressed', String(viewMode === 'explorer'));
      get('build-explorer').title = viewMode === 'explorer' ? 'Hide Device Explorer' : 'Show Device Explorer';
      get('build-explorer').setAttribute('aria-label', get('build-explorer').title);
      get('build-processes').setAttribute('aria-pressed', String(viewMode === 'processes'));
      get('build-processes').title = viewMode === 'processes' ? 'Hide Processes' : 'Show Processes';
      get('build-processes').setAttribute('aria-label', get('build-processes').title);
      get('device-explorer').hidden = viewMode !== 'explorer' && viewMode !== 'processes';
      document.body.dataset.deviceViewMode = viewMode;
      get('build-mirror').title = mirrorVisible ? 'Hide mirroring' : 'Show mirroring';
      get('build-mirror').setAttribute('aria-label', get('build-mirror').title);
      document.body.classList.toggle('mirror-hidden', !mirrorVisible);
      get('build-refresh').disabled = gradleLoading;
      get('build-root-count').textContent = (state.projects || []).length + ' Gradle roots';
      status.textContent = state.error || state.status || 'No Gradle project';
      status.title = status.textContent;
      status.classList.toggle('failed', !!state.error);
      get('build-progress').classList.toggle('codicon-modifier-spin', !!state.busy);
      get('build-progress').classList.toggle('codicon-loading', !!state.busy);
    }
  }

  // 只发送已知动作与宿主返回的选择值，后端再次校验；npm test UI 回归执行每个控件并断言消息。
  function action(name, value) { send({ type: 'buildPanel', action: name, value }); }
  run.onclick = () => action(state.busy || state.running || state.stopping ? 'stop' : runMode ? 'run' : 'runApp', runMode?.value);
  if (runMode) runMode.onchange = () => { state.runMode = runMode.value; render(); action('runMode', runMode.value); };
  if (debugMode) debugMode.onchange = () => {
    if (state.busy || state.running || state.stopping) { render(); return; }
    state.debugMode = debugMode.value;
    action('debugMode', state.debugMode);
  };
  if (debugLaunch) debugLaunch.onclick = () => action(state.busy || state.running || state.stopping ? 'stop' : 'debugLaunch', state.debugMode || 'dual');
  if (debugAttach) debugAttach.onclick = () => action(state.busy || state.running || state.stopping ? 'stop' : 'debugAttach', state.debugMode || 'dual');
  // Logcat 只绑定模式与启停；npm test build panel UI 验证删去控件无DOM依赖且 Device Tools 保留全部动作。
  if (deviceTools) {
    project.onchange = () => action('project', project.value);
    target.onchange = () => action('target', target.value);
    for (const name of ['build', 'install', 'refresh', 'output']) get('build-' + name).onclick = () => action(name);
    get('build-logcat').onclick = () => send({ type: 'logcat' });
    // 设备选择框后的三个按钮共用唯一模式，重复点击选中项隐藏；device-view-mode及build-panel-ui回归断言互斥和消息。
    get('build-mirror').onclick = () => send({ type: 'setDeviceViewMode', mode: viewMode === 'mirror' ? 'hidden' : 'mirror' });
    get('build-explorer').onclick = () => send({ type: 'setDeviceViewMode', mode: viewMode === 'explorer' ? 'hidden' : 'explorer' });
    get('build-processes').onclick = () => send({ type: 'setDeviceViewMode', mode: viewMode === 'processes' ? 'hidden' : 'processes' });
  }
  addEventListener('message', ({ data: message }) => {
    if (message.type === 'buildState') {
      state = { ...message, deviceLoading: message.deviceLoading ?? state.deviceLoading };
      if (deviceTools) {
        options(project, message.projects || [], message.project, 'No Gradle project');
        options(target, message.targets || [], message.target, 'No Android variants');
      }
      if (runMode) {
        options(runMode, message.runModes || [{ id: 'run', label: 'Application', action: 'run' }], message.runMode || runMode.value || 'run', 'No run mode');
        state.runMode = runMode.value;
      }
      state.debugMode = message.debugMode || state.debugMode || 'dual';
      render();
    } else if (message.type === 'deviceViewMode') { viewMode = message.mode; render();
    } else if (message.type === 'mirrorVisibility') { viewMode = message.mode || (message.visible ? 'mirror' : 'hidden'); render();
    } else if (message.type === 'devices') { serial = message.serial || ''; state.deviceLoading = false; render(); }
    else if (message.type === 'deviceLoading') { state.deviceLoading = message.loading; render(); }
    else if (message.type === 'error') { state = { ...state, error: message.text }; render(); }
  });
  render();
  action('sync');
  // 脚本监听注册后确认持久化状态；npm test UI preference 回归验证请求，避免 ready 回包先到。
  if (deviceTools) send({ type: 'getMirrorVisibility' });
}
