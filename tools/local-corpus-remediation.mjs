import { createHash } from 'node:crypto';
import { readFile, writeFile, lstat, realpath, mkdir, mkdtemp, rename, rm, open } from 'node:fs/promises';
import { resolve, dirname, basename, isAbsolute, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { corpusStatusLabel, renderCorpusOutcomeSummary } from './local-corpus.mjs';

const root = resolve(import.meta.dirname, '..');
const MAX_BYTES = 256 * 1024 * 1024;
const STATUSES = ['passed', 'failed', 'unsupported', 'invalid'];
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const count = value => Number.isSafeInteger(value) && value >= 0;
const sha = value => createHash('sha256').update(value).digest('hex');
const emptyCounts = () => Object.fromEntries(STATUSES.map(value => [value, 0]));
const fingerprint = files => sha(files.map(file => JSON.stringify([file.relativePath, file.bytes, file.sha256]) + '\n').join(''));
const text = value => typeof value === 'string' ? value : '';
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sameCounts = (a, b) => a && Object.keys(a).length === STATUSES.length && STATUSES.every(key => a[key] === b[key]);
const within = (path, directory) => path === directory || path.startsWith(directory + sep);

function checkedFile(file) {
    const name = file?.relativePath;
    if (typeof name !== 'string' || !name || name.length > 4096 || isAbsolute(name) || name.includes('\\') || /^[A-Za-z]:/.test(name) || name.includes('\0')
        || name.split('/').some(part => !part || part === '.' || part === '..') || !count(file.bytes) || !hex(file.sha256)) {
        throw new Error('Invalid corpus file identity.');
    }
    return { relativePath: name, bytes: file.bytes, sha256: file.sha256 };
}

function validateReport(report, baseline) {
    if (report?.schemaVersion !== 1 || !Array.isArray(report.results) || report.results.length > 100000
        || typeof report.directory !== 'string' || !isAbsolute(report.directory) || !hex(report.sourceDigest)
        || !['viewerVersion', 'easiJsVersion'].every(key => typeof report[key] === 'string' && report[key].length <= 128)
        || !report.coverage || !count(report.coverage.discoveredFiles) || !count(report.coverage.selectedFiles)
        || report.coverage.selectedFiles > report.coverage.discoveredFiles || report.results.length > report.coverage.selectedFiles
        || typeof report.coverage.completeDirectory !== 'boolean'
        || !['all', 'first-middle-last'].includes(report.coverage.frameMode)
        || !count(report.coverage.perFileTimeoutMs) || report.coverage.perFileTimeoutMs < 1
        || report.completedAt != null && (typeof report.completedAt !== 'string' || !Number.isFinite(Date.parse(report.completedAt)))) {
        throw new Error('Invalid corpus report schema or coverage.');
    }
    for (const key of ['inputFingerprint', 'selectionFingerprint']) if (report[key] !== undefined && !hex(report[key])) throw new Error('Invalid corpus fingerprint.');
    if (!report.inputFingerprint && !report.selectionFingerprint) throw new Error('Missing corpus fingerprint.');
    const complete = Boolean(report.completedAt) && report.interrupted !== true && !report.harnessError;
    if (report.completedAt && !complete) throw new Error('A completed report cannot also be interrupted or have a harness error.');
    if (complete && report.results.length !== report.coverage.selectedFiles) throw new Error('Completed report has missing results.');
    if (report.reportedFiles !== undefined && report.reportedFiles !== report.results.length) throw new Error('Reported file count disagrees with its results.');
    const counts = emptyCounts(), seen = new Set(), results = [];
    for (const result of report.results) {
        const file = checkedFile(result.file);
        if (seen.has(file.relativePath)) throw new Error('Duplicate corpus file identity.');
        seen.add(file.relativePath);
        if (!STATUSES.includes(result.status) || result.status !== 'passed' && (typeof result.reason !== 'string' || !result.reason || result.reason.length > 4096)
            || result.reason != null && typeof result.reason !== 'string') throw new Error('Missing or invalid corpus status or reason.');
        if (result.sourceUnchanged !== true) throw new Error('Report does not confirm unchanged source bytes.');
        const frames = result.framesChecked ?? 0;
        if (!count(frames) || result.frameCount !== undefined && !count(result.frameCount)
            || result.status === 'passed' && (frames < 1 || result.frameCount === undefined || frames > result.frameCount
                || report.coverage.frameMode === 'all' && frames !== result.frameCount)
            || result.allFramesRequested !== undefined && result.allFramesRequested !== (report.coverage.frameMode === 'all')) {
            throw new Error('Frame evidence disagrees with the declared frame scope.');
        }
        const uid = value => typeof value === 'string' && value.length <= 64 && /^[0-9]+(?:\.[0-9]+)+$/.test(value) ? value : 'unavailable';
        results.push({ file, status: result.status, reason: result.reason || '', framesChecked: frames,
            frameCount: result.frameCount ?? null, parsed: result.parsing?.passed === true,
            sopClass: uid(result.profile?.sopClass), transferSyntax: uid(result.profile?.transferSyntax) });
        counts[result.status]++;
    }
    if (!sameCounts(report.summary, counts)) throw new Error('Report summary disagrees with its results.');
    if (complete && report.selectionFingerprint && fingerprint(results.map(value => value.file)) !== report.selectionFingerprint) throw new Error('Selection fingerprint disagrees with its results.');
    if (baseline && (!complete || !report.coverage.completeDirectory || report.coverage.selectedFiles !== report.coverage.discoveredFiles
        || report.results.length !== report.coverage.discoveredFiles || !hex(report.inputFingerprint)
        || fingerprint(results.map(value => value.file)) !== report.inputFingerprint)) throw new Error('Baseline must be a completed full campaign with a matching input fingerprint.');
    return { report, results, counts, complete };
}

function groupNonpasses(results) {
    const groups = new Map();
    for (const result of results.filter(value => value.status !== 'passed')) {
        const key = JSON.stringify([result.status, result.reason, result.sopClass, result.transferSyntax]);
        const group = groups.get(key) || { status: result.status, reason: result.reason, sopClass: result.sopClass,
            transferSyntax: result.transferSyntax, count: 0, parsed: 0, framesChecked: 0,
            review: result.reason === 'Unsupported undefined-length UN sequence value.' ? 'Actionable parser gap'
                : result.status === 'invalid' ? 'Input validity requires independent review' : 'Declared limitation remains unresolved' };
        group.count++; group.parsed += result.parsed ? 1 : 0; group.framesChecked += result.framesChecked;
        groups.set(key, group);
    }
    return [...groups.values()].sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason) || a.sopClass.localeCompare(b.sopClass));
}

