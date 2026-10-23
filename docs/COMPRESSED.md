# Compressed pixels

EASI JS still reads the DICOM stream and materializes its bounded Pixel Data
attribute. EASI View indexes the encapsulated fragments, assembles only the
requested frame and sends a copy of that frame to its decoding worker. Display
windowing, geometry, interaction and rendering remain owned by EASI View.

| Transfer syntax | UID suffix after `1.2.840.10008.1.2` | Supported pixel profile |
| --- | --- | --- |
| JPEG Baseline | `.4.50` | Unsigned 8-bit MONOCHROME1/2; RGB/YBR_FULL/YBR_FULL_422 color |
| JPEG Extended, Processes 2/4 | `.4.51` | Unsigned MONOCHROME1/2, stored precision 8 or 12, SOF1 sequential Huffman with 1×1 component sampling; 12-bit samples require 16-bit allocation |
| JPEG Lossless, Process 14 | `.4.57` | 8/16-bit allocated monochrome, 2–16 stored bits; unsigned 8-bit RGB |
| JPEG Lossless, Process 14 SV1 | `.4.70` | Same profile, predictor 1 |
| JPEG-LS Lossless | `.4.80` | 8/16-bit allocated monochrome, 2–16 stored bits; unsigned 8-bit RGB |
| JPEG-LS Near-lossless | `.4.81` | Same layout; bounded codestream NEAR parameter |
| JPEG2000 Lossless | `.4.90` | 8/16-bit allocated monochrome; unsigned 8-bit RGB, YBR_RCT, or full-resolution YBR_FULL with MCT0/Planar Configuration0 |
| JPEG2000 | `.4.91` | Same layout, including supported YBR_RCT/YBR_ICT transforms and unsigned 8-bit full-resolution YBR_FULL with MCT0/Planar Configuration0 |
| RLE Lossless | `.5` | Native 8/16-bit monochrome; unsigned 8-bit RGB/YBR_FULL |

Stored scalar samples remain signed/unsigned values separate from rescale and
display. Color decoding produces interleaved RGB exactly once. Native YBR_FULL
and even-column interleaved YBR_FULL_422 also convert to RGB using the full-range
DICOM matrix. ICC color management and additional color profiles remain separate
work. Compressed images do not imply support for enhanced geometry, active XA
subtraction or other unsupported image-object/presentation profiles.

For the `YBR_FULL` JPEG2000 profile, the codestream must have three unsigned
8-bit, unsubsampled components and no multiple-component transform (MCT0).
The codec's RGB conversion is disabled and its returned Y/Cb/Cr label/layout
must match. The owned full-range matrix then converts to RGB exactly once;
the renderer/worker receive canonical RGB while preserving `encodedPhotometric`
for source provenance. YBR_RCT/ICT inverse transforms retain their separate
existing path. Signed, higher-depth, subsampled or mismatched-transform
`YBR_FULL` still rejects.

## Exact private CT provider

The hardening candidate additionally recognizes Philips CT-private-ELE
`1.3.46.670589.33.1.4.1` only with classic CT, private owner `ELSCINT1`, format
`PMSCT_RLE1` and its complete private OB body. The profile is one unsigned
12-in-16 MONOCHROME2 frame; explicit-little-endian dataset encoding, exact VR/VM,
dimensions, output counts and full encoded consumption are validated. It returns
canonical native words through a dedicated verified marker while retaining the
original transfer syntax and attribute snapshot. This is a distinct private
RLE/delta grammar, not an alias for standard DICOM RLE.

All 84 local private CT canonical frames matched a separately compiled GDCM
reference byte-for-byte, without saving input or decoded arrays. This reference
and Node/worker checks qualify the bounded provider; current-candidate browser
rendering and full-corpus retesting remain pending. Other private owners,
formats, layouts and absent JSON bulk bodies remain unsupported. See
[PHILIPS_PRIVATE.md](PHILIPS_PRIVATE.md) for limits and primary provenance.

Deflated Explicit VR Little Endian (`1.2.840.10008.1.2.1.99`) compresses the
dataset rather than individual encapsulated frames. Dataset inflation is not
implemented by this core candidate and reports an explicit unsupported capability.
An earlier EOF rejection does not establish that such an input is corrupt.

## Frame boundaries

