# Browser qualification and sustained-session checks

## AI-free v1 candidate qualification — 2026-10-22

The fixed **1.0.0-rc.1** source fingerprint is
`c335d229eedd333db5afac0f29534a1e93044e68799590b26e6c6c88a3d510ab`.
`npm run check` passed **2,163 tests with zero skipped**, production bundling and
AI-free module/runtime/distribution checks. Every receipt retains its exact source
fingerprint; the previous 2,156-test build is not substituted for this result.

| Native-browser gate | Passed checks |
| --- | --- |
| Standalone opening/indexing/selection and AI-free boundary | 9 |
| Patient/study/series session navigation | 21 |
| Annotation gestures, source binding and statistics | 18 |
| Workspace layout, assignment and links | 15 |
| Inspector hierarchy, active source and disconnect cleanup | 25 |
| Embedded integration, initial display and lifecycle | 11 |
| **Total** | **99** |

These generated-input gates exercise real browser UI/File APIs. They include
cancellable indexing and Add overlays, local Select all across 30 studies/pages,
patient isolation, extensionless ultrasound navigation/cine, independent embeds
and source/resource cleanup. The base-release gate leaves native fetch intact and
checks the absence of assistant controls, AI SDK methods/events, configuration
fetches, authentication/model requests and source uploads. Supplying the removed
`ai` option is rejected before mounting. Derived-result import remains available.

Qualification found two real defects before the final pass. Archive disconnect
released its client too early and left remote pane B/pixels/Attributes retained;
cleanup now runs while the binding is available. The embedded host listened only
to frame navigation and could remain at Preparing after initial source display;
it now also handles `sourcechange`. Both fixes are included in the fingerprint
and final browser counts above. Older harness assumptions about an implicit
initial CT demo or unawaited async workspace operations were corrected without
restoring implicit demo loads or weakening product assertions.

A separate clean independent SDK consumer passed **9 actual Chrome checks**, plus
six Node export checks and strict TypeScript **5.3.3** compilation. It installed
the packed viewer with registry-resolved EASI JS 1.0.1, copied all **46 files**
through direct and `npx` CLI paths, mounted the SDK, verified exact **64-sample
JPEG-LS** values and **0.75 mm** calibration, and completed disposal. This is
consumer/runtime qualification, not proof that the viewer was already published
to npm. Final publication/tag/integrity and hosted results belong to release
records and must be verified separately.

The **23,893-file private full-corpus campaign is running** on the actual fixed
build, checking every logical frame in successful supported sessions. No final
outcome is claimed. It blocks stable 1.0.0; candidate `next` publication can expose
this remaining gate explicitly. Originals and private reports stay outside the
public SDK and release assets. These browser/software checks do not establish
clinical validation or broad native-device/production-network performance.

