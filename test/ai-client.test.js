import test from 'node:test';
import assert from 'node:assert/strict';
import { AiClient, normalizeAiBaseUrl, normalizeAiConfiguration, normalizeAiSignInUrl } from '../src/ai/AiClient.js';
import { MAX_AI_OUTPUT_BYTES } from '../src/ai/protocol.js';

const request = () => ({ version: 1, task: 'explain-series', facts: [{ id: 'E1', code: 'rows', value: 512 }] });
const ndjson = events => events.map(event => JSON.stringify(event)).join('\n') + '\n';
const good = () => [{ type: 'delta', text: '512 rows [E1].' }, { type: 'done', model: 'amazon.nova-micro-v1:0' }];
function response(events = good(), { chunkSize = 9, type = 'application/x-ndjson; charset=utf-8', status = 200, raw, onCancel = () => {} } = {}) {
    const bytes = raw instanceof Uint8Array ? raw : new TextEncoder().encode(raw ?? ndjson(events));
    let offset = 0;
    return { ok: status >= 200 && status < 300, status, headers: new Headers({ 'content-type': type }), body: new ReadableStream({
        pull(controller) {
            if (offset >= bytes.length) { controller.close(); return; }
            controller.enqueue(bytes.subarray(offset, offset += chunkSize));
        }, cancel: onCancel
    }) };
}
const client = (fetchImpl, options = {}) => new AiClient({ baseUrl: 'https://gateway.example/api/ai', ...options }, { fetchImpl });
const workflowPlan = () => ({version: 1, status: 'ready', summary: 'Use two panes.', question: null, actions: [{type: 'layout', count: 2}]});
const jsonResponse = value => new Response(JSON.stringify(value), {headers: {'Content-Type': 'application/json'}});

test('workflow text and audio requests keep native-like fetch invocation, model binding and gateway authorization', async () => {
    const calls = [];
    function transport(url, options) {
        assert.equal(this, undefined); calls.push({url, options});
        return Promise.resolve(jsonResponse(url.endsWith('/plan') ? {version: 1, model: 'test-model', plan: workflowPlan()} : {version: 1, model: 'gpt-transcribe', text: 'Use two panes.'}));
    }
    const instance = client(transport, {model: 'test-model', credentials: 'same-origin', getHeaders: () => ({Authorization: 'Bearer synthetic', 'X-Easi-Ai-Model': 'cannot-override'})});
    assert.equal(calls.length, 0);
    assert.equal((await instance.planCommand('  Use two panes.  ')).plan.actions[0].count, 2);
    assert.equal((await instance.transcribeCommand({mimeType: 'audio/webm', audio: 'AQID'})).text, 'Use two panes.');
    assert.deepEqual(calls.map(call => JSON.parse(call.options.body)), [{version: 1, task: 'plan-workflow', command: 'Use two panes.'}, {version: 1, task: 'transcribe-command', mimeType: 'audio/webm', audio: 'AQID'}]);
    assert.ok(calls.every(call => call.options.headers.get('x-easi-ai-model') === 'test-model' && call.options.headers.get('authorization') === 'Bearer synthetic' && call.options.headers.get('accept') === 'application/json' && call.options.credentials === 'same-origin' && call.options.redirect === 'error'));
});

test('workflow rejects invalid commands and audio before any transport call', () => {
    let calls = 0; const instance = client(() => { calls++; });
    for (const command of ['', 'x'.repeat(1201), 'hidden\u0000instruction']) assert.throws(() => instance.planCommand(command), error => error.code === 'invalid-request');
    for (const recording of [{mimeType: 'video/webm', audio: 'AQID'}, {mimeType: 'audio/webm', audio: 'not base64'}, {mimeType: 'audio/webm', audio: 'AAAB'.repeat(700000)}]) assert.throws(() => instance.transcribeCommand(recording), error => error.code === 'invalid-request');
    assert.equal(calls, 0);
});

