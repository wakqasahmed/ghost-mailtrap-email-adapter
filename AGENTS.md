# ghost-mailtrap-email-adapter: agent context

Mailtrap bulk email provider for Ghost newsletters, the sibling of `wakqasahmed/ghost-ses-email-adapter`. Read that repo's `AGENTS.md` for the verified facts about Ghost's AdapterManager and why a wiring patch is needed; they apply here unchanged.

## Facts verified while building this (2026-10-03)

- **Mailtrap batch API:** `POST {bulk|send}.api.mailtrap.io/api/batch`, body `{base, requests[]}`, max 500 messages and 50 MB per call. It returns HTTP 200 even when single messages fail; check `responses[i].success` (same order as `requests`). Auth: `Authorization: Bearer <token>`. Send a real `User-Agent`; bare requests may be blocked. Rate limit: 150 requests per 10 s per token, 429 when exceeded. Source: docs.mailtrap.io "Batch send emails" and "Rate Limits".
- **Bulk Stream always adds Mailtrap's own `List-Unsubscribe` headers**; they can't be disabled. Hence the documented two-unsubscribe-paths limitation.
- **Wiring patches are Ghost-version specific.** The SES repo's `ghost-6.x` patch applies to 6.54 but not 6.53; the 6.53 variant comes from `wakqasahmed/personal-portfolio` `docker/ghost/patches/`. On 6.53 the adapter-manager module has no `.default` export.
- **Ghost 6.53 admin API quirks** used by the integration test: `POST /session/` answers with plain text; `Origin` must match Ghost's configured `url`; weak passwords are rejected; "Ghost is running" is logged before the admin API is ready.

## Conventions

- Same as the SES repo: MIT, Node >= 20, mocha/should/sinon, changesets, branch per issue, PRs to `main`, no AI attribution in commits, fake credentials only in tests.
- Integration tests run only against disposable containers they create themselves. Never against a running Ghost on the host.