/** Compare reported outcomes only; baseline passes are never current re-verifications. */
export function compareCorpusReports(baseline, candidate = null) {
    const previous = validateReport(baseline, true), current = candidate ? validateReport(candidate, false) : null;
    if (current && (resolve(candidate.directory) !== resolve(baseline.directory)
        || candidate.inputFingerprint && candidate.inputFingerprint !== baseline.inputFingerprint)) throw new Error('Candidate belongs to a different corpus.');
    const known = new Map(previous.results.map(result => [result.file.relativePath, result]));
    const actual = new Map();
    for (const result of current?.results || []) {
        const old = known.get(result.file.relativePath);
        if (!old) throw new Error('Candidate contains a file outside the baseline corpus.');
        if (old.file.bytes !== result.file.bytes || old.file.sha256 !== result.file.sha256) throw new Error('Candidate source bytes or hash drifted from the baseline.');
        actual.set(result.file.relativePath, result);
    }
    if (current && candidate.coverage.completeDirectory && (candidate.coverage.discoveredFiles !== previous.results.length
        || candidate.coverage.selectedFiles !== previous.results.length)) throw new Error('Candidate claims full coverage for a different corpus size.');
    const totals = { baselineFiles: previous.results.length, candidateCovered: actual.size, newlyPassed: 0, retainedPasses: 0,
        regressions: 0, unresolvedRetested: 0, unretested: 0, baselinePassesUnretested: 0, baselineNonpassesUnretested: 0 };
    const rows = previous.results.map(old => {
        const next = actual.get(old.file.relativePath);
        const delta = !next ? 'unretested' : old.status === 'passed' ? next.status === 'passed' ? 'retained-pass' : 'regression'
            : next.status === 'passed' ? 'newly-passed' : 'unresolved';
        const key = { 'retained-pass': 'retainedPasses', regression: 'regressions', 'newly-passed': 'newlyPassed', unresolved: 'unresolvedRetested', unretested: 'unretested' }[delta];
        totals[key]++;
        if (!next) totals[old.status === 'passed' ? 'baselinePassesUnretested' : 'baselineNonpassesUnretested']++;
        return { ...old.file, delta, baselineStatus: old.status, candidateStatus: next?.status || 'not-retested', baselineReason: old.reason,
            candidateReason: next?.reason || '', baselineFramesChecked: old.framesChecked, candidateFramesChecked: next?.framesChecked ?? null };
    });
    const metadata = item => item ? { sourceDigest: item.report.sourceDigest, viewerVersion: item.report.viewerVersion,
        easiJsVersion: item.report.easiJsVersion, completedAt: item.report.completedAt ?? null, complete: item.complete,
        frameMode: item.report.coverage.frameMode, selectedFiles: item.report.coverage.selectedFiles,
        reportedFiles: item.results.length, summary: item.counts,
        framesChecked: item.results.reduce((sum, result) => sum + result.framesChecked, 0) } : null;
    const fullCandidate = Boolean(current?.complete && candidate.coverage.completeDirectory && actual.size === previous.results.length);
    const reviewStatus = totals.regressions ? 'regressions' : !current ? 'baseline-only' : !fullCandidate || candidate.coverage.frameMode !== 'all'
        ? 'incomplete' : current.counts.passed !== previous.results.length ? 'unresolved' : 'reported-all-passed';
    return { schemaVersion: 1, scope: 'Report comparison only. Unsupported and invalid are reported outcomes, not source-conformance proof or waived work.',
        inputFingerprint: baseline.inputFingerprint, baseline: metadata(previous), candidate: metadata(current), totals,
        candidateScope: { files: !current ? 'not-provided' : fullCandidate ? 'full' : 'subset', completed: current?.complete ?? false,
            frames: current?.report.coverage.frameMode ?? 'not-provided' }, reviewStatus,
        groups: { baselineNonpasses: groupNonpasses(previous.results), candidateNonpasses: groupNonpasses(current?.results || []) }, rows };
}

