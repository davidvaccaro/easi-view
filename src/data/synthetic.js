// All public demo pixels and identifiers are generated here. No imaging corpus is used.
const textEncoder = new TextEncoder();
const LONG_VR = new Set(['OB', 'OW', 'SQ', 'UN', 'UT']);
const UID_ROOT = '1.2.826.0.1.3680043.10.543.900';
const SOP = {
    ct: '1.2.840.10008.5.1.4.1.1.2', mr: '1.2.840.10008.5.1.4.1.1.4',
    xr: '1.2.840.10008.5.1.4.1.1.1', us: '1.2.840.10008.5.1.4.1.1.3.1'
};

function concat(parts) {
    const bytes = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
    let offset = 0;
    for (const part of parts) { bytes.set(part, offset); offset += part.length; }
    return bytes;
}

function encodeValue(vr, value, littleEndian) {
    if (value instanceof Uint8Array) return value;
    if (vr === 'US' || vr === 'SS' || vr === 'UL') {
        const bytes = new Uint8Array(vr === 'UL' ? 4 : 2);
        const view = new DataView(bytes.buffer);
        if (vr === 'UL') view.setUint32(0, value, littleEndian);
        else if (vr === 'SS') view.setInt16(0, value, littleEndian);
        else view.setUint16(0, value, littleEndian);
        return bytes;
    }
    const encoded = textEncoder.encode(Array.isArray(value) ? value.join('\\') : String(value));
    if (encoded.length % 2 === 0) return encoded;
    return concat([encoded, new Uint8Array([vr === 'UI' ? 0 : 32])]);
}

function element(id, vr, value, littleEndian, implicit = false) {
    let bytes = encodeValue(vr, value, littleEndian);
    if (bytes.length % 2) bytes = concat([bytes, new Uint8Array(1)]);
    const header = new Uint8Array(implicit ? 8 : LONG_VR.has(vr) ? 12 : 8);
    const view = new DataView(header.buffer);
    view.setUint16(0, parseInt(id.slice(0, 4), 16), littleEndian);
    view.setUint16(2, parseInt(id.slice(4), 16), littleEndian);
    if (implicit) view.setUint32(4, bytes.length, littleEndian);
    else {
        header.set(textEncoder.encode(vr), 4);
        if (LONG_VR.has(vr)) view.setUint32(8, bytes.length, littleEndian);
        else view.setUint16(6, bytes.length, littleEndian);
    }
    return concat([header, bytes]);
}

