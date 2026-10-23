import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_WORKFLOW_AUDIO_BYTES, MAX_TRANSCRIPTION_REQUEST_BYTES, WORKFLOW_PLAN_SCHEMA, WORKFLOW_TRANSCRIPTION_MODEL,
    validateWorkflowRequest, validateWorkflowPlan, validateWorkflowPlanResponse, validateTranscriptionRequest, validateTranscriptionResponse } from '../src/ai/workflow-protocol.js';

const ready = actions => ({ version: 1, status: 'ready', summary: 'Arrange the current study.', question: null, actions });
const selection = () => ({ type: 'select-series', viewport: 0, selector: { study: 'active', modality: 'CT', plane: 'axial', contrast: 'present', bodyPart: 'chest', seriesNumber: null } });
const audio = (bytes = Buffer.from([0, 1, 2])) => ({ version: 1, task: 'transcribe-command', mimeType: 'audio/webm;codecs=opus', audio: bytes.toString('base64') });

test('workflow command contains only explicit text and no catalog, identifiers or model selector', () => {
    const input = { version: 1, task: 'plan-workflow', command: '  Show CT in two panes.  ' };
    assert.deepEqual(validateWorkflowRequest(input), { version: 1, task: 'plan-workflow', command: 'Show CT in two panes.' });
    for (const extra of ['catalog', 'patient', 'frames', 'sourceUrl', 'model', 'apiKey', 'context']) assert.throws(() => validateWorkflowRequest({ ...input, [extra]: 'PRIVATE' }), error => error.code === 'invalid-request' && !error.message.includes('PRIVATE'));
    for (const command of ['', '  ', 'x'.repeat(1201), 'bad\u0000text', 12, {}]) assert.throws(() => validateWorkflowRequest({ ...input, command }), error => error.code === 'invalid-request');
});

test('request starting mode is optional for legacy clients and restricted to fresh or continue', () => {
    const input = {version: 1, task: 'plan-workflow', command: 'Prepare this CT.'};
    assert.deepEqual(validateWorkflowRequest(input), input);
    for (const mode of ['fresh', 'continue']) assert.deepEqual(validateWorkflowRequest({...input, mode}), {...input, mode});
    for (const mode of [null, '', 'reset-patient', {}, 1]) assert.throws(() => validateWorkflowRequest({...input, mode}), error => error.code === 'invalid-request');
    const accessor = {...input}; let touched = false;
    Object.defineProperty(accessor, 'mode', {get() {touched = true; return 'fresh';}});
    assert.throws(() => validateWorkflowRequest(accessor)); assert.equal(touched, false);
});

test('closed workflow actions and selectors round trip as detached typed plans', () => {
    const actions = [{ type: 'layout', count: 4 }, selection(), { type: 'window', viewport: 1, preset: 'soft-tissue' },
        { type: 'synchronize', slice: true, window: false, camera: true }, { type: 'frame', viewport: 0, frame: 400 },
        { type: 'cine', viewport: 1, playing: false }, { type: 'tool', tool: 'length' }, { type: 'reset', viewport: 2 }, { type: 'last-measurement', viewport: 3 }];
    const input = ready(actions), result = validateWorkflowPlan(input);
    assert.deepEqual(result, input); input.actions[1].selector.modality = 'MR'; assert.equal(result.actions[1].selector.modality, 'CT');
    assert.deepEqual(validateWorkflowPlanResponse({ version: 1, model: 'gpt-6.1-sol', plan: result }, 'gpt-6.1-sol').plan, result);
});

