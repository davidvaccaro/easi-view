# Changelog

## Unreleased — storage source settings and connection tests

Add a unified Storage sources manager with named DICOMweb/DIMSE connections,
explicit unsaved/saved connection tests, session-only authentication, optional
nonsecret profiles, default selection, safe editing/removal and managed-source
controls. Native DIMSE setup uses a loopback companion service with configured
PACS host/port/AE titles, C-ECHO and fixed-target C-FIND/C-GET gateways. Tests
report metadata connectivity separately from untested image retrieval/display.
Embedded applications retain control of authentication and source editing.
No npm publication or hosted-site deployment is implied by this source update.

## Unreleased — research access and patient-name search

Use Store 0.2.1's explicit local research policy for cookie-free local DICOMweb
and DIMSE viewing. Keep authenticated mode and protected administration intact.
Search ordinary patient names as prefixes during patient discovery while
preserving explicit DICOM expressions and exact identifiers. Expired sessions
show a safe sign-in action, retaining criteria and checked studies for explicit
retry, including expiry during initial admission.

## Unreleased — local EASI Store interoperability

Add named DICOMweb and DIMSE sources in the standalone local viewer with a fixed,
read-only same-origin bridge. Reuse the existing Store HttpOnly session without
saving credentials or disabling archive authentication. Document patient search,
study selection, lazy instance viewing and the DIMSE gateway series-memory limit.
Preserve protected metadata/bulk/frame response URLs across the bridge.


## 1.0.0-rc.1 — AI-free release candidate, 2026-10-22

Prepare the first source-available base-viewer release with a frozen supported
profile and independently published EASI JS 1.0.1 dependency. Public candidate
publication targets npm `next`; stable 1.0.0 remains gated by the running full
23,893-file corpus campaign and review.

Preserve the complete AI experiment on `feature/ai-assist-preview` at commit
`5142fa1f51e0dd9345fd002c1fbac15d18672f33`, tagged
`checkpoint/pre-v1-ai-split-2026-10-22`. Remove AI controls, public SDK options,
methods and events, voice capture, planner/explanation clients, gateway examples
and AI deployment tools from the release. Preserve full target IDs, completed
Preview contracts and historical evidence in [AI_BACKLOG.md](docs/AI_BACKLOG.md).

Retain core improvements made during the experiment: opening/indexing progress,
Select all and patient isolation, automatic window behavior, cine and pane/source
handling, conservative metadata and measurement correctness. DICOM SEG/SR/GSPS
and explicit supplied overlays remain supported independently of AI execution.
Build and artifact guards require an AI-free module inventory and reject hidden
AI imports, runtime code, public API/configuration or deployment assets.

Document release scope, remaining compatibility/corpus/browser/consumer gates
and reproducible candidate publishing in [RELEASE_PLAN.md](docs/RELEASE_PLAN.md)
and [RELEASING.md](docs/RELEASING.md). Existing advanced profiles retain their
previously declared limits; no new specialty functionality is added.

Fix archive disconnect cleanup before releasing the client binding, so remote
panes/pixels and Attributes are cleared. Update the embedded example to handle
initial source changes as well as frame navigation, replacing its preparing status
on the first displayed image.

Source `c335d229eedd333db5afac0f29534a1e93044e68799590b26e6c6c88a3d510ab`
passed **2,163 tests with zero skipped**, production build/distribution guards and
**99 native-browser checks**. A clean independent SDK consumer additionally passed
9 actual Chrome checks, six Node export checks, TypeScript 5.3.3, direct/CLI asset
copying, exact JPEG-LS values/calibration and disposal. These checks do not claim
clinical validation or a completed new-build corpus pass. Final registry/release
and deployment proof is recorded separately.

## Unreleased — opening progress and study selection

Show a dimmed, cancellable progress overlay during local file/media indexing,
remote queries and final admission. Paint the busy state before indexing work;
errors restore selection for retry. Local **Select all** covers every available
study for the selected patient across pages, with mixed-state/count feedback and
Clear selection. Remote **Select all studies on this page** covers known current
rows only; it does not fetch or assume unseen studies. Checked remote selections
remain across pages.

## Unreleased — compact current-image notices

