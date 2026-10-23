import { AI_FACTS, aiByteLength, aiError, isAiModelLabel } from './protocol.js';

export const MAX_WORKFLOW_COMMAND_CHARS = 1200;
export const MAX_WORKFLOW_ACTIONS = 12;
export const MAX_WORKFLOW_REQUEST_BYTES = 8192;
export const MAX_WORKFLOW_RESPONSE_BYTES = 32768;
export const MAX_WORKFLOW_AUDIO_BYTES = 2 * 1024 * 1024;
export const MAX_WORKFLOW_AUDIO_MS = 20000;
export const MAX_TRANSCRIPTION_REQUEST_BYTES = Math.ceil(MAX_WORKFLOW_AUDIO_BYTES / 3) * 4 + 1024;
export const WORKFLOW_TRANSCRIPTION_MODEL = 'gpt-transcribe';
export const WORKFLOW_AUDIO_MIME_TYPES = Object.freeze(['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/mp4;codecs=mp4a.40.2', 'audio/wav', 'audio/x-wav', 'audio/mpeg']);
export const WORKFLOW_MODALITIES = AI_FACTS.modality.values;

const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
const enumerated = values => ({ type: 'string', enum: values });
const nullable = values => ({ type: ['string', 'null'], enum: [...values, null] });
const integer = (minimum, maximum) => ({ type: 'integer', minimum, maximum });
const object = properties => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const viewport = { anyOf: [integer(0, 3), enumerated(['active'])] };
const selector = object({ study: enumerated(['displayed', 'active', 'latest', 'prior', 'selected-prior']), modality: nullable(WORKFLOW_MODALITIES),
    plane: nullable(['axial', 'coronal', 'sagittal']), contrast: nullable(['present', 'absent']),
    bodyPart: nullable(['chest', 'abdomen', 'pelvis', 'head', 'spine', 'liver']), seriesNumber: { type: ['integer', 'null'], minimum: 0, maximum: 2147483647 } });
const viewSelector = object({
    study: selector.properties.study, modality: selector.properties.modality, plane: selector.properties.plane,
    contrast: selector.properties.contrast, bodyPart: selector.properties.bodyPart,
    purpose: nullable(['routine', 'lung', 'soft-tissue', 'bone']),
    reconstruction: nullable(['ordinary', 'conventional', 'blended', 'monoenergetic', 'virtual-unenhanced', 'material-map', 'projection', 'reformatted']),
    energyKeV: { type: ['number', 'null'], minimum: 1, maximum: 1000 },
    energyPreference: nullable(['lowest', 'highest']), thickness: nullable(['thinnest', 'thickest']),
    kernel: nullable(['standard', 'sharp'])
});
const action = (type, fields) => object({ type: enumerated([type]), ...fields });

/** One fixed strict function schema; source catalogs, identifiers and arbitrary
 * viewer arguments are deliberately absent. Grounding happens only locally. */
export const WORKFLOW_PLAN_SCHEMA = freeze(object({
    version: { type: 'integer', enum: [1] }, status: enumerated(['ready', 'clarify', 'unsupported']),
    summary: { type: 'string', minLength: 1, maxLength: 500 }, question: { type: ['string', 'null'], minLength: 1, maxLength: 500 },
    actions: { type: 'array', maxItems: MAX_WORKFLOW_ACTIONS, items: { anyOf: [
        action('layout', { count: { type: 'integer', enum: [1, 2, 4] } }),
        action('select-series', { viewport, selector }),
        action('select-view', { viewport, selector: viewSelector }),
        action('window', { viewport, preset: enumerated(['lung', 'soft-tissue', 'bone', 'brain', 'default']) }),
        action('synchronize', { slice: { type: 'boolean' }, window: { type: 'boolean' }, camera: { type: 'boolean' } }),
        action('frame', { viewport, frame: integer(1, 1000000) }),
        action('position', { viewport, position: enumerated(['first', 'middle', 'last']) }),
        action('cine', { viewport, playing: { type: 'boolean' } }),
        action('tool', { tool: enumerated(['window', 'pan', 'zoom', 'probe', 'length', 'angle', 'rectangle', 'ellipse', 'polygon']) }),
        action('reset', { viewport }), action('last-measurement', { viewport })
    ] } }
}));

