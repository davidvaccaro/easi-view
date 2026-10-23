# Annotation and measurement foundation

The standalone viewer and embedded SDK share a bounded, versioned annotation
model. Distance is on the main toolbar; **Measure** opens angles, rectangle,
ellipse and polygon ROIs, and the selection/edit tool. The inspector lists
annotations on the original DICOM frame, displays selected ROI statistics,
and provides undo, redo, deletion and explicit JSON import/export.

Two-point tools drag. Angles use three clicks. Polygons finish with Enter or a
double click; Escape cancels unfinished work. Select a record in the inspector
or use **Edit annotations**, then drag a handle or outline. Ctrl/Cmd+Z and
Delete apply when the image canvas has focus. Records survive frame navigation,
pane changes and source replacement within the viewer session. Export them to
keep them after disposal or integrate persistence through your application.

Nothing is saved or transmitted automatically. This JSON interchange does not
write DICOM SR/GSPS objects. Original DICOM identifiers and coordinates are
included in explicit exports; treat those exports as application data.

```js
import {
    AnnotationStore, createImageReference, measureAnnotation
} from './src/annotations/index.js';

const store = new AnnotationStore();
const image = createImageReference(frame);
const annotation = store.add({
    tool: 'rectangle',
    image,
    points: [{ x: 0, y: 0 }, { x: 3, y: 3 }]
});
const result = measureAnnotation(annotation, frame);
console.log(result.geometry, result.statistics);

const saved = store.exportJson();
const restored = new AnnotationStore();
restored.import(saved); // Atomic merge; colliding ids reject the entire import.
```

`frame` must contain explicit source `sopUid`, zero-based **original**
`frameIndex`, rows/columns, and decoded original samples. Local/archive source
frames carry the same identifiers. A sorted stack's display position is never
used as the original frame number.

## Embedded viewer API

```js
const annotation = viewer.addAnnotation({
  tool: 'rectangle',
  points: [{ x: 10, y: 10 }, { x: 50, y: 40 }]
}); // References the active viewport's original SOP/frame and geometry.
const result = viewer.measureAnnotation(annotation.id);
const saved = viewer.exportAnnotations();
viewer.undoAnnotations();
viewer.redoAnnotations();
// On another viewer after opening the referenced images:
viewer.importAnnotations(saved, { mode: 'merge' });
```

`getAnnotations({ viewport })` lists records on the displayed original frame;
`addAnnotation` and `measureAnnotation` also accept an optional viewport in their
second argument. `removeAnnotation(id)` and `clearAnnotations()` act on the
shared session model. `getAnnotationState()` reports only counts, payload bytes,
revision and undo/redo availability. `annotationchange` and
`annotationselectionchange` events expose operational state without identifiers,
coordinates or pixels. Explicit `getAnnotations`/export calls return source
references. Host callback failures cannot interrupt committed viewer actions.

The modules below supply the same model and numeric reference functions for
internal integrations; their source paths are not a published npm export.

## Coordinates and scope

Points use continuous image-edge coordinates: `(0,0)` is the upper-left image
edge, and pixel centers are `(column + 0.5, row + 0.5)`. Coordinates remain
independent of viewport zoom, pan, rotation, flips and device-pixel ratio.
Valid coordinates include the outer image edges.

Each record has exactly `id`, `tool`, `image` and `points`. The image reference
contains `sopUid`, one-based `frameNumber`, `rows` and `columns`, with optional
`seriesUid`, `frameOfReferenceUid` and `geometryFingerprint`.
`createImageReference` includes a geometry fingerprint by default and rejects
overrides that contradict an explicit source UID/frame index.

For compatibility with legacy local files, optional Series references accept
ASCII numeric dot-separated components, including leading zeroes, within the
64-character limit. The source spelling is preserved through creation, matching,
undo/redo and JSON roundtrips: `2.25.000041` and `2.25.41` are different
references. This does not repair the original DICOM identifier. Required SOP and
supplied Frame of Reference UIDs retain strict validation, as do archive requests
and DICOM interchange. The same exact source-reference rule applies to viewer
AI overlay/result JSON.

The fingerprint is a versioned equality hint over numeric geometry. It is not a
security hash or a replacement for SOP/original-frame identity. A measurement
rejects a mismatching source frame, missing explicitly referenced identity, or
changed fingerprint. An annotation with no usable patient geometry can still
be measured on its scoped pixel grid.

Supported tools:

| Tool | Points | Meaning |
| --- | --- | --- |
| `length` | 2 | Endpoint distance |
| `angle` | 3 | Angle at the second point, from 0 to 180 degrees |
| `rectangle` | 2 | Opposite corners of an axis-aligned image rectangle |
| `ellipse` | 2 | Opposite corners of an axis-aligned ellipse bounding box |
| `polygon` | 3–128 | Simple closed polygon; the last point is implicitly connected to the first |

Duplicate points, zero-length arms, zero-width/height ROIs, degenerate polygon
area, overlapping edges and nonadjacent edge crossings/touches reject.
Do not repeat the first polygon point at the end.

`annotationHandles`, `moveAnnotationHandle` and `translateAnnotation` support
selection/editing while retaining the original source reference. Moves remain
subject to the same bounds and shape checks. `imageToPatient` and
`patientToImage` use DICOM position/orientation and anisotropic spacing.
The first pixel center maps to Image Position (Patient). A point outside the
requested plane tolerance returns `null`; missing patient geometry also returns
`null`. Matching Frame of Reference and choosing target planes remain the
workspace's responsibility.

## Measurement and statistics

`measureGeometry(tool, points, frame)` supplies geometry for draft previews.
`measureAnnotation(annotation, frame)` also verifies durable source scope and
computes ROI statistics. Pass `{ statistics: false }` for geometry only.

