# Contributing to StackForge

Use Node.js 22.12 or later. Run `npm test` and `npm run check` after cloning; start the local UI with `npm start`. The generator has no third-party runtime dependencies.

Use the [code map](docs/CODE-MAP.md) to find a feature and its tests. See the [architecture specification](ARCHITECTURE.md) for dependency and compatibility rules. For a new stack, declare its options in `src/generation/catalog.mjs`, then extend the templates and generator. Add meaningful coverage for supported combinations, generated output, and failure recovery. Keep the server local, preserve existing directories, exclude `.env` from commits, and never interpolate user input into shell commands.

For interface changes, support both English and Chinese. Add message pairs to `public/shared/messages.js`. Use `{name}` slots for runtime values and `setText` from `public/shared/i18n.js` for dynamic text so a user can switch languages without reloading. Use `data-i18n` and corresponding attribute bindings for static copy. Keep user names, paths, code, and external CLI output intact. English is the default, and generated project documentation is written in English.

Describe the problem, resulting behavior, and validation in English when submitting an issue or pull request. Do not commit generated test projects, node_modules, temporary logs, task records, or credentials. Real integration tests create local projects and persistent Docker volumes; `--github` additionally creates and retains a private remote repository.

## Preparing a release

Run **Prepare release draft** from the repository's Actions tab on `main` when a version is ready. Enter the version tag, such as `v0.32.3`. The workflow uses the selected `main` commit by default. To release a previously tested commit, enter its full SHA. The workflow checks the version in both package files and the CI result for that exact commit on `main`.

An optional English summary goes before the generated release notes. Open the draft from the workflow summary, review the changes and installation instructions, then publish it from GitHub Releases.
