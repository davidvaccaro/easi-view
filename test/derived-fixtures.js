import EASI from '@xinonix/easi-js';
// DS/IS retain their decimal-string representation; this also avoids EASI1.0.0
// interpreting an all-byte integer DS array as a raw byte override on writing.
export const j = (vr, ...values) => ({ vr, Value: ['DS', 'IS'].includes(vr) ? values.map(String) : values });
export const sq = (...Value) => j('SQ', ...Value);
export const c = (value = 'MASK', scheme = '99EASI', meaning = 'Synthetic mask') => ({ '00080100': j('SH', value), '00080102': j('SH', scheme), '00080104': j('LO', meaning) });
export function base(sopClass, sopUid) { return { '00080016': j('UI', sopClass), '00080018': j('UI', sopUid), '00100010': j('PN', 'SYNTHETIC^DERIVED'),
    '00100020': j('LO', 'SYNTHETIC-ONLY'), '0020000D': j('UI', '2.25.700'), '0020000E': j('UI', '2.25.701') }; }
export function sourceFrame(index = 0, { rows = 1, columns = 3, sopUid = `2.25.710.${index + 1}`, frameIndex = 0 } = {}) {
    return { rows, columns, sopUid, seriesUid: '2.25.710', frameOfReferenceUid: '2.25.711', sopClassUid: '1.2.840.10008.5.1.4.1.1.2', frameIndex,
        position: [0, 0, index * 2], orientation: [1, 0, 0, 0, 1, 0], pixelSpacing: [0.8, 1.2], samples: Uint16Array.from({ length: rows * columns }, (_, n) => n + 10),
        photometric: 'MONOCHROME2', slope: 1, intercept: 0, unit: 'HU' };
}
export const imageReference = frame => ({ '00081150': j('UI', frame.sopClassUid), '00081155': j('UI', frame.sopUid), '00081160': j('IS', frame.frameIndex + 1) });
export const resolver = frames => (sopUid, frameNumber) => frames.find(frame => frame.sopUid === sopUid && frame.frameIndex === frameNumber - 1);

