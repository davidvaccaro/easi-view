import { createDicomFixture } from '../src/data/synthetic.js';

// A generated-only, independent Part 10 DICOMDIR writer. Offsets refer to the
// first byte of each Item tag measured from the beginning of the file, as on
// removable DICOM media. Expected image values never come from the reader.
const encoder = new TextEncoder();
export const MEDIA_DIRECTORY_SOP = '1.2.840.10008.1.3.10';
export const MEDIA_IMAGE_SOP = '1.2.840.10008.5.1.4.1.1.2';
export const MEDIA_TRANSFER_SYNTAX = '1.2.840.10008.1.2.1';
const root = '2.25.997';
const longVR = new Set(['OB', 'OW', 'SQ', 'UN', 'UT']);
const concat = parts => {
    const bytes = new Uint8Array(parts.reduce((sum, item) => sum + item.length, 0));
    let offset = 0;
    for (const part of parts) { bytes.set(part, offset); offset += part.length; }
    return bytes;
};
const number = (value, size) => {
    const bytes = new Uint8Array(size), view = new DataView(bytes.buffer);
    if (size === 2) view.setUint16(0, value, true); else view.setUint32(0, value, true);
    return bytes;
};
function element(tag, vr, value) {
    let data = value instanceof Uint8Array ? value
        : vr === 'UL' ? number(value, 4) : vr === 'US' ? number(value, 2)
            : encoder.encode(Array.isArray(value) ? value.join('\\') : String(value));
    if (data.length % 2) data = concat([data, new Uint8Array([vr === 'UI' ? 0 : 32])]);
    const header = new Uint8Array(longVR.has(vr) ? 12 : 8), view = new DataView(header.buffer);
    view.setUint16(0, parseInt(tag.slice(0, 4), 16), true);
    view.setUint16(2, parseInt(tag.slice(4), 16), true);
    header.set(encoder.encode(vr), 4);
    if (longVR.has(vr)) view.setUint32(8, data.length, true); else view.setUint16(6, data.length, true);
    return concat([header, data]);
}
const item = (bytes, undefinedLength = false) => concat([
    new Uint8Array([254, 255, 0, 224]), number(undefinedLength ? 0xffffffff : bytes.length, 4), bytes,
    ...(undefinedLength ? [new Uint8Array([254, 255, 13, 224, 0, 0, 0, 0])] : [])
]);
const sequence = (tag, bytes, undefinedLength = false) => {
    const encoded = element(tag, 'SQ', bytes);
    if (!undefinedLength) return encoded;
    new DataView(encoded.buffer).setUint32(8, 0xffffffff, true);
    return concat([encoded, new Uint8Array([254, 255, 221, 224, 0, 0, 0, 0])]);
};

