# Implementation roadmap

EASI View is an independent asset built with EASI JS; the current hardening candidate pins the independently packaged `1.0.1-corpus.0` core. It owns its rendering and interaction engine. The 272-capability competitive inventory remains a prioritization backlog, not a claim of universal viewer parity. [The interactive catalog](easi-view-plan.html) and [feature inventory](feature-catalog.json) preserve original acceptance criteria and primary evidence.

## Approved implementation sequence

| Milestone | Delivered implementation | Scope and verification |
| --- | --- | --- |
| 1. Compressed images | Strict encapsulated frame indexes and selected-frame worker codec providers | JPEG Baseline/Lossless, JPEG-LS, JPEG2000, RLE; exact subsets in [COMPRESSED.md](COMPRESSED.md) |
| 2. Modern metadata | Enhanced CT/MR partitions, per-frame geometry, rescale, recorded timing, LUT/VOI/palette | Independent numeric/display fixtures; [PRESENTATION.md](PRESENTATION.md) |
| 3. Comparison | 1/2/4 panes, geometry-checked links and shared budgets | Independent pane/source cancellation and original pixels; [WORKSPACE.md](WORKSPACE.md) |
| 4. Measurements | Durable lengths/angles/ROIs, selection/editing, bounded history, JSON | Source identity, physical spacing and padding-aware original statistics; [ANNOTATIONS.md](ANNOTATIONS.md) |
| 5. Study workflow | Additive series, prior candidates, derived thumbnails, optional prefetch/native frame reads | Fixed archive metadata and requested pixels; [DICOMWEB.md](DICOMWEB.md) |
| 6. SDK/artifacts | Typed browser ESM SDK, branding/embedding, installable npm/static archives | Private local artifacts, clean-consumer checks, Chromium/Firefox/WebKit and sustained 2D lifecycle evidence; [ARTIFACTS.md](ARTIFACTS.md), [BROWSER_VALIDATION.md](BROWSER_VALIDATION.md) |
| 7. Reconstruction | MPR, oblique, slabs, bounded parallel rays, explicit rigid fusion | Float64 derived modality values and unchanged originals; [RECONSTRUCTION.md](RECONSTRUCTION.md) |
| 8. Derived objects | AI/SEG masks, reported SR and explicit GSPS, versioned JSON | Restricted exact-grid interchange and independent quantitative/display checks; [DERIVED_OBJECTS.md](DERIVED_OBJECTS.md) |
| 9. Enterprise | Host identity/worklists/context persistence/shares, protected lifecycle and gateway example | Per-request backend authorization, fixed client/scope, atomic reference-only context and cancellation/rollback; [ENTERPRISE.md](ENTERPRISE.md) |
| 10. Specialty profiles | Local dose/AVG_SUB previews, declared cine timing, breast layout and slide metadata | Separate explicitly bounded research profiles; [SPECIALTIES.md](SPECIALTIES.md) |
| 11. Reading layouts | Versioned bounded JSON definitions, metadata-only ranking, CT/MR/current-prior presets, eligible manual choices and selected-frame pane transactions | Exact viewer-owned research profile; no automatic identity/registration or DICOM Hanging Protocol Storage interchange; [READING_PROTOCOLS.md](READING_PROTOCOLS.md) |

The implementation slices are qualified independently. Published or clinical releases require their own decisions and operational validation; EASI View remains 0.1.0-alpha.0 and its npm publication guard remains enabled. The release evidence in [STATUS.md](STATUS.md) identifies actual counts, scopes and known limitations rather than treating every competitive catalog entry as complete.

Current corpus hardening uses the immutable 23,893-file baseline to target
undefined-length UN parsing, declared-unit PET, bounded RF/private CT,
JPEG2000 MCT0 `YBR_FULL`, original-coordinate shutter thumbnails and spatial-only
word Secondary Capture. Generated regressions and all-original Node checks are
separate from the pending final-build browser pilot and full campaign rerun.
The SC profile preserves source geometry without recorded timing or a volume/link
contract. [CORPUS_TESTING.md](CORPUS_TESTING.md) defines the frozen fix/retest and
per-file comparison workflow; unsupported or invalid-labelled outcomes stay open
for independent review rather than becoming waivers.

## AI target backlog and Preview implementation

The [AI implementation backlog](AI_BACKLOG.md) records the accepted target
for configurable AI services, source-scoped jobs/results, assistant and imaging
tools, a third-party SDK and eventual private/public extension distribution.
These broader completion gates remain open.

The implemented [AI Assist (Preview)](AI_ASSIST.md) slice provides one
host-configured gateway/model and two guided actions: **Explain this series**
and **Draft a measurement summary**. Users review technical/measurement facts
and the destination before generating a cancellable streamed draft. Original
source evidence remains locally bound and viewer calculations stay authoritative.
Provider credentials stay on the server. Pixels, image inference, arbitrary
chat/tool execution and the plugin/marketplace platform remain deferred.
This increment does not change the alpha version or commit the wider roadmap.

## Further expansion

- Larger volumes need explicit bricking/out-of-core scheduling and a measured GPU/perspective renderer; streaming parsing does not remove volume residency costs.
- Broader SEG/SR/GSPS IODs, clinical DICOM result writing, structured reporting and result editing require independent interoperability/complete-IOD gates.
- Reading-layout expansion needs separately validated anatomy/view rules, broader clinical workflows and standards-based Hanging Protocol interchange. Current layouts deliberately expose missing or ambiguous metadata instead of inferring sequence physiology or patient identity.
- Production deployment needs the customer's identity/authorization policy, archive compatibility, TLS, retention, audit delivery and operational tests. The gateway example is separately operated.
- Full specialty viewers need breast presentation protocols/tomosynthesis, ECG-linked cardiac and vessel analysis, RT structures/plans/DVH, WSI tile/pyramid rendering and additional diagnostic workflows. Current breast/WSI/cine explorers explicitly report manifest/index/timeline scope.
- Native devices, representative archive/network distributions and clinical use need validation beyond generated headless fixtures. Benchmark counters are nominal owned resources, not process/GPU-memory measurements.

Keep every extension behind its declared profile and reuse the EASI data pipeline, exact original references and owned resource lifecycle. Do not silently approximate an unsupported object.
