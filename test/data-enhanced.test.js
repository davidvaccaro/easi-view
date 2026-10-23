import test from 'node:test';
import assert from 'node:assert/strict';
import EASI from '@xinonix/easi-js';
import { createDicomFixture } from '../src/data/synthetic.js';
import { ENHANCED_SOP_CLASSES, resolveEnhancedFrames, partitionEnhancedFrames } from '../src/data/enhanced.js';
import { DicomWebClient } from '../src/data/DicomWebClient.js';

const ctClass = '1.2.840.10008.5.1.4.1.1.2.1';
const mrClass = '1.2.840.10008.5.1.4.1.1.4.1';
const common = { rows: 2, columns: 2, littleEndian: true, slope: 99, intercept: 999,
    pixelSpacing: [9, 9], orientation: [0, 0, 0, 0, 0, 0], position: [999, 999, 999], frameTime: 50 };
const dimensionUid = '2.25.800';
const sq = item => ['SQ', [item]];
const measures = { '00280030': ['DS', [0.5, 0.75]], '00180050': ['DS', 2], '00180088': ['DS', 2] };
const plane = { '00200037': ['DS', [1, 0, 0, 0, 1, 0]] };
const transform = { '00281053': ['DS', 2], '00281052': ['DS', -1024], '00281054': ['LO', 'HU'] };
const voi = { '00281050': ['DS', [40, 400]], '00281051': ['DS', [400, 2000]], '00281056': ['CS', 'LINEAR'] };

function concatenate(parts) {
    const bytes = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
    let offset = 0;
    for (const part of parts) { bytes.set(part, offset); offset += part.length; }
    return bytes;
}

// This independent recursive sequence writer is intentionally separate from
// the normalizer and from EASI's parser. All image pixels are generated.
function encodeElement(id, vr, value, { littleEndian = true, implicit = false } = {}) {
    let body;
    if (vr === 'SQ') body = encodeItems(value, { littleEndian, implicit });
    else if (['US', 'UL', 'FD', 'FL', 'AT'].includes(vr)) {
        const values = Array.isArray(value) ? value : [value];
        const width = { US: 2, UL: 4, FD: 8, FL: 4, AT: 4 }[vr];
        body = new Uint8Array(values.length * width);
        const view = new DataView(body.buffer);
        for (let index = 0; index < values.length; index++) {
            if (vr === 'AT') {
                view.setUint16(index * 4, parseInt(values[index].slice(0, 4), 16), littleEndian);
                view.setUint16(index * 4 + 2, parseInt(values[index].slice(4), 16), littleEndian);
            } else view[{ US: 'setUint16', UL: 'setUint32', FD: 'setFloat64', FL: 'setFloat32' }[vr]](index * width, values[index], littleEndian);
        }
    } else {
        body = new TextEncoder().encode(Array.isArray(value) ? value.join('\\') : String(value));
        if (body.length % 2) body = concatenate([body, Uint8Array.of(vr === 'UI' ? 0 : 32)]);
    }
    const long = !implicit && vr === 'SQ';
    const header = new Uint8Array(long ? 12 : 8);
    const view = new DataView(header.buffer);
    view.setUint16(0, parseInt(id.slice(0, 4), 16), littleEndian);
    view.setUint16(2, parseInt(id.slice(4), 16), littleEndian);
    if (implicit) view.setUint32(4, body.length, littleEndian);
    else {
        header.set(new TextEncoder().encode(vr), 4);
        if (long) view.setUint32(8, body.length, littleEndian);
        else view.setUint16(6, body.length, littleEndian);
    }
    return concatenate([header, body]);
}

function encodeItems(items, options = {}) {
    return concatenate(items.map(item => {
        const contents = concatenate(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))
            .map(([id, [vr, value]]) => encodeElement(id, vr, value, options)));
        const header = new Uint8Array(8);
        const view = new DataView(header.buffer);
        view.setUint16(0, 0xFFFE, options.littleEndian ?? true);
        view.setUint16(2, 0xE000, options.littleEndian ?? true);
        view.setUint32(4, contents.length, options.littleEndian ?? true);
        return concatenate([header, contents]);
    }));
}

function definitions(items) {
    return items.map(([pointer, group]) => ({ '00209164': ['UI', dimensionUid], '00209165': ['AT', pointer],
        ...(group ? { '00209167': ['AT', group] } : {}) }));
}

