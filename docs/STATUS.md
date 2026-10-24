# Supported profile and validation status

## Current development — local EASI Store

The standalone development server now connects to local EASI Store 0.2.0 through
a fixed authenticated bridge, with named DICOMweb and DIMSE sources. This changes
the local integration, not the already-published RC artifact. The integrated
checkout passes **2,185 tests**, its production build and distribution guards;
actual DICOMweb/DIMSE opening, local research access, sign-in recovery and twelve original-encoding decode paths are
recorded in [BROWSER_VALIDATION.md](BROWSER_VALIDATION.md). See
[opening instructions and limits](OPENING.md#local-easi-store-connection).


Version **1.0.0-rc.1** is the public AI-free release candidate using the independent
**EASI JS 1.0.1** core. AI controls, configuration, public SDK endpoints, provider
adapters and voice workflows are removed from the release line. The accomplished
experimental work and its exact preservation commit remain in [AI_BACKLOG.md](AI_BACKLOG.md).
DICOM SEG/SR/GSPS and explicit supplied overlays are ordinary derived-result
features and remain supported within their existing profiles.

## AI-free candidate qualification — 2026-10-22

Source fingerprint
`c335d229eedd333db5afac0f29534a1e93044e68799590b26e6c6c88a3d510ab`
passed `npm run check`: **2,163 automated tests**, **zero skipped**, production
bundling and the AI-free distribution/module-inventory guards. The independently
published EASI JS 1.0.1 core previously passed **1,466 tests** and its registry
archive was matched to the tested core artifact.

The final viewer passed **99 native-browser checks**: standalone opening 9,
session navigation 21, annotations 18, workspace 15, inspector 25 and embedding 11.
A separate independent consumer passed **9 actual Chrome SDK checks**, six Node
export checks, strict TypeScript 5.3.3 compilation, direct and `npx` copying of all
46 runtime files, exact 64-sample JPEG-LS decoding, 0.75 mm calibration and disposal.
Qualification includes no assistant API/UI/configuration or inference requests.
The receipts qualify this software profile, not clinical interpretation or
representative production-device/archive performance.

Release qualification exposed and fixed two pre-existing defects: disconnecting
an archive now clears its owned remote pane/pixels and Attributes before the
client binding is released; the embedded example handles `sourcechange` as well
as `framechange`, so its first displayed image replaces the preparing status.
The final counts above are on the fixed fingerprint, not copied from its earlier
2,156-test predecessor. See [BROWSER_VALIDATION.md](BROWSER_VALIDATION.md).

## Publication and deployed identity

The [public source repository](https://github.com/davidvaccaro/easi-view) and
[GitHub release](https://github.com/davidvaccaro/easi-view/releases/tag/v1.0.0-rc.1)
are live. Tag `v1.0.0-rc.1` identifies commit
[`5dd411056f426ebd33929091ed17eac2214d0968`](https://github.com/davidvaccaro/easi-view/commit/5dd411056f426ebd33929091ed17eac2214d0968).
The publication-proof main revision was
[`6185296bb6d749f46f127093546cd9c94eb14927`](https://github.com/davidvaccaro/easi-view/commit/6185296bb6d749f46f127093546cd9c94eb14927).
The release provides six versioned SDK/static archive, manifest and checksum assets.
The npm SDK archive SHA-256 is
`ce2d5193b17065bcacfe19357cdbade0acc14b0b73397464c05f0e701d2da318`,
matching the exact tested public archive. A fresh public-registry consumer verified
that integrity, six Node exports, strict TypeScript declarations, the `npx`
46-file asset copy and registry-resolved EASI JS 1.0.1.

[The public demo](https://d3gv6o0ove04h3.cloudfront.net/) and local previews on
ports 5174/5188 serve all **46 files** byte-for-byte from qualified fingerprint
`c335d229…`. Post-deployment actual Chrome smoke checks passed **10/10** across
public and local viewing. An older development watcher briefly rebuilt local
assets during the Git update; only the owned watcher was stopped, the tagged
assets were restored and the local checks then passed. The experimental cloud
backend remains separate and unchanged; no model/authentication calls were
needed to deploy the AI-free static viewer.

**Measured npm tag state:** both `next` and `latest` point to **1.0.0-rc.1**.
npm assigned `latest` at first publication as well as the requested `next` tag.
An authenticated attempt to remove `latest` returned **HTTP 400**, so no tag
cleanup is claimed. Install `@xinonix/easi-view@next` or the explicit version;
this tag state does not make the prerelease a stable release.

The **23,893-file full-corpus campaign is running** from an isolated tagged
copy with all-frame coverage for successful supported sessions. After the local
watcher issue, 400 validated files were retained and the incomplete 200-file
batch was restarted. This is progress, not a completed campaign outcome. The
reviewed final outcome remains a **stable 1.0.0 gate**. Historical results below
retain their original fingerprints rather than becoming new-build passes.
See [RELEASE_PLAN.md](RELEASE_PLAN.md).

These post-publication notes update main documentation only. The versioned tag,
release archives and their original qualification documents remain unchanged.

## Implemented

| Area | Current behavior |
| --- | --- |
| Sources | Browser File/Blob, selected local files/folders, DICOMDIR media, configured independent DICOMweb sources and DIMSE HTTP gateway sources; legacy host HTTP(S) reads |
| Opening/session navigation | Staged Images/Study/Test opening with a dimmed, inactive content area and cancellable progress overlay during indexing, queries and final admission, patient-first remote search and checked study admission, direct series/instance cards and pane drag/drop, accurate assignment badges, primary Open/Close menu and bounded patient view/measurement restoration; see [OPENING.md](OPENING.md) |
| Local patient library | Bounded metadata-first additive imports, patient search/timeline, matching-local-record suggestions with confirmed study combination, stable image references, explicit comparison and session-only measurement isolation; see [LOCAL_LIBRARY.md](LOCAL_LIBRARY.md) |
| Local image retention | Bounded recent-series cache with selected groups protected, inactive groups released after successful display, and on-demand reopening from original local files; full catalog and measurements survive eviction |
| Local media | DICOMDIR-aware selected-folder import, referenced-file resolution and metadata consistency checks; malformed optional descriptions are omitted with a notice; studies enter the local timeline with series pixels loaded on demand |
| Parsing | Independent EASI JS 1.0.1 DICOM/JSON pipelines, including CP-246 undefined-length UN sequences; native instance validation remains authoritative |
| Archive navigation | Paged QIDO study/series search, metadata-first stacks, additive study comparison, bounded earlier-study candidates and derived thumbnails without extra retrieval |
| Archive authentication | In-memory host header object/async callback and explicit browser credentials mode; host owns sign-in |
| Native syntax | Implicit VR Little Endian, Explicit VR Little Endian, Explicit VR Big Endian |
| Compressed syntax | JPEG Baseline, unsigned monochrome JPEG Extended .51, JPEG Lossless .57/.70, JPEG-LS .80/.81, JPEG2000 .90/.91 and RLE through independently bounded worker providers; see [COMPRESSED.md](COMPRESSED.md) for exact subsets |
| Private pixels | Exact Philips CT-private-ELE/ELSCINT1/PMSCT_RLE1 single-frame unsigned12-in16 MONOCHROME2 provider; original syntax retained; see [PHILIPS_PRIVATE.md](PHILIPS_PRIVATE.md) |
| Pixel profile | 8/16-bit native MONOCHROME1/2; signed/unsigned stored values; validated Bits Stored/High Bit; unsigned 8-bit RGB with three samples and planar configuration 0/1 |
| Color conversion | Native YBR_FULL/YBR_FULL_422 and supported compressed YBR normalize to RGB once; ICC and broader color profiles remain separate |
| Presentation | Per-frame rescale, Modality/VOI LUTs, LINEAR/LINEAR_EXACT/SIGMOID windows, validated polarity and direct palette color with retained original indices; see [PRESENTATION.md](PRESENTATION.md) |
| Geometry | Classic and enhanced CT/MR shared/per-frame geometry, including item-scoped private creators; temporal/echo/diffusion partitions before spatial sorting; missing optional geometry permits labeled 2D preview |
| Spatial word SC | Native unsigned16 MONOCHROME2 `.7.3` with only Pixel Measures, Plane Position and Plane Orientation functional groups; original frame identity/presentation, no recorded timing or volume/spatial linking |
| True Color SC | Multi-frame `.7.4`, interleaved unsigned 8-bit RGB with native, RLE, JPEG Lossless and lossless JPEG-LS syntax; manual navigation and existing validated timing |
| Classic PET | Explicit source Units and original/rescaled values; compatible STATIC/WHOLE BODY IMAGE slices share 2D navigation despite per-slice reference times; full acquisition scopes still guard linking/reconstruction and dynamic/gated navigation; no inferred SUV |
| Classic XA/RF | Bounded native monochrome profiles, explicitly selected fixed/vector timing, inactive masks and one verified circular display shutter |
| Rendering | Independently implemented WebGL2 scalar/RGB-texture renderer, Canvas2D reference/fallback, GPU disposal/context recovery |
| Tools | Window, pan, zoom, rotate, horizontal flip, invert, reset and original-sample probe |
| Inspector | Details, Measurements, Attributes, Performance and Objects tabs; compact header notice icon with grouped hover/focus/click popover and per-study encoding acknowledgements, keyboard navigation, active-pane context, paged tag/name/value search and nested/private metadata; see [INSPECTOR.md](INSPECTOR.md) |
| Measurements | Durable distance, angle, rectangle/ellipse/polygon ROIs; scoped selection/editing, calibrated geometry, padding-aware original/modality statistics, bounded undo/redo and explicit versioned JSON import/export; see [ANNOTATIONS.md](ANNOTATIONS.md) |
| Frames | Slider, keyboard/scroll navigation, fixed and recorded variable timing, explicit manual FPS preview, labeled classic-US malformed-timing fallback and visibility/source-switch pause |
| Observation | Bounded in-memory phase timings, success-only median/p95, tracked retained pixel/cache bytes and worker handles; host snapshot/reset API |
| Runtime | Lazy worker decode, pane cancellation and a shared 64 MiB decoded budget including visible/rollback-held frames; archive instances share a separate global 64 MiB encoded budget and all source scopes reuse one decoder worker |
| Workspace | 1/2/4 panes, active-pane series assignment, geometry-checked slice/physical-view links, compatible window links, independent cancellation and one aggregate decoded budget; see [WORKSPACE.md](WORKSPACE.md) |
| Reading layouts | Defined metadata-only CT dual-window, distinct MR sequence and explicit current/prior presets; deterministic ambiguity, eligible overrides and selected-frame pane transactions; see [READING_PROTOCOLS.md](READING_PROTOCOLS.md) |
| Reconstruction | Explicit LPS MPR/oblique/slab, bounded CPU parallel rays and supplied rigid fusion; Float64 modality values, unchanged originals, 128 MiB combined volume and 8 MiB derived budget; see [RECONSTRUCTION.md](RECONSTRUCTION.md) |
| Derived objects | Exact-grid native binary/fractional SEG, supplied masks/probabilities, coded reported SR and explicit pane-scoped restricted GSPS; JSON results; see [DERIVED_OBJECTS.md](DERIVED_OBJECTS.md) |
| Enterprise integration | Host identity/refresh, bounded worklists, reference-only persistence, backend-verified sharing, fixed-client transactional contexts and protected-data revocation; see [ENTERPRISE.md](ENTERPRISE.md) |
| Specialty research | Native PHYSICAL RT Dose and zero-shift classic AVG_SUB previews; declared cine timeline, breast CC/MLO manifest and WSI TILED_FULL metadata index; see [SPECIALTIES.md](SPECIALTIES.md) |
| Host integration | Browser ESM SDK, Shadow DOM style isolation, viewer-scoped keyboard shortcuts, name/logo/color/chrome configuration, host controls/events and disposal/remount |
| Demos | Generated CT 16-image stack, MR 12-image stack, XR projection image, US 24-frame cine |
| Local corpus checks | Explicit repository-only Chrome File API harness; complete parse, actual frame draws/commits, modality-aware tools/cine and awaited cleanup; private reports in ignored artifacts; see [CORPUS_TESTING.md](CORPUS_TESTING.md) |

### Compact current-image notices — 2026-10-19

Build `32ef900adce39bb8b20454343529306496be404b484ff382e5f37a3158a5301b`
passed **2,097 automated tests**, production bundling/distribution checks and
**46 generated browser checks** (16 compact-notice, 21 geometry and 9 PET
regressions). The header icon groups the active image's geometry, timing and
encoding notes in a scrollable popover, available on hover, focus and click/tap.
The inline banner and duplicate Details paragraphs are removed. Noticed and clean
images retain identical image-stage and Details dimensions; errors remain visible.

Native pointer, keyboard and touch checks cover read state, pane/frame switching,
clearing an active pane, a pinned popover during inactive-pane work, inspector-hidden
access, 390px layout, long literal text and an offset embedded viewer. Numeric
GPU/probe/ROI/measurement, original Attributes and source-byte checks remain valid.
A separate smoke run of the full corpus browser driver passed **4 generated files
and all 7 frames**, including geometry, timing and combined encoding notices, actual
tools/cine and awaited cleanup. It did not repeat the private 23,893-file campaign.
No original medical inputs were used; observed uploads, external requests and
browser errors were zero. See [INSPECTOR.md](INSPECTOR.md) and
[BROWSER_VALIDATION.md](BROWSER_VALIDATION.md).

### Import progress and whole-body PET navigation — 2026-10-19

Build `ee8370778b56cc9d7f6a0f8320f489dbd89608c3e690cbd27a07d6c66a3f63ca`
passed **2,085 automated tests**, production bundling/distribution checks and
**48 generated browser checks** (8 import overlay, 10 PET navigation, 9 large-series
and 21 session-navigation checks). Final admission paints a dimmed, inert content
area and centered progress indicator before invoking the Add callback; keyboard
cancellation, failure/retry, clean reopening, narrow layout and reduced motion
are covered. Search and preview behavior and the public workflow state are unchanged.

Generated JPEG Lossless PET checks render STATIC and WHOLE BODY images with
different per-frame reference times in single 2D stacks, preserving source timing,
SOP/frame identity, Attributes and exact worker/GPU samples. DYNAMIC/GATED
partitions and full-scope linking/reconstruction rejection remain strict.
Other acquisition differences, lazy archive retrieval and immutable source bytes
have focused automated coverage. See [BROWSER_VALIDATION.md](BROWSER_VALIDATION.md).

A separate read-only browser qualification of the reported private PET media
confirmed **11 series, 12 stacks and 1,906 frames**, versus the previous 712
navigation stacks. The affected classic series now contain one stack each with
**419 and 284 images**. All 11 native series-card selections and 12 additional
first/middle/last and exact-instance checks passed with matching source identity
and actual renderer output. This is selected navigation/rendering evidence,
not a repeated all-frame decode or draw campaign. No source files were modified,
and the count-only receipt excludes identifying metadata and pixels.

### Large partitioned series selection — 2026-10-19

Build `12cc7278727c0201d82b496d6a2f51aef349fdf4fd77ce5d4f346c3a1363b535`
passed **2,062 automated tests**, production bundling/distribution checks and
**42 generated browser checks** (9 large-series, 21 session navigation and
12 local working-set regressions). Qualified cases include 419- and 283-stack
series, selection through stack 418 and individual instances beyond 128,
24-item stack pages, exact GPU/probe samples, unchanged pixel-memory limits,
visible genuine budget failures and comparison-safe cancellation/rollback.

A separate read-only browser qualification of the reported PET media passed
**all 11 real series card selections and 12 additional navigation checks**,
including the previously blocked 419/283-stack series, their last stack/instance,
last-frame navigation and cine. Requested pane/instance assignment and actual
renderer output were checked together. This is selected browser-navigation
evidence, distinct from the earlier all-1,906-frame decode pass. No original
images, identifiers or pixel values were copied into reports or screenshots.

### Study-scoped encoding notice acknowledgements — 2026-10-19

Build `4325405fa78226ceb7cbf8f051176d69c58f4b3d8ae505afb26a81bf57f643f3`
passed **2,050 automated tests**, production bundling/distribution checks and
**40 generated browser checks** (10 notice, 21 geometry and 9 PET regressions).
Dismissed encoding issues stay quiet across a study's series and recreated
stacks; only newly encountered issues appear. Details/API messages remain
complete, Show notice restores current messages, and geometry/timing calibration
and actual errors retain their separate behavior. Study/source and viewer
isolation, close/reopen reset, worker disposal, unchanged full-range sample
values and narrow layouts passed. No original medical inputs were used for
these UI checks. See [INSPECTOR.md](INSPECTOR.md).

### PET export compatibility — 2026-10-19

Build `42dc4cc09d79b687f2231faf07cec70554cea5281cff9a15ad31a54d8958fa39`
passed **2,032 automated tests**, production bundling/distribution checks and
**9 generated browser checks**. Qualification covers the single necessary JPEG
alignment byte, full 16-bit values in the narrowly recovered 12-bit declaration
case, original attributes, worker metadata, GPU output, probes, navigation/cine,
True Color SC and rejection of excess trailing payloads. Reconstruction keeps
its descriptor-versus-decoded-profile guard; precision recovery excludes
Modality/VOI LUT presentation. See [COMPRESSED.md](COMPRESSED.md).

The reported private PET media indexed **1,623 image instances** across
**11 series**. Every series loaded, and **all 1,906 frames decoded** through the
local viewer data pipeline with validated dimensions/sample counts. This is an
all-frame decode check, separate from the generated browser rendering checks;
it does not claim that every original frame was drawn in a browser. Original
files were read only, the DICOMDIR hash was unchanged, and no original imaging
files or identifying metadata enter tests, screenshots or distributables.

### Matching local patient imports — 2026-10-19

Build `316b1a9bc3d745d0498dc6a0e60acc6f0800576592f791e2854e086bc3ff3681`
passed **1,988 automated tests**, build/distribution checks, a strict TypeScript
consumer and **35 generated browser groups** (11 association/match groups and
24 opening regressions). Matching suggestions require complete agreeing local
MRN/name/birth-date metadata and no known issuer conflict; they never associate
records automatically. Confirmed combination preserves admitted references,
original source provenance, displayed target frames/windows/panes and target
measurements. Unchecked studies remain excluded. Active-source SDK handling,
measured-source guards, repeated selected imports and close/reopen cleanup passed.
Four new desktop/narrow screenshots were inspected; no uploads, external requests
or browser errors were recorded.

A private count-only catalog check combined the two reported media imports from
two patient records into one with all **3 studies, 41 series and 5,172 instances**.
Study/series/instance references and original provenance stayed stable after
combination and selected readmission. Original DICOMDIR hashes were unchanged.
This association check did not rerun a full-frame rendering campaign.

### Recoverable optional description encoding — 2026-10-19

Build `64aed0f3ee6ffca13757f4d2df6769ced9dddfb55862edec00eed07ee5db534a`
passed **1,971 automated tests**, build/distribution checks and **8 generated
browser groups**. Only malformed byte encoding in optional study/series display
labels is omitted with a notice; identity, UID, path, unsupported charset and
size checks remain enforced. Tests cover independent directory-record charset
scope, preserved supported text, preview/cancel, correct rendered image samples
and unchanged prior workspaces after failed identity validation.

The privately reported MRI media indexed **2,180 referenced instances** across
**21 series** with no failures. All series parsed and the first frame decoded for
each of **26 image stacks**. This is metadata and first-frame decode evidence,
not a full-frame renderer campaign. Original DICOMDIR bytes were unchanged; no
original images or identifying metadata enter tests, screenshots or archives.

### Compact image-stack descriptions — 2026-10-19

Series with multiple selectable stacks now use **Image stacks** and short
metadata-based labels for differing orientation, echo, time, diffusion or matrix
dimensions. Labels are at most 24 characters and use numbered fallbacks when
metadata cannot distinguish groups. Image counts remain compact, with full
wording in tooltips and accessible names. Grouping and source/frame references
are unchanged.

Source fingerprint `7b581bdd7431e7530377ffe92d3796cc3c7b6ed0e83b297eb9010ed08bccc57f`
passed **1,955 automated tests**, build/distribution checks and **7 generated
browser checks**. Independent axial/coronal pixel expectations, stack switching,
frame navigation, narrow/desktop fit and resource disposal passed. Both screenshots
were inspected; no uploads, external requests or browser errors were recorded.

### Direct navigation qualification — 2026-10-19

Source fingerprint `06848f835901e5acb0b4ff05d7dc8ad8cbfba97859bcc13247fbbff61fff308d`
passed **1,948 automated tests**, build/distribution checks and a strict TypeScript
consumer. **45 generated Chrome browser groups** comprise 21 direct card/instance,
drag/drop, pane badge, menu, close/reopen and remote metadata checks, plus 24
structured opening regression groups. Checks compare rendered samples, test
multi-frame first-image selection, and verify disposal and cancellation. Desktop
and narrow screenshots were inspected. No original local images or live PACS data
were used. The full historical 23,893-file corpus campaign was not repeated for
this navigation change. See [BROWSER_VALIDATION.md](BROWSER_VALIDATION.md).

The object-class allowlist covers selected classic CT, MR, projection, US,
secondary-capture, classic XA/RF, classic PET and enhanced/legacy-converted CT/MR
image classes only when they satisfy this pixel/presentation profile. A recognized
modality alone does not establish compatibility.
The classic US allowlist includes retired US Image Storage `.6` with the same
pixel and presentation validation. Unsupported SR/KO documents are separate from
pixel-image classes.

The P1 embedding and first archive foundations are implemented. Repeated
live-archive compatibility and production performance gates remain open, alongside
broader imaging and deployment profiles. The SDK starts empty by default and shares
the standalone viewer's supported profile and limits. See [EMBEDDING.md](EMBEDDING.md)
and the local `embed.html` example. It has static and locally installable release-candidate archives. Viewer npm
publication is pending. See [DICOMWEB.md](DICOMWEB.md) for archive setup,
host-managed authentication and paging.

## Explicit limits

The local catalog accepts **30,000 indexed files**, with a **2 MiB metadata scan
per file**, **512-character navigation values** and **64 MiB normalized metadata
accounting**. Indexing retains File references rather than complete pixel data;
successful indexing does not establish full-object validity or renderability.
The selected local patient image workspace retains at most **128 series groups**,
containing up to **1,024 image stacks**, **10,000 frames** and **256 MiB retained
encoded source data**. These series and stack counts are separate: one series
can have hundreds of independently navigable acquisition/geometry partitions.
Cached local
patient measurement documents have an **8 MiB** aggregate budget, separate from
the existing active annotation-store limits. All local catalog/session data is
memory-only. See [LOCAL_LIBRARY.md](LOCAL_LIBRARY.md).

DICOMDIR selections accept at most **32 indexes**, **16 MiB per index**,
**32 MiB combined index data** and **30,000 directory records per index**.
The selection's **30,000-file** limit includes the index files. The media
importer accepts Part 10 Explicit VR Little Endian directory indexes and active
IMAGE references; other referenced object types are reported as unsupported by
this importer. These bounds are separate from metadata scans of the referenced
images and the active image workspace.

Each image-loader local-file or direct-URL operation accepts at most **256 MiB
of received source bytes**. Archive navigation caps each metadata response at
**8 MiB**, an opened series at **10,000 frames**, and each selected instance
response at **256 MiB**. Archive retrieval uses complete instances, including
all encoded frames of a multiframe instance; only the selected frame is decoded.
Opt-in native scalar/palette frame mode uses the selected `/frames/N` endpoint.
Optional idle prefetch prepares at most two adjacent frames using the same shared
budgets; both are off by default.
A frame accepts at most **16 megapixels**, each dimension at most 8192 pixels;
the GPU may impose a smaller texture limit. At most 4096 frames per instance
are accepted. These are implementation limits rather than clinical guidance.

All archive sessions share a **64 MiB** encoded-instance LRU. All panes and sources
share a **64 MiB** decoded budget including displayed and rollback-held frames.
Derived RGBA thumbnails have a separate **4 MiB** cache. The combined loaded
session library follows the series-group, image-stack, frame and retained-source
limits above. The separate legacy archive-addition and reading-layout/context
paths retain their explicit 128-stack limits.
Reading-layout definitions accept at most 32 protocols in a 64 KiB UTF-8 JSON
collection, with four selectors, sixteen rules per selector and one/two/four
fully specified panes. Preview uses loaded normalized metadata without archive
enumeration or pixel requests. Equal-ranked candidates require a choice, and
current/prior roles establish no patient identity or registration. See
[READING_PROTOCOLS.md](READING_PROTOCOLS.md) for schema and lifecycle details.
An instance larger than the encoded cache budget can be decoded within the
instance input limit, but is not retained by that cache. Metadata descriptors
do not retain encoded pixel buffers after cache eviction. Server-supplied
`BulkDataURI` values are not dereferenced. Pixel Data encoded as InlineBinary
is rejected before parsing. EASI JS's JSON adapter can decode permitted non-pixel `InlineBinary`
values within the 8 MiB metadata input cap; metadata parsing does
not provide an additional zero-allocation guarantee for those values.

Cache size counts retained pixel arrays, not complete browser-process memory.
The visible frame, worker transfer, parser backing storage and GPU texture need
additional memory. Replacing a source temporarily retains the previous successful
source so a failed new source can roll back. Therefore old and new input/cache
storage can overlap. These caps do not imply a 256 MiB total process-memory ceiling.

Pixel Spacing calibrates distance in the image plane; without it, distance is
labeled in pixels. A valid non-square Pixel Aspect Ratio supplies display shape
when Pixel Spacing is unavailable, with measurements still reported in pixels.
Malformed optional spacing, aspect, position and orientation metadata is discarded
with a nonfatal notice available through the header's highlighted Image notices
icon. Without valid Pixel Spacing, its geometry group explains that measurements
use pixels; valid spacing keeps 2D measurements calibrated even when another
optional field is malformed. Hover/focus/click reveals the current image's
grouped notes without changing viewport or Details dimensions. Mark as read
quiets the highlight for the same warning and calibration within the loaded
series; a different warning highlights again, and all current messages remain
available in the popover. No replacement patient coordinates or millimeter spacing
are invented. The viewer does not infer patient calibration from detector
spacing or claim specialized ultrasound-region calibration.

Native RGB requires three unsigned 8-bit channels, Bits Stored 8/High Bit 7, and
Planar Configuration 0 or 1. Planar frames are normalized to interleaved RGB
without changing channel values. Grayscale window and inversion controls are
disabled; the host API rejects scalar window settings. Sources with padding or
nonidentity rescale are rejected rather than reusing them as color transforms.
RGB frame navigation and cine decode one selected
frame at a time. This profile does not establish diagnostic display color
management or specialized ultrasound calibration.

Classic XA/RF accepts unsigned MONOCHROME2 with one sample per pixel, Bits
Allocated 8 or 16, Bits Stored 8/10/12/16 within the allocated size, and High Bit
equal to Bits Stored minus one. Pixel Intensity Relationship must be `LIN` or
`DISP`; Recommended Viewing Mode is absent or `NAT`. The bounded native cine
profile accepts absent masks or `Mask Operation: NONE`, validates the fixed Frame
Time or Frame Time Vector selected by Frame Increment Pointer, and displays
native photometric grayscale values. Manual FPS preview and recorded timing
remain distinct.
This preview does not apply Start/Stop Trim, Recommended Display Frame Rate,
Cine Rate or Preferred Playback Sequencing as a prescribed playback workflow.
Pixel Intensity Relationship/Sign describe acquisition relationships and do not
automatically invert displayed pixels. Active subtraction, non-native viewing
requests, unsupported shutters and special pixel/presentation transformations are rejected.
One CIRCULAR monochrome shutter accepts a bounded in-image integer center/radius
and square raster aspect; its final P-value affects display only, preserving
original samples and quantitative statistics. Other shapes, combined/bitmap
shutters and non-square/invalid declared aspect remain unsupported.
Derived thumbnails classify the shutter at each sampled original raster
coordinate, then apply its final P-value; reducing the thumbnail does not move
the shutter boundary or modify image samples.
Without valid image-plane Pixel Spacing, XA distances remain uncalibrated pixels.
The profile does not implement DSA, enhanced XA/RF, rotational angiography
geometry, vessel quantification or cardiac calibration.

Classic PET requires supported explicit Units (0054,1001); a supplied Rescale
Type must agree. Probes/statistics use source rescaled units, without calculating
SUV or inferring decay/dose corrections. Series Type, counts source, correction,
image index and required dynamic/gated fields form acquisition scopes before
spatial operations. Missing/invalid scope permits only labelled 2D viewing;
reprojection planes do not become tomographic volumes. PET unit/scope mismatches
cannot silently link or fuse stacks.

For fully validated STATIC or WHOLE BODY IMAGE series, 2D navigation omits only
Frame Reference Time from its grouping key. All other acquisition and geometry
fields remain exact, every frame retains its source time, and spatial/window
linking and reconstruction still compare the full scope. This follows the
[PET series slice index](https://dicom.nema.org/medical/dicom/current/output/chtml/part03/sect_C.8.9.html)
and [per-image reference-time semantics](https://dicom.nema.org/medical/dicom/current/output/chtml/part03/sect_C.8.9.4.html);
it does not reinterpret dynamic/gated timing or merge incomplete metadata.

The spatial-only multiframe grayscale-word Secondary Capture profile accepts
SOP class `.7.3`, native transfer syntaxes, unsigned16 MONOCHROME2, and exactly
the standard Pixel Measures, Plane Position and Plane Orientation macros.
Required pixel and geometry VR/VM, duplicate tags/macros, shared/per-frame
exclusivity, item/frame cardinality and bounded orthonormal geometry are checked.
Each descriptor retains its source frame index, patient coordinates and spacing;
source SOP class and top-level presentation remain intact. Declared recorded
timing, dimension/concatenation organization, unknown macros and other pixel
layouts reject. This is 2D navigation, not an inferred tomographic acquisition:
spatial linking and reconstruction remain ineligible.

## Deferred and rejected rather than approximated

- Additional compressed profiles, including JPEG Extended color/progressive, HTJ2K and JPEG XL;
  lossless JPEG point transforms, JPEG-LS mapping/color transforms, and JPEG2000 component overrides/ROI coding.
- Additional YBR, segmented/supplemental/alpha palette color, 16-bit RGB, nonempty ICC profiles/color-space metadata,
  1-bit/32-bit/float pixels and unsupported object classes.
- Broader XA/RF active mask subtraction/DSA, non-circular or broader display shutters, special presentation/intensity
  LUT processing, enhanced XA/XRF and rotational angiography geometry.
- Real-world value mappings and unsupported presentation LUT transforms.
- Deflated Explicit VR Little Endian dataset inflation; the parser reports this
  missing capability explicitly rather than treating the encoded body as raw attributes.
- Rendered-image and additional encoded-frame retrieval profiles, viewer-managed
  built-in sign-in UI, credential persistence, automatic annotation persistence and complete DICOM result export.
- Automatic prior identity matching/registration, DICOM Hanging Protocol Storage interchange and broader clinical hanging workflows, perspective/unbounded reconstruction, broader SEG/SR/GSPS profiles,
  broader enterprise/specialty workflows and production gateway deployment.

The viewer reports these limits instead of silently displaying an approximate
image. A static browser cannot directly open a DIMSE TCP association; a separately
configured HTTP gateway is required for the supported DIMSE repository adapter.

## Verification

`npm run check` runs independent numeric, EASI parsing, geometry, cache and worker
lifecycle tests, builds the static application and checks redistribution notices,
synthetic-only assets and the absence of external viewer-engine dependencies.

`node tools/render-browser-check.mjs` executes the actual WebGL2 shaders in an
isolated local Chrome instance and compares sampled pixels to CPU reference
outputs. It covers signed/rescaled values, the unsigned 16-bit range, threshold
windows, LINEAR_EXACT/inversion and padding, plus texture reuse and disposal.

The first shader QA uses Chrome's software WebGL implementation. It validates
the shader path and pixel results; it is not a hardware performance benchmark.
Headless Chromium/Firefox/WebKit verification is now recorded below. Broader
native-device, live-archive, hardware and production-performance gates remain
future work.
No comparison to competitors' speed or clinical/regulatory claim follows from
these tests.

Initial local verification on 2026-10-13: **65 automated tests** and **31 browser
integration groups** passed, with zero uncaught browser exceptions or console
errors. Browser checks cover desktop/mobile layouts, all four demos, tools,
source rollback/cancellation, local-file privacy, progressive multipart retrieval,
cine timing/pause/seek and viewer disposal/remount. Those original counts describe
the first alpha rather than later archive changes.

Geometry recovery has additional synthetic regressions and browser checks for
uncalibrated 2D viewing, warnings, aspect preservation and source rollback.
Embedding configuration tests cover strict option validation, safe logo URLs,
bounded brand text, fixed color tokens and host CSP nonces. Integration browser
QA exercises the actual SDK and host page; the initial verification counts above
describe the original alpha rather than every later change.

Archive milestone verification on 2026-10-13: **180 automated tests** passed
with the build and distributable checks. **57 synthetic browser groups** cover
the standalone viewer, geometry recovery, embedding and archive navigation. A
final isolated-browser check used the loopback-only preview bridge to search the
running Orthanc, browse series and display an available 512 × 512 image, with
zero uncaught browser exceptions. Original image files and image screenshots
were not copied into verification artifacts.

Archive regression tests use independently generated metadata and image instances
to verify metadata-only navigation, requested-SOP retrieval, multipart parsing,
geometry/identity validation, multiframe reuse, byte/frame budgets, cache eviction,
query cancellation and cleanup. A local technical check against Orthanc 1.12.8
with DICOMweb plugin 1.20 confirmed QIDO, metadata and native multipart instance
retrieval for an available image. Some stale archive records could not be
retrieved. This check establishes a working integration path, not universal
Orthanc compatibility or a measured first-image/scrolling performance claim.
See [DICOMWEB.md](DICOMWEB.md) for the check's scope and operational limitations.

Native RGB verification adds independent planar/interleaved and multiframe numeric
fixtures plus **8 synthetic browser groups**. Actual WebGL2 samples and Canvas2D
output preserve primaries and nontrivial RGB values; checks also cover worker
decoding/cache reuse, RGB probes, distance, cine, monochrome/color control
switching, and unsupported replacement rollback. These use generated images,
not local patient images, and do not establish display color management.

Final RGB update verification on 2026-10-13: **215 automated tests**, build and
distributable checks passed. **66 synthetic browser groups** cover the standalone
viewer, geometry, embedding (including RGB host controls), archive navigation and
color display. Five existing scalar shader/reference cases also passed. The
requested local Renal US series displayed as a 1440 × 1080 native RGB image through
the preview bridge, with zero uncaught browser exceptions. Only technical results
were retained; its original image and screenshot were not saved.

Classic XA verification on 2026-10-13: **256 automated tests**, build and
distributable checks passed, plus **6 new XA browser groups** and **10 archive
browser groups**. The live Orthanc XA instance displayed 512 × 512 native
grayscale frames, navigated through all 96 frames, reused one retrieved instance
when seeking to its last frame, and played/paused cine at the declared 33 ms
frame interval (about 30.3 fps). This is a functional integration check, not a
performance benchmark. Only technical results were retained; the original image
and its screenshots were not saved.

Performance observation now supplies a local timing panel and bounded host
snapshots. The controlled synthetic runner checks repeated pixel-cold opens,
cached/uncached seeks, cancellation, recorder bounds and disposal. Draw submission
is distinct from actual paint; retained-cache counters are not total process/GPU
memory. Controlled loopback/software-WebGL and optional live Orthanc results
remain separate. See [PERFORMANCE.md](PERFORMANCE.md) for precise definitions and
evidence conditions; production/cross-browser/performance gates remain open.

The first controlled performance run passed **five browser groups**, covering
two generated CT sizes with seven repeated observations per size, cancellation,
bounded history/reset, repeated disposal, and an explicitly enabled five-repeat
local Orthanc XA check. Build/source fingerprints matched and no browser
exceptions or console errors occurred. Only the synthetic panel was captured;
no original pixel bytes or original-image screenshots entered artifacts. Timing
values remain in the local receipt with their conditions, rather than being
advertised as universal speed targets.

Final performance milestone verification on 2026-10-13: **285 automated tests**,
build and distributable checks passed, plus **31 standalone**, **11 embedding**
and **5 performance browser groups**. Controlled fixtures used two image sizes
and seven repeats; live Orthanc XA used five separate read-only repetitions.
The final port-5174 build also displayed timing observations and verified host
snapshot isolation, cached XA navigation, timing reset without changing the image,
and zero tracked resources after disposal. Verification retained technical data
and synthetic screenshots only.

Compressed-image milestone: browser worker decoding and reference-pixel suites now
cover five codec families and eight transfer syntax UIDs. This extends the
format foundation. Comparison and annotation foundations now have their own
verified implementation slices; the general 1.0 release gates remain open. Enhanced CT/MR geometry and supported presentation
profiles now have their own implementation and validation slice; see PRESENTATION.md.
See [COMPRESSED.md](COMPRESSED.md) for bounds and validation details.

Comparison workspace verification on 2026-10-14: **760 automated tests**, build
and distributable checks passed. **15 workspace browser groups** validate all
four canvases, linked patient planes, independent cancellation, cache ownership,
source/assignment rollback and rapid synchronization, including visible overlay
recovery. Existing **11 embedding**, **31 standalone** and **4 controlled
performance** groups also passed before the final targeted overlay repair;
workspace groups were rerun on the repaired build. All use synthetic inputs,
with zero browser exceptions or console errors.

Annotation milestone verification on 2026-10-14: **761 automated tests**, build
and distributable checks passed. **73 browser groups** (16 annotation, 31
standalone, 15 workspace and 11 embedding) passed on the same source/build
fingerprint, with zero uncaught exceptions or console errors. Checks cover
pointer creation/editing, anisotropic angles/areas, original-frame identity,
window-independent stored/modality statistics, color exclusions, bounded
history, JSON round trips, callback isolation and disposal. Numeric and browser
fixtures are generated synthetic data. This is functional/numeric evidence,
not independent clinical validation.

Study-workflow verification on 2026-10-14: **801 automated tests**, build and
distribution checks passed for the isolated 2D study build. **16 study-workflow**,
**15 workspace** and **31 standalone browser groups** passed after the final
additive-commit correction. Coverage includes two archive studies alongside a
local pane, metadata-only prior candidates, no implicit thumbnail retrieval,
shared encoded/decoded caches and one worker, default-off prefetch and urgent
preemption, native-frame retrieval, failed GPU/source rollback, recorded replay,
mobile layout and disposal. All inputs and screenshots are generated synthetic.

Typed SDK/artifact verification on 2026-10-14: **802 automated tests** and
build/distribution checks passed, including npm archive inventory, checksum,
asset copying and rejection of unintended repository files. A clean independent
application installed the local `.tgz`, imported the ESM factory, compiled a
strict TypeScript host example and copied the full runtime assets without a
sibling EASI checkout.

**168 browser groups** passed across Chromium 156.0.8078.4, Firefox 157.0 and
WebKit 27.2, in default and forced Canvas2D modes. Each configuration completed
1,000 seeks and 50 dispose/remount cycles; final tracked encoded, decoded,
thumbnail and worker resources were zero. Chromium/WebKit default paths used
WebGL2; Firefox default used Canvas2D. There were no browser exceptions or
application console/CSP errors. WebKit's native select controls emit a proven
internal `text-overflow:inherit` CSP warning, recorded separately without changing
the strict policy; a prohibited application inline style remained blocked.
These are Linux headless engine checks, not a physical-device performance or
clinical certification. See [BROWSER_VALIDATION.md](BROWSER_VALIDATION.md) for
commands, fingerprints, tolerances and the exact scope.

Reconstruction workspace verification on 2026-10-14: **885 automated tests**, build/distribution checks and **17 synthetic browser groups** passed. Independent affine/shear numeric fields, rendered grayscale, slabs, oblique planes, parallel rays and explicit cross-reference fusion were checked. Cancellation, renderer rejection rollback, true 480px layout, focus/inert/Escape and pending disposal passed without browser exceptions or console errors. Supported profiles and limits are documented in [RECONSTRUCTION.md](RECONSTRUCTION.md).

Derived-object verification on 2026-10-14: **995 automated tests**, build/distribution checks and **21 synthetic browser groups** passed. AI and exact-grid native SEG masks use a separate bounded canvas/cache. Restricted SR imports keep reported measurements distinct; explicit pane-scoped GSPS controls display without modifying originals. Real EASI-generated objects, independent source pixels/alpha, transforms, cancellation, source rollback, reset, multi-pane graphics and disposal were checked with no browser exceptions, console errors, external fetches or uploads. [DERIVED_OBJECTS.md](DERIVED_OBJECTS.md) defines the supported interchange profiles.

Enterprise integration verification on 2026-10-14: **1,092 automated tests**, build/distribution and strict TypeScript checks passed. **15 enterprise** and **8 targeted revocation browser groups** used a separately authorized synthetic backend. They cover exact two/four-pane contexts, scope, identity/header failures, expiry, realm changes, controlled shares and server revocation, original-frame references, immediate versus post-commit cancellation, protected annotation history/masks/reconstruction/thumbnail cleanup, pending local/URL rollback, ignored delayed callbacks, disposal and local-file retention. No browser exceptions, console errors or credential leaks were found. These checks do not select or deploy a production identity provider.

Specialty verification on 2026-10-14: **1,206 automated tests**, build/distribution and strict TypeScript checks passed. **16 synthetic browser groups** exercised independent dose/AVG_SUB values and Canvas pixels, anisotropic physical aspect/probes, original32-bit/nonuniform dose planes, declared timing, metadata-only breast/WSI, memory peaks, rollback, stale-probe clearing, generation cancellation, close/reopen ownership, disposal, mobile focus/inert and local-only transport. Independent numeric/lifecycle review also passed. These restricted research profiles do not imply full cardiac, breast, RT planning or slide-pixel viewer support.

Integrated qualification on 2026-10-14: source fingerprint `540681b3025cd74d61119840d6c3e6f0237daf94029da06ba5bc33ed6efd5680` passed **1,206 automated tests**, build/distribution and strict TypeScript checks, **168 portable engine/render-mode groups** and **77 advanced groups** (**245 total**). All unmasked snapshots have zero overlay allocations; every awaited teardown has `cleanupPending:false` and zero owned resource counters. The six portable configurations each completed 1,000 seeks and 50 remounts. The documented WebKit native-select warning remains visible without relaxing CSP. Historical validation receipts retain this fingerprint.

Legacy Series annotation fix on 2026-10-14: source fingerprint `e44327a13f3f6f101447a2afbf3469e64c6f0cbfb3e31d09e10dd9a751969bec` passed **1,213 automated tests**, build/distribution checks and **18 synthetic annotation browser groups**. Optional numeric Series references preserve leading zeroes without canonical aliases; required SOP/supplied Frame of Reference and network/interchange validation remain unchanged. Browser checks cover real ellipse gestures, MONOCHROME1, absent optional patient geometry, calibrated original-value statistics, JSON roundtrips, undo/redo, identity conflicts and disposal. A separate local-file browser check verified the reported ellipse failure and file integrity with no upload or screenshot. These focused checks qualify the fix; the historical six-engine/advanced qualification above was not repeated for this fingerprint.

Tabbed inspector verification on 2026-10-14: source fingerprint `cafb0966595118c6a1a3e0778970b28f1fdad040b545d94bb2f84e1c9c9abe2f` passed **1,235 automated tests**, build/distribution and strict TypeScript checks. **69 synthetic browser groups** comprise 22 inspector, 18 annotation, 21 derived-object and 8 protected-source revocation checks on this exact build. The inspector checks cover linked tab semantics, focused keyboard/scroll behavior, 1500px desktop and 480px mobile embeds, metadata search/paging/nesting/private values, bounded text disclosure, active pane/frame identity, explicit derived actions, memory/source cleanup and local-only transport. Instance and frame retrieval paths preserve private JSON VR and bulk provenance without exposing bulk URLs; ordinary private text remains literal. Attribute preview budgets do not prevent pixel viewing. No browser exceptions, console errors, uploads or external requests occurred. The broader historical six-engine qualification was not repeated for this change.


Reading-layout verification on 2026-10-14: source fingerprint `04e60700e5fcac40898c149a918623896443d06994d95bb1c9e6158851cddbe5` passed **1,279 automated tests**, build/distribution and strict TypeScript checks. **114 synthetic browser groups** comprise 30 reading-layout, 22 inspector, 18 annotation, 21 derived-object, 15 enterprise and 8 protected-source revocation checks on this exact build. Metadata-only preview, distinct MR stacks, explicit prior roles, ambiguous matching and eligible overrides, shared original-frame CT windows, original-value ROI invariance, transactional rollback/cancellation/supersession, source revocation during growing/shrinking layouts, mobile controls and sibling isolation passed. Normalized JSON remains within its declared 64 KiB cap and reimports; detached explanation plans allow 1 MiB. Fifty reset/apply cycles reused decoded frames; with deliberately retained graphics references, at most six contexts remained live and all 175 were released at awaited disposal. No captured browser exceptions, console errors, uploads or external requests occurred. These resource figures describe API liveness and nominal owned allocations, not process/GPU-memory measurements. [READING_PROTOCOLS.md](READING_PROTOCOLS.md) defines the profile; [BROWSER_VALIDATION.md](BROWSER_VALIDATION.md) records commands, fingerprints and the prior unconfirmed concurrent-run failure. The historical six-engine qualification was not repeated.


Geometry-notice clarification on 2026-10-14: source fingerprint `74eec801db1f1bb108090f9b46726059c864965a22bc32615f032a6f113ea880` passed **1,279 automated tests**, build/distribution checks and **12 synthetic browser groups**. The notice confirms successful display and pixel measurement units when valid Pixel Spacing is absent; valid spacing keeps millimeter calibration even if an optional aspect is malformed. Strict source metadata validation, original samples, display aspect and warning details are unchanged. Browser checks cover unsigned ten-bit MONOCHROME1 CR polarity, source-grid probes, pixel/mm lengths and ROIs, literal IS/DS metadata, failed replacement rollback, frame/pane switching, 390px mobile geometry, independent embeds and disposal. No captured browser exceptions, console errors, uploads or external requests occurred. A separate local-only browser check verified the reported file's 440×440 display and notice, with its file checksum unchanged and no saved image screenshot. These checks qualify this focused UI change; the historical broader reading-layout and six-engine suites were not repeated.

Dismissible geometry notices on 2026-10-14: source fingerprint `0c1cdcf1a1e0dd5d8dcb8e223ae155befd469ae9f7fb5eed2bfcef768f4d7db1` passed **1,279 automated tests**, build/distribution checks and **21 synthetic geometry browser groups**. The close button supports Enter, Space and pointer activation, restores canvas focus and reclaims viewport space with correctly aligned annotations. Details retains the warning and restores the banner. Original pixels and pixel/mm measurements are unchanged. Dismissal survives same-series frame/cine navigation, display changes and failed replacement rollback, while different warnings and reloaded sources appear again. Active-pane and sibling-viewer isolation, 390px mobile layout and awaited disposal passed. No captured browser exceptions, console errors, uploads, external requests or persistent browser storage occurred. Original imaging files were not used. These focused checks extend the preceding geometry gate; broader historical milestone and six-engine suites were not repeated.

Local corpus qualification on 2026-10-14: qualified baseline source fingerprint `164e8437da14a63f9a3c5f4a8ba98388a79ded6ee317a8ed55ce5ae79a625a04` passed **1,379 automated tests** and build/distribution checks. The explicit local Chrome harness recursively selected **281 DICOM files**, including extensionless Part 10 inputs. **All 281 parsed**, **all 203 pixel-image sessions passed**, and **all 1,246 logical frames** received successful new renderer draws and commits. **78 non-image objects**—presentation states, structured/key-object documents, directory indexes, raw data, spectroscopy and vendor objects—remain unsupported for direct pixel viewing, with **zero unexpected failures or invalid cases**. Each case exercised applicable tools, ROI invariance, frames/cine, notice retention and awaited cleanup. All original file hashes were unchanged; captured uploads/external application requests were zero. Thirteen enhanced MR inputs now support valid item-scoped private creators, retaining geometry and dimension checks. The actual legacy `.51` warning and malformed-US manual-timing notice were confirmed across workers, state, banner and Details. Reports remain private under ignored `artifacts/local-corpus/`; no originals or image screenshots enter distributables. Generated control cases and a SIGINT run verify negative results and partial-report/worker cleanup. This is software-WebGL functional evidence, not an independent clinical pixel-accuracy or physical-GPU benchmark. The broader historical six-engine qualification was not repeated; [CORPUS_TESTING.md](CORPUS_TESTING.md) defines scope and commands.


The repository-only `test:corpus:campaign` runner extends local testing to large
collections using a sorted fingerprinted inventory, deterministic batches and
resume checks. Each batch owns a fresh browser; partial results remain private.
Part 10 files are recognized regardless of extension. See
[CORPUS_TESTING.md](CORPUS_TESTING.md) for execution and coverage.

The 50-file balanced follow-up pilot on source `71e8b08c…` passed 29 image sessions,
recorded 16 unsupported and five invalid inputs, and left zero unexpected
failures. It checked all 1,122 frames of passing sessions plus 35 frames before a
malformed RLE rejection. All originals stayed unchanged; buffers/workers cleared
and uploads/external application requests were zero. That historical candidate passed
1,406 generated tests and build/distribution checks. Nonzero embedded HP color
transforms keep their existing rejection gate with an explicit unsupported-profile
reason; navigation failures retain their current classified error event through
the SDK's generic rejection.

Large-library baseline on 2026-10-15: source fingerprint
`71e8b08c0ddeb99b2ed526d34659cebecd10a0ba1c548fe09518cdcbafdfa056`
completed **120 batches and 23,893 inputs**: **20,974 passed**, **2,907 reported
unsupported**, **12 labelled invalid**, **zero unexpected failures**. Passing
sessions checked all **23,138 logical frames**; 35 frames checked before a later
RLE rejection bring actual frame checks to **23,173**. Every input hash was
reconciled against the completed inventory; all case teardown resources/workers
were zero, with no captured uploads or external requests. These are historical
functional observations, not clinical interpretation or proof that every
rejected input is malformed.

The hardening candidate fixes **2,380** undefined-length UN parser rejections in
the independent core and adds bounded viewing for **324 PET**, **22 RF** and
**84 private CT** inputs, one JPEG2000 `YBR_FULL` input and three spatial-only
word Secondary Capture inputs. All **2,814 originals** passed Node parsing/decoding
with all 2,949 frames checked, unchanged source hashes and cleared resources. The
84 private CT canonical frames also match an independent GDCM reference exactly.
The browser pilot passed all 150 selected files / 938 frames. The completed
23,893-file campaign then recorded 23,788 successful sessions, 97 unsupported
profiles, eight current-validation rejections and zero unexpected errors: 105
sessions could not complete. All 23,893 files reached browser opening; successful
sessions checked all 26,087 logical frames, with another 35 checked before a
later-frame rejection. There were 2,814 new passes, 20,974 retained passes and
zero regressions. These results belong to fingerprint `7ae2580052c7d9c00fd7a6b5196c0076b155a6455936f4d6d18102090d47a42d`.
In particular, three earlier
deflated-dataset EOF cases now have an explicit unsupported capability diagnosis,
without claiming their source data is corrupt.

The same frozen build checked **48 circular-shutter configurations and 1,200
known framebuffer pixels**, plus the actual SDK/worker/WASM JPEG2000 color path
for both `.90` and `.91` with **18 known RGB pixels**. These numerical/browser
receipts retain their own source fingerprints. The browser pilot verified all 22
RF and 84 private CT inputs, plus selected UN/PET cases, JPEG2000, all three SC
files and 20 prior passing controls. Its 130 new passes / 20 retained passes had
zero regressions, unchanged hashes, complete cleanup and no uploads or external
requests. All **1,607 viewer tests** and build/distribution checks passed. These
are selected functional checks; the full campaign result above is separately
recorded.

Private baseline reports remain in `artifacts/local-corpus/test-library/` and the
compact comparison in `artifacts/local-corpus/hardening-summary/`. The comparison
labels partial/sampled retests, preserves unresolved outcomes and rejects input
drift. Former baseline passes remain unretested until the candidate checks them.
That historical campaign used the local `1.0.1-corpus.0` candidate. The current
independent 1.0.1 core and viewer release preparation are described in
[ARTIFACTS.md](ARTIFACTS.md); the campaign must be repeated for the release build.

### Collapsible attribute hierarchy

The Attributes inspector starts sequences and items collapsed. Small +/− buttons
reveal children in the existing flat table, with theme-based depth shades and
explicit level labels. Expand/collapse-all controls and 50-row paging keep deep
metadata manageable. Search includes closed branches and restores expansion when
cleared. Tree controls operate only on retained metadata; binary/bulk summaries
and the existing row, depth and byte budgets remain unchanged.

Verification: 1,651 automated tests and 25 synthetic browser checks cover nested
items, independent branches, keyboard activation/focus, search restoration,
paging, theme-based shades, aligned columns and narrow-screen overflow. Source
replacement, archive disconnect and disposal clear the relevant metadata.

### Local file selection

DICOM file pickers in the standalone viewer, embedded example, derived-object
inspector and specialty workspace show all files, including extensionless names.
The main image loader continues to validate DICOM contents locally rather than
requiring a filename extension or browser MIME type.

### Follow-up: sampled CT projection compatibility

Native Enhanced CT sampled MAX_IP projections with paired empty dimension
sequences can open as one source-ordered 2D frame sequence when required planes,
spacing, rescale, windowing and frame types pass the bounded profile. A visible
warning describes limited viewing; no dimension organization, acquisition clock
or reconstructable volume is invented. Spatial linking and reconstruction remain
disabled. Other malformed enhanced data stays rejected.

The exact reported input passed all 69 frames in the SDK browser harness and the
standalone file-input/slider/cine workflow, with unchanged source bytes, no uploads
or external requests and complete SDK cleanup. All 1,644 automated tests and
build/distribution checks passed. These are follow-up checks for build
`058a9447ed359743276799aa4c492b990d1cf382f05e0335bbb51b02c0e24785`;
the entire 23,893-file campaign has not been repeated for this later build.

### Local patient catalog and comparison timeline

Standalone file/folder/drop imports now add navigation metadata to a local
patient library. Issuer-qualified identifiers can connect compatible additive
imports; unqualified identifiers stay scoped to their import batch, missing
identifiers stay study-scoped, and conflicting demographics remain separate.
Explicitly confirmed associations retain original identities and DICOM metadata.
Reused SOP UIDs remain separate selectable variants rather than assumed copies.
Conflicting study dates/modalities also stay separately selectable.

Patient search, a paged dated timeline and explicit series selection support
two-study comparisons with current/comparison pane labels. Both studies must
belong to the same associated patient. The user chooses roles and series;
automatic clinical-prior matching and cross-examination registration are not
performed. Failed/canceled preparation restores previous images. Patient changes
isolate measurements and undo history; external annotation documents are never
restored from the local cache. Other derived-object state is cleared on patient
context changes rather than cached per patient.

The SDK exposes additive `importLocalFiles`, explicit catalog snapshots, patient
and series selection, comparison, association and cleanup APIs. Existing
`openFiles` replacement semantics remain unchanged. Catalog snapshots explicitly
contain patient metadata; normal library state/events contain counts and opaque
references. Examples remain separate, with host-configurable visibility.
Persistence and a federated local/remote identity catalog remain future work.
[LOCAL_LIBRARY.md](LOCAL_LIBRARY.md) defines these
contracts and bounds.

Generated catalog/session tests exercise atomic imports, metadata-only reads,
identity ambiguity/conflicts, cancellation/disposal, duplicate variants, explicit
comparison roles and patient measurement isolation. Historical corpus evidence
remains unchanged; the full 23,893-file rendering campaign has not been repeated
for this navigation milestone.

### DICOMDIR local media import

An inconsistent redundant last-root pointer is recoverable with a visible warning
after the forward root/child links validate. Missing first roots, malformed
offsets, cyclic/dangling links and detached active roots that make the root chain
ambiguous remain errors. No records are inferred from the inconsistent pointer.

Selecting a media root folder containing DICOMDIR and its image folders now
uses the index to resolve referenced files within that explicit selection.
Only referenced, consistent objects enter the additive local catalog;
extensionless filenames are supported. Missing, ambiguous and conflicting
references are reported. Invalid indexes do not silently scan unrelated files.
Folders without DICOMDIR keep ordinary additive metadata indexing.

The resulting patient timeline makes the study's series available while
retaining on-demand pixel loading and image-profile validation. Directory
records cannot override conflicting source patient identifiers or UIDs. Reads
remain local, session-only and restricted to the files supplied by the user.
The count-only media report distinguishes file resolution from the import's
metadata-indexing outcome. Non-image directory references are counted as
unsupported; image renderability remains a separate on-demand check.
See [LOCAL_LIBRARY.md](LOCAL_LIBRARY.md#open-a-dicomdir-media-folder).
