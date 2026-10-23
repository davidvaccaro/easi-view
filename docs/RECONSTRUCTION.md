# Reconstruction foundation

Installed SDK users should start with the [embedding guide](EMBEDDING.md) and the viewer/SDK section below. Examples importing `src/` require a repository checkout; those internal modules are not npm exports.


`src/volume/index.js` provides a CPU numeric foundation for validated volume
assembly, patient-space sampling, reslicing, slab projection, parallel-ray
rendering and explicitly registered fusion. The standalone viewer and embedded SDK now provide an explicit derived workspace
using these modules. It does not infer registration, write derived DICOM instances
or claim clinical validation. The original 2D image renderer and stored samples
remain independent.

```js
import { Volume, validateVolumeGeometry, reslice } from './src/volume/index.js';

// Metadata validation happens before any frame request.
const plan = validateVolumeGeometry(series.frames);
const volume = await Volume.fromSeries(series, {
    signal: controller.signal,
    // Optional adapter to a host's frame broker; request one frame without prefetch.
    getFrame: (index, options) => series.getFrame(index, options),
    onProgress: ({ completed, total, bytes }) => updateProgress(completed, total, bytes)
});

try {
    const image = await reslice(volume, {
        rows: 256, columns: 256,
        origin: patientFirstPixelCenter,
        orientation: [1, 0, 0, 0, 1, 0],
        pixelSpacing: [1, 1] // Row, then column spacing in mm.
    }, { signal: controller.signal, interpolation: 'trilinear' });
    // Float64 modality values plus a validity mask; display is a separate step.
    presentDerivedImage(image.values, image.valid, image.unit);
} finally {
    volume.dispose();
}
```

## Open the derived workspace

Choose **Reconstruct** with a spatial stack active, or call:

```js
await viewer.openReconstruction({ viewport: 0 });
await viewer.setReconstruction({ projection: 'mip', thicknessMm: 10 });
await viewer.setReconstruction({ fourth: '3d', rayMode: 'composite' });
// For an explicitly registered, already loaded overlay series:
await viewer.setReconstructionFusion(1, {
  registration: suppliedRigidRegistration,
  mode: 'alpha', alpha: 0.5
});
await viewer.closeReconstruction();
```

The workspace shows axial, coronal and sagittal LPS planes, plus an oblique,
parallel-ray or registered-fusion fourth view. Position sliders choose a fraction
of the validated voxel-center bounds. Oblique yaw/pitch, physical slab thickness,
slice/MIP/minIP/mean, modality W/L, inversion and output resolution are explicit.
The default output grid is 192 pixels on its longest side, capped at 256, with
square physical pixels and aspect-preserving display. Patient bounds include all
eight affine corners, including regular gantry shear.

Derived planes keep Float64 modality values and validity masks. Only the display
is RGBA8; no second source rescale or observed-range data normalization is applied.
The derived workspace uses an explicit window, rather than the source VOI LUT.
Source polarity is preserved. Original image probes, annotations and patient
geometry remain unchanged when the workspace closes.

**Parallel3D** uses CPU parallel rays and explicit continuous grayscale/warm color
and opacity per sample. This is a bounded reconstruction profile, without
perspective camera or diagnostic tissue presets. Its probe reports ray color,
with no single-voxel intensity claim. Plane probes report derived modality values
and patient coordinates; fusion probes retain separate base/overlay values and
units. `probeReconstruction(view, column, row)` exposes this only on explicit
host request; automatic reconstruction events contain operational state.

Fusion requires an explicit row-major rigid matrix mapping base patient
coordinates into overlay patient coordinates. Different reference frames also
require matching `fromFrameOfReferenceUid` and `toFrameOfReferenceUid`; the UI
shows those identifiers for an explicit registration decision. It never aligns
prior studies automatically or mixes quantitative channels.

