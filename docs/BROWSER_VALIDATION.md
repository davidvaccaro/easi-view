# Browser qualification and sustained-session checks

## Opening progress and AI request starting points — 2026-10-22

Build `42d84d54783a68b2a2f2f5f2f56248a1631827823f8eee67e1b3fcc9a9e3ca14`
passed `npm run check`: **2,573 tests**, production bundling and distributable
validation. `node tools/browser-request-flow-check.mjs` passed **14 checks** with
native fetch and generated File API inputs, including nine core product checks.
It verifies the visible
indexing overlay, inert selection, cancel/error recovery, full-patient local
Select all across 30 studies and multiple pages, patient isolation and final Add.

The AI cases verify that Fresh planning leaves a playing multi-pane view
unchanged, while explicit Run creates the reviewed clean setup without deleting
imported studies or manual measurements. Undo restores distinct pane A/B source
assignments, linking and playback. A Continue request that reduces the layout
carries the active pane B image, frame, window and camera into the remaining pane;
Undo restores the prior layout. Changing mode invalidates review while retaining
text; New request clears AI state and preserves valid Undo. Both controls make
zero inference requests and do not mutate images.

Five further groups cover generated audio capture/transcription and busy-mode
controls, stale Fresh review rejection, bounded provider-error recovery, wire
privacy and an actual same-source automatic-window Undo regression. The latter
checks an original automatic W2001/L120.5 display, a Continue bone-window override
and Undo restoring both the automatic mode and its exact frame-derived values.
A genuine-provider attempt exposed this missing restore behavior before the fix;
its partial result is not treated as a complete qualification pass. The earlier
`fb290f4a…` 13-check receipt remains historical evidence.

The final deterministic gate made **ten planning requests** and **one
generated-tone transcription**, with zero genuine model calls, source uploads,
foreign browser requests, browser exceptions or console errors. A canceled plan
and an intentional HTTP502 provider fixture are expected negative paths, not
unexplained failures. The harness SHA256 is
`d6aced26e0cab4be1e59a3e69f280aeef4bd07fc55dab3c4ed499f10cc4883cd`.

This authenticated loopback gate qualifies the exercised viewer contracts; it
is not a genuine-provider pass, diagnostic correctness result or measured clinical
productivity improvement. Genuine provider/mode qualification remains a separate
receipt. Earlier sections retain their qualified build fingerprints.

A separate hosted check on this exact build passed **9 checks with 3 genuine
OpenAI planning requests** using `gpt-6.1-sol`. It imports generated studies once
and prepares distinct sources in panes A/B to exercise continuation. A right-pane
bone-window request preserves the left pane and source/frame; Undo restores the
original automatic window. A one-pane request keeps the previously active B
source and frame; Undo restores both panes. New request then prepares a fresh
lung review from the study catalog without reimporting. Planning changes no
images, every task requires explicit Run, and each Undo restores the baseline.
The run uses native fetch and the real POST sign-in, with zero retries, original
imaging inputs, image uploads, image captures, foreign browser requests or browser
errors. No genuine audio call was part of this gate. The earlier two-request
attempt exposed the Undo defect and remains a partial historical result;
the final three-request pass qualifies the fixed build.

## Conceptual clinical viewing assistance — 2026-10-22

Build `11159ac2b646459eb4c61ba80dbce772b406a7a701ba705d90b40899dc4f8c1c`
passed `npm run check`: **2,538 tests**, production bundling and distributable
validation. The owned viewer still uses EASI JS as its independent data pipeline.

`node tools/browser-ai-concept-check.mjs` passed **15 checks** using a real
standalone page, native fetch, generated File API imports and an authenticated
HTTP gateway with a deterministic planner. Ten conceptual requests each start
with a freshly imported scout, require no source number or preparatory series
navigation, leave the view unchanged during planning, execute against the
expected actual sources, and restore the imported view with Undo. Checks cover
routine/lung/bone setup, lowest-energy versus blended comparison, three-window
source sharing, middle-image ellipse/distance preparation, advancing CT cine,
independent stack endpoints and current/prior viewing. The latter includes a
same-patient prior fixture. A disclosure expansion after execution is used only
to verify the prior pane's actual source assignment; it is not source setup.
The separate anatomy, missing-prior and stale-review checks refuse execution.
Commands contain no series numbers; source assertions use actual session badges,
frame counts/positions, numeric windows, tool state and playback advancement.
The local display profile explicitly prefers available blended routine CT.

The browser gate exposed and drove a fix for cine Undo: per-frame automatic
window changes must not be classified as manual edits. The captured window mode
now distinguishes those changes from explicit overrides. Manual window edits,
source/annotation changes and transforms remain guarded; Undo also preserves
original automatic window mode. Prior pane links are temporarily disabled in
reviewed conceptual multi-pane setup so they cannot cascade independent windows
or requested endpoints. Unit regressions cover both behaviors.

A private local follow-up passed **9 checks** across three workflows on original
chest CT media: automatic blended lung/soft-tissue setup, lowest-energy versus
blended comparison, and middle-image ellipse preparation. The original sources
had 228 images; midpoint selection resolved image 114. No series cards or choices
were needed, and Undo restored the imported state after each task. The planner
was deterministic and local: three generic command requests, zero genuine model
calls, copied originals, source uploads, pixel captures/screenshots, external
browser requests, browser exceptions or console errors. Receipts contain only
technical counts, with no clinical identifiers or original paths.

A separate metadata-only audit checked 20 original representative headers:
indexed and loaded metadata projections matched in all 20, and parsing stopped
before Pixel Data. One vendor image-type hint (`GSI MONO`) occurs on a source
explicitly labeled blended. It is therefore not treated as definitive family
classification. Stronger standard attributes and explicit supported labels retain
their source/evidence distinctions; genuine conflicts remain unknown. These
checks establish exercised software behavior, not diagnostic accuracy or a
measured clinical productivity improvement.

The final hosted native-browser gate passed **12 checks**, including all **10
fresh-study conceptual workflows**, against the same build and the deployed
OpenAI `gpt-6.1-sol` planner. Exactly **10 genuine planning requests** returned
HTTP200. Every case reviewed and executed against actual source bindings,
numeric windows, frame positions, tool state or advancing playback as applicable;
Undo restored its imported scout. No preparatory source navigation or source
numbers were used. The model received only command/protocol fields. Source
catalogs, original imaging, pixels, screenshots, foreign browser requests,
browser exceptions and console errors were absent from the model/browser
transfer path. The source/harness fingerprints match the deterministic gate.
One initial attempt encountered a login-script HTTP429 before invitation entry
or inference; its zero-call failure receipt is retained separately. The later
complete run passed without changing authentication, quotas or concurrency.
This evidence qualifies the deployed planning interface and exercised workflows,
not general clinical reasoning, diagnostic accuracy or a time-saving percentage.


## Current-study CT series discovery — 2026-10-21

Build `79a4872f4bec333714fd497b8e13a74458bcef781b0aadacb3a7be2850b25b65`
passed `npm run check`: **2,494 tests**, production bundling and distributable
validation. The new metadata field uses bounded Image Type tokens. In particular,
`GSI VUE` and `GSI MD` remain specialized reconstructions even when marked
ORIGINAL and AXIAL; missing/mixed reconstruction evidence stays unknown.

