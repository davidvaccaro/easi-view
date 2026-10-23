# Specialty processing foundations

Installed SDK users should start with the [embedding guide](EMBEDDING.md) and the viewer/SDK section below. Examples importing `src/` require a repository checkout; those internal modules are not npm exports.


These modules provide five restricted, independently tested processing profiles.
They do not claim complete cardiology, breast, radiotherapy, or pathology viewer
support. They are separate from the main image reader and its safety checks;
in particular, active XA subtraction remains rejected by ordinary image opening.
The standalone Specialty action and installed SDK integrate the supported local research profiles.

| Profile | Functional output | Explicit boundary |
| --- | --- | --- |
| Cine timing | Original-frame trim, loop/sweep sequence, acquisition times and playback schedule | No ECG phase inference, synchronized waveforms, audio or motion codecs |
| Classic XA `AVG_SUB` | Signed Float64 contrast-average minus mask-average values | Native unsigned MONOCHROME2; zero mask shift only; no TID, LOG/LUT conversion or enhanced XA |
| Breast metadata | Coded CC/MLO classification and a four-slot layout with ambiguous/missing states | One study; full, unmodified, single-frame presentation images; no inferred flips, priors or tomosynthesis |
| RT Dose | Original unsigned16/32 words, scaled physical dose planes and patient-space sampling | Native PHYSICAL GY/RELATIVE; no dose accumulation, DVH, plan interpretation or implicit registration |
| Whole-slide index | Visible-region tile references and exact slide/pixel coordinates | One TILED_FULL VOLUME instance, focal plane and optical path; metadata only |

## Reading through EASI JS

```js
import {
    readSpecialtyInstance, readSpecialtyMetadata,
    normalizeCine, createXaSubtraction, DoseGrid, createSlideIndex
} from './src/specialties/index.js';

// Local bytes or Blob: EASI streams the native DICOM dataset into its model.
const instance = await readSpecialtyInstance(file, { signal });

// Local DICOM JSON metadata: InlineBinary is rejected before the EASI adapter.
// BulkDataURI is retained as metadata and is never followed by this reader.
const slideMetadata = await readSpecialtyMetadata(dicomJson, { signal });
const slide = createSlideIndex(slideMetadata);
```

The binary reader reuses the bounded derived-object EASI pipeline. It materializes
native Pixel Data needed by the XA or dose processor, with a 64 MiB input cap.
The metadata reader accepts a JSON object or JSON text with an 8 MiB cap. Neither
reader accepts a URL, performs a fetch, uploads files or changes the EASI runtime.
Processors accept published EASI `Instance`/`DataSet` objects, not custom parser
substitutes. The profile validators do not validate every required attribute of
a complete clinical IOD.

## Cine trim and timing

```js
import { normalizeCine, frameAtTime, nextCineFrame } from './src/specialties/index.js';

const plan = normalizeCine(instance);
const request = frameAtTime(plan, elapsedPlaybackMs);
const frame = await frameBroker.getFrame(request.frameIndex, { signal });

// Explicit manual playback speed; original acquisition times remain separate.
const manual = normalizeCine(instance, { manualRateFps: 25 });
```

`Start Trim` and `Stop Trim` are one-based DICOM frame numbers. Returned indices
remain zero-based original frame indices. Preferred Playback Sequencing selects
loop or sweep. Sweeping does not repeat terminal frames. Frame Time requires its
matching Frame Increment Pointer; Frame Time Vector requires one zero first
increment followed by positive intervals and exactly one value per frame.
Frame Delay contributes to `acquisitionTimesMs`.

Playback timing precedence is an explicit manual override, Recommended Display
Frame Rate, then the pointed acquisition timing. Cine Rate alone is not treated
as proof of acquisition timing. `timing` records the selected provenance.
`physiologicalPhase` remains null. Manual timing can supply absent acquisition
timing but cannot bypass malformed declared metadata.

For vector timing, sweep intervals are the traversed acquisition intervals. A
loop has no transmitted interval from its final frame back to its first;
`closurePolicy: 'repeat-last-interval'` states that playback convention explicitly.
A one-frame trim is static. Plans are immutable, bounded to 4096 source frames,
and contain no pixel buffers. The host owns playback scheduling, cancellation
and frame-broker policy.