function invalid(code = 'invalid-request') { throw aiError(code); }
function record(value, keys, code) {
    if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid(code);
    const own = Reflect.ownKeys(value);
    if (own.length !== keys.length || !keys.every(key => Object.hasOwn(value, key)) || own.some(key => typeof key !== 'string' || !keys.includes(key) ||
        !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'))) invalid(code);
}
function array(value, maximum, code) {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > maximum || Reflect.ownKeys(value).length !== value.length + 1 ||
        Reflect.ownKeys(value).some(key => key !== 'length' && (typeof key !== 'string' || !/^(?:0|[1-9]\d*)$/.test(key) ||
            !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value')))) invalid(code);
}
function text(value, maximum, code) {
    if (typeof value !== 'string' || !value.trim() || value.length > maximum || /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(value)) invalid(code);
    return value.trim();
}
function matches(value, schema, code) {
    if (schema.anyOf) {
        for (const choice of schema.anyOf) { try { return matches(value, choice, code); } catch { /* Try the next closed action union. */ } }
        invalid(code);
    }
    if (value === null && Array.isArray(schema.type) && schema.type.includes('null')) return null;
    if (schema.type === 'object') {
        record(value, schema.required, code);
        return Object.fromEntries(schema.required.map(key => [key, matches(value[key], schema.properties[key], code)]));
    }
    if (schema.type === 'array') { array(value, schema.maxItems, code); return value.map(item => matches(item, schema.items, code)); }
    const type = Array.isArray(schema.type) ? schema.type.find(value => value !== 'null') : schema.type;
    if (type === 'string') {
        const normalized = text(value, schema.maxLength ?? 120, code);
        if (schema.enum && !schema.enum.includes(value)) invalid(code);
        return normalized;
    }
    if (type === 'integer') {
        if (!Number.isSafeInteger(value) || value < (schema.minimum ?? -Number.MAX_SAFE_INTEGER) || value > (schema.maximum ?? Number.MAX_SAFE_INTEGER) || schema.enum && !schema.enum.includes(value)) invalid(code);
        return value;
    }
    if (type === 'number') {
        if (typeof value !== 'number' || !Number.isFinite(value) || value < schema.minimum || value > schema.maximum) invalid(code);
        return value;
    }
    if (type === 'boolean' && typeof value === 'boolean') return value;
    invalid(code);
}

export function validateWorkflowRequest(input) {
    const hasMode = input != null && Object.hasOwn(input, 'mode');
    record(input, ['version', 'task', 'command', ...(hasMode ? ['mode'] : [])]);
    if (input.version !== 1 || input.task !== 'plan-workflow') invalid();
    if (hasMode && !['fresh', 'continue'].includes(input.mode)) invalid();
    const result = { version: 1, task: 'plan-workflow', command: text(input.command, MAX_WORKFLOW_COMMAND_CHARS), ...(hasMode ? { mode: input.mode } : {}) };
    if (aiByteLength(result) > MAX_WORKFLOW_REQUEST_BYTES) invalid();
    return result;
}

export function validateWorkflowPlan(input) {
    const result = matches(input, WORKFLOW_PLAN_SCHEMA, 'invalid-response');
    if (result.actions.some(action => action.type === 'select-view' && action.selector.energyKeV != null && action.selector.energyPreference != null)) invalid('invalid-response');
    if (result.status === 'ready' ? !result.actions.length || result.question !== null : result.actions.length ||
        (result.status === 'clarify' ? result.question === null : result.question !== null)) invalid('invalid-response');
    if (aiByteLength(result) > MAX_WORKFLOW_RESPONSE_BYTES) invalid('invalid-response');
    return result;
}

export function validateWorkflowPlanResponse(input, expectedModel) {
    record(input, ['version', 'model', 'plan'], 'invalid-response');
    if (input.version !== 1 || !isAiModelLabel(input.model) || expectedModel != null && input.model !== expectedModel) invalid('invalid-response');
    return { version: 1, model: input.model, plan: validateWorkflowPlan(input.plan) };
}

export function validateTranscriptionRequest(input) {
    record(input, ['version', 'task', 'mimeType', 'audio']);
    if (input.version !== 1 || input.task !== 'transcribe-command' || !WORKFLOW_AUDIO_MIME_TYPES.includes(input.mimeType) ||
        typeof input.audio !== 'string' || !input.audio.length || input.audio.length % 4 !== 0 || input.audio.length > Math.ceil(MAX_WORKFLOW_AUDIO_BYTES / 3) * 4 ||
        !/^[A-Za-z0-9+/]*={0,2}$/.test(input.audio)) invalid();
    const padding = input.audio.endsWith('==') ? 2 : input.audio.endsWith('=') ? 1 : 0;
    const bytes = input.audio.length / 4 * 3 - padding;
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    if (bytes < 1 || bytes > MAX_WORKFLOW_AUDIO_BYTES || padding && alphabet.indexOf(input.audio[input.audio.length - padding - 1]) % (padding === 2 ? 16 : 4)) invalid();
    return { version: 1, task: 'transcribe-command', mimeType: input.mimeType, audio: input.audio };
}

export function validateTranscriptionResponse(input) {
    record(input, ['version', 'model', 'text'], 'invalid-response');
    if (input.version !== 1 || input.model !== WORKFLOW_TRANSCRIPTION_MODEL) invalid('invalid-response');
    return { version: 1, model: input.model, text: text(input.text, MAX_WORKFLOW_COMMAND_CHARS, 'invalid-response') };
}
