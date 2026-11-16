# StackForge product backlog

Develop these candidates in priority order. v0.33.0 completes the first item. The v0.32.3 stability work is recorded in the [refactor checklist](REFACTOR-CHECKLIST.md) and the published release.

1. **Project startup preflight.** Check a locally imported or cloned project before starting it and point users to the relevant setup action.
2. **Project-scoped development databases.** Start with a managed PostgreSQL instance in Docker for a single project. Define ownership and cleanup before exposing creation.
3. **Additional migration adapters.** Choose one from a real imported project. Start with target checks and a preview before supporting execution.
4. **Project activity history and overview.** Begin with a project's installation, checks, and database outcomes. Evaluate a global task view and dashboard after that.
5. **Environment, integrations, and settings.** Evaluate dedicated tools and settings views once project-level flows establish what users need to manage.
6. **Extended database management.** Evaluate backup and lifecycle operations for MongoDB, Redis, and SQL Server, then provider-specific cloud lifecycle workflows.

## v0.33.0 startup preflight

- [x] Add read-only checks for folder identity, saved startup and working directories, recognizable tools, declared ports, and discovered database configuration. Report individual results as passed, needs attention, or unverified.
- [x] Link checks to the existing startup, dependency, and database controls, including the PostgreSQL guide for missing or placeholder Prisma URLs. Use the existing Start project workflow after checking.
- [x] Verify a Game Portal-style Prisma project with a missing URL, a project with separate frontend and backend folders, and a ready project that opens its running service. `npm run test:browser` exercises each scenario in English and Chinese.

The [architecture specification](../ARCHITECTURE.md) defines the current product boundaries and how these candidates fit.
