export const MAX_READING_PROTOCOLS = 32;
export const MAX_READING_PROTOCOL_BYTES = 64 * 1024;
export const MAX_READING_CANDIDATES = 128;
export const MAX_READING_FRAMES = 10000;
export const READING_STRING_FIELDS = Object.freeze(['modality', 'description', 'photometric', 'unit', 'acquisitionContrast', 'complexImageComponent']);
export const READING_NUMBER_FIELDS = Object.freeze(['rows', 'columns', 'frameCount', 'effectiveEchoTime', 'temporalPositionIndex', 'acquisitionNumber']);
export const READING_BOOLEAN_FIELDS = Object.freeze(['geometryKnown', 'dimensionsValid']);
const strings = new Set(READING_STRING_FIELDS), numbers = new Set(READING_NUMBER_FIELDS), booleans = new Set(READING_BOOLEAN_FIELDS);
const encoder = new TextEncoder();
const own = (value, key) => Object.hasOwn(value, key);
export function protocolError(reason) { return new Error(`Invalid reading protocol: ${reason}.`); }
function invalid(reason) { throw protocolError(reason); }
export function plainObject(value) {
    return value != null && typeof value === 'object' && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
export function objectKeys(value, keys, reason) {
    if (!plainObject(value) || Reflect.ownKeys(value).some(key => typeof key !== 'string' || !keys.includes(key) ||
        !Object.getOwnPropertyDescriptor(value, key)?.enumerable || !own(Object.getOwnPropertyDescriptor(value, key), 'value'))) invalid(reason);
}
export function protocolInteger(value, minimum, maximum, reason) {
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) invalid(reason);
    return value;
}
export function protocolNumber(value, reason) {
    if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > 1e12) invalid(reason);
    return value;
}
function text(value, maximum, reason, empty = false) {
    if (typeof value !== 'string' || value.length > maximum || (!empty && !value.trim()) || /[\x00-\x1f\x7f]/u.test(value)) invalid(reason);
    return value;
}
function identifier(value) {
    if (typeof value !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/u.test(value)) invalid('use bounded protocol and selector identifiers');
    return value;
}
function choice(value, choices, reason) { if (!choices.includes(value)) invalid(reason); return value; }

/** Inspect JSON data before normalization. Reject accessors and stop at the byte
 * cap without invoking caller code or serializing an unbounded input tree. */
