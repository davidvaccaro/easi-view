import EASI from '@xinonix/easi-js';
import { catalogError, checkCatalogAbort, validCatalogUid, NAVIGATION_DESCRIPTION_WARNING } from './metadata.js';
import { getLocalRelativePath, isDicomDirectory } from './local-paths.js';

export const MAX_DIRECTORY_BYTES = 16 * 1024 * 1024;
export const MAX_DIRECTORY_RECORDS = 30000;
const MAX_FILES = 30000, MAX_DIRECTORY_TOTAL_BYTES = 32 * 1024 * 1024;
const DIRECTORY_SOP = '1.2.840.10008.1.3.10', EXPLICIT_LE = '1.2.840.10008.1.2.1';
const FIELDS = Object.freeze({
    '00080005': 'charset', '00080020': 'studyDate', '00080030': 'studyTime',
    '00080060': 'modality', '00081030': 'studyDescription', '0008103E': 'seriesDescription',
    '00100010': 'patientName', '00100020': 'patientId', '00100021': 'issuerOfPatientId',
    '00100030': 'patientBirthDate', '0020000D': 'studyUid', '0020000E': 'seriesUid'
});
const TEXT = new Set(['00020002', '00020003', '00020010', '00041430', '00041500', '00041510', '00041511', '00041512', ...Object.keys(FIELDS)]);
const NUMBERS = new Map([['00041200', 4], ['00041202', 4], ['00041212', 2], ['00041400', 4], ['00041410', 2], ['00041420', 4]]);
const ROOT_TYPES = new Set(['PATIENT', 'HANGING PROTOCOL', 'PALETTE', 'IMPLANT', 'IMPLANT ASSY', 'IMPLANT GROUP', 'INVENTORY', 'PRIVATE']);
const LEAF_TYPES = new Set(['IMAGE', 'RT DOSE', 'RT STRUCTURE SET', 'RT PLAN', 'RT TREAT RECORD', 'PRESENTATION',
    'WAVEFORM', 'SR DOCUMENT', 'KEY OBJECT DOC', 'SPECTROSCOPY', 'RAW DATA', 'REGISTRATION', 'FIDUCIAL', 'ENCAP DOC',
    'VALUE MAP', 'STEREOMETRIC', 'PLAN', 'MEASUREMENT', 'SURFACE', 'SURFACE SCAN', 'TRACT', 'ASSESSMENT',
    'RADIOTHERAPY', 'ANNOTATION', 'WF PRESENTATION']);
const SIDECAR = /(?:^\.|\.(?:txt|pdf|rtf|html?|css|js|json|xml|ini|inf|exe|dll|bat|cmd|sh|png|jpe?g|gif|ico|bmp|zip|rar|7z|md|csv|log)$)/iu;
const WARNINGS = Object.freeze({
    case: 'A referenced filename required a unique case-insensitive match.',
    path: 'A referenced File ID uses nonstandard filename characters or component lengths.',
    inactive: 'Retired inactive directory records were skipped.',
    flag: 'A reserved nonzero record flag was interpreted as active.',
    unreachable: 'Unlinked directory records were ignored.',
    missing: 'Some referenced files are absent. Select the complete media folder.',
    ambiguous: 'Some referenced filenames are ambiguous and were skipped.',
    invalid: 'Some unsafe, duplicate, or invalid file references were skipped.',
    unsupported: 'Non-image directory references were skipped by the local media image importer.',
    private: 'Private directory records have no standardized clinical hierarchy; their own file metadata will be used.',
    lastRoot: 'The DICOMDIR last-root pointer was inconsistent. Verified forward directory links were used.',
    descriptionEncoding: NAVIGATION_DESCRIPTION_WARNING
});

