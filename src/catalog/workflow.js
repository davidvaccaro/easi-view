/** Bounded technical workflow evidence. Raw descriptions, identifiers and agent
 * names stay in the local index and never enter this projection. An agent field
 * records administration metadata; it does not establish enhancement or phase. */
export const WORKFLOW_PLANES = Object.freeze(['axial', 'coronal', 'sagittal', 'oblique', 'unknown']);
export const WORKFLOW_RECONSTRUCTIONS = Object.freeze(['axial', 'reformatted', 'projection', 'virtual-unenhanced', 'material-map', 'unknown']);
export const WORKFLOW_CT_FAMILIES = Object.freeze(['conventional', 'blended', 'monoenergetic', 'unknown']);
const SPECIAL_RECONSTRUCTIONS = new Set(['virtual-unenhanced', 'material-map', 'projection', 'reformatted']);
const EVIDENCE = ['attribute', 'image-type', 'label', 'unknown'];
const NUMERIC = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/u;
const KERNELS = new Map([['STANDARD', 'standard'], ['STND', 'standard'], ['SHARP', 'sharp']]);
export const WORKFLOW_BODY_PARTS = Object.freeze(['head', 'brain', 'neck', 'chest', 'abdomen', 'pelvis', 'chest-abdomen-pelvis', 'abdomen-pelvis',
    'spine', 'liver', 'kidney', 'prostate', 'heart', 'breast', 'upper-extremity', 'lower-extremity', 'whole-body', 'unknown']);
const BODY_PARTS = new Map([
    ['HEAD', 'head'], ['BRAIN', 'brain'], ['NECK', 'neck'], ['CHEST', 'chest'], ['THORAX', 'chest'], ['LUNG', 'chest'],
    ['ABDOMEN', 'abdomen'], ['ABDOMINAL', 'abdomen'], ['PELVIS', 'pelvis'], ['CHESTABDOMENPELVIS', 'chest-abdomen-pelvis'],
    ['CHESTABDPELVIS', 'chest-abdomen-pelvis'], ['ABDOMENPELVIS', 'abdomen-pelvis'], ['ABDPELVIS', 'abdomen-pelvis'],
    ['CSPINE', 'spine'], ['TSPINE', 'spine'], ['LSPINE', 'spine'], ['SPINE', 'spine'], ['LIVER', 'liver'], ['KIDNEY', 'kidney'],
    ['KIDNEYS', 'kidney'], ['PROSTATE', 'prostate'], ['HEART', 'heart'], ['CARDIAC', 'heart'], ['BREAST', 'breast'],
    ['SHOULDER', 'upper-extremity'], ['ELBOW', 'upper-extremity'], ['WRIST', 'upper-extremity'], ['HAND', 'upper-extremity'],
    ['ARM', 'upper-extremity'], ['HIP', 'lower-extremity'], ['FEMUR', 'lower-extremity'], ['KNEE', 'lower-extremity'],
    ['ANKLE', 'lower-extremity'], ['FOOT', 'lower-extremity'], ['LEG', 'lower-extremity'], ['WHOLEBODY', 'whole-body']
]);
const clean = value => typeof value === 'string' && value.length <= 512 ? value.trim().toUpperCase() : '';
const recorded = value => clean(value).length > 0;
const ABSENT_AGENTS = new Set(['NONE', 'NO', 'NO CONTRAST', 'NO CONTRAST AGENT', 'NOT ADMINISTERED']);
const UNKNOWN_AGENTS = new Set(['', 'UNKNOWN', 'UNSPECIFIED', 'N/A', 'NA', '?']);
const EVIDENCE_FIELDS = ['agentRecorded', 'routeRecorded', 'startTimeRecorded', 'stopTimeRecorded'];
const timeRecorded = value => /^(?:[01]\d|2[0-3])(?:[0-5]\d(?:[0-5]\d(?:\.\d{1,6})?)?)?$/u.test(clean(value));
const RECONSTRUCTION_TOKENS = Object.freeze([
    ['virtual-unenhanced', new Set(['GSI_VUE', 'GSI_VNC', 'VNC', 'VIRTUAL_UNENHANCED', 'VIRTUAL_NONCONTRAST', 'VIRTUAL_NON_CONTRAST'])],
    ['material-map', new Set(['GSI_MD', 'IODINE_MAP', 'IODINE_DENSITY', 'IODINE_DENSITY_MAP', 'MATERIAL_MAP', 'MATERIAL_DENSITY', 'MATERIAL_DENSITY_MAP', 'GSI_MATERIAL_DENSITY'])],
    ['projection', new Set(['MIP', 'MINIP', 'PROJECTION', 'MAXIMUM_INTENSITY_PROJECTION', 'MINIMUM_INTENSITY_PROJECTION'])],
    ['reformatted', new Set(['MPR', 'REFORMATTED', 'MULTIPLANAR_REFORMAT', 'MULTIPLANAR_REFORMATTED', 'MULTIPLANAR_RECONSTRUCTION'])],
    ['axial', new Set(['AXIAL'])]
]);

