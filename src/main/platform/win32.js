'use strict';
// Windows backend: everything goes through native/build/egctl.exe (SetupAPI, HID API, DirectShow,
// Kernel Streaming). DirectShow controls are exposed under V4L2 control names so the shared
// camera/capture controllers work unchanged.

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const catalog = require('../devices/catalog');

function helperPath() {
  const candidates = [
    process.resourcesPath && path.join(process.resourcesPath, 'native', 'egctl.exe'),
    path.join(__dirname, '../../../native/build/egctl.exe'),
  ].filter(Boolean);
  return candidates.find((p) => fs.existsSync(p)) || null;
}

let cachedHelper;
function run(args, { timeoutMs = 5000 } = {}) {
  if (cachedHelper === undefined) cachedHelper = helperPath();
  if (!cachedHelper) return Promise.reject(new Error('egctl.exe not built (run `npm run build:native`)'));
  return new Promise((resolve, reject) => {
    execFile(cachedHelper, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message).trim()));
      else resolve(stdout.trim());
    });
  });
}

const toHex = (b) => Buffer.from(b).toString('hex');
const fromHex = (s) => Buffer.from(s.replace(/\s+/g, ''), 'hex');

// ---- discovery -----------------------------------------------------------------------

// Parent instance ids look like USB\VID_0FD9&PID_00AF\AC8KB0000TEST1.
function parseParent(parent) {
  const m = /^USB\\VID_([0-9A-F]{4})&PID_([0-9A-F]{4})\\(.+)$/i.exec(parent || '');
  return m ? { vid: parseInt(m[1], 16), pid: parseInt(m[2], 16), serial: m[3] } : null;
}

function buildDevices(list) {
  const byParent = new Map();
  const entry = (parent) => {
    if (!byParent.has(parent)) byParent.set(parent, { hid: [], video: [] });
    return byParent.get(parent);
  };
  for (const h of list.hid || []) entry(h.parent || h.path).hid.push(h);
  for (const v of list.video || []) entry(v.parent || v.path).video.push(v);

  const devices = [];
  for (const [parent, nodes] of byParent) {
    const usb = parseParent(parent);
    const model = usb ? catalog.lookup(usb.vid, usb.pid) : null;
    const video = nodes.video[0];
    if (!model && !video) continue;
    const hid = nodes.hid.map((h) => ({ node: h.path, interface: h.interface }));
    devices.push({
      id: usb ? `${usb.vid.toString(16).padStart(4, '0')}:${usb.pid.toString(16).padStart(4, '0')}:${usb.serial}` : `video:${video.name}`,
      usbPath: parent,
      vid: usb ? usb.vid : 0,
      pid: usb ? usb.pid : 0,
      serial: usb ? usb.serial : null,
      name: model ? model.name : video.name,
      kind: model ? model.kind : 'generic',
      model,
      speedMbps: 0, // not exposed through SetupAPI without a hub query
      usb2Fallback: !!(model && usb && model.usb2Pid === usb.pid && model.pids.length > 1),
      videoNode: video ? video.path : null,
      videoName: video ? video.name : null,
      hidraw: hid,
      controlHid: model && model.hidInterface != null ? (hid.find((h) => h.interface === model.hidInterface) || {}).node || null : null,
      alsaCard: null,
      alsaId: null,
    });
  }
  return devices;
}

async function scan() {
  return buildDevices(JSON.parse(await run(['list'], { timeoutMs: 10000 })));
}

// ---- HID -------------------------------------------------------------------------------

// Windows returns the reply exactly as on the wire; prepend the report id so callers get the
// same [reportId, wire bytes…] layout as Linux's HIDIOCGINPUT.
const withId = (reportId, hex) => Buffer.concat([Buffer.from([reportId]), fromHex(hex)]);

const hid = {
  write: (node, bytes) => run(['hid', 'write', node, toHex(bytes)]),
  input: async (node, reportId, wireLen) => withId(reportId, await run(['hid', 'input', node, String(reportId), String(wireLen)])),
  xfer: async (node, bytes, reportId, wireLen) => withId(reportId, await run(['hid', 'xfer', node, toHex(bytes), String(reportId), String(wireLen)])),
  featureGet: (node, reportId, len) => run(['hid', 'feature-get', node, String(reportId), String(len)]).then(fromHex),
  featureSet: (node, bytes) => run(['hid', 'feature-set', node, toHex(bytes)]),
};

