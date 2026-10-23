# Image inspector

The standalone viewer and embedded viewer share five inspector tabs. The
inspector follows the active image pane; switching tabs does not reload an image
or change its original samples, measurements or presentation.

| Tab | Contents |
| --- | --- |
| Details | Window/level, presets, image dimensions and calibration, original-value pixel probe |
| Measurements | Drawing/editing tools, current-frame measurement list, selected ROI statistics, undo/redo, delete and JSON import/export |
| Attributes | Searchable parsed DICOM attributes, file meta information, nested sequence/item paths, private/unknown tags and bulk-data summaries |
| Performance | EASI JS data flow, retained pixel/cache memory, recent successful pipeline/decode/display timings and reset |
| Objects | Imported SEG/AI masks, reported SR measurements, GSPS, visibility/style/removal, explicit presentation application and result export |

Details opens first. Choosing a measurement tool opens Measurements; choosing
Window or Probe returns to Details. Pan/zoom, image navigation and active-pane
changes preserve the selected tab. Counts on Measurements and Objects make
existing content visible from the tab bar. Closing the inspector preserves its
tab; each tab remembers its own scroll position for the viewer session.

The compact **Image notices** icon in the upper-right header consolidates the
active image's geometry, playback-timing and encoding messages. Unread notes
highlight the icon. Hover or keyboard focus opens the popover; click or tap keeps
it open so you can read and scroll. The popover names its active pane and image,
groups technical messages, and stays within the available viewer area. Escape,
its close button or an outside click closes it. It remains accessible when Details
or the whole inspector is hidden. Notices consume no image-stage or Details
space; actionable errors retain their visible banner.

**Mark as read** acknowledges the current messages without deleting them from the
popover or public API. Geometry/timing acknowledgement applies to the same loaded
stack and calibration. Encoding issues are acknowledged individually for the
admitted study across its series and reloaded stacks. A new issue or another
study highlights again. Direct SDK sources without a study catalog use the
loaded stack as their scope. State is bounded and in memory within that viewer,
and clears when the relevant patient/library or entire session closes. Reading
or closing the popover alone does not acknowledge messages. Calibration,
measurements, pixels, original attributes and public warning arrays are unchanged.

Use Left/Right Arrow to move between tabs, Home/End for the first/last tab and
Tab to enter the selected panel. Navigation is scoped to that viewer, following
the [WAI-ARIA tabs pattern](https://www.w3.org/WAI/ARIA/apg/patterns/tabs/).
At smaller widths, the inspector opens over the image rather than reducing the
image workspace to an unusable size. Selecting a drawing tool chooses the
Measurements tab without opening a closed overlay, so the image remains
available for drawing. Open the inspector to review the results. All styling
uses the viewer's theme tokens.

## Attribute browsing

Browse sequences and items using the small **+** and **−** buttons beside their
names. Branches start collapsed; opening one reveals its immediate children.
Child sequences and items can be opened in the same way. Columns stay aligned
without increasing indentation. Ten subtle shades use the current theme's
accent and panel colors to distinguish levels; the **L0**, **L1**, … label gives
the exact level even when shades repeat in a deeply nested branch. Empty or
unretained branches have no expansion button. **Expand all** and **Collapse all**
offer shortcuts, and the revealed rows remain paged in groups of 50.

Search by tag, dictionary name, value or sequence/item path. Both `00100010`
and `(0010,0010)` locate Patient Name. Search shows matching rows from every
retained level, including closed branches, with their sequence/item paths.
Long paths use an ellipsis; hover to read the full path.
Tree controls pause while a search is active; clearing it restores the open
branches. Long retained values have a separate disclosure. Unknown/private tags
remain visible even when a dictionary name is unavailable. Tree buttons support
keyboard activation and announce their expanded state to assistive technology.

Native text previews cover ASCII/default, UTF-8 and ISO_IR 100 (Latin-1).
Other native character sets are explicitly marked as limited rather than
decoded with a guessed encoding. DICOM JSON text is already decoded; the
archive client preserves declared VR and bulk-reference provenance for private
tags alongside EASI's materialized values.

The list represents the source instance's parsed metadata, including the
encoded functional groups for enhanced images. Image Details and measurements
use the resolved current-frame geometry and transforms. Attributes are
read-only; opening a tab does not rewrite metadata or save it to browser storage.
Pixel Data and other binary attributes show summaries rather than pixel arrays.
Bulk-data references are summarized and never fetched by the inspector.

Display metadata is retained once per source instance and shared across its
frames. The display snapshot is bounded to **128 KiB per instance**, **2 MiB per
source session**, **4,096 rows**, **16 sequence levels** and **4,096 characters
per value**. Byte limits count serialized UTF-8 display rows rather than browser
heap allocation. A warning identifies shortened values or an incomplete snapshot.
Filters persist while navigating frames within the same stack and clear when
switching stacks or removing the source. Open branches persist while frames
share the same retained instance snapshot; changing the instance resets them.
Archive inspection uses metadata
already retrieved for viewing. Source/pane changes replace the list, and
disconnect/revocation/disposal clear attributes belonging to removed sources.
Attribute values are displayed as plain text and are absent from default host
state/events and pipeline statistics.

See [ANNOTATIONS.md](ANNOTATIONS.md), [PERFORMANCE.md](PERFORMANCE.md) and
[DERIVED_OBJECTS.md](DERIVED_OBJECTS.md) for each tab's data and integration
contracts.
