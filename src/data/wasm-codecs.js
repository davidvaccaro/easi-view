// This module owns the small C ABI adapter. The codec package's JavaScript and
// DICOM model are deliberately absent from the viewer runtime.
const SYNTAX = '1.2.840.10008.1.2.4.';
const JPEG_EXTENDED = `${SYNTAX}51`;
const JPEG = new Set([JPEG_EXTENDED, `${SYNTAX}57`, `${SYNTAX}70`]);
const JLS = new Set([`${SYNTAX}80`, `${SYNTAX}81`]);
const J2K = new Set([`${SYNTAX}90`, `${SYNTAX}91`]);
const MAX_WASM_BYTES = 8 * 1024 * 1024;
const MAX_FRAME_BYTES = 64 * 1024 * 1024;
const MAX_PIXELS = 16 * 1024 * 1024;
const MAX_WASM_MEMORY = 512 * 1024 * 1024;
const PHOTOMETRIC = ['MONOCHROME1', 'MONOCHROME2', 'PALETTE COLOR', 'RGB', 'YBR_FULL',
    'YBR_FULL_422', 'YBR_PARTIAL_422', 'YBR_PARTIAL_420', 'YBR_ICT', 'YBR_RCT'];
export const JPEG_STORED_PRECISION_WARNING = 'JPEG Lossless codestream precision is 16 bits while the source declares 12 stored bits. Viewing preserves the full decoded values; original DICOM attributes are unchanged.';
let defaultRuntime;
const injectedRuntimes = new WeakMap();

function invalid() { throw new Error('Invalid or unsupported compressed frame header.'); }
function mismatch() { throw new Error('Compressed codestream dimensions, components, precision or signedness do not match the DICOM metadata.'); }

function validateMetadata(bytes, metadata) {
    if (!(bytes instanceof Uint8Array) || !bytes.byteLength || bytes.byteLength > MAX_FRAME_BYTES) {
        throw new Error('Compressed frame exceeds the supported input limit or is empty.');
    }
    if (!metadata || ![...JPEG, ...JLS, ...J2K].includes(metadata.transferSyntax)) invalid();
    const { rows, columns, bitsAllocated, bitsStored, highBit, samplesPerPixel, signed } = metadata;
    if (![rows, columns, bitsAllocated, bitsStored, highBit, samplesPerPixel].every(Number.isSafeInteger) ||
        rows < 1 || columns < 1 || rows * columns > MAX_PIXELS || ![8, 16].includes(bitsAllocated) ||
        bitsStored < (J2K.has(metadata.transferSyntax) ? 1 : 2) || bitsStored > bitsAllocated || highBit !== bitsStored - 1 ||
        ![1, 3].includes(samplesPerPixel) || typeof signed !== 'boolean') invalid();
    const photometric = metadata.encodedPhotometric ?? metadata.photometric;
    if (metadata.transferSyntax === JPEG_EXTENDED && (signed || samplesPerPixel !== 1
        || ![8, 12].includes(bitsStored) || !['MONOCHROME1', 'MONOCHROME2'].includes(photometric))) {
        throw new Error('JPEG Extended requires the verified unsigned 8-bit or 12-bit monochrome pixel profile.');
    }
    if (samplesPerPixel === 1 && !['MONOCHROME1', 'MONOCHROME2'].includes(photometric)) invalid();
    if (samplesPerPixel === 3 && (signed || bitsAllocated !== 8 || bitsStored !== 8 ||
        !['RGB', 'YBR_RCT', 'YBR_ICT', 'YBR_FULL'].includes(photometric) ||
        ![0, 1, null, undefined].includes(metadata.planarConfiguration))) invalid();
    if (!J2K.has(metadata.transferSyntax) && samplesPerPixel === 3 && photometric !== 'RGB') invalid();
    if (photometric === 'YBR_FULL' && metadata.planarConfiguration !== 0) invalid();
    const decodedBytes = rows * columns * samplesPerPixel * bitsAllocated / 8;
    if (decodedBytes > MAX_FRAME_BYTES) invalid();
    // Codestream precision determines the codec's physical output width. The
    // DICOM native container can be wider (e.g. Bits Stored8 in Allocated16),
    // but asking the codec for that width can leave half the samples unwritten.
    const codecBitsAllocated = bitsStored <= 8 ? 8 : 16;
    const codecDecodedBytes = rows * columns * samplesPerPixel * codecBitsAllocated / 8;
    return { photometric, decodedBytes, codecBitsAllocated, codecDecodedBytes };
}

