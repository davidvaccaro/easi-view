import { Transform } from 'node:stream';

const HEADER_BYTES = 16 * 1024;
const EXPLICIT_LE = '1.2.840.10008.1.2.1';
function parameters(value) {
    const parts = value.split(';').map(value => value.trim()), media = parts.shift().toLowerCase(), result = {};
    for (const part of parts) {
        const match = part.match(/^([A-Za-z0-9-]+)\s*=\s*(?:"([^"\r\n]*)"|([^\s;]+))$/u);
        if (!match || Object.hasOwn(result, match[1].toLowerCase())) throw new Error('Unsupported native-frame MIME profile.');
        result[match[1].toLowerCase()] = match[2] ?? match[3];
    }
    return { media, parameters: result };
}
export function validateNativeFrameMedia(contentType) {
    const media = parameters(contentType ?? '');
    if (media.media !== 'application/octet-stream' || Object.keys(media.parameters).some(key => key !== 'transfer-syntax') ||
        media.parameters['transfer-syntax'] != null && media.parameters['transfer-syntax'] !== EXPLICIT_LE) throw new Error('The gateway native-frame profile requires Explicit Little Endian pixels.');
}
export function proveNativeFrameLocation(value, upstreamUrl, downstreamUrl) {
    const expected = new URL(upstreamUrl), downstream = new URL(downstreamUrl);
    const framePath = /\/studies\/((?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*))*)\/series\/((?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*))*)\/instances\/((?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*))*)\/frames\/([1-9]\d{0,3}|10000)$/u;
    const first = expected.pathname.match(framePath), second = downstream.pathname.match(framePath);
    if (!first || !second || first.slice(1).some((part, index) => part.length > 64 || part !== second[index + 1]) ||
        [expected, downstream].some(url => !['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)) throw new Error('Configure proven selected native-frame endpoints.');
    if (typeof value !== 'string' || !value || value.length > 2048 || /[\x00-\x20\x7f\\]/u.test(value)) throw new Error('Unproven native-frame resource location.');
    let resolved; try { resolved = new URL(value, expected); } catch { throw new Error('Unproven native-frame resource location.'); }
    if (resolved.username || resolved.password || resolved.hash || resolved.href !== expected.href) throw new Error('Unproven native-frame resource location.');
    return downstream.href;
}

/** One proven Explicit-LE octet-stream part; only MIME headers and a tiny delimiter tail are retained. */
export function nativeFrameTransformer({ contentType, upstreamUrl, downstreamUrl, maxBytes = 64 * 1024 * 1024 } = {}) {
    const outer = parameters(contentType ?? '');
    const boundary = outer.parameters.boundary;
    if (outer.media !== 'multipart/related' || outer.parameters.type !== 'application/octet-stream' || typeof boundary !== 'string' ||
        !/^[A-Za-z0-9'()+_,.\/:=?-]{1,70}$/u.test(boundary) || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 64 * 1024 * 1024) throw new Error('Unsupported native-frame MIME profile.');
    const start = `--${boundary}\r\n`, marker = Buffer.from(`\r\n--${boundary}`), closing = Buffer.from(`\r\n--${boundary}--`);
    let header = Buffer.alloc(0), tail = Buffer.alloc(0), terminal = null, ready = false, pixelBytes = 0, declared = null;
    function emitPixels(stream, bytes) {
        pixelBytes += bytes.length;
        if (pixelBytes > maxBytes || declared != null && pixelBytes > declared) throw new Error('Native-frame byte limit exceeded.');
        if (bytes.length) stream.push(bytes);
    }
    function body(stream, chunk) {
        if (terminal) {
            if (terminal.length + chunk.length > closing.length + 2) throw new Error('Native-frame response contains an additional part or epilogue.');
            terminal = Buffer.concat([terminal, chunk]);
            if (!Buffer.concat([closing, Buffer.from('\r\n')]).subarray(0, terminal.length).equals(terminal)) throw new Error('Native-frame response contains an additional part.');
            return;
        }
        const bytes = Buffer.concat([tail, chunk]);
        const index = bytes.indexOf(marker);
        if (index >= 0) {
            emitPixels(stream, bytes.subarray(0, index)); terminal = Buffer.alloc(0); tail = Buffer.alloc(0); body(stream, bytes.subarray(index)); return;
        }
        const retained = Math.min(bytes.length, marker.length + 4);
        emitPixels(stream, bytes.subarray(0, bytes.length - retained)); tail = bytes.subarray(bytes.length - retained);
    }
    function parseHeader(stream, bytes) {
        const raw = bytes.toString('ascii');
        if (!raw.startsWith(start) || bytes.some(value => value < 32 && value !== 13 && value !== 10 || value > 126)) throw new Error('Unsupported native-frame MIME headers.');
        const fields = {};
        for (const line of raw.slice(start.length).split('\r\n')) {
            const match = line.match(/^([A-Za-z0-9-]+):\s*(.*)$/u);
            if (!match || Object.hasOwn(fields, match[1].toLowerCase()) || !['content-type', 'content-location', 'content-length'].includes(match[1].toLowerCase())) throw new Error('Unsupported native-frame MIME headers.');
            fields[match[1].toLowerCase()] = match[2];
        }
        validateNativeFrameMedia(fields['content-type']);
        const location = proveNativeFrameLocation(fields['content-location'], upstreamUrl, downstreamUrl);
        if (fields['content-length'] != null) {
            if (!/^\d+$/u.test(fields['content-length'])) throw new Error('Invalid native-frame length.');
            declared = Number(fields['content-length']); if (!Number.isSafeInteger(declared) || declared < 1 || declared > maxBytes) throw new Error('Invalid native-frame length.');
        }
        const rewritten = `${start}Content-Type: ${fields['content-type']}\r\nContent-Location: ${location}\r\n${declared == null ? '' : `Content-Length: ${declared}\r\n`}\r\n`;
        stream.push(Buffer.from(rewritten)); ready = true;
    }
    return new Transform({ transform(chunk, _encoding, done) {
        try {
            if (ready) { body(this, chunk); done(); return; }
            const take = Math.min(chunk.length, HEADER_BYTES - header.length);
            header = Buffer.concat([header, chunk.subarray(0, take)]);
            const end = header.indexOf('\r\n\r\n');
            if (end < 0) { if (header.length >= HEADER_BYTES) throw new Error('Native-frame MIME headers exceed16KiB.'); done(); return; }
            parseHeader(this, header.subarray(0, end));
            body(this, header.subarray(end + 4)); header = Buffer.alloc(0);
            body(this, chunk.subarray(take)); done();
        } catch (error) { done(error); }
    }, flush(done) {
        try {
            if (!ready || !terminal || !(terminal.equals(closing) || terminal.equals(Buffer.concat([closing, Buffer.from('\r\n')]))) || pixelBytes < 1 || declared != null && pixelBytes !== declared) throw new Error('The native-frame envelope is incomplete or contains extra parts.');
            this.push(terminal); done();
        } catch (error) { done(error); }
    } });
}
