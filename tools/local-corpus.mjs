import { constants } from 'node:fs';
import { lstat, open, opendir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export const LOCAL_SOURCE_LIMIT_BYTES = 256 * 1024 * 1024;
const MAX_DISCOVERY_ENTRIES = 1000000;
export const MAX_CORPUS_FILES = 100000;
const HASH_CHUNK_BYTES = 64 * 1024;

function visible(name) {
    return !name.startsWith('.') && name.toLowerCase() !== '__macosx';
}

async function hasPart10Header(path) {
    const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
        const header = Buffer.alloc(132);
        const { bytesRead } = await handle.read(header, 0, header.length, 0);
        return bytesRead === 132 && header.toString('ascii', 128, 132) === 'DICM';
    } finally {
        await handle.close();
    }
}

function aborted(signal) { if (signal?.aborted) throw new DOMException('Corpus inventory interrupted.', 'AbortError'); }

async function fingerprint(file, signal) {
    const handle = await open(file.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
        const before = await handle.stat();
        if (!before.isFile() || !Number.isSafeInteger(before.size)) throw new Error('Corpus entries must be regular files with bounded integer sizes.');
        const hash = createHash('sha256');
        let bytes = 0;
        for await (const chunk of handle.createReadStream({ highWaterMark: HASH_CHUNK_BYTES, autoClose: false })) {
            aborted(signal);
            bytes += chunk.byteLength;
            hash.update(chunk);
        }
        const after = await handle.stat();
        if (bytes !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
            throw new Error('A local corpus file changed while its fingerprint was being read.');
        }
        return { ...file, bytes, sha256: hash.digest('hex'), overSourceLimit: bytes > LOCAL_SOURCE_LIMIT_BYTES };
    } finally {
        await handle.close();
    }
}

export function selectCorpus(files, { offset = 0, limit = MAX_CORPUS_FILES } = {}) {
    if (!Number.isSafeInteger(offset) || offset < 0) throw new RangeError('Corpus offset must be a nonnegative integer.');
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_CORPUS_FILES) throw new RangeError('Corpus limit must be an integer from 1 to 100000.');
    if (offset >= files.length) throw new RangeError('Corpus offset is outside the discovered selection.');
    const selected = files.slice(offset, offset + limit);
    Object.defineProperties(selected, { discoveredCount: { value: files.length }, selectedCount: { value: selected.length },
        limit: { value: limit }, offset: { value: offset } });
    return selected;
}

export function corpusFingerprint(files) {
    const hash = createHash('sha256');
    for (const file of files) hash.update(JSON.stringify([file.relativePath, file.bytes, file.sha256]) + '\n');
    return hash.digest('hex');
}

/** A private frozen inventory contains only relative paths and technical fingerprints. */
export function validateCorpusInventory(inventory, directory) {
    const root = resolve(directory);
    if (inventory?.schemaVersion !== 1 || inventory.directory !== root || !Array.isArray(inventory.files)
        || !inventory.files.length || inventory.files.length > MAX_CORPUS_FILES) throw new Error('Invalid corpus inventory or directory mismatch.');
    let previous = '';
    const files = inventory.files.map(file => {
        const name = file.relativePath;
        if (typeof name !== 'string' || !name || name <= previous || isAbsolute(name) || name.includes('\\') || name.includes('\0')
            || name.split('/').some(part => !part || part === '.' || part === '..' || !visible(part))
            || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || !/^[a-f0-9]{64}$/.test(file.sha256)) throw new Error('Invalid or unsorted corpus inventory entry.');
        previous = name;
        return { path: resolve(root, name), relativePath: name, bytes: file.bytes, sha256: file.sha256,
            overSourceLimit: file.bytes > LOCAL_SOURCE_LIMIT_BYTES };
    });
    if (inventory.fingerprint !== corpusFingerprint(files)) throw new Error('Corpus inventory fingerprint does not match its entries.');
    return files;
}

export async function readCorpusInventory(path, directory) {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 64 * 1024 * 1024) throw new Error('Invalid or oversized corpus inventory file.');
    return validateCorpusInventory(JSON.parse(await readFile(path, 'utf8')), directory);
}