/** Records are trees: {type, children, fileId, ...metadata}. */
export function createDicomdirFixture(records, options = {}) {
    const entries = [];
    const flatten = siblings => {
        for (let index = 0; index < siblings.length; index++) {
            const record = siblings[index];
            entries.push({ record, sibling: siblings[index + 1] ?? null });
            flatten(record.children ?? []);
        }
    };
    flatten(records);
    const preamble = new Uint8Array(132); preamble.set(encoder.encode('DICM'), 128);
    const meta = concat([
        element('00020001', 'OB', new Uint8Array([0, 1])),
        element('00020002', 'UI', MEDIA_DIRECTORY_SOP),
        element('00020003', 'UI', `${root}.0.1`),
        element('00020010', 'UI', MEDIA_TRANSFER_SYNTAX),
        element('00020012', 'UI', `${root}.0`)
    ]);
    const prefix = concat([preamble, element('00020000', 'UL', meta.length), meta,
        element('00041130', 'CS', 'EASIMEDIA'),
        element('00041200', 'UL', 0), element('00041202', 'UL', 0),
        element('00041212', 'US', 0)]);
    const offsets = new Map();
    const encodeRecord = (record, sibling, index) => {
        const fields = [
            element('00041400', 'UL', options.links?.[index]?.next ?? offsets.get(sibling) ?? 0),
            element('00041410', 'US', record.active === false ? 0 : 65535),
            element('00041420', 'UL', options.links?.[index]?.child ?? offsets.get(record.children?.[0]) ?? 0),
            element('00041430', 'CS', record.type)
        ];
        const attributes = {
            ...(record.fileId != null ? { '00041500': ['CS', record.fileId],
                '00041510': ['UI', record.sopClassUid ?? MEDIA_IMAGE_SOP],
                '00041511': ['UI', record.sopUid ?? `${root}.1.1.1`],
                '00041512': ['UI', record.transferSyntaxUid ?? MEDIA_TRANSFER_SYNTAX] } : {}),
            ...(record.patientName != null ? { '00100010': ['PN', record.patientName] } : {}),
            ...(record.patientId != null ? { '00100020': ['LO', record.patientId] } : {}),
            ...(record.studyDate != null ? { '00080020': ['DA', record.studyDate] } : {}),
            ...(record.studyTime != null ? { '00080030': ['TM', record.studyTime] } : {}),
            ...(record.studyDescription != null ? { '00081030': ['LO', record.studyDescription] } : {}),
            ...(record.studyUid != null ? { '0020000D': ['UI', record.studyUid] } : {}),
            ...(record.seriesUid != null ? { '0020000E': ['UI', record.seriesUid] } : {}),
            ...(record.modality != null ? { '00080060': ['CS', record.modality] } : {}),
            ...(record.seriesNumber != null ? { '00200011': ['IS', record.seriesNumber] } : {}),
            ...(record.instanceNumber != null ? { '00200013': ['IS', record.instanceNumber] } : {}),
            ...(record.attributes ?? {})
        };
        for (const [tag, [vr, value]] of Object.entries(attributes).sort(([a], [b]) => a.localeCompare(b))) fields.push(element(tag, vr, value));
        if (record.iconSequence || options.iconSequence) fields.push(sequence('00880200', item(concat([
            element('00280002', 'US', 1), element('00280004', 'CS', 'MONOCHROME2'),
            element('00280010', 'US', 1), element('00280011', 'US', 1),
            element('00280100', 'US', 8), element('00280101', 'US', 8),
            element('00280102', 'US', 7), element('00280103', 'US', 0),
            element('7FE00010', 'OB', new Uint8Array([7, 0]))
        ]), options.undefinedLengthItems), options.undefinedLengthSequence));
        return item(concat(fields), options.undefinedLengthItems);
    };
    let offset = prefix.length + 12;
    entries.forEach(({ record, sibling }, index) => { offsets.set(record, offset); offset += encodeRecord(record, sibling, index).length; });
    // Prefix length does not change when fixed-width UL offsets are filled in.
    const firstRoot = options.firstRootOffset ?? offsets.get(records[0]) ?? 0;
    const lastRoot = options.lastRootOffset ?? offsets.get(options.lastRootRecord ?? records.at(-1)) ?? 0;
    const filledPrefix = concat([preamble, element('00020000', 'UL', meta.length), meta,
        element('00041130', 'CS', 'EASIMEDIA'),
        element('00041200', 'UL', firstRoot), element('00041202', 'UL', lastRoot),
        element('00041212', 'US', 0)]);
    return concat([filledPrefix, sequence('00041220', concat(entries.map(({ record, sibling }, index) => encodeRecord(record, sibling, index))), options.undefinedLengthSequence)]);
}

const definitions = [
    { key: 'current-a', study: 1, series: 1, instance: 1, base: 100, date: '20261016', description: 'Media follow-up', seriesDescription: 'Media axial lung', fileId: ['IMAGES', 'CT01', 'IM000001'] },
    { key: 'current-b', study: 1, series: 1, instance: 2, base: 110, date: '20261016', description: 'Media follow-up', seriesDescription: 'Media axial lung', fileId: ['IMAGES', 'CT01', 'IM000002'] },
    { key: 'current-soft', study: 1, series: 2, instance: 1, base: 200, date: '20261016', description: 'Media follow-up', seriesDescription: 'Media soft tissue', fileId: ['IMAGES', 'CT02', 'IM000001'] },
    { key: 'prior', study: 2, series: 1, instance: 1, base: 300, date: '20260901', description: 'Media baseline', seriesDescription: 'Media prior axial', fileId: ['IMAGES', 'PRIOR', 'IM000001'] },
    { key: 'other-patient', patient: 'BETA', study: 3, series: 1, instance: 1, base: 400, date: '20261015', description: 'Media second patient', seriesDescription: 'Media other axial', fileId: ['IMAGES', 'PAT02', 'IM000001'] },
    { key: 'later', study: 4, series: 1, instance: 1, base: 500, date: '20261116', description: 'Media later examination', seriesDescription: 'Media later axial', fileId: ['IMAGES', 'LATER', 'IM000001'] },
    { key: 'decoy', study: 99, series: 1, instance: 1, base: 900, date: '20261201', description: 'Unreferenced decoy', seriesDescription: 'Do not import this image', fileId: ['UNLISTED', 'IM000001'] }
];

