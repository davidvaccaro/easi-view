import { writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createDicomFixture } from '../src/data/synthetic.js';
import { createCompressedDicom } from '../test/compressed-fixtures.js';
import { createEnhancedDicom, expectedGroups, pixels, presentationFixtures, createVariableCineDicom } from '../test/enhanced-fixtures.js';

/** Generate only synthetic data on the host; the isolated browser needs no encoder dependency. */
export async function browserEngineFixtures() {
    const cases = [], add = (name, bytes, options) => cases.push({ name, encoded: Buffer.from(bytes).toString('base64'),
        sha256: createHash('sha256').update(bytes).digest('hex'), ...options });
    const quad = (rows, columns, values) => Array.from({ length: rows * columns }, (_, index) =>
        values[(Math.floor(index / columns) >= rows / 2 ? 2 : 0) + (index % columns >= columns / 2 ? 1 : 0)]).flat();
    const nativeFrames = Array.from({ length: 20 }, (_, frame) => quad(16, 16, [frame, 100 + frame, 1000 + frame, 4095 - frame]));
    const nativeBytes = createDicomFixture({ rows: 16, columns: 16, frames: nativeFrames.length, bitsStored: 12,
        values: nativeFrames.flat(), sopUid: '2.25.970.1', seriesUid: '2.25.970',
        sopClass: '1.2.840.10008.5.1.4.1.1.7.3', modality: 'OT', frameTime: 40,
        window: { center: 2048, width: 4096 }, extraAttributes: { '00200052': ['UI', '2.25.971'] } });
    add('native-16', nativeBytes, { rows: 16, columns: 16, frameCount: 20, samplesPerPixel: 1,
        expectedSamples: nativeFrames, window: { center: 2048, width: 4096 }, pixelSpacing: [0.75, 0.75], tolerance: 0 });
    const compressed = [
        ['rle-signed', { codec: 'rle', bitsAllocated: 16, bitsStored: 12, signed: true }, f => [-2048 + f, -1 - f, f, 2047 - f], 0],
        ['rle-rgb', { codec: 'rle', samplesPerPixel: 3, planarConfiguration: 1, bot: false }, f => [[255 - f, 0, 0], [0, 255 - f, 0], [0, 0, 255 - f], [17 + f, 31, 129]], 0],
        ['jpeg-gray', { codec: 'jpeg', rows: 16, columns: 16, bot: false, fragmentsPerFrame: 3 }, f => [16 + f, 80 + f, 128 + f, 240 - f], 1],
        ['jpeg-rgb', { codec: 'jpeg', rows: 16, columns: 16, samplesPerPixel: 3, fragmentsPerFrame: 3 }, f => [[255 - f, 0, 0], [0, 255 - f, 0], [0, 0, 255 - f], [17 + f, 31, 129]], 3],
        ['jpeg-lossless', { codec: 'jpeg-lossless', bitsAllocated: 16, signed: true, fragmentsPerFrame: 2 }, f => [-32768 + f, -1 - f, f, 32767 - f], 0],
        ['jpeg-lossless-p2', { codec: 'jpeg-lossless', transferSyntax: '1.2.840.10008.1.2.4.57', bitsAllocated: 16, fragmentsPerFrame: 2, encoderOptions: { predictor: 2 } }, f => [f, 255 + f, 32768 + f, 65535 - f], 0],
        ['jpeg-ls', { codec: 'jpeg-ls', bitsAllocated: 16, bitsStored: 12, fragmentsPerFrame: 2, bot: false }, f => [f, 255 + f, 1024 + f, 4095 - f], 0],
        ['jpeg-ls-near', { codec: 'jpeg-ls-near', rows: 16, columns: 16, bitsAllocated: 8, fragmentsPerFrame: 2, encoderOptions: { allowedLossyError: 2 } }, f => [16 + f, 80 + f, 128 + f, 240 - f], 2],
        ['jpeg2000', { codec: 'jpeg2000', bitsAllocated: 16, signed: true, fragmentsPerFrame: 2 }, f => [-32768 + f, -1 - f, f, 32767 - f], 0],
        ['jpeg2000-lossy', { codec: 'jpeg2000-lossy', rows: 16, columns: 16, bitsAllocated: 8, fragmentsPerFrame: 2, encoderOptions: { rate: 1 } }, f => [16 + f, 80 + f, 128 + f, 240 - f], 3],
        ['jpeg2000-rct', { codec: 'jpeg2000', samplesPerPixel: 3, photometric: 'YBR_RCT', extendedOffsets: true }, f => [[255 - f, 0, 0], [0, 255 - f, 0], [0, 0, 255 - f], [17 + f, 31, 129]], 0]
    ];
    for (const [name, options, values, tolerance] of compressed) {
        const rows = options.rows ?? 8, columns = options.columns ?? 8;
        const fixture = await createCompressedDicom({ ...options, rows, columns, frameTime: 40,
            frameSamples: Array.from({ length: 4 }, (_, frame) => quad(rows, columns, values(frame))),
            sopUid: `2.25.970.${cases.length + 1}` });
        const signed = options.signed ?? false, bitsStored = options.bitsStored ?? options.bitsAllocated ?? 8;
        add(name, fixture.bytes, { rows, columns, frameCount: 4, samplesPerPixel: fixture.metadata.samplesPerPixel,
            expectedSamples: fixture.expectedSamples, tolerance, transferSyntax: fixture.metadata.transferSyntax, pixelSpacing: [0.75, 0.75],
            window: { center: signed ? 0 : 2 ** (bitsStored - 1), width: 2 ** bitsStored } });
    }
    for (const [name, fixture] of Object.entries(presentationFixtures())) add(name, fixture.bytes, {
        rows: 2, columns: 2, frameCount: fixture.expectedSamples.length, samplesPerPixel: 1,
        expectedSamples: fixture.expectedSamples, expectedLevels: fixture.expectedLevels, expectedRgb: fixture.expectedRgb,
        pixelSpacing: [0.75, 0.75], tolerance: 0, presentation: true
    });
    add('enhanced', createEnhancedDicom(), { rows: 2, columns: 2, samplesPerPixel: 1, frameCount: 2, seriesCount: 4,
        expectedGroups, expectedSamples: pixels, pixelSpacing: [0.5, 0.75], tolerance: 0,
        window: { center: 0, width: 20000 }, enhanced: true });
    const timed = createVariableCineDicom();
    add('timed', timed.bytes, { rows: 2, columns: 2, frameCount: 4, samplesPerPixel: 1, window: { center: 128, width: 256 },
        expectedSamples: timed.expectedSamples, timingOffsetsMs: timed.acquisitionOffsetsMs, timingIntervalsMs: timed.nextIntervalsMs,
        pixelSpacing: [0.75, 0.75], tolerance: 0, timing: true });
    const attribute = (vr, ...Value) => ({ vr, Value });
    const archiveStudy = '2.25.980', archiveSeries = `${archiveStudy}.1`;
    const archiveInstances = Array.from({ length: 3 }, (_, index) => {
        const sopUid = `${archiveSeries}.${index + 1}`;
        const bytes = createDicomFixture({ rows: 16, columns: 16, frames: 1, bitsStored: 12, values: nativeFrames[index],
            sopUid, seriesUid: archiveSeries, sopClass: '1.2.840.10008.5.1.4.1.1.7.3', modality: 'OT', rescaleType: 'TEST',
            window: { center: 2048, width: 4096 }, position: [0, 0, index], instanceNumber: index + 1,
            extraAttributes: { '0020000D': ['UI', archiveStudy], '00200052': ['UI', '2.25.981'] } });
        return { sopUid, encoded: Buffer.from(bytes).toString('base64'), metadata: {
            '00080016': attribute('UI', '1.2.840.10008.5.1.4.1.1.7.3'), '00080018': attribute('UI', sopUid), '00080060': attribute('CS', 'OT'),
            '0020000D': attribute('UI', archiveStudy), '0020000E': attribute('UI', archiveSeries), '00200052': attribute('UI', '2.25.981'),
            '00200013': attribute('IS', index + 1), '00200032': attribute('DS', 0, 0, index), '00200037': attribute('DS', 1, 0, 0, 0, 1, 0),
            '00280002': attribute('US', 1), '00280004': attribute('CS', 'MONOCHROME2'), '00280008': attribute('IS', 1),
            '00280010': attribute('US', 16), '00280011': attribute('US', 16), '00280030': attribute('DS', 0.75, 0.75),
            '00280100': attribute('US', 16), '00280101': attribute('US', 12), '00280102': attribute('US', 11), '00280103': attribute('US', 0),
            '00281050': attribute('DS', 2048), '00281051': attribute('DS', 4096), '00281052': attribute('DS', 0), '00281053': attribute('DS', 1),
            '00281054': attribute('LO', 'TEST'), '00281056': attribute('CS', 'LINEAR'), '7FE00010': { vr: 'OW', BulkDataURI: 'https://synthetic.invalid/not-followed' }
        } };
    });
    return { schemaVersion: 1, scope: 'Generated synthetic fixtures only; discrete tests do not imply all real-world profiles are covered.', cases,
        archive: { studyUid: archiveStudy, seriesUid: archiveSeries, instances: archiveInstances } };
}
if (import.meta.url === `file://${process.argv[1]}`) {
    if (!process.argv[2]) throw new Error('Provide an output JSON path.');
    const data = await browserEngineFixtures();
    await writeFile(process.argv[2], JSON.stringify(data) + '\n');
    console.log(`Generated ${data.cases.length} synthetic browser-engine fixtures.`);
}
