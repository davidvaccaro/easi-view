export type Demo = 'ct' | 'mr' | 'xr' | 'us';
export type Layout = 1 | 2 | 4;
export type Tool = 'window' | 'pan' | 'zoom' | 'probe' | 'distance' | 'angle' | 'rectangle' | 'ellipse' | 'polygon' | 'select';
export interface Window { center: number; width: number }
export interface Branding { name?: string; logoUrl?: string | null; logoAlt?: string; showReleaseTag?: boolean }
export interface Theme { accent?: string; background?: string; panel?: string; text?: string; muted?: string; border?: string }
export interface ViewerOptions {
    branding?: Branding;
    theme?: Theme;
    ui?: { header?: boolean; library?: boolean; inspector?: boolean; statusBar?: boolean; demos?: boolean };
    initialDemo?: Demo | null;
    styleNonce?: string | null;
    /** Configured repositories. Registration makes no network request. */
    sources?: RemoteSourceConfiguration[];
    opening?: OpeningPolicy;
}
export interface OpeningPolicy { localImages?: boolean; localStudies?: boolean; remoteStudies?: boolean; tests?: boolean; sourceEditing?: boolean }
export type SourceSearchField = 'patientId' | 'patientName' | 'patientBirthDate' | 'issuerOfPatientId' | 'accessionNumber' | 'studyDate' | 'modality';
export interface RemoteSourceConfiguration extends ArchiveConfiguration {
    id: string; name: string; type: 'dicomweb' | 'dimse';
    /** Declare optional matching fields only when the repository supports them. */
    searchFields?: SourceSearchField[];
}
/** Safe source metadata: excludes connection URLs, credential suppliers and headers. */
export interface RemoteSource {
    readonly id: string; readonly name: string; readonly type: 'dicomweb' | 'dimse';
    readonly capabilities: { readonly searchFields: readonly SourceSearchField[]; readonly patientSearch: true; readonly studySelection: true; readonly retrievalMode: 'instance' | 'frame'; readonly requiresGateway: boolean };
}
export interface OpenWorkflowState {
    open: boolean; step: string; intent: 'images' | 'study' | null; busy: boolean;
    sourceId: string | null; patientId: string | null; selectedStudyIds: string[];
    patientCount: number; error: string; patientOffset: number; studyOffset: number;
}
export interface SessionState {
    patients: number; studies: number; series: number; instances: number; frames: number;
    activePatientId: string | null; currentStudyId: string | null; comparisonStudyId: string | null;
    busy: boolean; disposed: boolean;
}
export interface SessionSource { readonly kind: 'local' | 'remote' | 'test'; readonly id: string; readonly label: string; readonly protocol: string | null }
export interface SessionInstance {
    readonly id: string; readonly sopUid: string; readonly sopClassUid: string;
    readonly instanceNumber: number | null; readonly frameCount: number | null;
    readonly status: string; readonly indexStatus: string; readonly availability: string;
    readonly stackIndex?: number; readonly frameIndex?: number;
}
export interface SessionImageOptions { viewport?: number; stackIndex?: number; frameIndex?: number; signal?: AbortSignal }
export interface WorkflowMetadata {
    plane: 'axial' | 'coronal' | 'sagittal' | 'oblique' | 'unknown';
    bodyPart: string; contrast: 'present' | 'absent' | 'unknown'; localizer: boolean | null;
    derivation: 'original' | 'derived' | 'unknown'; uniform: boolean;
    reconstruction: 'axial' | 'reformatted' | 'projection' | 'virtual-unenhanced' | 'material-map' | 'unknown';
    ctFamily: 'conventional' | 'blended' | 'monoenergetic' | 'unknown';
    familyEvidence: 'attribute' | 'image-type' | 'label' | 'unknown';
    energyKeV: number | null; energyEvidence: 'attribute' | 'label' | 'unknown';
    sliceThicknessMm: number | null;
    kernel: 'standard' | 'sharp' | 'unknown'; kernelEvidence: 'attribute' | 'label' | 'unknown';
    contrastEvidence: { agentRecorded: boolean; routeRecorded: boolean; startTimeRecorded: boolean; stopTimeRecorded: boolean };
}
export interface SessionSeries {
    workflow: WorkflowMetadata;
    readonly id: string; readonly patientId: string; readonly studyId: string; readonly seriesUid: string;
    readonly description: string; readonly modality: string; readonly seriesNumber: number | null;
    readonly instanceCount: number | null; readonly frameCount: number | null; readonly status: string; readonly source: SessionSource;
    readonly instances: readonly SessionInstance[]; readonly instancesLoaded: boolean;
    readonly stackGroups: readonly { readonly id: string; readonly label: string; readonly frameCount: number }[];
}
export interface SessionStudy {
    readonly id: string; readonly patientIdOpaque: string; readonly studyUid: string; readonly studyDate: string;
    readonly description: string; readonly accessionNumber: string; readonly modalities: readonly string[];
    readonly seriesLoaded: boolean; readonly series: readonly SessionSeries[]; readonly source: SessionSource;
}
/** Explicit metadata access contains patient identifiers. Do not use for telemetry. */
export interface SessionPatient extends LocalPatientIdentity {
    readonly id: string; readonly synthetic: boolean; readonly source: SessionSource; readonly studies: readonly SessionStudy[];
    readonly identityStatus: string; readonly warnings: readonly string[];
    readonly originalIdentities?: readonly LocalPatientIdentity[];
}
export interface SessionCatalogView {
    readonly patients: readonly SessionPatient[]; readonly activePatientId: string | null;
    readonly counts: {readonly patients: number; readonly studies: number; readonly series: number; readonly instances: number; readonly frames: number};
}
export interface ArchiveConfiguration {
    baseUrl: string;
    headers?: Record<string, string> | ((request: { url: string; signal?: AbortSignal }) => Record<string, string> | Promise<Record<string, string>>);
    credentials?: 'omit' | 'same-origin' | 'include';
    /** Frame mode requires an archive serving the documented native frame profile. */
    retrievalMode?: 'instance' | 'frame';
}
export interface StudyFilters { patientId?: string; patientName?: string; patientBirthDate?: string; issuerOfPatientId?: string; studyDate?: string; accessionNumber?: string; modality?: string; studyUid?: string }
export interface PageOptions { offset?: number; limit?: number; signal?: AbortSignal }
export interface Page<T> { items: T[]; hasMore: boolean; nextOffset: number | null; warnings: string[] }
export interface Study {
    studyUid: string; patientName: string; patientId: string; studyDate: string; description: string;
    accessionNumber: string; modalities: string[]; seriesCount: number | null; instanceCount: number | null;
}
export interface Series {
    studyUid: string; seriesUid: string; modality: string; description: string;
    seriesNumber: number | null; instanceCount: number | null;
}
/** Counts and opaque session keys only: no patient names, DICOM identifiers, or filenames. */
export interface LocalCatalogCounts {
    readonly patients: number; readonly studies: number; readonly series: number; readonly instances: number;
    readonly frames: number; readonly batches: number; readonly metadataBytes: number;
}
export interface LocalLibraryState extends LocalCatalogCounts {
    readonly activePatientId: string | null; readonly currentStudyId: string | null; readonly comparisonStudyId: string | null;
    readonly indexing: boolean; readonly busy: boolean; readonly disposed: boolean;
    readonly media: LocalMediaReport | null;
}
/** Count-only outcome for the last successfully read local DICOMDIR import. */
export interface LocalMediaReport {
    readonly mode: 'dicomdir'; readonly directories: number; readonly referenced: number; readonly resolved: number;
    readonly missing: number; readonly ambiguous: number; readonly invalid: number; readonly inactive: number;
    readonly unsupported: number; readonly unreferenced: number; readonly warnings: readonly string[];
}
export interface LocalImportResult extends LocalLibraryState {
    readonly added: number; readonly duplicates: number; readonly failed: number;
}
/** Source metadata is available only through the explicit getLocalCatalog() call. */
export interface LocalPatientIdentity {
    readonly patientName: string; readonly patientId: string; readonly issuerOfPatientId: string; readonly patientBirthDate: string;
}
export interface LocalInstanceMetadata {
    readonly id: string; readonly sopUid: string; readonly sopClassUid: string; readonly instanceNumber: number | null;
    readonly frameCount: number | null; readonly indexStatus: 'metadata-only'; readonly availability: 'unverified';
}
export interface LocalSeriesMetadata {
    workflow: WorkflowMetadata;
    readonly id: string; readonly seriesUid: string; readonly studyUid: string; readonly studyId: string;
    readonly patientIdOpaque: string; readonly patientKey: string; readonly description: string; readonly modality: string;
    readonly seriesNumber: number | null; readonly instanceCount: number; readonly frameCount: number; readonly variant: number;
    readonly status: 'indexed' | 'uid-conflict'; readonly indexStatus: 'metadata-only'; readonly availability: 'unverified';
    readonly warnings: readonly string[]; readonly instances: readonly LocalInstanceMetadata[]; readonly revision: number;
}
export interface LocalStudyMetadata {
    readonly id: string; readonly studyUid: string; readonly studyDate: string; readonly studyTime: string; readonly description: string;
    readonly modalities: readonly string[]; readonly institutionName: string; readonly instanceCount: number; readonly frameCount: number;
    readonly warnings: readonly string[]; readonly series: readonly LocalSeriesMetadata[];
}
export interface LocalPatientMetadata extends LocalPatientIdentity {
    readonly id: string;
    readonly identityStatus: 'issuer-qualified' | 'batch-scoped' | 'study-scoped' | 'confirmed-association';
    readonly warnings: readonly string[]; readonly originalIdentities: readonly LocalPatientIdentity[]; readonly studies: readonly LocalStudyMetadata[];
}
export interface LocalCatalogView {
    readonly patients: readonly LocalPatientMetadata[]; readonly counts: LocalCatalogCounts;
}
export interface LocalStudyOptions { seriesId?: string; stackIndex?: number }
export interface LocalComparisonOptions {
    currentSeriesId?: string; comparisonSeriesId?: string; currentStackIndex?: number; comparisonStackIndex?: number;
}
export interface Synchronization { slice?: boolean; window?: boolean; camera?: boolean; toleranceMm?: number }
export interface ViewportState {
    slot: number; assigned: boolean; seriesIndex: number | null; frameIndex: number | null; frameCount: number; busy: boolean;
    image: { rows: number; columns: number; photometric: string } | null;
    window: Window | null;
    transform: { zoom: number; panX: number; panY: number; rotation: number; flipX: boolean; flipY: boolean; invert: boolean };
}
export interface PrefetchOptions { enabled: boolean; neighbors?: 1 | 2 }
export interface PriorContext { patientId: string; currentStudyUid: string; currentStudyDate: string; modality?: string }
export interface PriorOptions { signal?: AbortSignal; limit?: number; maxPages?: number }
export interface PriorCandidate { studyUid: string; studyDate: string; description: string; modalities: string[]; seriesCount: number | null; instanceCount: number | null }
export interface PriorCandidates { items: PriorCandidate[]; pages: number; truncated: boolean; nextOffset: number | null; warnings: string[] }
export type AnnotationTool = 'length' | 'angle' | 'rectangle' | 'ellipse' | 'polygon';
export interface Point { x: number; y: number }
export interface ImageReference { sopUid: string; frameNumber: number; rows: number; columns: number; seriesUid?: string; frameOfReferenceUid?: string; geometryFingerprint?: string }
export interface Annotation { id: string; tool: AnnotationTool; image: ImageReference; points: Point[] }
export interface AnnotationInput { id?: string; tool: AnnotationTool; points: Point[] }
export interface AnnotationDocument { schema: 'easi-view.annotations'; version: 1; coordinateSystem: 'image-edge'; frameNumberBase: 1; annotations: Annotation[] }
export interface AnnotationState { count: number; frameCount: number; bytes: number; revision: number; selected: boolean; canUndo: boolean; canRedo: boolean }
export interface GeometryMeasurement { kind: 'length' | 'angle' | 'area'; value: number; unit: 'mm' | 'px' | 'deg' | 'mm2' | 'px2'; calibrated: boolean; calibrationSource: string; pixelArea?: number; bounds?: { minX: number; minY: number; maxX: number; maxY: number } }
export interface Moments { count: number; mean: number | null; stdDev: number | null; min: number | null; max: number | null }
export interface RoiStatistics { status: 'ok' | 'empty' | 'color-intensity-unavailable'; representation: 'scalar' | 'RGB' | 'palette'; pixelCount: number; sampledPixelCount: number; excludedPadding: number; sampledArea: number; areaUnit: 'mm2' | 'px2'; stored: Moments | null; modality: Moments | null; unit: string | null; varianceDefinition: 'population' }
export interface AnnotationMeasurement { id: string; geometry: GeometryMeasurement; statistics: RoiStatistics | null }
export interface ViewportOption { viewport?: number }
export interface WorkspaceState {
    disposed: boolean; layout: Layout; activeViewport: number; viewports: ViewportState[];
    synchronization: Required<Synchronization>; prefetch: Required<PrefetchOptions>; decodedBytes: number; cacheBudget: number; encodedBytes: number; encodedCacheBudget: number; workerCount: number; thumbnailBytes: number;
    lastSync: { slot: number; matched: boolean; reason?: string; frameIndex?: number }[];
}
export type VoiFunction = 'LINEAR' | 'LINEAR_EXACT' | 'SIGMOID';
export interface ReconstructionWindow extends Window { voiFunction?: VoiFunction }
export interface ReconstructionOptions { viewport?: number; maxBytes?: number; signal?: AbortSignal }
export interface ReconstructionView {
    maximumSize?: number; axialPosition?: number; coronalPosition?: number; sagittalPosition?: number; obliquePosition?: number;
    yawDeg?: number; pitchDeg?: number; projection?: 'slice' | 'mip' | 'minip' | 'mean'; thicknessMm?: number;
    fourth?: 'oblique' | '3d' | 'fusion'; rayMode?: 'composite' | 'mip' | 'minip' | 'mean'; opacity?: number;
    color?: 'grayscale' | 'warm'; invert?: boolean; fusionAlpha?: number; fusionMode?: 'alpha' | 'checkerboard';
    window?: ReconstructionWindow; overlayWindow?: ReconstructionWindow;
}
export interface RigidRegistration { matrix: number[] | Float32Array | Float64Array; fromFrameOfReferenceUid?: string; toFrameOfReferenceUid?: string }
export interface FusionOptions { registration: RigidRegistration; alpha?: number; mode?: 'alpha' | 'checkerboard'; window?: ReconstructionWindow; signal?: AbortSignal }
export interface ReconstructionState {
    open: boolean; ready: boolean; busy: boolean; disposed: boolean; error: boolean; dimensions: number[] | null;
    volumeCount: number; volumeBytes: number; pendingVolumeBytes: number; volumeBudget: number;
    derivedBytes: number; retainedDerivedBytes: number; pendingDerivedBytes: number; canvasBytes: number; derivedBudget: number;
    viewCount: number; fourth: 'oblique' | '3d' | 'fusion' | null; projection: 'slice' | 'mip' | 'minip' | 'mean' | null;
    maximumSize: number | null; progress: { completed: number; total: number; bytes?: number } | null;
}
export interface ReconstructionProbe { kind: 'derived-modality' | 'derived-fusion' | 'parallel-ray-color'; patient?: number[]; value?: number | null; unit?: string; base?: number | null; baseUnit?: string; overlay?: number | null; overlayUnit?: string; projection?: string; mode?: string; rgba?: number[] }
export interface DerivedCode { value: string; scheme: string; meaning: string; version?: string }
export interface OverlayInput { id?: string; kind: 'binary' | 'fractional' | 'probability'; values: number[] | Uint8Array | Float32Array; maximum?: number; fractionalType?: 'PROBABILITY' | 'OCCUPANCY' | null; opacity?: number; color?: [number, number, number] }
export interface Overlay extends OverlayInput { id: string; image: ImageReference; source: 'ai' | 'seg'; maximum: number; values: number[] | Uint8Array | Float32Array; segment?: { number: number; label: string; algorithmType: 'MANUAL' | 'AUTOMATIC' | 'SEMIAUTOMATIC'; algorithmName?: string; category: DerivedCode; type: DerivedCode; recommendedCielab?: number[] }; geometry?: { rows: number; columns: number; frameOfReferenceUid: string; position: number[]; orientation: number[]; pixelSpacing: number[] } }
export interface OverlayStyle { opacity?: number; color?: [number,number,number]; visible?: boolean }
export interface OverlayDocument { schema: 'easi-view.overlays'; version: 1; coordinateSystem: 'image-grid'; frameNumberBase: 1; overlays: Overlay[] }
export interface DerivedGraphic { id?: string; type: 'POLYLINE' | 'ELLIPSE'; points: Point[]; closed: boolean; controlPoints?: Point[]; layer?: string; filled?: boolean }
export interface ReportedMeasurement { id: string; concept: DerivedCode; value: number; unit: DerivedCode; image: ImageReference; graphic: DerivedGraphic }
export interface SrResult { profile: 'by-value-num-scoord-sr-v1'; sopUid: string; documentConcept: DerivedCode; measurements: ReportedMeasurement[] }
export interface PresentationResult { profile: 'single-frame-pixel-gsps-v1'; sopUid: string; image: ImageReference; layers: {name:string;order:number;grayValue:number}[]; graphics: DerivedGraphic[]; window: Required<ReconstructionWindow>; presentationShape: 'IDENTITY' | 'INVERSE'; presentationInvert: boolean; displayedArea: {topLeft:number[];bottomRight:number[];mode:'SCALE TO FIT'} }
export interface DerivedResultDocument { schema: 'easi-view.derived-results'; version: 1; coordinateSystem: 'image-edge'; frameNumberBase: 1; documents: (SrResult | PresentationResult)[] }
export interface DerivedState { disposed: boolean; busy: boolean; revision: number; overlayCount: number; overlayBytes: number; documentCount: number; srCount: number; gspsCount: number; reportedMeasurementCount: number; graphicCount: number; appliedPresentationCount: number }
export type ReadingStringField = 'modality' | 'description' | 'photometric' | 'unit' | 'acquisitionContrast' | 'complexImageComponent';
export type ReadingNumberField = 'rows' | 'columns' | 'frameCount' | 'effectiveEchoTime' | 'temporalPositionIndex' | 'acquisitionNumber';
export type ReadingBooleanField = 'geometryKnown' | 'dimensionsValid';
export type ReadingField = ReadingStringField | ReadingNumberField | ReadingBooleanField;
export interface ReadingRuleOptions { required?: boolean; weight?: number }
export type ReadingRule = ReadingRuleOptions & (
    { field: ReadingStringField; op: 'eq' | 'contains'; value: string } |
    { field: ReadingStringField; op: 'in'; value: readonly string[] } |
    { field: ReadingNumberField; op: 'eq'; value: number } |
    { field: ReadingNumberField; op: 'in'; value: readonly number[] } |
    { field: ReadingNumberField; op: 'range'; value: readonly [number, number] } |
    { field: ReadingBooleanField; op: 'eq'; value: boolean } |
    { field: ReadingBooleanField; op: 'in'; value: readonly boolean[] } |
    { field: ReadingField; op: 'exists'; value: boolean }
);
export type ReadingScope = 'selected' | 'all' | 'current' | 'prior';
export interface ReadingSelector { readonly id: string; readonly scope: ReadingScope; readonly distinctFrom?: readonly string[]; readonly rules: readonly ReadingRule[] }
/** Logical stack indices are zero-based; original encoded-frame identity stays owned by the source. */
export type ReadingFramePolicy = { readonly mode: 'first' | 'middle' | 'active' } | { readonly mode: 'index'; readonly index: number };
export interface ReadingSlot {
    readonly id: number; readonly selector: string; readonly label?: string; readonly frame?: ReadingFramePolicy;
    readonly window?: Readonly<Window> | null; readonly windowUnit?: string | null;
}
export interface ReadingLinks { scroll: boolean; window: boolean; camera: boolean }
/** Viewer-owned JSON profile; this is not a DICOM Hanging Protocol Storage object. */
export interface ReadingProtocol {
    readonly version: 1; readonly id: string; readonly name: string; readonly layout: Layout;
    readonly selectors: readonly ReadingSelector[]; readonly slots: readonly ReadingSlot[]; readonly links?: Partial<ReadingLinks>;
}
export interface NormalizedReadingSelector extends ReadingSelector {
    readonly distinctFrom: readonly string[]; readonly rules: readonly (ReadingRule & { required: boolean; weight: number })[];
}
export interface NormalizedReadingSlot extends ReadingSlot {
    readonly label: string; readonly frame: ReadingFramePolicy; readonly window: Readonly<Window> | null; readonly windowUnit: string | null;
}
export interface NormalizedReadingProtocol extends ReadingProtocol {
    readonly selectors: readonly NormalizedReadingSelector[]; readonly slots: readonly NormalizedReadingSlot[]; readonly links: Readonly<ReadingLinks>;
}
/** One already partitioned loaded stack. No source objects, identifiers or display snapshots are accepted. */
export interface ReadingCandidate {
    index: number; role?: 'unassigned' | 'current' | 'prior'; modality?: string | null; description?: string | null;
    photometric?: string | null; unit?: string | null; rows?: number | null; columns?: number | null; frameCount?: number | null;
    geometryKnown?: boolean | null; dimensionsValid?: boolean | null; effectiveEchoTime?: number | null;
    temporalPositionIndex?: number | null; acquisitionNumber?: number | null; acquisitionContrast?: string | null; complexImageComponent?: string | null;
}
export interface ReadingEvaluationOptions { selectedIndex?: number | null; activeFrames?: Readonly<Record<number, number>>; overrides?: Readonly<Record<string, number>> }
export interface ReadingCandidateResult { readonly index: number; readonly eligible: boolean; readonly score: number; readonly reasonCodes: readonly string[] }
export type ReadingSelectorStatus = 'matched' | 'missing' | 'ambiguous' | 'blocked';
export interface ReadingSelectorResult {
    readonly id: string; readonly status: ReadingSelectorStatus; readonly matchedIndex: number | null;
    readonly candidates: readonly ReadingCandidateResult[]; readonly reasonCodes: readonly string[]; readonly manual: boolean;
}
export interface ReadingPlanSlot {
    readonly id: number; readonly selector: string; readonly status: 'ready' | 'missing' | 'ambiguous' | 'blocked' | 'frame-unavailable';
    readonly candidateIndex: number | null; readonly frameIndex: number | null; readonly window: Readonly<Window> | null;
    readonly windowUnit: string | null; readonly reasonCodes: readonly string[];
}
/** Pure preview/result DTO: indices, display settings and fixed reason codes, with no source identifiers. */
export interface ReadingProtocolPlan {
    readonly version: 1; readonly protocolId: string; readonly layout: Layout; readonly links: Readonly<ReadingLinks>;
    readonly status: 'ready' | 'unresolved'; readonly selectors: readonly ReadingSelectorResult[]; readonly slots: readonly ReadingPlanSlot[];
}
export interface ReadingProtocolPreviewOptions {
    /** Explicit already-loaded catalog indices; roles are never established from patient-name/date heuristics. */
    currentSeries?: readonly number[]; priorSeries?: readonly number[]; overrides?: Readonly<Record<string, number>>;
}
export interface ReadingProtocolApplyOptions extends ReadingProtocolPreviewOptions { signal?: AbortSignal }
export interface ReadingProtocolState {
    disposed: boolean; busy: boolean; preparing: boolean; committing: boolean; preparedFrames: number; preparedBytes: number;
    assignmentCount: number; activeProtocolId: string | null; manualOverride: boolean; layout: Layout;
}
export interface ViewerState {
    disposed: boolean; busy: boolean; tool: Tool; sourceType: string; seriesCount: number;
    frameIndex: number; frameCount: number; modality: string | null; playing: boolean;
    archive: { connected: boolean; searching: boolean };
    localLibrary: LocalLibraryState;
    image: { rows: number; columns: number; photometric: string; samplesPerPixel: number; calibrated: boolean; geometryWarnings: string[]; timingWarnings: string[]; encodingWarnings: string[] } | null;
    window: Window | null; workspace: WorkspaceState; annotations: AnnotationState; reconstruction: ReconstructionState | null; derived: DerivedState; specialty: SpecialtyState; readingProtocol: ReadingProtocolState;
}
export interface PerformanceMeasurement {
    phase: string; status: 'success' | 'error' | 'canceled'; durationMs: number; source?: string;
    bytes?: number; decodedBytes?: number; encodedCacheBytes?: number; decodedCacheBytes?: number;
    decodedCacheHit?: boolean; encodedCacheHit?: boolean;
}
export interface PerformanceSnapshot {
    limit: number; measurements: PerformanceMeasurement[];
    summary: Record<string, { count: number; successCount: number; errorCount: number; canceledCount: number; lastMs: number; medianMs: number | null; p95Ms: number | null }>;
    resources: { disposed: boolean; seriesCount: number; frameCount: number; encodedBytes: number; decodedCacheBytes: number; workerCount: number; viewportCount: number; encodedCacheBytes: number; thumbnailBytes: number; specialtyBytes: number; overlayBytes: number; overlayRenderBytes: number; reconstructionVolumeBytes: number; reconstructionDerivedBytes: number; cleanupPending: boolean };
}
export interface ViewerEvents {
    sourcechange: ViewerState;
    framechange: ViewerState & { viewport: number };
    layoutchange: ViewerState;
    viewportchange: ViewerState;
    syncchange: ViewerState;
    annotationchange: ViewerState;
    annotationselectionchange: ViewerState;
    reconstructionchange: ViewerState;
    derivedchange: ViewerState;
    specialtychange: ViewerState;
    readingprotocolchange: ReadingProtocolState;
    librarychange: LocalLibraryState | SessionState;
    error: { title: string; message: string };
    dispose: ViewerState;
}
export interface Viewer {
    readonly ready: Promise<ViewerState | undefined>;
    open(path?: 'images' | 'study' | 'test'): OpenWorkflowState;
    getOpenWorkflowState(): OpenWorkflowState;
    getSessionCatalog(): SessionCatalogView;
    getSessionState(): SessionState;
    selectSessionPatient(id: string): Promise<SessionState>;
    openSessionStudy(studyId: string, options?: {seriesId?: string; stackIndex?: number}): Promise<SessionState>;
    openSessionSeries(seriesId: string, options?: SessionImageOptions): Promise<SessionState>;
    openSessionInstance(instanceId: string, options?: SessionImageOptions & {seriesId?: string}): Promise<SessionState>;
    listSessionInstances(seriesId: string, options?: {signal?: AbortSignal}): Promise<SessionInstance[]>;
    clearViewport(slot: number): Promise<WorkspaceState>;
    closeSession(): Promise<SessionState>;
    compareSessionStudies(currentId: string, comparisonId: string, options?: LocalComparisonOptions): Promise<SessionState>;
    removeSessionPatient(id: string): Promise<SessionState>;
    getSources(): readonly RemoteSource[];
    /** Host-controlled registration. IDs are stable and cannot replace an existing connection. */
    registerSource(configuration: RemoteSourceConfiguration): RemoteSource;
    openFiles(files: Iterable<File> | FileList): Promise<ViewerState>;
    /** Add metadata to the session catalog without materializing the collection's pixel data. */
    importLocalFiles(files: Iterable<File> | FileList, options?: {signal?: AbortSignal}): Promise<LocalImportResult>;
    /** Explicit metadata access, including patient identifiers; never included in automatic viewer events. */
    getLocalCatalog(): LocalCatalogView;
    getLocalLibraryState(): LocalLibraryState;
    selectLocalPatient(id: string): Promise<ViewerState>;
    openLocalStudy(studyId: string, options?: LocalStudyOptions): Promise<ViewerState>;
    openLocalSeries(seriesId: string, options?: {stackIndex?: number}): Promise<ViewerState>;
    compareLocalStudies(currentStudyId: string, comparisonStudyId: string, options?: LocalComparisonOptions): Promise<ViewerState>;
    /** Cancels pending local indexing or selection preparation. */
    cancelLocalImport(): void;
    clearLocalLibrary(): Promise<LocalLibraryState>;
    /** Associates catalog records for this session while preserving original DICOM metadata. */
    associateLocalPatient(fromId: string, toId: string, options: {confirmed: true}): Promise<LocalLibraryState>;
    openUrl(url: string): Promise<ViewerState>;
    openDemo(demo: Demo): Promise<ViewerState>;
    exportStudyContext(options: {archiveKey: string}): StudyContext;
    applyStudyContext(context: StudyContext, options: ApplyStudyContextOptions): Promise<StudyContext>;
    configureArchive(configuration: ArchiveConfiguration): { connected: true };
    disconnectArchive(): Promise<void>;
    searchStudies(filters?: StudyFilters, page?: PageOptions): Promise<Page<Study>>;
    listStudySeries(studyUid: string, page?: PageOptions): Promise<Page<Series>>;
    openArchiveSeries(studyUid: string, seriesUid: string): Promise<ViewerState>;
    addArchiveSeries(studyUid: string, seriesUid: string, options?: ViewportOption): Promise<WorkspaceState>;
    findPriorStudies(context: PriorContext, options?: PriorOptions): Promise<PriorCandidates>;
    setPrefetch(options: PrefetchOptions): Required<PrefetchOptions>;
    getAnnotationState(): AnnotationState;
    getAnnotations(options?: ViewportOption): Annotation[];
    addAnnotation(input: AnnotationInput, options?: ViewportOption): Annotation;
    removeAnnotation(id: string): Annotation;
    measureAnnotation(id: string, options?: ViewportOption): AnnotationMeasurement;
    exportAnnotations(): AnnotationDocument;
    importAnnotations(document: AnnotationDocument | string, options?: { mode?: 'merge' | 'replace' }): number;
    undoAnnotations(): boolean;
    redoAnnotations(): boolean;
    clearAnnotations(): boolean;
    openReconstruction(options?: ReconstructionOptions): Promise<ReconstructionState>;
    closeReconstruction(): Promise<ReconstructionState>;
    getReconstructionState(): ReconstructionState;
    setReconstruction(options: ReconstructionView): Promise<ReconstructionState>;
    setReconstructionFusion(seriesIndex: number, options: FusionOptions): Promise<ReconstructionState>;
    /** Explicit quantitative read; ray composites return color rather than a single-voxel measurement. */
    probeReconstruction(view: number, column: number, row: number): ReconstructionProbe | null;
    /** dispose() stays synchronous; this promise waits for pending allocation cancellation to finish. */
    whenDisposed(): Promise<void>;
    importDerived(input: Blob | ArrayBuffer | Uint8Array | OverlayDocument | DerivedResultDocument | string, options?: {signal?: AbortSignal}): Promise<DerivedState>;
    addOverlay(input: OverlayInput, options?: ViewportOption): {id: string};
    updateOverlay(id: string, style: OverlayStyle): {id: string; opacity: number; color: number[]};
    removeOverlay(id: string): boolean;
    exportOverlays(): OverlayDocument;
    exportDerivedResults(): DerivedResultDocument;
    importDerivedResults(document: DerivedResultDocument | string, options?: {mode?: 'merge' | 'replace'; signal?: AbortSignal}): Promise<DerivedState>;
    applyPresentation(index: number): Promise<DerivedState>;
    getDerivedState(): DerivedState;
    clearDerived(): void;
    openSpecialtyFiles(files: Blob[], options?: {signal?: AbortSignal}): Promise<SpecialtyState>;
    closeSpecialty(): Promise<SpecialtyState>;
    getSpecialtyState(): SpecialtyState;
    setSpecialty(options: SpecialtyOptions): Promise<SpecialtyState>;
    setSpecialtyFrame(index: number): Promise<SpecialtyState>;
    playSpecialty(): SpecialtyState;
    pauseSpecialty(): void;
    probeSpecialty(column: number, row: number): SpecialtyProbe | null;
    exportSpecialtyReport(): string;
    getReadingProtocols(): readonly NormalizedReadingProtocol[];
    /** Replaces the complete in-memory definition collection after strict validation. */
    setReadingProtocols(protocols: readonly ReadingProtocol[]): readonly NormalizedReadingProtocol[];
    previewReadingProtocol(id: string, options?: ReadingProtocolPreviewOptions): ReadingProtocolPlan;
    applyReadingProtocol(id: string, options?: ReadingProtocolApplyOptions): Promise<ReadingProtocolPlan>;
    cancelReadingProtocol(): Promise<void>;
    /** One pane with the current active original frame, default presentation and links off. */
    resetReadingProtocol(): Promise<ReadingProtocolPlan>;
    getReadingProtocolState(): ReadingProtocolState;
    setFrame(index: number): Promise<ViewerState>;
    setSeries(index: number): Promise<ViewerState>;
    setTool(tool: Tool): void;
    setWindow(window: Window): void;
    setLayout(layout: Layout): Promise<WorkspaceState>;
    setActiveViewport(slot: number): WorkspaceState;
    assignViewportSeries(slot: number, seriesIndex: number): Promise<WorkspaceState>;
    setSynchronization(options: Synchronization): Promise<WorkspaceState>;
    getWorkspaceState(): WorkspaceState;
    play(): void; pause(): void; reset(): void;
    getState(): ViewerState;
    getPerformance(): PerformanceSnapshot;
    resetPerformance(): void;
    setBranding(branding: Branding): void;
    setTheme(theme: Theme): void;
    on<K extends keyof ViewerEvents>(event: K, handler: (detail: ViewerEvents[K]) => unknown): () => void;
    dispose(): void;
}
/** Mounts an independently owned browser viewer into a height-constrained host element. */
export function createViewer(container: HTMLElement, options?: ViewerOptions): Readonly<Viewer>;
export function getDefaultReadingProtocols(): readonly NormalizedReadingProtocol[];
export function normalizeReadingProtocol(input: ReadingProtocol | string): NormalizedReadingProtocol;
export function normalizeReadingProtocols(input: readonly ReadingProtocol[] | string): readonly NormalizedReadingProtocol[];
export function evaluateReadingProtocol(protocol: ReadingProtocol | string, candidates: readonly ReadingCandidate[], options?: ReadingEvaluationOptions): ReadingProtocolPlan;

