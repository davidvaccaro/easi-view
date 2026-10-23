# Embed and brand EASI View

The standalone application and embeddable component use the same EASI JS data
pipeline, owned renderer and tools. Your application can own study selection,
navigation and branding while EASI View owns the image workspace. The SDK mounts
inside a Shadow DOM boundary; its styles and keyboard shortcuts stay inside the
component, rather than changing your application's page styles or shortcuts.

This is a typed browser ES-module integration in the private research alpha.
Local static/npm archives are available; registry publication and the completed
general viewer release remain separate. Supported image profiles
and remaining limitations are unchanged; see [STATUS.md](STATUS.md).

## Try the integration example

Run `npm run dev`, then open **http://127.0.0.1:5174/embed.html**. The sample host
application selects generated studies, opens local files and switches between
three brands without reloading the current image. It uses the SDK that ships
with the static distribution, rather than a separate viewer implementation.
The component's **Open…** workflow supports configured patient/study selection
and a unified session library. See [OPENING.md](OPENING.md) for `sources`,
`opening` policies and typed session APIs. The legacy archive APIs below remain
available to host applications supplying their own worklists.

## Mount in your application

Run `npm run build` and serve the distribution's assets from your own application.
Keep the SDK, `decode-worker.js`, linked legal-comment files and license notices
together. No sibling EASI checkout or runtime CDN is required. See
[ARTIFACTS.md](ARTIFACTS.md) for packaging and redistribution requirements.

Give the container an explicit height and at least **320 pixels** of width. For
example, in your host stylesheet:

```css
#imaging-viewer { width: 100%; min-width: 320px; height: 640px; }
```

Host markup:

```html
<input id="dicom-files" type="file" multiple>
<div id="imaging-viewer"></div>
<script type="module" src="./viewer-host.js"></script>
```

Your `viewer-host.js`:

```js
import { createViewer } from './assets/easi-view.js';

const viewer = createViewer(document.getElementById('imaging-viewer'), {
  branding: { name: 'Acme Imaging', showReleaseTag: false },
  theme: { accent: '#7aa9ff', panel: '#121b2b' },
  ui: { library: false, demos: false }
});

const stopListening = viewer.on('framechange', state => {
  console.log(`Image ${state.frameIndex + 1} of ${state.frameCount}`);
});
viewer.on('error', error => console.error(error.message));
await viewer.ready;

document.getElementById('dicom-files').addEventListener('change', async event => {
  try {
    await viewer.openFiles(event.target.files);
  } catch (error) {
    if (error.name !== 'AbortError') console.error(error.message);
  }
});

// Call these from your framework/component unmount lifecycle:
function unmountViewer() {
  stopListening();
  viewer.dispose();
}
```

`createViewer()` requires an HTML element in the current document. It appends its
own component without replacing the host container's existing content. By
default it starts empty: mounting does not fetch an archive or load a demo.
Choose `initialDemo: 'ct'` explicitly for a generated initial study. The `ready`
promise resolves after initialization, including that study when requested;
initial loading errors reject it.

## Configuration

Only the following options are accepted. Unknown keys and invalid types throw
an actionable error before mounting.

| Option | Default | Accepted values |
| --- | --- | --- |
| `branding.name` | `EASI View` | Nonempty plain text, at most 120 characters |
| `branding.logoUrl` | `null` | Relative asset path or explicit HTTP(S) URL; no URL credentials, executable schemes or protocol-relative URLs |
| `branding.logoAlt` | Empty string | Plain text, at most 120 characters |
| `branding.showReleaseTag` | `true` | Boolean; controls the visible alpha label |
| `theme` | `{}` | Supported hexadecimal color tokens below |
| `ui.header`, `ui.library`, `ui.inspector`, `ui.statusBar`, `ui.demos` | All `true` | Booleans controlling the corresponding chrome |
| `initialDemo` | `null` | `ct`, `mr`, `xr`, `us`, or `null` |
| `styleNonce` | `null` | Host CSP nonce, nonempty text up to 256 characters without control characters |
| `ai` | Disabled | Optional single gateway/model profile for explicit metadata/measurement assistance; see [AI_ASSIST.md](AI_ASSIST.md) |

