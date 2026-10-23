import { attribute, text, scalar, numbers, one, sequence, reference, resolveReference, validateStructure, rejectTags, uid, integer, checkSignal, fail, MAX_DERIVED_RECORDS } from './common.js';
import { normalizeVoi } from '../data/presentation-math.js';
import { polyline, axisAlignedEllipse } from './graphics.js';

export const GSPS_SOP_CLASS = '1.2.840.10008.5.1.4.1.1.11.1';
function sameReference(first, second, singleFrame) { return first.sopUid === second.sopUid && first.sopClassUid === second.sopClassUid &&
    (first.frameNumber === second.frameNumber || singleFrame && (first.frameNumber ?? 1) === (second.frameNumber ?? 1)); }
function scoped(set, global, singleFrame) {
    const specified = one(set, '00081140', { required: false });
    if (specified && !sameReference(reference(specified), global, singleFrame)) fail('GSPS subset references a different source frame');
}

/** One monochrome frame, full-grid scale-to-fit, simple PIXEL graphics + window. */
export async function importGsps(instance, { resolveSource, signal } = {}) {
    checkSignal(signal); const set = instance?.dataSet; validateStructure(set);
    if (text(set, '00080016') !== GSPS_SOP_CLASS) fail('Grayscale Softcopy Presentation State class required');
    rejectTags(set, ['00181600', '00181602', '00181604', '00181606', '00181608', '00181610', '00181612', '00181620', '00181622', '00181623', '00181624',
        '00283000', '20500010', '00700209', '00700008', '00409096', '00283010', '00282000', '00282002', '00286100', '00289443']);
    if (set.attributes.some(attr => /^60[0-9A-F]{2}/u.test(attr.tag.ID))) fail('GSPS bitmap overlays are unsupported');
    if (attribute(set, '00700042') && scalar(set, '00700042') !== 0 || attribute(set, '00700041') && text(set, '00700041') !== 'N') fail('GSPS rotation and flips are unsupported');
    const series = one(set, '00081115'), ref = reference(one(series, '00081140')), resolved = await resolveReference(ref, resolveSource, signal);
    const singleFrame = (resolved.frame.numberOfFrames ?? resolved.frame.frameCount) === 1;
    if (uid(text(series, '0020000E')) !== resolved.image.seriesUid || !['MONOCHROME1', 'MONOCHROME2'].includes(resolved.frame.photometric) || resolved.frame.modalityLut) fail('GSPS needs the exact referenced monochrome series without a modality LUT');
    const slope = scalar(set, '00281053', { required: false }) ?? 1, intercept = scalar(set, '00281052', { required: false }) ?? 0;
    if (slope === 0 || Boolean(attribute(set, '00281053')) !== Boolean(attribute(set, '00281052')) || slope !== (resolved.frame.slope ?? 1) || intercept !== (resolved.frame.intercept ?? 0)) fail('GSPS modality transform differs from source; independent transforms are unsupported');
    const rescaleType = text(set, '00281054', { required: false });
    if (rescaleType != null && (rescaleType === 'US' ? '' : rescaleType) !== (resolved.frame.unit ?? '')) fail('GSPS modality units differ from source');
    const area = one(set, '0070005A'); scoped(area, ref, singleFrame);
    if (text(area, '00700100') !== 'SCALE TO FIT' || ![null, 'FRAME'].includes(text(area, '00480301', { required: false })) ||
        JSON.stringify(numbers(area, '00700052')) !== '[1,1]' || JSON.stringify(numbers(area, '00700053')) !== JSON.stringify([resolved.image.columns, resolved.image.rows])) fail('only a full-frame GSPS displayed area is supported');
    rejectTags(area, ['00700103']);
    const spacing = numbers(area, '00700101', { required: false }), aspect = numbers(area, '00700102', { required: false });
    if (spacing.length && (spacing.length !== 2 || !resolved.frame.pixelSpacing || spacing.some((value, index) => value !== resolved.frame.pixelSpacing[index])) ||
        !spacing.length && !aspect.length || aspect.length && (aspect.length !== 2 || aspect.some(value => !Number.isInteger(value) || value <= 0) ||
            Math.abs(aspect[0] / aspect[1] - (resolved.frame.pixelSpacing ? resolved.frame.pixelSpacing[0] / resolved.frame.pixelSpacing[1] :
                resolved.frame.pixelAspectRatio ? resolved.frame.pixelAspectRatio[0] / resolved.frame.pixelAspectRatio[1] : 1)) > 1e-9)) fail('GSPS display aspect/calibration differs from source');
    const voi = one(set, '00283110'); scoped(voi, ref, singleFrame); rejectTags(voi, ['00283010']);
    const window = normalizeVoi(scalar(voi, '00281050'), scalar(voi, '00281051'), text(voi, '00281056', { required: false }) ?? 'LINEAR');
    const presentationShape = text(set, '20500020'); if (!['IDENTITY', 'INVERSE'].includes(presentationShape)) fail('unsupported GSPS presentation polarity');
    const layers = sequence(set, '00700060', { maximum: 256 }).map(layer => {
        rejectTags(layer, ['00700067', '00700401']);
        const grayValue = scalar(layer, '00700066'); integer(grayValue, 0, 65535);
        const name = text(layer, '00700002', { maximum: 16 }); if (!/^[A-Z0-9_ ]{1,16}$/u.test(name)) fail('GSPS layer name is invalid');
        return { name, order: integer(scalar(layer, '00700062'), 0, 0xFFFFFFFF), grayValue };
    });
    if (new Set(layers.map(layer => layer.name)).size !== layers.length) fail('duplicate GSPS layers');
    const graphics = [];
    for (const group of sequence(set, '00700001', { maximum: MAX_DERIVED_RECORDS })) {
        checkSignal(signal); scoped(group, ref, singleFrame); rejectTags(group, ['00700008', '00700209']);
        const layer = text(group, '00700002', { maximum: 16 }); if (!layers.some(item => item.name === layer)) fail('undefined graphic layer');
        for (const object of sequence(group, '00700009', { maximum: MAX_DERIVED_RECORDS })) {
            if (graphics.length >= MAX_DERIVED_RECORDS) fail('graphic count limit exceeded');
            rejectTags(object, ['00700232', '00700233', '00700226', '0070031A']);
            if (text(object, '00700005') !== 'PIXEL' || scalar(object, '00700020') !== 2) fail('only two-dimensional PIXEL graphics are supported');
            const type = text(object, '00700023'), data = numbers(object, '00700022', { maximum: 258 });
            if (scalar(object, '00700021') * 2 !== data.length) fail('graphic point count differs from data');
            const graphic = type === 'POLYLINE' ? polyline(data, resolved.image) : type === 'ELLIPSE' ? axisAlignedEllipse(data, resolved.image) : fail('unsupported GSPS graphic type');
            const filled = text(object, '00700024', { required: graphic.closed });
            if (filled != null && filled !== 'N') fail('filled GSPS graphics are unsupported');
            graphics.push({ id: `gsps-${graphics.length + 1}`, layer, ...graphic, filled: false });
        }
    }
    checkSignal(signal); return { profile: 'single-frame-pixel-gsps-v1', sopUid: uid(text(set, '00080018')), image: resolved.image,
        layers, graphics, window, presentationShape, presentationInvert: presentationShape === 'INVERSE',
        displayedArea: { topLeft: [1, 1], bottomRight: [resolved.image.columns, resolved.image.rows], mode: 'SCALE TO FIT' } };
}
