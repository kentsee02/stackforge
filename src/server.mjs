import { createServer } from 'node:http';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { randomBytes, createHash, randomUUID } from 'node:crypto';
import { catalog, validateOptions } from './catalog.mjs';
import { generateProject } from './generator.mjs';
import { checkEnvironment } from './environment.mjs';
import { publishProject } from './git.mjs';
import { run } from './process.mjs';
import { Jobs } from './jobs.mjs';
import { absoluteDirectory, defaultProjectsDirectory } from './paths.mjs';
import { Settings } from './settings.mjs';
import { createDesktop } from './desktop.mjs';
import { ProjectRuntime, inspectRecordedProject, readProjectFolder, developmentScript, startupDiagnostic } from './project-runtime.mjs';
import { ProjectConfig, defaultPorts, validatePorts, importedProject, projectPathKey } from './project-config.mjs';
import { ProjectOperations } from './project-operations.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const identity = { application: 'stackforge-local', version: '0.13.0', project: createHash('sha256').update(process.platform === 'win32' ? root.toLowerCase() : root).digest('hex') };
const staticFiles = { '/': ['index.html', 'text/html; charset=utf-8'], '/app.js': ['app.js', 'text/javascript; charset=utf-8'], '/i18n.js': ['i18n.js', 'text/javascript; charset=utf-8'], '/messages.js': ['messages.js', 'text/javascript; charset=utf-8'], '/template-store.js': ['template-store.js', 'text/javascript; charset=utf-8'], '/style.css': ['style.css', 'text/css; charset=utf-8'], '/plex-regular.ttf': ['plex-regular.ttf', 'font/ttf'], '/plex-semibold.ttf': ['plex-semibold.ttf', 'font/ttf'] };
staticFiles['/projects'] = ['projects.html', 'text/html; charset=utf-8'];
staticFiles['/projects.js'] = ['projects.js', 'text/javascript; charset=utf-8'];

async function locationExists(path) {
  try { await lstat(path); return true; }
  catch (error) { return !['ENOENT', 'ENOTDIR'].includes(error.code); }
}

