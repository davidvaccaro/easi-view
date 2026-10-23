import test from 'node:test';
import assert from 'node:assert/strict';
import { createOpenAiProvider, DEFAULT_OPENAI_MODEL } from '../examples/ai-gateway/openai-provider.mjs';
import { MAX_AI_OUTPUT_BYTES } from '../src/ai/protocol.js';

const API_KEY = 'sk-fixture-private-0123456789';
const request = () => ({ version: 1, task: 'explain-series', facts: [{ id: 'E1', code: 'rows', value: 512 }] });
const testRequest = () => ({ version: 1, task: 'connection-test', facts: [] });
const message = text => ({ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] });
const completed = (text = '512 rows [E1].', options = {}) => ({ type: 'response.completed', response: { model: DEFAULT_OPENAI_MODEL, status: 'completed',
    output: [message(text)], error: null, incomplete_details: null, ...options } });
const events = (text = '512 rows [E1].') => [
    { type: 'response.created', response: { model: DEFAULT_OPENAI_MODEL, status: 'in_progress', output: [], error: null, incomplete_details: null } },
    { type: 'response.output_item.added', item: { type: 'message', role: 'assistant', status: 'in_progress', content: [] } },
    { type: 'response.content_part.added', part: { type: 'output_text', text: '', annotations: [] } },
    { type: 'response.output_text.delta', delta: text }, { type: 'response.output_text.done', text },
    { type: 'response.content_part.done', part: { type: 'output_text', text, annotations: [] } },
    { type: 'response.output_item.done', item: message(text) }, completed(text)
];
const encode = values => values.map(value => `event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`).join('');
function response(values = events(), { chunkSize = 17, raw, status = 200, type = 'text/event-stream; charset=utf-8', cancel = () => {}, headers = {} } = {}) {
    const bytes = raw instanceof Uint8Array ? raw : new TextEncoder().encode(raw ?? encode(values));
    let offset = 0;
    return { ok: status >= 200 && status < 300, status, headers: new Headers({ 'content-type': type, ...headers }), body: new ReadableStream({
        pull(controller) { if (offset >= bytes.length) controller.close(); else controller.enqueue(bytes.subarray(offset, offset += chunkSize)); }, cancel
    }) };
}
const provider = (fetchImpl = async () => response(), options = {}) => createOpenAiProvider({ apiKey: API_KEY, fetchImpl, ...options });
const collect = async iterable => { let text = ''; for await (const delta of iterable) text += delta; return text; };
const turn = () => new Promise(resolve => setImmediate(resolve));

test('OpenAI connector is inert until explicit generation and its serializable state contains no credential', async () => {
    let calls = 0;
    const instance = provider(async () => { calls++; return response(); });
    assert.equal(calls, 0); assert.equal(instance.model, DEFAULT_OPENAI_MODEL);
    assert.equal(DEFAULT_OPENAI_MODEL, 'gpt-6.1-sol'); assert.ok(!JSON.stringify(instance).includes(API_KEY));
    assert.equal(await collect(instance.generate(request())), '512 rows [E1].'); assert.equal(calls, 1);
});

test('Responses request uses a fixed origin, server-only key, controlled input and explicit storage/tool/reasoning policy', async () => {
    let captured;
    const instance = provider(async (url, options) => { captured = { url, options }; return response(); });
    await collect(instance.generate(request()));
    assert.equal(captured.url, 'https://api.openai.com/v1/responses');
    assert.equal(captured.options.method, 'POST'); assert.equal(captured.options.redirect, 'error'); assert.equal(captured.options.credentials, 'omit');
    assert.equal(captured.options.cache, 'no-store'); assert.equal(captured.options.referrerPolicy, 'no-referrer');
    assert.equal(captured.options.headers.Authorization, `Bearer ${API_KEY}`); assert.equal(captured.options.headers.Accept, 'text/event-stream');
    const body = JSON.parse(captured.options.body);
    assert.equal(body.model, DEFAULT_OPENAI_MODEL); assert.equal(body.store, false); assert.equal(body.stream, true);
    assert.deepEqual(body.reasoning, { effort: 'low' }); assert.equal(body.max_output_tokens, 4096); assert.deepEqual(body.tools, []);
    assert.equal(body.truncation, 'disabled'); assert.deepEqual(body.text, { format: { type: 'text' }, verbosity: 'low' });
    assert.deepEqual(body.input.map(item => item.role), ['developer', 'user']);
    assert.ok(body.input.every(item => item.content.every(part => part.type === 'input_text')));
    assert.match(body.input[1].content[0].text, /Task: explain-series\nAllowlisted facts:\n\[E1\] Image rows: 512/);
    assert.ok(!captured.options.body.includes(API_KEY)); assert.ok(!captured.options.body.includes('Bearer'));
    for (const key of ['temperature', 'previous_response_id', 'conversation', 'metadata', 'user', 'background']) assert.ok(!Object.hasOwn(body, key));
});

