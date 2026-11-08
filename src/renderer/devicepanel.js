// Device settings panel: builds controls from the property descriptors the main process
// returns, so cameras, capture cards and generic webcams share one UI.
import { $, el, toast, debounce, ask } from './util.js';

const { studio } = window;

let current = null; // { device, properties, categories, actions }
let hudTimer = null;
let loadToken = 0;

function fmtValue(p, v) {
  if (v === null || v === undefined) return '–';
  if (p.dataType === 'bool') return v ? 'On' : 'Off';
  if (p.valueInfo && p.valueInfo.unit === 'K') return `${v} K`;
  if (p.propertyId === 'shutterSpeed') return v > 0 ? `1/${Math.round(10000 / v)}` : v;
  return String(v);
}

function isDisabled(p) {
  if (!p.dependsOn) return false;
  const [dep, want] = p.dependsOn;
  const d = current.properties.find((x) => x.propertyId === dep);
  return d ? !!d.value !== want : false;
}

async function setProp(p, value) {
  try {
    await studio.call('devices:set', current.device.id, p.propertyId, value);
    p.value = value;
    if (current.properties.some((x) => x.dependsOn && x.dependsOn[0] === p.propertyId)) render();
  } catch (e) {
    toast(`${p.name}: ${e.message}`, true);
  }
}

function control(p) {
  const wrap = el('div', { class: `ctrl${isDisabled(p) ? ' disabled' : ''}`, 'data-prop': p.propertyId });
  const label = el('label', {}, p.name);
  const val = el('span', { class: 'val' }, fmtValue(p, p.value));
  const disabled = isDisabled(p);
  if (p.dataType === 'bool') {
    const cb = el('input', { type: 'checkbox', disabled });
    cb.checked = !!p.value;
    cb.addEventListener('change', () => setProp(p, cb.checked));
    wrap.append(label, cb);
  } else if (p.dataType === 'enum') {
    const sel = el('select', { disabled }, (p.valueInfo.values || []).map((o) => el('option', { value: o.value }, o.displayName)));
    sel.value = p.value;
    sel.addEventListener('change', () => setProp(p, Number(sel.value)));
    wrap.append(label, sel);
  } else {
    const vi = p.valueInfo || {};
    const r = el('input', { type: 'range', min: vi.min ?? 0, max: vi.max ?? 100, step: vi.stepSize || 1, disabled });
    r.value = p.value ?? vi.min ?? 0;
    const send = debounce((v) => setProp(p, v), 60);
    r.addEventListener('input', () => { val.textContent = fmtValue(p, Number(r.value)); send(Number(r.value)); });
    wrap.append(label, val, r);
  }
  if (p.canReset) {
    const reset = el('button', { class: 'reset', title: 'Reset to default' }, '↺');
    reset.addEventListener('click', async () => {
      await studio.call('devices:reset', current.device.id, p.propertyId).catch((e) => toast(e.message, true));
      await load(current.device);
    });
    if (p.dataType !== 'int') {
      wrap.classList.add('with-reset');
      wrap.append(reset);
    } else {
      label.append(' ', reset);
    }
  }
  return wrap;
}

function render() {
  const box = $('#device-controls');
  box.innerHTML = '';
  if (!current) return;
  for (const cat of current.categories) {
    const props = current.properties.filter((p) => p.categoryId === cat.categoryId);
    const acts = current.actions.filter((a) => a.categoryId === cat.categoryId);
    if (!props.length && !acts.length) continue;
    const head = el('h3', {}, cat.name);
    const g = el('div', { class: 'group' }, head);
    if (cat.canReset && props.length) {
      const r = el('button', { class: 'reset small', title: `Reset ${cat.name}` }, 'Reset');
      r.addEventListener('click', async () => {
        await studio.call('devices:resetCategory', current.device.id, cat.categoryId).catch((e) => toast(e.message, true));
        await load(current.device);
      });
      head.append(' ', r);
    }
    props.forEach((p) => g.append(control(p)));
    for (const a of acts) {
      const b = el('button', {}, a.name);
      b.addEventListener('click', async () => {
        try { await studio.call('devices:invoke', current.device.id, a.actionId); toast(`${a.name}: done`); } catch (e) { toast(e.message, true); }
      });
      g.append(b);
    }
    box.append(g);
  }
  if (!box.children.length) box.append(el('p', { class: 'muted small' }, 'No adjustable settings were found for this device.'));
}