Theme keys are `accent`, `background`, `panel`, `text`, `muted` and `border`.
Values must be three- or six-digit hex colors, such as `#7aa9ff` or `#123`.
Arbitrary CSS and HTML are not configuration inputs. Brand labels are applied as
text, not markup. A relative logo asset stays on the host origin; an absolute
logo URL is an explicit host choice to make that image request. No external logo,
font, analytics or telemetry request is configured by default.

Change the skin without reopening the image:

```js
viewer.setBranding({ name: 'Orbit Research', logoUrl: '/images/orbit.svg', logoAlt: 'Orbit' });
viewer.setTheme({ accent: '#c2a6ff', panel: '#171427' });

// These replace their respective configuration objects. Omitted fields reset:
viewer.setBranding({}); // EASI View name, no logo, alpha label visible
viewer.setTheme({});    // Default viewer colors
```

UI flags are chosen at mount time; there is no dynamic UI-configuration setter.
Hiding the header also removes its panel-toggle buttons. For a host-owned
workflow without those controls, use
`ui: { header: false, library: false, inspector: false, demos: false }`.
Hiding demo buttons does not disable programmatic `openDemo()` calls.

## Host API and events

| API | Behavior |
| --- | --- |
| `openFiles(files)` | Promise; accepts a `FileList` or collection of browser files. Reads them locally without uploading |
| `openUrl(url)` | Promise; explicitly fetches an HTTP(S) DICOM or multipart DICOM response. Requires archive CORS and a supported profile; credentials are omitted. Use the configured archive APIs for host-managed request headers |
| `openDemo(id)` | Promise; opens generated `ct`, `mr`, `xr` or `us` data |
| `configureArchive({ baseUrl, headers, credentials })` | Validates and stores an archive connection in memory; returns `{ connected: true }`. Does not fetch until a search/open action |
| `searchStudies(filters, { offset, limit, signal })` | Promise; returns `{ items, hasMore, nextOffset, warnings }`. Default offset 0/limit 25; filters are `patientId`, `patientName`, `studyDate`, `accessionNumber`, `modality`, `studyUid` |
| `listStudySeries(studyUid, { offset, limit, signal })` | Promise; returns the same page shape for that study. Default offset 0/limit 50 |
| `openArchiveSeries(studyUid, seriesUid)` | Promise; builds compatible stacks from EASI metadata and retrieves the first selected native instance for display. Later navigation retrieves only the requested SOP |
| `disconnectArchive()` | Cancels archive queries and pending archive source work, clears connection/results, and releases displayed archive pixels; local/synthetic source ownership is preserved |
| `setFrame(index)` | Promise; selects a **zero-based** frame after the first image is displayed and pauses cine. Out-of-range indices reject; superseded requests reject with `AbortError` |
| `setSeries(index)` | Promise; selects a **zero-based** compatible image stack within the loaded source and resets its view. Bounds use `getState().seriesCount` |
| `setTool(id)` | Selects `window`, `pan`, `zoom`, `probe` or `distance`; grayscale window is unavailable for RGB |
| `setWindow({ center, width })` | Sets the current image window. Both values must be finite and `width` must be at least 1; a grayscale image must be open; RGB rejects scalar window settings |
| `play()`, `pause()` | Control current-series cine; page hiding and source replacement also pause playback |
| `reset()` | Resets presentation, clears the current probe/distance and pauses cine |
| `getState()` | Returns a detached operational snapshot, including geometry/timing/encoding notice arrays; does not expose pixel arrays or patient/instance identifiers |
| `getPerformance()` | Returns bounded, detached timing summaries and tracked buffer/worker counts; remains readable after disposal |
| `resetPerformance()` | Clears completed timing history without changing the current image, caches or in-flight operations |
| `on(type, handler)` | Subscribes to a supported event; returns an unsubscribe function |
| `dispose()` | Cancels work and releases the mounted viewer's resources; safe to call repeatedly |

