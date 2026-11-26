import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, rmdirSync, unlinkSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const source = fileURLToPath(new URL('./windows-npm.cs', import.meta.url));
let build;

async function compile() {
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
  const compiler = systemRoot && ['Framework64', 'Framework'].map(folder =>
    join(systemRoot, 'Microsoft.NET', folder, 'v4.0.30319', 'csc.exe')).find(existsSync);
  if (!compiler) throw new Error('Windows could not prepare safe npm cancellation. The Windows .NET Framework compiler is unavailable.');
  const directory = await mkdtemp(join(tmpdir(), 'stackforge-windows-npm-'));
  const program = join(directory, 'run-npm.exe');
  const cleanup = () => {
    try { unlinkSync(program); } catch { /* The compiler may have stopped before writing the executable. */ }
    try { rmdirSync(directory); } catch { /* Windows may still be closing the helper. */ }
  };
  try {
    await execute(compiler, ['/nologo', '/noconfig', '/target:exe', '/optimize+', '/out:' + program, source],
      { cwd: directory, timeout: 20000, windowsHide: true });
  } catch {
    cleanup();
    throw new Error('Windows could not prepare safe npm cancellation. The process supervisor could not compile.');
  }
  process.once('exit', cleanup);
  return program;
}

export async function windowsNpmSupervisor() {
  build ??= compile().catch(error => { build = undefined; throw error; });
  const program = await build;
  const name = 'Local\\StackForge.Npm.' + randomUUID();
  return {
    spawn(command, args, options) { return spawn(program, ['run', name, command, ...args], options); },
    async stop(child) {
      child.kill();
      // The npm root can exit before a descendant releases the original output pipes.
      try { await execute(program, ['cancel', name], { timeout: 10000, windowsHide: true }); }
      catch { throw new Error('Windows could not verify cancellation of the npm process group.'); }
    }
  };
}
