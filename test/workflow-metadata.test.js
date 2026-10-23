import test from 'node:test';
import assert from 'node:assert/strict';
import { WORKFLOW_RECONSTRUCTIONS, workflowPlane, workflowFromMetadata, normalizeWorkflow, aggregateWorkflow } from '../src/catalog/workflow.js';
import { indexLocalFile } from '../src/catalog/metadata.js';
import LocalCatalog from '../src/catalog/LocalCatalog.js';
import { SessionCatalog } from '../src/catalog/SessionCatalog.js';
import { loadFiles } from '../src/data/sources.js';
import { createDicomFixture } from '../src/data/synthetic.js';

let nextUid = 1;
const fixture = (extra = {}, options = {}) => new File([createDicomFixture({ sopUid: `2.25.20261021.${nextUid++}`, ...options,
    extraAttributes: { '00100021': ['LO', 'SYNTHETIC-ISSUER'], '00180015': ['CS', 'CHEST'],
        '00080008': ['CS', ['ORIGINAL', 'PRIMARY', 'AXIAL']], '00180010': ['LO', 'SYNTHETIC CONTRAST'],
        '00181040': ['LO', 'INTRAVENOUS'], '00181042': ['TM', '120000.5'], ...extra } })], 'SYNTHETIC');

for (const [label, input, expected] of [
    ['axial', '1\\0\\0\\0\\1\\0', 'axial'], ['coronal', [1, 0, 0, 0, 0, -1], 'coronal'],
    ['sagittal', [0, 1, 0, 0, 0, -1], 'sagittal'], ['reversed axial', [-1, 0, 0, 0, 1, 0], 'axial'],
    ['oblique', [Math.SQRT1_2, Math.SQRT1_2, 0, 0, 0, 1], 'oblique'], ['missing', null, 'unknown'],
    ['zero directions', [0, 0, 0, 0, 0, 0], 'unknown'], ['parallel directions', [1, 0, 0, 1, 0, 0], 'unknown'],
    ['nonunit directions', [2, 0, 0, 0, 1, 0], 'unknown'], ['wrong VM', '1\\0\\0', 'unknown'],
    ['empty components', '1\\\\0\\0\\1\\0', 'unknown'], ['non-DICOM number', '0x1\\0\\0\\0\\1\\0', 'unknown']
]) test(`workflow orientation evidence: ${label}`, () => assert.equal(workflowPlane(input), expected));

test('true contrast agent metadata records evidence without inferring enhancement or phase', () => {
    const present = workflowFromMetadata({ contrastBolusAgent: 'Synthetic agent', contrastBolusRoute: 'IV',
        contrastBolusStartTime: '090030', contrastBolusStopTime: '090045.5', bodyPartExamined: 'CHEST', imageType: 'ORIGINAL\\PRIMARY\\AXIAL' });
    assert.equal(present.contrast, 'present'); assert.equal(present.bodyPart, 'chest'); assert.equal(present.localizer, false); assert.equal(present.derivation, 'original');
    assert.deepEqual(present.contrastEvidence, { agentRecorded: true, routeRecorded: true, startTimeRecorded: true, stopTimeRecorded: true });
    const serialized = JSON.stringify(present);
    for (const forbidden of ['Synthetic agent', 'IV', '090030', 'phase', 'enhance']) assert.equal(serialized.includes(forbidden), false);
    assert.equal(workflowFromMetadata({ contrastBolusAgent: 'NONE' }).contrast, 'absent');
    for (const input of [{}, { contrastBolusAgent: 'UNKNOWN' }, { contrastBolusAgent: 'N/A' },
        { contrastBolusRoute: 'IV' }, { contrastBolusAgent: 'SYNTHETIC\\NONE' }, { contrastBolusAgent: 'NONE', contrastBolusRoute: 'IV' },
        { contrastBolusAgent: 'NONE', contrastBolusStartTime: '090000' }]) assert.equal(workflowFromMetadata(input).contrast, 'unknown');
    assert.equal(workflowFromMetadata({ contrastBolusAgent: 'NONE', contrastBolusStartTime: '250099' }).contrast, 'absent');
});

