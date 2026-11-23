# StackForge Architecture & Modular Design Specification

- Specification version 1.1
- Product baseline [StackForge v0.32.0](docs/PRODUCT-BASELINE-v0.32.0.md)
- Implementation map [StackForge code map](docs/CODE-MAP.md)
- Work and verification [Architecture refactor checklist](docs/REFACTOR-CHECKLIST.md)
- Development priorities [Product backlog](docs/PRODUCT-BACKLOG.md)
- Status Approved product boundary and incremental refactoring direction

## 1. Project overview

StackForge is a local development tool for creating, importing, and running projects and managing the resources they need. It runs as a modular monolith with a loopback HTTP server and a browser interface. A project can be registered before its development environment is ready.

### 1.1 Current product scope

- **Create project** generates a selected frontend, backend, and database stack in a new directory. This workflow includes templates, preflight, resumable generation, dependency installation, and optional Git initialization and GitHub publishing.
- **Projects** supports local import and GitHub HTTPS clone, discovery, startup preflight, startup and dependency settings, start and stop, logs, checks, Git status, and eligible database operations.
- The [v0.32.0 product baseline](docs/PRODUCT-BASELINE-v0.32.0.md) records supported combinations, prerequisites, limits, and verified behavior. These are the capabilities to preserve during refactoring.

### 1.2 Core workflows

1. **Create.** Select a stack and destination, review preflight, and generate the project. Resume the saved task if interrupted. Install dependencies during creation or later, then start the generated project when ready.
2. **Import.** Select an existing folder. Verify its identity and inspect the project using the shared discovery rules. Register the folder even when runtime tools are missing or framework detection is inconclusive.
3. **Clone.** Clone a GitHub repository to a staged checkout and promote it to the destination. Register the result through the same workflow as local import. Cancellation before promotion cleans up the staged checkout. Registration completes after promotion.
4. **Run and maintain.** Start an eligible managed launcher or the saved external service group. Review suggested commands before saving them. Configure dependencies, ports, database connections, and migrations when the project needs them. Readiness and diagnostics are separate from project registration.

### 1.3 Architectural goals

Keep responsibilities clear, reuse capabilities across workflows, and preserve project identity, user data, and supported behavior. Prefer incremental changes with verified compatibility.

## 2. High-level architecture

### 2.1 Dependency direction

Arrows represent source dependencies. The composition root binds application workflows to concrete implementations.

```text
Browser -> HTTP adapters -> Application workflows -> Domain rules and contracts
Infrastructure implementations ------------------> Domain rules and contracts
Composition root -> HTTP adapters, application workflows, infrastructure implementations
```

- **Presentation** renders state, collects input, and displays previews and confirmations.
- **HTTP adapters** handle routing, request security, input envelopes, response serialization, and HTTP status mapping.
- **Application workflows** coordinate validation, decisions, target resolution, and execution using the required tools and storage.
- **Domain rules** define ownership, identity, capabilities, and legal state transitions.
- **Infrastructure** provides filesystem, process, Git, Docker, database, credential storage, and persistence implementations.

Use focused modules and explicit dependencies where a workflow crosses a boundary. The layers describe responsibilities and dependency direction. Their names need not appear in every module's directory tree.

## 3. Module responsibilities

The responsibilities below describe internal boundaries. The current browser navigation is specified in section 8.

### 3.1 Dashboard and aggregate views

An independent dashboard is a product candidate. Any aggregate view derives its data from Projects, Services, Databases, and Tasks. Those modules continue to own their records and activity.

### 3.2 Projects and generation

- **Generation** owns stack choices, preflight for creation, template generation, and the resumable creation workflow. The creation task owns its checkpoint until the job completes.
- **Projects** owns registration, project identity and location, import, clone registration, relocation, and removal policy. It recognizes generated projects and external imports.
- Keep a registered identity when the original directory can be verified at a new location on the same filesystem. A replacement at the old path is a different directory. Recheck identity before actions that write, run commands, or move files.
- Import and clone share the registration and discovery workflow. Database discovery observations can be refreshed independently after registration.

### 3.3 Environments

