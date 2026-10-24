# Open images and navigate the viewing session

The compact **Open…** button beside **Session library** chooses sources and selections.
The upper-left menu provides the same Open action. The **Session library**
contains only admitted patients, studies and series. Source selection closes
before ordinary reading/navigation. Keyboard **O** opens the same dialog;
file/folder drops enter its local-image preview rather than importing immediately.
The progress row uses explicit **Step 1**, **Step 2**, etc.; these numbers identify
workflow stages, not patient or study counts. A single patient is selected
automatically before reviewing their studies.

Local file/folder indexing, DICOMDIR indexing, remote patient/study queries and
final **Add** all dim the dialog content and show a spinner with the current
operation label. The busy state is painted before indexing starts; selection
controls are inactive until work finishes. **Cancel operation**, the close button
and Escape remain available. Failure restores the selection for retry;
cancellation closes the dialog and late results cannot enter a later selection.
The same overlay applies when opening a synthetic test workspace.

## Open Images

Choose **Files** or **Folder** and use the browser's native picker. File extensions
are not used to establish DICOM validity; extensionless files are accepted.
The folder option includes subfolders by default and provides an explicit switch.
Only the selected files and folder subtree are inspected. There is no sibling or
parent-directory search.

Review the indexed selection, then choose **Add selected images**. This path scans
the selected image contents even when DICOMDIR is present; it does not follow the
media index. A notice explains how to use Open Study instead. A selection can
contain several patients, which remain separate workspaces. Metadata indexing
is not proof of image-profile support; the selected series is validated when viewed.

## Open Study from local storage

Choose **Local storage**, then the media root folder containing **DICOMDIR** and
its referenced image directories. The browser needs the whole selected file set,
not just the DICOMDIR file. A copied disc or removable drive uses this same picker.

The preview follows the validated directory references only. Choose a patient,
check one or more studies, and choose **Add selected studies**. Unchecked studies
and unreferenced images are not admitted. Missing, inconsistent or unsupported
references produce notices. Without DICOMDIR, choose the explicit Open Images
path to scan the folder. Invalid indexes never silently change into a folder scan.

**Select all N studies for this patient** checks every available study in the
chosen patient’s local preview, including studies on other local pages. The
checkbox shows partial selection and a selected/available count. Unchecking it
or choosing **Clear all selected studies** clears the selected studies; disabled
or unavailable studies are excluded. This never admits another patient’s studies.

The existing bounded parser, safe path resolution, forward-chain recovery and
image-versus-directory identity checks remain in use. See [LOCAL_LIBRARY.md](LOCAL_LIBRARY.md).

An invalid byte encoding in an optional study or series description produces an
omission notice instead of blocking the media. Names, identifiers, UIDs and file
references still undergo the existing validation; no replacement character set
is guessed. Original DICOM attributes and files are unchanged. Directory-record
character sets are scoped to each actual sequence item, independently of the
patient/study/series links.

## Open Study from remote storage

1. Select a named configured repository. Registration itself does not connect.
2. Enter patient criteria and choose Search. Patient ID and name are primary;
   birth date and additional criteria appear when supported. Additional criteria
   include accession number, study date and modality. An empty/wildcard-only broad
   search is not submitted.
3. Choose a matching patient. Results include source-qualified identifiers and
   available demographics. Page controls and warnings remain visible when the
   server limits results.
4. Select studies and choose **Add selected studies**. **Select all studies on
   this page** covers only selectable rows already returned for the current page;
   it never fetches or assumes unseen pages. Individual checked studies persist
   across pages, and the counts distinguish this page from the total selection.
   **Clear all selected studies** clears that patient’s selection across pages.
   Already available session entries are deduplicated by provenance.

DICOMweb patient results are grouped study-query results, not a universal patient
index. After choosing a patient, the viewer performs a fresh exact-patient study
query; initial date/modality/accession filters do not hide older examinations.
Known issuer/name/birth-date conflicts or missing verification data exclude a
returned study. A candidate without an exact patient identifier remains scoped to
its discovered studies instead of triggering an unrestricted patient query.

