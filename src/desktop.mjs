import { spawn } from 'node:child_process';
import { stat, lstat } from 'node:fs/promises';
import { posix, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run, throwIfCancelled } from './process.mjs';
import { absoluteDirectory } from './paths.mjs';

const pickerScript = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName System.Windows.Forms
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = $env:STACKFORGE_PICKER_TITLE
$dialog.SelectedPath = $env:STACKFORGE_PICKER_PATH
$dialog.ShowNewFolderButton = $true
$owner = New-Object System.Windows.Forms.Form
$owner.Text = 'StackForge'
$owner.StartPosition = 'CenterScreen'
$owner.ClientSize = New-Object System.Drawing.Size(320, 80)
$owner.TopMost = $true
$owner.ShowInTaskbar = $true
$owner.Show()
try {
  if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) {
    ConvertTo-Json -Compress -InputObject @{path=$dialog.SelectedPath}
  } else { '{"path":null}' }
} finally { $dialog.Dispose(); $owner.Dispose() }
`;
const terminalScript = "$ErrorActionPreference='Stop'; Set-Location -LiteralPath $env:STACKFORGE_OPEN_PATH; $host.UI.RawUI.WindowTitle='StackForge - ' + (Split-Path -Leaf $env:STACKFORGE_OPEN_PATH)";
const macPicker = 'on run argv\ntry\nset chosen to choose folder with prompt (item 2 of argv) default location (POSIX file (item 1 of argv))\nreturn POSIX path of chosen\non error number -128\nreturn ""\nend try\nend run';
const macTerminal = 'on run argv\ntell application "Terminal"\nactivate\ndo script "cd -- " & quoted form of (item 1 of argv)\nend tell\nend run';
const macTrash = `function run(argv) {
  ObjC.import('Foundation');
  const url = $.NSURL.fileURLWithPath(argv[0]);
  if (!$.NSFileManager.defaultManager.trashItemAtURLResultingItemURLError(url, null, null)) throw Error('Trash rejected the folder.');
}`;
const windowsTrash = "$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; Add-Type -Path $env:STACKFORGE_RECYCLE_SOURCE; [StackForgeRecycle]::Move($env:STACKFORGE_TRASH_PATH)";
const encoded = value => Buffer.from(value, 'utf16le').toString('base64');
// A detached Node child has no Windows console. Start a visible one from PowerShell.
const startTerminalScript = `Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') -ArgumentList @('-NoLogo', '-NoProfile', '-NoExit', '-EncodedCommand', '${encoded(terminalScript)}') -WindowStyle Normal -ErrorAction Stop`;

async function exists(path) { try { return (await stat(path)).isFile(); } catch { return false; } }
export function launchApplication(command, args, { cwd, env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, shell: false, detached: true, windowsHide: false, stdio: 'ignore' });
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); resolve(); });
  });
}

