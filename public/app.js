import { setText, setupI18n } from './i18n.js';
setupI18n();
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
let pickingDirectory = false;
let directoryWrites = Promise.resolve();
const statusNames = { running: '执行中', cancelling: '停止中', cancelled: '已取消', failed: '未完成', complete: '已完成' };
const presets = { java: ['vue', 'spring', 'mysql'], node: ['react', 'express', 'postgres'], nest: ['react', 'nestjs', 'postgres'], web: ['vue', 'none', 'none'] };
const choiceIcons = {
  vue: '<path d="M3 5h4l5 8 5-8h4L12 21zM7 5h3l2 3 2-3h3"/>',
  react: '<circle cx="12" cy="12" r="2"/><ellipse cx="12" cy="12" rx="10" ry="4"/><ellipse cx="12" cy="12" rx="10" ry="4" transform="rotate(60 12 12)"/><ellipse cx="12" cy="12" rx="10" ry="4" transform="rotate(120 12 12)"/>',
  spring: '<path d="M20 3c2 10-3 18-10 17C3 19 2 12 7 8c4-3 8-1 13-5ZM5 21l12-12"/>',
  express: '<path d="m8 7-5 5 5 5m8-10 5 5-5 5M14 4l-4 16"/>',
  nestjs: '<path d="M12 3 4 7.5v9L12 21l8-4.5v-9L12 3Zm0 9 8-4.5M12 12 4 7.5M12 12v9"/>',
  mysql: '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 4 16 4 16 0V5M4 12c0 4 16 4 16 0"/>',
  postgres: '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 4 16 4 16 0V5M4 12c0 4 16 4 16 0"/>',
  none: '<path d="M5 5l14 14M19 5 5 19"/>'
};

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
    const title = document.createElement('strong'); setText(title, item.name);
    const detail = document.createElement('small'); setText(detail, item.detail);
    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    icon.setAttribute('viewBox', '0 0 24 24'); icon.setAttribute('aria-hidden', 'true');
    icon.innerHTML = choiceIcons[item.id]; // Authored, fixed SVG; never user input.
    text.append(title, detail); label.append(icon, text, input); container.append(label);
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
  if (options.commit || options.publish) $('#git-details').open = true;
  for (const button of document.querySelectorAll('[data-preset]')) {
    button.setAttribute('aria-pressed', String(['frontend', 'backend', 'database'].every((key, index) => options[key] === presets[button.dataset.preset][index])));
  }
  const separator = options.parentDir.includes('\\') ? '\\' : '/';
  $('#destination-preview').textContent = options.parentDir.replace(/[\\/]+$/, '') + separator + (options.name || 'my-project');
  if (!running) setText(createButton.querySelector('span'), options.publish ? '创建并发布到 GitHub' : '检查并创建项目');
  setText($('#publish-notice'), `将代码推送到当前 GitHub 账号下的新${options.visibility === 'public' ? '公开' : '私有'}仓库${options.visibility === 'public' ? '，源码和提交记录将对所有人可见。' : '。'}`);
  const labels = ['frontend', 'backend', 'database'].filter(key => options[key] !== 'none').map(key => state.catalog[key].find(item => item.id === options[key]).name);
  setText($('#stack-label'), labels.join(' / '));
  $('#tree-name').textContent = options.name || 'my-project';
  const nodes = [];
  if (options.frontend !== 'none') nodes.push(['frontend/', [`src/App.${options.frontend === 'vue' ? 'vue' : 'tsx'}`, `src/main.${options.frontend === 'vue' ? 'ts' : 'tsx'}`, 'vite.config.ts', 'package.json']]);
  if (backend === 'spring') nodes.push(['backend/', ['src/main/java/', 'src/main/resources/', 'pom.xml', 'mvnw · mvnw.cmd']]);
  if (backend === 'express') nodes.push(['backend/', ['src/server.js', 'package.json']]);
  if (backend === 'nestjs') nodes.push(['backend/', ['src/main.ts', 'src/app.module.ts', 'src/health.controller.ts', ...(options.database !== 'none' ? ['src/database.service.ts'] : []), 'nest-cli.json', 'tsconfig.json', 'package.json']]);
  if (options.database !== 'none') nodes.push(['compose.yaml'], ['.env · .env.example']);
  nodes.push(['scripts/dev.mjs'], ['package.json'], ['README.md'], ['stackforge.json']);
  if (options.git) nodes.push(['.git/']);
  $('#file-tree').textContent = nodes.map(([name, children], index) => `${index === nodes.length - 1 ? '└' : '├'}─ ${name}${children ? '\n' + children.map((child, ci) => `${index === nodes.length - 1 ? ' ' : '│'}  ${ci === children.length - 1 ? '└' : '├'}─ ${child}`).join('\n') : ''}`).join('\n');
  $('#start-command').textContent = options.install ? 'npm run dev' : 'npm install\nnpm run dev';
  setText($('#launch-description'), options.database !== 'none' ? '自动启动数据库，并运行前后端服务。数据库数据保存在 Docker 数据卷中。' : backend === 'none' ? '启动 Vite 开发服务器，直接开始编写页面。' : options.frontend === 'none' ? '启动后端服务，健康检查接口开箱即用。' : '同时启动前后端，/api 请求自动代理到本机后端。');
  setText($('#database-hint'), options.database === 'none' ? '不生成数据库服务，后续可按需要添加。' : '生成 Compose 配置与连接驱动，开发启动时自动启动数据库。');
  const requirements = ['Node.js 22.12+'];
  if (backend === 'spring') requirements.push('Java 21+ · 自动提供 Maven Wrapper');
  if (options.database !== 'none') requirements.push('Docker Desktop / Docker Compose v2');
  if (options.git) requirements.push('Git');
  $('#requirements').replaceChildren(...requirements.map(text => { const li = document.createElement('li'); setText(li, text); return li; }));
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
  setText($('#environment-summary'), errors.length ? `${errors.length} 项问题需处理后再创建` : warnings.length ? `可以创建 · ${warnings.length} 项启动提示` : '环境就绪，可以创建');
  const row = item => {
    const li = document.createElement('li'); li.dataset.status = item.status;
    const title = document.createElement('strong'); setText(title, item.label);
    const detail = document.createElement('p'); setText(detail, item.detail);
    li.append(title, detail);
    if (item.status !== 'ok' && item.fix) { const fix = document.createElement('p'); setText(fix, item.fix); li.append(fix); }
    if (item.url) { const link = document.createElement('a'); link.href = item.url; setText(link, '打开官方安装说明'); link.target = '_blank'; link.rel = 'noreferrer'; li.append(link); }
    return li;
  };
  $('#critical-checks').replaceChildren(...[...errors, ...warnings].map(row));
  $('#passed-checks').replaceChildren(...passed.map(row));
  setText($('#all-checks summary'), `${passed.length} 项检测已通过`);
}

