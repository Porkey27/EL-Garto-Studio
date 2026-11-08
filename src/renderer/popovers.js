// Two pop-ups from the top bar, as in Elgato Studio: device details (name, model, serial,
// firmware, USB speed, HDR tone mapping for other apps) and the signal path (input -> card ->
// recording output, plus audio).
import { $, el, toast } from './util.js';
import * as firmware from './firmware.js';
import * as live from './live.js';
import { outputFormat, formatLabel, megabytesPerMinute, pickMime, supportedCodecs, snapFps } from './recording.js';

const { studio } = window;

let ctx = { device: () => null, settings: () => ({}), onRename: () => {} };

export function init(c) {
  ctx = c;
  $('#btn-device-info').addEventListener('click', (e) => { e.stopPropagation(); toggle('#pop-info', '#btn-device-info', renderInfo); });
  $('#btn-signal').addEventListener('click', (e) => { e.stopPropagation(); toggle('#pop-signal', '#btn-signal', renderSignal); });
  document.addEventListener('click', (e) => {
    for (const id of ['#pop-info', '#pop-signal']) if (!$(id).hidden && !$(id).contains(e.target)) $(id).hidden = true;
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeAll(); });
  setInterval(updateSignalButton, 1000);
}

export function closeAll() {
  $('#pop-info').hidden = true;
  $('#pop-signal').hidden = true;
}

