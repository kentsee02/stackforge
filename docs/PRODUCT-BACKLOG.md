# StackForge product backlog

Develop these candidates in priority order. v0.33.0 completed startup preflight, v0.34.0 added project-scoped PostgreSQL, and v0.35.0 added the first Drizzle PostgreSQL migration preview.

1. **Project startup preflight** (completed). Check a locally imported or cloned project and point users to the relevant setup action.
2. **Project-scoped development databases** (completed for Docker PostgreSQL). Imports and clones can create and manage one dedicated instance.
3. **Additional migration adapters.** Drizzle PostgreSQL target checks and preview shipped in v0.35.0. Design confirmed, verified Drizzle execution separately. Evaluate Alembic, EF Core Migrations, Flyway, and Liquibase against real imports.
4. **Project activity history.** Record installation, check, and database outcomes per project.
5. **Global task history and queue.** Evaluate a cross-project task view and queue after the individual workflows expose compatible state.
6. **Independent dashboard.** Derive an aggregate view from Projects, Services, Databases, and Tasks.
7. **Standalone environment view.** Consolidate tool availability, versions, executable paths, and prerequisite guidance.
8. **Standalone integrations view.** Consolidate Git, GitHub, Docker, and desktop integration status. Evaluate broader integration preferences here.
9. **App-wide settings.** Evaluate theme, notifications, and other app-wide preferences independently of project configuration.
10. **Additional local database operations.** Evaluate backup, restore, and lifecycle controls for MongoDB, Redis, and SQL Server individually.
11. **Native PostgreSQL and MySQL provisioning.** Evaluate setup for supported local operating systems with their existing server and permissions model.
12. **Cloud database lifecycle.** Evaluate provider-specific provisioning, lifecycle, and deletion with separate provider permissions.

## v0.35.0 Drizzle PostgreSQL migration preview

- [x] Recognize a static Drizzle Kit configuration and its saved PostgreSQL URL variable. Check the target through a native client or the verified project container.
- [x] Compare PostgreSQL journal v7 SQL checksums and timestamps against migration history. Show applied, pending, and unverified files without running project code.
- [x] Validate a real clone of the [Next.js SaaS Starter](https://github.com/nextjs/saas-starter), plus missing URLs, conflicting settings, applied history, and changed files. Verify the Projects panel in English and Chinese.

## v0.34.0 project-scoped PostgreSQL

- [x] Preview and confirm one PostgreSQL instance per verified external import or clone. Use a dedicated, verified Docker container and volume with a loopback port.
- [x] Start, stop, and inspect its readiness. Write a selected missing or placeholder connection variable through the existing environment-file safety checks.
- [x] Preserve data on stop and verify exact-target confirmation, ownership, and shared use before removing resources. `npm run test:development-postgres` covers real Docker and replaced containers and volumes. `npm run test:browser` covers the guide, preview, and localization.

## v0.33.0 startup preflight

- [x] Add read-only checks for folder identity, saved startup and working directories, recognizable tools, declared ports, and discovered database configuration. Report individual results as passed, needs attention, or unverified.
- [x] Link checks to the existing startup, dependency, and database controls, including the PostgreSQL guide for missing or placeholder Prisma URLs. Use the existing Start project workflow after checking.
- [x] Verify a Game Portal-style Prisma project with a missing URL, a project with separate frontend and backend folders, and a ready project that opens its running service. `npm run test:browser` exercises each scenario in English and Chinese.

The [architecture specification](../ARCHITECTURE.md) defines the current product boundaries and how these candidates fit.