/** Independent small Part 10 writer, limited to native synthetic test/demo images. */
export function createDicomFixture(options = {}) {
    const rows = options.rows ?? 2;
    const columns = options.columns ?? 2;
    const frames = options.frames ?? 1;
    const bitsAllocated = options.bitsAllocated ?? 16;
    const bitsStored = options.bitsStored ?? bitsAllocated;
    const highBit = options.highBit ?? bitsStored - 1;
    const signed = options.signed ?? false;
    const transferSyntax = options.transferSyntax ?? '1.2.840.10008.1.2.1';
    const littleEndian = transferSyntax !== '1.2.840.10008.1.2.2';
    const implicit = transferSyntax === '1.2.840.10008.1.2';
    const sopClass = options.sopClass ?? SOP.ct;
    const sopUid = options.sopUid ?? `${UID_ROOT}.1.1`;
    let pixels = options.rawPixelBytes;
    if (!pixels) {
        const values = options.values ?? [0, 100, 200, 300];
        if (values.length !== rows * columns * frames) throw new Error('Synthetic fixture dimensions and samples disagree.');
        pixels = new Uint8Array(values.length * bitsAllocated / 8);
        const view = new DataView(pixels.buffer);
        for (let i = 0; i < values.length; i++) {
            const normalized = values[i] < 0 ? values[i] + 2 ** bitsStored : values[i];
            const packed = normalized * 2 ** (highBit + 1 - bitsStored);
            if (bitsAllocated === 8) view.setUint8(i, packed);
            else view.setUint16(i * 2, packed, littleEndian);
        }
    }
    const meta = concat([
        element('00020001', 'OB', new Uint8Array([0, 1]), true),
        element('00020002', 'UI', sopClass, true),
        element('00020003', 'UI', sopUid, true),
        element('00020010', 'UI', transferSyntax, true),
        element('00020012', 'UI', `${UID_ROOT}.0`, true),
        element('00020013', 'SH', 'EASIVIEW_SYNTH', true)
    ]);
    const attributes = new Map([
        ['00080005', ['CS', 'ISO_IR 192']],
        ['00080008', ['CS', ['DERIVED', 'SECONDARY', 'SYNTHETIC']]],
        ['00080016', ['UI', sopClass]], ['00080018', ['UI', sopUid]],
        ['00080060', ['CS', options.modality ?? 'CT']],
        ['0008103E', ['LO', options.description ?? 'Synthetic scalar fixture']],
        ['00100010', ['PN', 'SYNTHETIC^DEMO']], ['00100020', ['LO', 'EASI-SYNTHETIC']],
        ['0020000D', ['UI', `${UID_ROOT}.1`]],
        ['0020000E', ['UI', options.seriesUid ?? `${UID_ROOT}.1.0`]],
        ['00200013', ['IS', options.instanceNumber ?? 1]],
        ['00200032', ['DS', options.position ?? [0, 0, 0]]],
        ['00200037', ['DS', options.orientation ?? [1, 0, 0, 0, 1, 0]]],
        ['00280002', ['US', 1]], ['00280004', ['CS', options.photometric ?? 'MONOCHROME2']],
        ['00280008', ['IS', frames]], ['00280010', ['US', rows]], ['00280011', ['US', columns]],
        ['00280030', ['DS', options.pixelSpacing ?? [0.75, 0.75]]],
        ['00280100', ['US', bitsAllocated]], ['00280101', ['US', bitsStored]],
        ['00280102', ['US', highBit]], ['00280103', ['US', signed ? 1 : 0]],
        ['00280301', ['CS', 'YES']],
        ['00281052', ['DS', options.intercept ?? 0]], ['00281053', ['DS', options.slope ?? 1]],
        ['00281056', ['CS', options.voiFunction ?? 'LINEAR']],
        ['7FE00010', [bitsAllocated === 8 ? 'OB' : 'OW', pixels]]
    ]);
    if (options.window) {
        attributes.set('00281050', ['DS', options.window.center]);
        attributes.set('00281051', ['DS', options.window.width]);
    }
    if (options.rescaleType || (options.modality ?? 'CT') === 'CT') attributes.set('00281054', ['LO', options.rescaleType ?? 'HU']);
    if (options.padding != null) attributes.set('00280120', [signed ? 'SS' : 'US', options.padding]);
    if (options.paddingLimit != null) attributes.set('00280121', [signed ? 'SS' : 'US', options.paddingLimit]);
    if (frames > 1) {
        attributes.set('00280009', ['AT', new Uint8Array([0x18, 0, 0x63, 0x10])]);
        attributes.set('00181063', ['DS', options.frameTime ?? 50]);
    }
    for (const [id, value] of Object.entries(options.extraAttributes ?? {})) {
        if (value === null) attributes.delete(id);
        else attributes.set(id, value);
    }
    const preamble = new Uint8Array(132);
    preamble.set(textEncoder.encode('DICM'), 128);
    const dataset = [...attributes].sort(([a], [b]) => a.localeCompare(b))
        .map(([id, [vr, value]]) => element(id, vr, value, littleEndian, implicit));
    return concat([preamble, element('00020000', 'UL', meta.length, true), meta, ...dataset]);
}

function noise(x, y, z) {
    const n = Math.sin(x * 12.9898 + y * 78.233 + z * 37.719) * 43758.5453;
    return n - Math.floor(n);
}

