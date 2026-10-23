# AI implementation backlog

Recorded **2026-10-20**, updated **2026-10-22**, for the independent EASI View project.

| Planning boundary | Status |
| --- | --- |
| Full architecture below | Accepted target direction; implementation backlog |
| AI Assist (Preview) first-release slice | Implemented Preview increment: reviewed voice/text viewer tasks plus two existing fact-based text tools; qualification/deployment evidence recorded separately |
| Current runtime | Optional AI connection, closed local workflow broker, short voice transcription and bounded source-bound text assistance; no third-party plugin runtime |
| Existing foundation | Source-bound masks, annotations, calibrated measurements, restricted derived imports and host integration |

All full `EV-AI-*` completion gates below remain **Planned/open**. The narrower
AI Assist implementation described below partially addresses several of them;
it does not complete the wider AI platform. This document does not change the
package version, publish an artifact, promise delivery dates or make the full
AI platform a prerequisite for the first viewer release.
The existing [competitive inventory](feature-catalog.json) remains a separate
272-capability backlog with its original IDs and acceptance criteria.

## Product objective and architecture

Make EASI View useful with configurable language and imaging services, then let
third parties supply analysis tools through the same contracts as built-in tools.
Keep EASI JS responsible for preparing DICOM data and the owned viewer responsible
for rendering, interaction, measurements and applying reviewed results.

The target flow is:

1. A user or authorized host selects a task and its source context.
2. A scoped context service prepares only permitted metadata, measurements,
   frames, regions or volumes through the EASI pipeline.
3. A job coordinator invokes an approved browser model or host-operated AI gateway.
4. The gateway authenticates, authorizes, routes and bounds remote requests;
   provider credentials remain on the server.
5. Typed results are validated against captured source references and provenance.
6. The viewer presents proposed results for review before controlled application.

Language completion, multimodal interpretation and quantitative imaging inference
have different capabilities and input contracts. A rendered screenshot is not an
original quantitative image. Per-model requirements determine whether inputs can
be processed in bounded chunks or require explicit complete-volume preparation.
AI remains optional, configurable by the embedding application, and lazy-loaded
where additional runtimes or model assets are needed.

## Full target backlog

Every full-target row has status **Planned/open**. First-slice coverage is recorded below; the phase is an ordering guide, not a delivery date.