function invalid(message = 'The DICOMDIR index is invalid. Choose a complete, valid DICOM media folder.') {
    return catalogError('dicomdir-invalid', message);
}
function isSidecar(file) { return SIDECAR.test(String(file?.name || '')); }
function isBookkeeping(file) { return /^(?:\.DS_Store|thumbs\.db|desktop\.ini)$/iu.test(String(file?.name || '')); }
function addWarning(report, key) { if (!report.warnings.includes(WARNINGS[key])) report.warnings.push(WARNINGS[key]); }
function decode(data, charset = '', encoded = false, onInvalidEncoding) {
    if (!(data instanceof Uint8Array)) return '';
    const encoding = !encoded || !charset || charset === 'ISO_IR 6' || charset === 'ISO_IR 192' ? 'utf-8'
        : charset === 'ISO_IR 100' ? 'iso-8859-1' : null;
    if (!encoding) throw invalid('The DICOMDIR uses an unsupported text character set.');
    let value;
    try { value = new TextDecoder(encoding, { fatal: true }).decode(data).replace(/\0+$/gu, '').trim(); }
    catch {
        if (onInvalidEncoding) { onInvalidEncoding(); return ''; }
        throw invalid('The DICOMDIR contains invalid text encoding.');
    }
    if (value.length > 512 || /[\u0000-\u001f\u007f]/u.test(value)) throw invalid('The DICOMDIR contains invalid or excessive navigation text.');
    return value;
}
function number(values, id, { optional = false } = {}) {
    const data = values.get(id), length = NUMBERS.get(id);
    if (!data && optional) return 0;
    if (!(data instanceof Uint8Array) || data.byteLength !== length) throw invalid('The DICOMDIR has a missing or invalid directory offset or flag.');
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    return length === 4 ? view.getUint32(0, true) : view.getUint16(0, true);
}

/** Keep only scalar navigation data. EASI owns all DICOM syntax parsing,
 * including defined/undefined sequence lengths and nested icon image data. */
class DirectoryHandler {
    parser = null;
    onStartInstance() { return { root: new Map(), records: [], stack: [], attributes: 0, sequences: 0, complete: false }; }
    onStartSequence(context, sequence) {
        if (context.stack.length > 32 || ++context.sequences > 120000) throw invalid('The DICOMDIR exceeds its sequence complexity limit.');
        if (sequence.tag.ID === '00041220') {
            if (context.stack.length || context.hasDirectorySequence) throw invalid('The DICOMDIR contains an invalid Directory Record Sequence.');
            context.hasDirectorySequence = true;
        }
        context.stack.push({ kind: 'sequence', tag: sequence.tag.ID });
    }
    onStartItem(context) {
        const direct = context.stack.length === 1 && context.stack[0].tag === '00041220';
        const values = direct ? new Map() : null;
        if (direct) {
            if (context.records.length >= MAX_DIRECTORY_RECORDS) throw invalid('The DICOMDIR exceeds the 30,000-record limit.');
            const offset = this.parser.totalBytesConsumed - 8;
            if (!Number.isSafeInteger(offset) || offset < 132) throw invalid();
            context.records.push({ offset, values });
        }
        context.stack.push({ kind: 'item', values });
    }
    onStartAttribute(context, attribute) {
        if (++context.attributes > 500000 || attribute.valueLength > 1024 * 1024) throw invalid('The DICOMDIR exceeds its attribute limits.');
        const wanted = TEXT.has(attribute.tag.ID) || NUMBERS.has(attribute.tag.ID);
        if (wanted && attribute.valueLength > 2048) throw invalid('A DICOMDIR navigation value exceeds its size limit.');
    }
    onEndAttribute(context, attribute) {
        const id = attribute.tag.ID;
        if (!TEXT.has(id) && !NUMBERS.has(id)) return;
        const target = context.stack.length === 0 ? context.root
            : context.stack.length === 2 ? context.stack[1].values : null;
        if (!target) return;
        if (target.has(id)) throw invalid('The DICOMDIR repeats a navigation attribute.');
        if (!(attribute.data instanceof Uint8Array)) throw invalid('The DICOMDIR contains an unsupported navigation value.');
        target.set(id, attribute.data);
    }
    onEndItem(context) { if (context.stack.pop()?.kind !== 'item') throw invalid(); }
    onEndSequence(context) { if (context.stack.pop()?.kind !== 'sequence') throw invalid(); }
    onEndInstance(context) { context.complete = true; return context; }
}

function boundedDirectorySource(file, signal) {
    let reader = null, controller = null, closed = false, consumed = 0;
    const release = () => { signal?.removeEventListener('abort', abort); try { reader?.releaseLock(); } catch {} };
    const cancel = async reason => {
        if (closed) return;
        closed = true;
        try { await reader?.cancel(reason); } catch {}
        release();
    };
    const abort = () => { if (!closed) { controller?.error(new DOMException('Local media import was canceled.', 'AbortError')); void cancel(); } };
    return { size: file.size, type: 'application/dicom', stream: () => new ReadableStream({
        start(value) {
            controller = value;
            reader = file.stream().getReader();
            signal?.addEventListener('abort', abort, { once: true });
            if (signal?.aborted) abort();
        },
        async pull() {
            try {
                checkCatalogAbort(signal);
                const chunk = await reader.read();
                if (closed) return;
                if (chunk.done) { closed = true; release(); controller.close(); return; }
                if (!(chunk.value instanceof Uint8Array)) throw invalid('Choose browser File inputs for local media.');
                consumed += chunk.value.byteLength;
                if (consumed > MAX_DIRECTORY_BYTES) throw invalid('The DICOMDIR exceeds the 16 MiB index limit.');
                controller.enqueue(chunk.value);
            } catch (error) { if (!closed) controller.error(error); await cancel(error); }
        },
        cancel
    }, { highWaterMark: 0 }) };
}

