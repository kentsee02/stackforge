# StackForge product backlog

The [architecture specification](../ARCHITECTURE.md) defines the product boundaries. See the [delivery history](PRODUCT-DELIVERY-HISTORY.md) for completed releases and the [migration test matrix](MIGRATION-TEST-CASES.md) for executable cases and coverage limits.

## Current priority

Complete the remaining migration coverage before starting project activity history. All five adapters support detection, history checks and reviewed writes for their supported PostgreSQL layouts. Drizzle, Flyway and Liquibase also have a project MySQL write path. EF Core can apply and downgrade reviewed SQL exports on a project SQL Server target.

### Open migration work

1. **Alembic runtime coverage.** Handle external pinned dependencies, cross-branch `depends_on` execution and nontransactional revisions. Verify runtime isolation and expose partial results when atomic execution is unavailable.
2. **Liquibase execution filters.** Verify context and label filtering against the exact changeset range, including eligible preconditions and runtime property inputs.
3. **Flyway runtime integration.** Cover project-managed Maven and Gradle behavior such as Java migrations and callbacks separately from the reviewed SQL locations already supported. Undo requires an eligible Flyway edition and an undo migration for live verification.
4. **Additional Drizzle engines and layouts.** Evaluate hosted dialects and SQLite batches that require custom runtime controls. PostgreSQL, MySQL and local SQLite cover legacy journals and v1 folders.

### Acceptance criteria

- [x] Discover and preview files for all five adapters, with unresolved cases reported per service, configuration or DbContext.
- [x] Read migration history and distinguish a recorded migration from a verified SQL checksum where the tool exposes one.
- [ ] For each remaining write path, review the exact source, tool/runtime, target and range. Revalidate approval, reject shared or replaced targets and verify expected history. Report partial changes when the engine commits them separately.
- [ ] For each eligible rollback path, review the exact reversal and verify the retained history. Exercise supported backup recovery where reversal is unavailable.
- [ ] Document the tested engines and runtime layouts. Cover failure, cancellation, stale approval and recovery on real databases, and exercise import, clone and both interface languages.

## Next product work

1. **Project activity history.** Record installation, check and database outcomes per project.
2. **Global task history and queue.** Evaluate cross-project task controls once the workflows expose compatible state.
3. **Independent dashboard.** Derive an aggregate view from Projects, Services, Databases and Tasks.
4. **Standalone environment view.** Consolidate tool availability, versions, executable paths and prerequisites.
5. **Standalone integrations view.** Consolidate Git, GitHub, Docker and desktop integration status.
6. **App-wide settings.** Evaluate theme, notifications and other cross-project preferences.

## Product candidates

- **Additional local database operations.** Evaluate backup, restore and lifecycle coverage individually for MongoDB, Redis and SQL Server. Project SQL Server currently supports container lifecycle and reviewed EF Core migration.
- **Native PostgreSQL and MySQL provisioning.** Evaluate setup on supported operating systems using their service and permissions model.
- **Cloud database lifecycle.** Evaluate provider-specific creation, lifecycle and deletion with separate provider permissions.

## Completed foundations

Startup preflight, service-level engine selection, project-owned PostgreSQL and MySQL, and FastAPI entry point discovery shipped in v0.33.0–v0.39.0. The delivery history retains their release details and regression cases.
