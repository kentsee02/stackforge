import { createServer } from 'node:http';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { randomBytes, createHash, randomUUID } from 'node:crypto';
import metadata from '../package.json' with { type: 'json' };
import { catalog, validateOptions } from './catalog.mjs';
import { generateProject } from './generator.mjs';
import { checkEnvironment } from './environment.mjs';
import { publishProject } from './git.mjs';
import { run } from './process.mjs';
import { Jobs } from './jobs.mjs';
import { absoluteDirectory, defaultProjectsDirectory } from './paths.mjs';
import { Settings } from './settings.mjs';
import { createDesktop } from './desktop.mjs';
import { ProjectRuntime, inspectRecordedProject, projectDirectory, readProjectFolder, developmentScript, startupDiagnostic, recordedProjectChanged } from './project-runtime.mjs';
import { ProjectConfig, defaultPorts, validatePorts, importedProject, projectPathKey } from './project-config.mjs';
import { ProjectOperations } from './project-operations.mjs';
import { cloneGithub, verifyClone } from './project-clone.mjs';
import { detectFrameworks } from './project-detection.mjs';
import { directoryIdentity } from './project-identity.mjs';
import { resolveStartup, validateStartup } from './project-startup.mjs';
import { detectDependencyPlan } from './dependency-plan.mjs';
import { detectStartupSuggestions } from './startup-suggestions.mjs';
import { backupLimit } from './database-backup.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const identity = { application: 'stackforge-local', version: metadata.version, project: createHash('sha256').update(process.platform === 'win32' ? root.toLowerCase() : root).digest('hex') };
const staticFiles = { '/': ['index.html', 'text/html; charset=utf-8'], '/app.js': ['app.js', 'text/javascript; charset=utf-8'], '/i18n.js': ['i18n.js', 'text/javascript; charset=utf-8'], '/messages.js': ['messages.js', 'text/javascript; charset=utf-8'], '/template-store.js': ['template-store.js', 'text/javascript; charset=utf-8'], '/style.css': ['style.css', 'text/css; charset=utf-8'], '/plex-regular.ttf': ['plex-regular.ttf', 'font/ttf'], '/plex-semibold.ttf': ['plex-semibold.ttf', 'font/ttf'] };
staticFiles['/projects'] = ['projects.html', 'text/html; charset=utf-8'];
staticFiles['/projects.js'] = ['projects.js', 'text/javascript; charset=utf-8'];

async function locationExists(path) {
  try { await lstat(path); return true; }
  catch (error) { return !['ENOENT', 'ENOTDIR'].includes(error.code); }
}

function removeOnly(project) {
  return project.cloneId ? !project.cloneIdentity : project.unmanaged === true;
}

function projectDetails(project) {
  const { cloneId, cloneIdentity, folderIdentity, startup, ...details } = project;
  return { ...details, ...(cloneId && { cloned: true }), ...(removeOnly(project) && { removeOnly: true }),
    ...(project.unmanaged && { external: !project.frameworks.length,
      hasStartup: Boolean(startup?.services.some(service => service.command)),
      hasInstallCommands: Boolean(startup?.services.some(service => service.installCommand)) }) };
}

