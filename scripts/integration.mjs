import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { parseEnv } from 'node:util';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import assert from 'node:assert/strict';
import { generateProject } from '../src/generator.mjs';
import { run, npm, terminateTree } from '../src/process.mjs';
import { portAvailable } from '../src/environment.mjs';

const github = process.argv.includes('--github');
const repoName = process.argv.find(arg => arg.startsWith('--repo-name='))?.slice(12);
const only = process.argv.find(arg => arg.startsWith('--only='))?.slice(7);
const runId = new Date().toISOString().replace(/\D/g, '').slice(0, 14) + '-' + randomUUID().slice(0, 6);
const directory = resolve('work/integration', runId);
const report = { runId, startedAt: new Date().toISOString(), results: [] };
await mkdir(directory, { recursive: true });
for (const port of [5173, 8080]) if (!await portAvailable(port)) throw new Error(`联调需要空闲端口 ${port}，请停止占用该端口的开发服务后重试。`);
await run('docker', ['info', '--format', '{{.ServerVersion}}'], { timeout: 15000 });

async function freePort() {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function waitFor(url, accept, child, logs) {
  const deadline = Date.now() + 240000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error('开发服务提前退出。\n' + logs());
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(6000) });
      if (response.ok) { const data = await response.json(); if (accept(data)) return data; }
    } catch { /* the backend may still be starting */ }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new Error(`等待接口超时：${url}\n${logs()}`);
}

const variants = [
  { id: 'node', frontend: 'vue', backend: 'express', database: 'postgres' },
  { id: 'java', frontend: 'react', backend: 'spring', database: 'mysql' },
  { id: 'nest', frontend: 'react', backend: 'nestjs', database: 'postgres' }
].filter(variant => !only || only === variant.id);
if (!variants.length) throw new Error('--only 仅支持 node、java 或 nest。');

try {
  for (const variant of variants) {
    const name = `sfg-${runId}-${variant.id}`;
    const options = { name, parentDir: directory, ...variant, install: true, git: true, commit: true, authorName: 'StackForge integration', authorEmail: 'stackforge-integration@example.invalid', publish: github && variant.id === 'node', repoName: repoName || name, visibility: 'private' };
    console.log(`\n验证 ${variant.frontend} + ${variant.backend} + ${variant.database}`);
    const result = await generateProject(options, event => { if (event.type === 'step') console.log(event.message); });
    const record = { stack: variant, path: result.path, versions: result.versions, checks: [], remote: result.remote };
    report.results.push(record);
    let child;
    let tail = '';
    const env = { ...process.env };
    delete env.COMPOSE_PROJECT_NAME;
    try {
      if (options.publish) {
        assert.equal(result.remote?.status, 'published', result.remote?.error);
        const fullName = result.remote.url.split('/').slice(-2).join('/');
        const remote = JSON.parse(await run('gh', ['api', `repos/${fullName}`, '--jq', '{private,archived}']));
        assert.equal(remote.private, true);
        const localSha = (await run('git', ['rev-parse', 'HEAD'], { cwd: result.path })).trim();
        const remoteSha = (await run('gh', ['api', `repos/${fullName}/commits/main`, '--jq', '.sha'])).trim();
        assert.equal(remoteSha, localSha);
        record.checks.push('github-private-repository-and-matching-commit');
      }
      const tracked = (await run('git', ['ls-files'], { cwd: result.path })).split(/\r?\n/);
      assert.equal(tracked.includes('.env'), false);
      assert.equal(tracked.includes('.stackforge-owner'), false);
      record.checks.push('secrets-and-recovery-files-excluded');
      await npm(['run', 'build'], { cwd: result.path });
      record.checks.push('frontend-production-build');
      if (variant.backend === 'nestjs') {
        await readFile(join(result.path, 'backend', 'dist', 'main.js'));
        record.checks.push('nestjs-production-build');
      }
      if (variant.backend === 'spring') {
        if (process.platform === 'win32') await run(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'mvnw.cmd -B test'], { cwd: join(result.path, 'backend') });
        else await run('./mvnw', ['-B', 'test'], { cwd: join(result.path, 'backend') });
        record.checks.push('spring-tests');
      }
      const envPath = join(result.path, '.env');
      await writeFile(envPath, (await readFile(envPath, 'utf8')).replace(/^DB_PORT=.*$/m, 'DB_PORT=' + await freePort()), { mode: 0o600 });
      child = spawn(process.execPath, ['scripts/dev.mjs'], { cwd: result.path, env, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
      for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { tail = (tail + data.toString()).slice(-12000); });
      child.once('error', error => { tail += error.message; });
      await waitFor('http://127.0.0.1:8080/api/health', data => data.status === 'ok' && data.message.includes(name), child, () => tail);
      record.checks.push('backend-health');
      await waitFor('http://127.0.0.1:5173/api/health', data => data.status === 'ok' && data.message.includes(name), child, () => tail);
      record.checks.push('frontend-proxy-to-backend');
      await waitFor('http://127.0.0.1:5173/api/db', data => data.status === 'ok' && data.database === variant.database, child, () => tail);
      record.checks.push('real-database-query-through-frontend-proxy');
      if (variant.backend === 'nestjs') {
        await run('docker', ['compose', 'stop', 'db'], { cwd: result.path, env, timeout: 30000 });
        const unavailable = await fetch('http://127.0.0.1:5173/api/db', { signal: AbortSignal.timeout(6000) });
        assert.equal(unavailable.status, 503);
        assert.equal((await unavailable.json()).status, 'unavailable');
        await run('docker', ['compose', 'up', '-d', '--wait', '--no-deps', 'db'], { cwd: result.path, env, timeout: 120000 });
        await waitFor('http://127.0.0.1:5173/api/db', data => data.status === 'ok' && data.database === variant.database, child, () => tail);
        record.checks.push('database-reconnect-after-restart');
      }
      const page = await fetch('http://127.0.0.1:5173');
      assert.match(await page.text(), /id="app"/);
      record.checks.push('frontend-html');
      console.log('通过：' + record.checks.join(', '));
    } finally {
      if (child) await terminateTree(child);
      await run('docker', ['compose', 'down'], { cwd: result.path, env, timeout: 120000 });
      record.databaseVolumeRetained = true;
      await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2));
    }
  }
  report.completedAt = new Date().toISOString(); report.status = 'passed';
} catch (error) { report.status = 'failed'; report.error = error.message; throw error; }
finally { await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2)); }
console.log(`\n联调完成：${join(directory, 'report.json')}`);