test('body part and localizer evidence use known bounded tokens rather than arbitrary descriptions', () => {
    assert.equal(workflowFromMetadata({ bodyPartExamined: 'ABD_PELVIS' }).bodyPart, 'abdomen-pelvis');
    assert.equal(workflowFromMetadata({ bodyPartExamined: 'PRIVATE NAME', seriesDescription: 'axial liver contrast' }).bodyPart, 'unknown');
    assert.equal(workflowFromMetadata({ imageType: 'ORIGINAL\\PRIMARY\\LOCALIZER' }).localizer, true);
    assert.equal(workflowFromMetadata({ imageType: ['ORIGINAL', 'PRIMARY', 'M'] }).localizer, null);
    assert.equal(workflowFromMetadata({ seriesDescription: 'Scout' }).localizer, null);
    assert.equal(workflowFromMetadata({ imageType: 'DERIVED\\PRIMARY\\OTHER' }).derivation, 'derived');
    assert.equal(workflowFromMetadata({}).derivation, 'unknown');
});

for (const [description, imageType, expected] of [
    ['ordinary axial acquisition', 'ORIGINAL\\PRIMARY\\AXIAL', 'axial'],
    ['original monoenergetic reconstruction', ['ORIGINAL', 'SECONDARY', 'AXIAL', 'GSI MONO'], 'axial'],
    ['original virtual unenhanced reconstruction', 'ORIGINAL\\SECONDARY\\AXIAL\\GSI VUE', 'virtual-unenhanced'],
    ['explicit virtual noncontrast', ['ORIGINAL', 'PRIMARY', 'AXIAL', 'VNC'], 'virtual-unenhanced'],
    ['spaced virtual unenhanced', ['DERIVED', 'PRIMARY', 'AXIAL', 'virtual unenhanced'], 'virtual-unenhanced'],
    ['iodine map', ['DERIVED', 'PRIMARY', 'AXIAL', 'IODINE_MAP'], 'material-map'],
    ['material density map', ['ORIGINAL', 'SECONDARY', 'AXIAL', 'MATERIAL DENSITY'], 'material-map'],
    ['maximum intensity projection', 'DERIVED\\SECONDARY\\REFORMATTED\\MIP', 'projection'],
    ['minimum intensity projection', ['DERIVED', 'PRIMARY', 'AXIAL', 'MINIP'], 'projection'],
    ['explicit projection', ['DERIVED', 'PRIMARY', 'AXIAL', 'PROJECTION'], 'projection'],
    ['reformatted axial', ['DERIVED', 'PRIMARY', 'AXIAL', 'REFORMATTED'], 'reformatted'],
    ['multiplanar reformat', ['DERIVED', 'SECONDARY', 'MPR'], 'reformatted'],
    ['original alone', 'ORIGINAL\\PRIMARY', 'unknown'],
    ['unrecognized words', ['ORIGINAL', 'PRIMARY', 'NOT_MIP', 'AXIALIZED', 'VNC_CUSTOM'], 'unknown'],
    ['missing image type', null, 'unknown']
]) test(`bounded reconstruction evidence: ${description}`, () => {
    assert.equal(workflowFromMetadata({ imageType }).reconstruction, expected);
});

test('reconstruction classification never infers processing from descriptions, geometry or partial tokens', () => {
    assert.equal(workflowFromMetadata({ imageOrientation: [1, 0, 0, 0, 1, 0], seriesDescription: 'MIP VNC axial',
        imageType: ['ORIGINAL', 'PRIMARY', 'IODINE'] }).reconstruction, 'unknown');
    assert.equal(workflowFromMetadata({ imageType: [...Array(16).fill('OTHER'), 'MIP'] }).reconstruction, 'unknown');
    assert.equal(workflowFromMetadata({ imageType: ['MIP' + ' '.repeat(510)] }).reconstruction, 'unknown');
});

