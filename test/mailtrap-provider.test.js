const should = require('should');
const sinon = require('sinon');
const errors = require('@tryghost/errors');
const MailtrapEmailProvider = require('../MailtrapEmailProvider');

const TOKEN = 'fake-mailtrap-token-for-tests';

function jsonResponse(status, body, headers = {}) {
    return {
        status,
        ok: status >= 200 && status < 300,
        headers: {get: name => headers[name.toLowerCase()]},
        json: async () => body
    };
}

function okFor(requests, idPrefix = 'msg') {
    return jsonResponse(200, {
        success: true,
        responses: requests.map((r, i) => ({success: true, message_ids: [`${idPrefix}-${i}-${r.to[0].email}`]}))
    });
}

function makeProvider(fetchImpl, extra = {}) {
    return new MailtrapEmailProvider({token: TOKEN, fetch: fetchImpl, sleep: async () => {}, ...extra});
}

const unsubscribeToken = /%%\{list_unsubscribe\}%%/g;
const nameToken = /%%\{name\}%%/g;

function emailData(recipients, overrides = {}) {
    return {
        subject: 'Already There: Atomic Habits',
        html: '<p>Hi %%{name}%%</p><a href="%%{list_unsubscribe}%%">Unsubscribe</a>',
        plaintext: 'Hi %%{name}%% unsubscribe: %%{list_unsubscribe}%%',
        from: 'Wakqas Ahmed <news@example.test>',
        replyTo: 'reply@example.test',
        emailId: 'email-123',
        replacementDefinitions: [{id: 'list_unsubscribe', token: unsubscribeToken}, {id: 'name', token: nameToken}],
        recipients,
        ...overrides
    };
}

function recipient(email, name = 'Reader') {
    return {
        email,
        replacements: [
            {id: 'list_unsubscribe', value: `https://example.test/unsubscribe/?uuid=${email}`},
            {id: 'name', value: name}
        ]
    };
}

