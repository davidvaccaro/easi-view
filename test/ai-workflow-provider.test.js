import test from 'node:test';
import assert from 'node:assert/strict';
import { createOpenAiProvider } from '../examples/ai-gateway/openai-provider.mjs';
import { createOpenAiWorkflowProvider } from '../examples/ai-gateway/openai-workflow-provider.mjs';
import { WORKFLOW_PLAN_SCHEMA } from '../src/ai/workflow-protocol.js';

const KEY = 'sk-test-private-0123456789';
const request = () => ({ version: 1, task: 'plan-workflow', command: 'Show current CT in lung and soft tissue windows.' });
const plan = () => ({ version: 1, status: 'ready', summary: 'Arrange two CT windows.', question: null, actions: [{ type: 'layout', count: 2 }] });
const audio = () => ({ version: 1, task: 'transcribe-command', mimeType: 'audio/webm;codecs=opus', audio: Buffer.from([0, 1, 2]).toString('base64') });
const answer = changes => ({ model: 'gpt-6.1-sol', status: 'completed', output: [{ type: 'function_call', name: 'submit_viewer_plan', arguments: JSON.stringify(plan()) }], error: null, incomplete_details: null, ...changes });
function response(body, { raw, status = 200, chunkSize = 13, type = 'application/json', cancelled = () => {} } = {}) {
    const bytes = raw instanceof Uint8Array ? raw : new TextEncoder().encode(raw ?? JSON.stringify(body)); let offset = 0;
    return { ok: status >= 200 && status < 300, status, headers: new Headers({ 'content-type': type }), body: new ReadableStream({
        pull(controller) { if (offset >= bytes.length) controller.close(); else controller.enqueue(bytes.subarray(offset, offset += chunkSize)); }, cancel: cancelled
    }) };
}
const provider = (fetchImpl = async () => response(answer()), settings = {}) => createOpenAiWorkflowProvider({ apiKey: KEY, fetchImpl, ...settings });
const turn = () => new Promise(resolve => setImmediate(resolve));

test('existing OpenAI provider exposes workflow methods without automatic inference', () => {
    let called = false; const instance = createOpenAiProvider({ apiKey: KEY, fetchImpl: async () => { called = true; return response(answer()); } });
    assert.equal(typeof instance.generate, 'function'); assert.equal(typeof instance.plan, 'function'); assert.equal(typeof instance.transcribe, 'function'); assert.equal(called, false);
});

test('planner submits one strict forced function and only the explicit command, never source data or credentials', async () => {
    let sent, receiver;
    const instance = provider(function (url, options) { receiver = this; sent = { url, options }; return Promise.resolve(response(answer())); });
    const result = await instance.plan(request());
    assert.deepEqual(result, { version: 1, model: 'gpt-6.1-sol', plan: plan() }); assert.equal(receiver, undefined);
    assert.equal(sent.url, 'https://api.openai.com/v1/responses'); assert.equal(sent.options.headers.Authorization, `Bearer ${KEY}`);
    assert.equal(sent.options.credentials, 'omit'); assert.equal(sent.options.redirect, 'error');
    const body = JSON.parse(sent.options.body);
    assert.equal(body.store, false); assert.equal(body.stream, false); assert.deepEqual(body.reasoning, { effort: 'low' }); assert.equal(body.max_output_tokens, 4096);
    assert.equal(body.parallel_tool_calls, false); assert.deepEqual(body.tool_choice, { type: 'function', name: 'submit_viewer_plan' });
    assert.equal(body.tools.length, 1); assert.equal(body.tools[0].strict, true); assert.deepEqual(body.tools[0].parameters, WORKFLOW_PLAN_SCHEMA);
    assert.deepEqual(body.input[1], { role: 'user', content: [{ type: 'input_text', text: request().command }] });
    assert.ok(!sent.options.body.includes(KEY)); assert.ok(!Object.hasOwn(body, 'temperature')); assert.ok(!Object.hasOwn(body, 'previous_response_id'));
});

test('planner receives the validated starting-mode instruction without source context or conversation history', async () => {
    const bodies = [];
    const instance = provider(async (url, options) => {bodies.push(JSON.parse(options.body));return response(answer());});
    await instance.plan({...request(), mode: 'fresh'});
    await instance.plan({...request(), mode: 'continue'});
    assert.match(bodies[0].input[0].content[0].text, /Request mode: NEW TASK FROM STUDY/u);
    assert.match(bodies[1].input[0].content[0].text, /Request mode: CONTINUE CURRENT VIEW/u);
    for (const body of bodies) {
        assert.equal(body.input.length, 2);
        assert.equal(body.input[1].content[0].text, request().command);
        assert.equal(body.store, false);
        assert.equal(Object.hasOwn(body, 'previous_response_id'), false);
    }
});

test('transcription sends only selected in-memory recording with an anonymous fixed filename and current ASR model', async () => {
    let sent;
    const result = await provider(async (url, options) => { sent = { url, options }; return response({ text: 'Show two panes.', languages: [{ code: 'en' }] }); }).transcribe(audio());
    assert.deepEqual(result, { version: 1, model: 'gpt-transcribe', text: 'Show two panes.' });
    assert.equal(sent.url, 'https://api.openai.com/v1/audio/transcriptions'); assert.equal(sent.options.headers.Authorization, `Bearer ${KEY}`);
    assert.equal(sent.options.headers['Content-Type'], undefined); assert.equal(sent.options.credentials, 'omit'); assert.equal(sent.options.redirect, 'error');
    assert.ok(sent.options.body instanceof FormData); assert.deepEqual([...sent.options.body.keys()], ['model', 'file']);
    assert.equal(sent.options.body.get('model'), 'gpt-transcribe'); const file = sent.options.body.get('file');
    assert.equal(file.name, 'command.webm'); assert.equal(file.type, 'audio/webm'); assert.deepEqual([...new Uint8Array(await file.arrayBuffer())], [0, 1, 2]);
});