for (const [name, item] of [
    ['unknown action', { type: 'execute', code: 'PRIVATE' }], ['extra JavaScript', { type: 'reset', viewport: 0, script: 'PRIVATE' }],
    ['unsupported layout', { type: 'layout', count: 3 }], ['invalid viewport', { type: 'reset', viewport: 4 }],
    ['zero-based frame', { type: 'frame', viewport: 0, frame: 0 }], ['unbounded frame', { type: 'frame', viewport: 0, frame: 1000001 }],
    ['invalid preset', { type: 'window', viewport: 0, preset: 'diagnose' }], ['arbitrary tool', { type: 'tool', tool: 'delete-all' }],
    ['numeric boolean', { type: 'cine', viewport: 0, playing: 1 }], ['unknown selector', { ...selection(), selector: { ...selection().selector, uid: 'PRIVATE' } }],
    ['unrestricted contrast', { ...selection(), selector: { ...selection().selector, contrast: 'arterial-phase' } }],
    ['unrestricted body part', { ...selection(), selector: { ...selection().selector, bodyPart: 'patient-specific-name' } }],
    ['invalid series number', { ...selection(), selector: { ...selection().selector, seriesNumber: 2.5 } }],
    ['unknown modality', { ...selection(), selector: { ...selection().selector, modality: 'PRIVATE' } }]
]) test(`workflow plan rejects ${name}`, () => assert.throws(() => validateWorkflowPlan(ready([item])), error => error.code === 'invalid-response' && !error.message.includes('PRIVATE')));

test('all selector fields are required and nullable rather than arbitrary optional criteria', () => {
    const item = selection(); item.selector = { study: 'selected-prior', modality: null, plane: null, contrast: null, bodyPart: null, seriesNumber: null };
    assert.deepEqual(validateWorkflowPlan(ready([item])).actions[0], item);
    delete item.selector.contrast; assert.throws(() => validateWorkflowPlan(ready([item])), /invalid/);
});

test('displayed selector is an explicit local identity intent distinct from an active study search', () => {
    const item = selection(); item.selector.study = 'displayed';
    assert.equal(validateWorkflowPlan(ready([item])).actions[0].selector.study, 'displayed');
});

test('ready, clarify and unsupported statuses have mutually exclusive action/question semantics', () => {
    assert.deepEqual(validateWorkflowPlan({ version: 1, status: 'clarify', summary: 'Choose a study.', question: 'Which prior study?', actions: [] }).actions, []);
    assert.equal(validateWorkflowPlan({ version: 1, status: 'unsupported', summary: 'Image analysis is unavailable.', question: null, actions: [] }).status, 'unsupported');
    for (const plan of [ready([]), { ...ready([{ type: 'layout', count: 2 }]), question: 'Unknown?' },
        { version: 1, status: 'clarify', summary: 'Choose.', question: null, actions: [] },
        { version: 1, status: 'unsupported', summary: 'No.', question: null, actions: [{ type: 'layout', count: 2 }] },
        { version: 1, status: 'unsupported', summary: 'No.', question: 'Which?', actions: [] }]) assert.throws(() => validateWorkflowPlan(plan), error => error.code === 'invalid-response');
});

test('plan bounds, provenance, accessors and exotic input records fail closed', () => {
    const valid = ready([{ type: 'layout', count: 2 }]);
    for (const plan of [{ ...valid, summary: 'x'.repeat(501) }, { ...valid, actions: new Array(13).fill({ type: 'layout', count: 1 }) },
        Object.assign(Object.create({ inherited: true }), valid), { ...valid, [Symbol('private')]: true }]) assert.throws(() => validateWorkflowPlan(plan), /invalid/);
    let touched = false;
    const getter = { ...valid }; Object.defineProperty(getter, 'summary', { get() { touched = true; return 'PRIVATE'; } });
    assert.throws(() => validateWorkflowPlan(getter), /invalid/); assert.equal(touched, false);
    assert.throws(() => validateWorkflowPlanResponse({ version: 1, model: 'different', plan: valid }, 'gpt-6.1-sol'), /invalid/);
    const sparse = ready(new Array(1)); assert.throws(() => validateWorkflowPlan(sparse), /invalid/);
});

test('forced function schema is deeply frozen and every object is closed with all properties required', () => {
    function walk(value) {
        if (!value || typeof value !== 'object') return;
        assert.equal(Object.isFrozen(value), true);
        if (value.type === 'object') { assert.equal(value.additionalProperties, false); assert.deepEqual(value.required, Object.keys(value.properties)); }
        Object.values(value).forEach(walk);
    }
    walk(WORKFLOW_PLAN_SCHEMA);
});

