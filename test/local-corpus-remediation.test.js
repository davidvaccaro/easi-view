import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, open, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { compareCorpusReports, renderRemediationHtml, renderRemediationCsv, parseArguments, writeRemediationSummary } from '../tools/local-corpus-remediation.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const fingerprint = records => hash(records.map(x => JSON.stringify([x.file.relativePath,x.file.bytes,x.file.sha256])+'\n').join(''));
const counts = records => records.reduce((sum,x)=>{sum[x.status]++;return sum;},{passed:0,failed:0,unsupported:0,invalid:0});
function record(index,status='passed',patch={}) {
    return {file:{relativePath:'synthetic-'+index+'.dcm',bytes:132+index,sha256:hash('synthetic-'+index)},status,
        reason:status==='passed'?null:status==='invalid'?'Invalid generated data.':'Unsupported undefined-length UN sequence value.',sourceUnchanged:true,
        allFramesRequested:true,framesChecked:status==='passed'?4:0,frameCount:4,parsing:{passed:status==='passed'},
        profile:{sopClass:'1.2.840.10008.5.1.4.1.1.2',transferSyntax:'1.2.840.10008.1.2.1'},...patch};
}
function report(records,{directory='/private/tmp/generated-corpus',baseline=true,selected=records.length,discovered=records.length,complete=true,all=true}={}) {
    return {schemaVersion:1,directory,sourceDigest:hash(baseline?'baseline':'candidate'),viewerVersion:'0.1.0-alpha.0',easiJsVersion:baseline?'1.0.0':'1.0.1-corpus.0',
        completedAt:complete?'2026-10-15T12:00:00Z':null,interrupted:!complete,
        ...(baseline?{inputFingerprint:fingerprint(records)}:{selectionFingerprint:fingerprint(records)}),
        reportedFiles:records.length,coverage:{discoveredFiles:discovered,selectedFiles:selected,completeDirectory:baseline,frameMode:all?'all':'first-middle-last',perFileTimeoutMs:120000},
        summary:counts(records),results:records};
}
const baselineRecords=()=>[record(0),record(1),record(2,'unsupported'),record(3,'invalid'),record(4,'unsupported')];
const baseline=()=>report(baselineRecords());

test('baseline-only summary keeps every unresolved status and makes no current-pass claim',()=>{
    const result=compareCorpusReports(baseline());
    assert.equal(result.reviewStatus,'baseline-only');assert.equal(result.totals.candidateCovered,0);assert.equal(result.totals.retainedPasses,0);
    assert.equal(result.totals.unretested,5);assert.equal(result.totals.baselinePassesUnretested,2);assert.equal(result.totals.baselineNonpassesUnretested,3);
    assert.equal(result.groups.baselineNonpasses.find(x=>x.status==='invalid').count,1);
    assert.match(result.groups.baselineNonpasses.find(x=>x.status==='unsupported').review,/Actionable parser gap/);
    assert.match(renderRemediationHtml(result),/have not been reverified/);
});

test('explicit subset distinguishes new passes, reverified passes, unresolved and unretested cases',()=>{
    const old=baseline(),next=report([record(0),record(2),record(3,'invalid')],{baseline:false});
    const result=compareCorpusReports(old,next);
    assert.deepEqual(result.totals,{baselineFiles:5,candidateCovered:3,newlyPassed:1,retainedPasses:1,regressions:0,unresolvedRetested:1,unretested:2,baselinePassesUnretested:1,baselineNonpassesUnretested:1});
    assert.equal(result.reviewStatus,'incomplete');assert.equal(result.candidateScope.files,'subset');assert.equal(result.candidate.easiJsVersion,'1.0.1-corpus.0');
    assert.equal(result.rows[3].candidateStatus,'invalid');assert.equal(result.rows[4].candidateStatus,'not-retested');
});

test('partial candidate results remain explicitly incomplete and do not invent missing outcomes',()=>{
    const result=compareCorpusReports(baseline(),report([record(2)],{baseline:false,selected:3,discovered:5,complete:false}));
    assert.equal(result.totals.candidateCovered,1);assert.equal(result.candidateScope.completed,false);assert.equal(result.totals.unretested,4);
    const html=renderRemediationHtml(result);
    assert.match(html,/partial or absent report/);
    assert.match(html,/1 file with a reported attempt · 1 successful viewing session · 0 could not complete/);
    assert.match(html,/2 selected files pending without a reported outcome/);
});

