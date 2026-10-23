import assert from 'node:assert/strict';
import EASI from '@xinonix/easi-js';
import { createDicomFixture } from '../src/data/synthetic.js';

const studyUid = '2.25.810', seriesUid = '2.25.810.1', sopUid = '2.25.810.1.1';
const sopClass = '1.2.840.10008.5.1.4.1.1.4.1';
const locations = [
    [2, 20, 2], [1, 10, 0], [1, 20, 2], [2, 10, 0],
    [1, 10, 2], [2, 20, 0], [2, 10, 2], [1, 20, 0]
];
const expectedGroups = [[5, 0], [1, 4], [7, 2], [3, 6]];
const pixels = locations.map((_, index) => [-2000 + index * 100, -1, 0, 2000 - index * 100]);
const seq = item => ['SQ', [item]];
function attributes() {
    return {
        '00080016': ['UI', sopClass], '00080018': ['UI', sopUid], '00080060': ['CS', 'MR'],
        '0020000D': ['UI', studyUid], '0020000E': ['UI', seriesUid], '00200052': ['UI', '2.25.811'],
        '00280002': ['US', 1], '00280004': ['CS', 'MONOCHROME2'], '00280008': ['IS', locations.length],
        '00280010': ['US', 2], '00280011': ['US', 2], '00280100': ['US', 16], '00280101': ['US', 12],
        '00280102': ['US', 11], '00280103': ['US', 1],
        '52009229': seq({ '00289110': seq({ '00280030': ['DS', [0.5, 0.75]] }),
            '00209116': seq({ '00200037': ['DS', [1, 0, 0, 0, 1, 0]] }) }),
        '52009230': ['SQ', locations.map(([time, echo, z], index) => ({
            '00209113': seq({ '00200032': ['DS', [0, 0, z]] }),
            '00189114': seq({ '00189082': ['FD', echo] }),
            '00289145': seq({ '00281053': ['DS', index + 1], '00281052': ['DS', -100 * (index + 1)], '00281054': ['LO', 'HU'] }),
            '00209111': seq({ '00209056': ['SH', 'A'], '00209057': ['UL', z / 2 + 1], '00209128': ['UL', time],
                '00209157': ['UL', [z / 2 + 1, time, echo / 10]] })
        }))],
        '00209221': seq({ '00209164': ['UI', '2.25.812'] }),
        '00209222': ['SQ', [['00209057', '00209111'], ['00209128', '00209111'], ['00189082', '00189114']]
            .map(([pointer, group]) => ({ '00209164': ['UI', '2.25.812'], '00209165': ['AT', pointer], '00209167': ['AT', group] }))]
    };
}

function join(parts) {
    const bytes = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
    let offset = 0;
    for (const part of parts) { bytes.set(part, offset); offset += part.length; }
    return bytes;
}

// Independent bounded binary SQ/AT/FD/UL writer for generated test metadata.
function items(values, littleEndian = true, implicit = false) {
    return join(values.map(value => {
        const parts = Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([id, [vr, content]]) => {
            let body;
            if (vr === 'SQ') body = items(content, littleEndian, implicit);
            else if (content instanceof Uint8Array) body = content;
            else if (['AT', 'US', 'SS', 'UL', 'FD'].includes(vr)) {
                const values = Array.isArray(content) ? content : [content], width = ['US', 'SS'].includes(vr) ? 2 : vr === 'FD' ? 8 : 4;
                body = new Uint8Array(values.length * width);
                const view = new DataView(body.buffer);
                for (let index = 0; index < values.length; index++) {
                    if (vr === 'AT') {
                        view.setUint16(index * 4, parseInt(values[index].slice(0, 4), 16), littleEndian);
                        view.setUint16(index * 4 + 2, parseInt(values[index].slice(4), 16), littleEndian);
                    } else view[{ FD: 'setFloat64', UL: 'setUint32', US: 'setUint16', SS: 'setInt16' }[vr]](index * width, values[index], littleEndian);
                }
            } else {
                body = new TextEncoder().encode(Array.isArray(content) ? content.join('\\') : String(content));
                if (body.length % 2) body = join([body, Uint8Array.of(vr === 'UI' ? 0 : 32)]);
            }
            const long = !implicit && ['SQ', 'OW', 'OB'].includes(vr), header = new Uint8Array(long ? 12 : 8), view = new DataView(header.buffer);
            view.setUint16(0, parseInt(id.slice(0, 4), 16), littleEndian); view.setUint16(2, parseInt(id.slice(4), 16), littleEndian);
            if (implicit) view.setUint32(4, body.length, littleEndian);
            else { header.set(new TextEncoder().encode(vr), 4); if (long) view.setUint32(8, body.length, littleEndian); else view.setUint16(6, body.length, littleEndian); }
            return join([header, body]);
        });
        const body = join(parts), header = new Uint8Array(8), view = new DataView(header.buffer);
        view.setUint16(0, 0xFFFE, littleEndian); view.setUint16(2, 0xE000, littleEndian); view.setUint32(4, body.length, littleEndian);
        return join([header, body]);
    }));
}

