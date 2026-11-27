import { setText, setupI18n } from '/i18n.js';
import { normalizeTaskNotice, readTaskNoticeMode, taskNoticeKey } from '/task-notices.js';

setupI18n();
const $ = id => document.getElementById(id);
const themeKey = 'stackforge.theme';
const themes = ['light', 'dark', 'system'];
let state, working = false;

function readTheme() {
  try {
    const theme = localStorage.getItem(themeKey);
    if (themes.includes(theme)) return theme;
  } catch {}
  return 'light';
}

function feedback(id, message, error = false) {
  const output = $(id);
  setText(output, message);
  output.dataset.error = String(error);
}

function saveBrowserPreference({ key, value, select, eventName, feedbackId, read }) {
  try {
    localStorage.setItem(key, value);
    window.dispatchEvent(new Event(eventName));
    feedback(feedbackId, 'Preference saved in this browser.');
  } catch {
    select.value = read();
    feedback(feedbackId, 'This browser could not save the preference.', true);
  }
}

const theme = $('theme');
theme.value = readTheme();
theme.addEventListener('change', () => saveBrowserPreference({
  key: themeKey, value: themes.includes(theme.value) ? theme.value : 'light', select: theme, eventName: 'stackforge:theme',
  feedbackId: 'appearance-feedback', read: readTheme
}));
const mode = $('task-notice-mode');
mode.value = readTaskNoticeMode();
mode.addEventListener('change', () => saveBrowserPreference({
  key: taskNoticeKey, value: normalizeTaskNotice(mode.value), select: mode, eventName: 'stackforge:task-notices',
  feedbackId: 'notices-feedback', read: readTaskNoticeMode
}));
window.addEventListener('storage', event => {
  if (event.key === themeKey || event.key === null) theme.value = readTheme();
  if (event.key === taskNoticeKey || event.key === null) mode.value = readTaskNoticeMode();
});
$('language').addEventListener('change', () => {
  let saved = false;
  try { saved = localStorage.getItem('stackforge.language') === $('language').value; } catch {}
  feedback('appearance-feedback', saved ? 'Preference saved in this browser.' : 'This browser could not save the preference.', !saved);
});

const directory = $('settings-directory');
const remember = $('settings-remember-directory');
const browse = $('settings-browse');
const directoryForm = $('settings-location-form');
const locationFeedback = (message, error) => feedback('settings-location-feedback', message, error);

async function request(url, { payload, timeout = 10000 } = {}) {
  const options = { signal: AbortSignal.timeout(timeout) };
  if (payload) {
    options.method = 'POST';
    options.headers = { 'Content-Type': 'application/json', 'X-StackForge-Token': state.token };
    options.body = JSON.stringify(payload);
  }
  const response = await fetch(url, options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Could not update the save location. Try again.');
  return data;
}

function updateLocationControls() {
  $('settings-location-fields').disabled = working || !state;
  directory.disabled = !remember.checked;
  browse.disabled = !remember.checked || !state?.desktop?.picker;
  $('settings-use-default').disabled = !remember.checked;
}

function renderLocation() {
  $('settings-default-directory').textContent = state.defaultDir;
  remember.checked = state.preferences.rememberDirectory;
  directory.value = state.preferences.directory || state.defaultDir;
  updateLocationControls();
}

async function loadLocation() {
  $('settings-location-retry').hidden = true;
  locationFeedback('Loading save location…');
  try {
    state = await request('/api/state');
    renderLocation();
    locationFeedback('');
  } catch {
    locationFeedback('Could not load save location settings. Try again.', true);
    $('settings-location-retry').hidden = false;
  }
}

remember.addEventListener('change', updateLocationControls);
$('settings-use-default').addEventListener('click', () => { directory.value = state.defaultDir; });
$('settings-location-retry').addEventListener('click', loadLocation);
browse.addEventListener('click', async () => {
  if (working || browse.disabled) return;
  working = true;
  updateLocationControls();
  locationFeedback('Choose a folder in the system dialog.');
  try {
    const payload = { initialDir: directory.value.trim() || state.defaultDir, language: document.documentElement.lang };
    const { path } = await request('/api/desktop/pick-directory', { payload, timeout: 610000 });
    if (path) directory.value = path;
    locationFeedback(path ? 'Folder selected. Save to use it for new projects.' : 'Folder selection cancelled.');
  } catch (error) {
    locationFeedback(error.message, true);
  } finally {
    working = false;
    updateLocationControls();
  }
});

directoryForm.addEventListener('submit', async event => {
  event.preventDefault();
  if (!state || working) return;
  working = true;
  updateLocationControls();
  locationFeedback('Saving location settings…');
  try {
    const payload = { rememberDirectory: remember.checked, directory: directory.value.trim() };
    state.preferences = await request('/api/preferences', { payload });
    renderLocation();
    locationFeedback(state.preferences.rememberDirectory ? 'Location saved on this computer.' : 'Location history cleared. This choice will not be remembered.');
  } catch (error) {
    locationFeedback(error.message, true);
  } finally {
    working = false;
    updateLocationControls();
  }
});

void loadLocation();