async function readDirectory(file, signal) {
    checkCatalogAbort(signal);
    if (typeof file?.stream !== 'function' || !Number.isSafeInteger(file.size) || file.size < 132 || file.size > MAX_DIRECTORY_BYTES) {
        throw invalid('Choose a nonempty DICOMDIR index no larger than 16 MiB.');
    }
    const handler = new DirectoryHandler();
    const pipeline = EASI.pipelineBuilder().fromFileStream().ofDicomData({ includePart10Header: true })
        .withBulkDataPolicy({ mode: 'auto', hardSafetyCap: 1024 * 1024 + 1, knownLengthThreshold: 1 })
        .withHandler(handler).build();
    handler.parser = pipeline.parser;
    let parsed;
    try { parsed = (await pipeline.process({ source: boundedDirectorySource(file, signal), sourceOptions: { contentType: 'application/dicom' } })).single(); }
    catch (error) { checkCatalogAbort(signal); if (error?.code === 'dicomdir-invalid') throw error; throw invalid(); }
    checkCatalogAbort(signal);
    if (!parsed?.complete || parsed.stack.length || !parsed.hasDirectorySequence ||
        decode(parsed.root.get('00020002')) !== DIRECTORY_SOP || !validCatalogUid(decode(parsed.root.get('00020003'))) ||
        decode(parsed.root.get('00020010')) !== EXPLICIT_LE) {
        throw invalid('The DICOMDIR must be a complete Explicit VR Little Endian Media Storage Directory file.');
    }
    if (number(parsed.root, '00041212') !== 0) throw invalid('The DICOMDIR declares an inconsistent file-set. Use a complete, repaired media export.');
    return parsed;
}

function selectedPath(file) {
    const path = getLocalRelativePath(file);
    if (typeof path !== 'string' || !path || path.length > 4096 || /^[\\/]/u.test(path) || /[\u0000-\u001f\u007f\\:]/u.test(path)) return null;
    const parts = path.split('/');
    if (parts.length > 64 || parts.some(part => !part || part === '.' || part === '..')) return null;
    return parts.join('/');
}
function referencePath(data, report) {
    // CS padding is SPACE. NUL is permitted as UI padding elsewhere but must
    // never disappear from an untrusted filesystem reference.
    if (data?.includes(0)) return null;
    const value = decode(data), parts = value.split('\\');
    if (!value || parts.length > 8 || parts.some(part => !part || part === '.' || part === '..' || part.length > 255 || /[\u0000-\u001f\u007f/:]/u.test(part))) return null;
    if (parts.some(part => !/^[A-Z0-9_]{1,8}$/u.test(part))) addWarning(report, 'path');
    return parts.join('/');
}
function permitted(parent, child) {
    if (!parent) return ROOT_TYPES.has(child);
    if (parent === 'PRIVATE' || child === 'PRIVATE') return true;
    if (parent === 'PATIENT') return child === 'STUDY';
    if (parent === 'STUDY') return child === 'SERIES';
    return parent === 'SERIES' && LEAF_TYPES.has(child);
}
function hierarchyValues(record, inherited, charset, report) {
    const result = { ...inherited };
    // A PRIVATE node cannot add standardized patient/study/series identity.
    const type = decode(record.values.get('00041430'));
    const allowed = type === 'PATIENT' ? ['patientName', 'patientId', 'patientBirthDate', 'issuerOfPatientId']
        : type === 'STUDY' ? ['studyUid', 'studyDate', 'studyTime', 'studyDescription']
            : type === 'SERIES' ? ['seriesUid', 'modality', 'seriesDescription'] : [];
    for (const [id, key] of Object.entries(FIELDS)) if (allowed.includes(key) && record.values.has(id)) {
        const description = ['studyDescription', 'seriesDescription'].includes(key);
        const value = decode(record.values.get(id), charset, ['patientName', 'patientId', 'issuerOfPatientId', 'studyDescription', 'seriesDescription'].includes(key),
            description ? () => addWarning(report, 'descriptionEncoding') : undefined);
        if ((key === 'studyUid' || key === 'seriesUid') && value && !validCatalogUid(value)) throw invalid('The DICOMDIR contains an invalid hierarchy UID.');
        result[key] = value;
    }
    return result;
}

