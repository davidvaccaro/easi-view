import { normalizeReadingProtocol, objectKeys, plainObject, protocolInteger, protocolNumber, protocolError,
    READING_STRING_FIELDS, READING_NUMBER_FIELDS, READING_BOOLEAN_FIELDS, MAX_READING_CANDIDATES, MAX_READING_FRAMES } from './schema.js';
const fields = [...READING_STRING_FIELDS, ...READING_NUMBER_FIELDS, ...READING_BOOLEAN_FIELDS];
const monochrome = value => ['MONOCHROME1', 'MONOCHROME2'].includes(value);
const freeze = values => Object.freeze(values);
const invalid = reason => { throw protocolError(reason); };
const known = value => value != null && value !== '';
const equal = (first, second) => typeof first === 'string' && typeof second === 'string' ? first.toLowerCase() === second.toLowerCase() : first === second;

function candidatesFrom(input) {
    if (!Array.isArray(input) || input.length > MAX_READING_CANDIDATES) invalid('use at most one hundred twenty-eight distinct stack candidates');
    if (Reflect.ownKeys(input).length !== input.length + 1 || Array.from({ length: input.length }, (_, index) =>
        Object.getOwnPropertyDescriptor(input, String(index))).some(property => !property?.enumerable || !Object.hasOwn(property, 'value'))) invalid('use candidate arrays without accessors or extra fields');
    const seen = new Set();
    return input.map(input => {
        objectKeys(input, ['index', 'role', ...fields], 'use supported candidate metadata fields');
        const index = protocolInteger(input.index, 0, MAX_READING_CANDIDATES - 1, 'use bounded candidate indices');
        if (seen.has(index)) invalid('candidate indices must identify distinct stacks'); seen.add(index);
        const role = input.role ?? 'unassigned';
        if (!['unassigned', 'current', 'prior'].includes(role)) invalid('assign current or prior roles explicitly');
        const result = { index, role };
        for (const field of READING_STRING_FIELDS) {
            const value = input[field] ?? null;
            if (value !== null && (typeof value !== 'string' || value.length > (field === 'description' ? 512 : 64) || /[\x00-\x1f\x7f]/u.test(value))) invalid('use bounded text candidate metadata');
            result[field] = value;
        }
        for (const field of READING_NUMBER_FIELDS) result[field] = input[field] == null ? null : protocolNumber(input[field], 'use finite numeric candidate metadata');
        for (const field of READING_BOOLEAN_FIELDS) {
            if (input[field] != null && typeof input[field] !== 'boolean') invalid('use boolean candidate metadata');
            result[field] = input[field] ?? null;
        }
        if (result.frameCount != null) protocolInteger(result.frameCount, 1, MAX_READING_FRAMES, 'use a bounded candidate frame count');
        for (const field of ['rows', 'columns']) if (result[field] != null) protocolInteger(result[field], 1, 65535, 'use positive image dimensions');
        return freeze(result);
    }).sort((a, b) => a.index - b.index);
}
function optionsFrom(input, candidates, protocol) {
    objectKeys(input, ['selectedIndex', 'activeFrames', 'overrides'], 'use supported evaluation options');
    const indices = new Set(candidates.map(value => value.index)), selectedIndex = input.selectedIndex ?? null;
    if (selectedIndex !== null) {
        protocolInteger(selectedIndex, 0, MAX_READING_CANDIDATES - 1, 'use a bounded selected stack index');
        if (!indices.has(selectedIndex)) invalid('the selected stack must be a current candidate');
    }
    const activeFrames = input.activeFrames ?? {}, overrides = input.overrides ?? {};
    if (!plainObject(activeFrames) || Reflect.ownKeys(activeFrames).length > MAX_READING_CANDIDATES) invalid('use bounded active frame indices');
    for (const key of Reflect.ownKeys(activeFrames)) {
        if (typeof key !== 'string' || !/^(?:0|[1-9]\d*)$/u.test(key) || !indices.has(Number(key))) invalid('active frames must reference current candidates');
        const property = Object.getOwnPropertyDescriptor(activeFrames, key);
        if (!property?.enumerable || !Object.hasOwn(property, 'value')) invalid('active frame indices must be JSON values');
        protocolInteger(property.value, 0, MAX_READING_FRAMES - 1, 'use bounded zero-based active frame indices');
    }
    objectKeys(overrides, protocol.selectors.map(value => value.id), 'override only declared selectors');
    for (const value of Object.values(overrides)) {
        protocolInteger(value, 0, MAX_READING_CANDIDATES - 1, 'use bounded override indices');
        if (!indices.has(value)) invalid('override only current stack candidates');
    }
    return { selectedIndex, activeFrames, overrides };
}
function matches(rule, value) {
    if (rule.op === 'exists') return known(value) === rule.value;
    if (!known(value)) return false;
    if (rule.op === 'eq') return equal(value, rule.value);
    if (rule.op === 'in') return rule.value.some(item => equal(item, value));
    if (rule.op === 'contains') return value.toLowerCase().includes(rule.value.toLowerCase());
    return value >= rule.value[0] && value <= rule.value[1];
}
function scoreCandidate(selector, candidate, slots, options, excluded, blocked) {
    const reasonCodes = [], reason = code => { if (!reasonCodes.includes(code)) reasonCodes.push(code); };
    let eligible = true, score = 0;
    if (blocked) { eligible = false; reason('dependency-unresolved'); }
    if (selector.scope === 'selected' ? candidate.index !== options.selectedIndex : selector.scope !== 'all' && candidate.role !== selector.scope) {
        eligible = false; reason('outside-selector-scope');
    }
    if (excluded.has(candidate.index)) { eligible = false; reason('stack-must-be-distinct'); }
    if (candidate.frameCount == null) { eligible = false; reason('missing-frame-count'); }
    for (const rule of selector.rules) {
        if (matches(rule, candidate[rule.field])) score += rule.weight;
        else {
            if (rule.required) eligible = false;
            reason(`${rule.required ? 'rule' : 'preference'}-${known(candidate[rule.field]) ? 'mismatch' : 'missing'}:${rule.field}`);
        }
    }
    for (const slot of slots) if (slot.window) {
        if (!monochrome(candidate.photometric)) { eligible = false; reason('window-requires-monochrome'); }
        if (slot.windowUnit !== null && candidate.unit !== slot.windowUnit) { eligible = false; reason('window-unit-mismatch'); }
    }
    return freeze({ index: candidate.index, eligible, score, reasonCodes: freeze(reasonCodes) });
}
function selectFrame(slot, candidate, options) {
    if (slot.frame.mode === 'first') return 0;
    if (slot.frame.mode === 'middle') return Math.floor((candidate.frameCount - 1) / 2);
    if (slot.frame.mode === 'index') return slot.frame.index;
    return options.activeFrames[candidate.index] ?? null;
}

