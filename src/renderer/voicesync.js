// VoiceSync: offline speech recognition (Vosk, WebAssembly) driving the prompter scroll.
import { Matcher } from './voicesync-match.js';

export class VoiceSync {
  constructor({ onWord, onStatus, getModelPath }) {
    this.onWord = onWord;
    this.onStatus = onStatus;
    this.getModel = getModelPath;
    this.matcher = new Matcher();
  }

  setWords(words) { this.matcher.setWords(words); }

  reset() { this.matcher.reset(); }

  async start() {
    if (!window.Vosk) throw new Error('speech engine failed to load');
    this.onStatus('Loading speech model…');
    const bytes = await this.getModel();
    const url = URL.createObjectURL(new Blob([bytes], { type: 'application/gzip' }));
    this.model = await window.Vosk.createModel(url);
    URL.revokeObjectURL(url);

    this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 } });
    this.ctx = new AudioContext();
    const rec = new this.model.KaldiRecognizer(this.ctx.sampleRate);
    this.recognizer = rec;
    const handle = (text) => {
      const i = this.matcher.update(text);
      if (i !== null) this.onWord(i);
    };
    rec.on('partialresult', (m) => handle(m.result.partial));
    rec.on('result', (m) => handle(m.result.text));

    const src = this.ctx.createMediaStreamSource(this.stream);
    // ScriptProcessor is deprecated but is what vosk-browser's acceptWaveform expects.
    const proc = this.ctx.createScriptProcessor(4096, 1, 1);
    proc.onaudioprocess = (e) => { try { rec.acceptWaveform(e.inputBuffer); } catch { /* recogniser busy */ } };
    src.connect(proc);
    proc.connect(this.ctx.destination);
    this.proc = proc;
    this.onStatus('VoiceSync listening');
  }

  stop() {
    if (this.proc) this.proc.disconnect();
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    if (this.ctx) this.ctx.close();
    if (this.recognizer) this.recognizer.remove();
    if (this.model) this.model.terminate();
    this.proc = this.stream = this.ctx = this.recognizer = this.model = null;
  }
}
