import test from 'node:test';
import assert from 'node:assert/strict';
import EASI from '@xinonix/easi-js';
import { workflowFromMetadata, normalizeWorkflow, aggregateWorkflow, workflowTechnicalMetadata } from '../src/catalog/workflow.js';
import { indexLocalFile } from '../src/catalog/metadata.js';
import LocalCatalog from '../src/catalog/LocalCatalog.js';
import { SessionCatalog } from '../src/catalog/SessionCatalog.js';
import { loadFiles, normalizeInstance } from '../src/data/sources.js';
import { createDicomFixture } from '../src/data/synthetic.js';

const fd = (value, littleEndian = true) => {
    const bytes = new Uint8Array(8); new DataView(bytes.buffer).setFloat64(0, value, littleEndian); return bytes;
};
const base = { modality: 'CT', imageType: ['ORIGINAL', 'PRIMARY', 'AXIAL'], imageOrientation: [1, 0, 0, 0, 1, 0] };
const semantics = value => Object.fromEntries(['ctFamily', 'energyKeV', 'energyEvidence', 'familyEvidence', 'sliceThicknessMm', 'kernel', 'kernelEvidence'].map(field => [field, value[field]]));
let next = 1;
function file({ syntax = '1.2.840.10008.1.2.1', energy = 70, description = 'Synthetic 70 keV STANDARD', extra = {} } = {}) {
    return new File([createDicomFixture({ transferSyntax: syntax, description, sopUid: '2.25.20261022.' + next++,
        extraAttributes: { '00080008': ['CS', base.imageType], '00100021': ['LO', 'SYNTHETIC'], '00180050': ['DS', '1.25'],
            '00181210': ['SH', 'STANDARD'], '0018937C': ['FD', fd(energy, syntax !== '1.2.840.10008.1.2.2')], ...extra } })], 'SYNTHETIC-CT');
}

test('bounded CT description hints identify energy and blended labels without retaining raw text', () => {
    for (const [seriesDescription, family, energy] of [['Synthetic 50 keV', 'monoenergetic', 50], ['SYNTHETIC 70keV AXIAL', 'monoenergetic', 70],
        ['Synthetic BLENDED AXIAL', 'blended', null], ['Synthetic CONVENTIONAL', 'conventional', null]]) {
        const result = workflowFromMetadata({ ...base, seriesDescription });
        assert.equal(result.ctFamily, family); assert.equal(result.energyKeV, energy); assert.equal(result.familyEvidence, 'label');
        assert.equal(result.energyEvidence, energy == null ? 'unknown' : 'label'); assert.equal(JSON.stringify(result).includes('Synthetic'), false);
    }
    for (const seriesDescription of ['Synthetic 70 kVp', 'Synthetic blend', 'UNBLENDED', 'Synthetic70keV', 'Synthetic 70keVextended', '70keV' + ' '.repeat(513)]) {
        assert.equal(workflowFromMetadata({ ...base, seriesDescription }).ctFamily, 'unknown');
    }
    assert.equal(workflowFromMetadata({ ...base, kvp: 70, KVP: 70 }).energyKeV, null);
    assert.equal(workflowFromMetadata({ ...base }).ctFamily, 'unknown', 'Absence of spectral evidence does not prove conventional CT.');
});

test('CT family distinguishes explicit Image Type, standardized energy and weaker local labels', () => {
    for (const imageType of [['ORIGINAL', 'SECONDARY', 'AXIAL', 'MONOENERGETIC'], ['ORIGINAL', 'SECONDARY', 'AXIAL', 'MONOENERGY']]) {
        const result = workflowFromMetadata({ ...base, imageType });
        assert.equal(result.ctFamily, 'monoenergetic'); assert.equal(result.familyEvidence, 'image-type'); assert.equal(result.energyKeV, null);
    }
    const attribute = workflowFromMetadata({ ...base, monoenergeticEnergyEquivalent: 70, seriesDescription: 'Synthetic 70 keV' });
    assert.equal(attribute.ctFamily, 'monoenergetic'); assert.equal(attribute.familyEvidence, 'attribute'); assert.equal(attribute.energyEvidence, 'attribute');
    assert.equal(workflowFromMetadata({ ...base, modality: 'MR', seriesDescription: 'Synthetic 70 keV' }).ctFamily, 'unknown');
});

