import { text, scalar, numbers, one, sequence, code, reference, resolveReference, validateStructure, rejectTags, uid, checkSignal, fail, MAX_DERIVED_RECORDS } from './common.js';
import { polyline } from './graphics.js';

export const SUPPORTED_SR_CLASSES = Object.freeze(['1.2.840.10008.5.1.4.1.1.88.22', '1.2.840.10008.5.1.4.1.1.88.33']);
const UNITS = new Set(['mm', 'cm', 'mm2', 'cm2', 'deg', '1', '%']);

/** Untemplated by-value CONTAINER -> NUM -> SCOORD POLYLINE -> IMAGE only. */
export async function importSr(instance, { resolveSource, signal } = {}) {
    checkSignal(signal); const set = instance?.dataSet; validateStructure(set);
    if (!SUPPORTED_SR_CLASSES.includes(text(set, '00080016'))) fail('supported Enhanced/Comprehensive SR class required');
    const rejectContent = current => {
        rejectTags(current, ['0040A504', '0040DB73', '0040A168', '0040A161', '0040A162', '0040A163']);
        for (const child of sequence(current, '0040A730', { required: false, minimum: 0, maximum: MAX_DERIVED_RECORDS })) rejectContent(child);
    };
    rejectContent(set);
    if (text(set, '0040A040') !== 'CONTAINER' || text(set, '0040A050') !== 'SEPARATE') fail('a separate root container is required');
    const documentConcept = code(one(set, '0040A043')), sopUid = uid(text(set, '00080018')), measurements = [];
    for (const number of sequence(set, '0040A730', { maximum: MAX_DERIVED_RECORDS })) {
        checkSignal(signal);
        if (text(number, '0040A040') !== 'NUM' || text(number, '0040A010') !== 'CONTAINS') fail('only direct numeric measurements are supported');
        const concept = code(one(number, '0040A043')), measured = one(number, '0040A300'), value = scalar(measured, '0040A30A');
        rejectTags(measured, ['0040A161', '0040A162', '0040A163', '0040A301']);
        const unit = code(one(measured, '004008EA'));
        if (unit.scheme !== 'UCUM' || !UNITS.has(unit.value)) fail('numeric measurement unit is outside the supported coded-unit profile');
        const coordinate = one(number, '0040A730');
        if (text(coordinate, '0040A040') !== 'SCOORD' || text(coordinate, '0040A010') !== 'INFERRED FROM' ||
            text(coordinate, '00700023') !== 'POLYLINE' || ![null, 'FRAME'].includes(text(coordinate, '00480301', { required: false }))) fail('only frame-relative inferred SCOORD polylines are supported');
        const imageContent = one(coordinate, '0040A730');
        if (text(imageContent, '0040A040') !== 'IMAGE' || text(imageContent, '0040A010') !== 'SELECTED FROM' ||
            sequence(imageContent, '0040A730', { required: false, minimum: 0 }).length) fail('one selected-from image reference is required');
        const referenced = one(imageContent, '00081199'); rejectTags(referenced, ['0062000B']);
        const ref = reference(referenced), resolved = await resolveReference(ref, resolveSource, signal);
        const graphic = polyline(numbers(coordinate, '00700022', { maximum: 258 }), resolved.image);
        measurements.push({ id: `sr-${measurements.length + 1}`, concept, value, unit, image: resolved.image, graphic });
    }
    checkSignal(signal); return { profile: 'by-value-num-scoord-sr-v1', sopUid, documentConcept, measurements };
}
