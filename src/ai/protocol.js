/** Shared, deliberately narrow AI Assist v1 wire contract. No DICOM objects cross it. */
export const MAX_AI_REQUEST_BYTES = 32 * 1024;
export const MAX_AI_OUTPUT_BYTES = 64 * 1024;
export const MAX_AI_FACTS = 256;
export const AI_TIMEOUT_MS = 60000;
export const AI_ERROR_CODES = Object.freeze(['provider-error', 'invalid-request', 'unauthorized', 'rate-limited', 'timeout', 'unavailable', 'invalid-response', 'configuration-changed']);
export const AI_TASKS = Object.freeze(['explain-series', 'summarize-measurements', 'connection-test']);

const numeric = (label, options = {}) => Object.freeze({ label, type: 'number', ...options });
const enumeration = (label, values) => Object.freeze({ label, type: 'enum', values: Object.freeze(values) });
const INTENSITY_UNITS = Object.freeze(['unspecified', 'stored', 'HU', 'BQML', 'CNTS', 'CPS', 'GML', 'PROPCNTS', 'PROPCPS', 'PCNT', 'NONE', 'CM2', 'MM2', 'CM2ML', 'MLML', 'MGML', 'UMOLML', 'UMOLMINML', 'MGMINML']);
const GEOMETRY_UNITS = Object.freeze(['mm', 'px', 'mm2', 'px2', 'deg']);
export const AI_NOTICE_CODES = Object.freeze(['jpeg-alignment', 'jpeg-precision', 'geometry', 'timing', 'encoding', 'compatibility']);

export const AI_FACTS = Object.freeze({
    modality: enumeration('Modality', ['CT', 'MR', 'CR', 'DX', 'US', 'XA', 'XRF', 'NM', 'PT', 'MG', 'RF', 'OT', 'SC', 'PX', 'IO', 'XC', 'ES', 'GM', 'SM', 'OPT', 'OP', 'OCT', 'IVOCT', 'RTIMAGE']),
    rows: numeric('Image rows', { integer: true, min: 1, max: 65536 }),
    columns: numeric('Image columns', { integer: true, min: 1, max: 65536 }),
    'frame-count': numeric('Navigable frames', { integer: true, min: 1, max: 1000000000 }),
    photometric: enumeration('Photometric interpretation', ['MONOCHROME1', 'MONOCHROME2', 'RGB', 'PALETTE COLOR', 'YBR_FULL', 'YBR_FULL_422', 'YBR_RCT', 'YBR_ICT']),
    'bits-stored': numeric('Source-declared stored precision in bits', { integer: true, min: 1, max: 64 }),
    'bits-allocated': numeric('Source-declared allocated bits', { integer: true, min: 1, max: 64 }),
    'decoded-bits-stored': numeric('Decoded precision in bits', { integer: true, min: 1, max: 64 }),
    'pixel-representation': enumeration('Pixel representation', ['signed', 'unsigned']),
    'spatial-calibration': enumeration('Spatial calibration', ['pixel-spacing', 'pixel-grid']),
    'row-spacing': numeric('Row spacing', { min: Number.MIN_VALUE, units: Object.freeze(['mm']) }),
    'column-spacing': numeric('Column spacing', { min: Number.MIN_VALUE, units: Object.freeze(['mm']) }),
    'rescale-slope': numeric('Modality rescale slope'),
    'rescale-intercept': numeric('Modality rescale intercept'),
    'intensity-unit': enumeration('Modality intensity unit', INTENSITY_UNITS),
    notice: enumeration('Compatibility notice category', AI_NOTICE_CODES),
    'measurement-kind': enumeration('Measurement type', ['length', 'angle', 'area']),
    value: numeric('Viewer-computed measurement', { min: 0, units: GEOMETRY_UNITS }),
    calibration: enumeration('Measurement calibration', ['physical', 'pixels']),
    'roi-status': enumeration('ROI statistics status', ['ok', 'empty', 'color-intensity-unavailable']),
    'pixel-count': numeric('Included ROI pixels', { integer: true, min: 0 }),
    'excluded-padding': numeric('Excluded padding pixels', { integer: true, min: 0 }),
    'sampled-area': numeric('Sampled ROI area', { min: 0, units: Object.freeze(['mm2', 'px2']) }),
    'stored-mean': numeric('Stored-value mean', { units: Object.freeze(['stored']) }),
    'stored-min': numeric('Stored-value minimum', { units: Object.freeze(['stored']) }),
    'stored-max': numeric('Stored-value maximum', { units: Object.freeze(['stored']) }),
    'stored-standard-deviation': numeric('Stored-value population standard deviation', { min: 0, units: Object.freeze(['stored']) }),
    'modality-mean': numeric('Modality-value mean', { units: INTENSITY_UNITS }),
    'modality-min': numeric('Modality-value minimum', { units: INTENSITY_UNITS }),
    'modality-max': numeric('Modality-value maximum', { units: INTENSITY_UNITS }),
    'modality-standard-deviation': numeric('Modality-value population standard deviation', { min: 0, units: INTENSITY_UNITS })
});
const MEASUREMENT_CODES = new Set(['measurement-kind', 'value', 'calibration', 'roi-status', 'pixel-count', 'excluded-padding', 'sampled-area',
    'stored-mean', 'stored-min', 'stored-max', 'stored-standard-deviation', 'modality-mean', 'modality-min', 'modality-max', 'modality-standard-deviation']);
