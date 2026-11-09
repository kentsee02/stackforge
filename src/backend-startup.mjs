import { lstat, opendir, stat } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { findBuildWrapper, localText, npmManifest } from './project-detection.mjs';
import { declaredEndpoint, jvmEndpoint, ktorEndpoint, literalPath, literalPort, nestedText, uniqueValue } from './startup-endpoints.mjs';

function candidate(name, command, source, kind, { port, openPath } = {}) {
  return { name, choice: { command, script: name, source, ...(kind && { kind }), ...(port && { port }), ...(openPath && { openPath }) } };
}

async function isFile(folder, name) {
  return (await lstat(join(folder, name)).catch(() => null))?.isFile() === true;
}

async function projectProcess(folder) {
  for (const file of ['Procfile.dev', 'Procfile']) {
    const text = await localText(folder, file);
    const commands = [...text.matchAll(/^web:[ \t]+([^\r\n]+)$/gm)].map(match => match[1].trim());
    if (commands.length === 1 && commands[0] && commands[0].length <= 500 && !/[\x00-\x1f\x7f]/.test(commands[0])) {
      return candidate('Web process', commands[0], file + ' · web', undefined, declaredEndpoint(commands[0]));
    }
  }
}

async function pythonLauncher(folder) {
  const venv = process.platform === 'win32' ? '.venv/Scripts/python.exe' : '.venv/bin/python';
  const directory = await lstat(join(folder, '.venv')).catch(() => null);
  if (directory?.isDirectory() && (await stat(join(folder, venv)).catch(() => null))?.isFile()) {
    return '.' + sep + venv.replaceAll('/', sep);
  }
  const command = process.platform === 'win32' ? 'python' : 'python3';
  return await isFile(folder, 'uv.lock') && await isFile(folder, 'pyproject.toml') ? 'uv run --no-sync python' : command;
}

