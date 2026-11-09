'use strict';

const { app, BrowserWindow, ipcMain, shell, dialog, Tray, Menu, nativeImage, globalShortcut, powerSaveBlocker, screen } = require('electron');
const fs = require('fs');
const path = require('path');
const { pathToFileURL, fileURLToPath } = require('url');

const { DeviceMonitor } = require('./devices/discovery');
const { CameraController, CATEGORIES } = require('./devices/camera');
const { CaptureController, CAPTURE_CATEGORIES } = require('./devices/capture');
const platform = require('./platform');
const { Settings } = require('./settings');
const { Library } = require('./library');
const { Recorder } = require('./recorder');
const { StudioRpcServer, RpcError } = require('./wsserver');
const { ScriptStore } = require('./prompter/scripts');
const assets = require('./elgato-assets');
const virtualMic = require('./virtual-mic');
const { FirmwareFlow } = require('./firmware/flow');
const hdr = require('./hdr');

// V4L2 capture needs these on some distros; harmless elsewhere.
app.commandLine.appendSwitch('enable-features', 'WebRTCPipeWireCapturer,VaapiVideoDecoder,VaapiVideoEncoder');
// Play audio from the app's own process, labelled with the app's name. Chromium normally plays it
// from a separate "audio service" helper process (and on Linux labels the stream "Chromium"), so
// apps that capture a shared window's sound (Discord's screen share, OBS's Application Audio
// Capture) can't tie the sound to El-Garto Studio's window and stream silence.
app.commandLine.appendSwitch('disable-features', 'AudioServiceOutOfProcess');
if (process.platform === 'linux') {
  // libpulse (also used through PipeWire's pulse layer) applies these to every stream we open.
  process.env.PULSE_PROP_OVERRIDE = 'application.name="El-Garto Studio" application.icon_name="el-garto-studio"';
}

// Windows groups taskbar buttons and picks their icon by this ID (matches build.appId).
if (process.platform === 'win32') app.setAppUserModelId('io.github.porkey27.el-garto-studio');
// The app used to be called "Studio for Elgato" (and briefly "El-Gato" / "El-Gato Studio"), and its data folder is named after the app. On the
// first start after the rename, copy settings, themes and prompter scripts across (not caches).
function migrateUserData() {
  const now = app.getPath('userData');
  const old = ['El-Gato Studio', 'Studio for Elgato', 'El-Gato'].map((n) => path.join(app.getPath('appData'), n))
    .find((d) => d !== now && fs.existsSync(path.join(d, 'settings.json')));
  if (!old || fs.existsSync(path.join(now, 'settings.json'))) return;
  const skip = new Set(['Cache', 'Code Cache', 'GPUCache', 'DawnGraphiteCache', 'DawnWebGPUCache', 'Crashpad', 'blob_storage',
    'Shared Dictionary', 'SingletonLock', 'SingletonCookie', 'SingletonSocket', 'lockfile']);
  try {
    fs.mkdirSync(now, { recursive: true });
    for (const entry of fs.readdirSync(old)) {
      if (skip.has(entry)) continue;
      try { fs.cpSync(path.join(old, entry), path.join(now, entry), { recursive: true, force: false }); } catch { /* skip files in use */ }
    }
    // The theme's background image lives in the data folder: point the saved theme at the copy.
    const file = path.join(now, 'settings.json');
    const text = fs.readFileSync(file, 'utf8');
    fs.writeFileSync(file, text.split(pathToFileURL(old).href).join(pathToFileURL(now).href));
    console.log(`Copied settings from ${old}`);
  } catch (e) {
    console.error(`Could not copy settings from ${old}: ${e.message}`);
  }
}
migrateUserData();
const userData = app.getPath('userData');
const settings = new Settings(userData);
const library = new Library(() => settings.get('recordingsDir'));
const recorder = new Recorder(settings);
const scripts = new ScriptStore(path.join(userData, 'scripts'));
const monitor = new DeviceMonitor(platform.scan, platform.scanIntervalMs);

let mainWindow = null;
let prompterWindow = null;
let tray = null;
let keepAwakeId = null;

// deviceId -> { device, controller }
const sessions = new Map();
let activeDeviceId = null;
// State the renderer owns (preview audio, signal) mirrored here for the RPC API.
const preview = { volumePercentage: 100, isMuted: false, isFullscreen: false, levelLeft: 0, levelRight: 0 };
const signal = { hasSignal: false, width: 0, height: 0, framerate: 0, isHdr: false };
let prompterState = { isScriptPlaying: false, scrollSpeed: 3, scriptName: null, scriptProgress: 0, countdownSec: 3 };

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

function sendPrompter(channel, payload) {
  if (prompterWindow && !prompterWindow.isDestroyed()) prompterWindow.webContents.send(channel, payload);
}

function deviceSummary(d) {
  return {
    id: d.id, name: d.name, kind: d.kind, videoNode: d.videoNode, videoName: d.videoName, controlHid: d.controlHid,
    alsaCard: d.alsaCard, speedMbps: d.speedMbps, usb2Fallback: d.usb2Fallback,
    pcie: !!(d.model && d.model.pcie), features: d.model ? d.model.features || {} : {},
    maxRes: d.model ? d.model.maxRes || [] : [], type: d.model ? d.model.type : 'GENERIC',
    serial: d.serial || null, pid: d.pid || null, usb2Pid: d.model ? d.model.usb2Pid || null : null,
    displayName: (settings.get('deviceNames') || {})[d.id] || null,
  };
}

function controllerFor(d) {
  if (d.kind === 'capture') return new CaptureController(d);
  return new CameraController(d); // Elgato cameras and generic UVC webcams
}

