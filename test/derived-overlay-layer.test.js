import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OverlayStore } from '../src/derived/OverlayStore.js';
import { OverlayRenderCache, DerivedOverlayLayer, MAX_OVERLAY_RENDER_BYTES } from '../src/render/DerivedOverlayLayer.js';
import { createImageReference } from '../src/annotations/model.js';
import { createImageTransform, transformPoint } from '../src/render/ViewportTransform.js';
import { sourceFrame } from './derived-fixtures.js';

class ImageData { constructor(data,width,height) { this.data=data;this.width=width;this.height=height; } }
class Canvas {
    constructor(document) {
        this.allocations=[];this.ownerDocument=document;this.width=120;this.height=40;this.hidden=false;this.removed=false;
        this.style={setProperty(){}};this.attributes={};this.draws=[];this.transforms=[];this.data=null;this.throwDraw=false;
        this.context={setTransform:(...m)=>{this.transforms.push(m);},clearRect:()=>{this.draws=[];},
            drawImage:bitmap=>{if(this.throwDraw){this.throwDraw=false;throw new Error('Synthetic draw failure');}this.draws.push(bitmap);},
            putImageData:data=>{this.data=new Uint8ClampedArray(data.data);}};
    }
    set width(value){this._width=value;if(this._height!=null)this.allocations?.push(value*this._height*4);}get width(){return this._width;}
    set height(value){this._height=value;if(this._width!=null)this.allocations?.push(value*this._width*4);}get height(){return this._height;}
    setAttribute(k,v){this.attributes[k]=v;} after(canvas){this.overlay=canvas;} remove(){this.removed=true;}
    getContext(){return this.context;}getBoundingClientRect(){return{left:50,top:80,width:120,height:40};}
}
const document={createElement:()=>new Canvas(document),defaultView:{ImageData}};
function setup(options={}) {
    const frame=sourceFrame(),store=new OverlayStore({maxBytes:32*1024*1024}),cache=new OverlayRenderCache(store,{document,...options});
    let renders=0;const render=store.render.bind(store);store.render=(...args)=>{++renders;return render(...args);};
    const state={zoom:1,panX:0,panY:0,rotation:0,flipX:false,flipY:false},image=new Canvas(document);
    const viewport={frame,imageToScreen:(x,y)=>transformPoint(createImageTransform(viewport.frame,state,120,40),x,y)};
    const layer=new DerivedOverlayLayer(image,viewport,cache);
    const add=(id='mask',values=[0,1,1],color=[255,0,0])=>store.add({id,image:createImageReference(frame),kind:'binary',values,opacity:.5,color,source:'ai'});
    return{frame,store,cache,state,image,viewport,layer,add,get renders(){return renders;},cleanup(){layer.dispose();cache.dispose();store.dispose();}};
}
const close=(a,b)=>assert.ok(Math.abs(a-b)<1e-9,`${a} differs from ${b}`);

test('unmasked frame redraws keep the overlay canvas zero-sized without reserving a display bitmap',async()=>{
    const f=setup();
    try{
        await f.layer.render(f.frame);f.layer.resize();f.state.rotation=90;f.state.zoom=2;f.layer.resize();
        assert.deepEqual([f.layer.canvas.width,f.layer.canvas.height],[0,0]);assert.equal(f.layer.canvas.hidden,true);
        assert.equal(f.cache.getState().bytes,0);assert.equal(f.cache.getState().displayCount,0);assert.equal(f.renders,0);
    }finally{f.cleanup();}
});

test('redrawing an unmasked frame during its first pending mask leaves candidate cancellation and reservations intact',async()=>{
    const f=setup();let release,signal;
    try{
        await f.layer.render(f.frame);f.add();
        f.store.render=(_frame,options)=>{signal=options.signal;return new Promise(resolve=>{release=()=>resolve({rgba:Uint8ClampedArray.from([0,0,0,0,255,0,0,128,255,0,0,128]),rows:1,columns:3,alphaMode:'straight'});});};
        const pending=f.layer.render(f.frame),admitted=f.cache.getState().bytes;assert.equal(admitted,120*40*4+24);
        f.layer.resize();assert.equal(signal.aborted,false);assert.equal(f.cache.getState().bytes,admitted);
        assert.deepEqual([f.layer.canvas.width,f.layer.canvas.height],[0,0]);assert.equal(f.layer.canvas.hidden,true);
        release();await pending;assert.equal(f.layer.canvas.hidden,false);assert.equal(f.cache.getState().bytes,120*40*4+12);
    }finally{f.cleanup();}
});