/** Published EASI writer is the byte-encoding reference, independent of importer. */
export async function writeFixture(metadata) {
    return (await EASI.pipelineBuilder().fromByteStream().ofDicomMetadata().toDicomData().build()
        .process({ source: new TextEncoder().encode(JSON.stringify(metadata)) })).first();
}
export async function parseFixture(metadata) {
    return (await EASI.pipelineBuilder().fromByteStream().ofDicomData().withBulkDataPolicy({ mode: 'materialize', hardSafetyCap: 1024 * 1024 })
        .toInstances().build().process({ source: await writeFixture(metadata) })).first();
}
// Independent native Part10 encoder for byte-order tests; does not call importer
// or the EASI writer and keeps OW word ordering separate from OB octets.
export function independentNativeFixture(metadata, syntax = '1.2.840.10008.1.2.1') {
    const concatenate = parts => { const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0)); let offset = 0;
        for (const part of parts) { result.set(part, offset); offset += part.length; } return result; };
    const text = new TextEncoder(), little = syntax !== '1.2.840.10008.1.2.2', implicit = syntax === '1.2.840.10008.1.2';
    const dataset = (values, le, im) => concatenate(Object.keys(values).sort().map(id => element(id, values[id], le, im)));
    function element(id, attribute, le, im) {
        const vr = attribute.vr; let data;
        if (vr === 'SQ') data = concatenate(attribute.Value.map(item => { const content = dataset(item, le, im), header = new Uint8Array(8), view = new DataView(header.buffer);
            view.setUint16(0, 0xFFFE, le); view.setUint16(2, 0xE000, le); view.setUint32(4, content.length, le); return concatenate([header, content]); }));
        else if (attribute.InlineBinary != null) {
            data = Uint8Array.from(Buffer.from(attribute.InlineBinary, 'base64'));
            if (!le && vr === 'OW') for (let index = 0; index < data.length; index += 2) [data[index], data[index + 1]] = [data[index + 1], data[index]];
        } else if (['US', 'SS', 'UL', 'SL', 'FL', 'FD'].includes(vr)) {
            const widths = { US: 2, SS: 2, UL: 4, SL: 4, FL: 4, FD: 8 }, methods = { US: 'setUint16', SS: 'setInt16', UL: 'setUint32', SL: 'setInt32', FL: 'setFloat32', FD: 'setFloat64' };
            data = new Uint8Array(widths[vr] * attribute.Value.length); const view = new DataView(data.buffer);
            attribute.Value.forEach((value, index) => view[methods[vr]](index * widths[vr], Number(value), le));
        } else data = text.encode(attribute.Value.join('\\'));
        if (data.length % 2) data = concatenate([data, Uint8Array.of(vr === 'UI' || vr === 'OB' || vr === 'OW' ? 0 : 32)]);
        const long = ['OB', 'OW', 'SQ', 'UN', 'UT'].includes(vr), header = new Uint8Array(im ? 8 : long ? 12 : 8), view = new DataView(header.buffer);
        view.setUint16(0, parseInt(id.slice(0, 4), 16), le); view.setUint16(2, parseInt(id.slice(4), 16), le);
        if (im) view.setUint32(4, data.length, le);
        else { header.set(text.encode(vr), 4); if (long) view.setUint32(8, data.length, le); else view.setUint16(6, data.length, le); }
        return concatenate([header, data]);
    }
    const meta = { '00020001': { vr: 'OB', InlineBinary: 'AAE=' }, '00020002': metadata['00080016'], '00020003': metadata['00080018'],
        '00020010': j('UI', syntax), '00020012': j('UI', '2.25.705') };
    const fileMetadata = dataset(meta, true, false), preamble = new Uint8Array(132); preamble.set(text.encode('DICM'), 128);
    return concatenate([preamble, element('00020000', j('UL', fileMetadata.length), true, false), fileMetadata, dataset(metadata, little, implicit)]);
}
export function segFixture({ fractional = false, maximum = 200, values = null } = {}) {
    const sources = [0, 1, 2].map(index => sourceFrame(index));
    // Nine continuous bits:101 011 110 -> F5 + bit0=0. Nonzero unused tail bits ignored.
    const pixel = values ?? (fractional ? Uint8Array.from([0, 100, 200, 50, 150, 200, 200, 0, 100, 255]) : Uint8Array.of(0xF5, 0xFE));
    const metadata = { ...base('1.2.840.10008.5.1.4.1.1.66.4', '2.25.720'), '00080060': j('CS', 'SEG'), '00200052': j('UI', '2.25.711'),
        '00280010': j('US', 1), '00280011': j('US', 3), '00280008': j('IS', 3), '00280002': j('US', 1), '00280004': j('CS', 'MONOCHROME2'),
        '00280100': j('US', fractional ? 8 : 1), '00280101': j('US', fractional ? 8 : 1), '00280102': j('US', fractional ? 7 : 0), '00280103': j('US', 0),
        '00620001': j('CS', fractional ? 'FRACTIONAL' : 'BINARY'), '00620002': sq({ '00620004': j('US', 7), '00620005': j('LO', 'Synthetic region'),
            '00620008': j('CS', 'AUTOMATIC'), '00620009': j('LO', 'Independent fixture'), '00620003': sq(c('TISSUE')), '0062000F': sq(c('REGION')) }),
        '52009229': sq({ '00209116': sq({ '00200037': j('DS', 1, 0, 0, 0, 1, 0) }), '00289110': sq({ '00280030': j('DS', 0.8, 1.2) }) }),
        '52009230': sq(...sources.map(frame => ({ '0062000A': sq({ '0062000B': j('US', 7) }), '00209113': sq({ '00200032': j('DS', ...frame.position) }),
            '00089124': sq({ '00082112': sq({ ...imageReference(frame), '0028135A': j('CS', 'YES') }) }) }))),
        '7FE00010': { vr: 'OW', InlineBinary: Buffer.from(pixel).toString('base64') } };
    if (fractional) { metadata['00620010'] = j('CS', 'PROBABILITY'); metadata['0062000E'] = j('US', maximum); }
    return { metadata, sources };
}
export function srFixture() {
    const source = sourceFrame(0, { rows: 6, columns: 8 });
    const metadata = { ...base('1.2.840.10008.5.1.4.1.1.88.22', '2.25.730'), '0040A040': j('CS', 'CONTAINER'), '0040A050': j('CS', 'SEPARATE'),
        '0040A043': sq(c('REPORT', '99EASI', 'Synthetic measurements')), '0040A730': sq({ '0040A040': j('CS', 'NUM'), '0040A010': j('CS', 'CONTAINS'),
            '0040A043': sq(c('LENGTH', '99EASI', 'Synthetic length')), '0040A300': sq({ '0040A30A': j('DS', 5.25), '004008EA': sq(c('mm', 'UCUM', 'millimeter')) }),
            '0040A730': sq({ '0040A040': j('CS', 'SCOORD'), '0040A010': j('CS', 'INFERRED FROM'), '00700023': j('CS', 'POLYLINE'),
                '00700022': j('FL', 0, 0, 8, 6), '0040A730': sq({ '0040A040': j('CS', 'IMAGE'), '0040A010': j('CS', 'SELECTED FROM'),
                    '00081199': sq(imageReference(source)) }) }) }) };
    return { metadata, sources: [source] };
}
export function gspsFixture() {
    const source = sourceFrame(0, { rows: 6, columns: 8 });
    const metadata = { ...base('1.2.840.10008.5.1.4.1.1.11.1', '2.25.740'), '00081115': sq({ '0020000E': j('UI', source.seriesUid), '00081140': sq(imageReference(source)) }),
        '00700041': j('CS', 'N'), '00700042': j('US', 0), '0070005A': sq({ '00700052': j('SL', 1, 1), '00700053': j('SL', 8, 6),
            '00700100': j('CS', 'SCALE TO FIT'), '00700101': j('DS', 0.8, 1.2) }), '00283110': sq({ '00281050': j('DS', 40), '00281051': j('DS', 400) }),
        '20500020': j('CS', 'IDENTITY'), '00700060': sq({ '00700002': j('CS', 'MEASURE'), '00700062': j('IS', 1), '00700066': j('US', 65535) }),
        '00700001': sq({ '00700002': j('CS', 'MEASURE'), '00700009': sq({ '00700005': j('CS', 'PIXEL'), '00700020': j('US', 2), '00700021': j('US', 2),
            '00700022': j('FL', 0, 0, 8, 6), '00700023': j('CS', 'POLYLINE') }, { '00700005': j('CS', 'PIXEL'), '00700020': j('US', 2), '00700021': j('US', 4),
            '00700022': j('FL', 1, 3, 7, 3, 4, 1, 4, 5), '00700023': j('CS', 'ELLIPSE'), '00700024': j('CS', 'N') }) }) };
    return { metadata, sources: [source] };
}
