// Live preview, audio monitoring, recording, snapshots, Flashback, virtual camera and multiview.
import { toast, $, fmtBytes, fmtTime } from './util.js';
import { pickMime as pickRecordingMime, outputFormat, videoBitrate, targetVideoBitrate, learnEncoderRatio } from './recording.js';

const { studio } = window;

const state = {
  device: null,
  stream: null,
  audioStream: null,
  recorder: null,
  flashbackRec: null,
  vcamRec: null,
  audioCtx: null,
  gain: null,
  analysers: null,
  monitorDest: null,
  recordDest: null,
  muted: false,
  volume: 1,
  audioDeviceId: 'auto',
  format: null,
  settings: {},
  multiview: [],
};

const video = $('#preview');

function pickMime() {
  return pickRecordingMime(state.settings).mime;
}

// HDR recording (Windows): Chromium can't open the card in 10-bit, so the native helper takes it
// over while recording and sends the preview as JPEG frames, drawn onto a canvas.
const hdr = {
  status: { capable: false }, // from main: capable, eotf, label ('SDR' | 'HDR10' | 'HLG'), hdr, encoder
  format: null, // { width, height, fps, label } while the helper records
  canvas: null,
  ctx2d: null,
  drawing: false,
  reopen: false, // reopen the card once the helper has released it
};

export function hdrStatus() { return hdr.status; }
export function hdrRecording() { return !!(state.recorder && state.recorder.hdr); }
export function willRecordHdr() { return !!(state.settings.recHdr && hdr.status.capable && hdr.status.hdr); }

async function pollHdr() {
  const before = JSON.stringify(hdr.status);
  if (state.device && state.device.kind === 'capture') {
    try { hdr.status = await studio.call('hdr:status', state.device.id); } catch { hdr.status = { capable: false }; }
  } else {
    hdr.status = { capable: false };
  }
  if (JSON.stringify(hdr.status) !== before) window.dispatchEvent(new CustomEvent('hdr-status', { detail: hdr.status }));
}
setInterval(pollHdr, 2000);

// The source as it arrives from the device.
export function sourceFormat() {
  if (hdr.format && hdrRecording()) return { width: hdr.format.width, height: hdr.format.height, fps: hdr.format.fps };
  const t = state.stream && state.stream.getVideoTracks()[0];
  if (!t || t.readyState !== 'live') return null;
  const st = t.getSettings();
  const width = st.width || video.videoWidth;
  const height = st.height || video.videoHeight;
  return width && height ? { width, height, fps: st.frameRate || 60 } : null;
}

export function recordingFormat() {
  return outputFormat(sourceFormat(), state.settings);
}

// Chromium labels V4L2 devices with the driver's card name; match on that or our model name.
export async function findMediaDevice(kind, device) {
  const all = await navigator.mediaDevices.enumerateDevices();
  const list = all.filter((d) => d.kind === kind);
  const names = [device.videoName, device.name].filter(Boolean).map((n) => n.toLowerCase());
  const short = names.map((n) => n.split(' ').slice(-2).join(' '));
  return list.find((d) => names.some((n) => d.label.toLowerCase().includes(n)))
    || list.find((d) => short.some((n) => d.label.toLowerCase().includes(n)))
    || null;
}

async function ensurePermission() {
  // Labels stay empty until the first successful getUserMedia call.
  const devs = await navigator.mediaDevices.enumerateDevices();
  if (devs.some((d) => d.label)) return;
  try {
    const s = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    s.getTracks().forEach((t) => t.stop());
  } catch { /* no devices yet */ }
}

export async function listAudioInputs() {
  await ensurePermission();
  return (await navigator.mediaDevices.enumerateDevices())
    .filter((d) => d.kind === 'audioinput' && !/Studio Virtual/i.test(d.label)); // our own virtual mic would loop
}

function stopStream(s) {
  if (s) s.getTracks().forEach((t) => t.stop());
}

