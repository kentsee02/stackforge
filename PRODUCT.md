# StackForge

A local tool for developers who repeatedly initialize full-stack projects. A browser interface turns frontend, backend, and database choices into an independent project directory. English is the default; English and Chinese (华文) can be switched without reloading, including during creation. Language preference is stored in the current browser.

Supports Vue / React / no frontend, Spring Boot / Express / no backend, and MySQL / PostgreSQL / no database. Generates real code, an API proxy, database drivers, Compose, random local credentials, Maven Wrapper, English documentation, optional dependency installation, and optional local Git initialization. Uses Node.js with no third-party runtime dependencies and is MIT licensed.

The server listens only on loopback. Users install Node.js, Java, and Docker themselves. Database images are pulled when the generated development launcher first starts them. Existing project directories cannot be overwritten.

Preflight checks cover runtime tools, download sources, destinations, and ports, separating creation blockers from startup warnings. Personal templates use browser storage, support JSON import/export, and exclude paths, identities, and publishing permission.

Git operations are separate: local initialization, first commit, and GitHub publishing. Only publishing requires authentication. Publishing is off by default, private by default, and never overwrites an unrelated remote repository. Author identity is applied only to the generated project; credentials and global Git configuration remain under the user’s control.

Tasks support cancellation, checkpoint recovery, and persistent history. Cancellation stops downloads and installation subprocesses while retaining files. Recovery uses the original configuration, validates directory ownership, skips completed steps, and preserves passwords. Records live in the Git-ignored `.stackforge/` without copying `.env` passwords or tokens. GitHub publishing can be retried after restarting.

The Windows launcher opens the browser, reuses a service for the same checkout/version, and avoids occupied ports. Real integration scripts verify both frontend/backend families and MySQL / PostgreSQL queries. GitHub creation/push testing is an explicit opt-in; its private repository is retained.
