import test from 'node:test';
import assert from 'node:assert/strict';
import { describeImageStacks } from '../src/ui/image-stack-labels.js';

const axial = [1, 0, 0, 0, 1, 0], coronal = [1, 0, 0, 0, 0, 1], sagittal = [0, 1, 0, 0, 0, 1];
const frame = (changes = {}) => ({ orientation: axial, rows: 256, columns: 512, ...changes });
const stack = (...frames) => ({ frames });
const labels = stacks => describeImageStacks(stacks).map(item => item.label);

test('image-stack planes use independent numeric row-cross-column orientation, including reversed directions', () => {
    assert.deepEqual(labels([stack(frame()), stack(frame({ orientation: coronal })), stack(frame({ orientation: sagittal })),
        stack(frame({ orientation: [1, 0, 0, 0, -1, 0] }))]), ['Axial #1', 'Coronal', 'Sagittal', 'Axial #4']);
    assert.deepEqual(labels([stack(frame({ orientation: [Math.SQRT1_2, 0, Math.SQRT1_2, 0, 1, 0] }))]), ['Oblique · 512×256']);
});

test('only differing dimensions distinguish multiple stacks and classic echo and time values remain explicit', () => {
    const items = [1, 2].map(echo => stack(frame({ classicDimensions: { echoNumbers: [echo], temporalPositionIndex: 3 } })));
    assert.deepEqual(labels(items), ['Echo 1', 'Echo 2']);
    assert.deepEqual(labels([stack(frame({ classicDimensions: { temporalPositionIndex: 2 } })),
        stack(frame({ classicDimensions: { temporalPositionIndex: 3 } }))]), ['Time 2', 'Time 3']);
});

test('enhanced dimensions expose echo, temporal position, and diffusion b-values without clinical inference', () => {
    assert.deepEqual(labels([stack(frame({ dimensions: { echoNumber: 1 } })), stack(frame({ dimensions: { echoNumbers: [2] } }))]), ['Echo 1', 'Echo 2']);
    assert.deepEqual(labels([stack(frame({ dimensions: { temporalPositionIndex: 1, diffusionBValue: 0 } })),
        stack(frame({ dimensions: { temporalPositionIndex: 2, diffusionBValue: 1000 } }))]), ['Time 1 · b=0', 'Time 2 · b=1000']);
    assert.deepEqual(labels([stack(frame({ dimensions: { effectiveEchoTime: 12 } })),
        stack(frame({ dimensions: { effectiveEchoTime: 24 } }))]), ['TE 12ms', 'TE 24ms']);
});

test('matrix labels use columns by rows and remain available without patient orientation', () => {
    assert.deepEqual(labels([stack(frame({ orientation: null })), stack(frame({ orientation: null, columns: 1024 }))]), ['512×256', '1024×256']);
});

test('unknown, invalid, mixed, and incomplete frame descriptors do not fabricate stack labels', () => {
    assert.deepEqual(labels([stack({}), stack({}), stack()]), ['Stack 1', 'Stack 2', 'Stack 3']);
    const invalids = [null, [], [1, 0, 0, 1, 0, 0], [2, 0, 0, 0, 1, 0], [1, 0, 0, 0, NaN, 0]];
    for (const orientation of invalids) assert.deepEqual(labels([stack({ orientation })]), ['Stack 1']);
    assert.deepEqual(labels([stack(frame(), frame({ orientation: coronal }))]), ['512×256']);
    assert.deepEqual(labels([stack({ classicDimensions: { echoNumbers: [1] } }, {}),
        stack({ dimensions: { echoNumbers: [1, 2], effectiveEchoTime: 10 } }),
        stack({ classicDimensions: { invalid: true, echoNumbers: [2] } })]), ['Stack 1', 'Stack 2', 'Stack 3']);
    assert.deepEqual(labels([stack({ dimensions: { temporalPositionIndex: 1 } }, { dimensions: { temporalPositionIndex: 2 } })]), ['Stack 1']);
});

test('all image-stack labels are short and unique, preserve ids and frame counts, and never mutate descriptors', () => {
    const items = Array.from({ length: 100 }, (_, index) => stack(frame({ dimensions: {
        echoNumbers: [123456789], temporalPositionIndex: 123456789, diffusionBValue: 123456789
    } }), frame({ dimensions: { echoNumbers: [123456789], temporalPositionIndex: 123456789, diffusionBValue: 123456789 } })));
    const before = structuredClone(items);
    const result = describeImageStacks(items);
    assert.equal(result.length, 100); assert.equal(new Set(result.map(item => item.label)).size, 100);
    assert.ok(result.every(item => item.label.length <= 24 && item.frameCount === 2));
    assert.deepEqual(result.map(item => item.id), items.map((_, index) => String(index)));
    assert.deepEqual(items, before); assert.deepEqual(describeImageStacks([]), []);
});

test('overflowing descriptive values retain bounded, unique numeric fallback labels', () => {
    const items = [1, 2, 3].map(index => stack({ dimensions: { effectiveEchoTime: index * 1.234567890123456e-90 } }));
    const result = describeImageStacks(items);
    assert.ok(result.every(item => item.label.length <= 24));
    assert.equal(new Set(result.map(item => item.label)).size, items.length);
});