function trailingPadding(bytes, offset) {
    if (offset !== bytes.length && !(offset === bytes.length - 1 && bytes[offset] === 0)) invalid();
}

// The pinned decoder can recover an early EOI with invented missing samples.
// Count bounded sequential mono blocks before allocating a codec context. This
// checks Huffman syntax only; reconstruction and inverse DCT stay in the codec.
function validateSequentialScan(bytes, start, end, metadata, dc, ac, restartInterval) {
    let offset = start, remaining = 0, buffer = 0;
    const bit = () => {
        if (!remaining) {
            if (offset >= end) invalid();
            buffer = bytes[offset++];
            if (buffer === 255 && (offset >= end || bytes[offset++] !== 0)) invalid();
            remaining = 8;
        }
        return (buffer >> --remaining) & 1;
    };
    const skip = count => { for (let index = 0; index < count; index++) bit(); };
    const code = table => {
        let value = 0, first = 0, position = 0;
        for (let length = 0; length < 16; length++) {
            value = value * 2 + bit();
            const count = table.counts[length];
            if (value >= first && value < first + count) return table.symbols[position + value - first];
            position += count; first = (first + count) * 2;
        }
        invalid();
    };
    const align = () => {
        if (remaining && (buffer & (2 ** remaining - 1)) !== 2 ** remaining - 1) invalid();
        remaining = 0;
    };
    const blocks = Math.ceil(metadata.rows / 8) * Math.ceil(metadata.columns / 8);
    let restart = 0;
    for (let block = 0; block < blocks; block++) {
        skip(code(dc));
        let coefficient = 1;
        while (coefficient < 64) {
            const symbol = code(ac), run = symbol >> 4, size = symbol & 15;
            if (size === 0) {
                if (run === 0) break;
                coefficient += 16;
                if (coefficient > 64) invalid();
            } else {
                coefficient += run;
                if (coefficient >= 64) invalid();
                skip(size); coefficient++;
            }
        }
        if (restartInterval && (block + 1) % restartInterval === 0 && block + 1 < blocks) {
            align();
            if (bytes[offset++] !== 255) invalid();
            while (bytes[offset] === 255) offset++;
            if (bytes[offset++] !== 208 + restart++ % 8) invalid();
        }
    }
    align();
    if (offset !== end) invalid();
}

