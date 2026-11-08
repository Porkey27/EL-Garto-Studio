// Firmware updates in the app (Game Capture 4K S): an update check when the card is selected, a
// dot on the device-details button when an update is available, and the update dialog.
import { $, el, toast } from './util.js';
import * as live from './live.js';

const { studio } = window;

const results = new Map(); // deviceId -> last check result
const notified = new Set();
let ctx = { reopen: async () => {} };
let running = false;

export function init(c) { ctx = c; }
export const lastResult = (device) => (device ? results.get(device.id) : null);
export const isRunning = () => running;

const trim = (v) => (v ? v.split('.').map((x) => String(Number(x))).join('.') : '?');

export async function check(device, { quiet = false } = {}) {
  if (!device || device.type !== '4K_S') { updateBadge(device); return null; }
  let r;
  try {
    r = await studio.call('firmware:check', device.id);
  } catch (e) {
    if (!quiet) toast(`Firmware check: ${e.message}`, true);
    return null;
  }
  results.set(device.id, r);
  updateBadge(device);
  if (r.updateAvailable && quiet && !notified.has(device.id)) {
    notified.add(device.id);
    toast(r.resume || r.baseInterrupted
      ? `${device.displayName || device.name}: a firmware update was interrupted. Open device details (⚙) to finish it.`
      : `Firmware update available for ${device.displayName || device.name}. Open device details (⚙) to install it.`);
  }
  return r;
}

export function updateBadge(device) {
  const r = device && results.get(device.id);
  $('#btn-device-info').classList.toggle('has-update', !!(r && r.updateAvailable));
}

// Firmware block for the device-details pop-up.
export function infoBlock(device, onOpen) {
  if (!device || device.type !== '4K_S') return null;
  const box = el('div', { class: 'fw-block' });
  const render = (r) => {
    box.innerHTML = '';
    if (!r) { box.append(el('div', { class: 'muted small' }, 'Checking for firmware updates…')); return; }
    if (!r.supported) { box.append(el('div', { class: 'muted small' }, r.reason)); return; }
    if (r.busy) { box.append(el('div', { class: 'muted small' }, 'Firmware update in progress…')); return; }
    if (r.updateAvailable) {
      const what = r.resume || r.baseInterrupted ? 'An earlier update did not finish.'
        : `Update available: ${[r.parts.mcu && `MCU ${trim(r.latest.mcu)}`, r.parts.base && `Base ${trim(r.latest.base)}`].filter(Boolean).join(', ')}`;
      box.append(el('div', { class: 'fw-available' }, what),
        el('button', { class: 'primary', onclick: () => { onOpen(); openDialog(device); } }, r.resume || r.baseInterrupted ? 'Finish update…' : 'Update firmware…'));
    } else {
      box.append(el('div', { class: 'muted small' }, 'Firmware is up to date.'),
        el('button', { class: 'link small', onclick: () => { onOpen(); openDialog(device, { force: true }); } }, 'Reinstall…'));
    }
  };
  render(results.get(device.id));
  check(device, { quiet: true }).then(render);
  return box;
}

// ---- dialog ---------------------------------------------------------------------------

function modal() {
  let m = $('#fw-modal');
  if (!m) {
    m = el('div', { id: 'fw-modal', class: 'modal', hidden: true });
    document.body.append(m);
  }
  return m;
}