export function createApp({ generate = generateProject, check = checkEnvironment, publish = (path, options, report, { signal } = {}) => publishProject(path, options, report, (name, args, config = {}) => run(name, args, { ...config, signal })), clone = cloneGithub, defaultDir = defaultProjectsDirectory(), stateDir = resolve(root, '.stackforge/jobs'), settingsFile = stateDir ? join(dirname(stateDir), 'settings.json') : false, desktop = createDesktop(), runtime = new ProjectRuntime(), operations = new ProjectOperations() } = {}) {
  const token = randomBytes(32).toString('hex');
  const jobs = new Jobs({ directory: stateDir, generate, check, publish });
  const settings = new Settings(settingsFile);
  const projectConfig = new ProjectConfig(stateDir ? join(dirname(stateDir), 'projects.json') : false);
  const removals = new Map();
  const configWrites = new Map();
  let cloneTask, transfer;
  let closing = false;
  function managedProjects() {
    const created = jobs.projects();
    const paths = new Set(created.map(project => projectPathKey(project.path)));
    return [...projectConfig.value.imports.filter(project => !paths.has(projectPathKey(project.path))), ...created];
  }
  async function registerProject(path, clone = {}) {
    const directory = await projectDirectory(absoluteDirectory(path)).catch(() => {
      throw new Error('Choose an existing project directory.');
    });
    let project;
    try {
      const { manifest } = await readProjectFolder(directory);
      await developmentScript(directory);
      const { name, frontend, backend, database } = manifest.options ?? {};
      const folderIdentity = directoryIdentity(await lstat(directory, { bigint: true }));
      project = importedProject(randomUUID(), directory, { name, frontend, backend, database, folderIdentity, ...clone });
    } catch {
      project = importedProject(randomUUID(), directory, { unmanaged: true, ...clone, frameworks: await detectFrameworks(directory) });
    }
    const existing = await Promise.all(jobs.projects().map(item => realpath(item.path).catch(() => item.path)));
    if (existing.some(item => projectPathKey(item) === projectPathKey(project.path))) throw new Error('This folder is already in Projects.');
    await projectConfig.addProject(project);
    return projectDetails(project);
  }
  function send(res, status, value) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(value));
  }
  function authorized(req, contentType) {
    const origin = req.headers.origin;
    return (!origin || origin === `http://${req.headers.host}`) && req.headers['x-stackforge-token'] === token &&
      req.headers['content-type']?.split(';')[0] === contentType;
  }
  const server = createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    const validHosts = [`127.0.0.1:${req.socket.localPort}`, `localhost:${req.socket.localPort}`];
    if (!validHosts.includes(req.headers.host)) return send(res, 403, { error: '只允许从本机地址访问。' });
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      if (req.method === 'GET' && url.pathname === '/api/identity') return send(res, 200, identity);
      await Promise.all([jobs.ready, settings.ready, projectConfig.ready]);
      if (req.method === 'GET' && url.pathname === '/api/state') return send(res, 200, { catalog, token, defaultDir, node: process.version, platform: process.platform, version: identity.version, jobs: jobs.list(), preferences: settings.value, desktop: await desktop.capabilities() });
      if (req.method === 'GET' && url.pathname === '/api/projects') {
        const selected = url.searchParams.get('logs');
        const projects = await Promise.all(managedProjects().map(async project => {
          const deleting = removals.has(project.path);
          const session = runtime.status(project, project.id === selected);
          if (!deleting && !['starting', 'running', 'stopping'].includes(session.status) && !await locationExists(project.path)) return;
          const detail = { ...projectDetails(project), ...session, ...operations.status(project, project.id === selected), deleting };
          if (transfer?.path === project.path) detail.operation = 'databaseTransfer';
          if (project.id === selected) {
            if (project.unmanaged) detail.startupServices = project.startup?.services ?? [];
            else {
              const info = await inspectRecordedProject(project).catch(() => null);
              Object.assign(detail, { portDefaults: defaultPorts(project), ports: projectConfig.ports(project), canConfigurePorts: info?.manifest.portConfig === 1 });
            }
          }
          return detail;
        }));
        return send(res, 200, { projects: projects.filter(Boolean) });
      }
      const projectView = /^\/api\/projects\/([^/]+)\/(database|checks|git|dependencies|startup-suggestions)$/.exec(url.pathname);
      if (req.method === 'GET' && projectView) {
        const [, id, view] = projectView;
        const project = managedProjects().find(item => item.id === id);
        if (!project) return send(res, 404, { error: 'This project was not found in StackForge.' });
        try {
          if (view === 'checks') return send(res, 200, { checks: await operations.checks(project) });
          if (view === 'git') return send(res, 200, await operations.git(project));
          if (view === 'startup-suggestions') {
            if (!project.unmanaged) return send(res, 409, { error: 'This project uses the StackForge launcher.' });
            return send(res, 200, await detectStartupSuggestions(project));
          }
          if (view === 'dependencies') {
            if (!project.unmanaged) return send(res, 409, { error: 'This project uses the StackForge launcher.' });
            const { id, steps, issues } = await detectDependencyPlan(project);
            return send(res, 200, { id, steps: steps.map(({ tool, command, directory, evidence }) => ({ tool, command, directory, evidence })), issues });
          }
          return send(res, 200, await operations.database(project, projectConfig.ports(project), url.searchParams.has('logs')));
        } catch (error) {
          return send(res, 409, { error: error.message.split('\n')[0].trim(), diagnostic: view === 'database' ? startupDiagnostic(project, error.message) : undefined });
        }
      }
      if (req.method === 'GET' && url.pathname === '/api/jobs') return send(res, 200, jobs.list());
      if (req.method === 'GET' && url.pathname.startsWith('/api/jobs/')) {
        const job = jobs.view(url.pathname.slice('/api/jobs/'.length));
        return send(res, job ? 200 : 404, job ?? { error: '找不到这个创建任务。' });
      }
      const databaseTransfer = /^\/api\/projects\/([^/]+)\/database-(backup|restore)$/.exec(url.pathname);
      if (req.method === 'POST' && databaseTransfer) {
        const [, id, action] = databaseTransfer;
        const restore = action === 'restore';
        if (!authorized(req, restore ? 'application/octet-stream' : 'application/json')) return send(res, 403, { error: '请求来源无效，请刷新本机页面后重试。' });
        const project = managedProjects().find(item => item.id === id);
        if (!project || project.database === 'none') return send(res, 404, { error: 'This project has no database.' });
        if (closing || transfer || removals.has(project.path) || configWrites.has(project.path) || operations.active(project)) {
          return send(res, 409, { error: 'Wait for the current project operation to finish.' });
        }
        const size = Number(req.headers['content-length']);
        if (restore) {
          if (req.headers['x-stackforge-confirm-name'] !== project.name) return send(res, 400, { error: 'Enter the exact project name to confirm restoration.' });
          if (!Number.isSafeInteger(size) || size < 1 || size > backupLimit) return send(res, 413, { error: 'Choose a backup file up to 64 MiB.' });
          if (['starting', 'running', 'stopping'].includes(runtime.status(project).status)) return send(res, 409, { error: 'Stop the project before restoring its database.' });
        }
        const controller = new AbortController();
        res.once('close', () => { if (!res.writableFinished) controller.abort(); });
        const done = (async () => {
          let file;
          if (restore) {
            const chunks = [];
            const cancelUpload = () => req.destroy();
            controller.signal.addEventListener('abort', cancelUpload, { once: true });
            try { for await (const chunk of req) chunks.push(chunk); }
            finally { controller.signal.removeEventListener('abort', cancelUpload); }
            file = Buffer.concat(chunks);
            if (file.length !== size) throw new Error('The backup upload was incomplete.');
          } else req.resume();
          return operations.databaseBackup(project, projectConfig.ports(project), file, controller.signal);
        })();
        transfer = { path: project.path, done, controller };
        try {
          const result = await done;
          if (restore) return send(res, 200, { restored: true });
          res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store',
            'Content-Disposition': `attachment; filename="${result.filename}"`, 'Content-Length': result.data.length });
          return res.end(result.data);
        } catch (error) {
          if (!res.destroyed) return send(res, 409, { error: error.message.split('\n')[0].trim() });
        } finally { transfer = undefined; }
        return;
      }
      const projectAction = /^\/api\/projects\/([^/]+)\/(start|stop|startup|trash|remove|ports|install|install-cancel|database-start|database-stop|run-check|check-cancel)$/.exec(url.pathname);
      if (req.method === 'POST' && (projectAction || ['/api/projects', '/api/projects/import', '/api/projects/clone', '/api/checks', '/api/preferences', '/api/desktop/pick-directory'].includes(url.pathname) || /^\/api\/jobs\/[^/]+\/(publish|retry|cancel|open)$/.test(url.pathname))) {
        if (!authorized(req, 'application/json')) return send(res, 403, { error: '请求来源无效，请刷新本机页面后重试。' });
        if (jobs.busy && (['/api/projects', '/api/desktop/pick-directory'].includes(url.pathname) || /\/(publish|retry)$/.test(url.pathname))) return send(res, 409, { error: '已有任务正在执行，请等待或取消。' });
        const chunks = []; let size = 0;
        for await (const chunk of req) { size += chunk.length; if (size > 16384) return send(res, 413, { error: '请求内容过大。' }); chunks.push(chunk); }
        if (closing) return send(res, 409, { error: 'StackForge is shutting down.' });
        const body = Buffer.concat(chunks).toString('utf8');
        let payload;
        try { payload = JSON.parse(body); if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error(); }
        catch { return send(res, 400, { error: 'Invalid JSON request.' }); }
        if (cloneTask && (['/api/projects', '/api/projects/import', '/api/projects/clone'].includes(url.pathname) || /\/api\/jobs\/[^/]+\/retry$/.test(url.pathname))) {
          return send(res, 409, { error: 'Wait for the GitHub clone to finish.' });
        }
        if (url.pathname === '/api/projects/clone') {
          if (jobs.busy || removals.size) return send(res, 409, { error: 'Wait for StackForge to finish its current task.' });
          const controller = new AbortController();
          res.once('close', () => { if (!res.writableFinished) controller.abort(); });
          const done = (async () => {
            const { path, cloneId, cloneIdentity } = await clone(payload.repository, payload.parentDir, { signal: controller.signal });
            return registerProject(path, { cloneId, cloneIdentity });
          })();
          cloneTask = { done, controller };
          try { return send(res, 201, await done); }
          catch (error) { if (!res.destroyed) return send(res, 409, { error: error.message }); }
          finally { cloneTask = undefined; }
          return;
        }
        if (removals.size && (['/api/projects', '/api/projects/import'].includes(url.pathname) || /\/api\/jobs\/[^/]+\/(publish|retry|open)$/.test(url.pathname))) return send(res, 409, { error: 'Wait for the project to finish moving to the trash.' });
        if (url.pathname === '/api/projects/import') {
          if (jobs.busy) return send(res, 409, { error: 'Wait for StackForge to finish its current task.' });
          try { return send(res, 201, await registerProject(payload.path)); }
          catch (error) { return send(res, 400, { error: error.message }); }
        }
        if (projectAction) {
          const [, id, action] = projectAction;
          const project = managedProjects().find(item => item.id === id);
          if (!project) return send(res, 404, { error: 'This project was not found in StackForge.' });
          if (transfer?.path === project.path) return send(res, 409, { error: 'Wait for the current project operation to finish.' });
          if (project.unmanaged && !['start', 'stop', 'startup', 'install', 'install-cancel', 'run-check', 'check-cancel', 'trash', 'remove'].includes(action)) {
            return send(res, 409, { error: 'This action requires a StackForge project.' });
          }
          if (project.unmanaged && action === 'start' && !project.startup?.services.some(service => service.command)) return send(res, 409, { error: 'Save a startup configuration before starting this project.' });
          const detectedInstall = project.unmanaged && action === 'install' && payload.mode === 'detected';
          if (detectedInstall && (typeof payload.planId !== 'string' || !/^[a-f0-9]{64}$/.test(payload.planId))) return send(res, 400, { error: 'Review the detected install plan before running it.' });
          if (project.unmanaged && action === 'install' && !detectedInstall && !project.startup?.services.some(service => service.installCommand)) return send(res, 409, { error: 'Save an install command before installing dependencies.' });
          if (removals.has(project.path)) return send(res, 409, { error: 'Wait for the project to finish moving to the trash.' });
          if (configWrites.has(project.path)) return send(res, 409, { error: 'Wait for the project settings to finish saving.' });
          if (action === 'install-cancel' || action === 'check-cancel') {
            operations.cancel(project, action === 'install-cancel' ? 'dependencies' : 'checkTask');
            return send(res, 202, operations.status(project, true));
          }
          if (action !== 'stop' && operations.active(project)) return send(res, 409, { error: 'Wait for the current project operation to finish.' });
          if (action === 'install' || action === 'run-check' || action.startsWith('database-')) {
            const session = runtime.status(project);
            const inTransition = ['starting', 'stopping'].includes(session.status);
            if (action === 'install' && (inTransition || session.status === 'running')) return send(res, 409, { error: 'Stop the project before installing dependencies.' });
            if (action === 'run-check' && (inTransition || session.status === 'running')) return send(res, 409, { error: 'Stop the project before running checks.' });
            if (action.startsWith('database-') && (inTransition || session.status === 'running' && !session.initialized)) return send(res, 409, { error: 'Wait for the project to become ready or stop it first.' });
            try {
              operations.start(project, action, projectConfig.ports(project), payload.check, detectedInstall ? payload.planId : undefined);
              return send(res, 202, operations.status(project, true));
            } catch (error) { return send(res, 409, { error: error.message }); }
          }
          if (action === 'ports') {
            if (['starting', 'running', 'stopping'].includes(runtime.status(project).status)) return send(res, 409, { error: 'Stop the project before changing its ports.' });
            const saving = (async () => {
              const ports = validatePorts(project, payload.ports);
              const { manifest } = await inspectRecordedProject(project);
              if (manifest.portConfig !== 1) throw new Error('This project uses an older launcher with fixed app ports.');
              await projectConfig.savePorts(project, ports);
              return ports;
            })();
            configWrites.set(project.path, saving);
            try { return send(res, 200, { ports: await saving }); }
            catch (error) { return send(res, 400, { error: error.message }); }
            finally { configWrites.delete(project.path); }
          }
          if (action === 'startup') {
            if (!project.unmanaged) return send(res, 409, { error: 'This project uses the StackForge launcher.' });
            if (['starting', 'running', 'stopping'].includes(runtime.status(project).status)) return send(res, 409, { error: 'Stop the project before changing its startup configuration.' });
            const saving = (async () => {
              const services = validateStartup(payload.services);
              let startup;
              if (services.length) {
                const { identity } = await resolveStartup(project, services, project.startup?.identity ?? project.cloneIdentity);
                startup = { identity, services };
              }
              await projectConfig.saveStartup(id, startup);
              return { services };
            })();
            configWrites.set(project.path, saving);
            try { return send(res, 200, await saving); }
            catch (error) { return send(res, 400, { error: error.message }); }
            finally { configWrites.delete(project.path); }
          }
          if (action === 'trash' || action === 'remove') {
            if (payload.confirmName !== project.name) return send(res, 400, { error: 'Enter the exact project name to confirm deletion.' });
            if (action === 'remove' && !project.imported) return send(res, 409, { error: 'Only imported projects can be removed from the list.' });
            if (jobs.busy) return send(res, 409, { error: 'Wait for StackForge to finish its current task.' });
            if (['starting', 'running', 'stopping'].includes(runtime.status(project).status)) return send(res, 409, { error: 'Stop the project before moving it to the trash.' });
            if (action === 'remove' || removeOnly(project)) {
              await projectConfig.removeImport(project.id);
              return send(res, 200, { removed: true });
            }
            const moving = (async () => {
              const info = await inspectRecordedProject(project);
              if (project.cloneId) await verifyClone(info.directory, project.cloneId, project.cloneIdentity);
              const databaseDeleted = project.database !== 'none' && await operations.removeDatabase(project, projectConfig.ports(project), info);
              try {
                if (project.cloneId && project.database !== 'none') await verifyClone(info.directory, project.cloneId, project.cloneIdentity);
                if (project.cloneId) await desktop.trashProject(info.directory, project.cloneIdentity);
                else await desktop.trashProject(info.directory, project.folderIdentity, recordedProjectChanged);
                if (await locationExists(project.path)) throw new Error('The project is still at its original location. Check the system trash before retrying.');
              } catch (error) {
                if (databaseDeleted) throw new Error('The database was deleted, but the project folder could not be moved to the trash.');
                throw error;
              }
              if (project.cloneId) await projectConfig.removeImport(project.id);
              return { trashed: true, databaseDeleted };
            })();
            removals.set(project.path, moving);
            try { return send(res, 200, await moving); }
            catch (error) { return send(res, 409, { error: error.message }); }
            finally { removals.delete(project.path); }
          }
          try {
            if (action === 'start') runtime.start(project, projectConfig.ports(project));
            else runtime.stop(project);
            return send(res, 202, runtime.status(project));
          } catch (error) { return send(res, 409, { error: error.message, diagnostic: startupDiagnostic(project, error.message) }); }
        }
        if (url.pathname === '/api/preferences') {
          try { return send(res, 200, await settings.save(payload)); }
          catch (error) { return send(res, 400, { error: error.message }); }
        }
        if (url.pathname === '/api/desktop/pick-directory') {
          const controller = new AbortController();
          res.once('close', () => { if (!res.writableEnded) controller.abort(); });
          try { return send(res, 200, { path: await desktop.pickDirectory(payload.initialDir || defaultDir, { language: payload.language, signal: controller.signal }) }); }
          catch (error) { return send(res, 400, { error: error.message }); }
        }
        if (url.pathname.endsWith('/open')) {
          const job = jobs.view(url.pathname.split('/')[3]);
          if (!job) return send(res, 404, { error: '找不到这个创建任务。' });
          try {
            if (job.status !== 'complete' || !job.result?.path) throw new Error('The local project is not ready to open.');
            const expected = resolve(job.options.parentDir, job.options.name);
            const actual = absoluteDirectory(job.result.path);
            const normalized = value => process.platform === 'win32' ? value.toLowerCase() : value;
            if (normalized(actual) !== normalized(expected)) throw new Error('The recorded project location does not match this task.');
            await desktop.openProject(expected, payload.action);
            return send(res, 200, { requested: true });
          } catch (error) { return send(res, 400, { error: error.message }); }
        }
        if (/\/(publish|retry|cancel)$/.test(url.pathname)) {
          const id = url.pathname.split('/')[3];
          try {
            if (url.pathname.endsWith('/cancel')) await jobs.cancel(id);
            else await jobs.retry(id, url.pathname.endsWith('/publish'));
            return send(res, 202, { id });
          } catch (error) { return send(res, 400, { error: error.message }); }
        }
        let input;
        try { input = validateOptions(payload); }
        catch (error) { return send(res, 400, { error: error.message }); }
        if (url.pathname === '/api/checks') return send(res, 200, await check(input));
        try { return send(res, 202, { id: await jobs.create(input) }); }
        catch (error) { return send(res, 409, { error: error.message }); }
      }
      const asset = staticFiles[url.pathname];
      if (req.method === 'GET' && asset) {
        const content = await readFile(join(root, 'public', asset[0]));
        res.writeHead(200, { 'Content-Type': asset[1], 'Cache-Control': 'no-cache' });
        return res.end(content);
      }
      return send(res, 404, { error: '页面不存在。' });
    } catch (error) { return send(res, 500, { error: error.message }); }
  });
  server.requestTimeout = 30_000;
  server.shutdownTasks = async () => {
    closing = true;
    desktop.shutdown();
    cloneTask?.controller.abort();
    transfer?.controller.abort();
    await Promise.allSettled([jobs.shutdown(), settings.pending, projectConfig.pending, runtime.shutdown(), operations.shutdown(),
      cloneTask?.done, transfer?.done, ...removals.values(), ...configWrites.values()]);
  };
  server.jobs = jobs;
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const port = Number(process.env.PORT || 4310);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be an integer between 1 and 65535.');
  const server = createApp();
  server.on('error', error => { console.error(error.code === 'EADDRINUSE' ? `Port ${port} is occupied. Set PORT and try again.` : error.message); process.exitCode = 1; });
  server.listen(port, '127.0.0.1', () => console.log(`\n  StackForge ${identity.version}\n  Open http://127.0.0.1:${port}\n  Ctrl+C to stop\n`));
  for (const event of ['SIGINT', 'SIGTERM']) process.on(event, async () => { await server.shutdownTasks(); server.close(() => process.exit(0)); });
}
