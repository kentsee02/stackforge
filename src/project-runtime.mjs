import { spawn } from 'node:child_process';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { portAvailable } from './environment.mjs';
import { run, terminateTree } from './process.mjs';
import { defaultPorts, projectPathKey } from './project-config.mjs';
import { sameDirectory } from './project-identity.mjs';
import { resolveStartup } from './project-startup.mjs';

const logLimit = 64 * 1024;
const active = new Set(['starting', 'running', 'stopping']);
export const recordedProjectChanged = 'The recorded StackForge project is missing, has moved, or no longer matches its record.';

async function probeService(url, signal, custom, requireRoute) {
  try {
    const response = await fetch(url, { redirect: custom ? 'manual' : 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(1500)]) });
    if (custom || !response.ok || !url.endsWith('/api/health')) {
      await response.body?.cancel();
      if (custom && requireRoute) return (response.status >= 200 && response.status < 400) || [401, 403].includes(response.status);
      return custom || response.ok;
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body ?? []) {
      size += chunk.byteLength;
      if (size > 4096) return false;
      chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')).status === 'ok';
  } catch { return false; }
}

export function startupDiagnostic(_project, output) {
  if (/EADDRINUSE|address already in use|port [^\r\n]{1,32}(?:already in use|already allocated)|ports are not available/i.test(output)) return 'port';
  if (/(?:cannot resolve environment variable|missing required environment variable|environment variable not found)\s*:\s*["']?DATABASE_URL\b|\bDATABASE_URL\b[^\r\n]{0,10}\b(?:is (?:not set|missing|required|undefined)|must be set)\b/i.test(output)) return 'databaseUrl';
  if (/\bP1001\s*:|can.t reach database server/i.test(output)) return 'databaseConnection';
  if (/\bJAVA_HOME\b[^\r\n]*(?:not set|not defined|not found|incorrect|invalid|not correctly|does not)|invalid (?:target|source) release|release version \d+ not supported|UnsupportedClassVersionError|Unsupported class file major version|No compiler is provided in this environment|(?:cannot|could not) find a Java installation|\b(?:java|javac)\b[^\r\n]*(?:not found|not recognized|不是内部或外部命令)/i.test(output)) return 'java';
  if (/NETSDK1045|compatible \.NET SDK (?:was not found|could not be found)|no \.NET SDKs were found/i.test(output)) return 'dotnetSdk';
  if (/ERR_PNPM_OUTDATED_LOCKFILE|\bYN0028\b|(?:package-lock\.json|npm-shrinkwrap\.json)[^\r\n]*(?:in sync|out of sync)|the lock file [^\r\n]*needs to be updated but --locked/i.test(output)) return 'lockfile';
  if (/cannot connect to the docker daemon|is the docker daemon running|dockerDesktopLinuxEngine|docker_engine.*(?:cannot|not find|denied)|spawn docker ENOENT|\bdocker\b[^\r\n]*(?:not recognized|command not found|不是内部或外部命令)/i.test(output)) return 'docker';
  if (/Database startup failed/i.test(output)) return 'database';
  if (/ModuleNotFoundError:\s*No module named|\bpython(?:3|\.exe)?\s*:\s*No module named/i.test(output)) return 'pythonDependencies';
  if (/(?:\bspawn\s+(?:dotnet|go|cargo|composer|bundle|gradle|mvn|uv|python3?)\s+ENOENT|\b(?:dotnet|go|cargo|composer|bundle|gradle|mvn|uv|python3?)\b["']?\s*:?\s*(?:command not found|is not recognized|不是内部或外部命令))/i.test(output)) return 'toolMissing';
  if (/Cannot find (?:package|module) ['"](?:vite|vue|react|express|mysql2|pg|@vitejs\/[^'"]+|@nestjs\/[^'"]+)['"]|(?:vite|\bnest)['"]?[^\r\n]{0,32}(?:not recognized|not found|不是内部或外部命令)|failed to load config[^\r\n]*\n[^\r\n]*Cannot find package/i.test(output)) return 'dependencies';
}

export async function projectDirectory(path) {
  const root = await lstat(path);
  if (!root.isDirectory() || root.isSymbolicLink()) throw new Error();
  return realpath(path);
}

export async function readProjectFolder(path) {
  const directory = await projectDirectory(path);
  const manifestFile = join(directory, 'stackforge.json');
  const manifestInfo = await lstat(manifestFile);
  if (!manifestInfo.isFile() || manifestInfo.size > 64 * 1024) throw new Error();
  const manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
  if (manifest.generator !== 'StackForge') throw new Error();
  return { directory, manifest };
}

export async function inspectRecordedProject(project) {
  if (project.unmanaged) {
    const { root: directory } = await resolveStartup(project, []);
    if (projectPathKey(directory) !== projectPathKey(project.path)) throw new Error(recordedProjectChanged);
    return { directory, manifest: {} };
  }
  try {
    const info = await readProjectFolder(project.path);
    if (project.folderIdentity && !sameDirectory(await lstat(info.directory, { bigint: true }), project.folderIdentity)) throw new Error();
    if (['name', 'frontend', 'backend', 'database'].some(key => info.manifest.options?.[key] !== project[key])) throw new Error();
    return info;
  } catch {
    throw new Error(recordedProjectChanged);
  }
}

export async function developmentScript(directory) {
  const script = join(directory, 'scripts', 'dev.mjs');
  try {
    if (!(await lstat(script)).isFile() || projectPathKey(await realpath(script)) !== projectPathKey(script)) throw new Error();
    return script;
  } catch { throw new Error('The recorded StackForge project or its development script is missing or has moved.'); }
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
  constructor({ probePort = portAvailable, probeEndpoint = probeService } = {}) {
    this.probePort = probePort;
    this.probeEndpoint = probeEndpoint;
    this.runs = new Map();
    this.closing = false;
  }

  status(project, includeLogs = false) {
    const entry = this.runs.get(projectPathKey(project.path));
    const runtime = { status: entry?.status ?? 'stopped', error: entry?.error };
    if (entry?.status === 'running') {
      runtime.services = entry.services;
      runtime.ready = Object.values(entry.services).every(service => service.ready);
      runtime.initialized = entry.initialized === true;
    }
    if (entry && (runtime.status === 'failed' || runtime.status === 'running' && !runtime.ready)) {
      runtime.diagnostic = startupDiagnostic(project, (entry.error || '') + '\n' + entry.log.slice(-12000));
      if (!runtime.diagnostic && runtime.status === 'running' && Date.now() - entry.launchedAt > 30000) {
        runtime.diagnostic = Object.values(entry.services).some(service => service.openUrl && !service.ready) ? 'waitingLink' : 'waiting';
      }
    }
    if (includeLogs) Object.assign(runtime, { log: entry?.log ?? '', truncated: entry?.truncated ?? false });
    return runtime;
  }

  start(project, overrides = {}) {
    if (this.closing) throw new Error('StackForge is shutting down.');
    const key = projectPathKey(project.path);
    if (active.has(this.runs.get(key)?.status)) return;
    const effective = { ...defaultPorts(project), ...overrides };
    const startup = project.startup?.services.filter(service => service.command);
    const ports = (startup ? startup.map(service => service.port) : [effective.frontend, effective.backend, overrides.database]).filter(Boolean);
    const reserved = ports.find(port => [...this.runs.values()].some(other => active.has(other.status) && other.ports.includes(port)));
    if (reserved) throw new Error(`Development port ${reserved} is already in use.`);
    const services = {};
    if (startup) for (const [index, { name, port, kind, openPath }] of startup.entries()) {
      if (!port) continue;
      const url = `http://127.0.0.1:${port}/`;
      services[index] = { name, url, ready: false, ...(kind && { kind }), ...(openPath && { openUrl: new URL(openPath, url).href }) };
    }
    if (effective.frontend) services.frontend = { url: `http://127.0.0.1:${effective.frontend}/`, ready: false };
    if (effective.backend) services.backend = { url: `http://127.0.0.1:${effective.backend}/api/health`, ready: false };
    const entry = { status: 'starting', ports, services, readiness: new AbortController(), log: '', truncated: false };
    this.runs.set(key, entry);
    const launch = startup ? this.launchStartup(project, entry, startup) : this.launch(project, entry, effective, overrides);
    entry.done = launch.catch(error => {
      if (entry.status !== 'stopping') entry.error = error.message;
    }).finally(() => { entry.readiness.abort(); entry.status = entry.error ? 'failed' : 'stopped'; entry.child = undefined; });
  }

  capture(entry, chunk) {
    const output = entry.log + chunk.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
    if (output.length > logLimit) entry.truncated = true;
    entry.log = output.slice(-logLimit);
  }

  markRunning(entry) {
    if (entry.status !== 'starting') return;
    entry.launchedAt = Date.now();
    entry.status = 'running';
    this.watchReadiness(entry).catch(() => {});
  }

  async launchStartup(project, entry, services) {
    const { commands } = await resolveStartup(project, services, project.startup.identity);
    const signal = entry.readiness.signal;
    for (const port of entry.ports) {
      if (signal.aborted) return;
      if (!await this.probePort(port)) throw new Error(`Development port ${port} is already in use.`);
    }
    if (signal.aborted) return;

    let remaining = commands.length;
    const onSpawn = () => { if (--remaining === 0) this.markRunning(entry); };
    await Promise.all(commands.map(({ name, cwd, command, port }) => {
      const ended = error => {
        if (signal.aborted) return;
        this.capture(entry, `[${name}] ${error?.message ?? 'Process exited (0).'}\n`);
        entry.error = 'A startup service exited. See the runtime log for details.';
        this.stopRun(entry);
      };
      return run(command, [], {
        cwd, env: { ...process.env, ...(port && { PORT: String(port) }) },
        shell: true, timeout: 0, signal, onSpawn,
        log: chunk => this.capture(entry, `[${name}] ${chunk}`)
      }).then(() => ended(), ended);
    }));
  }

  async launch(project, entry, effective, overrides) {
    const { directory, manifest } = await inspectRecordedProject(project);
    if (Object.keys(overrides).length && manifest.portConfig !== 1) throw new Error('This project uses an older launcher with fixed app ports.');
    const script = await developmentScript(directory);
    if (entry.status === 'stopping') return;
    // A database left running from the previous session may already own its port.
    for (const port of [effective.frontend, effective.backend].filter(Boolean)) if (!await this.probePort(port)) throw new Error(`Development port ${port} is already in use.`);
    if (entry.status === 'stopping') return;

    const child = spawn(process.execPath, [script], {
      cwd: directory, shell: false, detached: process.platform !== 'win32', windowsHide: true,
      env: { ...process.env, STACKFORGE_FRONTEND_PORT: String(effective.frontend ?? ''), STACKFORGE_BACKEND_PORT: String(effective.backend ?? ''), STACKFORGE_DATABASE_PORT: String(overrides.database ?? '') },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    entry.child = child;
    const capture = chunk => this.capture(entry, chunk);
    child.stdout.setEncoding('utf8').on('data', capture);
    child.stderr.setEncoding('utf8').on('data', capture);
    child.once('spawn', () => this.markRunning(entry));
    child.once('error', error => { if (entry.status !== 'stopping') entry.error = `Could not start the development process: ${error.message}`; });
    const [code, signal] = await new Promise(resolve => child.once('close', (...result) => resolve(result)));
    await entry.termination;
    if (entry.status !== 'stopping' && !entry.error && code !== 0) entry.error = `Development process exited (${code ?? signal}). See the log for details.`;
  }

  async watchReadiness(entry) {
    const signal = entry.readiness.signal;
    const services = Object.values(entry.services);
    while (!signal.aborted) {
      const checks = await Promise.all(services.map(service => this.probeEndpoint(service.openUrl ?? service.url, signal, Boolean(service.name), Boolean(service.openUrl))));
      if (signal.aborted) return;
      for (const [index, service] of services.entries()) service.ready = checks[index];
      const ready = checks.every(Boolean);
      if (ready) entry.initialized = true;
      await delay(ready ? 2000 : 850, undefined, { signal, ref: false });
    }
  }

  stop(project) {
    const entry = this.runs.get(projectPathKey(project.path));
    if (entry) this.stopRun(entry);
  }

  stopRun(entry) {
    if (!active.has(entry.status) || entry.status === 'stopping') return;
    entry.status = 'stopping';
    entry.readiness.abort();
    if (entry.child) entry.termination = stopTree(entry.child);
  }

  async shutdown() {
    this.closing = true;
    for (const entry of this.runs.values()) this.stopRun(entry);
    await Promise.allSettled([...this.runs.values()].map(entry => entry.done));
  }
}