/** Pure metadata planning: each candidate is one already partitioned stack.
 * Matching never merges candidates, guesses study roles or reads pixel data. */
export function evaluateReadingProtocol(input, inputCandidates, inputOptions = {}) {
    const protocol = normalizeReadingProtocol(input), candidates = candidatesFrom(inputCandidates), options = optionsFrom(inputOptions, candidates, protocol);
    const byIndex = new Map(candidates.map(value => [value.index, value])), resolved = new Map(), selectors = [];
    for (const selector of protocol.selectors) {
        const dependencies = selector.distinctFrom.map(id => resolved.get(id)), blocked = dependencies.some(value => value.status !== 'matched');
        const excluded = new Set(dependencies.filter(value => value.status === 'matched').map(value => value.matchedIndex));
        const selectorSlots = protocol.slots.filter(slot => slot.selector === selector.id);
        const scores = candidates.map(candidate => scoreCandidate(selector, candidate, selectorSlots, options, excluded, blocked));
        const eligible = scores.filter(value => value.eligible), manual = Object.hasOwn(options.overrides, selector.id);
        let status = blocked ? 'blocked' : 'missing', matchedIndex = null, reasonCodes = blocked ? ['dependency-unresolved'] : ['no-eligible-candidates'];
        if (manual) {
            const chosen = scores.find(value => value.index === options.overrides[selector.id]);
            if (!chosen.eligible) invalid('manual override is not eligible for its selector');
            status = 'matched'; matchedIndex = chosen.index; reasonCodes = ['manual-override'];
        } else if (eligible.length) {
            const best = Math.max(...eligible.map(value => value.score)), winners = eligible.filter(value => value.score === best);
            if (winners.length === 1) { status = 'matched'; matchedIndex = winners[0].index; reasonCodes = ['unique-best-match']; }
            else { status = 'ambiguous'; reasonCodes = ['equal-ranked-candidates']; }
        } else if (!blocked && selector.scope === 'selected' && options.selectedIndex === null) reasonCodes = ['no-selected-stack'];
        const result = freeze({ id: selector.id, status, matchedIndex, candidates: freeze(scores), reasonCodes: freeze(reasonCodes), manual });
        selectors.push(result); resolved.set(selector.id, result);
    }
    const slots = protocol.slots.map(slot => {
        const selected = resolved.get(slot.selector), candidate = selected.matchedIndex === null ? null : byIndex.get(selected.matchedIndex);
        let status = selected.status === 'matched' ? 'ready' : selected.status, frameIndex = null, reasonCodes = [...selected.reasonCodes];
        if (candidate) {
            frameIndex = selectFrame(slot, candidate, options);
            if (frameIndex === null || frameIndex >= candidate.frameCount) { status = 'frame-unavailable'; frameIndex = null; reasonCodes = [slot.frame.mode === 'active' ? 'active-frame-unavailable' : 'frame-index-out-of-range']; }
        }
        return freeze({ id: slot.id, selector: slot.selector, status, candidateIndex: selected.matchedIndex, frameIndex,
            window: slot.window, windowUnit: slot.windowUnit, reasonCodes: freeze(reasonCodes) });
    });
    return freeze({ version: 1, protocolId: protocol.id, layout: protocol.layout, links: protocol.links,
        status: slots.every(slot => slot.status === 'ready') ? 'ready' : 'unresolved', selectors: freeze(selectors), slots: freeze(slots) });
}