// Inspect every scan header, not just SOF: predictor/point transform, NEAR and
// interleave modes can appear after the frame dimensions. Entropy bytes are
// skipped without retaining or interpreting their values.
function jpegHeader(bytes, metadata) {
    if (bytes.length < 4 || bytes[0] !== 255 || bytes[1] !== 216) invalid();
    const jls = JLS.has(metadata.transferSyntax);
    const extended = metadata.transferSyntax === JPEG_EXTENDED;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let offset = 2, frame, scans = 0, markers = 0, restartInterval = 0;
    const covered = new Set();
    const quantizers = new Set(), huffman = new Map();
    while (offset < bytes.length && ++markers <= 4096) {
        if (bytes[offset++] !== 255) invalid();
        while (bytes[offset] === 255) offset++;
        const marker = bytes[offset++];
        if (marker === 217) {
            if (!frame || !scans || covered.size !== frame.components) invalid();
            trailingPadding(bytes, offset);
            return frame;
        }
        if ([0, 216, 1].includes(marker) || marker >= 208 && marker <= 215 || offset + 2 > bytes.length) invalid();
        const length = view.getUint16(offset);
        if (length < 2 || offset + length > bytes.length) invalid();
        const start = offset + 2;
        const end = offset + length;
        const startsWith = text => length >= text.length + 2
            && [...text].every((character, index) => bytes[start + index] === character.charCodeAt(0));
        if ([192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207, 247].includes(marker)) {
            // PS3.5 A.4.1: Process2/4 uses SOF1; no progressive/lossless relabeling.
            if (frame || marker !== (jls ? 247 : extended ? 193 : 195) || length < 8) invalid();
            const components = bytes[start + 5];
            if (![1, 3].includes(components) || length !== 8 + 3 * components) invalid();
            const ids = new Set(), quantizationById = new Map();
            for (let index = 0; index < components; index++) {
                const base = start + 6 + index * 3;
                if (ids.has(bytes[base]) || bytes[base + 1] !== 17 || (extended ? bytes[base + 2] > 3 : bytes[base + 2] !== 0)) invalid();
                ids.add(bytes[base]);
                quantizationById.set(bytes[base], bytes[base + 2]);
            }
            frame = { precision: bytes[start], rows: view.getUint16(start + 1),
                columns: view.getUint16(start + 3), components, ids, quantizationById,
                ...(extended ? { encodingWarnings: [] } : {}) };
            if (frame.rows !== metadata.rows || frame.columns !== metadata.columns || frame.components !== metadata.samplesPerPixel) mismatch();
            if (frame.precision !== metadata.bitsStored) {
                // PS3.5 8.2 gives JPEG stream characteristics precedence for
                // decompression. Qualify only this observed unsigned mono
                // container mismatch, and expose its actual decoded precision.
                if (jls || extended || metadata.bitsAllocated !== 16 || metadata.bitsStored !== 12 || metadata.highBit !== 11 ||
                    metadata.signed !== false || metadata.samplesPerPixel !== 1 || frame.precision !== 16 ||
                    metadata.modalityLut || metadata.voiLut || metadata.hasVoiLut ||
                    !['MONOCHROME1', 'MONOCHROME2'].includes(metadata.encodedPhotometric ?? metadata.photometric)) mismatch();
                frame.effectiveBitsStored = 16; frame.encodingWarnings = [JPEG_STORED_PRECISION_WARNING];
            }
        } else if (marker === 218) {
            if (!frame || length < 6) invalid();
            const count = bytes[start];
            if (!count || count > frame.components || length !== 6 + 2 * count) invalid();
            for (let index = 0; index < count; index++) {
                const id = bytes[start + 1 + index * 2];
                if (!frame.ids.has(id) || covered.has(id)) invalid();
                if (extended) {
                    const tables = bytes[start + 2 + index * 2];
                    if (tables >> 4 > 3 || (tables & 15) > 3 || !huffman.has(tables >> 4)
                        || !huffman.has(16 | (tables & 15)) || !quantizers.has(frame.quantizationById.get(id))) invalid();
                }
                covered.add(id);
            }
            const a = bytes[end - 3], b = bytes[end - 2], c = bytes[end - 1];
            if (extended) {
                // T.81 sequential SOS requires Se=63. Some legacy encoders
                // emit all-zero SOS fields, also tolerated by libjpeg-turbo:
                // https://github.com/libjpeg-turbo/libjpeg-turbo/blob/main/src/jdhuff.c
                // Accept only Se=0 with the same full64-coefficient scan check
                // below and an explicit warning; this is not progressive/DC-only.
                if (a !== 0 || ![0, 63].includes(b) || c !== 0) invalid();
            } else if (jls) {
                if (a > Math.min(255, (2 ** frame.precision - 1) / 2) ||
                    metadata.transferSyntax === `${SYNTAX}80` && a !== 0 ||
                    ![0, 1, 2].includes(b) || count === 1 && b !== 0 || count > 1 && b === 0 || c !== 0) invalid();
            } else if (a < 1 || a > 7 || metadata.transferSyntax === `${SYNTAX}70` && a !== 1 || b !== 0 || c !== 0) {
                throw new Error('Unsupported lossless JPEG predictor or point transform.');
            }
            scans++;
            offset = end;
            const entropyStart = offset;
            let entropyBytes = 0, restarts = 0;
            while (offset < bytes.length) {
                if (bytes[offset] !== 255) { offset++; entropyBytes++; continue; }
                const next = bytes[offset + 1];
                if (next === undefined) invalid();
                if (jls ? next < 128 : next === 0) { offset += 2; entropyBytes++; continue; }
                let restartOffset = offset + 1;
                if (extended) while (bytes[restartOffset] === 255) restartOffset++;
                const restartMarker = bytes[restartOffset];
                if (restartMarker >= 208 && restartMarker <= 215) {
                    if (extended && (!restartInterval || restartMarker !== 208 + restarts % 8)) invalid();
                    restarts++; offset = restartOffset + 1; continue;
                }
                break;
            }
            if (extended && !entropyBytes) invalid();
            if (extended) {
                const tables = bytes[start + 2];
                validateSequentialScan(bytes, entropyStart, offset, metadata,
                    huffman.get(tables >> 4), huffman.get(16 | (tables & 15)), restartInterval);
                if (b === 0) frame.encodingWarnings.push('Legacy JPEG sequential scan uses Se=0; the complete 64-coefficient scan was validated before decoding.');
            }
            continue;
        } else if (extended && marker === 219) {
            let table = start;
            if (table === end) invalid();
            while (table < end) {
                const selector = bytes[table++], precision = selector >> 4, id = selector & 15;
                // T.81 B.2.4.1: 8-bit DCT cannot use16-bit quantizer elements.
                if (precision > 1 || metadata.bitsStored === 8 && precision !== 0
                    || id > 3 || table + 64 * (precision + 1) > end) invalid();
                for (let index = 0; index < 64; index++) {
                    const value = precision ? view.getUint16(table) : bytes[table];
                    if (!value) invalid();
                    table += precision + 1;
                }
                quantizers.add(id);
            }
        } else if (extended && marker === 196) {
            let table = start;
            if (table === end) invalid();
            while (table < end) {
                const selector = bytes[table++], kind = selector >> 4, id = selector & 15;
                if (kind > 1 || id > 3 || table + 16 > end) invalid();
                const counts = bytes.slice(table, table + 16);
                let symbols = 0, available = 1;
                for (let index = 0; index < 16; index++) {
                    const count = bytes[table++];
                    symbols += count; available = available * 2 - count;
                    if (available <= 0) invalid();
                }
                if (!symbols || symbols > 256 || table + symbols > end) invalid();
                const values = bytes.slice(table, table + symbols);
                for (let index = 0; index < symbols; index++) {
                    const symbol = bytes[table++];
                    if (kind === 0 ? symbol > metadata.bitsStored + 3
                        : (symbol & 15) > metadata.bitsStored + 2 || (symbol & 15) === 0 && ![0, 15].includes(symbol >> 4)) invalid();
                }
                huffman.set(selector, { counts, symbols: values });
            }
        } else if (extended && marker === 221) {
            if (length !== 4) invalid();
            restartInterval = view.getUint16(start);
        } else if (extended && [204, 222, 223].includes(marker)) {
            invalid(); // Arithmetic coding and hierarchical frames are separate processes.
        } else if (extended && ((marker === 226 && startsWith('ICC_PROFILE'))
            || marker === 238 && startsWith('Adobe') || marker === 232 && startsWith('mrfx'))) {
            invalid(); // No ICC or embedded color-transform profile is claimed for .51 mono.
        } else if (marker === 248) {
            // Mapping tables and extended dimensions need their own profile.
            if (!jls || !frame || length !== 13 || bytes[start] !== 1 ||
                view.getUint16(start + 1) !== 2 ** frame.precision - 1 ||
                !view.getUint16(start + 9)) invalid();
        } else if (marker === 220) {
            invalid(); // DNL dimensions must not change an already bounded frame.
        } else if (marker === 238 && length >= 14 && bytes[start] === 65 && bytes[start + 1] === 100 &&
            bytes[start + 2] === 111 && bytes[start + 3] === 98 && bytes[start + 4] === 101 && bytes[start + 11] !== 0) {
            invalid();
        } else if (marker === 232 && length >= 7 && bytes[start] === 109 && bytes[start + 1] === 114 &&
            bytes[start + 2] === 102 && bytes[start + 3] === 120 && bytes[start + 4] !== 0) {
            throw new Error('Embedded HP color transforms require a dedicated decoding profile.');
        }
        offset = end;
    }
    invalid();
}