test('connection testing sends only a fixed synthetic task and uses a bounded reasoning-inclusive token allowance', async () => {
    let body;
    const instance = provider(async (_, options) => { body = JSON.parse(options.body); return response(events('EASI View AI connection is ready.')); });
    assert.equal(await collect(instance.generate(testRequest())), 'EASI View AI connection is ready.');
    assert.equal(body.max_output_tokens, 1024); assert.match(body.input[1].content[0].text, /No medical data/);
    assert.ok(!JSON.stringify(body).includes('Image rows'));
});

test('measurement summary preserves exact supplied values, opaque groups and units', async () => {
    let body;
    const input = { version: 1, task: 'summarize-measurements', facts: [
        { id: 'E1', code: 'measurement-kind', value: 'length', group: 'M1' },
        { id: 'E2', code: 'value', value: 27.5, unit: 'mm', group: 'M1' },
        { id: 'E3', code: 'calibration', value: 'physical', group: 'M1' }
    ] };
    await collect(provider(async (_, options) => { body = JSON.parse(options.body); return response(events('27.5 mm [E2].')); }).generate(input));
    assert.match(body.input[1].content[0].text, /\[E2\] M1 · Viewer-computed measurement: 27.5 mm/);
});

test('SSE parser handles every UTF-8, CRLF and token boundary plus comments and optional DONE sentinel', async () => {
    const wire = `: heartbeat\r\nid: event-1\r\n${encode(events('A café [E1].')).replaceAll('\n', '\r\n')}data: [DONE]\r\n\r\n`;
    assert.equal(await collect(provider(async () => response([], { raw: wire, chunkSize: 1 })).generate(request())), 'A café [E1].');
});

test('SSE multiline data and final CR-only separators preserve one exact draft', async () => {
    const wire = events().map(value => `event: ${value.type}\r${JSON.stringify(value, null, 2).split('\n').map(line => `data: ${line}`).join('\r')}\r\r`).join('');
    assert.equal(await collect(provider(async () => response([], { raw: wire, chunkSize: 3 })).generate(request())), '512 rows [E1].');
});

test('reasoning events and encrypted/internal reasoning items never become viewer text', async () => {
    const values = events(); values.splice(1, 0,
        { type: 'response.output_item.added', item: { type: 'reasoning', summary: [] } },
        { type: 'response.reasoning_summary_text.delta', delta: 'PRIVATE_REASONING' },
        { type: 'response.output_item.done', item: { type: 'reasoning', summary: [] } });
    values.at(-1).response.output.unshift({ type: 'reasoning', summary: [] });
    assert.equal(await collect(provider(async () => response(values)).generate(request())), '512 rows [E1].');
});

test('wire validation rejects patient metadata, raw data, arbitrary instructions and malformed requests before credentials or fetch', async () => {
    let loaded = false, fetched = false;
    const instance = createOpenAiProvider({ getApiKey: async () => { loaded = true; return API_KEY; }, fetchImpl: async () => { fetched = true; return response(); } });
    for (const input of [{ ...request(), patientName: 'PRIVATE_PATIENT' }, { ...request(), task: 'Diagnose this patient' },
        { ...request(), facts: [{ id: 'E1', code: 'rows', value: 'PRIVATE' }] }, { ...request(), pixels: [1, 2] }]) {
        await assert.rejects(collect(instance.generate(input)), error => error.code === 'invalid-request' && !error.message.includes('PRIVATE'));
    }
    assert.equal(loaded, false); assert.equal(fetched, false);
});