The definitions come from [DICOM PS3.3 Cine Module](https://dicom.nema.org/medical/dicom/current/output/chtml/part03/sect_C.7.6.5.html).

## Classic average subtraction

```js
const source = await createXaSubtraction(instance, { signal });
try {
    const result = await source.subtract(contrastFrameIndex, { signal });
    // result.values is Float64 and can be negative. Source samples are unchanged.
    showDerivedScalar(result.values, result.rows, result.columns);
} finally {
    source.dispose();
}
```

Only classic XA Storage with unsigned 8/16 MONOCHROME2 and Bits Stored 8/10/12/16
is accepted. Stored samples are copied into owned storage, with unused upper
bits excluded. Modality rescale must be identity. LIN and DISP describe the
stored intensity relationship; its sign is preserved as metadata and does not
cause inversion or logarithmic processing.

One Mask Subtraction Sequence item must specify `AVG_SUB`. One-based mask frame
numbers are unique, within bounds, and averaged. Contrast Frame Averaging defaults
to one; the frames beginning at the requested original frame are averaged, then
the mask average is subtracted. Applicable ranges are inclusive and nonoverlapping;
absent ranges end at the last valid contrast-averaging start. The module rejects
nonzero mask shifts instead of inventing interpolation or a shift direction.

The output unit is `stored-intensity difference`, with operation provenance
`contrast-average-minus-mask-average`. This is not an attenuation, dose or flow
measurement. No display shutter or presentation state is applied. LOG/LUT
relationships, modality transforms, padding and enhanced functional groups are
unsupported. Numeric outputs retain source SOP/original-frame references.

Masks and contrast averages are capped at 128 frames each. A result is bounded to
16 million averaging operations. The owned source, mask average and one result
must fit the chosen working budget, at most 64 MiB. `storedFrame()` returns a copy;
`dispose()` releases owned buffers and invalidates outstanding yielded processing.

The operation follows [DICOM PS3.3 Mask Module](https://dicom.nema.org/medical/dicom/current/output/chtml/part03/sect_C.7.6.10.html).

## Breast view layout

```js
import { normalizeBreastImage, createBreastLayout } from './src/specialties/index.js';

const images = instances.map(normalizeBreastImage);
const layout = createBreastLayout(images);
// Slot order: R-CC, L-CC, R-MLO, L-MLO. No image is flipped by this plan.
for (const slot of layout.slots) {
    if (slot.status === 'ready') assignViewport(slot.row, slot.column, slot.image);
}
```

Classification uses Image Laterality and coded View Code Sequence, including
current SCT and legacy SRT/SNM3 CC/MLO codes. It never matches Code Meaning or
filenames. Conflicting laterality or presentation intent is invalid. Bilateral,
modified, partial, unknown-extent, processing-only and unrecognized-view images
remain unassigned with explicit reasons. A ready slot requires Partial View NO
and no modifier/partial-view codes. Missing slots stay missing; duplicates remain
ambiguous with candidate references, rather than selecting an arbitrary image.

This plan has at most 256 images from one explicit Study. Prior studies require
separate plans. Image orientation remains unchanged; this is a deterministic
layout suggestion, not a DICOM Hanging Protocol importer, clinical display
protocol or mammography image-processing implementation. Coded anatomical
laterality modifiers are rejected until their separate consistency rules are
implemented.

Metadata follows [DICOM PS3.3 Mammography Image Module](https://dicom.nema.org/medical/dicom/current/output/chtml/part03/sect_C.8.11.7.html)
and the [PS3.16 mammography view code group](https://dicom.nema.org/medical/dicom/current/output/chtml/part16/sect_CID_4014.html).

## Native RT Dose grid

```js
const dose = await DoseGrid.fromInstance(instance, { signal });
try {
    const plane = await dose.frameValues(originalFrameIndex, { signal });
    const value = dose.samplePatient(patientPointMm, {
        interpolation: 'trilinear',
        frameOfReferenceUid: knownPointFrameOfReferenceUid
    });
    // dose.geometry.units is GY or RELATIVE. RELATIVE never becomes Gy implicitly.
} finally {
    dose.dispose();
}
```

Stored samples remain separate from `stored * Dose Grid Scaling`. The accepted
profile is native unsigned 16/32 PHYSICAL MONOCHROME2, Bits Stored equal to Bits
Allocated, High Bit one less, positive scaling and explicit GY/RELATIVE units.
Unsupported coded units, ERROR/EFFECTIVE dose, modality/padding transforms and
spatial registration requirements reject. Dose Summation Type is retained as
metadata; this module does not interpret a treatment plan.

Grid Frame Offset Vector has exactly one value per frame and strictly monotonic
plane positions. Relative offsets begin at zero and follow the orientation
normal. The legacy absolute-patient-Z encoding is accepted only with exact
transverse orientation and its first offset equal to the first Image Position Z.
Ascending or descending, nonuniform spacing is preserved; no regular spacing is
inferred from Slice Thickness.

`gridToPatient()` maps center-based column/row coordinates and an original frame
index. `patientToGrid()` returns column, row and physical offsetMm.
`samplePatient()` uses nearest or trilinear interpolation over the actual planes,
returns NaN outside the transmitted center lattice, and rejects a supplied
mismatched Frame of Reference. A point without a supplied FoR is understood to
already be in the dose grid's FoR; this is caller responsibility. No registration
is inferred, and dose is never combined with another image automatically.

Native 32-bit OW cells are decoded least-significant word first; Big Endian changes
the byte order within each 16-bit word. Original 32-bit unsigned values above the
signed range are retained. Storage and one Float64 output plane share the 64 MiB
working budget. Native source buffers remain caller owned and unchanged.

The definitions are in [DICOM PS3.3 RT Dose Module](https://dicom.nema.org/medical/dicom/current/output/chtml/part03/sect_C.8.8.3.html),
[dose offset encoding](https://dicom.nema.org/medical/dicom/current/output/chtml/part03/sect_C.8.8.3.2.html),
[dose pixel specialization](https://dicom.nema.org/medical/dicom/current/output/chtml/part03/sect_C.8.8.3.4.html)
and [PS3.5 native pixel encoding](https://dicom.nema.org/medical/dicom/current/output/chtml/part05/sect_8.2.html).

## Whole-slide tile index

```js
const slide = createSlideIndex(slideMetadata);
const tiles = slide.tilesInRegion({ column: 100, row: 200, width: 512, height: 512 });
for (const tile of tiles) {
    // Host explicitly requests only these original frame numbers.
    requestTileFrame(slide.metadata.sopUid, tile.frameNumber);
}
const slidePoint = slide.pixelToSlide([columnCenterIndex, rowCenterIndex]);
// {xMm, yMm, zUm}; units remain explicit.
```

One single-instance TILED_FULL VOLUME layer, one explicit focal plane and optical
path are required. Exact Number of Frames must equal the complete tile grid.
Frame order varies across columns, then rows. Row/column starts are exposed both
as zero-based pixel-center indices and one-based DICOM matrix positions. Edge
tile descriptors distinguish full encoded dimensions from the clipped valid
matrix extent. No pixels are read, copied, decoded, rendered or fetched by
index construction or region queries.

Total Pixel Matrix origin is the first pixel center. Pixel Spacing is expressed
in millimetres; slide X/Y coordinates use millimetres while Z offsets use
micrometres. Rotated in-plane, right-handed slide geometry is supported. Tilted
planes reject rather than mix those units. The declared imaged extent must match
the full matrix spacing. Queries are half-open pixel-edge rectangles and are
clipped to the indexed matrix; coordinate conversion uses pixel-center indices.

Sparse tiles, concatenations, multiple optical/focal planes, explicit per-frame
groups, labels/overviews and pyramid navigation are outside this profile.
Pixel metadata is checked for consistency but does not claim codec or color
management support. The index has at most 4096 frames and a region query defaults
to at most 1024 returned tile references, checked before allocation.

See [DICOM PS3.3 tiled frame ordering](https://dicom.nema.org/medical/dicom/current/output/chtml/part03/sect_C.7.6.17.3.html),
[whole-slide metadata](https://dicom.nema.org/medical/dicom/current/output/chtml/part03/sect_C.8.12.4.html)
and [slide coordinates](https://dicom.nema.org/medical/dicom/current/output/chtml/part03/sect_C.8.12.6.html).

## Validation and lifetime

All tests use generated synthetic data and independent numeric references.
Native binary fixtures cover implicitLE, explicitLE and explicitBE, odd-width
frame packing, uint32 high-bit values, nonuniform/rotated dose grids, signed
subtraction and exact tile ordering. Cancellation checks exercise yielded work,
and disposal invalidates subsequent requests. No original medical files are
included or uploaded.

Limits apply to each owned processor and one output operation, not the combined
heap of caller input, EASI models, multiple concurrent operations and retained
result arrays. The host must bound those lifetimes separately. Specialty results
contain necessary image references and are not anonymized exports. The modules
perform no external telemetry and make no clinical or regulatory claims.

Run `node --test test/specialties*.test.js` from the project root.

## Standalone viewer and SDK

Choose **Specialty** to open explicit local DICOM or DICOM JSON files. The separate modal keeps original pixels and primary viewer behavior intact. Dose/subtraction previews use explicit display windows and quantitative probes. Breast/slide outputs are manifests/indexes; ordinary cine exposes declared timing rather than ECG or new pixel rendering.

```js
await viewer.openSpecialtyFiles([localDoseFile], { signal });
await viewer.setSpecialty({ window: { center: 20, width: 40 } });
await viewer.setSpecialtyFrame(0); // Original zero-based frame.
const dose = viewer.probeSpecialty(10, 10);
const report = viewer.exportSpecialtyReport(); // Explicit <= 1MiB JSON string.
await viewer.closeSpecialty();
```

The model, selected derived plane, stored plane, Canvas/ImageData, input/parser scratch, pending replacement and rollback share one 64MiB nominal budget. Close cancels and awaits owned cleanup. Playback pauses on document hiding/page suspension and viewer disposal. Default state/events contain operational counts only; requested probes and explicit report exports contain the requested image-associated values/references. No backend or browser storage is used.
