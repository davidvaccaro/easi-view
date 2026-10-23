import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeNative } from '../src/data/native.js';
import { PHILIPS_PRIVATE_CT_SYNTAX,PHILIPS_PRIVATE_PIXEL_PROFILE,resolvePhilipsPrivateProfile,decodePhilipsRle1 } from '../src/data/philips-private.js';

function fixture(encoded,patch={}){
    const attrs={
        '00080016':['UI','1.2.840.10008.5.1.4.1.1.2'],'00080060':['CS','CT'],
        '07A10010':['LO','ELSCINT1'],'07A11011':['CS','PMSCT_RLE1'],'07A1100A':['OB',encoded],
        '00280004':['CS','MONOCHROME2'],'00280010':['US',2],'00280011':['US',2],
        '00280002':['US',1],'00280100':['US',16],'00280101':['US',12],'00280102':['US',11],'00280103':['US',0],...patch
    };
    const set={find(tag){const item=attrs[tag.ID];return item?{value:item[1],vr:{ID:item[0]},transferSyntax:{IsExplicit:true,IsLittleEndian:true},valueLength:item[1]?.byteLength??0,access:()=>item[1]}:null;}};
    const profile=resolvePhilipsPrivateProfile(set,{transferSyntax:PHILIPS_PRIVATE_CT_SYNTAX});
    return {set,profile,encoded};
}
const values=bytes=>Array.from({length:bytes.length/2},(_,index)=>new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength).getUint16(index*2,true));
function encodedAbsolute(samples){
    const expanded=samples.flatMap(value=>[0x5a,value&255,value>>>8]);
    const raw=expanded.flatMap(value=>value===0xa5?[0xa5,0,value]:[value]);
    if(raw.length%2)raw.push(0);return Uint8Array.from(raw);
}

test('verified profile preserves provenance and decode returns independent canonical little-endian words',()=>{
    // Absolute1000, +1, -2, +3 =>1000,1001,999,1002; six encoded bytes.
    const encoded=Uint8Array.of(0x5a,0xe8,0x03,1,0xfe,3);const f=fixture(encoded);
    const before=new Uint8Array(encoded),output=decodePhilipsRle1(encoded,f.profile);
    assert.deepEqual(values(output),[1000,1001,999,1002]);assert.deepEqual(encoded,before);assert.notEqual(output.buffer,encoded.buffer);
    assert.equal(f.profile.payloadTag,'07A1100A');assert.equal(f.profile.pixelDecodingProfile,PHILIPS_PRIVATE_PIXEL_PROFILE);
    assert.equal(f.profile.transferSyntax,PHILIPS_PRIVATE_CT_SYNTAX);assert.equal(Object.isFrozen(f.profile),true);
    output.fill(0);assert.deepEqual(encoded,before);
});

test('run escapes repeat expanded bytes across rows and absolute payload boundaries',()=>{
    const f=fixture(Uint8Array.of(0xa5,3,1,0));
    assert.deepEqual(values(decodePhilipsRle1(f.encoded,f.profile)),[1,2,3,4]);
    const absolute=fixture(Uint8Array.of(0x5a,0xa5,1,0,1,2,0,0));
    // RLE expands the two zero bytes making one absolute0, then deltas1/2/0 and one OB pad0.
    assert.deepEqual(values(decodePhilipsRle1(absolute.encoded,absolute.profile)),[0,1,3,3]);
});

test('uint16 predictor arithmetic wraps exactly and native decoding retains the declared twelve stored bits',()=>{
    const f=fixture(Uint8Array.of(0xff,1,0xff,1));const bytes=decodePhilipsRle1(f.encoded,f.profile);
    assert.deepEqual(values(bytes),[65535,0,65535,0]);
    const frame=decodeNative(bytes,{...f.profile,littleEndian:true,signed:false,photometric:'MONOCHROME2',slope:1,intercept:0});
    assert.deepEqual([...frame.samples],[4095,0,4095,0]);
});

