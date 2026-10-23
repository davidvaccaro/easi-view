// Directory drops do not populate File.webkitRelativePath. Retain only paths
// explicitly granted by that drop; never probe the host filesystem.
const paths = new WeakMap();

export function getLocalRelativePath(file) {
    return paths.get(file) || file?.webkitRelativePath || file?.name || '';
}

export function setLocalRelativePath(file, path) {
    if (file && typeof file === 'object' && typeof path === 'string') paths.set(file, path);
}

export function isDicomDirectory(file) {
    return String(file?.name || '').toUpperCase() === 'DICOMDIR';
}