test('conflicting energy, family or malformed energy evidence is never replaced by a plausible label', () => {
    for (const metadata of [
        { monoenergeticEnergyEquivalent: 70, seriesDescription: 'Synthetic 50 keV' },
        { monoenergeticEnergyEquivalent: 70, seriesDescription: 'Synthetic BLENDED' },
        { seriesDescription: 'Synthetic 50 keV and 70 keV' },
        { seriesDescription: 'Synthetic BLENDED 70 keV' },
        { imageType: ['ORIGINAL', 'AXIAL', 'MONOENERGETIC', 'BLENDED'] },
        { imageType: ['ORIGINAL', 'AXIAL', 'MONOENERGETIC'], seriesDescription: 'Synthetic BLENDED' },
        { seriesDescription: 'Synthetic 0 keV' }
    ]) {
        const result = workflowFromMetadata({ ...base, ...metadata });
        assert.equal(result.ctFamily, 'unknown'); assert.equal(result.familyEvidence, 'unknown'); assert.equal(result.energyKeV, null); assert.equal(result.energyEvidence, 'unknown');
    }
    for (const invalid of [null, NaN, Infinity, 0, -1, 1001, '0x46', '70\\50', [50, 70], {}]) {
        const result = workflowFromMetadata({ ...base, monoenergeticEnergyEquivalent: invalid, seriesDescription: 'Synthetic 70 keV' });
        assert.equal(result.energyKeV, null); assert.equal(result.energyEvidence, 'unknown');
    }
});

test('vendor GSI MONO processing tokens cannot override explicit blended or keV labels', () => {
    for (const imageType of [['ORIGINAL', 'SECONDARY', 'AXIAL', 'GSI MONO'], ['ORIGINAL', 'SECONDARY', 'AXIAL', 'GSI', 'MONO']]) {
        const unspecified = workflowFromMetadata({ ...base, imageType });
        assert.equal(unspecified.ctFamily, 'unknown'); assert.equal(unspecified.familyEvidence, 'unknown');
        const blended = workflowFromMetadata({ ...base, imageType, seriesDescription: 'Synthetic BLENDED STND' });
        assert.equal(blended.ctFamily, 'blended'); assert.equal(blended.familyEvidence, 'label'); assert.equal(blended.energyKeV, null);
        const mono = workflowFromMetadata({ ...base, imageType, seriesDescription: 'Synthetic 50 keV STND' });
        assert.equal(mono.ctFamily, 'monoenergetic'); assert.equal(mono.familyEvidence, 'label'); assert.equal(mono.energyKeV, 50);
    }
});

test('specialized CT products cannot qualify as ordinary energy or blended families through labels', () => {
    for (const processing of ['GSI VUE', 'GSI MD', 'MIP', 'MPR']) {
        const result = workflowFromMetadata({ ...base, imageType: ['ORIGINAL', 'SECONDARY', 'AXIAL', processing],
            monoenergeticEnergyEquivalent: 70, seriesDescription: 'Synthetic 70 keV' });
        assert.equal(result.ctFamily, 'unknown'); assert.equal(result.energyKeV, null); assert.equal(result.familyEvidence, 'unknown');
    }
});