function setupAudio(audioStream) {
  if (state.audioCtx) state.audioCtx.close();
  // 48 kHz like video: the system default can be 96 kHz or more, which Chromium's AAC encoder
  // rejects ("encoder configuration is not supported"), leaving MP4 recordings empty.
  state.audioCtx = new AudioContext({ latencyHint: 'interactive', sampleRate: 48000 });
  const ctx = state.audioCtx;
  state.recordDest = ctx.createMediaStreamDestination();
  if (!audioStream || !audioStream.getAudioTracks().length) { state.analysers = null; rebindVirtualMic(); return; }
  const src = ctx.createMediaStreamSource(audioStream);
  const split = ctx.createChannelSplitter(2);
  const aL = ctx.createAnalyser();
  const aR = ctx.createAnalyser();
  aL.fftSize = aR.fftSize = 1024;
  src.connect(split);
  split.connect(aL, 0);
  split.connect(aR, 1);
  src.connect(state.recordDest); // recordings always get full-level audio
  state.gain = ctx.createGain();
  src.connect(state.gain);
  state.gain.connect(ctx.destination);
  applyGain();
  state.analysers = [aL, aR];
  rebindVirtualMic();
}

function applyGain() {
  if (state.gain) state.gain.gain.value = state.muted ? 0 : state.volume;
  studio.reportPreview({ volumePercentage: Math.round(state.volume * 100), isMuted: state.muted });
  $('#btn-mute').classList.toggle('on', state.muted);
  $('#volume').value = Math.round(state.volume * 100);
}

let lastLevelReport = 0;
function meterLoop() {
  requestAnimationFrame(meterLoop);
  if (!state.analysers) return;
  const buf = new Float32Array(1024);
  const levels = state.analysers.map((a) => {
    a.getFloatTimeDomainData(buf);
    let peak = 0;
    for (const v of buf) peak = Math.max(peak, Math.abs(v));
    return Math.min(1, peak);
  });
  const shown = levels.map((l) => (state.muted ? 0 : l * state.volume));
  $('#meter-l').style.width = `${shown[0] * 100}%`;
  $('#meter-r').style.width = `${shown[1] * 100}%`;
  const now = performance.now();
  if (now - lastLevelReport > 200) {
    lastLevelReport = now;
    studio.reportLevels(Math.round(shown[0] * 100), Math.round(shown[1] * 100));
  }
}

export async function openDevice(device, { format, audioDeviceId } = {}) {
  await stopRecordingIfNeeded();
  stopFlashback();
  stopStream(state.stream);
  stopStream(state.audioStream);
  state.device = device;
  state.stream = null;
  if (!device) {
    video.srcObject = null;
    $('#no-signal').hidden = false;
    $('#no-signal').textContent = 'Connect an Elgato capture card or camera';
    return;
  }
  await ensurePermission();

  const vid = await findMediaDevice('videoinput', device);
  if (!vid) {
    $('#no-signal').hidden = false;
    $('#no-signal').textContent = device.pcie ? 'This PCIe card has no Linux driver' : 'Video device not found';
    return;
  }
  const constraints = { deviceId: { exact: vid.deviceId } };
  const fmt = format || state.format;
  if (fmt) Object.assign(constraints, { width: { exact: fmt.width }, height: { exact: fmt.height }, frameRate: { ideal: fmt.fps } });
  else Object.assign(constraints, { width: { ideal: 3840 }, height: { ideal: 2160 }, frameRate: { ideal: 60 } });
  try {
    state.stream = await navigator.mediaDevices.getUserMedia({ video: constraints, audio: false });
  } catch (e) {
    toast(`Could not open ${device.name}: ${e.message}`, true);
    return;
  }
  video.srcObject = state.stream;
  // A track ends without stop() when the device leaves USB (unplug, or a capture card restarting
  // after a scaler change). Reopen it once it is back.
  state.stream.getVideoTracks()[0].addEventListener('ended', () => reopenWhenBack(device));

  state.audioDeviceId = audioDeviceId || state.audioDeviceId;
  let aud = null;
  if (state.audioDeviceId === 'auto') aud = await findMediaDevice('audioinput', device);
  else if (state.audioDeviceId !== 'none') aud = { deviceId: state.audioDeviceId };
  state.audioStream = null;
  if (aud) {
    try {
      state.audioStream = await navigator.mediaDevices.getUserMedia({
        audio: { deviceId: { exact: aud.deviceId }, echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 2, sampleRate: 48000 },
      });
    } catch { /* device has no audio */ }
  }
  setupAudio(state.audioStream);
  reportSignal();
  startFlashback();
  pollHdr();
}

