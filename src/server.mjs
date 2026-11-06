import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { catalog, validateOptions } from './catalog.mjs';
import { generateProject } from './generator.mjs';
import { checkEnvironment } from './environment.mjs';
import { publishProject } from './git.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const staticFiles = { '/': ['index.html', 'text/html; charset=utf-8'], '/app.js': ['app.js', 'text/javascript; charset=utf-8'], '/template-store.js': ['template-store.js', 'text/javascript; charset=utf-8'], '/style.css': ['style.css', 'text/css; charset=utf-8'], '/plex-latin.woff2': ['plex-latin.woff2', 'font/woff2'] };

export function createApp({ generate = generateProject, check = checkEnvironment, publish = publishProject, defaultDir = resolve(root, 'projects') } = {}) {
  const token = randomBytes(32).toString('hex');
  const jobs = new Map();
  const optionsByJob = new Map();
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
      if (req.method === 'POST' && (['/api/projects', '/api/checks'].includes(url.pathname) || /^\/api\/jobs\/[^/]+\/publish$/.test(url.pathname))) {
        const origin = req.headers.origin;
        if ((origin && origin !== `http://${req.headers.host}`) || req.headers['x-stackforge-token'] !== token || req.headers['content-type']?.split(';')[0] !== 'application/json') return send(res, 403, { error: '请求来源无效，请刷新本机页面后重试。' });
        if (busy && url.pathname !== '/api/checks') return send(res, 409, { error: '已有项目正在创建，请等待完成。' });
        const chunks = []; let size = 0;
        for await (const chunk of req) { size += chunk.length; if (size > 16384) return send(res, 413, { error: '请求内容过大。' }); chunks.push(chunk); }
        const body = Buffer.concat(chunks).toString('utf8');
        if (url.pathname.endsWith('/publish')) {
          const id = url.pathname.split('/')[3];
          const job = jobs.get(id);
          const options = optionsByJob.get(id);
          if (!job || !options?.publish || job.result?.remote?.status !== 'failed') return send(res, 400, { error: '只有本次服务中发布失败的项目可以重试。' });
          if (busy) return send(res, 409, { error: '已有任务正在执行。' });
          busy = true; job.status = 'running'; job.step = '正在重试 GitHub 发布';
          send(res, 202, { id });
          Promise.resolve().then(() => publish(job.result.path, options, event => {
            if (event.type === 'step') { job.step = event.message; job.progress = event.progress; }
            job.logs.push(event.message.slice(-8000));
            if (job.logs.length > 300) job.logs.shift();
          })).then(remote => { job.result.remote = remote; })
            .catch(error => { job.result.remote = { status: 'failed', error: error.message }; })
            .finally(() => { busy = false; job.status = 'complete'; job.progress = 100; job.step = job.result.remote.status === 'published' ? 'GitHub 发布成功' : '本地项目已保留，GitHub 发布未完成'; });
          return;
        }
        let input;
        try { input = validateOptions(JSON.parse(body)); }
        catch (error) { return send(res, 400, { error: error.message }); }
        if (url.pathname === '/api/checks') return send(res, 200, await check(input));
        if (busy) return send(res, 409, { error: '已有项目正在创建，请等待完成。' });
        busy = true;
        let environment;
        try { environment = await check(input); }
        catch (error) { busy = false; return send(res, 500, { error: error.message }); }
        if (!environment.canCreate) { busy = false; return send(res, 422, { error: '创建前检查未通过，请处理标红的问题后重试。', environment }); }
        const id = randomUUID();
        const job = { id, status: 'running', progress: 0, step: '准备创建项目', logs: [], createdAt: new Date().toISOString() };
        jobs.set(id, job);
        optionsByJob.set(id, input);
        while (jobs.size > 20) { const oldest = jobs.keys().next().value; jobs.delete(oldest); optionsByJob.delete(oldest); }
        send(res, 202, { id });
        Promise.resolve().then(() => generate(input, event => {
          if (event.type === 'step') { job.step = event.message; job.progress = event.progress; }
          job.logs.push(event.message.slice(-8000));
          if (job.logs.length > 300) job.logs.shift();
        })).then(result => { job.status = 'complete'; job.result = result; job.progress = 100; job.step = result.remote?.status === 'failed' ? '本地项目已创建，GitHub 发布未完成' : '项目已创建'; })
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
  server.listen(port, '127.0.0.1', () => console.log(`\n  StackForge 0.2.0\n  打开 http://127.0.0.1:${port}\n  Ctrl+C 停止服务\n`));
}
