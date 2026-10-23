import test from 'node:test';
import assert from 'node:assert/strict';
import { AiController } from '../src/ai/AiController.js';

const request = () => ({ version: 1, task: 'explain-series', facts: [{ id: 'E1', code: 'rows', value: 512 }] });
const prepared = (changes = {}) => ({ request: request(), contextKey: 'opaque-frame-A', revision: 1, ...changes });
function fixture() {
    const jobs = [], states = [];
    const client = { generate(input, options) { return new Promise((resolve, reject) => jobs.push({ input, options, resolve, reject })); },
        connectionTest(options) { return new Promise((resolve, reject) => jobs.push({ options, resolve, reject, test: true })); } };
    return { client, jobs, states, controller: new AiController({ client, onChange: state => states.push(state) }) };
}

test('controller is inert until an explicit request and preparation detaches all state', () => {
    const f = fixture(), input = prepared();
    assert.equal(f.jobs.length, 0); assert.equal(f.controller.getState().phase, 'idle');
    f.controller.prepare(input); assert.equal(f.jobs.length, 0); input.request.facts[0].value = 9;
    const state = f.controller.getState(); assert.equal(state.request.facts[0].value, 512);
    state.request.facts[0].value = 8;
    assert.equal(f.controller.getState().request.facts[0].value, 512);
    f.states[0].request.facts[0].value = 7;
    assert.equal(f.controller.getState().request.facts[0].value, 512);
    f.controller.dispose();
});

test('streaming and final draft remain bound to the prepared local context and fixed facts', async () => {
    const f = fixture(); f.controller.prepare(prepared()); const running = f.controller.generate(), job = f.jobs[0];
    assert.equal(f.controller.getState().phase, 'generating');
    job.options.onDelta('512 rows [E1].'); assert.equal(f.controller.getState().text, '512 rows [E1].');
    job.resolve({ text: '512 rows [E1].', model: 'test-model:1' });
    const result = await running;
    assert.equal(f.controller.getState().phase, 'complete'); assert.deepEqual(result.evidenceIds, ['E1']);
    assert.deepEqual(result.numericWarnings, []); assert.equal(f.controller.getState().contextKey, 'opaque-frame-A');
    f.controller.dispose();
});

test('new patient/context preparation cancels owned work and rejects late deltas, results and errors', async () => {
    const f = fixture(); f.controller.prepare(prepared()); const running = f.controller.generate(), job = f.jobs[0];
    f.controller.prepare(prepared({ contextKey: 'opaque-frame-B', revision: 2 }));
    assert.equal(job.options.signal.aborted, true); job.options.onDelta('OLD_PATIENT_DRAFT'); job.resolve({ text: 'OLD_PATIENT_DRAFT' });
    assert.equal(await running, null);
    assert.equal(f.controller.getState().contextKey, 'opaque-frame-B'); assert.equal(f.controller.getState().text, '');
    assert.equal(f.controller.getState().phase, 'ready'); f.controller.dispose();
});

for (const action of ['cancel', 'invalidate', 'clear', 'dispose']) test(`${action} clears transient text and ignores late completions`, async () => {
    const f = fixture(); f.controller.prepare(prepared()); const running = f.controller.generate(), job = f.jobs[0];
    job.options.onDelta('partial draft'); f.controller[action]();
    assert.equal(job.options.signal.aborted, true); job.options.onDelta('late draft'); job.reject(new Error('late PRIVATE_PROVIDER_ERROR'));
    assert.equal(await running, null); assert.equal(f.controller.getState().text, ''); assert.equal(f.controller.getState().result, null);
    assert.equal(f.controller.getState().error, null); f.controller.dispose();
});

test('only one controller job may be active and connection testing is explicit/synthetic', async () => {
    const f = fixture(); const running = f.controller.test(), job = f.jobs[0];
    assert.equal(job.test, true); assert.equal(job.input, undefined); assert.equal(f.controller.getState().phase, 'testing');
    await assert.rejects(f.controller.test(), error => error.code === 'busy');
    job.resolve({ text: 'Connected.' }); await running;
    assert.equal(f.controller.getState().result.connectionTest, true); assert.equal(f.controller.getState().request, null);
    f.controller.dispose();
});

test('controlled request failures clear partial output and never expose provider errors', async () => {
    const f = fixture(); f.controller.prepare(prepared()); const running = f.controller.generate(), job = f.jobs[0];
    job.options.onDelta('partial'); job.reject(Object.assign(new Error('Bearer PRIVATE_SECRET'), { code: 'PRIVATE_SECRET' }));
    await running;
    assert.equal(f.controller.getState().phase, 'error'); assert.equal(f.controller.getState().text, '');
    assert.deepEqual(f.controller.getState().error, { code: 'unavailable', message: 'The AI gateway is unavailable. Check that the service is running and try again.' }); f.controller.dispose();
});

test('invalid completed drafts never enter result state and do not mutate source facts', async () => {
    const f = fixture(); f.controller.prepare(prepared()); const running = f.controller.generate();
    f.jobs[0].resolve({ text: 'bad\u0000draft' }); await running;
    assert.equal(f.controller.getState().phase, 'error'); assert.equal(f.controller.getState().error.code, 'invalid-response');
    assert.equal(f.controller.getState().request.facts[0].value, 512); f.controller.dispose();
});

test('generation can be repeated after cancellation without reusing an old response', async () => {
    const f = fixture(); f.controller.prepare(prepared()); const first = f.controller.generate(); f.controller.cancel();
    const second = f.controller.generate(); f.jobs[1].resolve({ text: '512 rows [E1].' }); await second;
    f.jobs[0].resolve({ text: 'old response' }); await first;
    assert.equal(f.controller.getState().text, '512 rows [E1].'); assert.equal(f.controller.getState().phase, 'complete'); f.controller.dispose();
});

test('disposed or unconfigured controllers do not invoke clients', async () => {
    const unconfigured = new AiController();
    await assert.rejects(unconfigured.generate(), error => error.code === 'unavailable');
    await assert.rejects(unconfigured.test(), error => error.code === 'unavailable');
    const f = fixture(); f.controller.dispose(); f.controller.prepare(prepared());
    await assert.rejects(f.controller.generate(), error => error.code === 'unavailable'); assert.equal(f.jobs.length, 0);
});

test('host callback exceptions cannot strand an active request or expose mutable state', async () => {
    let calls = 0;
    const controller = new AiController({ client: { generate: async () => { calls++; return { text: '512 rows [E1].' }; }, connectionTest: async () => ({ text: 'Connected.' }) }, onChange: () => { throw new Error('Host UI failed'); } });
    controller.prepare(prepared()); await controller.generate(); await controller.generate();
    assert.equal(calls, 2); assert.equal(controller.getState().phase, 'complete'); controller.dispose();
});
