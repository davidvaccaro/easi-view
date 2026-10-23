# AI Assist (Preview)

AI Assist is optional and host-configured. **Tasks** turns a reviewed voice or
text command into a proposed viewer workflow. **Explain** retains technical
series explanations and summaries of explicitly selected existing measurements.
Both use a server-operated gateway; provider credentials stay out of the viewer.

Tasks can select available series, arrange panes, apply calibrated CT windows,
request compatible links, navigate frames, control cine, activate an existing
tool or return to an existing measurement. The model proposes a closed intent
plan; local code resolves it against the current viewing session. It does not
receive the catalog or control arbitrary viewer APIs. See
[AI_WORKFLOWS.md](AI_WORKFLOWS.md) for examples and exact action boundaries.

The assistant does not inspect pixels, locate anatomy, diagnose, infer a largest
organ slice or create anatomical measurements. Segmentation, imaging inference,
registration, third-party plugins and the marketplace remain backlog work.

## Use the panel

1. The host enables AI, configures its gateway and opts into Tasks with
   `workflows: true`. Open **AI Assist** from the header or primary menu.
2. In **Tasks**, keep **New task from study** for a new setup, or choose
   **Continue current view** to adjust existing panes. Type a short command.
   Alternatively choose **Record a task**,
   grant microphone access, speak and choose **Stop and transcribe**. This sends
   the audio to the configured transcription service; the 20-second recording
   limit also stops and sends it. **Cancel task** discards an unsent recording.
3. Review and edit the transcript, then choose **Plan task**. Only the reviewed
   command and bounded starting-point mode are sent for planning; no catalog or
   image context is attached.
4. Read **Proposed steps · review before running**. Choose a matching series for
   each ambiguous step. Paired lung/soft-tissue CT windows share one series
   choice for both panes. Missing metadata or unsupported requests leave Run
   unavailable and explain what needs clarification.
5. Choose **Run task**. The broker checks the captured session, then executes
   bounded actions through owned viewer APIs with visible progress.
6. Use **Cancel task** to stop further steps, or **Undo last task** to restore a
   completed task's prior view. Later manual changes invalidate Undo; it cannot
   overwrite a newer patient workspace. Closing the dialog stops active work.
   A completed task's guarded Undo remains available when the dialog is reopened.

**New task from study** is the default. The reviewed clean-pane preparation
runs only after **Run task**; planning never clears images. It stops owned cine
and pane links, prepares one pane, then applies the requested source/layout/view.
Imported studies and measurements stay available. **Continue current view** uses
the actual current images and settings, without persistent conversation history.
Choose it for a displayed-image adjustment or returning to an existing measurement.
If Continue reduces the layout to one pane, that pane keeps the previously active
image, frame, window and camera; it does not silently substitute the old pane A.

**New request** clears AI command/review/choices/errors and restores the default
starting point without clearing imported data or the previous task’s valid Undo.
Changing mode keeps the command but invalidates its review; neither action sends
a request or changes the view. The controls are disabled while work or microphone
use is active. Closing/reopening resets the mode while retaining guarded Undo.

Recording is push-to-talk only: there is no background microphone or browser
speech-recognition service. Denied permission or unsupported recording leaves
typed commands available. The microphone tracks are released on stop, cancel,
late permission cancellation, panel closure and disposal. Closing the panel
clears its transient command/recording/plan, without creating a saved conversation.

**Commands and sent audio leave the device.** They can contain identifiers the
user types or speaks; there is no automatic identifier redaction. The viewer
adds no automatic patient names, source UIDs, free-text descriptions, catalog,
DICOM files or pixels to a planning request. Local labels appear only in the
review choices. Avoid dictating identifiers into this demonstration.

### Describe the viewing goal