async function reopenWhenBack(device, attempt = 0) {
  if (!state.device || state.device.id !== device.id) return; // user switched devices meanwhile
  $('#no-signal').hidden = false;
  $('#no-signal').textContent = 'Device reconnecting…';
  await new Promise((r) => setTimeout(r, 1000));
  if (!state.device || state.device.id !== device.id) return;
  if (await findMediaDevice('videoinput', device)) {
    await openDevice(device);
  } else if (attempt < 15) {
    reopenWhenBack(device, attempt + 1);
  } else {
    $('#no-signal').textContent = `${device.name} disconnected`;
  }
}

function reportSignal() {
  if (hdrRecording() && hdr.format) {
    $('#no-signal').hidden = true;
    studio.reportSignal({ hasSignal: true, width: hdr.format.width, height: hdr.format.height, framerate: hdr.format.fps, isHdr: true });
    return;
  }
  const t = state.stream && state.stream.getVideoTracks()[0];
  const s = t ? t.getSettings() : {};
  const has = !!(t && t.readyState === 'live' && video.videoWidth > 0);
  $('#no-signal').hidden = has || !t;
  if (!has && t) $('#no-signal').textContent = 'No signal';
  studio.reportSignal({ hasSignal: has, width: s.width || video.videoWidth, height: s.height || video.videoHeight, framerate: s.frameRate || 0, isHdr: false });
}

video.addEventListener('resize', reportSignal);
video.addEventListener('loadedmetadata', reportSignal);

// The recorded video is a copy of the preview track, scaled down and/or frame-rate limited by the
// recording settings (Chromium scales cloned tracks itself), so the preview stays at full quality.
// Returns { stream, release } — release stops the copy once the recorder is done with it.
async function recordingStream() {
  const src = state.stream.getVideoTracks()[0];
  const fmt = recordingFormat();
  const srcFmt = sourceFormat();
  let track = src;
  if (fmt && srcFmt && (fmt.height < srcFmt.height || fmt.fps < Math.round(srcFmt.fps))) {
    track = src.clone();
    try {
      await track.applyConstraints({ width: { exact: fmt.width }, height: { exact: fmt.height }, frameRate: { max: fmt.fps }, resizeMode: 'crop-and-scale' });
    } catch (e) {
      toast(`Recording at source size: ${e.message}`, true);
    }
  }
  const tracks = [track];
  if (state.recordDest) tracks.push(...state.recordDest.stream.getAudioTracks());
  return { stream: new MediaStream(tracks), release: () => { if (track !== src) track.stop(); } };
}