test('credential loader is lazy, receives cancellation and places its secret only in the upstream authorization header', async () => {
    let loaded = 0, authorization;
    const instance = createOpenAiProvider({ getApiKey: async ({ signal }) => { assert.equal(signal.aborted, false); loaded++; return API_KEY; },
        fetchImpl: async (_, options) => { authorization = options.headers.Authorization; return response(); } });
    assert.equal(loaded, 0); await collect(instance.generate(request()));
    assert.equal(loaded, 1); assert.equal(authorization, `Bearer ${API_KEY}`); assert.ok(!JSON.stringify(instance).includes(API_KEY));
});

test('credential loading is included in timeout and late credentials cannot initiate a request', async () => {
    let resolveKey, fetched = false, loaderSignal;
    const instance = createOpenAiProvider({ timeoutMs: 15, getApiKey: ({ signal }) => { loaderSignal = signal; return new Promise(resolve => { resolveKey = resolve; }); },
        fetchImpl: async () => { fetched = true; return response(); } });
    await assert.rejects(collect(instance.generate(request())), error => error.code === 'timeout' && error.aiDiagnostic === 'provider-timeout');
    assert.equal(loaderSignal.aborted, true); resolveKey(API_KEY); await turn(); assert.equal(fetched, false);
});

test('external cancellation during credential loading prevents a late request and does not expose its reason', async () => {
    let resolveKey, fetched = false;
    const signal = new AbortController(), instance = createOpenAiProvider({ getApiKey: () => new Promise(resolve => { resolveKey = resolve; }),
        fetchImpl: async () => { fetched = true; return response(); } });
    const running = collect(instance.generate(request(), { signal: signal.signal })); signal.abort(new Error('PRIVATE_REASON'));
    await assert.rejects(running, error => error.code === 'unavailable' && !error.message.includes('PRIVATE'));
    resolveKey(API_KEY); await turn(); assert.equal(fetched, false);
});

test('invalid secret-loader output and secret errors are controlled and never sent or echoed', async () => {
    for (const value of [null, 'PRIVATE', 'bad\nPRIVATE_KEY', {}]) {
        let fetched = false;
        const instance = createOpenAiProvider({ getApiKey: async () => value, fetchImpl: async () => { fetched = true; return response(); } });
        await assert.rejects(collect(instance.generate(request())), error => error.code === 'provider-error' && !error.message.includes('PRIVATE'));
        assert.equal(fetched, false);
    }
    const failed = createOpenAiProvider({ getApiKey: async () => { throw Object.assign(new Error('PRIVATE_SECRET_ERROR'), { code: 'PRIVATE_SECRET_CODE', aiDiagnostic: 'PRIVATE_DIAGNOSTIC' }); } });
    await assert.rejects(collect(failed.generate(request())), error => error.code === 'provider-error' && error.aiDiagnostic === 'provider-failure' && !error.message.includes('PRIVATE'));
});

test('fixed server secret diagnostics survive credential loading while messages and arbitrary data remain redacted', async () => {
    for (const diagnostic of ['secret-access-denied', 'secret-timeout', 'secret-invalid', 'secret-unavailable']) {
        let fetched = false;
        const instance = createOpenAiProvider({ getApiKey: async () => { throw Object.assign(new Error('PRIVATE_SECRET_VALUE'), {
            code: diagnostic === 'secret-timeout' ? 'timeout' : 'unavailable', aiDiagnostic: diagnostic, headers: { Authorization: API_KEY }, requestId: 'PRIVATE_REQUEST'
        }); }, fetchImpl: async () => { fetched = true; return response(); } });
        await assert.rejects(collect(instance.generate(request())), error => error.aiDiagnostic === diagnostic &&
            !error.message.includes('PRIVATE') && !Object.hasOwn(error, 'headers') && !Object.hasOwn(error, 'requestId') && !JSON.stringify(error).includes(API_KEY));
        assert.equal(fetched, false);
    }
});

for (const [status, code, diagnostic] of [[401, 'provider-error', 'provider-unauthorized'], [403, 'provider-error', 'provider-unauthorized'],
    [429, 'rate-limited', 'provider-rate-limited'], [400, 'provider-error', 'provider-failure'], [500, 'provider-error', 'provider-failure'], [503, 'provider-error', 'provider-failure']]) {
    test(`OpenAI HTTP ${status} yields fixed ${code}/${diagnostic} without response-body exposure`, async () => {
        await assert.rejects(collect(provider(async () => response([], { status, raw: 'PRIVATE_UPSTREAM_MESSAGE' })).generate(request())),
            error => error.code === code && error.aiDiagnostic === diagnostic && !error.message.includes('PRIVATE'));
    });
}

