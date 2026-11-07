import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { absoluteDirectory } from './paths.mjs';

export class Settings {
  constructor(file, { platform = process.platform } = {}) {
    this.file = file; this.platform = platform; this.value = { rememberDirectory: true, recentDirectories: [] };
    this.pending = Promise.resolve(); this.ready = this.load();
  }
  async load() {
    if (!this.file) return;
    try {
      const saved = JSON.parse(await readFile(this.file, 'utf8'));
      if (saved.version !== 1 || typeof saved.rememberDirectory !== 'boolean') return;
      if (!saved.rememberDirectory) { this.value = { rememberDirectory: false, recentDirectories: [] }; return; }
      const directory = absoluteDirectory(saved.directory, this.platform);
      const recentDirectories = [...new Set([directory, ...(Array.isArray(saved.recentDirectories) ? saved.recentDirectories.filter(item => typeof item === 'string').map(item => absoluteDirectory(item, this.platform)) : [])])].slice(0, 5);
      this.value = { rememberDirectory: true, directory, recentDirectories };
    } catch { /* a missing or damaged preference must not block the generator */ }
  }
  async save(input) {
    if (!input || typeof input.rememberDirectory !== 'boolean') throw new Error('Choose whether to remember this location.');
    const directory = input.rememberDirectory ? absoluteDirectory(input.directory, this.platform) : undefined;
    const writing = this.pending.catch(() => {}).then(async () => {
      await this.ready;
      const next = { rememberDirectory: input.rememberDirectory, ...(directory && { directory }), recentDirectories: directory ? [directory, ...this.value.recentDirectories.filter(item => item !== directory)].slice(0, 5) : [] };
      if (this.file) {
        await mkdir(dirname(this.file), { recursive: true });
        const temporary = this.file + '.' + randomUUID() + '.tmp';
        await writeFile(temporary, JSON.stringify({ version: 1, ...next }), { mode: 0o600 });
        await rename(temporary, this.file);
      }
      this.value = next;
      return next;
    });
    this.pending = writing;
    return writing;
  }
}