async function pythonStartup(folder) {
  const manage = await localText(folder, 'manage.py');
  if (/django\.core\.management/.test(manage) && /DJANGO_SETTINGS_MODULE/.test(manage)) {
    return candidate('Django', await pythonLauncher(folder) + ' manage.py runserver', 'manage.py · Django', 'web');
  }

  const entries = ['main.py', 'app.py', 'asgi.py', 'wsgi.py', 'app/main.py', 'app/__init__.py', 'src/main.py', 'src/app.py'];
  const contents = await Promise.all(entries.map(file => nestedText(folder, file)));
  const detected = entries.flatMap((file, index) => {
    const content = contents[index];
    if (/^\s*(?:from\s+fastapi\s+import\s+FastAPI\b|import\s+fastapi\b)/m.test(content) &&
        /^app\s*=\s*(?:fastapi\.)?FastAPI\s*\(/m.test(content)) return [{ file, kind: 'fastapi' }];
    if (/^\s*(?:from\s+flask\s+import\s+Flask\b|import\s+flask\b)/m.test(content) &&
        /^(?:app\s*=\s*(?:flask\.)?Flask\s*\(|def\s+create_app\s*\()/m.test(content)) return [{ file, kind: 'flask' }];
    return [];
  });
  if (detected.length !== 1) return;
  const [entry] = detected;
  const python = await pythonLauncher(folder);
  const entryPath = join(folder, entry.file);
  if (entry.kind === 'flask') {
    return { ...candidate('Flask', python + ' -m flask --app ' + entry.file + ' run', entry.file + ' · Flask'), entryPath };
  }
  const srcLayout = entry.file.startsWith('src/');
  const module = (srcLayout ? entry.file.slice(4) : entry.file).replace(/(?:\/__init__)?\.py$/, '').replaceAll('/', '.');
  const args = ' -m uvicorn ' + module + ':app --reload' + (srcLayout ? ' --app-dir src' : '');
  const app = /^app\s*=\s*(?:fastapi\.)?FastAPI\s*\(([^)]{0,1600})\)/m.exec(contents[entries.indexOf(entry.file)])?.[1] ?? '';
  const docs = [...app.matchAll(/(?:^|,)\s*docs_url\s*=\s*(['"])([^'"\r\n]+)\1\s*(?=,|$)/g)];
  const openPath = uniqueValue(docs.map(([, , value]) => value), literalPath);
  return { ...candidate('FastAPI', python + args, entry.file + ' · FastAPI', 'api', { openPath }), entryPath };
}

async function dotnetStartup(folder) {
  const entries = await opendir(folder).catch(() => null);
  if (!entries) return;
  const projects = [];
  let visited = 0;
  try {
    for await (const entry of entries) {
      if (++visited > 192) return;
      if (!entry.isFile() || !/^[a-z0-9][a-z0-9_. -]{0,119}\.(?:csproj|fsproj|vbproj)$/i.test(entry.name)) continue;
      const project = (await localText(folder, entry.name)).replace(/<!--[\s\S]*?-->/g, '');
      if (/<Project\b[^>]*\bSdk\s*=\s*["']Microsoft\.NET\.Sdk\.Web(?:\/[^"']+)?["']/i.test(project)) projects.push(entry.name);
      if (projects.length > 1) return;
    }
  } catch { return; /* A changing directory provides incomplete project evidence. */ }
  if (!projects.length) return;
  const [project] = projects;
  const target = project.includes(' ') ? `"${project}"` : project;
  const profiles = npmManifest(await nestedText(folder, 'Properties/launchSettings.json'))?.profiles;
  const profile = profiles && Object.entries(profiles).find(([name, value]) => /^\w[\w.-]{0,79}$/.test(name) && value?.commandName === 'Project');
  const command = 'dotnet run --project ' + target + (profile ? ' --launch-profile ' + profile[0] : ' --no-launch-profile');
  const settings = profile?.[1];
  const bindings = [settings?.applicationUrl, settings?.environmentVariables?.ASPNETCORE_URLS].filter(value => typeof value === 'string');
  const port = uniqueValue(bindings, value => uniqueValue(value.split(';').filter(url => /^http:\/\//i.test(url.trim())), url =>
    literalPort(/^http:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0):(\d+)\/?$/i.exec(url.trim())?.[1])));
  const launchUrl = settings?.launchUrl;
  const openPath = typeof launchUrl === 'string' && launchUrl ? literalPath(launchUrl.startsWith('/') ? launchUrl : '/' + launchUrl) : undefined;
  const program = await localText(folder, 'Program.cs');
  const kind = /\.MapControllers\s*\(|\.Map(?:Get|Group|Post)\s*\(\s*["']\/api(?:\/|["'])/.test(program) ? 'api' : undefined;
  return candidate('ASP.NET Core', command, project + (profile ? ' · launchSettings.json' : ''), kind, { port, openPath });
}

async function goStartup(folder, root) {
  const main = (await localText(folder, 'main.go')).replace(/\/\*[\s\S]*?\*\/|^[ \t]*\/\/.*$/gm, '');
  if (!/^package\s+main\b/m.test(main) || !/^func\s+main\s*\(/m.test(main)) return;
  if (!/"(?:net\/http|github\.com\/(?:gin-gonic\/gin|labstack\/echo(?:\/v\d+)?|gofiber\/fiber(?:\/v\d+)?|go-chi\/chi(?:\/v\d+)?))"/.test(main)) return;
  if (!/\b(?:ListenAndServe(?:TLS)?|Run|Start|Listen)\s*\(/.test(main)) return;
  for (let current = folder; ; current = dirname(current)) {
    if (await isFile(current, 'go.mod')) {
      const listeners = [...main.matchAll(/\bhttp\.ListenAndServe\s*\(\s*([^,\r\n]+)/g)];
      const port = uniqueValue(listeners.map(([, address]) => /^"(?:localhost|127\.0\.0\.1|0\.0\.0\.0)?:(\d+)"$/.exec(address.trim())?.[1]), literalPort);
      const routes = [...main.matchAll(/\bhttp\.HandleFunc\s*\(\s*"(?:GET )?(\/[^"\r\n]*)"\s*,/g)];
      const openPath = routes.length === 1 ? literalPath(routes[0][1]) : undefined;
      return candidate('Go', 'go run .', 'go.mod · main.go', 'api', { port, openPath });
    }
    if (!relative(root, current)) return;
  }
}

async function rustStartup(folder) {
  const cargo = await localText(folder, 'Cargo.toml');
  const section = /^\[package\][ \t]*\r?\n([\s\S]*?)(?=^\[|(?![\s\S]))/m.exec(cargo)?.[1];
  const name = section && /^[ \t]*name\s*=\s*["']([a-zA-Z0-9][a-zA-Z0-9_-]{0,119})["'][ \t]*(?:#.*)?$/m.exec(section)?.[1];
  if (!name || /^[ \t]*autobins\s*=\s*false\b/m.test(section) ||
      !/^[ \t]*(?:axum|actix-web|rocket|warp|salvo|poem)\s*(?:=|\.workspace\s*=)/m.test(cargo)) return;
  const main = await nestedText(folder, 'src/main.rs');
  if (/\bfn\s+main\s*\(/.test(main)) {
    const bindings = [...main.matchAll(/\bTcpListener::bind\s*\(\s*([^,\r\n)]+)/g)];
    const port = uniqueValue(bindings.map(([, address]) => /^"(?:localhost|127\.0\.0\.1|0\.0\.0\.0):(\d+)"$/.exec(address.trim())?.[1]), literalPort);
    return candidate('Rust', 'cargo run --bin ' + name, 'Cargo.toml · src/main.rs', 'api', { port });
  }
}

async function phpStartup(folder) {
  const manifest = npmManifest(await localText(folder, 'composer.json'));
  if (typeof manifest?.require?.['laravel/framework'] === 'string' && await isFile(folder, 'artisan')) {
    return candidate('Laravel', 'php artisan serve', 'composer.json · artisan', 'web');
  }
}

async function rubyStartup(folder) {
  const gemfile = await localText(folder, 'Gemfile');
  if (/^[ \t]*gem\s+["']rails["']/m.test(gemfile) && await nestedText(folder, 'bin/rails')) {
    const puma = await nestedText(folder, 'config/puma.rb');
    const ports = [...puma.matchAll(/^[ \t]*port[ \t]+([^\r\n#]+)/gm)];
    return candidate('Rails', 'ruby bin/rails server', 'Gemfile · bin/rails', 'web', { port: uniqueValue(ports.map(([, value]) => value.trim()), literalPort) });
  }
}

async function gradleStartup(folder, root) {
  const tools = [
    ['org.springframework.boot', 'Spring Boot', 'bootRun'],
    ['io.quarkus', 'Quarkus', 'quarkusDev'],
    ['io.micronaut.application', 'Micronaut', 'run'],
    ['io.ktor.plugin', 'Ktor', 'run']
  ];
  for (const file of ['build.gradle.kts', 'build.gradle']) {
    const text = (await localText(folder, file)).replace(/\/\*[\s\S]*?\*\/|^[ \t]*\/\/.*$/gm, '');
    for (const [plugin, name, task] of tools) {
      const escaped = plugin.replaceAll('.', '\\.');
      const match = new RegExp('(?:^|[\\n{;])\\s*id\\s*\\(?\\s*["\\x27]' + escaped + '["\\x27][^\\r\\n;]*', 'm').exec(text);
      if (!match || /\bapply\s*(?:\(\s*)?false\b/.test(match[0])) continue;
      if (name === 'Ktor' && !/\bapplication\s*\{[^}]*\bmainClass(?:Name)?\b/.test(text)) continue;
      const wrapper = await findBuildWrapper(folder, root, process.platform === 'win32' ? 'gradlew.bat' : 'gradlew');
      const endpoint = name === 'Ktor' ? await ktorEndpoint(folder, text) : await jvmEndpoint(folder, name);
      return candidate(name, (wrapper ?? 'gradle') + ' ' + task, file + ' · ' + plugin, 'api', endpoint);
    }
  }
}

export async function detectBackendLaunchers(folder, root) {
  const [declared, ...launchers] = await Promise.all([
    projectProcess(folder), pythonStartup(folder), dotnetStartup(folder), goStartup(folder, root),
    rustStartup(folder), phpStartup(folder), rubyStartup(folder), gradleStartup(folder, root)
  ]);
  if (declared?.choice.port) {
    const target = /^(?:python3?\s+-m\s+)?uvicorn\s+([\w.]+:app)(?:\s|$)/.exec(declared.choice.command)?.[1];
    const fastapi = target && launchers.find(launcher => launcher?.name === 'FastAPI' && launcher.choice.command.includes(`uvicorn ${target} `));
    if (fastapi && !/--(?:root-path|app-dir|factory)\b/.test(declared.choice.command)) {
      declared.choice.kind = 'api';
      if (fastapi.choice.openPath) declared.choice.openPath = fastapi.choice.openPath;
    }
  }
  return { declared, launchers: launchers.filter(Boolean) };
}