for (const [name, result, code = 'invalid-response'] of [
    ['wrong content type', () => response([], { type: 'application/json' })],
    ['redirected response', () => ({ ...response(), redirected: true })],
    ['non-JSON SSE data', () => response([], { raw: 'data: PRIVATE\n\n' })],
    ['mismatched event name', () => response([], { raw: 'event: response.completed\ndata: {"type":"response.output_text.delta","delta":"text"}\n\n' })],
    ['missing completion', () => response(events().slice(0, -1))],
    ['DONE without completion', () => response([], { raw: 'data: [DONE]\n\n' })],
    ['extra event after completion', () => response([...events(), { type: 'response.output_text.delta', delta: 'extra' }])],
    ['different created model', () => response([{ type: 'response.created', response: { model: 'different-model' } }, ...events()])],
    ['different completed model', () => response([...events().slice(0, -1), completed(undefined, { model: 'different-model' })])],
    ['incomplete terminal status', () => response([...events().slice(0, -1), completed(undefined, { status: 'incomplete' })])],
    ['hidden incomplete details', () => response([...events().slice(0, -1), completed(undefined, { incomplete_details: { reason: 'max_output_tokens' } })])],
    ['changed final text', () => response([...events().slice(0, -1), completed('Different final text')])],
    ['unsafe delta control characters', () => response([{ type: 'response.output_text.delta', delta: 'text\u0000' }])],
    ['invalid UTF-8', () => response([], { raw: new Uint8Array([0xC3, 0x28]) })],
    ['tool-call output', () => response([{ type: 'response.output_item.added', item: { type: 'function_call', name: 'execute' } }])],
    ['unknown event type', () => response([{ type: 'private-event', message: 'PRIVATE' }])],
    ['refusal delta', () => response([{ type: 'response.refusal.delta', delta: 'PRIVATE_REFUSAL' }]), 'provider-error'],
    ['refusal completed content', () => response([...events().slice(0, -1), completed(undefined, { output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'refusal', refusal: 'PRIVATE' }] }] })]), 'provider-error'],
    ['incomplete event', () => response([{ type: 'response.incomplete', response: { incomplete_details: { reason: 'max_output_tokens' } } }]), 'provider-error'],
    ['provider failed event', () => response([{ type: 'response.failed', response: { error: { code: 'server_error', message: 'PRIVATE' } } }]), 'provider-error'],
    ['provider error event', () => response([{ type: 'error', code: 'server_error', message: 'PRIVATE' }]), 'provider-error']
]) test(`OpenAI SSE rejects ${name}`, async () => {
    await assert.rejects(collect(provider(async () => result()).generate(request())), error => error.code === code && !error.message.includes('PRIVATE'));
});

test('error events map provider authentication and quota failures to distinct safe diagnostics', async () => {
    for (const [upstream, code, diagnostic] of [['invalid_api_key', 'provider-error', 'provider-unauthorized'], ['insufficient_quota', 'rate-limited', 'provider-rate-limited']]) {
        await assert.rejects(collect(provider(async () => response([{ type: 'error', code: upstream, message: API_KEY }])).generate(request())),
            error => error.code === code && error.aiDiagnostic === diagnostic && !error.message.includes(API_KEY));
    }
});

test('wire and draft budgets reject oversized UTF-8 data before an oversized delta reaches the consumer', async () => {
    let deltas = 0;
    const wire = response([{ type: 'response.output_text.delta', delta: 'é'.repeat(MAX_AI_OUTPUT_BYTES / 2 + 1) }], { chunkSize: 8192 });
    await assert.rejects(async () => { for await (const delta of provider(async () => wire).generate(request())) deltas++; }, error => error.code === 'invalid-response');
    assert.equal(deltas, 0);
    await assert.rejects(collect(provider(async () => response([], { headers: { 'content-length': '65537' } })).generate(request())), error => error.code === 'invalid-response');
});

