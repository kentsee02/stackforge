import { access, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { createServer } from 'node:net';
import { validateOptions } from './catalog.mjs';
import { run, npm as runNpm, throwIfCancelled } from './process.mjs';
import { gitIdentity, githubAccount } from './git.mjs';

const help = {
  node: 'https://nodejs.org/en/download', git: 'https://git-scm.com/downloads',
  java: 'https://adoptium.net/temurin/releases/?version=21', docker: 'https://docs.docker.com/desktop/',
  github: 'https://cli.github.com/'
};

export async function portAvailable(port) {
  return new Promise(resolve => {
    const probe = createServer();
    probe.once('error', () => resolve(false));
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)));
  });
}

export async function checkEnvironment(input, services = {}) {
  const options = validateOptions(input);
  const signal = services.signal;
  throwIfCancelled(signal);
  const command = (name, args, config = {}) => (services.run ?? run)(name, args, { ...config, signal });
  const npm = (args, config = {}) => (services.npm ?? runNpm)(args, { ...config, signal });
  const fetchImpl = services.fetchImpl ?? fetch;
  const probePort = services.portAvailable ?? portAvailable;
  const checks = [];
  const add = (id, label, status, detail, fix = '', url) => checks.push({ id, label, status, detail, fix, ...(url && { url }) });
  async function executable(id, label, task, required, fix, minimum) {
    try {
      const output = (await task()).trim();
      const version = output.match(/(?:version\s+)?["']?(\d+)(?:\.(\d+))?/i);
      if (minimum && (!version || !minimum(Number(version[1]), Number(version[2] || 0)))) throw new Error('版本不满足要求');
      add(id, label, 'ok', output.split(/\r?\n/).find(Boolean)?.slice(0, 180) || '可用');
    } catch {
      add(id, label, required ? 'error' : 'warning', '未安装、版本不满足要求或当前不可用', fix, help[id]);
    }
  }
  const tasks = [];
  const [major, minor] = (services.nodeVersion ?? process.versions.node).split('.').map(Number);
  add('node', 'Node.js', major > 22 || major === 22 && minor >= 12 ? 'ok' : 'error', services.nodeVersion ?? process.version, '安装 Node.js 22.12+，推荐 24 LTS。', help.node);
  const usesNpm = options.frontend !== 'none' || options.backend === 'express';
  if (usesNpm) tasks.push(executable('npm', 'npm', () => npm(['--version'], { timeout: 8000 }), options.install, '重新安装含 npm 的官方 Node.js。'));
  if (options.backend === 'spring') tasks.push(executable('java', 'Java JDK 21+', () => command('javac', ['-version'], { timeout: 8000 }), options.install, '安装 JDK 21+，并将 JAVA_HOME 和 JDK bin 加入环境变量。', version => version >= 21));
  if (options.git) tasks.push(executable('git', 'Git 2.28+', () => command('git', ['--version'], { timeout: 8000 }), true, '安装 Git 2.28+，然后重启工具；初始化本地仓库不需要登录。', (major, minor) => major > 2 || major === 2 && minor >= 28));
  if (options.commit) tasks.push((async () => {
    const identity = await gitIdentity(options, command);
    add('identity', 'Git 提交身份', identity.name && identity.email ? 'ok' : 'error', identity.name && identity.email ? `${identity.name} <${identity.email}>` : '缺少提交者姓名或邮箱', '在 Git 选项中填写姓名和邮箱；只应用到新项目，或取消首次提交。');
  })());
  if (options.database !== 'none') {
    tasks.push(executable('docker', 'Docker Compose v2', () => command('docker', ['compose', 'version', '--short'], { timeout: 8000 }), false, '安装 Docker Desktop 或 Compose v2；仍可先生成数据库配置。', version => version >= 2));
    tasks.push((async () => {
      try { const version = await command('docker', ['info', '--format', '{{.ServerVersion}}'], { timeout: 8000 }); add('docker-engine', 'Docker 引擎', 'ok', version.trim()); }
      catch { add('docker-engine', 'Docker 引擎', 'warning', '尚未启动或不可访问', '启动 Docker Desktop 后再运行生成项目的 npm run dev。', help.docker); }
    })());
  }
  const urls = [
    ...(usesNpm ? [['npm-network', 'npm 下载源', 'https://registry.npmjs.org/vite/latest']] : []),
    ...(options.backend === 'spring' ? [['spring-network', 'Spring Initializr', 'https://start.spring.io/metadata/client'], ...(options.install ? [['maven-network', 'Maven Central', 'https://repo.maven.apache.org/maven2/org/springframework/boot/spring-boot-starter-parent/maven-metadata.xml']] : [])] : [])
  ];
  for (const [id, label, url] of urls) tasks.push((async () => {
    try { const response = await fetchImpl(url, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(8000)]) : AbortSignal.timeout(8000) }); await response.body?.cancel(); if (!response.ok) throw new Error(); add(id, label, 'ok', '连接正常'); }
    catch { add(id, label, 'error', '无法连接下载源', '检查网络、代理与防火墙后点击重新检测。'); }
  })());
  for (const [port, label] of [...(options.frontend !== 'none' ? [[5173, '前端端口 5173']] : []), ...(options.backend !== 'none' ? [[8080, '后端端口 8080']] : []), ...(options.database !== 'none' ? [[options.database === 'mysql' ? 3306 : 5432, '数据库端口']] : [])]) tasks.push((async () => {
    const available = await probePort(port);
    add(`port-${port}`, label, available ? 'ok' : 'warning', available ? `${port} 可用` : `${port} 已占用或无法绑定`, '启动前停止占用端口的服务；数据库可在生成的 .env 中修改 DB_PORT。');
  })());
  tasks.push((async () => {
    try {
      if (!isAbsolute(options.parentDir)) throw new Error('保存目录必须为绝对路径。');
      let existing = resolve(options.parentDir);
      while (true) {
        try { const item = await stat(existing); if (!item.isDirectory()) throw new Error('保存位置不是目录。'); await access(existing, constants.W_OK); break; }
        catch (error) { if (error.code !== 'ENOENT') throw error; const next = dirname(existing); if (next === existing) throw error; existing = next; }
      }
      try { await stat(resolve(options.parentDir, options.name)); add('destination', '保存位置', 'error', '目标项目目录已存在', '更换项目名或保存目录，工具不会覆盖已有文件。'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; add('destination', '保存位置', 'ok', '可创建新目录'); }
    } catch (error) { add('destination', '保存位置', 'error', error.message, '选择可写的绝对路径。'); }
  })());
  if (options.publish) tasks.push((async () => {
    try {
      await command('gh', ['--version'], { timeout: 8000 });
      const account = await githubAccount(command);
      add('github', 'GitHub 认证', 'ok', `当前账号：${account}`);
      try {
        await command('gh', ['api', '--hostname', 'github.com', `repos/${account}/${options.repoName}`, '--jq', '.id'], { timeout: 15000 });
        add('repo-name', 'GitHub 仓库名称', 'error', `${account}/${options.repoName} 已存在`, '更换仓库名；工具只创建新仓库，不推送到已有仓库。');
      } catch (error) {
        if (/HTTP 404/.test(error.message)) add('repo-name', 'GitHub 仓库名称', 'ok', `${account}/${options.repoName} 可用`);
        else add('repo-name', 'GitHub 仓库名称', 'error', '无法确认仓库名称是否可用', '检查 GitHub 认证权限和网络后重试。');
      }
    } catch { add('github', 'GitHub 认证', 'error', 'GitHub CLI 未安装或尚未认证', '安装 gh，执行 gh auth login --hostname github.com，然后重新检测。', help.github); }
  })());
  await Promise.all(tasks);
  throwIfCancelled(signal);
  const priority = { error: 0, warning: 1, ok: 2 };
  checks.sort((a, b) => priority[a.status] - priority[b.status] || a.id.localeCompare(b.id));
  return { canCreate: !checks.some(item => item.status === 'error'), checks, checkedAt: new Date().toISOString() };
}