Replace the full-width image notice banner and duplicate Details paragraphs with
a compact header icon. Group the active frame's geometry, playback-timing and
encoding messages in a bounded scrollable popover available on hover, keyboard
focus and click/tap. Preserve explicit acknowledgement, highlight new issues,
and keep all current messages available after reading. The popover occupies no
layout space and remains available with the inspector closed. Actual errors
retain their visible banner, and warning arrays, source values and calibration
are unchanged.

## Unreleased — import progress and whole-body PET navigation

Dim and make the opening dialog content inert during final image/study admission,
with a centered, branded progress spinner. Paint progress before starting the
Add callback, retain keyboard-accessible cancellation, and clear the overlay on
success, failure, cancellation or disposal. Search and preview keep their existing
progress behavior; the public opening-workflow state is unchanged.

Group compatible, fully validated STATIC and WHOLE BODY PET IMAGE instances into
2D navigation stacks without partitioning on Frame Reference Time alone. Preserve
each frame's original timing, attributes, calibration and identity. All other
geometry/acquisition dimensions still partition navigation, and dynamic/gated,
reprojection, incomplete metadata, spatial linking and reconstruction retain
their existing strict checks. Local and archive sources share the same rule.

## Unreleased — display series with many image stacks

Separate the recent-series cache limit from the number of compatible image
stacks within those series. Retain at most 128 series groups and 1,024 image
stacks, with the existing 10,000-frame and 256 MiB encoded-source limits.
Preserve geometry/acquisition partitions, shared-buffer accounting and lazy
selected-frame decoding. The shared decoded budget remains 64 MiB.

Page the Image stacks list and permit selection beyond stack 128. Failed
structured selections now show a visible error while retaining the previous
image; cancellation remains quiet. Parsing, pixel values and compatibility
notices are unchanged. Canceled or failed legacy local selections also retain
their current/comparison study roles when restoring the shared session snapshot.

## Unreleased — remember dismissed encoding notices per study

Keep each acknowledged encoding compatibility notice quiet across a session
study's series and reloaded image stacks. A new issue still appears; previously
acknowledged messages are not repeated when the warning combination changes.
Retain complete technical details in the inspector and allow Show notice to
restore the current image's messages. Keep geometry/timing acknowledgements
specific to the loaded stack and calibration, and preserve actual error banners.

Scope acknowledgements to validated opaque study records, with weak stack
fallbacks for direct SDK sources, bounded memory, independent viewer instances
and cleanup when patients, the local library or the session are closed. Pixel decoding,
original attributes and public warning arrays are unchanged.

## Unreleased — PET export JPEG padding and color cine compatibility

Accept exactly one required final JPEG/JPEG-LS alignment byte after a complete
odd-length codestream, including a nonstandard byte value with a visible
compatibility notice. Preserve original encoded bytes and keep multi-byte
suffixes, hidden codestreams, malformed markers and inconsistent offset tables
rejected. Retain the existing RLE and JPEG2000 boundary rules.

For the qualified unsigned monochrome JPEG Lossless 16-bit codestream / 12-bit
DICOM declaration mismatch, decode and report the effective 16-bit precision
with a notice. Preserve full sample values, source attributes and numeric
rescale/window transforms; exclude Modality/VOI LUT presentations and keep other
precision mismatches rejected. Reconstruction still rejects a decoded pixel
profile that disagrees with its source descriptor.

Add Multi-frame True Color Secondary Capture for verified interleaved unsigned
8-bit RGB native, RLE, JPEG Lossless and lossless JPEG-LS profiles. Retain frame
identity, navigation and existing timing validation; other layouts remain
explicitly unsupported.

## Unreleased — recognize matching local patient imports

Highlight possible matches across local imports when the MRN, full name and
birth date agree and known issuers do not conflict. Offer a prominent review and
confirmed Combine studies action. Keep incomplete, conflicting and remote-source
identities separate; matching suggestions never combine records automatically.

Preserve admitted study/series/instance identifiers, image positions, pane
assignments, target measurements and original provenance during confirmed local
association. Unselected studies remain excluded and source measurements must be
exported and cleared before associating their records.

## Unreleased — recover malformed optional navigation descriptions

Omit invalidly encoded optional study/series descriptions with a visible notice
instead of blocking DICOMDIR opening or local image indexing. Preserve original
attributes and strict identity, UID, path, charset-support and size checks.
Resolve each directory record's character set within its actual sequence-item
scope rather than inheriting it along patient/study/series pointer links.

## Unreleased — clear opening step numbers