// Add these declarations to the EASI View browser SDK declaration artifact.
export interface EnterpriseIdentity { subject: string; realm: string; expiresAt: number }
export interface EnterpriseSignal { signal?: AbortSignal }
export interface EnterpriseCurrent { identity: EnterpriseIdentity; signal: AbortSignal }
export interface EnterpriseIdentityAdapter {
    login(options: {signal: AbortSignal}): EnterpriseIdentity | null | undefined | Promise<EnterpriseIdentity | null | undefined>;
    logout(options: {signal: AbortSignal}): unknown | Promise<unknown>;
    current(options: {signal: AbortSignal}): EnterpriseIdentity | null | Promise<EnterpriseIdentity | null>;
    /** Refresh credentials for this one allowlisted request; URL credentials and cookie headers are rejected. */
    getHeaders(options: EnterpriseCurrent & {url: string}): Record<string, string> | Promise<Record<string, string>>;
}
export interface ArchiveReference { archiveKey: string; studyUid: string; seriesUid?: string; sopUid?: string }
export interface StudyContextViewport {
    slot: number; reference: ArchiveReference; frameIndex: number;
    /** One-based ORIGINAL encoded frame, 1..4096; requires reference.sopUid. */
    originalFrameNumber?: number; window?: Window;
}
export interface StudyContext { version: 1; layout: Layout; activeViewport: number; viewports: StudyContextViewport[] }
export interface StudyContextOptions { archiveKey: string }
export interface ApplyStudyContextOptions extends StudyContextOptions, EnterpriseSignal { scope?: ArchiveReference }
export interface WorklistItem {
    key: string; title: string; reference: ArchiveReference; modality?: string;
    priority?: 'normal' | 'urgent'; status?: 'scheduled' | 'ready' | 'reading' | 'complete';
}
export interface WorklistPage { items: WorklistItem[]; nextOffset: number | null }
export interface WorklistOptions extends EnterpriseSignal { offset?: number; limit?: number }
export interface EnterpriseWorkflowAdapter {
    list(options: EnterpriseCurrent & {offset: number; limit: number}): WorklistPage | Promise<WorklistPage>;
    openStudy(options: EnterpriseCurrent & {reference: ArchiveReference}): StudyContext | Promise<StudyContext>;
}
export interface EnterprisePersistenceAdapter {
    load(options: EnterpriseCurrent & {key: string}): StudyContext | null | Promise<StudyContext | null>;
    save(options: EnterpriseCurrent & {key: string; context: StudyContext}): unknown | Promise<unknown>;
}
export interface ShareReceipt { shareId: string; capability: string }
export interface VerifiedShare {
    shareId: string; subject: string; realm: string; origin: string; expiresAt: number; revoked: boolean;
    permissions: ['view']; reference: ArchiveReference;
}
export interface EnterpriseShareAdapter {
    create(options: EnterpriseCurrent & {reference: ArchiveReference; ttlMs: number; viewerOrigin: string}): ShareReceipt | Promise<ShareReceipt>;
    verify(options: EnterpriseCurrent & {receipt: ShareReceipt; operation: 'create' | 'resolve' | 'revoke'}): VerifiedShare | Promise<VerifiedShare>;
    revoke(options: EnterpriseCurrent & {shareId: string}): ShareReceipt | Promise<ShareReceipt>;
}
export interface EnterpriseAudit {
    operation: 'login' | 'logout' | 'dicom-auth' | 'worklist' | 'open-study' | 'save-context' | 'load-context' | 'create-share' | 'resolve-share' | 'revoke-share';
    status: 'success' | 'error' | 'canceled'; durationMs: number;
}
export interface EnterpriseViewerState {
    disposed: boolean; authenticated: boolean; connected: boolean; pendingOperations: number;
    clearingRemote: boolean; cleanupPending: boolean; blocked: boolean; worklistCount: number;
    sharingEnabled: boolean; activeShareCount: number;
}
export interface EnterpriseViewerOptions {
    identityAdapter: EnterpriseIdentityAdapter;
    archive: {key: string; baseUrl: string; retrievalMode?: 'instance' | 'frame'};
    workflowAdapter: EnterpriseWorkflowAdapter; persistence?: EnterprisePersistenceAdapter; shareAdapter?: EnterpriseShareAdapter;
    /** Required when sharing is configured; exact HTTPS viewer origin. */
    viewerOrigin?: string; audit?: (event: EnterpriseAudit) => unknown;
    /** Explicit development-only permission for HTTP loopback endpoints. */
    allowInsecureLoopback?: boolean; onChange?: (state: EnterpriseViewerState) => unknown;
}
export interface EnterpriseViewer {
    login(options?: EnterpriseSignal): Promise<EnterpriseViewerState>;
    logout(options?: EnterpriseSignal): Promise<EnterpriseViewerState>;
    listWorklist(options?: WorklistOptions): Promise<WorklistPage>;
    openStudy(reference: ArchiveReference, options?: EnterpriseSignal): Promise<EnterpriseViewerState>;
    saveContext(key: string, options?: EnterpriseSignal): Promise<{saved: true}>;
    restoreContext(key: string, options?: EnterpriseSignal): Promise<EnterpriseViewerState | null>;
    createShare(reference: ArchiveReference, options?: EnterpriseSignal & {ttlMs?: number}): Promise<ShareReceipt & {expiresAt: number}>;
    resolveShare(receipt: ShareReceipt, options?: EnterpriseSignal): Promise<{shareId: string; expiresAt: number; reference: ArchiveReference; opened: true}>;
    revokeShare(shareId: string, options?: EnterpriseSignal): Promise<{shareId: string; revoked: true}>;
    getState(): EnterpriseViewerState;
    subscribe(observer: (state: EnterpriseViewerState) => unknown): () => void;
    /** Clears owned remote data and services; does not dispose the host's viewer. */
    dispose(): Promise<EnterpriseViewerState>;
}
/** Identity and workflow callbacks are trusted host integrations; the backend must authorize every archive read. */
export function createEnterpriseViewer(viewer: Readonly<Viewer>, configuration: EnterpriseViewerOptions): Readonly<EnterpriseViewer>;


