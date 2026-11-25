# StackForge product backlog

The [architecture specification](../ARCHITECTURE.md) defines the product boundaries. See the [delivery history](PRODUCT-DELIVERY-HISTORY.md) for completed releases and the [migration test matrix](MIGRATION-TEST-CASES.md) for executable cases and coverage limits.

## Current priority

Project activity history is the next planned product task. The migration milestone shipped detection, history checks and reviewed writes for all five adapters on supported PostgreSQL layouts. Drizzle, Flyway and Liquibase also have a project MySQL write path. EF Core can apply and downgrade reviewed SQL exports on a project SQL Server target.

### Open migration work

- **Flyway licensed Undo (deferred).** StackForge can list `U` migration files. Flyway Community uses verified backup recovery. Resume native Undo work when an authorized Flyway Teams or Enterprise license and a matching versioned migration and undo pair are available.

### Acceptance criteria when Flyway Undo resumes

- [ ] Review the undo source, licensed runtime, exact rollback range and verified database before approval. Reject shared or replaced targets and stale plans.
- [ ] Verify the resulting schema and retained history on a disposable project database. Cover failure, cancellation and backup recovery where the engine can commit partial changes.
- [ ] Document the pinned fixture, supported engines and runtime limits. Verify the preview and confirmation in both interface languages.

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
- **Additional hosted Drizzle dialects.** Turso has source preview. Evaluate provider authentication, target identity, history verification and recovery separately before enabling writes. Validate CockroachDB, SingleStore and SQL Server against their own dialects.

## Completed foundations

Startup preflight, service-level engine selection, project-owned PostgreSQL and MySQL, and FastAPI entry point discovery shipped in v0.33.0–v0.39.0. The delivery history retains their release details and regression cases.
