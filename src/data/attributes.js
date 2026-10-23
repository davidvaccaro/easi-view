// Display-only metadata. No EASI instance, byte buffer or bulk URI is retained.
export const MAX_ATTRIBUTE_ROWS = 4096;
export const MAX_ATTRIBUTE_DEPTH = 16;
export const MAX_ATTRIBUTE_VALUE_CHARS = 4096;
export const MAX_ATTRIBUTE_BYTES = 128 * 1024;
export const MAX_SESSION_ATTRIBUTE_BYTES = 2 * 1024 * 1024;
const encoder = new TextEncoder();
const DEFAULT_LIMITS = Object.freeze({ maxRows: MAX_ATTRIBUTE_ROWS, maxDepth: MAX_ATTRIBUTE_DEPTH,
    maxValueChars: MAX_ATTRIBUTE_VALUE_CHARS, maxBytes: MAX_ATTRIBUTE_BYTES });
const EMPTY_ROWS = Object.freeze([]);
const UNAVAILABLE = Object.freeze({ rows: EMPTY_ROWS, bytes: 0, truncated: true,
    reasons: Object.freeze(['byte-limit']), limits: Object.freeze({ ...DEFAULT_LIMITS, maxBytes: 0 }) });
const BINARY = new Set(['OB', 'OD', 'OF', 'OL', 'OV', 'OW', 'UN']);
const PIXELS = new Set(['7FE00010', '7FE00008', '7FE00009']);
const NUMERIC = { US: [2, 'getUint16'], SS: [2, 'getInt16'], UL: [4, 'getUint32'], SL: [4, 'getInt32'],
    FL: [4, 'getFloat32'], FD: [8, 'getFloat64'], UV: [8, 'getBigUint64'], SV: [8, 'getBigInt64'] };
// EASI 1.0.0's JSON adapter preserves values, but not an unknown tag's declared
// VR or BulkDataURI provenance. Keep only these two facts, not the raw JSON or
// the URI, on weakly held attributes while the client still has both trees.
const jsonMetadata = new WeakMap();

/** Register provenance from already validated, bounded DICOM JSON metadata. */
export function registerAttributeMetadata(instance, dataSet) {
    const invalid = () => { throw new Error('The archive returned invalid DICOM JSON metadata.'); };
    const visit = (parsed, input, depth = 0) => {
        if (!parsed || !Array.isArray(parsed.attributes) || !input || typeof input !== 'object' || Array.isArray(input) || depth > 32) invalid();
        for (const attribute of parsed.attributes) {
            const id = attribute?.tag?.ID;
            if (typeof id !== 'string' || !/^[0-9A-F]{8}$/u.test(id) || !Object.hasOwn(input, id)) invalid();
            const original = input[id];
            if (!original || typeof original !== 'object' || typeof original.vr !== 'string' || !/^[A-Z]{2}$/u.test(original.vr)) invalid();
            jsonMetadata.set(attribute, Object.freeze({ vr: original.vr, hasBulkDataURI: Object.hasOwn(original, 'BulkDataURI') }));
            if (original.vr !== 'SQ' || !Object.hasOwn(original, 'Value')) continue;
            if (!Array.isArray(original.Value) || !Array.isArray(attribute.items)) invalid();
            let index = 0;
            // The published adapter omits null SQ components and retains empty
            // objects. Align emitted item order without copying the input tree.
            for (const item of original.Value) {
                if (item === null) continue;
                if (index >= attribute.items.length) invalid();
                visit(attribute.items[index++], item, depth + 1);
            }
            if (index !== attribute.items.length) invalid();
        }
    };
    visit(instance?.dataSet, dataSet);
}

/** Read the declared VR without retaining JSON values or replacing EASI tags. */
export function getAttributeVR(attribute) {
    return jsonMetadata.get(attribute)?.vr ?? attribute?.vr?.ID ?? attribute?.tag?.VR?.ID ?? null;
}

