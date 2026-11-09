import { lstat, opendir, realpath, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { findBuildWrapper, localText, npmManifest } from './project-detection.mjs';

function candidate(name, command, source, kind, port) {
  return { name, choice: { command, script: name, source, ...(kind && { kind }), ...(port && { port }) } };
}

async function nestedText(folder, file) {
  if (dirname(file) === '.') return localText(folder, file);
  const directory = await realpath(join(folder, dirname(file))).catch(() => null);
  if (!directory) return '';
  const within = relative(folder, directory);
  if (isAbsolute(within) || within.split(sep)[0] === '..') return '';
  return localText(directory, basename(file));
}

async function isFile(folder, name) {
  return (await lstat(join(folder, name)).catch(() => null))?.isFile() === true;
}

async function projectProcess(folder) {
  for (const file of ['Procfile.dev', 'Procfile']) {
    const text = await localText(folder, file);
    const commands = [...text.matchAll(/^web:[ \t]+([^\r\n]+)$/gm)].map(match => match[1].trim());
    if (commands.length === 1 && commands[0] && commands[0].length <= 500 && !/[\x00-\x1f\x7f]/.test(commands[0])) {
      return candidate('Web process', commands[0], file + ' · web');
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
  return { ...candidate('FastAPI', python + args, entry.file + ' · FastAPI', 'api'), entryPath };
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
  const urls = typeof settings?.applicationUrl === 'string' && !settings.environmentVariables?.ASPNETCORE_URLS ? settings.applicationUrl.split(';') : [];
  const http = urls.map(url => /^http:\/\/(?:localhost|127\.0\.0\.1):(\d+)\/?$/i.exec(url.trim())).filter(Boolean);
  const port = http.length === 1 ? Number(http[0][1]) : undefined;
  const program = await localText(folder, 'Program.cs');
  const kind = /\.MapControllers\s*\(|\.Map(?:Get|Group|Post)\s*\(\s*["']\/api(?:\/|["'])/.test(program) ? 'api' : undefined;
  return candidate('ASP.NET Core', command, project + (profile ? ' · launchSettings.json' : ''), kind, port >= 1024 && port <= 65535 ? port : undefined);
}

async function goStartup(folder, root) {
  const main = (await localText(folder, 'main.go')).replace(/\/\*[\s\S]*?\*\/|^[ \t]*\/\/.*$/gm, '');
  if (!/^package\s+main\b/m.test(main) || !/^func\s+main\s*\(/m.test(main)) return;
  if (!/"(?:net\/http|github\.com\/(?:gin-gonic\/gin|labstack\/echo(?:\/v\d+)?|gofiber\/fiber(?:\/v\d+)?|go-chi\/chi(?:\/v\d+)?))"/.test(main)) return;
  if (!/\b(?:ListenAndServe(?:TLS)?|Run|Start|Listen)\s*\(/.test(main)) return;
  for (let current = folder; ; current = dirname(current)) {
    if (await isFile(current, 'go.mod')) return candidate('Go', 'go run .', 'go.mod · main.go', 'api');
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
  if (/\bfn\s+main\s*\(/.test(main)) return candidate('Rust', 'cargo run --bin ' + name, 'Cargo.toml · src/main.rs', 'api');
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
    return candidate('Rails', 'ruby bin/rails server', 'Gemfile · bin/rails', 'web');
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
      return candidate(name, (wrapper ?? 'gradle') + ' ' + task, file + ' · ' + plugin, 'api');
    }
  }
}

export async function detectBackendLaunchers(folder, root) {
  const [declared, ...launchers] = await Promise.all([
    projectProcess(folder), pythonStartup(folder), dotnetStartup(folder), goStartup(folder, root),
    rustStartup(folder), phpStartup(folder), rubyStartup(folder), gradleStartup(folder, root)
  ]);
  return { declared, launchers: launchers.filter(Boolean) };
}
