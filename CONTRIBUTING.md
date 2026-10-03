# Contributing

## Release intent

Every pull request that changes publishable package files must include a Changeset. Run `npx changeset`, select `ghost-mailtrap-email-adapter`, choose the semantic version bump, and commit the generated file under `.changeset/`.

For changes that intentionally need no npm release (tests, CI, docs), ask a maintainer for the `no-changeset` label and say why in the PR.

After a Changeset PR merges, the Release workflow opens or updates a "Version Packages" PR. Merging that PR publishes to npm.

## Tests

- `npm test`: unit tests (mocked `fetch`, no network).
- `npm run test:integration`: disposable Ghost plus a fake Mailtrap in Docker; see `docs/installation.md`.