function bound(value, maximum, minimum = 1) {
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new TypeError('Use bounded attribute display limits.');
    return value;
}
function limits(options) {
    return Object.freeze({ maxRows: bound(options.maxRows ?? MAX_ATTRIBUTE_ROWS, MAX_ATTRIBUTE_ROWS),
        maxDepth: bound(options.maxDepth ?? MAX_ATTRIBUTE_DEPTH, MAX_ATTRIBUTE_DEPTH),
        maxValueChars: bound(options.maxValueChars ?? MAX_ATTRIBUTE_VALUE_CHARS, MAX_ATTRIBUTE_VALUE_CHARS),
        maxBytes: bound(options.maxBytes ?? MAX_ATTRIBUTE_BYTES, MAX_ATTRIBUTE_BYTES, 0) });
}
function clipped(value, maximum) {
    const text = String(value);
    return text.length > maximum ? { value: text.slice(0, maximum - 1) + '…', truncated: true } : { value: text, truncated: false };
}
function override(attribute) { return Object.getOwnPropertyDescriptor(attribute, '_value')?.value; }
function length(attribute, raw) {
    if (ArrayBuffer.isView(raw)) return raw.byteLength;
    const declared = attribute.valueLength;
    return Number.isSafeInteger(declared) && declared >= 0 && declared !== 0xFFFFFFFF ? declared : null;
}
function readable(value, maximum, seen = new WeakSet(), depth = 0) {
    if (value == null) return { value: '(empty)', truncated: false };
    if (typeof value === 'string') return clipped(value, maximum);
    if (typeof value !== 'object') return clipped(value, maximum);
    if (ArrayBuffer.isView(value)) return { value: `Binary value · ${value.byteLength} bytes`, truncated: false };
    if (depth >= MAX_ATTRIBUTE_DEPTH) return { value: '(value depth limit)', truncated: true };
    if (seen.has(value)) return { value: '(cyclic value)', truncated: true };
    seen.add(value);
    let output = '', truncated = false;
    const append = text => { const available = maximum - output.length; if (text.length > available) { output += text.slice(0, Math.max(0, available - 1)) + '…'; truncated = true; } else output += text; };
    if (Array.isArray(value)) {
        for (let index = 0; index < value.length; index++) {
            if (output.length >= maximum) { truncated = true; break; }
            const part = readable(value[index], Math.max(1, maximum - output.length), seen, depth + 1);
            append((index ? '\\' : '') + part.value); truncated ||= part.truncated;
        }
    } else {
        // DICOM JSON Person Name component groups, or another small metadata object.
        const keys = Object.keys(value);
        for (let index = 0; index < keys.length; index++) {
            if (output.length >= maximum || index >= 16) { truncated = true; break; }
            const key = keys[index], part = readable(value[key], Math.max(1, maximum - output.length), seen, depth + 1);
            append((index ? ' · ' : '') + key + ': ' + part.value); truncated ||= part.truncated;
        }
    }
    seen.delete(value);
    return { value: output || '(empty)', truncated };
}
function characterSet(set, inherited = '') {
    const attr = set?.attributes?.find(value => value?.tag?.ID === '00080005');
    if (!attr) return inherited;
    const raw = override(attr);
    if (typeof raw === 'string') return raw.slice(0, 128).trim();
    if (Array.isArray(raw)) {
        let result = '';
        for (const component of raw) {
            if (result.length >= 128) break;
            result += (result ? '\\' : '') + String(component).slice(0, 128 - result.length);
        }
        return result.trim();
    }
    if (raw != null) return '(unavailable)';
    return attr.data instanceof Uint8Array ? new TextDecoder().decode(attr.data.subarray(0, 128)).replace(/\0/gu, '').trim() : '(unavailable)';
}
function display(attribute, id, vr, maximum, charset, provenance) {
    const raw = override(attribute), bytes = length(attribute, raw);
    const uri = provenance?.hasBulkDataURI === true || !provenance && typeof raw === 'string' && vr !== 'UN' && BINARY.has(vr);
    if (PIXELS.has(id)) return { kind: typeof raw === 'string' ? 'bulk' : 'binary', value: typeof raw === 'string' ? 'Pixel Data · bulk URI (not fetched)' :
        attribute.valueLength === 0xFFFFFFFF ? 'Encapsulated Pixel Data · undefined length' : `Pixel Data · ${bytes ?? 'unknown'} bytes (not displayed)`, truncated: false };
    if (uri || attribute.isBulkStreamed === true || attribute.isMaterialized === false || attribute.isStreamingBulkData === true) {
        return { kind: 'bulk', value: 'Deferred bulk data (not fetched)', truncated: false };
    }
    if (BINARY.has(vr) || ArrayBuffer.isView(raw)) {
        // Unknown/private JSON strings remain readable, but their encoded VR may
        // be absent in EASI1.0.0's materialized adapter result.
        if (vr === 'UN' && raw != null && !ArrayBuffer.isView(raw)) return { kind: 'value', ...readable(raw, maximum) };
        return { kind: 'binary', value: `Binary value · ${bytes ?? 'unknown'} bytes (not displayed)`, truncated: false };
    }
    if (raw != null) return { kind: 'value', ...readable(raw, maximum) };
    const data = attribute.data;
    if (!(data instanceof Uint8Array)) return { kind: 'value', value: '(unavailable)', truncated: false };
    if (NUMERIC[vr] || vr === 'AT') {
        const width = vr === 'AT' ? 4 : NUMERIC[vr][0], values = [], view = new DataView(data.buffer, data.byteOffset, data.byteLength);
        const little = attribute.transferSyntax?.IsLittleEndian !== false;
        let chars = 0, offset = 0;
        for (; offset + width <= data.byteLength; offset += width) {
            const value = vr === 'AT' ? `(${view.getUint16(offset, little).toString(16).padStart(4, '0')},${view.getUint16(offset + 2, little).toString(16).padStart(4, '0')})`
                : String(view[NUMERIC[vr][1]](offset, little));
            if ((chars += value.length + 1) > maximum) break;
            values.push(value);
        }
        const result = clipped(values.join('\\') || '(empty)', maximum);
        return { kind: 'value', ...result, truncated: result.truncated || offset !== data.byteLength };
    }
    // Decode only a bounded view of an already materialized textual attribute.
    const cap = maximum * 4, affected = ['LO', 'LT', 'PN', 'SH', 'ST', 'UC', 'UT'].includes(vr);
    const encoding = !affected || !charset || ['ISO_IR 6', 'ISO_IR 192'].includes(charset) ? 'utf-8' : charset === 'ISO_IR 100' ? 'iso-8859-1' : null;
    if (!encoding) return { kind: 'value', value: `Text value · ${data.byteLength} bytes · unsupported Specific Character Set`, truncated: true };
    const decoded = new TextDecoder(encoding, { fatal: true }).decode(data.subarray(0, cap), { stream: data.byteLength > cap }).replace(/\0/gu, '').trim();
    const result = clipped(decoded, maximum);
    return { kind: 'value', ...result, truncated: result.truncated || data.byteLength > cap };
}