`node tools/browser-ai-series-check.mjs` passed **8 checks** using the actual
standalone page, native fetch, a deterministic HTTP planner and generated DICOM.
The exact paired-window command starts on a scout without series-card navigation,
resolves one shared three-option choice, displays the chosen stack in both panes
with independent numeric CT windows, and supports Undo. The sole suitable
candidate is chosen automatically; explicit displayed-series requests retain
literal selection. Other studies/patients are not silently substituted. Original
material-density, virtual-unenhanced, projection and derived candidates are
excluded from the general comparison. No genuine model call was made by this gate.

A private local-only follow-up passed **10 checks** across selected chest and
abdominal examinations from original media. Study selection occurred in Open
Study; no series cards were expanded or chosen. One shared AI-dialog choice
contained three eligible chest reconstructions or two eligible abdominal
reconstructions. The selected stacks contained 228 and 184 images respectively;
both panes used the same selected source with lung W1500/L−600 and soft-tissue
W400/L40. Counts-only render comparisons differed at 63 of 64 sampled positions
in each examination. Original pixels were sampled from a transient in-memory
canvas capture and discarded; no screenshot file or clinical identifier/path was
retained in the receipts. The planner was deterministic and local. Original
imaging uploads, external browser requests, exceptions and console errors were
zero. These checks establish the exercised software paths, not clinical superiority
of any reconstruction or general imaging/diagnostic accuracy.

The final hosted `--origin` gate passed **5 checks** against this build and
the deployed OpenAI `gpt-6.1-sol` planner with exactly **one genuine planning
request**. The exact generic command began on a generated scout, resolved one
shared three-option choice, loaded the chosen stack into both panes with the
requested independent windows and matching session assignments, and restored
the scout with Undo. The model received only the command and protocol fields, with no catalog
or pixels. Original imaging was not used. Screenshots, external browser
requests, browser exceptions and console errors were zero. This separate gate qualifies the deployed
prompt without treating deterministic fixtures as model evidence. An initial
zero-call harness failure preceded the final successful check: the cold-page
login form was clicked before its submit handler was ready. The harness now
verifies the installed handler, real login POST and root-page redirect before
proceeding. Gateway login behavior was unchanged.


## AI session recovery — 2026-10-21

Build `c96dc751584ff5c355a0d695e74cf41034a5c77aa56f00e1a28d88eb17e35c71`
passed `npm run check`: **2,469 tests**, production bundling and distributable
validation. Nine new unit regressions cover opt-in URL policy, new-tab controls
and unauthorized task/audio/draft/connection states.

`node tools/browser-ai-signin-check.mjs` passed **5 checks** using the actual
standalone viewer, native browser fetch, generated local DICOM and a real
loopback gateway with a deterministic planner. Its session clock advances past
the real 30-minute lifetime. The resulting HTTP 401 exposes recovery while
retaining the original command and local ultrasound image/frame. A trusted click
opens the configured invitation page in another tab; real form sign-in restores
the shared cookie without an opener/referrer or any automatic AI retry. The
original tab keeps its command, source and frame. An explicit retry returns
HTTP 200 and Run changes the layout successfully.

The count-only receipt is retained in ignored local artifacts. Browser
exceptions, original clinical inputs and genuine provider calls were zero.
Neither session lifetimes nor gateway authentication/authorization rules changed.


## Reviewed AI workflows — 2026-10-21

Source fingerprint
`62381d8915839b7d17a7e1f45503c75a7afe0324eb2b71a20e08c0b4b5746ba1`
passed **2,460 automated tests**, production bundling and distributable checks
with `npm run check`. Task/audio qualification is separate from the historical
explanation and connection receipts below.

### Generated standalone workflow gate

`tools/browser-ai-workflow-check.mjs` passed **12 checks** against the actual
standalone page with an explicitly deterministic loopback planner/transcriber.
It preserves native browser fetch and observes requests through CDP rather than
replacing the transport. The generated cases verified:

- Sign-in, opening DICOM files and typing a command cause no automatic AI call
  or source upload.
- A reviewed displayed-CT task applies independent lung/soft-tissue windows and
  visibly different rendered pixels: the sampled RGB values were **230/230/230**
  and **102/102/102**. Undo survives dialog closure/reopening and restores the
  prior view.
- Three original MRI contrast-recorded candidates require a local choice;
  derived subtraction is excluded. A “with contrast” description cannot create
  missing agent evidence or enable Run.
- Cancel blocks late planning results; an external frame change invalidates
  the reviewed snapshot before execution.
- A one-based frame-40 request pauses cine and selects actual frame index **39**.
- Microphone denial leaves typing available; Cancel discards an actual
  MediaRecorder capture without transmission. A completed capture uses only the
  transcription endpoint and returns an editable transcript without auto-planning.
- Requests contain only the allowed command/audio fields and expected-model
  guard. Browser exceptions, console errors and requests beyond the configured
  test origin were **zero**.

The ignored receipt is
`artifacts/browser-ai-workflow-62381-final/results.json`. It records no original
images, credentials, command/transcript, model prose or screenshots. Its
`genuineProviderUsed` and `genuineVoiceTranscription` values are **false**: the
microphone lifecycle was exercised, but its transcript was supplied by the
fixture. Operational-event privacy is qualified separately by integration unit
tests; the standalone entrypoint has no event subscriber.

### Private local-study follow-up

The same source fingerprint passed **5 actual-UI checks** using privately
selected local CT/MRI media through the browser File API. A deterministic local
planner drove the reviewed actions; no genuine provider was invoked and no
original imaging bytes were uploaded. The checks exercised CT DICOMDIR import,
actual distinct CT window rendering, refusal to manufacture missing contrast
evidence, a three-candidate original MRI choice and opening the selected
150-instance acquisition.

The private count-only receipt is retained outside public source publication.
It contains no patient identifiers, study paths, dates, image files, credentials,
commands/transcripts, model prose or screenshots. Browser exceptions, console
errors and external browser requests were **zero**. This focused local-study
follow-up is not a full-corpus or clinical validation claim.

### Genuine provider qualification

The final invited HTTPS run passed **6 actual standalone checks**, with exactly
**three genuine HTTP 200 calls**: CT planning with `gpt-6.1-sol`, optional speech
transcription with `gpt-transcribe`, and planning of the reviewed voice command.
The CT task produced distinct lung/soft-tissue rendering and guarded Undo.
Actual Record/Stop captured offline-generated speech; the returned transcript
remained editable and caused no automatic planning. Explicit Plan and Run then
paused the ultrasound on image **40** (array index **39**).

The ignored receipt is
`artifacts/public-workflow-62381-native-voice-final/results.json`. Native fetch
was untouched, requests contained only the allowed fields, and browser
exceptions, console errors, external browser requests and image uploads were
zero. One visually inspected review screenshot contains only generated CT pixels,
a generic command and its model plan. No operator recording, original clinical
inputs, transcript, invitation, cookie or provider key was retained.

An earlier attempt recorded silence from Chrome's simulated file microphone and
returned HTTP 502; it is retained as a failed attempt rather than counted as a
pass. An isolated-browser audio-service/autoplay fixture adjustment enabled
non-silent speech capture with the **unchanged production capture code**. The
final receipt records those test-only Chrome flags. A separate bounded generated
WAV probe also confirmed the transcription service's HTTP 200 response and text
validation. These checks establish the exercised software paths, not arbitrary
command accuracy, every microphone/browser or clinical performance.

### Reproduce the gates

The default run builds on generated inputs and uses its own deterministic
loopback service; it needs no provider credential and makes no genuine AI call:

```sh
npm run check
node tools/browser-ai-workflow-check.mjs \
  --output artifacts/browser-ai-workflow
```

An explicit `--origin` targets a separately running, compatible invited demo
and makes genuine, billable planning calls with generated images. The private
invitation file is read locally; no provider key enters the browser. For example:

```sh
node tools/browser-ai-workflow-check.mjs \
  --origin https://d3gv6o0ove04h3.cloudfront.net \
  --expected-model gpt-6.1-sol \
  --output artifacts/browser-ai-workflow-public
```

Adding **`--live-voice`** explicitly opts into the genuine speech gate: two
planning requests and one transcription request. It uses generated speech,
actual Record/Stop controls and a reviewed editable transcript; it does not
record the operator or use original medical inputs. This mode may save one
review screenshot containing only generated CT pixels and generic task prose,
as declared in its receipt. Use a separate ignored output directory and inspect
the command's exit status and receipt; an incomplete/failed attempt is not a pass.

```sh
node tools/browser-ai-workflow-check.mjs \
  --origin https://d3gv6o0ove04h3.cloudfront.net \
  --expected-model gpt-6.1-sol --live-voice \
  --output artifacts/browser-ai-workflow-public-voice
```

All of these remain research software integration checks. They do not qualify
anatomy identification, automatic anatomical measurement, image registration,
clinical accuracy, every microphone/browser or every real DICOM study. Slice
links remain subject to the viewer's existing geometry/compatibility checks.


## Actual standalone AI transport — 2026-10-21

Source fingerprint
`9f83f631ac090337099bd4eacb21d6e35b69708de3fe0aa15c8db49442c3d96b`
passed **2,305 automated tests**, production bundling and distribution checks.
Two added regressions exercise the default native-like transport for Test and
Generate. The client invokes fetch independently rather than as a method on
the AI client object.

Before the correction, the actual standalone Test control reported an unavailable
gateway with **zero POST requests**. A harmless configuration-file probe verified
that direct native fetch returned HTTP `200`, while invoking that same native
function as an object method threw an `Illegal invocation` TypeError. The
earlier SDK harnesses wrapped fetch to capture bodies; that wrapper masked the
receiver error. Their historical model, draft and SDK receipts below retain
their original scope and fingerprints.

`tools/browser-ai-standalone-check.mjs` loads the shipped standalone page and
never replaces, binds or wraps its native fetch function. It observes bounded
test-request fields through CDP and uses a disposable browser profile. The
local OpenAI demonstration passed **5 checks**:

- The actual header/Test action in a fresh browser reaches the gateway, gets
  HTTP `401` and shows controlled sign-in guidance.
- The actual invitation form signs in without a model call.
- The actual Open Images/file-picker workflow imports and displays one
  generated extensionless 2 × 2 DICOM, without uploading it.
- The actual header/Test control then succeeds with **one genuine OpenAI
  `gpt-6.1-sol` connection call**, despite prepared image facts being present.
  Both test requests contain exactly `{"version":1,"task":"connection-test","facts":[]}`
  and the matching expected-model header; no image context is submitted.
- Native fetch remains unchanged, with no unexpected uploads, external browser
  requests, runtime exceptions or console errors.

The same fingerprint passed **5 actual standalone checks on the invited HTTPS
deployment**, with exactly **one genuine empty-facts connection call**. Its
receipt is `artifacts/browser-ai-standalone-public-20261021/results.json`.
The first hosted attempt stopped during sign-in, before inference; the harness
was then changed to wait for the complete login page and its deferred submit
handler. The successful hosted rerun records one login POST/`200`, and no
credentials, query strings or model prose. The local receipt retains the earlier
harness hash; both runs used the same viewer build and native transport.

The local count-only receipt belongs under ignored
`artifacts/browser-ai-standalone-local-20261021/results.json`. No credentials,
cookies, model prose, screenshots or original medical files are retained. This
focused connection gate does not repeat the earlier draft-generation suite or
establish model/clinical accuracy. It explicitly makes one model call; use
`--unauthenticated-only` for a fresh-session transport check with no provider call.

```sh
node tools/browser-ai-standalone-check.mjs \
  --origin http://127.0.0.1:5188 --expected-model gpt-6.1-sol \
  --output artifacts/browser-ai-standalone-local-20261021
```

## OpenAI activation qualification — 2026-10-21

Candidate source fingerprint
`cbed0d1a6c491198349cf9936227b658137d11ec6c2199a4f487678bfe6da6b2`
passed **2,303 automated tests** plus production build/distribution checks.
`node tools/browser-ai-check.mjs` passed **12 generated SDK browser checks**,
including the SDK-owned expected-model equality header on Generate and Test.
No genuine provider was invoked by these generated checks.

The provider browser gate now reads `viewer-config.json` and checks the deployed
profile/model instead of assuming Nova Micro. `--expected-model` can pin an
explicit expected response-model identifier; `--provider` and optional `--region`
identify the operator-selected deployment in its count-only receipt. It also
checks that every inference request carries the profile model in the SDK-owned
`X-Easi-Ai-Model` equality guard. The gate
still requires a private invitation and makes exactly three explicit model calls
with generated inputs. It does not put a provider key in the browser.

The activated HTTPS demonstration passed **4 genuine OpenAI browser checks**
using `gpt-6.1-sol`. Exactly **three** model calls used generated inputs:
connection test (empty facts), series explanation (14 facts) and a selected
measurement summary (6 facts, retaining the independently expected 0.75 mm
viewer calculation). Request previews and the model equality header matched
all three operations; response model provenance matched `gpt-6.1-sol`.

The metadata draft retained **one numeric-review warning**, with 14 valid
evidence references. The measurement draft had **zero numeric-review warnings**
and three valid evidence references. Both had **zero unknown references**.
These flags remain visible and all prose remains an unverified draft; passing
the integration does not establish general factual or clinical correctness.

The count-only receipt is stored under ignored
`artifacts/browser-ai-openai-provider/results.json`. It records model/build and
request counts without credentials, provider response text, screenshots, original
images or patient information. Browser exceptions, console errors and requests
beyond the configured origin were zero; owned resources were zero after cleanup.
The Bedrock counts/fingerprint below remain historical provider-specific evidence.

The reference gateway rejects a stale/changed expected model with HTTP `409`,
requiring refresh and fresh sign-in; the header does not select or authorize
another model. After the activation's invitation rotation, the current private
invitation is required. The operator ran:

```sh
node tools/browser-ai-provider-check.mjs \
  --origin https://d3gv6o0ove04h3.cloudfront.net \
  --expected-model gpt-6.1-sol --provider OpenAI \
  --output artifacts/browser-ai-openai-provider
```

The explicit provider and standalone gates make genuine model calls. Ordinary
automated tests and the deterministic generated browser gate require no provider key.

## AI Assist Preview — 2026-10-20

The focused build is
`739fbfdff100ae3226ea193003bc7a7401622c422b5d704b8d4af0242c2f16d5`.
`npm run check` passed **2,239 tests**, bundling and distribution checks.