function walkDirectory(parsed, report, signal) {
    const byOffset = new Map(parsed.records.map(record => [record.offset, record]));
    if (byOffset.size !== parsed.records.length) throw invalid();
    const first = number(parsed.root, '00041200'), last = number(parsed.root, '00041202');
    if (!first && parsed.records.length) throw invalid('The DICOMDIR has records without valid root links. Re-export the media index.');
    if ((first || last) && !parsed.records.length) throw invalid();
    const visited = new Set(), references = [];
    const rootCharset = decode(parsed.root.get('00080005'));
    const queue = [{ offset: first, parent: '', inherited: {}, inactive: false, depth: 0, root: true }];
    let lastRoot = 0;
    while (queue.length) {
        checkCatalogAbort(signal);
        const entry = queue.pop();
        if (!entry.offset) continue;
        if (entry.depth > 64 || visited.has(entry.offset)) throw invalid('The DICOMDIR contains cyclic or multiply linked directory records.');
        const record = byOffset.get(entry.offset);
        if (!record) throw invalid('The DICOMDIR points outside a directory record. Re-export the media index.');
        visited.add(entry.offset);
        const next = number(record.values, '00041400'), child = number(record.values, '00041420'), flag = number(record.values, '00041410');
        const type = decode(record.values.get('00041430'));
        if (!type || !permitted(entry.parent, type)) throw invalid('The DICOMDIR has an invalid patient, study, or series hierarchy.');
        const inactive = entry.inactive || flag === 0;
        if (flag === 0) { report.inactive++; addWarning(report, 'inactive'); }
        else if (flag !== 65535) addWarning(report, 'flag');
        if (type === 'PRIVATE') addWarning(report, 'private');
        // Directory records are sibling sequence Items. Pointer-linked parents
        // contribute hierarchy fields, not their character-set declarations.
        // PS3.3 F.3.2.2; PS3.5 7.5.3 (actual containing Data Set inheritance).
        const charset = record.values.has('00080005') ? decode(record.values.get('00080005')) : rootCharset;
        const inherited = hierarchyValues(record, entry.inherited, charset, report);
        if (entry.root) lastRoot = entry.offset;
        if (next) queue.push({ ...entry, offset: next });
        if (child) queue.push({ offset: child, parent: type, inherited, inactive, depth: entry.depth + 1, root: false });
        if (!inactive && record.values.has('00041500')) {
            report.referenced++;
            const path = referencePath(record.values.get('00041500'), report);
            const expected = { ...inherited, recordType: type,
                sopClassUid: decode(record.values.get('00041510')), sopUid: decode(record.values.get('00041511')),
                transferSyntaxUid: decode(record.values.get('00041512')) };
            if (!path || ![expected.sopClassUid, expected.sopUid, expected.transferSyntaxUid].every(validCatalogUid)) {
                report.invalid++; addWarning(report, 'invalid');
            } else if (type !== 'IMAGE') { report.unsupported++; addWarning(report, 'unsupported'); }
            else references.push({ path, expected: Object.freeze(expected) });
        }
    }
    if (lastRoot !== last) {
        // The terminal pointer is redundant after the forward hierarchy has
        // validated. Never use a stale pointer to discover or reparent records.
        // A detached active root could instead mean the patient chain was cut.
        const detachedRoot = parsed.records.some(record => !visited.has(record.offset) &&
            ROOT_TYPES.has(decode(record.values.get('00041430'))) && number(record.values, '00041410') !== 0);
        if (detachedRoot) throw invalid('The DICOMDIR root chain is incomplete: active root records are unlinked.');
        addWarning(report, 'lastRoot');
    }
    if (visited.size !== parsed.records.length) addWarning(report, 'unreachable');
    return references;
}