Committed and pending volumes share at most **128 MiB**, including the old volume
during replacement and a second fusion volume. Derived Float64/valid/RGBA outputs,
display canvases, staging and rollback-held images share a separate **8 MiB** cap.
Large replacements can require lowering output resolution or closing first.
Canvas resizing clears one axis before changing dimensions, so a wide/tall
reshape cannot briefly allocate an unadmitted larger backing store.
Source/encoded/decoded caches remain separate; these counters are not total
browser or GPU memory.

Assembly uses the same serial frame broker and one decoder worker; cine and
optional prefetch stop before explicit volume loading. Source replacement,
closure and disposal cancel owned work. The previous successful derived view
survives an invalid/canceled replacement. `getReconstructionState()` reports
dimensions, counts, progress, budgets and pending allocations, with no image UIDs
or coordinates. `closeReconstruction()` resolves after canceled allocation cleanup.
`dispose()` stays synchronous for framework lifecycle callbacks; after it, await
`whenDisposed()` to observe completion of pending cleanup. Until then, resource
snapshots retain truthful reservation/cleanup counters.

## Geometry and semantic gates

The source must contain 2–4,096 frames with explicit original `sopUid`/
zero-based `frameIndex`, the same valid nonempty Series and Frame of Reference
UIDs, modality and units. Samples per Pixel must be 1, with the same monochrome
photometric interpretation and signed/unsigned 8/16-bit stored-pixel layout.
An empty unit string is allowed and remains unknown; no physical intensity unit
is invented.

Every frame needs finite Image Position (Patient), valid orthonormal Image
Orientation (Patient) and positive physical Pixel Spacing. Missing geometry,
color/palette images, duplicate original frames or planes, changing in-plane
geometry, irregular slice steps and changing gantry shear reject. Enhanced
unknown/unresolved dimension indices and explicitly ineligible volumetric
properties also reject.

Classic `classicDimensions`/`syncDimensions` and enhanced `dimensions` retain
temporal, echo, acquisition, diffusion and component families. Exposed family
values must agree across the volume; time and echo indices never become slice
ordering. An invalid/unknown scope fails with a specific unsupported reason.
The plan's `semanticScope` reports `same-series-only`,
`classic-exposed-dimensions` or `enhanced-verified-dimensions`. A missing classic
scope is not proof that no hidden acquisition dimensions exist.

Archive metadata may omit classic scope fields that retrieved instances supply.
Nonempty metadata-supplied values must still agree; complete retrieved families
must match one another. If retrieval reveals different echoes, time points or
acquisitions, assembly fails. The completed volume reports the retrieved semantic
scope. Scope fields and small descriptors are snapshotted before async work, so
host mutation cannot redefine an already validated affine.

Frames sort by their patient-plane projection. `basisX` is the first orientation
vector times column spacing; `basisY` is the second vector times row spacing.
`basisZ` is the actual adjacent Image Position delta, including a regular
in-plane gantry shear. A full 3×3 inverse supports that shear; the third axis is
not replaced with the slice normal. The origin is the first transmitted voxel
center, and voxel coordinates `[0,0,0]` are center-based. Annotation image-edge
coordinates need their existing half-pixel conversion when used here.

Validation allows rounded direction cosines within 0.0001 of unit/orthogonal
constraints, in-plane consistency within 0.00001, and slice-position residuals
within the larger of 0.0001 mm or 0.1% of the normal slice interval. These are
numeric acceptance tolerances, not a claim about acquisition accuracy.

