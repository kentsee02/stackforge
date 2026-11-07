import { spawn } from 'node:child_process';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { portAvailable } from './environment.mjs';
import { terminateTree } from './process.mjs';

const logLimit = 64 * 1024;
const active = new Set(['starting', 'running', 'stopping']);
const pathKey = path => process.platform === 'win32' ? path.toLowerCase() : path;

export async function recordedProjectDirectory(project) {
  try {
    const root = await lstat(project.path);
    if (!root.isDirectory() || root.isSymbolicLink()) throw new Error();
    const directory = await realpath(project.path);
    const manifestFile = join(directory, 'stackforge.json');
    const manifestInfo = await lstat(manifestFile);
    if (!manifestInfo.isFile() || manifestInfo.size > 64 * 1024) throw new Error();
    const manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
    if (manifest.generator !== 'StackForge' || ['name', 'frontend', 'backend', 'database'].some(key => manifest.options?.[key] !== project[key])) throw new Error();
    return directory;
  } catch {
    throw new Error('The recorded StackForge project is missing, has moved, or no longer matches its record.');
  }
}

function stopTree(child) {
  if (!child.pid) return Promise.resolve();
  if (process.platform === 'win32') return terminateTree(child);

  // Generated launchers handle SIGTERM and shut down their own child groups.
  // Signal the group too so a Compose startup command in progress is interrupted.
  try { process.kill(-child.pid, 'SIGTERM'); } catch { return Promise.resolve(); }
  return new Promise(resolve => {
    const closed = () => { clearTimeout(timer); resolve(); };
    const timer = setTimeout(async () => {
      child.off('close', closed);
      await terminateTree(child);
      resolve();
    }, 3000);
    child.once('close', closed);
  });
}

export class ProjectRuntime {
  constructor({ probePort = portAvailable } = {}) {
    this.probePort = probePort;
    this.runs = new Map();
    this.closing = false;
  }

  status(project, includeLogs = false) {
    const entry = this.runs.get(pathKey(project.path));
    const runtime = { status: entry?.status ?? 'stopped', error: entry?.error };
    if (includeLogs) Object.assign(runtime, { log: entry?.log ?? '', truncated: entry?.truncated ?? false });
    return runtime;
  }

  start(project) {
    if (this.closing) throw new Error('StackForge is shutting down.');
    const key = pathKey(project.path);
    if (active.has(this.runs.get(key)?.status)) return;
    const ports = [project.frontend !== 'none' ? 5173 : null, project.backend !== 'none' ? 8080 : null].filter(Boolean);
    const reserved = ports.find(port => [...this.runs.values()].some(other => active.has(other.status) && other.ports.includes(port)));
    if (reserved) throw new Error(`Development port ${reserved} is already in use.`);
    const entry = { status: 'starting', ports, log: '', truncated: false };
    this.runs.set(key, entry);
    entry.done = this.launch(project, entry).catch(error => {
      if (entry.status !== 'stopping') entry.error = error.message;
    }).finally(() => { entry.status = entry.error ? 'failed' : 'stopped'; entry.child = undefined; });
  }

  async launch(project, entry) {
    const directory = await recordedProjectDirectory(project);
    const script = join(directory, 'scripts', 'dev.mjs');
    try {
      if (!(await lstat(script)).isFile() || pathKey(await realpath(script)) !== pathKey(script)) throw new Error();
    } catch { throw new Error('The recorded StackForge project or its development script is missing or has moved.'); }
    if (entry.status === 'stopping') return;
    for (const port of entry.ports) if (!await this.probePort(port)) throw new Error(`Development port ${port} is already in use.`);
    if (entry.status === 'stopping') return;

    const child = spawn(process.execPath, [script], {
      cwd: directory, shell: false, detached: process.platform !== 'win32', windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    entry.child = child;
    const capture = chunk => {
      const output = entry.log + chunk.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
      if (output.length > logLimit) entry.truncated = true;
      entry.log = output.slice(-logLimit);
    };
    child.stdout.setEncoding('utf8').on('data', capture);
    child.stderr.setEncoding('utf8').on('data', capture);
    child.once('spawn', () => { if (entry.status === 'starting') entry.status = 'running'; });
    child.once('error', error => { if (entry.status !== 'stopping') entry.error = `Could not start the development process: ${error.message}`; });
    const [code, signal] = await new Promise(resolve => child.once('close', (...result) => resolve(result)));
    await entry.termination;
    if (entry.status !== 'stopping' && !entry.error && code !== 0) entry.error = `Development process exited (${code ?? signal}). See the log for details.`;
  }

  stop(project) {
    const entry = this.runs.get(pathKey(project.path));
    if (entry) this.stopRun(entry);
  }

  stopRun(entry) {
    if (!active.has(entry.status) || entry.status === 'stopping') return;
    entry.status = 'stopping';
    if (entry.child) entry.termination = stopTree(entry.child);
  }

  async shutdown() {
    this.closing = true;
    for (const entry of this.runs.values()) this.stopRun(entry);
    await Promise.allSettled([...this.runs.values()].map(entry => entry.done));
  }
}
