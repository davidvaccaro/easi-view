import test from 'node:test';
import assert from 'node:assert/strict';
import { loadFiles } from '../src/data/sources.js';
import { createDicomFixture } from '../src/data/synthetic.js';
import { measureDistance } from '../src/render/DisplayMath.js';

function file(options = {}) {
    return new File([createDicomFixture(options)], 'synthetic-geometry.dcm', { type: 'application/dicom' });
}

async function withFrame(options, inspect) {
    const series = await loadFiles([file(options)]);
    try { await inspect(await series[0].getFrame(0)); }
    finally { series.forEach(stack => stack.dispose()); }
}

test('a CR image with a singleton IS pixel aspect ratio still displays its original samples', async () => {
    await withFrame({ sopClass: '1.2.840.10008.5.1.4.1.1.1', modality: 'CR', photometric: 'MONOCHROME1',
        bitsStored: 10, values: [0, 1, 511, 1023], extraAttributes: { '00280034': ['IS', '01'] } }, frame => {
        assert.deepEqual([...frame.samples], [0, 1, 511, 1023]);
        assert.equal(frame.photometric, 'MONOCHROME1');
        assert.equal(frame.pixelAspectRatio, null);
        assert.deepEqual(frame.pixelSpacing, [0.75, 0.75]);
        assert.deepEqual(frame.geometryWarnings, ['Ignored Pixel Aspect Ratio (0028, 0034): expected 2 positive integer values.']);
    });
});

test('a secondary-capture CT with three DS spacing values displays without invented calibration', async () => {
    await withFrame({ sopClass: '1.2.840.10008.5.1.4.1.1.7', modality: 'CT', bitsAllocated: 8, bitsStored: 8,
        values: [0, 1, 127, 255], extraAttributes: { '00280030': ['DS', '0.2\\0\\0.200000'] } }, frame => {
        assert.deepEqual([...frame.samples], [0, 1, 127, 255]);
        assert.equal(frame.pixelSpacing, null);
        assert.deepEqual(measureDistance([{ x: 0, y: 0 }, { x: 3, y: 4 }], frame.pixelSpacing),
            { value: 5, unit: 'px', calibrated: false });
        assert.deepEqual(frame.geometryWarnings, ['Ignored Pixel Spacing (0028, 0030): expected 2 positive finite values.']);
    });
});

const geometryTags = [['00280030', 'DS', 'pixelSpacing'], ['00280034', 'IS', 'pixelAspectRatio'],
    ['00200037', 'DS', 'orientation'], ['00200032', 'DS', 'position']];
for (const [label, makeValue] of [['absent', () => null], ['zero-length', vr => [vr, '']],
    ['padded empty', vr => [vr, '  ']], ['all blank components', vr => [vr, ' \\ \\ ']]]) {
    test(`${label} optional geometry stays unavailable`, async () => {
        const extraAttributes = Object.fromEntries(geometryTags.map(([tag, vr]) => [tag, makeValue(vr)]));
        await withFrame({ extraAttributes }, frame => {
            for (const [, , field] of geometryTags) assert.equal(frame[field], null);
            assert.deepEqual(frame.geometryWarnings, []);
            assert.deepEqual([...frame.samples], [0, 100, 200, 300]);
        });
    });
}

const malformed = [
    ['partial spacing', '00280030', 'DS', '0.75', 'pixelSpacing'],
    ['blank spacing component', '00280030', 'DS', '0.75\\ ', 'pixelSpacing'],
    ['zero spacing', '00280030', 'DS', '0\\1', 'pixelSpacing'],
    ['negative spacing', '00280030', 'DS', '-1\\1', 'pixelSpacing'],
    ['nonfinite spacing', '00280030', 'DS', 'NaN\\1', 'pixelSpacing'],
    ['hexadecimal spacing', '00280030', 'DS', '0x10\\1', 'pixelSpacing'],
    ['partial position', '00200032', 'DS', '0\\0', 'position'],
    ['blank position component', '00200032', 'DS', '0\\ \\0', 'position'],
    ['nonfinite position', '00200032', 'DS', '0\\Infinity\\0', 'position'],
    ['partial orientation', '00200037', 'DS', '1\\0\\0', 'orientation'],
    ['blank orientation component', '00200037', 'DS', '1\\0\\0\\ \\1\\0', 'orientation'],
    ['nonorthogonal orientation', '00200037', 'DS', '1\\0\\0\\1\\0\\0', 'orientation'],
    ['nonnormal orientation', '00200037', 'DS', '2\\0\\0\\0\\1\\0', 'orientation'],
    ['zero pixel aspect', '00280034', 'IS', '0\\1', 'pixelAspectRatio'],
    ['fractional pixel aspect', '00280034', 'IS', '1.5\\1', 'pixelAspectRatio'],
    ['blank pixel aspect component', '00280034', 'IS', '1\\ ', 'pixelAspectRatio']
];
for (const [label, tag, vr, encoded, field] of malformed) {
    test(`${label} is discarded with a technical warning`, async () => {
        await withFrame({ extraAttributes: { [tag]: [vr, encoded] } }, frame => {
            assert.equal(frame[field], null);
            assert.equal(frame.geometryWarnings.length, 1);
            assert.match(frame.geometryWarnings[0], /^Ignored [\w ()]+ \([0-9A-F]{4}, [0-9A-F]{4}\): expected [236] /);
            assert.ok(!frame.geometryWarnings[0].includes(encoded));
            assert.deepEqual([...frame.samples], [0, 100, 200, 300]);
        });
    });
}

