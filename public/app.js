const $ = selector => document.querySelector(selector);
const form = $('#project-form');
const createButton = $('#create');
const activity = $('#activity');
let state;
let running = false;
let currentJob;
let pollTimer;

function readOptions() {
  const values = new FormData(form);
  return { name: values.get('name').trim(), parentDir: values.get('parentDir').trim(), groupId: values.get('groupId') || 'com.example', frontend: values.get('frontend'), backend: values.get('backend'), database: values.get('database'), install: $('#install').checked, git: $('#git').checked };
}

function choices(key) {
  const container = $(`#${key}-options`);
  for (const [index, item] of state.catalog[key].entries()) {
    const label = document.createElement('label');
    label.className = 'choice';
    const input = document.createElement('input');
    Object.assign(input, { type: 'radio', name: key, value: item.id, checked: index === 0 });
    const text = document.createElement('span');
    const title = document.createElement('strong'); title.textContent = item.name;
    const detail = document.createElement('small'); detail.textContent = item.detail;
    text.append(title, detail); label.append(input, text); container.append(label);
  }
}

function updatePreview() {
  if (!state) return;
  const backend = form.elements.backend.value;
  for (const input of document.querySelectorAll('input[name=database]')) input.disabled = backend === 'none' && input.value !== 'none';
  if (backend === 'none') form.elements.database.value = 'none';
  $('#group-field').hidden = backend !== 'spring';
  $('#group-id').disabled = backend !== 'spring';
  const options = readOptions();
  const labels = ['frontend', 'backend', 'database'].filter(key => options[key] !== 'none').map(key => state.catalog[key].find(item => item.id === options[key]).name);
  $('#stack-label').textContent = labels.join(' / ');
  $('#tree-name').textContent = options.name || 'my-project';
  const nodes = [];
  if (options.frontend !== 'none') nodes.push(['frontend/', [`src/App.${options.frontend === 'vue' ? 'vue' : 'tsx'}`, `src/main.${options.frontend === 'vue' ? 'ts' : 'tsx'}`, 'vite.config.ts', 'package.json']]);
  if (backend === 'spring') nodes.push(['backend/', ['src/main/java/', 'src/main/resources/', 'pom.xml', 'mvnw · mvnw.cmd']]);
  if (backend === 'express') nodes.push(['backend/', ['src/server.js', 'package.json']]);
  if (options.database !== 'none') nodes.push(['compose.yaml'], ['.env · .env.example']);
  nodes.push(['scripts/dev.mjs'], ['package.json'], ['README.md'], ['stackforge.json']);
  if (options.git) nodes.push(['.git/']);
  $('#file-tree').textContent = nodes.map(([name, children], index) => `${index === nodes.length - 1 ? '└' : '├'}─ ${name}${children ? '\n' + children.map((child, ci) => `${index === nodes.length - 1 ? ' ' : '│'}  ${ci === children.length - 1 ? '└' : '├'}─ ${child}`).join('\n') : ''}`).join('\n');
  $('#start-command').textContent = options.install ? 'npm run dev' : 'npm install\nnpm run dev';
  $('#launch-description').textContent = options.database !== 'none' ? '自动启动数据库，并运行前后端服务。数据库数据保存在 Docker 数据卷中。' : backend === 'none' ? '启动 Vite 开发服务器，直接开始编写页面。' : options.frontend === 'none' ? '启动后端服务，健康检查接口开箱即用。' : '同时启动前后端，/api 请求自动代理到本机后端。';
  $('#database-hint').textContent = options.database === 'none' ? '不生成数据库服务，后续可按需要添加。' : '生成 Compose 配置与连接驱动，开发启动时自动启动数据库。';
  const requirements = ['Node.js 22.12+'];
  if (backend === 'spring') requirements.push('Java 21+ · 自动提供 Maven Wrapper');
  if (options.database !== 'none') requirements.push('Docker Desktop / Docker Compose v2');
  if (options.git) requirements.push('Git');
  $('#requirements').replaceChildren(...requirements.map(text => { const li = document.createElement('li'); li.textContent = text; return li; }));
  try { localStorage.setItem('stackforge.preferences', JSON.stringify({ frontend: options.frontend, backend, database: options.database, groupId: options.groupId, install: options.install, git: options.git })); } catch {}
}

function lockForm(value) {
  running = value;
  for (const input of form.querySelectorAll('input')) input.disabled = value;
  for (const button of document.querySelectorAll('[data-preset]')) button.disabled = value;
  createButton.disabled = value;
  createButton.querySelector('span').textContent = value ? '正在创建…' : '创建项目';
  if (!value) updatePreview();
}

function showError(message) {
  activity.dataset.status = 'failed';
  $('#job-state').textContent = '创建失败';
  $('#job-message').textContent = message;
  $('#progress').hidden = true;
  lockForm(false);
}

