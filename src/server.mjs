import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { catalog, validateOptions } from './catalog.mjs';
import { generateProject } from './generator.mjs';
import { checkEnvironment } from './environment.mjs';
import { publishProject } from './git.mjs';
import { run } from './process.mjs';
import { Jobs } from './jobs.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const identity = { application: 'stackforge-local', version: '0.3.0', project: createHash('sha256').update(process.platform === 'win32' ? root.toLowerCase() : root).digest('hex') };
const staticFiles = { '/': ['index.html', 'text/html; charset=utf-8'], '/app.js': ['app.js', 'text/javascript; charset=utf-8'], '/template-store.js': ['template-store.js', 'text/javascript; charset=utf-8'], '/style.css': ['style.css', 'text/css; charset=utf-8'], '/plex-latin.woff2': ['plex-latin.woff2', 'font/woff2'] };

export function createApp({ generate = generateProject, check = checkEnvironment, publish = (path, options, report, { signal } = {}) => publishProject(path, options, report, (name, args, config = {}) => run(name, args, { ...config, signal })), defaultDir = resolve(root, 'projects'), stateDir = resolve(root, '.stackforge/jobs') } = {}) {
  const token = randomBytes(32).toString('hex');
  const jobs = new Jobs({ directory: stateDir, generate, check, publish });
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
      await jobs.ready;
      const url = new URL(req.url, `http://${req.headers.host}`);
      if (req.method === 'GET' && url.pathname === '/api/identity') return send(res, 200, identity);
      if (req.method === 'GET' && url.pathname === '/api/state') return send(res, 200, { catalog, token, defaultDir, node: process.version, platform: process.platform, version: identity.version, jobs: jobs.list() });
      if (req.method === 'GET' && url.pathname === '/api/jobs') return send(res, 200, jobs.list());
      if (req.method === 'GET' && url.pathname.startsWith('/api/jobs/')) {
        const job = jobs.view(url.pathname.slice('/api/jobs/'.length));
        return send(res, job ? 200 : 404, job ?? { error: '找不到这个创建任务。' });
      }
      if (req.method === 'POST' && (['/api/projects', '/api/checks'].includes(url.pathname) || /^\/api\/jobs\/[^/]+\/(publish|retry|cancel)$/.test(url.pathname))) {
        const origin = req.headers.origin;
        if ((origin && origin !== `http://${req.headers.host}`) || req.headers['x-stackforge-token'] !== token || req.headers['content-type']?.split(';')[0] !== 'application/json') return send(res, 403, { error: '请求来源无效，请刷新本机页面后重试。' });
        if (jobs.busy && !['/api/checks'].includes(url.pathname) && !url.pathname.endsWith('/cancel')) return send(res, 409, { error: '已有任务正在执行，请等待或取消。' });
        const chunks = []; let size = 0;
        for await (const chunk of req) { size += chunk.length; if (size > 16384) return send(res, 413, { error: '请求内容过大。' }); chunks.push(chunk); }
        const body = Buffer.concat(chunks).toString('utf8');
        if (/\/(publish|retry|cancel)$/.test(url.pathname)) {
          const id = url.pathname.split('/')[3];
          try {
            if (url.pathname.endsWith('/cancel')) await jobs.cancel(id);
            else await jobs.retry(id, url.pathname.endsWith('/publish'));
            return send(res, 202, { id });
          } catch (error) { return send(res, 400, { error: error.message }); }
        }
        let input;
        try { input = validateOptions(JSON.parse(body)); }
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
  server.shutdownTasks = () => jobs.shutdown();
  server.jobs = jobs;
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const port = Number(process.env.PORT || 4310);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT 必须为 1–65535 之间的整数。');
  const server = createApp();
  server.on('error', error => { console.error(error.code === 'EADDRINUSE' ? `端口 ${port} 已被占用，请设置 PORT 后重试。` : error.message); process.exitCode = 1; });
  server.listen(port, '127.0.0.1', () => console.log(`\n  StackForge ${identity.version}\n  打开 http://127.0.0.1:${port}\n  Ctrl+C 停止服务\n`));
  for (const event of ['SIGINT', 'SIGTERM']) process.on(event, async () => { await server.shutdownTasks(); server.close(() => process.exit(0)); });
}
