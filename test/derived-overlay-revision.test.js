import test from 'node:test';
import assert from 'node:assert/strict';
import { OverlayStore } from '../src/derived/OverlayStore.js';
import { createImageReference } from '../src/annotations/model.js';
import { sourceFrame } from './derived-fixtures.js';

test('overlay revision advances before every committed observer, remains unchanged on failure and invalidates once on disposal',()=>{
    const frame=sourceFrame(),store=new OverlayStore(),events=[];
    store.subscribe(payload=>events.push({revision:store.getRevision(),keys:Object.keys(payload).sort()}));
    assert.equal(store.getRevision(),0);store.add({id:'mask',image:createImageReference(frame),kind:'binary',values:[1,0,1],color:[255,0,0]});
    assert.equal(events[0].revision,1);assert.deepEqual(events[0].keys,['bytes','count']);
    assert.throws(()=>store.updateStyle('mask',{opacity:-1}));assert.equal(store.getRevision(),1);
    store.updateStyle('mask',{opacity:.25});assert.equal(events[1].revision,2);store.remove('mask');assert.equal(events[2].revision,3);
    store.dispose();assert.equal(store.getRevision(),4);store.dispose();assert.equal(store.getRevision(),4);assert.equal(events.length,3);
});
