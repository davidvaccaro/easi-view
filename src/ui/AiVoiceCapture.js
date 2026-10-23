import {MAX_WORKFLOW_AUDIO_BYTES, MAX_WORKFLOW_AUDIO_MS, WORKFLOW_AUDIO_MIME_TYPES} from '../ai/workflow-protocol.js';

/** Push-to-talk only. No browser speech recognition or background microphone. */
export class AiVoiceCapture {
    #devices; #Recorder; #onRecording; #onState; #onError; #stream = null; #recorder = null; #timer = null; #chunks = []; #bytes = 0; #generation = 0; #disposed = false;
    constructor({mediaDevices = globalThis.navigator?.mediaDevices, MediaRecorder = globalThis.MediaRecorder, onRecording = () => {}, onState = () => {}, onError = () => {}} = {}) {
        this.#devices = mediaDevices; this.#Recorder = MediaRecorder; this.#onRecording = onRecording; this.#onState = onState; this.#onError = onError;
    }
    isSupported() { return typeof this.#devices?.getUserMedia === 'function' && typeof this.#Recorder === 'function'; }
    #release() { clearTimeout(this.#timer); this.#timer = null; for (const track of this.#stream?.getTracks?.() ?? []) track.stop(); this.#stream = null; }
    async start() {
        if (this.#disposed || this.#recorder || this.#stream) return;
        if (!this.isSupported()) { this.#onError('Recording is unavailable in this browser. Type your task instead.'); return; }
        const generation = ++this.#generation; this.#onState('permission');
        try {
            const stream = await this.#devices.getUserMedia({audio: true, video: false});
            if (this.#disposed || generation !== this.#generation) { for (const track of stream.getTracks()) track.stop(); return; }
            this.#stream = stream;
            const mimeType = WORKFLOW_AUDIO_MIME_TYPES.find(type => this.#Recorder.isTypeSupported?.(type));
            if (!mimeType) throw new Error('unsupported');
            const recorder = new this.#Recorder(stream, {mimeType}); this.#recorder = recorder; this.#chunks = []; this.#bytes = 0;
            recorder.addEventListener('dataavailable', event => {
                if (generation !== this.#generation || !event.data?.size) return;
                this.#bytes += event.data.size;
                if (this.#bytes > MAX_WORKFLOW_AUDIO_BYTES) { this.cancel(); this.#onError('Recording exceeded 2 MiB. Record a shorter task or type it.'); return; }
                this.#chunks.push(event.data);
            });
            recorder.addEventListener('error', () => { if (generation === this.#generation) { this.cancel(); this.#onError('The microphone could not record. Type your task instead.'); } });
            recorder.addEventListener('stop', async () => {
                if (this.#disposed || generation !== this.#generation) return;
                this.#release(); if (this.#recorder === recorder) this.#recorder = null;
                const blob = new Blob(this.#chunks, {type: mimeType}); this.#chunks = []; this.#bytes = 0; this.#onState('idle');
                if (!blob.size) { this.#onError('No audio was recorded. Try again or type your task.'); return; }
                try {
                    const bytes = new Uint8Array(await blob.arrayBuffer());
                    if (this.#disposed || generation !== this.#generation) return;
                    let binary = ''; for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
                    this.#onRecording({mimeType, audio: btoa(binary)});
                } catch { if (generation === this.#generation) this.#onError('The recording could not be prepared. Type your task instead.'); }
            });
            recorder.start(250); this.#onState('recording'); this.#timer = setTimeout(() => this.stop(), MAX_WORKFLOW_AUDIO_MS);
        } catch (error) {
            // A canceled permission prompt may reject after another capture
            // starts. It no longer owns the current recorder or its tracks.
            if (this.#disposed || generation !== this.#generation) return;
            this.#release(); this.#recorder = null;
            if (!this.#disposed && generation === this.#generation) { this.#onState('idle'); this.#onError(error?.name === 'NotAllowedError' || error?.name === 'SecurityError' ? 'Microphone permission was not granted. Type your task instead.' : 'Recording is unavailable. Check your microphone or type your task.'); }
        }
    }
    stop() { if (this.#recorder?.state === 'recording') { this.#recorder.stop(); this.#release(); } }
    cancel() { ++this.#generation; const recorder = this.#recorder; this.#recorder = null; if (recorder && recorder.state !== 'inactive') { try { recorder.stop(); } catch { /* Already stopped. */ } } this.#release(); this.#chunks = []; this.#bytes = 0; if (!this.#disposed) this.#onState('idle'); }
    dispose() { if (this.#disposed) return; this.cancel(); this.#disposed = true; this.#onRecording = () => {}; this.#onError = () => {}; this.#onState = () => {}; }
}