function jpeg2000Header(bytes, metadata, photometric) {
    if (bytes.length < 4 || bytes[0] !== 255 || bytes[1] !== 79) invalid();
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let offset = 2, siz = false, tileCount = 0, coding, quantization = false, tileEnd = null, tileParts = 0, markers = 0;
    const lossless = metadata.transferSyntax === `${SYNTAX}90`;
    while (offset < bytes.length && ++markers <= 16384) {
        if (offset + 2 > bytes.length || bytes[offset] !== 255) invalid();
        const marker = bytes[offset + 1];
        offset += 2;
        if (marker === 217) {
            if (!siz || !coding || !quantization || !tileParts || tileEnd !== null) invalid();
            trailingPadding(bytes, offset);
            return;
        }
        if (marker === 147) {
            if (!coding || !quantization || tileEnd === null || tileEnd < offset) invalid();
            offset = tileEnd;
            tileEnd = null;
            continue;
        }
        if (offset + 2 > bytes.length) invalid();
        const length = view.getUint16(offset);
        if (length < 2 || offset + length > bytes.length) invalid();
        const start = offset + 2;
        if (marker === 81) {
            if (siz || tileParts || length < 38 || ![0, 1, 2].includes(view.getUint16(start))) invalid();
            const columns = view.getUint32(start + 2) - view.getUint32(start + 10);
            const rows = view.getUint32(start + 6) - view.getUint32(start + 14);
            const components = view.getUint16(start + 34);
            if (columns !== metadata.columns || rows !== metadata.rows || components !== metadata.samplesPerPixel) mismatch();
            if (length !== 38 + 3 * components || !view.getUint32(start + 18) || !view.getUint32(start + 22) ||
                view.getUint32(start + 26) > view.getUint32(start + 10) ||
                view.getUint32(start + 30) > view.getUint32(start + 14)) invalid();
            tileCount = Math.ceil((view.getUint32(start + 2) - view.getUint32(start + 26)) / view.getUint32(start + 18)) *
                Math.ceil((view.getUint32(start + 6) - view.getUint32(start + 30)) / view.getUint32(start + 22));
            if (!Number.isSafeInteger(tileCount) || tileCount < 1 || tileCount > 4096) invalid();
            for (let index = 0; index < components; index++) {
                const base = start + 36 + 3 * index;
                if ((bytes[base] & 127) + 1 !== metadata.bitsStored || Boolean(bytes[base] & 128) !== metadata.signed) mismatch();
                if (bytes[base + 1] !== 1 || bytes[base + 2] !== 1) invalid();
            }
            siz = true;
        } else if (marker === 82) {
            if (!siz || length < 12) invalid();
            const style = bytes[start], mct = bytes[start + 4], levels = bytes[start + 5], transform = bytes[start + 9];
            if (style > 7 || bytes[start + 1] > 4 || !view.getUint16(start + 2) || mct > 1 || levels > 16 ||
                bytes[start + 6] > 8 || bytes[start + 7] > 8 || bytes[start + 6] + bytes[start + 7] > 8 ||
                bytes[start + 8] > 63 || ![0, 1].includes(transform) ||
                length !== 12 + (style & 1 ? levels + 1 : 0) || lossless && transform !== 1) invalid();
            const expectedMct = ['YBR_RCT', 'YBR_ICT'].includes(photometric) ? 1 : 0;
            if (mct !== expectedMct || photometric === 'YBR_RCT' && transform !== 1 ||
                photometric === 'YBR_ICT' && transform !== 0) {
                throw new Error('JPEG 2000 component transform does not match the declared photometric interpretation.');
            }
            if (coding && (coding.mct !== mct || coding.transform !== transform || coding.levels !== levels)) invalid();
            coding = { mct, transform, levels };
        } else if (marker === 92) {
            if (!coding || length < 4) invalid();
            const style = bytes[start] & 31;
            const bands = 3 * coding.levels + 1;
            if (style > 2 || lossless && style !== 0 ||
                length !== (style === 0 ? 3 + bands : style === 1 ? 5 : 3 + 2 * bands)) invalid();
            if (style === 0) for (let index = start + 1; index < offset + length; index++) if (bytes[index] & 7) invalid();
            quantization = true;
        } else if (marker === 144) {
            if (!siz || !coding || !quantization || length !== 10 || tileEnd !== null) invalid();
            const markerStart = offset - 2;
            const partLength = view.getUint32(start + 2);
            const eoc = bytes.length - (bytes[bytes.length - 1] === 0 ? 3 : 2);
            if (view.getUint16(start) >= tileCount || bytes[start + 7] && bytes[start + 6] >= bytes[start + 7] ||
                partLength !== 0 && (partLength < 14 || markerStart + partLength > eoc) || ++tileParts > 4096) invalid();
            tileEnd = partLength === 0 ? eoc : markerStart + partLength;
            if (partLength === 0 && (bytes[eoc] !== 255 || bytes[eoc + 1] !== 217)) invalid();
        } else if ([83, 93, 94].includes(marker)) {
            throw new Error('JPEG 2000 component overrides or ROI coding are not supported.');
        } else if (![85, 87, 88, 96, 97, 99, 100].includes(marker)) {
            invalid();
        }
        offset += length;
        if (tileEnd !== null && offset >= tileEnd) invalid();
    }
    invalid();
}

