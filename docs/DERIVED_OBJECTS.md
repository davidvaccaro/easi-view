# Restricted derived-object foundation

Installed SDK users should start with the [embedding guide](EMBEDDING.md) and the viewer/SDK section below. Examples importing `src/` require a repository checkout; those internal modules are not npm exports.


`src/derived/index.js` supplies bounded local EASI JS adapters, source-scoped
AI/SEG overlays, restricted SR/GSPS imports and explicit versioned JSON results.
It does not change the native image allowlist, install an overlay UI, upload
data, follow BulkDataURI, infer registration, or claim general DICOM conformance.
Unsupported profiles reject instead of being partially interpreted as a complete
presentation/report.

| Capability | Current verified profile |
| --- | --- |
| SEG import | Segmentation Storage `.66.4`; native BINARY1 or FRACTIONAL8; exact source-frame grid |
| AI overlays | Binary Uint8, fractional Uint8 with declared maximum/type, or Float32 probability samples |
| SR import | Enhanced/Comprehensive SR `.88.22`/`.88.33`; untemplated by-value CONTAINER→NUM→SCOORD POLYLINE→IMAGE |
| GSPS import | `.11.1`; one monochrome source frame; full-grid SCALE TO FIT; PIXEL polylines/axis-aligned simple ellipses; explicit window/polarity |
| Result export | Versioned bounded JSON for overlays and restricted SR/GSPS results |
| DICOM object export | Pending independent complete-IOD validation; no clinical SEG/SR/GSPS writer is exposed |

## Local parsing and explicit source resolution

```js
import { readDerivedInstance, importSeg, OverlayStore } from './src/derived/index.js';

const instance = await readDerivedInstance(file, { signal }); // Local Blob or bytes.
const result = await importSeg(instance, {
    signal,
    resolveSource: async (sopUid, frameNumber, { signal }) => {
        // Return the exact original decoded frame or metadata descriptor from the host.
        // Supply known numberOfFrames/frameCount when frameNumber is null.
        return resolveOriginalFrame(sopUid, frameNumber, signal);
    },
    consumePixelData: true // Explicitly release the derived SEG's raw pixel backing store.
});
const overlays = new OverlayStore();
for (const mask of result.overlays) overlays.add(mask);
const rgba = await overlays.render(currentFrame, { signal, alphaMode: 'straight' });
```

`readDerivedInstance` uses the published EASI pipeline's `toInstances()` output,
with a bounded streaming reader and materialization cap. Input is local
Uint8Array/ArrayBuffer/Blob; URLs are rejected. Exactly one instance is required.
The existing EASI library is neither forked nor modified. Supported text is
default ASCII or explicitly declared UTF-8 (`ISO_IR 192`); other character sets
reject.

References contain a SOP Class/Instance UID and original one-based frame number.
`resolveSource(sopUid, frameNumber, { signal })` is a host callback, not an
implicit network lookup. The returned frame must identify the same SOP and
zero-based original `frameIndex`; a supplied source SOP Class also must match.
Missing Referenced Frame Number is supported only when returned metadata
explicitly declares `numberOfFrames: 1` or `frameCount: 1` and original frame0.
The callback receives null for that case. Unknown/all-frame multiframe references
reject instead of guessing frame1.

The host controls resolver/cache lifetimes and supplies cancellation. Late
resolutions after cancellation are ignored. Imports complete before any store
commit; an error does not publish partial masks/documents. Original image
samples are never read or changed by overlay rendering.

## Native SEG packing and exact binding

Binary SEG has Samples per Pixel1, MONOCHROME2, unsigned representation,
Bits Allocated/Stored1 and High Bit0. Fractional SEG uses unsigned8-bit samples,
Bits Stored8 and High Bit7, a declared maximum from1 to255, and either
`PROBABILITY` or `OCCUPANCY`. Values above the declared maximum reject.
LABELMAP/compressed SEG are outside this profile.