export function createApp({ generate = generateProject, check = checkEnvironment, publish = (path, options, report, { signal } = {}) => publishProject(path, options, report, (name, args, config = {}) => run(name, args, { ...config, signal })), defaultDir = defaultProjectsDirectory(), stateDir = resolve(root, '.stackforge/jobs'), settingsFile = stateDir ? join(dirname(stateDir), 'settings.json') : false, desktop = createDesktop(), runtime = new ProjectRuntime(), operations = new ProjectOperations() } = {}) {
  const token = randomBytes(32).toString('hex');
  const jobs = new Jobs({ directory: stateDir, generate, check, publish });
  const settings = new Settings(settingsFile);
  const projectConfig = new ProjectConfig(stateDir ? join(dirname(stateDir), 'projects.json') : false);
  const removals = new Map();
  const portWrites = new Map();
  let closing = false;
  function managedProjects() {
    const created = jobs.projects();
    const paths = new Set(created.map(project => projectPathKey(project.path)));
    return [...projectConfig.value.imports.filter(project => !paths.has(projectPathKey(project.path))), ...created];
  }
  async function registerProject(path) {
    let project;
    try {
      const { directory, manifest } = await readProjectFolder(absoluteDirectory(path));
      await developmentScript(directory);
      project = importedProject(randomUUID(), directory, manifest.options);
    } catch { throw new Error('Choose a StackForge project folder with a valid stackforge.json and development script.'); }
    const existing = await Promise.all(jobs.projects().map(item => realpath(item.path).catch(() => item.path)));
    if (existing.some(item => projectPathKey(item) === projectPathKey(project.path))) throw new Error('This folder is already in Projects.');
    await projectConfig.addProject(project);
    return project;
  }
  function send(res, status, value) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(value));
  }
  const server = createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    const validHosts = [`127.0.0.1:${req.socket.localPort}`, `localhost:${req.socket.localPort}`];
    if (!validHosts.includes(req.headers.host)) return send(res, 403, { error: '只允许从本机地址访问。' });
    try {
      await Promise.all([jobs.ready, settings.ready, projectConfig.ready]);
      const url = new URL(req.url, `http://${req.headers.host}`);
      if (req.method === 'GET' && url.pathname === '/api/identity') return send(res, 200, identity);
      if (req.method === 'GET' && url.pathname === '/api/state') return send(res, 200, { catalog, token, defaultDir, node: process.version, platform: process.platform, version: identity.version, jobs: jobs.list(), preferences: settings.value, desktop: await desktop.capabilities() });
      if (req.method === 'GET' && url.pathname === '/api/projects') {
        const selected = url.searchParams.get('logs');
        const projects = await Promise.all(managedProjects().map(async project => {
          const deleting = removals.has(project.path);
          const session = runtime.status(project, project.id === selected);
          if (!deleting && !['starting', 'running', 'stopping'].includes(session.status) && !await locationExists(project.path)) return;
          const detail = { ...project, ...session, ...operations.status(project, project.id === selected), deleting };
          if (project.id === selected) {
            const info = await inspectRecordedProject(project).catch(() => null);
            Object.assign(detail, { portDefaults: defaultPorts(project), ports: projectConfig.ports(project), canConfigurePorts: info?.manifest.portConfig === 1 });
          }
          return detail;
        }));
        return send(res, 200, { projects: projects.filter(Boolean) });
      }
      const projectView = /^\/api\/projects\/([^/]+)\/(database|checks|git)$/.exec(url.pathname);
      if (req.method === 'GET' && projectView) {
        const [, id, view] = projectView;
        const project = managedProjects().find(item => item.id === id);
        if (!project) return send(res, 404, { error: 'This project was not found in StackForge.' });
        try {
          if (view === 'checks') return send(res, 200, { checks: await operations.checks(project) });
          if (view === 'git') return send(res, 200, await operations.git(project));
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
      const projectAction = /^\/api\/projects\/([^/]+)\/(start|stop|trash|ports|install|install-cancel|database-start|database-stop|run-check|check-cancel)$/.exec(url.pathname);
      if (req.method === 'POST' && (projectAction || ['/api/projects', '/api/projects/import', '/api/checks', '/api/preferences', '/api/desktop/pick-directory'].includes(url.pathname) || /^\/api\/jobs\/[^/]+\/(publish|retry|cancel|open)$/.test(url.pathname))) {
        const origin = req.headers.origin;
        if ((origin && origin !== `http://${req.headers.host}`) || req.headers['x-stackforge-token'] !== token || req.headers['content-type']?.split(';')[0] !== 'application/json') return send(res, 403, { error: '请求来源无效，请刷新本机页面后重试。' });
        if (jobs.busy && (['/api/projects', '/api/desktop/pick-directory'].includes(url.pathname) || /\/(publish|retry)$/.test(url.pathname))) return send(res, 409, { error: '已有任务正在执行，请等待或取消。' });
        const chunks = []; let size = 0;
        for await (const chunk of req) { size += chunk.length; if (size > 16384) return send(res, 413, { error: '请求内容过大。' }); chunks.push(chunk); }
        const body = Buffer.concat(chunks).toString('utf8');
        let payload;
        try { payload = JSON.parse(body); if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error(); }
        catch { return send(res, 400, { error: 'Invalid JSON request.' }); }
        if (removals.size && (['/api/projects', '/api/projects/import'].includes(url.pathname) || /\/api\/jobs\/[^/]+\/(publish|retry|open)$/.test(url.pathname))) return send(res, 409, { error: 'Wait for the project to finish moving to the trash.' });
        if (url.pathname === '/api/projects/import') {
          if (closing || jobs.busy) return send(res, 409, { error: 'Wait for StackForge to finish its current task.' });
          try { return send(res, 201, await registerProject(payload.path)); }
          catch (error) { return send(res, 400, { error: error.message }); }
        }
        if (projectAction) {
          const [, id, action] = projectAction;
          const project = managedProjects().find(item => item.id === id);
          if (!project) return send(res, 404, { error: 'This project was not found in StackForge.' });
          if (removals.has(project.path)) return send(res, 409, { error: 'Wait for the project to finish moving to the trash.' });
          if (portWrites.has(project.path)) return send(res, 409, { error: 'Wait for the project ports to finish saving.' });
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
              operations.start(project, action, projectConfig.ports(project), payload.check);
              return send(res, 202, operations.status(project, true));
            } catch (error) { return send(res, 409, { error: error.message }); }
          }
          if (action === 'ports') {
            if (closing || ['starting', 'running', 'stopping'].includes(runtime.status(project).status)) return send(res, 409, { error: 'Stop the project before changing its ports.' });
            const saving = (async () => {
              const ports = validatePorts(project, payload.ports);
              const { manifest } = await inspectRecordedProject(project);
              if (manifest.portConfig !== 1) throw new Error('This project uses an older launcher with fixed app ports.');
              await projectConfig.savePorts(project, ports);
              return ports;
            })();
            portWrites.set(project.path, saving);
            try { return send(res, 200, { ports: await saving }); }
            catch (error) { return send(res, 400, { error: error.message }); }
            finally { portWrites.delete(project.path); }
          }
          if (action === 'trash') {
            if (payload.confirmName !== project.name) return send(res, 400, { error: 'Enter the exact project name to confirm deletion.' });
            if (closing || jobs.busy) return send(res, 409, { error: 'Wait for StackForge to finish its current task.' });
            if (['starting', 'running', 'stopping'].includes(runtime.status(project).status)) return send(res, 409, { error: 'Stop the project before moving it to the trash.' });
            const moving = (async () => {
              const info = await inspectRecordedProject(project);
              const databaseDeleted = project.database !== 'none' && await operations.removeDatabase(project, projectConfig.ports(project), info);
              try {
                await desktop.trashProject(info.directory);
                if (await locationExists(project.path)) throw new Error('The project is still at its original location. Check the system trash before retrying.');
              } catch (error) {
                if (databaseDeleted) throw new Error('The database was deleted, but the project folder could not be moved to the trash.');
                throw error;
              }
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
    await Promise.allSettled([jobs.shutdown(), settings.pending, projectConfig.pending, runtime.shutdown(), operations.shutdown(), ...removals.values(), ...portWrites.values()]);
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