test('reconstruction projection validates exact enum values and aggregates every instance conservatively', () => {
    for (const reconstruction of WORKFLOW_RECONSTRUCTIONS) assert.equal(normalizeWorkflow({ reconstruction }).reconstruction, reconstruction);
    for (const reconstruction of ['AXIAL', 'MIP', 'private custom reconstruction', '', null, 1, {}, ['axial']]) {
        assert.equal(normalizeWorkflow({ reconstruction }).reconstruction, 'unknown');
    }
    const axial = workflowFromMetadata({ imageType: 'ORIGINAL\\PRIMARY\\AXIAL' });
    const virtual = workflowFromMetadata({ imageType: 'ORIGINAL\\SECONDARY\\AXIAL\\GSI VUE' });
    assert.equal(virtual.derivation, 'original');
    assert.equal(aggregateWorkflow([axial, axial]).reconstruction, 'axial');
    assert.equal(aggregateWorkflow([virtual, virtual]).reconstruction, 'virtual-unenhanced');
    for (const values of [[axial, virtual], [axial, axial, workflowFromMetadata({})], [virtual, axial, virtual]]) {
        const aggregated = aggregateWorkflow(values);
        assert.equal(aggregated.reconstruction, 'unknown'); assert.equal(aggregated.uniform, false);
    }
    assert.equal(aggregateWorkflow([]).reconstruction, 'unknown');
});

test('series workflow evidence requires every instance and never uses majority or first-instance guesses', () => {
    const axial = workflowFromMetadata({ imageOrientation: [1, 0, 0, 0, 1, 0], bodyPartExamined: 'CHEST', contrastBolusAgent: 'Synthetic' });
    const missing = workflowFromMetadata({});
    assert.deepEqual(aggregateWorkflow([axial, axial]), axial);
    const mixed = aggregateWorkflow([axial, axial, missing]);
    assert.equal(mixed.plane, 'unknown'); assert.equal(mixed.contrast, 'unknown'); assert.equal(mixed.bodyPart, 'unknown');
    assert.equal(mixed.contrastEvidence.agentRecorded, false); assert.equal(mixed.uniform, false);
    assert.equal(aggregateWorkflow([]).uniform, false);
});

test('workflow normalization strips raw values and arbitrary extra fields and freezes nested evidence', () => {
    const normalized = normalizeWorkflow({ plane: 'axial', bodyPart: 'not-known', contrast: 'potentially enhanced',
        localizer: 'yes', uniform: true, secret: 'UNEXPECTED', contrastEvidence: { agentRecorded: true, agentName: 'UNEXPECTED' } });
    assert.equal(normalized.plane, 'axial'); assert.equal(normalized.bodyPart, 'unknown'); assert.equal(normalized.contrast, 'unknown');
    assert.equal(normalized.localizer, null); assert.equal(JSON.stringify(normalized).includes('UNEXPECTED'), false);
    assert.equal(Object.isFrozen(normalized.contrastEvidence), true);
});

for (const transferSyntax of ['1.2.840.10008.1.2', '1.2.840.10008.1.2.1', '1.2.840.10008.1.2.2']) {
    test(`EASI metadata selection extracts real contrast/geometry tags before pixels (${transferSyntax})`, async () => {
        const metadata = await indexLocalFile(fixture({}, { transferSyntax }));
        assert.equal(metadata.workflow.plane, 'axial'); assert.equal(metadata.workflow.bodyPart, 'chest');
        assert.equal(metadata.workflow.contrast, 'present'); assert.equal(metadata.workflow.contrastEvidence.startTimeRecorded, true);
        assert.equal(metadata.workflow.localizer, false); assert.equal(metadata.workflow.reconstruction, 'axial');
    });
}

test('missing Contrast/Bolus Agent stays unknown even when Acquisition Contrast or series descriptions claim contrast', async () => {
    const metadata = await indexLocalFile(fixture({ '00180010': null, '00181040': null, '00181042': null,
        '00089209': ['CS', 'CONTRAST'], '0008103E': ['LO', 'Synthetic post contrast'] }));
    assert.equal(metadata.workflow.contrast, 'unknown'); assert.equal(metadata.workflow.contrastEvidence.agentRecorded, false);
});