async function moduleBytes() {
    const url = new URL('./dicom-codecs.wasm', import.meta.url);
    if (url.protocol === 'file:') {
        // Keep the Node-only fallback dynamic after a minified SDK is bundled
        // again by a browser host. A constant becomes a resolvable Node import.
        const moduleName = ['node', 'fs/promises'].join(':');
        const fs = await import(moduleName);
        let path = url;
        try { await fs.access(path); } catch {
            path = new URL('../../node_modules/dcmjs-codecs/build/dcmjs-native-codecs.wasm', import.meta.url);
        }
        const stat = await fs.stat(path);
        if (stat.size < 8 || stat.size > MAX_WASM_BYTES) throw new Error('Invalid codec module size.');
        const bytes = await fs.readFile(path);
        if (bytes.byteLength > MAX_WASM_BYTES) throw new Error('Invalid codec module size.');
        return bytes;
    }
    const response = await fetch(url, { credentials: 'omit', redirect: 'error' });
    if (!response.ok || !response.body) throw new Error('Codec module is unavailable.');
    const reader = response.body.getReader();
    const chunks = [];
    let length = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            length += value.byteLength;
            if (length > MAX_WASM_BYTES) throw new Error('Invalid codec module size.');
            chunks.push(value);
        }
    } catch (error) {
        await reader.cancel().catch(() => {});
        throw error;
    } finally { reader.releaseLock(); }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return bytes;
}

