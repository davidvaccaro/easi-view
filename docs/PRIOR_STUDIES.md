# Explicit prior-study candidate lookup

`findPriorCandidates(client, context, options)` is a metadata-only helper. It
runs only when called explicitly; opening an image never starts a prior search.
It does not retrieve image instances, frame resources, BulkDataURI values, or
thumbnails.

```js
const candidates = await findPriorCandidates(client, {
  patientId: selectedStudy.patientId,
  currentStudyUid: selectedStudy.studyUid,
  currentStudyDate: selectedStudy.studyDate,
  modality: 'CT' // optional
}, { signal, limit: 25, maxPages: 4 });
```

The current Study Date must be a complete, valid DICOM date. The helper requests
an inclusive upper date bound but then excludes the current study, same-day or
later studies, mismatching patient IDs/modalities, incomplete dates, duplicate
UIDs, and invalid metadata. Results are sorted newest first. Unknown dates and
truncated result sets produce explicit warnings. The maximum search is four
pages of 25 studies; no continuation or pixel fetch happens automatically.

Matching a Patient ID within one archive provides **potential comparison
candidates**, not proof of identity. Patient ID reuse, missing issuers, changed
identifiers, and archive linkage require application/user verification before
comparison. The helper always returns this caution and does not infer identity
from patient names. Wildcards and multi-value Patient IDs are rejected.

Results contain study UID/date/description, modalities, and instance/series
counts. Patient names, IDs, accessions, query addresses, authentication values,
and raw provider errors are not copied into the candidate list or logs. No
candidate data is persisted. Use the existing configured DICOMweb client's
per-request authentication and cancellation behavior.

This helper supplies lookup only. Cross-study image loading, registration,
side-by-side prior selection, hanging protocols, and clinical interpretation
remain separate viewer/application capabilities.
