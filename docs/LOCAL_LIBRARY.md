# Local patient library

The **Session library** organizes admitted local files as patients, dated studies,
series and navigable images. Choose **Open… → Open Images** for selected files or
folder contents, or **Open Study → Local storage** for DICOMDIR media. Review the
selection before adding it; source selection and session navigation are separate.
Files may have any extension or none, and remain on this device. The complete
current UI workflow is described in [OPENING.md](OPENING.md).

## Find and compare examinations

1. Choose **Open… → Open Images → Files/Folder**, or drop files/a folder into its preview.
   Indexing reports progress and per-batch successes/failures; Cancel leaves the
   previously committed collection unchanged.
2. Find a patient by name, patient ID, issuer or birth date. An initial import
   containing one patient attempts to open its newest indexed study when starting
   empty or from an unchanged demo; existing real images stay in place. A collection
   with several patients stays available for explicit patient selection.
3. Choose an examination in the patient timeline. Expand its series and select
   the required series before opening or comparing it. Unknown dates remain
   labeled unknown. The timeline is paged and ordered newest first.
4. Open the current examination, then choose another study and **Compare**. Each
   pane identifies its examination date and current/comparison role. An earlier,
   later or same-day examination can be the comparison.

The basic comparison opens two explicitly selected studies belonging to the
same associated patient. It preserves a displayed current series when available;
hosts can supply exact series and stack choices. Spatial, window and camera links
start off. A comparison does not establish registration or infer that the
examinations have matching geometry. Existing guarded synchronization controls
remain available for eligible loaded images.

Choosing another patient prepares a separate workspace. Measurements from the
current patient remain available when that patient is revisited. Failed or
canceled image preparation restores the previous images. **Clear local library**
releases the catalog and its local session state.

## Open a DICOMDIR media folder

Choose **Open… → Open Study → Local storage**, then select the media's root folder: the folder containing
**DICOMDIR** and its referenced image folders. A copied CD/DVD, USB drive or
locally exported file set works through the same browser folder picker. Files
referenced by DICOMDIR can have no extension. Do not select only DICOMDIR; the
browser must also receive the referenced files through the selected folder.

The importer detects the directory index and resolves its references only
against files you selected. It indexes the referenced images and makes their
patients, studies and series available in the existing timeline. Unreferenced
files in that media folder are not added. When several studies are present,
choose the study you need; opening it prepares its selected series. The rest of
the study remains available without eagerly reading and decoding every image
on the media.

Import feedback reports references that are missing, ambiguous, unsupported or
inconsistent with their image metadata. An unreadable or invalid directory does
not silently fall back to scanning all of the folder's files. Select the correct
media root, or select the actual image files without DICOMDIR to use ordinary
additive indexing. For a folder without DICOMDIR, explicitly use Open Images to scan its contents.
File/folder drops enter Open Images and do not automatically follow DICOMDIR.
The legacy SDK `importLocalFiles()` retains its automatic media-detection behavior.

The supported index is a Part 10 Media Storage Directory encoded as Explicit VR
Little Endian. Directory links determine the hierarchy, rather than record order
in the file. Active **IMAGE** references are eligible for image import; other
referenced object types, such as SR documents or presentation states, are counted
as unsupported by this media importer. This does not change their separate
viewer feature profiles.

Directory records do not override patient identifiers, available demographics,
Study/Series/SOP UIDs, SOP Class or transfer syntax in the referenced objects.
Conflicting images are excluded and reported as indexing failures, with the
existing patient-identity safeguards still applying to accepted files.
A readable directory entry does not establish that the image profile can be
displayed; pixel validation still happens when a series is opened.

Relative paths are resolved beneath each selected DICOMDIR's folder. Unsafe
absolute paths, traversal and ambiguous matches are rejected. A unique
case-insensitive filename match is allowed with a notice; the importer does not
guess a different folder or add a filename extension.

Some media exports contain an inconsistent **last-root pointer** while their
forward directory links are complete. The importer follows the verified forward
hierarchy and shows a warning for this recoverable inconsistency. A missing first
root, malformed offsets, broken or cyclic links, or detached active roots that
make recovery ambiguous still stop the import. The original DICOMDIR is unchanged.

Malformed byte encoding in optional study/series descriptions is recoverable:
the navigation label is omitted and a generic notice is shown. This does not
guess an alternative encoding or rewrite an attribute. Patient identity, UIDs,
paths, unsupported character sets and structural/size validation remain strict.
Each directory record uses its own character-set declaration or the actual
containing dataset's declaration, not the charset of a pointer-linked parent.

All reads remain local to the explicitly selected files. Folder selection does
not grant unrestricted filesystem access, upload media contents, install a
service or retain permission across page reloads. Keep removable media connected
while viewing; the catalog holds file references rather than copying the media.

## Metadata first, pixels on demand

The catalog uses an EASI JS scalar selection pipeline to index navigation fields:
patient identity, study/series/SOP identifiers, examination date and description,
modality, series number and declared frame count. It does not derive identity
from the Attributes inspector's display snapshot.

