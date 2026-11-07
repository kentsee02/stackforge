import { mkdir, writeFile, mkdtemp, rename, rm, access, chmod, open, readFile, lstat } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { validateOptions } from './catalog.mjs';
import { extractZip } from './zip.mjs';
import { npm, run, throwIfCancelled } from './process.mjs';
import { initializeGit, publishProject } from './git.mjs';
import { createSteps, verifyStaging, wasPromoted, writeOwnedFiles } from './checkpoint.mjs';
import { json, frontendFiles, expressFiles, databaseFiles, devScript, generatedReadme } from './templates.mjs';

export async function download(url, { fetchImpl = fetch, binary = false, signal } = {}) {
  throwIfCancelled(signal);
  const response = await fetchImpl(url, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(45_000)]) : AbortSignal.timeout(45_000), headers: { Accept: binary ? 'application/zip' : 'application/json', 'User-Agent': 'StackForge/0.6.0' } });
  if (!response.ok) throw new Error(`下载失败（HTTP ${response.status}）：${new URL(url).hostname}`);
  if (binary) {
    const reader = response.body.getReader();
    const chunks = []; let length = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.length;
        if (length > 12 * 1024 * 1024) throw new Error('下载文件超过 12 MB 限制。');
        chunks.push(Buffer.from(value));
      }
    } finally { await reader.cancel().catch(() => {}); }
    return Buffer.concat(chunks);
  }
  return response.json();
}

