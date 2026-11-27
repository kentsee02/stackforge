import { setText, setupI18n } from '/i18n.js';

setupI18n();
const $ = id => document.getElementById(id);
const toolLabels = { available: 'Available', missing: 'Tool not found', outdated: 'Below minimum version',
  unavailable: 'Tool could not run', unverified: 'Version unverified' };
const engines = {
  ready: ['Local Docker Engine ready', 'Project databases use Docker Engine 28 or later in Linux container mode.'],
  'tool-missing': ['Docker CLI not found', 'Install Docker Desktop or Docker Engine, then check again.'],
  'context-unverified': ['Docker context unverified', 'Check the Docker context settings, select a local connection, and try again.'],
  'non-local': ['Docker context is outside the supported local connections', 'Check the Docker context settings, select a local connection, and try again.'],
  unreachable: ['Local Docker Engine unreachable', 'Start Docker Desktop or the local Docker Engine and try again.'],
  unverified: ['Local Docker Engine version or mode unverified', 'Check the Docker Engine status and try again.'],
  'windows-mode': ['Windows containers', 'For project databases, switch to Linux containers.'],
  outdated: ['Below minimum version', 'For project databases, update Docker Engine to version 28 or later.']
};
let report, checking, verifying;

async function json(url, options = {}) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error();
  return response.json();
}

function status(id, label, tone = '') {
  const output = $(id);
  setText(output, label);
  output.dataset.tone = tone;
}

function paintTool(id, tool) {
  status(id, [toolLabels[tool.status], tool.version], tool.status === 'available' ? 'positive' : 'warning');
}

function paintTime() {
  if (!report) return;
  const time = $('integrations-checked');
  time.dateTime = report.checkedAt;
  time.textContent = new Intl.DateTimeFormat(document.documentElement.lang, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(time.dateTime));
}

function updateGithubButton() {
  $('github-verify').disabled = !!verifying || !['available', 'outdated', 'unverified'].includes(report?.github.tool.status);
}

function paint() {
  paintTime();
  paintTool('git-tool', report.git.tool);
  status('git-identity', { configured: 'Commit name and email found', unconfirmed: 'Default identity unconfirmed', unverified: 'Not yet verified' }[report.git.identity],
    report.git.identity === 'configured' ? 'positive' : 'warning');
  paintTool('github-tool', report.github.tool);
  paintTool('docker-cli', report.docker.cli);
  paintTool('docker-compose', report.docker.compose);
  const engine = report.docker.engine;
  const [label, guidance] = engines[engine.status];
  status('docker-engine', [label, engine.version, engine.mode === 'linux' && 'Linux containers'], engine.status === 'ready' ? 'positive' : 'warning');
  setText($('docker-guidance'), guidance);
  for (const action of ['picker', 'folder', 'terminal', 'vscode']) {
    const available = report.desktop?.[action];
    status('desktop-' + action, available ? 'Application found' : available === false ? 'Application not found' : 'Not yet verified',
      available ? 'positive' : '');
  }
  updateGithubButton();
  $('integration-results').hidden = false;
}

async function refresh() {
  if (checking) return;
  checking = true;
  $('integrations-refresh').disabled = true;
  setText($('integrations-message'), 'Checking local integrations…');
  try {
    report = await json('/api/integrations');
    paint();
    setText($('integrations-message'), '');
  } catch {
    setText($('integrations-message'), report ? 'Could not refresh integrations. Showing the last available results.' : 'Could not read integration status. Try checking again.');
  } finally {
    checking = false;
    $('integrations-refresh').disabled = false;
  }
}

async function verifyGithub() {
  if ($('github-verify').disabled) return;
  verifying = true;
  updateGithubButton();
  $('github-sign-in').hidden = true;
  status('github-account', 'Verifying GitHub account…');
  try {
    const { token } = await json('/api/state');
    const result = await json('/api/integrations/github', { method: 'POST', body: '{}',
      headers: { 'Content-Type': 'application/json', 'x-stackforge-token': token } });
    if (result.status === 'verified') status('github-account', `GitHub account verified · ${result.account}`, 'positive');
    else if (result.status === 'sign-in-required') {
      status('github-account', 'GitHub sign-in required', 'warning');
      $('github-sign-in').hidden = false;
    } else throw new Error();
  } catch {
    status('github-account', 'Could not verify the GitHub account. Check the network and CLI sign-in.', 'warning');
  } finally {
    verifying = false;
    updateGithubButton();
  }
}

$('integrations-refresh').addEventListener('click', refresh);
$('github-verify').addEventListener('click', verifyGithub);
$('language').addEventListener('change', paintTime);
void refresh();
