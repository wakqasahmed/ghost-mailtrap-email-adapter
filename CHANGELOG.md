# ghost-mailtrap-email-adapter

## 0.1.0

### Minor Changes

- a8decb7: First release: Mailtrap Bulk Stream provider for Ghost newsletters (batch API, up to 500 personalised messages per call, retry of failed recipients only, backoff on 429/5xx, PII-redacted errors), with Ghost 6.53 and 6.54 wiring patches and a disposable end-to-end integration test.