Selection stops before image values in the usual ordered DICOM dataset. The
index retains normalized navigation metadata and private File references, without
materializing retained pixel arrays or invoking a decoder. Choosing a series
passes only its selected files to the existing validated image loader; only
requested frames are decoded. Large collections are therefore not loaded as one
256 MiB image-source operation.

**Metadata indexed** means navigation metadata was obtained. It does not prove
that an entire object is valid, supported or renderable. Documents and other
non-image objects can be indexed while remaining unavailable for direct image
display. Malformed or unsupported metadata can produce a per-file indexing
failure; this does not independently establish that the source file is corrupt.
Frame counts in the catalog are metadata counts, not completed rendering checks.

## Patient identity and duplicate safeguards

The DICOM [Issuer of Patient ID](https://dicom.nema.org/medical/dicom/current/output/chtml/part03/sect_10.15.html)
identifies the authority that assigned the identifier. The local import rules
keep that identity scope separate from a possible-match suggestion.

- An issuer-qualified patient ID can group additive imports when available names
  and birth dates do not conflict. Matching names alone never merge patients.
- Patient IDs without an issuer are scoped to their import batch. Missing patient
  IDs are scoped to a valid study within that batch, or isolated per file when
  the Study UID is unavailable. Another import can therefore
  intentionally appear as a separate patient record.
- Conflicting or ambiguous demographics remain separate with a notice. Reused
  Study/Series UIDs cannot merge different patient records. Conflicting study
  dates or modalities remain separately selectable.
- Reimporting the exact same File object is skipped. Different File objects with
  the same SOP UID are unverified copies: they remain separately selectable
  series variants, with a UID-conflict notice. Filename, size and UID equality
  are not treated as proof of identical contents.
- Missing or invalid source UIDs receive opaque local grouping references and
  warnings. Source metadata is not repaired; image opening still applies the
  existing supported-profile checks.

The active patient workspace and patient finder highlight **Possible same
patient** records when a nonempty exact MRN, normalized full name and valid birth
date agree, known issuers do not conflict, and both records belong to the same
local source. Suggestions use metadata already in the session; they do not read
files or contact a repository. MRN-only, name-only, incomplete and conflicting
records do not receive this suggestion. The MRN remains text, including leading
zeroes and letter case.

Choose **Review and combine** to inspect the identities and explicitly confirm
that their studies belong together. Other local records retain the manual review
path. This association exists only
in this viewer session; original identities and study boundaries remain visible
in the catalog, and DICOM metadata is unchanged. Only already admitted studies
are brought together. Study, series and instance references and the displayed
target patient's image positions, pane assignments and measurements are preserved.
Source-patient measurements
must be exported and cleared before associating those records. Association is a
user assertion, not a master-patient-index or clinical identity-verification
service.

## Memory and lifetime

| Resource | Limit |
| --- | --- |
| Local catalog | 30,000 successfully indexed files; at most 30,000 candidate files per selection |
| DICOMDIR selection | At most 32 indexes, 16 MiB per index and 32 MiB combined; the 30,000 selected-file limit includes the indexes |
| DICOMDIR records | At most 30,000 records per index, including patient/study/series records |
| Metadata scan | 2 MiB per file |
| Navigation value | 512 characters, with a 2 KiB encoded attribute bound |
| Catalog metadata accounting | 64 MiB of normalized metadata |
| Active local patient workspace | 128 series groups, 1,024 image stacks, 10,000 frames and 256 MiB retained encoded source data |
| Cached patient measurement documents | 8 MiB across local patient contexts |

The active annotation store and shared decoded/GPU/source limits still apply;
see [ANNOTATIONS.md](ANNOTATIONS.md), [WORKSPACE.md](WORKSPACE.md) and
[STATUS.md](STATUS.md). These caps do not describe total browser-process memory.
Replacement preparation can temporarily retain the previous successful source.

Browsing studies uses a bounded recent-series cache. The selected current and
comparison series groups are protected; recent inactive groups are kept only
while all limits permit. Older inactive groups are released after the new view
commits successfully. A failed or canceled selection leaves the previous views
available. A failed selection also shows its reason in the global error banner;
cancellation does not produce an error. Reopening a released series reads its
original local files again. Series groups remain atomic for source ownership;
their geometry/acquisition partitions are preserved and their shared encoded
allocations are counted once. Only requested frames enter the decoded cache.

These image limits apply to loaded sources, not to the total number of indexed
studies or frames. Catalog records and patient measurement documents are not
removed by image-cache eviction. A selected series or comparison that exceeds
the limits on its own still requires a smaller selection.

Patient changes isolate measurement documents and clear undo/redo history so an
inactive patient's annotations cannot enter the active patient's export or undo
history. Changing series within the same patient retains that patient's
measurements. The local cache does not retain or restore external/remote
annotation documents. Other derived-object state is cleared when patient context
changes; it is not a per-patient derived-object archive.

The catalog, file references, associations and cached measurements live only in
memory. Refresh, Clear local library or viewer disposal releases them. There is
no filesystem scan outside the explicitly selected files, persistent directory
permission, IndexedDB catalog, automatic upload or server-side local repository.
Removing media can make later file reads fail; selecting a folder is not a copy
of the original collection.

## Host integration

`importLocalFiles()` is the additive catalog workflow, including automatic
DICOMDIR detection when a complete media-folder selection is supplied. The
existing SDK `openFiles()` keeps its replacement-source behavior for integrations and corpus
qualification. An SDK host using `openFiles()` does not implicitly populate the
local patient catalog.

```js
import { createViewer } from './assets/easi-view.js';

const viewer = createViewer(document.getElementById('viewer'), {
  initialDemo: null,
  ui: { demos: false }
});
await viewer.ready;

// Call from your file picker. Each successful batch adds to the catalog.
async function addLocalFiles(files, signal) {
  await viewer.importLocalFiles(files, { signal });
  return viewer.getLocalCatalog(); // Explicit metadata access for your worklist UI.
}

// Values come from the patient's studies/series selected in your host UI.
async function compareSelectedStudies(patientId, current, comparison) {
  await viewer.selectLocalPatient(patientId);
  await viewer.compareLocalStudies(current.studyId, comparison.studyId, {
    currentSeriesId: current.seriesId,
    comparisonSeriesId: comparison.seriesId
  });
}

viewer.on('librarychange', counts => {
  // Counts and opaque selection references; no patient demographics.
  console.log(`${counts.instances} local instances indexed`);
});
```

The explicit `getLocalCatalog()` snapshot contains identifying metadata. Hosts
should render and handle it as patient data. Ordinary library events/state expose
counts, operational flags and opaque selection references instead.

The import result and `getLocalLibraryState().media` also expose a count-only
`LocalMediaReport` for the last successfully resolved DICOMDIR selection. An
ordinary file import resets `media` to `null`. A rejected directory import keeps
the preceding successful catalog, images and report while displaying its error.

| Media report field | Meaning |
| --- | --- |
| `mode`, `directories` | `"dicomdir"` and the number of indexes read |
| `referenced` | Active file references encountered, including non-image references |
| `resolved` | Eligible, uniquely located image files before image-metadata validation |
| `missing`, `ambiguous`, `invalid` | Absent targets, multiple path matches, and unsafe or conflicting references skipped by resolution |
| `inactive`, `unsupported` | Retired inactive records and non-image references skipped |
| `unreferenced` | Selected non-sidecar files not assigned an accepted image reference |
| `warnings` | Fixed explanatory messages without filenames or patient metadata |

`resolved` is not a successful-image or catalog count. Check the import result's
`added`, `duplicates` and `failed` counts for metadata-indexing outcomes; a located
file can still fail its identity or encoding consistency check. The directory
report and normal library events contain no source filenames or identifying
metadata.

| Method | Behavior |
| --- | --- |
| `importLocalFiles(files, { signal }?)` | Add a bounded atomic batch, detecting DICOMDIR when present; returns added/duplicate/failure counts and library state |
| `getLocalCatalog()` | Detached patient/study/series/instance navigation snapshot |
| `getLocalLibraryState()` | Counts, active opaque patient/study references and operational flags |
| `selectLocalPatient(patientId)` | Select an opaque catalog patient reference |
| `openLocalStudy(studyId, { seriesId, stackIndex }?)` | Open the selected study/series, with an explicit stack when needed |
| `openLocalSeries(seriesId, { stackIndex }?)` | Open a selected catalog series variant |
| `compareLocalStudies(currentId, comparisonId, options?)` | Open two same-patient studies; options select each series/stack |
| `associateLocalPatient(fromId, toId, { confirmed: true })` | Explicit session-only association using opaque catalog patient references |
| `cancelLocalImport()` | Cancel pending indexing or local selection preparation |
| `clearLocalLibrary()` | Release local catalog/session state |

`LocalComparisonOptions` additionally supports `currentStackIndex` and
`comparisonStackIndex`. Stack choices refer to the existing image loader's
logical partitions; catalog series metadata does not claim those stacks have
already been decoded or validated. See the distributed TypeScript declarations
and [EMBEDDING.md](EMBEDDING.md) for lifecycle and other viewer APIs.

## Examples and remaining scope

Generated CT, MR, X-ray and ultrasound examples remain in a separate **Examples**
section, outside patient imports. `ui: { demos: false }` hides these controls in
an embed; `initialDemo: null` starts empty. This is UI configuration, not an
authorization boundary: a host can still explicitly call `openDemo()`.

This milestone does not persist local libraries, federate local/remote patient
identity, choose clinically relevant priors, match series automatically or
register different examinations. The existing configured DICOMweb browser
remains separate. DICOMDIR is a navigation index, not a pixel image; common
operating-system index files remain excluded from image candidates.

Generated catalog/session tests cover identity conflicts, additive imports,
duplicate variants, metadata-only reads, cancellation, budgets, explicit roles
and measurement isolation. Historical full-corpus results retain their original
build fingerprints. The 23,893-file image campaign has not been repeated for
this navigation milestone, and metadata indexing is not a substitute for that
image-rendering qualification.