// ---- camera controls -------------------------------------------------------------------

const PROCAMP = { 0: 'brightness', 1: 'contrast', 2: 'hue', 3: 'saturation', 4: 'sharpness', 5: 'gamma', 7: 'white_balance_temperature', 8: 'backlight_compensation', 9: 'gain', 13: 'power_line_frequency' };
const CAMERA = { 0: 'pan_absolute', 1: 'tilt_absolute', 3: 'zoom_absolute', 4: 'exposure_time_absolute', 6: 'focus_absolute' };
const AUTO_NAME = { 'procamp:7': 'white_balance_automatic', 'camera:4': 'auto_exposure', 'camera:6': 'focus_automatic_continuous' };
const FLAG_AUTO = 1;
const FLAG_MANUAL = 2;

// DirectShow exposure is log2(seconds); V4L2 uses 100 µs units.
const expToV4l2 = (v) => Math.max(1, Math.round(2 ** v * 10000));
const expFromV4l2 = (x) => Math.round(Math.log2(Math.max(1, x) / 10000));

function mapControls(raw) {
  const out = [];
  for (const r of raw) {
    const names = r.set === 'procamp' ? PROCAMP : CAMERA;
    const name = names[r.prop];
    if (!name) continue;
    const isExposure = r.set === 'camera' && r.prop === 4;
    const auto = (r.flags & FLAG_AUTO) !== 0;
    const c = {
      name, type: 'int', min: r.min, max: r.max, step: r.step || 1, default: r.default, value: r.value,
      inactive: auto, menu: undefined, raw: r,
    };
    if (isExposure) Object.assign(c, { min: expToV4l2(r.min), max: expToV4l2(r.max), step: 1, default: expToV4l2(r.default), value: expToV4l2(r.value) });
    if (name === 'power_line_frequency') Object.assign(c, { type: 'menu', menu: { 0: 'Disabled', 1: '50 Hz', 2: '60 Hz', 3: 'Auto' } });
    out.push(c);
    const autoName = AUTO_NAME[`${r.set}:${r.prop}`];
    if (autoName && (r.caps & FLAG_AUTO)) {
      if (autoName === 'auto_exposure') {
        out.push({ name: autoName, type: 'menu', min: 1, max: 3, step: 1, default: 3, value: auto ? 3 : 1, menu: { 1: 'Manual Mode', 3: 'Aperture Priority Mode' }, raw: r, autoOf: name });
      } else {
        out.push({ name: autoName, type: 'bool', min: 0, max: 1, step: 1, default: 1, value: auto ? 1 : 0, raw: r, autoOf: name });
      }
    }
  }
  return out;
}

async function listControls(dev) {
  return mapControls(JSON.parse(await run(['cam', 'list', dev])));
}

async function setControl(dev, name, value) {
  const c = (await listControls(dev)).find((x) => x.name === name);
  if (!c) throw new Error(`control ${name} not available`);
  const r = c.raw;
  if (c.autoOf) {
    const on = c.type === 'menu' ? Number(value) !== 1 : !!Number(value);
    return run(['cam', 'set', dev, r.set, String(r.prop), String(r.value), String(on ? FLAG_AUTO : FLAG_MANUAL)]);
  }
  const v = r.set === 'camera' && r.prop === 4 ? expFromV4l2(Number(value)) : Math.round(Number(value));
  return run(['cam', 'set', dev, r.set, String(r.prop), String(v), String(FLAG_MANUAL)]);
}