export async function startRecording() {
  if (!state.stream || state.recorder || state.recStarting) return;
  if (willRecordHdr()) return startHdrRecording();
  state.recStarting = true;
  try {
    const mimeType = pickMime();
    const { stream, release } = await recordingStream();
    const rec = new MediaRecorder(stream, {
      mimeType,
      videoBitsPerSecond: videoBitrate(recordingFormat(), state.settings),
      audioBitsPerSecond: (state.settings.audioBitrateKbps || 192) * 1e3,
    });
    try {
      await studio.call('recorder:start', { mimeType });
    } catch (e) {
      release();
      toast(e.message, true);
      return;
    }
    state.releaseRecording = release;
    const meter = { codec: pickRecordingMime(state.settings).codec, requested: videoBitrate(recordingFormat(), state.settings), bytes: 0, started: performance.now() };
    state.recMeter = meter;
    rec.ondataavailable = async (e) => {
      if (!e.data.size) return;
      meter.bytes += e.data.size;
      studio.sendChunk(await e.data.arrayBuffer());
    };
    // The recorder can stop by itself (encoder failure, GPU reset, the device leaving USB). Save
    // what was recorded instead of leaving the app stuck in "recording".
    rec.onerror = (e) => {
      console.warn(`MediaRecorder error: ${e.error ? `${e.error.name}: ${e.error.message}` : e}`);
      toast(`Recording stopped: ${(e.error && e.error.message) || 'the encoder failed'}`, true);
      if (state.recorder === rec) stopRecording();
    };
    rec.addEventListener('stop', () => { if (state.recorder === rec) stopRecording(); });
    rec.start(1000);
    state.recorder = rec;
    updateRecordUi(true);
  } finally {
    state.recStarting = false;
  }
}

function showHdrPreview() {
  const c = document.createElement('canvas');
  c.width = 960;
  c.height = 540;
  hdr.canvas = c;
  hdr.ctx2d = c.getContext('2d');
  video.srcObject = c.captureStream(30);
  $('#no-signal').hidden = true;
}

function hideHdrPreview() {
  hdr.canvas = null;
  hdr.ctx2d = null;
  hdr.format = null;
}

async function startHdrRecording() {
  state.recStarting = true;
  try {
    const track = state.audioStream && state.audioStream.getAudioTracks()[0];
    // Chromium appends the USB IDs to some device names; Media Foundation's names don't have them.
    const audioLabel = track ? track.label.replace(/\s*\([0-9a-f]{4}:[0-9a-f]{4}\)\s*$/i, '') : null;
    const fmt = recordingFormat();
    const bitrate = targetVideoBitrate(fmt, { ...state.settings, recCodec: 'hevc' });
    stopFlashback();
    if (state.vcamRec) await toggleVirtualCamera();
    stopStream(state.stream);
    state.stream = null;
    showHdrPreview();
    state.recorder = { hdr: true };
    hdr.reopen = false;
    try {
      await studio.call('recorder:startHdr', { audioLabel, bitrate, maxHeight: state.settings.recMaxHeight || 0, maxFps: state.settings.recMaxFps || 0 });
    } catch (e) {
      state.recorder = null;
      hideHdrPreview();
      toast(`HDR recording could not start: ${e.message}`, true);
      await openDevice(state.device);
      return;
    }
    updateRecordUi(true);
    reportSignal();
  } finally {
    state.recStarting = false;
  }
}

async function stopHdrRecording() {
  state.recorder = null;
  updateRecordUi(false);
  hdr.reopen = true;
  try {
    toast('Saving recording…');
    const file = await studio.call('recorder:stop');
    if (file) toast(`Saved ${file.split(/[\\/]/).pop()}`);
  } catch (e) {
    toast(e.message, true);
  }
  reopenAfterHdr();
}

// The helper has let go of the card (main sends this before the file is remuxed).
function reopenAfterHdr() {
  if (!hdr.reopen) return;
  hdr.reopen = false;
  hideHdrPreview();
  if (state.device) openDevice(state.device);
}

