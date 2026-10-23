# Reading layouts and protocols

EASI View provides a versioned, viewer-owned reading-layout profile for already
loaded image stacks. It selects panes and display settings from normalized
metadata, then prepares only the chosen frames. This research alpha does not
import or export DICOM Hanging Protocol Storage objects or claim a general
clinical hanging-protocol implementation.

## Defined presets

| Preset ID | Behavior |
| --- | --- |
| `ct-dual-window` | The active CT stack must be monochrome and declare HU. Both panes show its same active logical frame, with center/width 40/400 and -600/1500. Scroll and camera links are requested; windows stay independent. |
| `mr-sequence-comparison` | The active monochrome MR stack occupies the first pane. A distinct monochrome MR stack from the explicit current role occupies the second. Multiple equally ranked comparisons require a manual choice. No T1/T2, anatomy or physiological classification is inferred. |
| `current-prior-comparison` | Separate current and prior roles select monochrome stacks. Each role must resolve uniquely or receive an eligible manual override. Earlier dates, similar names and adjacent library positions do not establish a role or registration. |

Use **Reading layout** to preview candidates and resolve missing or ambiguous
selections before applying. A candidate represents one existing loaded stack;
enhanced, temporal, echo and acquisition partitions retain separate indices.
Two stacks with identical visible metadata remain two candidates.

Preview reads normalized metadata from those stacks. It does not search an
archive, enumerate other series, fetch instances, read the truncated Attributes
display list, create thumbnails or decode pixels. A preview reports `ready` or
`unresolved`, with per-selector eligibility, scores and fixed reason codes.
Equal best scores produce `ambiguous`; input ordering never breaks a tie.

## SDK use

```js
const preview = viewer.previewReadingProtocol('ct-dual-window');
if (preview.status === 'ready') {
  await viewer.applyReadingProtocol('ct-dual-window');
}
```

Catalog indices identify already loaded stacks. For comparison, assign roles
explicitly; make the intended first MR sequence the active pane first.

```js
const options = {
  currentSeries: [0, 1, 2],
  priorSeries: [3],
  overrides: { comparison: 2 }
};
const preview = viewer.previewReadingProtocol('mr-sequence-comparison', options);
if (preview.status === 'ready') {
  await viewer.applyReadingProtocol('mr-sequence-comparison', options);
}
```

An override resolves a selector, not an arbitrary pane. It must satisfy that
selector's scope, required metadata rules, distinct-stack constraints and any
slot window/unit requirements. It cannot turn an RGB image into an HU image or
choose an out-of-range frame. Applying reevaluates the current metadata rather
than treating a previously displayed preview as authority.

Selected distinct stack/frame pairs are decoded through the existing broker,
admitted to the shared budget and held while the pane transaction commits.
Repeated slots reuse a prepared frame. Original SOP/frame identity, geometry,
intensity metadata and source/client lifetime are checked before acceptance.
Cancellation waits for an in-progress pane rollback; failures preserve the
previous successful workspace. No source is disposed merely because a protocol
borrows one of its frames. Metadata matching and display presets never change
original stored samples or measurement statistics.

```js
const controller = new AbortController();
const applying = viewer.applyReadingProtocol('ct-dual-window', {
  signal: controller.signal
});
controller.abort();
await applying.catch(error => {
  if (error.name !== 'AbortError') throw error;
});
await viewer.cancelReadingProtocol();
```

`resetReadingProtocol()` returns to one pane showing the **current active
original frame**, with its default presentation and links off. It clears the
active protocol marker. It does not restore the pre-application pane layout or
retain a hidden collection of old frames. Changing images or view settings can
mark an applied layout as manually overridden. Operational state and the
`readingprotocolchange` event expose counts, preparation/commit status and the
active protocol ID, without source UIDs, descriptions or pixel data.

## Versioned JSON definitions

`setReadingProtocols(array)` validates and replaces the entire in-memory
collection. Use `getReadingProtocols()` to obtain immutable normalized
definitions, or serialize definitions explicitly with `JSON.stringify`.
There is no automatic local storage or server persistence.

