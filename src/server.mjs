import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { catalog, validateOptions } from './catalog.mjs';
import { generateProject } from './generator.mjs';
import { run } from './process.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const staticFiles = { '/': ['index.html', 'text/html; charset=utf-8'], '/app.js': ['app.js', 'text/javascript; charset=utf-8'], '/style.css': ['style.css', 'text/css; charset=utf-8'], '/plex-latin.woff2': ['plex-latin.woff2', 'font/woff2'] };

export function createApp({ generate = generateProject, defaultDir = resolve(root, 'projects') } = {}) {
  const token = randomBytes(32).toString('hex');
  const jobs = new Map();
  let busy = false;
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
      const url = new URL(req.url, `http://${req.headers.host}`);
      if (req.method === 'GET' && url.pathname === '/api/state') return send(res, 200, { catalog, token, defaultDir, node: process.version, platform: process.platform });
      if (req.method === 'GET' && url.pathname.startsWith('/api/jobs/')) {
        const job = jobs.get(url.pathname.slice('/api/jobs/'.length));
        return send(res, job ? 200 : 404, job ?? { error: '找不到这个创建任务。' });
      }
      if (req.method === 'POST' && url.pathname === '/api/projects') {
        const origin = req.headers.origin;
        if ((origin && origin !== `http://${req.headers.host}`) || req.headers['x-stackforge-token'] !== token || req.headers['content-type']?.split(';')[0] !== 'application/json') return send(res, 403, { error: '请求来源无效，请刷新本机页面后重试。' });
        if (busy) return send(res, 409, { error: '已有项目正在创建，请等待完成。' });
        let body = ''; let size = 0;
        for await (const chunk of req) { size += chunk.length; if (size > 16384) return send(res, 413, { error: '请求内容过大。' }); body += chunk; }
        let input;
        try { input = validateOptions(JSON.parse(body)); }
        catch (error) { return send(res, 400, { error: error.message }); }
        if (busy) return send(res, 409, { error: '已有项目正在创建，请等待完成。' });
        busy = true;
        const id = randomUUID();
        const job = { id, status: 'running', progress: 0, step: '准备创建项目', logs: [], createdAt: new Date().toISOString() };
        jobs.set(id, job);
        while (jobs.size > 20) jobs.delete(jobs.keys().next().value);
        send(res, 202, { id });
        Promise.resolve().then(() => generate(input, event => {
          if (event.type === 'step') { job.step = event.message; job.progress = event.progress; }
          job.logs.push(event.message.slice(-8000));
          if (job.logs.length > 300) job.logs.shift();
        })).then(result => { job.status = 'complete'; job.result = result; job.progress = 100; job.step = '项目已创建'; })
          .catch(error => { job.status = 'failed'; job.error = error.message; job.step = '创建失败'; })
          .finally(() => { busy = false; });
        return;
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
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const port = Number(process.env.PORT || 4310);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT 必须为 1–65535 之间的整数。');
  const server = createApp();
  server.on('error', error => { console.error(error.code === 'EADDRINUSE' ? `端口 ${port} 已被占用，请设置 PORT 后重试。` : error.message); process.exitCode = 1; });
  server.listen(port, '127.0.0.1', () => console.log(`\n  StackForge 0.1.0\n  打开 http://127.0.0.1:${port}\n  Ctrl+C 停止服务\n`));
}