async function runChecks() {
  if (!state || running) return;
  const serial = ++checkSerial;
  $('#check-environment').disabled = true;
  setText($('#environment-summary'), '正在检测当前配置所需的环境…');
  try {
    const response = await fetch('/api/checks', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-StackForge-Token': state.token }, body: JSON.stringify(readOptions()), signal: AbortSignal.timeout(40000) });
    const report = await response.json();
    if (serial !== checkSerial) return;
    if (!response.ok) throw new Error(report.error);
    renderEnvironment(report);
  } catch (error) {
    if (serial !== checkSerial) return;
    $('.environment').dataset.status = 'error';
    setText($('#environment-summary'), error.message || '检测未完成，请检查本地服务后重试。');
  } finally { if (serial === checkSerial) $('#check-environment').disabled = running; }
}

function scheduleChecks() {
  clearTimeout(checkTimer);
  ++checkSerial; // ignore a response for an older configuration immediately
  $('.environment').dataset.status = 'checking';
  setText($('#environment-summary'), '正在检测当前配置所需的环境…');
  $('#critical-checks').replaceChildren();
  $('#passed-checks').replaceChildren();
  setText($('#all-checks summary'), '正在检测…');
  checkTimer = setTimeout(runChecks, 650);
}

function templateMessage(message, error = false) {
  setText($('#template-message'), message);
  $('#template-message').dataset.status = error ? 'error' : 'ok';
}

function refreshTemplates(selected = '') {
  const select = $('#saved-template');
  const placeholder = document.createElement('option'); placeholder.value = ''; setText(placeholder, templates.length ? '选择一个模板' : '还没有保存的模板');
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
  resetActivity();
  for (const key of ['frontend', 'backend', 'database']) form.elements[key].value = config[key];
  $('#group-id').value = config.groupId;
  for (const key of ['install', 'git', 'commit']) $(`#${key}`).checked = config[key];
  $('#publish').checked = false;
  syncGit(); updatePreview(); scheduleChecks();
}

function lockForm(value) {
  running = value;
  document.body.classList.toggle('is-running', value);
  clearTimeout(checkTimer);
  ++checkSerial;
  for (const input of form.querySelectorAll('input, select, button')) input.disabled = value;
  for (const button of document.querySelectorAll('[data-preset], #check-environment, #retry-publish, #resume-job, #job-history')) button.disabled = value;
  createButton.disabled = value || pickingDirectory;
  $('#browse-directory').disabled = value || pickingDirectory || !state.desktop?.picker;
  setText(createButton.querySelector('span'), value ? '正在创建…' : '创建项目');
  if (!value) { updatePreview(); refreshTemplates($('#saved-template').value); }
}

function restoreOptions(options) {
  clearTimeout(checkTimer);
  ++checkSerial;
  $('.environment').dataset.status = 'idle';
  setText($('#environment-summary'), '已恢复任务配置；新建项目时会重新检查环境。');
  $('#critical-checks').replaceChildren();
  $('#passed-checks').replaceChildren();
  setText($('#all-checks summary'), '尚未重新检测');
  $('#check-environment').disabled = running;
  for (const key of ['frontend', 'backend', 'database', 'name', 'parentDir', 'groupId']) if (options[key]) form.elements[key].value = options[key];
  for (const key of ['install', 'git', 'commit', 'publish']) $(`#${key}`).checked = Boolean(options[key]);
  for (const [id, key] of [['author-name', 'authorName'], ['author-email', 'authorEmail'], ['repo-name', 'repoName'], ['visibility', 'visibility']]) $(`#${id}`).value = options[key] || (key === 'visibility' ? 'private' : '');
  updatePreview();
}

function renderHistory(jobs) {
  $('#history-field').hidden = !jobs.length;
  const empty = document.createElement('option'); empty.value = ''; setText(empty, '选择已保存的任务');
  $('#job-history').replaceChildren(empty, ...jobs.map(job => {
    const option = document.createElement('option'); option.value = job.id;
    setText(option, `${job.name} · ${statusNames[job.status] || job.status}`);
    return option;
  }));
  if (jobs.some(job => job.id === currentJob)) $('#job-history').value = currentJob;
}

async function refreshHistory() {
  try { const response = await fetch('/api/jobs'); if (response.ok) renderHistory(await response.json()); } catch {}
}

function showError(message) {
  activity.dataset.status = 'failed';
  setText($('#job-state'), '创建失败');
  setText($('#job-message'), message);
  $('#progress').hidden = true;
  lockForm(false);
}

function resetActivity() {
  if (running) return;
  clearTimeout(pollTimer);
  currentJob = undefined; currentOptions = undefined;
  activity.dataset.status = 'idle';
  document.body.classList.remove('has-task');
  setText($('#job-state'), '准备就绪');
  setText($('#job-message'), '项目会在新文件夹中创建。');
  for (const id of ['result', 'recovery', 'resume-job', 'cancel-job', 'logs-panel', 'progress']) $(`#${id}`).hidden = true;
  $('#job-history').value = '';
  setText($('#open-message'), '');
}

function revealTask() {
  document.body.classList.add('has-task');
  if (window.matchMedia('(max-width: 800px)').matches) activity.scrollIntoView({ block: 'start', behavior: 'instant' });
}

async function pollJob() {
  const polledJob = currentJob;
  try {
    const response = await fetch(`/api/jobs/${polledJob}`);
    const job = await response.json();
    if (currentJob !== polledJob) return;
    if (!response.ok) {
      if (response.status === 404) {
        try { sessionStorage.removeItem('stackforge.job'); } catch {}
        showError('创建任务已失效。服务可能已重启，请先检查目标目录，再重新创建。');
        return;
      }
      throw new Error(job.error);
    }
    activity.dataset.status = job.status;
    document.body.classList.add('has-task');
    setText($('#job-state'), job.status === 'running' ? `${job.progress}%` : job.status === 'complete' ? '创建成功' : statusNames[job.status] || '创建失败');
    setText($('#job-message'), job.status === 'failed' ? job.error : job.step);
    $('#progress').value = job.progress;
    setText($('#logs'), job.logs.join('\n'));
    const active = ['running', 'cancelling'].includes(job.status);
    $('#cancel-job').hidden = !active;
    $('#cancel-job').disabled = job.status === 'cancelling';
    setText($('#cancel-job'), job.status === 'cancelling' ? '正在停止…' : '取消任务');
    $('#resume-job').hidden = !job.canResume;
    $('#recovery').hidden = !job.canResume;
    if (job.canResume) {
      setText($('#checkpoint-summary'), job.retainedPath ? `已保留 ${job.completed.length} 个完成步骤与项目文件。` : '环境检查尚未通过，可以修复环境后重试。');
      setText($('#retained-path'), job.retainedPath || '');
    }
    if (job.environment) renderEnvironment(job.environment);
    if (active) { if (!running) lockForm(true); pollTimer = setTimeout(pollJob, 900); return; }
    $('#progress').hidden = true;
    lockForm(false);
    try { sessionStorage.removeItem('stackforge.job'); } catch {}
    $('#result').hidden = !job.result;
    if (job.result) {
      $('#result').hidden = false;
      $('#result-path').textContent = job.result.path;
      $('#result-commands').textContent = job.result.commands.join('\n');
      $('#open-actions').hidden = job.status !== 'complete';
      for (const button of document.querySelectorAll('[data-open]')) button.disabled = job.status !== 'complete' || !state.desktop?.[button.dataset.open];
      setText($('#open-help'), ['folder', 'vscode', 'terminal'].every(action => state.desktop?.[action]) ? '' : 'Some desktop apps were not found. You can copy the project path instead.');
      if (job.status === 'complete') setText($('#job-message'), '文件已生成。进入项目目录，即可开始开发。');
      const remote = job.result.remote;
      $('#remote-link').hidden = remote?.status !== 'published';
      $('#retry-publish').hidden = remote?.status !== 'failed';
      setText($('#remote-result'), remote?.status === 'published' ? `已发布到 GitHub · ${remote.visibility === 'public' ? '公开仓库' : '私有仓库'}` : remote?.status === 'failed' ? `本地项目已保留。GitHub 发布未完成：${remote.error}` : '');
      if (remote?.status === 'published') $('#remote-link').href = remote.url;
      if (remote?.status === 'failed') { setText($('#job-state'), '本地已创建'); $('#logs-panel').open = true; }
    }
    if (job.status !== 'complete') $('#logs-panel').open = true;
    refreshHistory();
  } catch (error) {
    if (currentJob !== polledJob) return;
    setText($('#job-state'), '连接已断开');
    setText($('#job-message'), '无法读取创建状态，请检查本地服务。连接恢复后将继续显示进度。');
    pollTimer = setTimeout(pollJob, 3000);
  }
}

form.addEventListener('input', event => {
  if (running || ['template-name', 'template-file', 'remember-directory'].includes(event.target.id)) return;
  resetActivity();
  if (event.target.id === 'repo-name') repoNameEdited = true;
  if (event.target.id === 'project-name' && !repoNameEdited) $('#repo-name').value = event.target.value;
  syncGit(event.target.id); updatePreview(); scheduleChecks();
});
form.addEventListener('change', event => {
  if (event.target.id === 'remember-directory') { saveDirectory(); return; }
  if (running || ['saved-template', 'template-file'].includes(event.target.id)) return;
  resetActivity();
  syncGit(event.target.id); updatePreview(); scheduleChecks();
  if (event.target.id === 'parent-dir' && $('#remember-directory').checked) saveDirectory();
});
form.addEventListener('submit', async event => {
  event.preventDefault();
  if (running || pickingDirectory || !state || !form.reportValidity()) return;
  const options = readOptions();
  currentOptions = options;
  if (options.frontend === 'none' && options.backend === 'none') { showError('至少选择一个前端或后端。'); return; }
  $('#result').hidden = true;
  setText($('#open-message'), '');
  $('#recovery').hidden = true;
  $('#resume-job').hidden = true;
  setText($('#logs'), '');
  $('#logs-panel').hidden = false;
  $('#logs-panel').open = false;
  $('#progress').hidden = false;
  $('#progress').value = 0;
  activity.dataset.status = 'running';
  setText($('#job-state'), '准备中');
  setText($('#job-message'), '正在执行创建前检查…');
  lockForm(true);
  try {
    const response = await fetch('/api/projects', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-StackForge-Token': state.token }, body: JSON.stringify(options) });
    const data = await response.json();
    if (!response.ok) { if (data.environment) renderEnvironment(data.environment); throw new Error(data.error); }
    if ($('#remember-directory').checked && state.preferences.directory !== options.parentDir) saveDirectory();
    currentJob = data.id;
    revealTask();
    $('#cancel-job').hidden = false; $('#cancel-job').disabled = false;
    try { sessionStorage.setItem('stackforge.job', JSON.stringify({ id: currentJob, options })); } catch {}
    clearTimeout(pollTimer);
    pollJob();
  } catch (error) { showError(error.message); }
});

document.addEventListener('click', event => {
  const preset = event.target.closest('[data-preset]');
  if (!preset || running || !state) return;
  resetActivity();
  const values = presets[preset.dataset.preset];
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
$('#cancel-job').addEventListener('click', async () => {
  $('#cancel-job').disabled = true;
  try {
    const response = await fetch(`/api/jobs/${currentJob}/cancel`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-StackForge-Token': state.token }, body: '{}' });
    const data = await response.json(); if (!response.ok) throw new Error(data.error);
    clearTimeout(pollTimer); pollJob();
  } catch (error) { setText($('#job-message'), error.message); $('#cancel-job').disabled = false; }
});
$('#resume-job').addEventListener('click', async () => {
  restoreOptions(currentOptions); lockForm(true);
  $('#resume-job').hidden = true; $('#progress').hidden = false;
  try {
    const response = await fetch(`/api/jobs/${currentJob}/retry`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-StackForge-Token': state.token }, body: '{}' });
    const data = await response.json(); if (!response.ok) throw new Error(data.error);
    try { sessionStorage.setItem('stackforge.job', JSON.stringify({ id: currentJob, options: currentOptions })); } catch {}
    clearTimeout(pollTimer); pollJob();
  } catch (error) { showError(error.message); $('#resume-job').hidden = false; }
});
$('#job-history').addEventListener('change', async () => {
  if (running || !$('#job-history').value) return;
  const response = await fetch('/api/jobs/' + $('#job-history').value);
  if (!response.ok) return;
  const job = await response.json(); currentJob = job.id; currentOptions = job.options;
  setText($('#open-message'), '');
  restoreOptions(job.options); clearTimeout(pollTimer);
  $('#logs-panel').hidden = false; revealTask(); pollJob();
});
$('#copy-path').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText($('#result-path').textContent); setText($('#copy-path'), '已复制'); setTimeout(() => { setText($('#copy-path'), '复制路径'); }, 1600); }
  catch { setText($('#copy-path'), '请手动选择上方路径复制'); }
});

function selectPreviewTab(id) {
  for (const tab of document.querySelectorAll('[role=tab]')) {
    const selected = tab.id === id;
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
    document.getElementById(tab.getAttribute('aria-controls')).hidden = !selected;
  }
}
for (const tab of document.querySelectorAll('[role=tab]')) {
  tab.addEventListener('click', () => selectPreviewTab(tab.id));
  tab.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const id = event.key === 'Home' ? 'files-tab' : event.key === 'End' ? 'start-tab' : tab.id === 'files-tab' ? 'start-tab' : 'files-tab';
    selectPreviewTab(id); document.getElementById(id).focus();
  });
}
$('#copy-command').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText($('#start-command').textContent);
    setText($('#copy-command'), '已复制');
    setTimeout(() => setText($('#copy-command'), '复制命令'), 1600);
  } catch { setText($('#copy-command'), '请选择并复制下方命令'); }
});
form.addEventListener('invalid', event => {
  const details = event.target.closest('details'); if (details) details.open = true;
}, true);
document.addEventListener('keydown', event => {
  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !running && !createButton.disabled) {
    event.preventDefault(); form.requestSubmit(createButton);
  }
});

