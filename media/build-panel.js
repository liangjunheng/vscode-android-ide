(function () {
  const get = (id) => document.getElementById(id);
  const project = get('build-project'), target = get('build-target');
  const status = get('build-status'), run = get('build-run');
  let state = { busy: false, targets: [] }, serial = '', mirrorVisible = true;

  // 输入宿主选项与选择值，以文本节点更新下拉；npm test 的 build panel UI 回归验证转义、空列表和选择。
  function options(select, items, value, empty) {
    select.replaceChildren();
    if (!items.length) { const option = document.createElement('option'); option.value = ''; option.textContent = empty; select.appendChild(option); }
    for (const item of items) { const option = document.createElement('option'); option.value = item.id; option.textContent = item.label; select.appendChild(option); }
    select.value = value || '';
  }

  // 根据真实任务/设备状态控制按钮，不影响镜像；npm test UI 回归覆盖 busy、错误、无设备和停止消息。
  function render() {
    project.disabled = state.busy;
    target.disabled = state.busy || !state.targets.length;
    const stoppable = state.busy || state.running;
    run.disabled = !stoppable && (!serial || !state.target);
    run.title = stoppable ? 'Stop task or app' : 'Build, install and run';
    run.setAttribute('aria-label', state.busy ? 'Stop task' : 'Run app');
    get('build-run-icon').className = 'codicon codicon-' + (stoppable ? 'debug-stop' : 'play');
    get('build-run-label').textContent = stoppable ? 'Stop' : 'Run';
    for (const action of ['build', 'install', 'debug']) get('build-' + action).disabled = state.busy || !state.target || (action !== 'build' && !serial);
    get('build-logcat').disabled = !serial;
    get('build-mirror').setAttribute('aria-pressed', String(mirrorVisible));
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
  run.onclick = () => action(state.busy || state.running ? 'stop' : 'run');
  for (const name of ['build', 'install', 'debug', 'refresh', 'output']) get('build-' + name).onclick = () => action(name);
  // 日志使用当前设备，投屏开关由宿主确认状态；npm test UI 回归验证按钮消息和 aria-pressed。
  get('build-logcat').onclick = () => send({ type: 'logcat' });
  get('build-mirror').onclick = () => send({ type: 'setMirrorVisibility', visible: !mirrorVisible });
  get('build-wifi').onclick = () => send({ type: 'pairDevice' });
  addEventListener('message', ({ data: message }) => {
    if (message.type === 'buildState') {
      state = message;
      options(project, message.projects || [], message.project, 'No Gradle project');
      options(target, message.targets || [], message.target, 'No Android variants');
      render();
    } else if (message.type === 'mirrorVisibility') { mirrorVisible = message.visible; render();
    } else if (message.type === 'devices') { serial = message.serial || ''; render(); }
  });
  render();
  action('refresh');
})();
