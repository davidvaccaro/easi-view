# Multi-viewport workspace

EASI View provides one, two, or four independent image panes. Open a synthetic
study, local files, an HTTP source, or an explicitly configured DICOMweb archive.
Choose the layout above the images, select a pane, and use the series selector
or study library to assign a loaded series. Each pane keeps its own slice,
window, zoom, pan, rotation, flips, inversion, probe, and temporary distance.
The toolbar, inspector, frame slider, keyboard shortcuts, and cine controls
operate on the active pane. Cine pauses when the active pane changes.

Opening another source replaces the loaded library and its pane assignments.
If that source cannot open, the prior source and pane views are restored.
This milestone does not combine separately opened studies into one library.
Different series and enhanced temporal/echo stacks within the current source
can be assigned independently.

## Embedding API

```js
const viewer = createViewer(container, { initialDemo: null });
await viewer.openFiles(files);
await viewer.setLayout(4);
await viewer.assignViewportSeries(0, 0);
await viewer.assignViewportSeries(1, 1);
viewer.setActiveViewport(0);
await viewer.setFrame(10);
viewer.setWindow({ center: 40, width: 400 });
await viewer.setSynchronization({
  slice: true, window: false, camera: false, toleranceMm: 1
});
console.log(viewer.getWorkspaceState());
```

Pane and series indices are zero based. `assignViewportSeries(slot, seriesIndex)`
uses the currently loaded source and does not change the active pane.
`setFrame`, `setSeries`, `setWindow`, and existing interaction methods target
the active pane. Invalid layout, pane, series, frame, or synchronization options
fail before starting a request. A superseded request rejects with `AbortError`.

`getWorkspaceState()` and `getState().workspace` return detached operational
state: layout, active pane, per-pane series index, frame index/count, matrix,
photometric interpretation, screen transform, grayscale window, busy state,
shared decoded bytes/budget, link options, and the last match/skip results.
These snapshots contain no patient fields, DICOM UIDs, pixel samples, archive
addresses, or patient-coordinate positions. `getPerformance().resources`
includes the shared decoded memory and viewport count.

Subscribe with `viewer.on('layoutchange', handler)`,
`viewer.on('viewportchange', handler)`, or `viewer.on('syncchange', handler)`.
Existing `framechange` events include the pane index as `viewport`.
Observers cannot interrupt a viewer operation by throwing or rejecting.

## Guarded linking

Link options are independent and off by default. Skipped panes report a
technical reason in the workspace state and beside the link controls.

- **Slices:** matching, nonempty Frame of Reference UIDs, valid patient-space
  orientation/position/spacing, parallel plane normals, and the same known
  temporal/echo/diffusion family are required. Navigation selects the unique
  nearest patient plane within the explicit millimetre tolerance. It never
  matches by slice index alone or guesses missing patient positions.
- **W/L:** both images must be grayscale with the same modality, unit,
  rescale/LUT semantics, VOI function, polarity, and temporal/echo family.
  Unknown intensity units can link only within the same valid Series UID.
  Color images and incompatible intensity domains are skipped.
- **View:** pan and zoom are translated through patient-coordinate image
  centers and pixels per millimetre. Matching reference/plane/family geometry
  and an overlapping field of view are required. Raw screen offsets are not
  copied between differently sized images. Each pane retains its rotation
  and flip settings.

A compatible slice can update even if a separately requested W/L or view link
is skipped; the result retains the completed slice index. Turning all links
off clears their last status. Sync requests are canceled and coalesced when
navigation, assignments, the active pane, or settings change.

## Ownership and resource limits

The independent `WorkspaceModel` owns `ViewportSession` slots and explicit
`SourceLease` registrations. A registration and every assigned pane retain a
source. Shrinking a layout releases only removed slots. Owned sources dispose
once after their final lease; borrowed sources regain an empty independent
cache and remain usable. The application uses borrowed leases because its
source loader owns commit/rollback and disposal.