function fixture({ sopClass = ctClass, positions = [4, 0, 2], shared = {
    '00289110': sq(measures), '00209116': sq(plane), '00289145': sq(transform), '00289132': sq(voi)
}, perFrame, dimensionDefinitions = [['00209056', '00209111'], ['00209057', '00209111']], extra = {} } = {}) {
    const frames = perFrame ?? positions.map((z, index) => ({
        '00209113': sq({ '00200032': ['DS', [10, 20, z]] }),
        '00209111': sq({ '00209056': ['SH', 'A'], '00209057': ['UL', index + 1],
            ...(dimensionDefinitions.length ? { '00209157': ['UL', [1, index + 1]] } : {}) })
    }));
    return { '00080016': ['UI', sopClass], '00280008': ['IS', frames.length], '00200052': ['UI', '2.25.801'],
        '52009229': ['SQ', [shared]], '52009230': ['SQ', frames],
        ...(dimensionDefinitions.length ? { '00209221': ['SQ', [{ '00209164': ['UI', dimensionUid] }]],
            '00209222': ['SQ', definitions(dimensionDefinitions)] } : {}), ...extra };
}

function jsonAttributes(object) {
    return Object.fromEntries(Object.entries(object).filter(([, tuple]) => tuple !== null).map(([id, [vr, value]]) => [id,
        { vr, Value: vr === 'SQ' ? value.map(jsonAttributes) : Array.isArray(value) ? value : [value] }]));
}

async function parse(object, { format = 'binary', transferSyntax = '1.2.840.10008.1.2.1' } = {}) {
    if (format === 'json') {
        const input = jsonAttributes(object), previousFetch = globalThis.fetch;
        input['0020000D'] = { vr: 'UI', Value: ['2.25.804'] };
        input['0020000E'] = { vr: 'UI', Value: ['2.25.804.1'] };
        input['00080018'] = { vr: 'UI', Value: ['2.25.804.1.1'] };
        globalThis.fetch = async () => new Response(JSON.stringify([input]),
            { headers: { 'content-type': 'application/dicom+json' } });
        try {
            const client = new DicomWebClient({ baseUrl: 'https://synthetic.invalid/dicom-web' });
            return (await client.getSeriesMetadata('2.25.804', '2.25.804.1'))[0];
        } finally { globalThis.fetch = previousFetch; }
    }
    const littleEndian = transferSyntax !== '1.2.840.10008.1.2.2';
    const implicit = transferSyntax === '1.2.840.10008.1.2';
    const extraAttributes = Object.fromEntries(Object.entries(object).map(([id, tuple]) => [id,
        tuple?.[0] === 'SQ' ? ['SQ', encodeItems(tuple[1], { littleEndian, implicit })] : tuple]));
    const count = Number(object['00280008'][1]);
    const bytes = createDicomFixture({ sopClass: object['00080016'][1], modality: 'CT', transferSyntax,
        frames: count, rows: 2, columns: 2, values: Array.from({ length: count * 4 }, (_, index) => index),
        extraAttributes: { '00181063': null, '00280009': null, ...extraAttributes } });
    return (await EASI.pipelineBuilder().fromByteStream().ofDicomData().toInstances().build().process({ source: bytes })).first();
}

for (const transferSyntax of ['1.2.840.10008.1.2', '1.2.840.10008.1.2.1', '1.2.840.10008.1.2.2']) {
    test(`published EASI native SQ resolves per-frame geometry, binary AT/UL and shared transforms (${transferSyntax})`, async () => {
        const frames = resolveEnhancedFrames(await parse(fixture(), { transferSyntax }), { ...common, littleEndian: transferSyntax !== '1.2.840.10008.1.2.2' });
        assert.deepEqual(frames.map(frame => frame.frameIndex), [0, 1, 2]);
        assert.deepEqual(frames.map(frame => frame.overrides.position), [[10, 20, 4], [10, 20, 0], [10, 20, 2]]);
        assert.deepEqual(frames[0].overrides.pixelSpacing, [0.5, 0.75]);
        assert.deepEqual(frames[0].overrides.orientation, [1, 0, 0, 0, 1, 0]);
        assert.equal(frames[0].overrides.slope, 2); assert.equal(frames[0].overrides.intercept, -1024);
        assert.equal(frames[0].overrides.unit, 'HU');
        assert.equal(frames[0].overrides.frameTime, null);
        assert.deepEqual(frames[0].overrides.windowAlternatives, [{ center: 40, width: 400 }, { center: 400, width: 2000 }]);
        assert.deepEqual(frames[2].dimensions.dimensionIndexValues, [1, 3]);
        assert.equal(frames[2].dimensions.indices[1].indexPointer, '00209057');
        assert.equal(frames[2].dimensions.indices[1].spatial, true);
        const groups = partitionEnhancedFrames(frames);
        assert.equal(groups.length, 1);
        assert.equal(groups[0].spatialEligible, true);
        assert.deepEqual(groups[0].frames.map(frame => frame.frameIndex), [1, 2, 0]);
        assert.deepEqual(frames.map(frame => frame.frameIndex), [0, 1, 2]);
    });
}