Resolve tool availability, versions, executable locations where available, and prerequisites for the requested operation. Tool detection and project structure discovery serve different purposes. For native PostgreSQL and MySQL, the current product detects installations and offers guidance. Provisioning a native server or a Docker instance from that guidance would be a separate product decision.

### 3.4 Databases

The database module owns requirements, server and database targets, connections, project bindings, initialization, migration approvals, and backups. It interprets provider capabilities and verifies ownership before protected actions.

#### 3.4.1 Discovery and resource identity

- Discover requirements from eligible project configuration, Compose, environment files and templates, ORM declarations, paths, and package dependencies. Do not run project code during discovery. Observations may be saved in the local registry.
- A **requirement** is evidence that a project expects a database. A **server candidate** records the discovered endpoint. A **database target** identifies a named database on a server or an eligible file such as SQLite. Discovery can reference a database or file that is still missing.
- A **connection** describes how to reach a target, its effective configuration source, and any credential reference. A **binding** records the relationship between a project and a target. A project can bind to several targets and several projects can reference the same target.
- Endpoint matching can identify potential sharing. Verify provider-specific identity, ownership, and current permissions before writes. Treat IPv4 and IPv6 loopback as potentially overlapping for safety and resolve ambiguity before choosing a write target.

#### 3.4.2 Current capability boundary

- **Docker Compose PostgreSQL and MySQL.** Start, stop, readiness, redacted logs, backup, and restore for eligible services with verified local data volumes. Imported projects can select among eligible services in a single root Compose file. Permanent volume deletion applies only to verified StackForge-managed volumes.
- **Project development database.** A verified external import or clone can select a supported service and provision one PostgreSQL 17 or MySQL 8.4 instance with local Docker Engine 28 or newer in Linux container mode. Creation revalidates the selected service and engine evidence. StackForge records the daemon, project identity, engine, container and volume ownership, and port. The port is published on IPv4 loopback. Users can start, stop, and save eligible connection settings. Dedicated MySQL offers backup and verified restore through the existing archive workflow. Exact-volume confirmation and shared-use checks apply to cleanup.
- **Local PostgreSQL and MySQL.** Check availability and connection, preview database creation, and apply the supported explicit SQL initialization flow. Supported direct URLs and native tools can enable backup and restore, subject to database grants.
- **Remote PostgreSQL and MySQL.** Test and save eligible TLS connection profiles. Backup and restore depend on the connection and grants. Server lifecycle, provisioning, and database deletion use provider tools.
- **SQLite.** Inspect an eligible project-relative database file, create it when absent, take a verified snapshot, and restore to a missing file. SQLite has no server lifecycle in StackForge.
- **Local MongoDB, Redis, and SQL Server.** Read-only connection checks for recognized targets using native clients. Backup, restore, and lifecycle support are future capabilities.