/** PS3.3 F.3.2.2/F.4 defines record links; PS3.10 8.2/8.5/8.6 defines
 * relative File IDs and the Explicit VR Little Endian DICOMDIR format.
 * https://dicom.nema.org/medical/dicom/current/output/chtml/part03/sect_F.3.2.2.html
 * https://dicom.nema.org/medical/dicom/current/output/chtml/part10/sect_8.6.html
 * Resolve only explicitly granted browser Files, never filesystem paths or URLs.
 * A present DICOMDIR is authoritative; invalid/missing references never cause a
 * broad scan of unrelated files. No referenced image pixels are read here. */
export async function resolveLocalMedia(inputs, { signal, onProgress } = {}) {
    checkCatalogAbort(signal);
    if (signal != null && (typeof signal.addEventListener !== 'function' || typeof signal.removeEventListener !== 'function')) throw new TypeError('Use an AbortSignal for local media.');
    if (onProgress != null && typeof onProgress !== 'function') throw new TypeError('Use a progress callback.');
    const files = [], allInputs = [], seen = new WeakSet();
    let attempted = 0;
    for (const file of inputs ?? []) {
        if (++attempted > MAX_FILES) throw catalogError('file-limit', 'The local media selection exceeds the 30,000-file limit.');
        if (!file || typeof file !== 'object') throw catalogError('invalid-input', 'Choose browser File inputs for local media.');
        allInputs.push(file);
        if (!seen.has(file)) { seen.add(file); files.push(file); }
    }
    const directories = files.filter(isDicomDirectory);
    const report = { mode: directories.length ? 'dicomdir' : 'files', directories: directories.length,
        referenced: 0, resolved: 0, missing: 0, ambiguous: 0, invalid: 0, inactive: 0, unsupported: 0, unreferenced: 0, warnings: [] };
    if (!directories.length) return { files: allInputs.filter(file => !isBookkeeping(file)), report: Object.freeze({ ...report, warnings: Object.freeze([]) }), references: new Map() };
    if (directories.length > 32 || directories.reduce((sum, file) => sum + file.size, 0) > MAX_DIRECTORY_TOTAL_BYTES) {
        throw invalid('The selected media exceeds the directory-count or 32 MiB combined index limit.');
    }
    const exact = new Map(), folded = new Map();
    for (const file of files) {
        const path = selectedPath(file);
        if (!path) { if (isDicomDirectory(file)) throw invalid('The selected DICOMDIR has an unsafe or unavailable relative path. Select the complete media folder.'); continue; }
        const same = exact.get(path) ?? []; same.push(file); exact.set(path, same);
        const lower = path.toLowerCase(), matches = folded.get(lower) ?? []; matches.push(file); folded.set(lower, matches);
    }
    const references = new Map(), rejected = new Set(), reserved = new Set(directories);
    let completed = 0;
    const progress = () => onProgress?.(Object.freeze({ phase: 'media', completed, total: directories.length,
        directories: report.directories, referenced: report.referenced, resolved: report.resolved,
        missing: report.missing, ambiguous: report.ambiguous, invalid: report.invalid }));
    progress();
    for (const directory of directories) {
        const path = selectedPath(directory), slash = path.lastIndexOf('/'), base = slash === -1 ? '' : path.slice(0, slash + 1);
        if (exact.get(path)?.length !== 1) throw invalid('More than one DICOMDIR occupies the same selected media path.');
        const parsed = await readDirectory(directory, signal);
        for (const reference of walkDirectory(parsed, report, signal)) {
            const target = base + reference.path;
            let matches = exact.get(target), caseMatch = false;
            if (!matches?.length) { matches = folded.get(target.toLowerCase()); caseMatch = true; }
            if (!matches?.length) { report.missing++; addWarning(report, 'missing'); continue; }
            if (matches.length !== 1) { report.ambiguous++; addWarning(report, 'ambiguous'); continue; }
            const file = matches[0];
            if (reserved.has(file) || rejected.has(file) || references.has(file)) {
                // One file cannot be assigned two directory identities. Remove
                // both rather than silently preferring whichever was first.
                if (references.delete(file)) { report.resolved--; report.invalid++; }
                rejected.add(file); report.invalid++; addWarning(report, 'invalid'); continue;
            }
            if (caseMatch) addWarning(report, 'case');
            references.set(file, reference.expected); report.resolved++;
        }
        completed++; progress(); checkCatalogAbort(signal);
    }
    report.unreferenced = files.filter(file => !reserved.has(file) && !references.has(file) && !isSidecar(file)).length;
    progress(); checkCatalogAbort(signal);
    return { files: [...references.keys()], report: Object.freeze({ ...report, warnings: Object.freeze([...report.warnings]) }), references };
}

export default resolveLocalMedia;