async function listFormats(dev) {
  const modes = JSON.parse(await run(['cam', 'formats', dev], { timeoutMs: 10000 }));
  const byFourcc = new Map();
  for (const m of modes) {
    if (!byFourcc.has(m.fourcc)) byFourcc.set(m.fourcc, { fourcc: m.fourcc, description: m.fourcc, sizes: [] });
    const f = byFourcc.get(m.fourcc);
    let s = f.sizes.find((x) => x.width === m.width && x.height === m.height);
    if (!s) { s = { width: m.width, height: m.height, fps: [] }; f.sizes.push(s); }
    const fps = Math.round(m.fps * 100) / 100;
    if (fps && !s.fps.includes(fps)) s.fps.push(fps);
  }
  return [...byFourcc.values()];
}

// ---- UVC extension units (Kernel Streaming) --------------------------------------------

const xuGuid = new Map(); // `${dev}|${node}` -> guid, filled by extensionUnits()

async function extensionUnits(dev, guids) {
  const units = [];
  for (const guid of guids) {
    const node = parseInt(await run(['xu', 'find', dev, guid]).catch(() => '-1'), 10);
    if (node >= 0) {
      xuGuid.set(`${dev}|${node}`, guid);
      units.push({ unitId: node, guid });
    }
  }
  return units;
}

const guidFor = (dev, unit) => {
  const g = xuGuid.get(`${dev}|${unit}`);
  if (!g) throw new Error(`unknown extension unit ${unit}`);
  return g;
};

// KSPROPERTY_DESCRIPTION (40 bytes) followed by member lists; each list is a 16-byte
// KSPROPERTY_MEMBERSHEADER {flags, size, count, memberFlags} and its members.
function parseBasicSupport(buf, len) {
  const out = {};
  if (buf.length < 40) return out;
  const lists = buf.readUInt32LE(32);
  let p = 40;
  for (let i = 0; i < lists && p + 16 <= buf.length; i++) {
    const kind = buf.readUInt32LE(p);
    const size = buf.readUInt32LE(p + 4);
    const count = buf.readUInt32LE(p + 8);
    const flags = buf.readUInt32LE(p + 12);
    const body = buf.subarray(p + 16, p + 16 + size * count);
    if ((kind === 1 || kind === 2) && size === 3 * len) {
      out.res = body.subarray(0, len); out.min = body.subarray(len, 2 * len); out.max = body.subarray(2 * len, 3 * len);
    } else if ((kind === 1 || kind === 2) && size === 2 * len) {
      out.min = body.subarray(0, len); out.max = body.subarray(len, 2 * len);
    } else if (kind === 3 && (flags & 1) && size === len) {
      out.def = body.subarray(0, len);
    }
    p += 16 + size * count;
  }
  return out;
}

const basicCache = new Map();
async function basic(dev, unit, sel, len) {
  const key = `${dev}|${unit}|${sel}`;
  if (!basicCache.has(key)) {
    basicCache.set(key, run(['xu', 'basic', dev, guidFor(dev, unit), String(unit), String(sel)]).then((h) => parseBasicSupport(fromHex(h), len)));
  }
  return basicCache.get(key);
}

const need = (field) => async (dev, unit, sel, len) => {
  const b = await basic(dev, unit, sel, len);
  if (!b[field]) throw new Error(`no ${field} reported for selector ${sel}`);
  return Buffer.from(b[field]);
};

const xu = {
  get: (dev, unit, sel, len) => run(['xu', 'get', dev, guidFor(dev, unit), String(unit), String(sel), String(len)]).then(fromHex),
  set: (dev, unit, sel, data) => run(['xu', 'set', dev, guidFor(dev, unit), String(unit), String(sel), toHex(data)]),
  len: (dev, unit, sel) => run(['xu', 'len', dev, guidFor(dev, unit), String(unit), String(sel)]).then((s) => parseInt(s, 10)),
  min: need('min'),
  max: need('max'),
  def: need('def'),
};

module.exports = {
  name: 'win32',
  features: { virtualCamera: false },
  scanIntervalMs: 3000,
  scan,
  hid,
  hidReportSizes: () => ({ input: {}, output: {}, feature: {} }), // egctl pads to the HID caps size
  controls: { listControls, setControl, listFormats },
  xu,
  extensionUnits,
  helperPath,
  virtualCameraDevices: () => [],
  // exported for tests
  _internal: { buildDevices, mapControls, parseBasicSupport, expToV4l2, expFromV4l2, parseParent },
};
