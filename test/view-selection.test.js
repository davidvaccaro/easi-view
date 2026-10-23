import test from 'node:test';
import assert from 'node:assert/strict';
import { frameAtPosition, resolveViewCandidates, sharedViewSelections, viewSelectionLabel, viewSelectionReason } from '../src/ai/ViewSelection.js';

const selector = changes => ({study: 'active', modality: 'CT', plane: 'axial', contrast: null, bodyPart: null,
    purpose: 'routine', reconstruction: null, energyKeV: null, energyPreference: null, thickness: null, kernel: null, ...changes});
const stack = (id, workflow = {}) => ({id, modality: 'CT', number: 92, description: 'Synthetic technical label', frameCount: 228,
    workflow: {plane: 'axial', localizer: false, derivation: 'original', reconstruction: 'axial', ctFamily: 'monoenergetic',
        familyEvidence: 'image-type', energyKeV: 70, energyEvidence: 'attribute', sliceThicknessMm: 1.25,
        kernel: 'standard', kernelEvidence: 'attribute', ...workflow}});
const ids = value => value.candidates.map(item => item.id);

test('ordinary conceptual selection excludes explicit specialized, scout and derived stacks without guessing unknown metadata', () => {
    const ordinary = stack('ordinary'), unknown = stack('unknown', {ctFamily: 'unknown', familyEvidence: 'unknown', energyKeV: null, energyEvidence: 'unknown', reconstruction: 'unknown'});
    const excluded = ['virtual-unenhanced', 'material-map', 'projection', 'reformatted'].map(reconstruction => stack(reconstruction, {reconstruction}));
    excluded.push(stack('scout', {localizer: true}), stack('derived', {derivation: 'derived'}));
    assert.deepEqual(ids(resolveViewCandidates([ordinary, ...excluded, unknown], selector())), ['ordinary', 'unknown']);
});

test('explicit specialized family honors its actual recorded class even when derived, but descriptions cannot create it', () => {
    const special = stack('special', {reconstruction: 'projection', derivation: 'derived'});
    const misleading = {...stack('label-only'), description: 'MIP iodine virtual noncontrast'};
    assert.deepEqual(ids(resolveViewCandidates([special, misleading], selector({reconstruction: 'projection'}))), ['special']);
    assert.deepEqual(ids(resolveViewCandidates([special, misleading], selector({reconstruction: 'material-map'}))), []);
});

test('an explicitly requested nonaxial plane may use an existing recorded reformat without generating or guessing one', () => {
    const coronal = stack('coronal', {plane: 'coronal', reconstruction: 'reformatted', derivation: 'derived'});
    const axial = stack('axial-mpr', {plane: 'axial', reconstruction: 'reformatted', derivation: 'derived'});
    assert.deepEqual(ids(resolveViewCandidates([coronal], selector({plane: 'coronal'}))), ['coronal']);
    assert.deepEqual(ids(resolveViewCandidates([coronal, axial], selector({plane: 'axial'}))), []);
    assert.deepEqual(ids(resolveViewCandidates([coronal], selector({plane: 'sagittal'}))), []);
});

test('an explicitly displayed stack stays literal unless a specific family criterion was requested', () => {
    const scout = stack('shown', {localizer: true, derivation: 'derived', reconstruction: 'projection'});
    assert.deepEqual(ids(resolveViewCandidates([scout], selector({study: 'displayed', purpose: 'lung'}))), ['shown']);
    assert.deepEqual(ids(resolveViewCandidates([scout], selector({study: 'displayed', reconstruction: 'ordinary'}))), []);
});

test('explicit families, energy and kernels require recognized evidence and never use a misleading display label', () => {
    const valid = stack('valid'), noEvidence = stack('unknown', {familyEvidence: 'unknown', energyEvidence: 'unknown', kernelEvidence: 'unknown'});
    for (const criteria of [{reconstruction: 'monoenergetic'}, {energyKeV: 70}, {kernel: 'standard'}]) {
        assert.deepEqual(ids(resolveViewCandidates([valid, noEvidence], selector(criteria))), ['valid']);
    }
    const noisy = stack('display-label', {ctFamily: 'unknown', familyEvidence: 'unknown', energyKeV: null, kernel: 'unknown', kernelEvidence: 'unknown'});
    noisy.description = '50 keV sharp BLENDED';
    assert.equal(resolveViewCandidates([noisy], selector({reconstruction: 'blended'})).candidates.length, 0);
    assert.equal(resolveViewCandidates([noisy], selector({energyKeV: 50})).candidates.length, 0);
});

test('lowest and highest energy use recorded monoenergetic values and retain equal-value ambiguity', () => {
    const candidates = [stack('70'), stack('50-a', {energyKeV: 50}), stack('50-b', {energyKeV: 50}), stack('blended', {ctFamily: 'blended', energyKeV: null, energyEvidence: 'unknown'})];
    assert.deepEqual(ids(resolveViewCandidates(candidates, selector({energyPreference: 'lowest'}))), ['50-a', '50-b']);
    assert.deepEqual(ids(resolveViewCandidates(candidates, selector({energyPreference: 'highest'}))), ['70']);
    assert.deepEqual(ids(resolveViewCandidates(candidates, selector({energyKeV: 70}))), ['70']);
});