test('planning sends only command protocol and the explicitly selected mode without pane or catalog state', async () => {
    const calls = [];
    const instance = client(async (url, options) => {calls.push(JSON.parse(options.body)); return jsonResponse({version: 1, model: 'test-model', plan: workflowPlan()});});
    await instance.planCommand('Make the right pane bone.', {mode: 'continue'});
    await instance.planCommand('Prepare a new CT review.', {mode: 'fresh'});
    assert.deepEqual(calls.map(value => value.mode), ['continue', 'fresh']);
    assert.ok(calls.every(value => Object.keys(value).join(',') === 'version,task,command,mode'));
    assert.throws(() => instance.planCommand('Prepare CT.', {mode: 'clear-library'}), error => error.code === 'invalid-request');
});

for (const [name, result] of [
    ['wrong JSON type', () => new Response('{}', {headers: {'Content-Type': 'text/html'}})],
    ['arbitrary plan action', () => jsonResponse({version: 1, model: 'test-model', plan: {...workflowPlan(), actions: [{type: 'javascript', code: 'execute()'}]}})],
    ['extra catalog field', () => jsonResponse({version: 1, model: 'test-model', plan: workflowPlan(), catalog: 'private'})],
    ['bounded output', () => new Response(' '.repeat(65537), {headers: {'Content-Type': 'application/json'}})],
    ['invalid JSON', () => new Response('{private provider body}', {headers: {'Content-Type': 'application/json'}})]
]) test(`workflow JSON rejects ${name} with a controlled error`, async () => {
    await assert.rejects(client(async () => result(), {model: 'test-model'}).planCommand('Use two panes.'), error => error.code === 'invalid-response' && !error.message.includes('private'));
});

test('workflow model mismatch and wrong transcription provenance cannot reach the UI', async () => {
    await assert.rejects(client(async () => jsonResponse({version: 1, model: 'different-model', plan: workflowPlan()}), {model: 'test-model'}).planCommand('Use two panes.'), error => error.code === 'configuration-changed');
    await assert.rejects(client(async () => jsonResponse({version: 1, model: 'different-transcriber', text: 'Use two panes.'})).transcribeCommand({mimeType: 'audio/webm', audio: 'AQID'}), error => error.code === 'invalid-response');
});

test('workflow shares the one-job boundary with legacy generation and cancels a stalled request', async () => {
    let signal;
    const instance = client((_, options) => { signal = options.signal; return new Promise(() => {}); });
    const pending = instance.planCommand('Use two panes.'); await Promise.resolve();
    await assert.rejects(instance.connectionTest(), error => error.code === 'busy');
    instance.cancel(); await assert.rejects(pending, error => error.code === 'cancelled'); assert.equal(signal.aborted, true);
});

test('workflow timeout includes asynchronous authorization and never sends after it expires', async () => {
    let release, called = false;
    const instance = client(() => { called = true; }, {timeoutMs: 10, getHeaders: () => new Promise(resolve => { release = resolve; })});
    await assert.rejects(instance.planCommand('Use two panes.'), error => error.code === 'timeout'); release({Authorization: 'Bearer late'}); await Promise.resolve(); assert.equal(called, false);
});

test('AI configuration is opt-in and an enabled unconfigured panel makes no implicit connection', () => {
    assert.deepEqual(normalizeAiConfiguration(undefined), { enabled: false, configured: false, baseUrl: null, label: 'AI service', recipient: null, model: null, credentials: 'omit' });
    const enabled = normalizeAiConfiguration({ enabled: true });
    assert.equal(enabled.enabled, true); assert.equal(enabled.configured, false);
    const configured = normalizeAiConfiguration({ baseUrl: 'https://gateway.example/api/ai/', label: 'Research AI', model: 'test-model:1' });
    assert.equal(configured.baseUrl, 'https://gateway.example/api/ai'); assert.equal(configured.recipient, 'gateway.example');
    assert.equal(configured.credentials, 'omit');
});