Prefix opening progress with “Step” so “Step 2: Patient” clearly identifies a
workflow stage. Keep each step label together when the progress row wraps.

## Unreleased — compact image-stack labels

Rename Display groups to Image stacks and describe each compatible stack with
short metadata-based labels for orientation, echo, time, diffusion or matrix size.
Show compact image counts while keeping full count wording in tooltips and
accessible names. Use numbered labels when metadata cannot distinguish stacks;
image grouping and selection behavior remain unchanged.

## Unreleased — direct series and instance navigation

Open a series at its first image by clicking its card or using Enter/Space.
Expand paged instance lists to select a specific object, or drag a series/instance
onto an individual pane. Multi-frame instances start at their first encoded
frame. Pane badges follow actual displayed images and clear when panes close or
the layout shrinks. Drag references are scoped to the originating viewer.

Add a slide-out primary menu with Open and Close viewing session, place a compact
Open button in the padded Session library heading, and move session counts and
local-file privacy information into the status bar. Give empty panes an explicit
opening prompt. Closing a patient now releases its local catalog/file references;
reopening selected media does not resurrect closed patients or unchecked studies.
Expose typed instance browsing, targeted opening, pane clearing and session close
APIs. Qualify these changes with generated unit and browser inputs.

## Unreleased — structured opening and unified session navigation

Consolidate source selection into Open Images, Open Study (local DICOMDIR or
configured remote repository), and isolated synthetic Test Images. Stage local
metadata and remote patient/study selections before explicit admission. Preserve
selected-only folder/media boundaries, capability-aware search, page selections,
cancellation and source-qualified identity.

Add a metadata-only session catalog and patient/study/series navigator with
series thumbnails, active-pane assignment, current/comparison roles, restored
patient views/measurements and explicit reviewed association of outside local
records. Keep study references available independently of bounded resident pixels.
Retain legacy host APIs while sharing additive local admissions with the library.

Add independent configured DICOMweb/DIMSE HTTP sources, exact selected-patient
metadata/retrieval checks, bounded query history and a documented fixed-peer EASI
DIMSE C-FIND/C-GET gateway example. Include typed host policy/source/session APIs
and generated unit/runtime/browser qualification. See [OPENING.md](docs/OPENING.md).

## Unreleased — bounded local study browsing

Keep the complete local metadata catalog while treating loaded image series as
a bounded recent-series cache. Protect the selected view/comparison, retain
recent inactive groups when they fit, and release older groups only after the
new display commits. Reopening an evicted series reads its local files again;
measurements and catalog entries remain available. Count shared encoded backing
buffers once. The existing 128-stack, 10,000-frame and 256 MiB limits still apply
to the selected view and resident cache; oversized selections preserve the prior
display with an actionable error.

## Unreleased — recoverable DICOMDIR terminal pointers

Accept an inconsistent last-root pointer with a visible warning after validating
the complete forward directory hierarchy. Keep an absent first root, malformed
offsets, cycles, dangling traversal links and ambiguous detached active roots as
errors. The terminal pointer never supplies or reparents records. Preserve the
original media and all existing identity/reference checks.
Clear an earlier local-index failure banner after a successful retry while
retaining unrelated image/display errors.

## Unreleased — DICOMDIR local media import

Open a selected media root folder containing DICOMDIR and its referenced image
folders. Resolve only user-selected files, including extensionless images,
and add their patients, studies and series to the additive local timeline.
Referenced object metadata remains authoritative; conflicting, missing and
ambiguous references are reported instead of silently entering the library.
Invalid directories do not fall back to scanning unrelated folder contents.
Folders without DICOMDIR retain ordinary additive indexing.

Accept bounded Part 10 Explicit VR Little Endian indexes and active IMAGE
references. Report non-image entries as unsupported by this importer. Expose
count-only media resolution outcomes alongside the separate metadata-indexing
counts, without filenames or identifying metadata in normal library events.