class SnapshotBuilder {
    constructor(options) {
        this.limits = limits(options); this.rows = []; this.bytes = 2; this.reasons = new Set(); this.stopped = this.limits.maxBytes < 2;
        if (this.stopped) this.reasons.add('byte-limit');
    }
    add(input) {
        if (this.stopped) { this.reasons.add('byte-limit'); return false; }
        if (this.rows.length >= this.limits.maxRows) { this.reasons.add('row-limit'); this.stopped = true; return false; }
        const summary = clipped(input.value, this.limits.maxValueChars);
        if (summary.truncated) this.reasons.add('value-limit');
        let row = { ...input, ...summary, truncated: input.truncated || summary.truncated }, cost = encoder.encode(JSON.stringify(row)).byteLength + (this.rows.length ? 1 : 0);
        while (this.bytes + cost > this.limits.maxBytes && row.value.length > 1) {
            row = { ...row, value: row.value.slice(0, Math.floor(row.value.length / 2)) + '…', truncated: true };
            if (row.value.length <= 2) row.value = '…';
            cost = encoder.encode(JSON.stringify(row)).byteLength + (this.rows.length ? 1 : 0); this.reasons.add('byte-limit');
        }
        if (this.bytes + cost > this.limits.maxBytes) { this.reasons.add('byte-limit'); this.stopped = true; return false; }
        if (row.truncated) this.reasons.add('value-limit');
        this.rows.push(Object.freeze(row)); this.bytes += cost; return true;
    }
    finish() {
        if (!this.rows.length && this.reasons.has('byte-limit')) return UNAVAILABLE;
        return Object.freeze({ rows: Object.freeze(this.rows), bytes: this.bytes, truncated: Boolean(this.reasons.size),
            reasons: Object.freeze([...this.reasons]), limits: this.limits });
    }
}