test('AI configuration normalization is idempotent and configured is derived from the endpoint', () => {
    for (const input of [undefined, { enabled: true }, { baseUrl: 'https://gateway.example/api/ai', label: 'Research AI' }]) {
        const normalized = normalizeAiConfiguration(input);
        assert.deepEqual(normalizeAiConfiguration(normalized), normalized);
    }
    assert.equal(normalizeAiConfiguration({ configured: true }).configured, false);
    assert.equal(normalizeAiConfiguration({ baseUrl: 'https://gateway.example', configured: false }).configured, true);
    assert.throws(() => normalizeAiConfiguration({ configured: 'true' }), error => error.code === 'invalid-request');
});

test('configuration rejects secrets, unsupported authentication policy and nonplain/accessor/symbol records', () => {
    let touched = false;
    for (const config of [{ apiKey: 'SECRET' }, { credentials: 'include' }, { getHeaders: 'SECRET' }, { model: '<script>' }, { timeoutMs: 60001 },
        { label: 'private\nlabel' }, Object.create({ baseUrl: 'https://gateway.example' }), { [Symbol('secret')]: 'SECRET' }, true, []]) {
        assert.throws(() => normalizeAiConfiguration(config), error => error.code === 'invalid-request' && !error.message.includes('SECRET'));
    }
    assert.throws(() => normalizeAiConfiguration({ get baseUrl() { touched = true; return 'https://gateway.example'; } }));
    assert.equal(touched, false);
});

test('gateway URL policy requires HTTPS except loopback development, with no embedded credentials/query/hash', () => {
    assert.equal(normalizeAiBaseUrl('/api/ai', 'https://viewer.example/viewer/'), 'https://viewer.example/api/ai');
    assert.equal(normalizeAiBaseUrl('http://127.0.0.1:8080/api/ai/'), 'http://127.0.0.1:8080/api/ai');
    assert.equal(normalizeAiBaseUrl('http://[::1]:8080'), 'http://[::1]:8080');
    for (const url of ['http://remote.example', 'http://127.0.0.1.evil.example', 'https://name:SECRET@gateway.example', 'https://gateway.example?token=SECRET', 'https://gateway.example/#secret', 'data:text/plain,hi', 'file:///tmp/gateway', 'javascript:alert(1)']) {
        assert.throws(() => normalizeAiBaseUrl(url), error => error.code === 'invalid-request' && !error.message.includes('SECRET'));
    }
});

test('generate performs one explicit credential-omitting nonredirecting request containing exactly previewed facts', async () => {
    let calls = 0, captured;
    const instance = client(async (url, options) => { calls++; captured = { url, options }; return response(); });
    assert.equal(calls, 0);
    const deltas = [], result = await instance.generate(request(), { onDelta: delta => deltas.push(delta) });
    assert.equal(calls, 1); assert.equal(captured.url, 'https://gateway.example/api/ai/generate');
    assert.deepEqual(JSON.parse(captured.options.body), request());
    assert.equal(captured.options.credentials, 'omit'); assert.equal(captured.options.redirect, 'error');
    assert.equal(captured.options.referrerPolicy, 'no-referrer'); assert.equal(captured.options.cache, 'no-store');
    assert.equal(captured.options.headers.get('content-type'), 'application/json');
    assert.deepEqual(result, { text: '512 rows [E1].', model: 'amazon.nova-micro-v1:0' });
    assert.equal(deltas.join(''), result.text);
});

test('synthetic connection test sends no frame, measurements or identifiers', async () => {
    let wire;
    const instance = client(async (url, options) => { wire = { url, body: JSON.parse(options.body) }; return response([{ type: 'delta', text: 'Connected.' }, { type: 'done' }]); });
    assert.equal((await instance.connectionTest()).text, 'Connected.');
    assert.equal(wire.url, 'https://gateway.example/api/ai/test');
    assert.deepEqual(wire.body, { version: 1, task: 'connection-test', facts: [] });
});

