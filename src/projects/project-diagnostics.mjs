const ignoredPnpmBuilds = /\bERR_PNPM_IGNORED_BUILDS\b/;

export function pnpmBuildPackages(output) {
  const pending = output.split(/\r?\n/)
    .filter(line => ignoredPnpmBuilds.test(line))
    .flatMap(line => /\bIgnored build scripts:\s*(.*)$/i.exec(line)?.[1].split(/,\s*/) ?? []);
  const packageReference = /^(?:@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*(?:@\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?(?:\+[a-z0-9.-]+)?)?$/i;
  return [...new Set(pending.map(value => value.trim()).filter(value => value.length <= 214 && packageReference.test(value)))].slice(0, 60);
}

export function commandDiagnostic(output) {
  if (ignoredPnpmBuilds.test(output)) return 'pnpmBuildApproval';
  if (/EADDRINUSE|address already in use|port [^\r\n]{1,32}(?:already in use|already allocated)|ports are not available/i.test(output)) return 'port';
  if (/(?:cannot resolve environment variable|missing required environment variable|environment variable not found)\s*:\s*["']?DATABASE_URL\b|\bDATABASE_URL\b[^\r\n]{0,10}\b(?:is (?:not set|missing|required|undefined)|must be set)\b/i.test(output)) return 'databaseUrl';
  if (/\bP1001\s*:|can.t reach database server/i.test(output)) return 'databaseConnection';
  if (/\bJAVA_HOME\b[^\r\n]*(?:not set|not defined|not found|incorrect|invalid|not correctly|does not)|invalid (?:target|source) release|release version \d+ not supported|UnsupportedClassVersionError|Unsupported class file major version|No compiler is provided in this environment|(?:cannot|could not) find a Java installation|\b(?:java|javac)\b[^\r\n]*(?:not found|not recognized|不是内部或外部命令)/i.test(output)) return 'java';
  if (/NETSDK1045|compatible \.NET SDK (?:was not found|could not be found)|no \.NET SDKs were found/i.test(output)) return 'dotnetSdk';
  if (/ERR_PNPM_OUTDATED_LOCKFILE|\bYN0028\b|(?:package-lock\.json|npm-shrinkwrap\.json)[^\r\n]*(?:in sync|out of sync)|the lock file [^\r\n]*needs to be updated but --locked/i.test(output)) return 'lockfile';
  if (/cannot connect to the docker daemon|is the docker daemon running|dockerDesktopLinuxEngine|docker_engine.*(?:cannot|not find|denied)|spawn docker ENOENT|\bdocker\b[^\r\n]*(?:not recognized|command not found|不是内部或外部命令)/i.test(output)) return 'docker';
  if (/Database startup failed/i.test(output)) return 'database';
  if (/ModuleNotFoundError:\s*No module named|\bpython(?:3|\.exe)?\s*:\s*No module named/i.test(output)) return 'pythonDependencies';
  if (/(?:\bspawn\s+(?:dotnet|go|cargo|composer|bundle|gradle|mvn|uv|python3?)\s+ENOENT|\b(?:dotnet|go|cargo|composer|bundle|gradle|mvn|uv|python3?)\b["']?\s*:?\s*(?:command not found|is not recognized|不是内部或外部命令))/i.test(output)) return 'toolMissing';
  if (/Cannot find (?:package|module) ['"](?:vite|vue|react|express|mysql2|pg|@vitejs\/[^'"]+|@nestjs\/[^'"]+)['"]|(?:vite|\bnest)['"]?[^\r\n]{0,32}(?:not recognized|not found|不是内部或外部命令)|failed to load config[^\r\n]*\n[^\r\n]*Cannot find package/i.test(output)) return 'dependencies';
}