test('disposal completion awaits canceled render buffers before declaring nominal reservations released',async()=>{
    let release,started;const begun=new Promise(resolve=>{started=resolve;}),f=setup();f.add();
    f.store.render=()=>new Promise(resolve=>{release=()=>resolve({rgba:new Uint8ClampedArray(12),rows:1,columns:3,alphaMode:'straight'});started();});
    assert.throws(()=>f.cache.whenDisposed(),/Dispose/);
    const acquire=f.cache.acquire(f.frame);await begun;assert.equal(f.cache.getState().bytes,24);
    f.cache.dispose();let complete=false;const disposed=f.cache.whenDisposed().then(()=>{complete=true;});await Promise.resolve();
    assert.equal(complete,false);assert.equal(f.cache.getState().bytes,24);release();await assert.rejects(acquire);await disposed;
    assert.equal(f.cache.getState().bytes,0);assert.equal(f.cache.getState().pendingCount,0);assert.equal(complete,true);
    f.cache.dispose();await f.cache.whenDisposed();f.layer.dispose();f.store.dispose();
});

test('straight RGBA mask pixels, transparent zero values and source padding samples are independent of grayscale originals',async()=>{
    const f=setup();f.frame.padding={min:10,max:10};const original=[...f.frame.samples];f.add('mask',[1,0,1]);
    try{
        await f.layer.render(f.frame);assert.deepEqual([...f.layer.lease.bitmap.data],[255,0,0,128,0,0,0,0,255,0,0,128]);
        assert.deepEqual([...f.frame.samples],original);assert.equal(f.renders,1);assert.equal(f.layer.canvas.attributes['aria-hidden'],'true');
        assert.equal(f.layer.canvas.hidden,false);assert.equal(f.cache.getState().bytes,120*40*4+12);
    }finally{f.cleanup();}
});

test('window/pan/zoom redraws reuse cached masks rather than rescanning values, and DPR affine axes match image-edge geometry',async()=>{
    const f=setup();f.image.width=240;f.image.height=80;f.add();
    try{
        await f.layer.render(f.frame);const first=f.layer.canvas.transforms.at(-2);
        close(first[0],80);close(first[1],0);close(first[2],0);close(first[3],160/3);close(first[4],0);close(first[5],40/3);
        f.state.rotation=90;f.state.flipX=true;f.state.panX=7;f.state.panY=-3;f.layer.resize();
        const changed=f.layer.canvas.transforms.at(-2);close(changed[0],0);close(changed[1],-80/3);close(changed[2],-160/9);close(changed[3],0);close(changed[4],1160/9+14);close(changed[5],74);
        await f.layer.render(f.frame);assert.equal(f.renders,1);assert.equal(f.cache.getState().cachedCount,1);
    }finally{f.cleanup();}
});

test('concurrent panes share one scoped mask bitmap; canceling one waiter does not cancel the remaining pane',async()=>{
    const f=setup();f.add();const image=new Canvas(document),other=new DerivedOverlayLayer(image,f.viewport,f.cache),controller=new AbortController();
    try{
        const a=f.layer.render(f.frame,{signal:controller.signal}),b=other.render(f.frame);controller.abort();
        await assert.rejects(a,{name:'AbortError'});await b;assert.equal(f.renders,1);assert.equal(other.canvas.hidden,false);
        await f.layer.render(f.frame);assert.equal(f.renders,1);assert.equal(f.layer.lease.bitmap,other.lease.bitmap);
        assert.equal(f.cache.getState().bytes,2*120*40*4+12);
    }finally{other.dispose();f.cleanup();}
});

test('wrong original frame, grid or FoR never aliases a cached overlay',async()=>{
    const f=setup();f.add();
    try{
        await f.layer.render(f.frame);const bitmap=f.layer.lease.bitmap;
        f.viewport.frame={...f.frame,frameIndex:1};await f.layer.render(f.viewport.frame);assert.equal(f.layer.lease,null);assert.equal(f.layer.canvas.hidden,true);
        f.viewport.frame={...f.frame,frameOfReferenceUid:'2.25.999'};await assert.rejects(f.layer.render(f.viewport.frame),/SOP, original frame or geometry/);
        assert.equal(f.layer.canvas.hidden,true);assert.equal(f.renders,2);assert.notEqual(f.layer.lease?.bitmap,bitmap);
    }finally{f.cleanup();}
});