Adding studies admits metadata references. Series lists and image pixels are
requested as needed. Browsing/searching/canceling previews does not replace the
current images. Canceling image preparation preserves the previous display; a
metadata admission that already completed remains available in the library.
A partial or unsupported image selection remains navigable with its inline error.

DICOMweb sources use QIDO and WADO. DIMSE sources use a separately operated HTTP
gateway; the browser never opens a DIMSE TCP connection. The included
[DIMSE gateway example](../examples/dimse-gateway/README.md) implements fixed-peer
C-FIND/C-GET through EASI JS. Its metadata facade retrieves a bounded series to
obtain rendering metadata, discards those pixel bytes, and retrieves selected
instances again on demand. It supports complete-instance retrieval, not C-MOVE
or a frame endpoint. Synthetic integration tests qualify this contract; a live
PACS and production authentication remain deployment configuration.

## Open Test Images

Choose a generated CT, MR, radiograph or ultrasound example. Examples join an
isolated, visibly marked **Synthetic test workspace**, never an actual patient's
study timeline. Frame controls and playback use the normal viewer runtime.
The host can hide examples and can explicitly disable this opening option.

## Session library and comparison

The library presents one active patient, reverse-chronological collapsible studies,
and series cards with modality, description, series number, counts, source and
availability. Unknown counts/dates remain unknown. Viewed images supply thumbnails;
thumbnail generation does not request another local or remote image.

Click anywhere on a series card's main area to open its first image in the active
pane; its focusable header also supports Enter/Space. Other panes for the same
patient remain in place. Expand **Instances** to select a particular DICOM object.
Lists are paged; expanding a remote list explicitly requests rendering metadata,
not image pixels. For DIMSE, the gateway's metadata facade has the bounded
retrieval behavior described above. A multi-frame instance opens at its first
encoded frame and retains the normal frame selector and cine controls.

Drag a series card or individual instance onto the desired pane to open it there.
A series drop starts at the first image; an instance drop starts at that object's
first encoded frame. The destination highlights during a drag. Other panes remain
unchanged. Drops are limited to the originating viewer and the displayed patient's
workspace. Pane A/B/C/D badges identify actual series and instance assignments;
changing frames, clearing a pane or shrinking the layout updates them immediately.

**View study** starts a reading view for that study.
**Compare** opens explicitly selected current/comparison studies with dates in
both panes. Links start disabled and still require eligible geometry/presentation.
Series with incompatible geometry or acquisition dimensions remain separate
selectable stacks. A 400-instance CT stack offers 400 navigable images; a
120-frame ultrasound object remains one instance with 120 frames and cine controls.
Original SOP instance and encoded-frame references are preserved.

Compatible classic PET **STATIC / IMAGE** and **WHOLE BODY / IMAGE** slices can
share one scrollable 2D stack despite different Frame Reference Times. Each
frame keeps its own source time and calibration. Other acquisition and geometry
differences still create separate stacks; dynamic/gated and incomplete PET
metadata retain their strict partitions. This navigation grouping does not relax
the full acquisition checks for linking or reconstruction.

When a series contains more than one stack, **Image stacks** lists compact labels
such as **Axial**, **Echo 2**, **Time 3** or **512×512**, using available metadata
that distinguishes those stacks. The number after the label is its image count;
the tooltip and accessible name spell out the count. Unknown or indistinguishable
metadata uses numbered stack labels rather than guessed acquisition names.
Lists with more than 24 stacks have Previous/Next pages and a range/total count.
Paging does not open an image; selecting a stack opens that partition's first
frame. The global stack index is preserved across pages, and instance browsing
remains independent. A selection that cannot display shows a visible error while
retaining the previous image and its pane assignment.