function reconstructionFromImageType(imageType) {
    const tokens = imageType.map(value => value.replace(/[\s-]+/gu, '_'));
    // Image Type can mark a specialized reconstruction ORIGINAL and AXIAL.
    // Its explicit processing token takes priority over those broad labels.
    if (tokens.includes('GSI') && tokens.includes('VUE')) return 'virtual-unenhanced';
    if (tokens.includes('GSI') && tokens.includes('MD')) return 'material-map';
    return RECONSTRUCTION_TOKENS.find(([, known]) => tokens.some(token => known.has(token)))?.[0] ?? 'unknown';
}

function positive(value) {
    if (Array.isArray(value)) value = value.length === 1 ? value[0] : null;
    if (typeof value === 'string') value = value.length <= 32 && NUMERIC.test(value.trim()) ? Number(value.trim()) : null;
    return typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 1000 ? value : null;
}

function attributeValue(attribute, vr, littleEndian) {
    if (!attribute || (attribute.vr?.ID ?? attribute.tag?.VR?.ID) !== vr) return null;
    // The DICOM JSON adapter retains a Value override, including FD numbers.
    // Native FD must be read as binary in dataset byte order, never as text.
    const override = Object.getOwnPropertyDescriptor(attribute, '_value')?.value;
    if (override != null) {
        const raw = Array.isArray(override) ? override.length === 1 ? override[0] : null : override;
        if (vr === 'FD') return typeof raw === 'number' ? positive(raw) : null;
        return positive(raw);
    }
    const bytes = attribute.data;
    if (!(bytes instanceof Uint8Array)) return null;
    if (vr === 'FD') return bytes.byteLength === 8 ? positive(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getFloat64(0, littleEndian ?? attribute.transferSyntax?.IsLittleEndian !== false)) : null;
    if (bytes.byteLength > 32) return null;
    try { return positive(new TextDecoder('utf-8', { fatal: true }).decode(bytes).trim()); } catch { return null; }
}

/** Read only three bounded optional technical attributes. No KVP fallback:
 * tube voltage is not reconstructed monoenergetic energy. A present malformed
 * attribute stays null, so a label cannot silently replace invalid evidence. */
export function workflowTechnicalMetadata(find, { littleEndian } = {}) {
    const result = {};
    for (const [id, field, vr] of [['0018937C', 'monoenergeticEnergyEquivalent', 'FD'], ['00180050', 'sliceThickness', 'DS']]) {
        const attribute = find(id);
        if (attribute) result[field] = attributeValue(attribute, vr, littleEndian);
    }
    const attribute = find('00181210');
    if (attribute) {
        const override = Object.getOwnPropertyDescriptor(attribute, '_value')?.value;
        let value = Array.isArray(override) && override.length <= 16 && override.every(item => typeof item === 'string' && item.length <= 512) ? override.join('\\') : override;
        if (value == null && attribute.data instanceof Uint8Array && attribute.data.byteLength <= 2048) {
            try { value = new TextDecoder('utf-8', { fatal: true }).decode(attribute.data).replace(/\0+$/gu, '').trim(); } catch { value = null; }
        }
        result.convolutionKernel = (attribute.vr?.ID ?? attribute.tag?.VR?.ID) === 'SH' && typeof value === 'string' && value.length <= 512 ? value : null;
    }
    return result;
}

