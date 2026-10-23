import EASI from '@xinonix/easi-js';
import { NodeDimseQueryRetrieveSourceTransport } from '@xinonix/easi-js/dimse/node';
import { validateDicomUid, MAX_METADATA_BYTES } from '../../src/data/DicomWebClient.js';
import { getAttributeVR } from '../../src/data/attributes.js';

export const DIMSE_GATEWAY_LIMITS = Object.freeze({ encodedBytes: 256 * 1024 * 1024, metadataBytes: MAX_METADATA_BYTES,
    maxResults: 10000, maxConcurrent: 2, operationTimeoutMs: 60000 });
const STUDY_KEYS = { '0020000D': 'UI', '00080020': 'DA', '00080050': 'SH', '00080061': 'CS', '00081030': 'LO',
    '00100010': 'PN', '00100020': 'LO', '00100021': 'LO', '00100030': 'DA', '00201206': 'IS', '00201208': 'IS' };
const SERIES_KEYS = { '0020000D': 'UI', '0020000E': 'UI', '00080060': 'CS', '0008103E': 'LO', '00200011': 'IS', '00201209': 'IS' };
const FILTERS = { PatientID: '00100020', PatientName: '00100010', PatientBirthDate: '00100030', IssuerOfPatientID: '00100021',
    StudyDate: '00080020', AccessionNumber: '00080050', ModalitiesInStudy: '00080061', StudyInstanceUID: '0020000D' };
const TEXT_VRS = new Set('AE AS CS DA DS DT IS LO LT PN SH ST TM UC UI UR UT'.split(' '));
const BINARY_VRS = new Set('OB OD OF OL OV OW UN'.split(' '));
const NUMBER_VRS = { US: [2, 'getUint16'], SS: [2, 'getInt16'], UL: [4, 'getUint32'], SL: [4, 'getInt32'],
    FL: [4, 'getFloat32'], FD: [8, 'getFloat64'], SV: [8, 'getBigInt64'], UV: [8, 'getBigUint64'] };
const PIXELS = new Set(['7FE00008', '7FE00009', '7FE00010']);
const error = (status, message) => Object.assign(new Error(message), { status });

function plain(value) { return value && typeof value === 'object' && [null, Object.prototype].includes(Object.getPrototypeOf(value)); }
function short(value) { return typeof value === 'string' && value.length <= 256 && !/[\x00-\x1f\x7f]/u.test(value); }
function uid(value) { try { return validateDicomUid(value); } catch { throw error(400, 'Use valid DICOM UIDs.'); } }
function bytes(attribute) {
    const result = attribute.access();
    if (!(result instanceof Uint8Array)) throw error(502, 'The DIMSE peer returned invalid attribute bytes.');
    return result;
}
function text(attribute, charset) {
    const affected = ['LO', 'LT', 'PN', 'SH', 'ST', 'UC', 'UT'].includes(getAttributeVR(attribute));
    const encoding = !affected || !charset || ['ISO_IR 6', 'ISO_IR 192'].includes(charset) ? 'utf-8'
        : charset === 'ISO_IR 100' ? 'iso-8859-1' : null;
    if (!encoding) throw error(502, 'This DIMSE gateway does not support the returned character set.');
    try { return new TextDecoder(encoding, { fatal: true }).decode(bytes(attribute)).replace(/\0+$/u, '').trimEnd(); }
    catch (failure) { if (failure.status) throw failure; throw error(502, 'The DIMSE peer returned invalid text encoding.'); }
}

/** Complete recursive DICOM JSON metadata, with pixels represented only by an inert
 * BulkDataURI. The browser always retrieves the original instance, never this URI. */