function binaryAttributes(object, transferSyntax = '1.2.840.10008.1.2.1') {
    const littleEndian = transferSyntax !== '1.2.840.10008.1.2.2';
    return Object.fromEntries(Object.entries(object).map(([id, tuple]) => {
        if (tuple?.[0] === 'SQ') return [id, ['SQ', items(tuple[1], littleEndian, transferSyntax === '1.2.840.10008.1.2')]];
        if (tuple && ['US', 'SS', 'UL'].includes(tuple[0]) && Array.isArray(tuple[1])) {
            const width = tuple[0] === 'UL' ? 4 : 2, bytes = new Uint8Array(tuple[1].length * width), view = new DataView(bytes.buffer);
            tuple[1].forEach((value, index) => view[{ US: 'setUint16', SS: 'setInt16', UL: 'setUint32' }[tuple[0]]](index * width, value, littleEndian));
            return [id, [tuple[0], bytes]];
        }
        return [id, tuple];
    }));
}

function native(object = attributes(), transferSyntax = '1.2.840.10008.1.2.1') {
    return createDicomFixture({ sopClass, sopUid, seriesUid, modality: 'MR', rows: 2, columns: 2,
        signed: true, bitsStored: 12, frames: locations.length, values: pixels.flat(), transferSyntax,
        extraAttributes: { '00181063': null, '00280009': null, ...binaryAttributes(object, transferSyntax) } });
}

function json(object) {
    return Object.fromEntries(Object.entries(object).filter(([, tuple]) => tuple != null).map(([id, [vr, value]]) =>
        [id, value instanceof Uint8Array ? { vr, InlineBinary: Buffer.from(value).toString('base64') } :
            { vr, Value: vr === 'SQ' ? value.map(json) : Array.isArray(value) ? value : [value] }]));
}

async function archive({ object = attributes(), bytes = native(object), retrieve } = {}) {
    const result = await EASI.pipelineBuilder().fromByteStream().ofDicomMetadata().toInstances().build()
        .process({ source: new TextEncoder().encode(JSON.stringify([json(object)])) });
    const calls = [];
    return { calls, async getSeriesMetadata() { return result.toArray(); },
        async retrieveInstance(study, series, uid, { signal }) {
            assert.equal(study, studyUid); assert.equal(series, seriesUid); assert.equal(uid, sopUid);
            calls.push(uid);
            if (retrieve) return retrieve(signal);
            return new Response(bytes, { headers: { 'content-type': 'application/dicom' } });
        } };
}

function file(bytes) { return new File([bytes], 'generated-enhanced-mr.dcm', { type: 'application/dicom' }); }
function expectedRange(index) { return { min: pixels[index][0] * (index + 1) - 100 * (index + 1), max: pixels[index][3] * (index + 1) - 100 * (index + 1) }; }

function words(values) {
    const bytes = new Uint8Array(values.length * 2), view = new DataView(bytes.buffer);
    values.forEach((value, index) => view.setUint16(index * 2, value, true));
    return bytes;
}