test('thickness and kernel are bounded recorded facts rather than a clinical reconstruction preference', () => {
    const attribute = workflowFromMetadata({ ...base, sliceThickness: '1.25', convolutionKernel: 'STND' });
    assert.equal(attribute.sliceThicknessMm, 1.25); assert.equal(attribute.kernel, 'standard'); assert.equal(attribute.kernelEvidence, 'attribute');
    assert.equal(workflowFromMetadata({ ...base, convolutionKernel: 'SHARP' }).kernel, 'sharp');
    assert.equal(workflowFromMetadata({ ...base, seriesDescription: 'Synthetic STANDARD' }).kernelEvidence, 'label');
    for (const convolutionKernel of ['B31f', 'STANDARD\\SHARP', null, {}, 'STANDARDIZED']) {
        assert.equal(workflowFromMetadata({ ...base, convolutionKernel, seriesDescription: 'Synthetic STANDARD' }).kernel, 'unknown');
    }
    assert.equal(workflowFromMetadata({ ...base, convolutionKernel: 'STANDARD', seriesDescription: 'Synthetic SHARP' }).kernel, 'unknown');
    assert.equal(workflowFromMetadata({ ...base, seriesDescription: 'Synthetic STANDARD SHARP' }).kernel, 'unknown');
    for (const sliceThickness of ['', '0x10', 0, -1, Infinity, '1\\2', 1001, ['1', '2']]) {
        assert.equal(workflowFromMetadata({ ...base, sliceThickness }).sliceThicknessMm, null);
    }
});

for (const syntax of ['1.2.840.10008.1.2', '1.2.840.10008.1.2.1', '1.2.840.10008.1.2.2']) {
    test(`metadata index reads FD energy in original byte order and loaded pixels retain it (${syntax})`, async () => {
        const input = file({ syntax }), indexed = await indexLocalFile(input), stacks = await loadFiles([input]);
        try {
            assert.deepEqual(semantics(indexed.workflow), { ctFamily: 'monoenergetic', energyKeV: 70, energyEvidence: 'attribute', familyEvidence: 'attribute',
                sliceThicknessMm: 1.25, kernel: 'standard', kernelEvidence: 'attribute' });
            assert.deepEqual(stacks[0].frames[0].workflow, indexed.workflow);
            assert.deepEqual((await stacks[0].getFrame(0)).workflow, indexed.workflow);
        } finally { stacks.forEach(stack => stack.dispose()); }
    });
}

test('metadata selection does not treat binary FD as a string or require a correctly aligned backing buffer', () => {
    const backing = new Uint8Array(13); backing.set(fd(50, false), 3);
    const result = workflowTechnicalMetadata(id => id === '0018937C' ? { vr: { ID: 'FD' }, data: backing.subarray(3, 11) } : null, { littleEndian: false });
    assert.equal(result.monoenergeticEnergyEquivalent, 50);
    for (const data of [new Uint8Array(7), new Uint8Array(16), fd(NaN), fd(Infinity), fd(0), fd(-1)]) {
        assert.equal(workflowTechnicalMetadata(id => id === '0018937C' ? { vr: { ID: 'FD' }, data } : null).monoenergeticEnergyEquivalent, null);
    }
    assert.equal(workflowTechnicalMetadata(id => id === '0018937C' ? { vr: { ID: 'DS' }, data: new TextEncoder().encode('70') } : null).monoenergeticEnergyEquivalent, null);
});

test('malformed optional FD energy leaves the index usable but cannot silently use the label', async () => {
    for (const malformed of [new Uint8Array(6), fd(NaN), fd(-20)]) {
        const metadata = await indexLocalFile(file({ extra: { '0018937C': ['FD', malformed] } }));
        assert.equal(metadata.workflow.energyKeV, null); assert.equal(metadata.workflow.energyEvidence, 'unknown');
        assert.equal(metadata.workflow.sliceThicknessMm, 1.25);
    }
});