const encoder = new TextEncoder();
export const aiByteLength = value => encoder.encode(typeof value === 'string' ? value : JSON.stringify(value)).byteLength;

export function aiError(code, message) {
    const error = new Error(message ?? ({ 'invalid-request': 'The AI context is invalid or exceeds its limit.', 'invalid-response': 'The AI service returned an invalid response.',
        unauthorized: 'AI access expired or was not authorized. Sign in to the AI service and try again.', 'rate-limited': 'The AI service is busy or its usage limit was reached.',
        'configuration-changed': 'The AI configuration changed. Refresh the viewer and sign in again before sending.',
        timeout: 'The AI request timed out.', unavailable: 'The AI gateway is unavailable. Check that the service is running and try again.', 'provider-error': 'The configured AI model could not complete this request. The host should check its provider configuration and account access.',
        cancelled: 'The AI request was cancelled.', busy: 'An AI request is already active.' }[code] ?? 'The AI request failed.'));
    error.code = code;
    return error;
}
function invalid() { throw aiError('invalid-request'); }
function record(value, permitted) {
    if (value == null || typeof value !== 'object' || ![null, Object.prototype].includes(Object.getPrototypeOf(value))) invalid();
    const keys = Reflect.ownKeys(value);
    if (keys.some(key => typeof key !== 'string' || !permitted.includes(key) || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'))) invalid();
}
function normalizedFact(input) {
    record(input, ['id', 'code', 'value', 'unit', 'group']);
    if (!['id', 'code', 'value'].every(key => Object.hasOwn(input, key)) || typeof input.id !== 'string' || !/^E(?:[1-9]\d{0,2})$/.test(input.id) || Number(input.id.slice(1)) > MAX_AI_FACTS || !Object.hasOwn(AI_FACTS, input.code)) invalid();
    const definition = AI_FACTS[input.code], measurement = MEASUREMENT_CODES.has(input.code);
    if (measurement !== (input.group != null) || input.group != null && (typeof input.group !== 'string' || !/^M(?:[1-9]|[1-5]\d|6[0-4])$/.test(input.group))) invalid();
    if (definition.type === 'number') {
        if (typeof input.value !== 'number' || !Number.isFinite(input.value) || Math.abs(input.value) > 1e15 ||
            definition.integer && !Number.isSafeInteger(input.value) || input.value < (definition.min ?? -1e15) || input.value > (definition.max ?? 1e15)) invalid();
    } else if (!definition.values.includes(input.value)) invalid();
    if (definition.units ? !definition.units.includes(input.unit) : input.unit != null) invalid();
    return { id: input.id, code: input.code, value: input.value, ...(definition.units ? { unit: input.unit } : {}), ...(measurement ? { group: input.group } : {}) };
}

/** Validate on both sides of the gateway. Unknown fields are rejected, never forwarded. */
export function validateAiRequest(input) {
    record(input, ['version', 'task', 'facts']);
    if (!['version', 'task', 'facts'].every(key => Object.hasOwn(input, key)) || input.version !== 1 || !AI_TASKS.includes(input.task) ||
        !Array.isArray(input.facts) || Object.getPrototypeOf(input.facts) !== Array.prototype || input.facts.length > MAX_AI_FACTS ||
        Reflect.ownKeys(input.facts).length !== input.facts.length + 1 || Reflect.ownKeys(input.facts).some(key => key !== 'length' &&
            (typeof key !== 'string' || !/^(?:0|[1-9]\d*)$/.test(key) || !Object.hasOwn(Object.getOwnPropertyDescriptor(input.facts, key), 'value')))) invalid();
    if (input.task === 'connection-test' ? input.facts.length !== 0 : input.facts.length === 0) invalid();
    const facts = input.facts.map(normalizedFact), ids = new Set(), fields = new Set(), measurements = new Map();
    for (const fact of facts) {
        if (ids.has(fact.id)) invalid();
        ids.add(fact.id);
        const key = `${fact.group ?? ''}:${fact.code}:${fact.code === 'notice' ? fact.value : ''}`;
        if (fields.has(key) || input.task === 'explain-series' && fact.group) invalid();
        fields.add(key);
        if (fact.group) {
            if (!measurements.has(fact.group)) measurements.set(fact.group, new Map());
            measurements.get(fact.group).set(fact.code, fact);
        }
    }
    if (input.task === 'summarize-measurements' && !measurements.size) invalid();
    for (const group of measurements.values()) {
        const kind = group.get('measurement-kind')?.value, value = group.get('value'), calibration = group.get('calibration')?.value;
        if (!kind || !value || !calibration || kind === 'angle' && value.unit !== 'deg' || kind === 'length' && !['mm', 'px'].includes(value.unit) ||
            kind === 'area' && !['mm2', 'px2'].includes(value.unit) || kind !== 'angle' && (calibration === 'physical') !== value.unit.startsWith('mm')) invalid();
        if (kind === 'angle' && value.value > 180) invalid();
    }
    const request = { version: 1, task: input.task, facts };
    if (aiByteLength(request) > MAX_AI_REQUEST_BYTES) invalid();
    return request;
}

/** Display only fixed labels and validated coded values; never arbitrary metadata text. */
export function formatAiFact(input) {
    const fact = normalizedFact(input), label = AI_FACTS[fact.code].label;
    return { ...fact, label, text: `${fact.group ? `${fact.group} · ` : ''}${label}: ${fact.value}${fact.unit ? ` ${fact.unit}` : ''}` };
}

/** Build a narrow facts projection. Omit unknown values rather than send raw text. */
export function createSeriesFacts(frame, { frameCount = frame?.frameCount ?? 1, notices = [], sourceBitsStored = frame?.bitsStored, sourceBitsAllocated = frame?.bitsAllocated } = {}) {
    if (!frame || typeof frame !== 'object' || !Array.isArray(notices)) return [];
    const facts = [], add = (code, value, unit) => {
        const candidate = { id: `E${facts.length + 1}`, code, value, ...(unit ? { unit } : {}) };
        try { facts.push(normalizedFact(candidate)); } catch { /* Unknown/unavailable technical fields stay local. */ }
    };
    for (const [code, value] of [['modality', frame.modality], ['rows', frame.rows], ['columns', frame.columns], ['frame-count', frameCount],
        ['photometric', frame.photometric], ['bits-stored', sourceBitsStored], ['bits-allocated', sourceBitsAllocated]]) add(code, value);
    if (frame.bitsStored !== sourceBitsStored) add('decoded-bits-stored', frame.bitsStored);
    if (typeof frame.signed === 'boolean') add('pixel-representation', frame.signed ? 'signed' : 'unsigned');
    const spacing = frame.pixelSpacing;
    const calibrated = Array.isArray(spacing) && spacing.length === 2 && spacing.every(value => Number.isFinite(value) && value > 0 && value <= 1e15);
    add('spatial-calibration', calibrated ? 'pixel-spacing' : 'pixel-grid');
    if (calibrated) { add('row-spacing', spacing[0], 'mm'); add('column-spacing', spacing[1], 'mm'); }
    add('rescale-slope', frame.slope); add('rescale-intercept', frame.intercept);
    add('intensity-unit', INTENSITY_UNITS.includes(frame.unit) ? frame.unit : 'unspecified');
    for (const code of new Set(notices)) if (AI_NOTICE_CODES.includes(code)) add('notice', code);
    return facts;
}

/** Accept measureAnnotation results, never labels, IDs, points, source references or samples. */
export function createMeasurementFacts(measurements, { startId = 1 } = {}) {
    if (!Array.isArray(measurements) || measurements.length > 64 || !Number.isInteger(startId) || startId < 1) invalid();
    const facts = [], add = (group, code, value, unit) => {
        const fact = { id: `E${startId + facts.length}`, code, value, ...(unit ? { unit } : {}), group };
        facts.push(normalizedFact(fact));
    };
    measurements.forEach((measurement, index) => {
        const geometry = measurement?.geometry, group = `M${index + 1}`;
        if (!geometry) invalid();
        add(group, 'measurement-kind', geometry.kind); add(group, 'value', geometry.value, geometry.unit);
        if (typeof geometry.calibrated !== 'boolean') invalid();
        add(group, 'calibration', geometry.calibrated ? 'physical' : 'pixels');
        const stats = measurement.statistics;
        if (!stats) return;
        add(group, 'roi-status', stats.status); add(group, 'pixel-count', stats.pixelCount);
        add(group, 'excluded-padding', stats.excludedPadding); add(group, 'sampled-area', stats.sampledArea, stats.areaUnit);
        for (const domain of ['stored', 'modality']) {
            const moments = stats[domain];
            if (!moments || !moments.count) continue;
            const unit = domain === 'stored' ? 'stored' : INTENSITY_UNITS.includes(stats.unit) ? stats.unit : 'unspecified';
            for (const [field, name] of [['mean', 'mean'], ['min', 'min'], ['max', 'max'], ['stdDev', 'standard-deviation']]) add(group, `${domain}-${name}`, moments[field], unit);
        }
    });
    // Reuse cross-field calibration and value checks without retaining any input object.
    if (facts.length) validateAiRequest({ version: 1, task: 'summarize-measurements', facts });
    return facts;
}

const UNIT_ALIASES = Object.freeze({ 'mm²': 'mm2', 'px²': 'px2', '°': 'deg', degrees: 'deg', degree: 'deg', pixels: 'px', pixel: 'px' });
const UNIT_PATTERN = /^(mm²|px²|cm²|mm2|px2|cm2|mm|cm|px|deg|degrees?|°|HU|BQML|CNTS|CPS|GML|PCNT|stored|pixels?)(?![A-Za-z0-9_])/;
/** Checks citations and exact numeric quotations, not the semantic truth of prose. */
export function validateAiDraft(text, inputFacts) {
    if (typeof text !== 'string' || !text.trim() || aiByteLength(text) > MAX_AI_OUTPUT_BYTES || /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(text)) throw aiError('invalid-response');
    const facts = inputFacts.map(normalizedFact), ids = new Set(facts.map(fact => fact.id));
    const references = [...new Set(text.match(/\bE[0-9]+\b/g) ?? [])];
    const evidenceIds = references.filter(id => ids.has(id)), unknownEvidenceIds = references.filter(id => !ids.has(id));
    const scrubbed = text.replace(/\b[EM][0-9]+\b/g, match => ' '.repeat(match.length));
    const numericWarnings = [], seen = new Set();
    for (const match of scrubbed.matchAll(/(?<![A-Za-z0-9_])[-+]?(?:(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?(?![A-Za-z0-9_])/g)) {
        const number = Number(match[0].replaceAll(',', '')), matching = facts.filter(fact => typeof fact.value === 'number' && fact.value === number);
        const suffix = scrubbed.slice(match.index + match[0].length).trimStart().match(UNIT_PATTERN)?.[1];
        const unit = UNIT_ALIASES[suffix] ?? suffix;
        const reason = !matching.length ? 'not-supplied' : unit && !matching.some(fact => fact.unit === unit || unit === 'px' &&
            ['rows', 'columns', 'pixel-count', 'excluded-padding'].includes(fact.code)) ? 'unit-mismatch' : null;
        const key = `${match[0]}:${unit ?? ''}:${reason}`;
        if (reason && !seen.has(key) && numericWarnings.length < 64) {
            numericWarnings.push({ token: `${match[0]}${unit ? ` ${unit}` : ''}`, reason }); seen.add(key);
        }
    }
    return { text, evidenceIds, unknownEvidenceIds, numericWarnings };
}

export function isAiModelLabel(value) {
    return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/@+ -]{0,119}$/.test(value);
}