test('published EASI DICOM JSON metadata produces the same normalized frames as native data', async () => {
    const object = fixture();
    const native = resolveEnhancedFrames(await parse(object), common);
    const metadata = resolveEnhancedFrames(await parse(object, { format: 'json' }), common);
    assert.deepEqual(metadata, native);
});

for (const sopClass of ENHANCED_SOP_CLASSES) {
    test(`enhanced and legacy-converted CT/MR profile accepts ${sopClass}`, async () => {
        assert.equal(resolveEnhancedFrames(await parse(fixture({ sopClass })), common).length, 3);
    });
}

test('temporal and echo partitions are resolved before spatial sorting and retain encoded frame indices', async () => {
    const perFrame = [
        { temporal: 2, echo: 20, z: 2 }, { temporal: 1, echo: 10, z: 0 },
        { temporal: 1, echo: 20, z: 2 }, { temporal: 2, echo: 10, z: 0 },
        { temporal: 1, echo: 10, z: 2 }, { temporal: 2, echo: 20, z: 0 },
        { temporal: 2, echo: 10, z: 2 }, { temporal: 1, echo: 20, z: 0 }
    ].map(frame => ({
        '00209113': sq({ '00200032': ['DS', [0, 0, frame.z]] }),
        '00189114': sq({ '00189082': ['FD', frame.echo] }),
        '00209111': sq({ '00209056': ['SH', 'A'], '00209057': ['UL', frame.z / 2 + 1],
            '00209128': ['UL', frame.temporal], '00209157': ['UL', [frame.z / 2 + 1, frame.temporal, frame.echo / 10]] })
    }));
    const object = fixture({ sopClass: mrClass, perFrame,
        dimensionDefinitions: [['00209057', '00209111'], ['00209128', '00209111'], ['00189082', '00189114']] });
    for (const format of ['binary', 'json']) {
        const groups = partitionEnhancedFrames(resolveEnhancedFrames(await parse(object, { format }), common));
        assert.equal(groups.length, 4);
        assert.deepEqual(groups.map(group => group.frames.map(frame => frame.frameIndex)), [[5, 0], [1, 4], [7, 2], [3, 6]]);
        for (const group of groups) {
            assert.equal(group.spatialEligible, true);
            assert.equal(new Set(group.frames.map(frame => frame.dimensions.temporalPositionIndex)).size, 1);
            assert.equal(new Set(group.frames.map(frame => frame.dimensions.effectiveEchoTime)).size, 1);
        }
    }
});

test('unknown nonspatial dimensions are partitioned conservatively and never promoted to spatial volumes', async () => {
    const perFrame = [1, 2, 1, 2].map((ordinal, index) => ({
        '00209113': sq({ '00200032': ['DS', [0, 0, index < 2 ? 0 : 2]] }),
        '00209111': sq({ '00209157': ['UL', [ordinal]] })
    }));
    const frames = resolveEnhancedFrames(await parse(fixture({ perFrame,
        dimensionDefinitions: [['00189073', '00189112']] })), common);
    const groups = partitionEnhancedFrames(frames);
    assert.equal(groups.length, 2);
    assert.deepEqual(groups.map(group => group.frames.map(frame => frame.frameIndex)), [[0, 2], [1, 3]]);
    assert.ok(groups.every(group => group.spatialEligible === false));
    assert.ok(frames.every(frame => frame.dimensions.indices[0].known === false));
});

test('missing optional geometry remains null and never inherits top-level or extrapolated positions', async () => {
    const frames = resolveEnhancedFrames(await parse(fixture({ shared: {}, dimensionDefinitions: [], perFrame: [{}, {}] })), common);
    assert.ok(frames.every(frame => frame.overrides.position === null && frame.overrides.orientation === null && frame.overrides.pixelSpacing === null));
    assert.equal(frames[0].overrides.slope, 1); assert.equal(frames[0].overrides.intercept, 0);
    assert.equal(frames[0].overrides.window, null);
    assert.equal(partitionEnhancedFrames(frames)[0].spatialEligible, false);
});