After opening a CT study, requests can describe routine review, lung/soft-tissue/
bone presentations, blended versus monoenergetic reconstructions, recorded
energy and thickness preferences, and relative stack positions. No series-card
navigation or internal number is required. Identical source requests are resolved
once and reused across all requested panes. See the ten conceptual examples in
[AI_WORKFLOWS.md](AI_WORKFLOWS.md#clinical-viewing-goals-without-series-numbers).

Configure `workflowPreferences: {routineCt: 'blended'}` inside `ai` when the host
wants suitable recorded blended images preferred for ordinary CT review. The
isolated demo enables it; the SDK defaults to `no-preference`. Example: `ai: {enabled: true, workflows: true, baseUrl: "/api/ai", workflowPreferences: {routineCt: "blended"}}` on a compatible host. The review states
when that display policy was applied. It is not a universal clinical ranking.
Other matching sources remain choices when no preference resolves them.

Selection uses bounded metadata and explicit evidence. Standard monoenergetic
energy is read numerically; tube kVp is not a substitute. Recognized description
labels stay local and are identified as label evidence. Missing, conflicting or
malformed values stay unknown. Ordinary CT excludes explicit scouts, derived
images and specialized products such as material maps and virtual-unenhanced
images. Explicit requested existing coronal/sagittal reformats can be used.
Supported-image/calibrated-HU checks still run when sources open.

Only the active patient's admitted studies are considered. Latest/prior matching
requires usable chronology and never silently borrows another patient's study.
Explicit displayed-series and exact-number overrides remain available. First,
middle and last refer to navigable stack positions, not anatomical landmarks.
Tool preparation requires clinician drawing/pointing; no image interpretation,
automatic anatomical measurement, phase inference or registration is performed.

### Explain existing facts

The **Explain** tab retains:

- **Explain this series:** explain selected technical image properties,
  calibration, units and controlled compatibility categories.
- **Draft a measurement summary:** summarize existing annotations explicitly
  selected by the user, using viewer-calculated values, statistics and units.

Review the named recipient/model, **Authoritative viewer facts** and **Exact
context sent to the gateway**, then explicitly choose **Generate**. Plain text
streams into an **Unverified draft**. Check it against the fact table. Source
buttons return to captured images; they do not attach results to the frame
currently being browsed. **Use current selection** discards the draft and
prepares another review.

Patient/source changes, annotation revisions, source removal and revocation
invalidate affected explanation contexts and late requests. Closing the panel
clears its draft and selected measurements. No AI output becomes a measurement,
finding or report automatically.

**Test connection** is explicit and sends an empty-facts synthetic test. It is a
connection check, separate from task planning, transcription and image facts.

## Configure an embedded viewer

```js
import {createViewer} from './assets/easi-view.js';

const viewer = createViewer(container, {
  initialDemo: null,
  ai: {
    enabled: true,
    workflows: true, // Opt into reviewed Tasks; omit/false retains Explain only.
    baseUrl: '/api/ai',
    label: 'Acme AI assistance',
    recipient: 'Acme-operated AI gateway',
    model: 'gpt-6.1-sol', // Must match the approved model on this host gateway.
    credentials: 'same-origin'
  }
});
await viewer.ready;

// These open/close controls do not send an inference request.
viewer.openAiAssist();
viewer.closeAiAssist();
```

`baseUrl` identifies the gateway root. Explain uses `POST <baseUrl>/generate`
and `POST <baseUrl>/test`; Tasks adds `POST <baseUrl>/plan` and optional
`POST <baseUrl>/transcribe`. The browser never calls a provider API directly.
A host enabling Tasks must implement the matching versioned plan/audio contracts;
completion-compatible text support alone does not supply these endpoints.
Relative addresses resolve against the hosting page. HTTPS is required except
for loopback HTTP during local development. Credentials in URLs, query strings,
fragments and redirects are rejected. `model` is the expected server model
identifier, not a client-side model selector. The SDK sends it in
**`X-Easi-Ai-Model`** as an equality guard, and host authorization callbacks cannot
override that header. The reference gateway requires an exact match with its
approved server model before inference. It never selects a different model from
this header. Generic host gateways may omit `model` when they do not enforce
this contract; the hosted demonstration always configures it.

The server determines its approved provider/model and invocation settings and
returns verified response-model provenance. If the configured profile changes,
HTTP `409` produces a controlled configuration-changed error: refresh the viewer
and sign in again before sending. Use the exact approved server model ID in the
example, such as `amazon.nova-micro-v1:0` for the Bedrock reference profile.

The default is disabled (`ai` omitted or `false`). `ai: {enabled: true}` exposes
setup guidance without a connection or inference request. Configuration is fixed
for the mounted viewer; dispose/remount to change the approved profile.

| Option | Meaning |
| --- | --- |
| `enabled` | Opt into the AI surface; defaults true when an `ai` object is supplied |
| `workflows` | Boolean, false/omitted by default. Enable the Tasks tab and explicit command/audio endpoints alongside Explain |
| `baseUrl` | Approved host gateway root, not a provider URL with a client-side key |
| `label`, `recipient` | Short plain-text connection/destination labels visible before sending |
| `model` | Expected server model ID, displayed before sending and bound by `X-Easi-Ai-Model`; never a model selector |
| `credentials` | `omit` by default, or `same-origin` for host-owned sessions |
| `getHeaders({signal})` | Optional host callback returning short-lived gateway authorization headers; never provide a reusable provider secret |
| `timeoutMs` | Positive timeout up to 60,000 ms; default 60 seconds |

If authorization is supplied by an existing application, the host can provide a
short-lived gateway token through `getHeaders`. Refreshing sign-in, authorizing
requests and storing credentials remain the host/gateway's responsibility.
The callback's signal supports cancellation while authorization is obtained.
CSP must allow the chosen gateway in `connect-src`; for another origin, that
server must explicitly allow the host origin. The separate source-checkout demo service has its
own deployment, authorization and usage limits. It is not part of the SDK npm archive.

The SDK exposes:

| Method | Behavior |
| --- | --- |
| `openAiAssist()` | Open the optional panel without sending; Tasks is present only when opted in |
| `closeAiAssist()` | Close the panel and cancel/discard owned transient recording, command, plan and draft; a completed task retains guarded Undo |
| `cancelAiAssist()` | Cancel active request/recording/task; a partially applied task attempts restoration only in its still-current patient workspace |
| `getAiState()` | Detached operational state/counts, including bounded workflow mode, phase/action/choice counts and Undo availability; no command, transcript, patient identifiers, draft text, provider headers or source URLs |
| `getAiDraft()` | Explicit access to the current draft, supplied facts, evidence labels, validation flags and model provenance; no pixel arrays or raw source identifiers |

`aichange` events contain safe operational state, not the prompt or draft.
Applications that explicitly retrieve `getAiDraft()` control any subsequent
handling/export; do not route it into generic telemetry incidentally. Disposing
the viewer cancels its AI work and releases the panel/client/controller state.

## Server-side OpenAI option

The source-checkout gateway includes **OpenAI Responses API** adapters targeting
**`gpt-6.1-sol`**, with `reasoning.effort: "low"` and `store: false`. Explain
streams bounded plain text from selected allowlisted facts. Tasks obtains one
strict, nonstreaming `submit_viewer_plan` function result from the reviewed
command and bounded starting-point mode;
that function is an intent envelope, not server-side execution or arbitrary code.
The viewer validates and grounds the result locally before review and Run task.

Optional speech uses the fixed **`gpt-transcribe`** model through the gateway's
transcription endpoint. Its transcript must be reviewed before Plan task; the
browser does not hold another provider key or choose an arbitrary speech model.
The normal `model` profile and expected-model header still bind the primary
server profile. There are no image attachments or persistent conversations in
either mode, and no direct browser-to-OpenAI requests.

The model and streaming interface follow the [official model documentation](https://developers.openai.com/api/docs/models/gpt-6.1-sol)
and [Responses streaming guide](https://developers.openai.com/api/docs/guides/streaming-responses).
`store: false` controls Responses storage; it does not establish a separate
provider/account retention agreement. Account access, billing, data handling
and permitted use remain the operator's responsibility.

**Historical explanation qualification, 2026-10-21:** the invited HTTPS demonstration switched to **OpenAI
`gpt-6.1-sol`** through the server-operated gateway. A genuine synthetic connection
test and both guided tools passed browser integration checks. The previous
Bedrock qualification remains historical evidence for that separate provider;
it is not relabelled as OpenAI evidence. Those receipts qualify the explanation
and connection paths, not the later Tasks/audio increment. New task/audio checks
are recorded separately in [BROWSER_VALIDATION.md](BROWSER_VALIDATION.md). Other
installations still need their own approved server credential, model access and
provider configuration.

These checks establish connectivity and source/fact handling, not general model
accuracy. The series explanation produced one numeric-review warning in this
run; the selected-measurement summary produced none. Unknown evidence references
were zero. Drafts remain unverified and the viewer facts remain authoritative.

For the local kit, place the OpenAI API key in this private file using a local
editor or secure credential-entry flow:

```text
~/.config/easi-view/openai-api-key
```

The file must be readable only by its owner (mode `0600`). It stays outside the
repository and is read by the server using `--openai-key-file`. Do not paste a
key into the viewer, a URL, a Git-tracked file, an environment file, command-line
argument values or browser configuration. The demonstration invitation code is
separate from the provider API key.

From a **source checkout**, after building the viewer and installing the
optional gateway dependencies, an operator can build a separate OpenAI variant
and start its loopback gateway:

```sh
node infrastructure/ai-demo/build.mjs --viewer-dist dist \
  --output artifacts/ai-demo-openai --provider openai --model gpt-6.1-sol
node examples/ai-gateway/server.mjs --provider openai --model gpt-6.1-sol \
  --openai-key-file "$HOME/.config/easi-view/openai-api-key" \
  --passcode-file "$HOME/.config/easi-view/ai-demo-access.json" \
  --static artifacts/ai-demo-openai/viewer --port 5188
```

The commands contain file paths, never key values. The static variant contains
only the public recipient/model/gateway settings. Stop any previous server on
that port through its owning terminal/session before starting its replacement.
The ordinary viewer build remains AI-disabled. The OpenAI demo variant enables
`ai.workflows: true`; a different host must opt in explicitly and deploy the new
plan/transcription endpoints together with its compatible viewer build. Audio,
planning, connection and explanation requests share the reference gateway's
session, concurrency and usage limits; a voice task normally consumes a
transcription request plus a planning request. Run/Undo are local viewer actions.

For the AWS deployment, the operator stores the key in **AWS Secrets Manager**
and supplies the **`OpenAiApiKeySecretArn`** stack parameter. The Lambda role reads
that approved secret server-side; the key does not enter CloudFront/S3 assets,
SDK configuration, model prompts or frontend logs. A secret ARN is a configuration
reference, not the secret value. See the [source-checkout deployment guide](https://github.com/davidvaccaro/easi-view/tree/main/infrastructure/ai-demo)
for the exact IAM, provider/model, rotation and deployment settings.

After any recipient/provider/model change, reload the viewer, review the new
recipient and **sign in again** at the deployment's `/api/ai/login` page. Sessions
are scoped to their configured provider/model, and existing drafts must not be
carried across a provider switch. Use the invitation there, not the OpenAI API
key. Then run **Test connection**, which sends no patient/image facts.

### Local demonstration addresses

| Address | Purpose |
| --- | --- |
| `http://127.0.0.1:5188/` | Local OpenAI demonstration: viewer and AI gateway share this origin. Sign in at `/api/ai/login` using the current private invitation. |
| `http://127.0.0.1:5174/` | Ordinary viewer development server; AI is disabled in its default configuration and it does not provide the AI gateway. |

When restarting the local demonstration, use the server's **`--provider openai`
and `--model gpt-6.1-sol`** flags together with the **OpenAI static variant** via
`--static artifacts/ai-demo-openai/viewer`, as shown above. Both the running
server and its served viewer profile must identify the same approved model.
Reload and sign in with the current invitation after a restart/provider change.

The restarted local service first passed an SDK-mounted generated-input gate
on **2026-10-21**: four checks and three genuine OpenAI calls. Both drafts had
zero numeric-review warnings and unknown evidence references in that run. Its
receipt, `artifacts/browser-ai-openai-local-20261021/results.json`, qualifies
that SDK harness, whose request-capture fetch wrapper masked a native-fetch
receiver error in the standalone application.

The corrected standalone build was then checked separately with its native
fetch function untouched. All **five actual-UI checks** passed: fresh-session
sign-in guidance, the invitation form, generated local-file import/display and
one genuine synthetic Test connection. Its exact empty-facts request does not
include the displayed image context. The ignored receipt is
`artifacts/browser-ai-standalone-local-20261021/results.json`; this is local
standalone evidence, separate from hosted AWS and earlier SDK qualification.
The same build also passed five actual-UI checks on the invited HTTPS deployment
with one genuine empty-facts call; its separate receipt is
`artifacts/browser-ai-standalone-public-20261021/results.json`.
See [browser validation](BROWSER_VALIDATION.md) for the build, commands and
login-readiness adjustment used in the hosted rerun.

## Connection and request errors

The panel shows controlled messages without exposing provider response bodies,
credentials or internal stack traces:

| Message/category | Next step |
| --- | --- |
| Access expired or was not authorized (`401`/`403`) | Sign in to the configured application/demo service, then retry. Demo invitation sessions expire; a model/provider switch also requires signing in again. |
| Configuration changed (`409`) | Refresh the viewer and sign in again. Review the newly displayed recipient/model; a stale tab must not send facts under an outdated service profile. |
| Service busy or usage limit reached (`429`) | Wait for the permitted window or ask the host operator about its cap. Connection tests also consume an inference call. |
| Configured model could not complete the request (`502`/provider error) | The operator should check its server-side key, provider/project model access, billing and provider status. Do not enter a key in the viewer. |
| Request timed out (`504` or timeout event) | Try again after checking service availability; the viewer retains its existing image and measurements. |
| Gateway unavailable (`503` or transport failure) | Confirm the gateway is running/reachable and that its server configuration is ready. A local viewer on port 5174 does not itself provide the AI gateway. |
| Invalid response/context | Refresh the selected context or contact the operator; unsupported content is not admitted as a draft. |

Opening the panel does not probe the service automatically. An unconfigured
panel shows setup guidance, while an explicitly configured connection can still
fail because its server/provider is unavailable. These states are distinct.

## Data and validation boundaries

The modes have deliberately separate payloads:

| Operation | Sent to the host gateway/provider | Kept in the viewer |
| --- | --- | --- |
| Plan task | Version, task, reviewed command text and optional bounded starting-point mode | Session catalog, source identities, candidate descriptions and local action bindings |
| Stop and transcribe | Version, task, media type and the captured audio | No automatic image, catalog or patient-record context is added |
| Run task / Undo last task | No new AI inference request | Captured plan, local choices, source loading and viewer actions; configured remote archives can still be read through ordinary viewer APIs |
| Explain / measurement draft | Task and allowlisted typed facts with opaque evidence IDs | Raw identifiers, source URLs, private tags, unrestricted descriptions, raw DICOM and pixels |
| Test connection | Synthetic test with empty facts | Current image and measurement context |

User text/audio can itself contain identifiers or other sensitive information.
Do not describe Tasks as de-identified or entirely on-device. Provider data
handling follows the operator's configured service/account policy; `store: false`
is a Responses setting, not a promise covering speech or every provider policy.

Commands are limited to **1,200 characters** and an **8 KiB** serialized request.
Plans contain at most **12 closed model actions**, with a **32 KiB** serialized
limit. Review includes local preparation through **16 expanded steps**, rejecting
longer lists rather than hiding actions. The optional `mode` field accepts only
`fresh` or `continue`; existing three-field command requests remain accepted and
keep continuation semantics. Mode is bound to the local review/execution snapshot.
Browser recordings are limited to **20 seconds** and **2 MiB** before base64
transport; the gateway bounds the encoded envelope and decoded audio size.
Explain requests retain their **32 KiB**, **256-fact**, **16-measurement** limits,
and **64 KiB** maximum draft. The default client timeout is **60 seconds**.
Each viewer coordinates one active AI operation. No automatic inference,
background catalog submissions, persistent browser transcript or background
microphone is introduced. Deployed gateways still authorize and bound requests.

A plan can only use the declared action union. Unknown actions/fields, invalid
panes/frames and stale snapshots are rejected. Missing or conflicting contrast
and geometry evidence stays unknown. Review choices use local metadata; a
recorded Contrast/Bolus Agent does not prove enhancement, phase or a primary
acquisition. Source data and measurements are not rewritten by task actions.

For Explain, source labels are checked against supplied evidence; unknown labels
are flagged and cannot become navigation targets. Numeric quotations are checked
against supplied values/units and discrepancies are flagged. This limited check
does not prove semantic or clinical correctness. Prose remains bounded literal
text and an unverified draft; it is not executable HTML, script, a viewer action
or an automatically accepted finding.

## Gateway and future work

[The invited HTTPS demonstration](https://d3gv6o0ove04h3.cloudfront.net/api/ai/login)
uses OpenAI `gpt-6.1-sol` behind a private invitation and temporary server session.
The ordinary viewer build remains AI-disabled; the isolated deployment enables
its same-origin gateway profile. The provider switch rotated the invitation:
use the current privately supplied code and sign in again. Do not place either
the invitation or the provider key in URLs or browser bundles.

The [source-checkout demonstration gateway](https://github.com/davidvaccaro/easi-view/tree/main/examples/ai-gateway) describes the actual
provider adapter, server-owned credentials, local operation and deployment.
Generated browser qualification uses a separate deterministic loopback service;
that service is a test fixture, not a claimed genuine model invocation.
Real-provider qualification is recorded separately with synthetic inputs only.

The [AI backlog](AI_BACKLOG.md) retains the full target architecture, plugin SDK,
imaging models, browser inference, extension distribution and interoperable
result-export milestones. This Preview slice does not complete those targets
or change the viewer's alpha/research status.


## Sign in again without losing an open study

The demonstration viewer is public; AI requests use a separate 30-minute,
HttpOnly session cookie. Refreshing the viewer does not renew AI access. Choose
**Sign in to AI** in AI Assist, authenticate in the new tab, close that tab and
retry explicitly in your original viewer. Its local files, panes and task stay
available. Signing in never automatically replays an AI request.

The reference demo profile sets `signInUrl: '/api/ai/login'`. An embedding host
may optionally configure `ai.signInUrl` for its own gateway login page. It must
use the gateway origin, HTTPS (or loopback HTTP), and have no embedded credentials,
query or fragment. Omit it when authentication is handled by the application.
The viewer never derives a navigation URL from a model response or server error.

Use the same host as the original viewer: `localhost` and `127.0.0.1` do not
share cookies. No patient identifier, current URL or local file path is appended
to the sign-in link. The new tab has no opener or referrer access.
