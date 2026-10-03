const EmailProviderBase = require('./EmailProviderBase');
const errors = require('@tryghost/errors');
const debug = require('@tryghost/debug')('email-service:mailtrap-adapter');
const crypto = require('node:crypto');
const {version} = require('./package.json');

const ENDPOINTS = {
    bulk: 'https://bulk.api.mailtrap.io',
    transactional: 'https://send.api.mailtrap.io'
};
// Mailtrap batch API limit: 500 messages per call (docs.mailtrap.io, "Batch send emails").
const MAX_BATCH_SIZE = 500;
// Keep retry recipient state bounded to limit memory and PII retention.
const MAX_RETRY_STATE_ENTRIES = 1000;
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

/**
 * Mailtrap Email Provider Adapter
 *
 * Sends Ghost newsletters through Mailtrap's batch sending API (Bulk Stream by default),
 * one personalised message per member, up to 500 messages per API call.
 * Extends EmailProviderBase to work with Ghost's AdapterManager.
 */
class MailtrapEmailProvider extends EmailProviderBase {
    #token;
    #endpoint;
    #batchSize;
    #category;
    #fromEmail;
    #fetch;
    #maxRetries;
    #retryBaseMs;
    #timeoutMs;
    #sleep;
    #errorHandler;
    #successfulRecipients = new Map();
    #inFlightSends = new Map();

    /**
     * @param {Object} config - Adapter configuration (from Ghost's `adapters.email.mailtrap` block)
     * @param {string} config.token - Mailtrap API token for the verified sending domain
     * @param {string} [config.stream='bulk'] - 'bulk' (newsletters) or 'transactional'
     * @param {string} [config.fromEmail] - Fallback sender when Ghost passes none
     * @param {string} [config.category='newsletter'] - Mailtrap category for analytics
     * @param {number} [config.batchSize=500] - Messages per API call (1-500)
     * @param {number} [config.maxRetries=3] - Retries for 429 and 5xx responses
     * @param {number} [config.retryBaseMs=1000] - First retry delay; doubles each attempt
     * @param {number} [config.timeoutMs=30000] - Per-request timeout
     * @param {string} [config.apiBaseUrl] - Override the API host (tests and local fakes only)
     */
    constructor(config) {
        super(config);

        // Accept both the AdapterManager shape ({token, ...}) and a wrapped one ({mailtrap: {...}}).
        const mailtrapConfig = config.mailtrap || config;

        if (!mailtrapConfig.token) {
            throw new errors.IncorrectUsageError({
                message: 'Mailtrap adapter requires token in configuration'
            });
        }

        const stream = mailtrapConfig.stream || 'bulk';
        if (!ENDPOINTS[stream]) {
            throw new errors.IncorrectUsageError({
                message: `Mailtrap adapter stream must be 'bulk' or 'transactional', got '${stream}'`
            });
        }

        const batchSize = mailtrapConfig.batchSize === undefined ? MAX_BATCH_SIZE : Number(mailtrapConfig.batchSize);
        if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > MAX_BATCH_SIZE) {
            throw new errors.IncorrectUsageError({
                message: `Mailtrap adapter batchSize must be an integer from 1 to ${MAX_BATCH_SIZE}`
            });
        }

