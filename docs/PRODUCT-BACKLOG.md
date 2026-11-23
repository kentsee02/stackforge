# StackForge product backlog

Develop these candidates in priority order. v0.33.0 completed startup preflight, v0.34.0 added project-scoped PostgreSQL, and v0.35.0 added the first Drizzle PostgreSQL migration preview.

1. **Project startup preflight** (completed). Check a locally imported or cloned project and point users to the relevant setup action.
2. **Engine-aware development database setup** (completed in v0.39.0). Use service-level discovery to recommend PostgreSQL or MySQL and offer eligible connection and Compose controls. Recheck the service, engine, and connection settings when confirming creation.
3. **FastAPI startup detection for imports and clones** (completed in v0.39.0). Recognize declared entrypoints, named application objects, and supported local factories through static service scans.
4. **Project-scoped MySQL** (completed in v0.39.0). Manage a dedicated Docker MySQL database, configure eligible connection settings, and verify backup, restore, and volume ownership. Dedicated Docker PostgreSQL shipped in v0.34.0.
5. **Additional migration adapters** (in progress). All five provide source preview, read-only history and a reviewed write path for supported PostgreSQL layouts as of v0.46.0. Complete the remaining layout, engine and rollback coverage before starting project activity history. See the [migration test matrix](MIGRATION-TEST-CASES.md).
6. **Project activity history.** Record installation, check, and database outcomes per project.
7. **Global task history and queue.** Evaluate a cross-project task view and queue after the individual workflows expose compatible state.
8. **Independent dashboard.** Derive an aggregate view from Projects, Services, Databases, and Tasks.
9. **Standalone environment view.** Consolidate tool availability, versions, executable paths, and prerequisite guidance.
10. **Standalone integrations view.** Consolidate Git, GitHub, Docker, and desktop integration status. Evaluate broader integration preferences here.
11. **App-wide settings.** Evaluate theme, notifications, and other app-wide preferences independently of project configuration.
12. **Additional local database operations.** Evaluate backup, restore, and lifecycle controls for MongoDB, Redis, and SQL Server individually.
13. **Native PostgreSQL and MySQL provisioning.** Evaluate setup for supported local operating systems with their existing server and permissions model.
14. **Cloud database lifecycle.** Evaluate provider-specific provisioning, lifecycle, and deletion with separate provider permissions.

## Migration adapter acceptance criteria

- [x] Preview detected migration files and report unresolved declarations per service, configuration or DbContext.
- [x] Provide a read-only history check for each adapter. v0.44.0 adds Flyway and Liquibase history on PostgreSQL and MySQL, EF Core history on SQL Server, and custom Alembic version tables. Distinguish recorded entries from verified file checksums.
- [ ] Prepare an explicit apply plan for every adapter. Show the tool, version, working directory, selected database, migration range and reviewed files or SQL. Revalidate the source and target on confirmation, reject shared or replaced targets, and verify history after execution.
- [ ] Prepare a rollback plan when the tool, edition and migration definitions support it. Show the downgrade target and destructive operations. Support checksum-verified recovery to an eligible empty database when the adapter cannot reverse its migrations.
- [ ] Exercise apply, rollback, cancelled and failed executions, stale approval, and recovery against real development databases. Verify both languages and imported and cloned projects. Record unsupported engines, runtime configurations or migration layouts explicitly.

## v0.46.0 Alembic, EF Core, and public repository tests

- [x] Apply Alembic revisions and downgrade to a reviewed target on project-owned PostgreSQL. Use a staged environment with the approved revision files and verify history inside the database transaction.
- [x] Preview and run EF Core PostgreSQL SQL exports for the selected `DbContext` and migration range. Roll back the transaction if the script does not produce the expected history.
- [x] Run supported Flyway SQL selected by literal Spring Boot properties on project-owned PostgreSQL.
- [x] Add a reproducible [test matrix](MIGRATION-TEST-CASES.md) with fixed upstream commits plus live database and bilingual cases.
- [ ] Extend writes to additional database engines and runtime layouts. Remaining items include EF Core SQL Server writes, project-specific Alembic runtimes, Liquibase structured changelogs and ranged rollback, licensed Flyway Undo, and broader Drizzle SQL.

## v0.45.0 Native Flyway and Liquibase execution

- [x] Prepare and execute a Flyway Community plan for supported standalone versioned and repeatable SQL.
- [x] Apply supported standalone Liquibase formatted SQL and roll back the last recorded changeset when it declares explicit rollback SQL.
- [x] Limit native writes to the verified project-owned PostgreSQL container. Pin the tool image, review the source files and range, bind the plan to the database identity and history, and verify the expected history after execution.
- [x] Offer verified PostgreSQL archives from the project database controls. Restore only to a verified empty target. This provides database recovery for tools and editions without native rollback.
- [ ] Extend native execution to additional layouts and engines. Evaluate native Flyway Undo for users with the necessary edition and an undo script.

