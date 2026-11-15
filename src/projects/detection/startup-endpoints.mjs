import { realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { localText, npmManifest } from './project-detection.mjs';

export function localAccessPath(value) {
  return typeof value === 'string' && value.length <= 240 && /^\/(?!\/)/.test(value) && !/[\\\s\x00-\x1f\x7f]/.test(value);
}

export function literalPort(value) {
  if (!['string', 'number'].includes(typeof value) || !/^\d+$/.test(value)) return;
  const port = Number(value);
  if (port >= 1024 && port <= 65535) return port;
}

export function literalPath(value) {
  if (localAccessPath(value) && /^\/[a-z0-9_./~?&=%#+-]*$/i.test(value) && !/(?:^|\/)\.{1,2}(?:\/|[?#]|$)/.test(value)) return value;
}

export async function nestedText(folder, file) {
  if (dirname(file) === '.') return localText(folder, file);
  const directory = await realpath(join(folder, dirname(file))).catch(() => null);
  if (!directory) return '';
  const within = relative(folder, directory);
  if (isAbsolute(within) || within.split(sep)[0] === '..') return '';
  return localText(directory, basename(file));
}

export function uniqueValue(values, parse = value => value) {
  const parsed = values.map(parse);
  if (parsed.length && parsed[0] !== undefined && parsed.every(value => value === parsed[0])) return parsed[0];
}

function scalar(text) {
  const value = text.trim();
  return /^(?:"[^"\\]*"|'[^'\\]*')$/.test(value) ? value.slice(1, -1) : value;
}

// Read simple properties and indentation-based YAML. Keep duplicate and dynamic values
// so an ambiguous setting cannot be mistaken for a literal.
function settings(properties, yaml) {
  const values = new Map();
  const add = (key, value) => {
    if (!values.has(key)) values.set(key, []);
    values.get(key).push(scalar(value));
  };
  for (const [, key, value] of properties.matchAll(/^[ \t]*([\w.%-]+)[ \t]*[:=][ \t]*([^\r\n]*)/gm)) add(key, value);
  for (const text of yaml) {
    const parents = [];
    for (const line of text.split(/\r?\n/)) {
      if (/^\s*---\s*(?:#.*)?$/.test(line)) parents.length = 0;
      const match = /^( *)([\w.%-]+|"[\w.%-]+"|'[\w.%-]+')[ \t]*:[ \t]*(.*)$/.exec(line);
      if (!match) continue;
      const [, spaces, key, raw] = match;
      const value = raw.replace(/(?:^|[ \t]+)#.*$/, '').trim();
      while (parents.length && parents.at(-1).indent >= spaces.length) parents.pop();
      if (value) add([...parents.map(parent => parent.key), scalar(key)].join('.'), value);
      else parents.push({ indent: spaces.length, key: scalar(key) });
    }
  }
  return values;
}

export async function jvmEndpoint(folder, framework) {
  if (!['Spring Boot', 'Quarkus', 'Micronaut'].includes(framework)) return {};
  const [properties, ...yaml] = await Promise.all(['application.properties', 'application.yml', 'application.yaml']
    .map(file => nestedText(folder, 'src/main/resources/' + file)));
  const values = settings(properties, yaml);
  const read = (key, parse, profile) => {
    const parts = key.split('.');
    if (parts.slice(0, -1).some((_, index) => values.has(parts.slice(0, index + 1).join('.')))) return;
    return uniqueValue((profile && values.get(`${profile}.${key}`)) ?? values.get(key) ?? [], parse);
  };
  if (framework === 'Spring Boot') {
    const ssl = values.get('server.ssl.enabled');
    if (ssl?.some(value => value !== 'false') || (!ssl && (values.has('server.ssl.key-store') || values.has('server.ssl.bundle')))) return {};
    const port = read('server.port', literalPort);
    const contexts = [...(values.get('server.servlet.context-path') ?? []), ...(values.get('spring.webflux.base-path') ?? [])];
    const context = uniqueValue(contexts, literalPath);
    const docs = read('springdoc.swagger-ui.path', literalPath);
    const disabled = values.get('springdoc.swagger-ui.enabled')?.some(value => value !== 'true');
    const openPath = docs && !disabled && (!contexts.length || context) ? literalPath((context?.replace(/\/$/, '') ?? '') + docs) : undefined;
    return { port, openPath };
  }
  if (framework === 'Quarkus') {
    if (read('quarkus.http.insecure-requests', undefined, '%dev') === 'disabled') return {};
    return { port: read('quarkus.http.port', literalPort, '%dev'), openPath: read('quarkus.swagger-ui.path', literalPath, '%dev') };
  }
  return { port: read('micronaut.server.port', literalPort) };
}

export async function ktorEndpoint(folder, build) {
  const main = /\bmainClass\s*(?:\.set\s*\(\s*|=\s*)['"]([\w.]+)['"]/.exec(build)?.[1];
  if (!main) return {};
  if (!/^io\.ktor\.server\.\w+\.EngineMain$/.test(main)) {
    if (!/^(?:\w+\.)*\w+Kt$/.test(main)) return {};
    const entry = await nestedText(folder, `src/main/kotlin/${main.slice(0, -2).replaceAll('.', '/')}.kt`);
    if (!/\bEngineMain\.main\s*\(/.test(entry) || /\bembeddedServer\s*\(/.test(entry)) return {};
  }
  const [conf, yaml] = await Promise.all(['application.conf', 'application.yaml'].map(file => nestedText(folder, 'src/main/resources/' + file)));
  if (Boolean(conf) === Boolean(yaml)) return {};
  const hocon = conf.replace(/\/\/[^\r\n]*|#[^\r\n]*/g, '');
  if (/\binclude\b|\bdeployment\s*[:=]?\s*\{[^}]*\{/.test(hocon)) return {};
  const deployment = /\bktor\s*[:=]?\s*\{[^{}]*\bdeployment\s*[:=]?\s*\{([^{}]*)\}/.exec(hocon)?.[1] ?? '';
  const values = yaml ? settings('', [yaml]).get('ktor.deployment.port') ?? [] :
    [...deployment.matchAll(/(?:^|[\r\n,])\s*port\s*[:=]\s*([^\r\n,]*)/g)].map(([, value]) => scalar(value));
  return { port: uniqueValue(values, literalPort) };
}

const shellSyntax = /[;&|$<>`\r\n%]/;
const tlsFlag = /(?:^|\s)--(?:experimental-https|https|ssl)(?:=|\s|$)/;

function flag(text, names, parse) {
  const matches = [...text.matchAll(new RegExp(`(?:^|\\s)(?:${names})(?==|\\s|$)(?:=|\\s+)?([^\\s]*)`, 'g'))];
  return { present: Boolean(matches.length), value: uniqueValue(matches.map(([, value]) => scalar(value)), parse) };
}

// Inspect only a direct object export. Tokenize strings and comments as single items,
// then keep keys at the current depth so nested proxy and build settings cannot match.
function configObject(text, factory) {
  text = text.replace(/\/\*[\s\S]*?\*\/|^[ \t]*\/\/[^\r\n]*/gm, '');
  const direct = new RegExp(`^[ \\t]*export\\s+default\\s+(?:${factory}\\s*\\(\\s*)?\\{`, 'm').exec(text);
  const named = /(?:^|\n)[ \t]*export\s+default\s+(\w+)\s*;?\s*$/.exec(text);
  const declaration = named && new RegExp(`^[ \\t]*const\\s+${named[1]}(?:\\s*:\\s*[\\w.]+)?\\s*=\\s*\\{`, 'm').exec(text);
  const start = direct ?? declaration;
  if (!start) return [];
  return text.slice(start.index + start[0].length).match(/\/\*[\s\S]*?\*\/|\/\/[^\r\n]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\w+|\.{3}|[^\s]/g)
    ?.filter(token => !token.startsWith('//') && !token.startsWith('/*')) ?? [];
}

function property(tokens, key) {
  const matches = [];
  let depth = 0;
  let field = true;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (!depth && token === '}') break;
    if (!depth && field) {
      if (token === '...' || token === '[') return;
      if (scalar(token) === key && tokens[i + 1] === ':') matches.push(i + 2);
      field = false;
    }
    if (/^[{[(]$/.test(token)) depth++;
    if (/^[}\])]$/.test(token)) depth--;
    if (!depth && token === ',') field = true;
  }
  if (matches.length !== 1) return;
  const index = matches[0];
  if (tokens[index] === '{') {
    let depth = 1, end = index + 1;
    for (; depth && end < tokens.length; end++) {
      if (tokens[end] === '{') depth++;
      if (tokens[end] === '}') depth--;
    }
    if ([',', '}'].includes(tokens[end])) return tokens.slice(index + 1, end);
  }
  if ([',', '}'].includes(tokens[index + 1])) return scalar(tokens[index]);
}

async function webConfig(folder, name, factory) {
  const files = ['ts', 'js', 'mts', 'mjs', 'cts', 'cjs'];
  const contents = (await Promise.all(files.map(ext => localText(folder, `${name}.config.${ext}`)))).filter(Boolean);
  return contents.length === 1 ? configObject(contents[0], factory) : [];
}

async function angularEndpoint(folder, text, portFlag) {
  const pathFlag = flag(text, '--serve-path', literalPath);
  const config = npmManifest(await localText(folder, 'angular.json'));
  const project = /^ng\s+serve\s+(\w[\w-]*)(?:\s|$)/.exec(text)?.[1] ?? config?.defaultProject ??
    (Object.keys(config?.projects ?? {}).length === 1 ? Object.keys(config.projects)[0] : undefined);
  const entry = config?.projects?.[project];
  const serve = entry?.architect?.serve ?? entry?.targets?.serve;
  const selected = flag(text, '--configuration|-c', value => /^[\w-]+$/.test(value) ? value : undefined);
  const name = selected.present ? selected.value : serve?.defaultConfiguration;
  const override = name && serve?.configurations?.[name];
  const options = (selected.present || name) && !override ? {} : { ...serve?.options, ...override };
  if (options.ssl === true) return {};
  return { port: portFlag.present ? portFlag.value : literalPort(options.port),
    openPath: pathFlag.present ? pathFlag.value : literalPath(options.servePath) };
}

export async function webEndpoint(folder, text) {
  if (shellSyntax.test(text) || tlsFlag.test(text)) return {};
  const [tool, task] = text.split(/\s+/, 2);
  const portFlag = flag(text, tool === 'next' || tool === 'nuxt' ? '--port|-p' : '--port', literalPort);
  if (tool === 'vite') {
    const cliPath = flag(text, '--base', literalPath);
    const defaultConfig = !/(?:^|\s)(?:--config|-c)(?:=|\s|$)/.test(text) && (!task || /^(?:dev|serve|preview|-)/.test(task));
    const config = defaultConfig ? await webConfig(folder, 'vite', 'defineConfig') : [];
    const server = property(config, task === 'preview' ? 'preview' : 'server');
    if (Array.isArray(server) && server.some(token => scalar(token) === 'https') && property(server, 'https') !== 'false') return {};
    return { port: portFlag.present ? portFlag.value : literalPort(Array.isArray(server) ? property(server, 'port') : undefined),
      openPath: cliPath.present ? cliPath.value : literalPath(property(config, 'base')) };
  }
  if (tool === 'next') {
    const config = await webConfig(folder, 'next', '(?!)');
    return { port: portFlag.value, openPath: literalPath(property(config, 'basePath')) };
  }
  if (tool === 'nuxt' || tool === 'nuxi') {
    const config = await webConfig(folder, 'nuxt', 'defineNuxtConfig');
    const server = property(config, 'devServer'), app = property(config, 'app');
    if (Array.isArray(server) && server.some(token => scalar(token) === 'https') && property(server, 'https') !== 'false') return {};
    return { port: portFlag.present ? portFlag.value : literalPort(Array.isArray(server) ? property(server, 'port') : undefined),
      openPath: literalPath(Array.isArray(app) ? property(app, 'baseURL') : undefined) };
  }
  if (tool === 'ng') return angularEndpoint(folder, text, portFlag);
  return { port: portFlag.value };
}

export function declaredEndpoint(text) {
  if (shellSyntax.test(text) || tlsFlag.test(text) || /(?:^|\s)--ssl-(?:keyfile|certfile)(?:=|\s|$)/.test(text)) return {};
  if (/^(?:uvicorn\s|python3?\s+-m\s+(?:uvicorn|flask)\s|flask\s|php\s+artisan\s+serve(?:\s|$)|(?:ruby\s+bin\/rails|rails)\s+server(?:\s|$))/.test(text)) {
    return { port: flag(text, '--port|-p', literalPort).value };
  }
  const django = /^python3?\s+manage\.py\s+runserver\s+(?:(?:localhost|127\.0\.0\.1|0\.0\.0\.0):)?(\d+)(?=\s|$)/.exec(text);
  return { port: literalPort(django?.[1]) };
}

export async function nodeApiEndpoint(folder, text) {
  if (shellSyntax.test(text)) return {};
  const nest = /^nest\s+start(?:\s+--watch)?$/.test(text);
  let entry;
  if (nest) {
    const config = npmManifest(await localText(folder, 'nest-cli.json'));
    if (config?.monorepo || config?.projects) return {};
    const { sourceRoot = 'src', entryFile = 'main' } = config ?? {};
    if (typeof sourceRoot !== 'string' || typeof entryFile !== 'string') return {};
    entry = `${sourceRoot}/${entryFile}.ts`;
  } else {
    entry = /^(?:node(?:\s+--watch)?|tsx(?:\s+watch)?|ts-node|bun(?:\s+--watch)?)\s+(?:\.\/)?([\w./-]+\.[cm]?[jt]s)(?:\s|$)/.exec(text)?.[1];
  }
  if (!entry || !/^(?:[\w-]+\/)*[\w.-]+\.[cm]?[jt]s$/.test(entry)) return {};
  const source = (await nestedText(folder, entry)).replace(/\/\*[\s\S]*?\*\/|^[ \t]*\/\/[^\r\n]*/gm, '');
  if (/\b(?:https\.createServer|HttpsOptions|httpsOptions)\b|['"](?:node:)?https['"]/.test(source)) return {};
  const listeners = [...source.matchAll(/\b(?:app|server)\.listen\s*\(\s*(?:await\s+)?([^,\r\n)]+)/g)];
  const port = uniqueValue(listeners.map(([, value]) => value.trim()), literalPort);
  const pattern = nest ? /\bSwaggerModule\.setup\s*\(\s*(['"])([^'"\r\n]+)\1\s*,/g : /\bapp\.get\s*\(\s*(['"])(\/[^'"\r\n]*)\1\s*,/g;
  const routes = [...source.matchAll(pattern)];
  const route = routes.length === 1 ? routes[0][2] : undefined;
  const openPath = route && literalPath(route.startsWith('/') ? route : '/' + route);
  return { port, openPath };
}