Basic Offset Table entries must identify increasing fragment Item tags. Extended
Offset Tables require paired 64-bit lengths/offsets, an empty BOT and one fragment
per frame. Frame counts, item lengths, padding and offsets are checked before
decoding. RLE has one fragment per frame. JPEG and JPEG-LS can span fragments;
their empty-BOT index uses marker lengths and entropy-stuffing rules. JPEG2000
requires an offset table for fragmented frames; an empty BOT is accepted only
when there is one fragment per declared frame. Ambiguous boundaries fail clearly.
Exactly one final alignment byte may follow an odd-length JPEG/JPEG-LS
codestream's EOI to make its fragment length even. NULL and legacy FF padding
remain quiet; another byte value is accepted with a visible encoding
compatibility notice. Only the decoder's frame view excludes this byte; original
source bytes are preserved. More trailing bytes, a second codestream, malformed
markers and inconsistent offset tables remain rejected. RLE and JPEG2000 padding
rules are unchanged. Necessary padding after EOI is described in
[DICOM PS3.5 A.4](https://dicom.nema.org/medical/dicom/current/output/chtml/part05/sect_A.4.html).

One qualified legacy JPEG Lossless case (`.57`/`.70`) declares unsigned
MONOCHROME1/2, 16 Bits Allocated, 12 Bits Stored and High Bit 11 in DICOM, but
16-bit precision in its SOF3 codestream. Decompression uses the codestream's
16-bit precision, and the decoded frame reports effective Bits Stored 16 / High
Bit 15 with a compatibility notice. Values above 4095 are retained without a
12-bit mask. Original attributes, source bytes and numeric rescale/window
transforms are preserved. This recovery excludes Modality LUT and VOI LUT
presentation. Reconstruction retains its descriptor-versus-decoded-profile
check, so a source with this precision discrepancy is limited to 2D viewing.
Dimensions, components and predictor/point-transform checks remain enforced;
other precision mismatches remain unsupported.
[DICOM PS3.5 8.2.1](https://dicom.nema.org/medical/dicom/current/output/chtml/part05/sect_8.2.html)
describes using the JPEG stream's explicit characteristics for decompression.

The existing 256 MiB input/instance, 4096-frame/instance and 16-megapixel/frame
limits remain in effect. Indexing allows up to 65,536 fragments. The index owns
one encoded allocation; its fragments are views, not eager decoded frames. A
worker receives only the requested frame. Decoded frames use the existing bounded
LRU. These limits describe retained inputs/pixels, not whole browser memory.
The WASM provider has an additional 64 MiB encoded-frame limit and rejects
memory growth beyond 512 MiB; workers terminate on cancellation or codec errors.

## Providers and deployment

JPEG Baseline uses the `jpeg-js` decoder with strict parsing and explicit
resolution/memory limits. RLE indexing and decoding are implemented here.
JPEG Extended, lossless JPEG, JPEG-LS and JPEG2000 use a small owned C ABI adapter around the
pinned `dcmjs-codecs` WASM binary. Its JavaScript DICOM parser and model are
build/test tools only; the viewer runtime does not import them. No external
viewer engine is used. See `licenses/codecs` for upstream notices and provenance.
The Extended profile validates dimensions, precision, unsigned monochrome layout,
SOF1/SOS, quantization/Huffman tables and complete sequential entropy blocks before
codec allocation. Progressive, arithmetic, hierarchical, embedded ICC/color
transforms and Extended color remain outside this profile. Processes 2/4 and
SOF1 are specified in [DICOM PS3.5 A.4.1](https://dicom.nema.org/medical/dicom/current/output/chtml/part05/sect_A.4.html#sect_A.4.1).
There is one explicit legacy compatibility case: SOF1 sequential scans with
`Ss=0, Se=0, Ah/Al=0` may display only after a complete 64-coefficient entropy
scan is independently validated. This header is nonconformant; an
`encodingWarnings` notice states the exception, remains in Details and crosses
the decoder-worker boundary. Source bytes and Attributes are preserved. Other
spectral-selection values, truncated scans and missing blocks still reject.
[libjpeg-turbo's sequential decoder](https://github.com/libjpeg-turbo/libjpeg-turbo/blob/main/src/jdhuff.c#L79)
documents the historical all-zero scan fields as a warning condition; this
viewer adds the completeness gate before invoking that decoder.

Deploy `assets/dicom-codecs.wasm` with the app/SDK and worker. Serve it with
`Content-Type: application/wasm`. The embedding CSP must allow same-origin worker
and codec requests and `script-src 'wasm-unsafe-eval'` for WebAssembly compilation.
This permission does not enable JavaScript string evaluation. All runtime assets
are local; viewing a local file does not upload its bytes.

DICOMweb retrieval requests `transfer-syntax=*`, allowing the server to return
its original compressed syntax. The actual retrieved syntax/profile is validated
before displaying a frame. A classified original pixel-encoding/index failure retries that same selected
instance once as native Explicit VR Little Endian. Both attempts validate identity
and geometry before pixel indexing. HTTP errors, cancellation, input budgets and
semantic metadata failures do not retry. Local-file rejection remains strict;
server-native transcoding is a separate transport capability.

## Verification

Generated synthetic Part 10 fixtures cover scalar/color, signed/unsigned stored
samples, multiframe indexing, BOT/EOT, fragmented frames, cache/disposal and
malformed metadata. Lossless expectations are the independently specified source
sample arrays. JPEG Baseline comparisons allow the stated lossy rounding tolerance.
Browser checks exercise the actual bundled worker, GPU display, frame/cine
navigation, host API and cleanup. No local imaging collection is redistributed.

`node tools/browser-jpeg2000-ybr-check.mjs` checks both JPEG2000 UIDs through the
actual SDK/worker/WASM path against independently known RGB channels and GPU
samples. One local JPEG2000 source additionally matched all 6,220,800 decoded
components to an independent bounded RLE byte-plane reference, then matched the
full-range RGB matrix; no original/decoded arrays were saved. This does not relax
the standard RLE boundary/padding gates. Interim checks retain their original
source fingerprints; final-candidate and full-corpus retests remain separate.

Initial supported subsets reject lossless JPEG point transforms, JPEG-LS mapping
tables/color transforms, JPEG2000 component overrides/ROI coding and unsupported
JPEG processes. Future formats extend these gates only after independent tests.