test('local index and admitted session retain bounded workflow evidence and refresh mixed series conservatively', async () => {
    const catalog = new LocalCatalog();
    await catalog.addFiles([fixture(), fixture()]);
    const patient = catalog.getPatients()[0], series = patient.studies[0].series[0], session = new SessionCatalog();
    assert.equal(series.workflow.contrast, 'present'); assert.equal(series.workflow.uniform, true);
    const admission = session.admitLocal(catalog.getView(), { patientId: patient.id, studyIds: [patient.studies[0].id] });
    assert.deepEqual(session.getSeries(admission.seriesIds[0]).workflow, series.workflow);
    assert.equal(JSON.stringify(session.getSeries(admission.seriesIds[0]).workflow).includes('SYNTHETIC CONTRAST'), false);
    await catalog.addFiles([fixture({ '00180010': null, '00181040': null, '00181042': null })]);
    session.admitLocal(catalog.getView(), { patientId: patient.id, studyIds: [patient.studies[0].id] });
    assert.equal(session.getSeries(admission.seriesIds[0]).workflow.contrast, 'unknown');
    assert.equal(session.getSeries(admission.seriesIds[0]).workflow.uniform, false);
    session.updateSeries(admission.seriesIds[0], { workflow: { plane: 'coronal', uniform: true, raw: 'PRIVATE' } });
    assert.equal(session.getSeries(admission.seriesIds[0]).workflow.plane, 'coronal');
    assert.equal(JSON.stringify(session.getSeries(admission.seriesIds[0]).workflow).includes('PRIVATE'), false);
});

test('loaded stack frame descriptors expose the same bounded projection without raw agent values', async () => {
    const file = fixture(), metadata = await indexLocalFile(file), stacks = await loadFiles([file]);
    try {
        assert.equal(stacks.length, 1);
        assert.deepEqual(stacks[0].frames[0].workflow, metadata.workflow);
        assert.deepEqual((await stacks[0].getFrame(0)).workflow, metadata.workflow);
    } finally { stacks.forEach(stack => stack.dispose()); }
});

for (const kind of ['ct-missing-agent', 'mr-multiple-contrast']) {
    test(`public synthetic real-world workflow pattern: ${kind}`, async () => {
        const { createWorkflowStudyFiles } = await import('./fixtures/workflow-studies.js');
        const local = new LocalCatalog();
        const result = await local.addFiles(createWorkflowStudyFiles({ kind, instancesPerSeries: 3 }));
        assert.equal(result.failed, 0);
        const patient = local.getPatients()[0], study = patient.studies[0];
        assert.equal(patient.patientName, 'SYNTHETIC^WORKFLOW'); assert.equal(patient.studies.length, 1);
        assert.ok(study.series.every(series => series.instanceCount === 3 && series.workflow.plane === 'axial' && series.workflow.uniform));
        if (kind === 'ct-missing-agent') {
            assert.match(study.description, /with contrast/u);
            assert.ok(study.series.every(series => series.workflow.contrast === 'unknown'));
            assert.equal(study.series.filter(series => series.workflow.derivation === 'derived').length, 1);
        } else {
            assert.equal(study.series.filter(series => series.workflow.contrast === 'present' && series.workflow.derivation === 'original').length, 3);
            assert.equal(study.series.find(series => series.seriesNumber === 9).workflow.contrast, 'unknown');
            assert.equal(study.series.find(series => series.seriesNumber === 11001).workflow.derivation, 'derived');
        }
    });
}


test('split GSI and VUE Image Type components keep virtual unenhanced separate from ordinary original axial CT', () => {
    const value = workflowFromMetadata({imageType: ['ORIGINAL', 'SECONDARY', 'AXIAL', 'GSI', 'VUE']});
    assert.equal(value.derivation, 'original'); assert.equal(value.reconstruction, 'virtual-unenhanced');
    assert.equal(workflowFromMetadata({imageType: ['ORIGINAL', 'SECONDARY', 'AXIAL', 'GSI', 'MONO']}).reconstruction, 'axial');
});


test('original axial GSI material-density reconstructions remain distinguishable from ordinary HU image stacks', () => {
    for (const imageType of ['ORIGINAL\\SECONDARY\\AXIAL\\GSI MD', ['ORIGINAL', 'SECONDARY', 'AXIAL', 'GSI', 'MD']]) {
        const value = workflowFromMetadata({imageType});
        assert.equal(value.derivation, 'original'); assert.equal(value.reconstruction, 'material-map');
    }
});