test('omitted per-frame sequence is accepted for entirely shared macros without inventing per-frame geometry', async () => {
    const object = fixture({ positions: [0, 1], dimensionDefinitions: [], extra: { '52009230': null } });
    const frames = resolveEnhancedFrames(await parse(object), common);
    assert.equal(frames.length, 2);
    assert.equal(frames[1].overrides.position, null);
    assert.deepEqual(frames[1].overrides.orientation, [1, 0, 0, 0, 1, 0]);
});

test('per-frame transforms remain frame-specific and acquisition duration is not a cine interval', async () => {
    const shared = { '00289110': sq(measures), '00209116': sq(plane) };
    const perFrame = [0, 1].map(index => ({
        '00289145': sq({ '00281053': ['DS', index + 1], '00281052': ['DS', -index * 100], '00281054': ['LO', index ? 'HU' : 'US'] }),
        '00289132': sq({ '00281050': ['DS', index * 10], '00281051': ['DS', 0.5], '00281056': ['CS', 'LINEAR_EXACT'] }),
        '00209111': sq({ '00189220': ['FD', 999], '00209156': ['US', index + 1] })
    }));
    const frames = resolveEnhancedFrames(await parse(fixture({ shared, perFrame, dimensionDefinitions: [] })), common);
    assert.deepEqual(frames.map(frame => [frame.overrides.slope, frame.overrides.intercept, frame.overrides.unit]), [[1, 0, ''], [2, -100, 'HU']]);
    assert.ok(frames.every(frame => frame.overrides.frameTime === null));
    assert.ok(frames.every(frame => frame.dimensions.frameAcquisitionDuration === 999));
    assert.equal(frames[1].overrides.window.width, 0.5);
});

test('concatenation keeps logical ordinal separate from local encoded frameIndex', async () => {
    const object = fixture({ extra: { '00209161': ['UI', '2.25.803'], '00209228': ['UL', 100] } });
    const frames = resolveEnhancedFrames(await parse(object), common);
    assert.deepEqual(frames.map(frame => frame.frameIndex), [0, 1, 2]);
    assert.deepEqual(frames.map(frame => frame.dimensions.logicalFrameIndex), [100, 101, 102]);
});

test('frame acquisition timestamps and temporal offsets are retained separately from cine timing', async () => {
    const perFrame = [0, 100].map((offset, index) => ({
        '00209310': sq({ '0020930D': ['FD', offset] }),
        '00209111': sq({ '00189151': ['DT', `2026101410100${index}.123456-0400`],
            '00189074': ['DT', `2026101410090${index}-0400`], '00189220': ['FD', 250] })
    }));
    const object = fixture({ perFrame, dimensionDefinitions: [], extra: { '00181063': ['DS', 33] } });
    const native = resolveEnhancedFrames(await parse(object), common);
    const metadata = resolveEnhancedFrames(await parse(object, { format: 'json' }), common);
    assert.deepEqual(metadata, native);
    assert.deepEqual(native.map(frame => frame.dimensions.temporalPositionTimeOffset), [0, 100]);
    assert.equal(native[0].dimensions.frameReferenceDateTime, '20261014101000.123456-0400');
    assert.equal(native[1].dimensions.frameAcquisitionDateTime, '20261014100901-0400');
    assert.ok(native.every(frame => frame.overrides.frameTime === 33));
    assert.equal(partitionEnhancedFrames(native).length, 2);
});

test('empty optional numeric geometry carries no position or orientation, including DICOM JSON null values', async () => {
    const object = fixture({ shared: { '00289110': sq({ '00280030': ['DS', ['', '']] }),
        '00209116': sq({ '00200037': ['DS', ['', '', '', '', '', '']] }) }, dimensionDefinitions: [],
    perFrame: [{ '00209113': sq({ '00200032': ['DS', ['', '', '']] }) }] });
    for (const format of ['binary', 'json']) {
        const frames = resolveEnhancedFrames(await parse(object, { format }), common);
        assert.equal(frames[0].overrides.pixelSpacing, null);
        assert.equal(frames[0].overrides.position, null);
        assert.equal(frames[0].overrides.orientation, null);
    }
    const empty = fixture({ shared: {}, dimensionDefinitions: [], perFrame: [{ '00209113': sq({ '00200032': ['DS', [null]] }) }] });
    assert.equal(resolveEnhancedFrames(await parse(empty, { format: 'json' }), common)[0].overrides.position, null);
});