studio.on('hdr:format', (f) => {
  hdr.format = { width: f.width, height: f.height, fps: f.fpsNum / f.fpsDen, label: f.label };
  if (hdr.canvas && f.preview) { hdr.canvas.width = f.preview.width; hdr.canvas.height = f.preview.height; }
  reportSignal();
});
studio.on('hdr:preview', async (jpeg) => {
  if (!hdr.ctx2d || hdr.drawing) return; // drop frames rather than queue them
  hdr.drawing = true;
  try {
    const bmp = await createImageBitmap(new Blob([jpeg], { type: 'image/jpeg' }));
    if (hdr.ctx2d) hdr.ctx2d.drawImage(bmp, 0, 0, hdr.canvas.width, hdr.canvas.height);
    bmp.close();
  } catch { /* skip a bad frame */ }
  hdr.drawing = false;
});
studio.on('hdr:released', reopenAfterHdr);
studio.on('hdr:ended', (why) => {
  if (!hdrRecording()) return;
  toast(`HDR recording stopped: ${why}`, true);
  stopHdrRecording();
});

export async function stopRecording() {
  const rec = state.recorder;
  if (!rec) return;
  if (rec.hdr) return stopHdrRecording();
  state.recorder = null;
  updateRecordUi(false);
  // Wait for the recorder's last chunk. An already stopped recorder never fires 'stop' again, and
  // one whose encoder died may never fire it, so don't wait forever.
  if (rec.state !== 'inactive') {
    await Promise.race([
      new Promise((resolve) => { rec.addEventListener('stop', resolve, { once: true }); try { rec.stop(); } catch { resolve(); } }),
      new Promise((resolve) => setTimeout(resolve, 5000)),
    ]);
  }
  if (state.releaseRecording) { state.releaseRecording(); state.releaseRecording = null; }
  // Let the final dataavailable handler finish posting its chunk.
  await new Promise((r) => setTimeout(r, 250));
  const m = state.recMeter;
  state.recMeter = null;
  const secs = m ? (performance.now() - m.started) / 1000 : 0;
  if (m && secs >= 5) {
    const audio = (state.settings.audioBitrateKbps || 192) * 1e3;
    const ratios = learnEncoderRatio(state.settings, m.codec, m.requested, Math.max(1, (m.bytes * 8) / secs - audio));
    if (ratios) studio.call('settings:set', 'encoderRatio', ratios).then((st) => setSettings(st)).catch(() => {});
  }
  try {
    toast('Saving recording…');
    const file = await studio.call('recorder:stop');
    if (file) toast(`Saved ${file.split(/[\\/]/).pop()}`);
  } catch (e) {
    toast(e.message, true);
  }
}

async function stopRecordingIfNeeded() {
  if (state.recorder) await stopRecording();
}

export function toggleRecording(force) {
  const want = typeof force === 'boolean' ? force : !state.recorder;
  return want ? startRecording() : stopRecording();
}

function updateRecordUi(on) {
  $('#btn-record').classList.toggle('recording', on);
  $('#btn-record .label').textContent = on ? 'Stop' : 'Record';
  $('#rec-status').hidden = !on;
}

studio.on('recorder:status', (st) => {
  $('#rec-time').textContent = fmtTime(st.durationSec);
  $('#rec-size').textContent = fmtBytes(st.sizeBytes);
});

export async function snapshot() {
  if (!video.videoWidth) { toast('No video to capture', true); return; }
  const c = document.createElement('canvas');
  c.width = video.videoWidth;
  c.height = video.videoHeight;
  c.getContext('2d').drawImage(video, 0, 0);
  const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
  const file = await studio.call('recorder:snapshot', await blob.arrayBuffer());
  toast(`Snapshot saved: ${file.split('/').pop()}`);
}