export function renderRemediationHtml(summary) {
    const t = summary.totals;
    const badge = summary.reviewStatus === 'regressions' ? 'Regressions need attention' : summary.reviewStatus === 'reported-all-passed'
        ? 'Candidate reports every file passed' : 'Hardening remains open';
    const versions = (title, value) => '<tr><th>' + title + '</th><td>' + (value ? escape(value.viewerVersion) + ' · EASI JS ' + escape(value.easiJsVersion)
        + '<br><code>' + escape(value.sourceDigest) + '</code><br>' + escape(value.frameMode) + ' frames · ' + value.reportedFiles + ' reported of ' + value.selectedFiles + ' selected files' : 'Not supplied') + '</td></tr>';
    const groups = (title, values) => '<h2>' + title + '</h2><table><thead><tr><th>Cases</th><th>Reported status / reason</th><th>SOP class / transfer syntax</th><th>Review</th></tr></thead><tbody>'
        + values.map(group => '<tr><td>' + group.count + '</td><td>' + escape(corpusStatusLabel(group.status)) + '<br>' + escape(group.reason) + '</td><td><code>' + escape(group.sopClass) + '<br>'
            + escape(group.transferSyntax) + '</code></td><td>' + escape(group.review) + '</td></tr>').join('') + '</tbody></table>';
    return '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; img-src \'none\'; connect-src \'none\'; base-uri \'none\'; form-action \'none\'"><title>DICOM corpus hardening</title>'
        + '<style>body{font:16px/1.5 system-ui,sans-serif;color:#17342e;background:#f4f7f5;max-width:1120px;margin:32px auto;padding:0 20px}table{width:100%;border-collapse:collapse;background:white;margin:16px 0}th,td{text-align:left;padding:12px;vertical-align:top;border-bottom:1px solid #dce5e0}code{font-size:12px;overflow-wrap:anywhere}.notice{padding:16px;background:'
        + (summary.reviewStatus === 'regressions' ? '#ffe1db' : summary.reviewStatus === 'reported-all-passed' ? '#d9f1e4' : '#fff0cf') + '}h1{margin-bottom:8px}@media(max-width:640px){table{font-size:13px}th,td{padding:8px}}</style>'
        + '<h1>DICOM corpus hardening</h1><p class="notice"><strong>' + badge + '</strong></p><p>' + escape(summary.scope) + '</p>'
        + '<h2>Candidate viewing outcomes</h2>' + (summary.candidate ? renderCorpusOutcomeSummary({ ...summary.candidate, coverage: { selectedFiles: summary.candidate.selectedFiles } }) : '<p>No candidate attempts have been reported.</p>')
        + '<p>Candidate scope: <strong>' + escape(summary.candidateScope.files) + '</strong>; ' + (summary.candidateScope.completed ? 'completed report' : 'partial or absent report') + '; <strong>' + escape(summary.candidateScope.frames) + '</strong> frames. Baseline passes outside candidate coverage have not been reverified.</p>'
        + '<table><tbody>' + versions('Baseline', summary.baseline) + versions('Candidate', summary.candidate) + '</tbody></table>'
        + '<h2>Baseline viewing outcomes (historical)</h2>' + renderCorpusOutcomeSummary({ ...summary.baseline, coverage: { selectedFiles: summary.baseline.selectedFiles } })
        + '<h2>Reported statuses</h2><table><thead><tr><th>Status</th><th>Baseline</th><th>Candidate checked files</th></tr></thead><tbody>'
        + STATUSES.map(status => '<tr><th>' + escape(corpusStatusLabel(status)) + '</th><td>' + summary.baseline.summary[status] + '</td><td>' + (summary.candidate ? summary.candidate.summary[status] : 'Not retested') + '</td></tr>').join('') + '</tbody></table>'
        + '<h2>Compared outcomes</h2><table><tbody>' + [['Baseline files',t.baselineFiles],['Candidate files checked',t.candidateCovered],['Newly reported passed',t.newlyPassed],['Reverified retained passes',t.retainedPasses],['Regressions',t.regressions],['Retested, still unresolved',t.unresolvedRetested],['Not retested',t.unretested],['Not retested: former passes',t.baselinePassesUnretested],['Not retested: former nonpasses',t.baselineNonpassesUnretested]]
            .map(([label,value])=>'<tr><th>'+label+'</th><td>'+value+'</td></tr>').join('') + '</tbody></table>'
        + groups('Baseline non-passing groups (historical)',summary.groups.baselineNonpasses) + groups('Candidate unresolved groups',summary.groups.candidateNonpasses)
        + '<p>Per-file identities and transitions are in delta.csv. The source images remain local.</p></html>\n';
}

