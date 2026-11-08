// Recording options: max resolution, max frame rate, quality and codec, as in Elgato Studio's
// Recording tab. Pure helpers plus the panel that edits them.
import { $, el } from './util.js';

const { studio } = window;

export const RESOLUTIONS = [
  { value: 0, label: 'Source' },
  { value: 2160, label: '2160p (4K UHD)' },
  { value: 1440, label: '1440p (QHD)' },
  { value: 1080, label: '1080p (Full HD)' },
  { value: 720, label: '720p (HD)' },
];
export const FRAME_RATES = [{ value: 0, label: 'Max' }, { value: 60, label: '60' }, { value: 30, label: '30' }];
export const QUALITY = ['Low', 'Medium', 'High', 'Highest'];
const BITS_PER_PIXEL = [0.07, 0.12, 0.19, 0.28]; // per frame, for HEVC
const CODEC_FACTOR = { h264: 1.3, hevc: 1, av1: 0.85, vp9: 1 };

// MediaRecorder MIME types to try per codec, best first. Chromium's support depends on the OS and
// the GPU's encoders, so only codecs with at least one supported type are offered.
const CODECS = {
  // Opus first: the app converts audio to AAC when it finishes an MP4 anyway, and Chromium's AAC
  // encoder fails on some systems' sample rates.
  h264: { label: 'H.264 (AVC)', mimes: ['video/mp4;codecs=avc1.640034,opus', 'video/mp4;codecs=avc1,opus', 'video/mp4;codecs=avc1.640034,mp4a.40.2', 'video/x-matroska;codecs=avc1,opus', 'video/webm;codecs=h264,opus', 'video/webm;codecs=avc1,opus'] },
  hevc: { label: 'H.265 (HEVC)', mimes: ['video/mp4;codecs=hvc1.1.6.L153.B0,opus', 'video/mp4;codecs=hvc1,opus', 'video/mp4;codecs=hvc1.1.6.L153.B0,mp4a.40.2', 'video/mp4;codecs=hev1,opus', 'video/x-matroska;codecs=hvc1,opus', 'video/x-matroska;codecs=hev1,opus'] },
  av1: { label: 'AV1', mimes: ['video/mp4;codecs=av01.0.12M.08,opus', 'video/webm;codecs=av01,opus', 'video/x-matroska;codecs=av01,opus'] },
  vp9: { label: 'VP9', mimes: ['video/webm;codecs=vp9,opus'] },
};

export function supportedCodecs() {
  return Object.entries(CODECS)
    .map(([id, c]) => ({ id, label: c.label, mime: c.mimes.find((m) => MediaRecorder.isTypeSupported(m)) }))
    .filter((c) => c.mime);
}

export function pickMime(settings) {
  const list = supportedCodecs();
  const want = list.find((c) => c.id === settings.recCodec) || list[0];
  return want ? { codec: want.id, mime: want.mime } : { codec: null, mime: MediaRecorder.isTypeSupported('video/webm') ? 'video/webm' : '' };
}

// 59.94 -> 60, 29.97 -> 30 and so on, as frame rates are usually named.
export function snapFps(fps) {
  const common = [24, 25, 30, 48, 50, 60, 90, 100, 120, 144, 165, 240];
  const near = common.find((c) => Math.abs(c - fps) <= 1.2);
  return near || Math.round(fps);
}

// Output size and frame rate for a source, capped by the settings (aspect ratio kept, even sizes).
export function outputFormat(src, settings) {
  if (!src || !src.width || !src.height) return null;
  const maxH = settings.recMaxHeight || 0;
  const height = maxH && src.height > maxH ? maxH : src.height;
  const width = Math.round((src.width * height) / src.height / 2) * 2;
  const srcFps = snapFps(src.fps || 60);
  const fps = settings.recMaxFps && srcFps > settings.recMaxFps ? settings.recMaxFps : srcFps;
  return { width, height, fps };
}

// The bitrate we want in the file.
export function targetVideoBitrate(fmt, settings) {
  if (!fmt) return 40e6;
  const q = Math.max(0, Math.min(QUALITY.length - 1, settings.recQuality ?? 2));
  const codec = pickMime(settings).codec || 'h264';
  const bps = fmt.width * fmt.height * fmt.fps * BITS_PER_PIXEL[q] * (CODEC_FACTOR[codec] || 1);
  return Math.round(Math.max(2e6, Math.min(200e6, bps)));
}

// What to ask the encoder for. Some hardware encoders don't honour the requested bitrate (AMD's
// HEVC/H.264 through Chromium produce about 2x), so the app learns each codec's ratio from past
// recordings (settings.encoderRatio) and corrects for it.
export function videoBitrate(fmt, settings) {
  const codec = pickMime(settings).codec || 'h264';
  const ratio = (settings.encoderRatio || {})[codec] || 1;
  return Math.round(Math.max(1e6, targetVideoBitrate(fmt, settings) / ratio));
}

