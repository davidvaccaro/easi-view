import { one, rejectTags } from '../derived/common.js';
import { dataSet, text, scalar, numbers, values, integer, uid, fail, attribute, nativeSyntax, nativePixelBytes, unsignedPixelReader,
    boundedOutput, frozenArray, checkSignal, yieldTask, MAX_SPECIALTY_BYTES, MAX_SPECIALTY_FRAMES } from './common.js';

export const XA_SOP_CLASS = '1.2.840.10008.5.1.4.1.1.12.1';
const TOKEN = Symbol('owned-xa-subtraction');
const MAX_AVERAGE_FRAMES = 128;
const MAX_SUBTRACTION_WORK = 16 * 1024 * 1024;

/** Classic AVG_SUB only. Never changes the main viewer's native XA guard. */
export async function createXaSubtraction(instance, { signal, maxBytes = MAX_SPECIALTY_BYTES } = {}) {
    checkSignal(signal); integer(maxBytes, 1, MAX_SPECIALTY_BYTES);
    const set = dataSet(instance);
    if (text(set, '00080016') !== XA_SOP_CLASS) fail('classic XA SOP Class is required');
    const rows = integer(scalar(set, '00280010'), 1, 8192), columns = integer(scalar(set, '00280011'), 1, 8192);
    const frameCount = integer(scalar(set, '00280008'), 2, MAX_SPECIALTY_FRAMES), pixels = rows * columns;
    const bitsAllocated = scalar(set, '00280100'), bitsStored = scalar(set, '00280101');
    if (text(set, '00280004') !== 'MONOCHROME2' || scalar(set, '00280002') !== 1 || scalar(set, '00280103') !== 0 ||
        ![8, 16].includes(bitsAllocated) || ![8, 10, 12, 16].includes(bitsStored) || bitsStored > bitsAllocated || scalar(set, '00280102') !== bitsStored - 1) fail('unsigned scalar classic XA pixels are required');
    if ((scalar(set, '00281053', { required: false }) ?? 1) !== 1 || (scalar(set, '00281052', { required: false }) ?? 0) !== 0 ||
        values(set, '00281054', { required: false }).some(value => value !== 'US')) fail('subtraction requires identity modality rescale');
    const relationship = text(set, '00281040'), relationshipSign = scalar(set, '00281041', { required: false });
    if (!['LIN', 'DISP'].includes(relationship) || relationshipSign != null && ![-1, 1].includes(relationshipSign)) fail('only untransformed LIN or DISP intensity relationships are supported');
    rejectTags(set, ['00283000', '00289422', '00289443', '00409096', '52009229', '52009230', '00280120', '00280121', '7FE00008', '7FE00009']);
    const item = one(set, '00286100');
    if (text(item, '00286101') !== 'AVG_SUB') fail('one AVG_SUB mask operation is required');
    const shifts = numbers(item, '00286114', { required: false, maximum: 2 });
    if (shifts.length && (shifts.length !== 2 || shifts.some(value => value !== 0))) fail('only a zero mask sub-pixel shift is supported');
    if (attribute(item, '00286120')) fail('TID offsets are not supported by AVG_SUB');
    const maskFrames = numbers(item, '00286110', { maximum: MAX_AVERAGE_FRAMES }).map(number => integer(number, 1, frameCount) - 1);
    if (new Set(maskFrames).size !== maskFrames.length) fail('mask frame numbers must be unique');
    const contrastCount = integer(scalar(item, '00286112', { required: false }) ?? 1, 1, Math.min(frameCount, MAX_AVERAGE_FRAMES));
    const ranges = numbers(item, '00286102', { required: false, maximum: 128 });
    const lastStart = frameCount - contrastCount;
    const applicable = ranges.length ? ranges.map(number => integer(number, 1, frameCount) - 1) : [0, lastStart];
    if (applicable.length % 2 || applicable.some((value, index) => index % 2 === 0 && (value > applicable[index + 1] || applicable[index + 1] > lastStart || index > 0 && value <= applicable[index - 1]))) fail('applicable contrast ranges are invalid or overlap');
    const bytes = pixels * frameCount * 2 + pixels * 8;
    boundedOutput(pixels, 16, maxBytes);
    if (!Number.isSafeInteger(bytes) || bytes + pixels * 8 > maxBytes || pixels * (maskFrames.length + contrastCount) > MAX_SUBTRACTION_WORK) fail('subtraction working data exceeds its byte or work budget');
    const { littleEndian } = nativeSyntax(instance), raw = nativePixelBytes(set, pixels * frameCount * bitsAllocated / 8);
    const read = unsignedPixelReader(set, raw, bitsAllocated, littleEndian), stored = new Uint16Array(pixels * frameCount), mask = new Float64Array(pixels);
    const maximum = 2 ** bitsStored - 1;
    try {
        for (let start = 0; start < stored.length; start += 65536) {
            checkSignal(signal);
            for (let index = start; index < Math.min(stored.length, start + 65536); index++) stored[index] = read(index) & maximum;
            if (start + 65536 < stored.length) await yieldTask();
        }
        for (let start = 0; start < pixels; start += 65536) {
            checkSignal(signal);
            for (let pixel = start; pixel < Math.min(pixels, start + 65536); pixel++) {
                let sum = 0; for (const index of maskFrames) sum += stored[index * pixels + pixel];
                mask[pixel] = sum / maskFrames.length;
            }
            if (start + 65536 < pixels) await yieldTask();
        }
        checkSignal(signal);
        return new XaSubtraction(TOKEN, { rows, columns, frameCount, bitsStored, sopUid: uid(text(set, '00080018')), relationship,
            relationshipSign, maskFrameIndices: frozenArray(maskFrames), contrastFrameAveraging: contrastCount, applicableRanges: frozenArray(applicable), bytes, maxBytes }, stored, mask);
    } catch (error) { stored.fill(0); mask.fill(0); throw error; }
}