// Draft SDK additions derived from the frozen SpecialtyWorkspace implementation.
// Target: src/integration/easi-view.d.ts. This file is a review artifact only.
// Reuse the existing exported Window interface.

export type SpecialtyProfile = 'xa' | 'dose' | 'cine' | 'breast' | 'slide';
export type SpecialtyTiming = 'manual' | 'recommended-display-rate' | 'frame-time-vector' | 'frame-time';
export interface SpecialtyOpenOptions { signal?: AbortSignal }
export interface SpecialtyRegion { column: number; row: number; width: number; height: number }
export interface SpecialtySlidePoint { xMm: number; yMm: number; zUm: number }
export interface SpecialtyOptions {
    /** XA/dose only. Finite center |value|<=1e12; width1e-12..1e12. LINEAR_EXACT display only. */
    window?: Window | null;
    /** Choose one nonnull override. FPS0<value<=1000; frame time0<value<=60000ms. */
    manualRateFps?: number | null;
    manualFrameTimeMs?: number | null;
    /** Slide index only. Half-open pixel-edge region, clipped to the full matrix; max1024 results. */
    slideRegion?: SpecialtyRegion | null;
    /** Slide index only. Pixel-center mapping in the explicitly indexed plane. */
    slidePoint?: SpecialtySlidePoint | null;
}
export interface SpecialtyState {
    open: boolean; ready: boolean; busy: boolean; playing: boolean; disposed: boolean; error: boolean;
    profile: SpecialtyProfile | null; sourceCount: number;
    /** Original zero-based frame/tile index, independent of cine sequence position. */
    frameIndex: number | null;
    frameCount: number;
    /** [columns, rows], present only for quantitative XA/dose previews. */
    dimensions: [number, number] | null;
    modelBytes: number; outputBytes: number; canvasBytes: number; pendingBytes: number;
    bytes: number; budget: number;
    hasCine: boolean; timing: SpecialtyTiming | null; tileQueryCount: number;
    readyLayoutSlots: number; ambiguousLayoutSlots: number;
}
export interface SpecialtyDoseProbe {
    kind: 'dose'; column: number; row: number; frameIndex: number;
    stored: number; value: number; units: 'GY' | 'RELATIVE';
    patientLpsMm: [number, number, number];
}
export interface SpecialtySubtractionProbe {
    kind: 'xa-subtraction'; column: number; row: number; frameIndex: number;
    stored: number; value: number; units: 'stored-intensity difference';
    relationship: 'LIN' | 'DISP'; relationshipSign: -1 | 1 | null;
}
export type SpecialtyProbe = SpecialtyDoseProbe | SpecialtySubtractionProbe;

