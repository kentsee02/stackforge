# Contributing to StackForge

Use Node.js 22.12 or later. Run `npm test` and `npm run check` after cloning; start the local UI with `npm start`. The generator has no third-party runtime dependencies.

For a new stack, declare its options in `src/catalog.mjs`, then extend the templates and generator. Add meaningful coverage for supported combinations, generated output, and failure recovery. Keep the server local, preserve existing directories, exclude `.env` from commits, and never interpolate user input into shell commands.

For interface changes, support both English and Chinese. Add message pairs to `public/messages.js`; `{name}` slots hold runtime values. Use `setText` from `public/i18n.js` for dynamic UI messages so an in-progress task can switch languages without reloading. Use `data-i18n` and corresponding attribute bindings for static copy. Keep user names, paths, code, and external CLI output intact. English is the default; generated project documentation stays in English.

Describe the problem, resulting behavior, and validation in English when submitting an issue or pull request. Do not commit generated test projects, node_modules, temporary logs, task records, or credentials. Real integration tests create local projects and persistent Docker volumes; `--github` additionally creates and retains a private remote repository.
