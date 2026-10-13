# EASI View

EASI View is an independent browser DICOM viewer with EASI JS as its data
pipeline. Keep rendering, interactions, scheduling, and workspace behavior
owned by this project. Do not add Cornerstone, OHIF, vtk.js, or another viewer
engine without an explicit architectural decision by the owner.

Use ES modules and focused classes. Keep original stored pixel values and
patient-coordinate geometry separate from presentation. Never silently
render an unsupported image profile. Preserve EASI JS's pipeline abstraction
and its independent license; do not fork or edit it incidentally.

All public demos and automated tests use generated synthetic DICOM. Never
commit local imaging files, secrets, environment files, or credentials.
Use data/local/ only for ignored local assets. Local file viewing must not
upload data or produce telemetry. DICOMweb connections are explicit user actions.

Run `npm run check` for behavioral changes. Use independent numeric/display
expectations, cancellation/memory tests, and browser checks for viewport changes.
Keep CHANGELOG.md, README.md, and docs/STATUS.md accurate about supported
profiles. New specialty features must meet a documented correctness gate.

The local research alpha does not claim clinical or regulatory validation.
Use the EASI View Community License; eligibility mirrors EASI JS, including
group-wide revenue strictly below USD 5 million and its institutional exceptions.
