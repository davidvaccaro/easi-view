import { abortError, checkAbort } from '../runtime/native-decoder.js';

export const MAX_BULK_FRAME_BYTES = 64 * 1024 * 1024;
const MAX_HEADERS = 16 * 1024;
const MAX_ENVELOPE = MAX_HEADERS + 512;
const NATIVE_SYNTAX = '1.2.840.10008.1.2.1';
const invalid = () => new Error('The archive returned an unsupported or malformed native frame response.');

function mediaType(value) {
    if (typeof value !== 'string' || value.length > 1024 || /[\r\n]/.test(value)) throw invalid();
    const parts = value.split(';');
    const media = parts.shift().trim().toLowerCase();
    const parameters = new Map();
    for (const part of parts) {
        const match = /^\s*([\w-]+)\s*=\s*(?:"([^"\\]*)"|([^\s";]+))\s*$/.exec(part);
        if (!match || parameters.has(match[1].toLowerCase())) throw invalid();
        parameters.set(match[1].toLowerCase(), match[2] ?? match[3]);
    }
    return { media, parameters };
}

function equalAt(bytes, pattern, offset) {
    return offset >= 0 && offset + pattern.length <= bytes.length && pattern.every((value, index) => bytes[offset + index] === value);
}

function locate(bytes, pattern, start, end = bytes.length) {
    for (let offset = start; offset + pattern.length <= end; offset++) if (equalAt(bytes, pattern, offset)) return offset;
    return -1;
}

function nativeType(value) {
    const type = mediaType(value);
    if (type.media !== 'application/octet-stream' || [...type.parameters.keys()].some(key => key !== 'transfer-syntax') ||
        (type.parameters.has('transfer-syntax') && type.parameters.get('transfer-syntax') !== NATIVE_SYNTAX)) throw invalid();
}

/** A single explicitly requested native frame, never a rendered JPEG or an arbitrary bulk URL. */
export async function readNativeFrame(response, { signal, expectedUrl, expectedBytes, maxBytes = MAX_BULK_FRAME_BYTES } = {}) {
    let reader;
    let exhausted = false;
    const cancel = () => { void reader?.cancel(abortError()).catch(() => {}); };
    try {
        checkAbort(signal);
        if (!Number.isSafeInteger(expectedBytes) || expectedBytes <= 0 || !Number.isSafeInteger(maxBytes) ||
            maxBytes <= 0 || maxBytes > MAX_BULK_FRAME_BYTES || expectedBytes > maxBytes || !response.body) throw invalid();
        const outer = mediaType(response.headers.get('content-type'));
        if (outer.media !== 'multipart/related' || outer.parameters.get('type')?.toLowerCase() !== 'application/octet-stream' ||
            [...outer.parameters.keys()].some(key => !['type', 'boundary', 'transfer-syntax'].includes(key)) ||
            (outer.parameters.has('transfer-syntax') && outer.parameters.get('transfer-syntax') !== NATIVE_SYNTAX)) throw invalid();
        const boundary = outer.parameters.get('boundary');
        if (!boundary || !/^[0-9A-Za-z'()+_,.\/:=? -]{1,70}$/.test(boundary) || boundary.endsWith(' ')) throw invalid();
        const maximum = Math.min(maxBytes, expectedBytes) + MAX_ENVELOPE;
        const declared = response.headers.get('content-length');
        if (declared != null && (!/^\d+$/.test(declared) || Number(declared) > maximum)) throw invalid();
        reader = response.body.getReader();
        signal?.addEventListener('abort', cancel, { once: true });
        const chunks = [];
        let length = 0;
        while (true) {
            checkAbort(signal);
            const chunk = await reader.read();
            checkAbort(signal);
            if (chunk.done) { exhausted = true; break; }
            if (!(chunk.value instanceof Uint8Array)) throw invalid();
            length += chunk.value.byteLength;
            if (length > maximum) throw invalid();
            chunks.push(chunk.value);
        }
        const bytes = new Uint8Array(length);
        let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
        chunks.length = 0;
        const encoder = new TextEncoder();
        const opening = encoder.encode(`--${boundary}\r\n`);
        if (!equalAt(bytes, opening, 0)) throw invalid();
        const headerEnd = locate(bytes, Uint8Array.of(13, 10, 13, 10), opening.length, Math.min(length, opening.length + MAX_HEADERS));
        if (headerEnd < 0) throw invalid();
        const headerBytes = bytes.subarray(opening.length, headerEnd);
        if (headerBytes.some(value => value > 126 || value < 32 && value !== 13 && value !== 10)) throw invalid();
        const headers = new Map();
        for (const line of new TextDecoder().decode(headerBytes).split('\r\n')) {
            const match = /^([A-Za-z0-9-]+): *([^\r\n]*)$/.exec(line);
            if (!match || headers.has(match[1].toLowerCase())) throw invalid();
            headers.set(match[1].toLowerCase(), match[2].trim());
        }
        if ([...headers.keys()].some(key => !['content-type', 'content-location', 'content-length'].includes(key))) throw invalid();
        nativeType(headers.get('content-type'));
        // A native frame has no embedded SOP identity. Bind it to the requested
        // resource using Content-Location; never follow that location as a URL.
        const location = headers.get('content-location');
        let actual, expected;
        try { expected = new URL(expectedUrl); actual = new URL(location, expected); } catch { throw invalid(); }
        if (!location || actual.href !== expected.href || actual.username || actual.password || actual.hash || actual.search) throw invalid();
        const payloadStart = headerEnd + 4;
        const closing = encoder.encode(`\r\n--${boundary}--`);
        const payloadEnd = payloadStart + expectedBytes;
        if (!equalAt(bytes, closing, payloadEnd)) throw invalid();
        const suffix = bytes.subarray(payloadEnd + closing.length);
        if (suffix.length && !(suffix.length === 2 && suffix[0] === 13 && suffix[1] === 10)) throw invalid();
        if (headers.has('content-length') && headers.get('content-length') !== String(expectedBytes)) throw invalid();
        checkAbort(signal);
        return bytes.slice(payloadStart, payloadEnd); // Own only the requested frame, without MIME storage.
    } finally {
        signal?.removeEventListener('abort', cancel);
        if (!exhausted) {
            try { if (reader) await reader.cancel(); else await response.body?.cancel(); } catch {}
        }
        try { reader?.releaseLock(); } catch {}
    }
}