/** Inventory local input only. Named DICOM files remain included even if malformed. */
export async function discoverCorpus(directory, options = {}) {
    if (typeof directory !== 'string' || !directory.trim()) throw new TypeError('Choose a non-empty local corpus directory.');
    if (!options || Object.getPrototypeOf(options) !== Object.prototype || Object.keys(options).some(key => !['limit', 'offset', 'match', 'signal', 'onProgress'].includes(key))) {
        throw new TypeError('Corpus options must contain only limit, offset, match, signal and onProgress.');
    }
    const limit = options.limit === undefined ? MAX_CORPUS_FILES : options.limit;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_CORPUS_FILES) {
        throw new RangeError('Corpus limit must be an integer from 1 to 100000.');
    }
    if (options.offset !== undefined && (!Number.isSafeInteger(options.offset) || options.offset < 0)) throw new RangeError('Corpus offset must be a nonnegative integer.');
    if (options.signal !== undefined && !(options.signal instanceof AbortSignal)) throw new TypeError('Corpus signal must be an AbortSignal.');
    if (options.onProgress !== undefined && typeof options.onProgress !== 'function') throw new TypeError('Corpus onProgress must be a function.');
    if (options.match !== undefined && (typeof options.match !== 'string' || !options.match.trim())) {
        throw new TypeError('Corpus match must be a non-empty filename substring.');
    }
    const match = options.match?.toLowerCase() ?? null;
    const root = resolve(directory);
    let rootStat;
    try { rootStat = await lstat(root); }
    catch (error) {
        if (error.code === 'ENOENT') throw new Error(`Local corpus directory does not exist: ${root}`, { cause: error });
        throw error;
    }
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('Local corpus input must be a directory, not a file or symbolic link.');

    const candidates = [];
    const directories = [root];
    let visited = 0;
    while (directories.length) {
        aborted(options.signal);
        const entries = await opendir(directories.pop());
        for await (const entry of entries) {
            aborted(options.signal);
            if (++visited > MAX_DISCOVERY_ENTRIES) throw new RangeError('Local corpus discovery exceeds 1000000 entries. Choose a narrower directory.');
            if (!visible(entry.name) || entry.isSymbolicLink()) continue;
            const path = join(entries.path, entry.name);
            if (entry.isDirectory()) { directories.push(path); continue; }
            if (!entry.isFile()) continue;
            const relativePath = relative(root, path).split(sep).join('/');
            if (match !== null && !relativePath.toLowerCase().includes(match)) continue;
            const extension = extname(entry.name).toLowerCase();
            const stat = await lstat(path);
            if (!stat.isFile() || stat.isSymbolicLink()) continue;
            if (!Number.isSafeInteger(stat.size) || stat.size < 0) throw new RangeError('A local corpus file has an unsupported filesystem size.');
            if (!['.dcm', '.dicom'].includes(extension) && (stat.size < 132 || !await hasPart10Header(path))) continue;
            candidates.push({ path, relativePath, bytes: stat.size });
            if (candidates.length > MAX_CORPUS_FILES) throw new RangeError('Local corpus exceeds 100000 DICOM files. Choose a narrower directory.');
        }
    }
    candidates.sort((left, right) => left.relativePath < right.relativePath ? -1 : left.relativePath > right.relativePath ? 1 : 0);
    if (!candidates.length) throw new Error('No matching DICOM files were found in the local corpus directory.');
    const selection = selectCorpus(candidates, { offset: options.offset ?? 0, limit });
    const selected = [];
    for (const candidate of selection) {
        aborted(options.signal);
        selected.push(await fingerprint(candidate, options.signal));
        options.onProgress?.({ completed: selected.length, total: selection.length, discovered: candidates.length });
    }
    Object.defineProperties(selected, {
        discoveredCount: { value: candidates.length },
        selectedCount: { value: selected.length },
        limit: { value: limit },
        offset: { value: options.offset ?? 0 },
        match: { value: options.match ?? null }
    });
    return selected;
}

