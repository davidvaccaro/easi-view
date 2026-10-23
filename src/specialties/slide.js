import { one, rejectTags } from '../derived/common.js';
import { orientation } from '../volume/geometry.js';
import { dataSet, attribute, text, scalar, numbers, values, integer, uid, fail, frozenArray, MAX_SPECIALTY_FRAMES } from './common.js';

export const WSI_SOP_CLASS = '1.2.840.10008.5.1.4.1.1.77.1.6';
const TOKEN = Symbol('slide-index');

/** Arithmetic index only: never accesses Pixel Data, codecs or remote bulk data. */
export function createSlideIndex(instance) {
    const set = dataSet(instance);
    if (text(set, '00080016') !== WSI_SOP_CLASS || text(set, '00209311') !== 'TILED_FULL') fail('one TILED_FULL whole-slide instance is required');
    const imageType = values(set, '00080008', { maximum: 4 });
    if (imageType.length !== 4 || !['ORIGINAL', 'DERIVED'].includes(imageType[0]) || imageType[1] !== 'PRIMARY' || imageType[2] !== 'VOLUME' ||
        !['NONE', 'RESAMPLED'].includes(imageType[3])) fail('a VOLUME whole-slide layer is required; labels and overviews use different extents');
    rejectTags(set, ['00209161', '00209228', '00209162', '00209163', '52009230']);
    const tileRows = integer(scalar(set, '00280010'), 1, 8192), tileColumns = integer(scalar(set, '00280011'), 1, 8192);
    const totalRows = integer(scalar(set, '00480007'), 1, 0x7FFFFFFF), totalColumns = integer(scalar(set, '00480006'), 1, 0x7FFFFFFF);
    const tileGridRows = Math.ceil(totalRows / tileRows), tileGridColumns = Math.ceil(totalColumns / tileColumns), frameCount = integer(scalar(set, '00280008'), 1, MAX_SPECIALTY_FRAMES);
    if (frameCount !== tileGridRows * tileGridColumns || scalar(set, '00480303') !== 1 || scalar(set, '00480302') !== 1) fail('single focal plane and optical path require exact full-grid frame count');
    const optical = one(set, '00480105'), opticalPathId = text(optical, '00480106', { maximum: 16 });
    const originSet = one(set, '00480008'), origin = { xMm: scalar(originSet, '0040072A'), yMm: scalar(originSet, '0040073A'), zUm: scalar(originSet, '0040074A') };
    if (Object.values(origin).some(value => !Number.isFinite(value) || Math.abs(value) > 1e9) || origin.zUm < 0) fail('bounded explicit slide origin is required');
    const imageOrientation = numbers(set, '00480102'), basis = orientation(imageOrientation);
    if (basis.x[2] !== 0 || basis.y[2] !== 0 || Math.abs(basis.normal[2] - 1) > 0.00001) fail('only an in-plane right-handed slide orientation is supported');
    const shared = one(set, '52009229'), measures = one(shared, '00289110'), spacing = numbers(measures, '00280030');
    if (spacing.length !== 2 || spacing.some(value => value <= 0 || value > 10000)) fail('explicit positive slide Pixel Spacing is required');
    const width = scalar(set, '00480001'), height = scalar(set, '00480002'), depth = scalar(set, '00480003');
    if (depth <= 0 || width <= 0 || height <= 0 || Math.abs(width - totalColumns * spacing[1]) > Math.max(1e-7, width * 1e-5) ||
        Math.abs(height - totalRows * spacing[0]) > Math.max(1e-7, height * 1e-5)) fail('imaged volume extent differs from the full pixel matrix spacing');
    // This only classifies metadata; no color transform or pixel decoding occurs.
    const photometric = text(set, '00280004'), samplesPerPixel = scalar(set, '00280002'), bits = scalar(set, '00280100');
    if (!['MONOCHROME2', 'RGB', 'YBR_FULL_422', 'YBR_ICT', 'YBR_RCT'].includes(photometric) || samplesPerPixel !== (photometric === 'MONOCHROME2' ? 1 : 3) ||
        ![8, 16].includes(bits) || scalar(set, '00280101') !== bits || scalar(set, '00280102') !== bits - 1 || scalar(set, '00280103') !== 0 ||
        samplesPerPixel === 3 && scalar(set, '00280006') !== 0) fail('whole-slide pixel metadata is inconsistent');
    if (attribute(shared, '0048021A') || attribute(shared, '00480207')) fail('explicit plane or optical-path functional groups are outside this implicit-index profile');
    return new SlideIndex(TOKEN, Object.freeze({ profile: 'single-plane-tiled-full-index-v1', sopUid: uid(text(set, '00080018')), seriesUid: uid(text(set, '0020000E')),
        frameOfReferenceUid: uid(text(set, '00200052')), totalRows, totalColumns, tileRows, tileColumns, tileGridRows, tileGridColumns, frameCount,
        opticalPathId, focalPlaneIndex: 0, origin: Object.freeze(origin), orientation: frozenArray(imageOrientation), basisX: frozenArray(basis.x), basisY: frozenArray(basis.y),
        pixelSpacing: frozenArray(spacing), photometric, samplesPerPixel, bitsAllocated: bits, coordinateConvention: 'pixel-center-index-0',
        units: Object.freeze({ x: 'mm', y: 'mm', z: 'um' }) }));
}