test('input validation precedes lazy credentials and no catalog or arbitrary audio type is accepted', async () => {
    let loaded = false, fetched = false;
    const instance = createOpenAiWorkflowProvider({ getApiKey: async () => { loaded = true; return KEY; }, fetchImpl: async () => { fetched = true; return response(answer()); } });
    await assert.rejects(instance.plan({ ...request(), catalog: { patientName: 'PRIVATE' } }), error => error.code === 'invalid-request');
    await assert.rejects(instance.transcribe({ ...audio(), mimeType: 'application/dicom' }), error => error.code === 'invalid-request');
    assert.equal(loaded, false); assert.equal(fetched, false);
});

for (const [name, value] of [
    ['wrong model', answer({ model: 'different' })], ['incomplete', answer({ status: 'incomplete' })],
    ['truncation details', answer({ incomplete_details: { reason: 'max_output_tokens' } })], ['provider error', answer({ error: { message: 'PRIVATE' } })],
    ['no function', answer({ output: [] })], ['wrong function', answer({ output: [{ type: 'function_call', name: 'execute', arguments: '{}' }] })],
    ['multiple functions', answer({ output: [...answer().output, ...answer().output] })], ['malformed arguments', answer({ output: [{ ...answer().output[0], arguments: 'PRIVATE' }] })],
    ['unbounded action', answer({ output: [{ ...answer().output[0], arguments: JSON.stringify({ ...plan(), actions: [{ type: 'layout', count: 9 }] }) }] })],
    ['extra parameters', answer({ output: [{ ...answer().output[0], arguments: JSON.stringify({ ...plan(), script: 'PRIVATE' }) }] })],
    ['ordinary prose', answer({ output: [{ type: 'message', content: [{ type: 'output_text', text: 'do something' }] }] })]
]) test(`planner rejects ${name} without executing output`, async () => await assert.rejects(provider(async () => response(value)).plan(request()), error => error.code === 'invalid-response' && !error.message.includes('PRIVATE')));

test('planner refuses unsupported/refusal output and returns typed clarify/unsupported plans without actions', async () => {
    await assert.rejects(provider(async () => response(answer({ output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'PRIVATE' }] }] }))).plan(request()), error => error.code === 'provider-error');
    for (const status of ['clarify', 'unsupported']) {
        const value = { version: 1, status, summary: 'Needs selection.', question: status === 'clarify' ? 'Which study?' : null, actions: [] };
        const result = await provider(async () => response(answer({ output: [{ ...answer().output[0], arguments: JSON.stringify(value) }] }))).plan(request());
        assert.deepEqual(result.plan, value);
    }
});

test('transcription rejects empty/overlong/unsafe text and wrong explicit model provenance', async () => {
    for (const value of [{ text: '' }, { text: 'x'.repeat(1201) }, { text: '\u0000PRIVATE' }, { text: 'Show CT.', model: 'different' }]) {
        await assert.rejects(provider(async () => response(value)).transcribe(audio()), error => error.code === 'invalid-response');
    }
});

for (const operation of ['plan', 'transcribe']) test(`${operation} has a bounded deadline covering credentials and no late request`, async () => {
    let resolve, fetched = false;
    const instance = createOpenAiWorkflowProvider({ timeoutMs: 15, getApiKey: () => new Promise(value => { resolve = value; }), fetchImpl: async () => { fetched = true; return response(answer()); } });
    await assert.rejects(instance[operation](operation === 'plan' ? request() : audio()), error => error.code === 'timeout' && error.aiDiagnostic === 'provider-timeout');
    resolve(KEY); await turn(); assert.equal(fetched, false);
});

test('caller cancellation releases a blocked JSON reader and ignores uncooperative late completion', async () => {
    let entered, cancelled = false, released = false; const ready = new Promise(resolve => { entered = resolve; }), abort = new AbortController();
    const instance = provider(async () => ({ ok: true, headers: new Headers({ 'content-type': 'application/json' }), body: { getReader: () => ({
        read: () => { entered(); return new Promise(() => {}); }, cancel: () => { cancelled = true; }, releaseLock: () => { released = true; }
    }) } }));
    const operation = instance.plan(request(), { signal: abort.signal }); await ready; abort.abort(new Error('PRIVATE'));
    await assert.rejects(operation, error => error.code === 'unavailable' && !error.message.includes('PRIVATE')); assert.equal(cancelled, true); assert.equal(released, true);
});

test('transport bounds and fixed error diagnostics apply without upstream messages reaching the caller', async () => {
    for (const [status, code, diagnostic] of [[401, 'provider-error', 'provider-unauthorized'], [429, 'rate-limited', 'provider-rate-limited'], [500, 'provider-error', 'provider-failure']]) {
        await assert.rejects(provider(async () => response(null, { status, raw: 'PRIVATE' })).plan(request()), error => error.code === code && error.aiDiagnostic === diagnostic && !error.message.includes('PRIVATE'));
    }
    await assert.rejects(provider(async () => response(null, { raw: 'x'.repeat(128 * 1024 + 1) })).plan(request()), error => error.code === 'invalid-response');
    await assert.rejects(provider(async () => response(null, { raw: new Uint8Array([0xC3, 0x28]) })).plan(request()), error => error.code === 'invalid-response');
    await assert.rejects(provider(async () => response(answer(), { type: 'text/html' })).plan(request()), error => error.code === 'invalid-response');
});
