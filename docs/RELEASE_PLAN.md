# EASI View v1 release plan

Status: **1.0.0-rc.1 published**, 2026-10-22. Source, npm SDK, six GitHub release
assets and the AI-free public demo are available. Targeted qualification and
public-registry installation checks passed. Complete the running full-corpus
stable gate before advancing to 1.0.0 or resuming feature expansion. Both npm
`next` and `latest` currently resolve to the candidate; this is not stable 1.0.0.

## Preserved work and release line

The complete AI experiment is preserved on `feature/ai-assist-preview` at
[`5142fa1f51e0dd9345fd002c1fbac15d18672f33`](https://github.com/davidvaccaro/easi-view/tree/5142fa1f51e0dd9345fd002c1fbac15d18672f33),
with tag `checkpoint/pre-v1-ai-split-2026-10-22`. The base preparation proceeds on
`release/1.0`. [AI_BACKLOG.md](AI_BACKLOG.md) records accomplishments, evidence,
limitations and future return gates. AI UI, configuration, public SDK methods,
voice, model/gateway code and active setup guides are excluded from this release.
Shared opening, metadata, pane/cine and measurement fixes are retained.

## Frozen base scope

| Area | Initial-release behavior and boundary |
| --- | --- |
| Opening | Explicit Images/Study/Test workflow; local files/folders including extensionless inputs; DICOMDIR media; cancellable indexing/Add feedback; patient-scoped local Select all and current-page remote selection |
| Session | Patient/study/series/instance hierarchy, additive admission, study timeline, manual patient association, stack navigation and pane drag/drop |
| Image display | Qualified native grayscale/color and compressed profiles; original stored/modality values preserved; clear unsupported/error outcomes |
| Interaction | Window/level, pan, zoom, probe, rotations/flips, frame selection and declared cine timing |
| Measurement | Distance, angles and ROIs with declared calibration/units, original-value statistics, selection/editing, bounded Undo/Redo and JSON interchange |
| Comparison | 1/2/4 panes, explicit assignments and geometry-checked links; supplied studies and manual current/prior roles |
| Inspection | Details, Measurements, hierarchical Attributes, Performance and Objects; compact notices with visible actual errors |
| Sources | Explicit configured DICOMweb and HTTP DIMSE gateway adapters; host-managed credentials and archive policies |
| Integration | Brandable isolated browser ESM SDK, types/events, standalone static build, adjacent worker/WASM assets and explicit disposal |
| Existing advanced profiles | Keep implemented reconstruction, restricted SEG/SR/GSPS, enterprise and specialty research slices within their documented limits; no expanded parity claims |
| Privacy/licensing | Local viewing requires no upload or telemetry; original corpora/reports stay ignored; Community License and commercial alternative with separate core/codec notices |

[STATUS.md](STATUS.md) is the exact supported-profile and limits reference.
Availability of a modality label, metadata index or derived manifest is not a
promise that every associated image/object profile can render. The 272-item
competitive inventory remains a backlog rather than release scope.

## Acceptance gates and current progress

| Gate | Current status | Completion evidence |
| --- | --- | --- |
| Preserve AI experiment | Complete | Immutable checkpoint/branch/tag above; full backlog retained |
| Remove AI from runtime and public SDK | Complete on the qualified candidate | Bundled-input, runtime/API/profile and SDK package exclusion checks; no automatic AI configuration fetch |
| Independent EASI JS hardening | Complete: 1.0.1 published, tested archive verified against registry, 1,466 tests passed | Exact registry version/integrity, independent clean install and viewer lock |
| Viewer numeric/runtime/build checks | Passed: 2,163 tests, zero skipped, production build and distribution guards | `npm run check` and clean source fingerprint; no inherited AI-test count |
| Browser qualification | Passed: 99 native-browser checks on the fixed source | Opening/cancel/error/Select all, display, tools/measurements, comparison, embedding, no AI requests and disposal |
| Full local corpus regression | Running from an isolated tagged copy across all 23,893 files; outcome pending and required before stable 1.0.0 | Per-file comparison over all 23,893 inputs, actual supported frame draws and applicable interactions; classified unsupported/invalid inputs remain explicit |
| Clean consumer installation | Passed: 9 actual Chrome checks on the exact SDK plus fresh public-registry integrity/exports/types/46-file asset-copy checks | Install packed SDK plus registry-resolved core in a fresh consumer, resolve types, copy assets, mount/render/dispose and verify adjacent worker/WASM |
| Artifact/publication hygiene | Passed: exact public SDK archive matched the tested SHA-256; six release assets available | Clean tagged checkout, synthetic-only public assets, secrets/original-data exclusion, complete licenses and checksums |
| Documentation/support matrix | Updated for the qualified candidate and verified publication; immutable tagged docs retained | README, exact profile/limits, embedding/assets, unsupported outcomes, licensing and reproducible release instructions |
| RC publication/demo | Complete: public source, npm RC, GitHub release and byte-matched demo; 10/10 public/local Chrome smoke checks | Both npm `next`/`latest` point to RC1; explicit candidate install recommended; exact tag/archive/deployment proof in STATUS.md |
| Stable 1.0.0 | Not yet approved by these candidate results | Resolve release-blocking defects, finish review/qualification, bump/tag/build a distinct stable version and publish `latest` deliberately |

The qualified source fingerprint is
`c335d229eedd333db5afac0f29534a1e93044e68799590b26e6c6c88a3d510ab`.
The final build includes archive-disconnect source cleanup and the embedded host's
initial `sourcechange` status fix. Earlier test/browser results are not carried
forward as qualification of this corrected build.

A public release candidate may proceed after its targeted checks, browser and
clean-consumer gates pass while the full corpus rerun remains visibly running with its outcome pending.
Stable 1.0.0 requires that completed campaign and a reviewed outcome report.

Historical corpus and browser evidence stays useful for selecting regressions,
but every receipt retains its original build identity. Do not carry old passes
forward as if the new release had exercised those inputs. The complete-corpus
run must report every file, actual render outcomes, supported modality actions,
known unsupported/invalid classifications and unexpected failures. Fix defects
with generated public regressions, then retest affected originals privately and
freeze/requalify the final build. Never commit source images or clinical data.

## Published candidate and remaining tag limitation

- [npm package](https://www.npmjs.com/package/@xinonix/easi-view): use
  `npm install @xinonix/easi-view@next` or `@1.0.0-rc.1` explicitly.
- [Versioned release and six assets](https://github.com/davidvaccaro/easi-view/releases/tag/v1.0.0-rc.1):
  tag commit `5dd411056f426ebd33929091ed17eac2214d0968`; published SDK SHA-256
  `ce2d5193b17065bcacfe19357cdbade0acc14b0b73397464c05f0e701d2da318`.
- [AI-free public demo](https://d3gv6o0ove04h3.cloudfront.net/): all 46 files
  match the qualified build; restored local previews match it too.

npm also assigned the initial prerelease to `latest`. The authenticated removal
attempt returned HTTP 400; both tags remain on RC1. This is a recorded registry
limitation, not a stable-release promotion. Do not claim `next` exclusivity or
stable qualification from that label. [STATUS.md](STATUS.md) retains exact
publication and recovery evidence. Future stable publication requires the
completed corpus report and a distinct stable version/tag/artifact.

## Release discipline

Until the base is released, accept stability, correctness, usability,
compatibility and documentation fixes within the frozen scope. Additional AI,
plugins/marketplace, anatomical inference and specialty expansion remain deferred.
A successful software release does not establish clinical/regulatory validation.
The license is source available, with the binding eligibility and commercial
terms in [LICENSE](../LICENSE) and [LICENSING.md](LICENSING.md).

[RELEASING.md](RELEASING.md) gives the candidate-to-stable sequence. Do not infer
that branch preservation disables, deletes or renews any separately operated
cloud service; those operations have their own explicit deployment decisions.