test('default native-like browser fetch succeeds for connection testing and generation without a client receiver', async () => {
    const originalFetch = globalThis.fetch, calls = [];
    let instance;
    try {
        // Browser-native fetch rejects an unrelated object receiver. Arrow-only
        // transport mocks hide that failure, so exercise the default capture.
        globalThis.fetch = function (url, options) {
            if (this !== undefined && this !== globalThis) throw new TypeError('Illegal invocation');
            calls.push({ receiver: this, url, options });
            return Promise.resolve(response(url.endsWith('/test') ? [{ type: 'delta', text: 'Connected.' }, { type: 'done' }] : good()));
        };
        instance = new AiClient({ baseUrl: 'https://gateway.example/api/ai', credentials: 'same-origin', model: 'amazon.nova-micro-v1:0' });
    } finally { globalThis.fetch = originalFetch; }
    assert.equal(calls.length, 0);
    assert.equal((await instance.connectionTest()).text, 'Connected.');
    assert.equal((await instance.generate(request())).text, '512 rows [E1].');
    assert.deepEqual(calls.map(call => call.url), ['https://gateway.example/api/ai/test', 'https://gateway.example/api/ai/generate']);
    assert.ok(calls.every(call => call.receiver === undefined));
    assert.deepEqual(JSON.parse(calls[0].options.body), { version: 1, task: 'connection-test', facts: [] });
    assert.deepEqual(JSON.parse(calls[1].options.body), request());
    assert.ok(calls.every(call => call.options.credentials === 'same-origin' && call.options.redirect === 'error' &&
        call.options.headers.get('x-easi-ai-model') === 'amazon.nova-micro-v1:0'));
});

test('custom fetch transports are invoked as standalone functions without exposing the AiClient receiver', async () => {
    let receiver, calls = 0;
    async function transport(url, options) {
        receiver = this; calls++;
        assert.equal(url, 'https://gateway.example/api/ai/generate');
        assert.deepEqual(JSON.parse(options.body), request());
        return response();
    }
    const instance = client(transport);
    await instance.generate(request());
    assert.equal(calls, 1); assert.equal(receiver, undefined);
});

test('UTF-8 NDJSON parsing handles token, line and multibyte boundaries', async () => {
    const instance = client(async () => response([{ type: 'delta', text: 'A café [E1].' }, { type: 'delta', text: '\nNext line.' }, { type: 'done' }], { chunkSize: 1 }));
    assert.equal((await instance.generate(request())).text, 'A café [E1].\nNext line.');
});

test('host authorization callback is bounded and cannot override transport headers', async () => {
    let headerCalls = 0, headers;
    const instance = client(async (_, options) => { headers = options.headers; return response(); }, { getHeaders: async ({ signal }) => {
        assert.equal(signal.aborted, false); headerCalls++; return { Authorization: 'Bearer gateway-session', 'X-Tenant': 'demo' };
    }, credentials: 'same-origin' });
    assert.equal(headerCalls, 0);
    await instance.generate(request());
    assert.equal(headerCalls, 1); assert.equal(headers.get('authorization'), 'Bearer gateway-session');
    for (const bad of [{ 'Content-Type': 'text/plain' }, { Cookie: 'SECRET' }, { Host: 'evil.example' }, { Authorization: 'x'.repeat(8193) }]) {
        let fetched = false;
        await assert.rejects(client(async () => { fetched = true; return response(); }, { getHeaders: () => bad }).generate(request()), error => error.code === 'unauthorized');
        assert.equal(fetched, false);
    }
});

