import {createDicomFixture} from '../../src/data/synthetic.js';

/** Invented workflow studies. Pixels, identifiers, timing and descriptions are
 * authored here and do not derive from local medical imaging. */
export function createAiSeriesStudyFiles({kind = 'ambiguous'} = {}) {
    if (!['ambiguous', 'unique', 'boundary'].includes(kind)) throw new TypeError('Choose a generated series-selection scenario.');
    const base = '2.25.2026102101';
    const studies = kind === 'boundary' ? [
        {id: 31, patient: 'ALPHA', date: '20260303', title: 'ACTIVE SCOUT ONLY', series: [{number: 1, title: 'AXIAL SCOUT', token: 'LOCALIZER', frames: 2}]},
        {id: 32, patient: 'ALPHA', date: '20260202', title: 'OTHER STUDY ELIGIBLE CT', series: [{number: 712, title: 'OTHER STUDY STANDARD AXIAL', frames: 3}]},
        {id: 33, patient: 'BETA', date: '20260303', title: 'OTHER PATIENT ELIGIBLE CT', series: [{number: 812, title: 'OTHER PATIENT STANDARD AXIAL', frames: 3}]}
    ] : [{id: kind === 'unique' ? 22 : 21, patient: 'ALPHA', date: '20260303', title: 'SYNTHETIC AXIAL CT SELECTION', series: [
        {number: 1, title: 'AXIAL SCOUT', token: 'LOCALIZER', frames: 2},
        {number: 312, title: '70 keV standard axial', frames: 3},
        ...(kind === 'ambiguous' ? [{number: 313, title: '50 keV standard axial', frames: 3}, {number: 317, title: 'Blended standard axial', frames: 3}] : []),
        {number: 316, title: 'VUE virtual unenhanced axial', imageType: ['ORIGINAL', 'SECONDARY', 'AXIAL', 'GSI', 'VUE'], frames: 3},
        {number: 318, title: 'MIP axial projection', imageType: ['DERIVED', 'SECONDARY', 'AXIAL', 'MIP'], frames: 3},
        {number: 319, title: 'Derived axial secondary image', derived: true, frames: 3},
        {number: 320, title: 'GSI material density axial map', imageType: ['ORIGINAL', 'SECONDARY', 'AXIAL', 'GSI', 'MD'], unit: 'MG/ML', frames: 3}
    ]}];
    return studies.flatMap(study => study.series.flatMap(series => Array.from({length: series.frames}, (_, index) => {
        const uid = `${base}.${study.id}.${series.number}`;
        return new File([createDicomFixture({modality: 'CT', seriesUid: uid, sopUid: `${uid}.${index + 1}`, rescaleType: series.unit ?? 'HU',
            description: series.title, instanceNumber: index + 1, position: [0, 0, index * 2],
            values: [0, 100, 200, 300], extraAttributes: {
                '00080008': ['CS', series.imageType ?? [series.derived ? 'DERIVED' : 'ORIGINAL', 'PRIMARY', series.token ?? 'AXIAL']],
                '00080020': ['DA', study.date], '00081030': ['LO', study.title],
                '00100010': ['PN', `SYNTHETIC^${study.patient}`], '00100020': ['LO', `SYNTHETIC-${study.patient}`],
                '00100021': ['LO', 'EASI GENERATED AI SERIES'], '00180015': ['CS', 'CHEST'],
                '00180050': ['DS', 2], '0020000D': ['UI', `${base}.${study.id}`],
                '00200011': ['IS', series.number], '00200052': ['UI', `${base}.${study.id}.99999`]
            }})], `GENERATED-${study.id}-${series.number}-${index + 1}`, {type: 'application/dicom'});
    })));
}
