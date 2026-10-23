import { Tag } from '@xinonix/easi-js';
import { validateDicomUid } from './DicomWebClient.js';
import { expectedIdentity, instanceIdentity, verifyPatient } from './archive-source.js';

const MAX_INSTANCES = 30000;
const PATIENT_FIELDS = ['patientId', 'issuerOfPatientId', 'patientName', 'patientBirthDate'];
const invalid = () => new Error('The archive returned invalid instance navigation metadata.');

function scalar(instance, tag, fallback = null) {
    const attribute = instance?.dataSet?.find(Tag.find(tag));
    if (!attribute) return fallback;
    const value = attribute.value;
    if (Array.isArray(value)) { if (value.length > 1) throw invalid(); return value[0] ?? fallback; }
    return value ?? fallback;
}

function instanceUid(instance, tag) {
    const attribute = instance?.dataSet?.find(Tag.find(tag));
    if (attribute?.tag?.VR?.ID !== 'UI') throw invalid();
    try { return validateDicomUid(scalar(instance, tag)); } catch { throw invalid(); }
}

function integer(instance, tag, { minimum = -Number.MAX_SAFE_INTEGER, fallback = null } = {}) {
    const value = scalar(instance, tag);
    if (value == null || value === '') return fallback;
    if (!['string', 'number'].includes(typeof value) || (typeof value === 'string' && !/^[+-]?\d+$/u.test(value.trim()))) throw invalid();
    const result = Number(value);
    if (!Number.isSafeInteger(result) || result < minimum) throw invalid();
    return result;
}

/** Convert an EASI metadata response into a bounded, patient-scoped instance
 * list. Image profiles and bulk pixels are deliberately not inspected here. */
export function instanceNavigation(instances, { patient, sourceId, studyUid, seriesUid } = {}) {
    if (!Array.isArray(instances) || instances.length > MAX_INSTANCES) throw new RangeError('Choose at most 30,000 instance navigation records.');
    if (typeof sourceId !== 'string' || !sourceId.trim() || sourceId.length > 4096 || /[\u0000-\u001f\u007f]/u.test(sourceId)) {
        throw new TypeError('Choose an identified repository for instance navigation.');
    }
    validateDicomUid(studyUid); validateDicomUid(seriesUid);
    if (patient !== undefined && (!patient || typeof patient !== 'object' || Array.isArray(patient))) throw new TypeError('Choose the selected patient identity.');
    const expected = expectedIdentity(patient === undefined ? undefined : Object.fromEntries(PATIENT_FIELDS.map(field => [field, patient[field] ?? ''])));
    const seen = new Set();
    const descriptors = instances.map(instance => {
        if (expected) verifyPatient(instanceIdentity(instance), expected);
        const actualStudy = instanceUid(instance, '0020000D'), actualSeries = instanceUid(instance, '0020000E');
        if (actualStudy !== studyUid || actualSeries !== seriesUid) throw new Error('The archive metadata does not match the requested Study and Series Instance UIDs.');
        const sopUid = instanceUid(instance, '00080018'), sopClassUid = instanceUid(instance, '00080016');
        if (seen.has(sopUid)) throw new Error('The archive metadata contains a duplicate SOP Instance UID.');
        seen.add(sopUid);
        return { sourceId, studyUid, seriesUid, sopUid, sopClassUid,
            instanceNumber: integer(instance, '00200013'), frameCount: integer(instance, '00280008', { minimum: 1, fallback: 1 }) };
    });
    return descriptors.sort((a, b) => (a.instanceNumber ?? Infinity) - (b.instanceNumber ?? Infinity) || a.sopUid.localeCompare(b.sopUid));
}