export function dimseMetadata(instance) {
    function convert(set, inherited = '', depth = 0) {
        if (depth > 32 || !Array.isArray(set?.attributes)) throw error(502, 'The DIMSE metadata nesting exceeds its limit.');
        const charsetAttribute = set.attributes.find(attribute => attribute.tag.ID === '00080005');
        const charset = charsetAttribute ? text(charsetAttribute, '') : inherited;
        const output = {};
        for (const attribute of set.attributes) {
            const id = attribute.tag.ID, vr = getAttributeVR(attribute);
            if (!/^[0-9A-F]{8}$/u.test(id) || id.slice(4) === '0000') continue;
            if (PIXELS.has(id)) { output[id] = { vr, BulkDataURI: 'urn:easi-view:dimse:pixel-data' }; continue; }
            if (vr === 'SQ') { output[id] = { vr, Value: attribute.items.map(item => convert(item, charset, depth + 1)) }; continue; }
            const raw = bytes(attribute);
            if (!raw.length) { output[id] = { vr }; continue; }
            if (BINARY_VRS.has(vr)) {
                output[id] = { vr, InlineBinary: Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength).toString('base64') };
            } else if (TEXT_VRS.has(vr)) {
                const values = text(attribute, charset).split('\\');
                output[id] = { vr, Value: vr === 'PN' ? values.map(value => {
                    const [Alphabetic, Ideographic, Phonetic] = value.split('=');
                    return Object.fromEntries(Object.entries({ Alphabetic, Ideographic, Phonetic }).filter(([, item]) => item));
                }) : values };
            } else if (NUMBER_VRS[vr]) {
                const [width, read] = NUMBER_VRS[vr], view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
                if (raw.byteLength % width) throw error(502, 'The DIMSE peer returned invalid numeric attribute bytes.');
                const values = [];
                for (let offset = 0; offset < raw.byteLength; offset += width) {
                    const value = view[read](offset, attribute.transferSyntax?.IsLittleEndian !== false);
                    // Preserve exact integer text for 64-bit values outside JSON's numeric range.
                    if (typeof value === 'bigint') values.push(String(value));
                    else if (!Number.isFinite(value)) throw error(502, 'The DIMSE peer returned invalid numeric attribute values.');
                    else values.push(value);
                }
                output[id] = { vr, Value: values };
            } else if (vr === 'AT') {
                if (raw.byteLength % 4) throw error(502, 'The DIMSE peer returned invalid attribute tags.');
                const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength), little = attribute.transferSyntax?.IsLittleEndian !== false;
                const values = [];
                for (let offset = 0; offset < raw.byteLength; offset += 4) values.push(
                    view.getUint16(offset, little).toString(16).padStart(4, '0').toUpperCase() + view.getUint16(offset + 2, little).toString(16).padStart(4, '0').toUpperCase());
                output[id] = { vr, Value: values };
            } else throw error(502, 'The DIMSE peer returned an unsupported attribute representation.');
        }
        return output;
    }
    return convert(instance.dataSet);
}

function route(url, basePath) {
    if (!url.pathname.startsWith(`${basePath}/`)) throw error(404, 'Not Found');
    const path = url.pathname.slice(basePath.length + 1), parts = path.split('/');
    if (path === 'studies') return { kind: 'studies' };
    if (parts[0] !== 'studies' || parts[2] !== 'series' || ![3, 5, 6].includes(parts.length)) throw error(404, 'Not Found');
    const studyUid = uid(parts[1]);
    if (parts.length === 3) return { kind: 'series', studyUid };
    const seriesUid = uid(parts[3]);
    if (parts.length === 5 && parts[4] === 'metadata') return { kind: 'metadata', studyUid, seriesUid };
    if (parts.length === 6 && parts[4] === 'instances') return { kind: 'instance', studyUid, seriesUid, sopUid: uid(parts[5]) };
    throw error(404, 'Not Found');
}

function queryOptions(url, resource) {
    const allowed = resource.kind === 'studies' ? [...Object.keys(FILTERS), 'offset', 'limit', 'includefield']
        : resource.kind === 'series' ? ['offset', 'limit', 'includefield'] : [];
    for (const key of url.searchParams.keys()) if (!allowed.includes(key) || url.searchParams.getAll(key).length !== 1) {
        throw error(400, 'Use supported gateway search parameters once each.');
    }
    if (url.searchParams.has('includefield') && (url.searchParams.get('includefield').length > 512 ||
        !/^[0-9A-F]{8}(?:,[0-9A-F]{8})*$/u.test(url.searchParams.get('includefield')))) {
        throw error(400, 'Use DICOM tag identifiers for return fields.');
    }
    const offset = Number(url.searchParams.get('offset') ?? 0), limit = Number(url.searchParams.get('limit') ?? 25);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 10000 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
        throw error(400, 'Use a bounded gateway result page.');
    }
    const keys = {};
    for (const [name, tag] of Object.entries(FILTERS)) if (url.searchParams.has(name)) {
        const value = url.searchParams.get(name);
        if (!short(value)) throw error(400, 'Use short text search criteria.');
        if (tag === '0020000D' && value) uid(value);
        keys[tag] = value;
    }
    return { offset, limit, keys };
}

function wait(operation, signal) {
    if (signal.aborted) return Promise.reject(new DOMException('The gateway request was canceled.', 'AbortError'));
    return new Promise((resolve, reject) => {
        const canceled = () => reject(new DOMException('The gateway request was canceled.', 'AbortError'));
        signal.addEventListener('abort', canceled, { once: true });
        Promise.resolve(operation).then(value => { signal.removeEventListener('abort', canceled); resolve(value); }, failure => {
            signal.removeEventListener('abort', canceled); reject(failure);
        });
    });
}