Switching patients restores their selected image positions, layout, view settings
and bounded measurement document. One patient's multi-pane workspace never mixes
another patient's images. Source-qualified identities are not merged by name or
by matching MRNs across repositories. Matching local records show a prominent
**Possible same patient** suggestion when the MRN, normalized full name and valid
birth date agree, with no conflicting known issuer. Choose **Review and combine**
to inspect both identities, confirm they belong to the same patient, and combine
their admitted studies. A suggestion never performs the association itself.
Other same-source local records retain a manual review option in the patient
finder. This association is session-only and never edits originals. Study,
series and instance references stay stable, displayed target images and target
measurements are retained, and unchecked studies remain excluded. Source-record
measurements must be exported and cleared before their records can be associated.

The bottom status bar shows admitted patient, study, series and instance counts;
it includes the local-file privacy indicator on the right. Counts describe catalog
metadata, not the number of fully rendered images.

The × on a pane clears its displayed image while keeping its study in the library.
**Close patient workspace** removes that patient's session references, measurements
and private local File records. Reopening the same media then admits only the
newly selected studies, without restoring closed records. Neither action deletes
selected local files or remote studies. The session and File grants are memory-only.
Inactive pixel groups can be evicted and reread while all admitted study metadata
remains available. See [WORKSPACE.md](WORKSPACE.md) for memory/display limits.

The upper-left menu's **Close viewing session** cancels ongoing reads and clears
all admitted patients, panes, measurements, private file references and remote
search history. Configured repositories remain available for the next Open action.
Escape or the menu's × dismisses the menu and returns focus to its toggle.

## Configure an embedded viewer

```js
const viewer = createViewer(container, {
  branding: { name: 'Acme Imaging' },
  sources: [{
    id: 'main-pacs', name: 'Main imaging archive', type: 'dicomweb',
    baseUrl: 'https://pacs.example/dicom-web/',
    headers: async ({ signal }) => sessionHeaders(signal)
  }],
  opening: {
    localImages: true, localStudies: true, remoteStudies: true,
    tests: false, sourceEditing: false
  }
});
await viewer.ready;
viewer.open('study');
```

Source IDs are stable and unique. Each source owns an independent connection and
authentication supplier. Header values, connection URLs and suppliers are omitted
from `viewer.getSources()`. Credentials are not stored in browser persistence.
Use `type: 'dimse'` with the gateway HTTP URL for a DIMSE source. Native frame mode
is an explicit DICOMweb option only.

Default matching fields are patient ID/name, accession, study date and modality.
A host may supply `searchFields` containing `patientBirthDate` or
`issuerOfPatientId` only when its repository supports those optional matches.
The standalone local preview includes named Local Orthanc and Local EASI Store
DICOMweb/DIMSE sources and optional Connection settings; embedded viewers default
to host-managed source configuration.

New session APIs:

- `open('images' | 'study' | 'test')`, `getOpenWorkflowState()`.
- `getSources()`, `registerSource(configuration)`; no replacement of existing IDs.
- `getSessionCatalog()` for explicit identifying metadata; do not send it to telemetry.
- `getSessionState()` for counts and opaque navigation IDs only.
- `selectSessionPatient(id)`, `openSessionStudy(id)`.
- `openSessionSeries(id, {viewport, stackIndex, frameIndex})`; a card opens frame zero.
- `listSessionInstances(seriesId)` explicitly loads instance metadata when needed.
- `openSessionInstance(instanceId, {viewport})` opens the object's first encoded frame.
- `compareSessionStudies(currentId, comparisonId, options)`, `removeSessionPatient(id)`.
- `clearViewport(viewport)` clears one pane; `closeSession()` awaits full session cleanup.

Pane indices are zero-based and must refer to an existing pane. Use the opaque
instance IDs from `getSessionCatalog()` or `listSessionInstances()`, not a SOP UID.
An explicit targeted pane cannot mix patients within a workspace. Instance
descriptors contain metadata and navigation references only, never file or pixel
objects. The TypeScript declarations specify available fields and options.

Opening policies control the built-in workflows; low-level SDK methods remain
available for explicit host-controlled reads. The existing `openFiles()` replacement
and `importLocalFiles()` additive contracts remain supported. Legacy source
replacement detaches the active session identity, and additive local imports also
appear in the unified library. Explicit `opening.tests: false` disables synthetic
opening, including `openDemo()`; `ui.demos: false` hides its built-in selector.

