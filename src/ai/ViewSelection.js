const SPECIAL = new Set(['virtual-unenhanced', 'material-map', 'projection', 'reformatted']);
const PURPOSES = new Set(['routine', 'lung', 'soft-tissue', 'bone']);
const ordinaryFamily = family => ['conventional', 'blended', 'monoenergetic'].includes(family);
const positive = value => typeof value === 'number' && Number.isFinite(value) && value > 0;
const familyKnown = workflow => ['attribute', 'image-type', 'label'].includes(workflow.familyEvidence);
const energyKnown = workflow => positive(workflow.energyKeV) && ['attribute', 'label'].includes(workflow.energyEvidence);
const kernelKnown = workflow => ['attribute', 'label'].includes(workflow.kernelEvidence);
const clean = value => String(value ?? '').replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 180);
const evidenceLabel = value => ({ attribute: 'recorded attribute', 'image-type': 'recorded image type', label: 'local source label' }[value] ?? 'unknown evidence');

/** Resolve only bounded local technical evidence. Descriptions are display
 * labels, never an unrestricted query or a substitute for missing metadata. */
export function resolveViewCandidates(source, selector, preferences = {}) {
    const explicitFamily = selector.reconstruction && selector.reconstruction !== 'ordinary';
    const literal = selector.study === 'displayed';
    let candidates = source.filter(series => {
        const workflow = series.workflow ?? {};
        const requestedReformat = ['coronal', 'sagittal'].includes(selector.plane) && workflow.plane === selector.plane && workflow.reconstruction === 'reformatted';
        if (!literal && workflow.localizer === true) return false;
        if (explicitFamily) {
            if (SPECIAL.has(selector.reconstruction)) {
                if (workflow.reconstruction !== selector.reconstruction) return false;
            } else if (workflow.ctFamily !== selector.reconstruction || !familyKnown(workflow)) return false;
        } else if (!literal || selector.reconstruction === 'ordinary') {
            if (!requestedReformat && (workflow.derivation === 'derived' || SPECIAL.has(workflow.reconstruction))) return false;
        }
        if (selector.kernel && (workflow.kernel !== selector.kernel || !kernelKnown(workflow))) return false;
        if (selector.energyKeV != null || selector.energyPreference) {
            if (workflow.ctFamily !== 'monoenergetic' || !familyKnown(workflow)) return false;
            if (selector.energyKeV != null && (workflow.energyKeV !== selector.energyKeV || !energyKnown(workflow))) return false;
        }
        return true;
    });
    if (!candidates.length) return { candidates: [], reason: 'No image stack has the requested recorded metadata. Missing or conflicting family, energy, kernel, contrast and orientation evidence is not treated as a match.' };
    const rank = (field, direction, explanation) => {
        if (candidates.some(series => !positive(series.workflow?.[field]) || field === 'energyKeV' && !energyKnown(series.workflow ?? {}))) return 'Cannot determine the ' + explanation + ': at least one otherwise matching image stack has missing or conflicting recorded values. Narrow the request or choose a reconstruction with known metadata.';
        const target = Math[direction === 'lowest' || direction === 'thinnest' ? 'min' : 'max'](...candidates.map(series => series.workflow[field]));
        candidates = candidates.filter(series => series.workflow[field] === target);
        return null;
    };
    if (selector.energyPreference) {
        const reason = rank('energyKeV', selector.energyPreference, selector.energyPreference + ' recorded monoenergetic energy');
        if (reason) return { candidates: [], reason };
    }
    if (selector.thickness) {
        const reason = rank('sliceThicknessMm', selector.thickness, selector.thickness + ' recorded slice thickness');
        if (reason) return { candidates: [], reason };
    }
    let preferenceApplied = false;
    if (!literal && (!selector.reconstruction || selector.reconstruction === 'ordinary') && selector.energyKeV == null && !selector.energyPreference &&
        PURPOSES.has(selector.purpose) && preferences.routineCt === 'blended') {
        const preferred = candidates.filter(series => series.workflow?.ctFamily === 'blended' && familyKnown(series.workflow));
        if (preferred.length) { candidates = preferred; preferenceApplied = true; }
    }
    return { candidates, preferenceApplied, reason: null };
}

export function viewSelectionReason(series, selection = {}) {
    const workflow = series.workflow ?? {}, reasons = [];
    if (workflow.ctFamily && workflow.ctFamily !== 'unknown' && familyKnown(workflow)) reasons.push(workflow.ctFamily + ' family from ' + evidenceLabel(workflow.familyEvidence));
    if (energyKnown(workflow)) reasons.push(workflow.energyKeV + ' keV from ' + evidenceLabel(workflow.energyEvidence));
    if (workflow.kernel && workflow.kernel !== 'unknown' && kernelKnown(workflow)) reasons.push(workflow.kernel + ' kernel from ' + evidenceLabel(workflow.kernelEvidence));
    if (positive(workflow.sliceThicknessMm)) reasons.push(workflow.sliceThicknessMm + ' mm recorded slice thickness');
    if (selection.preferenceApplied) reasons.push('configured routine CT preference: blended; not a clinical ranking');
    if (series.modality === 'CT') reasons.push('HU calibration checked when opened');
    return reasons.join('; ');
}

export function viewSelectionLabel(series) {
    const workflow = series.workflow ?? {};
    const family = ordinaryFamily(workflow.ctFamily) && familyKnown(workflow) ? workflow.ctFamily : SPECIAL.has(workflow.reconstruction) ? workflow.reconstruction : series.modality || 'Image';
    const name = family.charAt(0).toUpperCase() + family.slice(1) + (series.modality === 'CT' && family !== 'CT' ? ' CT' : '');
    return [name, energyKnown(workflow) && workflow.energyKeV + ' keV',
        workflow.plane && workflow.plane !== 'unknown' && workflow.plane,
        clean(series.description), (series.frameCount ?? '?') + ' images',
        series.number != null && 'Series ' + series.number].filter(Boolean).join(' · ');
}

/** Identical conceptual requests refer to one local source choice in any
 * number of panes. Different criteria and different study roles stay separate. */
export function sharedViewSelections(plan) {
    const groups = new Map(), indices = new Map();
    plan.actions.forEach((action, index) => {
        if (action.type !== 'select-view') return;
        const key = JSON.stringify(action.selector);
        if (!groups.has(key)) groups.set(key, 'view-' + index);
        indices.set(index, groups.get(key));
    });
    return indices;
}

export function frameAtPosition(position, count) {
    if (!Number.isSafeInteger(count) || count < 1) throw new Error('The selected image stack has no reliable navigable image count. Its first, middle or last image cannot be resolved.');
    return position === 'first' ? 1 : position === 'last' ? count : Math.floor((count - 1) / 2) + 1;
}