/** Fixed peer, read-only research gateway. Authorization is supplied by the host;
 * no request can choose another host, AE title, port, file path or retrieve model. */
export function createDimseGateway({ association, publicOrigin, authorize, transportFactory = () => new NodeDimseQueryRetrieveSourceTransport(),
    basePath = '/dimse', limits = DIMSE_GATEWAY_LIMITS } = {}) {
    if (!plain(association) || Object.keys(association).some(key => !['host', 'port', 'callingAeTitle', 'calledAeTitle'].includes(key)) ||
        !short(association.host) || !association.host || !Number.isInteger(association.port) || association.port < 1 || association.port > 65535 ||
        ['callingAeTitle', 'calledAeTitle'].some(key => typeof association[key] !== 'string' || !association[key].trim() || association[key].length > 16 || /[^\x20-\x7E]|\\/u.test(association[key])) ||
        typeof publicOrigin !== 'string' || new URL(publicOrigin).origin !== publicOrigin || typeof authorize !== 'function' ||
        typeof transportFactory !== 'function' || !/^\/[a-zA-Z0-9_-]+$/u.test(basePath) || !plain(limits) ||
        Object.keys(limits).some(key => !Object.hasOwn(DIMSE_GATEWAY_LIMITS, key)) || Object.keys(DIMSE_GATEWAY_LIMITS).some(key =>
            !Number.isSafeInteger(limits[key]) || limits[key] < 1 || limits[key] > DIMSE_GATEWAY_LIMITS[key])) {
        throw new TypeError('Configure a fixed DIMSE peer, exact public origin, authorization callback and bounded gateway limits.');
    }
    const peer = Object.freeze({ ...association });
    let active = 0;
    const handler = async (request, response) => {
        let acquired = false, timer;
        const controller = new AbortController();
        const canceled = () => { if (!response.writableEnded) controller.abort(); };
        response.on('close', canceled); request.on('aborted', canceled);
        response.setHeader('Cache-Control', 'no-store'); response.setHeader('Referrer-Policy', 'no-referrer');
        response.setHeader('X-Content-Type-Options', 'nosniff');
        try {
            if (request.headers.origin && request.headers.origin !== publicOrigin) throw error(403, 'This viewer origin is not allowed.');
            if (request.headers.origin === publicOrigin) {
                response.setHeader('Access-Control-Allow-Origin', publicOrigin);
                response.setHeader('Vary', 'Origin');
                response.setHeader('Access-Control-Expose-Headers', 'Warning');
            }
            const url = new URL(request.url, 'http://gateway.invalid'), resource = route(url, basePath), paging = queryOptions(url, resource);
            if (request.method === 'OPTIONS') {
                response.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
                response.setHeader('Access-Control-Allow-Headers', 'Accept, Authorization');
                response.writeHead(204); response.end(); return;
            }
            if (request.method !== 'GET') throw error(405, 'This DIMSE gateway supports read-only GET requests.');
            timer = setTimeout(() => controller.abort(), limits.operationTimeoutMs);
            let authorized = false;
            try { authorized = await wait(authorize({ authorization: request.headers.authorization ?? '', method: request.method,
                path: url.pathname, query: Object.fromEntries(url.searchParams), resource: { ...resource }, signal: controller.signal }), controller.signal) === true; }
            catch { if (controller.signal.aborted) throw new DOMException('Canceled', 'AbortError'); }
            if (!authorized) throw error(403, 'Access to this DIMSE gateway was not authorized.');
            if (active >= limits.maxConcurrent) throw error(429, 'The DIMSE gateway is busy. Try again after the current requests finish.');
            active++; acquired = true;
            const transport = transportFactory(), retrieve = ['metadata', 'instance'].includes(resource.kind);
            const vr = resource.kind === 'studies' ? STUDY_KEYS : SERIES_KEYS;
            const keys = retrieve ? {} : { ...Object.fromEntries(Object.keys(vr).map(key => [key, ''])), ...paging.keys };
            if (resource.studyUid) keys['0020000D'] = resource.studyUid;
            if (resource.seriesUid) keys['0020000E'] = resource.seriesUid;
            if (resource.sopUid) keys['00080018'] = resource.sopUid;
            const options = { operation: retrieve ? 'c-get' : 'c-find', performFind: false, queryRetrieveModel: 'study-root',
                queryRetrieveLevel: resource.kind === 'studies' ? 'STUDY' : resource.kind === 'instance' ? 'IMAGE' : 'SERIES', keys,
                keyVrs: { ...STUDY_KEYS, ...SERIES_KEYS, '00080018': 'UI' }, signal: controller.signal,
                operationTimeoutMs: limits.operationTimeoutMs, maxDataSetBytes: limits.encodedBytes, maxTotalDataSetBytes: limits.encodedBytes };
            if (resource.kind === 'instance' && /transfer-syntax=1\.2\.840\.10008\.1\.2\.1(?:[,;\s]|$)/u.test(request.headers.accept ?? '')) {
                options.storageTransferSyntaxUids = ['1.2.840.10008.1.2.1'];
            }
            const envelope = await wait(transport.read(peer, options), controller.signal);
            const status = envelope?.metadata?.dimse?.finalResponse?.status ?? 0;
            if (controller.signal.aborted) throw new DOMException('Canceled', 'AbortError');
            if (status !== 0 && (retrieve || (status & 0xF000) !== 0xB000)) throw error(502, 'The DIMSE peer did not complete this operation successfully.');
            if (envelope?.contentLength > limits.encodedBytes) throw error(502, 'The DIMSE result exceeds its encoded byte limit.');
            const payload = envelope?.source ?? envelope?.data ?? envelope?.stream;
            if (resource.kind === 'instance') {
                if (envelope?.empty || envelope?.metadata?.count !== 1 || !payload) throw error(502, 'DIMSE RetrieveInstance must return exactly one instance.');
                const contentType = typeof envelope.contentType === 'string' ? envelope.contentType : '';
                if (!/^application\/dicom(?:;|$)/iu.test(contentType)) throw error(502, 'The DIMSE peer did not return one DICOM instance.');
                // The DIMSE transport buffers before returning. Enforce the bound before HTTP output.
                if (!(payload instanceof Uint8Array) || payload.byteLength > limits.encodedBytes) throw error(502, 'The DIMSE instance exceeds its encoded byte limit.');
                response.setHeader('Content-Type', contentType); response.end(payload); return;
            }
            let instances = [];
            if (!envelope?.empty) {
                const result = await wait(EASI.pipelineBuilder().fromPartStream().ofDicomData().toInstances().build().process({
                    source: payload, sourceOptions: { contentType: envelope.contentType }
                }), controller.signal);
                instances = result.toArray();
            }
            if (instances.length > limits.maxResults) throw error(502, 'The DIMSE result exceeds its result-count limit. Narrow the search.');
            let metadata = instances.map(dimseMetadata);
            const parent = (item, tag, expected) => item[tag]?.Value?.[0] === expected;
            if (resource.studyUid && metadata.some(item => !parent(item, '0020000D', resource.studyUid))) throw error(502, 'The DIMSE result does not match the requested study.');
            if (resource.seriesUid && metadata.some(item => !parent(item, '0020000E', resource.seriesUid))) throw error(502, 'The DIMSE result does not match the requested series.');
            if (!retrieve) {
                const tag = resource.kind === 'studies' ? '0020000D' : '0020000E';
                metadata.sort((a, b) => String(a[tag]?.Value?.[0] ?? '').localeCompare(String(b[tag]?.Value?.[0] ?? '')));
                metadata = metadata.slice(paging.offset, paging.offset + paging.limit);
            }
            const encoded = Buffer.from(JSON.stringify(metadata));
            if (encoded.byteLength > limits.metadataBytes) throw error(502, 'The DIMSE metadata exceeds its byte limit. Narrow the search.');
            if (status !== 0) response.setHeader('Warning', '299 gateway "The DIMSE peer returned partial search results."');
            response.setHeader('Content-Type', 'application/dicom+json'); response.end(encoded);
        } catch (failure) {
            if (response.destroyed) return;
            const status = failure?.name === 'AbortError' ? 504 : [400, 403, 404, 405, 429, 502].includes(failure?.status) ? failure.status : 502;
            response.setHeader('Content-Type', 'text/plain; charset=utf-8'); response.statusCode = status;
            response.end(status === 502 ? 'The DIMSE operation failed or returned unsupported metadata. Check the gateway configuration and peer capabilities.'
                : status === 504 ? 'The DIMSE gateway request was canceled or timed out.' : failure.message);
        } finally {
            if (acquired) active--;
            clearTimeout(timer); response.removeListener('close', canceled); request.removeListener('aborted', canceled);
        }
    };
    handler.getState = () => Object.freeze({ activeRequests: active });
    return handler;
}