// Match declared profile boundaries, never a generic occurrence of "unsupported".
const unsupportedMessages = new Set([
    'Embedded HP color transforms require a dedicated decoding profile.',
    'Enhanced DICOM LUT and real-world value transformations require a dedicated presentation implementation.',
    'Unsupported or invalid DICOM presentation: alpha, segmented and enhanced palettes require a separate profile.',
    'Unsupported undefined-length UN sequence value.',
        'Deflated Explicit VR Little Endian datasets are not supported.',
    'This DICOM transfer syntax does not have a verified pixel decoder.',
    'This DICOM object type is outside the 2D image profile supported by this alpha.',
    'Enhanced shared/per-frame functional groups need a dedicated geometry implementation and are not supported by this alpha.',
    'YBR_RCT/ICT require the corresponding verified JPEG2000 profile.',
    'This alpha requires a supported scalar/palette image with one sample per pixel or RGB with three samples per pixel.',
    'Compressed palette indices require native retrieval or the verified RLE profile.',
    'RLE YBR_FULL_422 is not a supported color profile.',
    'This alpha supports 8-bit and 16-bit native pixels.',
    'This alpha supports native RGB only with unsigned 8-bit channels, Bits Stored 8 and High Bit 7.',
    'RGB/palette color does not support scalar rescale or pixel padding transforms.',
    'RGB ICC profiles and declared color spaces require a color-management implementation and are not supported by this alpha.',
    'Classic XA requires fixed declared timing; variable frame-time vectors are unsupported for this profile.',
    'Enhanced CT/MR currently requires a verified monochrome pixel profile.',
    'This classic XA profile does not support nonidentity modality rescale or quantitative rescale units.',
    'This classic XA profile requires Pixel Intensity Relationship LIN or DISP; LOG images need a dedicated LUT implementation.',
    'Classic XA mask subtraction is not supported. Open native, unsubtracted image frames.',
    'Classic XA mask subtraction is not supported. Mask operations must be NONE for native viewing.',
    'This classic XA profile supports native (NAT) viewing only.',
    'Classic XA display shutters require a presentation implementation and are not supported by this profile.',
    'Classic XA Pixel Intensity Relationship LUTs are not supported by this profile.',
    'Unsupported lossless JPEG predictor or point transform.',
    'JPEG 2000 component overrides or ROI coding are not supported.',
    'The frame exceeds the 16-megapixel alpha limit.',
    'The input exceeds the 256 MiB source limit. Load a smaller series.',
    'The selected files exceed the 256 MiB source limit. Load a smaller series.',
    'The response exceeds the 256 MiB source limit. Retrieve a smaller series.',
    'Codec memory limit exceeded.'
]);
const invalidMessages = new Set([
    'Unexpected end of DICOM input. Incomplete data element, sequence, or item.',
    'The DICOM numeric metadata contains invalid values.',
    'The source does not contain a DICOM image dataset.',
    'Invalid native image dimensions or pixel metadata.',
    'Invalid pixel rescale transform.',
    'Invalid pixel padding metadata.',
    'Pixel Padding Range Limit requires a Pixel Padding Value.',
    'Pixel Data encoding does not match its transfer syntax, or is missing or incomplete.',
    'The native Pixel Data length does not match its frame count and dimensions.',
    'The native frame byte length does not match its dimensions.',
    'The DICOM image is missing a SOP or Series Instance UID.',
    'Invalid Frame of Reference UID.',
    'Unsupported or inconsistent native pixel bit layout.',
    'Invalid native frame byte length.',
    'Invalid native YBR frame length.',
    'JPEG Baseline codestream dimensions, components or precision do not match the DICOM metadata.',
    'Compressed codestream dimensions, components, precision or signedness do not match the DICOM metadata.',
    'Invalid or unsupported compressed frame header.'
]);

