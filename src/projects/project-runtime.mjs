import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { portAvailable } from '../platform/ports.mjs';
import { run, stopProcessTree } from '../platform/process.mjs';
import { defaultPorts, projectPathKey } from './project-config.mjs';
import { commandDiagnostic } from './project-diagnostics.mjs';
import { resolveStartup } from './project-startup.mjs';
import { developmentScript, inspectRecordedProject } from './project-folder.mjs';
import { addProjectLogSecrets, databaseRedactor, redactedProcessOutput } from '../database/security/secrets.mjs';

export { developmentScript, inspectRecordedProject, projectDirectory, readProjectFolder, recordedProjectChanged } from './project-folder.mjs';

const logLimit = 64 * 1024;
const active = new Set(['starting', 'running', 'stopping']);

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
      runtime.diagnostic = commandDiagnostic((entry.error || '') + '\n' + entry.log.slice(-12000));
      if (!runtime.diagnostic && runtime.status === 'running' && Date.now() - entry.launchedAt > 30000) {
        runtime.diagnostic = Object.values(entry.services).some(service => service.openUrl && !service.ready) ? 'waitingLink' : 'waiting';
      }
    }
    if (includeLogs) Object.assign(runtime, { log: entry?.log ?? '', truncated: entry?.truncated ?? false });
    return runtime;
  }

  start(project, overrides = {}, verifyDatabase) {
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
    const entry = { status: 'starting', ports, services, readiness: new AbortController(), log: '', truncated: false,
      redact: databaseRedactor(process.env) };
    this.runs.set(key, entry);
    const launch = startup ? this.launchStartup(project, entry, startup) : this.launch(project, entry, effective, overrides, verifyDatabase);
    entry.done = launch.catch(error => {
      if (entry.status !== 'stopping') entry.error = entry.redact.text(error.message);
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
    const { root, commands } = await resolveStartup(project, services, project.startup.identity);
    const signal = entry.readiness.signal;
    await Promise.all([...new Set([root, ...commands.map(service => service.cwd)])].map(cwd => addProjectLogSecrets(entry.redact, cwd)));
    for (const port of entry.ports) {
      if (signal.aborted) return;
      if (!await this.probePort(port)) throw new Error(`Development port ${port} is already in use.`);
    }
    if (signal.aborted) return;

    let remaining = commands.length;
    const onSpawn = () => { if (--remaining === 0) this.markRunning(entry); };
    await Promise.all(commands.map(({ name, cwd, command, port }) => {
      const append = chunk => this.capture(entry, `[${name}] ${chunk}`);
      const discard = () => { entry.truncated = true; };
      const output = redactedProcessOutput(append, entry.redact, discard);
      const ended = error => {
        output.flush();
        if (signal.aborted) return;
        const message = Number.isInteger(error?.exitCode) ? `Process exited (${error.exitCode}).` : error?.message?.split('\n')[0] ?? 'Process exited (0).';
        this.capture(entry, `[${name}] ${entry.redact.text(message)}\n`);
        entry.error = 'A startup service exited. See the runtime log for details.';
        this.stopRun(entry);
      };
      return run(command, [], {
        cwd, env: { ...process.env, ...(port && { PORT: String(port) }) },
        shell: true, timeout: 0, signal, onSpawn,
        log: output.write
      }).then(() => ended(), ended);
    }));
  }

  async launch(project, entry, effective, overrides, verifyDatabase) {
    const { directory, manifest } = await inspectRecordedProject(project);
    if (Object.keys(overrides).length && manifest.portConfig !== 1) throw new Error('This project uses an older launcher with fixed app ports.');
    const script = await developmentScript(directory);
    await Promise.all(['', 'frontend', 'backend'].map(path => addProjectLogSecrets(entry.redact, join(directory, path))));
    if (entry.status === 'stopping') return;
    // A database left running from the previous session may already own its port.
    for (const port of [effective.frontend, effective.backend].filter(Boolean)) if (!await this.probePort(port)) throw new Error(`Development port ${port} is already in use.`);
    if (entry.status === 'stopping') return;
    const dockerEnv = await verifyDatabase?.(entry.readiness.signal);
    if (entry.status === 'stopping') return;

    const child = spawn(process.execPath, [script], {
      cwd: directory, shell: false, detached: process.platform !== 'win32', windowsHide: true,
      env: { ...(dockerEnv ?? process.env), STACKFORGE_FRONTEND_PORT: String(effective.frontend ?? ''), STACKFORGE_BACKEND_PORT: String(effective.backend ?? ''), STACKFORGE_DATABASE_PORT: String(overrides.database ?? '') },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    entry.child = child;
    const append = chunk => this.capture(entry, chunk);
    const discard = () => { entry.truncated = true; };
    const output = redactedProcessOutput(append, entry.redact, discard);
    child.stdout.setEncoding('utf8').on('data', chunk => output.write(chunk, 'stdout'));
    child.stderr.setEncoding('utf8').on('data', chunk => output.write(chunk, 'stderr'));
    child.once('spawn', () => this.markRunning(entry));
    child.once('error', error => { if (entry.status !== 'stopping') entry.error = `Could not start the development process: ${entry.redact.text(error.message)}`; });
    const [code, signal] = await new Promise(resolve => child.once('close', (...result) => resolve(result)));
    output.flush();
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
    if (entry.child) entry.termination = stopProcessTree(entry.child);
  }

  async shutdown() {
    this.closing = true;
    for (const entry of this.runs.values()) this.stopRun(entry);
    await Promise.allSettled([...this.runs.values()].map(entry => entry.done));
  }
}