function semanticCt(metadata, imageType, reconstruction) {
    const description = clean(metadata.seriesDescription), typeTokens = imageType.map(value => value.replace(/[\s-]+/gu, '_'));
    const labelEnergies = [...description.matchAll(/(?:^|[^A-Z0-9.])(\d{1,4}(?:\.\d{1,3})?)\s*KEV(?=$|[^A-Z0-9])/gu)].map(match => positive(match[1]));
    const distinct = [...new Set(labelEnergies)];
    const labelEnergy = distinct.length === 1 ? distinct[0] : null;
    const explicitEnergy = metadata.monoenergeticEnergyEquivalent;
    const energyRecorded = explicitEnergy !== undefined && explicitEnergy !== '';
    const attributeEnergy = energyRecorded ? positive(explicitEnergy) : null;
    const labelConflict = distinct.length > 1 || distinct.includes(null) || attributeEnergy != null && labelEnergy != null && attributeEnergy !== labelEnergy;
    let energyKeV = labelConflict || energyRecorded && attributeEnergy == null ? null : attributeEnergy ?? labelEnergy;
    let energyEvidence = energyKeV == null ? 'unknown' : attributeEnergy != null ? 'attribute' : 'label';
    const typeFamilies = [];
    // GSI MONO is also present on vendor-labelled BLENDED exports. That broad
    // processing hint cannot establish a monoenergetic family or energy.
    if (typeTokens.some(token => ['MONOENERGETIC', 'MONOENERGY'].includes(token))) typeFamilies.push('monoenergetic');
    if (typeTokens.some(token => ['BLENDED', 'GSI_BLENDED'].includes(token))) typeFamilies.push('blended');
    if (typeTokens.includes('CONVENTIONAL')) typeFamilies.push('conventional');
    const labelFamilies = [];
    if (/(?:^|[^A-Z0-9])BLENDED(?=$|[^A-Z0-9])/u.test(description)) labelFamilies.push('blended');
    if (/(?:^|[^A-Z0-9])CONVENTIONAL(?=$|[^A-Z0-9])/u.test(description)) labelFamilies.push('conventional');
    if (labelEnergies.length) labelFamilies.push('monoenergetic');
    const families = new Set([...typeFamilies, ...labelFamilies, ...(attributeEnergy != null ? ['monoenergetic'] : [])]);
    let ctFamily = families.size === 1 ? [...families][0] : 'unknown';
    let familyEvidence = ctFamily === 'unknown' ? 'unknown' : attributeEnergy != null ? 'attribute' : typeFamilies.length ? 'image-type' : 'label';
    // Specialized products cannot become ordinary CT families through a label.
    if (SPECIAL_RECONSTRUCTIONS.has(reconstruction) || families.size > 1 || labelConflict || metadata.modality && clean(metadata.modality) !== 'CT') {
        ctFamily = 'unknown'; familyEvidence = 'unknown'; energyKeV = null; energyEvidence = 'unknown';
    }
    const rawKernel = metadata.convolutionKernel;
    const kernelRecorded = rawKernel !== undefined && rawKernel !== '';
    const components = clean(rawKernel).split('\\');
    const attributes = components.map(item => KERNELS.get(item.trim()) ?? 'unknown');
    const attributeKernel = attributes.length && attributes.every(item => item === attributes[0]) ? attributes[0] : 'unknown';
    const labelKernels = [...KERNELS].filter(([word]) => new RegExp('(?:^|[^A-Z0-9])' + word + '(?=$|[^A-Z0-9])', 'u').test(description)).map(([, kind]) => kind);
    const kinds = new Set(labelKernels);
    let kernel = kernelRecorded ? attributeKernel : kinds.size === 1 ? [...kinds][0] : 'unknown';
    let kernelEvidence = kernel === 'unknown' ? 'unknown' : kernelRecorded ? 'attribute' : 'label';
    if (kinds.size > 1 || kernelRecorded && kinds.size === 1 && kernel !== [...kinds][0]) { kernel = 'unknown'; kernelEvidence = 'unknown'; }
    return { ctFamily, energyKeV, energyEvidence, familyEvidence, sliceThicknessMm: positive(metadata.sliceThickness), kernel, kernelEvidence };
}

export function workflowPlane(raw) {
    const parts = Array.isArray(raw) ? raw : typeof raw === 'string' && raw.length <= 512 ? raw.split('\\') : [];
    if (parts.length !== 6 || parts.some(value => typeof value !== 'number' && (typeof value !== 'string' || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/u.test(value.trim())))) return 'unknown';
    const values = parts.map(Number);
    if (!values.every(Number.isFinite)) return 'unknown';
    const [a, b, c, d, e, f] = values;
    if (Math.abs(Math.hypot(a, b, c) - 1) > 0.02 || Math.abs(Math.hypot(d, e, f) - 1) > 0.02 || Math.abs(a * d + b * e + c * f) > 0.02) return 'unknown';
    const normal = [b * f - c * e, c * d - a * f, a * e - b * d], norm = Math.hypot(...normal);
    const axes = normal.map(value => Math.abs(value) / norm), maximum = Math.max(...axes);
    return maximum >= Math.cos(Math.PI / 12) ? ['sagittal', 'coronal', 'axial'][axes.indexOf(maximum)] : 'oblique';
}

