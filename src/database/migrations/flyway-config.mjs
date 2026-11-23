import { settings } from '../../projects/detection/startup-endpoints.mjs';

const projectDefault = 'classpath:db/migration';
const standaloneDefault = 'filesystem:sql';
const naming = new Map([
  ['sqlmigrationprefix', 'V'], ['repeatablesqlmigrationprefix', 'R'],
  ['undosqlmigrationprefix', 'U'], ['baselinemigrationprefix', 'B'], ['sqlmigrationseparator', '__'], ['sqlmigrationsuffixes', '.sql']
]);
const relevant = new Set(['locations', 'enabled', 'skip', 'configfiles', 'workingdirectory', ...naming.keys()]);
const normalized = key => key.toLowerCase().replaceAll('-', '');
const unquote = value => /^(["'])([^"'\\]*)\1$/.exec(value.trim())?.[2] ?? value.trim();

export function implicitSpringFlywayProperties(text) {
  return Boolean(text) && text.replace(/^\uFEFF/, '').split(/\r?\n/).every(line => {
    const value = line.trim();
    if (!value || /^[#!]/.test(value)) return value !== '#---' && value !== '!---';
    const entry = /^([\w.-]+)\s*[:=]\s*(.*)$/.exec(value);
    return entry && !entry[2].endsWith('\\') && !/^spring[.-](?:flyway|config|profiles)(?:[.-]|$)/i.test(entry[1]);
  });
}

function put(options, key, value) {
  key = normalized(key);
  if (relevant.has(key)) options.set(key, options.has(key) ? undefined : value);
}

function propertyOptions(text) {
  const result = new Map();
  for (const [, key, value] of text.replace(/^\uFEFF/, '').matchAll(/^[ \t]*flyway\.([\w-]+)[ \t]*[:=][ \t]*([^\r\n]*)/gm)) put(result, key, value);
  return result;
}

export function flywayRelativePath(path) {
  const value = path.replace(/^\.\/+/, '').replace(/\/$/, '');
  if (!value || value.length > 240 || value.split('/').some(part => !/^[\p{L}\p{N}_-][\p{L}\p{N}_ .-]*$/u.test(part) ||
      /[. ]$/.test(part))) return;
  return value;
}

function locations(value) {
  const trimmed = value.trim();
  const list = trimmed.startsWith('[') && trimmed.endsWith(']') ? trimmed.slice(1, -1).trim().replace(/,$/, '') : trimmed;
  const parts = list.split(',').map(unquote);
  if (parts.length > 12) return;
  const parsed = parts.map(part => {
    if (part.startsWith('filesystem:')) return flywayRelativePath(part.slice('filesystem:'.length));
    const path = flywayRelativePath(part.replace(/^classpath:\/?/, ''));
    return path && 'src/main/resources/' + path;
  });
  if (!parsed.includes(undefined)) return [...new Set(parsed)];
}

function configuration(file, scope, options, { profile, fallback = projectDefault, unsupported = false } = {}) {
  const source = { file, scope, ...(profile && { profile }) };
  if (unsupported || [...options].some(([key, value]) => value === undefined || key === 'workingdirectory' || key === 'configfiles' ||
    naming.has(key) && unquote(value.replace(/^\[\s*(.*?)\s*\]$/, '$1')) !== naming.get(key))) return source;
  const enabled = options.get('enabled') ?? 'true', skip = options.get('skip') ?? 'false';
  if (!/^(?:true|false)$/i.test(enabled) || !/^(?:true|false)$/i.test(skip)) return source;
  if (/^false$/i.test(enabled) || /^true$/i.test(skip)) return { ...source, disabled: true };
  return { ...source, locations: locations(options.get('locations') ?? fallback) };
}

function tomlOptions(text) {
  const section = /^\s*\[flyway\][ \t]*(?:#.*)?\r?\n([\s\S]*?)(?=^\s*\[[\w."'-]+(?:\.[\w."'-]+)*\]|(?![\s\S]))/m.exec(text)?.[1];
  if (section === undefined) return;
  const options = new Map();
  const entries = section.matchAll(/^[ \t]*([\w-]+)[ \t]*=[ \t]*(\[[^\]]*\]|[^#\r\n]*)(?:[ \t]*#.*)?$/gm);
  for (const [, key, value] of entries) put(options, key, value.trim());
  return options;
}

function springSettings(file, text) {
  const yaml = /\.ya?ml$/i.test(file);
  const profileFile = /application-([\w-]+)\.(?:properties|ya?ml)$/i.exec(file)?.[1];
  const sources = [];
  for (const [index, document] of text.replace(/^\uFEFF/, '').split(yaml ? /^---[ \t]*(?:#.*)?\r?$/m : /^[#!]---[ \t]*\r?$/m).entries()) {
    // Convert simple indented YAML lists to scalars for the shared JVM settings reader.
    const flat = yaml ? document.replace(/^( *)(locations|sql-migration-suffixes):[ \t]*(?:#.*)?\r?\n((?: +-[ \t]+[^\r\n]+(?:\r?\n|$))+)/gm,
      (_, indent, key, items) => indent + key + ': [' + items.trimEnd().split(/\r?\n/).map(item =>
        item.replace(/^ +-[ \t]+/, '').replace(/[ \t]+#.*$/, '')).join(',') + ']\n') : document;
    const values = settings(yaml ? '' : flat, yaml ? [flat] : []);
    const options = new Map();
    const hasFlyway = [...values.keys()].some(key => key === 'spring.flyway' || key.startsWith('spring.flyway.')) ||
      /^[ \t]*spring\.flyway[.:]/m.test(document);
    if (!hasFlyway && !values.has('spring.config.import')) continue;
    for (const [key, list] of values) if (key.startsWith('spring.flyway.')) put(options, key.slice('spring.flyway.'.length), list.length === 1 ? list[0] : undefined);
    const selectors = [...(values.get('spring.config.activate.on-profile') ?? []), ...(values.get('spring.profiles') ?? [])];
    const profile = selectors.length ? selectors[0] : profileFile;
    const validProfile = profile === undefined || /^[\w-]{1,48}$/.test(profile);
    const unsupported = values.has('spring.flyway') || values.has('spring.config.import') || selectors.length > 1 || !validProfile ||
      !options.has('locations') && /(?:^|[.\s])locations\s*[:=]/m.test(document);
    sources.push({ file, options, profile: validProfile ? profile : undefined, hasProfile: profile !== undefined,
      hasFlyway, unsupported, document: index });
    if (sources.length > 32) break;
  }
  return sources;
}

const xmlValue = (xml, tag) => new RegExp('<' + tag + '>\\s*([^<>]+?)\\s*</' + tag + '>', 'i').exec(xml)?.[1];
const mavenPlugins = xml => [...xml.matchAll(/<plugin>([\s\S]*?)<\/plugin>/g)].map(match => match[1])
  .filter(plugin => xmlValue(plugin, 'groupId') === 'org.flywaydb' && xmlValue(plugin, 'artifactId') === 'flyway-maven-plugin');

async function mavenSource(xml, read, profile) {
  const plugins = mavenPlugins(xml.replace(/<pluginManagement\b[^>]*>[\s\S]*?<\/pluginManagement>/g, ''));
  if (!plugins.length) return;
  const plugin = plugins[0];
  const options = new Map();
  for (const [, key, value] of xml.matchAll(/<flyway\.([\w-]+)>\s*([^<>]+?)\s*<\/flyway\.\1>/g)) put(options, key, value);
  for (const [, key, value] of plugin.matchAll(/<([\w-]+)>\s*([^<>]+?)\s*<\/\1>/g)) put(options, key, value);
  const blocks = [...plugin.matchAll(/<locations>([\s\S]*?)<\/locations>/g)];
  if (blocks.length) {
    const entries = [...blocks[0][1].matchAll(/<location>\s*([^<>]+?)\s*<\/location>/g)].map(match => match[1]);
    if (entries.length) put(options, 'locations', entries.join(','));
    else if (!options.has('locations')) options.set('locations', undefined);
  }
  const references = [...plugin.matchAll(/<configFile>\s*([^<>]+?)\s*<\/configFile>/g)].map(match => match[1]);
  const propertyReference = options.get('configfiles');
  if (propertyReference && !references.length) {
    references.push(...propertyReference.split(',').map(value => value.trim()));
    options.delete('configfiles');
  }
  const file = references.length === 1 && flywayRelativePath(references[0]);
  const unsupported = plugins.length > 1 || blocks.length > 1 || references.length > 1 ||
    (references.length > 0 || /<configFiles\b/.test(plugin)) && (!file || !file.endsWith('.conf'));
  if (file && !unsupported) {
    const text = await read(file);
    const fromFile = propertyOptions(text);
    for (const [key, value] of options) fromFile.set(key, fromFile.has(key) && fromFile.get(key) !== value ? undefined : value);
    return configuration(file, 'maven', fromFile, { profile, unsupported: !text });
  }
  return configuration('pom.xml', 'maven', options, { profile, unsupported });
}

export async function flywaySources({ files, pom, configs, read }) {
  const sources = [];
  for (const file of ['flyway.conf', 'flyway.toml'].filter(name => files.includes(name))) {
    const text = await read(file);
    const options = file.endsWith('.conf') ? propertyOptions(text) : tomlOptions(text);
    const unsupported = !text || !options || /\[environments\.[^\]]+\.flyway\]/m.test(text);
    sources.push(configuration(file, 'standalone', options ?? new Map(), { fallback: standaloneDefault, unsupported }));
  }

  const basePom = pom.replace(/<profiles\b[^>]*>[\s\S]*?<\/profiles>/g, '')
    .replace(/<dependencyManagement\b[^>]*>[\s\S]*?<\/dependencyManagement>/g, '');
  const dependency = /<artifactId>\s*(?:flyway-core|flyway-database-[\w-]+|flyway-mysql|spring-boot-starter-flyway)\s*<\/artifactId>/i;
  let runtimeFile = dependency.test(basePom) ? 'pom.xml' : undefined;
  const maven = await mavenSource(basePom, read);
  if (maven) sources.push(maven);
  const profiles = [...pom.matchAll(/<profile>([\s\S]*?)<\/profile>/g)];
  for (const [, profileXml] of profiles.slice(0, 16)) {
    const profile = xmlValue(profileXml, 'id');
    if (!/^[\w-]{1,48}$/.test(profile ?? '')) continue;
    const candidate = await mavenSource(profileXml, read, profile);
    if (candidate) sources.push(candidate);
  }
  for (const file of ['build.gradle', 'build.gradle.kts'].filter(name => files.includes(name))) {
    const text = (await read(file)).replace(/\/\*[\s\S]*?\*\/|^[ \t]*\/\/.*$/gm, '');
    if (/['"](?:org\.flywaydb:flyway-[\w-]+|org\.springframework\.boot:spring-boot-starter-flyway)(?=[:'"])/.test(text)) runtimeFile ??= file;
    if (!/\bid\s*\(?\s*['"]org\.flywaydb\.flyway['"]/.test(text)) continue;
    const options = new Map();
    const block = /\bflyway\s*\{([\s\S]*?)\}/.exec(text)?.[1] ?? '';
    for (const [, key, value] of block.matchAll(/^[ \t]*(\w+)[ \t]*=[ \t]*(\[[^\]]*\]|[^\r\n]+)$/gm)) put(options, key, value);
    const unsupported = [...relevant].some(key => new RegExp('\\b' + key + '\\b', 'i').test(block) && !options.has(key));
    sources.push(configuration(file, 'gradle', options, { unsupported }));
  }

  if (runtimeFile || maven || configs.some(file => /application/.test(file))) {
    const spring = [];
    const applicationConfigs = configs.filter(file => /(?:^|\/)application(?:-[\w-]+)?\.(?:properties|ya?ml)$/i.test(file));
    for (const file of applicationConfigs.slice(0, 24)) {
      const candidates = springSettings(file, await read(file));
      if (runtimeFile || maven) spring.push(...candidates);
      else spring.push(...candidates.filter(item => item.hasFlyway));
      if (spring.length > 32) break;
    }
    const defaults = spring.filter(item => !item.hasProfile);
    for (const item of spring) {
      const base = item.hasProfile && defaults.length === 1 ? defaults[0] : undefined;
      const inherited = new Map([...(base?.options ?? []), ...item.options]);
      const unsupported = item.unsupported || Boolean(base?.unsupported) ||
        item.hasProfile && defaults.length > 1 && !item.options.has('locations');
      sources.push({ ...configuration(item.file, 'spring', inherited, { profile: item.profile, unsupported }), document: item.document });
    }
    if (!defaults.length && runtimeFile) {
      const file = 'src/main/resources/application.properties';
      const implicit = !spring.length && applicationConfigs.length === 1 && applicationConfigs[0] === file &&
        implicitSpringFlywayProperties(await read(file));
      sources.push(implicit ? { ...configuration(file, 'spring', new Map()), implicitLocations: true } :
        configuration(runtimeFile, 'runtime', new Map()));
    }
  }
  return { sources: sources.slice(0, 32), limited: sources.length > 32 || profiles.length > 16 };
}