function phantom(kind, rows, columns, slice, total) {
    const values = new Int32Array(rows * columns);
    const z = total > 1 ? slice / (total - 1) : 0.5;
    for (let r = 0; r < rows; r++) {
        for (let c = 0; c < columns; c++) {
            const x = (c - columns / 2) / (columns / 2);
            const y = (r - rows / 2) / (rows / 2);
            const grain = noise(c, r, slice) - 0.5;
            let value;
            if (kind === 'ct') {
                const body = (x / 0.89) ** 2 + (y / 0.70) ** 2;
                const lungs = [((x + 0.36) / 0.25) ** 2 + ((y + 0.06) / 0.43) ** 2,
                    ((x - 0.36) / 0.25) ** 2 + ((y + 0.06) / 0.43) ** 2];
                value = body < 1 ? 35 + 20 * grain : -1000;
                if (body > 0.82 && body < 0.98) value = -90 + 25 * grain;
                if (lungs.some(l => l < 1)) value = -820 + 65 * grain;
                if ((x / 0.09) ** 2 + ((y - 0.37) / 0.12) ** 2 < 1) value = 950;
                if ((x / 0.04) ** 2 + ((y - 0.37) / 0.06) ** 2 < 1) value = 120;
                if (((x + 0.02) / 0.16) ** 2 + ((y + 0.01) / 0.22) ** 2 < 1) value = 65;
                const ribs = Math.abs(Math.sin(Math.atan2(y / 0.70, x / 0.89) * 9));
                if (body > 0.77 && body < 0.86 && ribs > 0.94) value = 1150;
                for (const side of [-1, 1]) {
                    const vx = side * (0.32 + 0.04 * Math.sin(z * 6));
                    const vy = -0.22 + z * 0.31;
                    if ((x - vx) ** 2 + (y - vy) ** 2 < 0.0035) value = 90;
                }
            } else if (kind === 'mr') {
                const scale = 0.79 + 0.11 * Math.sin(z * Math.PI);
                const radius = (x / (scale * 0.83)) ** 2 + (y / scale) ** 2;
                value = radius < 1 ? 850 + 110 * grain : 0;
                if (radius > 0.85 && radius < 1.03) value = 120 + 45 * grain;
                if (radius < 0.81) value = 1250 + 100 * grain;
                const groove = Math.sin(x * 23 + Math.sin(y * 18)) * Math.cos(y * 27 + z * 5);
                if (radius < 0.83 && Math.abs(groove) > 0.81) value = 380;
                if (((x - 0.12) / 0.10) ** 2 + ((y + 0.05) / 0.28) ** 2 < 1 ||
                    ((x + 0.12) / 0.10) ** 2 + ((y + 0.05) / 0.28) ** 2 < 1) value = 230;
                if (radius < 0.8 && Math.abs(x) < 0.012) value = 450;
            } else if (kind === 'xr') {
                const body = (x / 0.84) ** 2 + (y / 1.13) ** 2;
                value = body < 1 ? 1700 + 450 * (1 - Math.abs(x)) : 3500;
                const lung = ((Math.abs(x) - 0.34) / 0.27) ** 2 + ((y + 0.04) / 0.67) ** 2;
                if (lung < 1) value = 3000 - 350 * Math.abs(y);
                if (body < 1 && Math.abs(x) < 0.085) value -= 800;
                const rib = Math.sin((y + 0.22 * x * x) * 31);
                if (body < 1 && Math.abs(x) > 0.13 && Math.abs(rib) > 0.94) value -= 550;
                if (((x - 0.06) / 0.27) ** 2 + ((y - 0.27) / 0.37) ** 2 < 1) value -= 900;
                value += grain * 55;
            } else {
                const shiftedY = y + 1;
                const radius = Math.hypot(x, shiftedY);
                const angle = Math.atan2(x, shiftedY);
                const inFan = radius > 0.19 && radius < 1.83 && Math.abs(angle) < 0.62;
                value = inFan ? 35 + noise(c, r, 2) * 95 * (1 - radius / 2.4) : 0;
                const phase = slice / total * 2 * Math.PI;
                const hx = x + 0.045 * Math.sin(phase);
                const hy = y - 0.05;
                const heart = (hx / (0.39 + 0.035 * Math.sin(phase))) ** 2 + (hy / (0.45 - 0.045 * Math.sin(phase))) ** 2;
                if (inFan && heart < 1) value = 8 + grain * 8;
                if (inFan && heart > 0.78 && heart < 1.2) value = 140 + grain * 80;
                if (inFan && heart < 0.85 && Math.abs(hx - hy * 0.2 - 0.035 * Math.cos(phase)) < 0.025) value = 170;
                if (inFan && radius > 1.75) value = 145 + grain * 40;
            }
            values[r * columns + c] = Math.round(value);
        }
    }
    return values;
}

export function makeDemoFiles(kind = 'ct') {
    kind = String(kind).toLowerCase();
    if (!Object.hasOwn(SOP, kind)) throw new Error('Choose CT, MR, XR, or US for the synthetic demo.');
    const specs = {
        ct: { rows: 192, columns: 256, count: 16, description: 'Synthetic CT · thorax phantom', window: { center: 40, width: 400 } },
        mr: { rows: 224, columns: 224, count: 12, description: 'Synthetic MR · brain phantom', window: { center: 750, width: 1500 } },
        xr: { rows: 384, columns: 320, count: 1, description: 'Synthetic XR · chest phantom', window: { center: 1850, width: 3300 } },
        us: { rows: 192, columns: 192, count: 24, description: 'Synthetic US · cardiac cine', window: { center: 128, width: 256 } }
    };
    const spec = specs[kind];
    const uid = `${UID_ROOT}.${Object.keys(SOP).indexOf(kind) + 10}`;
    const base = {
        rows: spec.rows, columns: spec.columns, modality: kind.toUpperCase(), sopClass: SOP[kind],
        description: spec.description, seriesUid: `${uid}.1`, window: spec.window,
        signed: kind === 'ct', bitsAllocated: kind === 'us' ? 8 : 16,
        bitsStored: kind === 'ct' ? 16 : kind === 'us' ? 8 : 12,
        photometric: kind === 'xr' ? 'MONOCHROME1' : 'MONOCHROME2', pixelSpacing: kind === 'us' ? [0.45, 0.45] : [0.75, 0.75]
    };
    if (kind === 'us') {
        const values = new Int32Array(spec.rows * spec.columns * spec.count);
        for (let i = 0; i < spec.count; i++) values.set(phantom(kind, spec.rows, spec.columns, i, spec.count), i * spec.rows * spec.columns);
        return [new File([createDicomFixture({ ...base, sopUid: `${uid}.1.1`, frames: spec.count, values })], 'synthetic-us-cine.dcm', { type: 'application/dicom' })];
    }
    return Array.from({ length: spec.count }, (_, i) => new File([
        createDicomFixture({ ...base, sopUid: `${uid}.1.${i + 1}`, instanceNumber: i + 1, position: [0, 0, i * 2.5], values: phantom(kind, spec.rows, spec.columns, i, spec.count) })
    ], `synthetic-${kind}-${String(i + 1).padStart(3, '0')}.dcm`, { type: 'application/dicom' }));
}