| ID | Target capability | Completion gate | Phase |
| --- | --- | --- | --- |
| EV-AI-01 | Named connection profiles and provider adapters: endpoint, model/version, capabilities, authentication reference, parameters and health/capability testing; default assistant and specialist routing | Capability-specific tests; unsupported tasks explain why they are unavailable; no assumption that all completion-compatible endpoints behave identically | 1–2 |
| EV-AI-02 | Host AI gateway with backend-managed secrets, request authorization, endpoint policy, quotas and configurable private/cloud routing | No reusable provider key in browser configuration/storage; authorization and allowed data checked for each request; synthetic connection test | 1–2 |
| EV-AI-03 | Explicit, scoped AI context for selected metadata, measurements, images, regions and studies; host controls what may leave the device | No automatic catalog dump or image upload; separate permissions for metadata, identifiers and pixels; recipient and input scope visible; accurate local/remote processing status | 1–2 |
| EV-AI-04 | Versioned preprocessing, original/modality/rendered representations, geometry/calibration and bounded input preparation | Exact source references; transforms and units declared; no guessed spatial binding; resource plan for complete-volume models | 2 |
| EV-AI-05 | Shared job lifecycle: progress/streaming, cancellation, timeouts, bounded retries, concurrency, usage limits and low-priority resource scheduling | Viewing stays responsive; request/tensor/result budgets enforced; closing sources, identity revocation and disposal invalidate owned work and late responses | 1–2 |
| EV-AI-06 | Source-bound result admission independent of the currently displayed image | Capture study/series/SOP/frame and session/context revision at dispatch; reject stale or mismatched results; never attach an asynchronous result to whichever frame is currently active | 1–2 |
| EV-AI-07 | Versioned typed result envelope and provenance: text, proposed actions, measurements, annotations and masks; model/plugin/configuration/preprocessing versions | Validated schemas and evidence references; proposed/accepted/rejected states; reviewed edits retain original model output; model scores retain their declared meaning | 1–2 |
| EV-AI-08 | Explain selected series metadata, calibration and compatibility notices; draft summaries of selected existing measurements | Evidence-linked output; exact viewer-supplied facts/units; no inferred image findings or invented numeric measurements | 1 |
| EV-AI-09 | Compare explicitly matched current/prior findings and measurements | User-confirmed correspondence; differences computed deterministically; source links and dates; no automatic lesion matching or inferred progression from dates alone | 2–4 |
| EV-AI-10 | Interactive point/box segmentation, followed by supported detection/landmark/probability/heatmap tools and broader volumetric workflows | Qualified model and modality/profile; exact source-grid output first; explicit validated transforms for later resampled outputs; preview/review/correction without changing original pixels | 2–4 |
| EV-AI-11 | Optional browser inference using suitable WASM/WebGPU runtimes and qualified model assets | Lazy loading, disclosed model requirements/download size, integrity/version/license checks, hardware qualification and disposal; ordinary viewing works without inference | 2–4 |
| EV-AI-12 | Constrained proposed viewer commands through a host-controlled action broker | Declared allowed actions and reversible changes; validate arguments and context; review before actions with effects; no arbitrary code execution from model text | 2–4 |
| EV-AI-13 | Stable plugin SDK and manifest: modality/profile eligibility, input capabilities, model requirements, parameters, output types, permissions, viewer versions, publisher and license | Built-ins use the same contract; declarative host-rendered tools first; reference extension, synthetic fixtures and compatibility test kit; no undocumented viewer internals | 2 |
| EV-AI-14 | Isolation for third-party executable UI/computation and controlled messaging/data access | Explicit trust boundaries, isolated UI origins/sandbox policy and mediated network/data access; workers are a compute mechanism, not the entire security boundary; no plugin access to provider secrets | 2–3 |
| EV-AI-15 | Curated extension registry and private enterprise catalogs | Approved installation, compatible versions, declared data destinations and permissions, provenance, model requirements/validation information and branding/host controls | 3 |
| EV-AI-16 | Public marketplace and distribution operations | Publisher/package verification, pinned signed/integrity-checked versions, reviewed updates, disable/removal/revocation, licensing and eventual commercial entitlements; technical compatibility distinguished from model validation | 4 |
| EV-AI-17 | Portable derived results and broader DICOM segmentation/structured-measurement interchange | Bounded versioned JSON first; separate complete-IOD/interoperability gates for SEG/SR writing, TID1500 and archive export; generated prose is not itself a structured measurement report | 2–4 |
| EV-AI-18 | Operational validation, deployment guidance and reproducible analysis | Model/input/preprocessing/output provenance, host-owned durable audit/retention policy, minimal operational telemetry, usage accounting, model evaluation and synthetic correctness/lifecycle tests; no clinical claims inferred from connector tests | 1–4 |

Provider, plugin and model licensing remain separate from the viewer's license.
Full configuration and durable audit/retention services belong to the hosting
application; current archive-specific enterprise hooks must be extended deliberately.

The existing `addOverlay()` convenience API binds to the image active when called.
Future inference integrations must use explicit source-referenced result admission;
they must not await inference and then blindly call it on the current viewport.
Current public operational state does not expose arbitrary raw pixels or patient
metadata. Add explicit scoped access instead of expanding those events incidentally.

## Delivery sequence

| Phase | Target increment | Exit gate |
| --- | --- | --- |
| 1 | Narrow AI Assist (Preview) implementation below | Reviewed voice/text task planning and local actions, plus two guided fact-based actions; genuine provider/audio evidence separate from deterministic fixtures |
| 2 | Broader profile/job/result services, plugin SDK, reference interactive imaging plugin and optional model-runtime adapter | Built-in/reference tools share contracts; source binding, model inputs and review behavior independently qualified |
| 3 | Curated installation and private enterprise extension catalogs | Permissions, compatibility, isolation, updates, revocation and host deployment policies qualified |
| 4 | Public marketplace, broader imaging workflows and advanced interchange | Each workflow, distribution feature and DICOM export meets its own exit gate; none is implied by installing a plugin |

Phases 2–4 are future expansion. They are not promised first-release scope.

## First-release slice: AI Assist (Preview)