test('remediation headline includes all unresolved outcomes without changing JSON or CSV statuses',()=>{
    const records=[...Array.from({length:3},(_,index)=>record(index)),
        ...Array.from({length:97},(_,index)=>record(index+3,'unsupported')),
        ...Array.from({length:8},(_,index)=>record(index+100,'invalid'))];
    const old=report(records),next=report(records,{baseline:false});next.coverage.completeDirectory=true;
    const result=compareCorpusReports(old,next),before=JSON.stringify(result),html=renderRemediationHtml(result),csv=renderRemediationCsv(result);
    assert.match(html,/108 files with reported attempts · 3 successful viewing sessions · 105 could not complete/);
    assert.match(html,/Unexpected error \(failed\): 0/);
    assert.match(html,/Rejected by current validation \(invalid\): 8/);
    assert.match(html,/input validity requires independent review/);
    assert.equal(result.reviewStatus,'unresolved');assert.deepEqual(result.candidate.summary,{passed:3,failed:0,unsupported:97,invalid:8});
    assert.match(csv,/"invalid"/);assert.doesNotMatch(csv,/Rejected by current validation/);
    assert.equal(JSON.stringify(result),before);
});

test('sampled passes preserve checked-frame counts and cannot become a full all-frame qualification',()=>{
    const records=baselineRecords().map((old,index)=>record(index,'passed',{framesChecked:3,frameCount:8,allFramesRequested:false}));
    const next=report(records,{baseline:false,all:false});next.coverage.completeDirectory=true;
    const result=compareCorpusReports(baseline(),next);
    assert.equal(result.candidateScope.files,'full');assert.equal(result.candidateScope.frames,'first-middle-last');
    assert.equal(result.candidate.framesChecked,15);assert.equal(result.reviewStatus,'incomplete');
    assert.equal(result.totals.newlyPassed,3);assert.equal(result.totals.retainedPasses,2);
});

test('full completed all-frame candidate alone may report every file passed',()=>{
    const next=report(baselineRecords().map((old,index)=>record(index)),{baseline:false});next.coverage.completeDirectory=true;
    const result=compareCorpusReports(baseline(),next);
    assert.equal(result.reviewStatus,'reported-all-passed');assert.equal(result.totals.unretested,0);assert.equal(result.candidate.framesChecked,20);
});

test('regression to unsupported is a regression and invalid labels are never silently promoted',()=>{
    const next=report([record(0,'unsupported'),record(3,'unsupported')],{baseline:false});
    const result=compareCorpusReports(baseline(),next);
    assert.equal(result.totals.regressions,1);assert.equal(result.totals.unresolvedRetested,1);assert.equal(result.reviewStatus,'regressions');
    assert.match(renderRemediationHtml(result),/Regressions need attention/);assert.equal(result.rows[3].baselineStatus,'invalid');
});

for(const [name,change,pattern]of[
    ['unknown candidate file',x=>{x.results[0].file.relativePath='not-in-baseline.dcm';},/outside/],
    ['hash drift',x=>{x.results[0].file.sha256=hash('changed');},/drifted/],
    ['byte-size drift',x=>{x.results[0].file.bytes++;},/drifted/],
    ['different corpus directory',x=>{x.directory='/private/tmp/other-corpus';},/different corpus/],
    ['different corpus fingerprint',x=>{x.inputFingerprint=hash('different');},/different corpus/],
    ['missing status',x=>{delete x.results[0].status;},/status/],
    ['changed source flag',x=>{x.results[0].sourceUnchanged=false;},/unchanged source/],
    ['all-frame count mismatch',x=>{x.results[0].framesChecked=2;},/Frame evidence/]
])test('candidate rejects '+name,()=>{
    const next=report([record(0)],{baseline:false});change(next);next.selectionFingerprint=fingerprint(next.results);
    assert.throws(()=>compareCorpusReports(baseline(),next),pattern);
});

test('duplicates, malformed identities, missing completed results and misleading full-scope claims reject',()=>{
    const next=report([record(0),record(0)],{baseline:false});assert.throws(()=>compareCorpusReports(baseline(),next),/Duplicate/);
    for(const relativePath of ['../outside.dcm','/absolute.dcm','C:/absolute.dcm','bad\\path.dcm']){
        const next=report([record(0,'passed',{file:{...record(0).file,relativePath}})],{baseline:false});
        assert.throws(()=>compareCorpusReports(baseline(),next),/identity/);
    }
    assert.throws(()=>compareCorpusReports(baseline(),report([record(0)],{baseline:false,selected:2,discovered:5})),/missing results/);
    const misleading=report([record(0)],{baseline:false});misleading.coverage.completeDirectory=true;
    assert.throws(()=>compareCorpusReports(baseline(),misleading),/claims full coverage/);
});