export function normalizeWorkflow(value) {
    const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const evidence = source.contrastEvidence && typeof source.contrastEvidence === 'object' ? source.contrastEvidence : {};
    const energy = typeof source.energyKeV === 'number' && !SPECIAL_RECONSTRUCTIONS.has(source.reconstruction) ? positive(source.energyKeV) : null;
    return Object.freeze({
        plane: WORKFLOW_PLANES.includes(source.plane) ? source.plane : 'unknown',
        bodyPart: WORKFLOW_BODY_PARTS.includes(source.bodyPart) ? source.bodyPart : 'unknown',
        contrast: ['present', 'absent', 'unknown'].includes(source.contrast) ? source.contrast : 'unknown',
        localizer: typeof source.localizer === 'boolean' ? source.localizer : null,
        derivation: ['original', 'derived', 'unknown'].includes(source.derivation) ? source.derivation : 'unknown',
        reconstruction: WORKFLOW_RECONSTRUCTIONS.includes(source.reconstruction) ? source.reconstruction : 'unknown',
        ctFamily: WORKFLOW_CT_FAMILIES.includes(source.ctFamily) && !SPECIAL_RECONSTRUCTIONS.has(source.reconstruction) ? source.ctFamily : 'unknown',
        energyKeV: energy,
        energyEvidence: energy != null && ['attribute', 'label'].includes(source.energyEvidence) ? source.energyEvidence : 'unknown',
        familyEvidence: WORKFLOW_CT_FAMILIES.includes(source.ctFamily) && source.ctFamily !== 'unknown' && !SPECIAL_RECONSTRUCTIONS.has(source.reconstruction) && EVIDENCE.includes(source.familyEvidence) ? source.familyEvidence : 'unknown',
        sliceThicknessMm: typeof source.sliceThicknessMm === 'number' ? positive(source.sliceThicknessMm) : null,
        kernel: ['standard', 'sharp'].includes(source.kernel) ? source.kernel : 'unknown',
        kernelEvidence: ['standard', 'sharp'].includes(source.kernel) && ['attribute', 'label'].includes(source.kernelEvidence) ? source.kernelEvidence : 'unknown',
        contrastEvidence: Object.freeze(Object.fromEntries(EVIDENCE_FIELDS.map(field => [field, evidence[field] === true]))),
        uniform: source.uniform === true
    });
}

export function workflowFromMetadata(metadata = {}) {
    const agent = clean(metadata.contrastBolusAgent), route = recorded(metadata.contrastBolusRoute);
    const startTime = timeRecorded(metadata.contrastBolusStartTime), stopTime = timeRecorded(metadata.contrastBolusStopTime);
    const absent = ABSENT_AGENTS.has(agent), unknown = UNKNOWN_AGENTS.has(agent) || agent.includes('\\');
    const imageType = (Array.isArray(metadata.imageType) ? metadata.imageType.slice(0, 16).map(clean) : clean(metadata.imageType).split('\\').slice(0, 16));
    const localizer = imageType.some(value => ['LOCALIZER', 'SCOUT', 'SURVEY', 'TOPOGRAM'].includes(value)) ? true
        : imageType.some(value => ['AXIAL', 'CORONAL', 'SAGITTAL', 'VOLUME'].includes(value)) ? false : null;
    const reconstruction = reconstructionFromImageType(imageType);
    return normalizeWorkflow({ plane: workflowPlane(metadata.imageOrientation),
        bodyPart: BODY_PARTS.get(clean(metadata.bodyPartExamined).replace(/[ _-]/gu, '')) ?? 'unknown',
        contrast: unknown || absent && (route || startTime || stopTime) ? 'unknown' : absent ? 'absent' : 'present',
        localizer, derivation: imageType[0] === 'ORIGINAL' ? 'original' : imageType[0] === 'DERIVED' ? 'derived' : 'unknown', reconstruction,
        ...semanticCt(metadata, imageType, reconstruction), contrastEvidence: { agentRecorded: !absent && !unknown, routeRecorded: route,
            startTimeRecorded: startTime, stopTimeRecorded: stopTime }, uniform: true });
}

/** A series-level statement must hold for every indexed instance. Unknown and
 * conflicting values remain unknown, never a majority vote or first-file guess. */
export function aggregateWorkflow(values) {
    const items = [...values].map(normalizeWorkflow);
    if (!items.length) return normalizeWorkflow(null);
    const agreed = field => items.every(item => item[field] === items[0][field]) ? items[0][field] : ['localizer', 'energyKeV', 'sliceThicknessMm'].includes(field) ? null : 'unknown';
    const baseline = JSON.stringify(items[0]);
    return normalizeWorkflow({ plane: agreed('plane'), bodyPart: agreed('bodyPart'), contrast: agreed('contrast'), localizer: agreed('localizer'), derivation: agreed('derivation'), reconstruction: agreed('reconstruction'),
        ctFamily: agreed('ctFamily'), energyKeV: agreed('energyKeV'), energyEvidence: agreed('energyEvidence'), familyEvidence: agreed('familyEvidence'),
        sliceThicknessMm: agreed('sliceThicknessMm'), kernel: agreed('kernel'), kernelEvidence: agreed('kernelEvidence'),
        contrastEvidence: Object.fromEntries(EVIDENCE_FIELDS.map(field => [field, items.every(item => item.contrastEvidence[field])])),
        uniform: items.every(item => item.uniform && JSON.stringify(item) === baseline) });
}