test('same dimension ordinal must describe consistent nominal values across frames', async () => {
    const object = fixture();
    object['52009230'][1][1]['00209111'][1][0]['00209056'][1] = 'B';
    const instance = await parse(object);
    assert.throws(() => resolveEnhancedFrames(instance, common), /inconsistent/);
});

test('duplicate attributes within a functional group are not silently resolved by EASI first-match lookup', async () => {
    const instance = await parse(fixture());
    const shared = instance.dataSet.attributes.find(attr => attr.tag.ID === '52009229').items[0];
    shared.attributes.push(shared.attributes[0]);
    assert.throws(() => resolveEnhancedFrames(instance, common), /functional-group/);
});

test('a nonsequence attribute in a functional-group container fails rather than being ignored', async () => {
    const instance = await parse(fixture({ shared: { '00280030': ['DS', [1, 1]] }, dimensionDefinitions: [] }));
    assert.throws(() => resolveEnhancedFrames(instance, common), /functional-group/);
});

for (const format of ['binary', 'json']) {
    test(`item-scoped private creator LO declarations preserve enhanced frames and source attributes (${format})`, async () => {
        const expected = resolveEnhancedFrames(await parse(fixture(), { format }), common);
        const object = fixture();
        object['52009229'][1][0]['20050010'] = ['LO', 'SYNTHETIC_PRIVATE_GROUP'];
        object['52009229'][1][0]['20051010'] = sq({ '20050010': ['LO', 'SYNTHETIC_NESTED_GROUP'],
            '20051001': ['DS', 17] });
        for (const frame of object['52009230'][1]) {
            frame['20050010'] = ['LO', 'SYNTHETIC_PRIVATE_GROUP'];
            frame['20051011'] = sq({ '20050010': ['LO', 'SYNTHETIC_NESTED_GROUP'], '20051001': ['DS', 23] });
        }
        const instance = await parse(object, { format });
        const containers = instance.dataSet.attributes.filter(attr => ['52009229', '52009230'].includes(attr.tag.ID))
            .flatMap(attr => attr.items);
        const originals = containers.map(item => [...item.attributes]);
        const frames = resolveEnhancedFrames(instance, common);
        assert.deepEqual(frames, expected, 'Private declarations and unknown macros do not substitute for standard geometry or dimensions.');
        containers.forEach((item, index) => {
            assert.deepEqual(item.attributes, originals[index], 'Normalization retains the original creator and private macro attributes.');
            assert.equal(item.attributes.find(attr => attr.tag.ID === '20050010').value, 'SYNTHETIC_PRIVATE_GROUP');
        });
        assert.equal(partitionEnhancedFrames(frames)[0].spatialEligible, true);
    });

    for (const [label, tag, vr, value] of [
        ['wrong VR', '20050010', 'CS', 'SYNTHETIC_CREATOR'],
        ['invalid VM', '20050010', 'LO', ['SYNTHETIC_ONE', 'SYNTHETIC_TWO']],
        ['empty identifier', '20050010', 'LO', ''],
        ['oversized identifier', '20050010', 'LO', 'A'.repeat(65)],
        ['even group', '20040010', 'LO', 'SYNTHETIC_CREATOR'],
        ['element outside creator range', '20050100', 'LO', 'SYNTHETIC_CREATOR'],
        ['reserved private group', '00010010', 'LO', 'SYNTHETIC_CREATOR']
    ]) {
        test(`enhanced private creator rejects ${label} in shared and per-frame items (${format})`, async () => {
            for (const scope of ['shared', 'frame']) {
                const object = fixture();
                const item = scope === 'shared' ? object['52009229'][1][0] : object['52009230'][1][0];
                item[tag] = [vr, value];
                const instance = await parse(object, { format });
                assert.throws(() => resolveEnhancedFrames(instance, common), /functional-group/);
            }
        });
    }

    test(`item-scoped declarations do not permit the same private macro in shared and per-frame groups (${format})`, async () => {
        const object = fixture();
        for (const item of [object['52009229'][1][0], object['52009230'][1][0]]) {
            item['20050010'] = ['LO', 'SYNTHETIC_PRIVATE_GROUP'];
            item['20051010'] = sq({ '20050010': ['LO', 'SYNTHETIC_NESTED_GROUP'], '20051001': ['DS', 17] });
        }
        const instance = await parse(object, { format });
        assert.throws(() => resolveEnhancedFrames(instance, common), /both shared/);
    });
}