export async function openDialog(device, { force = false } = {}) {
  if (running) return;
  const m = modal();
  m.innerHTML = '';
  const box = el('div', { class: 'modal-box' });
  m.append(box);
  m.hidden = false;

  const r = results.get(device.id) || await check(device);
  if (!r || !r.supported) { box.append(el('p', {}, (r && r.reason) || 'Could not check this card.'), closeButton(m)); return; }

  const name = device.displayName || device.name;
  const doMcu = r.parts.mcu || (force && !r.resume);
  const doBase = r.parts.base || (force && !r.resume);
  const versionLine = (label, have, want, on) => el('div', { class: 'fw-row' },
    el('span', {}, label), el('span', { class: 'muted' }, have ? trim(have) : '?'), el('span', {}, on ? `→ ${trim(want)}` : 'unchanged'));

  box.append(el('h2', {}, `Firmware update · ${name}`));
  box.append(el('div', { class: 'fw-versions' },
    el('div', { class: 'fw-row head' }, el('span', {}, ''), el('span', {}, 'Installed'), el('span', {}, 'New')),
    versionLine('MCU', r.current.mcu, r.latest.mcu, doMcu),
    versionLine('Base', r.current.base, r.latest.base, doBase)));
  if (r.baseInterrupted) box.append(el('p', { class: 'fw-warn' }, "An earlier Base update didn't finish. The card works while it stays powered, but write the Base part again before unplugging it."));
  if (r.resume) box.append(el('p', { class: 'fw-warn' }, 'An earlier update stopped part-way: the card is waiting in its bootloader. The MCU part will be written again; run the update once more afterwards if the Base part is still out of date.'));

  const steps = el('ol', { class: 'fw-steps' });
  if (doMcu) steps.append(el('li', { 'data-step': 'mcu' }, 'Write the MCU firmware (about 1 minute), then replug the card'));
  if (doBase) steps.append(el('li', { 'data-step': 'base' }, 'Write and verify the Base firmware (about 30 seconds), then replug the card'));
  box.append(steps);
  box.append(el('ul', { class: 'fw-notes muted small' },
    el('li', {}, 'Keep the USB cable plugged in until the app asks you to unplug it.'),
    el('li', {}, "Don't close the app during the update. The HDMI input can stay connected."),
    el('li', {}, 'The preview pauses while the card updates.')));

  const status = el('div', { class: 'fw-status' });
  const bar = el('progress', { max: 1, value: 0, hidden: true });
  const replug = el('div', { class: 'fw-replug', hidden: true });
  const buttons = el('div', { class: 'row fw-buttons' });
  const cancel = el('button', { onclick: () => { m.hidden = true; } }, 'Cancel');
  const start = el('button', { class: 'primary' }, force && !r.updateAvailable ? 'Reinstall' : 'Update');
  buttons.append(el('span', { class: 'spacer' }), cancel, start);
  box.append(status, bar, replug, buttons);

  start.onclick = async () => {
    if (live.isRecording()) { toast('Stop the recording first.', true); return; }
    running = true;
    start.disabled = true;
    cancel.disabled = true;
    status.textContent = 'Starting…';
    await live.openDevice(null); // release the card's video while it updates
    const off = studio.on('firmware:event', (ev) => {
      if (ev.event === 'status') status.textContent = ev.message || '';
      if (ev.event === 'progress') {
        bar.hidden = false;
        bar.value = ev.fraction;
        const label = { 'mcu-erase': 'Erasing the MCU', 'mcu-write': 'Writing the MCU', 'base-write': 'Writing the Base', 'base-sections': 'Writing the Base' }[ev.phase] || ev.phase;
        status.textContent = `${label}… ${Math.round(ev.fraction * 100)}%`;
      }
      if (ev.event === 'step') {
        const li = steps.querySelector(`[data-step="${ev.step}"]`);
        if (li) li.className = ev.state === 'done' ? 'done' : 'active';
        bar.value = 0;
      }
      if (ev.event === 'replug') {
        replug.hidden = ev.state === 'done';
        replug.textContent = ev.state === 'waiting-plug' ? 'Unplugged. Now plug the card back into the same port…' : ev.message;
        if (ev.state !== 'done') bar.hidden = true;
      }
    });
    try {
      const out = await studio.call('firmware:update', device.id, { force });
      replug.hidden = true;
      bar.hidden = true;
      status.textContent = out.updated
        ? `Done. The card now runs MCU ${trim(out.versions.mcu)}, Base ${trim(out.versions.base)}.`
        : 'Nothing to update.';
      status.classList.add('ok');
      results.delete(device.id);
      notified.delete(device.id);
    } catch (e) {
      status.textContent = `Update stopped: ${e.message}`;
      status.classList.add('error');
      replug.hidden = true;
    } finally {
      off();
      running = false;
      buttons.innerHTML = '';
      buttons.append(el('span', { class: 'spacer' }), closeButton(m));
      await ctx.reopen().catch(() => {});
      check(device, { quiet: true });
    }
  };
}

function closeButton(m) {
  return el('button', { class: 'primary', onclick: () => { m.hidden = true; } }, 'Close');
}