Native implicit LE, explicit LE and explicit BE are supported. OB octets are
byte-order independent; OW words use the transfer syntax byte order. Binary
frames are continuously packed least-significant-bit first: a later frame can
start in the middle of a byte/word. There is no individual-frame padding. Only
the complete Pixel Data value gets an even-byte extension. Exact encoded length
is validated; unused final bits/pad bytes are ignored and not assumed zero.
These rules follow [PS3.5 pixel encoding](https://dicom.nema.org/medical/dicom/current/output/chtml/part05/chapter_8.html)
and the [SEG Image Module](https://dicom.nema.org/medical/dicom/current/output/chtml/part03/sect_C.8.20.2.html).

Segment numbers are unique; every frame references a declared segment. The
segment's short codes, category/type, label and algorithm description are
preserved. CIELab recommendations are retained as coded values, without guessing
an RGB conversion. The host chooses configurable display colors/opacity.

Each SEG frame requires one source image, `Spatial Locations Preserved: YES`,
the same explicit Frame of Reference UID, matching rows/columns and complete
patient position/orientation/spacing. Geometry must be numerically identical to
the resolved source grid. A nearest-plane match, resized mask, flipped grid or
tiny position shift does not bind. Registered/resampled mask binding remains
separate work. Duplicate segment/source-frame pairs reject.

`consumePixelData` defaults false and must be boolean. When explicitly true, a
successful import clears only the derived SEG instance's raw Pixel Data via
EASI's public attribute method. Returned mask arrays remain owned and exact;
original referenced medical-image samples and metadata remain untouched.

## Owned overlay model and rendering

An overlay contains id, scoped image reference, kind, owned values, declared
maximum/fractional type, opacity, RGB color and source (`ai`/`seg`). SEG records
also retain their segment description and exact grid geometry. Unknown patient,
host, source URL or raw-image-pixel fields are rejected. Image references use
the same one-based original-frame convention as annotations.

```js
overlays.add({
    id: 'prediction-1', image: createImageReference(frame),
    kind: 'probability', values: probabilities, // Float32Array or normalized numeric array.
    opacity: 0.4, color: [255, 90, 30], source: 'ai'
});
overlays.updateStyle('prediction-1', { opacity: 0.6, color: [80, 180, 255] });
const metadata = overlays.listDescriptors(); // No large sample copies.
const pixels = await overlays.render(frame, { alphaMode: 'premultiplied' });
```

Binary values must be0/1. Fractional values are integer samples bounded by the
declared maximum; probabilities are normalized to Float32 in[0,1]. This is an
explicit Float32 mask format, not a promise to retain arbitrary Float64 decimal
precision. Original DICOM samples are a separate representation.

`add`, `get` and `list` return copies. `updateStyle` shares the store's validated
mask allocation and returns only `{ id, opacity, color }`. It does not recopy a
large mask during each opacity slider update. `listDescriptors` and store-owned
`render` likewise avoid unnecessary mask copies. The standalone
`renderOverlayRgba(overlays, frame, options)` validates and owns input snapshots.

RGBA rendering validates SOP/original frame/geometry scope, normalizes opacity
by mask maximum and composites in explicit insertion/list order. `alphaMode`
declares straight or premultiplied channels; empty pixels are transparent.
Rendering yields in bounded batches and supports cancellation. A disposed store
cannot finish pending store rendering. `dispose` clears masks/subscriptions;
it does not dispose the source image or a caller-held returned copy.

`subscribe` receives only count/byte totals. Host callback failures are isolated.
`remove`, explicit JSON import/export and replacement are supported. Merge
collisions, invalid later records, count/byte limits and conflicting source grids
reject atomically. There is no automatic persistence or transport.

## Restricted SR and GSPS semantics

SR import accepts a separate root CONTAINER with direct NUM children, one
DS Numeric Value and a short coded concept/unit. Units are explicitly limited
to UCUM mm, cm, mm2, cm2, deg,1 and%. One inferred SCOORD POLYLINE selects one
IMAGE source. Values are reported as encoded; no length/angle is guessed from a
concept label or recomputed from the graphic. Open polylines and simple closed
polygons are retained as graphics.

Templates (including TID1500), by-reference content, nested observation trees,
alternate floating/rational values, qualifiers, multiple image targets,
SCOORD3D, tiled VOLUME coordinates and unsupported units/types reject. This is
an exact small import profile, not a TID1500 implementation or general SR reader.
[SCOORD](https://dicom.nema.org/medical/dicom/current/output/chtml/part03/sect_C.18.6.html)
uses image-edge coordinates with `(0,0)` at the first pixel's top-left edge.

GSPS PIXEL graphics use that same image-edge origin. The Displayed Area module
instead uses one-based pixel indices: full-frame TLHC is `[1,1]` and BRHC is
`[columns,rows]`. The importer does not shift graphic coordinates by one.
It supports only full-frame SCALE TO FIT with source-compatible aspect/spacing,
identity rotation/flip, outline polylines and simple axis-aligned four-axis-point
ellipses. Ellipse axis-center agreement allows1e−5 pixel FL rounding while
preserving all original points. Graphic layers retain order/grayscale P-values.

Crop/true-size/magnification, different calibration, display/matrix coordinates,
compound/free-text/filled graphics, slanted ellipses, color layer recommendations,
shutters, bitmap overlays, mask subtraction, LUTs and unsupported transforms
reject. A supported explicit window can use LINEAR, LINEAR_EXACT or SIGMOID.

GSPS transformations replace image transformations. Source MONOCHROME1 polarity
must not be added again; returned `presentationInvert` is the absolute
IDENTITY/INVERSE result. The first profile requires PS rescale equal to source
rescale, or both to be identity. An absent PS rescale never silently falls back
to a nonidentity source transform. Applying results to a viewport remains a
separate explicit host action. These conventions follow the
[Displayed Area Module](https://dicom.nema.org/medical/dicom/current/output/chtml/part03/sect_C.10.4.html),
[Graphic Annotation Module](https://dicom.nema.org/medical/dicom/current/output/chtml/part03/sect_C.10.5.html)
and [PS3.4 presentation pipeline](https://dicom.nema.org/medical/dicom/current/output/chtml/part04/sect_N.2.html).

## JSON results and resource ceilings

`OverlayStore.export()`/`exportJson()` and `import()` use
`easi-view.overlays`, version1, `coordinateSystem: 'image-grid'` and
`frameNumberBase: 1`. Float32/probability and binary/fractional values serialize
as explicit numeric arrays. JSON expansion has its own byte cap/preflight.

`exportDerivedResults([srResult, gspsResult])` and `importDerivedResults(text)`
use `easi-view.derived-results`, version1, `coordinateSystem: 'image-edge'` and
the same frame-number base. Known values, coded concepts/units, source references,
graphics and supported presentation instructions roundtrip. Unknown fields,
changed graphic semantics and unsupported versions reject.

Exports omit Patient Module fields, arbitrary host metadata, source URLs and
original image pixels. They contain necessary image/document UIDs, coordinates,
clinical segment labels/codes and derived results. They are not anonymizers;
the host must treat exported medical results appropriately. Nothing exports or
uploads automatically.

| Resource | Hard ceiling |
| --- | --- |
| Local DICOM input/materialized bulk | 64 MiB; configurable lower |
| Expanded SEG masks | 64 MiB; configurable lower |
| SEG frames/segments | 4,096 /256 |
| Image grid | 8,192 per axis; 16 megapixels |
| Overlay stored samples+metadata | 64 MiB; configurable lower |
| Stored overlays /overlays per image | 1,000 /64 |
| RGBA output /mask-input snapshots | 64 MiB each |
| Pixel×overlay rendering work | 16,777,216 samples |
| SR measurements or GSPS graphics | 1,000 |
| Graphic control points | 128; closed polygon may include repeated closure |
| Restricted result JSON | 1 MiB; configurable lower;32 documents/1,000 total records |
| Dataset structure | Depth12;32,768 sequence items;65,536 attributes |

These are per-operation/model limits, not a combined JavaScript heap guarantee.
The host manages input instances, exported/caller copies, caches and active
outputs together. Independent native encoders and the published EASI writer
roundtrip synthetic datasets in tests, including BE OW/OB, unaligned binary
frames, fractional maxima, coordinate origins, cancellation and malformed input.
Those fixtures validate this restricted reader/model profile; they are not a
complete-IOD validator. Complete clinical DICOM export and broader interchange
remain separate work with required metadata and independent validation gates.

## Standalone viewer and installed SDK

The inspector's Derived Objects section imports local SEG/SR/GSPS files or the versioned JSON schemas. Open the referenced source images first. Masks have visibility, opacity and tint controls. SR values are explicitly reported values. GSPS needs its referenced image displayed and an explicit Apply action; reset removes that pane's GSPS display/graphics. JSON exports contain references and derived results and should be handled as image-associated data. No local file is uploaded.

```js
await viewer.importDerived(localSegFile, { signal });
// Bind an actual model's output to the active original image grid.
viewer.addOverlay({ kind: 'probability', values: inference.probabilities, opacity: 0.45, color: [0, 200, 160] });
const overlayJson = viewer.exportOverlays();
await viewer.importDerived(localPresentationFile);
await viewer.applyPresentation(0); // Explicit document index, verified source image.
const reportedJson = viewer.exportDerivedResults();
```

`getDerivedState()` and events expose operational counts, not image identifiers or mask arrays. Explicit exports expose the requested data. Model import completion precedes asynchronous overlay painting; masks render when their exact source frame is displayed. The viewer owns 32MiB of overlay model data and a separate shared 32MiB budget for mask bitmaps, staging, display and rollback. These nominal counters are not a total browser heap guarantee.
