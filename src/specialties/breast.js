import { one, sequence, code } from '../derived/common.js';
import { dataSet, text, scalar, uid, fail } from './common.js';

export const MAMMOGRAPHY_SOP_CLASSES = Object.freeze(['1.2.840.10008.5.1.4.1.1.1.2', '1.2.840.10008.5.1.4.1.1.1.2.1']);
const VIEW_CODES = new Map([['SCT:399162004', 'CC'], ['SCT:399368009', 'MLO'], ['SRT:R-10242', 'CC'], ['SRT:R-10226', 'MLO'], ['SNM3:R-10242', 'CC'], ['SNM3:R-10226', 'MLO']]);

/** Metadata classification only; does not infer orientation, flip, prior or diagnosis. */
export function normalizeBreastImage(instance) {
    const set = dataSet(instance);
    if (!MAMMOGRAPHY_SOP_CLASSES.includes(text(set, '00080016')) || text(set, '00080060') !== 'MG' ||
        (scalar(set, '00280008', { required: false }) ?? 1) !== 1) fail('single-frame digital mammography is required');
    const laterality = text(set, '00200062'), seriesLaterality = text(set, '00200060', { required: false });
    if (!['L', 'R', 'B'].includes(laterality) || seriesLaterality != null && seriesLaterality !== laterality) fail('breast laterality is invalid or inconsistent');
    if (sequence(set, '00082230', { required: false, minimum: 0 }).length ||
        sequence(set, '00082228', { required: false, minimum: 0 }).some(item => sequence(item, '00082230', { required: false, minimum: 0 }).length)) fail('coded anatomical laterality modifiers require a dedicated consistency profile');
    const viewSet = one(set, '00540220'), viewCode = code(viewSet), view = VIEW_CODES.get(`${viewCode.scheme}:${viewCode.value}`) ?? null;
    const modifiers = sequence(viewSet, '00540222', { required: false, minimum: 0, maximum: 16 }).map(code);
    const partialView = text(set, '00281350', { required: false });
    if (partialView != null && !['YES', 'NO'].includes(partialView)) fail('Partial View must be YES or NO');
    const partialCodes = sequence(set, '00281352', { required: false, maximum: 2 }).map(code);
    const intent = text(set, '00080068', { required: false });
    if (intent != null && !['FOR PRESENTATION', 'FOR PROCESSING'].includes(intent)) fail('mammography presentation intent is invalid');
    const classIntent = text(set, '00080016') === MAMMOGRAPHY_SOP_CLASSES[0] ? 'FOR PRESENTATION' : 'FOR PROCESSING';
    if (intent != null && intent !== classIntent) fail('mammography presentation intent conflicts with its SOP Class');
    const reason = laterality === 'B' ? 'bilateral-view' : view == null ? 'unsupported-view' : modifiers.length ? 'modified-view' : partialView === 'YES' || partialCodes.length ? 'partial-view' :
        partialView == null ? 'unverified-full-view' : classIntent === 'FOR PROCESSING' ? 'processing-image' : null;
    return { profile: 'breast-view-metadata-v1', sopUid: uid(text(set, '00080018')), studyUid: uid(text(set, '0020000D')), seriesUid: uid(text(set, '0020000E')),
        originalFrameIndex: 0, laterality, view, viewCode, modifiers, partialView, partialCodes, eligible: reason == null, reason,
        presentationIntent: intent ?? classIntent, orientationTransform: null };
}

/** Four explicit slots, with ambiguous duplicate candidates left unselected. */
export function createBreastLayout(images) {
    if (!Array.isArray(images) || !images.length || images.length > 256) fail('a bounded set of breast image descriptors is required');
    const keys = ['R-CC', 'L-CC', 'R-MLO', 'L-MLO'], candidates = new Map(keys.map(key => [key, []]));
    const identities = new Set(), studies = new Set(), unassigned = [];
    for (const image of images) {
        if (image?.profile !== 'breast-view-metadata-v1' || typeof image.eligible !== 'boolean' || !['L', 'R', 'B'].includes(image.laterality) ||
            ![null, 'CC', 'MLO'].includes(image.view) || image.originalFrameIndex !== 0) fail('normalized breast metadata is required');
        uid(image.sopUid); uid(image.studyUid); uid(image.seriesUid);
        if (identities.has(image.sopUid)) fail('duplicate breast SOP Instance'); identities.add(image.sopUid); studies.add(image.studyUid);
        const key = `${image.laterality}-${image.view}`;
        if (image.eligible && !candidates.has(key)) fail('breast descriptor eligibility conflicts with its view');
        if (image.eligible) candidates.get(key).push({ sopUid: image.sopUid, seriesUid: image.seriesUid, originalFrameIndex: 0 });
        else unassigned.push({ sopUid: image.sopUid, reason: image.reason ?? 'ineligible-metadata' });
    }
    if (studies.size !== 1) fail('a breast layout must belong to one explicit Study; priors require a separate layout');
    return { profile: 'breast-four-view-layout-v1', studyUid: images[0].studyUid, rows: 2, columns: 2,
        slots: keys.map((key, index) => { const options = candidates.get(key); return { key, row: Math.floor(index / 2), column: index % 2,
            status: options.length === 0 ? 'missing' : options.length === 1 ? 'ready' : 'ambiguous', image: options.length === 1 ? options[0] : null, candidates: options }; }),
        unassigned, orientationPolicy: 'source-unchanged', protocol: 'explicit-cc-mlo-four-view' };
}