// These explicit export-only structures contain image references. They are not
// part of automatic getState()/specialtychange observer payloads.
export interface SpecialtySourceReference { sopUid: string; studyUid: string; seriesUid: string }
export interface SpecialtyBreastReference { sopUid: string; seriesUid: string; originalFrameIndex: 0 }
export interface SpecialtyBreastLayout {
    profile: 'breast-four-view-layout-v1'; studyUid: string; rows: 2; columns: 2;
    slots: Array<{
        key: 'R-CC' | 'L-CC' | 'R-MLO' | 'L-MLO'; row: number; column: number;
        status: 'missing' | 'ready' | 'ambiguous';
        image: SpecialtyBreastReference | null; candidates: SpecialtyBreastReference[];
    }>;
    unassigned: Array<{sopUid: string; reason: string}>;
    orientationPolicy: 'source-unchanged'; protocol: 'explicit-cc-mlo-four-view';
}
export interface SpecialtySlideMetadata {
    profile: 'single-plane-tiled-full-index-v1'; sopUid: string; seriesUid: string; frameOfReferenceUid: string;
    totalRows: number; totalColumns: number; tileRows: number; tileColumns: number;
    tileGridRows: number; tileGridColumns: number; frameCount: number;
    opticalPathId: string; focalPlaneIndex: 0; origin: SpecialtySlidePoint;
    orientation: [number,number,number,number,number,number];
    basisX: [number,number,number]; basisY: [number,number,number];
    /** [row spacing, column spacing], millimetres. No tile pixels are loaded. */
    pixelSpacing: [number,number];
    photometric: 'MONOCHROME2' | 'RGB' | 'YBR_FULL_422' | 'YBR_ICT' | 'YBR_RCT';
    samplesPerPixel: 1 | 3; bitsAllocated: 8 | 16;
    coordinateConvention: 'pixel-center-index-0'; units: {x:'mm';y:'mm';z:'um'};
}
export interface SpecialtySlideTile {
    /** frameIndex is zero-based; frameNumber is one-based. */
    frameIndex: number; frameNumber: number; column: number; row: number;
    /** DICOM column/row positions are one-based. */
    dicomColumnPosition: number; dicomRowPosition: number;
    columns: number; rows: number; encodedColumns: number; encodedRows: number;
    opticalPathId: string; focalPlaneIndex: 0; slidePosition: SpecialtySlidePoint;
}
export interface SpecialtyCineReport {
    timing: SpecialtyTiming; startFrameIndex: number; stopFrameIndex: number;
    sequencing: 'loop' | 'sweep'; sequence: number[]; durationsMs: number[];
    closurePolicy: 'repeat-last-interval'; physiologicalPhase: null;
}
export interface SpecialtyReport {
    schema: 'easi-view.specialty-report'; version: 1; profile: SpecialtyProfile; researchOnly: true;
    readProvenance: 'explicit-local-file-EASI-JS-1.0.0';
    sourceReferences: SpecialtySourceReference[]; originalFrameIndex: number;
    units: 'GY' | 'RELATIVE' | 'stored-intensity difference' | null;
    display: {window: Window; voiFunction: 'LINEAR_EXACT'; provenance: 'explicit-research-preset-or-manual'} | null;
    processing: {
        scaling: number; doseType: 'PHYSICAL'; units: 'GY' | 'RELATIVE'; originalPlaneOffsetMm: number;
    } | {
        operation: 'contrast-average-minus-mask-average'; maskOriginalFrameIndices: number[];
        contrastFrameAveraging: number; shift: [0,0]; relationship: 'LIN' | 'DISP'; relationshipSign: -1 | 1 | null;
    } | null;
    cine: SpecialtyCineReport | null; breastLayout: SpecialtyBreastLayout | null;
    slideIndex: {
        metadata: SpecialtySlideMetadata; selectedRegion: SpecialtyRegion; tiles: SpecialtySlideTile[];
        pointPixel: {column:number;row:number} | null; preview: 'index-only';
    } | null;
}

