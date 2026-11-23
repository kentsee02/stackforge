import { posix } from 'node:path';
import { settings } from '../../projects/detection/startup-endpoints.mjs';

export const changelogExtension = /\.(?:xml|ya?ml|json|sql)$/i;
export const javaResources = 'src/main/resources';
const springDefault = javaResources + '/db/changelog/db.changelog-master.yaml';
const defaults = [springDefault, javaResources + '/db/changelog/db.changelog-master.xml',
  javaResources + '/config/liquibase/master.xml'];

export function localResource(value, base = '') {
  if (typeof value !== 'string' || value.length > 240) return;
  const configured = value.trim();
  const classpath = configured.startsWith('classpath:');
  const path = classpath ? configured.slice('classpath:'.length).replace(/^\//, '') :
    configured.replace(/^(?:file|filesystem):/, '');
  if (!path || path.startsWith('/') || path.split('/').some(part => part !== '.' && part !== '..' &&
    part !== '' && (!/^[\p{L}\p{N}_-][\p{L}\p{N}_ .-]*$/u.test(part) || /[. ]$/.test(part)))) return;
  const resolved = posix.normalize(posix.join(classpath ? javaResources : base, path)).replace(/\/$/, '');
  if (!resolved || resolved === '.' || resolved === '..' || resolved.startsWith('../') || resolved.length > 380) return;
  if (classpath && !resolved.startsWith(javaResources + '/')) return;
  return resolved;
}

function source(file, scope, value, { profile, disabled = false, unsupported = false, spring = false } = {}) {
  const resolved = !unsupported && localResource(value, spring && !/^(?:file|filesystem):/.test(value ?? '') ? javaResources : '');
  const changelog = resolved && changelogExtension.test(resolved) ? resolved : undefined;
  return { file, scope, profile, disabled, changelog,
    ...(changelog && { resourceRoot: changelog.startsWith(javaResources + '/') ? javaResources : '' }) };
}

function properties(text) {
  const values = new Map();
  for (const [, key, value] of text.replace(/^\uFEFF/, '').matchAll(/^[ \t]*(?:liquibase\.)?(?:command\.)?(changeLogFile|searchPath)[ \t]*[:=][ \t]*([^\r\n]*)/gim)) {
    const name = key.toLowerCase();
    values.set(name, values.has(name) ? undefined : value.trim());
  }
  return values;
}

function springSettings(file, text) {
  const yaml = /\.ya?ml$/i.test(file);
  const profileFile = /application-([\w-]{1,48})\.(?:properties|ya?ml)$/i.exec(file)?.[1];
  return text.replace(/^\uFEFF/, '').split(yaml ? /^---[ \t]*(?:#.*)?\r?$/m : /^[#!]---[ \t]*\r?$/m)
    .slice(0, 16).flatMap((document, index) => {
      const values = settings(yaml ? '' : document, yaml ? [document] : []);
      const changeLog = [...(values.get('spring.liquibase.change-log') ?? []), ...(values.get('spring.liquibase.changeLog') ?? [])];
      const enabled = values.get('spring.liquibase.enabled') ?? [];
      const hasSettings = [...values.keys()].some(key => key === 'spring.liquibase' || key.startsWith('spring.liquibase.'));
      if (!hasSettings && !values.has('spring.config.import')) return [];
      const selectors = [...(values.get('spring.config.activate.on-profile') ?? []), ...(values.get('spring.profiles') ?? [])];
      const label = selectors[0] ?? profileFile;
      const validProfile = label === undefined || /^[\w-]{1,48}$/.test(label);
      return [{ file, document: index, value: changeLog[0], enabled: enabled[0], hasSettings, hasProfile: label !== undefined,
        profile: validProfile ? label : undefined, unsupported: values.has('spring.config.import') || values.has('spring.liquibase') ||
        changeLog.length > 1 || enabled.length > 1 || selectors.length > 1 || !validProfile }];
    });
}

const xmlValue = (xml, name) => new RegExp('<' + name + '>\\s*([^<>]+?)\\s*</' + name + '>', 'i').exec(xml)?.[1];

async function mavenSource(xml, read, profile) {
  const active = xml.replace(/<pluginManagement\b[^>]*>[\s\S]*?<\/pluginManagement>/g, '');
  const plugins = [...active.matchAll(/<plugin>([\s\S]*?)<\/plugin>/g)].map(match => match[1])
    .filter(plugin => xmlValue(plugin, 'groupId') === 'org.liquibase' && xmlValue(plugin, 'artifactId') === 'liquibase-maven-plugin');
  if (!plugins.length) return;
  const plugin = plugins[0];
  const configured = xmlValue(plugin, 'changeLogFile') ?? xmlValue(active, 'liquibase.changeLogFile');
  const propertyFile = localResource(xmlValue(plugin, 'propertyFile'));
  const text = propertyFile?.endsWith('.properties') ? await read(propertyFile) : '';
  const values = properties(text);
  const fileChangelog = values.get('changelogfile');
  const conflict = configured && fileChangelog && localResource(configured) !== localResource(fileChangelog);
  return source('pom.xml', 'maven', configured ?? fileChangelog, { profile, disabled: xmlValue(plugin, 'skip') === 'true',
    unsupported: plugins.length > 1 || Boolean(conflict) || values.has('searchpath') ||
      /<searchPath\b/i.test(plugin) || /<propertyFile\b/i.test(plugin) && !text });
}

export async function liquibaseSources({ files, pom, configs, read }) {
  const sources = [];
  if (files.includes('liquibase.properties')) {
    const values = properties(await read('liquibase.properties'));
    sources.push(source('liquibase.properties', 'standalone', values.get('changelogfile'), { unsupported: values.has('searchpath') }));
  }
  const activePom = pom.replace(/<profiles\b[^>]*>[\s\S]*?<\/profiles>/g, '');
  const maven = await mavenSource(activePom, read);
  if (maven) sources.push(maven);
  for (const [, xml] of Array.from(pom.matchAll(/<profile>([\s\S]*?)<\/profile>/g)).slice(0, 12)) {
    const profile = xmlValue(xml, 'id');
    if (!/^[\w-]{1,48}$/.test(profile ?? '')) continue;
    const candidate = await mavenSource(xml, read, profile);
    if (candidate) sources.push(candidate);
  }
  let runtime = /<artifactId>\s*(?:liquibase-core|spring-boot-starter-liquibase)\s*<\/artifactId>/i.test(
    activePom.replace(/<dependencyManagement\b[^>]*>[\s\S]*?<\/dependencyManagement>/g, '')) ? 'pom.xml' : undefined;
  for (const file of files.filter(file => /^build\.gradle(?:\.kts)?$/.test(file))) {
    const text = (await read(file)).replace(/\/\*[\s\S]*?\*\/|^[ \t]*\/\/.*$/gm, '');
    if (/['"](?:org\.liquibase:liquibase-core|org\.springframework\.boot:spring-boot-starter-liquibase)(?=[:'"])/.test(text)) runtime ??= file;
  }
  const configured = [];
  for (const file of configs.filter(file => /(?:^|\/)application(?:-[\w-]+)?\.(?:properties|ya?ml)$/i.test(file)).slice(0, 24)) {
    configured.push(...springSettings(file, await read(file)).filter(item => item.hasSettings || runtime));
    if (configured.length > 32) break;
  }
  const base = configured.filter(item => !item.hasProfile);
  let fallback;
  if ((runtime || configured.length) && (!base.length || base.some(item => !item.value))) {
    for (const file of defaults) {
      if (await read(file)) { fallback = file; break; }
    }
  }
  for (const item of configured.slice(0, 32)) {
    const inherited = item.hasProfile && base.length === 1 ? base[0] : undefined;
    const enabled = item.enabled ?? inherited?.enabled ?? 'true';
    const value = item.value ?? inherited?.value;
    const unsupported = item.unsupported || inherited?.unsupported || !/^(true|false)$/i.test(enabled) ||
      item.hasProfile && base.length > 1 && !item.value;
    const itemSource = source(item.file, 'spring', value, { spring: true, profile: item.profile, disabled: /^false$/i.test(enabled), unsupported });
    if (!value && !unsupported && !itemSource.disabled && fallback) {
      itemSource.changelog = fallback;
      itemSource.resourceRoot = javaResources;
    }
    sources.push({ ...itemSource, document: item.document });
  }
  if (!base.length && fallback) sources.push(source(fallback, 'convention', fallback));
  else if (!configured.length && runtime) sources.push(source(runtime, 'spring', springDefault));
  return { sources: sources.slice(0, 32), limited: sources.length > 32 || configured.length > 32 };
}
