import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { delay } from './browser-session.mjs';

// Fixed operational failures are safe to persist; unknown diagnostic text stays private.
export function safeCorpusFailure(error) {
    const message = String(error?.message || ''), name = String(error?.name || '');
    const unsupported = [
        'This DICOM object type is outside the 2D image profile supported by this alpha.',
        'This DICOM transfer syntax does not have a verified pixel decoder.',
        'The frame exceeds the 16-megapixel alpha limit.',
        'This alpha requires a supported scalar/palette image with one sample per pixel or RGB with three samples per pixel.',
        'Compressed palette indices require native retrieval or the verified RLE profile.',
        'Native RGB requires unsigned 8-bit channels, Planar Configuration 0 or 1, and no scalar transforms.',
        'This browser cannot create a WebGL2 or Canvas2D image viewport.',
        'Enhanced shared/per-frame functional groups need a dedicated geometry implementation and are not supported by this alpha.',
        'YBR_RCT/ICT require the corresponding verified JPEG2000 profile.', 'RLE YBR_FULL_422 is not a supported color profile.',
        'This alpha supports 8-bit and 16-bit native pixels.',
        'This alpha supports native RGB only with unsigned 8-bit channels, Bits Stored 8 and High Bit 7.',
        'RGB/palette color does not support scalar rescale or pixel padding transforms.',
        'RGB ICC profiles and declared color spaces require a color-management implementation and are not supported by this alpha.',
        'Classic XA requires fixed declared timing; variable frame-time vectors are unsupported for this profile.',
        'Enhanced CT/MR currently requires a verified monochrome pixel profile.',
        'Enhanced DICOM LUT and real-world value transformations require a dedicated presentation implementation.',
        'Unsupported or invalid DICOM presentation: alpha, segmented and enhanced palettes require a separate profile.',
        'Unsupported undefined-length UN sequence value.',
        'Deflated Explicit VR Little Endian datasets are not supported.',
        'Embedded HP color transforms require a dedicated decoding profile.',
        'This classic XA profile does not support nonidentity modality rescale or quantitative rescale units.',
        'This classic XA profile requires Pixel Intensity Relationship LIN or DISP; LOG images need a dedicated LUT implementation.',
        'Classic XA mask subtraction is not supported. Open native, unsubtracted image frames.',
        'Classic XA mask subtraction is not supported. Mask operations must be NONE for native viewing.',
        'This classic XA profile supports native (NAT) viewing only.',
        'Classic XA display shutters require a presentation implementation and are not supported by this profile.',
        'Classic XA Pixel Intensity Relationship LUTs are not supported by this profile.',
        'Unsupported lossless JPEG predictor or point transform.', 'JPEG 2000 component overrides or ROI coding are not supported.',
        'The input exceeds the 256 MiB source limit. Load a smaller series.',
        'The selected files exceed the 256 MiB source limit. Load a smaller series.',
        'The response exceeds the 256 MiB source limit. Retrieve a smaller series.', 'Codec memory limit exceeded.'
    ];
    const invalid = [
        'The source does not contain a DICOM image dataset.',
        'Invalid native image dimensions or pixel metadata.',
        'The DICOM numeric metadata has an unsupported encoding.',
        'The DICOM numeric metadata contains invalid values.',
        'Unsupported or inconsistent native pixel bit layout.',
        'The native frame byte length does not match its dimensions.',
        'The number of stored samples does not match the frame dimensions.', 'Invalid pixel rescale transform.',
        'Invalid pixel padding metadata.', 'Pixel Padding Range Limit requires a Pixel Padding Value.',
        'Pixel Data encoding does not match its transfer syntax, or is missing or incomplete.',
        'The native Pixel Data length does not match its frame count and dimensions.',
        'The DICOM image is missing a SOP or Series Instance UID.', 'Invalid Frame of Reference UID.',
        'Invalid native frame byte length.', 'Invalid native YBR frame length.',
        'JPEG Baseline codestream dimensions, components or precision do not match the DICOM metadata.',
        'Compressed codestream dimensions, components, precision or signedness do not match the DICOM metadata.',
        'Invalid or unsupported compressed frame header.',
        'Unexpected end of DICOM input. Incomplete data element, sequence, or item.',
        'Unsupported or invalid DICOM presentation: Window Center and Width multiplicities differ.',
        'Invalid enhanced DICOM functional-group metadata.',
        'Invalid DICOM RLE frame: segment offsets are not valid increasing byte boundaries.',
        'Invalid DICOM RLE frame: the segment contains extra encoded samples.'
    ];
    if (unsupported.includes(message)) return { status: 'unsupported', reason: message, reasonCode: 'unsupported-viewer-profile' };
    if (invalid.includes(message)) return { status: 'invalid', reason: message, reasonCode: 'invalid-image-data' };
    if (/^Frame dimensions exceed this GPU's \d+-pixel texture limit\.$/.test(message)) return { status: 'unsupported', reason: message, reasonCode: 'gpu-texture-limit' };
    if (/^The GPU could not upload this image frame \(WebGL error \d+\)\.$/.test(message)) return { status: 'failed', reason: message, reasonCode: 'gpu-upload-failed' };
    if (name === 'AbortError') return { status: 'failed', reason: 'The viewer operation was canceled.', reasonCode: 'viewer-operation-canceled' };
    return { status: 'failed', reason: 'Unexpected viewer error; raw diagnostic text was withheld.', reasonCode: 'unclassified-viewer-error' };
}

// The SDK reports a concrete frame error before rejecting navigation with a
// generic wrapper. Only the current operation's sanitized event can explain it.
export function safeCorpusOperationFailure(error, stage, frameFailure) {
    const direct = safeCorpusFailure(error);
    if (stage === 'setFrame' && error?.message === 'The requested frame could not be displayed.' && frameFailure
        && frameFailure.reasonCode !== 'unclassified-viewer-error') return { ...frameFailure };
    return direct;
}

// Opt-in local QA only. Originals enter through Chrome's File API, never HTTP.
// The generated host records technical counters/hashes, never source pixels,
// filenames, patient metadata, identifiers, screenshots or arbitrary errors.
async function corpusHostRuntime(sdkUrl) {
    const { createViewer } = await import(sdkUrl);
    const mount = document.getElementById('corpus-mount'), input = document.getElementById('corpus-file-input');
    const records = new WeakMap(), textureRecords = new WeakMap();
    let viewer, shadow, operation, sequence = 0, commits = 0, lastError = null;
    const workers = { created: 0, terminated: 0, active: 0 }; let workerBaseline = { created: 0, terminated: 0 };
    const NativeWorker = Worker;
    window.Worker = class extends NativeWorker {
        constructor(...args) { super(...args); workers.created++; workers.active++; this.corpusTerminated = false; }
        terminate() { if (!this.corpusTerminated) { this.corpusTerminated = true; workers.terminated++; workers.active--; } return super.terminate(); }
    };
    const hashBytes = bytes => {
        let hash = 2166136261;
        for (let index = 0; index < bytes.length; index++) hash = Math.imul(hash ^ bytes[index], 16777619);
        return (hash >>> 0).toString(16).padStart(8, '0');
    };
    function recordFor(canvas, backend) {
        if (!records.has(canvas)) records.set(canvas, { backend, uploads: 0, draws: 0, glErrors: 0, lastDrawOk: false,
            uploadChecksum: null, displayChecksum: null, rows: 0, columns: 0, matrix: null, cpuChecksum: null });
        return records.get(canvas);
    }
    function instrument(context, kind, canvas) {
        if (!context || context.__corpusHook) return context;
        context.__corpusHook = true;
        const record = recordFor(canvas, kind === 'webgl2' ? 'webgl2' : 'canvas2d');
        if (kind === 'webgl2') {
            const upload = context.texImage2D.bind(context), draw = context.drawArrays.bind(context), getError = context.getError.bind(context);
            const active = context.activeTexture.bind(context), bind = context.bindTexture.bind(context), remove = context.deleteTexture.bind(context);
            let unit = context.TEXTURE0; const bindings = new Map();
            context.activeTexture = value => { active(value); unit = value; };
            context.bindTexture = (target, texture) => { bind(target, texture); if (target === context.TEXTURE_2D) bindings.set(unit, texture); };
            context.deleteTexture = texture => { remove(texture); for (const [key, value] of bindings) if (value === texture) bindings.delete(key); if (texture) textureRecords.delete(texture); };
            context.getError = () => { const code = getError(); if (code !== context.NO_ERROR) record.glErrors++; return code; };
            context.texImage2D = (...args) => {
                upload(...args);
                const data = args[8], texture = bindings.get(unit);
                if (texture && ArrayBuffer.isView(data) && [context.RED, context.RGB, context.RGBA].includes(args[6])) {
                    textureRecords.set(texture, { rows: args[4], columns: args[3], format: args[6],
                        checksum: hashBytes(new Uint8Array(data.buffer, data.byteOffset, data.byteLength)), used: false });
                }
            };
            context.drawArrays = (...args) => {
                draw(...args); record.lastDrawOk = false;
                const code = context.getError(); if (code !== context.NO_ERROR || context.isContextLost()) return;
                const program = context.getParameter(context.CURRENT_PROGRAM);
                const dimensions = program && context.getUniform(program, context.getUniformLocation(program, 'dimensions'));
                const matrix = program && context.getUniform(program, context.getUniformLocation(program, 'imageToClip'));
                const uploaded = textureRecords.get(bindings.get(context.TEXTURE0));
                if (!dimensions || !matrix || !uploaded || uploaded.columns !== dimensions[0] || uploaded.rows !== dimensions[1]) return;
                if (!uploaded.used) { uploaded.used = true; record.uploads++; }
                const sample = new Uint8Array(16); let count = 0;
                for (const [x, y] of [[.5, .5], [dimensions[0] / 2, dimensions[1] / 2], [dimensions[0] - .5, dimensions[1] - .5], [dimensions[0] - .5, .5]]) {
                    const px = Math.floor((matrix[0] * x + matrix[3] * y + matrix[6] + 1) * canvas.width / 2);
                    const py = Math.floor((matrix[1] * x + matrix[4] * y + matrix[7] + 1) * canvas.height / 2);
                    if (px < 0 || py < 0 || px >= canvas.width || py >= canvas.height) continue;
                    context.readPixels(px, py, 1, 1, context.RGBA, context.UNSIGNED_BYTE, sample.subarray(count * 4, count * 4 + 4)); count++;
                }
                if (context.getError() !== context.NO_ERROR || count === 0) return;
                record.draws++; record.lastDrawOk = true; record.rows = uploaded.rows; record.columns = uploaded.columns;
                record.uploadChecksum = uploaded.checksum; record.displayChecksum = hashBytes(sample.subarray(0, count * 4)); record.matrix = Array.from(matrix);
            };
        } else if (kind === '2d') {
            const put = context.putImageData.bind(context), draw = context.drawImage.bind(context);
            context.putImageData = (...args) => { put(...args); const image = args[0]; record.cpuChecksum = hashBytes(image.data); record.rows = image.height; record.columns = image.width; record.uploads++; };
            context.drawImage = (...args) => {
                draw(...args); const source = records.get(args[0]);
                if (!source?.cpuChecksum) return;
                record.draws++; record.uploads = source.uploads; record.lastDrawOk = true; record.rows = source.rows; record.columns = source.columns;
                record.uploadChecksum = source.cpuChecksum; record.displayChecksum = source.cpuChecksum;
                const m = context.getTransform(); record.cpuTransform = [m.a, m.b, m.c, m.d, m.e, m.f];
            };
        }
        return context;
    }
    const htmlContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (kind, ...args) { return instrument(htmlContext.call(this, kind, ...args), kind, this); };
    if (typeof OffscreenCanvas === 'function') {
        const offscreenContext = OffscreenCanvas.prototype.getContext;
        OffscreenCanvas.prototype.getContext = function (kind, ...args) { return instrument(offscreenContext.call(this, kind, ...args), kind, this); };
    }
    const canvas = () => shadow?.querySelector('.viewport-canvas');
    const start = (work, stage) => {
        const token = ++sequence; operation = { token, stage, done: false, ok: false };
        Promise.resolve().then(work).then(() => { if (operation?.token === token) Object.assign(operation, { done: true, ok: true }); }, error => {
            if (operation?.token === token) Object.assign(operation, { done: true, ok: false, failure: safeOperationFailure(error, stage, operation.frameFailure) });
        });
        return token;
    };
    const resources = () => viewer?.getPerformance().resources || null;
    const snapshot = () => {
        const state = viewer?.getState(), workspace = viewer?.getWorkspaceState(), source = canvas() && records.get(canvas());
        const errorBanner = shadow?.getElementById('error-banner');
        return { operation, commits, error: Boolean(errorBanner && !errorBanner.hidden), lastError,
            state: state ? { disposed: state.disposed, busy: state.busy, seriesCount: state.seriesCount, frameIndex: state.frameIndex, frameCount: state.frameCount,
                playing: state.playing, image: state.image ? { rows: state.image.rows, columns: state.image.columns, photometric: state.image.photometric,
                    samplesPerPixel: state.image.samplesPerPixel, calibrated: state.image.calibrated, geometryWarningCount: state.image.geometryWarnings.length,
                    timingWarningCount: state.image.timingWarnings?.length || 0, encodingWarningCount: state.image.encodingWarnings?.length || 0 } : null,
                window: state.window, transform: workspace.viewports[workspace.activeViewport]?.transform } : null,
            render: source ? { backend: source.backend, uploads: source.uploads, draws: source.draws, glErrors: source.glErrors, lastDrawOk: source.lastDrawOk,
                uploadChecksum: source.uploadChecksum, displayChecksum: source.displayChecksum, rows: source.rows, columns: source.columns,
                checksumRepresentation: source.backend === 'webgl2' ? 'uploaded-stored-float32-or-rgb-bytes' : 'cpu-rendered-rgba' } : null,
            resources: resources(), workerCounts: { created: workers.created - workerBaseline.created, terminated: workers.terminated - workerBaseline.terminated, active: workers.active },
            budgets: workspace ? { decoded: workspace.decodedBytes, decodedLimit: workspace.cacheBudget,
                encoded: workspace.encodedBytes, encodedLimit: workspace.encodedCacheBudget, workers: workspace.workerCount } : null };
    };
    const profile = () => {
        const state = viewer.getState(), allowedModality = new Set(['CT', 'MR', 'CR', 'DX', 'US', 'XA', 'RF', 'MG', 'PT', 'NM', 'OT']);
        shadow.getElementById('inspector-tab-attributes').click(); const search = shadow.getElementById('attributes-search');
        const value = tag => { search.value = tag; search.dispatchEvent(new Event('input', { bubbles: true })); const row = shadow.querySelector('.attributes-row'); return row?.querySelector('.attributes-value')?.textContent.trim() || ''; };
        const numeric = tag => { const text = value(tag); return /^\d{1,6}$/.test(text) ? Number(text) : null; };
        const technicalUid = (tag, prefix) => { const text = value(tag); return text.startsWith(prefix) && /^[\d.]{1,64}$/.test(text) ? text : null; };
        const result = { modality: allowedModality.has(state.modality) ? state.modality : 'other', ...snapshot().state.image, frameCount: state.frameCount,
            bitsAllocated: numeric('00280100'), bitsStored: numeric('00280101'), highBit: numeric('00280102'), pixelRepresentation: numeric('00280103'),
            transferSyntax: technicalUid('00020010', '1.2.840.10008.1.2'), sopClass: technicalUid('00080016', '1.2.840.10008.5.1.4.1.1.') };
        search.value = ''; search.dispatchEvent(new Event('input', { bubbles: true }));
        result.attributesShown = shadow.querySelectorAll('.attributes-row').length;
        shadow.getElementById('inspector-tab-details').click(); return result;
    };
    const points = () => {
        const c = canvas(), r = c.getBoundingClientRect(), source = records.get(c), state = viewer.getState(), column = state.image.columns / 2, row = state.image.rows / 2;
        let x = r.width / 2, y = r.height / 2;
        if (source?.matrix) { const m = source.matrix; x = (m[0] * column + m[3] * row + m[6] + 1) * r.width / 2; y = (1 - (m[1] * column + m[4] * row + m[7])) * r.height / 2; }
        else if (source?.cpuTransform) { const m = source.cpuTransform; x = (m[0] * column + m[2] * row + m[4]) / devicePixelRatio; y = (m[1] * column + m[3] * row + m[5]) / devicePixelRatio; }
        return { x: r.x + x, y: r.y + y, canvas: { x: r.x, y: r.y, width: r.width, height: r.height } };
    };
    let roiCheck, uiCheck;
    async function testRoi() {
        const state = viewer.getState(), color = ['RGB', 'PALETTE COLOR'].includes(state.image.photometric);
        const annotation = viewer.addAnnotation({ tool: 'rectangle', points: [{ x: 0, y: 0 }, { x: Math.min(4, state.image.columns), y: Math.min(4, state.image.rows) }] });
        try {
            const before = viewer.measureAnnotation(annotation.id), beforeJson = JSON.stringify({ geometry: before.geometry, statistics: before.statistics }), originalWindow = state.window;
            if (!color) viewer.setWindow({ center: originalWindow.center + originalWindow.width / 10, width: originalWindow.width * 1.2 });
            const after = viewer.measureAnnotation(annotation.id);
            roiCheck = { invariant: beforeJson === JSON.stringify({ geometry: after.geometry, statistics: after.statistics }), calibrated: before.geometry.calibrated, pixelCount: before.statistics.pixelCount,
                colorScalarDeclined: color ? before.statistics.status === 'color-intensity-unavailable' && before.statistics.stored === null : null,
                resultChecksum: hashBytes(new TextEncoder().encode(beforeJson)) };
            if (!color) viewer.reset();
        } finally { viewer.removeAnnotation(annotation.id); }
    }
    window.__corpus = {
        ready: true, snapshot, profile, points,
        begin() { return start(async () => { if (viewer) { viewer.dispose(); await viewer.whenDisposed(); } input.value = ''; mount.replaceChildren(); commits = 0; lastError = null; roiCheck = uiCheck = null;
            workerBaseline = { created: workers.created, terminated: workers.terminated };
            viewer = createViewer(mount, { initialDemo: null }); await viewer.ready; shadow = mount.querySelector('easi-view-embed').shadowRoot;
            viewer.on('framechange', () => { commits++; }); viewer.on('error', detail => {
                lastError = safeFailure({ message: detail.message });
                if (operation && !operation.done && detail.title === 'Unable to display this frame') operation.frameFailure = lastError;
            }); }, 'mount'); },
        open() { return start(() => viewer.openFiles(input.files), 'open'); },
        command(name, ...args) { if (!['setSeries', 'setFrame', 'setTool', 'setWindow', 'reset', 'play', 'pause'].includes(name)) throw new Error('Unknown QA command.'); return start(() => viewer[name](...args), name); },
        roi() { return start(testRoi, 'roi'); }, roiResult() { return roiCheck; },
        probeVisible() { return /^Pixel \(\d+, \d+\)$/.test(shadow.getElementById('probe-coordinate').textContent.trim()); },
        rotate() { shadow.getElementById('rotate-view').click(); return snapshot().state.transform.rotation; },
        ui() {
            const image = viewer.getState().image, color = ['RGB', 'PALETTE COLOR'].includes(image.photometric);
            const button = shadow.querySelector('.image-notice-button'), notice = shadow.querySelector('.image-notice-popover');
            const geometryWarningCount = image.geometryWarnings?.length || 0, encodingWarningCount = image.encodingWarnings?.length || 0;
            const timingWarningCount = image.timingWarnings?.length || 0, warningCount = geometryWarningCount + encodingWarningCount + timingWarningCount;
            const canvas = shadow.querySelector('.workspace-pane.active .viewport-canvas') || shadow.querySelector('.viewport-canvas');
            const bounds = () => { const rect = canvas.getBoundingClientRect(); return [rect.x, rect.y, rect.width, rect.height]; }, before = bounds();
            const noticesShown = (category, warnings) => {
                const group = notice.querySelector('[data-notice-group="' + category + '"]');
                const messages = group ? [...group.querySelectorAll('.image-notice-message')].map(node => node.textContent) : [];
                return !notice.hidden && warnings.every(message => messages.includes(message));
            };
            let opened = null, closed = null, reopened = null, messagesRetained = null, acknowledged = null;
            let geometryNoticeVisible = null, encodingNoticeVisible = null, timingNoticeVisible = null;
            if (warningCount) {
                button.click(); opened = !notice.hidden;
                geometryNoticeVisible = geometryWarningCount > 0 ? noticesShown('geometry', image.geometryWarnings) : null;
                encodingNoticeVisible = encodingWarningCount > 0 ? noticesShown('encoding', image.encodingWarnings) : null;
                timingNoticeVisible = timingWarningCount > 0 ? noticesShown('timing', image.timingWarnings) : null;
                notice.querySelector('.image-notice-acknowledge').click(); acknowledged = button.dataset.unread === 'false';
                if (notice.hidden) button.click();
                messagesRetained = noticesShown('geometry', image.geometryWarnings) && noticesShown('encoding', image.encodingWarnings) && noticesShown('timing', image.timingWarnings);
                notice.querySelector('.image-notice-close').click(); closed = notice.hidden;
                button.click(); reopened = !notice.hidden && noticesShown('geometry', image.geometryWarnings) && noticesShown('encoding', image.encodingWarnings) && noticesShown('timing', image.timingWarnings);
                notice.querySelector('.image-notice-close').click();
            }
            uiCheck = { color, windowDisabled: shadow.getElementById('window-width').disabled, invertDisabled: shadow.getElementById('invert-view').disabled,
                warningCount, geometryWarningCount, geometryNoticeVisible, encodingWarningCount, encodingNoticeVisible, timingWarningCount, timingNoticeVisible,
                noticeOpened: opened, noticeClosed: closed, noticeReopened: reopened, noticeMessagesRetained: messagesRetained, noticeAcknowledged: acknowledged,
                noticeButtonDisabled: button.disabled, viewportUnchanged: before.every((value, index) => Math.abs(value - bounds()[index]) < 0.5),
                noInlineNotice: !shadow.getElementById('geometry-notice') && !shadow.getElementById('detail-geometry-notice') }; return uiCheck;
        },
        startCine() { shadow.getElementById('cine-fps').value = '10'; viewer.setFrame(0).then(() => viewer.play()).catch(error => { lastError = safeFailure(error); }); },
        dispose() { return start(async () => { viewer?.dispose(); if (viewer) await viewer.whenDisposed(); input.value = ''; }, 'cleanup'); }
    };
}

export async function writeCorpusHost({ directory, sdkUrl = '/assets/easi-view.js' }) {
    if (typeof directory !== 'string' || !directory || typeof sdkUrl !== 'string' || !sdkUrl.startsWith('/')) throw new TypeError('Use a private host directory and a same-origin SDK path.');
    await mkdir(directory, { recursive: true });
    await writeFile(resolve(directory, 'index.html'), '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="data:,"><link rel="stylesheet" href="host.css"><input id="corpus-file-input" type="file" hidden><main id="corpus-mount"></main><script type="module" src="host.js"></script>');
    await writeFile(resolve(directory, 'host.css'), 'html,body{margin:0;height:100%;background:#090f18}#corpus-mount{height:100vh;width:100%}');
    await writeFile(resolve(directory, 'host.js'), `const safeCorpusFailure = ${safeCorpusFailure.toString()};\nconst safeFailure = safeCorpusFailure;\nconst safeOperationFailure = ${safeCorpusOperationFailure.toString()};\n(${corpusHostRuntime.toString()})(${JSON.stringify(sdkUrl)});\n`);
}

export async function initializeCorpusBrowser({ browser, url }) {
    const target = new URL(url);
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname)) throw new TypeError('Local corpus QA requires a loopback host.');
    await browser.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    await browser.send('Page.navigate', { url: target.href });
    await browser.until('window.__corpus?.ready', 'The isolated corpus host did not become ready.');
}

