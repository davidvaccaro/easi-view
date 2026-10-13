# Implementation roadmap

The competitive inventory contains 272 candidate capabilities across 21 domains
and 16 viewer families. It is a prioritization aid, not a statement of completed
features or universal parity. The interactive [catalog](easi-view-plan.html) and
[machine-readable inventory](feature-catalog.json) retain acceptance criteria and
primary evidence. The architecture now targets our own engine throughout.

| Phase | Target | Exit gate |
| --- | --- | --- |
| P0 | Owned renderer/runtime and raw-frame foundation | Numeric display/geometry tests, CPU reference, worker cancellation, cache and disposal checks |
| P1 | Useful 2D alpha | Local files and a verified DICOMweb archive; CT/MR/XR and cine; basic tools and measured first-image behavior |
| P2 | General viewer 1.0 | Multi-viewport layouts/sync, mature measurements, annotations, archive navigation, compressed profiles and cross-browser verification |
| P3 | Reconstruction and fusion | Geometry-correct MPR, slab/MIP, volume rendering, registration and quantitative reference fixtures |
| P4 | Derived objects and research | DICOM SEG/SR/GSPS interoperability, editing, AI overlays, reproducible export and reference validation |
| P5 | Enterprise integration | Authentication integration, persistence, auditing, controlled sharing, gateway deployment and operational validation |
| P6 | Specialty modules | Separately validated breast, cardiovascular, RT, pathology and other advanced workflows |

## Next work package after this alpha

1. Add a tested DICOMweb archive browser: QIDO study/series search, metadata-first
   navigation, prioritized WADO instance/frame retrieval and explicit authentication
   integration. The alpha URL field retrieves an image or multipart image response.
2. Establish repeatable real Orthanc integration runs, first-frame timing and
   rapid-scroll memory/cancellation benchmarks.
3. Add correct compressed frame indexing and independently tested codec providers.
4. Normalize enhanced per-frame geometry, timing and presentation attributes.
5. Introduce multiple viewports, linked navigation and durable annotation models.

Keep each slice small enough to prove with independent image/geometry expectations.
Specialty breadth must not displace the everyday viewer correctness gates.
