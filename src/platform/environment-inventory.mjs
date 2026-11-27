import { win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findPathExecutable } from './paths.mjs';
import { npmCommand, run } from './process.mjs';
import { meetsToolMinimum, toolMinimums } from './tool-versions.mjs';

const cwd = fileURLToPath(new URL('.', import.meta.url));
const version = /^v?([0-9]{1,5}(?:\.[0-9]{1,6}){0,4}(?:\.[a-z][a-z0-9]*(?:\.\d+)?|(?:p|rc)\d+|[-+][a-z0-9][a-z0-9.+-]{0,35})?)(?=\s|$|,)/i;
const groups = {
  workspace: [
    ['node', 'Node.js'], ['npm', 'npm'], ['git', 'Git', 'git version'], ['gh', 'GitHub CLI', 'gh version'],
    ['docker', 'Docker CLI', 'Docker version'], ['docker-compose', 'Docker Compose', 'Docker Compose version', ['compose', 'version', '--short']]
  ],
  toolchains: [
    ['pnpm', 'pnpm'], ['yarn', 'Yarn'], ['bun', 'Bun'], ['java', 'Java JDK', 'javac', ['-version']],
    ['mvn', 'Maven', 'Apache Maven', ['-v']], ['gradle', 'Gradle', 'Gradle'], ['python', 'Python', 'Python'],
    ['uv', 'uv', 'uv'], ['dotnet', '.NET SDK', '', ['--list-sdks']], ['go', 'Go', 'go version go', ['version']],
    ['cargo', 'Cargo', 'cargo'], ['php', 'PHP', 'PHP'], ['composer', 'Composer', 'Composer version'],
    ['ruby', 'Ruby', 'ruby'], ['bundle', 'Bundler', 'Bundler version']
  ],
  databases: [
    ['psql', 'PostgreSQL (psql)', 'psql (PostgreSQL)'], ['mysql', 'MySQL client', 'mysql', ['--version']],
    ['sqlcmd', 'SQL Server (sqlcmd)', 'Version', ['-?']], ['mongosh', 'MongoDB Shell'], ['redis-cli', 'Redis CLI', 'redis-cli']
  ]
};

function readVersion(id, output, prefix = '') {
  const lines = output.split(/\r?\n/).map(line => line.trim());
  if (id === 'dotnet') return lines.reverse().find(line => /^\d+\.\d+\.\d+[^\s]*\s+\[/.test(line))?.match(version)?.[1];
  for (const line of lines) {
    let value = line;
    if (id === 'mysql') {
      value = /^mysql(?:\.exe)?\b.*?\bDistrib\s+(\S+)/i.exec(line)?.[1] ??
        /^mysql(?:\.exe)?\s+(?:Ver\s+)?(.+)$/i.exec(line)?.[1] ?? '';
    } else if (prefix && line.toLowerCase().startsWith(prefix.toLowerCase())) value = line.slice(prefix.length).trim();
    else if (id === 'sqlcmd' && /^sqlcmd:\s*v?\d/i.test(line)) value = line.slice(7).trim();
    else if (prefix && id !== 'docker-compose' && id !== 'sqlcmd') continue;
    const found = version.exec(value);
    if (found) return found[1];
  }
}

export async function inspectLocalTools({ ids, platform = process.platform, env = process.env, architecture = process.arch,
  nodeVersion = process.versions.node, nodePath = process.execPath, find = findPathExecutable, command = run, npm = npmCommand } = {}) {
  const offline = { ...env, COREPACK_ENABLE_NETWORK: '0', COREPACK_DEFAULT_TO_LATEST: '0', COREPACK_ENABLE_AUTO_PIN: '0',
    COREPACK_ENABLE_PROJECT_SPEC: '0', COREPACK_ENV_FILE: '0', GOTOOLCHAIN: 'local', RUSTUP_AUTO_INSTALL: '0',
    DOTNET_CLI_TELEMETRY_OPTOUT: '1', DOTNET_NOLOGO: '1', DOTNET_GENERATE_ASPNET_CERTIFICATE: 'false',
    YARN_ENABLE_TELEMETRY: '0', YARN_IGNORE_PATH: '1', npm_config_offline: 'true',
    GH_NO_UPDATE_NOTIFIER: '1', GH_TELEMETRY: 'false' };
  const lookups = new Map();
  const resolve = name => {
    if (!lookups.has(name)) lookups.set(name, find(name, { platform, env }));
    return lookups.get(name);
  };
  async function probe(path, args) {
    const shell = platform === 'win32' && /\.(?:cmd|bat)$/i.test(win32.extname(path));
    const config = { cwd, env: offline, timeout: 4500 };
    // Expand the resolved path once as data, without interpolating it into cmd's command text.
    return shell ? command(env.ComSpec ?? env.COMSPEC ?? 'cmd.exe',
      ['/d', '/s', '/v:off', '/c', '""%STACKFORGE_PROBE_BINARY%" ' + args.join(' ') + '"'],
      { ...config, env: { ...offline, STACKFORGE_PROBE_BINARY: path }, windowsVerbatimArguments: true }) : command(path, args, config);
  }
  async function inspect(group, [id, name, prefix, args = ['--version']]) {
    const minimum = toolMinimums[id];
    const row = { id, name, group, ...(minimum && { minimum: minimum.join('.') }) };
    const found = (value, path) => ({ ...row, path, ...(value && { version: value }),
      status: !value ? 'unverified' : meetsToolMinimum(id, value) ? 'available' : 'outdated' });
    if (id === 'node') return found(nodeVersion, nodePath);
    let path;
    try {
      if (id === 'npm') {
        let invocation;
        try { invocation = npm(); } catch { return { ...row, status: 'missing' }; }
        const executable = invocation.prefix.length ? invocation.command : await resolve(invocation.command);
        if (!executable) return { ...row, status: 'missing' };
        path = invocation.prefix[0] ?? executable;
        return found(readVersion(id, await probe(executable, [...invocation.prefix, ...args])), path);
      }
      if (id === 'python') {
        for (const alias of platform === 'win32' ? ['python', 'python3'] : ['python3', 'python']) {
          const candidate = await resolve(alias);
          if (!candidate) continue;
          path ??= candidate;
          const detected = await probe(candidate, args).then(output => readVersion(id, output, prefix)).catch(() => undefined);
          if (detected) return found(detected, candidate);
        }
        return { ...row, ...(path && { path }), status: path ? 'unavailable' : 'missing' };
      }
      path = await resolve(({ java: 'javac', 'docker-compose': 'docker' })[id] ?? id);
      if (!path) return { ...row, status: 'missing' };
      if (id === 'sqlcmd') {
        const detected = await probe(path, ['--version']).then(output => readVersion(id, output, prefix)).catch(() => undefined);
        if (detected) return found(detected, path);
      }
      return found(readVersion(id, await probe(path, args), prefix), path);
    } catch { return { ...row, ...(path && { path }), status: 'unavailable' }; }
  }
  const entries = Object.entries(groups).flatMap(([group, list]) =>
    list.filter(([id]) => !ids || ids.includes(id)).map(tool => [group, tool]));
  const tools = new Array(entries.length);
  let index = 0;
  await Promise.all(Array.from({ length: 5 }, async () => {
    while (index < entries.length) {
      const slot = index++;
      tools[slot] = await inspect(...entries[slot]);
    }
  }));
  return { platform, architecture, checkedAt: new Date().toISOString(), tools };
}

export function localEnvironmentInventory(options) {
  let pending;
  return () => pending ??= inspectLocalTools(options).finally(() => { pending = undefined; });
}
