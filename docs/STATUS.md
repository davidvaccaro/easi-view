# Supported profile and validation status

Version **0.1.0-alpha.0** starts the owned-engine foundation and 2D alpha phases.
It is a functioning research viewer. It does not yet complete the P1 or general
viewer 1.0 exit gates.

## Implemented

| Area | Current behavior |
| --- | --- |
| Sources | Browser File/Blob, multiple local files/folder, HTTP(S) DICOM and multipart DICOM response |
| Parsing | Published EASI JS 1.0.0 pipelines; encoded native pixels retained within a source limit |
| Native syntax | Implicit VR Little Endian, Explicit VR Little Endian, Explicit VR Big Endian |
| Pixel profile | 8/16-bit native MONOCHROME1/2; signed/unsigned stored values; validated Bits Stored/High Bit |
| Presentation | Linear rescale; LINEAR/LINEAR_EXACT windows; padding; inversion; scalar probe values |
| Geometry | Classic image-plane position/orientation; consistent spatial sorting; incompatible/incomplete geometry split into separate stacks |
| Rendering | Independently implemented WebGL2 scalar-texture renderer, Canvas2D reference/fallback, GPU disposal/context recovery |
| Tools | Window, pan, zoom, rotate, horizontal flip, invert, reset, probe and calibrated two-point distance |
| Frames | Slider, keyboard/scroll navigation, fixed-rate cine and visibility/source-switch pause |
| Runtime | Lazy worker decode, active/queued cancellation, 64 MiB byte-budgeted decoded LRU cache per source session |
| Workspace | One viewport, series selection, technical image inspector, source progress/error handling |
| Demos | Generated CT 16-image stack, MR 12-image stack, XR projection image, US 24-frame cine |

The object-class allowlist covers selected classic CT, MR, projection, US and
secondary-capture image classes only when they satisfy this pixel/presentation
profile. A recognized modality alone does not establish compatibility.

## Explicit limits

Each input operation accepts at most **256 MiB of received source bytes**.
A frame accepts at most **16 megapixels**, each dimension at most 8192 pixels;
the GPU may impose a smaller texture limit. At most 4096 frames per instance
are accepted. These are implementation limits rather than clinical guidance.

Cache size counts decoded scalar arrays, not complete browser-process memory.
The visible frame, worker transfer, parser backing storage and GPU texture need
additional memory. Replacing a source temporarily retains the previous successful
source so a failed new source can roll back. Therefore old and new input/cache
storage can overlap. These caps do not imply a 256 MiB total process-memory ceiling.

Pixel Spacing calibrates distance in the image plane; without it, distance is
labeled in pixels. Unsupported non-square Pixel Aspect Ratio without applicable
spacing is rejected. The viewer does not infer patient calibration from detector
spacing or claim specialized ultrasound-region calibration.

## Deferred and rejected rather than approximated

- Compressed transfer syntaxes and codec providers, including JPEG, JPEG-LS,
  JPEG2000, RLE and HTJ2K.
- Color/palette data, 1-bit/32-bit/float pixels and unsupported object classes.
- Enhanced shared/per-frame functional groups and variable Frame Time Vector.
- Modality/VOI LUT sequences, real-world value mappings, nonlinear SIGMOID VOI,
  and unsupported presentation LUT transforms.
- Archive search/authentication, metadata-only or rendered-image retrieval,
  persistent annotations and DICOM result export.
- Multiple viewports, priors, hanging protocols, MPR, 3D, fusion, SEG/SR/GSPS,
  enterprise workflows and specialty applications.

The alpha reports these limits instead of silently displaying an approximate
image. A static browser cannot directly open a DIMSE TCP association; a separately
configured gateway remains future integration work.

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
Cross-browser/device and live-archive conformance gates remain future work.
No comparison to competitors' speed or clinical/regulatory claim follows from
these tests.

Initial local verification on 2026-10-13: **65 automated tests** and **31 browser
integration groups** passed, with zero uncaught browser exceptions or console
errors. Browser checks cover desktop/mobile layouts, all four demos, tools,
source rollback/cancellation, local-file privacy, progressive multipart retrieval,
cine timing/pause/seek and viewer disposal/remount. The archive fixture is synthetic;
a live Orthanc compatibility run remains a separate integration gate.
