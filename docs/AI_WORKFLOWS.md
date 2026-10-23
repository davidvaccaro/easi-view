# Reviewed AI viewer workflows

AI Assist **Tasks** translates a short typed or spoken request into proposed
viewer steps. The model receives your command and starting-point mode; the viewer
resolves image choices
locally and executes only after review. A configured compatible host gateway and
`ai.workflows: true` are required. **Explain** remains available for technical
facts and existing-measurement drafts. See [AI_ASSIST.md](AI_ASSIST.md) for setup.

## Try a task

1. Add the intended images/studies and select the intended patient. For study
   searches, use the intended current study; opening an individual series first
   is unnecessary. For commands about an already displayed image, choose
   **Continue current view**.
2. Open **AI Assist → Tasks**. Keep **New task from study** for a new setup, or
   choose **Continue current view** for an adjustment. Type a command or choose
   **Record a task**.
3. For voice, grant microphone access and choose **Stop and transcribe**. Audio
   is sent to the configured speech service; reaching 20 seconds also stops and
   sends it. Cancel discards an unsent recording. Review/edit the transcript.
4. Choose **Plan task**. Review the proposed actions and named recipient/model.
   The planner has not seen your catalog or found images remotely.
5. Choose a matching series wherever a local choice is required. Then choose
   **Run task**. Progress identifies each step; Cancel stops further work.
6. Inspect the resulting panes. **Undo last task** restores the prior view only
   while no later manual view/patient/source changes have superseded the task.

The OpenAI reference gateway uses **`gpt-6.1-sol`** for planning and
**`gpt-transcribe`** for optional speech. Commands and sent recordings leave the
device. Do not put patient identifiers into them: typed or spoken identifiers
are not automatically removed. The viewer adds no catalog, source identifiers,
raw DICOM or pixels to these requests. Opening a selected remote series can
still retrieve images through the viewer's ordinary configured archive APIs.

## Choose a request starting point

**New task from study** is the default. Planning uses the current patient/study
catalog without inheriting an old displayed image. Only **Run task** stops owned
playback/links and prepares one clean pane before the requested setup. Imported
studies and measurements remain available. A request that only adjusts an existing
image asks you to switch to Continue or specify a new viewing goal.

**Continue current view** uses the actual captured panes, images and settings.
It does not replay a previous command or provide persistent chat memory. Use it
for “pause this image,” “change this pane to lung windows,” or “return to my last
measurement.” Explicit layout changes are still honored; if a smaller layout
removes the active pane, the remaining pane keeps that active pane’s image,
frame position, window and camera before subsequent active-pane actions apply.
For example, collapsing a view with pane B active carries B into the one-pane
layout rather than switching to the old pane A source.

Changing the starting point keeps your editable command but clears its reviewed
plan/choices; plan again before Run. **New request** clears command, plan, choices
and errors, resets New task from study, and keeps imported data and the previous
task’s valid Undo. Neither control changes the viewer or invokes AI. Controls are
locked during active planning/execution/transcription or microphone use. Closing
and reopening Tasks resets its starting point without discarding a valid Undo.

## Clinical viewing goals without series numbers

Tasks can describe the desired viewing session. A closed `select-view` intent
is resolved locally against the current patient's available stacks; relative
`position` intents calculate first, middle or last from the actual navigable
image count. The model receives the command and bounded starting-point mode.
It does not receive this
technical index, descriptions, source identifiers or pixels.

The isolated demonstration explicitly configures
`ai.workflowPreferences: {routineCt: 'blended'}`. When a suitable recorded
blended reconstruction is available, routine/lung/soft-tissue/bone CT requests
can select it automatically and disclose that local display preference in the
review. This is not a claim that blended is universally clinically superior.
The SDK default is `no-preference`; an embedding host chooses its own policy.
With no eligible preferred stack, genuine ambiguity remains a local choice.

The following commands are independent tests after opening the intended CT
study. No series card or internal series number is needed. Current/prior
comparison additionally requires an eligible earlier study for the same patient
already in the session; absence produces clarification without partial execution.

| Request | Expected viewing work |
| --- | --- |
| Set up this chest CT for routine review. | Resolve one routine axial stack for both panes; independent presets and compatible slice/camera links. |
| Prepare a one-pane lung review of this CT. | Choose a suitable routine axial stack and lung presentation. |
| Prepare a one-pane bone review of this CT. | Choose a suitable stack and bone presentation; this does not create a sharp reconstruction. |
| Compare the lowest-energy monoenergetic axial CT reconstruction with the blended axial reconstruction side by side, both in soft-tissue windows. | Resolve recorded energy and family separately; compare available sources without an invented clinical ranking. |
| Show the routine axial CT in lung, soft-tissue and bone windows in three panes of a four-pane layout. | Reuse one stack in all three presentations and preserve independent windows. |
| Open the routine axial CT at its middle image and activate the ellipse measurement tool. | Calculate the midpoint and prepare a manual ROI; the clinician draws it. |
| Open the routine axial CT at its middle image and activate the distance measurement tool. | Calculate the midpoint and prepare a manual length measurement. |
| Open the routine axial CT and play through its images. | Start sequential slice playback; CT playback is spatial, not patient motion. |
| Show the first and last images of the routine axial CT side by side without linking them. | Resolve stack endpoints locally and preserve independent positions. |
| Compare this current CT with the most recent prior CT side by side in soft-tissue windows, without linking them. | Resolve current/prior sources within the active patient and display both without inventing registration. |