function syncSessions(list) {
  const ids = new Set(list.map((d) => d.id));
  for (const id of sessions.keys()) if (!ids.has(id)) sessions.delete(id);
  for (const d of list) {
    const s = sessions.get(d.id);
    if (!s || s.device.videoNode !== d.videoNode) sessions.set(d.id, { device: d, controller: controllerFor(d), ready: null });
  }
  if (!sessions.has(activeDeviceId)) activeDeviceId = sessions.has(settings.get('lastDeviceId')) ? settings.get('lastDeviceId') : (list[0] ? list[0].id : null);
}

// Serial of the card being updated: nothing else may talk to it until the update finishes.
let firmwareBusy = null;

async function session(deviceId) {
  const s = sessions.get(deviceId || activeDeviceId);
  if (!s) throw new RpcError('invalidState');
  if (firmwareBusy && s.device.serial === firmwareBusy) throw new Error('A firmware update is in progress on this card.');
  if (!s.ready) s.ready = s.controller.refresh().catch((e) => { s.ready = null; throw e; });
  await s.ready;
  return s;
}

function categoriesFor(s) {
  return s.device.kind === 'capture' ? CAPTURE_CATEGORIES : CATEGORIES;
}

async function propertiesWithValues(s) {
  const desc = s.controller.describe();
  for (const p of desc) {
    try { p.value = await s.controller.get(p.propertyId); } catch { p.value = null; }
  }
  return desc;
}

// ---- Application API shared by IPC and the JSON-RPC server --------------------------

const api = {
  appInfo: () => ({
    appID: 'studio-linux', operatingSystem: 'linux', name: 'El-Garto Studio',
    version: app.getVersion(), build: 0, interfaceRevision: 2,
  }),
  recordingInfo: () => {
    const st = recorder.status();
    return {
      isRecording: st.isRecording, isRecordingAllowed: !!activeDeviceId,
      recordingDurationSec: st.durationSec, recordingSizeBytes: st.sizeBytes, usedDiskPercentage: diskUsedPercent(),
    };
  },
  setRecording: async (on) => {
    if (!activeDeviceId) throw new RpcError('invalidState');
    send('remote:record', !!on);
    return { isRecording: !!on };
  },
  takeSnapshot: () => new Promise((resolve, reject) => {
    if (!activeDeviceId) return reject(new RpcError('invalidState'));
    pendingSnapshot = { resolve, reject };
    send('remote:snapshot');
    setTimeout(() => { if (pendingSnapshot) { pendingSnapshot.reject(new RpcError('invalidState')); pendingSnapshot = null; } }, 5000);
    return undefined;
  }),
  lastRecordingInfo: async () => {
    const last = library.last();
    if (!last) return {};
    let thumb = null;
    try {
      const p = await (last.type === 'video' ? library.thumbnail(last.path, 249) : Promise.resolve(last.path));
      thumb = { width: 249, height: 140, data: fs.readFileSync(p).toString('base64') };
    } catch { /* no thumbnail */ }
    return { recordingItemType: last.type === 'video' ? 'videoRecording' : 'snapshot', recordingItemThumbnail: thumb, recordingItemName: last.name };
  },
  openStorage: () => { shell.openPath(library.dir()); return {}; },
  signalInfo: () => ({
    hasSignal: signal.hasSignal,
    video: signal.hasSignal ? { width: signal.width, height: signal.height, framerate: signal.framerate, isHdr: signal.isHdr } : null,
  }),
  previewInfo: () => ({
    volumePercentage: preview.volumePercentage, isMuted: preview.isMuted, isFullscreen: preview.isFullscreen,
    audio: { levelLeftPercentage: preview.levelLeft, levelRightPercentage: preview.levelRight },
  }),
  setPreview: (p) => { send('remote:preview', p); Object.assign(preview, p); return api.previewInfo(); },
  devices: () => ({
    devices: [...sessions.values()].map(({ device }) => ({
      deviceId: device.id, deviceClass: device.kind === 'capture' ? 'capture' : 'camera',
      deviceType: device.model ? device.model.type : 'GENERIC', name: device.name,
      status: device.videoNode ? 'ready' : 'unavailable',
    })).concat(prompterWindow ? [{ deviceId: 'prompter', deviceClass: 'prompter', deviceType: 'VIRTUAL_PROMPTER', name: 'Prompter', status: 'ready' }] : []),
  }),
  supportedProperties: async (deviceId) => {
    if (deviceId === 'prompter') return { deviceId, properties: prompterProperties(), categories: [] };
    const s = await session(deviceId);
    return { deviceId, properties: await propertiesWithValues(s), categories: categoriesFor(s) };
  },
  supportedActions: async (deviceId) => {
    if (deviceId === 'prompter') return { deviceId, actions: PROMPTER_ACTIONS, categories: [] };
    const s = await session(deviceId);
    return { deviceId, actions: s.controller.actions(), categories: categoriesFor(s) };
  },
  getProperty: async (deviceId, propertyId) => {
    if (deviceId === 'prompter') return { deviceId, propertyId, value: prompterState[propertyId] };
    const s = await session(deviceId);
    return { deviceId, propertyId, value: await s.controller.get(propertyId) };
  },
  setProperty: async (deviceId, propertyId, value) => {
    if (deviceId === 'prompter') { sendPrompterCommand({ type: 'set', key: propertyId, value }); return {}; }
    const s = await session(deviceId);
    await s.controller.set(propertyId, value);
    propertyChanged(s.device.id, propertyId, value);
    return {};
  },
  resetProperty: async (deviceId, propertyId) => {
    const s = await session(deviceId);
    await s.controller.reset(propertyId);
    propertyChanged(s.device.id, propertyId, await s.controller.get(propertyId).catch(() => null));
    return {};
  },
  resetCategory: async (deviceId, categoryId) => {
    const s = await session(deviceId);
    await s.controller.resetCategory(categoryId);
    send('device:propertiesChanged', s.device.id);
    return {};
  },
  invokeAction: async (deviceId, actionId, params) => {
    if (deviceId === 'prompter') { sendPrompterCommand({ type: 'action', actionId, params }); return {}; }
    const s = await session(deviceId);
    return { value: (await s.controller.invoke(actionId, params)) ?? null };
  },
};

