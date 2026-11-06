import { normalizeTemplate, parseTemplateFile } from './template-store.js';

const $ = selector => document.querySelector(selector);
const form = $('#project-form');
const createButton = $('#create');
const activity = $('#activity');
let state;
let running = false;
let currentJob;
let pollTimer;
let currentOptions;
let checkTimer;
let checkSerial = 0;
let repoNameEdited = false;
let templates = [];

function readOptions() {
  const values = new FormData(form);
  return { name: values.get('name').trim(), parentDir: values.get('parentDir').trim(), groupId: $('#group-id').value || 'com.example', frontend: values.get('frontend'), backend: values.get('backend'), database: values.get('database'), install: $('#install').checked, git: $('#git').checked, commit: $('#commit').checked, publish: $('#publish').checked, authorName: $('#author-name').value.trim(), authorEmail: $('#author-email').value.trim(), repoName: $('#repo-name').value.trim() || values.get('name').trim(), visibility: $('#visibility').value };
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
  $('#identity-fields').hidden = !$('#commit').checked;
  $('#publish-fields').hidden = !$('#publish').checked;
  for (const field of document.querySelectorAll('#identity-fields input')) field.disabled = !$('#commit').checked;
  for (const field of document.querySelectorAll('#publish-fields input, #publish-fields select')) field.disabled = !$('#publish').checked;
  const options = readOptions();
  if (!running) createButton.querySelector('span').textContent = options.publish ? '创建并发布到 GitHub' : '检查并创建项目';
  $('#publish-notice').textContent = `将代码推送到当前 GitHub 账号下的新${options.visibility === 'public' ? '公开' : '私有'}仓库${options.visibility === 'public' ? '，源码和提交记录将对所有人可见。' : '。'}`;
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
  try { localStorage.setItem('stackforge.preferences', JSON.stringify({ frontend: options.frontend, backend, database: options.database, groupId: options.groupId, install: options.install, git: options.git, commit: options.commit })); } catch {}
}

function syncGit(source) {
  if (source === 'publish' && $('#publish').checked) { $('#git').checked = true; $('#commit').checked = true; }
  if (source === 'commit' && $('#commit').checked) $('#git').checked = true;
  if (!$('#git').checked) { $('#commit').checked = false; $('#publish').checked = false; }
  if (!$('#commit').checked) $('#publish').checked = false;
}

function renderEnvironment(report) {
  const errors = report.checks.filter(item => item.status === 'error');
  const warnings = report.checks.filter(item => item.status === 'warning');
  const passed = report.checks.filter(item => item.status === 'ok');
  $('.environment').dataset.status = errors.length ? 'error' : warnings.length ? 'warning' : 'ok';
  $('#environment-summary').textContent = errors.length ? `${errors.length} 项问题需处理后再创建` : warnings.length ? `可以创建 · ${warnings.length} 项启动提示` : '环境就绪，可以创建';
  const row = item => {
    const li = document.createElement('li'); li.dataset.status = item.status;
    const title = document.createElement('strong'); title.textContent = item.label;
    const detail = document.createElement('p'); detail.textContent = item.detail;
    li.append(title, detail);
    if (item.status !== 'ok' && item.fix) { const fix = document.createElement('p'); fix.textContent = item.fix; li.append(fix); }
    if (item.url) { const link = document.createElement('a'); link.href = item.url; link.textContent = '打开官方安装说明'; link.target = '_blank'; link.rel = 'noreferrer'; li.append(link); }
    return li;
  };
  $('#critical-checks').replaceChildren(...[...errors, ...warnings].map(row));
  $('#passed-checks').replaceChildren(...passed.map(row));
  $('#all-checks summary').textContent = `${passed.length} 项检测已通过`;
}