**Status: implemented Preview increment.** An explicit `ai.workflows: true`
host configuration adds reviewed voice/text task planning and a constrained local
action broker alongside the two existing guided explanation/measurement actions.
Short recordings return editable transcripts before planning. Plans are grounded
against the local session, require series choices where ambiguous, and run only
after review. Cancel, guarded partial restoration and one-task Undo preserve the
viewer context. The optional host panel retains bounded request/draft lifecycle
and source evidence. The separately operated
[source-checkout demonstration gateway](https://github.com/davidvaccaro/easi-view/tree/main/examples/ai-gateway) supplies genuine model
connectivity; deterministic qualification is identified separately from actual
provider checks. [AI_ASSIST.md](AI_ASSIST.md) documents SDK setup and boundaries.
The full plugin platform, general agent framework and marketplace remain later
work, and the viewer remains a research alpha.

### User experience

1. The host opts into one configured gateway/model. Provider keys remain on
   that gateway. Tasks is a separate `workflows: true` opt-in; Explain remains
   available to hosts that only implement the original fact-based endpoints.
2. In **Tasks**, type a command or choose **Record a task**. Stop and transcribe
   sends audio to the configured speech service; the 20-second limit also stops
   and sends it. Cancel discards an unsent recording. Review/edit the transcript.
3. **Plan task** sends only the reviewed command. A closed plan is validated and
   matched against local metadata. The model receives no automatic catalog,
   identifiers, source descriptions, DICOM or pixel context. User-spoken or typed
   identifiers can still appear in their command; no automatic redaction occurs.
4. Review proposed steps and choose any ambiguous series, then **Run task**.
   Existing viewer APIs arrange/select/render images. Cancel stops further work;
   Undo restores a completed task while later manual changes have not superseded it.
5. In **Explain**, retain the exact-fact preview and explicit Generate flow for
   **Explain this series** or **Draft a measurement summary**. Streamed drafts
   remain unverified and cannot create annotations/findings automatically.

The OpenAI reference profile uses `gpt-6.1-sol` for planning and `gpt-transcribe`
for optional speech. Commands and sent audio leave the device. No background
microphone, general agent runtime, arbitrary code execution or persistent
conversation is introduced. See [AI_WORKFLOWS.md](AI_WORKFLOWS.md) for reproducible
synthetic examples and the limits of metadata-driven selection.

### Conceptual viewing increment — 2026-10-22

The current milestone reduces viewer setup and navigation work using conceptual
commands. It extends the bounded local selection vocabulary with reconstruction
families, recorded monoenergetic energy, thickness/kernel preferences, shared
multi-pane source choices and relative stack positions. A host can disclose a
routine CT display preference. This is viewing workflow assistance; the future
pixel/region/organ reasoning and automatic clinical analysis contracts remain
open. The command-only model privacy boundary and explicit Run/Undo are retained.
See AI_WORKFLOWS.md for supported tasks and independent qualification evidence.

### Implemented first-slice contracts

| Slice ID | First-release requirement |
| --- | --- |
| AI-V1-01 | One host/SDK-configured gateway/model profile with one documented completion adapter contract; no multi-provider administration UI |
| AI-V1-02 | One gateway example/host contract with server-owned provider credentials, host authorization, request allowlisting and a synthetic test operation |
| AI-V1-03 | Explicit context preparation for the two actions: allowlisted technical fields and selected measurement facts only; omit patient identifiers, unrestricted free text, private tags, raw DICOM, pixels and source URLs |
| AI-V1-04 | Capture original source references and context/annotation revision locally; use opaque evidence labels in prompts where possible, with local evidence navigation |
| AI-V1-05 | One active request per viewer, progress, streaming, cancel, clear timeout/error behavior and bounded plain-text rendering; implemented limits are 32 KiB serialized context, 64 KiB output and a 60-second default timeout |
| AI-V1-06 | Keep source context fixed during frame navigation; patient change, selected-measurement changes, source removal, revocation, cancellation and disposal invalidate affected jobs/late output |
| AI-V1-07 | Render an authoritative fact/measurement table from viewer calculations; validate returned evidence labels and numeric quotations against those supplied facts, flagging/omitting discrepancies; prose stays an unverified draft, with no claim of general semantic verification and no model-derived value becoming a quantitative measurement |
| AI-V1-08 | Optional, brandable AI panel with recipient/context preview, explicit Generate, visible unverified-draft status, source evidence and cancellation; truthful transfer indicators; no arbitrary code or unreviewed model actions |
| AI-V1-09 | Separate synthetic automated, actual-UI and genuine selected-provider qualification; document the connector/capability boundaries and which path each receipt qualifies |
| AI-V1-10 | Opt-in reviewed command planning through a closed versioned action schema, with no automatic catalog/image/identifier attachment; typed/spoken identifiers are not automatically redacted |
| AI-V1-11 | Local series/study/stack grounding from bounded contrast, orientation, body-part and derivation evidence; missing/conflicting values remain unknown, candidates remain choices and no primary phase is inferred |
| AI-V1-12 | Reviewed local actions for layouts, series, calibrated CT windows, compatible links, frames/cine, existing tools and last existing measurement; Run is explicit, without arbitrary viewer API access |
| AI-V1-13 | Snapshot validation, cancellation, same-patient partial restoration, manual-interruption guards and one-task Undo that cannot overwrite a newer workspace |
| AI-V1-14 | Optional push-to-talk recording with permission/cancellation cleanup, 20-second/2 MiB browser cap, explicit audio-transfer disclosure and an editable transcript before a separate Plan action |

The limited context/job/draft plumbing should leave room for the full contracts,
but it need not expose a stable third-party plugin API in the first release.
This slice partially addresses EV-AI-01/02/03/05/06/07/08/12/18; completing it does
not complete those broader target items.

### First-release acceptance gates

- Disabled or unconfigured AI makes no inference request; opening a study does
  not automatically invoke AI. Ordinary viewing works without the service.
- Explain payload preview matches transmitted allowlisted facts, with the
  recipient visible. No raw pixels/files, patient identifiers, private tags,
  source URLs or provider secrets are automatically attached. Tasks sends only
  the reviewed command; sent recordings and user commands may themselves contain
  identifiers and are not described as automatically de-identified. Local
  catalogs/candidate labels never enter planner requests or operational events.
  Technical warning text is selected/sanitized, not an unrestricted metadata dump.
- During remote AI use, processing/privacy status distinguishes selected
  fact transfer, reviewed command transfer and recorded audio transfer. Image
  bytes remain outside AI requests. An unconditional “No uploads” message must
  not misrepresent command, audio or fact transfer.
- Pixel versus physical units, missing calibration and supplied measurement
  values remain explicit in a viewer-computed fact table. Unknown evidence IDs
  and numeric quotations that do not match supplied facts are rejected, omitted
  or flagged. Prose remains an unverified draft; this is not a general verifier
  of semantic/clinical correctness, and prompts alone are not validation.
- Prompt-like text in supplied facts is treated as data. Explanation output
  remains bounded inert text. Task output must match the closed action schema;
  only reviewed, locally resolved actions can execute. Neither path executes
  arbitrary HTML, JavaScript, anatomy inference or diagnostic actions.
- Cancel, timeout, provider failure, invalid/oversized output, context changes
  and late responses leave images/tools usable and cannot display one patient's
  draft in another patient's context. Close/dispose releases owned request state.
- Generated tests exercise task review/choices, active-pane and stack
  identity, numeric/frame expectations, stale state, cancellation/Undo, voice
  cleanup, explanation evidence/units, exact payload boundaries and independent
  embeds. Deterministic fixtures, actual UI checks and genuine provider/audio
  calls retain separate evidence; none implies clinical validation.
- Public descriptions state what the connector actually does. A metadata or
  measurement assistant is not described as interpreting the DICOM image pixels.

### Explicitly deferred from this slice

Image interpretation/diagnosis, anatomy localization and automatic anatomical
measurements, segmentation/detection inference, arbitrary chat/tool calling,
registration, automatic cross-study finding matching, local model execution,
third-party executable plugins, extension catalogs/marketplace, persistent
conversations, automatic report/PACS writes and complete DICOM AI-result export.
These remain target backlog items where applicable, not first-release blockers.

Preview description (qualification and deployment evidence are recorded separately):

> AI Assist (Preview) plans reviewed voice/text viewer tasks, resolves images
> locally and runs bounded viewing actions after review. It also explains
> selected technical facts and drafts summaries of existing measurements.
> Image-analysis integrations and an extension ecosystem are planned.

## Existing backlog traceability and design references

The original inventory's `EV-AIR-01/02/03/06` relate to result ingestion, imaging
outputs and human review; `EV-AIR-04/05` to local/server execution;
`EV-AIR-07/08` to research export/reproducibility; and `EV-AIR-09` to extensions.
Those entries retain their original proposed acceptance criteria. Their existence
does not imply the full AI execution or marketplace platform is implemented.
Other research adapters/filters remain independently prioritized inventory items.

- Current scope: [derived objects](DERIVED_OBJECTS.md), [enterprise integration](ENTERPRISE.md), [implemented status](STATUS.md).
- Optional browser execution: [ONNX Runtime Web](https://onnxruntime.ai/docs/tutorials/web/).
- Specialist server/client annotation pattern: [MONAI Label](https://github.com/Project-MONAI/MONAILabel).
- Third-party execution boundaries: [OWASP third-party JavaScript guidance](https://cheatsheetseries.owasp.org/cheatsheets/Third_Party_Javascript_Management_Cheat_Sheet.html).
- Interchange targets: [DICOM segmentation](https://dicom.nema.org/medical/dicom/current/output/chtml/part03/sect_C.8.20.2.html) and [structured reporting templates](https://dicom.nema.org/medical/dicom/current/output/chtml/part16/chapter_A.html).

These references inform the target design; they are not evidence of implemented
EASI View AI features or model/clinical validation.