// Flashback: record self-contained 10 s segments; main keeps the last N minutes.
const SEGMENT_SEC = 10;
function startFlashback() {
  stopFlashback();
  if (!(state.settings.flashbackMinutes > 0) || !state.stream) { $('#btn-flashback').hidden = true; return; }
  $('#btn-flashback').hidden = false;
  const mimeType = pickMime();
  const bitrate = videoBitrate(recordingFormat(), state.settings);
  const pending = recordingStream();
  state.flashbackStopped = false;
  pending.then(({ stream, release }) => {
    if (state.flashbackStopped) { release(); return; }
    state.releaseFlashback = release;
    loop(stream);
  });
  const loop = (stream) => {
    if (state.flashbackStopped) return;
    const rec = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: bitrate });
    const parts = [];
    const started = performance.now();
    rec.ondataavailable = (e) => { if (e.data.size) parts.push(e.data); };
    rec.onstop = async () => {
      const blob = new Blob(parts, { type: mimeType });
      studio.sendFlashbackSegment(await blob.arrayBuffer(), (performance.now() - started) / 1000);
    };
    rec.start();
    state.flashbackRec = rec;
    state.flashbackTimer = setTimeout(() => { rec.stop(); loop(stream); }, SEGMENT_SEC * 1000);
  };
}

function stopFlashback() {
  state.flashbackStopped = true;
  clearTimeout(state.flashbackTimer);
  if (state.flashbackRec && state.flashbackRec.state !== 'inactive') state.flashbackRec.stop();
  state.flashbackRec = null;
  if (state.releaseFlashback) { state.releaseFlashback(); state.releaseFlashback = null; }
}

export async function saveFlashback() {
  try {
    const f = await studio.call('flashback:save');
    toast(`Flashback saved: ${f.split('/').pop()}`);
  } catch (e) {
    toast(e.message, true);
  }
}

export async function toggleVirtualCamera() {
  if (state.vcamRec) {
    state.vcamRec.stop();
    state.vcamRec = null;
    await studio.call('vcam:stop');
    $('#btn-vcam').classList.remove('on');
    return;
  }
  if (!state.stream) return;
  const dev = state.settings.vcamDevice || (await studio.call('vcam:devices'))[0];
  if (!dev) { toast('No virtual camera device found. Install v4l2loopback and run: sudo modprobe v4l2loopback video_nr=10 card_label="Studio Virtual Camera" exclusive_caps=1', true); return; }
  // Feed a 1080p/30 copy of the preview: that's what Discord and browsers use, and software VP8
  // encoding of a 4K/60 source can't keep up.
  const src = state.stream.getVideoTracks()[0];
  const s = src.getSettings();
  const track = src.clone();
  const h = Math.min(s.height || 1080, 1080);
  const w = Math.round(((s.width || 1920) * h) / (s.height || 1080) / 2) * 2;
  await track.applyConstraints({ width: { exact: w }, height: { exact: h }, frameRate: { max: 30 }, resizeMode: 'crop-and-scale' }).catch(() => {});
  try {
    await studio.call('vcam:start', dev, { width: w, height: h });
  } catch (e) {
    track.stop();
    throw e;
  }
  const rec = new MediaRecorder(new MediaStream([track]), { mimeType: 'video/webm;codecs=vp8', videoBitsPerSecond: 8e6 });
  rec.ondataavailable = async (e) => { if (e.data.size) studio.sendVcamChunk(await e.data.arrayBuffer()); };
  rec.onstop = () => track.stop();
  rec.start(100);
  state.vcamRec = rec;
  $('#btn-vcam').classList.add('on');
}

// Virtual microphone (Linux): the app's audio, at full level like recordings, played into the
// "Studio Virtual Audio" sink, whose remapped source Discord/OBS see as "Studio Virtual Microphone".
function rebindVirtualMic() {
  const vm = state.vmic;
  if (!vm || !state.recordDest) return;
  if (vm.src) vm.src.disconnect();
  vm.src = vm.ctx.createMediaStreamSource(state.recordDest.stream);
  vm.src.connect(vm.ctx.destination);
}