let pendingSnapshot = null;

const PROMPTER_ACTIONS = [
  { actionId: 'togglePlay', name: 'Play / pause', isEnabled: true },
  { actionId: 'restart', name: 'Back to start', isEnabled: true },
  { actionId: 'speedUp', name: 'Faster', isEnabled: true },
  { actionId: 'speedDown', name: 'Slower', isEnabled: true },
  { actionId: 'nextScript', name: 'Next script', isEnabled: true },
  { actionId: 'previousScript', name: 'Previous script', isEnabled: true },
];

function prompterProperties() {
  return [
    { propertyId: 'isScriptPlaying', name: 'Playing', dataType: 'bool', value: prompterState.isScriptPlaying, valueInfo: { type: 'bool' } },
    { propertyId: 'scrollSpeed', name: 'Scroll speed', dataType: 'int', value: prompterState.scrollSpeed, valueInfo: { type: 'range', min: 1, max: 10, stepSize: 1 } },
    { propertyId: 'scriptName', name: 'Script', dataType: 'string', value: prompterState.scriptName, readOnly: true },
    { propertyId: 'scriptProgress', name: 'Progress', dataType: 'int', value: prompterState.scriptProgress, readOnly: true },
    { propertyId: 'countdownSec', name: 'Countdown', dataType: 'int', value: prompterState.countdownSec, valueInfo: { type: 'range', min: 0, max: 10, stepSize: 1 } },
  ];
}

function sendPrompterCommand(cmd) {
  sendPrompter('prompter:command', cmd);
  send('prompter:command', cmd);
}

function propertyChanged(deviceId, propertyId, value) {
  rpc.notify('propertyChanged', { deviceId, propertyId, value });
  send('device:propertyChanged', { deviceId, propertyId, value });
}

function diskUsedPercent() {
  try {
    const st = fs.statfsSync(library.dir());
    return Math.round(100 * (1 - st.bavail / st.blocks));
  } catch {
    return 0;
  }
}

const rpc = new StudioRpcServer(api, {
  portFile: path.join(userData, 'ws-info.json'),
  limitToStreamDeck: () => settings.get('limitWebSocketToStreamDeck'),
});

// ---- Windows -------------------------------------------------------------------------

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1280, height: 800, minWidth: 900, minHeight: 600, backgroundColor: '#111316',
    title: 'El-Garto Studio', show: false, icon: appIcon() || undefined,
    webPreferences: { preload: path.join(__dirname, '../preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false },
  });
  mainWindow.removeMenu();
  mainWindow.on('close', (e) => {
    if (!firmwareBusy) return;
    e.preventDefault();
    dialog.showMessageBox(mainWindow, { type: 'warning', message: 'A firmware update is in progress.', detail: 'Wait until it finishes before closing the app. Closing now could leave the card needing a recovery update.' });
  });
  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  mainWindow.webContents.on('did-finish-load', () => {
    const t = settings.get('theme');
    if (t && t.uiScale) mainWindow.webContents.setZoomFactor(Math.max(0.7, Math.min(1.6, t.uiScale)));
  });
  mainWindow.once('ready-to-show', () => mainWindow.show());
  if (process.env.EGS_SMOKE_TEST) {
    // CI/dev check: surface renderer errors on stdout and exit after load.
    const logConsole = (tag) => (e) => {
      if (e.level === 'warning' || e.level === 'error') console.log(`${tag} ${e.level}: ${e.message} (${e.sourceId}:${e.lineNumber})`);
    };
    mainWindow.webContents.on('console-message', logConsole('renderer'));
    mainWindow.webContents.once('did-finish-load', () => setTimeout(() => {
      mainWindow.webContents.executeJavaScript('console.error("smoke probe")');
      openPrompterWindow();
      prompterWindow.webContents.on('console-message', logConsole('prompter'));
      // Optional script run in the main window before the screenshot (e.g. to open a pop-up).
      if (process.env.EGS_SMOKE_JS) setTimeout(() => mainWindow.webContents.executeJavaScript(process.env.EGS_SMOKE_JS, true).catch((e) => console.log(`smoke js: ${e.message}`)), 2500);
      setTimeout(async () => {
        if (process.env.EGS_SMOKE_SHOT) {
          fs.writeFileSync(`${process.env.EGS_SMOKE_SHOT}-main.png`, (await mainWindow.webContents.capturePage()).toPNG());
          fs.writeFileSync(`${process.env.EGS_SMOKE_SHOT}-prompter.png`, (await prompterWindow.webContents.capturePage()).toPNG());
        }
        console.log('smoke test done');
        // A normal quit, so the will-quit cleanup (virtual microphone, servers) runs as for users.
        tray = null;
        app.quit();
        setTimeout(() => app.exit(0), 5000).unref();
      }, Number(process.env.EGS_SMOKE_WAIT) || 4000);
    }, 4000));
  }
  mainWindow.on('enter-full-screen', () => { preview.isFullscreen = true; rpc.notify('previewInformationChanged', { isFullscreen: true }); });
  mainWindow.on('leave-full-screen', () => { preview.isFullscreen = false; rpc.notify('previewInformationChanged', { isFullscreen: false }); });
  mainWindow.on('closed', () => { mainWindow = null; });
}

