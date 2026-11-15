import { messages } from './messages.js';

export const normalizeLocale = value => value === 'zh-CN' ? 'zh-CN' : 'en';
let locale = 'en';
const bindings = new Map();
let cleanupPending = false;
const exact = new Map();
const patterns = [];
const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

for (const [zh, en] of messages) {
  for (const source of [zh, en]) {
    exact.set(source, { en, 'zh-CN': zh });
    if (!source.includes('{')) continue;
    const names = [];
    const pieces = source.split(/(\{\w+\})/g).map(piece => {
      if (!/^\{\w+\}$/.test(piece)) return escape(piece);
      names.push(piece.slice(1, -1)); return '(.+?)';
    });
    patterns.push({ regex: new RegExp('^' + pieces.join('') + '$', 's'), names, en, 'zh-CN': zh, specificity: source.replace(/\{\w+\}/g, '').length });
  }
}
patterns.sort((a, b) => b.specificity - a.specificity);

// Recognize both languages so task records from earlier versions remain readable.
// Unknown strings (including external CLI output) pass through unchanged.
export function translate(value, language = locale, depth = 0) {
  if (typeof value !== 'string' || !value) return value ?? '';
  language = normalizeLocale(language);
  if (exact.has(value) && !value.includes('{')) return exact.get(value)[language];
  if (depth < 5) for (const pattern of patterns) {
    const match = value.match(pattern.regex);
    if (!match) continue;
    const args = Object.fromEntries(pattern.names.map((name, index) => [name, ['message', 'error'].includes(name) ? translate(match[index + 1], language, depth + 1) : match[index + 1]]));
    return pattern[language].replace(/\{(\w+)\}/g, (_, name) => args[name]);
  }
  if (value.includes('\n')) return value.split('\n').map(line => translate(line, language, depth + 1)).join('\n');
  return value;
}

export function setText(element, source) {
  bindings.set(element, source);
  element.textContent = translate(source);
  if (bindings.size > 500 && !cleanupPending) {
    cleanupPending = true;
    queueMicrotask(() => {
      for (const element of bindings.keys()) if (!element.isConnected) bindings.delete(element);
      cleanupPending = false;
    });
  }
}

export function setupI18n() {
  try { locale = normalizeLocale(localStorage.getItem('stackforge.language')); } catch { locale = 'en'; }
  const select = document.querySelector('#language');
  function render() {
    document.documentElement.lang = locale;
    select.value = locale;
    for (const element of document.querySelectorAll('[data-i18n]')) element.textContent = translate(element.dataset.i18n);
    for (const attribute of ['placeholder', 'aria-label', 'content']) {
      for (const element of document.querySelectorAll(`[data-i18n-${attribute}]`)) element.setAttribute(attribute, translate(element.getAttribute(`data-i18n-${attribute}`)));
    }
    for (const [element, source] of bindings) {
      if (element.isConnected) element.textContent = translate(source);
      else bindings.delete(element);
    }
  }
  select.addEventListener('change', () => {
    locale = normalizeLocale(select.value);
    try { localStorage.setItem('stackforge.language', locale); } catch { /* switching still works without storage */ }
    render();
  });
  render();
}
