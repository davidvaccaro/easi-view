import { validateDicomUid } from './DicomWebClient.js';

function plain(value, keys) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
        Reflect.ownKeys(value).some(key => typeof key !== 'string' || !keys.includes(key) || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'))) {
        throw new TypeError('Use supported prior-study search options.');
    }
}
function completeDate(value) {
    if (typeof value !== 'string' || !/^\d{8}$/u.test(value)) return false;
    const year = Number(value.slice(0, 4)), month = Number(value.slice(4, 6)), day = Number(value.slice(6));
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    return year >= 1 && month >= 1 && month <= 12 && day >= 1 && day <= [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
}
const canceled = () => new DOMException('The prior-study search was canceled.', 'AbortError');
function check(signal) { if (signal?.aborted) throw canceled(); }
function count(value) {
    if (value == null) return null;
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid prior-study count.');
    return value;
}

/** Explicit, bounded metadata-only search; matching IDs identify candidates, not proven identity. */
export async function findPriorCandidates(client, context, options = {}) {
    plain(context, ['patientId', 'currentStudyUid', 'currentStudyDate', 'modality']);
    plain(options, ['signal', 'limit', 'maxPages']);
    const { patientId, currentStudyUid, currentStudyDate, modality } = context;
    if (typeof client?.searchStudies !== 'function' || typeof patientId !== 'string' || !patientId.trim() || patientId.length > 128 || /[\x00-\x1f\x7f*?\\]/u.test(patientId)) {
        throw new TypeError('Prior-study search requires an exact patient ID without wildcards.');
    }
    try { validateDicomUid(currentStudyUid); } catch { throw new TypeError('Prior-study search requires a valid current study identifier.'); }
    if (!completeDate(currentStudyDate)) throw new TypeError('Prior-study search requires a complete valid current study date.');
    if (modality != null && (typeof modality !== 'string' || !/^[A-Z0-9_]{1,16}$/u.test(modality))) throw new TypeError('Use a valid modality for prior-study search.');
    const { signal, limit = 25, maxPages = 4 } = options;
    if (signal != null && !(signal instanceof AbortSignal) || !Number.isInteger(limit) || limit < 1 || limit > 25 ||
        !Number.isInteger(maxPages) || maxPages < 1 || maxPages > 4) throw new TypeError('Prior-study search uses one to four pages of at most 25 studies.');
    check(signal);
    const items = [], seen = new Set(); let offset = 0, pages = 0, hasMore = false, skippedUndated = false;
    try {
        for (; pages < maxPages; ) {
            check(signal);
            const response = await client.searchStudies({ patientId, studyDate: `-${currentStudyDate}`, ...(modality ? { modality } : {}) }, { signal, offset, limit });
            check(signal); pages++;
            if (!Array.isArray(response?.items) || response.items.length > limit || typeof response.hasMore !== 'boolean') throw new Error('Invalid prior-study page.');
            for (const item of response.items) {
                if (!item || typeof item !== 'object' || item.patientId !== patientId || item.studyUid === currentStudyUid) continue;
                validateDicomUid(item.studyUid);
                if (!completeDate(item.studyDate)) { skippedUndated = true; continue; }
                if (item.studyDate >= currentStudyDate || seen.has(item.studyUid)) continue;
                if (!Array.isArray(item.modalities) || item.modalities.length > 16 || item.modalities.some(value => typeof value !== 'string' || !/^[A-Z0-9_]{1,16}$/u.test(value)) || typeof item.description !== 'string' || item.description.length > 1024) throw new Error('Invalid prior-study metadata.');
                if (modality && !item.modalities.includes(modality)) continue;
                seen.add(item.studyUid);
                items.push({ studyUid: item.studyUid, studyDate: item.studyDate, description: item.description,
                    modalities: [...item.modalities], seriesCount: count(item.seriesCount), instanceCount: count(item.instanceCount) });
            }
            hasMore = response.hasMore;
            if (!hasMore) break;
            if (!Number.isSafeInteger(response.nextOffset) || response.nextOffset <= offset) throw new Error('Invalid prior-study paging.');
            offset = response.nextOffset;
        }
    } catch (error) {
        if (signal?.aborted || error?.name === 'AbortError') throw canceled();
        throw new Error('The prior-study candidate search could not complete with valid bounded metadata.');
    }
    items.sort((a, b) => b.studyDate.localeCompare(a.studyDate) || a.studyUid.localeCompare(b.studyUid));
    const warnings = ['Matches use Patient ID within this archive. Confirm patient identity before comparing studies.'];
    if (skippedUndated) warnings.push('Studies without a complete valid date were excluded.');
    if (hasMore) warnings.push('The bounded candidate search stopped before all archive results were read.');
    return { items, pages, truncated: hasMore, nextOffset: hasMore ? offset : null, warnings };
}