test('multivalued legacy echo numbers are preserved without claiming spatial volume eligibility', async () => {
    const frames = resolveEnhancedFrames(await parse(fixture({ sopClass: '1.2.840.10008.5.1.4.1.1.4.4',
        extra: { '00180086': ['IS', [1, 2]] } })), common);
    assert.deepEqual(frames[0].dimensions.echoNumbers, [1, 2]);
    assert.equal(frames[0].dimensions.echoNumber, null);
    assert.equal(partitionEnhancedFrames(frames)[0].spatialEligible, false);
});

test('repeat patient positions and irregular spacing stay ineligible for a spatial volume', async () => {
    for (const positions of [[0, 0, 2], [0, 2, 5]]) {
        const groups = partitionEnhancedFrames(resolveEnhancedFrames(await parse(fixture({ positions })), common));
        assert.equal(groups.length, 1);
        assert.equal(groups[0].spatialEligible, false);
    }
});

test('missing frame of reference prevents volume eligibility without hiding a valid 2D plane', async () => {
    const frames = resolveEnhancedFrames(await parse(fixture({ extra: { '00200052': null } })), common);
    assert.deepEqual(frames[0].overrides.position, [10, 20, 4]);
    assert.equal(partitionEnhancedFrames(frames)[0].spatialEligible, false);
});

for (const [label, change, expression] of [
    ['per-frame count mismatch', object => object['00280008'][1]++, /count/],
    ['missing shared groups', object => object['52009229'] = null, /missing/],
    ['empty shared sequence', object => object['52009229'][1] = [], /functional-group/],
    ['multiple shared items', object => object['52009229'][1].push({}), /functional-group/],
    ['duplicated shared/per-frame macro', object => object['52009230'][1][0]['00209116'] = sq(plane), /both shared/],
    ['shared frame content', object => object['52009229'][1][0]['00209111'] = sq({}), /per-frame/],
    ['nonorthogonal orientation', object => object['52009229'][1][0]['00209116'][1][0]['00200037'][1] = [1, 0, 0, 1, 0, 0], /geometry/],
    ['bad position VM', object => object['52009230'][1][0]['00209113'][1][0]['00200032'][1] = [0, 0], /geometry/],
    ['zero spacing', object => object['52009229'][1][0]['00289110'][1][0]['00280030'][1] = [0, 1], /geometry/],
    ['zero rescale slope', object => object['52009229'][1][0]['00289145'][1][0]['00281053'][1] = 0, /slope/],
    ['missing rescale intercept', object => delete object['52009229'][1][0]['00289145'][1][0]['00281052'], /functional-group/],
    ['invalid window width', object => object['52009229'][1][0]['00289132'][1][0]['00281051'][1] = [0, 2000], /functional-group/],
    ['nested VOI LUT', object => object['52009229'][1][0]['00289132'][1][0]['00283010'] = sq({}), /presentation/],
    ['real-world value mapping', object => object['52009229'][1][0]['00409096'] = sq({}), /presentation/],
    ['dimension cardinality mismatch', object => object['52009230'][1][0]['00209111'][1][0]['00209157'][1] = [1], /dimension indices/],
    ['zero dimension ordinal', object => object['52009230'][1][0]['00209111'][1][0]['00209157'][1] = [1, 0], /dimension indices/],
    ['unknown organization UID', object => object['00209222'][1][0]['00209164'][1] = '2.25.999', /functional-group/],
    ['malformed frame of reference UID', object => object['00200052'][1] = 'not-a-spatial-uid', /identifier/],
    ['stack without in-stack ordinal', object => delete object['52009230'][1][0]['00209111'][1][0]['00209057'], /functional-group/],
    ['dimension pointer to dimension index values', object => object['00209222'][1][0]['00209165'][1] = '00209157', /functional-group/],
    ['unsupported image class', object => object['00080016'][1] = '1.2.840.10008.5.1.4.1.1.12.1.1', /outside/]
]) {
    test(`malformed enhanced metadata rejects explicitly: ${label}`, async () => {
        const object = structuredClone(fixture());
        change(object);
        const instance = await parse(object);
        assert.throws(() => resolveEnhancedFrames(instance, common), expression);
    });
}
