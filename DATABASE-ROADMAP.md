# Database implementation checklist

This checklist tracks the proposed Database Architecture Specification against StackForge 0.30.0. The database CI jobs require real PostgreSQL, MySQL and SQLite tests in addition to command fixtures.

## P0 · Protect existing data

- [x] Separate project file deletion from permanent database volume deletion. Keep the volume when project recycling fails. Require explicit confirmation of the verified volume, a stopped project and database, and revalidate ownership before removal.
- [x] Reject MySQL restores with grants outside the selected database. Include PostgreSQL large objects in the empty-target check and verify both protections against real disposable databases.
- [x] Redact known environment credentials and database connection strings in database container logs, task output, and errors. Verify masking with a real Docker container.
- [x] Redact file-backed Docker database credentials. Store database operation IDs, actions, timestamps, and outcomes without raw output, credentials, or backup data.
- [x] Verify the Docker container and volume for status, logs, start, stop, backup, restore, and volume deletion. Restrict automatic starts to reviewed database commands and health checks. Block custom entrypoints and lifecycle hooks, and preserve verified existing volumes.

## P1 · Discovery, bindings and explicit initialization

- [x] Use one read-only database discovery pipeline for local imports and clones. Record non-secret findings from Compose, environment templates, framework configuration, ORM declarations, and SQLite paths. Distinguish missing values, placeholders, ambiguous targets, and verified connections.
- [x] Add separate requirement, server, instance and project binding records. Support multiple databases per project and shared databases. Preserve registration identity during a verified path change and migrate existing Docker settings.
- [x] Separate ownership from per-operation permissions. Derive enabled actions from verified capabilities. Block shared or unverified deletion and track database operation outcomes with sanitized errors.
- [x] Detect local PostgreSQL and MySQL installations, service status, version and connection permissions on Windows and Linux. Provide setup guidance when an installation is missing.
- [x] Add explicit, reviewable initialization plans for missing databases and empty schemas. Check existing data, permissions, and target identity before executing. Track migrations separately and verify final schema readiness.

P1 initialization applies to loopback PostgreSQL and MySQL targets with verified server identity. Automatic migration accepts reviewed CREATE TABLE statements under `database/migrations`. The discovery scan uses bounded static analysis, so dynamic configuration can remain ambiguous.

## P2 · Additional adapters and backup verification

- [x] Add remote connection profiles with secure credential references, explicit connection tests and per-operation capabilities. Keep database permissions and provider permissions separate.
- [x] Add SQLite discovery, schema inspection, explicit creation, and backup/restore that handles locks and WAL files.
- [x] Verify backup integrity, record checksums and metadata, validate engine and version compatibility, preview restore impact, and verify restored objects in an isolated target.
- [x] Add Windows and Linux database CI jobs. Test shared bindings, unsupported operations, native Windows PostgreSQL, real SQLite on both platforms, and PostgreSQL/MySQL TLS, initialization, backup, restore, and Compose ownership with Linux containers.

Remote administration uses existing PostgreSQL and MySQL databases. SQLite creation requires a missing, project-relative database file. Remote infrastructure provisioning and management require provider tools.
