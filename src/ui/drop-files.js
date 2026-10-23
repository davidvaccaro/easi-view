import { isDicomDirectory, setLocalRelativePath } from '../catalog/local-paths.js';

const NON_IMAGE_FILES = new Set(['.ds_store', 'thumbs.db', 'desktop.ini', 'dicomdir']);

export function isImageCandidate(file) {
  return !NON_IMAGE_FILES.has(String(file?.name || '').toLowerCase());
}

function canceled() {
  return new DOMException('The file selection was superseded.', 'AbortError');
}

/** Read user-dropped entries only. Directory readers must be exhausted in batches. */
export async function collectDroppedFiles(dataTransfer, { isCurrent = () => true, maximumBytes = Infinity, maximumFiles = 30000, includeDicomdir = false } = {}) {
  if (!Number.isSafeInteger(maximumFiles) || maximumFiles < 1 || maximumFiles > 30000) throw new TypeError('Use a file selection limit from 1 to 30,000.');
  // Capture handles synchronously: the drag data store stops being readable after drop.
  const items = Array.from(dataTransfer?.items || []).filter((item) => item.kind !== 'string');
  const entries = items.map((item) => item.getAsEntry?.() || item.webkitGetAsEntry?.() || null);
  const fallback = Array.from(dataTransfer?.files || []);
  const files = [];
  let total = 0;
  const assertCurrent = () => { if (!isCurrent()) throw canceled(); };
  const append = (file) => {
    assertCurrent();
    if (!isImageCandidate(file) && !(includeDicomdir && isDicomDirectory(file))) return;
    if (files.length >= maximumFiles) throw new Error(`The local catalog accepts at most ${maximumFiles.toLocaleString()} files per selection.`);
    total += file.size;
    if (total > maximumBytes) throw new Error('The selected files exceed the 256 MiB source limit. Open a smaller DICOM folder.');
    files.push(file);
  };
  const walk = async (entry, parent = '') => {
    assertCurrent();
    const path = parent ? `${parent}/${entry.name || ''}` : entry.name || '';
    if (entry.isFile) {
      const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
      if (entry.name) setLocalRelativePath(file, path);
      append(file);
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      while (true) {
        assertCurrent();
        const batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
        if (!batch.length) break;
        for (const child of batch) await walk(child, path);
      }
    }
  };
  if (entries.length && entries.every(Boolean)) {
    for (const entry of entries) await walk(entry);
  } else {
    fallback.forEach(append);
  }
  assertCurrent();
  return files;
}