function openPrompterWindow(displayId) {
  if (prompterWindow && !prompterWindow.isDestroyed()) { prompterWindow.focus(); return; }
  const displays = screen.getAllDisplays();
  const target = displays.find((d) => d.id === displayId) || displays.find((d) => d.id !== screen.getPrimaryDisplay().id) || screen.getPrimaryDisplay();
  prompterWindow = new BrowserWindow({
    x: target.bounds.x, y: target.bounds.y, width: Math.min(1280, target.bounds.width), height: Math.min(720, target.bounds.height),
    backgroundColor: '#000000', title: 'Prompter', icon: appIcon() || undefined,
    fullscreen: target.id !== screen.getPrimaryDisplay().id,
    webPreferences: { preload: path.join(__dirname, '../preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false },
  });
  prompterWindow.removeMenu();
  prompterWindow.loadFile(path.join(__dirname, '../renderer/prompter.html'));
  prompterWindow.on('closed', () => { prompterWindow = null; rpc.notify('devicesChanged', api.devices()); send('prompter:windowClosed'); });
  rpc.notify('devicesChanged', api.devices());
}

// Icons live in assets/: icon.png (app and window icon, 512x512 or larger), icon.ico (Windows
// installer/taskbar, optional) and tray.png (+ tray@2x.png for HiDPI; 32x32 / 64x64). Replace those
// files to use your own.
const ASSETS = path.join(__dirname, '../../assets');
function assetImage(...names) {
  for (const n of names) {
    const p = path.join(ASSETS, n);
    if (fs.existsSync(p)) {
      const img = nativeImage.createFromPath(p);
      if (!img.isEmpty()) return img;
    }
  }
  return null;
}
const appIcon = () => assetImage(process.platform === 'win32' ? 'icon.ico' : 'icon.png', 'icon.png');

function trayIcon() {
  const img = assetImage('tray.png') || appIcon();
  if (!img) return nativeImage.createEmpty();
  // Windows draws tray icons at 16 px (32 on HiDPI), Linux panels at 22-24 px.
  const size = process.platform === 'win32' ? 16 : 24;
  return img.getSize().width > size * 2 ? img.resize({ width: size, height: size, quality: 'best' }) : img;
}

function createTray() {
  tray = new Tray(trayIcon());
  const menu = () => Menu.buildFromTemplate([
    { label: recorder.isRecording ? 'Stop recording' : 'Start recording', click: () => send('remote:record', !recorder.isRecording) },
    { label: 'Take snapshot', click: () => send('remote:snapshot') },
    { label: 'Save Flashback', enabled: settings.get('flashbackMinutes') > 0, click: () => send('remote:flashback') },
    { type: 'separator' },
    { label: 'Show Studio', click: () => (mainWindow ? mainWindow.show() : createMainWindow()) },
    { label: 'Open prompter', click: () => openPrompterWindow() },
    { label: 'Open recordings folder', click: () => shell.openPath(library.dir()) },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ]);
  tray.setToolTip('El-Garto Studio');
  tray.setContextMenu(menu());
  recorder.on('changed', () => tray && tray.setContextMenu(menu()));
}

function registerShortcuts() {
  globalShortcut.unregisterAll();
  const map = settings.get('shortcuts') || { record: 'CommandOrControl+Shift+R', snapshot: 'CommandOrControl+Shift+S', flashback: 'CommandOrControl+Shift+F', prompterToggle: 'CommandOrControl+Shift+P' };
  const actions = {
    record: () => send('remote:record', !recorder.isRecording),
    snapshot: () => send('remote:snapshot'),
    flashback: () => send('remote:flashback'),
    prompterToggle: () => sendPrompterCommand({ type: 'action', actionId: 'togglePlay' }),
  };
  for (const [k, accel] of Object.entries(map)) {
    if (accel && actions[k]) {
      try { globalShortcut.register(accel, actions[k]); } catch { /* invalid accelerator or taken */ }
    }
  }
}

// ---- IPC -----------------------------------------------------------------------------

function handle(channel, fn) {
  ipcMain.handle(channel, async (_e, ...args) => {
    try {
      return { ok: true, value: await fn(...args) };
    } catch (e) {
      return { ok: false, error: e.message || String(e) };
    }
  });
}

handle('devices:list', () => [...sessions.values()].map((s) => deviceSummary(s.device)));
handle('devices:active', () => activeDeviceId);
handle('devices:select', (id) => { activeDeviceId = id; settings.set('lastDeviceId', id); return id; });
handle('devices:properties', async (id) => {
  const s = await session(id);
  return { categories: categoriesFor(s), properties: await propertiesWithValues(s), actions: s.controller.actions() };
});
handle('devices:refresh', async (id) => { const s = sessions.get(id); if (s) s.ready = null; return (await session(id)) && true; });
handle('devices:set', (id, prop, value) => api.setProperty(id, prop, value));
handle('devices:reset', (id, prop) => api.resetProperty(id, prop));
handle('devices:resetCategory', (id, cat) => api.resetCategory(id, cat));
handle('devices:invoke', (id, action, params) => api.invokeAction(id, action, params));
handle('devices:live', async (id) => { const s = await session(id); return s.controller.live ? s.controller.live() : {}; });
handle('devices:formats', async (id) => { const s = sessions.get(id); return s && s.device.videoNode ? platform.controls.listFormats(s.device.videoNode) : []; });
handle('devices:info', async (id) => {
  const s = await session(id);
  const out = { ...deviceSummary(s.device), helper: !!platform.helperPath() };
  if (s.controller.firmwareVersion) out.firmware = await s.controller.firmwareVersion().catch(() => null);
  if (s.controller.isPassthroughMonitorConnected) out.passthroughMonitor = await s.controller.isPassthroughMonitorConnected().catch(() => null);
  if (s.controller.signal) out.signal = await s.controller.signal().catch(() => null);
  return out;
});
handle('devices:presetSave', (id, name, values) => {
  const all = settings.get('devicePresets') || {};
  all[id] = { ...(all[id] || {}), [name]: values };
  settings.set('devicePresets', all);
  return all[id];
});
handle('devices:presets', (id) => (settings.get('devicePresets') || {})[id] || {});
handle('devices:presetDelete', (id, name) => {
  const all = settings.get('devicePresets') || {};
  if (all[id]) delete all[id][name];
  settings.set('devicePresets', all);
  return all[id] || {};
});

handle('edid:read', async (id) => {
  const s = await session(id);
  return [...(await s.controller.readEdid())];
});
handle('edid:backup', async (id) => {
  const s = await session(id);
  const data = await s.controller.readEdid();
  const { filePath } = await dialog.showSaveDialog(mainWindow, { defaultPath: `${s.device.name} EDID backup.bin`, filters: [{ name: 'EDID', extensions: ['bin'] }] });
  if (!filePath) return null;
  fs.writeFileSync(filePath, data);
  return filePath;
});
handle('edid:writeFile', async (id) => {
  const s = await session(id);
  const { filePaths } = await dialog.showOpenDialog(mainWindow, { filters: [{ name: 'EDID', extensions: ['bin', 'edid', 'dat'] }], properties: ['openFile'] });
  if (!filePaths || !filePaths[0]) return null;
  const data = fs.readFileSync(filePaths[0]);
  const { response } = await dialog.showMessageBox(mainWindow, {
    type: 'warning', buttons: ['Cancel', 'Write EDID'], defaultId: 0, cancelId: 0,
    message: `Write ${path.basename(filePaths[0])} to ${s.device.name}?`,
    detail: 'This overwrites the EDID stored on the capture card. Make a backup first. Unplugging the card while writing can leave it with an invalid EDID.',
  });
  if (response !== 1) return null;
  assertExclusive();
  await s.controller.writeEdid(data, { onProgress: (p) => send('edid:progress', p) });
  return filePaths[0];
});

// Elgato Studio polls capture cards over the same HID channel; its requests interleave with ours,
// which can corrupt a read-back. Writes refuse to run alongside it.
function elgatoStudioRunning() {
  if (process.platform !== 'win32') return false;
  try {
    return /Elgato\.Studio\.exe/i.test(require('child_process').execFileSync('tasklist', ['/FI', 'IMAGENAME eq Elgato.Studio.exe'], { encoding: 'utf8', windowsHide: true }));
  } catch { return false; }
}
function assertExclusive() {
  if (elgatoStudioRunning()) throw new Error('Quit Elgato Studio first (tray icon > Quit): it talks to the card at the same time and can corrupt the write.');
}

// Elgato's EDID presets for this card (default, shared, card-specific), and which one the card has.
handle('edid:presets', async (id) => {
  const s = await session(id);
  if (!s.device.model || !s.device.model.features || !s.device.model.features.customEdid || !s.device.controlHid) return null;
  const firmware = s.controller.firmwareVersion ? await s.controller.firmwareVersion().catch(() => null) : null;
  const presets = assets.edidPresets(await assets.manifest(), s.device.pid, firmware);
  const card = await s.controller.readEdid();
  let active = null;
  for (const p of presets) {
    const data = await assets.assetFile(p).catch(() => null);
    if (data && data.equals(card.subarray(0, data.length))) { active = p.id; break; }
  }
  const out = presets.map(({ id: pid, name, type }) => ({ id: pid, name, type }));
  return { presets: out, active, lastCustom: (settings.get('lastCustomEdid') || {})[id] || null };
});
handle('edid:applyPreset', async (id, presetId) => {
  const s = await session(id);
  const firmware = s.controller.firmwareVersion ? await s.controller.firmwareVersion().catch(() => null) : null;
  const preset = assets.edidPresets(await assets.manifest(), s.device.pid, firmware).find((p) => p.id === presetId);
  if (!preset) throw new Error('Unknown EDID preset');
  assertExclusive();
  const data = await assets.assetFile(preset);
  await s.controller.writeEdid(data, { onProgress: (p) => send('edid:progress', p) });
  if (preset.type === 'custom') settings.set('lastCustomEdid', { ...(settings.get('lastCustomEdid') || {}), [id]: presetId });
  return preset.name;
});
// Firmware updates (Game Capture 4K S).
const firmwareFlow = new FirmwareFlow(platform, { emit: (event, payload) => send('firmware:event', { event, ...payload }) });
handle('firmware:check', async (id) => {
  const s = sessions.get(id);
  if (!s) throw new Error('Device not found');
  if (!s.device.model || s.device.model.type !== '4K_S') return { supported: false, reason: 'In-app firmware updates are available for the Game Capture 4K S only. Elgato Studio on Windows can update other models.' };
  if (firmwareBusy) return { supported: true, busy: true };
  return firmwareFlow.check(s.device.serial);
});
handle('firmware:update', async (id, opts = {}) => {
  const s = sessions.get(id);
  if (!s || !s.device.model || s.device.model.type !== '4K_S') throw new Error('Firmware updates are available for the Game Capture 4K S only.');
  if (firmwareBusy) throw new Error('A firmware update is already running.');
  assertExclusive();
  if (recorder.isRecording && recorder.status().hdr) throw new Error('Stop the HDR recording before updating the firmware.');
  const serial = s.device.serial;
  firmwareBusy = serial;
  if (powerSaveBlocker && keepAwakeId === null) keepAwakeId = powerSaveBlocker.start('prevent-app-suspension');
  try {
    return await firmwareFlow.run(serial, { force: !!opts.force });
  } finally {
    firmwareBusy = null;
    for (const [, sess] of sessions) if (sess.device.serial === serial) sess.ready = null; // re-read settings after the update
    if (keepAwakeId !== null && !recorder.isRecording) { powerSaveBlocker.stop(keepAwakeId); keepAwakeId = null; }
    send('devices:changed', [...sessions.values()].map((x) => deviceSummary(x.device)));
  }
});

// Themes. A chosen background image is copied into the app's data folder, so the theme keeps
// working if the original is moved or deleted.
const THEME_DIR = path.join(userData, 'theme');
const IMAGE_TYPES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', bmp: 'image/bmp', avif: 'image/avif' };
function storeThemeImage(buf, ext) {
  fs.mkdirSync(THEME_DIR, { recursive: true });
  for (const f of fs.readdirSync(THEME_DIR)) if (f.startsWith('background')) fs.rmSync(path.join(THEME_DIR, f), { force: true });
  const dest = path.join(THEME_DIR, `background-${Date.now()}.${ext}`);
  fs.writeFileSync(dest, buf);
  return pathToFileURL(dest).href;
}
handle('theme:chooseImage', async () => {
  const { filePaths } = await dialog.showOpenDialog(mainWindow, { title: 'Choose a background image', properties: ['openFile'], filters: [{ name: 'Images', extensions: Object.keys(IMAGE_TYPES) }] });
  if (!filePaths || !filePaths[0]) return null;
  const ext = path.extname(filePaths[0]).slice(1).toLowerCase();
  if (!IMAGE_TYPES[ext]) throw new Error('Unsupported image type');
  const buf = fs.readFileSync(filePaths[0]);
  if (buf.length > 50 * 1024 * 1024) throw new Error('That image is larger than 50 MB');
  return storeThemeImage(buf, ext);
});
handle('theme:removeImage', () => {
  if (fs.existsSync(THEME_DIR)) for (const f of fs.readdirSync(THEME_DIR)) if (f.startsWith('background')) fs.rmSync(path.join(THEME_DIR, f), { force: true });
  return true;
});
handle('theme:export', async (theme) => {
  const { filePath } = await dialog.showSaveDialog(mainWindow, { title: 'Export theme', defaultPath: 'Studio theme.json', filters: [{ name: 'Theme', extensions: ['json'] }] });
  if (!filePath) return null;
  const out = { app: 'el-garto-studio', type: 'theme', version: 1, theme: { ...theme } };
  // Embed the image so the file is self-contained.
  if (theme.image && theme.image.url && theme.image.url.startsWith('file:')) {
    const file = fileURLToPath(theme.image.url);
    const ext = path.extname(file).slice(1).toLowerCase();
    out.theme.image = { ...theme.image, url: null, data: `data:${IMAGE_TYPES[ext] || 'application/octet-stream'};base64,${fs.readFileSync(file).toString('base64')}`, ext };
  }
  fs.writeFileSync(filePath, JSON.stringify(out, null, 2));
  return filePath;
});
handle('theme:import', async () => {
  const { filePaths } = await dialog.showOpenDialog(mainWindow, { title: 'Import theme', properties: ['openFile'], filters: [{ name: 'Theme', extensions: ['json'] }] });
  if (!filePaths || !filePaths[0]) return null;
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(filePaths[0], 'utf8')); } catch { throw new Error('That file is not a theme'); }
  const theme = parsed && parsed.type === 'theme' ? parsed.theme : null;
  if (!theme || typeof theme !== 'object') throw new Error('That file is not an El-Garto Studio theme');
  if (theme.image && theme.image.data) {
    const m = /^data:([\w/+.-]+);base64,(.+)$/.exec(theme.image.data);
    const ext = String(theme.image.ext || '').toLowerCase();
    if (!m || !IMAGE_TYPES[ext]) throw new Error("The theme's background image is not a supported image");
    theme.image = { ...theme.image, data: undefined, ext: undefined, url: storeThemeImage(Buffer.from(m[2], 'base64'), ext) };
  } else if (theme.image) {
    theme.image = null; // a path from another computer would not exist here
  }
  return theme;
});
handle('window:zoom', (factor) => {
  const f = Math.max(0.7, Math.min(1.6, Number(factor) || 1));
  for (const w of [mainWindow, prompterWindow]) if (w && !w.isDestroyed()) w.webContents.setZoomFactor(f);
  return f;
});