Load promises resolve to the current state on success and reject on failure.
Starting another source or disposing the viewer cancels outstanding loads;
handle `AbortError` as cancellation. A failed replacement keeps the previous
successful image when rollback is possible.

`sourcechange` reports a successfully accepted source. `framechange` reports a
displayed frame, including navigation and cine. A progressively retrieved frame
can appear before its whole source finishes, so `framechange` can precede
`sourcechange`. Their handlers receive the same operational shape as
`getState()`: loading/disposal flags, selected tool, source type, series/frame
counts and zero-based index, modality, playback, window values, and image
dimensions/photometric/samples-per-pixel/calibration/geometry warnings. `error` receives `{ title, message }`;
`dispose` receives the final state. There is no persistent patient-data store or
event telemetry service.

The state snapshot includes `archive: { connected, searching }`. `connected`
means a connection is configured; it does not certify successful archive access.
`searching` indicates a pending study/series metadata query, while `busy` describes
source/frame loading. Explicit search results contain the archive's patient,
study and series fields and identifiers; they are separate from operational
events and state snapshots. The host owns access and handling of those results.

For native RGB, `getState().window` is null and grayscale presentation controls
are disabled. RGB uses the same sources, branding and navigation APIs; probes
display original channel triplets. Supported RGB is unsigned 8-bit with three
samples and planar storage 0/1. Other color formats retain their explicit limits.

Performance observations contain fixed phase/status/source values and numeric
durations, byte counts and cache flags. They do not add fields to `getState()` or
send timing events to an external service. See [PERFORMANCE.md](PERFORMANCE.md)
for phase boundaries, overlapping intervals, retained-window percentiles and
the repeatable browser baseline.

## Add a local patient library

Use `importLocalFiles()` to add files or folders to the session catalog. It reads
navigation metadata through EASI JS while leaving collection pixels unloaded.
The built-in library groups patients, shows a dated study timeline, and offers
explicit current/comparison roles. Existing `openFiles()` retains its direct,
replacement-source behavior for applications that already own navigation.

