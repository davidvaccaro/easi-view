export const MAX_LOCAL_WORKING_STACKS = 1024;
const DEFAULT_LIMITS = Object.freeze({ maxGroups: 128, maxStacks: MAX_LOCAL_WORKING_STACKS, maxFrames: 10000, maxBytes: 256 * 1024 * 1024 });
const selectedTooLarge = () => new Error('The selected view exceeds the local image budget. Open a smaller series, or choose smaller series for comparison (128 series, 1,024 image stacks, 10,000 frames and 256 MiB of encoded source data).');

function limitsFor(input) {
    if (!input || Object.getPrototypeOf(input) !== Object.prototype || Reflect.ownKeys(input).some(key => !Object.hasOwn(DEFAULT_LIMITS, key))) {
        throw new TypeError('Use supported local working-set limits.');
    }
    const result = { ...DEFAULT_LIMITS, ...input };
    for (const [key, value] of Object.entries(result)) if (!Number.isSafeInteger(value) || value < 0 || value > DEFAULT_LIMITS[key]) throw new TypeError('Local working-set limits must be bounded nonnegative safe integers.');
    return result;
}

function validateGroup(group) {
    if (!group || typeof group.id !== 'string' || !group.id || !Array.isArray(group.stacks) || !group.stacks.length ||
        group.stacks.some(stack => !stack || typeof stack !== 'object' || !Array.isArray(stack.frames))) {
        throw new TypeError('Use local series groups containing image stacks.');
    }
    return group;
}

function available(group) { return group.stacks.every(stack => !stack.disposed && stack.frames.length > 0); }
function sameStacks(first, second) {
    const a = new Set(first.stacks), b = new Set(second.stacks);
    return a.size === b.size && [...a].every(stack => b.has(stack));
}

/** Count retained backing allocations, including records shared by multiple viewing stacks. */
function footprint(groups) {
    const stacks = [...new Set(groups.flatMap(group => group.stacks))], buffers = new Set();
    let bytes = 0, frames = 0;
    for (const stack of stacks) {
        frames += stack.frames.length;
        if (stack._records instanceof Map) {
            for (const record of stack._records.values()) {
                if (!ArrayBuffer.isView(record?.bytes)) throw new TypeError('Local image records must expose retained encoded bytes.');
                const buffer = record.bytes.buffer;
                if (!buffers.has(buffer)) { buffers.add(buffer); bytes += buffer.byteLength; }
            }
        } else {
            // Non-file source doubles can expose a conservative standalone allocation.
            const retained = stack.sourceBytes;
            if (!Number.isSafeInteger(retained) || retained < 0) throw new TypeError('Local image source bytes must be nonnegative safe integers.');
            bytes += retained;
        }
        if (!Number.isSafeInteger(bytes) || !Number.isSafeInteger(frames)) throw new TypeError('Local image footprint exceeds safe integer accounting.');
    }
    return { stacks, bytes, frames };
}

/**
 * Plan a bounded resident cache without mutating or disposing its sources.
 * Catalog-series count and logical image-stack count are separate bounds.
 * Required catalog groups are atomic. Optional groups arrive newest first;
 * accepted groups return oldest first, with required groups promoted to newest.
 * `evicted` contains optional stacks absent from the final set, never shared survivors.
 * The caller releases those sources only after the selected view commits.
 */
export function planLocalWorkingSet(requiredGroups, optionalGroups = [], limits = {}) {
    if (!Array.isArray(requiredGroups) || !Array.isArray(optionalGroups)) throw new TypeError('Use arrays of local series groups.');
    const budget = limitsFor(limits), required = [], requiredIds = new Map(), optional = [], optionalIds = new Set();
    for (const input of requiredGroups) {
        const group = validateGroup(input), previous = requiredIds.get(group.id);
        if (previous) {
            if (!sameStacks(previous, group)) throw new Error('Choose one available revision of each selected local series.');
            continue;
        }
        if (!available(group)) throw new Error('The selected local series is no longer available. Choose it again from the patient timeline.');
        requiredIds.set(group.id, group); required.push(group);
    }
    for (const input of optionalGroups) {
        const group = validateGroup(input);
        if (requiredIds.has(group.id) || optionalIds.has(group.id)) continue;
        optionalIds.add(group.id);
        if (available(group)) optional.push(group);
    }
    const fits = groups => {
        const value = footprint(groups);
        return groups.length <= budget.maxGroups && value.stacks.length <= budget.maxStacks && value.frames <= budget.maxFrames && value.bytes <= budget.maxBytes;
    };
    if (!fits(required)) throw selectedTooLarge();
    const retained = [];
    for (const group of optional) if (fits([...required, ...retained, group])) retained.push(group);
    const groups = [...retained.reverse(), ...required], measured = footprint(groups), keep = new Set(measured.stacks);
    const evicted = [...new Set(optionalGroups.flatMap(group => group.stacks))].filter(stack => !keep.has(stack));
    return { groups, ...measured, evicted };
}