- `node tools/browser-ai-check.mjs`: **12 generated checks**, using an explicitly
  deterministic loopback qualification gateway. Exact reviewed JSON, allowlisted
  technical/measurement facts, no automatic calls, streamed inert text,
  source-bound evidence, independent 0.75 mm measurement expectations,
  numeric/unknown-reference warnings, cancel, 390px/Escape UI, source-change
  invalidation, independent unconfigured embeds, disabled AI and cleanup passed.
  Nine additional source-binding/queued-request cases cover insertion/reordering,
  removal, duplicate identities and original-frame resolution. Exact decoded-frame
  identity is admitted before viewport commit, including after a queued stack
  changes; mismatches cannot replace the displayed image.
  Desktop and narrow screenshots were visually reviewed. This fixture service
  does not count as a genuine model invocation.
- `node tools/browser-ai-provider-check.mjs`: **4 genuine-provider checks**,
  through the separately authenticated deployed HTTPS demonstration service.
  Exactly
  **three** explicit calls used Amazon Bedrock `amazon.nova-micro-v1:0` in
  `us-east-1`: synthetic connection, series explanation and selected measurement
  summary. The two drafts retained their exact reviewed facts and verified
  response-model label. Both had zero numeric-quotation and unknown-evidence
  flags in this run. No original medical inputs were used.

Receipts remain ignored under `artifacts/browser-ai/` and
`artifacts/browser-ai-provider/`. The genuine-provider receipt contains counts
and model/build provenance, never the private invitation, cookie, model text,
pixels or patient information. Only the configured CloudFront demonstration
origin was contacted by the browser; genuine provider inference occurred on the server. Both suites
recorded zero browser exceptions/console errors and released owned worker,
encoded and decoded resources. The historical corpus and cross-engine campaigns
were not repeated by these focused checks. These results demonstrate software
integration and do not establish general semantic or clinical correctness.