export function createDesktop({ platform = process.platform, env = process.env, fileExists = exists, statDirectory = stat, lstatDirectory = lstat, command = run, launch = launchApplication } = {}) {
  const paths = platform === 'win32' ? win32 : posix;
  let pickerController;
  const find = async name => {
    const extensions = platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
    for (let directory of (env.PATH || env.Path || '').split(platform === 'win32' ? ';' : ':')) {
      directory = directory.replace(/^"|"$/g, '');
      if (!paths.isAbsolute(directory)) continue;
      for (const extension of extensions) { const candidate = paths.join(directory, name + extension); if (await fileExists(candidate)) return candidate; }
    }
  };
  async function tools() {
    if (platform === 'win32') {
      const system = env.SystemRoot || env.WINDIR || 'C:\\Windows';
      const powershell = paths.join(system, 'System32/WindowsPowerShell/v1.0/powershell.exe');
      const explorer = paths.join(system, 'explorer.exe');
      const cli = await find('code');
      const candidates = [cli && paths.resolve(paths.dirname(cli), '../Code.exe'), env.LOCALAPPDATA && paths.join(env.LOCALAPPDATA, 'Programs/Microsoft VS Code/Code.exe'), env.ProgramFiles && paths.join(env.ProgramFiles, 'Microsoft VS Code/Code.exe')].filter(Boolean);
      let vscode; for (const candidate of candidates) if (await fileExists(candidate)) { vscode = candidate; break; }
      const shell = await fileExists(powershell) ? powershell : undefined;
      return { picker: shell, folder: await fileExists(explorer) ? explorer : undefined, vscode, terminal: shell };
    }
    if (platform === 'darwin') return { picker: await fileExists('/usr/bin/osascript') ? '/usr/bin/osascript' : undefined, folder: await fileExists('/usr/bin/open') ? '/usr/bin/open' : undefined, vscode: await find('code') || (await fileExists('/Applications/Visual Studio Code.app/Contents/MacOS/Electron') ? '/Applications/Visual Studio Code.app/Contents/MacOS/Electron' : undefined), terminal: await fileExists('/usr/bin/osascript') ? '/usr/bin/osascript' : undefined };
    if (platform === 'linux') {
      let terminal;
      for (const name of ['gnome-terminal', 'konsole', 'xfce4-terminal', 'x-terminal-emulator', 'xterm']) { const executable = await find(name); if (executable) { terminal = executable; break; } }
      return { picker: await find('zenity') || await find('kdialog'), folder: await find('xdg-open'), vscode: await find('code'), terminal };
    }
    return {};
  }
  return {
    async capabilities() { return Object.fromEntries(Object.entries({ picker: undefined, folder: undefined, vscode: undefined, terminal: undefined, ...await tools() }).map(([key, value]) => [key, Boolean(value)])); },
    async pickDirectory(initial, { language = 'en', signal } = {}) {
      if (pickerController) throw new Error('A folder picker is already open. Close it before trying again.');
      pickerController = new AbortController();
      const controller = pickerController;
      const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
      try {
        const available = await tools();
        if (!available.picker) throw new Error('No system folder picker is available. Enter an absolute path manually.');
        let directory = absoluteDirectory(initial, platform);
        while (true) {
          try { if ((await statDirectory(directory)).isDirectory()) break; } catch { /* choose the nearest existing parent */ }
          const parent = paths.dirname(directory);
          if (parent === directory) throw new Error('No accessible parent folder was found. Enter another path.');
          directory = parent;
        }
        const title = language === 'zh-CN' ? '选择新项目的保存父目录' : 'Choose a parent folder for your new project';
        let selected;
        const config = { timeout: 600000, signal: combined, stdoutOnly: true, env: { ...env, STACKFORGE_PICKER_PATH: directory, STACKFORGE_PICKER_TITLE: title } };
        if (platform === 'win32') selected = JSON.parse((await command(available.picker, ['-NoLogo', '-NoProfile', '-STA', '-EncodedCommand', encoded(pickerScript)], config)).trim()).path;
        else if (platform === 'darwin') selected = (await command(available.picker, ['-e', macPicker, '--', directory, title], config)).trim();
        else {
          const args = paths.basename(available.picker) === 'zenity' ? ['--file-selection', '--directory', '--filename', directory + paths.sep, '--title', title] : ['--getexistingdirectory', directory, '--title', title];
          try { selected = (await command(available.picker, args, config)).trim(); }
          catch (error) { if (error.exitCode === 1) return null; throw error; }
        }
        throwIfCancelled(combined);
        if (!selected) return null;
        const result = absoluteDirectory(selected, platform);
        if (!(await statDirectory(result)).isDirectory()) throw new Error('The selected location is not a directory.');
        return result;
      } finally { if (pickerController === controller) pickerController = undefined; }
    },
    async openProject(path, action) {
      if (!['folder', 'vscode', 'terminal'].includes(action)) throw new Error('Unsupported project action.');
      path = absoluteDirectory(path, platform);
      let info; try { info = await lstatDirectory(path); } catch { throw new Error('The project directory is no longer available. Check its location.'); }
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('The project directory was moved or replaced. Check its location.');
      const available = await tools();
      if (!available[action]) throw new Error(action === 'vscode' ? 'VS Code was not found. Install it, then refresh this page.' : 'No compatible desktop application was found for this action.');
      const config = { cwd: path, env: { ...env, STACKFORGE_OPEN_PATH: path } };
      if (action === 'folder') {
        if (platform === 'win32') await launch(available.folder, [path], config);
        else await command(available.folder, [path], { ...config, timeout: 15000 });
      } else if (action === 'vscode') await launch(available.vscode, ['--new-window', path], config);
      else if (platform === 'win32') await command(available.terminal, ['-NoLogo', '-NoProfile', '-EncodedCommand', encoded(startTerminalScript)], { ...config, timeout: 15000 });
      else if (platform === 'darwin') await command(available.terminal, ['-e', macTerminal, '--', path], { ...config, timeout: 15000 });
      else {
        const name = paths.basename(available.terminal);
        await launch(available.terminal, name === 'gnome-terminal' || name === 'xfce4-terminal' ? ['--working-directory', path] : name === 'konsole' ? ['--workdir', path] : [], config);
      }
    },
    async trashProject(path) {
      path = absoluteDirectory(path, platform);
      const info = await lstatDirectory(path);
      if (!info.isDirectory() || info.isSymbolicLink() || paths.parse(path).root === path) throw new Error('The project folder cannot be safely recycled.');
      const config = { timeout: 25000, env };
      try {
        if (platform === 'win32') {
          const shell = (await tools()).picker;
          if (!shell) throw new Error();
          await command(shell, ['-NoLogo', '-NoProfile', '-STA', '-EncodedCommand', encoded(windowsTrash)], { ...config, env: { ...env, STACKFORGE_TRASH_PATH: path, STACKFORGE_RECYCLE_SOURCE: fileURLToPath(new URL('./recycle-windows.cs', import.meta.url)) } });
        } else if (platform === 'darwin') {
          await command('/usr/bin/osascript', ['-l', 'JavaScript', '-e', macTrash, '--', path], config);
        } else {
          const gio = platform === 'linux' && await find('gio');
          if (!gio) throw new Error();
          await command(gio, ['trash', '--', path], config);
        }
      } catch { throw new Error('The system trash did not accept this folder. Check the drive and close any apps using the project.'); }
    },
    shutdown() { pickerController?.abort(); }
  };
}
