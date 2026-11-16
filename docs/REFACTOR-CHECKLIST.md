# StackForge architecture refactor checklist

The [StackForge Architecture & Modular Design Specification](../ARCHITECTURE.md) defines product boundaries and acceptance criteria. Use the [v0.32.0 baseline](PRODUCT-BASELINE-v0.32.0.md) for compatibility requirements and the [code map](CODE-MAP.md) for current implementation paths.

## P0 — Baseline, project identity, and removal

- [x] Record the creation, import, clone, startup, database, and removal capabilities and persisted formats from v0.32.0. See the [product baseline](PRODUCT-BASELINE-v0.32.0.md).
- [x] Route import and clone through the same registration path. Keep verified relocation with the registry and verify clone and filesystem identity before recycling. See the [registry](../src/projects/project-registry.mjs), [clone workflow](../src/projects/project-clone.mjs), and [folder checks](../src/projects/project-folder.mjs).
- [x] Give registration removal and verified recycling one project workflow. Preserve exact-name confirmation, folder identity checks, saved binding cleanup, and independent Docker volume deletion. See [project removal](../src/projects/project-removal.mjs) and [lifecycle and replacement-folder tests](../test/projects/project-runtime.test.mjs).
- [x] Hold the same project lock during registration removal and credential cleanup. A failed vault cleanup leaves registration available for retry and releases the lock. See the [concurrent removal regression](../test/database/database-p2.test.mjs).

## P1 — Transport, database, and execution boundaries

- [x] Keep request authorization and server composition in the HTTP entry point. Route project and generation requests through their adapters and coordinate operations in the owning workflow. See the [HTTP entry point](../src/http/server.mjs), [project workflows](../src/projects/project-workflows.mjs), and [generation routes](../src/http/generation-routes.mjs).
- [x] Keep binding, target, backup, and restore decisions in the database workflow. Separate Compose lifecycle operations from the HTTP paths for JSON and archive streaming. See [database workflows](../src/database/workflows.mjs), [Compose lifecycle](../src/database/docker/project-database.mjs), and [archive transport](../src/http/database-archive-routes.mjs).
- [x] Share process shutdown and streaming secret redaction across callers. Keep creation jobs, project services, and finite operations under their respective owners. See [process helpers](../src/platform/process.mjs) and [redaction](../src/database/security/secrets.mjs).
- [x] Move the shared loopback port probe and command diagnostics to [ports](../src/platform/ports.mjs) and [project diagnostics](../src/projects/project-diagnostics.mjs), retaining the same probe and response keys.
- [x] Check static source dependencies for cycles and enforce the HTTP and platform dependency boundaries through [npm run check](../scripts/check-architecture.mjs).

## P2 — Page modules, documentation, and verification

- [x] Split Projects startup, dependencies, Git and checks, and database panel code around the real workflows. Preserve both web entry points and both languages. See the [project page](../public/projects/page.js) and [browser workflow](../scripts/integration/browser.mjs).
- [x] Keep the specification at the repository root and give the current implementation map a distinct filename. Update documentation links and record acceptance here.
- [x] Run the static checks and automated test suite. Exercise localized project workflow panels and exact-name registration removal in the browser.
- [x] Run the PostgreSQL and MySQL integration and the guided Prisma setup, including large archive transfer.
- [x] Run the three representative generated stacks through installation, startup, health, and database checks.

## Verification on Windows

Local verification used Node.js 24.16.0, Docker Desktop, and Microsoft Edge.

- `npm run check` passed. Fixture checks verified rejection of an indirect cycle, a reverse HTTP dependency, and an application import from a platform helper.
- `npm test` passed all 96 tests. The new regression exercised concurrent writes during registration removal, cleanup failure and retry, and preservation of the project directory.
- `npm run test:browser` passed with Edge. It exercised English and Chinese switching, startup and dependency suggestions, saved checks, Git status, PostgreSQL setup, and exact-name registration removal.
- `npm run test:database-integration` passed with real PostgreSQL and MySQL servers and two-service Compose fixtures. `npm run test:prisma-integration -- --large` passed with database setup, Prisma migration, and a PostgreSQL archive exceeding 64 MiB.
- `npm run test:integration` passed for Vue + Express + PostgreSQL, React + Spring Boot + MySQL, and React + NestJS + PostgreSQL. The runs verified builds, backend health, and database queries through the frontend proxy. The NestJS case also verified reconnection after restarting its database. Local run ID 20261116095706-0c5124.

The v0.32.0 CI results remain recorded in the [product baseline](PRODUCT-BASELINE-v0.32.0.md#compatibility-and-regression-checks).

Product candidates in the specification, including a dashboard and global tasks view, require their own scope and acceptance criteria.
