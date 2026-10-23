import { base, j, sq, c, independentNativeFixture } from './derived-fixtures.js';
import { readSpecialtyInstance, readSpecialtyMetadata, XA_SOP_CLASS, RT_DOSE_SOP_CLASS, WSI_SOP_CLASS } from '../src/specialties/index.js';
export { j, sq, c, independentNativeFixture };
export const metadata = values => readSpecialtyMetadata(values);
export const parseNative = (values, syntax = '1.2.840.10008.1.2.1') => readSpecialtyInstance(independentNativeFixture(values, syntax));
function storedBytes(samples, bits) {
    const bytes = new Uint8Array(samples.length * bits / 8 + samples.length * bits / 8 % 2), view = new DataView(bytes.buffer);
    for (let index = 0; index < samples.length; index++) {
        if (bits === 8) bytes[index] = samples[index];
        else if (bits === 16) view.setUint16(index * 2, samples[index], true);
        else view.setUint32(index * 4, samples[index], true);
    }
    return { vr: bits === 8 ? 'OB' : 'OW', InlineBinary: Buffer.from(bytes).toString('base64') };
}
export function cineFixture(overrides = {}) {
    return { ...base(XA_SOP_CLASS, '2.25.810'), '00280008': j('IS', 5), '00280009': j('AT', '00181063'), '00181063': j('DS', 20),
        '00181066': j('DS', 7), '00082142': j('IS', 2), '00082143': j('IS', 4), ...overrides };
}
export function xaFixture({ rows = 1, columns = 3, frames = [[2, 4, 6], [6, 8, 10], [10, 20, 30], [20, 10, 40], [0, 0, 0]], bits = 8, bitsStored = bits, ...overrides } = {}) {
    return { ...base(XA_SOP_CLASS, '2.25.811'), '00080060': j('CS', 'XA'), '00280010': j('US', rows), '00280011': j('US', columns),
        '00280008': j('IS', frames.length), '00280002': j('US', 1), '00280004': j('CS', 'MONOCHROME2'), '00280100': j('US', bits),
        '00280101': j('US', bitsStored), '00280102': j('US', bitsStored - 1), '00280103': j('US', 0), '00281040': j('CS', 'LIN'), '00281041': j('SS', -1),
        '00281090': j('CS', 'SUB'), '00286100': sq({ '00286101': j('CS', 'AVG_SUB'), '00286110': j('US', 1, 2), '00286112': j('US', 2),
            '00286102': j('US', 3, frames.length - 1), '00286114': j('FL', 0, 0) }), '7FE00010': storedBytes(frames.flat(), bits), ...overrides };
}
export function doseFixture({ bits = 16, offsets = [0, 2, 5], position = [10, 20, 30], orientation = [1, 0, 0, 0, 1, 0], spacing = [2, 3],
    samples = [0, 3, 2, 5, 8, 11, 10, 13, 20, 23, 22, 25], rows = 2, columns = 2, syntax = '1.2.840.10008.1.2.1', ...overrides } = {}) {
    const little = syntax !== '1.2.840.10008.1.2.2', pointerBytes = new Uint8Array(4), pointerView = new DataView(pointerBytes.buffer);
    pointerView.setUint16(0, 0x3004, little); pointerView.setUint16(2, 0x000C, little);
    return { ...base(RT_DOSE_SOP_CLASS, '2.25.812'), '00080060': j('CS', 'RTDOSE'), '00200052': j('UI', '2.25.820'),
        '00280010': j('US', rows), '00280011': j('US', columns), '00280008': j('IS', offsets.length), '00280002': j('US', 1), '00280004': j('CS', 'MONOCHROME2'),
        '00280100': j('US', bits), '00280101': j('US', bits), '00280102': j('US', bits - 1), '00280103': j('US', 0), '30040002': j('CS', 'GY'),
        '30040004': j('CS', 'PHYSICAL'), '3004000A': j('CS', 'PLAN'), '3004000E': j('DS', 0.5), '3004000C': j('DS', ...offsets),
        '00280009': { vr: 'AT', InlineBinary: Buffer.from(pointerBytes).toString('base64') }, '00200032': j('DS', ...position), '00200037': j('DS', ...orientation),
        '00280030': j('DS', ...spacing), '7FE00010': storedBytes(samples, bits), ...overrides };
}
export function breastFixture({ laterality = 'R', view = 'CC', sopUid = '2.25.813', scheme = 'SCT', modifiers = [], ...overrides } = {}) {
    const codes = { SCT: { CC: '399162004', MLO: '399368009' }, SRT: { CC: 'R-10242', MLO: 'R-10226' } };
    return { ...base('1.2.840.10008.5.1.4.1.1.1.2', sopUid), '00080060': j('CS', 'MG'), '00080068': j('CS', 'FOR PRESENTATION'), '00200062': j('CS', laterality),
        '00540220': sq({ ...c(codes[scheme][view], scheme, view), '00540222': sq(...modifiers) }), '00281350': j('CS', 'NO'), ...overrides };
}
export function slideFixture(overrides = {}) {
    return { ...base(WSI_SOP_CLASS, '2.25.814'), '00080060': j('CS', 'SM'), '00200052': j('UI', '2.25.821'), '00209311': j('CS', 'TILED_FULL'),
        '00080008': j('CS', 'ORIGINAL', 'PRIMARY', 'VOLUME', 'NONE'), '00280010': j('US', 2), '00280011': j('US', 3), '00280008': j('IS', 9),
        '00480006': j('UL', 7), '00480007': j('UL', 5), '00480303': j('UL', 1), '00480302': j('UL', 1),
        '00480105': sq({ '00480106': j('SH', 'PATH1') }), '00480008': sq({ '0040072A': j('DS', 10), '0040073A': j('DS', 20), '0040074A': j('DS', 300) }),
        '00480102': j('DS', 0, 1, 0, -1, 0, 0), '00480001': j('FL', 0.021), '00480002': j('FL', 0.01), '00480003': j('FL', 4),
        '52009229': sq({ '00289110': sq({ '00280030': j('DS', 0.002, 0.003) }) }), '00280004': j('CS', 'RGB'), '00280002': j('US', 3), '00280006': j('US', 0),
        '00280100': j('US', 8), '00280101': j('US', 8), '00280102': j('US', 7), '00280103': j('US', 0), ...overrides };
}