handle('devices:rename', (id, name) => {
  const names = { ...(settings.get('deviceNames') || {}) };
  if (name && name.trim()) names[id] = name.trim(); else delete names[id];
  settings.set('deviceNames', names);
  return names[id] || null;
});

function recordingStarted(s) {
  if (s && s.controller.setRecordingLed) s.controller.setRecordingLed(true).catch(() => {});
  if (keepAwakeId === null) keepAwakeId = powerSaveBlocker.start('prevent-display-sleep');
}

handle('recorder:start', (opts) => {
  const s = sessions.get(activeDeviceId);
  const st = recorder.start({ ...opts, deviceName: s ? s.device.name : 'Recording' });
  recordingStarted(s);
  return st;
});

// ---- HDR (10-bit) recording, Windows: see hdr.js -------------------------------------------

// deviceId -> { at, formats } (the helper's P010 formats for the device, or null)
const hdrFormats = new Map();
async function hdrDeviceFormats(s) {
  const c = hdrFormats.get(s.device.id);
  if (c && (c.formats || Date.now() - c.at < 30000)) return c.formats;
  const formats = await hdr.deviceFormats(s.device.vid || 0x0fd9, s.device.pid).catch(() => null);
  hdrFormats.set(s.device.id, { at: Date.now(), formats: formats && formats.p010.length ? formats : null });
  return hdrFormats.get(s.device.id).formats;
}