const viewSelection = changes => ({ type: 'select-view', viewport: 0, selector: {
    study: 'active', modality: 'CT', plane: 'axial', contrast: null, bodyPart: null,
    purpose: 'routine', reconstruction: 'ordinary', energyKeV: null, energyPreference: null,
    thickness: null, kernel: null, ...changes
} });

test('conceptual source selection and relative positions round trip without internal source identifiers', () => {
    const input = ready([viewSelection(), viewSelection({ reconstruction: 'monoenergetic', energyPreference: 'lowest' }),
        viewSelection({ reconstruction: 'monoenergetic', energyKeV: 70.5 }), { type: 'position', viewport: 'active', position: 'middle' }]);
    const validated = validateWorkflowPlan(input);
    assert.deepEqual(validated, input);
    input.actions[0].selector.purpose = 'bone';
    assert.equal(validated.actions[0].selector.purpose, 'routine');
    assert.ok(!Object.hasOwn(validated.actions[0].selector, 'seriesNumber'));
});

test('conceptual selectors reject unbounded metadata, numeric ambiguity and unsupported inference criteria', () => {
    for (const changes of [
        { energyKeV: NaN }, { energyKeV: Infinity }, { energyKeV: '70' }, { energyKeV: 0 }, { energyKeV: 1001 },
        { energyKeV: 70, energyPreference: 'lowest' }, { reconstruction: 'best-for-diagnosis' },
        { purpose: 'find-lesion' }, { thickness: 1.25 }, { kernel: 'arbitrary-script' },
        { seriesNumber: 312 }, { sourceUrl: 'PRIVATE' }, { description: 'PRIVATE' }
    ]) assert.throws(() => validateWorkflowPlan(ready([viewSelection(changes)])), error => error.code === 'invalid-response');
    const missing = viewSelection(); delete missing.selector.reconstruction;
    assert.throws(() => validateWorkflowPlan(ready([missing])), error => error.code === 'invalid-response');
    assert.throws(() => validateWorkflowPlan(ready([{ type: 'position', viewport: 0, position: 'largest-liver' }])), error => error.code === 'invalid-response');
});

test('transcription accepts canonical bounded base64 and declared browser recording MIME types only', () => {
    assert.deepEqual(validateTranscriptionRequest(audio()), audio());
    for (const bytes of [Buffer.from([0]), Buffer.from([0, 1]), Buffer.from([0, 1, 2])]) assert.equal(validateTranscriptionRequest(audio(bytes)).audio, bytes.toString('base64'));
    const maximum = audio(Buffer.alloc(MAX_WORKFLOW_AUDIO_BYTES)); assert.equal(validateTranscriptionRequest(maximum).audio.length, maximum.audio.length);
    assert.ok(Buffer.byteLength(JSON.stringify(maximum)) < MAX_TRANSCRIPTION_REQUEST_BYTES);
    for (const change of [{ mimeType: 'application/dicom' }, { mimeType: 'audio/ogg' }, { audio: '' }, { audio: 'AA' }, { audio: 'AB==' },
        { audio: 'AAB=' }, { audio: 'data:audio/wav;base64,AAAA' }, { audio: 'AA A=' }, { audio: 'AAAA===' }, { audio: audio(Buffer.alloc(MAX_WORKFLOW_AUDIO_BYTES + 1)).audio }]) {
        assert.throws(() => validateTranscriptionRequest({ ...audio(), ...change }), error => error.code === 'invalid-request');
    }
});

test('transcript output has the approved ASR model and no extra provider response fields', () => {
    assert.deepEqual(validateTranscriptionResponse({ version: 1, model: WORKFLOW_TRANSCRIPTION_MODEL, text: '  Show two panes.  ' }), { version: 1, model: 'gpt-transcribe', text: 'Show two panes.' });
    for (const change of [{ model: 'different' }, { text: '' }, { text: 'x'.repeat(1201) }, { private: 'PRIVATE' }]) {
        assert.throws(() => validateTranscriptionResponse({ version: 1, model: WORKFLOW_TRANSCRIPTION_MODEL, text: 'Show two panes.', ...change }), error => error.code === 'invalid-response');
    }
});