See the [product baseline](docs/PRODUCT-BASELINE-v0.32.0.md#database-capabilities) for limits, verification coverage, and prerequisites.

#### 3.4.3 Connections, initialization, and migrations

Inspect the effective URL separately from observed reachability, server identity, and database existence. Manage an identified PostgreSQL or MySQL environment assignment using the eligible untracked, ignored file when Git is present. If the application's effective configuration and migration CLI configuration disagree or are ambiguous, surface the discrepancy and require a resolved target before writing. A remote connection profile is separate from editing the application's environment files.

Database creation, connection configuration, schema initialization, and applying migrations are distinct operations. Inspect the selected target and show the applicable next step. A project's existing migration history takes precedence over generic SQL initialization.

[Prisma CLI v7](https://www.prisma.io/docs/cli/v7/migrate/deploy) can attempt to create a missing database when running `prisma migrate deploy`. StackForge's PostgreSQL setup workflow requires an existing, verified target before applying migrations. For recognized local direct connections and an installed Prisma 7 CLI, present the committed migrations and exact target for confirmation. Revalidate the configuration, database identity, and files before execution. After applying migrations, verify the connection, migration history, and presence of tables. That readiness check does not establish full schema drift coverage.

The Drizzle PostgreSQL adapter previews recognized static configurations and PostgreSQL journal v7 files. It compares SQL file hashes and timestamps with the history table on a direct local PostgreSQL target. For supported schema additions, applying migrations requires a fresh preview and exact database-name confirmation. The server verifies the target and history again under a database lock, commits SQL and Drizzle history in one transaction, and checks the resulting history.

The Alembic adapter discovers service-level migration configurations through the same scan used by imports and clones. For a standard `alembic.ini` and a project-relative `versions` directory, it reads literal revision declarations and shows local ordering and branch heads. Users can select their project-owned Docker PostgreSQL or a saved direct loopback PostgreSQL URL and compare the default or a user-selected version table with the local graph in a read-only transaction. For self-contained revisions without `depends_on`, a reviewed plan runs upgrade or downgrade in an isolated staged runtime on project-owned PostgreSQL. The transaction checks the target database and recorded heads before and after running the revisions. Project-specific runtime configuration and schema drift checks require the project's Alembic environment.

Migration support is capability-based. Detecting an ORM or a migration tool does not authorize its execution. Applying migrations uses reviewed files and a confirmed target. Schema reset, schema replacement, and destructive SQL require separate explicit support and approval.

Flyway versioned and repeatable SQL from supported standalone or literal Spring Boot properties configurations and standalone Liquibase formatted SQL can run on verified project-owned PostgreSQL. A plan identifies the reviewed files, tool version, migration range and exact database. It expires after five minutes and is bound to the source bytes, target identity and migration history. StackForge stages only the reviewed files for a digest-pinned tool container that uses the database container's network namespace. History is checked again before and after the write. Flyway supports a selected target version for versioned-only sources. Liquibase can roll back a selected number of the latest recorded changesets when each declares explicit rollback SQL. Flyway Community recovery uses a verified backup.

#### 3.4.4 Backup and restore

Backup archives describe the engine, source version, and checksum. PostgreSQL supports streaming through temporary files. SQL backup verification and restore preview use eligible Docker images. See the baseline for size limits and engine-specific permissions.

Project-owned PostgreSQL and MySQL expose the archive controls directly in the project database panel.

Restore checks compatibility and integrity, previews the exact target, and checks ownership or access and shared use before writing. SQL restore requires an empty verified database. SQLite restore requires a missing destination file. Verify the result after writing. The current UI does not offer a restore that replaces an existing populated database.

### 3.5 Services and runtime

- Service configuration describes the working directory, startup or install command, port, and access path. The project configuration store currently persists those user settings.
- Runtime owns active processes, cancellation for startup and shutdown, readiness checks, and recent development output. The project page operates the managed launcher or the configured service group. Docker database ownership and lifecycle decisions remain in Databases.
- Run detected commands only through an approved plan. Validate relative working directories and preserve trusted custom commands as an explicit fallback.

### 3.6 Tasks and execution

Creation jobs own resumable checkpoints and history. Finite project operations such as installing dependencies or running checks have their own running state and cancellation. Services have a process lifecycle and readiness. Database actions can have separate previews and audit outcomes.

Reuse process launch, cancellation, timeouts, and redaction where their behavior agrees. Keep each workflow's state transitions, completion semantics, and storage contract. A late cancellation must not undo a completed result. A global queue or task history across all workflows is a separate product candidate.

### 3.7 Integrations

Git, GitHub, Docker, and desktop tools provide capabilities to the workflows that own their decisions. Projects owns clone registration, Generation owns publication of generated projects, and Databases owns Docker database actions. GitHub publishing uses the authenticated GitHub CLI. Local Git initialization does not require a GitHub login.

### 3.8 Settings

Keep project-specific configuration separate from app-wide preferences. StackForge currently persists recent project locations on the server and keeps language, templates, and creation preferences in the browser. Theme, notification, and broader integration settings remain product candidates.

## 4. Reusable capabilities

- **Discovery** provides shared service directory and framework rules for import, clone, dependencies, startup suggestions, and checks. Database-specific discovery can consume the same project scan and interpret its own configuration. Surface unsupported or ambiguous findings and allow manual setup.
- **Environment checks** share tool and prerequisite probes where they measure the same capability.
- **Execution** shares process, cancellation, and logging primitives. Long-lived services and resumable jobs retain their own orchestration.
- **Database workflows** reuse identity and permission checks between preview, execution, and verification. Provider commands stay in their own adapters.

## 5. Adapters

- A provider adapter reports actual capabilities for its engine and deployment type. Capability depends on current permissions, tool availability, verified target identity, and resource ownership.
- ORM detection reads configuration and describes requirements. A migration adapter resolves the target, inspects status, produces a preview, and verifies a confirmed execution. Keep those responsibilities separate from database lifecycle and transport.
- EF Core file preview reads C# migration attributes, context declarations, and migration types under the corresponding `.csproj`. It accepts standard split partial classes, single-file migrations, and literal project-relative compile includes and removals within the repository. Users can compare one verified migration group with a project-owned PostgreSQL or a direct loopback PostgreSQL or TCP SQL Server database. The check reads the default history table or a user-selected schema and table. For project-owned PostgreSQL, users can review and run a supported SQL script exported by their EF Core CLI for the selected context and range. StackForge verifies the history in the same transaction before committing. Script generation and SQL Server writes use the project's EF Core tooling.
- Flyway source preview uses the shared service scan and reads local SQL filenames from supported CLI, Spring Boot, Maven, and Gradle configurations. It resolves literal service-relative filesystem and classpath resource locations, keeps profile sources separate, and flags duplicate or partially scanned files. Users can explicitly compare ordinary SQL history with supported local PostgreSQL and MySQL targets. Standard UTF-8 SQL checksums flag edits and outdated repeatable migrations. Baseline, undo, Java, and other runtime-only history require the project's Flyway tool.
- Liquibase source preview resolves service-local changelog configuration and reads literal changeset declarations from XML, YAML, JSON and formatted SQL. It follows supported include paths, preserves declaration order, and reports repeated identities, cyclic references, and incomplete files. Users can explicitly compare recorded changeset identities with supported local PostgreSQL and MySQL targets, including entries marked as run. Changeset checksum validation and context- or label-specific execution require Liquibase.
- Document contracts at stable seams. Introduce a shared interface when callers need consistent operations and results. Keep capabilities optional where tools differ.

## 6. Dependencies and ownership

Use the dependency direction in section 2. The root composes the dependencies and passes narrow capabilities to workflows when modules need to collaborate. A module should use the owning module's interface for reads and writes.

- Projects owns registration, persistent project identity, and folder location. Generation owns creation checkpoints. Services owns the meaning of service definitions and runtime owns live process state.
- Databases owns requirements, targets, connections, bindings, migration approvals, and database audit records. It does not own project folders or their registration.
- Tasks and execution primitives carry out approved work. They do not decide whether a database, volume, or project can be changed.
- Integrations and platform adapters expose tools. Their consumers decide what a workflow is allowed to request.
- Avoid circular imports, duplicate discovery rules, cross-module writes to internal records, and application decisions in presentation code.

## 7. State and operation safety

Separate persisted settings and records, live state, discovery observations, and expiring approvals. Re-read the state that matters before a sensitive action.

- **Read-only checks** may refresh local observations. They do not run discovered project commands or change app or database resources.
- **Ordinary changes** such as saving settings, starting services, and installing reviewed dependencies use the user's explicit action and the corresponding validation.
- **Protected writes** such as database creation, migration, restore, and volume deletion verify identity and permissions, show an appropriate preview, require confirmation, revalidate, and record the result. A changed target invalidates the earlier approval.
- **Remove from Projects** removes an eligible import registration and its related configuration, bindings, and saved connection profiles while leaving the directory in place. An offline generated project can be hidden while retaining its creation history.
- **Delete project** verifies the stopped project and moves an eligible StackForge-managed directory or verified clone to the system trash after exact-name confirmation. SQLite files and other files inside the directory move with it.
- Keep conflicting project writes blocked while either removal operation is active, including during saved connection profile cleanup.
- **Delete data volume** is a separate operation on a verified StackForge-managed volume. Require exact-volume confirmation and stopped state, recheck ownership and shared use, and preserve the separation from project removal.

## 8. Frontend architecture

The web app has two main entry points. `/` is **Create project**, including templates and creation task history. `/projects` is **Projects**, including import, clone, and project details. Dependencies, startup, Git status, checks, and database controls are presented in the selected project. File previews describe generated output on the creation page.

Render server capabilities and operation states with accurate labels. Keep runtime status, server reachability, database existence, connection status, and migration status distinct. Use structured results where available and localize their presentation. Preserve runtime English and Chinese switching, trusted custom commands, and exact-target confirmations.

Dashboard, global tasks, standalone environment and integration views, and broader settings are candidates. Adding internal modules does not require adding top-level navigation.

## 9. Source layout

Use the [current code map](docs/CODE-MAP.md) for the existing entry points and locations. Introduce files where a workflow or responsibility has a clear owner. Review the current-to-target mapping before broad moves. Organize the frontend around the actual pages and their shared UI. Keep verified compatibility more important than uniform directory depth.

## 10. Persistence and compatibility

Preserve project IDs, recorded filesystem identities, import and generated project records, startup definitions, port settings, custom checks, creation checkpoints, and resumable history. Preserve database bindings, credential references, and database operation records. Keep browser local storage keys and supported project launchers compatible.

The baseline uses server-side state under `.stackforge/` and browser-managed settings as listed in the [compatibility baseline](docs/PRODUCT-BASELINE-v0.32.0.md#compatibility-and-regression-checks). Identify every reader and writer before changing a persisted format. Any required storage migration must be explicit and verifiable, with recovery where feasible. Refactoring source files does not authorize a change to user databases.

## 11. Security and reliability

- Keep request origin, host, and write-token validation at the HTTP boundary. Preserve bounded request, output, and discovery reads.
- Keep credentials out of API output and logs. Use scoped access and platform credential storage for eligible saved profiles. Verify environment file scope and Git protection before writing a project connection.
- Validate arguments and filesystem identities. Use explicit trusted shell commands only where the user saved that behavior. Track subprocesses, cancellation, and shutdown.
- Check database permissions and resource ownership independently. Refuse writes to shared or changed targets according to the operation's safety rules. Preserve diagnostics after redaction.

## 12. Testing and regression baseline

- Run the existing unit and HTTP integration suites. Test ownership, destination substitution, concurrency, cancellation, and reload of existing settings at the behavior boundaries.
- Validate all three entry workflows. Creation remains resumable, import and clone reach the same registration and discovery rules, and external projects can use their saved manual commands.
- Verify launch and stop, log redaction, ready links, port overrides, and built-in and custom checks. Preserve older launchers and the two web entry points.
- Verify database setup, PostgreSQL/MySQL Compose selection, shared-target protection, verified restore, and the three removal paths. Confirm that SQLite files move with recycled directories while Docker data volumes remain independent.
- Keep real database and representative full-stack integration checks and live localization in CI. See the [v0.32.0 verified results](docs/PRODUCT-BASELINE-v0.32.0.md#compatibility-and-regression-checks). Use test projects and fixtures for write verification.

## 13. Incremental refactoring strategy

1. Confirm the product baseline and inspect workflow owners, readers and writers, call directions, and current regressions.
2. Map each slice from its existing location to its target boundary. Account for compatibility and reuse the current implementation where it already fits.
3. Begin with project registration, verified relocation, and removal. Keep HTTP response mapping at the transport boundary and exercise import, clone, identity checks, and database binding cleanup.
4. Consider the remaining HTTP orchestration, database use cases, and execution or logging boundaries in subsequent slices. Extract shared behavior after identifying the canonical implementation and proving equivalent behavior.
5. Align page modules with actual web workflows while preserving navigation and localization. Treat new screens and capabilities as separate product decisions.

Track implementation and acceptance evidence in the [architecture refactor checklist](docs/REFACTOR-CHECKLIST.md).

## 14. Acceptance for each slice

The slice has a clear owner and documented entry points. Project registration, safe deletion, data persistence, task outcomes, API shapes, and other affected baseline behavior pass the existing tests. Compare affected browser and integration workflows where applicable. Record which boundaries moved and which remain in the existing implementation.

## 15. Engineering guidance

Use the product baseline and current code map before reshaping a module. Preserve existing behavior when the implementation and target diagrams differ. Resolve the smallest useful boundary in each change. Document the reason for any persistence or API change before adopting it.

## 16. Architectural principle

Keep StackForge extensible through explicit ownership and reusable capabilities. Let the supported local development workflows determine where the code needs boundaries.
