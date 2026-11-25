# StackForge delivery history

This archive preserves release work and regression notes. Current priorities are in the [product backlog](PRODUCT-BACKLOG.md). Reproducible adapter cases are in the [migration test matrix](MIGRATION-TEST-CASES.md).

## v0.56.0 Liquibase execution filters

- Preview context and label selections with the pinned tool and verify the exact recorded changesets, including non-prefix histories.
- Support reviewed XML preconditions that test read-only catalog state and literal properties in supported XML attributes.
- Exercise the original Liquibase context and label fixture on project PostgreSQL.

## v0.55.0 Alembic nontransactional revisions

- Review revisions containing Alembic autocommit blocks and require backup confirmation.
- Execute on an isolated project PostgreSQL connection with per-revision transactions and a session advisory lock.
- Block retries after possible partial commits until recovery, and verify concurrent index creation and archive recovery.

## v0.54.0 Alembic locked Python dependencies

- Show reviewed Python packages and exact versions in the migration plan. Bind approval to the lock file bytes.
- Install hash-verified PyPI wheels in a temporary, credential-free worker and use an internal Docker network for execution.
- Apply and roll back the original Invenio Records migration that imports SQLAlchemy-Utils.

## v0.53.0 Alembic cross-branch dependencies

- Plan literal `depends_on` dependencies with the pinned Alembic runtime using an offline graph and show the effective history heads.
- Verify the reviewed set and dependency order during apply and downgrade, then verify the version table before commit.
- Exercise the original Invenio DB and Invenio Records revisions against disposable PostgreSQL.

## v0.52.0 Drizzle SQLite migration support

- Inspect legacy journal and v1 folder history for SQLite files resolved inside the project.
- Review and apply a supported batch in one transaction, or create a missing target after the staged migration succeeds.
- Verified the original eight migrations from electron-db and the Drizzle team's upstream v1 SQLite fixture.
- v0.52.1 fixes migration preview on Windows when Node.js 22.12 provides the volume identifier only through an open file handle.

## v0.51.0 Drizzle MySQL migration support

- Detect static MySQL configurations and preview legacy journal and v1 folder migrations. Compare timestamps or folder names and hashes against MySQL history.
- Review and apply supported SQL to a verified project-owned MySQL 8.4 database. Invalidate approval if files, history, ownership, or the database changes.
- Keep interrupted runs visible and block automatic retry. Use the existing MySQL archive workflow for recovery to an empty database.

## v0.50.0 Migration runtime coverage

- Added EF Core SQL Server SQL export review, transactional application and downgrade on a verified project-owned SQL Server 2022 instance.
- Added Drizzle v1 folder-based PostgreSQL history, apply and rollback alongside the legacy journal layout.
- Staged declared local Liquibase SQL and CSV inputs, with file content bound to approval.
- Added reviewed Flyway SQL locations from supported Maven profiles and literal Gradle configuration.
- Added optional connection-aware Alembic environments with explicitly selected local Python modules.

## v0.49.0 Drizzle transactional schema changes and rollback

- [x] Review and apply common changes including rename, drop, type changes and data updates on a verified project PostgreSQL database.
- [x] Review an explicit rollback SQL file and select a prior journal revision. Tie the approval to file content and the exact target and history.
- [x] Check the expected history before commit. Verify failed scripts leave schema and history intact and that rolled-back revisions can be replayed.
- [x] In v0.49.1, expose cancellation and verify that cancelling a running rollback closes its PostgreSQL session and preserves schema and history.

## v0.48.1 Liquibase rollback by tag

- [x] List unique recorded tags in the history panel and preview the selected tag on project PostgreSQL and MySQL.
- [x] Show the exact rollback range and verify the retained history for both manually tagged rows and changelog tag changesets.
- [x] Exercise missing and ambiguous tags, read-only preview, native rollback and bilingual controls.

## v0.48.0 Flyway and Liquibase on project MySQL

- [x] Apply reviewed Flyway migrations on the project's MySQL 8.4 database, including the conventional Spring Boot location.
- [x] Apply and roll back supported Liquibase changelogs with read-only rollback previews.
- [x] Invalidate approval on database replacement or intervening MySQL writes. Verify migration history and surface the possibility of partially committed MySQL DDL.
- [x] Exercise source discovery and original upstream changes on real MySQL, plus stale approval, shared targets, failure, cancellation and bilingual controls.

## v0.47.0 Structured Liquibase changelogs

- [x] Stage supported XML, YAML and JSON resources with local includes, preserving the resource paths used by Liquibase history.
- [x] Apply the public Spring Boot Liquibase example's YAML and included SQL on a disposable PostgreSQL database.
- [x] Generate native rollback SQL for a reviewed structured changeset range and recheck the exact preview before writing.
- [x] In v0.47.1, reject encoded variable expressions and prove that changing an included changelog invalidates its approval. Verify physical tables and history through rollback.

## v0.46.1 Migration ranges

- [x] Preview and confirm rollback of a selected number of recently applied changesets. Require an explicit rollback statement for each changeset, bind the count to the approval and recheck the resulting history.
- [x] Apply versioned Flyway SQL up to a selected revision. Keep later versions pending and verify PostgreSQL rejects incompatible upstream seed SQL without marking the failed group as applied.

## v0.46.0 Alembic, EF Core, and public repository tests

- [x] Apply Alembic revisions and downgrade to a reviewed target on project-owned PostgreSQL. Use a staged environment with the approved revision files and verify history inside the database transaction.
- [x] Preview and run EF Core PostgreSQL SQL exports for the selected `DbContext` and migration range. Roll back the transaction if the script does not produce the expected history.
- [x] Run supported Flyway SQL selected by literal Spring Boot properties on project-owned PostgreSQL.
- [x] Add a reproducible [test matrix](MIGRATION-TEST-CASES.md) with fixed upstream commits plus live database and bilingual cases.

## v0.45.0 Native Flyway and Liquibase execution

- [x] Prepare and execute a Flyway Community plan for supported standalone versioned and repeatable SQL.
- [x] Apply supported standalone Liquibase formatted SQL and roll back the last recorded changeset when it declares explicit rollback SQL.
- [x] Limit native writes to the verified project-owned PostgreSQL container. Pin the tool image, review the source files and range, bind the plan to the database identity and history, and verify the expected history after execution.
- [x] Offer verified PostgreSQL archives from the project database controls. Restore only to a verified empty target. This provides database recovery for tools and editions without native rollback.

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

## Development database setup and FastAPI acceptance cases

- A service with a MySQL provider or a supported SQLAlchemy `mysql+pymysql://` setting gets MySQL guidance. A database driver dependency alone calls for user confirmation. Distinct services can select distinct engines. Conflicting settings in one service require resolution before a creation plan is issued.
- A matching saved connection or manageable Compose service offers its existing action. A creation preview identifies the target service, engine, version, endpoint, volume, and proposed configuration edit. The server rejects a changed or mismatched plan. Existing dedicated instances show management controls based on their recorded engine and verified ownership.
- A FastAPI clone with `from fastapi import Depends, FastAPI` and `app = FastAPI(...)` in `app/main.py` offers `app.main:app` from the repository root. A clone with an initialized `backend_app` in `backend/src/main.py` offers `src.main:backend_app` from `backend/`.
- Startup suggestions use static project evidence and expose ambiguous targets for manual review. Validate both FastAPI layouts through import and clone, including the rendered command and working directory.
- Include independently named ASGI entry points, deep Python package layouts, and environment variables with arbitrary supported names in regression coverage. Run `npm run test:development-mysql` against the official image to verify lifecycle, projected settings, and the archive workflow.