async function hdrInput(s) {
  // Testing aid: EGS_HDR_FORCE=1 treats any input as HDR10, to try the HDR path with an SDR source.
  if (process.env.EGS_HDR_FORCE === '1') return { eotf: hdr.EOTF.PQ, label: 'HDR10', hdr: true };
  if (!s.controller.hdrPacket) return hdr.parseDrmInfoFrame(null);
  return hdr.parseDrmInfoFrame(await s.controller.hdrPacket().catch(() => null));
}

// { capable, eotf, label, hdr, encoder } for the renderer's HDR toggle and the signal display.
handle('hdr:status', async (id) => {
  const s = await session(id);
  if (!s || s.device.kind !== 'capture' || !s.device.pid) return { capable: false };
  const input = await hdrInput(s);
  if (id === activeDeviceId) signal.isHdr = input.hdr;
  const formats = hdr.helperPath() ? await hdrDeviceFormats(s) : null;
  if (!formats) return { capable: false, ...input };
  const enc = await hdr.pickEncoder();
  return { capable: true, ...input, encoder: enc ? enc.label : null, softwareEncoder: !!(enc && enc.software) };
});

handle('recorder:startHdr', async (opts = {}) => {
  const s = sessions.get(activeDeviceId);
  if (!s) throw new Error('No device selected');
  if (firmwareBusy) throw new Error('A firmware update is in progress; HDR recording is unavailable until it finishes.');
  const input = await hdrInput(s);
  if (!input.hdr) throw new Error('The input is not HDR');
  const st = await recorder.startExternal({
    deviceName: s.device.name,
    makeCapture: (raw) => {
      const cap = new hdr.HdrCapture({
        videoMatch: hdr.videoMatch(s.device.vid || 0x0fd9, s.device.pid), audioMatch: opts.audioLabel || null,
        eotf: input.eotf, info: input, bitrate: opts.bitrate, maxHeight: opts.maxHeight, maxFps: opts.maxFps,
        audioKbps: settings.get('audioBitrateKbps'), output: raw,
      });
      cap.on('preview', (jpeg) => send('hdr:preview', jpeg));
      cap.on('format', (f) => send('hdr:format', { ...f, eotf: input.eotf, label: input.label }));
      cap.on('warning', (m) => send('app:error', m));
      cap.on('ended', (why) => send('hdr:ended', why));
      return cap;
    },
  });
  recordingStarted(s);
  return st;
});
ipcMain.on('recorder:chunk', (_e, buf) => recorder.chunk(buf));
handle('recorder:stop', async () => {
  const s = sessions.get(activeDeviceId);
  if (s && s.controller.setRecordingLed) s.controller.setRecordingLed(false).catch(() => {});
  if (keepAwakeId !== null) { powerSaveBlocker.stop(keepAwakeId); keepAwakeId = null; }
  return recorder.stop();
});
handle('recorder:status', () => recorder.status());
handle('recorder:snapshot', (png) => {
  const s = sessions.get(activeDeviceId);
  const file = recorder.snapshot(png, s ? s.device.name : 'Snapshot');
  if (pendingSnapshot) { pendingSnapshot.resolve({ snapshotName: path.basename(file) }); pendingSnapshot = null; }
  return file;
});
ipcMain.on('flashback:segment', (_e, buf, dur) => recorder.flashbackSegment(buf, dur));
handle('flashback:save', () => { const s = sessions.get(activeDeviceId); return recorder.saveFlashback(s ? s.device.name : 'El-Garto Studio'); });
handle('flashback:clear', () => recorder.clearFlashback());
handle('vcam:start', (dev, size) => recorder.startVirtualCamera(dev, size));
ipcMain.on('vcam:chunk', (_e, buf) => recorder.virtualCameraChunk(buf));
handle('vcam:stop', () => recorder.stopVirtualCamera());
handle('vcam:devices', () => platform.virtualCameraDevices());
let virtualMicOn = false;
handle('vmic:available', () => virtualMic.available());
handle('vmic:start', async () => { const r = await virtualMic.start(); virtualMicOn = true; return r; });
handle('vmic:stop', async () => { virtualMicOn = false; await virtualMic.stop(); });

