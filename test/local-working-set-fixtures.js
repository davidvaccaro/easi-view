import { createDicomFixture } from '../src/data/synthetic.js';

// Tiny generated pixels exercise a real 10,000-frame working-set boundary without
// allocating a large corpus or introducing test-only viewer configuration.
const root = '2.25.996';
export const WORKING_SET_FRAMES = 3000;
export const WORKING_SET_OVERSIZE_FRAMES = 3 * 4096;

export function workingSetSamples(key, frameIndex = 0) {
    const base = key === 'oversize' ? 900 : 100 + ('ABCDE'.indexOf(key) * 100);
    const offset = (frameIndex % 17) * 5;
    return [base + offset, base + offset + 10, base + offset + 20, base + offset + 30];
}

function image(key, study, frames, instance = 1) {
    const studyUid = `${root}.${study}`, seriesUid = `${studyUid}.1`, sopUid = `${seriesUid}.${instance}`;
    const pixels = new Uint8Array(frames * 8), view = new DataView(pixels.buffer);
    for (let frame = 0; frame < frames; frame++) {
        const values = workingSetSamples(key, frame);
        values.forEach((value, index) => view.setUint16(frame * 8 + index * 2, value, true));
    }
    return { key: key === 'oversize' ? `oversize-${instance}` : key, studyKey: key,
        name: `SYNTHETIC_${key}_${instance}`, studyUid, seriesUid, sopUid, frames,
        bytes: createDicomFixture({ rows: 2, columns: 2, frames, rawPixelBytes: pixels,
            sopUid, seriesUid, instanceNumber: instance, modality: 'CT',
            description: `Synthetic working set ${key}`, pixelSpacing: [1, 1],
            window: { center: 512, width: 1024 },
            extraAttributes: {
                '00080020': ['DA', `202610${String(17 - study).padStart(2, '0')}`],
                '00080030': ['TM', '120000'],
                '00081030': ['LO', `Synthetic examination ${key}`],
                '00100010': ['PN', 'SYNTHETIC^WORKING_SET'],
                '00100020': ['LO', 'SYNTHETIC_WORKING_SET'],
                '00100021': ['LO', 'SYNTHETIC_ISSUER'],
                '00100030': ['DA', '19700101'],
                '0020000D': ['UI', studyUid],
                '00200011': ['IS', 1],
                '00200052': ['UI', `${studyUid}.99`]
            } }) };
}

export function createLocalWorkingSetFixtures() {
    return {
        studies: [...'ABCDE'].map((key, index) => image(key, index + 1, WORKING_SET_FRAMES)),
        oversized: [1, 2, 3].map(instance => image('oversize', 6, 4096, instance))
    };
}