test('all absolute uint16 byte combinations needed by escape markers round trip independently',()=>{
    const samples=[0,1,90,165,255,256,4095,65535,0xa55a,0x5aa5];const encoded=encodedAbsolute(samples);
    const f=fixture(encoded,{'00280010':['US',2],'00280011':['US',5]});
    assert.deepEqual(values(decodePhilipsRle1(encoded,f.profile)),samples);
});

test('only one null OB pad at an odd encoded boundary is accepted',()=>{
    const f=fixture(Uint8Array.of(0xa5,3,0,0));assert.deepEqual(values(decodePhilipsRle1(f.encoded,f.profile)),[0,0,0,0]);
    for(const encoded of [Uint8Array.of(0xa5,3,0,1),Uint8Array.of(1,1,1,1,0,0),Uint8Array.of(1,1,1,1,0xa5,0),Uint8Array.of(0xa5,4,0,0)]){
        const f=fixture(encoded);assert.throws(()=>decodePhilipsRle1(encoded,f.profile),/trailing bytes|run expands/);
    }
});

for(const [name,encoded]of[
    ['truncated run',Uint8Array.of(1,1,1,0xa5)],['missing run value',Uint8Array.of(1,1,0xa5,0)],
    ['truncated absolute',Uint8Array.of(1,1,1,0x5a)],['missing absolute high byte',Uint8Array.of(1,1,0x5a,0)],
    ['too few samples',Uint8Array.of(1,1)]
])test('malformed stream rejects '+name,()=>{const f=fixture(encoded);assert.throws(()=>decodePhilipsRle1(encoded,f.profile),/truncated/);});

test('every truncated prefix fails unless it is a complete alternative declared image',()=>{
    const encoded=encodedAbsolute([0x1234,0xa55a,0x5678,0x9abc]);
    for(let length=0;length<encoded.length;length++){
        const prefix=encoded.subarray(0,length);if(length%2||length<2){assert.throws(()=>fixture(prefix),/payload length/);continue;}
        const f=fixture(prefix);assert.throws(()=>decodePhilipsRle1(prefix,f.profile),/truncated/);
    }
});

for(const [name,patch]of[
    ['different creator',{'07A10010':['LO','OTHER']}],['creator wrong VR',{'07A10010':['CS','ELSCINT1']}],
    ['different compression',{'07A11011':['CS','PMSCT_RGB1']}],['compression wrong VR',{'07A11011':['LO','PMSCT_RLE1']}],
    ['wrong SOP',{'00080016':['UI','1.2.840.10008.5.1.4.1.1.4']}],['wrong modality',{'00080060':['CS','MR']}],
    ['color',{'00280004':['CS','RGB']}],['signed',{'00280103':['US',1]}],['wrong allocated',{'00280100':['US',8]}],
    ['wrong stored',{'00280101':['US',16]}],['wrong highbit',{'00280102':['US',15]}],['three samples',{'00280002':['US',3]}],
    ['multiframe',{'00280008':['IS',2]}],['unknown dimensions',{'00280010':['US',0]}],['oversized axis',{'00280011':['US',8193]}],
    ['multiple numeric values',{'00280010':['US',[2,3]]}],['unparseable numeric',{'00280010':['IS','2pixels']}],
    ['standard Pixel Data conflict',{'7FE00010':['OW',Uint8Array.of(0,0)]}]
])test('private profile rejects '+name,()=>assert.throws(()=>fixture(Uint8Array.of(1,1,1,1),patch),/Philips/));

test('recognition does not alias other transfer syntaxes or materialize/clear a private payload',()=>{
    const f=fixture(Uint8Array.of(1,1,1,1));
    assert.equal(resolvePhilipsPrivateProfile(f.set,{transferSyntax:'1.2.840.10008.1.2.1'}),null);
    f.set.find=((original)=>tag=>{const attr=original(tag);if(attr&&tag.ID==='07A1100A')attr.access=()=>{throw new Error('Metadata recognition must not access private pixels.');};return attr;})(f.set.find.bind(f.set));
    assert.equal(resolvePhilipsPrivateProfile(f.set,{transferSyntax:PHILIPS_PRIVATE_CT_SYNTAX,metadataOnly:true}).encodedLength,4);
});

