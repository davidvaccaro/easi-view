import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile, writeFile} from 'node:fs/promises';

/** Invented commands and images for actual standalone workflow qualification. */
export const WORKFLOW_COMMANDS = Object.freeze({
    paired: 'Show this displayed CT in two panes with lung and soft tissue windows. Synchronize slices and camera, but keep window settings independent.',
    mr: 'Open an original axial MRI acquisition with contrast from the active study.',
    contrast: 'Open a chest CT series with confirmed contrast from the active study.',
    frame: 'Show frame forty of the displayed ultrasound and pause cine.',
    stale: 'Prepare a two pane layout for review.',
    cancel: 'Prepare a delayed two pane layout for review.'
});
const selector = changes => ({study: 'active', modality: null, plane: null, contrast: null, bodyPart: null, seriesNumber: null, ...changes});
const ready = actions => ({version: 1, status: 'ready', summary: 'Arrange the requested viewing task.', question: null, actions});
export function workflowFixturePlan(command) {
    if (command === WORKFLOW_COMMANDS.paired) return ready([{type: 'layout', count: 2},
        {type: 'select-series', viewport: 0, selector: selector({study: 'displayed'})}, {type: 'select-series', viewport: 1, selector: selector({study: 'displayed'})},
        {type: 'window', viewport: 0, preset: 'lung'}, {type: 'window', viewport: 1, preset: 'soft-tissue'}, {type: 'synchronize', slice: true, window: false, camera: true}]);
    if (command === WORKFLOW_COMMANDS.mr) return ready([{type: 'select-series', viewport: 0, selector: selector({modality: 'MR', plane: 'axial', contrast: 'present', bodyPart: 'abdomen'})}]);
    if (command === WORKFLOW_COMMANDS.contrast) return ready([{type: 'select-series', viewport: 0, selector: selector({modality: 'CT', plane: 'axial', contrast: 'present', bodyPart: 'chest'})}]);
    if (command === WORKFLOW_COMMANDS.frame) return ready([{type: 'frame', viewport: 0, frame: 40}, {type: 'cine', viewport: 0, playing: false}]);
    if ([WORKFLOW_COMMANDS.stale, WORKFLOW_COMMANDS.cancel].includes(command)) return ready([{type: 'layout', count: 2}]);
    throw new Error('The deterministic fixture received an unexpected generated command.');
}
export function workflowUltrasoundFixture(createDicomFixture) {
    const values = Array.from({length: 200}, (_, index) => Math.floor(index / 4) * 16 + index % 4 * 30);
    return new File([createDicomFixture({rows: 2, columns: 2, frames: 50, values, modality: 'US', sopClass: '1.2.840.10008.5.1.4.1.1.3.1',
        sopUid: '2.25.2026102100.3.1', seriesUid: '2.25.2026102100.3', frameTime: 200, window: {center: 500, width: 1000},
        extraAttributes: {'00100010': ['PN', 'SYNTHETIC^WORKFLOW_US'], '00100020': ['LO', 'SYNTHETIC-WORKFLOW-US'], '0020000D': ['UI', '2.25.2026102100.3']}})], 'GENERATED-US-50-FRAMES', {type: 'application/dicom'});
}
export function generatedVoiceWav() {
    const rate = 16000, samples = rate * 2, bytes = new Uint8Array(44 + samples * 2), view = new DataView(bytes.buffer);
    const ascii = (offset, value) => [...value].forEach((character, index) => view.setUint8(offset + index, character.charCodeAt(0)));
    ascii(0, 'RIFF'); view.setUint32(4, bytes.length - 8, true); ascii(8, 'WAVE'); ascii(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
    view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true); ascii(36, 'data'); view.setUint32(40, samples * 2, true);
    for (let index = 0; index < samples; index++) view.setInt16(44 + index * 2, Math.round(Math.sin(2 * Math.PI * 440 * index / rate) * 2000), true);
    return bytes;
}

/** Offline macOS speech only. The caller supplies a private temporary output;
 * no user audio, microphone, external speech service or provider key is read. */
export async function generatedSpokenVoiceWav(path) {
    if (process.platform !== 'darwin') throw new Error('The optional live voice gate requires macOS offline speech tools.');
    const run = promisify(execFile), source = `${path}.caf`;
    try {
        await run('/usr/bin/say', ['-r', '145', '-o', source, 'Pause on frame forty'], {timeout: 20000, maxBuffer: 8192});
        await run('/usr/bin/afconvert', ['-f', 'WAVE', '-d', 'LEI16@16000', '-c', '1', source, path], {timeout: 20000, maxBuffer: 8192});
    } catch { throw new Error('The benign offline speech fixture could not be generated. No provider call was made.'); }
    const wav = await readFile(path); let format, samples;
    for (let offset = 12; offset + 8 <= wav.length;) {
        const type = wav.toString('ascii', offset, offset + 4), length = wav.readUInt32LE(offset + 4), start = offset + 8;
        if (start + length > wav.length) throw new Error('The generated speech WAV is invalid.');
        if (type === 'fmt ') format = {encoding: wav.readUInt16LE(start), channels: wav.readUInt16LE(start + 2), rate: wav.readUInt32LE(start + 4), bits: wav.readUInt16LE(start + 14)};
        if (type === 'data') samples = wav.subarray(start, start + length);
        offset = start + length + length % 2;
    }
    if (!samples?.length || format?.encoding !== 1 || format.channels !== 1 || format.rate !== 16000 || format.bits !== 16) throw new Error('The generated speech must be mono 16 kHz PCM.');
    const speechMs = samples.length / 32, durationMs = Math.ceil(speechMs + 800);
    if (durationMs > 19000) throw new Error('The generated speech exceeded the voice fixture limit.');
    // Lead-in protects the first word while getUserMedia starts; trailing
    // silence keeps the fake device from looping before Stop is selected.
    const before = Buffer.alloc(9600), after = Buffer.alloc(80000), pcm = Buffer.concat([before, samples, after]);
    const header = Buffer.from(generatedVoiceWav().subarray(0, 44)); header.writeUInt32LE(pcm.length + 36, 4); header.writeUInt32LE(pcm.length, 40);
    await writeFile(path, Buffer.concat([header, pcm]));
    return {durationMs, source: 'offline macOS generated speech', sampleRate: 16000, channels: 1};
}
