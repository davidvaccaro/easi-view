# Local DICOM collection testing

The opt-in corpus harness opens local files one at a time in an isolated Chrome
session using the built EASI View SDK. Originals enter through the browser File
API. The temporary server serves only viewer/driver assets and accepts no uploads.
Inputs are fingerprinted before and after each case. Reports contain relative
filenames and technical outcomes, without images, screenshots, patient metadata
or pixel arrays.

This tool runs from a repository checkout. Normal tests and CI use generated
synthetic fixtures. Chrome must be installed; set `EASI_VIEW_BROWSER` to its
executable if it is not at the default macOS location.

## Run the entire collection

From the `easi-view` repository:

```sh
npm run check
npm run test:corpus -- --directory ../easi-platform/data/dicoms/local
```

The directory is `dicoms/local`. Discovery recursively includes `.dcm`/`.dicom`
files, including malformed inputs, plus files with a Part 10 header regardless of
extension. Hidden filesystem files and symlinks are excluded. Discovery accepts
at most 100,000 entries/files and reports an explicit error if that bound is
exceeded. No initial 10,000-file prefix is silently selected. Discovered/selected
counts and explicit subsets are stated in the report.

By default, every logical frame in every returned stack is tested. The per-file
parse/browser time budget is 120 seconds, configurable from 1 to 600 seconds.
Parse cancellation is cooperative: abortable reads enforce the byte/time limits,
but a synchronous parser operation cannot be interrupted mid-operation.

```sh
npm run test:corpus -- --directory ../easi-platform/data/dicoms/local --timeout-ms 300000
```

For faster diagnosis, choose an explicit subset or sampled frames:

```sh
npm run test:corpus -- --directory ../easi-platform/data/dicoms/local --match SERIES1
npm run test:corpus -- --directory ../easi-platform/data/dicoms/local --limit 5 --sample-frames
```

Sample mode tests first/middle/last frames. Unvisited frames are not counted as
tested. Matching occurs before the selection limit, including in large folders.

## Large collections and resuming

Use the campaign runner for collections with thousands of files:

```sh
npm run check
npm run test:corpus:campaign -- --directory ../easi-platform/data/test-library \
  --output artifacts/local-corpus/test-library
```

The campaign creates one sorted, streamed SHA-256 inventory. Each deterministic
batch runs through the same file-session harness, with a fresh isolated browser
for the next batch. The default batch size is 200. Source, frame, codec and cache
limits remain unchanged; files are never opened concurrently. Original source
hashes are checked again after each case.

Private per-batch reports and checkpoints retain progress. Final aggregate
HTML/JSON/CSV covers every selected file; an interrupted campaign is visibly
partial. Resume with the same configuration and output directory:

```sh
npm run test:corpus:campaign -- --directory ../easi-platform/data/test-library \
  --output artifacts/local-corpus/test-library --resume
```

Resume requires identical input fingerprints, viewer build, driver hashes and
configuration. It rehashes the input inventory to detect changes. Completed
batches are retained, including their unsuccessful outcomes; an incomplete batch
is rerun. A changed viewer or corpus needs a new output directory so results from
different versions are not presented as one qualification run.

Every logical frame is requested by default. For a faster compatibility survey,
add `--sample-frames` to the initial and resumed command; that run records
first/middle/last coverage and cannot establish that other frames work. Large
collections can take hours; progress timings are observations of this machine,
not throughput promises. Ctrl+C requests an orderly stop after the active file
and retains partial evidence. Allow that cleanup to finish before resuming.

## What a successful image session means

The harness checks:

- Complete bounded EASI streaming parsing, returning an allowlisted technical
  profile. The transient parser model contains metadata internally; it is not
  persisted, and large bulk values stay streamed.
- Opening through the actual browser SDK and File API.
- Actual main-canvas image upload/draw, zero observed GL errors, and a successful
  frame commit. Every tested frame must produce a new draw and commit.
- Parsed attributes in the inspector and compact current-image notice access,
  acknowledgement and retained-message checks without resizing the viewport.
- Pointer-driven pixel probe, pan/zoom, rotation and reset.
- Grayscale window/level with original-value ROI statistics unchanged by display
  changes. Color cases exercise their profile and decline scalar intensity
  statistics instead of inventing grayscale values.
- For multiframe images, frame navigation, actual cine frame commits and pause.
- Awaited disposal with cleared source/cache/overlay/reconstruction bytes and
  zero active decoder workers, including independently observed worker lifetimes.
- No uploads or external application requests, unchanged original file hash,
  and stable viewer/driver fingerprints throughout the run.

Recorded timing and manually selected playback rates stay separate. Classic US
with malformed timing can use manual navigation/FPS; the notice icon explains
that recorded playback/acquisition timing is unavailable. Original timing tags
remain inspectable. The harness chooses a manual rate for its cine interaction
check; it does not certify acquisition-clock accuracy.