test('decode rejects buffer aliases, tampered marker/length, allocation budgets and canceled work',()=>{
    const f=fixture(Uint8Array.of(1,1,1,1));
    assert.throws(()=>decodePhilipsRle1(new ArrayBuffer(4),f.profile),/encoded byte count/);
    assert.throws(()=>decodePhilipsRle1(f.encoded,{...f.profile,encodedLength:6}),/encoded byte count/);
    assert.throws(()=>decodePhilipsRle1(f.encoded,{...f.profile,pixelDecodingProfile:'other'}),/verified/);
    assert.throws(()=>decodePhilipsRle1(f.encoded,f.profile,{maxBytes:7}),/byte or dimension limit/);
    assert.throws(()=>decodePhilipsRle1(f.encoded,f.profile,{maxBytes:2**53}),/byte or dimension limit/);
    const controller=new AbortController();controller.abort();assert.throws(()=>decodePhilipsRle1(f.encoded,f.profile,{signal:controller.signal}),{name:'AbortError'});
    assert.throws(()=>decodePhilipsRle1(f.encoded,f.profile,{signal:17}),/AbortSignal/);
});


test('native scalar metadata validates encoded VM even if EASI exposes only its first word',()=>{
    for(const id of ['00280010','00280011','00280002','00280100','00280101','00280102','00280103']){
        const f=fixture(Uint8Array.of(1,1,1,1)),original=f.set.find.bind(f.set);
        f.set.find=tag=>{const attr=original(tag);if(tag.ID===id)return {...attr,valueLength:4,access:()=>Uint8Array.of(2,0,3,0)};return attr;};
        assert.throws(()=>resolvePhilipsPrivateProfile(f.set,{transferSyntax:PHILIPS_PRIVATE_CT_SYNTAX}),/verified/);
    }
});

test('private bulk URI metadata cannot masquerade as a complete original payload',()=>{
    const f=fixture(Uint8Array.of(1,1,1,1)),original=f.set.find.bind(f.set);
    f.set.find=tag=>tag.ID==='07A1100A'?{valueLength:0,vr:{ID:'OB'},transferSyntax:{IsExplicit:true,IsLittleEndian:true},value:null,access:()=>new Uint8Array()}:original(tag);
    assert.throws(()=>resolvePhilipsPrivateProfile(f.set,{transferSyntax:PHILIPS_PRIVATE_CT_SYNTAX,metadataOnly:true}),/complete original instance/);
});


test('private UID never authorizes an implicit-VR or big-endian encoded dataset',()=>{
    for(const syntax of [{IsExplicit:false,IsLittleEndian:true},{IsExplicit:true,IsLittleEndian:false},{}]){
        const f=fixture(Uint8Array.of(1,1,1,1)),original=f.set.find.bind(f.set);
        f.set.find=tag=>{const attribute=original(tag);return attribute?{...attribute,transferSyntax:syntax}:null;};
        assert.throws(()=>resolvePhilipsPrivateProfile(f.set,{transferSyntax:PHILIPS_PRIVATE_CT_SYNTAX}),/Explicit VR Little Endian dataset/);
    }
});


test('an explicitly incomplete private body never receives a verified profile',()=>{
    const f=fixture(Uint8Array.of(1,1,1,1)),original=f.set.find.bind(f.set);
    f.set.find=tag=>{const attr=original(tag);return tag.ID==='07A1100A'?{...attr,isComplete:false}:attr;};
    assert.throws(()=>resolvePhilipsPrivateProfile(f.set,{transferSyntax:PHILIPS_PRIVATE_CT_SYNTAX,metadataOnly:true}),/payload is incomplete/);
});
