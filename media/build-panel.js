(function () {
  const get = (id) => document.getElementById(id);
  const project = get('build-project'), target = get('build-target');
  const status = get('build-status'), run = get('build-run'), runMode = get('build-run-mode');
  let state = { busy: false, deviceLoading: true, targets: [], runModes: [] }, serial = '';
  let viewMode = document.body.dataset.deviceViewMode || (document.body.dataset.mirrorVisible === 'false' ? 'hidden' : 'mirror');

  // 输入宿主选项与选择值，保留下拉按钮及其加载图标；npm test 的 build panel UI 回归验证转义、空列表和选择。
  function options(select, items, value, empty) {
    const button = select.querySelector('button');
    select.replaceChildren(button);
    if (!items.length) { const option = document.createElement('option'); option.value = ''; option.textContent = empty; select.appendChild(option); }
    for (const item of items) { const option = document.createElement('option'); option.value = item.id; option.textContent = item.label; select.appendChild(option); }
    select.value = value || '';
  }

  // 根据Gradle、设备和运行模式控制加载图标、暂停状态及开始图标；build-panel-ui回归覆盖应用项、六个debug项、选择和结束复位。
  function render() {
    project.disabled = state.busy;
    target.disabled = state.busy || !state.targets.length;
    runMode.disabled = state.busy || state.running;
    const selectedMode = (state.runModes || []).find(mode => mode.id === (runMode.value || state.runMode)) || { action: 'run' };
    const stoppable = state.busy || state.running;
    run.disabled = !stoppable && (!serial || !state.target);
    run.title = stoppable ? 'Pause task or app' : selectedMode.action === 'debug' ? 'Start debugging' : 'Build, install and run';
    run.setAttribute('aria-label', stoppable ? 'Pause task or app' : selectedMode.action === 'debug' ? 'Start debugging' : 'Run app');
    run.setAttribute('data-mode', selectedMode.action);
    get('build-run-icon').className = 'codicon codicon-' + (stoppable ? 'debug-pause' : selectedMode.action === 'debug' ? 'debug-alt' : 'play');
    for (const action of ['build', 'install']) get('build-' + action).disabled = state.busy || !state.target || (action !== 'build' && !serial);
    get('build-logcat').disabled = false;
    get('build-project-loading').hidden = !state.busy;
    get('build-target-loading').hidden = !state.busy;
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
    get('build-refresh').disabled = state.busy;
    get('build-root-count').textContent = (state.projects || []).length + ' Gradle roots';
    status.textContent = state.error || state.status || 'No Gradle project';
    status.title = status.textContent;
    status.classList.toggle('failed', !!state.error);
    get('build-progress').classList.toggle('codicon-modifier-spin', !!state.busy);
    get('build-progress').classList.toggle('codicon-loading', !!state.busy);
  }

  // 只发送已知动作与宿主返回的选择值，后端再次校验；npm test UI 回归执行每个控件并断言消息。
  function action(name, value) { send({ type: 'buildPanel', action: name, value }); }
  project.onchange = () => action('project', project.value);
  target.onchange = () => action('target', target.value);
  runMode.onchange = () => { state.runMode = runMode.value; render(); action('runMode', runMode.value); };
  run.onclick = () => action(state.busy || state.running ? 'stop' : 'run', runMode.value);
  for (const name of ['build', 'install', 'refresh', 'output']) get('build-' + name).onclick = () => action(name);
  // 日志使用当前设备，投屏开关由宿主确认状态；npm test UI 回归验证按钮消息和 aria-pressed。
  get('build-logcat').onclick = () => send({ type: 'logcat' });
  // 设备选择框后的三个按钮共用唯一模式，重复点击选中项隐藏，不再绑定Wi-Fi按钮；device-view-mode及build-panel-ui回归断言互斥、消息及无旧绑定。
  get('build-mirror').onclick = () => send({ type: 'setDeviceViewMode', mode: viewMode === 'mirror' ? 'hidden' : 'mirror' });
  get('build-explorer').onclick = () => send({ type: 'setDeviceViewMode', mode: viewMode === 'explorer' ? 'hidden' : 'explorer' });
  get('build-processes').onclick = () => send({ type: 'setDeviceViewMode', mode: viewMode === 'processes' ? 'hidden' : 'processes' });
  addEventListener('message', ({ data: message }) => {
    if (message.type === 'buildState') {
      state = { ...message, deviceLoading: message.deviceLoading ?? state.deviceLoading };
      options(project, message.projects || [], message.project, 'No Gradle project');
      options(target, message.targets || [], message.target, 'No Android variants');
      options(runMode, message.runModes || [{ id: 'run', label: 'Application', action: 'run' }], message.runMode || runMode.value || 'run', 'No run mode');
      state.runMode = runMode.value;
      render();
    } else if (message.type === 'deviceViewMode') { viewMode = message.mode; render();
    } else if (message.type === 'mirrorVisibility') { viewMode = message.mode || (message.visible ? 'mirror' : 'hidden'); render();
    } else if (message.type === 'devices') { serial = message.serial || ''; state.deviceLoading = false; render(); }
    else if (message.type === 'deviceLoading') { state.deviceLoading = message.loading; render(); }
    else if (message.type === 'error') { state = { ...state, error: message.text }; render(); }
  });
  render();
  action('refresh');
  // 脚本监听注册后确认持久化状态；npm test UI preference 回归验证请求，避免 ready 回包先到。
  send({ type: 'getMirrorVisibility' });
})();