describe('MailtrapEmailProvider', function () {
    describe('configuration', function () {
        it('requires a token', function () {
            should.throws(() => new MailtrapEmailProvider({}), errors.IncorrectUsageError);
        });

        it('rejects an unknown stream', function () {
            should.throws(() => new MailtrapEmailProvider({token: TOKEN, stream: 'smtp'}), /bulk' or 'transactional/);
        });

        it('rejects batch sizes outside 1-500', function () {
            for (const batchSize of [0, 501, 2.5, 'x']) {
                should.throws(() => new MailtrapEmailProvider({token: TOKEN, batchSize}), /batchSize/);
            }
        });

        it('accepts the wrapped {mailtrap: {...}} shape', function () {
            const provider = new MailtrapEmailProvider({mailtrap: {token: TOKEN, batchSize: 10}});
            provider.getMaximumRecipients().should.equal(10);
        });

        it('reports a 500-recipient batch and no delivery window by default', function () {
            const provider = new MailtrapEmailProvider({token: TOKEN});
            provider.getMaximumRecipients().should.equal(500);
            provider.getTargetDeliveryWindow().should.equal(0);
            provider.requiredFns.should.eql(['send', 'getMaximumRecipients', 'getTargetDeliveryWindow']);
        });
    });

    describe('send', function () {
        it('posts one batch to the bulk endpoint with personalised, escaped content', async function () {
            const fetch = sinon.stub().callsFake(async (url, init) => okFor(JSON.parse(init.body).requests));
            const provider = makeProvider(fetch);
            const result = await provider.send(emailData([recipient('a@example.test', '<b>Ann</b>'), recipient('b@example.test', 'Bo')]));

            fetch.calledOnce.should.be.true();
            const [url, init] = fetch.firstCall.args;
            url.should.equal('https://bulk.api.mailtrap.io/api/batch');
            init.method.should.equal('POST');
            init.headers.Authorization.should.equal(`Bearer ${TOKEN}`);
            init.headers['User-Agent'].should.match(/^ghost-mailtrap-email-adapter\//);

            const body = JSON.parse(init.body);
            body.base.should.eql({
                from: {email: 'news@example.test', name: 'Wakqas Ahmed'},
                subject: 'Already There: Atomic Habits',
                category: 'newsletter',
                custom_variables: {email_id: 'email-123'},
                reply_to: {email: 'reply@example.test'}
            });
            body.requests.should.have.length(2);
            body.requests[0].to.should.eql([{email: 'a@example.test'}]);
            body.requests[0].html.should.equal('<p>Hi &lt;b&gt;Ann&lt;/b&gt;</p><a href="https://example.test/unsubscribe/?uuid=a@example.test">Unsubscribe</a>');
            body.requests[1].html.should.containEql('uuid=b@example.test');
            body.requests[1].text.should.containEql('unsubscribe: https://example.test/unsubscribe/?uuid=b@example.test');
            result.id.should.equal('msg-0-a@example.test');
        });

        it('uses the transactional endpoint and an apiBaseUrl override', async function () {
            const fetch = sinon.stub().callsFake(async (url, init) => okFor(JSON.parse(init.body).requests));
            await makeProvider(fetch, {stream: 'transactional'}).send(emailData([recipient('a@example.test')]));
            fetch.firstCall.args[0].should.equal('https://send.api.mailtrap.io/api/batch');
            await makeProvider(fetch, {apiBaseUrl: 'http://127.0.0.1:9999/'}).send(emailData([recipient('a@example.test')]));
            fetch.secondCall.args[0].should.equal('http://127.0.0.1:9999/api/batch');
        });

        it('splits recipients into batches of batchSize', async function () {
            const fetch = sinon.stub().callsFake(async (url, init) => okFor(JSON.parse(init.body).requests));
            const recipients = Array.from({length: 5}, (_, i) => recipient(`r${i}@example.test`));
            await makeProvider(fetch, {batchSize: 2}).send(emailData(recipients));
            fetch.callCount.should.equal(3);
            fetch.getCalls().map(c => JSON.parse(c.args[1].body).requests.length).should.eql([2, 2, 1]);
        });

        it('fails on per-message errors and resends only the failed recipients on retry', async function () {
            const fetch = sinon.stub();
            fetch.onFirstCall().resolves(jsonResponse(200, {
                success: false,
                responses: [
                    {success: true, message_ids: ['ok-a']},
                    {success: false, errors: ['mailbox unavailable for b@example.test']}
                ]
            }));
            fetch.onSecondCall().callsFake(async (url, init) => okFor(JSON.parse(init.body).requests, 'retry'));
            const provider = makeProvider(fetch);
            const data = emailData([recipient('a@example.test'), recipient('b@example.test')]);

            const err = await provider.send(data).catch(e => e);
            err.should.be.instanceOf(errors.EmailError);
            err.code.should.equal('BULK_EMAIL_SEND_FAILED');
            err.message.should.containEql('Mailtrap rejected 1 of 2 messages');
            err.message.should.not.containEql('b@example.test');

            const result = await provider.send(data);
            const retried = JSON.parse(fetch.secondCall.args[1].body).requests;
            retried.map(r => r.to[0].email).should.eql(['b@example.test']);
            result.id.should.equal('retry-0-b@example.test');
        });

        it('retries 429 and 5xx with backoff, honouring Retry-After', async function () {
            const sleep = sinon.stub().resolves();
            const fetch = sinon.stub();
            fetch.onCall(0).resolves(jsonResponse(429, {errors: ['rate limited']}, {'retry-after': '2'}));
            fetch.onCall(1).resolves(jsonResponse(503, {errors: ['unavailable']}));
            fetch.onCall(2).callsFake(async (url, init) => okFor(JSON.parse(init.body).requests));
            const provider = makeProvider(fetch, {sleep, retryBaseMs: 100});
            await provider.send(emailData([recipient('a@example.test')]));
            fetch.callCount.should.equal(3);
            sleep.getCalls().map(c => c.args[0]).should.eql([2000, 200]);
        });

        it('gives up after maxRetries', async function () {
            const fetch = sinon.stub().resolves(jsonResponse(500, {errors: ['boom']}));
            const err = await makeProvider(fetch, {maxRetries: 2}).send(emailData([recipient('a@example.test')])).catch(e => e);
            fetch.callCount.should.equal(3);
            err.should.be.instanceOf(errors.EmailError);
            err.statusCode.should.equal(500);
        });

        it('does not retry 400/401 and redacts addresses from the error', async function () {
            for (const status of [400, 401]) {
                const fetch = sinon.stub().resolves(jsonResponse(status, {errors: ['bad recipient a@example.test']}));
                const err = await makeProvider(fetch).send(emailData([recipient('a@example.test')])).catch(e => e);
                fetch.callCount.should.equal(1);
                err.statusCode.should.equal(status);
                err.message.should.containEql('[redacted]');
                err.message.should.not.containEql('a@example.test');
                err.errorDetails.should.not.containEql('a@example.test');
            }
        });

        it('retries network errors, then surfaces them as EmailError', async function () {
            const fetch = sinon.stub().rejects(new Error('socket hang up'));
            const err = await makeProvider(fetch, {maxRetries: 1}).send(emailData([recipient('a@example.test')])).catch(e => e);
            fetch.callCount.should.equal(2);
            err.should.be.instanceOf(errors.EmailError);
            err.message.should.containEql('socket hang up');
        });

        it('shares one in-flight request between concurrent identical sends', async function () {
            let release;
            const gate = new Promise((resolve) => {
                release = resolve;
            });
            const fetch = sinon.stub().callsFake(async (url, init) => {
                await gate;
                return okFor(JSON.parse(init.body).requests);
            });
            const provider = makeProvider(fetch);
            const data = emailData([recipient('a@example.test')]);
            const first = provider.send(data);
            const second = provider.send(data);
            release();
            (await first).should.eql(await second);
            fetch.callCount.should.equal(1);
        });

        it('falls back to fromEmail and fails clearly without any sender', async function () {
            const fetch = sinon.stub().callsFake(async (url, init) => okFor(JSON.parse(init.body).requests));
            await makeProvider(fetch, {fromEmail: 'Fallback <fallback@example.test>'}).send(emailData([recipient('a@example.test')], {from: ''}));
            JSON.parse(fetch.firstCall.args[1].body).base.from.should.eql({email: 'fallback@example.test', name: 'Fallback'});
            await makeProvider(fetch).send(emailData([recipient('a@example.test')], {from: ''})).should.be.rejectedWith(errors.IncorrectUsageError);
        });

        it('strips CR/LF from addresses', async function () {
            const fetch = sinon.stub().callsFake(async (url, init) => okFor(JSON.parse(init.body).requests));
            await makeProvider(fetch).send(emailData([recipient('a@example.test')], {from: 'Evil\r\nBcc: x@y <news@example.test>'}));
            JSON.parse(fetch.firstCall.args[1].body).base.from.name.should.not.match(/[\r\n]/);
        });

        it('passes errors to errorHandler without letting it throw', async function () {
            const errorHandler = sinon.stub().throws(new Error('logger down'));
            const fetch = sinon.stub().resolves(jsonResponse(401, {errors: ['Unauthorized']}));
            const err = await makeProvider(fetch, {errorHandler}).send(emailData([recipient('a@example.test')])).catch(e => e);
            errorHandler.calledOnce.should.be.true();
            err.should.be.instanceOf(errors.EmailError);
        });
    });
});