async function runChecks() {
  if (!state || running) return;
  const serial = ++checkSerial;
  $('#check-environment').disabled = true;
  $('#environment-summary').textContent = '正在检测当前配置所需的环境…';
  try {
    const response = await fetch('/api/checks', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-StackForge-Token': state.token }, body: JSON.stringify(readOptions()), signal: AbortSignal.timeout(40000) });
    const report = await response.json();
    if (serial !== checkSerial) return;
    if (!response.ok) throw new Error(report.error);
    renderEnvironment(report);
  } catch (error) {
    if (serial !== checkSerial) return;
    $('.environment').dataset.status = 'error';
    $('#environment-summary').textContent = error.message || '检测未完成，请检查本地服务后重试。';
  } finally { if (serial === checkSerial) $('#check-environment').disabled = running; }
}

function scheduleChecks() {
  clearTimeout(checkTimer);
  ++checkSerial; // ignore a response for an older configuration immediately
  checkTimer = setTimeout(runChecks, 650);
}

function templateMessage(message, error = false) {
  $('#template-message').textContent = message;
  $('#template-message').dataset.status = error ? 'error' : 'ok';
}

function refreshTemplates(selected = '') {
  const select = $('#saved-template');
  const placeholder = document.createElement('option'); placeholder.value = ''; placeholder.textContent = templates.length ? '选择一个模板' : '还没有保存的模板';
  select.replaceChildren(placeholder, ...templates.map(item => { const option = document.createElement('option'); option.value = item.name; option.textContent = item.name; return option; }));
  select.value = selected;
  $('#delete-template').disabled = running || !select.value;
  $('#export-templates').disabled = running || !templates.length;
}

function persistTemplates(next, selected = '') {
  localStorage.setItem('stackforge.templates', JSON.stringify({ format: 'stackforge-presets', version: 1, templates: next }));
  templates = next;
  refreshTemplates(selected);
}

function applyTemplate(config) {
  for (const key of ['frontend', 'backend', 'database']) form.elements[key].value = config[key];
  $('#group-id').value = config.groupId;
  for (const key of ['install', 'git', 'commit']) $(`#${key}`).checked = config[key];
  $('#publish').checked = false;
  syncGit(); updatePreview(); scheduleChecks();
}

function lockForm(value) {
  running = value;
  clearTimeout(checkTimer);
  ++checkSerial;
  for (const input of form.querySelectorAll('input, select, button')) input.disabled = value;
  for (const button of document.querySelectorAll('[data-preset], #check-environment, #retry-publish')) button.disabled = value;
  createButton.disabled = value;
  createButton.querySelector('span').textContent = value ? '正在创建…' : '创建项目';
  if (!value) { updatePreview(); refreshTemplates($('#saved-template').value); }
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
      const remote = job.result.remote;
      $('#remote-link').hidden = remote?.status !== 'published';
      $('#retry-publish').hidden = remote?.status !== 'failed';
      $('#remote-result').textContent = remote?.status === 'published' ? `已发布到 GitHub · ${remote.visibility === 'public' ? '公开仓库' : '私有仓库'}` : remote?.status === 'failed' ? `本地项目已保留。GitHub 发布未完成：${remote.error}` : '';
      if (remote?.status === 'published') $('#remote-link').href = remote.url;
      if (remote?.status === 'failed') { $('#job-state').textContent = '本地已创建'; $('#logs-panel').open = true; }
    } else $('#logs-panel').open = true;
  } catch (error) {
    $('#job-state').textContent = '连接已断开';
    $('#job-message').textContent = '无法读取创建状态，请检查本地服务。连接恢复后将继续显示进度。';
    pollTimer = setTimeout(pollJob, 3000);
  }
}