async function toggle(popId, btnId, render) {
  const pop = $(popId);
  const open = pop.hidden;
  closeAll();
  if (!open || !ctx.device()) return;
  const r = $(btnId).getBoundingClientRect();
  pop.style.top = `${r.bottom + 6}px`;
  pop.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - 8 - (popId === '#pop-signal' ? 660 : 380)))}px`;
  pop.innerHTML = '<div class="muted small">Loading…</div>';
  pop.hidden = false;
  await render(pop);
}

export function updateSignalButton() {
  const fmt = live.recordingFormat();
  const hs = live.hdrStatus();
  $('#btn-signal').textContent = fmt ? `${formatLabel(fmt)}${hs.hdr ? ` ${hs.label}` : ''}` : 'No signal';
}

const trimZeros = (v) => v.split('.').map((x) => String(Number(x))).join('.');

function firmwareLines(text) {
  if (!text) return ['Unknown'];
  const parts = [...String(text).matchAll(/(Base|MCU)\s+([\d.]+)/g)].map((m) => [m[1], trimZeros(m[2])]);
  if (!parts.length) return [text];
  parts.sort((a) => (a[0] === 'MCU' ? -1 : 1));
  return parts.map(([k, v]) => `${k}: ${v}`);
}

function usbSpeed(device, info) {
  const mbps = info.speedMbps || device.speedMbps;
  if (mbps >= 10000) return `USB 3.2 (${mbps / 1000} Gbps)`;
  if (mbps >= 5000) return 'USB 3.0 (5 Gbps)';
  if (mbps) return `USB 2.0 (${mbps} Mbps)`;
  if (device.usb2Pid) return device.pid === device.usb2Pid || info.usb2Fallback ? 'USB 2.0 (480 Mbps)' : 'USB 3.0 (5 Gbps)';
  return 'Unknown';
}

const row = (label, value) => el('div', { class: 'pop-row' }, el('span', {}, label), value instanceof Node ? value : el('span', { class: 'pop-val' }, value));

async function renderInfo(pop) {
  const device = ctx.device();
  const [info, props] = await Promise.all([
    studio.call('devices:info', device.id).catch(() => ({})),
    studio.call('devices:properties', device.id).catch(() => ({ properties: [] })),
  ]);
  pop.innerHTML = '';

  const name = el('input', { value: device.displayName || device.name, 'aria-label': 'Device name' });
  const commit = async () => {
    const v = name.value.trim();
    const saved = await studio.call('devices:rename', device.id, v === device.name ? '' : v).catch((e) => { toast(e.message, true); return undefined; });
    if (saved === undefined) return;
    device.displayName = saved;
    name.value = saved || device.name;
    ctx.onRename(device);
  };
  name.addEventListener('change', commit);
  name.addEventListener('keydown', (e) => { if (e.key === 'Enter') name.blur(); });
  pop.append(row('Device name', name), el('hr'));

  pop.append(row('Model', device.name));
  if (device.serial) pop.append(row('Serial number', device.serial));
  if (device.kind === 'capture') pop.append(row('Firmware version', el('span', { class: 'pop-val' }, firmwareLines(info.firmware).map((l) => el('div', {}, l)))));
  const fw = firmware.infoBlock(device, closeAll);
  if (fw) pop.append(fw);
  pop.append(el('hr'), row('USB speed', usbSpeed(device, info)));

  const tm = (props.properties || []).find((p) => p.propertyId === 'hdrTonemapping');
  if (tm) {
    const cb = el('input', { type: 'checkbox', class: 'switch' });
    cb.checked = !!tm.value;
    cb.addEventListener('change', async () => {
      try { await studio.call('devices:set', device.id, 'hdrTonemapping', cb.checked); } catch (e) { cb.checked = !cb.checked; toast(e.message, true); }
    });
    pop.append(el('hr'), row('HDR tone mapping for third-party apps', cb));
    pop.append(el('div', { class: 'muted small' }, 'Lets OBS and other apps receive HDR input as SDR.'));
  }
}

const RES_NAMES = { 2160: '4K UHD', 1440: 'QHD', 1080: 'Full HD', 720: 'HD' };
const maxResLabel = (list) => {
  const best = [...(list || [])].sort((a, b) => b[1] - a[1] || b[2] - a[2])[0];
  return best ? `${best[1]}p${best[2]}${RES_NAMES[best[1]] ? ` (${RES_NAMES[best[1]]})` : ''}` : null;
};

function card(icon, title, ...lines) {
  return el('div', { class: 'flow-card' }, el('div', { class: 'flow-icon' }, icon), el('div', { class: 'flow-title' }, title), ...lines.filter(Boolean).map((l) => (l instanceof Node ? l : el('div', { class: 'muted small' }, l))));
}

async function renderSignal(pop) {
  const device = ctx.device();
  const settings = ctx.settings();
  const [info, props] = await Promise.all([
    studio.call('devices:info', device.id).catch(() => ({})),
    studio.call('devices:properties', device.id).catch(() => ({ properties: [] })),
  ]);
  pop.innerHTML = '';

  const src = live.sourceFormat();
  let inputLine = 'No signal';
  if (info.signal && info.signal.hasSignal) inputLine = formatLabel({ height: info.signal.height, fps: snapFps(info.signal.framerate) });
  else if (!info.signal && src) inputLine = formatLabel({ height: src.height, fps: snapFps(src.fps) });
  const isCapture = device.kind === 'capture';

  const out = outputFormat(src, settings);
  const codec = supportedCodecs().find((c) => c.id === pickMime(settings).codec);
  const hs = live.hdrStatus();
  const hdrRec = live.willRecordHdr() || live.hdrRecording();
  const codecLine = hdrRec ? `H.265 (HEVC) Main 10, ${hs.label || 'HDR'}` : codec ? codec.label : null;
  const output = card('⏺', 'Recording format', out ? formatLabel(out) : 'No signal', out ? `~ ${megabytesPerMinute(out, hdrRec ? { ...settings, recCodec: 'hevc' } : settings)} MB/min` : null, codecLine);

  const head = el('div', { class: 'flow-head' }, el('span', {}, 'Input source'), el('span', {}, 'Capture device'), el('span', {}, 'Output'));
  const flow = el('div', { class: 'flow' },
    card(isCapture ? '▭' : '◉', isCapture ? 'HDMI IN' : 'Camera', inputLine, isCapture && inputLine !== 'No signal' ? hs.label || 'SDR' : null),
    el('div', { class: 'flow-arrow' }, '→'),
    card('▣', device.displayName || device.name, maxResLabel(device.maxRes) ? `Supports up to ${maxResLabel(device.maxRes)}` : null),
    el('div', { class: 'flow-arrow' }, '→'),
    output);
  pop.append(head, flow, el('hr'));

  const audioProp = (props.properties || []).find((p) => p.propertyId === 'audioInput');
  const audioOpt = audioProp && (audioProp.valueInfo.values || []).find((o) => o.value === audioProp.value);
  const picker = $('#audio-picker');
  const recAudio = picker.selectedOptions[0] ? picker.selectedOptions[0].textContent : 'Device audio';
  pop.append(el('div', { class: 'flow audio' },
    el('div', { class: 'flow-title' }, '🔊 Audio'),
    el('div', { class: 'flow-card slim' }, el('div', { class: 'muted small' }, 'Device audio source'), el('div', {}, audioOpt ? audioOpt.displayName : 'Device default')),
    el('div', { class: 'flow-card slim' }, el('div', { class: 'muted small' }, 'Used for recording'), el('div', {}, recAudio === 'Device audio' ? (device.displayName || device.name) : recAudio))));
}