/** A complete generated disc, including a nonreferenced valid image and sidecar. */
export function createDicomdirMedia(options = {}) {
    const selected = options.later ? ['later'] : ['current-a', 'current-b', 'current-soft', 'prior', ...(options.multiPatient ? ['other-patient'] : [])];
    const folder = options.folder ?? 'SYNTHETIC_DISC';
    const images = [...selected, 'decoy'].map(key => {
        const definition = definitions.find(item => item.key === key), { study, series, instance, base } = definition;
        const values = [base, base + 10, base + 20, base + 30], patient = definition.patient ?? 'ALPHA';
        const studyUid = `${root}.${study}`, seriesUid = `${studyUid}.${series}`, sopUid = `${seriesUid}.${instance}`;
        const relative = definition.fileId.join('/');
        const path = `${folder}/${options.caseVariant ? relative.toLowerCase() : relative}`;
        return { ...definition, patient, name: path.split('/').at(-1), path, values, studyUid, seriesUid, sopUid,
            bytes: createDicomFixture({ rows: 2, columns: 2, values, sopUid, seriesUid, description: definition.seriesDescription,
                modality: 'CT', instanceNumber: instance, position: [0, 0, instance - 1], pixelSpacing: [1, 1],
                window: { center: 512, width: 1024 }, extraAttributes: {
                    '00080020': ['DA', definition.date], '00080030': ['TM', '110000'],
                    '00081030': ['LO', definition.description], '00100010': ['PN', `SYNTHETIC^${patient}`],
                    '00100020': ['LO', `MEDIA_${patient}`], '00100021': ['LO', 'SYNTHETIC_MEDIA_ISSUER'],
                    '00100030': ['DA', patient === 'BETA' ? '19800102' : '19700101'],
                    '0020000D': ['UI', studyUid], '00200011': ['IS', series], '00200052': ['UI', `${root}.${study}.99`]
                } }) };
    });
    const referenced = images.filter(image => image.key !== 'decoy');
    const patients = [...new Set(referenced.map(image => image.patient))].map(patient => ({
        type: 'PATIENT', patientName: `SYNTHETIC^${patient}`, patientId: `MEDIA_${patient}`,
        children: [...new Set(referenced.filter(image => image.patient === patient).map(image => image.study))].map(study => {
            const studyImages = referenced.filter(image => image.patient === patient && image.study === study), first = studyImages[0];
            return { type: 'STUDY', studyUid: first.studyUid, studyDate: first.date, studyTime: '110000', studyDescription: first.description,
                children: [...new Set(studyImages.map(image => image.series))].map(series => {
                    const seriesImages = studyImages.filter(image => image.series === series);
                    return { type: 'SERIES', seriesUid: seriesImages[0].seriesUid, modality: 'CT', seriesNumber: series,
                        children: seriesImages.map(image => ({ type: 'IMAGE', fileId: image.fileId,
                            sopUid: options.uidMismatch && image.key === 'current-b' ? `${root}.999.1` : image.sopUid,
                            instanceNumber: image.instance })) };
                }) };
        })
    }));
    if (options.unsafeReference) patients[0].children[0].children[0].children[0].fileId = ['..', 'PRIVATE'];
    const lastImage = patients.at(-1)?.children.at(-1)?.children.at(-1)?.children.at(-1);
    const directoryBytes = createDicomdirFixture(patients, {
        ...(options.malformed ? { firstRootOffset: 1 } : {}),
        ...(options.lastRootOffset != null ? { lastRootOffset: options.lastRootOffset } : {}),
        ...(options.lastRootRecord === 'last-image' ? { lastRootRecord: lastImage } : {})
    });
    const directory = { key: 'directory', name: options.caseVariant ? 'dicomdir' : 'DICOMDIR', path: `${folder}/${options.caseVariant ? 'dicomdir' : 'DICOMDIR'}`, bytes: directoryBytes };
    const files = [directory, ...images.filter(image => !(options.missingReference && image.key === 'current-b')),
        { key: 'sidecar', name: 'README.TXT', path: `${folder}/README.TXT`, bytes: encoder.encode('Generated synthetic media; no original imaging data.') }];
    return { files, images, directory, records: patients, expected: {
        patients: options.multiPatient ? 2 : 1, studies: options.later ? 1 : options.multiPatient ? 3 : 2,
        series: options.later ? 1 : options.multiPatient ? 4 : 3,
        references: selected.length, available: selected.length - (options.missingReference ? 1 : 0),
        missing: options.missingReference ? 1 : 0, currentStudyUid: `${root}.${options.later ? 4 : 1}`,
        priorStudyUid: `${root}.2`, currentSeriesUid: `${root}.1.1`, softSeriesUid: `${root}.1.2`
    } };
}

export function mediaFixtureFiles(media) {
    return media.files.map(fixture => {
        const file = new File([fixture.bytes], fixture.name);
        Object.defineProperty(file, 'webkitRelativePath', { value: fixture.path });
        return file;
    });
}