export async function toggleVirtualMic() {
  const btn = $('#btn-vmic');
  if (state.vmic) {
    const vm = state.vmic;
    state.vmic = null;
    if (vm.src) vm.src.disconnect();
    await vm.ctx.close().catch(() => {});
    btn.classList.remove('on');
    await studio.call('vmic:stop');
    return;
  }
  btn.disabled = true;
  try {
    const { sinkLabel, sourceLabel } = await studio.call('vmic:start');
    // Chromium notices new PulseAudio/PipeWire devices after a short delay.
    let sink = null;
    for (let i = 0; i < 20 && !sink; i++) {
      sink = (await navigator.mediaDevices.enumerateDevices()).find((d) => d.kind === 'audiooutput' && d.label.includes(sinkLabel));
      if (!sink) await new Promise((r) => setTimeout(r, 250));
    }
    if (!sink) {
      await studio.call('vmic:stop');
      throw new Error('the virtual audio device did not appear');
    }
    // A dedicated audio context whose output is the virtual sink (an <audio> element's setSinkId
    // is not applied to MediaStream playback on Linux).
    const ctx = new AudioContext({ latencyHint: 'interactive', sampleRate: 48000, sinkId: sink.deviceId });
    if (ctx.sinkId !== sink.deviceId && ctx.setSinkId) await ctx.setSinkId(sink.deviceId);
    await ctx.resume();
    state.vmic = { ctx, src: null };
    if (!state.recordDest) setupAudio(state.audioStream);
    rebindVirtualMic();
    btn.classList.add('on');
    toast(`Virtual microphone on: pick "${sourceLabel}" in Discord, OBS or your browser`);
  } catch (e) {
    toast(`Virtual microphone: ${e.message}`, true);
  } finally {
    btn.disabled = false;
  }
}

studio.on('gpu:lost', async () => {
  const device = state.device;
  if (state.recorder) {
    toast('The graphics driver reset: saving the recording so far.', true);
    await stopRecording();
  }
  // Give the GPU process a moment to come back, then reopen the device.
  await new Promise((r) => setTimeout(r, 1500));
  if (device && state.device === device) await openDevice(device);
});

studio.on('vcam:state', (st) => {
  if (!st.running && state.vcamRec) {
    state.vcamRec.stop();
    state.vcamRec = null;
    $('#btn-vcam').classList.remove('on');
    if (st.error) toast(`Virtual camera stopped: ${st.error}`, true);
  }
});

export async function toggleMultiview(devices) {
  const mv = $('#multiview');
  if (!mv.hidden) {
    state.multiview.forEach(stopStream);
    state.multiview = [];
    mv.innerHTML = '';
    mv.hidden = true;
    $('#btn-multiview').classList.remove('on');
    return;
  }
  mv.hidden = false;
  $('#btn-multiview').classList.add('on');
  for (const d of devices) {
    const tile = document.createElement('div');
    tile.className = 'tile';
    const v = document.createElement('video');
    v.autoplay = true; v.muted = true;
    const label = document.createElement('span');
    label.textContent = d.name;
    tile.append(v, label);
    mv.append(tile);
    if (state.device && d.id === state.device.id && state.stream) { v.srcObject = state.stream; continue; }
    const md = await findMediaDevice('videoinput', d);
    if (!md) { label.textContent += ' (unavailable)'; continue; }
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: md.deviceId }, width: { ideal: 1280 }, height: { ideal: 720 } } });
      state.multiview.push(s);
      v.srcObject = s;
    } catch (e) {
      label.textContent += ` (${e.name})`;
    }
  }
}

export function setVolume(v) { state.volume = v; applyGain(); }
export function setMuted(m) { state.muted = m; applyGain(); }
export function isMuted() { return state.muted; }
export function setSettings(s) {
  const keys = ['flashbackMinutes', 'recMaxHeight', 'recMaxFps', 'recQuality', 'recCodec'];
  const flashChanged = keys.some((k) => s[k] !== state.settings[k]);
  state.settings = s;
  state.volume = s.previewVolume ?? state.volume;
  state.muted = s.previewMuted ?? state.muted;
  if (flashChanged && state.stream) startFlashback();
}
export function setFormat(f) { state.format = f; }
export function currentStream() { return state.stream; }
export function isRecording() { return !!state.recorder; }

meterLoop();