Default Chrome uses software WebGL for reproducible rendering checks. Successful
display and interaction are functional evidence. Hashes describe observed stored
textures/rendered output, not an independent diagnostic pixel oracle. Synthetic
numerical/shader tests remain separate correctness gates. This run does not
establish physical-GPU performance, cross-browser support, clinical interpretation,
full DICOM conformance or collection-wide study geometry. Files are tested
separately; multi-instance ordering belongs to the study/workspace suites.

## Reports and failures

Private reports are written under ignored `artifacts/local-corpus/latest/`:

- `report.html`: readable per-file outcomes and coverage.
- `results.json`: checks, timings, profiles, frames/resources, source hashes and
  build/driver provenance.
- `results.csv`: spreadsheet summary with formula-safe filenames.

Use `--output PATH` to retain a separate run outside the input collection. Single-run reports
are updated after every file, with interrupted runs visibly partial. Campaign
reports use bounded per-batch files and checkpoints. Public
regressions must use newly generated fixtures; local reports are not fixture data.

Statuses are `passed`, `failed`, `unsupported`, or `invalid`. Unsupported profiles
stay distinct from unexpected defects. Structured reports and key-object documents
parse but lack a directly viewable pixel image; DICOMDIR indexes, presentation
states, raw-data/spectroscopy objects and vendor objects also have separate
profiles. Rejection by the image viewer is
recorded as unsupported, never as successful display. Full document rendering
needs its own implementation profile.

Exit code **0** means every selected file passed; **1** means unsuccessful files,
including unsupported objects; **2** means a harness/setup error. A collection
containing unsupported documents keeps a nonzero result even when all its images
pass. Fix an image defect, add a synthetic regression, rebuild and rerun. No
status is silently waived to make the result green.

Source, pixel, codec and cache limits in [STATUS.md](STATUS.md) remain enforced.

## Verified local run

The 2026-10-14 frozen candidate parsed **281/281 files**, passed **203/203 pixel
images**, and tested **1,246/1,246 logical frames**. The remaining **78 inputs**
are non-image objects, explicitly unsupported for pixel viewing. There were no
unexpected failures or invalid cases; all original hashes remained unchanged.
The report's nonzero exit is intentional because unsupported objects remain
visible. Private filenames and per-case details are in the local report only.

The baseline source fingerprint for that run is
`164e8437da14a63f9a3c5f4a8ba98388a79ded6ee317a8ed55ce5ae79a625a04`.
Generated control inputs separately test ordinary images, RGB cine, retired US,
manual-timing and warned JPEG compatibility, plus intentionally invalid and
unsupported cases. Ctrl+C finishes the active case, retains a visibly partial
report, cleans up the owned browser/workers and exits **130**.

## Larger library inventory and completed baseline

A read-only inventory on 2026-10-14 found 25,870 regular files in the larger local
library: 23,696 with Part 10 signatures, plus 197 named `.dcm` inputs without that
signature. The latter require parsing rather than being assumed valid. There
were no unreadable inputs, symlinks, or sources above the 256 MiB limit. Part 10
inputs with other extensions account for 7,605 files that the original extension
filter would have omitted. Inventory alone establishes discovery; the completed
baseline campaign below records actual load, decode and display coverage.

The candidate rule excludes 1,930 hidden sidecars and 47 nonhidden files without
Part 10 signatures or named DICOM extensions. Bounded fixed-signature inspection
identified 45 `.7z` archives and two text files among the latter. Archives remain
unextracted and could contain additional data; campaign coverage applies to
expanded candidate files. The report states discovery rules rather than claiming
every physical file is a directly readable DICOM image.

A balanced 50-file browser pilot on the baseline build selected 31 eligible
SOP-class/transfer-syntax pairs, size/layout complements and unsupported controls.
It exercised 1,157 logical frames and preserved every original hash. Diagnosis
found intentional presentation/parser boundaries and malformed inputs, including
RLE segment padding and empty enhanced dimension sequences. These are retained
as unsuccessful outcomes rather than relaxing image validation.

The qualified follow-up pilot on frozen source
`71e8b08c0ddeb99b2ed526d34659cebecd10a0ba1c548fe09518cdcbafdfa056`
recorded **29 passed, 16 unsupported, 5 invalid and zero unexpected failures**.
All 1,122 frames in the successful image sessions were checked; 35 additional
frames displayed before a malformed RLE frame was rejected, giving 1,157 actual
frame checks. All 50 original hashes remained unchanged and uploads/external
application requests were zero. The full generated suite passed **1,406 tests**
and build/distribution checks. An eight-fixture, two-batch Chrome control proved
completed-batch reuse with expected failures retained; a separate interruption
control retained two cases, cleared buffers/workers and resumed to exactly eight
results. The large campaign is a separate run; its checkpoint and reports record
actual completion rather than extrapolating the pilot's outcomes.