handle('library:list', () => library.list());
handle('library:thumb', async (file) => `file://${await library.thumbnail(file)}`);
handle('library:rename', (file, name) => library.rename(file, name));
handle('library:trash', (file) => shell.trashItem(file));
handle('library:reveal', (file) => shell.showItemInFolder(file));
handle('library:open', (file) => shell.openPath(file));
handle('library:dir', () => library.dir());
handle('library:chooseDir', async () => {
  const { filePaths } = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory', 'createDirectory'] });
  if (filePaths && filePaths[0]) { settings.set('recordingsDir', filePaths[0]); library.unwatch(); library.watch(); }
  return settings.get('recordingsDir');
});

handle('settings:all', () => settings.all());
handle('settings:set', (k, v) => { settings.set(k, v); if (k === 'shortcuts') registerShortcuts(); return settings.all(); });
handle('app:info', () => ({ ...api.appInfo(), wsPort: rpc.port, helper: !!platform.helperPath(), platform: platform.name, features: platform.features, userData }));

ipcMain.on('state:preview', (_e, p) => {
  const prev = { ...preview };
  Object.assign(preview, p);
  const changed = {};
  for (const k of ['volumePercentage', 'isMuted']) if (prev[k] !== preview[k]) changed[k] = preview[k];
  if (Object.keys(changed).length) rpc.notify('previewInformationChanged', changed);
});
ipcMain.on('state:levels', (_e, l, r) => {
  preview.levelLeft = l; preview.levelRight = r;
  rpc.notify('previewInformationChanged', { audio: { levelLeftPercentage: l, levelRightPercentage: r } });
});
ipcMain.on('state:signal', (_e, sig) => {
  const had = signal.hasSignal;
  Object.assign(signal, sig);
  rpc.notify('signalInformationChanged', had !== signal.hasSignal ? api.signalInfo() : { video: api.signalInfo().video });
});
ipcMain.on('window:fullscreen', (_e, on) => mainWindow && mainWindow.setFullScreen(!!on));