test('render budgets include display backing, shared visible leases and prospective RGBA+bitmap staging',async()=>{
    const f=setup({maxBytes:19230});f.add();
    try{
        await f.layer.render(f.frame);const old=f.layer.lease.bitmap;f.store.updateStyle('mask',{color:[0,0,255]});
        await assert.rejects(f.layer.render(f.frame),/shared byte budget/);assert.equal(f.layer.lease.bitmap,old);assert.equal(f.layer.canvas.hidden,true);assert.equal(f.renders,1);
        assert.ok(f.cache.getState().bytes<=19230);
        f.image.width=10000;f.image.height=10000;const dimensions=[f.layer.canvas.width,f.layer.canvas.height];
        await assert.rejects(f.layer.render(f.frame),/byte budget/);assert.deepEqual([f.layer.canvas.width,f.layer.canvas.height],dimensions);assert.equal(f.layer.lease.bitmap,old);
    }finally{f.cleanup();}
});

test('a16MP mask is rejected before any typed RGBA allocation or store render call',async()=>{
    let renders=0;const store={getRevision:()=>0,subscribe:()=>()=>{},listDescriptors:()=>[{opacity:1}],render:()=>{++renders;throw new Error('Must not allocate');}};
    const cache=new OverlayRenderCache(store,{document}),frame={...sourceFrame(),rows:4096,columns:4096};
    await assert.rejects(cache.acquire(frame),/byte budget/);assert.equal(renders,0);assert.equal(cache.getState().bytes,0);cache.dispose();
});

test('failed candidate draw restores the prior bitmap and a later success reuses the prepared candidate without a rescan',async()=>{
    const f=setup();f.add();
    try{
        await f.layer.render(f.frame);const old=f.layer.lease.bitmap;f.store.updateStyle('mask',{color:[0,0,255]});f.layer.canvas.throwDraw=true;
        await assert.rejects(f.layer.render(f.frame),/Synthetic draw failure/);assert.equal(f.layer.lease.bitmap,old);assert.equal(f.layer.canvas.draws.at(-1),old);
        await f.layer.render(f.frame);assert.notEqual(f.layer.lease.bitmap,old);assert.equal(f.renders,2);assert.equal(old.width,0);assert.equal(f.cache.getState().cachedCount,1);
    }finally{f.cleanup();}
});

test('superseded frame work never commits and mismatched pending frames hide old pixels while preserving a rollback lease',async()=>{
    const f=setup();f.add();const second={...f.frame,sopUid:'2.25.710.2'};
    f.store.add({id:'other',image:createImageReference(second),kind:'binary',values:[1,1,0],opacity:.5,color:[0,255,0]});
    try{
        await f.layer.render(f.frame);const old=f.layer.lease.bitmap;f.viewport.frame=second;
        const request=f.layer.render(second);assert.equal(f.layer.canvas.hidden,true);assert.equal(f.layer.lease.bitmap,old);
        f.viewport.frame=f.frame;await f.layer.render(f.frame);await assert.rejects(request,{name:'AbortError'});
        assert.equal(f.layer.lease.bitmap,old);assert.equal(f.layer.canvas.hidden,false);
    }finally{f.cleanup();}
});

test('last canceled waiter and disposal stop pending scans, release nominal display/cache bytes and remove only the owned canvas',async()=>{
    const f=setup();f.add();const controller=new AbortController(),pending=f.layer.render(f.frame,{signal:controller.signal});controller.abort();
    await assert.rejects(pending,{name:'AbortError'});f.layer.dispose();f.cache.dispose();
    await new Promise(resolve=>setTimeout(resolve,5));assert.equal(f.cache.getState().bytes,0);assert.equal(f.layer.getState().bytes,0);
    assert.equal(f.layer.canvas.removed,true);assert.equal(f.image.removed,false);assert.equal(f.cache.getState().displayCount,0);f.store.dispose();
});

test('no overlays allocate no display backing, including ordinary large viewports',async()=>{
    const f=setup();f.image.width=10000;f.image.height=10000;
    try{await f.layer.render(f.frame);assert.equal(f.layer.getState().bytes,0);assert.equal(f.cache.getState().bytes,0);assert.equal(f.renders,0);}finally{f.cleanup();}
});


for(const omitted of ['seriesUid','frameOfReferenceUid']) test(`omitting ${omitted} hides a prior mask instead of aliasing its same-SOP rollback lease`,async()=>{
    const f=setup();f.add();
    try{await f.layer.render(f.frame);const old=f.layer.lease.bitmap,current={...f.frame};delete current[omitted];f.viewport.frame=current;
        await assert.rejects(f.layer.render(current),/SOP, original frame or geometry/);assert.equal(f.layer.lease.bitmap,old);assert.equal(f.layer.canvas.hidden,true);assert.equal(f.layer.getState().visible,false);
        f.viewport.frame=f.frame;f.layer.resize();assert.equal(f.layer.canvas.hidden,false);assert.equal(f.layer.lease.bitmap,old);
    }finally{f.cleanup();}
});