The genuine gate is an explicit operation that invokes the selected remote
model. It requires the [separately started source-checkout gateway](https://github.com/davidvaccaro/easi-view/tree/main/examples/ai-gateway)
and a private invitation file outside the repository. The verified deployment is
[the invited AI demonstration](https://d3gv6o0ove04h3.cloudfront.net/api/ai/login);
pass `--origin https://d3gv6o0ove04h3.cloudfront.net` to target it. Its default
local origin is `http://127.0.0.1:5188`; `--passcode-file` selects the private file and
`--output` selects an ignored receipt directory. It never prints the access
code or model response. Ordinary automated/unit tests do not require provider
credentials or make model calls.

## Compact current-image notices — 2026-10-19

Build `32ef900adce39bb8b20454343529306496be404b484ff382e5f37a3158a5301b`
passed `npm run check`: **2,097 automated tests**, production bundling and
distribution validation. **46 generated browser checks** passed:

- `node tools/browser-notices-check.mjs`: **16 checks** for native hover and
  pointer movement into the popup, keyboard focus/Enter/Space/Escape, click/touch
  pinning and outside dismissal, unread highlighting, retained current messages,
  same-study acknowledgements, independent series/studies/viewers and session reset.
  Frame/pane changes close stale content; inactive-pane work preserves the pinned
  active context; clearing its pane removes old messages. Clean and noticed images
  have identical viewport and Details dimensions. Inspector-hidden access,
  a 390px viewport, long literal text, real wheel scrolling and an offset 550×420
  embed are covered, along with preserved original pixels and visible errors.
- `node tools/browser-geometry-check.mjs`: **21 checks** preserving exact GPU,
  probe, pixel/mm measurements, ROI and annotation alignment, original Attributes,
  rollback, pane/viewer isolation and narrow layout. Notice interactions leave
  canvas dimensions unchanged.
- `node tools/browser-pet-padding-check.mjs`: **9 checks** retaining alignment
  and precision compatibility, full-range worker/GPU/probe samples, original
  attributes, frame/cine behavior, color SC and strict excess-payload rejection.

The updated full corpus browser driver also passed a separate smoke run with
**4 generated files and all 7 frames**: clean, optional geometry, invalid-US
manual timing, and combined JPEG alignment/precision notes. It checks real draws,
pointer tools, ROI invariance, compact-notice access/read/reopening, original
source hashes, cine and awaited cleanup. This does not repeat the earlier private
23,893-file campaign or extend its historical fingerprint.

Generated desktop, narrow and embedded screenshots were inspected. Evidence is
retained under ignored `artifacts/browser-compact-notices/`, with `notices/`,
`geometry/`, `pet/` and `generated-corpus-summary.json` receipts. All runs recorded
zero uploads, external requests, browser exceptions or console errors, and released
their worker/pixel resources. No original medical files or screenshots were used.

## Import progress and whole-body PET navigation — 2026-10-19

Build `ee8370778b56cc9d7f6a0f8320f489dbd89608c3e690cbd27a07d6c66a3f63ca`
passed `npm run check`: **2,085 automated tests**, production bundling and
distribution validation. **48 generated browser checks** passed:

- `node tools/browser-import-overlay-check.mjs`: **8 checks** for final local
  DICOMDIR/image admission, a painted dimmed/inert content area, centered spinner,
  focused enabled cancellation, success and exact GPU pixels, Escape during
  indexing, clean reopen, failure/retry, synthetic cancellation, narrow layout,
  reduced motion and resource cleanup. Native generated-file choosers are
  fulfilled through CDP before testing progress. The foreground test observes
  animation-frame and bounded-timer yield paths before the first import read;
  automated tests separately cover paint ordering, background-tab fallback and
  cancel-before-work behavior. Headless scheduling can use the timer fallback
  even when the document reports visible.
- `node tools/browser-pet-stacks-check.mjs`: **10 checks** for WHOLE BODY 5→1
  and STATIC 3→1 navigation grouping while DYNAMIC 4→2 and GATED 8→4 remain
  partitioned. First/middle/last navigation verifies requested original identity,
  original Attributes/reference times, JPEG Lossless worker samples and GPU
  output. Full-scope slice/window synchronization and reconstruction reject
  differing time metadata. Generated source hashes and disposal remain correct.
- `node tools/browser-large-series-check.mjs`: **9 regression checks** preserving
  unrelated 419/283 AcquisitionNumber partitions, paged selection, exact GPU/probe
  values, unchanged memory budgets, visible oversized-source failure and cancellation.
- `node tools/browser-session-navigation-check.mjs`: **21 regression checks** for
  cards/instances, pane assignments, dragging, opening/menu/close behavior,
  deduplication, multiframe navigation, metadata-first archive requests and cleanup.

Two synthetic import-progress screenshots were inspected at desktop and narrow
sizes. Evidence is retained under ignored `artifacts/browser-import-stacking/`,
with separate `overlay/`, `pet-navigation/`, `large-series/` and
`session-navigation/` receipts. Generated runs recorded no uploads, external
requests, browser exceptions or console errors. No original medical inputs were
used in these automated gates or screenshots.

A separate read-only private-media browser run confirmed **11 series, 12 stacks
and 1,906 frames**. The formerly fragmented classic series each have one stack
with **419 and 284 images**. All 11 native card selections passed; six
first/middle/last frame checks plus six exact-source-instance reopen checks
confirmed source SOP/frame identity and real GPU output. It recorded zero
uploads, external requests, browser exceptions, console errors or retained
worker/encoded/decoded resources after disposal. Its count-only receipt is
`private-pet-navigation.json` in the ignored evidence directory. No original
screenshots, identifying metadata, UIDs or pixel values were exported. This
selected navigation gate does not claim every original frame was redrawn; the
earlier all-1,906-frame decode receipt remains separate.

## Large partitioned series selection — 2026-10-19

Build `12cc7278727c0201d82b496d6a2f51aef349fdf4fd77ce5d4f346c3a1363b535`
passed **2,062 automated tests**, production bundling/distribution checks and
**42 generated browser checks**:

- `node tools/browser-large-series-check.mjs`: **9 checks** for series with
  419/283 independently preserved partitions, paged global stack indices 128/418,
  individual instance selection, exact stored texture/GPU/probe references,
  lazy decoding, narrow layouts and visible rejection of a genuine 1,025-stack
  oversized source without replacing the previous image. Cancellation is quiet.
- `node tools/browser-session-navigation-check.mjs`: **21 checks** for series
  cards, instance selection, panes, dragging, session cleanup and remote metadata
  navigation, including exact original-value draws and requested assignment.
- `node tools/browser-local-working-set-check.mjs`: **12 checks** for bounded
  retention/eviction, selected comparisons, preserved windows/measurements,
  cancel/failure rollback, 12,288-frame rejection and complete resource disposal.

The large-series harness SHA-256 is
`c8c05f7a262448e792b821ef43b32563f7f9a0fc6fdae6633c326eb27a4f8e53`.
Three generated screenshots were inspected. Evidence is retained under ignored
`artifacts/browser-large-series/`, with navigation and cache receipts in
`session-regression/` and `cache-regression/`. Generated checks recorded no
uploads, external requests, browser exceptions or console errors.

A separate private browser run used local File inputs for the reported PET
media: **all 11 series card selections and 12 navigation checks passed**. It
checked pane/instance assignment and renderer output together, including the
last stacks and instances of the 419/283-stack series, selected last frames and
cine. Before the fix, those two cards failed admission and redrew the old image;
a draw-count increase alone would therefore have produced a false success.
The final run recorded no uploads, external requests, browser exceptions or
console errors. Its count-only receipts contain no original images, identifying
metadata, source UIDs or pixel values, and no original screenshots were taken.
This selected browser gate does not claim every original frame was drawn; the
earlier full-frame decoding receipt remains separate.

## Study-scoped encoding notice acknowledgements — 2026-10-19

Build `4325405fa78226ceb7cbf8f051176d69c58f4b3d8ae505afb26a81bf57f643f3`
passed **2,050 automated tests**, production bundling/distribution checks and
**40 generated browser checks**:

- `node tools/browser-notices-check.mjs`: **10 checks** covering individual
  issue acknowledgement across series and recreated stacks; only new issues
  appear, complete messages remain in Details/API, Show notice restores current
  messages, and other studies/viewers/direct SDK source contexts remain isolated.
  Geometry/timing notices, visible failed-open errors and session reset passed.
- `node tools/browser-geometry-check.mjs`: **21 checks** retaining calibrated
  versus pixel measurement notices, keyboard dismissal/restoration, pane/viewer
  isolation, rollback, annotation alignment, original pixels and mobile layout.
- `node tools/browser-pet-padding-check.mjs`: **9 checks** preserving original
  source bytes/attributes, exact worker and GPU samples through 65,535,
  navigation/cine and strict excess-payload rejection.

Four new synthetic notice screenshots were inspected. The notice harness SHA-256
is `fe9f3806daa1d2c3fb03da608e9075f5d2939faf5640a2b88491d2ead15cafa1`;
evidence is retained under ignored `artifacts/browser-notices/`, with the geometry
and PET receipts in its `geometry-regression/` and `pet-regression/` subfolders.
Workers and retained buffers were released, with no uploads, external requests,
browser exceptions or console errors. The notice checks used generated data;
no original medical files were read or captured for this UI change.

## PET export compatibility — 2026-10-19

Build `42dc4cc09d79b687f2231faf07cec70554cea5281cff9a15ad31a54d8958fa39`
passed **2,032 automated tests**, production bundling and distribution checks.
`node tools/browser-pet-padding-check.mjs` passed **9 generated checks**:

- Reject multiple suffix bytes and a second JPEG codestream through the shared
  image pipeline; preserve the original generated source bytes.
- Render a generated Classic PET series with a nonstandard single alignment
  byte through actual workers, exact original samples, GPU pixel references,
  frame selection and playback.
- Preserve samples through 65,535 when an unsigned monochrome JPEG Lossless
  stream declares 16-bit precision but enclosing metadata declares 12/11.
  Verify effective 16/15 through the worker response, GPU shading and probes;
  retain original 12/11 in Attributes and show both compatibility notices.
- Render generated Multi-frame True Color SC `.7.4`, with exact RGB channels,
  frame navigation and playback.
- Release the worker and retained buffers on disposal, with no uploads,
  external requests, browser exceptions or console errors.

Three synthetic screenshots were visually inspected. Evidence is retained in
ignored `artifacts/browser-pet-padding/`; the harness SHA-256 is
`60db10cc89347e4a7b2b39f48994d2882a76de1ca4c66fb882ece44a1b33a273`.

A separate read-only qualification of the privately reported PET media indexed
**1,623 image instances / 11 series** and decoded **all 1,906 frames** through the
local viewer data pipeline. Dimensions and sample counts were checked for every
decoded frame; every series passed and the original DICOMDIR hash was unchanged.
These original inputs were not used by the browser harness, copied into the
repository or captured in screenshots. This all-frame decode receipt does not
claim a full browser-rendering campaign over the original study.

## Matching local records and confirmed study combination — 2026-10-19

Build `316b1a9bc3d745d0498dc6a0e60acc6f0800576592f791e2854e086bc3ff3681`
passed **1,988 automated tests**, production bundling, distribution checks and
strict TypeScript consumption of the preserved identity metadata.
`node tools/browser-patient-matches-check.mjs` passed **11 generated groups**;
`node tools/browser-open-workflow-check.mjs` passed **24 regression groups** on
the same fingerprint.

The new gate covers conservative local-only suggestions, explicit unchecked
consent, cancel, metadata changes, target frame/window/layout/measurement
preservation, stable study/series/instance IDs and original annotation references.
Independent stored samples and framebuffer assertions verify both MR/CT study
navigation and comparisons. Unchecked previews remain excluded through later
selected imports. Measured source records cannot be associated away; the legacy
SDK can combine a currently active unmeasured source without leaving a removed
patient context. Closing and reopening releases old associations. Remote,
foreign-source, incomplete and conflicting identity hints are excluded. Four
desktop/narrow screenshots were visually inspected. Reports record zero uploads,
external requests, browser exceptions and console errors. All browser inputs are
generated. Evidence stays in ignored `artifacts/browser-patient-matches/` and
`artifacts/browser-open-workflow/`.

Separate private, read-only catalog qualification of the reported local folders
retained all 3 studies, 41 series and 5,172 instances under one explicitly
associated patient. Image references and original provenance survived selected
readmission; both original DICOMDIR hashes stayed unchanged. No original images
or identifying metadata were exported. This is catalog association evidence,
not a repeat of the historical full-frame corpus campaign.

## Optional directory description encoding — 2026-10-19

Build `64aed0f3ee6ffca13757f4d2df6769ced9dddfb55862edec00eed07ee5db534a`
passed **1,971 automated tests**, production bundling and distribution checks.
`node tools/browser-directory-encoding-check.mjs` passed **8 generated groups**:
malformed optional study/series labels recover with an explicit omission notice;
directory-record charsets remain independently scoped; preview reads no image
pixels; cancellation preserves prior pixels and measurements; committing one
patient/study/two series renders independently expected first and subsequent
samples; malformed patient identity remains an error without replacing the prior
workspace. Desktop and 430px screenshots were inspected. Reports record zero
uploads, external requests, browser exceptions and console errors. Evidence stays
in ignored `artifacts/browser-directory-encoding/`.

A separate private, read-only check indexed all 2,180 referenced instances of the
reported MRI media and parsed all 21 series. First frames decoded for all 26
image stacks. No original-image screenshots or metadata values were exported;
the original DICOMDIR hash was unchanged. These checks do not claim every frame
was rendered or repeat the historical full corpus campaign.

## Compact image-stack labels — 2026-10-19

Build `7b581bdd7431e7530377ffe92d3796cc3c7b6ed0e83b297eb9010ed08bccc57f`
passed **1,955 automated tests**, production bundling and distribution checks.
`node tools/browser-stack-labels-check.mjs` passed **7 groups** using a generated
single series containing separate axial/coronal stacks. The gate checks concise
distinct labels, full accessible count wording, independent rendered sample
expectations on group selection and subsequent navigation, desktop/430px card
bounds, and disposal. Both screenshots were visually inspected. Reports record
zero uploads, external requests, browser exceptions and console errors. No original
medical files were used; broader historical browser/corpus runs were not repeated.
Evidence remains in ignored `artifacts/browser-stack-labels/`.

## Direct card, instance and pane navigation — 2026-10-19

Build `06848f835901e5acb0b4ff05d7dc8ad8cbfba97859bcc13247fbbff61fff308d`
passed **1,948 automated tests**, production bundling, distribution checks and a
strict TypeScript consumer for the instance, pane and session APIs. The generated
Chrome session-navigation gate passed **21 groups**, and the existing structured
opening gate below passed **24 regression groups** on this same fingerprint.

The new gate verifies card pointer/Enter/Space activation, paged local and remote
instance lists, first-encoded-frame multi-frame US selection, targeted series and
instance drops, independent panes, exact instance/series badges, clearing panes
and shrinking layouts. Wrong-viewer, expired, nonexistent-pane and cross-patient
drops cannot change the display. Rendered samples and independent framebuffer
readback are checked. Remote instance expansion requests metadata without a SOP
pixel request; selecting an instance then retrieves its image on demand.

Menu actions, Escape/focus restoration, session counts, local-file privacy,
library padding and narrow layouts are checked. Closing a missing-issuer media
patient and reopening newly selected File objects produces one replacement
patient, preserves the unrelated patient and does not resurrect unchecked studies.
Closing the entire session releases private catalogs, cached images, workers and
pending queries while preserving source configuration. Five new screenshots were
visually inspected. Reports record zero uploads, external requests, exceptions or
console errors. Every input is generated; original medical files and live PACS
were not accessed. The historical full corpus campaign was not repeated.

```sh
npm run check
node tools/browser-session-navigation-check.mjs
node tools/browser-open-workflow-check.mjs
tsc --noEmit --strict --target ES2022 --module NodeNext --moduleResolution NodeNext --lib ES2022,DOM,DOM.Iterable your-viewer-host.mts
```

Reports and generated screenshots remain in ignored
`artifacts/browser-session-navigation/` and `artifacts/browser-open-workflow/`.

## Structured opening and session navigation

Build `635307963a715e2b969f44e241d052435c5e33d21800c372bcc5ebc5f6cd67b8`
passed `npm run check` with **1,914 tests**, production bundling and distribution
checks. A strict generated-only Chrome gate passed **24 groups**, checking the
same source/build digest before and after the run. It covers the single Open
launcher, staged preview/cancel, selected-only DICOMDIR admission, image-folder
scanning that includes unreferenced selected images, rendered stack samples,
additive studies, current/comparison panes, active-pane series changes, four-pane
restoration, patient measurements, synthetic cine, remote patient/study paging,
fresh patient study queries and deferred image retrieval.

Cancellation during a real delayed synthetic HTTP pixel request leaves the
previous display and patient intact, with no late commit. Legacy file replacement
detaches the prior session patient banner; legacy additive imports enter the new
session navigator. A verified host study context detaches the prior local identity,
exports its original source references, and rejects an out-of-scope replacement
without changing the displayed pixels. Desktop, modal, comparison and 430-pixel
narrow screenshots were inspected. The report records zero uploads, external
requests, browser exceptions or console errors, and successful resource cleanup.
No original local images or live PACS patient data were used.

Reports are retained in `artifacts/browser-open-workflow/`. The independently
exercised DIMSE path uses generated responses at the transport boundary and real
EASI parsing/decoded frames; it does not qualify live PACS interoperability.

```sh
npm run check
node tools/browser-open-workflow-check.mjs
node --test test/source-registry.test.js test/dimse-gateway.test.js
tsc --noEmit --strict --target ES2022 --module NodeNext --moduleResolution NodeNext --lib ES2022,DOM your-viewer-host.mts
```

## Bounded local image retention

Build `4b9efcf1c8e28e8a02384159d3ec76d8e98a9b84d6ea8f1dc1d18dfe5fc2c29e`
passed `npm run check` with **1,820 tests** and production/distribution checks.
Generated Chrome qualification passed **12 new working-set groups**, plus the
existing **28 local-library** and **17 DICOMDIR** groups on the same build.
The new gate indexes 15,000 frames, repeatedly replaces a comparison beyond the
10,000 resident-frame limit, verifies eviction and actual File rereads, and
preserves independently checked GPU/framebuffer pixels, frame 3000, window and
measurements. Cancellation and a selected 12,288-frame source both restore the
prior panes. Byte/stack boundaries and shared backing allocations have focused
unit coverage, including actual enhanced partitions and source-lease disposal.

Separately, a private user-granted media folder was checked through the native
browser folder input. All 2,992 references indexed into two studies and twenty
catalog series; each series' default display stack rendered and navigated to its
last frame. The largest cross-study comparison (278 + 184 frames) rendered and
navigated in both panes. A measurement survived browsing and reopening. Encoded
resident data peaked at 246.25 MiB under the unchanged 256 MiB cap; disposal
released tracked buffers/workers. This did not render every frame or every scout
partition. No originals were copied, served over HTTP, exported or screenshotted.
The private receipt contains counts only. All browser gates recorded zero
uploads, external requests, exceptions and console errors.

New generated receipts and the inspected comparison screenshot are in
`artifacts/browser-local-working-set/`. Associated regression receipts and the
count-only private receipt are retained in `artifacts/local-working-set-20261016/`.
Historical corpus and browser receipts retain their original fingerprints.

```sh
npm run check
node tools/browser-local-working-set-check.mjs
node tools/browser-local-library-check.mjs
node tools/browser-dicomdir-check.mjs
```

## DICOMDIR terminal-pointer recovery

Build `609973307b6889c1a02a28228218c06f1f2f77ecdb84ebf35babfff8331ad995`
passed `npm run check` with **1,793 tests** and the production/distribution
checks. The generated DICOMDIR browser gate passed **17 groups**. It verifies
complete multi-patient indexing with a last pointer targeting an IMAGE, zero and
outside-record last pointers, visible recovery warnings, independent rendered
comparison pixels, retained measurements, and an actual folder failure followed
by a successful retry that clears only the stale local-import error banner.
Malformed traversal and ambiguous detached active roots remain rejected.

The final generated-only receipt, log and inspected screenshots are retained in
`artifacts/directory-root-fix-20261016/`; previous media qualification receipts
remain unchanged. The browser gate recorded zero uploads, external requests,
exceptions or console errors, and owned resources were released on disposal.

Separately, seven existing local directory indexes passed structural/reference
resolution with four stream chunk sizes under both the original and patched
reader (56 runs), without reading image streams. None reproduced the reported
last-root mismatch; the exact user-selected media was not available for verification.
The generated regressions reproduce and verify the reported failure condition.

## DICOMDIR media qualification

The 2026-10-16 media-import build has source digest
`bc2df776c4d0fc0620b10a99476d43ec7042f4513471f7a562450ea59c6d19ee`.
`npm run check` passed **1,778 tests**, the production build and distribution
checks. Isolated Chrome passed **14 DICOMDIR groups** and the existing **28
local-library groups** on this same build. Generated directory fixtures cover
real linked item offsets, nested extensionless paths, defined/undefined record
sequences and items, icons, inactive records, unsafe/ambiguous/missing references,
identity mismatches, complexity bounds and cancellation.

Browser qualification verifies native folder selection and paginated directory
drops, reference-only metadata indexing, complete study/series navigation,
independent stored-sample/framebuffer output, visible two-study comparisons,
additive imports and preserved measurements, clear failure reports, responsive
navigation, private operational events and complete disposal. Desktop comparison,
missing-reference and narrow-screen screenshots were inspected. No original
imaging files were used, and the media gate recorded zero uploads, external
requests, exceptions or console errors.

The new media receipt/screenshots are in `artifacts/browser-dicomdir/`; the
associated local-library receipt and logs are retained in
`artifacts/dicomdir-20261016/`. Earlier browser and full-corpus receipts retain
their original build fingerprints. This does not repeat the full image corpus
or the historical six-engine qualification.

```sh
npm run check
node tools/browser-dicomdir-check.mjs
node tools/browser-local-library-check.mjs
```

Both harnesses create isolated loopback-only servers and browser profiles. Keep
runtime inputs and build files unchanged while a browser gate runs.

## Local patient library qualification

The 2026-10-16 catalog/timeline build has source digest
`5cfd6dd93ed6e94a99541520edae7fbce19c19b39366b1f31037739ade95a414`.
`npm run check` passed **1,726 tests**, the production build and distribution
checks. Isolated Chrome checks passed **28 local-library groups**, plus the
existing **16 study-workflow**, **11 embedding**, **25 inspector** and
**8 archive-revocation** groups on this build.

The local-library gate verifies metadata-only indexing, exact scalar texture
uploads and independently computed framebuffer values in both comparison panes,
visible image labels/overlays, explicit series choices, additive imports,
patient measurement/export/undo isolation, reviewed identity association,
cancellation and competing requests, existing-source preservation, native
file/folder inputs, count-only events and awaited resource disposal. Desktop and
narrow comparison screenshots were inspected. All fixtures are generated;
there were zero uploads, external requests, browser exceptions or console errors
in the local-library gate.

The new receipt and screenshots are in `artifacts/browser-local-library/`.
Associated regression receipts and logs are retained separately in
`artifacts/local-library-20261016/`; historical corpus and browser receipts are
unchanged. This milestone does not repeat the full 23,893-file campaign or the
six-engine qualification below. Metadata indexing alone does not qualify image
renderability. See [LOCAL_LIBRARY.md](LOCAL_LIBRARY.md) for the exact scope.

```sh
npm run check
node tools/browser-local-library-check.mjs
```

The new harness starts its own loopback-only server and isolated browser profile.
Do not rebuild during a browser run: the gate verifies the build fingerprint
before accepting the result.

## Reading-layout qualification

The reading-layout build on 2026-10-14 has source digest
`04e60700e5fcac40898c149a918623896443d06994d95bb1c9e6158851cddbe5`.
`tools/browser-protocols-check.mjs` passed **30 synthetic groups** with the actual
embedded SDK and owned renderer in isolated Chrome 156.0.8078.12. These cover
metadata-only previews, shared original-frame decoding, independent CT windows
against scalar/GPU references, unchanged ROI statistics, local same-study MR
partitions and explicit overrides, current/prior roles, custom bounded JSON,
four-pane frame policies, failed-render rollback, cancellation, supersession,
source replacement, archive revocation during both growing and shrinking layouts,
mobile scrolling/focus, sibling isolation, and awaited disposal.

The receipt and four reviewed synthetic screenshots are in
`artifacts/browser-protocols/`. The final harness SHA-256 is
`d48c3571a63e8612f2b6d4c36c88f6811b7248de2b711f9dd87579e5266bb78b`;
fixture SHA-256 is
`bc6bb39ae8c7b2a8275474a622fcbd7f017363be6c9e5606be41622ab7758edd`.
There were zero browser exceptions, console errors, uploads or external requests.
The controlled archive received twenty synthetic requests, including five
canceled requests. No original imaging files or personal browser profiles were
used. Fifty repeated reset/apply cycles reused decoded frames without budget
growth. With 175 deliberately retained graphics-context references, live contexts
stayed at most six (four main panes and two sibling panes), and all contexts were
lost after awaited disposal. Removed panes explicitly release their owned context
where available, following the [Khronos context lifecycle extension](https://registry.khronos.org/webgl/extensions/WEBGL_lose_context/).
These are API liveness and owned buffer/cache/worker counters, not process/GPU
memory measurements. An earlier concurrent run on the preceding fingerprint
reported one pane-commit failure; an isolated 75-cycle follow-up passed. Its cause
was not established. The final retained-context check independently verifies
explicit disposal rather than attributing that earlier failure to a cause.

Build before starting a loopback-only preview. Run each harness with the actual
preview URL; do not rebuild or change runtime inputs during qualification:

```sh
npm run check
EASI_VIEW_URL=http://127.0.0.1:5174/ node tools/browser-protocols-check.mjs
```

The annotation, derived-object, enterprise, inspector and revocation receipts
also identify the exact build. The broader historical six-engine qualification
below was not repeated for this milestone.

`tools/browser-engine-check.mjs` exercises the built embeddable SDK with independently generated synthetic DICOM files and a controlled, in-process DICOMweb service. Playwright is a test driver supplied outside this project; it is not a viewer runtime dependency. No original imaging files, real archives, credentials, external websites or browser profiles enter this suite.

## Verified profile

The final 2026-10-14 integrated build passed **168 groups: 28 groups in each of six engine/render-mode combinations**. Each combination also performed 1,000 frame seeks with tool changes and 50 dispose/remount cycles.

| Pinned engine | Default renderer observed | Forced CPU renderer | Groups per mode |
| --- | --- | --- | --- |
| Chromium 156.0.8078.4 | WebGL2 | Canvas2D | 28 |
| Firefox 157.0 | Canvas2D fallback | Canvas2D | 28 |
| WebKit 27.2 | WebGL2 | Canvas2D | 28 |

These are Playwright 1.64.0 Linux engines, running in the official `v1.64.0-noble` **arm64** image pinned to `sha256:06a9939e57531807f8d5fd76ce44b53165ffb7d7501d87ab10e285c20b1e971f`, with Node 24.21.0. The container runs as `pwuser`, with Chromium's sandbox enabled, two CPUs, a 2 GiB memory limit, 256 MiB shared memory, fresh browser contexts and no external network. Only the distribution, driver, harness and synthetic fixture JSON are mounted, all read-only. The test server and browsers communicate through container loopback.

This evidence does not qualify Firefox WebGL2, native Safari, iOS/Android devices or every real-world DICOM encoding. The default backend is recorded rather than assumed. New runtime builds need fresh receipts.

## What is checked

Twenty generated fixture families cover native scalar samples, RLE signed and RGB data, JPEG Baseline grayscale/RGB, both supported JPEG Lossless UIDs, JPEG-LS lossless/near-lossless, JPEG 2000 lossless/lossy and reversible color transform, modality/VOI LUTs, SIGMOID, 8/16-bit palette tables, enhanced MR partitions and variable recorded timing. First and last frames have independently computed rendered RGBA references and original-value probes; original texture uploads are checked where WebGL2 is available. Enhanced partitions retain their original encoded frame indices.

Lossless original samples are exact. The controlled JPEG grayscale fixture allows one sample value of error; JPEG RGB allows three, near-lossless JPEG-LS allows two and the controlled lossy JPEG 2000 fixture allows three. Scalar rendered references additionally allow one 8-bit display level for rounding. These bounds belong to these fixtures and encoder settings; they are not general codec-quality guarantees. Palette and lossless RGB colors are exact.

The same real SDK/UI also checks recorded cine completion, independent 1/2/4 viewport navigation/windows and actual grid geometry, annotation statistics/import, failing synchronous and asynchronous host callbacks, per-pane HTTP cancellation, opt-in prefetch preemption, event privacy and complete disposal. The synthetic service rejects non-GET methods, and browser requests are restricted to its origin.

## CSP result and known WebKit behavior

The host uses a strict policy with the exact embedded stylesheet SHA-256 hash, external scripts, `wasm-unsafe-eval` for codecs and same-origin workers. It does not enable `unsafe-inline`. A separate positive control proves a prohibited `style="color:rgb(255,0,0)"` attribute is blocked. The viewer's actual stylesheet hash, applied CSS rules and pane geometry are verified in every mode.

WebKit 27.2 reports a native `<select>` control violation even for an otherwise empty select with no author `style` attribute. Its `report-sample` value is exactly `text-overflow:inherit`; [WebKit's select implementation](https://github.com/WebKit/WebKit/blob/main/Source/WebCore/html/HTMLSelectElement.cpp) creates that declaration in the user-agent shadow button slot. Direct DOM construction and `appearance:none` reproduce the issue. The suite records this engine-specific behavior separately and accepts only the exact enforced `style-src-attr`/inline/sample/viewer-source combination, with a count matching constructed select controls. Each final sustained WebKit run recorded 663 such violations: thirteen controls across 51 mounts. The earlier isolated 2D SDK build had five controls and 255 warnings; both counts match their respective constructed controls. Any other CSP violation or console error fails the suite.

No policy relaxation or template insertion workaround was applied. There were zero application CSP violations, application console errors or browser exceptions; WebKit's native-control messages remain explicitly present in its receipts. See the [CSP attribute directive](https://www.w3.org/TR/CSP/#directive-style-src-attr) for the distinction between attribute and stylesheet enforcement.

## Repeat the isolated run

From an installed checkout, build and check the distribution before running. Docker must be available. The pinned image below is the verified arm64 profile; a different platform or image needs its own qualification receipt. Keep Playwright and its container version aligned, as described in [Playwright's Docker guidance](https://playwright.dev/docs/docker).

```sh
npm run check
qa_repo="$(pwd)"
qa_driver="$(mktemp -d "${TMPDIR:-/tmp}/easi-view-engine-XXXXXX")"
PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install --prefix "$qa_driver" --save-exact playwright@1.64.0
node tools/browser-engine-fixtures.mjs "$qa_driver/fixtures.json"
cp tools/browser-engine-check.mjs "$qa_driver/check.mjs"
qa_image="mcr.microsoft.com/playwright@sha256:06a9939e57531807f8d5fd76ce44b53165ffb7d7501d87ab10e285c20b1e971f"
mkdir -p artifacts/browser-engines

docker run --rm --init --network none --user pwuser \
  --memory 2g --cpus 2 --shm-size 256m \
  --mount "type=bind,source=$qa_repo/dist,target=/dist,readonly" \
  --mount "type=bind,source=$qa_driver/node_modules,target=/driver/node_modules,readonly" \
  --mount "type=bind,source=$qa_driver/check.mjs,target=/driver/check.mjs,readonly" \
  --mount "type=bind,source=$qa_driver/fixtures.json,target=/fixtures.json,readonly" \
  -e PLAYWRIGHT_MODULE=/driver/node_modules/playwright/index.mjs \
  -e EASI_VIEW_DIST=/dist -e EASI_VIEW_SUSTAINED=1 \
  -e EASI_VIEW_ENGINE_IMAGE="$qa_image" "$qa_image" \
  sh -c 'node /driver/check.mjs; qa_status=$?; tar -C /tmp/easi-view-engine-results -cf - .; exit "$qa_status"' \
  > "$qa_driver/receipts.tar"
```

Check the command's exit status before considering the run passed. It exports available receipts even when an assertion fails, and preserves the test's failing exit status. Inspect and extract only the JSON receipt archive into `artifacts/browser-engines/`; no profiles or sockets are exported. Optional selectors are `EASI_VIEW_ENGINES=chromium,firefox,webkit` and `EASI_VIEW_RENDER_MODES=auto,cpu`. `EASI_VIEW_SUSTAINED=1` enables the sustained loop.

## Evidence and resource boundaries

Receipts contain engine/version, actual renderer, source digest, every built file's size/hash, harness SHA-256, synthetic fixture SHA-256, exact checks/tolerances, CSP control/known violations and final retained-resource counters. The verified milestone source digest is `540681b3025cd74d61119840d6c3e6f0237daf94029da06ba5bc33ed6efd5680`; its harness digest is `5517b1325da1fcc24cffb535976388d798f62c585697a53caeb2aedb3639bc81` and fixture digest is `90387dd25465a2bcd283b33a4ca3e51c687e68127c4b58ec3cc5f04f86aebb01`. Source digests identify build inputs, not an implied release commit or clinical certification.

During sustained runs, decoded retained samples stay within 64 MiB, shared encoded archive cache within 64 MiB, thumbnails within 4 MiB, active workers within one and completed timing history within 256 records. Local encoded source retention is additionally checked against the 256 MiB single-source ceiling. Every remount/final teardown awaits `whenDisposed()` and reports `cleanupPending:false` and zero owned resources. All unmasked snapshots also report zero overlay model/render allocations. Expensive per-pixel QA GPU readbacks are disabled during the seek loop, while the viewer still renders normally; the final draw is independently sampled again.

These are application resource counters on modest generated cases. They are not process-heap, browser allocator, GPU-memory, large-study capacity or comparative throughput measurements. See [PERFORMANCE.md](PERFORMANCE.md) for controlled pipeline timing definitions and baseline methodology.

## Integrated advanced qualification

The same final source fingerprint passed another **77 synthetic browser groups**: reconstruction 17, derived objects 21, enterprise 15, targeted revocation 8 and specialties 16. These use owned local loopback fixtures and independent quantitative/rendered-pixel references, with no original imaging files, external services or production credentials. Receipts in `artifacts/final-validation` include per-suite/harness hashes and a combined advanced receipt; the portable six-engine receipts are stored alongside them. Together the final build passed 245 browser groups. Advanced groups use the isolated local Chromium driver; the portable six-mode suite qualifies the 2D/runtime/CSP/lifecycle paths across its three engines, not every advanced profile on every native device.
