import { join } from 'node:path';
import { readMigrationFile } from './migration-files.mjs';

const setting = /^(script_location|version_locations|recursive_version_locations|sourceless|output_encoding)\s*[:=]\s*(.*)$/i;

function standardLocation(text) {
  const sections = [...text.matchAll(/^\s*\[([\w.-]+)\][ \t]*\r?$/gm)];
  if (sections.some(([, name]) => name === 'DEFAULT') || sections.filter(([, name]) => name === 'alembic').length !== 1) return;
  const index = sections.findIndex(([, name]) => name === 'alembic');
  const section = text.slice(sections[index].index + sections[index][0].length, sections[index + 1]?.index);
  const values = new Map();
  for (const line of section.split(/\r?\n/)) {
    if (line.trim() && !/^\s*[#;]/.test(line) && /^\s/.test(line)) return;
    const pair = setting.exec(line.trim());
    if (!pair) continue;
    const [, key, value] = pair;
    const name = key.toLowerCase();
    if (values.has(name)) return;
    values.set(name, value);
  }
  if (values.has('version_locations') || ['sourceless', 'recursive_version_locations'].some(name =>
    values.has(name) && !/^(?:false|no|off|0)$/i.test(values.get(name))) ||
    values.has('output_encoding') && !/^utf-?8$/i.test(values.get('output_encoding'))) return;
  const path = values.get('script_location')?.replace(/^%\(here\)s[/\\]/, '').replace(/^\.[/\\]/, '').replace(/[/\\]$/, '').replaceAll('\\', '/');
  if (!path || path.length > 220 || path.split('/').some(part => !/^[\w-][\w. -]*$/.test(part) || /[. ]$/.test(part))) return;
  return path + '/versions';
}

export async function alembicConfig(folder, files) {
  const read = name => readMigrationFile(join(folder, name), 64 * 1024).catch(() => '');
  const ini = files.includes('alembic.ini') && await read('alembic.ini');
  const toml = files.includes('pyproject.toml') && await read('pyproject.toml');
  const declaredIni = /^[ \t]*\[alembic\][ \t]*\r?$/m.test(ini || '');
  const declaredToml = /^[ \t]*\[tool\.alembic\][ \t]*(?:#[^\r\n]*)?\r?$/m.test(toml || '');
  if (declaredIni) return { file: 'alembic.ini', versions: declaredToml ? undefined : standardLocation(ini) };
  if (declaredToml) return { file: 'pyproject.toml' };
}