export function classifyFailure(message) {
    const text = typeof message === 'string' ? message.trim() : message instanceof Error ? message.message.trim() : '';
    if (unsupportedMessages.has(text) || /^Frame dimensions exceed this GPU's \d+-pixel texture limit\.$/.test(text)) return 'unsupported';
    if (invalidMessages.has(text) || /^(?:Invalid (?:DICOM RLE frame|encapsulated Pixel Data|enhanced DICOM functional-group metadata|classic XA (?:presentation|mask subtraction) metadata|JPEG (?:Baseline frame|marker boundary|frame components|Adobe color marker))|Truncated (?:DICOM|JPEG) (?:data|frame|header)|Unsupported or invalid DICOM presentation)(?:[.: ]|$)/.test(text)) return 'invalid';
    return 'unexpected';
}

function text(value) { return typeof value === 'string' ? value : ''; }
function escape(value) { return text(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character])); }
function integer(value) { return Number.isSafeInteger(value) && value >= 0 ? String(value) : '—'; }
function filename(value) {
    const name = text(value);
    if (isAbsolute(name) || /^[A-Za-z]:[\\/]/.test(name)) return '[absolute path omitted]';
    return name || '[unnamed local file]';
}
function profile(value) {
    if (typeof value === 'string') return value;
    if (!value || typeof value !== 'object') return '';
    return ['modality', 'photometric', 'transferSyntax', 'bitsAllocated', 'bitsStored', 'rows', 'columns']
        .filter(key => typeof value[key] === 'string' || Number.isFinite(value[key]))
        .map(key => `${key}: ${value[key]}`).join(' · ');
}
function rows(report) {
    if (!report || !Array.isArray(report.results)) throw new TypeError('A local corpus report requires a results array.');
    return report.results.map(result => {
        const file = result.file ?? result;
        return [filename(file.relativePath), integer(file.bytes), /^[a-f0-9]{64}$/i.test(text(file.sha256)) ? file.sha256 : '—',
            text(result.status) || 'not checked', result.parsing?.passed === true ? 'Parsed' : result.parsing?.passed === false ? 'Rejected' : 'Not checked', text(result.stage), text(result.reason ?? result.message), profile(result.profile),
            integer(Array.isArray(result.framesChecked) ? result.framesChecked.length : result.framesChecked), integer(result.frameCount),
            Array.isArray(result.warnings) ? result.warnings.filter(value => typeof value === 'string').join(' ') : ''];
    });
}

const headings = ['Local filename', 'Bytes', 'SHA-256', 'Status', 'EASI parsing', 'Stage', 'Reason', 'Image profile', 'Frames checked', 'Frame count', 'Warnings'];

export function corpusStatusLabel(status) {
    const labels = { passed: 'Successful viewing session (passed)', failed: 'Unexpected error (failed)',
        unsupported: 'Unsupported profile (unsupported)', invalid: 'Rejected by current validation (invalid)' };
    return Object.hasOwn(labels, status) ? labels[status] : status;
}

/** Human-facing totals distinguish unsuccessful sessions from unexpected errors. */
export function renderCorpusOutcomeSummary(report) {
    const results = report.results || [];
    const counts = report.summary || results.reduce((totals, result) => {
        totals[result.status] = (totals[result.status] || 0) + 1; return totals;
    }, {});
    const statuses = ['passed', 'failed', 'unsupported', 'invalid'];
    const values = statuses.map(status => counts[status] ?? 0);
    const reported = report.reportedFiles ?? results.length;
    const consistent = values.every(value => Number.isSafeInteger(value) && value >= 0)
        && values.reduce((sum, value) => sum + value, 0) === reported;
    const selected = report.coverage?.selectedFiles;
    const remaining = Number.isSafeInteger(selected) && selected >= reported ? selected - reported : null;
    const headline = consistent ? `${integer(reported)} ${reported === 1 ? 'file with a reported attempt' : 'files with reported attempts'} · ${integer(values[0])} successful viewing ${values[0] === 1 ? 'session' : 'sessions'} · ${integer(values[1] + values[2] + values[3])} could not complete.`
        : `${integer(reported)} reported files. Outcome totals need review before a success count can be established.`;
    return `<p class="outcome-summary"><strong>${headline}</strong></p>`
        + `<p>${statuses.map(status => `${escape(corpusStatusLabel(status))}: ${integer(counts[status] ?? 0)}`).join(' · ')}.</p>`
        + `<p>${remaining === null ? 'Selected-file total unavailable; remaining coverage is unknown.'
            : `${integer(remaining)} selected ${remaining === 1 ? 'file' : 'files'} pending without a reported outcome.`} Only reported attempts are counted above.</p>`
        + '<p>Unsupported profiles and validation rejections are unsuccessful viewing sessions. A validation rejection describes the current viewer; input validity requires independent review. Zero unexpected errors does not mean every file opened successfully.</p>';
}