test('deadline cancels and releases a stalled upstream reader without waiting indefinitely', async () => {
    let cancelled = false, released = false, upstreamSignal;
    const instance = provider(async (_, options) => { upstreamSignal = options.signal; return { ok: true, headers: new Headers({ 'content-type': 'text/event-stream' }), body: { getReader: () => ({
        read: () => new Promise(() => {}), cancel: () => { cancelled = true; return new Promise(() => {}); }, releaseLock: () => { released = true; }
    }) } }; }, { timeoutMs: 15 });
    await assert.rejects(collect(instance.generate(request())), error => error.code === 'timeout' && error.aiDiagnostic === 'provider-timeout');
    assert.equal(upstreamSignal.aborted, true); assert.equal(cancelled, true); assert.equal(released, true);
});

test('deadline covers stalled fetch headers and cancels an uncooperative late response body', async () => {
    let resolveFetch, cancelled = false, upstreamSignal;
    const instance = provider(async (_, options) => { upstreamSignal = options.signal; return new Promise(resolve => { resolveFetch = resolve; }); }, { timeoutMs: 15 });
    await assert.rejects(collect(instance.generate(request())), error => error.code === 'timeout');
    assert.equal(upstreamSignal.aborted, true);
    resolveFetch({ body: { cancel: async () => { cancelled = true; } } }); await turn(); assert.equal(cancelled, true);
});

test('external cancellation during a blocked upstream read aborts promptly and releases ownership', async () => {
    let started, cancelled = false, released = false;
    const ready = new Promise(resolve => { started = resolve; }), signal = new AbortController();
    const instance = provider(async () => ({ ok: true, headers: new Headers({ 'content-type': 'text/event-stream' }), body: { getReader: () => ({
        read: () => { started(); return new Promise(() => {}); }, cancel: () => { cancelled = true; }, releaseLock: () => { released = true; }
    }) } }));
    const running = collect(instance.generate(request(), { signal: signal.signal })); await ready; signal.abort();
    await assert.rejects(running, error => error.code === 'unavailable'); assert.equal(cancelled, true); assert.equal(released, true);
});

test('caller cancellation and early consumer return abort the upstream request and release its reader', async () => {
    let cancelled = false, released = false, upstreamSignal;
    const encoded = new TextEncoder().encode(encode([{ type: 'response.output_text.delta', delta: 'Partial draft' }]));
    let read = false;
    const instance = provider(async (_, options) => { upstreamSignal = options.signal; return { ok: true, headers: new Headers({ 'content-type': 'text/event-stream' }), body: { getReader: () => ({
        read: async () => read ? new Promise(() => {}) : (read = true, { done: false, value: encoded }),
        cancel: () => { cancelled = true; }, releaseLock: () => { released = true; }
    }) } }; });
    const iterator = instance.generate(request()); assert.equal((await iterator.next()).value, 'Partial draft');
    await iterator.return(); assert.equal(upstreamSignal.aborted, true); assert.equal(cancelled, true); assert.equal(released, true);
});

test('pre-cancelled generation does not read credentials or call the network', async () => {
    let loaded = false, fetched = false;
    const signal = new AbortController(); signal.abort();
    const instance = createOpenAiProvider({ getApiKey: async () => { loaded = true; return API_KEY; }, fetchImpl: async () => { fetched = true; return response(); } });
    await assert.rejects(collect(instance.generate(request(), { signal: signal.signal })), error => error.code === 'unavailable');
    assert.equal(loaded, false); assert.equal(fetched, false);
});

test('constructor validation and thrown transport errors do not expose credentials or arbitrary diagnostics', async () => {
    for (const config of [{}, { apiKey: 'PRIVATE' }, { apiKey: API_KEY, getApiKey: async () => API_KEY }, { apiKey: API_KEY, modelId: 'https://PRIVATE' }, { apiKey: API_KEY, timeoutMs: 60000 }]) {
        assert.throws(() => createOpenAiProvider(config), error => !error.message.includes('PRIVATE'));
    }
    await assert.rejects(collect(provider(async () => { throw Object.assign(new Error(API_KEY), { code: 'PRIVATE_CODE', aiDiagnostic: API_KEY }); }).generate(request())),
        error => error.code === 'provider-error' && error.aiDiagnostic === 'provider-failure' && !error.message.includes(API_KEY));
});
