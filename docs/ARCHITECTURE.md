# StackForge code map

## Entry points

- `npm start` starts the loopback HTTP server in `src/http/server.mjs`.
- `npm run launch` and `Start StackForge.cmd` use `scripts/launcher.mjs` to open or reuse the local server.
- `package.json` provides the application version for both pages, `/api/identity`, and generated project manifests. Generated projects have their own package version.

## Find a feature

- **Create a project.** `public/create/` contains the form, task history, and saved stack templates. `src/generation/` contains stack definitions, files for generated projects, preflight, and resumable jobs.
- **Manage a project.** `public/projects/page.js` controls the project list and coordinates import, startup, dependencies, and checks. `src/projects/` manages registered projects and subprocesses. `src/projects/detection/` reads service manifests and startup settings.
- **Manage a database.** `public/projects/database.js` handles the database panels and dialogs. `src/http/database-routes.mjs` handles discovery, configuration, initialization and archive requests. `src/database/` contains discovery, registry and resource operations, with separate folders for adapters, backups, Compose verification and credential protection.
- **Use system tools.** `src/platform/` contains filesystem paths and identity checks, process execution, desktop actions, Git, and local preferences.
- **Edit the web interface.** Each page has its own HTML and JavaScript. `public/shared/` holds common CSS and localization. `src/http/assets.mjs` maps public URLs to files and inserts the current version into both pages.

## Run checks

`npm run check` syntax-checks JavaScript files recursively. `npm test` runs the suites under `test/database/`, `test/generation/`, `test/platform/`, `test/projects/`, and `test/web/`. The real integration suites are in `scripts/integration/`.

Local task history, registered projects, settings, and database bindings are stored under `.stackforge/` at the repository root. Generated and imported projects live in their own directories.

See the [database checklist](DATABASE-ROADMAP.md), [product context](PRODUCT.md), and [design notes](DESIGN.md) for feature details.
