# StackForge product backlog

The [architecture specification](../ARCHITECTURE.md) defines the product boundaries. See the [delivery history](PRODUCT-DELIVERY-HISTORY.md) for completed releases and the [migration test matrix](MIGRATION-TEST-CASES.md) for executable cases and coverage limits.

## Current priority

Backup and restore for project-owned SQL Server is the next planned product task. SQL Server already supports managed Docker instances and reviewed EF Core migrations.

### Open migration work

- **Flyway licensed Undo (deferred).** StackForge can list `U` migration files. Flyway Community uses verified backup recovery. Resume native Undo work when an authorized Flyway Teams or Enterprise license and a matching versioned migration and undo pair are available.

### Acceptance criteria when Flyway Undo resumes

- [ ] Review the undo source, licensed runtime, exact rollback range and verified database before approval. Reject shared or replaced targets and stale plans.
- [ ] Verify the resulting schema and retained history on a disposable project database. Cover failure, cancellation and backup recovery where the engine can commit partial changes.
- [ ] Document the pinned fixture, supported engines and runtime limits. Verify the preview and confirmation in both interface languages.

## Next product work

- **SQL Server backup and restore.** Start with project-owned Docker instances. Verify the target catalog and ownership, define compatibility and restore confirmation, and run recovery against a disposable SQL Server database.

## Product candidates

- **Deferred task scheduling.** Evaluate explicit scheduling, persistent waiting jobs, and revalidation of approvals and project identity at dispatch time.
- **Additional local database operations.** Evaluate backup, restore, and lifecycle for MongoDB and Redis, and evaluate native and remote SQL Server recovery separately from project-owned Docker recovery.
- **Native PostgreSQL and MySQL provisioning.** Evaluate setup on supported operating systems using their service and permissions model.
- **Cloud database lifecycle.** Evaluate provider-specific creation, lifecycle and deletion with separate provider permissions.
- **Additional hosted Drizzle dialects.** Turso has source preview. Evaluate provider authentication, target identity, history verification and recovery separately before enabling writes. Validate CockroachDB, SingleStore and SQL Server against their own dialects.

## Completed foundations

Startup preflight, service-level engine selection, project-owned PostgreSQL and MySQL, and FastAPI entry point discovery shipped in v0.33.0–v0.39.0. The delivery history retains their release details and regression cases.