/** Retain only bounded text rows, never raw buffers, instances or source URLs. */
export function createAttributeSnapshot(instance, options = {}) {
    const builder = new SnapshotBuilder(options), active = new WeakSet();
    const visit = (set, section, parent, depth, inherited = '') => {
        if (!set || !Array.isArray(set.attributes)) return;
        if (active.has(set)) { builder.reasons.add('cyclic-sequence'); return; }
        active.add(set);
        const charset = section === 'meta' ? '' : characterSet(set, inherited);
        for (const attribute of set.attributes) {
            if (builder.stopped) break;
            const id = String(attribute?.tag?.ID ?? '').toUpperCase();
            if (!/^[0-9A-F]{8}$/u.test(id)) { builder.reasons.add('invalid-tag'); continue; }
            const tag = `(${id.slice(0, 4).toLowerCase()},${id.slice(4).toLowerCase()})`, path = parent ? `${parent}/${tag}` : `${section}/${tag}`;
            const provenance = jsonMetadata.get(attribute);
            const vr = String(provenance?.vr ?? attribute.vr?.ID ?? attribute.tag?.VR?.ID ?? 'UN');
            const name = clipped(attribute.tag?.Name ?? 'Unknown Tag', 256).value;
            try {
                if (!PIXELS.has(id) && !provenance?.hasBulkDataURI && (vr === 'SQ' || Array.isArray(attribute.items))) {
                    const items = attribute.items ?? [], truncated = depth >= builder.limits.maxDepth && items.length > 0;
                    if (truncated) builder.reasons.add('depth-limit');
                    if (!builder.add({ section, path, depth, tag, name, vr: 'SQ', kind: 'sequence', value: `${items.length} item${items.length === 1 ? '' : 's'}${truncated ? ' · depth limit reached' : ''}`, truncated })) break;
                    if (!truncated) for (let index = 0; index < items.length && !builder.stopped; index++) {
                        const itemPath = `${path}/item[${index + 1}]`;
                        if (!builder.add({ section, path: itemPath, depth: depth + 1, tag: '(fffe,e000)', name: `Item ${index + 1}`, vr: 'ITEM', kind: 'item', value: '', truncated: false })) break;
                        visit(items[index], section, itemPath, depth + 1, charset);
                    }
                } else builder.add({ section, path, depth, tag, name, vr, ...display(attribute, id, vr, builder.limits.maxValueChars, charset, provenance) });
            } catch { builder.add({ section, path, depth, tag, name, vr, kind: 'value', value: '(unavailable)', truncated: true }); }
        }
        active.delete(set);
    };
    visit(instance?.metaSet, 'meta', '', 0); visit(instance?.dataSet, 'dataset', '', 0);
    return builder.finish();
}

/** Re-admit an existing immutable snapshot without keeping a second metadata copy. */
export function limitAttributeSnapshot(snapshot, maxBytes) {
    if (!snapshot) return null;
    bound(maxBytes, MAX_ATTRIBUTE_BYTES, 0);
    if (snapshot.bytes <= maxBytes) return snapshot;
    const builder = new SnapshotBuilder({ ...snapshot.limits, maxBytes });
    for (const reason of snapshot.reasons) builder.reasons.add(reason);
    builder.reasons.add('byte-limit');
    for (const row of snapshot.rows) if (!builder.add(row)) break;
    return builder.finish();
}