test('one missing energy in the matching monoenergetic cohort prevents a fabricated lowest-energy ranking', () => {
    const candidates = [stack('70'), stack('unknown-energy', {energyKeV: null, energyEvidence: 'unknown'})];
    const result = resolveViewCandidates(candidates, selector({energyPreference: 'lowest'}));
    assert.deepEqual(result.candidates, []); assert.match(result.reason, /Cannot determine.*lowest.*missing or conflicting/u);
    assert.deepEqual(ids(resolveViewCandidates(candidates, selector({energyKeV: 70}))), ['70']);
});

test('thickness ranking uses the whole eligible cohort, retains ties and refuses missing thickness', () => {
    const candidates = [stack('thin-a'), stack('thin-b'), stack('thick', {sliceThicknessMm: 5})];
    assert.deepEqual(ids(resolveViewCandidates(candidates, selector({thickness: 'thinnest'}))), ['thin-a', 'thin-b']);
    assert.deepEqual(ids(resolveViewCandidates(candidates, selector({thickness: 'thickest'}))), ['thick']);
    candidates.push(stack('unknown', {sliceThicknessMm: null}));
    const result = resolveViewCandidates(candidates, selector({thickness: 'thinnest'}));
    assert.deepEqual(result.candidates, []); assert.match(result.reason, /Cannot determine.*thinnest.*missing or conflicting/u);
});

test('only an explicit host preference chooses eligible blended CT; it cannot override energy or family criteria', () => {
    const candidates = [stack('70'), stack('blend', {ctFamily: 'blended', familyEvidence: 'label', energyKeV: null, energyEvidence: 'unknown'})];
    assert.deepEqual(ids(resolveViewCandidates(candidates, selector())), ['70', 'blend']);
    assert.deepEqual(ids(resolveViewCandidates(candidates, selector(), {routineCt: 'no-preference'})), ['70', 'blend']);
    const result = resolveViewCandidates(candidates, selector(), {routineCt: 'blended'});
    assert.deepEqual(ids(result), ['blend']); assert.equal(result.preferenceApplied, true);
    assert.match(viewSelectionReason(result.candidates[0], result), /configured routine CT preference.*not a clinical ranking/u);
    for (const criteria of [{reconstruction: 'monoenergetic'}, {energyKeV: 70}, {energyPreference: 'lowest'}]) {
        assert.deepEqual(ids(resolveViewCandidates(candidates, selector(criteria), {routineCt: 'blended'})), ['70']);
    }
    assert.deepEqual(ids(resolveViewCandidates(candidates, selector({purpose: null}), {routineCt: 'blended'})), ['70', 'blend']);
});

test('configured preference does not invent a missing blended stack and ties remain choices', () => {
    const preference = {routineCt: 'blended'};
    assert.deepEqual(ids(resolveViewCandidates([stack('70')], selector(), preference)), ['70']);
    const blends = ['a', 'b'].map(id => stack(id, {ctFamily: 'blended', familyEvidence: 'image-type'}));
    assert.deepEqual(ids(resolveViewCandidates([stack('70'), ...blends], selector({reconstruction: 'ordinary'}), preference)), ['a', 'b']);
});

test('choice labels emphasize technical concepts, keep series numbers secondary and identify weaker local label evidence', () => {
    const item = stack('label', {familyEvidence: 'label', energyEvidence: 'label'});
    assert.match(viewSelectionLabel(item), /^Monoenergetic CT · 70 keV · axial/u);
    assert.ok(viewSelectionLabel(item).endsWith('Series 92'));
    assert.match(viewSelectionReason(item), /family from local source label; 70 keV from local source label/u);
    assert.doesNotMatch(viewSelectionReason(item), /best|clinically correct/u);
});

test('identical conceptual criteria share across four panes while distinct roles and energies stay independent', () => {
    const actions = [0, 1, 2, 3].map(viewport => ({type: 'select-view', viewport, selector: selector()}));
    actions.push({type: 'select-view', viewport: 1, selector: selector({study: 'prior'})},
        {type: 'select-view', viewport: 2, selector: selector({energyKeV: 50})});
    const groups = sharedViewSelections({actions});
    assert.deepEqual([...groups.values()], ['view-0', 'view-0', 'view-0', 'view-0', 'view-4', 'view-5']);
});

test('first middle and last image positions use actual counts and the lower middle of an even stack', () => {
    for (const [count, first, middle, last] of [[228, 1, 114, 228], [5, 1, 3, 5], [1, 1, 1, 1]]) {
        assert.equal(frameAtPosition('first', count), first); assert.equal(frameAtPosition('middle', count), middle); assert.equal(frameAtPosition('last', count), last);
    }
    for (const count of [undefined, null, 0, -1, 1.5, Infinity, '228']) assert.throws(() => frameAtPosition('middle', count), /reliable navigable image count/u);
});