class SlideIndex {
    constructor(token, metadata) { if (token !== TOKEN) fail('use createSlideIndex'); this.metadata = metadata; }
    tileDescriptor(frameIndex) {
        const m = this.metadata; integer(frameIndex, 0, m.frameCount - 1);
        const gridColumn = frameIndex % m.tileGridColumns, gridRow = Math.floor(frameIndex / m.tileGridColumns), column = gridColumn * m.tileColumns, row = gridRow * m.tileRows;
        return { frameIndex, frameNumber: frameIndex + 1, column, row, dicomColumnPosition: column + 1, dicomRowPosition: row + 1,
            columns: Math.min(m.tileColumns, m.totalColumns - column), rows: Math.min(m.tileRows, m.totalRows - row), encodedColumns: m.tileColumns,
            encodedRows: m.tileRows, opticalPathId: m.opticalPathId, focalPlaneIndex: 0, slidePosition: this.pixelToSlide([column, row]) };
    }
    tileAt(column, row) {
        const m = this.metadata; integer(column, 0, m.totalColumns - 1); integer(row, 0, m.totalRows - 1);
        return this.tileDescriptor(Math.floor(row / m.tileRows) * m.tileGridColumns + Math.floor(column / m.tileColumns));
    }
    tilesInRegion({ column, row, width, height }, { maxTiles = 1024 } = {}) {
        const m = this.metadata; integer(maxTiles, 1, MAX_SPECIALTY_FRAMES);
        if (![column, row, width, height].every(value => Number.isFinite(value) && Math.abs(value) <= 0x7FFFFFFF) || width <= 0 || height <= 0) fail('a bounded positive pixel region is required');
        const left = Math.max(0, column), top = Math.max(0, row), right = Math.min(m.totalColumns, column + width), bottom = Math.min(m.totalRows, row + height);
        if (right <= left || bottom <= top) return [];
        const firstColumn = Math.floor(left / m.tileColumns), firstRow = Math.floor(top / m.tileRows), lastColumn = Math.ceil(right / m.tileColumns) - 1,
            lastRow = Math.ceil(bottom / m.tileRows) - 1, count = (lastColumn - firstColumn + 1) * (lastRow - firstRow + 1);
        if (count > maxTiles) fail('visible tile query exceeds its result budget');
        const result = []; for (let gridRow = firstRow; gridRow <= lastRow; gridRow++) for (let gridColumn = firstColumn; gridColumn <= lastColumn; gridColumn++) result.push(this.tileDescriptor(gridRow * m.tileGridColumns + gridColumn));
        return result;
    }
    pixelToSlide(pixel) {
        const m = this.metadata;
        if (!Array.isArray(pixel) || pixel.length !== 2 || pixel.some(value => !Number.isFinite(value) || Math.abs(value) > 0x7FFFFFFF)) fail('bounded pixel-center coordinates are required');
        const [column, row] = pixel;
        return { xMm: m.origin.xMm + m.basisX[0] * column * m.pixelSpacing[1] + m.basisY[0] * row * m.pixelSpacing[0],
            yMm: m.origin.yMm + m.basisX[1] * column * m.pixelSpacing[1] + m.basisY[1] * row * m.pixelSpacing[0], zUm: m.origin.zUm };
    }
    slideToPixel({ xMm, yMm, zUm }, { frameOfReferenceUid } = {}) {
        const m = this.metadata;
        if (![xMm, yMm, zUm].every(value => Number.isFinite(value) && Math.abs(value) <= 1e9) || Math.abs(zUm - m.origin.zUm) > 1e-5 ||
            frameOfReferenceUid != null && frameOfReferenceUid !== m.frameOfReferenceUid) fail('slide point is outside the indexed plane or Frame of Reference');
        const x = xMm - m.origin.xMm, y = yMm - m.origin.yMm;
        return { column: (x * m.basisX[0] + y * m.basisX[1]) / m.pixelSpacing[1], row: (x * m.basisY[0] + y * m.basisY[1]) / m.pixelSpacing[0] };
    }
}