export async function generateProject(input, report = () => {}, services = {}) {
  const options = validateOptions(input);
  const signal = services.signal;
  throwIfCancelled(signal);
  if (!isAbsolute(options.parentDir)) throw new Error('保存目录必须使用绝对路径。');
  const target = resolve(options.parentDir, options.name);
  const checkpoint = services.checkpoint ?? {};
  if (checkpoint.options && JSON.stringify(checkpoint.options) !== JSON.stringify(options)) throw new Error('恢复任务时不能更换项目配置，请新建任务。');
  checkpoint.options = options;
  const save = async () => services.onCheckpoint?.(checkpoint);
  const command = (name, args, config = {}) => (services.run ?? run)(name, args, { ...config, signal });
  const install = (args, config = {}) => (services.npm ?? npm)(args, { ...config, signal });
  const log = text => report({ type: 'log', message: text });
  const step = (message, progress) => report({ type: 'step', message, progress });
  const steps = createSteps(checkpoint, report, save, signal);
  const put = (root, files) => writeOwnedFiles(root, files, signal);
  if (!checkpoint.promoted && await wasPromoted(target, checkpoint.owner)) { checkpoint.promoted = true; await save(); }
  if (checkpoint.promoted) {
    const info = await lstat(target);
    const manifest = JSON.parse(await readFile(join(target, 'stackforge.json'), 'utf8'));
    if (!info.isDirectory() || info.isSymbolicLink() || manifest.generator !== 'StackForge' || manifest.options?.name !== options.name) throw new Error('已创建的项目位置或标识发生变化，已停止恢复。');
  }
  if (!checkpoint.promoted) {
    try { await access(target); throw new Error('目标目录已经存在，请更换项目名。'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (options.git) await command('git', ['--version']);
    if (checkpoint.staging) await verifyStaging(checkpoint.staging, options, checkpoint.owner);
    else {
      await mkdir(options.parentDir, { recursive: true });
      checkpoint.staging = await mkdtemp(join(options.parentDir, '.stackforge-'));
      checkpoint.owner = randomBytes(24).toString('hex');
      await writeFile(join(checkpoint.staging, '.stackforge-owner'), checkpoint.owner, { mode: 0o600 });
      await save();
    }
  }
  const staging = checkpoint.staging;
  const versions = checkpoint.versions ??= {};
  try {
    if (!checkpoint.promoted) {
    await steps('versions', '解析技术栈与依赖版本', 8, async () => {
    const packages = [];
    if (options.frontend !== 'none') packages.push('vite', 'typescript', ...(options.frontend === 'vue' ? ['vue', '@vitejs/plugin-vue'] : ['react', 'react-dom', '@vitejs/plugin-react', '@types/react', '@types/react-dom']));
    if (options.backend === 'express') packages.push('express', ...(options.database === 'none' ? [] : [options.database === 'mysql' ? 'mysql2' : 'pg']));
    const fetched = await Promise.allSettled(packages.filter(name => !versions[name]).map(async name => {
      const metadata = await download(`https://registry.npmjs.org/${encodeURIComponent(name)}/latest`, { ...services, signal });
      if (typeof metadata.version !== 'string' || !/^\d+\.\d+\.\d+([+-][a-zA-Z0-9.-]+)?$/.test(metadata.version)) throw new Error(`无法解析 ${name} 的版本。`);
      versions[name] = metadata.version;
      await save();
    }));
    const failure = fetched.find(item => item.status === 'rejected');
    if (failure) throw failure.reason;
    });
    if (options.frontend !== 'none') await steps('frontend', '生成 TypeScript 前端与 API 代理', 22, () => put(staging, frontendFiles(options, versions)));
    await steps('backend', '生成后端服务与连接配置', 35, async () => {
    if (options.backend === 'spring') {
      let boot = versions.springBoot;
      if (!boot) {
      const metadata = await download('https://start.spring.io/metadata/client', services);
      const stable = metadata.bootVersion?.values?.filter(version => /^\d+\.\d+\.\d+(\.RELEASE)?$/.test(version.id));
      // Some Initializr instances still advertise modern releases with a legacy
      // .RELEASE suffix. Maven Central uses plain versions for Boot 3 and 4.
      const advertised = stable?.find(v => v.id === metadata.bootVersion.default)?.id ?? stable?.[0]?.id;
      boot = advertised && Number(advertised.split('.')[0]) >= 3 ? advertised.replace(/\.RELEASE$/, '') : advertised;
      if (!boot || !metadata.javaVersion?.values?.some(version => version.id === '21')) throw new Error('Spring Initializr 暂未提供可用的稳定版本 / Java 21，请稍后重试。');
      versions.springBoot = boot;
      await save();
      }
      const packageName = options.groupId + '.app';
      const dependencies = ['web', ...(options.database !== 'none' ? ['jdbc', options.database === 'mysql' ? 'mysql' : 'postgresql'] : [])];
      const query = new URLSearchParams({ type: 'maven-project', language: 'java', bootVersion: boot, javaVersion: '21', groupId: options.groupId, artifactId: `${options.name}-api`, name: 'Application', packageName, packaging: 'jar', dependencies: dependencies.join(',') });
      const cachePath = join(staging, '.stackforge-cache/spring.zip');
      let zip;
      try { zip = await readFile(cachePath); }
      catch (error) {
        if (error.code !== 'ENOENT') throw error;
        zip = await download(`https://start.spring.io/starter.zip?${query}`, { ...services, binary: true });
        await mkdir(dirname(cachePath), { recursive: true });
        await writeFile(cachePath, zip);
      }
      try { await extractZip(zip, join(staging, 'backend')); }
      catch (error) { await rm(cachePath, { force: true }); throw error; }
      await chmod(join(staging, 'backend/mvnw'), 0o755);
      if (options.database !== 'none') {
        const pomPath = join(staging, 'backend/pom.xml');
        const pom = await readFile(pomPath, 'utf8');
        if (!pom.includes('</dependencies>')) throw new Error('Spring 项目的 Maven 配置不完整。');
        await writeFile(pomPath, pom.replace('</dependencies>', '\t<dependency>\n\t\t<groupId>com.h2database</groupId>\n\t\t<artifactId>h2</artifactId>\n\t\t<scope>test</scope>\n\t</dependency>\n\t</dependencies>'));
        await put(staging, { 'backend/src/test/resources/application.properties': 'spring.datasource.url=jdbc:h2:mem:stackforge_test;DB_CLOSE_DELAY=-1\nspring.datasource.username=sa\nspring.datasource.password=\n' });
      }
      let properties = 'spring.application.name=' + options.name + '\nserver.address=127.0.0.1\nserver.port=8080\n';
      if (options.database !== 'none') {
        const mysql = options.database === 'mysql';
        properties += 'spring.datasource.url=jdbc:' + (mysql ? 'mysql' : 'postgresql') + '://${DB_HOST:127.0.0.1}:${DB_PORT:' + (mysql ? '3306' : '5432') + '}/${DB_NAME:app}\nspring.datasource.username=${DB_USER:app}\nspring.datasource.password=${DB_PASSWORD}\n';
      }
      const path = 'backend/src/main/java/' + packageName.replaceAll('.', '/') + '/HealthController.java';
      await put(staging, {
        'backend/src/main/resources/application.properties': properties,
        [path]: `package ${packageName};\n\nimport java.util.Map;\nimport org.springframework.web.bind.annotation.GetMapping;\nimport org.springframework.web.bind.annotation.RestController;\n${options.database === 'none' ? '' : 'import org.springframework.jdbc.core.JdbcTemplate;\nimport org.springframework.http.ResponseEntity;\n'}\n@RestController\npublic class HealthController {\n${options.database === 'none' ? '' : '    private final JdbcTemplate jdbc;\n    public HealthController(JdbcTemplate jdbc) { this.jdbc = jdbc; }\n'}    @GetMapping("/api/health")\n    public Map<String, String> health() { return Map.of("status", "ok", "message", "Hello, ${options.name}! The frontend and backend are connected."); }\n${options.database === 'none' ? '' : `    @GetMapping("/api/db")\n    public ResponseEntity<Map<String, String>> database() {\n        try { jdbc.queryForObject("SELECT 1", Integer.class); return ResponseEntity.ok(Map.of("status", "ok", "database", "${options.database}")); }\n        catch (Exception ex) { return ResponseEntity.status(503).body(Map.of("status", "unavailable")); }\n    }\n`}}\n`
      });
    } else if (options.backend === 'express') await put(staging, expressFiles(options, versions));
    });
    await steps('files', '生成环境变量、开发脚本与说明', 52, async () => {
    if (options.database !== 'none') await put(staging, databaseFiles(options, randomBytes(24).toString('hex'), randomBytes(24).toString('hex')));
    const workspaces = [...(options.frontend !== 'none' ? ['frontend'] : []), ...(options.backend === 'express' ? ['backend'] : [])];
    await put(staging, {
      'package.json': json({ name: options.name, private: true, version: '0.1.0', type: 'module', engines: { node: '>=22.12.0' }, ...(workspaces.length > 0 && { workspaces }), scripts: { dev: 'node scripts/dev.mjs', ...(options.frontend !== 'none' && { build: 'npm run build --workspace frontend' }), ...(options.database !== 'none' && { 'db:up': 'docker compose up -d --wait', 'db:down': 'docker compose down' }) } }),
      '.gitignore': 'node_modules/\ndist/\ntarget/\n.env\n.env.*\n!.env.example\n.stackforge-owner\n.stackforge-cache/\n*.log\n.idea/\n.vscode/\n.DS_Store\n',
      'scripts/dev.mjs': devScript(options),
      'README.md': generatedReadme(options),
      'stackforge.json': json({ generator: 'StackForge', generatorVersion: '0.6.0', createdAt: new Date().toISOString(), options: { ...options, parentDir: undefined }, versions })
    });
    });
    if (options.install) {
      if (options.frontend !== 'none' || options.backend === 'express') await steps('npm', '安装 npm 依赖（可取消，失败后可继续）', 64, () => install(['install', '--no-audit', '--no-fund'], { cwd: staging, log }));
      if (options.backend === 'spring') {
        await steps('maven', '通过 Maven Wrapper 预下载 Java 依赖', 78, async () => {
        if (process.platform === 'win32') await command(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'mvnw.cmd -B -DskipTests dependency:go-offline'], { cwd: join(staging, 'backend'), log });
        else await command('./mvnw', ['-B', '-DskipTests', 'dependency:go-offline'], { cwd: join(staging, 'backend'), log });
        });
      }
    }
    if (options.git) {
      await steps('git', options.commit ? '初始化 Git 并创建首次提交' : '初始化 Git（本地操作，无需登录）', 94, () => initializeGit(staging, options, command, log));
    }
    throwIfCancelled(signal);
    // rename into place only after success; never merge into an existing folder.
    const lockPath = join(options.parentDir, `.${options.name}.stackforge.lock`);
    const lock = await open(lockPath, 'wx').catch(() => { throw new Error('同名项目正在创建，请等待后重试。'); });
    try {
      try { await access(target); throw new Error('目标目录已经存在，请更换项目名。'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      await rename(staging, target);
      checkpoint.promoted = true;
      await save();
    } finally { await lock.close(); await rm(lockPath, { force: true }); }
    }
    await rm(join(target, '.stackforge-owner'), { force: true });
    await rm(join(target, '.stackforge-cache'), { recursive: true, force: true });
    const result = checkpoint.result ??= { path: target, name: options.name, versions, installed: options.install, git: options.git, committed: options.commit, commands: [...(!options.install ? ['npm install'] : []), 'npm run dev'] };
    await save();
    throwIfCancelled(signal);
    if (options.publish && result.remote?.status !== 'published') {
      try { result.remote = await publishProject(target, options, report, command); }
      catch (error) { throwIfCancelled(signal); result.remote = { status: 'failed', error: error.message }; log('GitHub 发布未完成，本地项目已保留。\n' + error.message); }
    }
    await save();
    step(result.remote?.status === 'failed' ? '本地项目已创建，GitHub 发布未完成' : '项目已创建', 100);
    return result;
  } catch (error) {
    if (!services.checkpoint && !checkpoint.promoted && staging) await rm(staging, { recursive: true, force: true });
    await save();
    throwIfCancelled(signal);
    throw error;
  }
}