Built-in sources share an aggregate 64 MiB decoded LRU across all panes.
Original sample buffers and modality/VOI/palette tables are counted once when
shared. Displayed frames and source rollback frames count toward the same
admission limit even when their LRU entries are evicted. Encoded archive
instances share a separate 64 MiB workspace LRU across connections and prior
studies; session-scoped teardown releases only its own records and indexes.
Local-file encoded inputs retain the independent 256 MiB source-operation cap
and are not charged to the archive LRU. Scoped cache teardown
cannot clear another source's frames. GPU textures, rendering staging arrays,
and the encoded data budget are separate from this decoded-cache accounting.

Each pane has its own generation and abort controller. A broker serializes
built-in source fetch/decode requests so the existing archive source's request
supersession cannot cancel another pane. Queued cancellation is immediate;
active cancellation reaches fetch/stream/worker cleanup. An unsupported custom
source that ignores its abort signal can delay the queue until it settles;
custom source injection is not part of the public embedding API.

The renderer validates and submits a frame before that pane publishes its
model commit. Failed decoding or display restores the prior pane assignment
and view. Disposal cancels every pane and sync request, releases source/cache
ownership and renderers, and reports zero retained viewer resources.

All automated workspace checks use generated synthetic DICOM, including
independent geometry, reference, temporal/echo, cancellation, memory, and
browser pixel checks. This research alpha does not claim clinical validation,
registration between differing reference frames, MPR, or hanging protocols.

## Optional adjacent-frame prefetch

The UI **Prefetch nearby** checkbox and `viewer.setPrefetch({ enabled: true,
neighbors: 2 })` enable delayed adjacent-frame loading after a successful idle
navigation. Disable it with `{ enabled: false }`. It does not run during cine
and never replaces a displayed image. Resource snapshots report the global
encoded/decoded caches, thumbnail bytes and the single shared decoder worker.

The internal workspace API provides
`prefetchNeighbors(slot, { neighbors: 1 | 2, delayMs: 150, signal, onMeasure })`.
It is off by default. An explicit call waits for the idle delay, then prepares
at most the next and previous navigable frames using the same source, decoder,
cache, and decoded admission budget. It never assigns a pane or changes its
image, transforms, or measurements. The returned `{requested, completed,
canceled}` record contains counts only.

Foreground navigation preempts pending and active background work. New
prefetch requests replace prior work; layout changes, source release, explicit
`cancelPrefetch()`, and workspace disposal cancel it. A separate background
observer is optional; an omitted observer does not overwrite the source's
foreground frame/decode measurements. Encoded DICOMweb retrieval follows the
connection's explicit instance or native-frame policy.

## Classic acquisition dimensions

Classic image descriptors retain `classicDimensions` (also available through
`syncDimensions`) with declared temporal position, echo time/numbers,
acquisition number, full image type/complex component, diffusion scope, and
Spacing Between Slices. Meaningful nonspatial differences partition stacks
before patient-position sorting. Instance Number orders images within a stack
and never defines a separate acquisition. A changed Acquisition Number splits
conservatively; archives that vary this field per image may produce several
small 2D stacks.

Spacing Between Slices is the declared center-to-center spacing; it is kept
separate from Slice Thickness and never substitutes for missing patient
positions. [DICOM PS3.3 Image Plane Module](https://dicom.nema.org/medical/dicom/current/output/chtml/part03/sect_C.7.6.2.html)
defines this distinction and its nonnegative ordinary image-plane semantics.
Malformed optional acquisition fields preserve a 2D preview with an explicit
warning, set `invalid`/`spatialEligible:false`, and cannot enter spatial linking
or reconstruction. Absent acquisition metadata stays marked
`semanticScope:'same-series-only'`. Archive retrieval verifies every nonempty
scope field supplied by its metadata; absent fields remain unknown.

## Multiple studies and previews

`viewer.addArchiveSeries(studyUid, seriesUid, { viewport })` preserves the loaded
library and assigns the newly verified source to one pane. Archive disconnection
clears remote members while preserving loaded local panes. Slice linking still
requires matching reference geometry; prior studies are not automatically
registered. Each viewed series gets a small derived thumbnail without another
network request. See [DICOMWEB.md](DICOMWEB.md).