class XaSubtraction {
    #stored; #mask;
    constructor(token, metadata, stored, mask) { if (token !== TOKEN) fail('use createXaSubtraction'); this.metadata = Object.freeze(metadata); this.#stored = stored; this.#mask = mask; this.disposed = false; }
    get bytes() { return this.disposed ? 0 : this.metadata.bytes; }
    #active() { if (this.disposed) fail('subtraction source is disposed'); }
    storedFrame(frameIndex) {
        this.#active(); integer(frameIndex, 0, this.metadata.frameCount - 1);
        const count = this.metadata.rows * this.metadata.columns; return this.#stored.slice(frameIndex * count, (frameIndex + 1) * count);
    }
    async subtract(frameIndex, { signal } = {}) {
        this.#active(); checkSignal(signal); integer(frameIndex, 0, this.metadata.frameCount - 1);
        const m = this.metadata, ranges = m.applicableRanges;
        if (!ranges.some((start, index) => index % 2 === 0 && frameIndex >= start && frameIndex <= ranges[index + 1])) fail('frame is outside the applicable subtraction ranges');
        const pixels = m.rows * m.columns, values = new Float64Array(pixels);
        for (let start = 0; start < pixels; start += 65536) {
            this.#active(); checkSignal(signal);
            for (let pixel = start; pixel < Math.min(pixels, start + 65536); pixel++) {
                let contrast = 0; for (let index = 0; index < m.contrastFrameAveraging; index++) contrast += this.#stored[(frameIndex + index) * pixels + pixel];
                values[pixel] = contrast / m.contrastFrameAveraging - this.#mask[pixel];
            }
            if (start + 65536 < pixels) await yieldTask();
        }
        this.#active(); checkSignal(signal);
        return { profile: 'classic-xa-average-subtraction-v1', rows: m.rows, columns: m.columns, sourceSopUid: m.sopUid, originalFrameIndex: frameIndex,
            values, bytes: values.byteLength, unit: 'stored-intensity difference', relationship: m.relationship, relationshipSign: m.relationshipSign,
            operation: 'contrast-average-minus-mask-average', maskShift: [0, 0] };
    }
    dispose() { if (this.disposed) return; this.#stored = null; this.#mask = null; this.disposed = true; }
}
