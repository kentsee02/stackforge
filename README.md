# StackForge

English | [华文](README.zh-CN.md)

A local, open-source full-stack project generator. Choose a frontend, backend, and database, then create a connected project in one step.

**Vue / React + Spring Boot / Express / NestJS + MySQL / PostgreSQL**, with frontend-only and backend-only options. Includes dependency installation, environment checks, reusable templates, Git setup, optional GitHub publishing, and resumable tasks. The generator has **zero third-party runtime dependencies**.

The Projects workspace lets you run local development sessions, manage databases, run build and test commands, and check Git status.

English is the default, with Chinese (华文) available from the top bar. Your choice is remembered in this browser; switching does not reload the page or interrupt a task. Generated project documentation and starter messages are in English.

## Quick start

1. Install [Node.js 22.12 or later](https://nodejs.org/en/download), including npm.
2. Open the [latest release](https://github.com/kentsee02/stackforge/releases/latest), download **Source code (zip)** under **Assets**, and extract it.
3. On Windows, double-click **Start StackForge.cmd** in the extracted folder. On macOS or Linux, open a terminal in that folder and run `npm run launch`.

The launcher opens your browser and uses port 4310 by default. Keep the terminal open while using StackForge. After updating, close the old StackForge service before launching the new version from the same checkout. StackForge itself requires no `npm install`. Install Git if you want to clone the repository or use Git features.

To try the latest development changes, clone the repository and launch it.

```sh
git clone https://github.com/kentsee02/stackforge.git
cd stackforge
npm run launch
```

Alternatively, run `npm start` and open [http://127.0.0.1:4310](http://127.0.0.1:4310). Set `PORT` to use another port, for example `$env:PORT=4311; npm start` in PowerShell.

When upgrading to a new folder, close StackForge and copy the local `.stackforge/` directory to the new folder to keep project records and settings.

### Create a project

1. Enter a project name. Use **Browse…** to pick a parent folder or enter an absolute path in **Save to**.
2. Choose your stack or apply a preset.
3. Review preflight checks and select dependency installation and Git operations.
4. After creation, open the project in VS Code, your file manager, or a terminal from the result panel. The same actions are available from **Task history** for completed projects.

The default parent folder is **Projects in your user home directory**, such as `C:\Users\your-name\Projects` on Windows, `/Users/your-name/Projects` on macOS, or `/home/your-name/Projects` on Linux. A project named `my-app` is created in `Projects/my-app`. This location is independent of the StackForge installation. The directory is created only when you create a project, and the existing destination checks still apply.

**Remember this location** restores your last parent folder when you return and suggests up to five recent folders. This preference is stored locally. Turn it off to clear the suggestions, or click **Use default** to return to your configured default. To set a different default, set `STACKFORGE_PROJECTS_DIR` to an absolute path before launching.

Desktop actions use the applications installed on your computer. On Windows, **Open terminal** starts PowerShell in the project folder. On Linux, **Browse…** requires `zenity` or `kdialog`. You can copy the project path from the result panel at any time.

## Manage local projects

Open **Projects** to find projects created by this StackForge checkout, including ones from earlier versions. Select a project and click **Start project** to run its existing `scripts/dev.mjs`. The page shows process status and streams the latest development output. Install the project's dependencies first if you skipped them during creation.

- **Open app** and **Open API** appear as their local checks pass. The backend check verifies `/api/health`.
- **Development ports** saves frontend, backend, and database port overrides per project for the next start. The frontend proxy follows the backend port. Projects generated with an older fixed-port launcher continue using their original ports.
- **Import project** accepts any existing local project directory. Framework labels, dependency installation, startup suggestions, and project checks share the same scan of the root, common service folders such as `services/*`, declared JavaScript workspaces, Maven modules, and saved service folders. Framework labels use dependencies, build plugins, and recognized entry points. A monorepo can show several frameworks. Folders with no detected framework are listed as **External project**. A valid StackForge manifest and launcher enable managed startup, dependencies, ports, and database controls. **Remove from Projects** clears the registration for ordinary imports.
- **Clone from GitHub** takes a repository HTTPS URL and a destination parent folder. It uses Git and your existing credentials for private repositories. **Cancel clone** stops Git and clears the temporary checkout before it is moved into the destination. Clone errors can identify missing Git, access, network, and destination problems. Clones use the same framework detection as local imports. **Delete project** requires the exact name, a matching clone marker, and a matching recorded filesystem identity before moving the directory to the system trash. Older clone records without that identity support removing the project from the list.
- **Remove from Projects** clears the registration for an imported or cloned project and leaves its files and database in place. If a folder was replaced, remove its stale registration and import the current folder to configure it again.
- **Startup configuration** lets an imported or cloned project without a StackForge launcher run up to six services together. Give each service a name, a folder relative to the project, and a trusted foreground shell command such as `npm run dev`. Use `.` for the root. An optional HTTP port is passed as `PORT` and checked for conflicts before launch. Add your framework’s port flag to the command if it reads ports from its own arguments. **Start project** runs the saved commands with named logs and links for responding HTTP services. **Stop project** stops the group. Commands are stored in local project settings, so keep credentials in the project's environment files.
- **Detect startup configuration** previews commands in the folders where they should run. It reads declared JavaScript and TypeScript scripts, Maven or Gradle plugins for Spring Boot, Quarkus, Micronaut and Ktor (Gradle), and conventional entry points for Django, FastAPI, Flask, ASP.NET Core, Go HTTP services, Rust web applications, Laravel and Rails. It also reads a single `web:` command from `Procfile.dev` or `Procfile` for any framework. The scan covers common service folders, declared JavaScript workspaces, Maven modules and saved service folders. Add suggestions to the editable draft, check runtime requirements and any port or URL fields, and save. You can always enter your own commands.
- Startup suggestions can also include an HTTP port and access path from explicit settings such as Vite server and base options, ASP.NET Core launch profiles, Spring Boot Swagger settings, and literal CLI arguments or routes. **Fill missing link settings** adds detected values to an existing matching service without replacing entries you have filled. Review and save the draft. You can enter either value manually when settings are dynamic, ambiguous, or absent. Links use loopback HTTP. **Open app** uses `/` by default, and **Open API** needs a path. A configured path is checked before its link appears.
- Installation and startup diagnostics explain recognized failures alongside the original log, including a missing Prisma `DATABASE_URL`, an unreachable database, an incompatible JDK or .NET SDK, outdated dependency lockfiles, and missing tools or Python modules.

**Install dependencies** runs npm or the Maven Wrapper for StackForge-generated projects. To define a custom install for an external project, add a trusted **Install command** in Startup configuration. A service can have an install command alone, which is useful for a workspace root or a library. Custom commands run in order from their respective folders and skip blank entries. Starting a project runs its startup commands only. The installation log shows progress and errors, and you can cancel and retry.

For imported and cloned projects, the Dependencies panel previews detected commands and their working directories. StackForge supports npm, pnpm, Yarn, and Bun declarations or lockfiles, Maven Wrapper, uv projects with `uv.lock`, and `requirements.txt` when a local `.venv` is present. Recognized JavaScript workspaces install at their workspace root. Review the list and choose **Install detected dependencies**. Ambiguous entries show a reason and are skipped. **Run custom install** uses the commands saved in Startup configuration and is also available when nothing is detected.

The same preview supports Gradle Wrapper `classes` for recognized JVM builds, `dotnet restore` for an unambiguous project or solution, `go mod download`, `cargo fetch`, Composer, and Bundler. Gradle's preparation step compiles the main sources and may write build output. The corresponding SDK or package manager needs to be available on the machine.

**Database controls** shows the Docker Compose database status and the last 100 lines of container output. A running container shows as starting until its configured database responds to a SQL query. The panel uses the project's saved database port and can start or stop the database separately. Stopping the database keeps its data volume.

Imported and cloned projects can use these controls when a single root Compose file defines one official MySQL or PostgreSQL service with a dedicated local named data volume. StackForge checks the recorded project directory, Compose labels, actual mounts and volume users. External volumes, shared volumes and ambiguous configurations are rejected. For older imports without a recorded directory identity, remove the registration and import the folder again. The database starts independently of the other Compose services.

**Download backup** exports a verified running database as a PostgreSQL custom archive or a MySQL SQL dump. Backup and restore both verify the attached project volume and connect through a Unix socket inside the verified container. You can also download a managed database backup from the project deletion dialog. MySQL uses the container's root password for export and includes tables, data, views, triggers, stored procedures, functions, and scheduled events. Dumps omit explicit definers so restored objects can use the destination account. **Restore backup** accepts a trusted file from the same database engine up to 64 MiB. Stop the application, start an empty project database, and type the exact project name to confirm. MySQL restore uses the configured non-root user and can require the server to allow stored functions and triggers. A failed restore can leave partially restored MySQL objects.

**Build, test & lint** uses the detected JavaScript package manager or npm when none is declared. Maven Wrapper `package` and `test` are available for discovered Maven projects, including imported Spring Boot projects. Detected checks also include Gradle, .NET, Go, and Rust build and test commands, Composer scripts, and supported Laravel and Rails tests and linters. Open **Custom check commands** to save a trusted build, test, or lint command and its working directory for any project. Select and run the saved command from the same panel. Stop the development server before running a check. The panel shows live output, the latest result, and a cancel button during execution. Keep credentials in the project's environment files.

**Git status** shows the current branch, pending changes, and how many commits the branch is ahead of or behind its tracked upstream. Refresh reads the local repository and compares it with the upstream information from the last fetch or pull.

**Stop project** stops the development processes started from this page. A normal StackForge shutdown also stops them. Development and installation logs are held in memory until StackForge restarts.

**Delete project** shows the folder path and asks you to type the exact project name. Stop the project in StackForge first. For newly generated and newly imported managed projects, StackForge checks the recorded filesystem identity before deletion. Earlier managed records still use the project manifest for verification. Project files go to the system trash and can be restored to their original location. Deletion also permanently removes the project's local Docker database container and its dedicated data volume. Docker must be running for projects with a database. StackForge blocks deletion when volume ownership is unclear, including older volumes with no matching container. On Linux, moving files to the system trash requires `gio` and a drive that supports it.

## Generated projects

- Vue 3 or React with Vite and TypeScript. Frontend `/api` requests proxy to the backend, which defaults to port 8080.
- Spring Boot from the official Spring Initializr service, using a stable release, Java 21, Maven Wrapper, a health endpoint, and optional JDBC connectivity.
- Express with TypeScript, a health endpoint, and an optional mysql2 / pg connection pool and database check endpoint.
- NestJS with TypeScript, a module and health controller, a development watcher, and optional MySQL or PostgreSQL connectivity. The NestJS full-stack preset pairs React with PostgreSQL.
- MySQL 8.4 or PostgreSQL 17 with Docker Compose, health checks, persistent volumes, and random local credentials.
- npm workspaces for the frontend and Node backend, plus a development launcher that starts the database when needed.
- `npm test` runs Vue and React render tests and Express and NestJS HTTP health tests without a database. Spring Boot keeps its Maven test entry.
- English README, .gitignore, stackforge.json, and optional Git repository on the main branch.
- npm dependencies resolved to exact versions at creation time, with a lockfile after installation.

Database passwords are stored in the Git-ignored `.env`. Share `.env.example` instead. First commits and GitHub publishing are optional and off by default.

## Preflight checks

Checks reflect the selected stack: Node.js, npm, JDK, Git, author identity, download sources, destination directory, and development ports. Database selections also check Docker Compose and its engine. GitHub CLI authentication and repository name availability are checked only when publishing is enabled.

Errors block creation and include recovery steps. npm and JDK are required immediately only when dependency installation needs them. A stopped Docker engine or occupied development port produces a startup warning, so files can still be generated. Requirements are checked again when a new task starts.

## Saved templates

Save the current stack under **My templates**. Saving an existing name replaces that template. Export/import JSON to back up templates or move them between browsers; duplicate names are skipped during import. Up to 20 templates are supported.

Templates live in browser storage for the current address. They contain stack choices, Group ID, installation, local Git, and first-commit options. They exclude project paths, names, author identity, credentials, and publishing permission. Applying a template always turns GitHub publishing off. Language preference is stored separately and is not part of a template.

## Git and GitHub

- **Initialize a local repository:** requires Git 2.28 or later. No account or sign-in is needed.
- **Create the first commit:** also requires an author name and email. Use existing Git configuration or enter an identity in the UI. An entered identity is saved only in the new project, without changing global Git settings.
- **Create a GitHub repository and push:** install [GitHub CLI](https://cli.github.com/) and run `gh auth login --hostname github.com` first. This includes local initialization and the first commit. Repositories are private by default; publishing publicly requires choosing Public.

The tool uses the current GitHub CLI account and does not collect passwords or tokens. It creates new repositories under that account and does not reuse or overwrite unrelated existing repositories.

Publishing happens after the local project is ready. If it fails, local files, dependencies, and commits remain available. Retry from the UI, including after restarting via task history. Recorded remotes are checked against the account, repository ID, and visibility before retrying. If a network failure prevents the creation result from being recorded, inspect GitHub first; StackForge will not assume a same-name repository belongs to this task.

## Cancel and resume

**Cancel task** stops downloads and installation process trees, then preserves the unfinished project in a `.stackforge-*` directory under the chosen parent directory.

**Resume unfinished steps** uses the original task configuration and skips completed stages. Completed files, existing `.env` passwords, and installation caches are preserved. An interrupted, incomplete file-generation stage may rewrite its own files. Start a new task to change the stack, name, or destination.

Task records are stored in the tool’s Git-ignored `.stackforge/jobs/` directory. They include paths, options, logs, and checkpoints, without copying `.env` passwords or GitHub credentials. After restarting, choose a task from **Task history**. Recovery validates directory ownership and stops if the retained directory was moved, removed, or its task marker no longer matches. Do not share `.stackforge/`: it may contain local paths and author identities. Unfinished directories are not automatically deleted.

UI labels, preflight results, task status, and StackForge messages support both languages, including earlier task records. Output from external tools such as npm, Maven, and Git is displayed as emitted by those tools.

## Requirements and network access

- StackForge: Node.js 22.12 or later, including npm.
- Spring Boot projects: Java 21 or later. Maven Wrapper is included; no global Maven is required.
- Databases: Docker Desktop or Docker Engine with Compose v2. Images are pulled on the first development startup.
- Git operations: Git 2.28 or later; commits need an author identity, and publishing needs an authenticated GitHub CLI.
- Creation accesses npm registry and, for Spring Boot, start.spring.io. Maven and Docker need network access for initial downloads.

StackForge listens only on `127.0.0.1`. Do not deploy it as a public service. Write requests validate Host, Origin, and a random per-start request token. Commands use fixed argument lists. Projects are built in staging directories and moved into place after success; existing destinations are never merged or overwritten.

## Development and validation

```sh
npm test
npm run check
npm start
```

Tests use Node’s built-in runner. They cover stack combinations, input validation, environment diagnostics, template filtering, real local commits, subprocess cancellation, restart recovery, directory ownership, launcher reuse, simulated GitHub retry, and local API protections. Unit tests do not create remote repositories.

For real frontend/backend/database integration:

```sh
npm run test:integration
```

Requires Git, a running Docker engine, network access, and free ports 5173 / 8080. The Spring Boot case also requires Java 21. Creates Vue + Express + PostgreSQL, React + Spring Boot + MySQL, and React + NestJS + PostgreSQL projects under `work/integration/`, installs and builds them, starts development services, performs real database queries through the frontend proxy, and writes `report.json`. Test services and containers stop afterward. Generated projects and their data volumes are kept for inspection.

Use `--only=node`, `--only=java`, or `--only=nest` to check one stack. The explicit command below also creates and pushes a **new private GitHub repository** under the current authenticated account and verifies its remote commit. The repository is retained; it is not archived or deleted. Default integration tests do not operate on GitHub.

```sh
npm run test:integration -- --only=node --github --repo-name=your-test-repository
```

Main modules: `src/generator.mjs` (creation), `src/checkpoint.mjs` (recovery), `src/jobs.mjs` / `src/job-store.mjs` (tasks), `src/templates.mjs` (generated code), `src/environment.mjs` (checks), `src/git.mjs` (Git/GitHub), `src/server.mjs` (local API), and `public/` (UI and localization). See [CONTRIBUTING.md](CONTRIBUTING.md) to contribute.

## Scope

Supports npm, Java 21 / Maven, Vue / React, Express / Spring Boot / NestJS, and MySQL / PostgreSQL. Global runtime installation, desktop installers, other package managers, and remote deployment are outside the current scope. Generated projects are development starters: add business logic, authentication, and production configuration as needed.

## Credits and license

Uses official [Vite](https://vite.dev/guide/) conventions and [Spring Initializr](https://docs.spring.io/initializr/docs/current/reference/html/) APIs. IBM Plex Sans comes from [IBM Plex](https://github.com/IBM/plex) under the SIL Open Font License; see [public/OFL.txt](public/OFL.txt). StackForge is [MIT licensed](LICENSE).
