import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { run } from './process.mjs';

const unavailable = 'The operating system credential store is unavailable.';
const referenceId = /^[a-f0-9-]{36}$/;
const windowsScript = method => `$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Security
$bytes=[Convert]::FromBase64String([Console]::In.ReadToEnd())
$scope=[System.Security.Cryptography.DataProtectionScope]::CurrentUser
$protected=[System.Security.Cryptography.ProtectedData]::${method}($bytes,$null,$scope)
[Console]::Write([Convert]::ToBase64String($protected))`;

export function databaseVault(directory, { command = run, platform = process.platform } = {}) {
  async function windows(method, input) {
    const encoded = Buffer.from(windowsScript(method), 'utf16le').toString('base64');
    return (await command('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
      { input: Buffer.from(input), stdoutOnly: true, stdoutLimit: 64 * 1024, timeout: 8000 })).trim();
  }
  function labels(id) {
    return ['application', 'StackForge', 'profile', id];
  }
  return {
    async save(password) {
      const id = randomUUID();
      try {
        if (platform === 'win32' && directory) {
          const blob = await windows('Protect', Buffer.from(password).toString('base64'));
          if (!blob || !/^[\w+/=]+$/.test(blob)) throw new Error();
          await mkdir(directory, { recursive: true, mode: 0o700 });
          const temp = join(directory, id + '.tmp');
          try {
            await writeFile(temp, blob, { flag: 'wx', mode: 0o600 });
            await rename(temp, join(directory, id));
          } finally { await rm(temp, { force: true }); }
        } else if (platform === 'linux' && directory) {
          await command('secret-tool', ['store', '--label=StackForge database', ...labels(id)],
            { input: Buffer.from(password), timeout: 8000 });
        } else throw new Error();
        return id;
      } catch { throw new Error(unavailable); }
    },
    async read(id) {
      if (!directory || !referenceId.test(id ?? '')) throw new Error(unavailable);
      try {
        if (platform === 'win32') return Buffer.from(await windows('Unprotect', await readFile(join(directory, id), 'utf8')), 'base64').toString();
        if (platform === 'linux') return (await command('secret-tool', ['lookup', ...labels(id)],
          { timeout: 8000, stdoutOnly: true, stdoutLimit: 4096 })).replace(/\r?\n$/, '');
      } catch { /* Never expose native store output. */ }
      throw new Error(unavailable);
    },
    async remove(id) {
      if (!directory || !referenceId.test(id ?? '')) return;
      try {
        if (platform === 'win32') await rm(join(directory, id), { force: true });
        if (platform === 'linux') await command('secret-tool', ['clear', ...labels(id)], { timeout: 8000 });
      } catch { throw new Error(unavailable); }
    }
  };
}
