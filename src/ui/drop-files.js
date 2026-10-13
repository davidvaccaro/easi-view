const NON_IMAGE_FILES = new Set(['.ds_store', 'thumbs.db', 'desktop.ini', 'dicomdir']);

export function isImageCandidate(file) {
  return !NON_IMAGE_FILES.has(String(file?.name || '').toLowerCase());
}

function canceled() {
  return new DOMException('The file selection was superseded.', 'AbortError');
}

/** Read user-dropped entries only. Directory readers must be exhausted in batches. */
export async function collectDroppedFiles(dataTransfer, { isCurrent = () => true, maximumBytes = Infinity } = {}) {
  // Capture handles synchronously: the drag data store stops being readable after drop.
  const items = Array.from(dataTransfer?.items || []).filter((item) => item.kind !== 'string');
  const entries = items.map((item) => item.getAsEntry?.() || item.webkitGetAsEntry?.() || null);
  const fallback = Array.from(dataTransfer?.files || []);
  const files = [];
  let total = 0;
  const assertCurrent = () => { if (!isCurrent()) throw canceled(); };
  const append = (file) => {
    assertCurrent();
    if (!isImageCandidate(file)) return;
    total += file.size;
    if (total > maximumBytes) throw new Error('The selected files exceed the 256 MiB source limit. Open a smaller DICOM folder.');
    files.push(file);
  };
  const walk = async (entry) => {
    assertCurrent();
    if (entry.isFile) {
      const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
      append(file);
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      while (true) {
        assertCurrent();
        const batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
        if (!batch.length) break;
        for (const child of batch) await walk(child);
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