For local media, pass the complete folder selection, including **DICOMDIR** and
its referenced image folders. The importer detects the index and resolves only
references within that selection; extensionless image files are supported.
Only referenced, consistent objects enter the catalog. Invalid indexes do not
silently trigger a scan of unreferenced files. A folder without DICOMDIR follows
the ordinary additive metadata-indexing path. The host's folder picker must
preserve relative paths, as a browser directory input does; passing DICOMDIR
alone does not grant access to its neighboring files. The viewer does not upload
the selected files or retain directory permission. See
[LOCAL_LIBRARY.md](LOCAL_LIBRARY.md#open-a-dicomdir-media-folder) for the workflow
and limits.

| API | Behavior |
| --- | --- |
| `importLocalFiles(files, { signal })` | Additive metadata indexing with automatic DICOMDIR detection for complete media selections; returns import counts and `LocalLibraryState`. Supports files with any extension or no extension |
| `getLocalLibraryState()` | Counts, operational flags, and opaque session keys; also available as `getState().localLibrary` |
| `getLocalCatalog()` | Explicit metadata getter containing patient identities and the patient/study/series/instance hierarchy; no file references or pixel arrays |
| `selectLocalPatient(patientId)` | Selects an opaque catalog patient key and clears the preceding patient's displayed views |
| `openLocalStudy(studyId, { seriesId, stackIndex })` | Opens the selected study and exact series; omitted choices use its first series/stack |
| `openLocalSeries(seriesId, { stackIndex })` | Opens the selected catalog series as the current examination |
| `compareLocalStudies(currentId, comparisonId, options)` | Opens two studies belonging to one catalog patient in independent panes; options select exact `currentSeriesId`, `comparisonSeriesId`, and stack indices |
| `associateLocalPatient(fromId, toId, { confirmed: true })` | Explicitly associates records for this session; original DICOM attributes remain unchanged |
| `cancelLocalImport()` | Cancels pending indexing or local selection preparation |
| `clearLocalLibrary()` | Releases local catalog/session state; original files remain unchanged |

```js
viewer.on('librarychange', state => {
  console.log(`${state.patients} patients · ${state.studies} studies`);
});
await viewer.importLocalFiles(selectedFiles);

// Read demographics only when your application explicitly needs them.
const catalog = viewer.getLocalCatalog();
// Pass the opaque patient/study/series keys chosen in your own navigation UI
// to selectLocalPatient(), openLocalStudy(), or compareLocalStudies().
```

Automatic `librarychange` events contain counts, flags, and opaque session keys;
they do not include names, source patient IDs, DICOM UIDs, or filenames.
Metadata indexing does not certify that an image profile can be displayed.
Cross-import patient associations require explicit confirmation when identity
cannot be safely resolved. See [LOCAL_LIBRARY.md](LOCAL_LIBRARY.md) for identity
rules, cancellation, resource limits, and comparison behavior.

For a DICOMDIR selection, `result.media` and `getLocalLibraryState().media`
contain a count-only `LocalMediaReport`: index/reference counts, uniquely located
images, missing/ambiguous/invalid targets, skipped inactive/non-image entries,
unreferenced files and fixed warnings. A located file is not yet a validated
catalog entry; inspect `result.added`, `result.duplicates` and `result.failed`
separately. Ordinary file imports reset the report to `null`; a rejected media
index preserves the preceding successful state. The media importer accepts
active IMAGE references from bounded Explicit VR Little Endian directory indexes;
it does not make every DICOM directory object type displayable.

## Connect an archive from the host

```js
viewer.configureArchive({
  baseUrl: 'https://archive.example/dicom-web/',
  headers: async ({ signal }) => ({
    Authorization: `Bearer ${await yourAccessTokenFunction({ signal })}`
  }),
  credentials: 'omit'
});

const studies = await viewer.searchStudies({ modality: 'CT' }, { limit: 25 });
if (studies.items.length) {
  const study = studies.items[0];
  const series = await viewer.listStudySeries(study.studyUid, { limit: 25 });
  if (series.items.length) {
    await viewer.openArchiveSeries(study.studyUid, series.items[0].seriesUid);
  }
}
```

`yourAccessTokenFunction()` belongs to your application; EASI View does not
implement sign-in. `headers` can be a plain object or a function called for each
request with `{ url, signal }`. The viewer manages `Accept`; browser-controlled
headers cannot be supplied through this hook. Credentials default to `omit`;
the host may explicitly choose `same-origin` or `include` for a suitable cookie
deployment. The viewer keeps settings in memory without browser persistence.

Both query methods accept page limits from 1 to 100 and an optional AbortSignal.
Follow `nextOffset` while `hasMore` is true; a final full page may lead to an
empty next page. Opening a series creates descriptors from metadata before
requesting the selected SOP's complete instance. Multiframe instances
arrive together as encoded pixels, then only selected frames are decoded.
Superseded requests are canceled, and no neighboring instance is prefetched.

The archive must allow the host origin and actual authentication headers through
CORS/preflight. Cookie requests require an explicit allowed origin and permission
for credentialed requests. An HTTPS host normally cannot access an ordinary
HTTP archive. See [DICOMWEB.md](DICOMWEB.md) for complete examples, bounds and
deployment requirements.

Call `dispose()` when your component or route unmounts; removing the container
alone is insufficient cleanup. Disposal releases workers, cache/source ownership,
GPU resources, observers and listeners, removes the component, and frees its
mount registration. Mounting twice into the same container is rejected. After
disposal you may mount a new instance in that container. Methods that change an
instance reject use after disposal; `getState()` remains available for its final
state.

## Host Content Security Policy

The SDK creates one scoped Shadow DOM stylesheet. A strict host `style-src`
policy must permit it by either passing a `styleNonce` matching the nonce in your
host response's CSP, or allowing the exact distribution's stylesheet hash.
`dist/build-info.json` records the base64 digest as `inlineStyleSha256`; add
`'sha256-<that value>'` to `style-src`. Rebuilds can change this digest. The local
preview server uses that recorded hash for the integration example.

Serve the SDK, module worker and `assets/dicom-codecs.wasm` from allowed origins.
Serve the WASM as `application/wasm` and permit `'wasm-unsafe-eval'` in `script-src`
for WebAssembly compilation. See [COMPRESSED.md](COMPRESSED.md). Also permit only your intended
archive origins in `connect-src`, and permit any explicitly configured logo
origin in `img-src`. The host controls these policies and its external script
and stylesheet loading. A nonce applies to the scoped stylesheet, not to
arbitrary injected CSS. The SDK is a direct DOM component; this integration does
not require embedding the standalone page in an iframe.

## Product and license scope

Branding support is an integration feature, not a waiver of EASI View or EASI JS
license and notice obligations. Retain the distribution's license files and
required notices. Commercial product use remains subject to eligibility or a
written commercial agreement; see [LICENSING.md](LICENSING.md).

This foundation supports the current supported 2D research alpha and host-managed
archive access. Viewer-managed sign-in, advanced reconstruction and broad
compatibility/performance gates remain future work; no clinical/regulatory
validation is claimed.

## Study and annotation APIs

`addArchiveSeries(studyUid, seriesUid, { viewport? })` keeps the existing loaded
library and assigns the first newly verified stack to one pane.
`findPriorStudies(context, options)` performs explicit metadata-only candidate
search; `setPrefetch({ enabled, neighbors? })` controls optional idle neighbor
loading. See [DICOMWEB.md](DICOMWEB.md) and [WORKSPACE.md](WORKSPACE.md).

The measurement model is shared across all panes. Use `getAnnotations`,
`addAnnotation`, `removeAnnotation`, `measureAnnotation`, `exportAnnotations`,
`importAnnotations`, `undoAnnotations`, `redoAnnotations` and `clearAnnotations`
for explicit host workflows. `getAnnotationState` and annotation events carry
operational counts; explicit records/exports carry necessary source references.
See [ANNOTATIONS.md](ANNOTATIONS.md) for exact types, limits and gestures.
The package's `easi-view.d.ts` declares the complete public viewer API.

## Bundled host applications and runtime assets

The installed package also exports `createViewer` and `createEnterpriseViewer` for ESM browser bundlers. The two-stage minified browser build is tested. Keep `decode-worker.js` and `dicom-codecs.wasm` adjacent in the copied `assets` directory and emit the host's ESM bundle there, so the module-relative worker URL resolves correctly. Preserve the copied legal files. Importing the served SDK URL as shown above is another supported integration. Bundling the JavaScript does not automatically copy worker/WASM files.

Advanced public APIs are typed in the package declarations and documented in [RECONSTRUCTION.md](RECONSTRUCTION.md), [DERIVED_OBJECTS.md](DERIVED_OBJECTS.md), [ENTERPRISE.md](ENTERPRISE.md) and [SPECIALTIES.md](SPECIALTIES.md). `dispose()` removes the mounted component synchronously; await `whenDisposed()` before measuring completed pending-buffer cleanup.
## Optional AI Assist (Preview)

Configure `ai` to expose the optional header/menu entry for explaining series
metadata and summarizing selected existing measurements. The user reviews the
named recipient and exact fact context before **Generate**. Provider credentials
stay on the gateway; no image bytes, pixels, patient identifiers, source URLs or
unrestricted source text enter the AI request. Viewer-calculated facts remain
authoritative and generated text remains an unverified draft.

Use `openAiAssist()`, `closeAiAssist()` and `cancelAiAssist()` for host controls;
`getAiState()` and `aichange` expose safe operational state only. Explicit
`getAiDraft()` returns the transient text, supplied facts and validation flags.
Patient/source/annotation invalidation and disposal cancel owned work; source
evidence retains its captured image binding. The host controls gateway
credentials/authorization and any intentional downstream use of retrieved drafts.
See [AI_ASSIST.md](AI_ASSIST.md) for complete configuration, exact transfer
boundaries, budgets, lifecycle and the separately operated demonstration service.

