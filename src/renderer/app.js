import { $, $$, el, toast } from './util.js';
import * as live from './live.js';
import * as panel from './devicepanel.js';
import * as library from './library.js';
import * as prompterUi from './prompter-ui.js';
import * as recording from './recording.js';
import * as popovers from './popovers.js';
import * as firmware from './firmware.js';
import * as themeUi from './theme-ui.js';

const { studio } = window;

let devices = [];
let active = null;
let settings = {};
let cameraLabel = null;

function showView(name) {
  $$('.nav').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${name}`));
  if (name === 'library') library.refresh();
}

function renderDevicePicker() {
  const sel = $('#device-picker');
  sel.innerHTML = '';
  if (!devices.length) sel.append(el('option', { value: '' }, 'No devices connected'));
  for (const d of devices) sel.append(el('option', { value: d.id }, (d.displayName || d.name) + (d.pcie ? ' (no Linux driver)' : '')));
  if (active) sel.value = active.id;
}

async function renderFormats(device) {
  const sel = $('#format-picker');
  sel.innerHTML = '';
  sel.append(el('option', { value: '' }, 'Best available'));
  if (!device) return;
  const formats = await studio.call('devices:formats', device.id).catch(() => []);
  const seen = new Set();
  for (const f of formats) {
    for (const s of f.sizes) {
      for (const fps of s.fps) {
        const key = `${s.width}x${s.height}@${fps}`;
        if (seen.has(key)) continue;
        seen.add(key);
        sel.append(el('option', { value: JSON.stringify({ width: s.width, height: s.height, fps }) }, `${s.width}×${s.height} @ ${Math.round(fps)} fps (${f.fourcc})`));
      }
    }
  }
}

async function renderAudioPicker() {
  const sel = $('#audio-picker');
  const prev = sel.value || 'auto';
  sel.innerHTML = '';
  sel.append(el('option', { value: 'auto' }, 'Device audio'), el('option', { value: 'none' }, 'No audio'));
  for (const a of await live.listAudioInputs()) sel.append(el('option', { value: a.deviceId }, a.label || 'Audio input'));
  sel.value = prev;
}

async function selectDevice(id) {
  active = devices.find((d) => d.id === id) || null;
  if (active) await studio.call('devices:select', active.id);
  renderDevicePicker();
  live.setFormat(null);
  await Promise.all([renderFormats(active), live.openDevice(active, { audioDeviceId: $('#audio-picker').value || 'auto' })]);
  panel.load(active);
  firmware.updateBadge(active);
  if (active) firmware.check(active, { quiet: true });
  const md = active ? await live.findMediaDevice('videoinput', active) : null;
  cameraLabel = md ? md.label : null;
  prompterUi.refreshCameraLabel();
}

async function refreshDevices(list) {
  devices = list || (await studio.call('devices:list'));
  const stillThere = active && devices.find((d) => d.id === active.id);
  // The card leaves USB during a firmware update; stay on it rather than switching devices.
  if (firmware.isRunning()) { renderDevicePicker(); return; }
  renderDevicePicker();
  if (!stillThere) {
    const want = await studio.call('devices:active');
    await selectDevice(want || (devices[0] && devices[0].id));
  }
}

function bindTransport() {
  $('#btn-record').addEventListener('click', () => live.toggleRecording());
  $('#btn-snapshot').addEventListener('click', () => live.snapshot().catch((e) => toast(e.message, true)));
  $('#btn-flashback').addEventListener('click', () => live.saveFlashback());
  $('#btn-mute').addEventListener('click', () => { live.setMuted(!live.isMuted()); studio.call('settings:set', 'previewMuted', live.isMuted()); });
  $('#volume').addEventListener('input', (e) => live.setVolume(Number(e.target.value) / 100));
  $('#volume').addEventListener('change', (e) => studio.call('settings:set', 'previewVolume', Number(e.target.value) / 100));
  $('#btn-hud').addEventListener('click', (e) => { const on = !e.target.classList.contains('on'); e.target.classList.toggle('on', on); panel.setHud(on); });
  $('#btn-grid').addEventListener('click', (e) => { const on = !e.target.classList.contains('on'); e.target.classList.toggle('on', on); $('#frame-grid').hidden = !on; });
  $('#btn-multiview').addEventListener('click', () => live.toggleMultiview(devices.filter((d) => !d.pcie)));
  $('#btn-vcam').addEventListener('click', () => live.toggleVirtualCamera().catch((e) => toast(e.message, true)));
  $('#btn-vmic').addEventListener('click', () => live.toggleVirtualMic());
  $('#btn-fullscreen').addEventListener('click', () => {
    const on = !document.fullscreenElement;
    if (on) $('#preview-wrap').requestFullscreen(); else document.exitFullscreen();
  });
  document.addEventListener('fullscreenchange', () => studio.setFullscreen(!!document.fullscreenElement));
  $('#preview').addEventListener('dblclick', () => $('#btn-fullscreen').click());

  $('#device-picker').addEventListener('change', (e) => selectDevice(e.target.value));
  $('#format-picker').addEventListener('change', async (e) => {
    const f = e.target.value ? JSON.parse(e.target.value) : null;
    live.setFormat(f);
    await live.openDevice(active, { format: f });
  });
  $('#audio-picker').addEventListener('change', (e) => live.openDevice(active, { audioDeviceId: e.target.value }));

  // Commands from the tray, global shortcuts and the WebSocket API.
  studio.on('remote:record', (on) => live.toggleRecording(on));
  studio.on('remote:snapshot', () => live.snapshot().catch((e) => toast(e.message, true)));
  studio.on('remote:flashback', () => live.saveFlashback());
  studio.on('remote:preview', (p) => {
    if (p.volumePercentage !== undefined) live.setVolume(p.volumePercentage / 100);
    if (p.isMuted !== undefined) live.setMuted(p.isMuted);
    if (p.isFullscreen !== undefined && p.isFullscreen !== !!document.fullscreenElement) $('#btn-fullscreen').click();
  });
  studio.on('devices:changed', (list) => refreshDevices(list));
  studio.on('app:error', (msg) => toast(msg, true));
  navigator.mediaDevices.addEventListener('devicechange', renderAudioPicker);
}

async function initSettings() {
  const s = settings;
  $('#s-dir').value = s.recordingsDir;
  $('#btn-s-dir').addEventListener('click', async () => { $('#s-dir').value = await studio.call('library:chooseDir'); });
  const bind = (id, key, cast = (v) => v, prop = 'value') => {
    const input = $(id);
    input[prop] = s[key];
    input.addEventListener('change', async () => {
      settings = await studio.call('settings:set', key, cast(input[prop]));
      live.setSettings(settings);
    });
  };
  bind('#s-container', 'container');
  bind('#s-abr', 'audioBitrateKbps', Number);
  bind('#s-flashback', 'flashbackMinutes', Number);
  bind('#s-ws-limit', 'limitWebSocketToStreamDeck', Boolean, 'checked');
  bind('#s-tray', 'keepRunningInTray', Boolean, 'checked');

  const vcams = await studio.call('vcam:devices').catch(() => []);
  const vsel = $('#s-vcam');
  vsel.innerHTML = '';
  if (!vcams.length) vsel.append(el('option', { value: '' }, 'None found'));
  for (const v of vcams) vsel.append(el('option', { value: v }, v));
  vsel.value = s.vcamDevice || vcams[0] || '';
  vsel.addEventListener('change', async () => { settings = await studio.call('settings:set', 'vcamDevice', vsel.value); live.setSettings(settings); });

  const sc = s.shortcuts || {};
  const scMap = { '#s-sc-record': 'record', '#s-sc-snapshot': 'snapshot', '#s-sc-flashback': 'flashback', '#s-sc-prompter': 'prompterToggle' };
  for (const [id, key] of Object.entries(scMap)) {
    const input = $(id);
    input.value = sc[key] || input.placeholder;
    input.addEventListener('change', async () => {
      const next = { ...(settings.shortcuts || {}) };
      for (const [i2, k2] of Object.entries(scMap)) next[k2] = $(i2).value.trim();
      settings = await studio.call('settings:set', 'shortcuts', next);
    });
  }

  const info = await studio.call('app:info');
  // v4l2loopback is Linux-only; Windows users can use OBS's virtual camera instead.
  $('#btn-vcam').hidden = !info.features.virtualCamera;
  $('#vcam-settings').hidden = !info.features.virtualCamera;
  $('#btn-vmic').hidden = !(info.platform === 'linux' && await studio.call('vmic:available').catch(() => false));
  $('#s-ws-port').textContent = info.wsPort ? `Listening on 127.0.0.1:${info.wsPort} (port published in ${info.userData}/ws-info.json)` : 'WebSocket server is not running';
  $('#s-about').innerHTML = '';
  $('#s-about').append(
    el('div', {}, `${info.name} ${info.version}`),
    el('div', {}, info.helper ? 'Native control helper: installed' : 'Native control helper: missing — run `npm run build:native` for camera/capture-card extended controls'),
    el('div', {}, 'Unofficial project, not affiliated with Elgato or Corsair.'),
  );
}

async function main() {
  settings = await studio.call('settings:all');
  themeUi.init(settings.theme); // first, so the window never flashes the default colours
  live.setSettings(settings);
  recording.initPanel({
    settings,
    source: () => live.sourceFormat(),
    hdr: () => live.hdrStatus(),
    onChange: (next) => { settings = next; live.setSettings(settings); popovers.updateSignalButton(); },
  });
  firmware.init({
    // After an update: reselect the card (its id is unchanged) and reload its settings.
    reopen: async () => {
      devices = await studio.call('devices:list');
      const back = active && devices.find((d) => d.id === active.id);
      await selectDevice(back ? back.id : (devices[0] && devices[0].id));
    },
  });
  popovers.init({
    device: () => active,
    settings: () => settings,
    onRename: (d) => { renderDevicePicker(); panel.setTitle(d); },
  });
  // The size estimate depends on the source format, which is only known once video arrives.
  $('#preview').addEventListener('resize', () => recording.update(settings));
  $$('.nav').forEach((b) => b.addEventListener('click', () => showView(b.dataset.view)));
  bindTransport();
  library.init();
  await initSettings();
  await renderAudioPicker();
  await refreshDevices();
  await prompterUi.init(settings, () => cameraLabel);
}

main().catch((e) => toast(e.message, true));
