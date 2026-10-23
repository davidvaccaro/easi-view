import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { AiGateway, aiRequestByteLimit } from '../examples/ai-gateway/gateway.mjs';
import { createAiServer } from '../examples/ai-gateway/server.mjs';
import { aiError } from '../src/ai/protocol.js';
import { MAX_TRANSCRIPTION_REQUEST_BYTES } from '../src/ai/workflow-protocol.js';

const passcode = 'synthetic-workflow-invitation-0123456789', origin = 'https://synthetic.invalid', model = 'gpt-6.1-sol';
const planRequest = () => ({ version: 1, task: 'plan-workflow', command: 'Show this CT in lung and soft tissue windows.' });
const audioRequest = (bytes = 3) => ({ version: 1, task: 'transcribe-command', mimeType: 'audio/webm', audio: Buffer.alloc(bytes).toString('base64') });
const planResponse = () => ({ version: 1, model, plan: { version: 1, status: 'ready', summary: 'Arrange two panes.', question: null, actions: [{ type: 'layout', count: 2 }] } });
const audioResponse = () => ({ version: 1, model: 'gpt-transcribe', text: 'Show two panes.' });
function fixture(settings = {}) {
    const calls = [], diagnostics = [];
    const provider = { model, async *generate(request) { calls.push({ type: 'generate', request }); yield 'Ready.'; },
        async plan(request, { signal }) { calls.push({ type: 'plan', request, signal }); return planResponse(); },
        async transcribe(request, { signal }) { calls.push({ type: 'transcribe', request, signal }); return audioResponse(); } };
    const gateway = new AiGateway({ provider, passcode, allowedOrigins: [origin], requireModelBinding: true, logger: entry => diagnostics.push(entry), ...settings });
    const invoke = (path, input, headers = {}, options = {}) => gateway.handle({ method: 'POST', path: `/api/ai/${path}`, headers: {
        origin, 'content-type': 'application/json', 'x-easi-ai-model': model, ...headers
    }, body: JSON.stringify(input), ip: '192.0.2.8', ...options });
    return { gateway, provider, calls, diagnostics, invoke, async login() { const result = await invoke('login', { passcode }); assert.equal(result.status, 200); return result.headers['Set-Cookie'].split(';')[0]; } };
}

for (const route of ['plan', 'transcribe']) test(`${route} requires origin, session and reviewed planner model before any provider operation`, async () => {
    const f = fixture(), input = route === 'plan' ? planRequest() : audioRequest();
    assert.equal((await f.invoke(route, input)).status, 401); const cookie = await f.login();
    assert.equal((await f.invoke(route, input, { cookie, origin: 'https://other.invalid' })).status, 401);
    assert.equal((await f.invoke(route, input, { cookie, 'x-easi-ai-model': 'different' })).status, 409);
    assert.equal((await f.invoke(route, input, { cookie, 'x-easi-ai-model': undefined })).status, 409);
    assert.equal(f.calls.length, 0);
});

test('workflow endpoints return bounded JSON envelopes and share the existing authenticated quota', async () => {
    const f = fixture({ dailyLimit: 2 }), cookie = await f.login();
    const plan = await f.invoke('plan', planRequest(), { cookie }); assert.equal(plan.status, 200);
    assert.match(plan.headers['Content-Type'], /application\/json/); assert.equal(plan.headers['Cache-Control'], 'no-store');
    assert.deepEqual(JSON.parse(plan.body), planResponse());
    const transcript = await f.invoke('transcribe', audioRequest(), { cookie }); assert.equal(transcript.status, 200);
    assert.deepEqual(JSON.parse(transcript.body), audioResponse());
    assert.deepEqual(f.calls.map(call => call.type), ['plan', 'transcribe']);
    assert.equal((await f.invoke('plan', planRequest(), { cookie })).status, 429);
    assert.equal(f.gateway.active, 0); assert.equal(f.calls.length, 2);
});

test('workflow request schemas reject catalog data, route mismatches and malformed audio before spending quota', async () => {
    let quotaCalls = 0; const f = fixture({ quota: { async consume() { quotaCalls++; return true; } } }), cookie = await f.login(); quotaCalls = 0;
    for (const [route, input] of [['plan', { ...planRequest(), catalog: { patientName: 'PRIVATE' } }], ['plan', audioRequest()],
        ['transcribe', planRequest()], ['transcribe', { ...audioRequest(), mimeType: 'application/dicom' }], ['transcribe', { ...audioRequest(), audio: 'AB==' }]]) {
        const result = await f.invoke(route, input, { cookie }); assert.equal(result.status, 400); assert.ok(!result.body.includes('PRIVATE'));
    }
    assert.equal(quotaCalls, 0); assert.equal(f.calls.length, 0);
});

test('unsupported provider capabilities fail before inference quota or key loading', async () => {
    let quotaCalls = 0; const f = fixture({ quota: { async consume() { quotaCalls++; return true; } } });
    delete f.provider.plan; const cookie = await f.login(); quotaCalls = 0;
    assert.equal((await f.invoke('plan', planRequest(), { cookie })).status, 503); assert.equal(quotaCalls, 0); assert.equal(f.calls.length, 0);
});