export async function exerciseCorpusFile({ browser, path, timeoutMs = 30000, allFrames = true }) {
    if (typeof path !== 'string' || !path || !Number.isFinite(timeoutMs) || timeoutMs < 1000 || typeof allFrames !== 'boolean') throw new TypeError('Supply a local file path, timeout and frame scope.');
    const started = performance.now(), deadline = started + timeoutMs, checks = [], series = [], timings = {}, beforeExceptions = browser.errors.length, beforeConsole = browser.consoleErrors.length, beforeRequests = browser.requests.length;
    let stage = 'mount', result, peak = {}, cleanup, totalFrames = 0;
    const evaluate = expression => browser.evaluate(expression);
    const snapshot = () => evaluate('window.__corpus.snapshot()');
    const fail = reason => { const error = new Error(reason); error.corpusReason = reason; throw error; };
    async function poll(condition, label) {
        while (performance.now() < deadline) { const value = await evaluate(condition); if (value) return value; await delay(40); }
        fail(`timeout-${label}`);
    }
    async function operation(expression, label) {
        stage = label; const token = await evaluate(expression);
        const completed = await poll(`(()=>{const op=window.__corpus.snapshot().operation;return op?.token===${token}&&op.done?op:null;})()`, label);
        if (!completed.ok) { result = { ...completed.failure, stage: label }; fail('operation-rejected'); }
    }
    const command = (name, ...args) => operation(`window.__corpus.command(${JSON.stringify(name)},...${JSON.stringify(args)})`, name);
    function inspectResources(observation) {
        for (const [key, value] of Object.entries(observation.resources || {})) if (typeof value === 'number') peak[key] = Math.max(peak[key] || 0, value);
        const b = observation.budgets;
        if (b && (b.decoded > b.decodedLimit || b.encoded > b.encodedLimit || b.workers > 1 || observation.workerCounts.active > 1)) fail('owned-resource-budget-exceeded');
    }
    function displayed(observation, index) {
        if (!observation.state?.image || observation.state.frameIndex !== index || observation.state.busy || observation.error || !observation.render?.lastDrawOk || observation.render.uploads < 1 || observation.render.draws < 1 || observation.render.glErrors > 0 || observation.commits < 1) fail('frame-not-successfully-uploaded-drawn-and-committed');
        inspectResources(observation);
    }
    async function drag(tool, delta) {
        await command('setTool', tool); const point = await evaluate('window.__corpus.points()');
        const x = Math.max(point.canvas.x + 8, Math.min(point.canvas.x + point.canvas.width - 8, point.x));
        const y = Math.max(point.canvas.y + 8, Math.min(point.canvas.y + point.canvas.height - 8, point.y));
        await browser.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
        await browser.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x + delta[0], y: y + delta[1], button: 'left', buttons: 1 });
        await browser.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x + delta[0], y: y + delta[1], button: 'left', buttons: 0, clickCount: 1 });
    }
    try {
        await operation('window.__corpus.begin()', 'mount');
        stage = 'file-input';
        const document = await browser.send('DOM.getDocument', { depth: 1 });
        const node = await browser.send('DOM.querySelector', { nodeId: document.root.nodeId, selector: '#corpus-file-input' });
        await browser.send('DOM.setFileInputFiles', { nodeId: node.nodeId, files: [path] });
        const openStarted = performance.now(); await operation('window.__corpus.open()', 'open'); timings.openMs = performance.now() - openStarted;
        let observation = await snapshot(); displayed(observation, 0);
        const count = observation.state.seriesCount; if (count < 1 || count > 128) fail('invalid-source-series-count');
        checks.push('file-api-only-open', 'successful-first-frame-upload-draw-commit');
        for (let index = 0; index < count; index++) {
            if (index) await command('setSeries', index);
            observation = await snapshot(); displayed(observation, 0); stage = 'attributes'; const profile = await evaluate('window.__corpus.profile()');
            if (profile.attributesShown < 1) fail('parsed-attributes-unavailable');
            const frames = observation.state.frameCount; if (frames < 1 || frames > 10000 || totalFrames + frames > 10000) fail('source-frame-count-outside-bounds');
            const entry = { index, profile, frameCount: frames, visitedFrames: 0, displayCommits: 0, backend: observation.render.backend,
                uploadChecksums: [], displayChecksum: null, checksumRepresentation: observation.render.checksumRepresentation, checks: [] };
            series.push(entry); const frameStarted = performance.now();
            const selectedFrames = allFrames ? Array.from({ length: frames }, (_, frame) => frame) : [...new Set([0, Math.floor((frames - 1) / 2), frames - 1])];
            for (const frame of selectedFrames) {
                const priorFrame = await snapshot(); await command('setFrame', frame); observation = await snapshot(); displayed(observation, frame);
                if (observation.commits <= priorFrame.commits) fail('frame-request-without-new-commit');
                if (observation.render.draws <= priorFrame.render.draws) fail('frame-request-without-new-main-canvas-draw');
                entry.visitedFrames++; entry.displayCommits++; totalFrames++; inspectResources(observation);
                if (entry.uploadChecksums.length < 8) entry.uploadChecksums.push(observation.render.uploadChecksum);
                entry.displayChecksum = observation.render.displayChecksum;
            }
            entry.timings = { frameSweepMs: performance.now() - frameStarted }; entry.checks.push(allFrames ? 'all-logical-frames-committed' : 'first-middle-last-logical-frames-committed');
            await command('setFrame', 0); await command('setTool', 'probe'); const point = await evaluate('window.__corpus.points()');
            await browser.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y, button: 'none', buttons: 0 });
            stage = 'probe'; if (!await poll('window.__corpus.probeVisible()', 'probe')) fail('original-probe-unavailable'); entry.checks.push('actual-pointer-probe');
            await drag('pan', [20, 10]); observation = await snapshot(); if (observation.state.transform.panX === 0 && observation.state.transform.panY === 0) fail('pan-did-not-change-transform');
            await command('reset'); await drag('zoom', [0, -24]); observation = await snapshot(); if (observation.state.transform.zoom <= 1) fail('zoom-did-not-change-transform');
            stage = 'rotate'; const rotation = await evaluate('window.__corpus.rotate()'); if (rotation !== 90) fail('rotate-did-not-change-transform');
            await command('reset'); observation = await snapshot(); if (observation.state.transform.zoom !== 1 || observation.state.transform.panX !== 0 || observation.state.transform.panY !== 0 || observation.state.transform.rotation !== 0) fail('reset-did-not-restore-transform');
            displayed(observation, 0); entry.checks.push('real-pointer-pan-zoom', 'rotate-reset');
            await operation('window.__corpus.roi()', 'roi'); const roi = await evaluate('window.__corpus.roiResult()');
            if (!roi.invariant || roi.colorScalarDeclined === false) fail('roi-source-value-invariance-failed');
            entry.checks.push(profile.photometric === 'RGB' || profile.photometric === 'PALETTE COLOR' ? 'color-roi-declines-scalar-statistics' : 'grayscale-roi-invariant-under-window'); entry.roi = roi;
            stage = 'image-notices'; const ui = await evaluate('window.__corpus.ui()');
            if (ui.color && (!ui.windowDisabled || !ui.invertDisabled)) fail('color-controls-profile-mismatch');
            if (!ui.noInlineNotice || !ui.viewportUnchanged) fail('compact-notice-disrupted-image-layout');
            if (ui.warningCount > 0 && (ui.noticeButtonDisabled || !ui.noticeOpened || !ui.noticeClosed || !ui.noticeReopened || !ui.noticeMessagesRetained || !ui.noticeAcknowledged)) fail('image-notice-unavailable-or-not-retained');
            if (ui.warningCount === 0 && !ui.noticeButtonDisabled) fail('clean-image-notice-button-not-disabled');
            entry.checks.push('profile-appropriate-controls', 'attributes-and-compact-image-notices');
            for (const category of ['geometry', 'encoding', 'timing']) {
                if (ui[category + 'WarningCount'] > 0) {
                    if (!ui[category + 'NoticeVisible']) fail(category + '-warning-not-visible-in-notice-popover');
                    entry.checks.push(category + '-warning-retained-and-reopenable-without-image-resize');
                }
            }
            if (frames >= 2) {
                await command('setFrame', 0); const cineBefore = (await snapshot()).commits; stage = 'cine'; await evaluate('window.__corpus.startCine();true');
                await poll(`window.__corpus.snapshot().commits>${cineBefore + 1}`, 'cine-frame-commit'); await command('pause'); await poll('!window.__corpus.snapshot().state.busy', 'cine-pause');
                const paused = await snapshot(); if (paused.state.playing) fail('cine-did-not-pause'); await delay(160);
                const stable = await snapshot(); if (stable.commits !== paused.commits || stable.state.playing) fail('cine-committed-after-pause'); displayed(stable, stable.state.frameIndex);
                entry.checks.push('cine-real-frame-commit-and-stable-pause');
            }
        }
        if (browser.errors.length > beforeExceptions || browser.consoleErrors.length > beforeConsole) fail('browser-exception-or-console-error');
        result = { status: 'passed', stage: 'complete', reason: null, checks, profile: series[0]?.profile || null, series,
            allFramesRequested: allFrames, visitedFrames: totalFrames, timings, resources: { peak } };
    } catch (error) {
        if (!result) result = { status: 'failed', stage, reason: error.corpusReason || 'browser-driver-failure', reasonCode: error.corpusReason || 'browser-driver-failure',
            checks, profile: series[0]?.profile || null, series, allFramesRequested: allFrames, visitedFrames: totalFrames, timings, resources: { peak } };
    } finally {
        result = { checks, profile: series[0]?.profile || null, series, allFramesRequested: allFrames, visitedFrames: totalFrames, timings, resources: { peak }, ...result };
        const cleanupFailed = reason => {
            result.cleanupFailure = { stage: 'cleanup', reason, originalFailure: result.status === 'passed' ? null :
                { status: result.status, stage: result.stage, reason: result.reason, reasonCode: result.reasonCode || null } };
            if (result.status === 'passed') Object.assign(result, { status: 'failed', stage: 'cleanup', reason, previousStatus: 'passed' });
            else { result.previousStatus = result.status; result.status = 'failed'; }
        };
        try {
            const cleanupToken = await evaluate('window.__corpus.dispose()');
            for (let index = 0; index < 250; index++) { const op = (await snapshot()).operation; if (op?.token === cleanupToken && op.done) break; await delay(40); }
            const final = await snapshot(); cleanup = final.resources;
            const bytes = ['encodedBytes', 'encodedCacheBytes', 'decodedCacheBytes', 'thumbnailBytes', 'overlayBytes', 'overlayRenderBytes', 'specialtyBytes', 'reconstructionVolumeBytes', 'reconstructionDerivedBytes'];
            const clear = final.operation?.token === cleanupToken && final.operation.done && final.operation.ok && cleanup?.disposed && !cleanup.cleanupPending && cleanup.workerCount === 0 && final.workerCounts.active === 0 && cleanup.seriesCount === 0 && cleanup.viewportCount === 0 && bytes.every(key => cleanup[key] === 0) && !final.state.image;
            result.workerCounts = final.workerCounts;
            if (!clear) cleanupFailed('owned-resources-not-cleared-after-disposal');
        } catch { cleanupFailed('cleanup-driver-failure'); }
    }
    result.resources = { ...(result.resources || { peak }), afterDisposal: cleanup || null };
    result.timings = { ...(result.timings || timings), totalMs: performance.now() - started };
    result.framesChecked = totalFrames;
    if (result.status === 'passed') result.frameCount = series.reduce((sum, stack) => sum + stack.frameCount, 0);
    const origin = await evaluate('location.origin'), requests = browser.requests.slice(beforeRequests);
    result.network = { requests: requests.length, uploads: requests.filter(request => !['GET', 'HEAD', 'OPTIONS'].includes(request.method)).length,
        externalRequests: requests.filter(request => new URL(request.url).origin !== origin).length };
    if (result.network.uploads || result.network.externalRequests) Object.assign(result, { status: 'failed', stage: 'network', reason: 'unexpected-upload-or-external-request' });
    result.scope = 'Local browser loading, actual renderer submissions, all requested logical frames and interaction/resource consistency; no independent clinical pixel-accuracy oracle.';
    return result;
}