The completed AI experiment is preserved at commit
[`5142fa1f51e0dd9345fd002c1fbac15d18672f33`](https://github.com/davidvaccaro/easi-view/tree/5142fa1f51e0dd9345fd002c1fbac15d18672f33)
on `feature/ai-assist-preview`; [AI_BACKLOG.md](AI_BACKLOG.md) summarizes its
separate historical qualification. Those results do not qualify this base release.
The non-AI historical evidence below is also retained with its original scope;
prior headless rendering does not establish current native-device or clinical validation.

## Compact current-image notices — 2026-10-19

Build `32ef900adce39bb8b20454343529306496be404b484ff382e5f37a3158a5301b`
passed `npm run check`: **2,097 automated tests**, production bundling and
distribution validation. **46 generated browser checks** passed:

- `node tools/browser-notices-check.mjs`: **16 checks** for native hover and
  pointer movement into the popup, keyboard focus/Enter/Space/Escape, click/touch
  pinning and outside dismissal, unread highlighting, retained current messages,
  same-study acknowledgements, independent series/studies/viewers and session reset.
  Frame/pane changes close stale content; inactive-pane work preserves the pinned
  active context; clearing its pane removes old messages. Clean and noticed images
  have identical viewport and Details dimensions. Inspector-hidden access,
  a 390px viewport, long literal text, real wheel scrolling and an offset 550×420
  embed are covered, along with preserved original pixels and visible errors.
- `node tools/browser-geometry-check.mjs`: **21 checks** preserving exact GPU,
  probe, pixel/mm measurements, ROI and annotation alignment, original Attributes,
  rollback, pane/viewer isolation and narrow layout. Notice interactions leave
  canvas dimensions unchanged.
- `node tools/browser-pet-padding-check.mjs`: **9 checks** retaining alignment
  and precision compatibility, full-range worker/GPU/probe samples, original
  attributes, frame/cine behavior, color SC and strict excess-payload rejection.

The updated full corpus browser driver also passed a separate smoke run with
**4 generated files and all 7 frames**: clean, optional geometry, invalid-US
manual timing, and combined JPEG alignment/precision notes. It checks real draws,
pointer tools, ROI invariance, compact-notice access/read/reopening, original
source hashes, cine and awaited cleanup. This does not repeat the earlier private
23,893-file campaign or extend its historical fingerprint.

Generated desktop, narrow and embedded screenshots were inspected. Evidence is
retained under ignored `artifacts/browser-compact-notices/`, with `notices/`,
`geometry/`, `pet/` and `generated-corpus-summary.json` receipts. All runs recorded
zero uploads, external requests, browser exceptions or console errors, and released
their worker/pixel resources. No original medical files or screenshots were used.

## Import progress and whole-body PET navigation — 2026-10-19

Build `ee8370778b56cc9d7f6a0f8320f489dbd89608c3e690cbd27a07d6c66a3f63ca`
passed `npm run check`: **2,085 automated tests**, production bundling and
distribution validation. **48 generated browser checks** passed:

- `node tools/browser-import-overlay-check.mjs`: **8 checks** for final local
  DICOMDIR/image admission, a painted dimmed/inert content area, centered spinner,
  focused enabled cancellation, success and exact GPU pixels, Escape during
  indexing, clean reopen, failure/retry, synthetic cancellation, narrow layout,
  reduced motion and resource cleanup. Native generated-file choosers are
  fulfilled through CDP before testing progress. The foreground test observes
  animation-frame and bounded-timer yield paths before the first import read;
  automated tests separately cover paint ordering, background-tab fallback and
  cancel-before-work behavior. Headless scheduling can use the timer fallback
  even when the document reports visible.
- `node tools/browser-pet-stacks-check.mjs`: **10 checks** for WHOLE BODY 5→1
  and STATIC 3→1 navigation grouping while DYNAMIC 4→2 and GATED 8→4 remain
  partitioned. First/middle/last navigation verifies requested original identity,
  original Attributes/reference times, JPEG Lossless worker samples and GPU
  output. Full-scope slice/window synchronization and reconstruction reject
  differing time metadata. Generated source hashes and disposal remain correct.
- `node tools/browser-large-series-check.mjs`: **9 regression checks** preserving
  unrelated 419/283 AcquisitionNumber partitions, paged selection, exact GPU/probe
  values, unchanged memory budgets, visible oversized-source failure and cancellation.
- `node tools/browser-session-navigation-check.mjs`: **21 regression checks** for
  cards/instances, pane assignments, dragging, opening/menu/close behavior,
  deduplication, multiframe navigation, metadata-first archive requests and cleanup.

Two synthetic import-progress screenshots were inspected at desktop and narrow
sizes. Evidence is retained under ignored `artifacts/browser-import-stacking/`,
with separate `overlay/`, `pet-navigation/`, `large-series/` and
`session-navigation/` receipts. Generated runs recorded no uploads, external
requests, browser exceptions or console errors. No original medical inputs were
used in these automated gates or screenshots.

A separate read-only private-media browser run confirmed **11 series, 12 stacks
and 1,906 frames**. The formerly fragmented classic series each have one stack
with **419 and 284 images**. All 11 native card selections passed; six
first/middle/last frame checks plus six exact-source-instance reopen checks
confirmed source SOP/frame identity and real GPU output. It recorded zero
uploads, external requests, browser exceptions, console errors or retained
worker/encoded/decoded resources after disposal. Its count-only receipt is
`private-pet-navigation.json` in the ignored evidence directory. No original
screenshots, identifying metadata, UIDs or pixel values were exported. This
selected navigation gate does not claim every original frame was redrawn; the
earlier all-1,906-frame decode receipt remains separate.

## Large partitioned series selection — 2026-10-19

Build `12cc7278727c0201d82b496d6a2f51aef349fdf4fd77ce5d4f346c3a1363b535`
passed **2,062 automated tests**, production bundling/distribution checks and
**42 generated browser checks**:

- `node tools/browser-large-series-check.mjs`: **9 checks** for series with
  419/283 independently preserved partitions, paged global stack indices 128/418,
  individual instance selection, exact stored texture/GPU/probe references,
  lazy decoding, narrow layouts and visible rejection of a genuine 1,025-stack
  oversized source without replacing the previous image. Cancellation is quiet.
- `node tools/browser-session-navigation-check.mjs`: **21 checks** for series
  cards, instance selection, panes, dragging, session cleanup and remote metadata
  navigation, including exact original-value draws and requested assignment.
- `node tools/browser-local-working-set-check.mjs`: **12 checks** for bounded
  retention/eviction, selected comparisons, preserved windows/measurements,
  cancel/failure rollback, 12,288-frame rejection and complete resource disposal.

The large-series harness SHA-256 is
`c8c05f7a262448e792b821ef43b32563f7f9a0fc6fdae6633c326eb27a4f8e53`.
Three generated screenshots were inspected. Evidence is retained under ignored
`artifacts/browser-large-series/`, with navigation and cache receipts in
`session-regression/` and `cache-regression/`. Generated checks recorded no
uploads, external requests, browser exceptions or console errors.

A separate private browser run used local File inputs for the reported PET
media: **all 11 series card selections and 12 navigation checks passed**. It
checked pane/instance assignment and renderer output together, including the
last stacks and instances of the 419/283-stack series, selected last frames and
cine. Before the fix, those two cards failed admission and redrew the old image;
a draw-count increase alone would therefore have produced a false success.
The final run recorded no uploads, external requests, browser exceptions or
console errors. Its count-only receipts contain no original images, identifying
metadata, source UIDs or pixel values, and no original screenshots were taken.
This selected browser gate does not claim every original frame was drawn; the
earlier full-frame decoding receipt remains separate.

## Study-scoped encoding notice acknowledgements — 2026-10-19

Build `4325405fa78226ceb7cbf8f051176d69c58f4b3d8ae505afb26a81bf57f643f3`
passed **2,050 automated tests**, production bundling/distribution checks and
**40 generated browser checks**:

- `node tools/browser-notices-check.mjs`: **10 checks** covering individual
  issue acknowledgement across series and recreated stacks; only new issues
  appear, complete messages remain in Details/API, Show notice restores current
  messages, and other studies/viewers/direct SDK source contexts remain isolated.
  Geometry/timing notices, visible failed-open errors and session reset passed.
- `node tools/browser-geometry-check.mjs`: **21 checks** retaining calibrated
  versus pixel measurement notices, keyboard dismissal/restoration, pane/viewer
  isolation, rollback, annotation alignment, original pixels and mobile layout.
- `node tools/browser-pet-padding-check.mjs`: **9 checks** preserving original
  source bytes/attributes, exact worker and GPU samples through 65,535,
  navigation/cine and strict excess-payload rejection.

Four new synthetic notice screenshots were inspected. The notice harness SHA-256
is `fe9f3806daa1d2c3fb03da608e9075f5d2939faf5640a2b88491d2ead15cafa1`;
evidence is retained under ignored `artifacts/browser-notices/`, with the geometry
and PET receipts in its `geometry-regression/` and `pet-regression/` subfolders.
Workers and retained buffers were released, with no uploads, external requests,
browser exceptions or console errors. The notice checks used generated data;
no original medical files were read or captured for this UI change.

## PET export compatibility — 2026-10-19

Build `42dc4cc09d79b687f2231faf07cec70554cea5281cff9a15ad31a54d8958fa39`
passed **2,032 automated tests**, production bundling and distribution checks.
`node tools/browser-pet-padding-check.mjs` passed **9 generated checks**:

- Reject multiple suffix bytes and a second JPEG codestream through the shared
  image pipeline; preserve the original generated source bytes.
- Render a generated Classic PET series with a nonstandard single alignment
  byte through actual workers, exact original samples, GPU pixel references,
  frame selection and playback.
- Preserve samples through 65,535 when an unsigned monochrome JPEG Lossless
  stream declares 16-bit precision but enclosing metadata declares 12/11.
  Verify effective 16/15 through the worker response, GPU shading and probes;
  retain original 12/11 in Attributes and show both compatibility notices.
- Render generated Multi-frame True Color SC `.7.4`, with exact RGB channels,
  frame navigation and playback.
- Release the worker and retained buffers on disposal, with no uploads,
  external requests, browser exceptions or console errors.

Three synthetic screenshots were visually inspected. Evidence is retained in
ignored `artifacts/browser-pet-padding/`; the harness SHA-256 is
`60db10cc89347e4a7b2b39f48994d2882a76de1ca4c66fb882ece44a1b33a273`.

A separate read-only qualification of the privately reported PET media indexed
**1,623 image instances / 11 series** and decoded **all 1,906 frames** through the
local viewer data pipeline. Dimensions and sample counts were checked for every
decoded frame; every series passed and the original DICOMDIR hash was unchanged.
These original inputs were not used by the browser harness, copied into the
repository or captured in screenshots. This all-frame decode receipt does not
claim a full browser-rendering campaign over the original study.

## Matching local records and confirmed study combination — 2026-10-19

Build `316b1a9bc3d745d0498dc6a0e60acc6f0800576592f791e2854e086bc3ff3681`
passed **1,988 automated tests**, production bundling, distribution checks and
strict TypeScript consumption of the preserved identity metadata.
`node tools/browser-patient-matches-check.mjs` passed **11 generated groups**;
`node tools/browser-open-workflow-check.mjs` passed **24 regression groups** on
the same fingerprint.

The new gate covers conservative local-only suggestions, explicit unchecked
consent, cancel, metadata changes, target frame/window/layout/measurement
preservation, stable study/series/instance IDs and original annotation references.
Independent stored samples and framebuffer assertions verify both MR/CT study
navigation and comparisons. Unchecked previews remain excluded through later
selected imports. Measured source records cannot be associated away; the legacy
SDK can combine a currently active unmeasured source without leaving a removed
patient context. Closing and reopening releases old associations. Remote,
foreign-source, incomplete and conflicting identity hints are excluded. Four
desktop/narrow screenshots were visually inspected. Reports record zero uploads,
external requests, browser exceptions and console errors. All browser inputs are
generated. Evidence stays in ignored `artifacts/browser-patient-matches/` and
`artifacts/browser-open-workflow/`.

Separate private, read-only catalog qualification of the reported local folders
retained all 3 studies, 41 series and 5,172 instances under one explicitly
associated patient. Image references and original provenance survived selected
readmission; both original DICOMDIR hashes stayed unchanged. No original images
or identifying metadata were exported. This is catalog association evidence,
not a repeat of the historical full-frame corpus campaign.

## Optional directory description encoding — 2026-10-19

Build `64aed0f3ee6ffca13757f4d2df6769ced9dddfb55862edec00eed07ee5db534a`
passed **1,971 automated tests**, production bundling and distribution checks.
`node tools/browser-directory-encoding-check.mjs` passed **8 generated groups**:
malformed optional study/series labels recover with an explicit omission notice;
directory-record charsets remain independently scoped; preview reads no image
pixels; cancellation preserves prior pixels and measurements; committing one
patient/study/two series renders independently expected first and subsequent
samples; malformed patient identity remains an error without replacing the prior
workspace. Desktop and 430px screenshots were inspected. Reports record zero
uploads, external requests, browser exceptions and console errors. Evidence stays
in ignored `artifacts/browser-directory-encoding/`.

A separate private, read-only check indexed all 2,180 referenced instances of the
reported MRI media and parsed all 21 series. First frames decoded for all 26
image stacks. No original-image screenshots or metadata values were exported;
the original DICOMDIR hash was unchanged. These checks do not claim every frame
was rendered or repeat the historical full corpus campaign.

## Compact image-stack labels — 2026-10-19

Build `7b581bdd7431e7530377ffe92d3796cc3c7b6ed0e83b297eb9010ed08bccc57f`
passed **1,955 automated tests**, production bundling and distribution checks.
`node tools/browser-stack-labels-check.mjs` passed **7 groups** using a generated
single series containing separate axial/coronal stacks. The gate checks concise
distinct labels, full accessible count wording, independent rendered sample
expectations on group selection and subsequent navigation, desktop/430px card
bounds, and disposal. Both screenshots were visually inspected. Reports record
zero uploads, external requests, browser exceptions and console errors. No original
medical files were used; broader historical browser/corpus runs were not repeated.
Evidence remains in ignored `artifacts/browser-stack-labels/`.

## Direct card, instance and pane navigation — 2026-10-19

Build `06848f835901e5acb0b4ff05d7dc8ad8cbfba97859bcc13247fbbff61fff308d`
passed **1,948 automated tests**, production bundling, distribution checks and a
strict TypeScript consumer for the instance, pane and session APIs. The generated
Chrome session-navigation gate passed **21 groups**, and the existing structured
opening gate below passed **24 regression groups** on this same fingerprint.

The new gate verifies card pointer/Enter/Space activation, paged local and remote
instance lists, first-encoded-frame multi-frame US selection, targeted series and
instance drops, independent panes, exact instance/series badges, clearing panes
and shrinking layouts. Wrong-viewer, expired, nonexistent-pane and cross-patient
drops cannot change the display. Rendered samples and independent framebuffer
readback are checked. Remote instance expansion requests metadata without a SOP
pixel request; selecting an instance then retrieves its image on demand.

Menu actions, Escape/focus restoration, session counts, local-file privacy,
library padding and narrow layouts are checked. Closing a missing-issuer media
patient and reopening newly selected File objects produces one replacement
patient, preserves the unrelated patient and does not resurrect unchecked studies.
Closing the entire session releases private catalogs, cached images, workers and
pending queries while preserving source configuration. Five new screenshots were
visually inspected. Reports record zero uploads, external requests, exceptions or
console errors. Every input is generated; original medical files and live PACS
were not accessed. The historical full corpus campaign was not repeated.

```sh
npm run check
node tools/browser-session-navigation-check.mjs
node tools/browser-open-workflow-check.mjs
tsc --noEmit --strict --target ES2022 --module NodeNext --moduleResolution NodeNext --lib ES2022,DOM,DOM.Iterable your-viewer-host.mts
```

Reports and generated screenshots remain in ignored
`artifacts/browser-session-navigation/` and `artifacts/browser-open-workflow/`.

## Structured opening and session navigation

Build `635307963a715e2b969f44e241d052435c5e33d21800c372bcc5ebc5f6cd67b8`
passed `npm run check` with **1,914 tests**, production bundling and distribution
checks. A strict generated-only Chrome gate passed **24 groups**, checking the
same source/build digest before and after the run. It covers the single Open
launcher, staged preview/cancel, selected-only DICOMDIR admission, image-folder
scanning that includes unreferenced selected images, rendered stack samples,
additive studies, current/comparison panes, active-pane series changes, four-pane
restoration, patient measurements, synthetic cine, remote patient/study paging,
fresh patient study queries and deferred image retrieval.

Cancellation during a real delayed synthetic HTTP pixel request leaves the
previous display and patient intact, with no late commit. Legacy file replacement
detaches the prior session patient banner; legacy additive imports enter the new
session navigator. A verified host study context detaches the prior local identity,
exports its original source references, and rejects an out-of-scope replacement
without changing the displayed pixels. Desktop, modal, comparison and 430-pixel
narrow screenshots were inspected. The report records zero uploads, external
requests, browser exceptions or console errors, and successful resource cleanup.
No original local images or live PACS patient data were used.

Reports are retained in `artifacts/browser-open-workflow/`. The independently
exercised DIMSE path uses generated responses at the transport boundary and real
EASI parsing/decoded frames; it does not qualify live PACS interoperability.

```sh
npm run check
node tools/browser-open-workflow-check.mjs
node --test test/source-registry.test.js test/dimse-gateway.test.js
tsc --noEmit --strict --target ES2022 --module NodeNext --moduleResolution NodeNext --lib ES2022,DOM your-viewer-host.mts
```

## Bounded local image retention

Build `4b9efcf1c8e28e8a02384159d3ec76d8e98a9b84d6ea8f1dc1d18dfe5fc2c29e`
passed `npm run check` with **1,820 tests** and production/distribution checks.
Generated Chrome qualification passed **12 new working-set groups**, plus the
existing **28 local-library** and **17 DICOMDIR** groups on the same build.
The new gate indexes 15,000 frames, repeatedly replaces a comparison beyond the
10,000 resident-frame limit, verifies eviction and actual File rereads, and
preserves independently checked GPU/framebuffer pixels, frame 3000, window and
measurements. Cancellation and a selected 12,288-frame source both restore the
prior panes. Byte/stack boundaries and shared backing allocations have focused
unit coverage, including actual enhanced partitions and source-lease disposal.

Separately, a private user-granted media folder was checked through the native
browser folder input. All 2,992 references indexed into two studies and twenty
catalog series; each series' default display stack rendered and navigated to its
last frame. The largest cross-study comparison (278 + 184 frames) rendered and
navigated in both panes. A measurement survived browsing and reopening. Encoded
resident data peaked at 246.25 MiB under the unchanged 256 MiB cap; disposal
released tracked buffers/workers. This did not render every frame or every scout
partition. No originals were copied, served over HTTP, exported or screenshotted.
The private receipt contains counts only. All browser gates recorded zero
uploads, external requests, exceptions and console errors.

New generated receipts and the inspected comparison screenshot are in
`artifacts/browser-local-working-set/`. Associated regression receipts and the
count-only private receipt are retained in `artifacts/local-working-set-20261016/`.
Historical corpus and browser receipts retain their original fingerprints.

```sh
npm run check
node tools/browser-local-working-set-check.mjs
node tools/browser-local-library-check.mjs
node tools/browser-dicomdir-check.mjs
```

## DICOMDIR terminal-pointer recovery

Build `609973307b6889c1a02a28228218c06f1f2f77ecdb84ebf35babfff8331ad995`
passed `npm run check` with **1,793 tests** and the production/distribution
checks. The generated DICOMDIR browser gate passed **17 groups**. It verifies
complete multi-patient indexing with a last pointer targeting an IMAGE, zero and
outside-record last pointers, visible recovery warnings, independent rendered
comparison pixels, retained measurements, and an actual folder failure followed
by a successful retry that clears only the stale local-import error banner.
Malformed traversal and ambiguous detached active roots remain rejected.

The final generated-only receipt, log and inspected screenshots are retained in
`artifacts/directory-root-fix-20261016/`; previous media qualification receipts
remain unchanged. The browser gate recorded zero uploads, external requests,
exceptions or console errors, and owned resources were released on disposal.

Separately, seven existing local directory indexes passed structural/reference
resolution with four stream chunk sizes under both the original and patched
reader (56 runs), without reading image streams. None reproduced the reported
last-root mismatch; the exact user-selected media was not available for verification.
The generated regressions reproduce and verify the reported failure condition.

## DICOMDIR media qualification

The 2026-10-16 media-import build has source digest
`bc2df776c4d0fc0620b10a99476d43ec7042f4513471f7a562450ea59c6d19ee`.
`npm run check` passed **1,778 tests**, the production build and distribution
checks. Isolated Chrome passed **14 DICOMDIR groups** and the existing **28
local-library groups** on this same build. Generated directory fixtures cover
real linked item offsets, nested extensionless paths, defined/undefined record
sequences and items, icons, inactive records, unsafe/ambiguous/missing references,
identity mismatches, complexity bounds and cancellation.

Browser qualification verifies native folder selection and paginated directory
drops, reference-only metadata indexing, complete study/series navigation,
independent stored-sample/framebuffer output, visible two-study comparisons,
additive imports and preserved measurements, clear failure reports, responsive
navigation, private operational events and complete disposal. Desktop comparison,
missing-reference and narrow-screen screenshots were inspected. No original
imaging files were used, and the media gate recorded zero uploads, external
requests, exceptions or console errors.

The new media receipt/screenshots are in `artifacts/browser-dicomdir/`; the
associated local-library receipt and logs are retained in
`artifacts/dicomdir-20261016/`. Earlier browser and full-corpus receipts retain
their original build fingerprints. This does not repeat the full image corpus
or the historical six-engine qualification.

```sh
npm run check
node tools/browser-dicomdir-check.mjs
node tools/browser-local-library-check.mjs
```

Both harnesses create isolated loopback-only servers and browser profiles. Keep
runtime inputs and build files unchanged while a browser gate runs.

## Local patient library qualification

The 2026-10-16 catalog/timeline build has source digest
`5cfd6dd93ed6e94a99541520edae7fbce19c19b39366b1f31037739ade95a414`.
`npm run check` passed **1,726 tests**, the production build and distribution
checks. Isolated Chrome checks passed **28 local-library groups**, plus the
existing **16 study-workflow**, **11 embedding**, **25 inspector** and
**8 archive-revocation** groups on this build.

The local-library gate verifies metadata-only indexing, exact scalar texture
uploads and independently computed framebuffer values in both comparison panes,
visible image labels/overlays, explicit series choices, additive imports,
patient measurement/export/undo isolation, reviewed identity association,
cancellation and competing requests, existing-source preservation, native
file/folder inputs, count-only events and awaited resource disposal. Desktop and
narrow comparison screenshots were inspected. All fixtures are generated;
there were zero uploads, external requests, browser exceptions or console errors
in the local-library gate.

The new receipt and screenshots are in `artifacts/browser-local-library/`.
Associated regression receipts and logs are retained separately in
`artifacts/local-library-20261016/`; historical corpus and browser receipts are
unchanged. This milestone does not repeat the full 23,893-file campaign or the
six-engine qualification below. Metadata indexing alone does not qualify image
renderability. See [LOCAL_LIBRARY.md](LOCAL_LIBRARY.md) for the exact scope.

```sh
npm run check
node tools/browser-local-library-check.mjs
```

The new harness starts its own loopback-only server and isolated browser profile.
Do not rebuild during a browser run: the gate verifies the build fingerprint
before accepting the result.

## Reading-layout qualification

The reading-layout build on 2026-10-14 has source digest
`04e60700e5fcac40898c149a918623896443d06994d95bb1c9e6158851cddbe5`.
`tools/browser-protocols-check.mjs` passed **30 synthetic groups** with the actual
embedded SDK and owned renderer in isolated Chrome 156.0.8078.12. These cover
metadata-only previews, shared original-frame decoding, independent CT windows
against scalar/GPU references, unchanged ROI statistics, local same-study MR
partitions and explicit overrides, current/prior roles, custom bounded JSON,
four-pane frame policies, failed-render rollback, cancellation, supersession,
source replacement, archive revocation during both growing and shrinking layouts,
mobile scrolling/focus, sibling isolation, and awaited disposal.

The receipt and four reviewed synthetic screenshots are in
`artifacts/browser-protocols/`. The final harness SHA-256 is
`d48c3571a63e8612f2b6d4c36c88f6811b7248de2b711f9dd87579e5266bb78b`;
fixture SHA-256 is
`bc6bb39ae8c7b2a8275474a622fcbd7f017363be6c9e5606be41622ab7758edd`.
There were zero browser exceptions, console errors, uploads or external requests.
The controlled archive received twenty synthetic requests, including five
canceled requests. No original imaging files or personal browser profiles were
used. Fifty repeated reset/apply cycles reused decoded frames without budget
growth. With 175 deliberately retained graphics-context references, live contexts
stayed at most six (four main panes and two sibling panes), and all contexts were
lost after awaited disposal. Removed panes explicitly release their owned context
where available, following the [Khronos context lifecycle extension](https://registry.khronos.org/webgl/extensions/WEBGL_lose_context/).
These are API liveness and owned buffer/cache/worker counters, not process/GPU
memory measurements. An earlier concurrent run on the preceding fingerprint
reported one pane-commit failure; an isolated 75-cycle follow-up passed. Its cause
was not established. The final retained-context check independently verifies
explicit disposal rather than attributing that earlier failure to a cause.

Build before starting a loopback-only preview. Run each harness with the actual
preview URL; do not rebuild or change runtime inputs during qualification:

```sh
npm run check
EASI_VIEW_URL=http://127.0.0.1:5174/ node tools/browser-protocols-check.mjs
```

The annotation, derived-object, enterprise, inspector and revocation receipts
also identify the exact build. The broader historical six-engine qualification
below was not repeated for this milestone.

`tools/browser-engine-check.mjs` exercises the built embeddable SDK with independently generated synthetic DICOM files and a controlled, in-process DICOMweb service. Playwright is a test driver supplied outside this project; it is not a viewer runtime dependency. No original imaging files, real archives, credentials, external websites or browser profiles enter this suite.

## Verified profile

The final 2026-10-14 integrated build passed **168 groups: 28 groups in each of six engine/render-mode combinations**. Each combination also performed 1,000 frame seeks with tool changes and 50 dispose/remount cycles.

| Pinned engine | Default renderer observed | Forced CPU renderer | Groups per mode |
| --- | --- | --- | --- |
| Chromium 156.0.8078.4 | WebGL2 | Canvas2D | 28 |
| Firefox 157.0 | Canvas2D fallback | Canvas2D | 28 |
| WebKit 27.2 | WebGL2 | Canvas2D | 28 |

These are Playwright 1.64.0 Linux engines, running in the official `v1.64.0-noble` **arm64** image pinned to `sha256:06a9939e57531807f8d5fd76ce44b53165ffb7d7501d87ab10e285c20b1e971f`, with Node 24.21.0. The container runs as `pwuser`, with Chromium's sandbox enabled, two CPUs, a 2 GiB memory limit, 256 MiB shared memory, fresh browser contexts and no external network. Only the distribution, driver, harness and synthetic fixture JSON are mounted, all read-only. The test server and browsers communicate through container loopback.

This evidence does not qualify Firefox WebGL2, native Safari, iOS/Android devices or every real-world DICOM encoding. The default backend is recorded rather than assumed. New runtime builds need fresh receipts.

## What is checked

Twenty generated fixture families cover native scalar samples, RLE signed and RGB data, JPEG Baseline grayscale/RGB, both supported JPEG Lossless UIDs, JPEG-LS lossless/near-lossless, JPEG 2000 lossless/lossy and reversible color transform, modality/VOI LUTs, SIGMOID, 8/16-bit palette tables, enhanced MR partitions and variable recorded timing. First and last frames have independently computed rendered RGBA references and original-value probes; original texture uploads are checked where WebGL2 is available. Enhanced partitions retain their original encoded frame indices.

Lossless original samples are exact. The controlled JPEG grayscale fixture allows one sample value of error; JPEG RGB allows three, near-lossless JPEG-LS allows two and the controlled lossy JPEG 2000 fixture allows three. Scalar rendered references additionally allow one 8-bit display level for rounding. These bounds belong to these fixtures and encoder settings; they are not general codec-quality guarantees. Palette and lossless RGB colors are exact.

The same real SDK/UI also checks recorded cine completion, independent 1/2/4 viewport navigation/windows and actual grid geometry, annotation statistics/import, failing synchronous and asynchronous host callbacks, per-pane HTTP cancellation, opt-in prefetch preemption, event privacy and complete disposal. The synthetic service rejects non-GET methods, and browser requests are restricted to its origin.

## CSP result and known WebKit behavior

The host uses a strict policy with the exact embedded stylesheet SHA-256 hash, external scripts, `wasm-unsafe-eval` for codecs and same-origin workers. It does not enable `unsafe-inline`. A separate positive control proves a prohibited `style="color:rgb(255,0,0)"` attribute is blocked. The viewer's actual stylesheet hash, applied CSS rules and pane geometry are verified in every mode.

WebKit 27.2 reports a native `<select>` control violation even for an otherwise empty select with no author `style` attribute. Its `report-sample` value is exactly `text-overflow:inherit`; [WebKit's select implementation](https://github.com/WebKit/WebKit/blob/main/Source/WebCore/html/HTMLSelectElement.cpp) creates that declaration in the user-agent shadow button slot. Direct DOM construction and `appearance:none` reproduce the issue. The suite records this engine-specific behavior separately and accepts only the exact enforced `style-src-attr`/inline/sample/viewer-source combination, with a count matching constructed select controls. Each final sustained WebKit run recorded 663 such violations: thirteen controls across 51 mounts. The earlier isolated 2D SDK build had five controls and 255 warnings; both counts match their respective constructed controls. Any other CSP violation or console error fails the suite.

No policy relaxation or template insertion workaround was applied. There were zero application CSP violations, application console errors or browser exceptions; WebKit's native-control messages remain explicitly present in its receipts. See the [CSP attribute directive](https://www.w3.org/TR/CSP/#directive-style-src-attr) for the distinction between attribute and stylesheet enforcement.

## Repeat the isolated run

From an installed checkout, build and check the distribution before running. Docker must be available. The pinned image below is the verified arm64 profile; a different platform or image needs its own qualification receipt. Keep Playwright and its container version aligned, as described in [Playwright's Docker guidance](https://playwright.dev/docs/docker).

```sh
npm run check
qa_repo="$(pwd)"
qa_driver="$(mktemp -d "${TMPDIR:-/tmp}/easi-view-engine-XXXXXX")"
PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install --prefix "$qa_driver" --save-exact playwright@1.64.0
node tools/browser-engine-fixtures.mjs "$qa_driver/fixtures.json"
cp tools/browser-engine-check.mjs "$qa_driver/check.mjs"
qa_image="mcr.microsoft.com/playwright@sha256:06a9939e57531807f8d5fd76ce44b53165ffb7d7501d87ab10e285c20b1e971f"
mkdir -p artifacts/browser-engines

docker run --rm --init --network none --user pwuser \
  --memory 2g --cpus 2 --shm-size 256m \
  --mount "type=bind,source=$qa_repo/dist,target=/dist,readonly" \
  --mount "type=bind,source=$qa_driver/node_modules,target=/driver/node_modules,readonly" \
  --mount "type=bind,source=$qa_driver/check.mjs,target=/driver/check.mjs,readonly" \
  --mount "type=bind,source=$qa_driver/fixtures.json,target=/fixtures.json,readonly" \
  -e PLAYWRIGHT_MODULE=/driver/node_modules/playwright/index.mjs \
  -e EASI_VIEW_DIST=/dist -e EASI_VIEW_SUSTAINED=1 \
  -e EASI_VIEW_ENGINE_IMAGE="$qa_image" "$qa_image" \
  sh -c 'node /driver/check.mjs; qa_status=$?; tar -C /tmp/easi-view-engine-results -cf - .; exit "$qa_status"' \
  > "$qa_driver/receipts.tar"
```

Check the command's exit status before considering the run passed. It exports available receipts even when an assertion fails, and preserves the test's failing exit status. Inspect and extract only the JSON receipt archive into `artifacts/browser-engines/`; no profiles or sockets are exported. Optional selectors are `EASI_VIEW_ENGINES=chromium,firefox,webkit` and `EASI_VIEW_RENDER_MODES=auto,cpu`. `EASI_VIEW_SUSTAINED=1` enables the sustained loop.

## Evidence and resource boundaries

Receipts contain engine/version, actual renderer, source digest, every built file's size/hash, harness SHA-256, synthetic fixture SHA-256, exact checks/tolerances, CSP control/known violations and final retained-resource counters. The verified milestone source digest is `540681b3025cd74d61119840d6c3e6f0237daf94029da06ba5bc33ed6efd5680`; its harness digest is `5517b1325da1fcc24cffb535976388d798f62c585697a53caeb2aedb3639bc81` and fixture digest is `90387dd25465a2bcd283b33a4ca3e51c687e68127c4b58ec3cc5f04f86aebb01`. Source digests identify build inputs, not an implied release commit or clinical certification.

During sustained runs, decoded retained samples stay within 64 MiB, shared encoded archive cache within 64 MiB, thumbnails within 4 MiB, active workers within one and completed timing history within 256 records. Local encoded source retention is additionally checked against the 256 MiB single-source ceiling. Every remount/final teardown awaits `whenDisposed()` and reports `cleanupPending:false` and zero owned resources. All unmasked snapshots also report zero overlay model/render allocations. Expensive per-pixel QA GPU readbacks are disabled during the seek loop, while the viewer still renders normally; the final draw is independently sampled again.

These are application resource counters on modest generated cases. They are not process-heap, browser allocator, GPU-memory, large-study capacity or comparative throughput measurements. See [PERFORMANCE.md](PERFORMANCE.md) for controlled pipeline timing definitions and baseline methodology.

## Integrated advanced qualification

The same final source fingerprint passed another **77 synthetic browser groups**: reconstruction 17, derived objects 21, enterprise 15, targeted revocation 8 and specialties 16. These use owned local loopback fixtures and independent quantitative/rendered-pixel references, with no original imaging files, external services or production credentials. Receipts in `artifacts/final-validation` include per-suite/harness hashes and a combined advanced receipt; the portable six-engine receipts are stored alongside them. Together the final build passed 245 browser groups. Advanced groups use the isolated local Chromium driver; the portable six-mode suite qualifies the 2D/runtime/CSP/lifecycle paths across its three engines, not every advanced profile on every native device.
