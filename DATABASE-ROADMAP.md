# Database implementation checklist

This checklist tracks the proposed Database Architecture Specification against StackForge 0.26.0. The current baseline is Docker Compose management for one MySQL or PostgreSQL service per project. Windows Docker Desktop tests verified both engines' backup and restore paths. The Windows and Linux CI matrix currently runs automated tests with database command fixtures.

## P0 · Protect existing data

- [x] Separate project file deletion from permanent database volume deletion. Keep the volume when project recycling fails. Require explicit confirmation of the verified volume, a stopped project and database, and revalidate ownership before removal.
- [ ] Scope restores to the selected database. Reject MySQL restores with broader effective privileges, include PostgreSQL large objects in the empty-target check, and test both against real disposable databases.
- [ ] Redact known credentials and credential-bearing connection strings before exposing database logs, operation errors, and diagnostics. Keep raw secrets out of operation records.
- [ ] Verify Docker capabilities consistently across inspection and mutation. Review custom Compose commands and lifecycle hooks before starting imported services. Preserve support for verified existing volumes.

## P1 · Discovery, bindings and explicit initialization

- [ ] Use one read-only database discovery pipeline for local imports and clones. Record non-secret findings from Compose, environment templates, framework configuration, ORM declarations, and SQLite paths. Distinguish missing values, placeholders, ambiguous targets, and verified connections.
- [ ] Add separate requirement, server, instance and project binding records. Support multiple databases per project and shared databases. Preserve registration identity during a verified path change and migrate existing Docker settings.
- [ ] Separate ownership from per-operation permissions. Derive enabled actions from verified capabilities. Block shared or unverified deletion and track database operation outcomes with sanitized errors.
- [ ] Detect local PostgreSQL and MySQL installations, service status, version and connection permissions on Windows and Linux. Provide setup guidance when an installation is missing.
- [ ] Add explicit, reviewable initialization plans for missing databases and empty schemas. Check existing data, permissions, and target identity before executing. Track migrations separately and verify final schema readiness.

## P2 · Additional adapters and backup verification

- [ ] Add remote connection profiles with secure credential references, explicit connection tests and per-operation capabilities. Keep database permissions and provider permissions separate.
- [ ] Add SQLite discovery, schema inspection, explicit creation, and backup/restore that handles locks and WAL files.
- [ ] Verify backup integrity, record checksums and metadata, validate engine and version compatibility, preview restore impact, and verify restored objects.
- [ ] Run real database integration tests on Windows and Linux. Cover shared bindings, database initialization, unsupported operations and the existing Docker workflows as release gates.
