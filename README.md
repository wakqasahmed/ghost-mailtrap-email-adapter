<h1 align="center">Ghost Mailtrap Email Adapter</h1>
<p align="center">Mailtrap bulk email provider adapter for <a href="https://ghost.org" target="_blank">Ghost</a> newsletters, packaged as a standalone npm module following Ghost's community adapter conventions. Sibling of <a href="https://github.com/wakqasahmed/ghost-ses-email-adapter">ghost-ses-email-adapter</a>.</p>
<p align="center">
  <a aria-label="NPM Version" href="https://www.npmjs.com/package/ghost-mailtrap-email-adapter">
    <img alt="" src="https://img.shields.io/npm/v/ghost-mailtrap-email-adapter.svg?label=NPM&logo=npm&style=for-the-badge&color=0470FF&logoColor=white">
  </a>
</p>

> **Status: pre-alpha.** Sending is verified end to end against a patched Ghost 6.53 and a fake Mailtrap API. See the [issues](https://github.com/wakqasahmed/ghost-mailtrap-email-adapter/issues) for the roadmap.

## Why

Ghost's newsletter bulk sending only integrates with Mailgun. Ghost core has said it prefers an adapter mechanism with community-maintained providers over bundling more of them ([TryGhost/Ghost#25367](https://github.com/TryGhost/Ghost/pull/25367)). This package is that provider for [Mailtrap Email Sending](https://mailtrap.io/email-sending/).

It sends through Mailtrap's batch API on the **Bulk Stream** (`POST https://bulk.api.mailtrap.io/api/batch`):

- **One personalised message per member.** Each member gets their own unsubscribe link and replacements, and values are HTML-escaped.
- **Up to 500 messages per API call**, which is Mailtrap's limit. Ghost hands the adapter up to 500 recipients at a time.
- **Partial failures fail the batch.** Mailtrap answers HTTP 200 even when single messages fail, so the adapter checks each one. Ghost's retry then resends only the members who did not get the email.
- **Retries on 429 and 5xx** with backoff, honouring `Retry-After`. 400/401 fail at once with the reason.
- **Errors never contain member addresses,** and two concurrent sends of the same batch are de-duplicated.

Until Ghost core ships third-party email adapter wiring ([TryGhost/Ghost#29553](https://github.com/TryGhost/Ghost/pull/29553)), Ghost needs a small interim patch to load any email adapter. The patch is the same one `ghost-ses-email-adapter` uses.

## How

1. In Mailtrap, add and **verify your sending domain**, then create an API token for it (Bulk Stream).
2. Apply the wiring patch that matches your Ghost version (table below), from `/var/lib/ghost/current`:

   ```bash
   git apply /path/to/ghost-6.53-email-adapter-wiring.patch
   ```

3. Install the adapter where Ghost loads email adapters:

   ```bash
   cd /var/lib/ghost/current
   npm install --omit=dev --no-save mailtrap@npm:ghost-mailtrap-email-adapter
   # or copy the package into content/adapters/email/mailtrap/
   ```

4. Configure Ghost (environment variables shown; `config.production.json` works the same):

   ```bash
   adapters__email__active=mailtrap
   adapters__email__mailtrap__token=<Mailtrap API token for the verified domain>
   # optional
   adapters__email__mailtrap__stream=bulk          # or transactional
   adapters__email__mailtrap__fromEmail=news@yourdomain.com
   adapters__email__mailtrap__category=newsletter
   ```

5. Restart Ghost. The newsletter's sender address (Ghost Admin → Settings → Newsletters) must be on the verified Mailtrap domain. Ghost's default is `noreply@<your site domain>`.

Full walkthrough, Docker example, configuration reference, and the disposable integration check: **[Installation guide](docs/installation.md)**.

## Supported Ghost versions

The wiring patch touches Ghost core files that change between releases, so each Ghost version needs the patch made for it.

| Ghost version | Wiring patch | Verified |
| --- | --- | --- |
| 6.53.x | [`ghost-6.53-email-adapter-wiring.patch`](patches/ghost-6.53-email-adapter-wiring.patch) | Patch applies; full newsletter send in `test/integration/ghost-6.sh` (default) |
| 6.54.x | [`ghost-6.54-email-adapter-wiring.patch`](patches/ghost-6.54-email-adapter-wiring.patch) | Patch applies (`git apply --check`); run the integration test with `GHOST_IMAGE=ghost:6.54.0-alpine WIRING_PATCH=ghost-6.54-email-adapter-wiring.patch` before relying on it |

Other versions are untested. Before every Ghost upgrade, run `git apply --check` with the matching patch and the disposable integration test.

## Known limitations

- **Two unsubscribe paths.** Mailtrap's Bulk Stream always adds its own `List-Unsubscribe` headers and does not let you turn them off ([Mailtrap docs](https://docs.mailtrap.io/email-api-smtp/setup/bulk-stream)). A reader who unsubscribes through their mail client's button is suppressed at Mailtrap, but Ghost still lists them as subscribed. Ghost's own unsubscribe link in the email footer works as usual. Syncing Mailtrap suppressions back to Ghost is planned.
- **No open/click/bounce analytics in Ghost.** Ghost reads these from Mailgun's events API only. Mailtrap shows them in its own dashboard, and tracking is configured per sending domain in Mailtrap, not per message.
- **Ghost's delivery-time spreading is not used.** Messages go out as soon as Ghost hands them over.

## Troubleshooting

- **`401 Unauthorized`:** the token is wrong, or belongs to a different domain than the sender address. Mailtrap tokens are per domain.
- **Per-message errors** (`Mailtrap rejected N of M messages`): Ghost marks the batch failed and retries it. Only the rejected members are resent. Check Mailtrap's Email Logs for the reason.
- **Adapter not loading** (Ghost still uses Mailgun): the wiring patch is missing or doesn't match your Ghost version. Run `git apply --check` with the matching patch.

## Credits

- The Ghost wiring patch comes from [ghost-ses-email-adapter](https://github.com/wakqasahmed/ghost-ses-email-adapter).
- Replacement handling follows that adapter's port of [TryGhost/Ghost#25367](https://github.com/TryGhost/Ghost/pull/25367) by Daniel Raffel (@danielraffel).
