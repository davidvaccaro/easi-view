import { LocalCatalog } from './LocalCatalog.js';
import { resolveLocalMedia } from './DicomDirectory.js';
import { isDicomDirectory } from './local-paths.js';
import { isImageCandidate } from '../ui/drop-files.js';

const canceled = () => new DOMException('The image selection was canceled.', 'AbortError');

/** Private, disposable file references for the Open dialog. Previewing never
 * admits records to the viewer's catalog or changes its reading workspace. */
export class LocalOpenSelection {
    #generation = 0;
    #controller = null;
    #selection = null;
    #disposed = false;

    clear() {
        ++this.#generation;
        this.#controller?.abort();
        this.#controller = null;
        this.#selection = null;
    }

    async preview(input, { intent = 'images', includeSubfolders = true, signal, onProgress } = {}) {
        if (this.#disposed) throw new Error('The opening workflow has been disposed.');
        if (!['images', 'study'].includes(intent)) throw new TypeError('Choose images or a local media study.');
        this.clear();
        const generation = this.#generation, controller = new AbortController();
        this.#controller = controller;
        const lifetime = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
        const catalog = new LocalCatalog();
        const selected = [];
        for (const file of input ?? []) {
            if (selected.length >= 30000) throw new RangeError('Choose at most 30,000 files in one selection.');
            const path = file?.webkitRelativePath || file?.relativePath || '';
            if (intent === 'images' && !includeSubfolders && path.split('/').filter(Boolean).length > 2) continue;
            if (isImageCandidate(file) || isDicomDirectory(file)) selected.push(file);
        }
        try {
            if (lifetime.aborted) throw canceled();
            const hasDirectory = selected.some(isDicomDirectory);
            if (intent === 'study' && !hasDirectory) {
                throw new Error('No DICOMDIR was found in this folder. Choose the media root, or use Open Images to scan its image files.');
            }
            const media = intent === 'study'
                ? await resolveLocalMedia(selected, { signal: lifetime, onProgress })
                : { files: selected.filter(file => !isDicomDirectory(file)), references: undefined, report: null };
            if (!media.files.length) throw new Error('No referenced DICOM images are available in this selection.');
            const result = await catalog.addFiles(media.files, { signal: lifetime, onProgress, references: media.references });
            if (lifetime.aborted || generation !== this.#generation || this.#disposed) throw canceled();
            const view = catalog.getView(), groups = new Map();
            for (const patient of view.patients) for (const study of patient.studies) {
                groups.set(study.id, { patientId: patient.id, files: study.series.flatMap(series => catalog.getSeriesFiles(series.id)) });
            }
            if (!groups.size) throw new Error('The selected files did not contain indexable DICOM images.');
            const token = `open-local-${generation}`;
            const warnings = [...(media.report?.warnings ?? [])];
            if (intent === 'images' && hasDirectory) warnings.push('This selection includes a DICOMDIR. Open Images uses only the selected folder contents. Use Open Study to follow its media index.');
            if (result.failed) warnings.push(`${result.failed.toLocaleString()} selected files could not be indexed.`);
            this.#selection = { token, groups, references: media.references, media: media.report?.mode === 'dicomdir' ? media.report : null };
            return { token, patients: view.patients, counts: view.counts, warnings, intent };
        } finally {
            catalog.dispose();
            if (this.#controller === controller) this.#controller = null;
        }
    }

    resolve(preview, { selection, patientId, studyIds } = {}) {
        const pending = this.#selection;
        if (!pending || preview?.token !== pending.token) throw new Error('This selection expired. Choose the files again.');
        const choices = selection ?? [{ patientId, studyIds }];
        if (!Array.isArray(choices) || !choices.length) throw new Error('Choose at least one study to add.');
        const files = new Set(), studies = new Set();
        for (const choice of choices) {
            if (!choice || !Array.isArray(choice.studyIds)) throw new TypeError('Choose studies from the current selection.');
            for (const id of choice.studyIds) {
                const group = pending.groups.get(id);
                if (!group || group.patientId !== choice.patientId) throw new Error('A selected study does not belong to this patient.');
                if (studies.has(id)) throw new Error('Select each study only once.');
                studies.add(id);
                group.files.forEach(file => files.add(file));
            }
        }
        if (!files.size) throw new Error('Choose at least one study to add.');
        return { files: [...files], references: pending.references, media: pending.media };
    }

    dispose() { this.clear(); this.#disposed = true; }
}