Optional technical requests include an explicit recorded energy such as
“70 keV,” the lowest/highest recorded monoenergetic energy, thinnest/thickest
recorded slice thickness, or an explicitly recorded standard/sharp kernel.
Tube kVp is never treated as reconstructed keV. Recognized local description
labels are lower-strength evidence than standard attributes; the review names
that evidence. Invalid, conflicting and missing values remain unknown. A claim
such as “lowest energy” or “thinnest” cannot be resolved over an otherwise
matching cohort with unknown values. No first-row or majority-vote guess is used.

Ordinary viewing excludes explicit scouts, derived images, projections,
virtual-unenhanced images and material maps. Existing recorded reformats can be
selected for an explicitly requested coronal or sagittal plane. No new MPR is
created by these actions. Explicit specialized-family requests remain deliberate
selections, with original source/profile and HU-unit checks still enforced.
Identical conceptual selectors share one source choice across all panes, not
only the original lung/soft-tissue special case. Any remaining choices use
reconstruction descriptions first, with series identifiers secondary.

The assistant pauses and positions an existing stack for measurement preparation.
It does not locate an organ, identify a lesion, choose an anatomical landmark,
perform a diagnosis, infer enhancement phase or draw a measurement. Earlier
plans and explicit displayed-series/series-number overrides remain supported.
Cancel, stale-session validation, same-patient rollback and Undo still apply.

## Example 1: one CT, two useful windows

Add the intended CT study to the viewing session, then enter this command. You
do not need to expand its series cards or open a particular series first:

> Show this CT in lung and soft-tissue windows side by side.

The viewer searches the **current study's local metadata** for eligible axial
CT stacks, excluding explicit localizers, derived images, reformats,
projections, virtual unenhanced reconstructions and material maps. It does not
send the catalog to the model. A single qualifying stack is selected
automatically. A configured local routine CT preference can also resolve an
eligible reconstruction and is disclosed in review. Otherwise choose one
**inside AI Assist** before Run becomes available; one shared choice supplies
both panes.
For example, a synthetic study with 70 keV, 50 keV and blended reconstructions
can contain three equally qualifying stacks with the same geometry. Their
metadata does not establish one as the clinically correct choice. A configured display preference is
distinct from a claim of clinical superiority; no energy preference is invented.

After review and Run, expect two panes containing the **same resolved image
stack**. The lung preset is center **−600 HU**, width **1,500 HU**; soft tissue
is center **40 HU**, width **400 HU**. Slice/view linking can keep compatible
navigation together while the independent window presets remain separate.
Try scrolling, then Undo to return to your previous layout/view.

For this paired-window request, “this CT” uses the current study when one is
known. If no current study is established, matching stays within the active
patient's admitted studies: one unambiguous candidate can resolve automatically,
while multiple candidates require a choice inside AI Assist with study labels.
The viewer does not silently take the first study or search another patient's
images. To retain an already displayed stack deliberately, choose **Continue
current view**, then say:

> Show the currently displayed CT series in lung and soft-tissue windows side by side.

An exact series-number request also preserves that deliberate selection. General
search exclusions do not block those explicit requests, but rendering and HU
calibration checks still apply. Uncalibrated or color images cannot acquire HU
calibration by applying a preset; the operation must refuse rather than guess
units. The same applies when metadata indexing succeeds but pixel loading later
finds an unsupported image profile.

Image Type evidence is deliberately separate from ORIGINAL/DERIVED status. A
virtual unenhanced reconstruction can be marked ORIGINAL and AXIAL while also
carrying an explicit specialized processing token. Missing or conflicting
reconstruction evidence remains unknown; a series description alone does not
establish its processing class. Unknown derivation does not become an ORIGINAL
claim, and can remain eligible when the other requested criteria match. Loading
the stack must still establish supported geometry and calibrated HU pixels
before the CT windows can be applied.

## Example 2: find contrast-recorded MRI acquisitions honestly

Open a synthetic or local MR study containing multiple axial acquisitions with
actual **Contrast/Bolus Agent (0018,0010)** metadata, then enter:

> Display an axial MR series with recorded contrast-agent information.

When several original acquisitions qualify, expect a local list of matching
series. Choose the intended acquisition before Run becomes available. Generic
searches exclude explicit derived series and localizers; an exact requested
series number can select those deliberately. For example, with an available
synthetic series numbered 1002:

> Display series 1002 from the active study.

