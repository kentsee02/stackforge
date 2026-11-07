import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function openBrowser(url) {
  const [command, args] = process.platform === 'win32' ? ['rundll32.exe', ['url.dll,FileProtocolHandler', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, stdio: 'ignore' });
    child.once('error', reject); child.once('close', code => code === 0 ? resolve() : reject(new Error('Could not open the browser automatically.')));
  });
}

export async function launch({ port = 4310, directory = join(root, '.stackforge'), open = openBrowser, appOptions = {}, attempts = 20 } = {}) {
  const { createApp, identity } = await import('../src/server.mjs');
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Port must be an integer between 0 and 65535.');
  const marker = join(directory, 'launcher.json');
  const isOurs = async url => {
    if (!/^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(url)) return false;
    try {
      const response = await fetch(url + '/api/identity', { signal: AbortSignal.timeout(700) });
      const remote = await response.json();
      return response.ok && remote.application === identity.application && remote.project === identity.project && remote.version === identity.version;
    } catch { return false; }
  };
  let previous;
  try { previous = JSON.parse(await readFile(marker, 'utf8')).url; } catch { /* first launch */ }
  if (previous && await isOurs(previous)) { if (open) await open(previous); return { url: previous, reused: true }; }
  for (let offset = 0; offset < attempts && port + offset <= 65535; offset++) {
    const candidate = port === 0 ? 0 : port + offset;
    const candidateUrl = `http://127.0.0.1:${candidate}`;
    if (candidate && await isOurs(candidateUrl)) { if (open) await open(candidateUrl); return { url: candidateUrl, reused: true }; }
    const server = createApp(appOptions);
    await server.jobs.ready;
    try {
      await new Promise((resolve, reject) => {
        const fail = error => { server.off('listening', ready); reject(error); };
        const ready = () => { server.off('error', fail); resolve(); };
        server.once('error', fail); server.once('listening', ready); server.listen(candidate, '127.0.0.1');
      });
    } catch (error) { if (error.code === 'EADDRINUSE') continue; throw error; }
    const url = `http://127.0.0.1:${server.address().port}`;
    try { await mkdir(directory, { recursive: true }); await writeFile(marker, JSON.stringify({ url }), { mode: 0o600 }); }
    catch (error) { await new Promise(resolve => server.close(resolve)); throw error; }
    if (open) {
      try { await open(url); } catch { console.log(`Open ${url} in your browser.`); }
    }
    return { url, server, reused: false };
  }
  throw new Error('All candidate ports are occupied. Close an old service or set PORT to another port.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || major === 22 && minor < 12) {
    console.error('Node.js 22.12 or later is required. Install Node.js 24 LTS: https://nodejs.org/en/download');
    process.exitCode = 1;
  } else {
    try {
      const { url, server, reused } = await launch({ port: Number(process.env.PORT || 4310), open: process.env.STACKFORGE_NO_BROWSER === '1' ? false : openBrowser });
      console.log(`\nStackForge 0.15.0\n${url}\n${reused ? 'Opened the existing service.' : 'Keep this window open. Press Ctrl+C to stop; unfinished tasks can be resumed.'}\n`);
      if (server) for (const event of ['SIGINT', 'SIGTERM']) process.on(event, async () => { await server.shutdownTasks(); server.close(() => process.exit(0)); });
    } catch (error) { console.error(error.message); process.exitCode = 1; }
  }
}