Keep media indexing local and bounded. Studies remain available as a whole,
with pixels loaded and validated per selected series rather than decoded for
the entire media set. Existing SDK `openFiles()` replacement behavior is
unchanged. See [LOCAL_LIBRARY.md](docs/LOCAL_LIBRARY.md#open-a-dicomdir-media-folder).

## Unreleased — local patient catalog and comparison timeline

Add a metadata-first local patient/study/series catalog using bounded EASI JS
selection pipelines and private File references. File, folder and drop imports
are additive, cancellable and atomic. The local library provides patient search,
a paged examination timeline, explicit series choices and labeled same-patient
current/comparison panes. Pixel/profile validation remains on demand; indexed
metadata is not reported as a completed image-viewing session.

Keep issuer-qualified identity separate from import-scoped identifiers, retain
conflicting demographics and UID variants, and require explicit session-only
association for outside records. Preserve per-patient measurements while
isolating active exports and undo/redo history. Bound catalog and active image
workspaces; do not persist or upload local patient data. Generated examples stay
separate and their controls can be hidden by hosts.

Expose additive local catalog/selection APIs while preserving SDK `openFiles()`
replacement behavior. Automatic prior/series matching,
cross-examination registration and persistent/federated catalogs remain outside
this milestone. See [LOCAL_LIBRARY.md](docs/LOCAL_LIBRARY.md). Historical corpus
qualification is unchanged; the complete image campaign was not rerun for this
navigation change.

## Unreleased — collapsible attribute hierarchy

Browse retained DICOM sequences and items with accessible +/− controls in a flat,
paged table. Theme-derived level shades and explicit level labels show nesting
without indentation. Include expand/collapse-all shortcuts; searching reaches
closed branches and clearing search restores expansion. Empty or unretained
branches have no toggle. Instance/source changes and disposal clear tree state.
Metadata retention, bulk-data summaries and local-only inspection are unchanged.

## Unreleased — unrestricted DICOM file selection

Allow any filename in the standalone, embedded, derived-object and specialty
DICOM file pickers, including files without an extension. Local DICOM parsing
and image validation remain unchanged. Update the documented host picker too.

## Unreleased — sampled CT projections and outcome clarity

Open the bounded native Enhanced CT sampled MAX_IP profile with paired empty
Dimension Organization/Index sequences as one source-ordered 2D sequence. Keep
per-frame planes, pixels, calibration and windowing unchanged; show an explicit
limited-viewing notice and disable spatial linking and volume reconstruction.
Other malformed enhanced profiles remain rejected. The exact reported local
input passed all 69 frames through both SDK and standalone file-picker/slider
workflows, including cine, with unchanged source bytes. All 1,644 tests and the
build/distribution checks passed. This follow-up is separately qualified; the
previous full campaign remains immutable.

Human reports now lead with successful viewing sessions and all sessions that
could not complete. Unexpected errors, unsupported profiles and rejections by
current validation remain separate, with unchanged JSON/CSV status values.
A rejection by viewer validation does not independently establish source validity.


## Unreleased — corpus hardening candidate

Retain the completed 23,893-file baseline unchanged: 20,974 passed, 2,907
unsupported, 12 labelled invalid and zero unexpected failures. All 120 batches,
input hashes, coverage and cleanup evidence were independently reconciled.
Reported invalid/unsupported states remain subjects for review; non-image
objects do not become successful image sessions.

Use the independent EASI JS `1.0.1-corpus.0` candidate for CP-246
undefined-length UN sequence parsing and writing, with scoped Implicit VR Little
Endian contents and restored enclosing syntax. Deflated Explicit VR Little
Endian now reports an explicit unsupported capability; the three affected
baseline inputs are not declared corrupt by their earlier EOF errors.

Add bounded classic PET with declared units and acquisition-family guards,
classic RF/native Frame Time Vector handling, a verified circular monochrome
display shutter, and the exact Philips ELSCINT1/PMSCT_RLE1 private CT provider.
Stored samples, source attributes and quantitative units remain independent of
presentation. Correct thumbnail shutter sampling in original raster coordinates
before applying final display P-values, preserving source samples and ROI values.
Add unsigned 8-bit JPEG2000 `.90`/`.91` `YBR_FULL` with MCT0: preserve decoded
Y/Cb/Cr components and apply the owned RGB conversion exactly once.
Add native unsigned16 MONOCHROME2 multiframe word Secondary Capture with only
Pixel Measures, Plane Position and Plane Orientation functional groups. Preserve
source SOP/frame identity and top-level presentation; reject recorded timing and
unresolved dimensions and keep volume/spatial links unavailable.

All 2,380 former UN rejections, 430 PET/RF/private-CT originals, one JPEG2000
and three Secondary Capture originals passed Node load/decode checks: **2,814
inputs / 2,949 frames**, unchanged source hashes and cleared resources.
The private decoder additionally matched all 84 canonical frames byte-for-byte
against a separately compiled GDCM reference. Final-build browser qualification
passed all 150 selected files / 938 frames, with 130 new passes, 20 retained passes,
zero regressions, unchanged originals, zero uploads/external requests and complete
worker/resource cleanup. The same frozen build passed 48 shutter configurations /
1,200 known pixels and real SDK worker/WASM JPEG2000 checks for both UIDs /
18 known RGB pixels. All 1,607 viewer tests and build/distribution checks passed;
the independent core passed 1,466 tests (37 skipped). The completed full
23,893-file rerun recorded 23,788 successful sessions, 97 unsupported profiles,
eight validation rejections and zero unexpected errors: 105 sessions did not
complete. Its frozen evidence is retained separately from later fixes.

Make the SDK asset-copy command work through npm executable symlinks and
directory aliases. Direct, alias and package-bin checks verify every copied asset
and preserve an existing consumer-owned destination when overwrite is rejected.

Add a bounded report comparison tool producing compact HTML/JSON and a per-file
CSV delta. It rejects identity/hash drift, distinguishes partial/sampled coverage,
and never counts an unretested baseline pass as reverified. Pair the local core
and SDK artifacts for consumer installs until the exact core candidate is
published. No registry publication is performed or authorized by this change.

## Unreleased — local corpus qualification and image compatibility

Large local collections also have a resumable campaign runner: sorted,
fingerprinted inventory; deterministic batches with a fresh browser per batch;
private checkpoints and aggregate reports; explicit partial and sampled coverage.
Known parser/presentation boundaries and malformed data stay separate from
unexpected defects, including later-frame navigation errors. Completed batches
are reused only when the input inventory, build, driver and
configuration still match. Part 10 discovery also recognizes DICOM files with
other extensions; no 10,000-file prefix is silently selected.

Add an explicit local collection harness with complete EASI parsing, actual
browser image uploads/draws/commits, all-frame navigation, modality-aware tools,
ROI invariance, cine and awaited resource cleanup. Private HTML/JSON/CSV reports
separate unsupported documents, malformed inputs and unexpected failures. Source
files stay unchanged; ordinary tests/CI remain synthetic.

Add verified unsigned monochrome JPEG Extended Processes 2/4 with preserved 8/12-bit
samples and complete sequential entropy validation. Accept one legacy FF JPEG
encapsulation pad after EOI and retired US Image Storage under existing pixel
checks. Malformed classic-US timing permits labeled manual preview, preserving
source tags and leaving recorded acquisition timing unavailable.
Enhanced functional-group validation accepts correctly formed, item-scoped
private creator declarations without treating them as macros or duplicate
shared/per-frame groups. Actual macro and geometry validation remains strict.

Validation: 1,379 automated tests and build/distribution checks passed. The final
local corpus run parsed all 281 files, passed all 203 pixel-image sessions and
drew/committed all 1,246 logical frames. The 78 non-image objects remain explicit
unsupported image-viewing cases, with zero unexpected failures. Originals were
unchanged; uploads and external requests were zero. Synthetic controls also
verify expected invalid/unsupported results, notice propagation and interruption
cleanup. Private filenames/results stay in ignored artifacts.

## Unreleased — dismissible geometry notices

Add a keyboard-accessible close button that reclaims viewport space. Keep the
warning in Image inspector → Details with a Show notice action. Dismissal is
scoped to the same warning/calibration status within one loaded series and
viewer, so frame navigation keeps it dismissed while different warnings and
newly loaded sources remain visible. Measurement units and validation do not
change.

Validation: 1,279 automated tests, build/distribution checks and 21 synthetic
geometry browser groups, including keyboard/pointer dismissal, viewport and
annotation resizing, Details reopening, frame/cine persistence, source rollback,
mobile layout and embedding isolation.

## Unreleased — clarify geometry notices

Geometry notices now explicitly confirm that the image is displayed and state
when measurements use pixels. Valid Pixel Spacing retains calibrated 2D
measurements even if an optional aspect tag is malformed. Original pixel data,
strict aspect validation and technical warning details remain available.

Validation: 1,279 automated tests, build/distribution checks and 12 synthetic
browser groups, including original MONOCHROME1 samples, pixel/mm measurements,
metadata, source rollback, mobile layout and embedding isolation. A separate
local-only check verified the reported file without saving an image screenshot.

## Unreleased — defined reading layouts

Add bounded versioned JSON layout definitions, deterministic metadata-only
matching, explicit missing/ambiguous results and eligible selector overrides.
CT dual-window reuses one active HU stack/frame; MR compares distinct loaded
sequences; current/prior roles are explicit. Application prepares only selected
frames through the shared runtime and preserves original samples and
measurements. The typed SDK provides definition configuration, preview,
apply/cancel, operational events and a one-pane current-image reset.

This viewer-owned research profile does not infer T1/T2, patient identity or
registration and does not implement DICOM Hanging Protocol Storage interchange.
See [READING_PROTOCOLS.md](docs/READING_PROTOCOLS.md) for supported rules, limits
and lifecycle behavior. Normalized definitions enforce the same byte bound as
accepted input and roundtrip without default-field expansion escaping that limit.
Removed viewports explicitly release their owned graphics contexts.

Validation: **1,279 automated tests**, build/distribution and strict TypeScript
checks; **114 synthetic browser groups**, including 30 reading-layout groups
and 50 reset/apply cycles with retained-context teardown checks. Artifacts stay
local/private 0.1.0-alpha.0 candidates.

## Unreleased — focused image inspector

The image inspector now groups controls into Details, Measurements, Attributes,
Performance and Objects. Tabs provide scoped keyboard navigation, separate
scroll positions, measurement/object counts and direct access when selecting
measurement tools. A searchable, paged DICOM attribute list preserves sequence
context and private tags while summarizing bulk data. It uses bounded retained
metadata from the EASI JS pipeline without extra retrieval or pixel decoding.

Validation: 1,235 automated tests, build/distribution and strict TypeScript checks;
69 synthetic browser groups covering the inspector, annotations, derived objects
and protected-source revocation. Private DICOM JSON VR/bulk provenance survives
the EASI adapter; bulk URLs stay summarized while ordinary private text remains
readable. Desktop/mobile screenshots and receipts use generated data only.

## Unreleased — legacy Series measurement compatibility

Local images with numeric Series identifiers containing leading zeroes now support measurements and annotation JSON roundtrips. Optional source Series references preserve their exact spelling and remain bound to the original SOP/frame; canonical spellings are not treated as aliases. Required SOP and supplied Frame of Reference identifiers, archive requests and DICOM interchange retain their existing validation.

Validation: 1,213 automated tests, build/distribution checks and 18 synthetic annotation browser groups. A separate local-only browser check verified the reported file's ellipse gesture, calibrated area and annotation roundtrip without modifying or uploading it.

## Unreleased — integrated qualification

All approved milestone slices share the final typed/brandable viewer build. Empty overlays allocate no display canvas, and disposal waits for pending allocation cleanup. Final validation: 1,206 automated tests, strict TypeScript and build/distribution checks, 245 synthetic browser groups including six portable engine/rendering configurations, and current-build source/resource receipts. Artifacts remain local/private 0.1.0-alpha.0 candidates.

## Unreleased — explicit specialty research workspace

Add native quantitative PHYSICAL RT Dose and zero-shift classic XA AVG_SUB Canvas previews/probes, declared cine timing, explicit breast CC/MLO layouts and WSI TILED_FULL metadata tile indexing. Keep specialty processing local and separately bounded, preserve original values and coordinate units, and export explicit provenance-bearing JSON reports. Modal close/reopen, disposal and frame changes correctly cancel readers and clear stale probes.

Validation: 1,206 automated tests, build/distribution and strict TypeScript checks; 16 synthetic specialty browser groups plus independent numeric/lifecycle review.

## Unreleased — enterprise viewing and protected lifecycle

Add a typed host identity/worklist/persistence/share controller, fixed-client reference-only viewing contexts and a separately operated read-only gateway example. Metadata and requested frames are verified before an atomic pane transaction; cancellation waits for rollback, and completed ownership transfer survives a later abort. Logout, refresh failure, identity change and revoked grants clear protected images, history, masks, reconstruction and historical thumbnails, including pending rollback snapshots. Explicit local-file images remain available.

Validation: 1,092 automated tests, build/distribution and strict TypeScript checks; 15 enterprise and 8 targeted revocation synthetic browser groups.

## Unreleased — derived-object workspace

Add source-grid AI/binary/fractional SEG masks on a separate transform-linked canvas, coded reported SR measurements and restricted explicit GSPS presentation. Local import and versioned JSON export are available through the inspector and typed SDK. A pane-specific display wrapper preserves original samples, modality transforms and quantitative measurements. Shared mask/render budgets include pending replacements and rollback; source mismatch, stale epochs, cancellation and reset cannot expose stale masks or graphics.

Validation: 995 automated tests and build/distribution checks; 21 synthetic browser groups exercise actual SEG packing/alpha, SR/GSPS pixels, source rollback, multiple panes, observer isolation, privacy and disposal.

## Unreleased — patient-space reconstruction workspace

Add bounded source-preserving axial/coronal/sagittal and oblique MPR, finite slab MIP/minIP/mean, CPU parallel-ray color compositing, and explicit rigid registration for fusion. Derived Float64 modality values remain available through probes; original source samples and caches remain independently owned. The modal workspace supports cancellation, failed replacement rollback, mobile layout and asynchronous disposal completion.

Validation: 885 automated tests and build checks; 17 synthetic browser groups, including independent affine/quantitative/rendered-pixel references and zero retained tracked reconstruction resources after cleanup.

## Unreleased — typed SDK and verified 2D artifacts

Provide a browser ESM package export, complete host API declarations, an
installable local npm archive and a public-asset copy helper that preserves
worker/WASM URLs and both projects' notices. Packaging validates inventory and
provenance and writes checksums; it keeps the private package publication guard.

Validation: 802 automated tests, clean consumer installation and strict
TypeScript compilation, plus 168 Chromium/Firefox/WebKit groups with sustained
seeking and repeated disposal. Document the proven WebKit native-select CSP
warning separately; application styles and strict-policy checks pass.

## Unreleased — study navigation and shared runtime

Add verified series to a comparison pane while preserving loaded studies,
explicit earlier-study candidate search, thumbnails derived from viewed frames,
optional idle nearby-frame prefetch and opt-in native WADO frame retrieval.
All panes and source sessions share one decoder worker, a 64 MiB decoded
budget and a separate 64 MiB archive encoded LRU. Navigation/source/layout changes
cancel background work; failed additions preserve existing images. Recorded cine
still stops on its final frame; an explicit Play action can replay from frame 1.
Host state counters and additive source-change completion reflect the active pane.

Validation: 801 automated tests, static build checks, and 16 study-workflow,
15 workspace and 31 standalone synthetic browser groups.

## Unreleased — annotation and measurement workspace

Add source-frame-scoped distances, angles, rectangle/ellipse/polygon ROIs,
selection and handle/outline editing, bounded undo/redo, and explicit versioned
JSON import/export to the standalone viewer and embedded SDK. The inspector
reports calibrated geometry and padding-aware original/modality statistics;
window/VOI changes do not alter measurement values. Color ROIs retain geometry
and counts without misleading scalar medical intensities. Host annotation
callbacks expose operational counts and cannot interrupt committed changes.
No persistence or upload occurs automatically.

Validation: 761 automated tests, build/distribution checks and 73 synthetic
browser groups on one matched source/build fingerprint.

## Unreleased

Add owned 1/2/4-pane comparison with series assignment, independent cancellation,
shared decoded-cache/visible-frame budgets and guarded patient-plane/window/view
links. Preserve all pane images and visible overlays on failed source replacement;
coalesce rapid synchronization and roll back rejected renderer commits. Expose
scoped SDK controls and operational events without automatic image-identifier or
pixel export. Built-in CT/MR demos have distinct stable reference identifiers.

Add enhanced and legacy-converted CT/MR functional-group resolution, per-frame
geometry/rescale and separate temporal/echo/diffusion stacks. Add validated
Modality/VOI LUTs, SIGMOID windowing and native/RLE direct palette color, keeping
original stored samples and palette indices. Retain variable Frame Time Vector
for Recorded timing without inventing a wrap interval. Share encoded data/tables
across enhanced stacks; count shared LUT buffers once in decoded-cache budgets.
Verify independent numeric/spatial expectations and real WebGL2/Canvas2D output.

Fix precision8 compressed samples in a 16-bit DICOM container: invoke codecs
with their precision-derived allocation, validate that output, then widen
canonical bytes explicitly. Exact signed/unsigned precision2–8 fixtures cover
all six WASM transfer syntax UIDs.

Add bounded encapsulated frame indexing and browser-worker compressed decoding:
JPEG Baseline, JPEG Lossless .57/.70, JPEG-LS .80/.81, JPEG2000 .90/.91 and RLE.
Preserve signed/unsigned scalar samples, normalize supported YBR/RGB exactly
once, validate codestream headers before allocation, and retain only requested
decoded frames in the existing LRU. Support BOT/EOT and unambiguous empty-BOT
framing; reject malformed fragment boundaries and unsupported profiles.
DICOMweb accepts original transfer syntaxes, including valid planar layout
changes during server transcoding. Package the pinned local WASM asset and all
upstream redistribution notices, with reference, worker/browser and cleanup tests.


Add local pipeline timing diagnostics and detached host `getPerformance()` /
`resetPerformance()` APIs. Retain at most 256 sanitized completed measurements,
with success-only median/p95 summaries and tracked pixel/cache/worker ownership.
Instrument archive metadata, streamed parsing, queued decode, cache hits and
accepted draw submission without changing source or frame event payloads.
Add a repeatable controlled browser baseline, optional read-only Orthanc checks,
and cancellation/disposal regressions. Document overlapping phases and the
difference between draw submission and screen paint.

Add bounded classic XA native grayscale cine support. Accept absent or inactive
mask subtraction, preserve original scalar samples and fixed Frame Time, and
reject active subtraction, shutters and unsupported angiographic presentation
requirements. Keep uncalibrated measurements in pixels and photometric display
polarity separate from acquisition intensity relationship metadata. Synthetic
worker/browser fixtures cover a 96-frame cine, first/last samples, native-rate
selection, cache reuse, rejection rollback and embedded host controls. Archive
JPEG-to-native transcoding remains separate from the new client codec support.

Add native unsigned 8-bit RGB viewing with three channels and planar storage 0/1.
The worker preserves interleaved channel values or normalizes planar frames;
the owned WebGL2/Canvas2D renderer displays RGB directly. RGB probes show stored
triplets, while pan/zoom, distance, navigation and cine remain available. Disable
grayscale window and inversion controls for RGB and reject nonidentity rescale,
padding, nonempty ICC/color-space metadata and unsupported color encodings.
Synthetic numeric and browser checks cover channel fidelity and switching
between color and grayscale sources.

Add DICOMweb archive browsing in the standalone viewer and embedded SDK:
paged QIDO study/series results, EASI-parsed series metadata, spatially grouped
frame descriptors and WADO retrieval of only the selected frame's instance.
Cancel superseded requests/decodes and retain bounded encoded-instance and
decoded-frame caches. Validate retrieved identities, frame counts, native
formats and geometry against metadata; preserve the committed image on a failed
replacement. Host-supplied request headers and explicit browser credentials modes
provide an authentication integration point without adding sign-in or credential
persistence. Document the archive workflow and its remaining performance,
compressed-profile and compatibility gates in docs/DICOMWEB.md and docs/STATUS.md.

Add a brandable browser ES-module SDK around the same viewer engine: scoped
Shadow DOM styles and keyboard handling, configurable name/logo/color/chrome,
host source/frame/window/tool/cine controls, operational events and explicit
disposal/remount. Embeds start empty by default and support a matching host CSP
nonce or a build-recorded stylesheet hash. Include a local host application
example and integration guide. This completes the P1 integration foundation;
Embedding shares the viewer’s current imaging profile; later reconstruction
gates remain open.

Allow native 2D images to open when optional pixel spacing, aspect or patient-plane
geometry is incomplete or malformed. Show the ignored attributes in a geometry
notice, retain valid display aspect, and use pixel distances when spacing is
unavailable. Reject blank numeric components instead of inventing zeros. Added
synthetic regressions for malformed legacy spacing/aspect metadata and geometry
recovery, calibrated tool behavior and warning lifecycle.

## 0.1.0-alpha.0 — 2026-10-13

Initial independent EASI View implementation: EASI JS ingestion, raw native
monochrome frame contract, owned WebGL2 renderer and CPU reference, lazy worker
decoding, bounded decoded cache, local and DICOMweb response loading, synthetic
study demos and a browser workspace. Includes the matching community license,
competitive feature inventory, phased roadmap and correctness tests.

This starts the foundation and 2D alpha phases. Advanced reconstruction,
compressed-profile coverage, enterprise workflows and specialty modules remain
future work. See docs/STATUS.md for the supported profile and validation scope.
