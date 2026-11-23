# StackForge code map

Use this map to locate the current implementation and its checks. The [architecture specification](../ARCHITECTURE.md) defines module ownership and dependency rules, the [v0.32.0 baseline](PRODUCT-BASELINE-v0.32.0.md) records existing product behavior, and the [refactor checklist](REFACTOR-CHECKLIST.md) records completed work and verification.

## Entry points

- `npm start` starts the loopback HTTP server in `src/http/server.mjs`.
- `npm run launch` and `Start StackForge.cmd` use `scripts/launcher.mjs` to open or reuse the local server.
- `package.json` provides the application version for both pages, `/api/identity`, and generated project manifests. Generated projects have their own package version.

## Find a feature

- **Create a project.** `public/create/` contains the form, task history, and saved stack templates. `src/generation/` contains stack definitions, files for generated projects, preflight, and resumable jobs.
- **Route a request.** `src/http/server.mjs` composes the local app, checks request origin and write access, and dispatches to `generation-routes.mjs`, `project-routes.mjs`, or the database adapters. The browser keeps the same paths and local settings.
- **Manage a project.** `src/projects/project-queries.mjs` assembles the project list and read models. `src/projects/project-workflows.mjs` coordinates startup configuration, port changes, command checks, runtime transitions, and database lifecycle requests. `src/projects/detection/project-services.mjs` combines declared workspaces, saved service paths, and a bounded repository scan. Framework labels, startup suggestions, dependency plans, checks, and database discovery use that service inventory.
- **Check startup readiness.** `src/projects/project-preflight.mjs` checks imported and cloned projects using the saved configuration, static database discovery, and loopback port probes. `public/projects/preflight.js` renders the results and opens the existing setup controls.
- **Register or relocate a project.** `src/projects/project-registry.mjs` combines generated and imported records and owns the registration path used by both local import and GitHub clone. It verifies relocation and calls the database catalog to refresh bindings. `src/projects/project-clone.mjs` owns the staged checkout and cancellation boundary. `src/projects/project-folder.mjs` verifies folder and launcher identity, and `src/projects/project-config.mjs` persists project settings.
- **Remove or recycle a project.** `src/projects/project-removal.mjs` chooses between removing the registration and sending the verified folder to the system trash. It holds the project lock through binding and credential cleanup. Permanent volume deletion is handled by the database workflow.
- **Manage a database.** `src/database/workflows.mjs` coordinates binding lookup, target verification, database actions, and operation locks. `src/database/docker/project-database.mjs` verifies and manages Compose services. `src/http/database-routes.mjs` maps JSON requests and responses. `src/http/database-archive-routes.mjs` handles streaming and temporary upload and download files.
- **Set up project development databases.** `src/database/development-setup.mjs` groups engine evidence and reusable targets by service. `src/database/docker/development-database.mjs` validates creation plans, manages owned PostgreSQL and MySQL containers, and provides a verified MySQL archive target. Ownership records live in the database registry.
- **Preview and apply Drizzle migrations.** `src/database/migrations/drizzle-config.mjs` reads the static configuration, `drizzle-sql.mjs` recognizes supported statement forms, and `src/database/migrations/drizzle-preview.mjs` owns the preview, approval, and database transaction. `public/projects/drizzle-preview.js` renders the inline workflow.
- **Preview Alembic revisions and PostgreSQL history.** `src/database/migrations/alembic-config.mjs` recognizes service configuration, `alembic-preview.mjs` reads and orders revision declarations, and `alembic-history.mjs` compares them with the selected database. `public/projects/alembic-preview.js` renders the inline workflow.
- **Preview EF Core migration files.** `src/database/migrations/ef-core-preview.mjs` scans C# declarations by project and context. `public/projects/ef-core-preview.js` renders the read-only preview.
- **Preview Flyway SQL migrations.** `src/database/migrations/flyway-config.mjs` resolves supported service-local configuration and profiles. `flyway-preview.mjs` enumerates and orders local SQL migration filenames. `public/projects/flyway-preview.js` renders the inline preview.
- **Preview Liquibase changesets.** `src/database/migrations/liquibase-config.mjs` resolves changelog roots, `liquibase-changelog.mjs` reads declarations, and `liquibase-preview.mjs` follows the local references. `public/projects/liquibase-preview.js` displays source files and review flags.
- **Execute and inspect commands.** `src/platform/process.mjs` provides process execution, cancellation, and termination. `src/database/security/secrets.mjs` handles fragmented stdout and stderr redaction for project services and finite project operations. `src/generation/jobs.mjs`, `src/projects/project-runtime.mjs`, and `src/projects/project-operations.mjs` manage resumable creation, long-lived processes, and finite operations respectively.
- **Probe and diagnose.** `src/platform/ports.mjs` is the loopback port check shared by preflight and runtime. `src/projects/project-diagnostics.mjs` classifies command failures using the diagnostic keys consumed by both runtime and database responses.
- **Edit the web interface.** `public/projects/page.js` coordinates project selection, polling, and request state. Startup, dependencies, checks and Git, and databases have their own panel modules in `public/projects/`. `public/shared/` holds common CSS and localization. `src/http/assets.mjs` maps public URLs to files and inserts the current version into both pages.

## Run checks

`npm run check` syntax-checks JavaScript and checks static source dependencies for cycles, imports of HTTP adapters from other modules, and imports of application modules from platform helpers. `npm test` runs the suites under `test/database/`, `test/generation/`, `test/platform/`, `test/projects/`, and `test/web/`. The real integration suites are in `scripts/integration/`.

Local task history, registered projects, settings, and database bindings are stored under `.stackforge/` at the repository root. Generated and imported projects live in their own directories.

- `npm run test:browser` covers the Projects page in English and Chinese. It checks Prisma setup and separate service directories, imports a local project and clones a test repository, then starts projects, follows their ready links, checks logs, and stops the processes. The test uses an isolated Git transport.
- `npm run test:development-postgres` verifies native Docker provisioning, connection-file writes, persistence, shared-use protection, refusal of a replacement container, and exact-volume removal.
- `npm run test:secret-service` runs on Linux with D-Bus, `gnome-keyring-daemon`, `gdbus`, and `secret-tool` installed. It launches a private session bus and keyring with temporary storage, then tests profile storage, retrieval, lock handling, and removal through the normal HTTP routes.

See the [database checklist](DATABASE-ROADMAP.md), [product context](PRODUCT.md), and [design notes](DESIGN.md) for feature details.