for (const [status, code] of [[400, 'invalid-request'], [401, 'unauthorized'], [403, 'unauthorized'], [413, 'invalid-request'], [429, 'rate-limited'], [500, 'unavailable'], [503, 'unavailable']]) {
    test(`HTTP ${status} has a controlled ${code} error without provider body exposure`, async () => {
        await assert.rejects(client(async () => response([], { status, raw: 'PRIVATE_PROVIDER_BODY' })).generate(request()), error => error.code === code && !error.message.includes('PRIVATE'));
    });
}

for (const [name, result] of [
    ['wrong content type', () => response(good(), { type: 'text/html' })],
    ['malformed JSON', () => response([], { raw: '{private-provider-body}\n' })],
    ['missing terminal event', () => response([{ type: 'delta', text: 'Draft.' }])],
    ['extra events after completion', () => response([...good(), { type: 'delta', text: 'late' }])],
    ['unknown event fields', () => response([{ type: 'delta', text: 'Draft.', tool: 'execute' }, { type: 'done' }])],
    ['arbitrary error text', () => response([{ type: 'error', code: 'SECRET' }])],
    ['tool-call event', () => response([{ type: 'tool-call', command: 'execute' }])],
    ['empty completion', () => response([{ type: 'done' }])],
    ['control characters', () => response([{ type: 'delta', text: 'draft\u0000' }, { type: 'done' }])],
    ['unsafe model metadata', () => response([{ type: 'delta', text: 'Draft.' }, { type: 'done', model: 'secret\nmodel' }])],
    ['invalid UTF-8', () => response([], { raw: new Uint8Array([0xC3, 0x28]) })],
    ['redirected response', () => ({ ...response(), redirected: true })]
]) test(`AI stream rejects ${name}`, async () => {
    await assert.rejects(client(async () => result()).generate(request()), error => error.code === 'invalid-response' && !error.message.includes('SECRET'));
});

test('output budget is enforced in decoded UTF-8 bytes and no oversized delta reaches UI', async () => {
    let emitted = false;
    await assert.rejects(client(async () => response([{ type: 'delta', text: 'é'.repeat(MAX_AI_OUTPUT_BYTES / 2 + 1) }, { type: 'done' }], { chunkSize: 8192 })).generate(request(), { onDelta: () => { emitted = true; } }), error => error.code === 'invalid-response');
    assert.equal(emitted, false);
});

test('invalid input is rejected before a request; disposed external signal does not call fetch', async () => {
    let fetched = false;
    const instance = client(async () => { fetched = true; return response(); });
    assert.throws(() => instance.generate({ ...request(), patientName: 'secret' }), error => error.code === 'invalid-request');
    const abort = new AbortController(); abort.abort();
    await assert.rejects(instance.generate(request(), { signal: abort.signal }), error => error.code === 'cancelled');
    assert.equal(fetched, false);
});

test('one active job, cancellation and next request leave no response callback active', async () => {
    let resolveFetch, calls = 0, deltas = 0;
    const instance = client(async () => { calls++; return calls === 1 ? new Promise(resolve => { resolveFetch = resolve; }) : response(); });
    const abort = new AbortController(), running = instance.generate(request(), { signal: abort.signal, onDelta: () => deltas++ });
    await Promise.resolve();
    await assert.rejects(instance.generate(request()), error => error.code === 'busy');
    abort.abort();
    await assert.rejects(running, error => error.code === 'cancelled');
    resolveFetch(response()); await Promise.resolve();
    assert.equal(deltas, 0);
    assert.equal((await instance.generate(request())).text, '512 rows [E1].');
});

test('timeout covers stalled authorization and prevents a late callback from sending data', async () => {
    let resolveHeaders, fetched = false;
    const instance = client(async () => { fetched = true; return response(); }, { timeoutMs: 15, getHeaders: () => new Promise(resolve => { resolveHeaders = resolve; }) });
    await assert.rejects(instance.generate(request()), error => error.code === 'timeout');
    resolveHeaders({ Authorization: 'Bearer SECRET' }); await Promise.resolve();
    assert.equal(fetched, false);
});

