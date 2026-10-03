# Installation

## 1. Mailtrap

1. **Sending Domains → Add Domain**, then add the DNS records Mailtrap lists at your DNS provider. Wait until the domain shows **verified**; Mailtrap refuses to send from an unverified domain.
2. Create an **API token** for that domain. Tokens are per domain, and the Bulk Stream uses the same token as transactional.

## 2. Ghost wiring patch

Stock Ghost always uses Mailgun for newsletters. The patch makes Ghost's `EmailServiceWrapper` ask the AdapterManager for an `email` adapter when `adapters.email` is configured, and falls back to Mailgun otherwise. Pick the file for your exact Ghost version (see the README table) and apply it from `/var/lib/ghost/current`:

```bash
git apply --check /path/to/ghost-6.53-email-adapter-wiring.patch   # must print nothing
git apply /path/to/ghost-6.53-email-adapter-wiring.patch
```

## 3. Install the adapter

Either install into Ghost's dependencies:

```bash
cd /var/lib/ghost/current
npm install --omit=dev --no-save mailtrap@npm:ghost-mailtrap-email-adapter
```

or place the package at `content/adapters/email/mailtrap/` (with its `node_modules`).

### Docker

```dockerfile
FROM ghost:6.53.0-alpine
USER root
RUN apk add --no-cache git
COPY ghost-6.53-email-adapter-wiring.patch /tmp/wiring.patch
RUN cd /var/lib/ghost/current && git apply /tmp/wiring.patch \
 && npm install --omit=dev --prefix /opt/ghost-mailtrap-email-adapter ghost-mailtrap-email-adapter \
 && rm /tmp/wiring.patch
# Copy into the content volume at start-up, since content/ is usually a mounted volume.
RUN printf '#!/bin/sh\nset -eu\nd=/var/lib/ghost/content/adapters/email/mailtrap\nmkdir -p "$d"\ncp -R /opt/ghost-mailtrap-email-adapter/node_modules/ghost-mailtrap-email-adapter/. "$d/"\ncp -R /opt/ghost-mailtrap-email-adapter/node_modules "$d/"\nexec docker-entrypoint.sh "$@"\n' > /usr/local/bin/entrypoint-mailtrap \
 && chmod 755 /usr/local/bin/entrypoint-mailtrap
USER node
ENTRYPOINT ["entrypoint-mailtrap"]
CMD ["node", "current/index.js"]
```

## 4. Configure

| Key (`adapters.email.mailtrap.*`) | Default | Meaning |
| --- | --- | --- |
| `token` | required | Mailtrap API token for the verified domain |
| `stream` | `bulk` | `bulk` for newsletters, `transactional` otherwise |
| `fromEmail` | none | Sender used only when Ghost passes none |
| `category` | `newsletter` | Mailtrap category, for its analytics |
| `batchSize` | `500` | Messages per API call (1–500); also what Ghost sends per batch |
| `maxRetries` | `3` | Retries for 429, 5xx and network errors |
| `retryBaseMs` | `1000` | First retry delay, doubled each attempt (`Retry-After` wins) |
| `timeoutMs` | `30000` | Per-request timeout |
| `apiBaseUrl` | Mailtrap | Override the API host; for tests and local fakes only |

Also set `adapters.email.active` to `mailtrap`. As environment variables: `adapters__email__active=mailtrap`, `adapters__email__mailtrap__token=…`.

Ghost's own transactional mail (staff sign-in codes, member magic links) is separate. Point it at Mailtrap SMTP with `mail__transport=SMTP`, `mail__options__host=live.smtp.mailtrap.io`, `mail__options__port=587`, `mail__options__auth__user=api`, and `mail__options__auth__pass=<token>`.

## 5. Verify

- Ghost Admin → Settings → Newsletters: the sender address must be on the verified Mailtrap domain.
- Send a test newsletter to yourself, and confirm it in Mailtrap's Email Logs under the `newsletter` category.

## Disposable integration check

`npm run test:integration` builds a patched Ghost (default `ghost:6.53.0-alpine`) with this package from `npm pack`, and starts a fake Mailtrap API on a private Docker network. It then publishes a post as a newsletter to two members and checks that one `/api/batch` call carried two individually personalised messages. Everything runs on tmpfs and is removed on exit.

```bash
GHOST_IMAGE=ghost:6.54.0-alpine WIRING_PATCH=ghost-6.54-email-adapter-wiring.patch npm run test:integration
```

Never point it at a running Ghost or a real Mailtrap token.