test('valid scientific decimal geometry is preserved and remains calibrated', async () => {
    await withFrame({ extraAttributes: {
        '00280030': ['DS', '+7.5E-1\\.75'],
        '00200037': ['DS', '+1.0E+0\\0\\0\\0\\1.\\0'],
        '00200032': ['DS', '-2.5E1\\+0\\.5']
    } }, frame => {
        assert.deepEqual(frame.pixelSpacing, [0.75, 0.75]);
        assert.deepEqual(frame.orientation, [1, 0, 0, 0, 1, 0]);
        assert.deepEqual(frame.position, [-25, 0, 0.5]);
        assert.deepEqual(frame.geometryWarnings, []);
        assert.equal(measureDistance([{ x: 0, y: 0 }, { x: 3, y: 4 }], frame.pixelSpacing).value, 3.75);
    });
});

test('positive pixel aspect pairs remain a display ratio without millimeter calibration', async () => {
    await withFrame({ extraAttributes: { '00280030': null, '00280034': ['IS', '2\\1'] } }, frame => {
        assert.equal(frame.pixelSpacing, null);
        assert.deepEqual(frame.pixelAspectRatio, [2, 1]);
        assert.deepEqual(frame.geometryWarnings, []);
        assert.equal(measureDistance([{ x: 0, y: 0 }, { x: 3, y: 4 }], frame.pixelSpacing).unit, 'px');
    });
});

test('different display aspects split stacks while equivalent ratios share a stack', async () => {
    const extra = ratio => ({ '00280030': null, '00280034': ['IS', ratio] });
    const series = await loadFiles([
        file({ sopUid: '1.2.3.1', extraAttributes: extra('2\\1') }),
        file({ sopUid: '1.2.3.2', extraAttributes: extra('4\\2') }),
        file({ sopUid: '1.2.3.3', extraAttributes: extra('1\\2') })
    ]);
    try {
        assert.equal(series.length, 2);
        assert.equal(series[0].frames.length, 2);
        assert.equal(series[1].frames.length, 1);
    } finally { series.forEach(stack => stack.dispose()); }
});

test('partial patient positions use instance ordering separately from geometric stacks', async () => {
    const series = await loadFiles([
        file({ sopUid: '1.2.3.1', position: [0, 0, 20], instanceNumber: 1 }),
        file({ sopUid: '1.2.3.2', position: [0, 0, -10], instanceNumber: 99 }),
        file({ sopUid: '1.2.3.3', instanceNumber: 8, extraAttributes: { '00200032': ['DS', '0\\0'] } }),
        file({ sopUid: '1.2.3.4', instanceNumber: 2, extraAttributes: { '00200032': ['DS', '0\\ \\0'] } })
    ]);
    try {
        assert.equal(series.length, 2);
        assert.deepEqual(series[0].frames.map(frame => frame.instanceNumber), [99, 1]);
        assert.deepEqual(series[1].frames.map(frame => frame.instanceNumber), [2, 8]);
        assert.ok(series[1].frames.every(frame => frame.position === null && frame.geometryWarnings.length === 1));
    } finally { series.forEach(stack => stack.dispose()); }
});

for (const [tag, value] of [['00281053', '1\\ '], ['00281052', '0x10'], ['00280008', '1\\']]) {
    test(`invalid numeric components in ${tag} still reject the image`, async () => {
        await assert.rejects(loadFiles([file({ extraAttributes: { [tag]: ['DS', value] } })]), /numeric metadata/);
    });
}
