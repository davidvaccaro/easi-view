import test from 'node:test';
import assert from 'node:assert/strict';
import { EasiStoreDimseTransport, STORE_ORIGINAL_SYNTAXES } from '../tools/easi-store-dimse-transport.mjs';
import { createDicomFixture } from '../src/data/synthetic.js';

const association = {host:'127.0.0.1',port:4248,callingAeTitle:'EASI_VIEW',calledAeTitle:'EASISTORE'};
const study='2.25.9911',series='2.25.9912',sop='2.25.9913',ct='1.2.840.10008.5.1.4.1.1.2';
const selection = {operation:'c-get',performFind:false,queryRetrieveModel:'study-root',queryRetrieveLevel:'SERIES',keys:{'0020000D':study,'0020000E':series}};
function fixture({studyUid=study,sopClass=ct,sopUid=sop,...options}={}) {
    return createDicomFixture({sopClass,sopUid,seriesUid:series,extraAttributes:{'0020000D':['UI',studyUid]},...options});
}
function envelope(bytes=fixture()) {return {source:bytes,contentType:'application/dicom',contentLength:bytes.length,metadata:{count:1,dimse:{finalResponse:{status:0}}}};}
function mock(payload=envelope()) {
    return new class extends EasiStoreDimseTransport {
        calls=[];
        async readPeer(peer,options){this.calls.push({peer,options});return options.operation==='c-find'?payload:{retrieved:true};}
    }();
}

test('Store adapter discovers exact class scope and proposes every original encoding separately',async()=>{
    const transport=mock();assert.deepEqual(await transport.read(association,selection),{retrieved:true});
    assert.equal(transport.calls.length,2);const [discovery,retrieve]=transport.calls;
    assert.equal(discovery.options.operation,'c-find');assert.equal(discovery.options.queryRetrieveLevel,'IMAGE');
    assert.deepEqual(discovery.options.keys,selection.keys);assert.deepEqual(discovery.options.returnKeys,['0020000D','0020000E','00080018','00080016']);
    assert.equal(discovery.options.maxTotalDataSetBytes,8*1024*1024);
    assert.deepEqual(retrieve.options.storageSopClassUids,[ct]);assert.deepEqual(retrieve.options.storageTransferSyntaxUids,[...STORE_ORIGINAL_SYNTAXES]);
    const options=transport.resolveQueryOptions(association,retrieve.options),model=transport.resolveQueryModel(options),rq=transport.buildAssociateRq(association,model,options);
    const storage=rq.contexts.filter(context=>context.kind==='store');assert.equal(storage.length,STORE_ORIGINAL_SYNTAXES.length);
    assert.deepEqual(storage.map(context=>context.transferSyntaxUids[0]),[...STORE_ORIGINAL_SYNTAXES]);assert.ok(storage.every(context=>context.transferSyntaxUids.length===1));
    assert.equal(new Set(rq.contexts.map(context=>context.id)).size,rq.contexts.length);assert.ok(rq.contexts.every(context=>context.id%2===1&&context.id<=255));
    assert.equal(Buffer.from(rq.pdu).readUInt32BE(2),rq.pdu.length-6);
});

test('native fallback remains explicit and ordinary FIND does not perform discovery',async()=>{
    const transport=mock();await transport.read(association,{...selection,storageTransferSyntaxUids:['1.2.840.10008.1.2.1']});
    assert.deepEqual(transport.calls[1].options.storageTransferSyntaxUids,['1.2.840.10008.1.2.1']);
    const find=mock();await find.read(association,{operation:'c-find',keys:{PatientID:'SYNTHETIC'}});assert.equal(find.calls.length,1);
});

test('discovery refuses wrong hierarchy, missing class identifiers and aborted requests',async()=>{
    const wrong=mock(envelope(fixture({studyUid:'2.25.9999'})));await assert.rejects(wrong.read(association,selection),/outside the requested hierarchy/);assert.equal(wrong.calls.length,1);
    const missing=mock(envelope(fixture({extraAttributes:{'0020000D':['UI',study],'00080016':null}})));await assert.rejects(missing.read(association,selection),/required UID/);assert.equal(missing.calls.length,1);
    const controller=new AbortController();controller.abort();const cancelled=mock();await assert.rejects(cancelled.read(association,{...selection,signal:controller.signal}),{name:'AbortError'});assert.equal(cancelled.calls.length,0);
});

test('adapter refuses associations beyond the protocol context limit rather than dropping codecs',()=>{
    const transport=mock(),classes=Array.from({length:11},(_,index)=>`1.2.840.10008.5.1.4.1.1.${index+1}`);
    const options=transport.resolveQueryOptions(association,{...selection,storageSopClassUids:classes,storageTransferSyntaxUids:[...STORE_ORIGINAL_SYNTAXES]});
    assert.throws(()=>transport.buildAssociateRq(association,transport.resolveQueryModel(options),options),/context limit/);
});