        this.#token = mailtrapConfig.token;
        this.#endpoint = `${(mailtrapConfig.apiBaseUrl || ENDPOINTS[stream]).replace(/\/+$/, '')}/api/batch`;
        this.#batchSize = batchSize;
        this.#category = (mailtrapConfig.category || 'newsletter').slice(0, 255);
        this.#fromEmail = mailtrapConfig.fromEmail;
        this.#fetch = mailtrapConfig.fetch || globalThis.fetch;
        this.#maxRetries = mailtrapConfig.maxRetries === undefined ? 3 : Number(mailtrapConfig.maxRetries);
        this.#retryBaseMs = mailtrapConfig.retryBaseMs === undefined ? 1000 : Number(mailtrapConfig.retryBaseMs);
        this.#timeoutMs = mailtrapConfig.timeoutMs === undefined ? 30000 : Number(mailtrapConfig.timeoutMs);
        this.#sleep = mailtrapConfig.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
        this.#errorHandler = config.errorHandler;
    }

    #parseAddress(value) {
        if (!value) {
            return undefined;
        }
        const cleaned = String(value).replace(/[\r\n]/g, '').trim();
        const match = cleaned.match(/^(.*?)\s*<([^<>]+)>$/);
        if (!match) {
            return {email: cleaned};
        }
        const name = match[1].trim().replace(/^"(.*)"$/, '$1');
        return name ? {email: match[2].trim(), name} : {email: match[2].trim()};
    }

    #escapeHtml(value) {
        return String(value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    /**
     * Replace Ghost's per-recipient tokens (e.g. %%{uuid}%%, the unsubscribe URL) in content.
     * Values are HTML-escaped in HTML content.
     */
    #processReplacements(content, replacements, replacementDefinitions = [], isHtml = false) {
        if (!content || !replacements || replacements.length === 0) {
            return content;
        }

        let processed = content;
        for (const replacement of replacements) {
            const token = replacement.token || replacementDefinitions.find(def => def.id === replacement.id)?.token;
            if (!token) {
                continue;
            }
            let value = replacement.value === null || replacement.value === undefined ? '' : String(replacement.value);
            if (isHtml) {
                value = this.#escapeHtml(value);
            }
            const tokenRegex = token instanceof RegExp
                ? new RegExp(token.source, token.flags.includes('g') ? token.flags : `${token.flags}g`)
                : new RegExp(String(token).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
            processed = processed.replace(tokenRegex, () => value);
        }
        return processed;
    }

    #redactPII(value, recipients = []) {
        if (value === null || value === undefined) {
            return value;
        }
        let redacted = String(value);
        for (const recipient of recipients) {
            if (recipient?.email) {
                redacted = redacted.split(recipient.email).join('[redacted]');
            }
        }
        return redacted;
    }

    // Ghost's batch-sending-service can run two batches of one email at once, so the retry
    // key folds in a digest of the recipient set, not just the emailId.
    #getRetryKey({emailId, subject, recipients}) {
        const digest = crypto.createHash('sha256')
            .update(recipients.map(recipient => recipient.email).sort().join(','))
            .digest('hex')
            .slice(0, 32);
        return emailId ? `email:${emailId}:${digest}` : `content:${crypto.createHash('sha256').update(String(subject)).digest('hex').slice(0, 16)}:${digest}`;
    }

    #rememberSuccessfulRecipients(retryKey, successfulRecipients) {
        this.#successfulRecipients.delete(retryKey);
        this.#successfulRecipients.set(retryKey, successfulRecipients);
        while (this.#successfulRecipients.size > MAX_RETRY_STATE_ENTRIES) {
            this.#successfulRecipients.delete(this.#successfulRecipients.keys().next().value);
        }
    }

    #chunk(items, size) {
        const chunks = [];
        for (let i = 0; i < items.length; i += size) {
            chunks.push(items.slice(i, i + size));
        }
        return chunks;
    }

    #retryDelay(attempt, response) {
        const retryAfter = Number(response?.headers?.get?.('retry-after'));
        if (Number.isFinite(retryAfter) && retryAfter >= 0) {
            return Math.min(retryAfter * 1000, 60000);
        }
        return this.#retryBaseMs * (2 ** attempt);
    }

    async #postBatch(payload) {
        for (let attempt = 0; ; attempt += 1) {
            let response;
            let networkError;
            try {
                response = await this.#fetch(this.#endpoint, {
                    method: 'POST',
                    headers: {
                        Authorization: `Bearer ${this.#token}`,
                        'Content-Type': 'application/json',
                        Accept: 'application/json',
                        'User-Agent': `ghost-mailtrap-email-adapter/${version}`
                    },
                    body: JSON.stringify(payload),
                    signal: AbortSignal.timeout(this.#timeoutMs)
                });
            } catch (err) {
                networkError = err;
            }

            const retryable = networkError || RETRYABLE_STATUS.has(response.status);
            if (retryable && attempt < this.#maxRetries) {
                const delay = this.#retryDelay(attempt, response);
                debug(`Mailtrap batch ${networkError ? 'network error' : `HTTP ${response.status}`}; retrying in ${delay}ms`);
                await this.#sleep(delay);
                continue;
            }
            if (networkError) {
                throw networkError;
            }

            let body;
            try {
                body = await response.json();
            } catch (err) {
                body = undefined;
            }

            if (!response.ok) {
                const failure = new Error(`Mailtrap API responded with HTTP ${response.status}: ${(body?.errors || []).join('; ') || 'no error details'}`);
                failure.statusCode = response.status;
                throw failure;
            }
            return body || {};
        }
    }

    /**
     * Send one Ghost email batch.
     * @param {Object} data - Email data from Ghost's sending service
     * @param {string} data.subject
     * @param {string} data.html
     * @param {string} data.plaintext
     * @param {string} data.from
     * @param {string} [data.replyTo]
     * @param {string} data.emailId
     * @param {Array<{email: string, replacements: Array}>} data.recipients
     * @param {Array} data.replacementDefinitions
     * @param {Object} [options] - openTrackingEnabled/clickTrackingEnabled; Mailtrap configures tracking per sending domain, so these are not sent per message
     * @returns {Promise<{id: string}>} First Mailtrap message id, used by Ghost as provider_id
     */
    async send(data, options = {}) {
        const recipients = data.recipients || [];
        const retryKey = this.#getRetryKey({emailId: data.emailId, subject: data.subject, recipients});
        const inFlight = this.#inFlightSends.get(retryKey);
        if (inFlight) {
            return inFlight;
        }

        const sendPromise = this.#send(data, options, retryKey);
        this.#inFlightSends.set(retryKey, sendPromise);
        try {
            return await sendPromise;
        } finally {
            if (this.#inFlightSends.get(retryKey) === sendPromise) {
                this.#inFlightSends.delete(retryKey);
            }
        }
    }

    async #send(data, options, retryKey) {
        const {subject, html, plaintext, from, replyTo, emailId, recipients = [], replacementDefinitions = []} = data;
        const startTime = Date.now();
        const successful = this.#successfulRecipients.get(retryKey) || new Set();
        const pending = recipients.filter(recipient => !successful.has(recipient.email));
        const messageIds = [];
        const failures = [];

        debug(`sending ${pending.length} of ${recipients.length} recipients in batches of ${this.#batchSize}`);

        try {
            const sender = this.#parseAddress(from || this.#fromEmail);
            if (!sender?.email) {
                throw new errors.IncorrectUsageError({
                    message: 'Mailtrap adapter needs a from address: Ghost passed none and fromEmail is not configured'
                });
            }

            const base = {
                from: sender,
                subject,
                category: this.#category,
                custom_variables: {email_id: String(emailId || 'unknown')}
            };
            const reply = this.#parseAddress(replyTo);
            if (reply) {
                base.reply_to = reply;
            }

            for (const batch of this.#chunk(pending, this.#batchSize)) {
                const requests = batch.map(recipient => {
                    const request = {to: [{email: recipient.email}]};
                    const personalHtml = this.#processReplacements(html, recipient.replacements, replacementDefinitions, true);
                    const personalText = this.#processReplacements(plaintext, recipient.replacements, replacementDefinitions, false);
                    if (personalHtml) {
                        request.html = personalHtml;
                    }
                    if (personalText) {
                        request.text = personalText;
                    }
                    return request;
                });

                const body = await this.#postBatch({base, requests});
                const responses = Array.isArray(body.responses) ? body.responses : [];
                batch.forEach((recipient, index) => {
                    const result = responses[index];
                    if (result?.success) {
                        successful.add(recipient.email);
                        messageIds.push(...(result.message_ids || []));
                    } else {
                        failures.push({recipient, errors: result?.errors || body.errors || ['no result returned for this message']});
                    }
                });
            }

            if (failures.length) {
                this.#rememberSuccessfulRecipients(retryKey, successful);
                const failure = new Error(`Mailtrap rejected ${failures.length} of ${pending.length} messages: ${failures[0].errors.join('; ')}`);
                failure.statusCode = 422;
                throw failure;
            }

            this.#successfulRecipients.delete(retryKey);
            const duration = Date.now() - startTime;
            debug(`sent ${pending.length} messages in ${duration}ms (${(pending.length / (Math.max(duration, 1) / 1000)).toFixed(2)} emails/sec)`);

            // provider_id fits Ghost's 255-char column; fall back to the retry key when every
            // recipient had already been sent by an earlier attempt.
            return {id: messageIds[0] || retryKey};
        } catch (e) {
            if (e instanceof errors.IncorrectUsageError) {
                throw e;
            }
            if (!failures.length && successful.size) {
                this.#rememberSuccessfulRecipients(retryKey, successful);
            }
            const message = (this.#redactPII(e.message, recipients) || 'Mailtrap Error').slice(0, 2000);
            const sanitized = new Error(message);
            sanitized.name = this.#redactPII(e.name, recipients);
            const ghostError = new errors.EmailError({
                statusCode: e.statusCode || 500,
                message,
                errorDetails: JSON.stringify({
                    error: {name: sanitized.name, message, statusCode: e.statusCode},
                    recipientCount: recipients.length,
                    failedCount: failures.length
                }).slice(0, 2000),
                context: `Mailtrap Error: ${message}`,
                help: 'https://github.com/wakqasahmed/ghost-mailtrap-email-adapter#troubleshooting',
                code: 'BULK_EMAIL_SEND_FAILED',
                err: sanitized
            });

            if (this.#errorHandler) {
                try {
                    Promise.resolve(this.#errorHandler(ghostError)).catch(() => {});
                } catch (handlerError) {
                    // never let a logging failure hide the send error
                }
            }
            throw ghostError;
        }
    }

    /**
     * Recipients Ghost may pass to one send() call: one Mailtrap batch.
     * @returns {number}
     */
    getMaximumRecipients() {
        return this.#batchSize;
    }

    /**
     * Mailtrap sends immediately and this adapter ignores options.deliveryTime, so 0 tells Ghost
     * not to spread batches over a delivery window (Ghost expects milliseconds).
     * @returns {number}
     */
    getTargetDeliveryWindow() {
        return 0;
    }
}

module.exports = MailtrapEmailProvider;