A recorded agent means administration information is present. It does **not**
identify a primary acquisition, enhancement, arterial/venous phase or a clinical
finding. A missing agent stays **unknown**, even when a series/study description
says “with contrast.” Such a case should ask for clarification or an explicit
series choice rather than invent evidence. Conflicting instance metadata also
stays unknown instead of inheriting the first image's value.

## Example 3: control an ultrasound cine without hunting for controls

Open a supported ultrasound cine with at least 40 frames and select its pane.
Choose **Continue current view**, then enter these as separate tasks:

> Play this ultrasound.

> Pause this ultrasound and show frame 40.

The second task should stop cine and display **image 40**. User-facing frame
numbers are one-based; this is the 40th navigable image, not array index 40.
With pane B active and no pane named in the command, pane B is the target. The
built-in US demonstration has 24 frames, so use **frame 12** there instead.
Out-of-range requests must leave the view usable and explain the problem.

## Example 4: arrange an explicitly selected prior

Add two CT studies for the same confirmed patient. Choose the current study and
comparison study using the existing Session library comparison workflow, then
enter:

> Show the current CT and my selected prior side by side with soft-tissue windows.

Choose the matching series for each step when necessary. Expect the selected
studies, independently reviewable windows and no inferred lesion correspondence.
For a chronology-based request, “latest” uses available local study chronology;
“prior” means the most recent earlier matching study relative to the active
study. Ties remain choices. Missing dates cannot establish a prior examination.
Selecting a prior explicitly is useful when several examinations are available.

In **Continue current view**, you can separately request:

> Synchronize compatible slices in these panes.

Geometry checks still apply. Different Frame of Reference values or incompatible
planes/acquisition families can leave panes unlinked. The completion notice must
report that limitation. This feature does not register examinations or infer
that similarly numbered slices show the same anatomy.

## Example 5: return to existing work

Draw a supported distance or ROI measurement, browse elsewhere in the same
patient workspace, choose **Continue current view**, then enter:

> Return to the image with my last measurement.

The viewer should reopen the actual source image and select the existing
annotation. No new annotation or model-derived measurement should appear. A
request such as “Activate the ellipse measurement tool” can prepare a manual
tool; the clinician still draws and reviews the measurement.

## Supported actions and limits

| Capability | Current boundary |
| --- | --- |
| Starting point | New task from study (default, clean pane only at Run) or Continue current view (actual current panes, no chat history) |
| Layout | One, two or four panes |
| Image selection | Displayed stack, active/latest/prior/selected-prior study; supported modality, principal plane, recorded contrast state, bounded body region or exact series number |
| Ambiguity | Local choices; paired CT windows share one series choice, and known multiple image stacks remain separate choices rather than silently stack zero |
| CT windows | Lung, soft tissue, bone and brain presets on calibrated HU monochrome CT; default/reset available |
| Linking | Existing compatible slice/window/view links; no image registration |
| Navigation | One-based frame requests and cine play/pause in the requested or captured active pane |
| Tools | Existing window/pan/zoom/probe and manual measurement tools |
| Existing measurements | Return to the source image of the last existing measurement; no automatic anatomical measurement |
| Recovery | Cancel; same-patient partial restoration when safe; one guarded completed-task Undo |

Plans contain at most **12 closed model actions**. The review also shows local
preparation, with at most **16 expanded steps**; an oversized review is rejected
rather than hiding executable steps. The optional request `mode` accepts only
`fresh` or `continue`, is bound into the local snapshot, and changes neither
the catalog-upload policy nor model authorization. Legacy three-field requests
remain accepted with continuation semantics. Unknown actions/arguments, stale
snapshots, invalid panes/frames and incompatible CT calibration are rejected.
Manual interactions, patient changes and source changes can invalidate a review
or Undo. Re-plan against the current session rather than applying an old plan.
The panel remains an optional research Preview.

“Find the largest liver slice and measure the right lobe” is deliberately
unsupported. It needs qualified anatomy localization and a defined measurement
method. The language model cannot inspect image pixels in this implementation;
it must not invent endpoints, findings or quantitative results.

## Reproducible generated cases

Public tests use generated data only. `test/fixtures/workflow-studies.js` creates
an invented CT study with missing agent metadata and several MRI contrast-recorded
candidates, including a derived subtraction. It contains no original clinical
images or identifiers. Reconstruction tests also cover explicit virtual
unenhanced, material-map, reformatted and projection Image Type tokens, including
specialized images marked ORIGINAL. Metadata, broker and adapter checks can be
run from a source checkout with:

```sh
node --test test/workflow-metadata.test.js \
  test/workflow-broker.test.js test/viewer-workflow.test.js
```

`npm run check` also covers these tests, production build and distributable
checks. Actual browser interaction and genuine provider/audio qualification have
separate receipts in [BROWSER_VALIDATION.md](BROWSER_VALIDATION.md). Deterministic
model fixtures prove viewer contracts; they do not establish model or clinical
accuracy.