function renderRecentDirectories(preferences) {
  state.preferences = preferences;
  $('#recent-directories').replaceChildren(...preferences.recentDirectories.map(path => {
    const option = document.createElement('option'); option.value = path; return option;
  }));
}
function directoryMessage(message, error = false) {
  setText($('#directory-message'), message); $('#directory-message').dataset.status = error ? 'error' : 'ok';
}
function saveDirectory() {
  const preferences = { rememberDirectory: $('#remember-directory').checked, directory: $('#parent-dir').value.trim() };
  const writing = directoryWrites.catch(() => {}).then(async () => {
    try {
      const response = await fetch('/api/preferences', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-StackForge-Token': state.token }, body: JSON.stringify(preferences) });
      const data = await response.json(); if (!response.ok) throw new Error(data.error);
      renderRecentDirectories(data);
      directoryMessage(data.rememberDirectory ? 'Location saved on this computer.' : 'Location history cleared. This choice will not be remembered.');
    } catch (error) { directoryMessage('Unable to save this location: ' + error.message, true); }
  });
  directoryWrites = writing;
  return writing;
}
$('#default-directory').addEventListener('click', async () => {
  if (!state || running || pickingDirectory) return;
  $('#parent-dir').value = state.defaultDir;
  resetActivity(); updatePreview(); scheduleChecks();
  if ($('#remember-directory').checked) await saveDirectory();
  else directoryMessage('Default location restored.');
});
$('#browse-directory').addEventListener('click', async () => {
  if (!state?.desktop?.picker || running || pickingDirectory) return;
  pickingDirectory = true;
  for (const id of ['browse-directory', 'remember-directory', 'default-directory', 'create', 'job-history', 'retry-publish', 'resume-job']) $('#' + id).disabled = true;
  $('#parent-dir').readOnly = true;
  setText($('#browse-directory'), 'Choosing…'); directoryMessage('Choose a folder in the system dialog.');
  try {
    const response = await fetch('/api/desktop/pick-directory', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-StackForge-Token': state.token }, body: JSON.stringify({ initialDir: $('#parent-dir').value.trim(), language: document.documentElement.lang }) });
    const data = await response.json(); if (!response.ok) throw new Error(data.error);
    if (data.path) {
      $('#parent-dir').value = data.path;
      resetActivity(); updatePreview(); scheduleChecks();
      if ($('#remember-directory').checked) await saveDirectory();
      else directoryMessage('Folder selected.');
    } else directoryMessage('Folder selection cancelled.');
  } catch (error) { directoryMessage(error.message, true); }
  finally {
    pickingDirectory = false; $('#parent-dir').readOnly = false;
    for (const id of ['remember-directory', 'default-directory', 'create', 'job-history', 'retry-publish', 'resume-job']) $('#' + id).disabled = running;
    $('#browse-directory').disabled = running || !state.desktop?.picker;
    setText($('#browse-directory'), 'Browse…');
  }
});
for (const button of document.querySelectorAll('[data-open]')) button.addEventListener('click', async () => {
  const id = currentJob, action = button.dataset.open;
  if (!id || running) return;
  button.disabled = true; $('#open-message').dataset.status = 'ok';
  setText($('#open-message'), { folder: 'Opening folder…', vscode: 'Opening VS Code…', terminal: 'Opening terminal…' }[action]);
  try {
    const response = await fetch('/api/jobs/' + id + '/open', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-StackForge-Token': state.token }, body: JSON.stringify({ action }) });
    const data = await response.json(); if (!response.ok) throw new Error(data.error);
    if (currentJob === id) setText($('#open-message'), 'Open request sent. Check the desktop window.');
  } catch (error) { if (currentJob === id) { setText($('#open-message'), error.message); $('#open-message').dataset.status = 'error'; } }
  finally { if (currentJob === id) button.disabled = !state.desktop?.[action]; }
});

async function init() {
  try {
    const response = await fetch('/api/state');
    if (!response.ok) throw new Error('无法连接本地服务，请刷新页面。');
    state = await response.json();
    renderHistory(state.jobs || []);
    ['frontend', 'backend', 'database'].forEach(choices);
    const preferencesDirectory = state.preferences || { rememberDirectory: true, recentDirectories: [] };
    $('#remember-directory').checked = preferencesDirectory.rememberDirectory;
    $('#parent-dir').value = preferencesDirectory.rememberDirectory && preferencesDirectory.directory || state.defaultDir;
    renderRecentDirectories(preferencesDirectory);
    $('#parent-dir').readOnly = false;
    $('#remember-directory').disabled = false;
    $('#default-directory').disabled = false;
    $('#browse-directory').disabled = !state.desktop?.picker;
    if (!state.desktop?.picker) directoryMessage('No system folder picker is available. Enter an absolute path manually.');
    setText($('#node-version'), `Node.js ${state.node} · 已连接`);
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
      restoreOptions(saved.options); currentJob = saved.id; currentOptions = saved.options;
      const check = await fetch(`/api/jobs/${currentJob}`);
      if (check.ok) { lockForm(true); $('#logs-panel').hidden = false; $('#progress').hidden = false; pollJob(); }
      else { try { sessionStorage.removeItem('stackforge.job'); } catch {} }
    }
  } catch (error) { setText($('#job-state'), '服务未连接'); setText($('#job-message'), error.message); }
}
init();