async function createRuntime(injected) {
    const bytes = injected ?? await moduleBytes();
    if (!(bytes instanceof Uint8Array) && !(bytes instanceof ArrayBuffer) || bytes.byteLength < 8 || bytes.byteLength > MAX_WASM_BYTES) {
        throw new Error('Invalid codec module size.');
    }
    let api;
    const view = () => new DataView(api.memory.buffer);
    const imports = {
        env: {
            onCodecsException() { throw new Error('Compressed frame decoding failed.'); },
            onCodecsInfo() {}, onCodecsTrace() {},
            emscripten_notify_memory_growth() {
                if (api.memory.buffer.byteLength > MAX_WASM_MEMORY) throw new Error('Codec memory limit exceeded.');
            }
        },
        wasi_snapshot_preview1: {
            proc_exit() { throw new Error('Compressed frame decoding failed.'); },
            environ_get() { return 0; },
            environ_sizes_get(count, size) { view().setUint32(count, 0, true); view().setUint32(size, 0, true); return 0; },
            clock_time_get(id, precision, output) {
                if (id !== 0 && id !== 1) return 28;
                view().setBigUint64(output, 1000000n, true);
                return 0;
            },
            fd_write(fd, vectors, count, written) {
                if (fd !== 1 && fd !== 2) return 8;
                let length = 0;
                for (let index = 0; index < count; index++) length += view().getUint32(vectors + index * 8 + 4, true);
                view().setUint32(written, length, true);
                return 0; // Never decode or log native diagnostic strings.
            },
            fd_seek(fd, offset, whence, output) { if (output) view().setBigUint64(output, 0n, true); return 0; },
            fd_close() { return 0; }
        }
    };
    const { instance } = await WebAssembly.instantiate(bytes, imports);
    api = instance.exports;
    if (!(api.memory instanceof WebAssembly.Memory) || api.memory.buffer.byteLength > MAX_WASM_MEMORY) {
        throw new Error('Invalid codec module memory.');
    }
    api._initialize?.();
    return api;
}

