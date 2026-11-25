import { randomBytes } from 'node:crypto';
import { throwIfCancelled } from '../../platform/process.mjs';
import { runMigrationContainer } from './migration-container.mjs';

export const alembicDependencyPath = '/stackforge-dependencies';
const databaseHost = 'stackforge-db';
const label = 'io.stackforge.alembic-dependencies';
const gateway = 'com.docker.network.bridge.gateway_mode_ipv4';
const maintenance = { signal: null, timeout: 15000 };

const installer = `import json, subprocess, sys
from importlib import metadata
from pip._vendor.packaging.requirements import Requirement
from pip._vendor.packaging.utils import canonicalize_name
from pip._vendor.packaging.version import Version

with open("/stackforge/packages.json", encoding="utf-8") as package_file:
    reviewed = {item["name"]: Version(item["version"]) for item in json.load(package_file)}
base = {canonicalize_name(item.metadata["Name"]): item for item in metadata.distributions()}
if set(reviewed) & set(base):
    print("base-conflict")
    sys.exit(0)

subprocess.run([
    sys.executable, "-I", "-m", "pip", "--isolated", "--disable-pip-version-check", "--quiet",
    "install", "--no-input", "--no-cache-dir", "--no-deps", "--no-compile", "--only-binary=:all:",
    "--require-hashes", "--index-url=https://pypi.org/simple/", "--timeout=15", "--retries=1",
    "--target=${alembicDependencyPath}", "--requirement=/stackforge/requirements.txt",
], check=True)
distributions = list(metadata.distributions(path=["${alembicDependencyPath}"]))
installed = {canonicalize_name(item.metadata["Name"]): item for item in distributions}
if {name: Version(item.version) for name, item in installed.items()} != reviewed or len(distributions) != len(reviewed):
    raise RuntimeError("Installed distributions do not match the approved lock")

available = {**base, **installed}
pending = [(name, "") for name in installed]
checked = set()
for key in pending:
    if key in checked:
        continue
    checked.add(key)
    name, extra = key
    item = available[name]
    for text in item.requires or []:
        reference = Requirement(text)
        if reference.marker and not reference.marker.evaluate({"extra": extra}):
            continue
        dependency = canonicalize_name(reference.name)
        resolved = available.get(dependency)
        if reference.url or resolved is None or not reference.specifier.contains(resolved.version, prereleases=True):
            print("incomplete")
            sys.exit(0)
        pending.extend((dependency, feature) for feature in ["", *reference.extras])
print("ready")
`;

function preparationError(status) {
  return Object.assign(new Error('The Alembic dependency runtime could not be prepared.'), { dependencyStatus: status });
}

export async function withIsolatedAlembicRuntime({ scope, image, directory, signal, lock, verify }, execute) {
  const { cli, container } = scope;
  const owner = randomBytes(16).toString('hex');
  const name = 'stackforge-alembic-' + owner;
  const mount = 'type=volume,src=' + name + ',dst=' + alembicDependencyPath;
  const ownedVolume = async (options = {}) => (await cli(['volume', 'inspect', '--format',
    '{{.Driver}} {{index .Labels "' + label + '"}}', name], options)).trim() === 'local ' + owner;
  async function ownedNetwork(options = {}) {
    const result = (await cli(['network', 'inspect', '--format', '{{.Id}} {{.Driver}} {{.Internal}} {{.EnableIPv6}} {{index .Options "' +
      gateway + '"}} {{index .Labels "' + label + '"}}', name], options)).trim().split(' ');
    const [id, driver, internal, ipv6, mode, marked] = result;
    if (/^[a-f\d]{64}$/.test(id ?? '') && driver === 'bridge' && internal === 'true' && ipv6 === 'false' &&
        mode === 'isolated' && marked === owner) return id;
  }
  try {
    if (lock) {
      let result;
      try {
        throwIfCancelled(signal);
        await cli(['volume', 'create', '--driver', 'local', '--label', label + '=' + owner, name], maintenance);
        const verifyInstall = async () => {
          if (!await ownedVolume()) throw preparationError('dependency-install-failed');
        };
        result = await runMigrationContainer({ cli, image, directory, signal, network: 'bridge', mounts: [mount], user: '0:0', timeout: 120000,
          args: [], env: {}, verify: verifyInstall,
          files: new Map([['run.py', installer], ['requirements.txt', lock.requirements], ['packages.json', JSON.stringify(lock.packages)]]) });
      } catch (error) {
        if (error.name === 'AbortError') throw error;
        throwIfCancelled(signal);
        throw preparationError('dependency-install-failed');
      }
      const status = result.trim();
      if (status === 'base-conflict') throw preparationError('dependency-base-conflict');
      if (status === 'incomplete') throw preparationError('dependency-lock-incomplete');
      if (status !== 'ready') throw preparationError('dependency-install-failed');
    }
    await verify();
    throwIfCancelled(signal);
    let network;
    try {
      await cli(['network', 'create', '--driver', 'bridge', '--internal', '--ipv6=false', '--opt', gateway + '=isolated',
        '--label', label + '=' + owner, name], maintenance);
      network = await ownedNetwork();
      if (!network) throw new Error();
      await cli(['network', 'connect', '--alias', databaseHost, network, container], maintenance);
    } catch (error) {
      if (error.name === 'AbortError') throw error;
      throwIfCancelled(signal);
      throw preparationError('dependency-network-failed');
    }
    return await execute({ network, mounts: lock ? [mount + ',readonly'] : [], host: databaseHost,
      async verify() {
        if (await ownedNetwork() !== network || lock && !await ownedVolume()) throw preparationError('dependency-network-failed');
      } });
  } finally {
    const network = await ownedNetwork(maintenance).catch(() => undefined);
    if (network) {
      await cli(['network', 'disconnect', '--force', network, container], maintenance).catch(() => {});
      await cli(['network', 'rm', network], maintenance).catch(() => {});
    }
    if (lock && await ownedVolume(maintenance).catch(() => false)) await cli(['volume', 'rm', name], maintenance).catch(() => {});
  }
}