// Prompter
handle('prompter:open', (displayId) => openPrompterWindow(displayId));
handle('prompter:close', () => prompterWindow && prompterWindow.close());
handle('prompter:displays', () => screen.getAllDisplays().map((d) => ({ id: d.id, label: d.label || `${d.size.width}×${d.size.height}`, bounds: d.bounds, primary: d.id === screen.getPrimaryDisplay().id })));
handle('scripts:list', () => scripts.list());
handle('scripts:get', (id) => scripts.get(id));
handle('scripts:save', (s) => scripts.save(s));
handle('scripts:delete', (id) => scripts.remove(id));
handle('scripts:import', async () => {
  const { filePaths } = await dialog.showOpenDialog(mainWindow, { filters: [{ name: 'Scripts', extensions: ['txt', 'md', 'docx', 'rtf'] }], properties: ['openFile', 'multiSelections'] });
  return (filePaths || []).map((f) => scripts.importFile(f));
});
handle('scripts:export', async (id) => {
  const s = scripts.get(id);
  const { filePath } = await dialog.showSaveDialog(mainWindow, { defaultPath: `${s.title}.txt` });
  if (filePath) fs.writeFileSync(filePath, s.text);
  return filePath || null;
});
const VOSK_MODEL_URL = 'https://ccoreilly.github.io/vosk-browser/models/vosk-model-small-en-us-0.15.tar.gz';

function download(url, dest, redirects = 5) {
  return new Promise((resolve, reject) => {
    require('https').get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
        res.resume();
        resolve(download(new URL(res.headers.location, url).toString(), dest, redirects - 1));
        return;
      }
      if (res.statusCode !== 200) { res.resume(); reject(new Error(`download failed (${res.statusCode})`)); return; }
      const tmp = `${dest}.part`;
      const out = fs.createWriteStream(tmp);
      res.pipe(out);
      out.on('finish', () => out.close(() => { fs.renameSync(tmp, dest); resolve(dest); }));
      out.on('error', reject);
    }).on('error', reject);
  });
}

handle('voicesync:model', async () => {
  const dir = path.join(userData, 'models');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, path.basename(VOSK_MODEL_URL));
  if (!fs.existsSync(file)) {
    sendPrompter('prompter:status', 'Downloading speech model (about 40 MB)…');
    await download(VOSK_MODEL_URL, file);
  }
  return fs.readFileSync(file);
});

ipcMain.on('prompter:command', (_e, cmd) => sendPrompterCommand(cmd));
ipcMain.on('prompter:state', (_e, st) => {
  const prev = prompterState;
  prompterState = { ...prompterState, ...st };
  send('prompter:state', prompterState);
  for (const k of Object.keys(st)) {
    if (prev[k] !== prompterState[k]) rpc.notify('propertyChanged', { deviceId: 'prompter', propertyId: k, value: prompterState[k] });
  }
});
ipcMain.on('prompter:load', (_e, script) => sendPrompter('prompter:load', script));
ipcMain.on('prompter:settings', (_e, s) => sendPrompter('prompter:settings', s));
ipcMain.on('prompter:chat', (_e, msg) => sendPrompter('prompter:chat', msg));

// ---- Lifecycle -----------------------------------------------------------------------

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => { if (mainWindow) { mainWindow.show(); mainWindow.focus(); } });

  app.whenReady().then(async () => {
    monitor.on('changed', (list) => {
      syncSessions(list);
      send('devices:changed', list.map(deviceSummary));
      rpc.notify('devicesChanged', api.devices());
    });
    monitor.on('error', (e) => console.error('device scan failed:', e.message));
    await monitor.start();
    syncSessions(monitor.list());
    library.watch();
    library.on('changed', (list) => {
      send('library:changed', list);
      api.lastRecordingInfo().then((info) => rpc.notify('lastRecordingItemInformationChanged', info));
    });
    recorder.on('changed', () => rpc.notify('recordingInformationChanged', api.recordingInfo()));
    recorder.on('error', (e) => send('app:error', e.message));
    recorder.on('vcam', (st) => send('vcam:state', st));
    recorder.on('released', () => send('hdr:released'));
    setInterval(() => { if (recorder.isRecording) { const i = api.recordingInfo(); rpc.notify('recordingInformationChanged', { recordingDurationSec: i.recordingDurationSec, recordingSizeBytes: i.recordingSizeBytes, usedDiskPercentage: i.usedDiskPercentage }); send('recorder:status', recorder.status()); } }, 1000);
    try { await rpc.start(); } catch (e) { console.error('WebSocket server failed:', e.message); }
    createMainWindow();
    createTray();
    registerShortcuts();
  });

  app.on('window-all-closed', (e) => {
    // Keep running in the tray (like Studio on Windows) unless no tray is available.
    if (!tray) app.quit();
  });

  // A GPU driver reset (seen with AMD drivers: "Camera texture device lost") kills Chromium's GPU
  // process. The renderer saves any recording in progress and reopens the preview.
  app.on('child-process-gone', (_e, details) => {
    if (details.type === 'GPU') send('gpu:lost', details.reason);
  });

  app.on('before-quit', (e) => {
    if (!firmwareBusy) return;
    e.preventDefault();
    if (mainWindow) dialog.showMessageBox(mainWindow, { type: 'warning', message: 'A firmware update is in progress.', detail: 'The app will stay open until it finishes.' });
  });

  let quitting = false;
  app.on('will-quit', async (e) => {
    // Remove the virtual microphone's devices so they don't linger after the app is gone.
    if (virtualMicOn && !quitting) {
      e.preventDefault();
      quitting = true;
      virtualMicOn = false;
      await virtualMic.stop().catch(() => {});
      app.quit();
      return;
    }
    globalShortcut.unregisterAll();
    monitor.stop();
    library.unwatch();
    recorder.dispose();
    await rpc.stop();
  });
}