test('provider-controlled plans and transcripts are validated again at the gateway boundary', async () => {
    const f = fixture(), cookie = await f.login();
    f.provider.plan = async () => ({ ...planResponse(), model: 'different' });
    let result = await f.invoke('plan', planRequest(), { cookie }); assert.equal(result.status, 502); assert.equal(JSON.parse(result.body).code, 'invalid-response');
    f.provider.plan = async () => ({ ...planResponse(), plan: { ...planResponse().plan, actions: [{ type: 'execute', script: 'PRIVATE' }] } });
    result = await f.invoke('plan', planRequest(), { cookie }); assert.equal(result.status, 502); assert.ok(!result.body.includes('PRIVATE'));
    f.provider.transcribe = async () => ({ ...audioResponse(), model: 'gpt-4o-mini-transcribe' });
    result = await f.invoke('transcribe', audioRequest(), { cookie }); assert.equal(result.status, 502);
    assert.equal(f.gateway.active, 0);
});

test('workflow provider failures log only fixed diagnostic enums and never command, transcript, audio or secrets', async () => {
    const f = fixture(), cookie = await f.login();
    f.provider.plan = async () => { throw Object.assign(new Error('PRIVATE_KEY_AND_COMMAND'), { code: 'PRIVATE_CODE', aiDiagnostic: 'PRIVATE_DIAGNOSTIC', headers: { Authorization: 'PRIVATE' } }); };
    const result = await f.invoke('plan', { ...planRequest(), command: 'PRIVATE_COMMAND' }, { cookie });
    assert.equal(result.status, 502); assert.deepEqual(f.diagnostics, [{ event: 'provider-failed', category: 'provider-failure', code: 'unavailable' }]);
    assert.ok(!JSON.stringify(f.diagnostics).includes('PRIVATE')); assert.ok(!result.body.includes('PRIVATE'));
});

test('in-flight workflow cancellation releases concurrency and ignores a late provider result', async () => {
    let started, finish; const ready = new Promise(resolve => { started = resolve; });
    const f = fixture({ maxConcurrent: 1 }), cookie = await f.login(), abort = new AbortController();
    f.provider.plan = (input, { signal }) => { started(signal); return new Promise(resolve => { finish = resolve; }); };
    const running = f.invoke('plan', planRequest(), { cookie }, { signal: abort.signal }); const providerSignal = await ready;
    assert.equal(f.gateway.active, 1); assert.equal((await f.invoke('transcribe', audioRequest(), { cookie })).status, 429);
    abort.abort(aiError('unavailable')); const result = await running;
    assert.equal(result.status, 503); assert.equal(providerSignal.aborted, true); assert.equal(f.gateway.active, 0);
    finish(planResponse()); await Promise.resolve(); assert.equal(f.gateway.active, 0);
    assert.equal((await f.invoke('transcribe', audioRequest(), { cookie })).status, 200);
});

test('edge origin authentication protects new endpoints and does not permit arbitrary cross-origin audio', async () => {
    const secret = 'synthetic-edge-secret-0123456789', f = fixture({ originSecret: secret, allowedOrigins: [] });
    const cookie = f.gateway.sessions.cookie(f.gateway.sessions.issue()).split(';')[0];
    assert.equal((await f.invoke('transcribe', audioRequest(), { cookie })).status, 401);
    assert.equal((await f.invoke('plan', planRequest(), { cookie, 'x-easi-origin-auth': secret, 'x-easi-public-origin': 'https://other.invalid' })).status, 401);
    assert.equal(f.calls.length, 0);
});

test('route-specific request caps preserve all existing 32-KiB limits and widen only transcription', () => {
    assert.equal(aiRequestByteLimit('/api/ai/transcribe'), MAX_TRANSCRIPTION_REQUEST_BYTES);
    for (const path of ['/api/ai/plan', '/api/ai/test', '/api/ai/generate', '/api/ai/login', '/other', '/api/ai/transcribe/']) assert.equal(aiRequestByteLimit(path), 32768);
});

test('standalone service admits bounded audio larger than the old cap and still limits other routes', async t => {
    const f = fixture(), server = createAiServer({ gateway: f.gateway }); server.listen(0, '127.0.0.1'); await once(server, 'listening');
    t.after(() => server.close()); const base = `http://127.0.0.1:${server.address().port}`;
    const common = { origin, 'content-type': 'application/json', 'x-easi-ai-model': model };
    const signed = await fetch(`${base}/api/ai/login`, { method: 'POST', headers: common, body: JSON.stringify({ passcode }) });
    const cookie = signed.headers.get('set-cookie').split(';')[0], headers = { ...common, cookie };
    const transcription = await fetch(`${base}/api/ai/transcribe`, { method: 'POST', headers, body: JSON.stringify(audioRequest(32000)) });
    assert.equal(transcription.status, 200); assert.deepEqual(await transcription.json(), audioResponse());
    const oversizedPlan = await fetch(`${base}/api/ai/plan`, { method: 'POST', headers, body: 'x'.repeat(33000) }); assert.equal(oversizedPlan.status, 413);
    const oversizedAudio = await fetch(`${base}/api/ai/transcribe`, { method: 'POST', headers, body: 'x'.repeat(MAX_TRANSCRIPTION_REQUEST_BYTES + 1) }); assert.equal(oversizedAudio.status, 413);
});
