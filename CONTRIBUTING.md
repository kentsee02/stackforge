# Contributing to StackForge

Use Node.js 22.12 or later. Run `npm test` and `npm run check` after cloning; start the local UI with `npm start`. The generator has no third-party runtime dependencies.

Use the [code map](docs/ARCHITECTURE.md) to find a feature and its tests. For a new stack, declare its options in `src/generation/catalog.mjs`, then extend the templates and generator. Add meaningful coverage for supported combinations, generated output, and failure recovery. Keep the server local, preserve existing directories, exclude `.env` from commits, and never interpolate user input into shell commands.

For interface changes, support both English and Chinese. Add message pairs to `public/shared/messages.js`. Use `{name}` slots for runtime values and `setText` from `public/shared/i18n.js` for dynamic text so a user can switch languages without reloading. Use `data-i18n` and corresponding attribute bindings for static copy. Keep user names, paths, code, and external CLI output intact. English is the default, and generated project documentation is written in English.

Describe the problem, resulting behavior, and validation in English when submitting an issue or pull request. Do not commit generated test projects, node_modules, temporary logs, task records, or credentials. Real integration tests create local projects and persistent Docker volumes; `--github` additionally creates and retains a private remote repository.