test('timeout cancels and releases a stalled response reader without waiting forever', async () => {
    let cancelled = false, released = false;
    const instance = client(async () => ({ ok: true, status: 200, headers: new Headers({ 'content-type': 'application/x-ndjson' }), body: { getReader: () => ({
        read: () => new Promise(() => {}), cancel: () => { cancelled = true; return new Promise(() => {}); }, releaseLock: () => { released = true; }
    }) } }), { timeoutMs: 15 });
    await assert.rejects(instance.generate(request()), error => error.code === 'timeout');
    assert.equal(cancelled, true); assert.equal(released, true);
});

test('provider and host errors never expose arbitrary messages or arbitrary error codes', async () => {
    for (const providerError of [new Error('Bearer SECRET'), Object.assign(new Error('SECRET'), { code: 'PRIVATE_SECRET_CODE' }), Object.assign(new Error('SECRET'), { code: 'unauthorized' })]) {
        await assert.rejects(client(async () => { throw providerError; }).generate(request()), error => !error.message.includes('SECRET') && !error.code.includes('SECRET'));
    }
    await assert.rejects(client(async () => response([{ type: 'error', code: 'provider-error' }])).generate(request()), error => error.code === 'provider-error');
});


test('HTTP provider failures and timeouts preserve controlled error types without reading upstream diagnostics', async () => {
    for (const [status, code] of [[502, 'provider-error'], [504, 'timeout'], [503, 'unavailable'], [401, 'unauthorized'], [429, 'rate-limited']]) {
        let bodyRead = false;
        const instance = client(async () => ({ok: false, status, get body() { bodyRead = true; throw new Error('PRIVATE_PROVIDER_DIAGNOSTIC'); }}));
        await assert.rejects(instance.connectionTest(), error => error.code === code && !error.message.includes('PRIVATE'));
        assert.equal(bodyRead, false);
    }
});


test('configured model binding accompanies both operations and cannot be supplied or overridden by host headers', async () => {
    const requests = [];
    const instance = client(async (_url, options) => { requests.push(options); return response(); }, {model:'gpt-6.1-sol',getHeaders:()=>({'X-Easi-Ai-Model':'hidden-other-model',Authorization:'Bearer short-lived-gateway-fixture'})});
    await instance.connectionTest(); await instance.generate(request());
    assert.equal(requests.length,2);
    for (const options of requests) {
        assert.equal(options.headers.get('X-Easi-Ai-Model'),'gpt-6.1-sol');
        assert.equal(options.headers.get('Authorization'),'Bearer short-lived-gateway-fixture');
        assert.equal(JSON.parse(options.body).model,undefined);
    }
    const noModel = client(async (_url, options) => {assert.equal(options.headers.has('X-Easi-Ai-Model'),false);return response();}, {getHeaders:()=>({'X-Easi-Ai-Model':'hidden-other-model'})});
    await noModel.connectionTest();
});

test('a changed server profile requires refresh using a controlled error without upstream diagnostics', async () => {
    const instance = client(async()=>({ok:false,status:409,get body(){throw new Error('PRIVATE_DIAGNOSTICS');}}));
    await assert.rejects(instance.connectionTest(), error=>error.code==='configuration-changed'&&/Refresh the viewer/.test(error.message)&&!error.message.includes('PRIVATE'));
});


test('workflow tasks are explicitly host-enabled and the flag survives configuration normalization', () => {
    const input = {baseUrl: 'https://gateway.example/api/ai', workflows: true};
    assert.equal(normalizeAiConfiguration(input).workflows, true);
    assert.deepEqual(normalizeAiConfiguration(normalizeAiConfiguration(input)), normalizeAiConfiguration(input));
    assert.equal(normalizeAiConfiguration({baseUrl: input.baseUrl}).workflows, undefined);
    assert.throws(() => normalizeAiConfiguration({baseUrl: input.baseUrl, workflows: 'true'}), error => error.code === 'invalid-request');
});