function runtime(wasmBytes) {
    if (wasmBytes !== undefined) {
        if (!(wasmBytes instanceof Uint8Array) && !(wasmBytes instanceof ArrayBuffer)) return Promise.reject(new Error('Invalid codec module bytes.'));
        if (!injectedRuntimes.has(wasmBytes)) injectedRuntimes.set(wasmBytes, createRuntime(wasmBytes));
        return injectedRuntimes.get(wasmBytes);
    }
    defaultRuntime ??= createRuntime().catch(() => { defaultRuntime = undefined; throw new Error('Codec module could not be loaded.'); });
    return defaultRuntime;
}

function discardRuntime(wasmBytes) {
    if (wasmBytes !== undefined && typeof wasmBytes === 'object' && wasmBytes !== null) injectedRuntimes.delete(wasmBytes);
    else defaultRuntime = undefined;
}

/** Decode one validated frame into canonical native little-endian sample bytes. */
export async function decodeWasmFrame(bytes, metadata, { wasmBytes } = {}) {
    const { photometric, decodedBytes, codecBitsAllocated, codecDecodedBytes } = validateMetadata(bytes, metadata);
    let encodingWarnings, effectiveBitsStored;
    if (J2K.has(metadata.transferSyntax)) jpeg2000Header(bytes, metadata, photometric);
    else {
        const header = jpegHeader(bytes, metadata);
        encodingWarnings = header.encodingWarnings; effectiveBitsStored = header.effectiveBitsStored;
    }
    const codecBitsStored = effectiveBitsStored ?? metadata.bitsStored;
    const api = await runtime(wasmBytes).catch(() => {
        discardRuntime(wasmBytes);
        throw new Error('Codec module could not be loaded.');
    });
    let context = 0, parameters = 0;
    try {
        context = api.CreateCodecsContext();
        if (!context) throw new Error('Codec context allocation failed.');
        api.SetColumns(context, metadata.columns); api.SetRows(context, metadata.rows);
        api.SetBitsAllocated(context, codecBitsAllocated); api.SetBitsStored(context, codecBitsStored);
        api.SetSamplesPerPixel(context, metadata.samplesPerPixel); api.SetPixelRepresentation(context, metadata.signed ? 1 : 0);
        api.SetPlanarConfiguration(context, 0); api.SetPhotometricInterpretation(context, PHOTOMETRIC.indexOf(photometric));
        api.SetEncodedBufferSize(context, bytes.byteLength);
        const encodedPointer = api.GetEncodedBuffer(context);
        if (!encodedPointer || encodedPointer + bytes.byteLength > api.memory.buffer.byteLength) throw new Error('Codec input allocation failed.');
        new Uint8Array(api.memory.buffer, encodedPointer, bytes.byteLength).set(bytes);
        parameters = api.CreateDecoderParameters();
        if (!parameters) throw new Error('Codec parameters allocation failed.');
        // OpenJPEG returns MCT0 YBR_FULL components unchanged. Keep them explicit;
        // the owned compressed-frame dispatcher applies YBR to RGB once.
        api.SetConvertColorspaceToRgb(parameters, metadata.samplesPerPixel === 3 && photometric !== 'YBR_FULL');
        const decode = JPEG.has(metadata.transferSyntax) ? api.DecodeJpeg : JLS.has(metadata.transferSyntax) ? api.DecodeJpegLs : api.DecodeJpeg2000;
        decode(context, parameters);
        const planar = api.GetPlanarConfiguration(context);
        const decodedPhotometric = PHOTOMETRIC[api.GetPhotometricInterpretation(context)];
        if (api.GetColumns(context) !== metadata.columns || api.GetRows(context) !== metadata.rows ||
            api.GetBitsAllocated(context) !== codecBitsAllocated || api.GetBitsStored(context) !== codecBitsStored ||
            api.GetSamplesPerPixel(context) !== metadata.samplesPerPixel || api.GetPixelRepresentation(context) !== (metadata.signed ? 1 : 0) ||
            api.GetDecodedBufferSize(context) !== codecDecodedBytes || ![0, 1].includes(planar) ||
            ![photometric, metadata.samplesPerPixel === 3 ? 'RGB' : photometric].includes(decodedPhotometric)) {
            throw new Error('Codec output layout does not match the expected frame.');
        }
        const pointer = api.GetDecodedBuffer(context);
        if (!pointer || pointer + codecDecodedBytes > api.memory.buffer.byteLength || api.memory.buffer.byteLength > MAX_WASM_MEMORY) {
            throw new Error('Codec output allocation is invalid.');
        }
        if (photometric === 'YBR_FULL' && decodedPhotometric !== 'YBR_FULL') throw new Error('Codec output color space does not match YBR_FULL.');
        let result = new Uint8Array(api.memory.buffer, pointer, codecDecodedBytes).slice();
        if (codecBitsAllocated === 8 && metadata.bitsAllocated === 16) {
            const widened = new Uint8Array(decodedBytes);
            for (let index = 0; index < result.length; index++) widened[index * 2] = result[index];
            result = widened; // High bytes zero; decodeNative applies Bits Stored/signedness.
        }
        if (metadata.samplesPerPixel === 3 && planar === 1) {
            const interleaved = new Uint8Array(decodedBytes);
            const count = metadata.rows * metadata.columns;
            for (let index = 0; index < count; index++) for (let channel = 0; channel < 3; channel++) {
                interleaved[index * 3 + channel] = result[index + channel * count];
            }
            result = interleaved;
        }
        // The native context retains YBR_RCT/ICT after OpenJPEG's inverse MCT.
        // The validated COD transform and requested RGB conversion define the
        // output color space; copying the encoded label would convert it twice.
        return { bytes: result, metadataOverrides: { littleEndian: true,
            planarConfiguration: metadata.samplesPerPixel === 3 ? 0 : null,
            photometric: metadata.samplesPerPixel === 3 && photometric !== 'YBR_FULL' ? 'RGB' : photometric,
            ...(effectiveBitsStored ? { bitsStored: effectiveBitsStored, highBit: effectiveBitsStored - 1 } : {}),
            ...(encodingWarnings ? { encodingWarnings } : {}) } };
    } catch {
        discardRuntime(wasmBytes);
        throw new Error('Compressed frame decoding failed or produced an unsupported layout.');
    } finally {
        let releaseFailed = false;
        try { if (parameters) api.ReleaseDecoderParameters(parameters); } catch { releaseFailed = true; }
        try { if (context) api.ReleaseCodecsContext(context); } catch { releaseFailed = true; }
        if (releaseFailed) {
            discardRuntime(wasmBytes);
            throw new Error('Compressed frame decoder cleanup failed.');
        }
    }
}
