# Image geometry, presentation and timing

EASI View retains stored samples separately from display transformations. The
worker decodes one requested frame; its frame descriptor supplies the geometry,
rescale and presentation for that original frame. The GPU and Canvas2D paths
apply the same independently tested numeric rules.

## Enhanced CT and MR

Enhanced CT/MR and legacy-converted Enhanced CT/MR are accepted when their
shared and per-frame functional groups meet the supported pixel profile. Pixel
Measures, Plane Position/Orientation, Pixel Value Transformation and Frame VOI
are resolved per frame. Conflicting macros and invalid cardinality fail explicitly.
Missing geometry permits labeled 2D viewing; patient positions are never invented.

Temporal, echo, diffusion, stack and other dimension values are retained. Frames
from distinct non-spatial dimensions are placed in separate navigable stacks
before spatial sorting. Unknown dimension pointers stay separate and do not
qualify for spatial reconstruction. A spatially eligible stack is only a candidate:
future reconstruction must still validate a complete affine and frame of reference.

## Presentation

Scalar display applies the stored value, then linear rescale or a Modality LUT,
then the selected VOI LUT or LINEAR, LINEAR_EXACT or SIGMOID window, and finally
presentation polarity and the user's inversion. Padding remains excluded from
display-range estimation and is black. The first VOI LUT item is used when
present. Manual windowing selects window mode; Reset restores the DICOM default.
Manual window settings persist during frame navigation. Otherwise each enhanced
frame uses its own presentation.

LUTs accept bounded 8/16-bit tables, including the descriptor convention for
65,536 entries. Signed first-mapped values and native byte order are validated.
Fractional rescale followed by a VOI LUT is rejected because this profile requires
integer lookup input. Metadata may identify pending external tables; their complete
validated entries must arrive with the instance. The viewer does not follow arbitrary
BulkDataURI values. Malformed tables are never replaced with identity transforms.

Native and RLE PALETTE COLOR retain the original scalar palette indices. Direct
8/16-bit RGB palette tables supply display colors; probes show the original index
and mapped RGB. Grayscale window/inversion controls do not apply. Segmented,
supplemental and alpha palettes, ICC processing, 16-bit RGB and real-world value
mapping remain outside this profile.

The WebGL2 path validates its floating-point representation before committing a
frame or window. Inputs that cannot preserve exact integer VOI lookup or finite
shader parameters fail explicitly. Canvas2D uses JavaScript numeric evaluation.
This is pixel correctness validation, not diagnostic monitor calibration.

## Cine timing

Fixed Frame Time and valid Frame Time Vector are retained separately from
acquisition timestamps. A vector starts with zero and supplies subsequent positive
intervals; Frame Increment Pointer must select an unambiguous supported clock.
Recorded timing is available only for consecutive original frames of one instance.
It stops at the last vector frame because no wrap interval is declared. Selecting
an explicit FPS provides ordinary looping preview. Frames with no timing do not
acquire an invented DICOM clock. Classic XA continues to require its supported
fixed-clock profile.
Classic US `.3.1`, retired `.6` and `.6.1` images with malformed declared timing
can still display and navigate manually. A separate `timingWarnings` notice states
that recorded playback/acquisition timing is unavailable; offsets and intervals
remain null. The source's timing attributes remain in Attributes. A manually
chosen FPS supplies preview only. Direct timing validation, CT/MR/enhanced and XA
profiles remain strict. A valid selected clock ignores malformed unused timing
fields, following the Frame Increment Pointer selection in
[DICOM PS3.3 C.7.6.5](https://dicom.nema.org/medical/dicom/current/output/chtml/part03/sect_C.7.6.5.html).

## Resource ownership

Enhanced functional-group items can contain validated private creator LO/VM1
declarations alongside their sequence macros. Reservations are scoped to each
item, following [DICOM PS3.5 §7.8](https://dicom.nema.org/medical/dicom/current/output/chtml/part05/sect_7.8.html).
Creators remain in Attributes and do not count as duplicate shared/per-frame
macros. Actual macro duplication, malformed declarations, geometry and dimension
identity checks remain strict. The DICOMweb JSON path uses retained declared VR
provenance instead of guessing unknown private tags from the dictionary.

Enhanced stacks share their encoded instance allocation and presentation tables.
Disposing one temporal/echo stack does not invalidate another. Decoded cache
accounting counts shared LUT backing buffers once. Cache counters exclude parser,
currently visible frame, worker, GPU and overall browser memory.

Validation uses generated Part 10 and DICOM JSON fixtures, independent numeric
and patient-coordinate expectations, worker/cache lifetime tests and actual
WebGL2/Canvas2D browser samples. Original imaging files are never bundled.