async function renderPresets() {
  const picker = $('#preset-picker');
  const presets = await studio.call('devices:presets', current.device.id).catch(() => ({}));
  picker.innerHTML = '';
  picker.append(el('option', { value: '' }, 'Presets…'), ...Object.keys(presets).map((n) => el('option', { value: n }, n)));
  picker.onchange = async () => {
    const values = presets[picker.value];
    if (!values) return;
    for (const [k, v] of Object.entries(values)) await studio.call('devices:set', current.device.id, k, v).catch(() => {});
    toast(`Applied preset "${picker.value}"`);
    await load(current.device);
  };
  $('#btn-preset-save').onclick = async () => {
    const name = await ask('Preset name');
    if (!name) return;
    const values = Object.fromEntries(current.properties.filter((p) => p.value !== null && p.value !== undefined).map((p) => [p.propertyId, p.value]));
    await studio.call('devices:presetSave', current.device.id, name, values);
    renderPresets();
  };
  $('#btn-preset-delete').onclick = async () => {
    if (!picker.value) return;
    await studio.call('devices:presetDelete', current.device.id, picker.value);
    renderPresets();
  };
}

async function renderInfo() {
  const info = await studio.call('devices:info', current.device.id).catch(() => null);
  const box = $('#device-info');
  box.innerHTML = '';
  if (!info) return;
  const lines = [
    `Video node: ${info.videoNode || 'none'}`,
    info.controlHid ? `Control channel: ${info.controlHid}` : null,
    info.speedMbps ? `USB link: ${info.speedMbps >= 5000 ? `${info.speedMbps / 1000} Gbps` : `${info.speedMbps} Mbps`}` : null,
    info.firmware ? `Firmware: ${info.firmware}` : null,
    info.signal ? `Input: ${info.signal.hasSignal ? `${info.signal.width}×${info.signal.height} @ ${info.signal.framerate} Hz` : 'no signal'}` : null,
    info.passthroughMonitor !== undefined && info.passthroughMonitor !== null ? `Pass-through monitor: ${info.passthroughMonitor ? 'connected' : 'not connected'}` : null,
    info.helper ? null : 'Native helper not built: extended controls are unavailable.',
  ].filter(Boolean);
  lines.forEach((l) => box.append(el('div', {}, l)));
  const warn = $('#usb-warning');
  warn.hidden = true;
  if (info.usb2Fallback || (info.kind === 'capture' && info.speedMbps && info.speedMbps < 5000)) {
    warn.textContent = 'Connected over USB 2.0 — use a USB 3 port for full quality';
    warn.hidden = false;
  }
}

// Custom EDID: off = the card's default EDID, on = one of Elgato's presets or a file. Choosing
// one writes it to the card straight away (verified chunk by chunk), as Elgato Studio does.
let edidState = null; // { presets, active, lastCustom }
const FILE = '__file__';
const FROM_FILE = '__current_file__';

async function edid() {
  const sec = $('#edid-section');
  const device = current.device;
  sec.hidden = !(device.kind === 'capture' && device.features.customEdid && device.controlHid);
  $('#btn-edid-backup').onclick = async () => {
    try { const f = await studio.call('edid:backup', device.id); if (f) toast(`EDID saved to ${f}`); } catch (e) { toast(e.message, true); }
  };
  if (sec.hidden) return;
  const status = $('#edid-status');
  status.textContent = 'Loading EDID presets…';
  try {
    edidState = await studio.call('edid:presets', device.id);
    status.textContent = '';
  } catch (e) {
    edidState = null;
    status.textContent = `EDID presets unavailable: ${e.message}`;
  }
  if (!current || current.device.id !== device.id) return;
  renderEdid();
}