Declared Spacing Between Slices, when present, must match the normal adjacent
position interval. It can expose uniformly omitted slices. With no trusted
declared spacing, a uniformly subsampled lattice is indistinguishable from the
supplied complete regular lattice; the code does not claim to prove completeness.
Slice Thickness and Slice Location never replace position geometry. These
conventions follow the DICOM [Image Plane Module](https://dicom.nema.org/medical/dicom/current/output/chtml/part03/sect_C.7.6.2.html).

## Assembly, memory and cancellation

`Volume.fromSeries(series, { signal, getFrame, onProgress, maxBytes })` first
validates all descriptors and budgets. It then requests sorted source indices
sequentially: one requested frame at a time, with no reconstruction prefetch.
A broker adapter should disable its own speculative prefetch for this operation.
Retrieved identity, geometry, scalar layout, supplied modality transforms and
declared spacing are validated again.

Each voxel has distinct owned data:

| Buffer | Meaning | Bytes per voxel |
| --- | --- | --- |
| `storedSamples` | Original signed/unsigned integer, including original padding | 2 |
| `modalityValues` | Float64 value after that frame's Modality LUT or rescale | 8 |
| `valid` | Nonpadding validity | 1 |

The combined slab is capped at 128 MiB (11 bytes per voxel). Construction does not
retain decoded frame objects, source sessions, samples or presentation tables
after completion. Per-frame slope/intercept may differ and are applied to their
own samples. Pending metadata-only Modality LUT descriptors need matching,
complete retrieved tables. No VOI, window, display inversion or observed-range
normalization changes these quantitative values.

Padding is preserved in `storedSamples`, excluded in `valid`, and represented
by NaN in `modalityValues`. Nonfinite modality results or stored integers outside
Bits Stored fail explicitly. Buffer views belong to the volume and must be
treated as read-only by the host; mutating them bypasses these invariants.

The slab limit is per volume. Source/decoder caches, bounded descriptor scratch,
derived images and a second fusion volume have their own allocations; the host
must manage their combined lifetime/budget. `dispose()` drops all three owned
slabs and prohibits further sampling. It leaves source/cache lifetimes with the
host.

Assembly and output kernels yield in bounded work batches and honor AbortSignal.
A canceled pending broker request rejects promptly and ignores its late result;
the underlying provider also receives the signal. Errors/cancellation dispose
an unfinished volume and never publish partial derived output. Progress events
contain only completed/total counts and allocated bytes; host observer failures
cannot change a committed copy.

## Sampling and derived planes

`volume.voxelToPatient([x,y,z])` and `volume.patientToVoxel([px,py,pz])` invert the
full affine. `sampleVoxel` and `samplePatient` accept:

```js
{ interpolation: 'nearest' | 'trilinear', domain: 'modality' | 'stored' }
```

The default is trilinear modality sampling. Sampling supports the center lattice
from 0 to size−1 on each axis; it does not extrapolate beyond it. A tiny 1e−8 voxel
boundary allowance clips inverse-affine roundoff. Nearest ties use JavaScript
`Math.round`. Trilinear interpolation returns NaN if any positive-weight neighbor
is padding/invalid; it does not renormalize across holes. Zero-weight neighbors
do not invalidate an exact center/edge sample. `storedAt(x,y,z)` explicitly reads
an original integer, including padding, at an in-bounds integer voxel index.

`reslice(volume, plane, options)` is async and supports arbitrary valid
orthogonal or oblique patient planes. A plane contains rows, columns, physical
row/column Pixel Spacing, six orientation direction cosines and `origin`, the
first output pixel center. It returns Float64 `values`, Uint8 `valid`, normalized
plane geometry, units, projection parameters and byte count.

Options select `projection: 'slice' | 'mip' | 'minip' | 'mean'`, interpolation,
domain, signal and output byte budget. A slice uses thickness 0/samples 1. A slab
uses an explicit positive `thicknessMm` and 2–1,024 samples across both endpoints
of the symmetric normal interval. A single-sample slab is allowed only at
thickness 0. MIP/minIP/mean include only finite samples; mean is the arithmetic
mean of those samples, not a continuous integral or a density-weighted average.
Wholly empty output pixels remain NaN/invalid.

## Parallel rays and explicit color transfer

`raycast(volume, plane, options)` is an async CPU reference. It uses parallel
patient-space rays and an explicit `nearMm`, `farMm` and positive `stepMm`.
`rayDirection` defaults to the plane normal. Rays sample near+n×step while the
distance is≤far; an off-grid far endpoint is not appended. Missing/padding
samples contribute nothing.

```js
const image3d = await raycast(volume, cameraPlane, {
    nearMm: 0, farMm: 100, stepMm: 1,
    mode: 'composite', // Or mip, minip, mean.
    transferFunction: value => [red(value), green(value), blue(value), opacity(value)]
});
```

A transfer function must return normalized RGB or RGBA channels in [0,1]. RGB
implies opaque alpha. Composite mode uses front-to-back premultiplied accumulation
and returns straight Uint8Clamped RGBA; it can terminate at the explicit
`terminationAlpha` (default 0.999). Alpha is per sample at the selected step;
there is no hidden opacity-per-millimetre adjustment. Projection modes first
compute a quantitative scalar MIP/minIP/mean and then apply the transfer function.
An empty ray is transparent. This reference supplies no inferred tissue preset,
lighting, surface extraction or perspective camera.

## Explicit registered fusion

```js
const fusion = createFusion(baseVolume, overlayVolume, {
    registration: {
        // Row-major rigid 4×4: base patient coordinate -> overlay patient coordinate.
        matrix,
        fromFrameOfReferenceUid: baseVolume.geometry.frameOfReferenceUid,
        toFrameOfReferenceUid: overlayVolume.geometry.frameOfReferenceUid
    }
});
const pair = fusion.samplePatient(patientPoint); // { base, overlay }, units stay distinct.
const image = await renderFusion(fusion, plane, {
    mode: 'alpha', alpha: 0.5, // Or checkerboard with explicit checkerSize.
    baseTransferFunction,
    overlayTransferFunction
});
fusion.dispose(); // Leaves both volumes alive.
```

Even matching Frame of Reference UIDs require an explicitly supplied matrix;
the code never creates an identity registration implicitly. Different FoRs also
require matching source/target identifiers. Validation permits a proper rigid
rotation/translation only, rejecting scale, shear, reflection, perspective and
nonfinite values. Matrix direction/order is explicit, consistent with DICOM's
row-major [Spatial Registration Module](https://dicom.nema.org/medical/dicom/current/output/chtml/part03/sect_C.20.2.html);
this API does not parse a DICOM registration object or validate the clinical
correctness of a supplied registration.

Alpha display blends explicit transfer colors with overlay opacity scaled by
`alpha`. Checkerboards alternate in output-pixel tiles and keep a missing chosen
sample transparent. The result retains separate Float64 `baseValues`/
`overlayValues`, masks and units; raw values from different modalities are never
added or averaged. Both volumes must stay alive until fusion work finishes.

## Hard operation ceilings and current limits

| Resource | Ceiling |
| --- | --- |
| Volume stored+modality+mask slabs | 128 MiB; configurable lower |
| Source frames | 4,096; at least 2 |
| Source image grid | 8,192 per axis; 16 megapixels per frame |
| Derived grid | 4,096 per axis |
| Derived buffers per operation | 32 MiB; configurable lower |
| Reslice storage | 9 bytes per output pixel |
| Raycast storage | 4 bytes per output pixel |
| Fusion storage | 22 bytes per output pixel |
| Sampling work per derived operation | 16,777,216 samples |
| Samples in a slab | 1,024 |
| Steps in a ray | 4,096 |

Independent synthetic tests cover analytic linear fields, rotated/sheared
affines, anisotropic spacing, per-frame rescale/LUTs, padding, scope mismatches,
registration direction, projection/compositing values, budgets, cancellation
and disposal. Irregular geometry is rejected rather than resampled into an
invented source lattice. Color volumes, deformable/scaled registration, unknown
dimension families, segmentation/RT structure reconstruction, GPU acceleration,
clinical specialty presets and the reconstruction UI remain separate work.