async function pollJob() {
  try {
    const response = await fetch(`/api/jobs/${currentJob}`);
    const job = await response.json();
    if (!response.ok) {
      if (response.status === 404) {
        try { sessionStorage.removeItem('stackforge.job'); } catch {}
        showError('创建任务已失效。服务可能已重启，请先检查目标目录，再重新创建。');
        return;
      }
      throw new Error(job.error);
    }
    activity.dataset.status = job.status;
    $('#job-state').textContent = job.status === 'running' ? `${job.progress}%` : job.status === 'complete' ? '创建成功' : '创建失败';
    $('#job-message').textContent = job.status === 'failed' ? job.error : job.step;
    $('#progress').value = job.progress;
    $('#logs').textContent = job.logs.join('\n');
    if (job.status === 'running') { pollTimer = setTimeout(pollJob, 900); return; }
    $('#progress').hidden = true;
    lockForm(false);
    try { sessionStorage.removeItem('stackforge.job'); } catch {}
    if (job.status === 'complete') {
      $('#result').hidden = false;
      $('#result-path').textContent = job.result.path;
      $('#result-commands').textContent = job.result.commands.join('\n');
      $('#job-message').textContent = '文件已生成。进入项目目录，即可开始开发。';
    } else $('#logs-panel').open = true;
  } catch (error) {
    $('#job-state').textContent = '连接已断开';
    $('#job-message').textContent = '无法读取创建状态，请检查本地服务。连接恢复后将继续显示进度。';
    pollTimer = setTimeout(pollJob, 3000);
  }
}

form.addEventListener('input', () => { if (!running) updatePreview(); });
form.addEventListener('change', () => { if (!running) updatePreview(); });
form.addEventListener('submit', async event => {
  event.preventDefault();
  if (running || !state || !form.reportValidity()) return;
  const options = readOptions();
  if (options.frontend === 'none' && options.backend === 'none') { showError('至少选择一个前端或后端。'); return; }
  $('#result').hidden = true;
  $('#logs').textContent = '';
  $('#logs-panel').hidden = false;
  $('#logs-panel').open = false;
  $('#progress').hidden = false;
  $('#progress').value = 0;
  activity.dataset.status = 'running';
  $('#job-state').textContent = '准备中';
  $('#job-message').textContent = '正在提交创建任务…';
  lockForm(true);
  try {
    const response = await fetch('/api/projects', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-StackForge-Token': state.token }, body: JSON.stringify(options) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error);
    currentJob = data.id;
    try { sessionStorage.setItem('stackforge.job', JSON.stringify({ id: currentJob, options })); } catch {}
    clearTimeout(pollTimer);
    pollJob();
  } catch (error) { showError(error.message); }
});

document.addEventListener('click', event => {
  const preset = event.target.closest('[data-preset]');
  if (!preset || running || !state) return;
  const values = { java: ['vue', 'spring', 'mysql'], node: ['react', 'express', 'postgres'], web: ['vue', 'none', 'none'] }[preset.dataset.preset];
  ['frontend', 'backend', 'database'].forEach((key, i) => { form.elements[key].value = values[i]; });
  updatePreview();
});
$('#copy-path').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText($('#result-path').textContent); $('#copy-path').textContent = '已复制'; setTimeout(() => { $('#copy-path').textContent = '复制路径'; }, 1600); }
  catch { $('#copy-path').textContent = '请手动选择上方路径复制'; }
});

async function init() {
  try {
    const response = await fetch('/api/state');
    if (!response.ok) throw new Error('无法连接本地服务，请刷新页面。');
    state = await response.json();
    ['frontend', 'backend', 'database'].forEach(choices);
    $('#parent-dir').value = state.defaultDir;
    $('#node-version').textContent = `Node.js ${state.node} · 已连接`;
    let preferences;
    try { preferences = JSON.parse(localStorage.getItem('stackforge.preferences') || 'null'); } catch {}
    if (preferences) {
      for (const key of ['frontend', 'backend', 'database']) if (state.catalog[key].some(item => item.id === preferences[key])) form.elements[key].value = preferences[key];
      for (const key of ['install', 'git']) if (typeof preferences[key] === 'boolean') $(`#${key}`).checked = preferences[key];
      if (typeof preferences.groupId === 'string') $('#group-id').value = preferences.groupId;
    }
    createButton.disabled = false;
    updatePreview();
    let saved;
    try { saved = JSON.parse(sessionStorage.getItem('stackforge.job') || 'null'); } catch {}
    if (saved?.id && saved.options) {
      // Restore the generating configuration too; disabled fields must match the job.
      for (const key of ['frontend', 'backend', 'database', 'name', 'parentDir', 'groupId']) if (saved.options[key]) form.elements[key].value = saved.options[key];
      for (const key of ['install', 'git']) $(`#${key}`).checked = saved.options[key];
      updatePreview(); currentJob = saved.id;
      const check = await fetch(`/api/jobs/${currentJob}`);
      if (check.ok) { lockForm(true); $('#logs-panel').hidden = false; $('#progress').hidden = false; pollJob(); }
      else { try { sessionStorage.removeItem('stackforge.job'); } catch {} }
    }
  } catch (error) { $('#job-state').textContent = '服务未连接'; $('#job-message').textContent = error.message; }
}
init();
