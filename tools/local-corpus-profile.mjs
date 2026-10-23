import { stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import EASI, { Tag } from '@xinonix/easi-js';
import { LOCAL_SOURCE_LIMIT_BYTES } from './local-corpus.mjs';

const modalities = new Set(['CT', 'MR', 'CR', 'DX', 'US', 'XA', 'RF', 'PT', 'NM', 'OT', 'SC', 'SR', 'KO', 'SEG', 'RTDOSE', 'RTPLAN', 'RTSTRUCT', 'MG', 'DS', 'DR', 'SM']);
const photometrics = new Set(['MONOCHROME1', 'MONOCHROME2', 'RGB', 'PALETTE COLOR', 'YBR_FULL', 'YBR_FULL_422', 'YBR_PARTIAL_422', 'YBR_PARTIAL_420', 'YBR_RCT', 'YBR_ICT']);
const raw = (set, id) => set?.value(Tag.find(id)) ?? null;
const scalar = value => Array.isArray(value) ? value.length === 1 ? value[0] : null : value;
function number(set, id) {
    const value = scalar(raw(set, id));
    if (value == null || value === '') return null;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}
function knownText(set, id, allowed) {
    const value = scalar(raw(set, id));
    return typeof value === 'string' && allowed.has(value.trim()) ? value.trim() : null;
}
function classUid(set, id) {
    const value = scalar(raw(set, id));
    return typeof value === 'string' && /^[0-9.]{1,64}$/.test(value.trim()) ? value.trim() : null;
}

/** Read a transient EASI model; return only allowlisted technical fields. */
export async function inspectCorpusFile(path, { timeoutMs = 120000 } = {}) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 600000) throw new RangeError('Use a bounded corpus parse timeout.');
    const file = await stat(path);
    if (!file.isFile() || file.size > LOCAL_SOURCE_LIMIT_BYTES) {
        return { passed: false, reason: 'The input exceeds the supported source size or is not a regular file.', profile: null };
    }
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs);
    let stream, received = 0;
    try {
        stream = createReadStream(path, { highWaterMark: 64 * 1024, signal: controller.signal });
        const source = { size: file.size, type: 'application/dicom', stream: () => Readable.toWeb(stream).pipeThrough(new TransformStream({
            transform(chunk, target) {
                received += chunk.byteLength;
                if (received > file.size || received > LOCAL_SOURCE_LIMIT_BYTES) throw new Error('The source grew beyond its declared byte limit.');
                target.enqueue(chunk);
            }
        })) };
        const result = await EASI.pipelineBuilder().fromFileStream()
            .ofDicomData({ includePart10Header: true })
            .withBulkDataPolicy({ mode: 'auto', knownLengthThreshold: 64 * 1024, hardSafetyCap: 1024 * 1024 })
            .toInstances().build().process({ source });
        const instance = result.first(), set = instance?.dataSet;
        if (!set || result.count !== 1) return { passed: false, reason: 'Expected exactly one DICOM instance in this file.', profile: null };
        const hasPixelData = Boolean(set.find(Tag.find('7FE00010')));
        return { passed: true, instances: result.count, receivedBytes: received, profile: {
            sopClass: classUid(set, '00080016') ?? classUid(instance.metaSet, '00020002'), transferSyntax: classUid(instance.metaSet, '00020010'),
            modality: knownText(set, '00080060', modalities), hasPixelData,
            rows: number(set, '00280010'), columns: number(set, '00280011'),
            frameCount: number(set, '00280008') ?? (hasPixelData ? 1 : 0),
            samplesPerPixel: number(set, '00280002'), photometric: knownText(set, '00280004', photometrics),
            bitsAllocated: number(set, '00280100'), bitsStored: number(set, '00280101'), highBit: number(set, '00280102')
        } };
    } catch {
        return { passed: false, reason: controller.signal.aborted ? 'The EASI DICOM parse exceeded its timeout.' : 'The EASI DICOM pipeline could not parse the complete bounded file.', profile: null };
    } finally { clearTimeout(timer); stream?.destroy(); }
}