```js
import { getDefaultReadingProtocols } from './assets/easi-view.js';

viewer.setReadingProtocols([
  ...getDefaultReadingProtocols(),
  {
    version: 1,
    id: 'mr-literal-label',
    name: 'MR · selected label',
    layout: 1,
    selectors: [{
      id: 'review', scope: 'current',
      rules: [
        { field: 'modality', op: 'eq', value: 'MR' },
        { field: 'photometric', op: 'in', value: ['MONOCHROME1', 'MONOCHROME2'] },
        { field: 'description', op: 'contains', value: 'Synthetic sequence' },
        { field: 'effectiveEchoTime', op: 'range', value: [20, 40], required: false, weight: 10 }
      ]
    }],
    slots: [{ id: 0, selector: 'review', frame: { mode: 'middle' } }],
    links: { scroll: false, window: false, camera: false }
  }
]);
```

Selectors have a bounded slug ID, an explicit `selected`, `all`, `current` or
`prior` scope, and one to sixteen rules. `distinctFrom` can reference earlier
selectors and prevents reuse of their matched stacks. An unresolved dependency
blocks its dependent selector. There are no arbitrary JavaScript predicates,
regular expressions, remote URLs or image identifiers in this schema.

| Field type | Fields | Operators |
| --- | --- | --- |
| Text | `modality`, `description`, `photometric`, `unit`, `acquisitionContrast`, `complexImageComponent` | `eq`, `in`, literal `contains`, `exists` |
| Number | `rows`, `columns`, `frameCount`, `effectiveEchoTime`, `temporalPositionIndex`, `acquisitionNumber` | `eq`, `in`, inclusive `range`, `exists` |
| Boolean | `geometryKnown`, `dimensionsValid` | `eq`, `in`, `exists` |

Rules are required by default. Required failures exclude a candidate; optional
failures add explanatory codes without excluding it. Each matched rule adds
its declared integer weight, default one. Unknown or varied metadata remains
unknown. Text comparisons are case-insensitive literal comparisons; window
units use exact equality with the image's declared unit.

Slots have numeric IDs `0..layout-1`, reference a selector, and choose a logical
frame policy: `first` is zero, `middle` is `floor((frameCount-1)/2)`, `active`
requires an active-frame mapping, and `index` supplies a zero-based index.
Missing active mappings or unavailable indexed frames remain explicitly
unresolved. A supplied window has finite center/width, width at least one,
and uses the image's DICOM window function on monochrome pixels;
`windowUnit` adds an exact unit gate.
Link flags request the existing workspace behavior, whose geometry and
intensity compatibility checks remain authoritative. Links do not register
unrelated studies.

Definitions are limited to **32 protocols**, **64 KiB of serialized UTF-8 JSON
for a definition collection**, four selectors, sixteen rules per selector and
one/two/four fully specified pane slots. Candidate planning accepts at most
128 distinct stack indices and 10,000 logical frames per stack, within the
library's existing aggregate frame and resource caps. Unsupported fields,
versions, malformed JSON, accessors, cyclic structures and excessive inputs
are rejected before use. These limits describe this implementation profile,
not a standard or clinical workflow guarantee.

Detached application plans have a separate 1 MiB ceiling, allowing bounded
per-candidate explanations to exceed the definition collection's size.
`geometryKnown` uses the workspace's valid patient-coordinate guard;
`dimensionsValid` checks original frame indices and excludes explicitly invalid
or nonspatial acquisition dimensions. Missing geometry is not synthesized.

The browser SDK also exports the pure `normalizeReadingProtocol`,
`normalizeReadingProtocols`, `evaluateReadingProtocol` and
`getDefaultReadingProtocols` functions. Pure evaluation accepts an explicit
candidate metadata array plus `selectedIndex`, `activeFrames` and `overrides`;
its plan contains operational indices, display settings and reason codes.
Hosts remain responsible for the provenance and authorization of the loaded
sources and explicit role assignments.