test('crossing display aspect ratios zero an axis before allocation so every reshape stays inside its final admission',async()=>{
    const f=setup();f.add();
    try{f.image.width=100;f.image.height=4000;await f.layer.render(f.frame);f.layer.canvas.allocations=[];
        f.image.width=4000;f.image.height=100;f.layer.resize();assert.ok(f.layer.canvas.allocations.every(bytes=>bytes<=1600000));
        assert.deepEqual(f.layer.canvas.allocations,[0,0,1600000]);assert.ok(f.cache.getState().bytes<=f.cache.maxBytes);
    }finally{f.cleanup();}
});

test('new narrow or wide source bitmaps have a zero axis before setting their declared grid',async()=>{
    const f=setup();f.add();try{await f.layer.render(f.frame);const allocations=f.layer.lease.bitmap.allocations.slice(1);
        assert.deepEqual(allocations,[0,0,12]);assert.equal(f.layer.lease.bitmap.width,3);assert.equal(f.layer.lease.bitmap.height,1);
    }finally{f.cleanup();}
});


test('all-hidden masks clear immediately even when the display no longer fits its render budget',async()=>{
    const f=setup();f.add();try{await f.layer.render(f.frame);f.image.width=10000;f.image.height=10000;f.store.updateStyle('mask',{opacity:0});
        await f.layer.render(f.frame);assert.equal(f.layer.getState().visible,false);assert.equal(f.layer.getState().bytes,0);assert.equal(f.cache.getState().bytes,0);assert.equal(f.renders,1);
    }finally{f.cleanup();}
});

for(const action of ['hide','remove']) test(`partial ${action} hides an obsolete composite when a replacement cannot fit`,async()=>{
    const f=setup({maxBytes:19230});f.add();f.add('other',[1,1,0],[0,255,0]);
    try{await f.layer.render(f.frame);const old=f.layer.lease.bitmap;if(action==='hide')f.store.updateStyle('mask',{opacity:0});else f.store.remove('mask');
        await assert.rejects(f.layer.render(f.frame),/shared byte budget/);assert.equal(f.layer.lease.bitmap,old);assert.equal(f.layer.canvas.hidden,true);assert.equal(f.layer.getState().visible,false);
    }finally{f.cleanup();}
});

test('an earlier store observer can redraw immediately without racing the cache listener or returning an obsolete bitmap',async()=>{
    const frame=sourceFrame(),store=new OverlayStore(),pending=[];let layer;
    store.subscribe(()=>{if(layer)pending.push(layer.render(frame));});const cache=new OverlayRenderCache(store,{document});
    const image=new Canvas(document),viewport={frame,imageToScreen:(x,y)=>({x:x*40,y:y*40})};layer=new DerivedOverlayLayer(image,viewport,cache);
    try{store.add({id:'mask',image:createImageReference(frame),kind:'binary',values:[1,0,1],opacity:.5,color:[255,0,0]});await pending.pop();const old=layer.lease.bitmap;
        store.updateStyle('mask',{color:[0,0,255]});await pending.pop();assert.notEqual(layer.lease.bitmap,old);assert.deepEqual([...layer.lease.bitmap.data.slice(0,4)],[0,0,255,128]);assert.equal(layer.lease.revision,store.getRevision());assert.equal(layer.canvas.hidden,false);
    }finally{layer.dispose();cache.dispose();store.dispose();}
});

test('clearing a pending layer does not let an obsolete finally recreate its display reservation',async()=>{
    const f=setup();f.add();const pending=f.layer.render(f.frame);f.layer.clear();
    await assert.rejects(pending,{name:'AbortError'});assert.equal(f.cache.getState().displayCount,0);assert.equal(f.layer.canvas.hidden,true);
    await new Promise(resolve=>setTimeout(resolve,5));f.cleanup();
});


test('an obsolete aborted render cannot shrink a newer pending display reservation',async()=>{
    const f=setup();f.add();let finish;f.store.render=()=>new Promise(resolve=>{finish=resolve;});
    const old=f.layer.render(f.frame).then(()=>null,error=>error.name);f.image.width=240;f.image.height=80;const latest=f.layer.render(f.frame);
    assert.equal(await old,'AbortError');assert.equal(f.cache.getState().bytes,240*80*4+24);assert.equal(f.cache.displays.get(f.layer),240*80*4);
    finish({rows:1,columns:3,rgba:new Uint8ClampedArray([0,0,0,0,255,0,0,128,255,0,0,128]),alphaMode:'straight'});
    await latest;assert.equal(f.cache.getState().bytes,240*80*4+12);assert.equal(f.layer.canvas.hidden,false);f.cleanup();
});