When Pixel Spacing is present, x distances use column spacing and y distances
use row spacing. Lengths are in `mm`, areas in `mm2`; the result identifies the
source as `dicom-pixel-spacing`. This uses the spacing supplied by the image;
it does not establish independent magnification/fiducial calibration.
Without Pixel Spacing, lengths/areas are in `px`/`px2` and `calibrated` is false.
Pixel Aspect Ratio affects display geometry and is not physical calibration.
Angles also account for anisotropic Pixel Spacing when available.

Rectangle, ellipse and polygon statistics include pixel centers inside or on
the closed ROI boundary. Scanlines use bounded vertex scratch storage and
stream moments directly from the existing samples. No ROI raster, copied sample
list or whole-image mask is allocated.

The returned `stored` and `modality` statistics each contain count, mean,
population standard deviation (`stdDev`), minimum and maximum. The modality
values use the frame's Modality LUT or slope/intercept. Pixel padding is excluded
before modality evaluation. Window/VOI LUT, inversion and palette display never
change the measured stored values. Empty/all-padding ROIs return null moments.

`pixelCount` counts included nonpadding pixels; `sampledPixelCount` also counts
padding, with `excludedPadding` reported separately. `sampledArea` is pixelCount
times the pixel-cell area. It differs from the analytic geometric ROI area when
subpixel boundaries cut cells; both are reported with distinct fields.

RGB and palette-color ROIs return geometry/pixel counts with
`status: 'color-intensity-unavailable'`, a representation label, and null stored/
modality intensity statistics. Their channel values are not presented as a
scalar medical intensity. Unsupported sample layouts and nonfinite numeric
results fail explicitly.

## Store, history and exports

The store supports add, point update, remove, clear, undo/redo, get/list,
subscribe, and explicit import/export. Returned objects are copies; edits cannot
change id, tool or source scope. Use a new annotation to change those fields.
An edit after undo clears redo history. Host observer errors are isolated.

Default hard ceilings are:

| Resource | Limit |
| --- | --- |
| Serialized annotation payload | 1 MiB |
| Annotations | 1,000 |
| Annotations per SOP/original-frame pair | 200 |
| Polygon points | 128 |
| Image | 8,192 rows/columns; 16 megapixels |
| Original frame number | 1–4,096 |
| History | Default64 edits; maximum128; 2 MiB serialized-history budget |

Constructor limits can lower these ceilings. A history entry too large for the
configured history budget clears prior history; the valid edit still commits.
Undo/redo share one bounded history budget. `clearHistory` drops history while
retaining records; `dispose` clears model, history and listeners.

Exports use this versioned envelope:

```json
{
  "schema": "easi-view.annotations",
  "version": 1,
  "coordinateSystem": "image-edge",
  "frameNumberBase": 1,
  "annotations": []
}
```

`export()` returns an object, `exportJson()` returns JSON text, and `import()`
accepts either. Merge is the default; `{ mode: 'replace' }` explicitly replaces
the model. Imports validate the complete candidate before committing, including
duplicate/colliding ids, per-image counts, conflicting references, shapes and
byte limits. Failure changes neither model nor undo/redo state.

Schema v1 excludes patient fields, arbitrary host metadata, labels/free text,
source URLs, raw pixels and computed statistics. Exports include the necessary
SOP/Series/Frame-of-Reference identifiers and annotation coordinates. No storage
or transport happens implicitly.

## Optional pointer controller

`src/ui/AnnotationController.js` supplies the interaction layer separately from
the store and renderer:

```js
import { AnnotationController } from './src/ui/AnnotationController.js';

const controller = new AnnotationController({
    canvas, layer: annotationSvg, viewport, store,
    getFrame: () => currentFrame,
    getTool: () => selectedTool,
    onChange: ({ count, selectedId }) => updateAnnotationControls(count, selectedId),
    onError: error => showAnnotationError(error.message)
});
// After the host clears/redraws the shared SVG overlay:
controller.render();
```

The controller accepts `length` (`distance` is an alias), `angle`, `rectangle`,
`ellipse`, `polygon` and `select`. It intercepts their primary-pointer events;
pan, zoom, window, probe and secondary-pointer actions stay with the host.
Two-point tools drag; angles use three clicks; polygons use clicks and finish
with Enter, a double click, or a repeated first point. Escape aborts a draft.
Pointer cancellation, lost capture, source-frame changes and tool changes also
discard unfinished work. Focus stays on the canvas for keyboard completion.

The select tool selects a shape and allows its control handles or whole shape to
move. Every completed drag creates at most one undoable point update. Invalid
edits retain the previous model. Changes to the model during an edit cancel the
unfinished edit. `deleteSelected()` removes the selected record; undo/redo remain
store operations. `getSelected()` returns a copied scoped annotation or null.
`cancelDraft()` aborts interaction without changing durable records.
`select(id)` explicitly selects a record on the current scoped image;
`select(null)` clears selection.

SVG previews and labels compute only geometry. They do not read samples or
calculate ROI statistics on pointer movement or rendering. A host can explicitly
call `measureAnnotation(controller.getSelected(), currentFrame)` after a commit
or selection when it wants statistics. `onChange` contains only `count` and
`selectedId`; no image identifiers, pixels or host metadata enter that event or
SVG data attributes. Observer failures are isolated from committed edits.

`dispose()` removes the controller's listeners, subscription, draft and SVG
group. It leaves the host-owned store and viewport alive. Dispose controllers
before disposing their shared store.


DICOM geometry references:
[Image Plane Module](https://dicom.nema.org/medical/dicom/current/output/chtml/part03/sect_C.7.6.2.html)
and [Pixel Spacing Calibration Macro](https://dicom.nema.org/medical/dicom/current/output/chtml/part03/sect_10.7.html).