test('baseline must have complete coverage and a self-consistent immutable identity',()=>{
    for(const patch of [{completedAt:null},{inputFingerprint:hash('wrong')},{summary:{passed:5,failed:0,unsupported:0,invalid:0}}])assert.throws(()=>compareCorpusReports({...baseline(),...patch}),/Baseline|fingerprint|summary/);
    const partial=baseline();partial.coverage.completeDirectory=false;assert.throws(()=>compareCorpusReports(partial),/Baseline/);
});

test('HTML is escaped, CSV formulas are neutralized, and arbitrary metadata and pixels are omitted',()=>{
    const hostile=record(0,'unsupported',{file:{...record(0).file,relativePath:'=FORMULA<img src=x>.dcm'},reason:'=FORMULA<script>bad()</script>',
        profile:{...record(0).profile,PatientName:'SECRET_PATIENT',PixelData:'SECRET_PIXELS'}});
    const old=report([hostile]);const result=compareCorpusReports(old),html=renderRemediationHtml(result),csv=renderRemediationCsv(result);
    assert.doesNotMatch(html,/<script>|<img/);assert.match(html,/&lt;script&gt;/);assert.match(csv,/"'=FORMULA/);
    for(const output of [html,csv,JSON.stringify(result)])assert.doesNotMatch(output,/SECRET_PATIENT|SECRET_PIXELS/);
    assert.doesNotMatch(html,/<script|<img|https?:\/\//);
});

test('argument parsing requires baseline and preserves explicit output/candidate selection',()=>{
    assert.throws(()=>parseArguments([]),/baseline/);assert.throws(()=>parseArguments(['--baseline','x','--unknown','y']),/Use/);
    const value=parseArguments(['--baseline','base','--candidate','next','--output','out'],'/private/tmp');
    assert.equal(value.baseline,'/private/tmp/base');assert.equal(value.candidate,'/private/tmp/next');assert.equal(value.output,'/private/tmp/out');
});

async function files(t){const temporary=await mkdtemp(resolve(tmpdir(),'easi-remediation-generated-'));t.after(()=>rm(temporary,{recursive:true,force:true}));
    const data=resolve(temporary,'data'),reports=resolve(temporary,'reports'),output=resolve(temporary,'summary');await mkdir(data);await mkdir(reports);
    const base=baseline();base.directory=data;const path=resolve(reports,'baseline.json');await writeFile(path,JSON.stringify(base));return {temporary,data,reports,output,path,base};}

test('atomic report writing preserves inputs and limits JSON output to operational summary fields',async t=>{
    const env=await files(t),before=await readFile(env.path);const result=await writeRemediationSummary({baseline:env.path,output:env.output});
    assert.equal(result.summary.totals.unretested,5);assert.deepEqual(await readFile(env.path),before);
    const json=JSON.parse(await readFile(resolve(env.output,'summary.json')));assert.equal(json.reportSha256.baseline,hash(before));assert.equal(json.rows,undefined);
    assert.equal((await readdir(env.output)).sort().join(','),'delta.csv,summary.html,summary.json');
    const previous=await readFile(resolve(env.output,'summary.json'));const invalid=resolve(env.reports,'bad.json');await writeFile(invalid,'{}');
    await assert.rejects(writeRemediationSummary({baseline:env.path,candidate:invalid,output:env.output}),/schema/);
    assert.deepEqual(await readFile(resolve(env.output,'summary.json')),previous);
});

test('output inside the original data or through an alias rejects before writing',async t=>{
    const env=await files(t);await assert.rejects(writeRemediationSummary({baseline:env.path,output:resolve(env.data,'new')}),/outside/);
    const alias=resolve(env.temporary,'alias');await symlink(env.data,alias);await assert.rejects(writeRemediationSummary({baseline:env.path,output:alias}),/outside/);
    assert.deepEqual(await readdir(env.data),[]);
});

test('input overwrite, oversized JSON and concurrent output lock reject',async t=>{
    const env=await files(t);const input=resolve(env.reports,'summary.json');await writeFile(input,JSON.stringify(env.base));
    await assert.rejects(writeRemediationSummary({baseline:input,output:env.reports}),/overwrite/);
    const huge=resolve(env.reports,'huge.json'),handle=await open(huge,'w');await handle.truncate(256*1024*1024+1);await handle.close();
    await assert.rejects(writeRemediationSummary({baseline:huge,output:env.output}),/256MiB/);
    await mkdir(env.output);await writeFile(resolve(env.output,'.remediation.lock'),'owned');
    await assert.rejects(writeRemediationSummary({baseline:env.path,output:env.output}),error=>error.code==='EEXIST');
    assert.equal(await readFile(resolve(env.output,'.remediation.lock'),'utf8'),'owned');
});
