import test from 'node:test';
import assert from 'node:assert/strict';
import { renderScalarToRgba, renderColorToRgba, probe, windowValue } from '../src/render/DisplayMath.js';
import { FrameCache } from '../src/runtime/frame-cache.js';
import { decodeNative } from '../src/data/native.js';

const lut = (entries, firstMapped=0, bits=8) => ({count:entries.length,firstMapped,bits,entries:Uint16Array.from(entries)});
const gray = overrides => ({ rows:1,columns:3,photometric:'MONOCHROME2',samplesPerPixel:1,
    samples:new Int16Array([-1,0,1]),slope:1,intercept:0,window:{center:0,width:3},...overrides });
const levels = rgba => [rgba[0],rgba[4],rgba[8]];

test('SIGMOID independently preserves middle intensity and symmetric tails', () => {
    assert.equal(windowValue(0,0,4,'SIGMOID'),0.5);
    assert.ok(Math.abs(windowValue(-1,0,4,'SIGMOID') - 1/(1+Math.E)) < 1e-12);
    assert.deepEqual(levels(renderScalarToRgba(gray({voiFunction:'SIGMOID',window:{center:0,width:4}}))),[69,128,186]);
});

test('modality lookup precedes VOI without changing stored values or probe units', () => {
    const frame=gray({modalityLut:lut([0,100,200],-1),voiLut:lut([0,128,255],0),voiMode:'lut',unit:'OD'});
    // All modality values above2 clamp to the last VOI entry.
    assert.deepEqual(levels(renderScalarToRgba(frame)),[0,255,255]);
    assert.equal(probe(frame,1.5,0.5).stored,0); assert.equal(probe(frame,1.5,0.5).rescaled,100);
    assert.deepEqual([...frame.samples],[-1,0,1]);
    assert.deepEqual(levels(renderScalarToRgba(frame,{center:100.5,width:201,voiMode:'window'})),[0,128,255]);
});

test('explicit presentation polarity and user inversion apply exactly once', () => {
    const frame=gray({photometric:'MONOCHROME1',presentationInvert:true,voiLut:lut([0,128,255],-1),voiMode:'lut'});
    assert.deepEqual(levels(renderScalarToRgba(frame)),[255,127,0]);
    assert.deepEqual(levels(renderScalarToRgba(frame,{...frame.window,invert:true})),[0,128,255]);
});

test('16-bit palette display and probe retain signed original indices', () => {
    const frame=gray({photometric:'PALETTE COLOR',palette:{count:3,firstMapped:-1,bits:16,
        red:new Uint16Array([65535,0,0]),green:new Uint16Array([0,65535,0]),blue:new Uint16Array([0,0,65535])}});
    assert.deepEqual([...renderColorToRgba(frame)],[255,0,0,255,0,255,0,255,0,0,255,255]);
    assert.deepEqual([...frame.samples],[-1,0,1]);
    const value=probe(frame,2.5,0.5); assert.equal(value.stored,1); assert.deepEqual(value.rgb,[0,0,255]);
});

test('worker native range uses modality LUT independently of stored samples', () => {
    const metadata={rows:1,columns:3,bitsAllocated:8,bitsStored:8,highBit:7,signed:false,
        photometric:'MONOCHROME2',modalityLut:lut([900,200,700])};
    const frame=decodeNative(new Uint8Array([0,1,2]),metadata);
    assert.deepEqual([...frame.samples],[0,1,2]); assert.deepEqual(frame.range,{min:200,max:900});
});

test('cache accounts shared table allocations once and releases their last reference', () => {
    const cache=new FrameCache(18), modalityLut=lut([0,1,2]);
    cache.set('a',{samples:new Uint16Array(3),modalityLut});
    cache.set('b',{samples:new Uint16Array(3),modalityLut});
    assert.equal(cache.bytes,18);
    cache.delete('a'); assert.equal(cache.bytes,12); assert.equal(cache.buffers.size,2);
    cache.set('c',{samples:new Uint16Array(3),modalityLut});
    cache.set('d',{samples:new Uint16Array(3),modalityLut});
    assert.equal(cache.get('b'),null); assert.equal(cache.bytes,18);
    cache.clear(); assert.equal(cache.bytes,0); assert.equal(cache.buffers.size,0);
});
