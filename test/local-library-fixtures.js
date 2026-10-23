import { createDicomFixture } from '../src/data/synthetic.js';

// Generated Part 10 inputs only. Identifiers, names, dates and stored samples
// are declared independently so browser QA does not derive expectations from
// the catalog or image reader under test.
const root = '2.25.998';
const definitions = [
    { key: 'current-lung-1', patient: 'ALPHA', issuer: 'SYNTHETIC_HOSPITAL_A', study: 1, series: 1, instance: 1, date: '20261016', time: '110000', description: 'Chest follow-up', seriesDescription: 'Axial lung · 1 mm', base: 100, name: 'IM000001' },
    { key: 'current-lung-2', patient: 'ALPHA', issuer: 'SYNTHETIC_HOSPITAL_A', study: 1, series: 1, instance: 2, date: '20261016', time: '110000', description: 'Chest follow-up', seriesDescription: 'Axial lung · 1 mm', base: 110, name: 'IM000002.ima' },
    { key: 'current-soft', patient: 'ALPHA', issuer: 'SYNTHETIC_HOSPITAL_A', study: 1, series: 2, instance: 1, date: '20261016', time: '110000', description: 'Chest follow-up', seriesDescription: 'Axial soft tissue', base: 200, name: 'soft.bin' },
    { key: 'prior', patient: 'ALPHA', issuer: 'SYNTHETIC_HOSPITAL_A', study: 2, series: 1, instance: 1, date: '20260901', time: '090000', description: 'Chest baseline', seriesDescription: 'Axial lung · 1.25 mm', base: 300, name: 'prior.dcm' },
    { key: 'prior-soft', patient: 'ALPHA', issuer: 'SYNTHETIC_HOSPITAL_A', study: 2, series: 2, instance: 1, date: '20260901', time: '090000', description: 'Chest baseline', seriesDescription: 'Axial soft tissue prior', base: 350, name: 'prior-soft' },
    { key: 'same-day', patient: 'ALPHA', issuer: 'SYNTHETIC_HOSPITAL_A', study: 3, series: 1, instance: 1, date: '20261016', time: '140000', description: 'Chest same-day', seriesDescription: 'Axial lung later visit', base: 400, name: 'same-day' },
    { key: 'undated', patient: 'ALPHA', issuer: 'SYNTHETIC_HOSPITAL_A', study: 4, series: 1, instance: 1, date: '', time: '', description: 'Undated chest', seriesDescription: 'Axial lung undated', base: 500, name: 'undated.IMA' },
    { key: 'other-patient', patient: 'BETA', patientId: 'ALPHA', issuer: 'SYNTHETIC_HOSPITAL_B', study: 5, series: 1, instance: 1, date: '20261015', time: '120000', description: 'Different issuer same identifier', seriesDescription: 'Other patient chest', base: 600, name: 'other-patient' },
    { key: 'failed-image', patient: 'ALPHA', issuer: 'SYNTHETIC_HOSPITAL_A', study: 6, series: 1, instance: 1, date: '20261017', time: '120000', description: 'Metadata valid unsupported image', seriesDescription: 'Unsupported stored pixel profile', base: 700, name: 'unsupported.ima', unsupported: true },
    { key: 'untrusted-label', patient: 'ALPHA', issuer: 'SYNTHETIC_HOSPITAL_A', study: 7, series: 1, instance: 1, date: '20261018', time: '120000', description: 'SYNTHETIC <img src=x onerror="window.__catalogUnsafe=true">', seriesDescription: 'SYNTHETIC <svg onload="window.__catalogUnsafe=true">', base: 800, name: 'untrusted-label' },
    { key: 'future', patient: 'ALPHA', issuer: 'SYNTHETIC_HOSPITAL_A', study: 9, series: 1, instance: 1, date: '20261116', time: '120000', description: 'Later chest follow-up', seriesDescription: 'Axial lung future', base: 1000, name: 'future' },
    { key: 'no-identity', patient: '', issuer: '', study: 8, series: 1, instance: 1, date: '20261019', time: '120000', description: 'Unidentified synthetic examination', seriesDescription: 'Missing patient identity', base: 900, name: 'unidentified' }
];

export function createLocalLibraryFixtures() {
    return definitions.map(definition => {
        const { study, series, instance, base } = definition;
        const values = [base, base + 10, base + 20, base + 30];
        const studyUid = `${root}.${study}`, seriesUid = `${studyUid}.${series}`, sopUid = `${seriesUid}.${instance}`;
        const extraAttributes = {
            '00080020': ['DA', definition.date], '00080030': ['TM', definition.time],
            '00081030': ['LO', definition.description],
            '00080080': ['LO', definition.issuer || 'Synthetic institution'],
            '00100010': ['PN', definition.patient ? `SYNTHETIC^${definition.patient}` : ''],
            '00100020': ['LO', definition.patientId ?? definition.patient],
            '00100021': ['LO', definition.issuer],
            '00100030': ['DA', definition.patient === 'BETA' ? '19800102' : '19700101'],
            '0020000D': ['UI', studyUid], '00200011': ['IS', series],
            '00200052': ['UI', `${root}.${study}.99`],
            ...(definition.unsupported ? { '00280004': ['CS', 'SYNTHETIC_UNSUPPORTED'] } : {})
        };
        return {
            ...definition, studyUid, seriesUid, sopUid, values,
            bytes: createDicomFixture({ rows: 2, columns: 2, values, sopUid, seriesUid,
                modality: 'CT', description: definition.seriesDescription, instanceNumber: instance,
                position: [0, 0, instance - 1], pixelSpacing: [1, 1],
                window: { center: 512, width: 1024 }, extraAttributes })
        };
    });
}

export function fixtureFile(fixture) { return new File([fixture.bytes], fixture.name); }
