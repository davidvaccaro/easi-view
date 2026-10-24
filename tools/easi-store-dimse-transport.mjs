// Local Store adapter for EASI's public transport extension point. The core
// client remains an independent dependency; no parser or transport is forked.
import EASI, { Tag } from '@xinonix/easi-js';
import { NodeDimseQueryRetrieveSourceTransport } from '@xinonix/easi-js/dimse/node';
import { validateDicomUid } from '../src/data/DicomWebClient.js';

export const STORE_ORIGINAL_SYNTAXES = Object.freeze([
    '1.2.840.10008.1.2.1', '1.2.840.10008.1.2', '1.2.840.10008.1.2.2', '1.2.840.10008.1.2.5',
    '1.2.840.10008.1.2.4.50', '1.2.840.10008.1.2.4.51', '1.2.840.10008.1.2.4.57', '1.2.840.10008.1.2.4.70',
    '1.2.840.10008.1.2.4.80', '1.2.840.10008.1.2.4.81', '1.2.840.10008.1.2.4.90', '1.2.840.10008.1.2.4.91'
]);
const UID_KEYS = ['0020000D', '0020000E', '00080018'];
const CLASS = '00080016';
const DISCOVERY_BYTES = 8 * 1024 * 1024;
const MAX_RESULTS = 10000;
function value(instance, tag) {
    const result = instance.dataSet.value(Tag.find(tag));
    if (typeof result !== 'string') throw new Error('The Store query omitted a required UID.');
    return validateDicomUid(result);
}
function item(type, body) {
    const header = Buffer.alloc(4); header[0] = type; header.writeUInt16BE(body.length, 2);
    return Buffer.concat([header, body]);
}
function items(bytes, start) {
    const result = [];
    for (let offset = start; offset < bytes.length;) {
        if (offset + 4 > bytes.length) throw new Error('Invalid generated association.');
        const length = bytes.readUInt16BE(offset + 2), end = offset + 4 + length;
        if (end > bytes.length) throw new Error('Invalid generated association length.');
        result.push({ type: bytes[offset], body: bytes.subarray(offset + 4, end) }); offset = end;
    }
    return result;
}

/** One request-scoped adapter. Discover the actual SOP classes, then offer each
 * original encoding in its own presentation context. A single context can
 * accept only one syntax and cannot retrieve a compressed/native mixed series. */
export class EasiStoreDimseTransport extends NodeDimseQueryRetrieveSourceTransport {
    readPeer(association, options) { return super.read(association, options); }

    async read(association, options = {}) {
        if (options.operation !== 'c-get') return this.readPeer(association, options);
        options.signal?.throwIfAborted();
        const keys = {};
        for (const tag of UID_KEYS) if (options.keys?.[tag]) keys[tag] = validateDicomUid(options.keys[tag]);
        if (!keys['0020000D'] || !keys['0020000E']) throw new Error('The local Store bridge retrieves a selected series or instance.');
        const discovery = await this.readPeer(association, { ...options, operation: 'c-find', performFind: false,
            queryRetrieveLevel: 'IMAGE', keys, returnKeys: [...UID_KEYS, CLASS],
            maxDataSetBytes: 262144, maxTotalDataSetBytes: DISCOVERY_BYTES });
        options.signal?.throwIfAborted();
        if (discovery?.metadata?.dimse?.finalResponse?.status !== 0) throw new Error('Store could not enumerate the requested image classes.');
        const parsed = discovery.empty ? [] : (await EASI.pipelineBuilder().fromPartStream().ofDicomData().toInstances().build().process({
            source: discovery.source ?? discovery.stream, sourceOptions: { contentType: discovery.contentType }
        })).toArray();
        if (parsed.length > MAX_RESULTS) throw new Error('The selected Store series exceeds the discovery limit.');
        const classes = new Set();
        for (const instance of parsed) {
            for (const tag of UID_KEYS) {
                const actual = value(instance, tag);
                if (keys[tag] && keys[tag] !== actual) throw new Error('Store returned an image outside the requested hierarchy.');
            }
            classes.add(value(instance, CLASS));
        }
        if (!classes.size) return { empty: true, source: new Uint8Array(), contentType: 'application/dicom', contentLength: 0,
            metadata: { count: 0, dimse: { finalResponse: { status: 0 } } } };
        const syntaxes = options.storageTransferSyntaxUids ?? STORE_ORIGINAL_SYNTAXES;
        if (!Array.isArray(syntaxes) || !syntaxes.length || syntaxes.some(syntax => !STORE_ORIGINAL_SYNTAXES.includes(syntax))) {
            throw new Error('The Store bridge requires supported original transfer syntaxes.');
        }
        if (classes.size * syntaxes.length + 2 > 128) throw new Error('The selected series contains too many SOP classes for one original-syntax association.');
        return this.readPeer(association, { ...options, performFind: false, storageSopClassUids: [...classes], storageTransferSyntaxUids: [...syntaxes] });
    }

    buildAssociateRq(association, model, options) {
        const original = super.buildAssociateRq(association, model, options);
        if (options.operation !== 'c-get') return original;
        const contexts = [];
        for (const context of original.contexts) {
            const variants = context.kind === 'store' ? context.transferSyntaxUids.map(syntax => [syntax]) : [context.transferSyntaxUids];
            for (const transferSyntaxUids of variants) contexts.push({ ...context, id: contexts.length * 2 + 1, transferSyntaxUids });
        }
        if (contexts.length > 128) throw new Error('The Store presentation-context limit was exceeded.');
        const bytes = Buffer.from(original.pdu), body = bytes.subarray(6), originalItems = items(body, 68);
        const presentation = contexts.map(context => item(0x20, Buffer.concat([Buffer.from([context.id, 0, 0, 0]),
            item(0x30, Buffer.from(context.abstractSyntaxUid)), ...context.transferSyntaxUids.map(syntax => item(0x40, Buffer.from(syntax)))])));
        let replaced = false;
        const rebuilt = Buffer.concat([body.subarray(0, 68), ...originalItems.flatMap(part => {
            if (part.type !== 0x20) return [item(part.type, part.body)];
            if (replaced) return [];
            replaced = true; return presentation;
        })]);
        const header = Buffer.alloc(6); header[0] = 1; header.writeUInt32BE(rebuilt.length, 2);
        return { ...original, pdu: new Uint8Array(Buffer.concat([header, rebuilt])), contexts };
    }
}
