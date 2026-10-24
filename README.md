# EASI View

An independent, zero-footprint DICOM viewer built on **EASI JS**. The browser
application owns its renderer, loading runtime, cache, interactions and tools.
It provides a brandable 2D workspace, patient-space reconstruction and explicitly scoped research/integration profiles.

**Version:** 1.0.0-rc.1 — published release candidate.
**License:** source available under the
[EASI View Community License](LICENSE), with a commercial alternative.

[Try the viewer](https://d3gv6o0ove04h3.cloudfront.net/) ·
[Release downloads](https://github.com/davidvaccaro/easi-view/releases/tag/v1.0.0-rc.1) ·
[npm package](https://www.npmjs.com/package/@xinonix/easi-view)

## Run locally

Requires Node.js 22 or 24 and a current desktop browser. From the project directory:

```sh
npm ci
npm run dev
```

Open **http://127.0.0.1:5174/** and choose **Open…**:

- **Open Images** selects local files or folder contents, including extensionless files.
- **Open Study** selects DICOMDIR media or finds patient studies in a configured DICOMweb/DIMSE repository.
- **Open Test Images** opens generated CT, MR, radiograph or ultrasound examples in an isolated test workspace.

Review selections before adding them. The **Session library** organizes admitted
patients, studies and series independently of their source or pixel-cache residency.
Opening shows a cancellable spinner while files are indexed, archives are queried
or studies are added. Local study selection has **Select all** for every available
study of the chosen patient, including other local pages; remote selection is
explicitly limited to the current results page.

Click a series card to display its first image in the active pane, expand its
instances to select one, or drag either onto a specific pane. The upper-left menu
also provides **Open…** and **Close viewing session**. Session counts and local-file
privacy information appear in the bottom status bar.
Local files stay on your device. See [opening and session navigation](docs/OPENING.md)
for the complete workflow, repository setup and host configuration.
Refresh after source changes; the dev server rebuilds automatically.

```sh
npm run check       # Numeric/runtime tests, build and distributable checks
npm run build       # Static browser application in dist/
npm run preview     # Serve the built application locally
npm run artifact:pack # Package the verified static dist/ with checksums
npm run sdk:pack      # Create an installable local npm .tgz with types and assets
```

Use `EASI_VIEW_PORT=5175 npm run dev` if port 5174 is occupied. The development
server binds only to your machine's loopback address. Static production hosting
must serve `.js` as JavaScript, `.wasm` as `application/wasm`, and preserve the included license notices.

## Connect the local viewer to EASI Store

Open **http://127.0.0.1:5174/** and choose **Open… → Open Study → From remote
storage**. Select **Local EASI Store · DICOMweb** or **Local EASI Store · DIMSE**,
search for a patient, choose studies, then choose **View study**. A family-name
prefix is sufficient: `Synthetic` finds `SYNTHETIC^PATIENT`.

EASI Store **0.2.1** offers two explicit client-access profiles. In **Local
research**, local DICOMweb and DIMSE clients need no browser login. An
administrator enables it under **Administration → Client access**, or starts
Store with `--access-profile local-research`. Both listeners must bind to loopback.
In **Authenticated clients**, DICOMweb requires a session or a configured client
Bearer token. For the built-in local bridge, sign in at
**http://127.0.0.1:8048/** using the same hostname as View. If that session expires,
the opening dialog offers a sign-in link while retaining your search and checked
studies; return and retry explicitly. Store administration stays protected in both
profiles, and DIMSE uses its separate calling-AE/IP trust policy.

The local development server supplies a fixed, read-only bridge and saves no
credentials in the viewer. DIMSE defaults to AE `EASISTORE`, port `4248`. See
[local Store setup and limits](docs/OPENING.md#local-easi-store-connection).
Deployed integrations use host-configured authentication and gateways.

## Embed in your product

Open **http://127.0.0.1:5174/embed.html** to try the viewer inside a sample imaging
application. Switch brands, select generated studies, or open local files through
the host application's controls. The same owned engine powers both this example
and the standalone viewer.

The build includes a browser ES-module SDK:

```js
import { createViewer } from './assets/easi-view.js';

const viewer = createViewer(container, {
  branding: { name: 'Acme Imaging' },
  theme: { accent: '#7aa9ff' },
  ui: { library: false, demos: false }
});
await viewer.ready;
await viewer.openFiles(fileInput.files);
// On component unmount:
viewer.dispose();
```

Give `container` an explicit height and at least 320 pixels of width. Embeds
start empty unless an initial demo is requested. Scoped styles, focused keyboard
shortcuts, host events, dynamic branding/colors and explicit cleanup form the
first integration foundation. See [EMBEDDING.md](docs/EMBEDDING.md) for the complete
API, configuration, CSP and lifecycle contract. This release candidate provides
static and installable npm archives and is available as
[`@xinonix/easi-view@next`](https://www.npmjs.com/package/@xinonix/easi-view).

EASI JS 1.0.1 and this viewer candidate are independently available from npm.
Install the candidate explicitly; copy the full asset directory into your application's
public files so worker and codec URLs remain adjacent:

```sh
npm install @xinonix/easi-view@next
npx easi-view-copy-assets public/easi-view
```

For a locally supplied candidate, replace the install command with
`npm install ./xinonix-easi-view-1.0.0-rc.1.tgz`. To pin the registry version
exactly, use `npm install @xinonix/easi-view@1.0.0-rc.1`. Published archives and
checksums are in the [GitHub release](https://github.com/davidvaccaro/easi-view/releases/tag/v1.0.0-rc.1).

At publication verification, npm tags **next and latest both resolve to
1.0.0-rc.1**. This is still a prerelease; the registry’s `latest` label does not
mean stable 1.0.0. Use the explicit candidate commands above.

```js
// Import from the copied public URL; worker and WASM URLs stay adjacent.
import { createViewer } from '/easi-view/assets/easi-view.js';
```

The copy command requires a new destination and preserves worker, codec,
stylesheet and license files. TypeScript declarations are also available through
`@xinonix/easi-view`. See [ARTIFACTS.md](docs/ARTIFACTS.md) for framework paths,
static hosting, checksums and distribution requirements. The independent
`@xinonix/easi-js@1.0.1` dependency resolves from the registry.
Packing or installing this local archive does not publish the viewer.

## Compare studies and navigate large series

The **Session library** provides patient workspaces, chronological study groups
and series cards. Add selected studies, choose a series for the active pane, or
compare current and prior examinations side by side. Patient changes restore
view settings and isolate measurements. Compatible single-frame instances become
scrollable stacks; multi-frame clips retain their frame and playback controls.
Matching local records offer **Possible same patient** and **Review and combine**
when MRN, name and birth date agree. Confirm the two identities to bring their
admitted studies into one workspace; original files and identifiers stay intact.
When a series has multiple **Image stacks**, compact metadata labels such as
**Axial**, **Echo 2** or **Time 3** distinguish them; the adjacent number is its
image count. Large stack lists have Previous/Next pages, so every available
partition can be selected. The session retains up to 128 series groups and
1,024 image stacks within its existing 10,000-frame and pixel-memory budgets.
A failed selection shows a visible error and preserves the previously displayed
image.

Study admission is metadata-first. Pixel loading occurs as needed, with bounded
recent-series retention and reopening after eviction. Local DICOMDIR selection
follows only referenced media; Open Images scans exactly the selected contents.
Malformed optional study/series labels are omitted with a notice; original files
and patient/image identity checks remain unchanged.
Remote search has a patient-selection step and a study checklist. Sources and
credentials are configured by the host; the standalone preview also has optional
Connection settings. See [OPENING.md](docs/OPENING.md),
[LOCAL_LIBRARY.md](docs/LOCAL_LIBRARY.md), [DICOMWEB.md](docs/DICOMWEB.md) and
[WORKSPACE.md](docs/WORKSPACE.md).

## Apply a reading layout

**Reading layout** previews metadata-based pane assignments before applying
them. CT dual windows reuse the active HU stack and its same frame; MR comparison
keeps selected sequences distinct; current/prior comparison requires explicit
study roles. Missing metadata and equally ranked candidates remain visible,
with eligible manual choices. Preview reads only already loaded stack metadata;
application prepares the selected frames through the existing shared runtime.
Original samples and measurements stay unchanged. Hosts can configure bounded
versioned JSON definitions and use the typed preview/apply/cancel/reset API.
See [READING_PROTOCOLS.md](docs/READING_PROTOCOLS.md) for the exact research
profile; this is a viewer-owned layout system rather than DICOM Hanging Protocol
Storage interchange.

## Reconstruct a spatial stack

**Reconstruct** opens derived axial/coronal/sagittal and oblique planes, physical
slab projections, bounded parallel-ray 3D and explicitly registered fusion.
Original image samples and measurements stay unchanged. Missing or irregular
geometry rejects rather than creating guessed patient coordinates. Output grids,
volume allocation and replacement staging are deliberately bounded; see
[RECONSTRUCTION.md](docs/RECONSTRUCTION.md) for the host API and exact profile.

## Display DICOM derived objects and supplied overlays

Open the source images, then use **Derived Objects** in the inspector to import local SEG masks, reported SR measurements or GSPS presentation states. Masks have visibility, opacity and tint controls. GSPS requires an explicit Apply action. Probes and ROI statistics continue to use original samples; reported SR values remain separate. The SDK provides `importDerived`, `addOverlay`, style controls and versioned JSON import/export. See [DERIVED_OBJECTS.md](docs/DERIVED_OBJECTS.md).

## Connect enterprise services

The installed SDK exports `createEnterpriseViewer(viewer, options)`. Your application supplies identity, worklist, persistence and sharing adapters and a fixed archive address. Sign-in and saving are explicit; the backend authorizes every read. Viewing contexts contain image references and view settings, including original enhanced-frame identity. Logout, expiry and revocation clear owned protected archive data and history while retaining existing local-file image panes. See [ENTERPRISE.md](docs/ENTERPRISE.md) and the separately operated [gateway integration guide](docs/ENTERPRISE.md#read-only-gateway-example).

## Explore specialty research profiles

**Specialty** opens explicit local files in a separate workspace. Native RT Dose and supported classic XA AVG_SUB have quantitative Canvas previews and original-value probes. Recorded cine exposes trim/loop/sweep timing. Breast files produce an explicit L/R CC/MLO layout manifest; WSI produces a bounded TILED_FULL tile index and physical coordinate query. Those latter explorers do not render breast/slide tiles or infer cardiac physiology. Nothing is uploaded. See [SPECIALTIES.md](docs/SPECIALTIES.md) for exact profiles and the SDK.

## Measure and annotate

The **Image inspector** groups deeper functionality into **Details**,
**Measurements**, **Attributes**, **Performance** and **Objects** tabs. It follows
the active image pane. Search Attributes by tag, name or value, including nested
sequences and private tags. Small +/− controls reveal nested sequences and items
in a flat table, with theme-based level shades and labels; search reaches closed
branches too. Pixel/binary values remain summaries. Measurement
tools open Measurements directly. See [INSPECTOR.md](docs/INSPECTOR.md).

Choose **Distance** or open **Measure** for angles and rectangle, ellipse or
polygon ROIs. Select a record in the inspector to see calibrated geometry and
original stored/modality statistics, then edit its handles or outline. Undo,
redo and JSON import/export share the same session model across all panes.
Color images report geometry and counts rather than scalar intensity statistics.
See [ANNOTATIONS.md](docs/ANNOTATIONS.md) for gestures, source-frame identity,
limits and the host API. Annotations remain in memory until explicitly exported;
windowing never changes their measured original values.

Local images with numeric Series identifiers containing leading zeroes can be
measured. Annotation references and JSON roundtrips preserve the exact source
identifier, alongside the original SOP/frame identity.

## View your images

Use **Open… → Open Images → Files/Folder**, or drop DICOM files onto the
viewer to preview and add them to the session library. Choose a series to load its
instances as a stack; compatible image geometry determines frame ordering.
Catalog metadata alone does not establish image support. Imports remain in
browser memory. The
application has no upload endpoint, analytics, or persistent patient-data storage.
Use the supported grayscale/color and compressed profiles listed in
[STATUS.md](docs/STATUS.md). [COMPRESSED.md](docs/COMPRESSED.md) explains the
JPEG Baseline, JPEG Lossless, JPEG-LS, JPEG2000 and RLE matrix, frame indexing
and local worker decoding. [PRESENTATION.md](docs/PRESENTATION.md) covers enhanced
CT/MR geometry, temporal/echo stacks, modality and VOI LUTs, SIGMOID windows,
palette color and recorded frame timing.

Images with missing or malformed optional spatial metadata can still open in 2D.
A nonfatal geometry notice identifies unusable fields and, without valid Pixel
Spacing, explains that measurements use pixels. Valid spacing keeps millimeter
measurements even when an optional aspect
tag is malformed. A valid Pixel Aspect Ratio can preserve display
shape without establishing millimeter calibration.
The compact **Image notices** icon beside the inspector button highlights unread
notes for the active image. Hover or focus it to read grouped geometry, playback
and encoding messages; click or tap to keep the popover open. Escape, its close
button or an outside click closes it. Long notes scroll inside the popover without
resizing the image or adding paragraphs to Details. The icon stays available when
the inspector is closed.

**Mark as read** quiets the highlight while keeping every current-image message
available through the icon. Geometry/timing acknowledgement applies to the same
stack and calibration; encoding issues follow the admitted study across its
series and reloaded stacks. New issues highlight again. Acknowledgements stay in
memory within this viewer and clear when the session closes; direct SDK sources
without a session study use their loaded stack. Public warning arrays and visible
actionable errors remain available.

Choose **Archive** to connect to a DICOMweb service, search studies and browse
their series. For local Orthanc, use the service base address
`http://127.0.0.1:5174/orthanc/dicom-web/`, then choose **Connect & search**.
The local preview provides a read-only bridge to Orthanc on port 8042, avoiding
browser CORS failures without changing Orthanc. For a deployed archive, use its
own DICOMweb URL with CORS or your application's gateway.
The viewer constructs a navigable stack from series metadata before fetching
pixels. Opening a frame requests only its DICOM instance; seeking elsewhere
cancels obsolete retrieval or decoding. It does not prefetch neighboring
instances. A multiframe object is retrieved as one complete encoded instance,
then decoded one selected frame at a time.

Classic PET displays original stored and rescaled values with explicitly
declared source units; it does not infer SUV. Acquisition metadata separates
dynamic/gated families before spatial grouping and linking. Compatible STATIC
and WHOLE BODY image slices share a scrollable 2D stack even when their individual
Frame Reference Times differ; each frame retains its original timing. Linking
and reconstruction still require the full acquisition scope. The private Philips
CT provider accepts only the verified single-frame ELSCINT1/PMSCT_RLE1 profile,
with strict byte counts and preserved original syntax. See
[STATUS.md](docs/STATUS.md) and [PHILIPS_PRIVATE.md](docs/PHILIPS_PRIVATE.md).

Legacy JPEG/JPEG-LS exports with one unusual final alignment byte can open with
an encoding compatibility notice. The viewer checks the complete frame boundary
and preserves the original source bytes. A qualified unsigned monochrome JPEG
Lossless export declaring 12 stored bits in DICOM but 16-bit JPEG precision uses
the JPEG precision with a notice, preserving values above the 12-bit range.
The Attributes inspector retains the original DICOM declarations.
Multi-frame True Color Secondary
Capture also supports interleaved unsigned 8-bit RGB in the qualified native,
RLE, JPEG Lossless and lossless JPEG-LS profiles, with frame navigation and
manual or valid recorded cine timing.

Native multiframe grayscale-word Secondary Capture can retain standard per-frame
position, orientation and pixel spacing through a narrow spatial-only profile.
It preserves original frame identity and top-level presentation; recorded timing,
unresolved dimensions, volume reconstruction and spatial links remain outside
that profile. JPEG2000 unsigned 8-bit `YBR_FULL` with no component transform also
converts once to RGB through the owned color pipeline.

Classic X-Ray Angiographic and Radiofluoroscopic Image Storage (XA/RF) can open
as native grayscale cine within the existing frame and memory limits. The
supported profile provides manual navigation/FPS preview and recorded playback
from the clock selected by Frame Increment Pointer, including a validated Frame
Time Vector. It accepts an absent subtraction mask or
`Mask Operation: NONE`, and does not perform digital subtraction angiography.
Cine trimming and sweeping belong to the separate Specialty workspace. One
bounded circular monochrome display shutter is supported. Active subtraction,
other shutters, special presentation processing and enhanced/3D angiography
remain unsupported. Missing image-plane spacing keeps
measurements in pixels. Supported JPEG-stored XA can now open directly from a
local file, or arrive in its original compressed syntax from an archive.
A classified unsupported original encoding can use one verified native-DICOM
archive retry; local-file decoding remains strict.

Hosts can use the same workflow through `configureArchive()`, `searchStudies()`,
`listStudySeries()` and `openArchiveSeries()`. Request headers may come from a
host callback that supplies a current token. Browser credentials default to
`omit`; `same-origin` or `include` require an explicit host choice. Connections
and credentials stay in memory, and EASI View supplies no sign-in service.
See [DICOMWEB.md](docs/DICOMWEB.md) for a complete integration example, paging,
authentication, CORS and troubleshooting.

The separate **DICOMweb URL** field retrieves a single `application/dicom` image or a
`multipart/related` response containing DICOM instances. For example, use an
Orthanc WADO-RS instance URL of this form:

```text
http://localhost:8042/dicom-web/studies/<StudyInstanceUID>/series/<SeriesInstanceUID>/instances/<SOPInstanceUID>
```

A series retrieve URL can return multiple instances in a multipart response.
The archive must allow the viewer origin through CORS and supply a supported
transfer syntax. This direct URL control omits credentials; use the
configured archive API for host-managed authentication. The viewer does not
accept credentials in URLs. An HTTPS-hosted
viewer cannot fetch an ordinary HTTP archive because of browser mixed-content
rules. Use an HTTPS archive or run the viewer locally for local testing.

## Compare image stacks

Choose **1**, **2** or **4** above the image. Click a pane to activate it, then
choose a series from the pane selector. Tools, the inspector and cine act on that
pane. **Slices** links nearest compatible patient planes; **W/L** shares compatible
scalar presentation, and **View** shares patient-coordinate center and physical
scale. Missing geometry, different frames of reference, ambiguous slices or
incompatible presentation produce a visible unlinked reason. CT/MR demos have
distinct reference identifiers; two panes showing the same CT demo can link.

The SDK exposes layout, assignment and synchronization controls. See
[WORKSPACE.md](docs/WORKSPACE.md) for examples and ownership/cancellation rules.

## Tools

Choose Window, Pan, Zoom, Probe or Distance, then drag or click within the image.
Window changes reuse decoded samples and the GPU texture. Pixel probes report
stored and rescaled values for grayscale or original RGB triplets for color;
distance reports millimeters when valid patient-plane
Pixel Spacing is available, otherwise pixels. Rotate, flip, invert and reset are
available from the viewport controls for their supported image types. Native
unsigned 8-bit RGB images support interleaved and planar storage, pan/zoom,
rotation/flip, RGB probes, distance, frame navigation and cine. Grayscale window
and inversion controls are disabled for RGB; stored channels display directly.
Supported YBR and compressed color normalize to RGB once. Direct native/RLE
palette color retains original indices and applies its 8/16-bit palette for
display. Broader color management and 16-bit RGB remain outside this profile.

Use the frame slider or arrow keys to navigate a stack. Ultrasound's synthetic
multiframe demo supports play/pause. Playback pauses when the tab is hidden or
the input changes. Keyboard shortcuts are shown in the workspace and do not
intercept ordinary input-field typing.

## Why this architecture

EASI JS parses DICOM through its expressive streaming pipeline. EASI View turns
that output into lazy raw-frame sources, decodes selected grayscale or RGB frames
in a worker,
and applies presentation in its own WebGL2 renderer. A Canvas2D reference path
is available when WebGL2 is unavailable. The implementation retains original
sample precision for grayscale windowing, scalar/RGB probes, calibrated tools
and future reconstruction.

Input retention and decoded cache limits are distinct. Local/direct URL loads
accept at most 256 MiB per operation. Archive loads accept 8 MiB per metadata
response, 10,000 frames per series and 4,096 frames per instance, and at most
256 MiB per selected instance response. Archive encoded-instance and decoded-frame
LRUs each retain at most 64 MiB; an oversized active instance is not retained by
the encoded cache. Parser buffers, metadata, the displayed frame and GPU storage
are additional allocations. This viewer does not
claim constant-memory processing of arbitrarily large studies. See the
[architecture](docs/ARCHITECTURE.md) for contracts, lifecycle and future volume work.

## Inspect and measure the pipeline

The inspector’s **Pipeline timing** panel shows local draw-submission, pipeline,
decode and cache observations. Embedded hosts can read the bounded in-memory
recorder through `getPerformance()` and clear completed history with
`resetPerformance()`. Timing snapshots contain no patient identifiers or request
credentials and are not sent as telemetry.

A controlled synthetic browser baseline records repeated cold-pixel opens and
cached/uncached seeks, median/p95, cancellation and disposal evidence with source
fingerprints. These are local software-WebGL observations, not hardware or
physical-paint claims. See [PERFORMANCE.md](docs/PERFORMANCE.md) for exact scopes,
conditions, resource-counter limits and optional read-only Orthanc checks.

## Test your local DICOM collection

From a repository checkout, run each local file through parsing, actual browser
display, tools, every frame, cine and resource cleanup:

```sh
npm run check
npm run test:corpus -- --directory ../easi-platform/data/dicoms/local
```

Originals stay local and unchanged. The private HTML/JSON/CSV results are under
`artifacts/local-corpus/latest/`. Unsupported documents and unexpected defects
are reported separately; a successful session requires actual image rendering.
For collections containing tens of thousands of files, use the resumable campaign:

```sh
npm run test:corpus:campaign -- --directory ../easi-platform/data/test-library \
  --output artifacts/local-corpus/test-library
```

The campaign keeps a fingerprinted inventory, tests deterministic batches with a
fresh browser for each batch, and saves aggregate reports. Repeat the same command
with `--resume` after interruption. Every frame is requested by default;
`--sample-frames` explicitly selects first/middle/last coverage instead.
See [CORPUS_TESTING.md](docs/CORPUS_TESTING.md) for coverage, resuming and limits.

The completed large-library baseline checked **23,893 files**: **20,974 passed**,
**2,907 were reported unsupported**, **12 were labelled invalid**, and there were
**zero unexpected failures**. These are historical outcomes, not waivers or
proof that every rejected input is malformed. The historical hardening candidate
fixed undefined-length UN sequence handling in EASI JS and adds bounded classic
PET, RF, private Philips CT, JPEG2000 `YBR_FULL` and spatial-only word Secondary
Capture profiles. All **2,814 affected originals / 2,949 frames** passed
Node parsing/decoding with unchanged hashes. The final-build browser pilot passed
**150 files / 938 frames**, including all 22 RF and 84 private CT cases; independent
shutter and JPEG2000 pixel checks also passed. The full 23,893-file rerun
completed: **23,788 successful viewing sessions and 105 that could not complete**
(97 unsupported profiles, eight rejected by current validation, zero unexpected
errors). Every file reached browser opening; successful sessions checked every
logical frame. Private baseline evidence is in
`artifacts/local-corpus/test-library/`; a compact comparison is in
`artifacts/local-corpus/hardening-summary/`. No baseline pass is carried forward
as a current-build verification without retesting it.

A subsequent bounded sampled-CT projection compatibility fix passed the reported
69-frame input through both the SDK and standalone viewer, preserving file order
and showing a limited 2D notice. Spatial linking and reconstruction remain
unavailable for these projections. This targeted follow-up does not replace the
completed campaign's frozen-build results; see [STATUS.md](docs/STATUS.md).

## Scope and roadmap

This is an AI-free research viewer release candidate. Its format, geometry,
rendering, reconstruction and integration support is defined by exact profiles in
[STATUS.md](docs/STATUS.md). The [v1 release plan](docs/RELEASE_PLAN.md) freezes the
base scope and remaining acceptance gates; [RELEASING.md](docs/RELEASING.md) describes
artifact and publication steps. The candidate is public on npm and GitHub;
stable 1.0.0 remains gated separately. The measured npm tag state is disclosed
above rather than implying that only `next` resolves to the candidate.
The new-build full-corpus rerun is **running across 23,893 files**, checking all
logical frames in successful supported sessions. Its reviewed outcome blocks
stable 1.0.0 and is not yet claimed as a completed pass.
The project does not claim clinical or regulatory validation.

The AI-free source fingerprint `c335d229eedd333db5afac0f29534a1e93044e68799590b26e6c6c88a3d510ab`
passed **2,163 automated tests** with no skips, production build/distribution
checks and **99 native-browser checks**. A separate independent clean SDK
consumer passed **9 actual-browser checks**, six Node export checks, strict
TypeScript 5.3.3 compilation and direct/CLI copying of all 46 runtime files.
These are software/integration checks; exact scopes and historical evidence are
recorded in [browser qualification](docs/BROWSER_VALIDATION.md). A fresh public-registry
consumer additionally verified package integrity, exports, strict types and the
46 copied runtime files. Actual Chrome smoke checks passed **10/10** across the
public demo and restored local server. The release tag and archive identity are
recorded in [STATUS.md](docs/STATUS.md).

The [roadmap](docs/ROADMAP.md) records phased exit gates. The
[interactive competitive catalog](docs/easi-view-plan.html) contains 272 candidate
features across 21 domains, with original acceptance criteria and primary sources.
That catalog is a backlog, not a list of implemented capabilities.

AI is deferred from the initial release. The [AI backlog](docs/AI_BACKLOG.md)
records the completed experimental preview, preservation commit and future
return gates. AI controls, SDK configuration, model calls, voice input and gateway
code are absent from this release; supported DICOM derived-result import remains.

This project has its own repository, CI and versioned deployment artifacts.
See [the artifact setup](docs/ARTIFACTS.md); no sibling EASI checkout is needed.

## Licensing and publication

Copyright © 2026 Xinonix Interactive Development, Inc. Qualifying research
institutions, nonprofits and individuals may use the project free under the
license conditions. Businesses also qualify when their organization group's
annual gross revenue is **strictly below USD 5 million**. Other organizations
require a written commercial license. See [licensing](docs/LICENSING.md) and the
binding [LICENSE](LICENSE) for institutional exceptions, affiliate aggregation,
redistribution and transition terms.

Commercial enquiries: [dvaccaro@xinonix.com](mailto:dvaccaro@xinonix.com).
This model is **source available**, rather than OSI-approved open source.

The viewer pins the independently published `@xinonix/easi-js@1.0.1` package; see
[ARTIFACTS.md](docs/ARTIFACTS.md). The build includes the pinned JPEG decoder and
local WASM codec asset; build/fixture tools remain development dependencies.
EASI JS and third-party codecs retain their separate notices, which the static
build includes. Public demos and tests use generated synthetic data. Original
local imaging collections and private validation reports are excluded from
source and package publication.