The completed baseline on 2026-10-15 covered **all 23,893 candidate files in 120
batches** on the same `71e8b08c…` source: **20,974 passed**, **2,907 unsupported**,
**12 labelled invalid**, and **zero unexpected failures**. All **23,138 frames**
in passing sessions were tested. Another 35 frames displayed before a later RLE
failure, giving **23,173 actual frame checks**. All original hashes, report
hashes and provenance reconciled; every case ended with zero owned resources
and active workers, and captured uploads/external requests were zero.

The immutable baseline reports are in `artifacts/local-corpus/test-library/`.
Unsupported and invalid are reported classifications, not proof of source
nonconformance or reasons to waive a viewer implementation gap. For example,
2,380 cases exposed missing undefined-length UN support in EASI JS, and three
deflated datasets produced earlier EOF errors because inflation was unsupported.
The latter now receive an explicit unsupported-capability error; this does not
declare their bytes corrupt. Non-image documents remain unsupported by the
direct image viewer until a separate declared implementation exists.

## Frozen fix and retest workflow

Keep the completed baseline immutable. Diagnose one technical group, add generated
positive/negative regressions, fix the owning EASI core or viewer component, then
freeze the source, installed core artifact, build and driver fingerprints. Run
Node/reference checks and actual browser checks against that same candidate.
Changed sources need a new report directory; `--resume` cannot merge different
builds into one qualification campaign. Every logical frame remains the default;
sampled first/middle/last results must retain their explicit narrower scope.

The current candidate's Node checks recovered all **2,380 former UN cases** plus
**324 PET, 22 RF, 84 private CT, one JPEG2000 `YBR_FULL` and three spatial-only
word Secondary Capture cases**: **2,814 originals / 2,949 frames**,
unchanged source hashes and cleared resources. The private CT output also matched
all 84 separately compiled GDCM reference frames. Node/reference success does not
establish current-browser rendering. The final frozen candidate also passed its
150-file / 938-frame browser pilot. Its completed full campaign then recorded
23,788 successful sessions, 97 unsupported profiles, eight validation rejections
and zero unexpected errors. All 23,893 files reached browser opening; all frames
were exercised for successful sessions. The SC additions checked all 138 original frames while
preserving geometry and rejecting recorded timing/volume inference. The JPEG2000
components matched an independently decoded RLE reference before the owned
full-range color conversion; this does not enable the reference's nonconforming
RLE segment offsets in the viewer.

Final-build synthetic browser checks independently verified 48 circular-shutter
configurations/1,200 framebuffer pixels and actual SDK worker/WASM decoding of
both JPEG2000 color UIDs/18 known RGB pixels. Thumbnail shutter decisions use
sampled original coordinates rather than a resized shutter definition. Each
receipt records its own build fingerprint. The 150-file all-frame pilot included
all 22 RF, all 84 private CT, selected UN/PET cases, the JPEG2000 case, all three
SC files and 20 prior passing controls: 130 new passes, 20 retained passes and
zero regressions. All sources stayed unchanged, all resources/workers were
released and uploads/external requests were zero. The full 23,893-file campaign
and its comparison report remain the source of complete-population outcomes.

Create a compact baseline summary, then add a candidate report when available:

```sh
node tools/local-corpus-remediation.mjs \
  --baseline artifacts/local-corpus/test-library \
  --output artifacts/local-corpus/hardening-summary

node tools/local-corpus-remediation.mjs \
  --baseline artifacts/local-corpus/test-library \
  --candidate artifacts/local-corpus/hardening-candidate \
  --output artifacts/local-corpus/hardening-summary
```

The candidate path must contain an actual retest report; the command does not run
the viewer. `summary.html` shows outcomes and unresolved technical groups,
`summary.json` records provenance/counts, and `delta.csv` contains operational file
identities and per-file transitions. Reports are private and contain no patient
attributes or pixels. Inputs remain untouched; outputs must be outside the
original data directory.

The comparison rejects duplicate/unknown files, changed hashes/sizes, inconsistent
statuses/counts and mismatched corpora. Complete versus partial/subset coverage
and all-frame versus sampled coverage remain explicit. A baseline pass outside
candidate coverage is **not retested**, never reverified. Regressions remain
visible even when many former failures pass. An invalid label still requires
independent validity review; unsupported profiles and non-image objects stay
unresolved rather than turning green. Tool exit 0 means the report comparison
was produced without regressions, not that every DICOM passed; regressions return
1 and report/schema/setup errors return 2.

## Reading unsuccessful outcomes

Every reported status other than `passed` is an unsuccessful viewing session.
`failed` means an unexpected error; `unsupported` means a declared capability
boundary; `invalid` means the viewer rejected input under its current validation.
That last label requires independent review before declaring a source malformed.
Human HTML summaries now show the combined count that could not complete while
JSON/CSV retain their original status values. Unreported selected files remain
pending, and missing selection counts remain unknown.

The completed hardened campaign contains the reported 69-frame sampled CT file
as an `invalid`/`open` result with zero displayed frames. A later bounded 2D
projection compatibility fix has its own successful SDK and standalone browser
receipts; it does not retroactively change the old campaign or certify every
other file on the new build. Historical reports and their hashes stay unchanged.
