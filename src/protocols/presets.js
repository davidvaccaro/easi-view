import { normalizeReadingProtocols } from './schema.js';
const mono = { field: 'photometric', op: 'in', value: ['MONOCHROME1', 'MONOCHROME2'] };
const protocols = normalizeReadingProtocols([
    { version: 1, id: 'ct-dual-window', name: 'CT · two windows, one stack', layout: 2,
        selectors: [{ id: 'selected', scope: 'selected', rules: [{ field: 'modality', op: 'eq', value: 'CT' }, mono, { field: 'unit', op: 'eq', value: 'HU' }] }],
        slots: [{ id: 0, selector: 'selected', label: 'Soft tissue', frame: { mode: 'active' }, window: { center: 40, width: 400 }, windowUnit: 'HU' },
            { id: 1, selector: 'selected', label: 'Lung', frame: { mode: 'active' }, window: { center: -600, width: 1500 }, windowUnit: 'HU' }],
        links: { scroll: true, window: false, camera: true } },
    { version: 1, id: 'mr-sequence-comparison', name: 'MR · compare selected sequences', layout: 2,
        selectors: [{ id: 'selected', scope: 'selected', rules: [{ field: 'modality', op: 'eq', value: 'MR' }, mono] },
            { id: 'comparison', scope: 'current', distinctFrom: ['selected'], rules: [{ field: 'modality', op: 'eq', value: 'MR' }, mono] }],
        slots: [{ id: 0, selector: 'selected', label: 'Selected sequence', frame: { mode: 'active' } },
            { id: 1, selector: 'comparison', label: 'Comparison sequence', frame: { mode: 'middle' } }], links: { scroll: false, window: false, camera: false } },
    { version: 1, id: 'current-prior-comparison', name: 'Current / prior · explicit study roles', layout: 2,
        selectors: [{ id: 'current', scope: 'current', rules: [mono] }, { id: 'prior', scope: 'prior', rules: [mono] }],
        slots: [{ id: 0, selector: 'current', label: 'Current', frame: { mode: 'middle' } },
            { id: 1, selector: 'prior', label: 'Prior', frame: { mode: 'middle' } }], links: { scroll: false, window: false, camera: false } }
]);
/** Immutable, explicit presets. No anatomy/sequence or registration inference. */
export function getDefaultReadingProtocols() { return protocols; }