// After a recording: actual video bitrate vs. requested, smoothed into settings.encoderRatio.
export function learnEncoderRatio(settings, codec, requestedBps, actualBps) {
  if (!codec || !(requestedBps > 0) || !(actualBps > 0)) return null;
  const measured = Math.max(0.25, Math.min(4, actualBps / requestedBps));
  const all = { ...(settings.encoderRatio || {}) };
  // actual / requested is the encoder's own ratio, whatever correction went into the request.
  const prev = all[codec];
  all[codec] = Math.round((prev ? (prev + measured) / 2 : measured) * 1000) / 1000;
  return all;
}

export function megabytesPerMinute(fmt, settings) {
  const audio = (settings.audioBitrateKbps || 192) * 1e3;
  return Math.round(((targetVideoBitrate(fmt, settings) + audio) * 60) / 8 / 1e6);
}

const NAMES = { 2160: '4K UHD', 1440: 'QHD', 1080: 'Full HD', 720: 'HD', 480: 'SD' };
export function formatLabel(fmt) {
  if (!fmt) return 'No signal';
  const name = NAMES[fmt.height];
  return `${fmt.height}p${fmt.fps}${name ? ` (${name})` : ''}`;
}

// ---- panel ------------------------------------------------------------------------------

let ctx = { settings: {}, source: () => null, onChange: () => {}, hdr: () => ({ capable: false }) };

export function initPanel({ settings, source, onChange, hdr }) {
  ctx = { settings, source, onChange, hdr: hdr || ctx.hdr };
  window.addEventListener('hdr-status', () => render());
  render();
}

export function update(settings) {
  ctx.settings = settings;
  render();
}

async function save(key, value) {
  ctx.settings = await studio.call('settings:set', key, value);
  ctx.onChange(ctx.settings);
  render();
}

function select(options, value, onChange) {
  const s = el('select', {}, options.map((o) => el('option', { value: o.value }, o.label)));
  s.value = String(value);
  s.addEventListener('change', () => onChange(s.value));
  return s;
}

export function render() {
  const box = $('#rec-section');
  if (!box) return;
  const st = ctx.settings;
  box.innerHTML = '';
  box.append(el('h3', {}, 'Recording'));

  const row = (label, control) => el('div', { class: 'ctrl' }, el('label', {}, label), control);
  box.append(row('Max resolution', select(RESOLUTIONS, st.recMaxHeight || 0, (v) => save('recMaxHeight', Number(v)))));
  box.append(row('Max frame rate', select(FRAME_RATES, st.recMaxFps || 0, (v) => save('recMaxFps', Number(v)))));

  const fmt = outputFormat(ctx.source(), st);
  const q = st.recQuality ?? 2;
  const est = el('span', { class: 'val' }, fmt ? `~ ${megabytesPerMinute(fmt, st)} MB/min` : '');
  const slider = el('input', { type: 'range', min: 0, max: QUALITY.length - 1, step: 1 });
  slider.value = q;
  slider.addEventListener('input', () => {
    const tmp = { ...st, recQuality: Number(slider.value) };
    est.textContent = fmt ? `~ ${megabytesPerMinute(fmt, tmp)} MB/min` : '';
    qName.textContent = QUALITY[slider.value];
  });
  slider.addEventListener('change', () => save('recQuality', Number(slider.value)));
  const qName = el('span', { class: 'muted small' }, QUALITY[q]);
  box.append(el('div', { class: 'ctrl' }, el('label', {}, 'Quality ', qName), est, slider));

  const codecs = supportedCodecs();
  const current = pickMime(st).codec;
  if (codecs.length) {
    box.append(row('Codec', select(codecs.map((c) => ({ value: c.id, label: c.label })), current, (v) => save('recCodec', v))));
  } else {
    box.append(el('p', { class: 'muted small' }, 'No hardware or software video encoder is available to the recorder.'));
  }

  // HDR: only offered where the native helper can open the card in 10-bit (Windows).
  const hs = ctx.hdr();
  if (hs.capable) {
    const cb = el('input', { type: 'checkbox', class: 'switch' });
    cb.checked = !!st.recHdr;
    cb.disabled = !hs.encoder;
    cb.addEventListener('change', () => save('recHdr', cb.checked));
    box.append(row('HDR', cb));
    let note;
    if (!hs.encoder) note = 'No HEVC Main 10 encoder works on this PC (needs a recent AMD, NVIDIA or Intel GPU, or x265 in ffmpeg).';
    else {
      note = `When the input is HDR, records 10-bit HEVC with ${hs.encoder}. Input now: ${hs.label || 'SDR'}.`;
      if (hs.softwareEncoder) note += ' CPU encoding may drop frames at high resolutions.';
      if (st.recHdr) note += ' Flashback and the virtual camera pause while an HDR recording runs.';
    }
    box.append(el('p', { class: 'muted small' }, note));
  }
}
