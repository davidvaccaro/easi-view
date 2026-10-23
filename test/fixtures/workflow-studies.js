import { createDicomFixture } from '../../src/data/synthetic.js';

/** Invented public fixtures for ambiguous metadata selection. These do not
 * contain or derive pixel values, identifiers or dates from a local study. */
export function createWorkflowStudyFiles({ kind = 'ct-missing-agent', instancesPerSeries = 2 } = {}) {
    if (!['ct-missing-agent', 'mr-multiple-contrast'].includes(kind) || !Number.isSafeInteger(instancesPerSeries) || instancesPerSeries < 1 || instancesPerSeries > 150) {
        throw new TypeError('Choose a bounded synthetic workflow study.');
    }
    const mr = kind === 'mr-multiple-contrast', root = `2.25.2026102100.${mr ? 2 : 1}`;
    const series = mr ? [
        { number: 9, description: 'Axial pre acquisition', agent: '', derived: false },
        { number: 1001, description: 'Axial post phase one', agent: 'SYNTHETIC AGENT', derived: false },
        { number: 1002, description: 'Axial post phase two', agent: 'SYNTHETIC AGENT', derived: false },
        { number: 1003, description: 'Axial post phase three', agent: 'SYNTHETIC AGENT', derived: false },
        { number: 11001, description: 'Subtraction phase one', agent: 'SYNTHETIC AGENT', derived: true }
    ] : [
        { number: 312, description: '70 keV standard', agent: '', derived: false },
        { number: 313, description: '50 keV standard', agent: '', derived: false },
        { number: 316, description: 'Virtual unenhanced reconstruction', agent: '', derived: true },
        { number: 317, description: 'Blended standard', agent: '', derived: false }
    ];
    return series.flatMap(item => Array.from({ length: instancesPerSeries }, (_, index) => new File([
        createDicomFixture({ modality: mr ? 'MR' : 'CT', sopClass: mr ? '1.2.840.10008.5.1.4.1.1.4' : '1.2.840.10008.5.1.4.1.1.2',
            sopUid: `${root}.${item.number}.${index + 1}`, seriesUid: `${root}.${item.number}`, instanceNumber: index + 1,
            description: item.description, position: [0, 0, index * 2], values: [0, 100, 200, 300],
            extraAttributes: { '00080008': ['CS', [item.derived ? 'DERIVED' : 'ORIGINAL', 'PRIMARY', 'AXIAL']],
                '00080020': ['DA', '20260101'], '00081030': ['LO', mr ? 'Synthetic MR abdomen with contrast' : 'Synthetic CT chest with contrast'],
                '00100010': ['PN', 'SYNTHETIC^WORKFLOW'], '00100020': ['LO', `SYNTHETIC-${mr ? 'MR' : 'CT'}`],
                '00100021': ['LO', 'EASI SYNTHETIC WORKFLOW'], '00180010': item.agent ? ['LO', item.agent] : null,
                '00180015': ['CS', mr ? 'ABDOMEN' : 'CHEST'], '0020000D': ['UI', root], '00200011': ['IS', item.number],
                '00200052': ['UI', `${root}.99999`] } })
    ], `SYNTHETIC-${item.number}-${index + 1}`, { type: 'application/dicom' })));
}