## v0.43.0 Liquibase changelog preview

- [x] Discover service-local roots from Liquibase properties, Maven, Spring Boot settings and standard resource layouts. Keep declared profiles separate.
- [x] Read changeset declarations from XML, YAML, JSON and formatted SQL. Follow supported local includes in order and report repeated identities, cycles and incomplete references.
- [x] Verify the [Spring Boot Liquibase sample](https://github.com/h3yzack/springboot3-liquibase-example), the [JHipster sample](https://github.com/jhipster/jhipster-sample-app) and the bilingual Projects panel. The preview reports source evidence and leaves database history unverified.

## v0.42.0 Flyway SQL source preview

- [x] Discover standard local SQL locations for Flyway CLI configuration, Spring Boot, and Maven and Gradle plugins, including separately declared Maven profile configuration files.
- [x] List versioned, repeatable, baseline, and undo SQL migration files. Compare numeric versions and report duplicate, unresolved, or incomplete results in English and Chinese.
- [x] Verify the [Spring Boot sample](https://github.com/nanotaboada/java.samples.spring.boot), the [Maven profile sample](https://github.com/BootcampToProd/flyway-with-spring-boot-maven), and the Projects panel. The preview covers local files. Database history comparison and migration execution are separate adapter work.

## v0.41.0 EF Core PostgreSQL history verification

- [x] Select a verified migration group and a project-owned PostgreSQL instance or a detected direct loopback connection.
- [x] Compare the declared migration IDs with the default EF Core history table or a user-specified schema and table in a read-only transaction. Report applied and pending migrations, missing tables, conflicting history, and access errors.
- [x] Exercise the workflow with the development PostgreSQL integration fixture, separate .NET project layouts, and the bilingual Projects panel.

## v0.40.0 EF Core source preview

- [x] Discover migration declarations by `.csproj`, `DbContext`, and migration attributes, including separate .NET projects and custom source layouts.
- [x] Pair generated partial classes and support literal compile links within the repository. Mark incomplete, duplicate, or ambiguous declarations for review.
- [x] Verify the [public .NET eShop sample](https://github.com/dotnet/eShop), independent multi-project fixtures, and the bilingual Projects panel.

## Development database setup and FastAPI acceptance cases

- A service with a MySQL provider or a supported SQLAlchemy `mysql+pymysql://` setting gets MySQL guidance. A database driver dependency alone calls for user confirmation. Distinct services can select distinct engines. Conflicting settings in one service require resolution before a creation plan is issued.
- A matching saved connection or manageable Compose service offers its existing action. A creation preview identifies the target service, engine, version, endpoint, volume, and proposed configuration edit. The server rejects a changed or mismatched plan. Existing dedicated instances show management controls based on their recorded engine and verified ownership.
- A FastAPI clone with `from fastapi import Depends, FastAPI` and `app = FastAPI(...)` in `app/main.py` offers `app.main:app` from the repository root. A clone with an initialized `backend_app` in `backend/src/main.py` offers `src.main:backend_app` from `backend/`.
- Startup suggestions use static project evidence and expose ambiguous targets for manual review. Validate both FastAPI layouts through import and clone, including the rendered command and working directory.
- Include independently named ASGI entry points, deep Python package layouts, and environment variables with arbitrary supported names in regression coverage. Run `npm run test:development-mysql` against the official image to verify lifecycle, projected settings, and the archive workflow.

## v0.38.0 Alembic PostgreSQL history checks

- [x] Select a project-owned PostgreSQL container or a saved direct loopback PostgreSQL URL and inspect `public.alembic_version` in a read-only transaction.
- [x] Match recorded revisions and their ancestors against local files. Show revision coverage, missing or conflicting history, unsupported history tables, and permission or connection errors in English and Chinese.
- [x] Exercise empty, branched, current, conflicting, restricted, stopped, and replaced targets with PostgreSQL integration tests.

## v0.37.0 Alembic revision preview

- [x] Find standard `alembic.ini` files in imported and cloned service directories, including nested backends.
- [x] List local revision files and their declared heads from static file reads. Report missing files, unsupported layouts, and ambiguous graphs.
- [x] Verify the [FastAPI Full Stack Template](https://github.com/fastapi/full-stack-fastapi-template), branch and merge fixtures, and the Projects panel in English and Chinese.

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