test('local CT reading preferences are closed, detached and cannot change workflow request inputs', async () => {
    const input = { baseUrl: 'https://gateway.example/api/ai', workflowPreferences: { routineCt: 'blended' } };
    const configuration = normalizeAiConfiguration(input);
    input.workflowPreferences.routineCt = 'no-preference';
    assert.deepEqual(configuration.workflowPreferences, { routineCt: 'blended' });
    let sent;
    const instance = new AiClient(configuration, { fetchImpl: async (url, options) => {
        sent = JSON.parse(options.body); return jsonResponse({ version: 1, model: 'test-model', plan: workflowPlan() });
    } });
    await instance.planCommand('Set up this CT for routine review.');
    assert.deepEqual(Object.keys(sent), ['version', 'task', 'command']);
    assert.ok(!JSON.stringify(sent).includes('blended'));
    for (const preference of [{ routineCt: 'clinically-best' }, { routineCt: 'blended', sourceUrl: 'PRIVATE' }, {}, [], 'blended']) {
        assert.throws(() => normalizeAiConfiguration({ baseUrl: input.baseUrl, workflowPreferences: preference }), error => error.code === 'invalid-request');
    }
    let touched = false;
    const accessor = {}; Object.defineProperty(accessor, 'routineCt', { get() { touched = true; return 'blended'; } });
    assert.throws(() => normalizeAiConfiguration({ baseUrl: input.baseUrl, workflowPreferences: accessor }));
    assert.equal(touched, false);
});


test('AI sign-in is explicit same-origin presentation state and normalization stays idempotent', () => {
    const config = normalizeAiConfiguration({baseUrl: 'https://gateway.example/api/ai', signInUrl: '/api/ai/login'});
    assert.equal(config.signInUrl, 'https://gateway.example/api/ai/login');
    assert.deepEqual(normalizeAiConfiguration(config), config);
    assert.equal(normalizeAiSignInUrl('login', config.baseUrl), config.signInUrl);
    assert.equal(normalizeAiSignInUrl('/api/ai/login', 'http://127.0.0.1:5188/api/ai'), 'http://127.0.0.1:5188/api/ai/login');
    assert.equal(Object.hasOwn(normalizeAiConfiguration({baseUrl: config.baseUrl}), 'signInUrl'), false);
});

test('AI sign-in rejects unconfigured, off-origin, secret-bearing and executable login URLs', () => {
    const baseUrl = 'https://gateway.example/api/ai';
    for (const signInUrl of ['javascript:alert(1)', 'data:text/html,unsafe', 'https://other.example/login', 'https://user:secret@gateway.example/login',
        '/login?token=SECRET', '/login#SECRET', '/login\n', '', true, 42]) {
        assert.throws(() => normalizeAiConfiguration({baseUrl, signInUrl}), error => error.code === 'invalid-request' && !error.message.includes('SECRET'));
    }
    assert.throws(() => normalizeAiConfiguration({signInUrl: 'https://gateway.example/login'}));
    assert.throws(() => normalizeAiConfiguration({baseUrl: 'http://127.0.0.1:5188/api/ai', signInUrl: 'http://localhost:5188/api/ai/login'}));
});

test('sign-in configuration never enters AI requests or causes an automatic authentication request', async () => {
    const calls = [], configuration = normalizeAiConfiguration({baseUrl: 'https://gateway.example/api/ai', signInUrl: '/api/ai/login'});
    const instance = new AiClient(configuration, {fetchImpl: async (url, options) => { calls.push({url, body: JSON.parse(options.body)}); return jsonResponse({version: 1, model: 'test-model', plan: workflowPlan()}); }});
    assert.equal(calls.length, 0); await instance.planCommand('Use two panes.');
    assert.deepEqual(calls, [{url: configuration.baseUrl + '/plan', body: {version: 1, task: 'plan-workflow', command: 'Use two panes.'}}]);
});