export function renderRemediationCsv(summary) {
    const fields = ['relativePath','bytes','sha256','delta','baselineStatus','candidateStatus','baselineReason','candidateReason','baselineFramesChecked','candidateFramesChecked'];
    const cell = value => { let string = String(value ?? ''); if (/^[\s]*[=+\-@]/.test(string) || /^[\t\r]/.test(string)) string = "'" + string; return '"' + string.replaceAll('"','""') + '"'; };
    return fields.map(cell).join(',') + '\r\n' + summary.rows.map(row => fields.map(key => cell(row[key])).join(',')).join('\r\n') + '\r\n';
}

export function parseArguments(argv, cwd = process.cwd()) {
    const options = { baseline: null, candidate: null, output: resolve(root,'artifacts/local-corpus/hardening-summary') };
    for (let index=0;index<argv.length;index++) {
        const key = { '--baseline':'baseline','--candidate':'candidate','--output':'output' }[argv[index]];
        if (!key || !argv[index+1] || argv[index+1].startsWith('--')) throw new Error('Use --baseline PATH, optional --candidate PATH and --output DIR.');
        options[key]=resolve(cwd,argv[++index]);
    }
    if (!options.baseline) throw new Error('A completed baseline campaign is required.');
    return options;
}

async function load(path) {
    let target=resolve(path),info=await lstat(target);
    if (info.isDirectory()) { target=resolve(target,'results.json');info=await lstat(target); }
    if (!info.isFile() || info.isSymbolicLink() || info.size>MAX_BYTES) throw new Error('Input report must be a regular JSON file of at most256MiB.');
    const bytes=await readFile(target);if(bytes.length>MAX_BYTES)throw new Error('Input report exceeds256MiB.');
    return { report:JSON.parse(bytes),path:await realpath(target),sha256:sha(bytes) };
}

async function canonicalTarget(path) {
    let current=resolve(path);const tail=[];
    for (;;) { try{return resolve(await realpath(current),...tail);}catch(error){if(error.code!=='ENOENT')throw error;tail.unshift(basename(current));current=dirname(current);} }
}

export async function writeRemediationSummary(options) {
    const baseline=await load(options.baseline),candidate=options.candidate?await load(options.candidate):null;
    const summary=compareCorpusReports(baseline.report,candidate?.report);
    const output=await canonicalTarget(options.output);
    const data=await canonicalTarget(baseline.report.directory);
    if (within(output,data)) throw new Error('Summary output must be outside the original input collection.');
    for(const input of [baseline,candidate].filter(Boolean))if(['summary.json','summary.html','delta.csv'].some(name=>resolve(output,name)===resolve(input.path)))throw new Error('Summary output would overwrite an input report.');
    await mkdir(output,{recursive:true});const lock=resolve(output,'.remediation.lock');const handle=await open(lock,'wx');await handle.close();
    let temporary;
    try {
        temporary=await mkdtemp(resolve(output,'.remediation-'));
        const {rows,...json}=summary;json.reportSha256={baseline:baseline.sha256,candidate:candidate?.sha256??null};
        for(const [name,contents]of [['summary.json',JSON.stringify(json,null,2)+'\n'],['summary.html',renderRemediationHtml(summary)],['delta.csv',renderRemediationCsv(summary)]])await writeFile(resolve(temporary,name),contents,{mode:0o600});
        for(const name of ['summary.json','summary.html','delta.csv'])await rename(resolve(temporary,name),resolve(output,name));
        return {output,summary:json};
    }finally{if(temporary)await rm(temporary,{recursive:true,force:true});await rm(lock,{force:true});}
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
    (async()=>{const result=await writeRemediationSummary(parseArguments(process.argv.slice(2)));console.log(JSON.stringify({output:result.output,totals:result.summary.totals,reviewStatus:result.summary.reviewStatus}));process.exitCode=result.summary.totals.regressions?1:0;})().catch(error=>{console.error('Corpus remediation: '+error.message);process.exitCode=2;});
}