/** Only explicit operational fields are rendered; no raw report JSON or imaging payload. */
export function renderCorpusReport(report) {
    const entries = rows(report);
    const title = text(report.title) || 'Local DICOM corpus coverage report';
    const totalDiscovered = report.discoveredCount ?? report.totalDiscovered;
    const discovered = Number.isSafeInteger(totalDiscovered) ? ` of ${totalDiscovered} discovered matching files` : '';
    const coverage = report.coverage;
    const coverageText = coverage ? `${integer(coverage.selectedFiles)} selected of ${integer(coverage.discoveredFiles)} discovered files; ${coverage.completeDirectory ? 'complete directory selection' : 'explicit subset'}; ${coverage.frameMode === 'all' ? 'all logical frames requested' : 'first/middle/last frames requested'}.` : '';
    const parsed = report.parsedCount ?? report.results.filter(result => result.parsing?.passed).length;
    const reported = report.reportedFiles ?? entries.length;
    const completion = report.completedAt ? 'Completed run' : report.startedAt ? 'Partial run · still running or interrupted' : '';
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; connect-src 'none'; base-uri 'none'; form-action 'none'">
<title>${escape(title)}</title><style>body{margin:2rem;font:15px/1.5 system-ui,sans-serif;color:#182b38;background:#f7f9fa}h1{font-size:1.7rem}aside{padding:1rem;background:#e8eff3;border-left:4px solid #58798e}table{width:100%;border-collapse:collapse;margin-top:1.5rem;background:white}th,td{text-align:left;vertical-align:top;padding:.6rem;border:1px solid #cad6de;overflow-wrap:anywhere}th{background:#e8eff3}td:nth-child(3){font:11px/1.6 monospace}p{max-width:90ch}.table-scroll{overflow:auto}</style></head>
<body><h1>${escape(title)}</h1><p>This is a local filename report containing file sizes, fingerprints and operational outcomes. It embeds no images, pixel arrays, DICOM attribute dumps or external resources.</p>
<aside><strong>${escape(completion || 'Coverage limits')}</strong><p>${escape(coverageText)} Successful image sessions require actual renderer submission, frame commits, interaction checks and resource cleanup. Per-file frame counts below describe actual tested frames. These outcomes do not establish pixel correctness, clinical interpretation or full DICOM conformance. Independent synthetic numeric and display tests provide separate correctness evidence. Unsupported document/object profiles are recorded explicitly; unclassified failures require investigation.</p></aside>
<p>${integer(reported)} reported files${discovered}.</p>
${renderCorpusOutcomeSummary(report)}
${report.startedAt ? `<p>EASI parsed ${integer(parsed)}/${integer(reported)} reported files. Viewer ${escape(report.viewerVersion)} · ${escape(report.browser)}. Started ${escape(report.startedAt)}${report.completedAt ? ` · Completed ${escape(report.completedAt)}` : ''}.</p>` : ''}
${report.sourceDigest ? `<details><summary>Verified viewer build fingerprint</summary><code>${escape(report.sourceDigest)}</code></details>` : ''}
${report.generatedAt ? `<p>Generated: ${escape(report.generatedAt)}</p>` : ''}
<div class="table-scroll"><table><thead><tr>${headings.map(heading => `<th scope="col">${heading}</th>`).join('')}</tr></thead><tbody>${renderCorpusReportRows(report.results)}</tbody></table></div></body></html>\n`;
}

export function renderCorpusReportRows(results) {
    return rows({ results }).map(row => `<tr>${row.map((value, index) => `<td>${escape(index === 3 ? corpusStatusLabel(value) : value)}</td>`).join('')}</tr>`).join('\n');
}

export function renderCorpusCsv(report) {
    const quote = value => `"${String(value).replaceAll('"', '""')}"`;
    // A local filename can start with a spreadsheet formula character.
    const cell = value => /^[\s]*[=+@-]/.test(value) ? `'${value}` : value;
    return [headings, ...rows(report)].map(row => row.map(value => quote(cell(value))).join(',')).join('\r\n') + '\r\n';
}
