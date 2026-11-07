# StackForge

English | [华文](README.zh-CN.md)

A local, open-source full-stack project generator. Choose a frontend, backend, and database, then create a connected project in one step.

**Vue / React + Spring Boot / Express + MySQL / PostgreSQL**, with frontend-only and backend-only options. Includes dependency installation, environment checks, reusable templates, Git setup, optional GitHub publishing, and resumable tasks. The generator has **zero third-party runtime dependencies**.

Version 0.5 makes the workspace easier to scan: compact presets, a persistent review column, collapsible templates and advanced Git options, file/command preview tabs, and a mobile action bar. Copy startup commands or use Ctrl/Cmd+Enter to create a project. Task status stays prominent during creation and recovery.

English is the default, with Chinese (华文) available from the top bar. Your choice is remembered in this browser; switching does not reload the page or interrupt a task. Generated project documentation and starter messages are in English.

## Quick start

Install [Node.js](https://nodejs.org/en/download) 22.12 or later (Node.js 24 LTS recommended). Install Git to clone this repository and use Git features.

```sh
git clone https://github.com/kentsee02/stackforge.git
cd stackforge
npm run launch
```

The launcher opens your browser, reuses an existing server for this checkout, and tries another port if 4310 is occupied. **On Windows, double-click `Start StackForge.cmd`** instead. Keep the terminal open while using the tool. No `npm install` is needed for StackForge itself.

Alternatively, run `npm start` and open [http://127.0.0.1:4310](http://127.0.0.1:4310). Set `PORT` to use another port, for example `$env:PORT=4311; npm start` in PowerShell.

1. Enter a project name. Use **Browse…** to pick a parent folder or enter an absolute path in **Save to**.
2. Choose your stack or apply a preset.
3. Review preflight checks and select dependency installation and Git operations.
4. After creation, open the project in VS Code, your file manager, or a terminal from the result panel. The same actions are available from **Task history** for completed projects.

The default parent folder is **Projects in your user home directory**, such as `C:\Users\your-name\Projects` on Windows, `/Users/your-name/Projects` on macOS, or `/home/your-name/Projects` on Linux. A project named `my-app` is created in `Projects/my-app`. This location is independent of the StackForge installation. The directory is created only when you create a project, and the existing destination checks still apply.

**Remember this location** restores your last parent folder when you return and suggests up to five recent folders. This preference is stored locally. Turn it off to clear the suggestions, or click **Use default** to return to your configured default. To set a different default, set `STACKFORGE_PROJECTS_DIR` to an absolute path before launching.

Desktop actions use the applications installed on your computer. On Windows, **Open terminal** starts PowerShell in the project folder. On Linux, **Browse…** requires `zenity` or `kdialog`. You can copy the project path from the result panel at any time.

## Generated projects

- Vue 3 or React with Vite and TypeScript. Frontend `/api` requests proxy to the backend on port 8080.
- Spring Boot from the official Spring Initializr service, using a stable release, Java 21, Maven Wrapper, a health endpoint, and optional JDBC connectivity.
- Express with a health endpoint and optional mysql2 / pg connection pool and database check endpoint.
- MySQL 8.4 or PostgreSQL 17 with Docker Compose, health checks, persistent volumes, and random local credentials.
- npm workspaces for the frontend and Node backend, plus a development launcher that starts the database when needed.
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

Requires Git, Java 21, a running Docker engine, network access, and free ports 5173 / 8080. Creates Vue + Express + PostgreSQL and React + Spring Boot + MySQL projects under `work/integration/`, installs and builds them, starts development services, performs real database queries through the frontend proxy, and writes `report.json`. Test services and containers stop afterward; projects and database volumes remain.

Use `--only=node` or `--only=java` to check one stack. The explicit command below also creates and pushes a **new private GitHub repository** under the current authenticated account and verifies its remote commit. The repository is retained; it is not archived or deleted. Default integration tests do not operate on GitHub.

```sh
npm run test:integration -- --only=node --github --repo-name=your-test-repository
```

Main modules: `src/generator.mjs` (creation), `src/checkpoint.mjs` (recovery), `src/jobs.mjs` / `src/job-store.mjs` (tasks), `src/templates.mjs` (generated code), `src/environment.mjs` (checks), `src/git.mjs` (Git/GitHub), `src/server.mjs` (local API), and `public/` (UI and localization). See [CONTRIBUTING.md](CONTRIBUTING.md) to contribute.

## Scope

Supports npm, Java 21 / Maven, Vue / React, Express / Spring Boot, and MySQL / PostgreSQL. Global runtime installation, desktop installers, other package managers, and remote deployment are outside the current scope. Generated projects are development starters: add business logic, authentication, and production configuration as needed.

## Credits and license

Uses official [Vite](https://vite.dev/guide/) conventions and [Spring Initializr](https://docs.spring.io/initializr/docs/current/reference/html/) APIs. IBM Plex Sans comes from [IBM Plex](https://github.com/IBM/plex) under the SIL Open Font License; see [public/OFL.txt](public/OFL.txt). StackForge is [MIT licensed](LICENSE).