function boundedJson(input) {
    if (typeof input === 'string') {
        if (input.length > MAX_READING_PROTOCOL_BYTES || encoder.encode(input).byteLength > MAX_READING_PROTOCOL_BYTES) invalid('JSON exceeds the 64 KiB limit');
        try { input = JSON.parse(input); } catch { invalid('use valid JSON'); }
    }
    let bytes = 0, nodes = 0;
    const visit = (value, depth) => {
        if (++nodes > 16384 || depth > 12) invalid('JSON structure exceeds its limit');
        if (value === null || typeof value === 'boolean') bytes += value === null ? 4 : value ? 4 : 5;
        else if (typeof value === 'number') {
            if (!Number.isFinite(value)) invalid('JSON numbers must be finite');
            bytes += String(value).length;
        } else if (typeof value === 'string') {
            if (value.length > MAX_READING_PROTOCOL_BYTES) invalid('JSON exceeds the 64 KiB limit');
            bytes += encoder.encode(JSON.stringify(value)).byteLength;
        } else if (Array.isArray(value)) {
            if (value.length > 128 || Reflect.ownKeys(value).length !== value.length + 1) invalid('use bounded JSON arrays without extra fields');
            bytes += 2 + Math.max(0, value.length - 1);
            for (let index = 0; index < value.length; index++) {
                const property = Object.getOwnPropertyDescriptor(value, String(index));
                if (!property || !own(property, 'value')) invalid('use JSON arrays without accessors');
                visit(property.value, depth + 1);
            }
        } else {
            if (!plainObject(value)) invalid('use JSON data in plain objects');
            const keys = Reflect.ownKeys(value);
            if (keys.length > 32) invalid('JSON object exceeds its field limit');
            bytes += 2 + Math.max(0, keys.length - 1);
            for (const key of keys) {
                const property = Object.getOwnPropertyDescriptor(value, key);
                if (typeof key !== 'string' || !property?.enumerable || !own(property, 'value')) invalid('use JSON data without accessors or hidden fields');
                if (key.length > MAX_READING_PROTOCOL_BYTES) invalid('JSON exceeds the 64 KiB limit');
                bytes += encoder.encode(JSON.stringify(key)).byteLength + 1;
                visit(property.value, depth + 1);
            }
        }
        if (bytes > MAX_READING_PROTOCOL_BYTES) invalid('JSON exceeds the 64 KiB limit');
    };
    visit(input, 0);
    return input;
}
function ruleValue(field, value) {
    if (strings.has(field)) return text(value, field === 'description' ? 256 : 64, 'use bounded literal rule values');
    if (numbers.has(field)) return protocolNumber(value, 'use finite numeric rule values');
    if (booleans.has(field) && typeof value === 'boolean') return value;
    invalid('use rule values matching the field type');
}
function normalizeRule(input) {
    objectKeys(input, ['field', 'op', 'value', 'required', 'weight'], 'use supported rule fields');
    const field = choice(input.field, [...strings, ...numbers, ...booleans], 'use supported metadata fields');
    const op = choice(input.op, ['eq', 'in', 'contains', 'range', 'exists'], 'use supported literal operators');
    let value;
    if (op === 'exists') {
        if (typeof input.value !== 'boolean') invalid('exists requires a boolean');
        value = input.value;
    } else if (op === 'range') {
        if (!numbers.has(field) || !Array.isArray(input.value) || input.value.length !== 2) invalid('range requires a numeric field and two bounds');
        value = input.value.map(item => ruleValue(field, item));
        if (value[0] > value[1]) invalid('range bounds must be ordered');
        value = Object.freeze(value);
    } else if (op === 'in') {
        if (!Array.isArray(input.value) || input.value.length < 1 || input.value.length > 16) invalid('in requires one to sixteen literal values');
        value = input.value.map(item => ruleValue(field, item));
        if (new Set(value.map(item => typeof item === 'string' ? item.toLowerCase() : item)).size !== value.length) invalid('in values must be distinct');
        value = Object.freeze(value);
    } else {
        if (op === 'contains' && !strings.has(field)) invalid('contains requires a text field');
        value = ruleValue(field, input.value);
    }
    if (own(input, 'required') && typeof input.required !== 'boolean') invalid('required must be a boolean');
    const weight = own(input, 'weight') ? protocolInteger(input.weight, 0, 100, 'use rule weights from zero to one hundred') : 1;
    return Object.freeze({ field, op, value, required: input.required ?? true, weight });
}
function normalizeSelector(input, previous) {
    objectKeys(input, ['id', 'scope', 'distinctFrom', 'rules'], 'use supported selector fields');
    const id = identifier(input.id);
    if (previous.includes(id)) invalid('selector identifiers must be unique');
    const scope = choice(input.scope, ['selected', 'all', 'current', 'prior'], 'use an explicit selector scope');
    const distinct = input.distinctFrom ?? [];
    if (!Array.isArray(distinct) || distinct.length > 3 || new Set(distinct).size !== distinct.length ||
        distinct.some(value => !previous.includes(value))) invalid('distinctFrom must name earlier distinct selectors');
    if (!Array.isArray(input.rules) || input.rules.length < 1 || input.rules.length > 16) invalid('use one to sixteen rules per selector');
    return Object.freeze({ id, scope, distinctFrom: Object.freeze([...distinct]), rules: Object.freeze(input.rules.map(normalizeRule)) });
}
function normalizeFrame(input = { mode: 'first' }) {
    objectKeys(input, ['mode', 'index'], 'use supported frame policy fields');
    const mode = choice(input.mode, ['first', 'middle', 'active', 'index'], 'use an explicit frame policy');
    if (mode === 'index') return Object.freeze({ mode, index: protocolInteger(input.index, 0, MAX_READING_FRAMES - 1, 'use a bounded zero-based logical frame index') });
    if (own(input, 'index')) invalid('only indexed frame policies contain an index');
    return Object.freeze({ mode });
}
function normalizeWindow(input) {
    objectKeys(input, ['center', 'width'], 'use a window center and width');
    const center = protocolNumber(input.center, 'use a finite window center'), width = protocolNumber(input.width, 'use a finite window width');
    if (width < 1) invalid('linear window width must be at least one');
    return Object.freeze({ center, width });
}
function normalize(input) {
    objectKeys(input, ['version', 'id', 'name', 'layout', 'selectors', 'slots', 'links'], 'use supported versioned protocol fields');
    if (input.version !== 1) invalid('only schema version one is supported');
    const id = identifier(input.id), name = text(input.name, 80, 'use a bounded protocol name');
    const layout = choice(input.layout, [1, 2, 4], 'use a one, two or four pane layout');
    if (!Array.isArray(input.selectors) || input.selectors.length < 1 || input.selectors.length > 4) invalid('use one to four selectors');
    const identifiers = [], selectors = input.selectors.map(value => { const selector = normalizeSelector(value, identifiers); identifiers.push(selector.id); return selector; });
    if (!Array.isArray(input.slots) || input.slots.length !== layout) invalid('provide exactly one slot for every layout pane');
    const used = new Set(), slots = input.slots.map(value => {
        objectKeys(value, ['id', 'selector', 'label', 'frame', 'window', 'windowUnit'], 'use supported slot fields');
        const slotId = protocolInteger(value.id, 0, layout - 1, 'use zero-based pane slot identifiers');
        if (used.has(slotId)) invalid('pane slot identifiers must be unique'); used.add(slotId);
        if (!identifiers.includes(value.selector)) invalid('slots must reference a declared selector');
        const label = own(value, 'label') ? text(value.label, 80, 'use bounded slot labels', true) : '';
        const window = value.window == null ? null : normalizeWindow(value.window);
        const windowUnit = value.windowUnit == null ? null : text(value.windowUnit, 32, 'use a bounded window unit');
        if (windowUnit && !window) invalid('windowUnit requires an explicit window');
        return Object.freeze({ id: slotId, selector: value.selector, label, frame: normalizeFrame(value.frame), window, windowUnit });
    }).sort((a, b) => a.id - b.id);
    if (identifiers.some(value => !slots.some(slot => slot.selector === value) && !selectors.some(selector => selector.distinctFrom.includes(value)))) invalid('every selector must be used by a slot or dependency');
    const inputLinks = input.links ?? {};
    objectKeys(inputLinks, ['scroll', 'window', 'camera'], 'use supported link flags');
    for (const value of Object.values(inputLinks)) if (typeof value !== 'boolean') invalid('link flags must be booleans');
    return Object.freeze({ version: 1, id, name, layout, selectors: Object.freeze(selectors), slots: Object.freeze(slots),
        links: Object.freeze({ scroll: inputLinks.scroll ?? false, window: inputLinks.window ?? false, camera: inputLinks.camera ?? false }) });
}
export function normalizeReadingProtocol(input) {
    const protocol = normalize(boundedJson(input));
    // Defaulted fields belong to the retained/exported definition too. Inspect
    // the new owned tree, never serialize or invoke methods on the caller's input.
    boundedJson(protocol);
    return protocol;
}
export function normalizeReadingProtocols(input) {
    input = boundedJson(input);
    if (!Array.isArray(input) || input.length < 1 || input.length > MAX_READING_PROTOCOLS) invalid('use one to thirty-two reading protocols');
    const protocols = input.map(normalize);
    if (new Set(protocols.map(value => value.id)).size !== protocols.length) invalid('protocol identifiers must be unique');
    boundedJson(protocols);
    return Object.freeze(protocols);
}