The SDK includes TypeScript declarations. Library events contain operational
counts and opaque references, not the full session catalog. All viewer resources,
queries, file references and generated workers are released on disposal.

## Local EASI Store connection

Requires EASI Store **0.2.0** or later with metadata and query/retrieve enabled.

1. Start Store on `127.0.0.1:8048`, DIMSE on `127.0.0.1:4248`, AE `EASISTORE`.
2. Choose the Store access profile. Store 0.2.1 **Local research** needs no client
   sign-in and is restricted to loopback listeners; an administrator enables it
   under **Administration → Client access** or via `--access-profile local-research`.
   In **Authenticated clients**, sign in to Store in this browser or supply an
   application-managed Bearer credential. Management always requires sign-in.
3. Start this viewer with `npm run dev`; open `http://127.0.0.1:5174/`.
4. Choose **Open… → Open Study → From remote storage**.
5. Choose **Local EASI Store · DICOMweb** or **Local EASI Store · DIMSE**.
6. Enter patient ID/name (a plain name searches by prefix; additional criteria are optional), choose the patient,
   check the examinations to add, then choose **View study** in the Session library.

The DICOMweb route searches QIDO, reads full nested metadata and retrieves original
instances lazily. The DIMSE route uses the existing Node gateway to execute actual
C-FIND and C-GET operations against Store, rather than substituting HTTP archive
reads. A Store-specific EASI transport adapter discovers the actual SOP classes
and proposes separate Storage presentation contexts for each supported original
encoding. It supports native little/big-endian, RLE, JPEG baseline/extended/lossless,
JPEG-LS and JPEG 2000 encodings, including mixed encodings within a series.
Discovery is bounded to 10,000 instances / 8 MiB and at most ten distinct SOP
classes per series within the 128-context association limit. Unsupported syntax
or requested conversion fails explicitly; Store does not silently transcode. Its series metadata operation currently retrieves the bounded series over
C-GET (up to 256 MiB), then an opened instance is retrieved again. For large studies,
DICOMweb metadata and lazy pixel retrieval is more efficient. Neither route changes
archived originals or bypasses Store authentication.

The local bridge accepts only same-origin loopback GET requests, fixed archive
routes and a fixed server destination. The existing HttpOnly Store session cookie
is shared by the same hostname across local ports and forwarded only to Store.
No write routes, arbitrary destination proxy, persistent browser credentials or
wildcard CORS are provided. Use `127.0.0.1` consistently; `localhost` has a separate
cookie namespace. Store restart expires browser sessions in authenticated mode. A 401 shows a
**Sign in to EASI Store** link; it opens Store using the viewer's hostname and the
configured Store port. Your search and checked studies stay in place. Return and
retry the existing search or Add action. Local research access does not depend on
those browser sessions. Explicit wildcard/name-component expressions are sent
unchanged, and patient IDs plus selected-patient lookups remain exact. A 502 means check that Store and its DIMSE
listener are running. This bridge is not included in the public browser SDK.

For isolated development servers on different ports:

```sh
EASI_VIEW_STORE_HTTP_PORT=18048 EASI_VIEW_STORE_DIMSE_PORT=14248 npm run dev
```

These select fixed loopback ports, not remote targets. Browser-supplied upstream
headers, cookies unrelated to Store and redirects are not forwarded. To deploy
elsewhere, configure explicit authenticated sources using the embedding APIs
above and an application-owned DIMSE gateway; do not expose this development
server as a production reverse proxy.

The bridge checks Store's public, non-identifying `/api/v1/access` declaration
before accepting cookie-free research requests. An absent, inconsistent or unknown
policy fails closed. It checks each request without caching access permission, so
switching to authenticated mode blocks subsequent unauthenticated operations.
The development bridge still exposes only archive reads; researchers using other
DICOMweb clients can use Store's standard STOW endpoint directly in research mode.
