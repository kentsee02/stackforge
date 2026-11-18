import { createServer } from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import metadata from '../../package.json' with { type: 'json' };
import { catalog } from '../generation/catalog.mjs';
import { generateProject } from '../generation/generator.mjs';
import { checkEnvironment } from '../generation/environment.mjs';
import { publishProject } from '../platform/git.mjs';
import { run } from '../platform/process.mjs';
import { Jobs } from '../generation/jobs.mjs';
import { defaultProjectsDirectory } from '../platform/paths.mjs';
import { Settings } from '../platform/settings.mjs';
import { createDesktop } from '../platform/desktop.mjs';
import { ProjectRuntime } from '../projects/project-runtime.mjs';
import { ProjectConfig, projectPathKey } from '../projects/project-config.mjs';
import { ProjectOperations } from '../projects/project-operations.mjs';
import { cloneGithub } from '../projects/project-clone.mjs';
import { createProjectRegistry } from '../projects/project-registry.mjs';
import { createProjectRemoval } from '../projects/project-removal.mjs';
import { createProjectQueries } from '../projects/project-queries.mjs';
import { discoverDatabases } from '../database/discovery.mjs';
import { createDatabaseWorkflows } from '../database/workflows.mjs';
import { serveAsset } from './assets.mjs';
import { createDatabaseRoutes } from './database-routes.mjs';
import { createProjectWorkflows } from '../projects/project-workflows.mjs';
import { createProjectRoutes, matchProjectAction } from './project-routes.mjs';
import { createGenerationRoutes } from './generation-routes.mjs';
import { send } from './response.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const identity = { application: 'stackforge-local', version: metadata.version, project: createHash('sha256').update(process.platform === 'win32' ? root.toLowerCase() : root).digest('hex') };

function retryPublication(path, options, report, { signal, verifyProject }) {
  const command = (name, args, config = {}) => run(name, args, { ...config, signal });
  return publishProject(path, options, report, command, verifyProject);
}

