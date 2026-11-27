import { setText, setupI18n } from '/i18n.js';

setupI18n();
const $ = id => document.getElementById(id);
const statuses = { available: 'Available', missing: 'Tool not found', outdated: 'Below minimum version',
  unavailable: 'Tool could not run', unverified: 'Version unverified' };
const groups = { workspace: 'Workspace tools', toolchains: 'Project toolchains', databases: 'Database clients' };
const platforms = { win32: 'Windows', linux: 'Linux', darwin: 'macOS' };
let report, checking;

function toolRow(tool) {
  const item = document.createElement('tr');
  item.dataset.tool = tool.id;
  const title = document.createElement('th');
  title.scope = 'row';
  title.textContent = tool.name;
  if (tool.minimum) {
    const minimum = document.createElement('span');
    minimum.className = 'tool-minimum';
    setText(minimum, `Minimum ${tool.minimum}`);
    title.append(minimum);
  }
  const status = document.createElement('td');
  status.dataset.state = tool.status;
  setText(status, statuses[tool.status]);
  const version = document.createElement('td');
  version.className = 'tool-version';
  version.textContent = tool.version ?? '—';
  const location = document.createElement('td');
  if (!tool.path) {
    location.dataset.empty = '';
    location.textContent = '—';
  } else {
    const content = document.createElement('div');
    content.className = 'tool-path-cell';
    const path = document.createElement('code');
    path.id = 'tool-path-' + tool.id;
    path.textContent = tool.path;
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'tool-copy';
    copy.setAttribute('aria-describedby', path.id);
    setText(copy, 'Copy path');
    copy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(tool.path);
        setText(copy, 'Copied');
        setText($('environment-message'), `${tool.name} path copied.`);
        setTimeout(() => setText(copy, 'Copy path'), 1500);
      } catch {
        const selection = window.getSelection();
        if (selection) {
          const range = document.createRange();
          range.selectNodeContents(path);
          selection.removeAllRanges();
          selection.addRange(range);
        }
        setText($('environment-message'), 'Select and copy the path manually.');
      }
    });
    content.append(path, copy);
    location.append(content);
  }
  item.append(title, status, version, location);
  return item;
}

function toolGroup(id, name, tools) {
  const section = document.createElement('section');
  section.className = 'environment-group';
  const heading = document.createElement('h2');
  heading.id = 'environment-' + id;
  setText(heading, name);
  section.setAttribute('aria-labelledby', heading.id);
  const table = document.createElement('table');
  table.className = 'environment-tool-table';
  table.setAttribute('aria-labelledby', heading.id);
  const header = table.createTHead().insertRow();
  for (const label of ['Tool', 'Tool status', 'Version', 'Resolved path']) {
    const cell = document.createElement('th');
    cell.scope = 'col';
    setText(cell, label);
    header.append(cell);
  }
  table.createTBody().append(...tools.map(toolRow));
  section.append(heading, table);
  return section;
}

function render() {
  if (!report) return;
  $('environment-host').textContent = (platforms[report.platform] ?? report.platform) + ' · ' + report.architecture;
  const date = $('environment-checked');
  date.dateTime = report.checkedAt;
  date.textContent = new Intl.DateTimeFormat(document.documentElement.lang, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(date.dateTime));
  const query = $('environment-search').value.trim().toLocaleLowerCase();
  const filter = $('environment-filter').value;
  const tools = report.tools.filter(tool => `${tool.name} ${tool.id} ${tool.path ?? ''}`.toLocaleLowerCase().includes(query) &&
    (filter === 'all' || (tool.status === 'available') === (filter === 'available')));
  $('environment-empty').hidden = tools.length > 0;
  $('environment-groups').replaceChildren(...Object.entries(groups).flatMap(([id, name]) => {
    const items = tools.filter(tool => tool.group === id);
    return items.length ? [toolGroup(id, name, items)] : [];
  }));
  $('environment-results').hidden = false;
}

async function refresh() {
  if (checking) return;
  checking = true;
  $('environment-refresh').disabled = true;
  setText($('environment-message'), 'Checking local tools…');
  try {
    const response = await fetch('/api/environment', { signal: AbortSignal.timeout(60000) });
    if (!response.ok) throw new Error();
    report = await response.json();
    render();
    setText($('environment-message'), '');
  } catch {
    setText($('environment-message'), report ? 'Could not refresh tools. Showing the last available results.' : 'Could not read the local environment. Try checking again.');
  } finally {
    checking = false;
    $('environment-refresh').disabled = false;
  }
}

$('environment-refresh').addEventListener('click', refresh);
$('environment-search').addEventListener('input', render);
$('environment-filter').addEventListener('change', render);
$('language').addEventListener('change', render);
void refresh();