/** Independent scalar/palette reference rasters for CPU and bundled GPU checks. */
export function presentationFixtures() {
    const result = {};
    const lutItem = (signed, firstMapped, values, bits, unit) => ({
        '00283002': [signed ? 'SS' : 'US', [values.length, firstMapped, bits]], '00283006': ['OW', words(values)],
        ...(unit ? { '00283004': ['LO', unit] } : {})
    });
    for (const kind of ['modalityLut', 'voiLut', 'combinedLut', 'sigmoid', 'palette', 'palette16']) {
        const palette = kind.startsWith('palette');
        const expectedSamples = palette ? [[-1, 0, 1, 2], [2000, 1, 0, -2000]] :
            [kind === 'sigmoid' ? [-100, 0, 100, 200] : [-2, -1, 0, 2]];
        const uid = `2.25.820.${Object.keys(result).length + 1}.1`;
        const object = {
            '00080016': ['UI', '1.2.840.10008.5.1.4.1.1.7'], '00080018': ['UI', uid], '00080060': ['CS', 'OT'],
            '0020000D': ['UI', '2.25.820'], '0020000E': ['UI', '2.25.820.1'], '00200013': ['IS', 1],
            '00200032': ['DS', [0, 0, 0]], '00200037': ['DS', [1, 0, 0, 0, 1, 0]], '00280030': ['DS', [0.75, 0.75]],
            '00280002': ['US', 1], '00280004': ['CS', palette ? 'PALETTE COLOR' : 'MONOCHROME2'],
            '00280008': ['IS', expectedSamples.length], '00280010': ['US', 2], '00280011': ['US', 2],
            '00280100': ['US', 16], '00280101': ['US', 16], '00280102': ['US', 15], '00280103': ['US', 1],
            '00281052': null, '00281053': null, '00281054': null, '00281056': null,
            ...(palette ? { '00181063': ['DS', 50] } : {})
        };
        let expectedLevels, expectedRgb;
        if (kind === 'modalityLut' || kind === 'combinedLut') {
            object['00283000'] = seq(lutItem(true, -2, kind === 'modalityLut' ? [0, 100, 200, 400] : [0, 1, 2, 3], 16, 'HU'));
        }
        if (kind === 'voiLut' || kind === 'combinedLut') {
            object['00283010'] = seq(lutItem(kind === 'voiLut', kind === 'voiLut' ? -2 : 0, [0, 64, 128, 255], 8));
            expectedLevels = [[0, 64 / 255, 128 / 255, 1]];
        } else if (kind === 'modalityLut') expectedLevels = [[0, 0.25, 0.5, 1]];
        if (kind === 'sigmoid') {
            object['00281050'] = ['DS', 0]; object['00281051'] = ['DS', 100]; object['00281056'] = ['CS', 'SIGMOID'];
            expectedLevels = [[1 / (1 + Math.exp(4)), 0.5, 1 / (1 + Math.exp(-4)), 1 / (1 + Math.exp(-8))]];
        }
        if (palette) {
            const bits = kind === 'palette16' ? 16 : 8, maximum = 2 ** bits - 1;
            for (const id of ['00281101', '00281102', '00281103']) object[id] = ['SS', [4, -1, bits]];
            object['00281201'] = ['OW', words([0, maximum, 0, 0])];
            object['00281202'] = ['OW', words([0, 0, maximum, 0])];
            object['00281203'] = ['OW', words([0, 0, 0, maximum])];
            expectedRgb = [[0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255], [0, 0, 255, 0, 255, 0, 255, 0, 0, 0, 0, 0]];
        }
        const bytes = createDicomFixture({ rows: 2, columns: 2, frames: expectedSamples.length, signed: true,
            sopClass: object['00080016'][1], sopUid: uid, seriesUid: '2.25.820.1', modality: 'OT',
            values: expectedSamples.flat(), extraAttributes: binaryAttributes(object) });
        const metadata = json(object);
        metadata['7FE00010'] = { vr: 'OW', BulkDataURI: 'https://synthetic.invalid/not-requested' };
        result[kind] = { kind, bytes, metadata, expectedSamples, expectedLevels, expectedRgb, attributes: object };
    }
    return result;
}

export function createVariableCineDicom() {
    const deltas = [0, 33, 55, 12], expectedSamples = deltas.map((_, index) => [index * 10, index * 10 + 1, index * 10 + 2, index * 10 + 3]);
    const object = { '00080016': ['UI', '1.2.840.10008.5.1.4.1.1.3.1'], '00080018': ['UI', '2.25.830.1.1'],
        '00080060': ['CS', 'US'], '0020000D': ['UI', '2.25.830'], '0020000E': ['UI', '2.25.830.1'],
        '00280002': ['US', 1], '00280004': ['CS', 'MONOCHROME2'], '00280008': ['IS', 4],
        '00280009': ['AT', '00181065'], '00181063': null, '00181065': ['DS', deltas],
        '00280010': ['US', 2], '00280011': ['US', 2], '00280100': ['US', 16], '00280101': ['US', 16],
        '00280102': ['US', 15], '00280103': ['US', 0] };
    const bytes = createDicomFixture({ sopClass: object['00080016'][1], sopUid: '2.25.830.1.1', seriesUid: '2.25.830.1',
        modality: 'US', rows: 2, columns: 2, frames: 4, values: expectedSamples.flat(),
        extraAttributes: { ...object, '00280009': ['AT', Uint8Array.of(0x18, 0, 0x65, 0x10)] } });
    return { bytes, expectedSamples, acquisitionOffsetsMs: [0, 33, 88, 100], nextIntervalsMs: [33, 55, 12, null], metadata: json(object) };
}

export { studyUid, seriesUid, sopUid, sopClass, locations, expectedGroups, pixels, binaryAttributes, expectedRange,
    attributes as enhancedAttributes, native as createEnhancedDicom, json as dicomJson, archive as createEnhancedArchive, file as fixtureFile };