export function createApp({ generate = generateProject, check = checkEnvironment, publish = retryPublication, clone = cloneGithub, defaultDir = defaultProjectsDirectory(), stateDir = resolve(root, '.stackforge/jobs'), settingsFile = stateDir ? join(dirname(stateDir), 'settings.json') : false, desktop = createDesktop(), runtime = new ProjectRuntime(), operations = new ProjectOperations(), localDatabase = {}, databaseAdapters = {} } = {}) {
  const token = randomBytes(32).toString('hex');
  const settings = new Settings(settingsFile);
  const projectConfig = new ProjectConfig(stateDir ? join(dirname(stateDir), 'projects.json') : false);
  const jobs = new Jobs({ directory: stateDir, generate, check, publish, relocatedPath: id => projectConfig.value.locations[id] });
  const removals = new Map();
  const configWrites = new Map();
  let closing = false;
  const managedProjects = () => projects.list();
  const database = createDatabaseWorkflows({ stateDir, operations, databaseAdapters, projectConfig, managedProjects,
    runtime, removals, configWrites, localDatabase, isClosing: () => closing });
  const databaseRoutes = createDatabaseRoutes({ database, managedProjects, runtime });
  const isProjectBusy = project => removals.has(project.path) || configWrites.has(project.path) ||
    database.blocksProjectAction(project) || Boolean(operations.active(project));
  const isProjectRunning = project => ['starting', 'running', 'stopping'].includes(runtime.status(project).status);
  const projects = createProjectRegistry({ projectConfig, generatedProjects: () => jobs.projects(), isProjectBusy, isProjectRunning,
    discoverDatabases, syncDatabaseBindings: database.scan, cleanupReplacedClone: database.cleanupReplacedClone,
    guardDevelopmentRemoval: database.guardDevelopmentRemoval, configWrites });
  void projects.retryCloneCleanup();
  const removeProject = createProjectRemoval({ projectConfig, removals, isProjectBusy, isProjectRunning,
    trashProject: (...args) => desktop.trashProject(...args), isCreatingProject: () => jobs.busy,
    isRegistered: project => managedProjects().some(item => item.id === project.id && projectPathKey(item.path) === projectPathKey(project.path)),
    removeDatabaseProfiles: database.removeProfiles, removeDatabaseRegistration: database.removeRegistration,
    recordProfileCleanup: project => database.record(project, 'database-profile-cleanup'),
    guardDevelopmentRemoval: database.guardDevelopmentRemoval });

  const execute = createProjectWorkflows({ projectConfig, operations, runtime, removals, configWrites, removeProject,
    databaseBusy: database.blocksProjectAction, chooseDatabase: database.selectedCompose, recordDatabase: database.record,
    verifyDeletion: database.verifyDeletion, syncDatabaseBindings: database.scan,
    openProject: (...args) => desktop.openProject(...args) });
  const queries = createProjectQueries({ projects, projectConfig, operations, runtime, removals, databaseOperation: database.operation });
  const projectRoutes = createProjectRoutes({ projects, queries, databaseRoutes, removals,
    isCreatingProject: () => jobs.busy, clone, execute });
  const generationRoutes = createGenerationRoutes({ jobs, check, desktop });

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
      if (req.method === 'GET' && await projectRoutes.get(res, url)) return;
      if (req.method === 'POST' && await databaseRoutes.archive(req, res, url.pathname, authorized)) return;
      if (req.method === 'GET' && generationRoutes.get(res, url)) return;
      const projectAction = matchProjectAction(url.pathname);
      if (req.method === 'POST' && (projectAction || ['/api/projects', '/api/projects/import', '/api/projects/clone', '/api/projects/clone-cancel', '/api/checks', '/api/preferences', '/api/desktop/pick-directory'].includes(url.pathname) || /^\/api\/jobs\/[^/]+\/(publish|retry|cancel|open)$/.test(url.pathname))) {
        if (!authorized(req, 'application/json')) return send(res, 403, { error: '请求来源无效，请刷新本机页面后重试。' });
        if (jobs.busy && (['/api/projects', '/api/desktop/pick-directory'].includes(url.pathname) || /\/(publish|retry)$/.test(url.pathname))) return send(res, 409, { error: '已有任务正在执行，请等待或取消。' });
        const chunks = []; let size = 0;
        for await (const chunk of req) { size += chunk.length; if (size > 16384) return send(res, 413, { error: '请求内容过大。' }); chunks.push(chunk); }
        if (closing) return send(res, 409, { error: 'StackForge is shutting down.' });
        const body = Buffer.concat(chunks).toString('utf8');
        let payload;
        try { payload = JSON.parse(body); if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error(); }
        catch { return send(res, 400, { error: 'Invalid JSON request.' }); }
        if (projectRoutes.cloning && (['/api/projects', '/api/projects/import', '/api/projects/clone'].includes(url.pathname) || /\/api\/jobs\/[^/]+\/retry$/.test(url.pathname))) {
          return send(res, 409, { error: 'Wait for the GitHub clone to finish.' });
        }
        if (removals.size && (['/api/projects', '/api/projects/import'].includes(url.pathname) || /\/api\/jobs\/[^/]+\/(publish|retry|open)$/.test(url.pathname))) {
          const moving = [...removals.values()].some(removal => removal.moving);
          return send(res, 409, { error: moving ? 'Wait for the project to finish moving to the trash.' : 'Wait for StackForge to finish its current task.' });
        }
        if (projectAction || ['/api/projects/import', '/api/projects/clone', '/api/projects/clone-cancel'].includes(url.pathname)) {
          return await projectRoutes.post(req, res, url.pathname, projectAction, payload);
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
        return await generationRoutes.post(res, url, payload);
      }
      if (req.method === 'GET' && await serveAsset(res, url.pathname)) return;
      return send(res, 404, { error: '页面不存在。' });
    } catch (error) { return send(res, 500, { error: error.message }); }
  });
  server.requestTimeout = 30_000;
  server.shutdownTasks = async () => {
    closing = true;
    desktop.shutdown();
    const clone = projectRoutes.shutdown();
    await Promise.allSettled([jobs.shutdown(), settings.pending, projectConfig.pending, runtime.shutdown(), operations.shutdown(),
      clone, projects.pendingCleanup, ...Array.from(removals.values(), removal => removal.done), ...configWrites.values(), database.shutdown()]);
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
