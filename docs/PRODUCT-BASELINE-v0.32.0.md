# StackForge v0.32.0 product baseline

This baseline describes the behavior available at commit [`7596db9`](https://github.com/kentsee02/stackforge/commit/7596db99a9137026938f2e92158fe99ad9783e49). Use it to review product scope and check behavior before and after the refactor. Database capabilities apply only to the listed engines, providers, and prerequisites.

## Web entry points

- **Create project** at `/` includes stack selection, preflight, generation, saved templates, and creation task history.
- **Projects** at `/projects` includes local import, GitHub clone, registered projects, and project details. Startup, dependencies, checks, Git status, and database controls are in the selected project's details.
- The interface defaults to English and supports live switching to Simplified Chinese. The choice is saved in the current browser. Generated documentation is in English.
- The app uses a loopback HTTP server. The default port is 4310. The launcher opens the browser, can find a free port, and reuses a server for the same checkout and version.

[Create page](../public/create/index.html) · [Projects page](../public/projects/index.html) · [Localization](../public/shared/i18n.js) · [Launcher](../scripts/launcher.mjs)

## Create a new project

- Choose Vue or React for the frontend, Spring Boot, Express, or NestJS for the backend, and PostgreSQL or MySQL for the database. Frontend-only and backend-only projects are supported. A database choice requires a backend. The creation tests cover 29 valid combinations.
- Preview the files and commands and run preflight checks for the selected stack. Files can include TypeScript, a frontend API proxy, backend health endpoints, Docker Compose, a development launcher, and stack-specific tests. Available output depends on the selected stack.
- Enter an absolute save directory or select one through the desktop picker where supported. The default is `Projects` under the user's home directory, with an optional `STACKFORGE_PROJECTS_DIR` override. The app can remember the last directory and up to five recent choices. Existing project directories are protected.
- Save reusable stack templates in the browser and import or export them as JSON. Exported templates exclude local paths, Git identity, and authority to publish to GitHub.
- Install dependencies during creation or later. Optional Git initialization works offline with Git installed. An initial commit requires author identity. GitHub publishing requires an authenticated GitHub CLI, is off by default, and defaults to private visibility when enabled.
- Cancel a creation task or resume its unfinished steps from a saved checkpoint. Resuming uses the original options and preserves completed steps. A GitHub publishing failure preserves the local project and allows the publication step to be retried.

[Stack definitions](../src/generation/catalog.mjs) · [Generation workflow](../src/generation/generator.mjs) · [Creation tasks](../src/generation/jobs.mjs) · [Templates](../public/create/template-store.js)

## Import, clone, and manage local projects

- Import an existing local project folder. Clone from a GitHub HTTPS URL into an unused destination. A clone uses the machine's existing Git credentials if access is required. It can be cancelled while cloning, and registration completes once the checkout has been promoted.
- Import and clone share registration and discovery. A compatible StackForge manifest and launcher enable managed behavior. Other projects can be registered with recognized frameworks or as **External project** when detection is inconclusive. Registration does not require dependencies or a running database.
- Discovery reads manifests, dependencies, plugins, entry points, workspace definitions, common service folders, and configured service directories. It can detect multiple components in one repository. Discovery of a framework or tool is distinct from permission to execute it.
- Recognizes reviewed startup, dependency, and check definitions across supported JavaScript and TypeScript tooling, JVM projects, Python, .NET, Go, Rust, PHP, and Ruby. Exact commands depend on the project files and installed tools. Examples include npm, pnpm, Yarn, Bun, Maven Wrapper, Gradle Wrapper, uv, `requirements.txt` with a local virtual environment, .NET restore, Go modules, Cargo, Composer, and Bundler.
- Start or stop the managed launcher or a group of up to six configured services. External projects can save trusted foreground startup and install commands with separate project-relative working directories. Startup suggestions can fill missing port and path fields when explicit configuration is recognized. Custom build, test, and lint commands remain available.
- Inspect recent process logs and recognized failure diagnostics. Eligible installation and check tasks can be cancelled. App and API links are shown when their configured local HTTP checks pass. Managed projects with a compatible launcher can save development port overrides for their next run.
- View current Git branch, changes, and upstream differences using the local repository and its last fetched upstream state. Open the folder, editor, or terminal where supported by the desktop environment.
- Re-import a moved original directory on the same filesystem to retain its registered identity and settings when verification succeeds. A replacement directory requires separate registration before protected actions.

[Project API](../src/http/server.mjs) · [Service discovery](../src/projects/detection/project-services.mjs) · [Dependency plans](../src/projects/dependency-plan.mjs) · [Runtime](../src/projects/project-runtime.mjs) · [Project checks](../src/projects/project-tools.mjs)

## Database capabilities

**Discovery and connection configuration.** The project page can identify declared dependencies, missing or placeholder settings, ambiguous configuration, and configured targets. Multiple bindings per project and potentially shared targets are represented. Presence of a URL or a published port alone does not establish database readiness. An identified PostgreSQL or MySQL connection variable can be added when missing or replaced in an eligible `.env` or `.env.local` file. In Git projects the file must be ignored and untracked. A saved secret is not prefilled in the form.

- **PostgreSQL and MySQL through Docker Compose.** Eligible managed or imported services can be started and stopped independently, show database readiness and recent redacted logs, and can be backed up or restored. Imports may select among eligible services in one root Compose file. The target must use the expected official image and a dedicated, verified local data volume. Permanent volume deletion is available separately for verified StackForge-managed volumes.
- **PostgreSQL and MySQL through local direct connections.** StackForge can check local installation and connectivity, preview database creation, and initialize supported `CREATE TABLE` declarations from `database/migrations/*.sql`. Confirmation and sufficient permissions are required. Backup and restore are available for supported direct URLs with the necessary native clients and privileges.
- **PostgreSQL with Prisma 7.** The setup dialog guides users when the server or `psql` is unavailable, diagnoses connection failures, offers to create a missing database, and saves the connection URL. A recognized local direct connection and project-installed Prisma 7 CLI enable review and explicit application of committed migrations. The readiness check verifies the connection, migration history, and presence of tables.
- **Remote PostgreSQL and MySQL.** Users can verify and save eligible TLS connections using native clients and a selected CA certificate. Profiles use Windows DPAPI or Linux Secret Service for the password. Backup and restore are available when the connection and database grants allow them. Database and server provisioning, startup, and deletion are handled with the provider's tools.
- **SQLite.** Inspect schema, create a missing file at an eligible project-relative path, take a backup including committed WAL data, and restore to a missing file. Active or leftover journal files block writes where required.
- **MongoDB, Redis, and SQL Server.** Recognized local targets have read-only connection checks using their native clients. StackForge has no backup, restore, or lifecycle controls for these engines in this version.

**Backups.** The `.sfdb` format records engine, version, and SHA-256 checksum. PostgreSQL supports server-side streaming of payloads up to 512 MiB. MySQL and SQLite have a 64 MiB payload limit. PostgreSQL and MySQL backup verification and restore preview require the matching official Docker image. Restore checks the archive, previews the target, and requires exact confirmation. SQL restores require a verified empty database. SQLite restore requires a missing destination file.

[Database discovery](../src/database/discovery.mjs) · [Database resources](../src/database/resources.mjs) · [Prisma setup](../src/database/prisma-setup.mjs) · [Local connection checks](../src/database/adapters/local-status.mjs)

## Removal and data boundaries

- **Remove from Projects** clears registration for an eligible imported or cloned project and keeps its directory. It also cleans up its StackForge bindings and saved connection profiles.
- **Delete project** moves an eligible StackForge-managed directory or verified clone to the system trash. It requires the exact project name, stopped project state, and filesystem identity checks. Older unverifiable clones can be removed from the list. Project-local files, including SQLite databases, move with the directory. Docker data volumes and separate database servers remain independent.
- **Delete data volume** is a separate operation for a verified StackForge-managed Compose volume. It requires the exact volume name and checks stopped state, ownership, and shared use. Removing a project registration or directory does not delete the Docker volume.

[Project removal](../src/projects/project-removal.mjs) · [Database routes](../src/http/database-routes.mjs) · [Compose lifecycle](../src/database/docker/project-database.mjs)

## Compatibility and regression checks

- Preserve project IDs, recorded folder identities, startup and check configurations, port overrides, and relocation behavior.
- Preserve the persisted formats used by `.stackforge/projects.json`, `.stackforge/settings.json`, `.stackforge/jobs/`, `.stackforge/databases.json`, and `.stackforge/database-operations.jsonl`, including database bindings and credential references. Preserve browser-stored language, templates, and creation preferences. Active process state and recent runtime logs are session state.
- Preserve trusted-command confirmation, cancellation, resumable creation, secret handling, and destructive-operation guards. Preserve existing page URLs, API contracts, and older supported launchers while moving implementation boundaries.
- Local verification on 2026-11-16 passed **95 tests**. The [CI run for the baseline commit](https://github.com/kentsee02/stackforge/actions/runs/43712347690) passed **10 jobs**. Coverage includes Windows and Ubuntu on Node.js 22 and 24, live browser localization, real PostgreSQL/MySQL integration, Windows native PostgreSQL, Prisma migration and large archive transfer, and representative Vue + Express + PostgreSQL, React + Spring Boot + MySQL, and React + NestJS + PostgreSQL flows. SQLite has a real-file test. The MongoDB, Redis, and SQL Server connection tests stub the client commands.

[Current code map](CODE-MAP.md) · [CI workflow](../.github/workflows/ci.yml)

## Scope for the architecture revision

An independent dashboard, global task queue, cloud database lifecycle management, theme and notification settings, and additional ORM migration adapters are candidates for future product decisions. The refactor acceptance baseline is the set of workflows above.