test('DICOMweb JSON FD values use the same metadata projection without binary coercion', async () => {
    const entry = (vr, ...Value) => ({ vr, Value });
    const object = {
        '00080008': entry('CS', ...base.imageType), '00080016': entry('UI', '1.2.840.10008.5.1.4.1.1.2'), '00080018': entry('UI', '2.25.20261022.900'),
        '00080060': entry('CS', 'CT'), '0008103E': entry('LO', 'Synthetic 70 keV STANDARD'), '00180050': entry('DS', 1.25),
        '00181210': entry('SH', 'STANDARD'), '0018937C': entry('FD', 70), '0020000D': entry('UI', '2.25.20261022.901'), '0020000E': entry('UI', '2.25.20261022.902'),
        '00200037': entry('DS', ...base.imageOrientation), '00280002': entry('US', 1), '00280004': entry('CS', 'MONOCHROME2'),
        '00280008': entry('IS', 1), '00280010': entry('US', 2), '00280011': entry('US', 2),
        '00280100': entry('US', 16), '00280101': entry('US', 16), '00280102': entry('US', 15), '00280103': entry('US', 0),
        '00281052': entry('DS', 0), '00281053': entry('DS', 1), '00281054': entry('LO', 'HU'), '7FE00010': { vr: 'OW', BulkDataURI: 'https://archive.example.test/pixel-data' }
    };
    const parsed = await EASI.pipelineBuilder().fromByteStream().ofDicomMetadata().toInstances().build().process({ source: new TextEncoder().encode(JSON.stringify([object])) });
    const result = normalizeInstance(parsed.single(), { metadataOnly: true });
    assert.deepEqual(semantics(result.common.workflow), { ctFamily: 'monoenergetic', energyKeV: 70, energyEvidence: 'attribute', familyEvidence: 'attribute',
        sliceThicknessMm: 1.25, kernel: 'standard', kernelEvidence: 'attribute' });
});

test('all-instance aggregation refuses mixed or missing semantic evidence and keeps session projections bounded', async () => {
    const known = workflowFromMetadata({ ...base, monoenergeticEnergyEquivalent: 70, convolutionKernel: 'STANDARD', sliceThickness: 1.25 });
    const missing = workflowFromMetadata(base), different = workflowFromMetadata({ ...base, monoenergeticEnergyEquivalent: 50, convolutionKernel: 'SHARP', sliceThickness: 5 });
    assert.deepEqual(aggregateWorkflow([known, known]), known);
    for (const values of [[known, known, missing], [different, known, known]]) {
        const result = aggregateWorkflow(values);
        assert.equal(result.energyKeV, null); assert.equal(result.energyEvidence, 'unknown'); assert.equal(result.sliceThicknessMm, null);
        assert.equal(result.kernel, 'unknown'); assert.equal(result.kernelEvidence, 'unknown'); assert.equal(result.uniform, false);
    }
    const catalog = new LocalCatalog(); await catalog.addFiles([file()]);
    const patient = catalog.getPatients()[0], session = new SessionCatalog();
    const admission = session.admitLocal(catalog.getView(), { patientId: patient.id, studyIds: [patient.studies[0].id] });
    assert.equal(session.getSeries(admission.seriesIds[0]).workflow.energyKeV, 70);
    await catalog.addFiles([file({ extra: { '0018937C': null }, description: 'Synthetic unspecified CT' })]);
    session.admitLocal(catalog.getView(), { patientId: patient.id, studyIds: [patient.studies[0].id] });
    const updated = session.getSeries(admission.seriesIds[0]).workflow;
    assert.equal(updated.energyKeV, null); assert.equal(updated.ctFamily, 'unknown'); assert.equal(updated.familyEvidence, 'unknown');
    assert.equal(JSON.stringify(updated).includes('Synthetic'), false);
});

test('normalization does not invent evidence labels for supplied numbers or known family names', () => {
    const result = normalizeWorkflow({ ctFamily: 'monoenergetic', energyKeV: 70, kernel: 'standard', sliceThicknessMm: 1.25, raw: 'PRIVATE' });
    assert.equal(result.energyEvidence, 'unknown'); assert.equal(result.familyEvidence, 'unknown'); assert.equal(result.kernelEvidence, 'unknown');
    assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
    assert.equal(normalizeWorkflow({ energyKeV: -1, sliceThicknessMm: Infinity }).energyKeV, null);
    assert.equal(normalizeWorkflow({ energyKeV: [70], sliceThicknessMm: '1.25' }).energyKeV, null);
    assert.equal(normalizeWorkflow({ reconstruction: 'material-map', ctFamily: 'monoenergetic', energyKeV: 70, energyEvidence: 'attribute' }).energyKeV, null);
});