form.addEventListener('input', event => {
  if (running || ['template-name', 'template-file'].includes(event.target.id)) return;
  if (event.target.id === 'repo-name') repoNameEdited = true;
  if (event.target.id === 'project-name' && !repoNameEdited) $('#repo-name').value = event.target.value;
  syncGit(event.target.id); updatePreview(); scheduleChecks();
});
form.addEventListener('change', event => {
  if (running || ['saved-template', 'template-file'].includes(event.target.id)) return;
  syncGit(event.target.id); updatePreview(); scheduleChecks();
});
form.addEventListener('submit', async event => {
  event.preventDefault();
  if (running || !state || !form.reportValidity()) return;
  const options = readOptions();
  currentOptions = options;
  if (options.frontend === 'none' && options.backend === 'none') { showError('至少选择一个前端或后端。'); return; }
  $('#result').hidden = true;
  $('#logs').textContent = '';
  $('#logs-panel').hidden = false;
  $('#logs-panel').open = false;
  $('#progress').hidden = false;
  $('#progress').value = 0;
  activity.dataset.status = 'running';
  $('#job-state').textContent = '准备中';
  $('#job-message').textContent = '正在执行创建前检查…';
  lockForm(true);
  try {
    const response = await fetch('/api/projects', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-StackForge-Token': state.token }, body: JSON.stringify(options) });
    const data = await response.json();
    if (!response.ok) { if (data.environment) renderEnvironment(data.environment); throw new Error(data.error); }
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
  $('#publish').checked = false;
  updatePreview(); scheduleChecks();
});

$('#check-environment').addEventListener('click', runChecks);
$('#saved-template').addEventListener('change', () => {
  const item = templates.find(item => item.name === $('#saved-template').value);
  $('#delete-template').disabled = !item;
  if (item) { applyTemplate(item.config); $('#template-name').value = item.name; templateMessage(`已应用「${item.name}」，GitHub 发布保持关闭。`); }
});
$('#save-template').addEventListener('click', () => {
  try {
    const item = normalizeTemplate({ name: $('#template-name').value, config: readOptions() });
    if (templates.length >= 20 && !templates.some(old => old.name === item.name)) throw new Error('最多保存 20 个模板，请先删除不用的模板。');
    const replaced = templates.some(old => old.name === item.name);
    persistTemplates([...templates.filter(old => old.name !== item.name), item], item.name);
    templateMessage(`已${replaced ? '更新' : '保存'}「${item.name}」。${replaced ? '同名模板已替换。' : ''}`);
  } catch (error) { templateMessage(error.message, true); }
});
$('#delete-template').addEventListener('click', () => {
  try { const name = $('#saved-template').value; persistTemplates(templates.filter(item => item.name !== name)); templateMessage(`已删除「${name}」。`); }
  catch { templateMessage('浏览器未允许保存模板变更。请检查存储设置。', true); }
});
$('#export-templates').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify({ format: 'stackforge-presets', version: 1, templates }, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob); const link = document.createElement('a');
  link.href = url; link.download = 'stackforge-presets.json'; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000); templateMessage('模板已导出，可用于备份或导入其他浏览器。');
});
$('#import-templates').addEventListener('click', () => $('#template-file').click());
$('#template-file').addEventListener('change', async event => {
  try {
    const file = event.target.files[0]; if (!file) return;
    if (file.size > 65536) throw new Error('模板文件不能超过 64 KB。');
    const incoming = parseTemplateFile(await file.text());
    const added = incoming.filter(item => !templates.some(old => old.name === item.name));
    if (templates.length + added.length > 20) throw new Error('导入后将超过 20 个模板，请先删除不用的模板。');
    persistTemplates([...templates, ...added]);
    templateMessage(`已导入 ${added.length} 个模板，跳过 ${incoming.length - added.length} 个同名模板。`);
  } catch (error) { templateMessage(error.message, true); }
  finally { event.target.value = ''; }
});
$('#retry-publish').addEventListener('click', async () => {
  lockForm(true); $('#progress').hidden = false;
  try {
    const response = await fetch(`/api/jobs/${currentJob}/publish`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-StackForge-Token': state.token }, body: '{}' });
    const data = await response.json(); if (!response.ok) throw new Error(data.error);
    try { sessionStorage.setItem('stackforge.job', JSON.stringify({ id: currentJob, options: currentOptions })); } catch {}
    clearTimeout(pollTimer); pollJob();
  } catch (error) { showError(error.message); }
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
      for (const key of ['install', 'git', 'commit']) if (typeof preferences[key] === 'boolean') $(`#${key}`).checked = preferences[key];
      if (typeof preferences.groupId === 'string') $('#group-id').value = preferences.groupId;
    }
    try { const stored = localStorage.getItem('stackforge.templates'); if (stored) templates = parseTemplateFile(stored); }
    catch { templateMessage('无法读取已保存模板，可导入备份恢复。', true); }
    refreshTemplates();
    createButton.disabled = false;
    syncGit();
    updatePreview();
    scheduleChecks();
    let saved;
    try { saved = JSON.parse(sessionStorage.getItem('stackforge.job') || 'null'); } catch {}
    if (saved?.id && saved.options) {
      // Restore the generating configuration too; disabled fields must match the job.
      for (const key of ['frontend', 'backend', 'database', 'name', 'parentDir', 'groupId']) if (saved.options[key]) form.elements[key].value = saved.options[key];
      for (const key of ['install', 'git', 'commit', 'publish']) $(`#${key}`).checked = Boolean(saved.options[key]);
      for (const [id, key] of [['author-name', 'authorName'], ['author-email', 'authorEmail'], ['repo-name', 'repoName'], ['visibility', 'visibility']]) if (saved.options[key]) $(`#${id}`).value = saved.options[key];
      updatePreview(); currentJob = saved.id; currentOptions = saved.options;
      const check = await fetch(`/api/jobs/${currentJob}`);
      if (check.ok) { lockForm(true); $('#logs-panel').hidden = false; $('#progress').hidden = false; pollJob(); }
      else { try { sessionStorage.removeItem('stackforge.job'); } catch {} }
    }
  } catch (error) { $('#job-state').textContent = '服务未连接'; $('#job-message').textContent = error.message; }
}
init();