function renderEdid() {
  const toggle = $('#edid-custom');
  const sel = $('#edid-preset');
  const st = edidState || { presets: [], active: null, lastCustom: null };
  const def = st.presets.find((p) => p.type === 'default');
  const customs = st.presets.filter((p) => p.type === 'custom');
  const isDefault = def && st.active === def.id;
  toggle.checked = !isDefault;
  toggle.disabled = !def;
  sel.disabled = isDefault;

  sel.innerHTML = '';
  const group = el('optgroup', { label: 'Elgato' }, st.presets.map((p) => el('option', { value: p.id }, p.name)));
  sel.append(group);
  if (!st.active) sel.append(el('option', { value: FROM_FILE }, 'Custom file (on the card now)'));
  sel.append(el('option', { value: FILE }, 'Select file…'));
  sel.value = st.active || FROM_FILE;
  if (isDefault) sel.value = (customs.find((p) => p.id === st.lastCustom) || customs[0] || def).id;
  sel.dataset.prev = sel.value;

  toggle.onchange = async () => {
    if (!toggle.checked) {
      await applyEdid(def.id);
    } else {
      const pick = customs.find((p) => p.id === st.lastCustom) || customs[0];
      if (pick) await applyEdid(pick.id); else renderEdid();
    }
  };
  sel.onchange = async () => {
    if (sel.value === FROM_FILE) return;
    if (sel.value === FILE) {
      const prog = $('#edid-progress');
      prog.hidden = false;
      try {
        const f = await studio.call('edid:writeFile', current.device.id);
        if (f) toast('EDID written and verified');
      } catch (e) { toast(e.message, true); }
      prog.hidden = true;
      await edid();
      return;
    }
    await applyEdid(sel.value);
  };
}

async function applyEdid(presetId) {
  const device = current.device;
  const prog = $('#edid-progress');
  const status = $('#edid-status');
  $('#edid-custom').disabled = true;
  $('#edid-preset').disabled = true;
  prog.value = 0;
  prog.hidden = false;
  status.textContent = 'Writing EDID… keep the card plugged in.';
  try {
    const name = await studio.call('edid:applyPreset', device.id, presetId);
    toast(`EDID set to ${name}`);
  } catch (e) {
    toast(`EDID: ${e.message}`, true);
  }
  prog.hidden = true;
  status.textContent = '';
  if (current && current.device.id === device.id) await edid();
}

studio.on('edid:progress', (p) => { $('#edid-progress').value = p; });
studio.on('device:propertyChanged', ({ deviceId, propertyId, value }) => {
  if (!current || deviceId !== current.device.id) return;
  const p = current.properties.find((x) => x.propertyId === propertyId);
  if (p) { p.value = value; render(); }
});
studio.on('device:propertiesChanged', (id) => { if (current && id === current.device.id) load(current.device); });

export function setTitle(device) {
  $('#device-title').textContent = device ? device.displayName || device.name : 'No device';
}

export async function load(device) {
  setTitle(device);
  $('#device-sub').textContent = device ? (device.kind === 'capture' ? 'Capture device' : device.kind === 'camera' ? 'Camera' : 'Webcam') : '';
  $('#presets').hidden = !device;
  const token = ++loadToken;
  if (!device) { current = null; render(); return; }
  let next;
  try {
    const r = await studio.call('devices:properties', device.id);
    next = { device, ...r };
  } catch (e) {
    next = { device, properties: [], categories: [], actions: [] };
    if (token === loadToken) toast(e.message, true);
  }
  // A newer load (the user switched devices meanwhile) wins.
  if (token !== loadToken) return;
  current = next;
  render();
  renderPresets();
  renderInfo();
  edid();
}

export function setHud(on) {
  clearInterval(hudTimer);
  const hud = $('#hud');
  hud.hidden = !on;
  if (!on || !current) return;
  const tick = async () => {
    const live = await studio.call('devices:live', current.device.id).catch(() => ({}));
    const parts = [];
    if (live.iso !== undefined) parts.push(`ISO ${live.iso}`);
    if (live.shutter) parts.push(`1/${Math.round(10000 / live.shutter)}`);
    if (live.whiteBalance) parts.push(`${live.whiteBalance} K`);
    if (live.focus !== undefined) parts.push(`F ${live.focus}`);
    hud.textContent = parts.join('   ') || 'No live data from this device';
  };
  tick();
  hudTimer = setInterval(tick, 1000);
}
