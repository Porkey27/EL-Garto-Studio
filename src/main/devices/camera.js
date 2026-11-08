'use strict';
// Camera controller: exposes Studio-compatible camera properties (same ids the Windows
// app uses on its WebSocket API) backed by V4L2 standard controls and Elgato UVC XUs.

const platform = require('../platform');

const GUID = {
  XU1: '23E49ED0-1178-4F31-AE52-D2FB8A8D3001',
  XU2: '2C49D16A-32B8-4485-3EA8-643A15236002',
  LEGACY_NEW: '23E49ED0-1178-4F31-AE52-D2FB8A8D3B48',
  LEGACY_FACECAM: 'A8E5782B-36E6-4FA1-87F8-83E32B323124',
};

const CATEGORIES = [
  { categoryId: 'exposure', name: 'Exposure', canReset: true },
  { categoryId: 'whiteBalance', name: 'White Balance', canReset: true },
  { categoryId: 'focus', name: 'Focus', canReset: true },
  { categoryId: 'picture', name: 'Picture', canReset: true },
  { categoryId: 'frame', name: 'Frame', canReset: true },
  { categoryId: 'detail', name: 'Detail', canReset: true },
  { categoryId: 'device', name: 'Device', canReset: false },
];

const enumValues = (labels) => labels.map(([value, displayName]) => ({ value, displayName }));

const METERING = enumValues([[0, 'Center weighted'], [1, 'Average'], [2, 'Spot']]);
const FOCUS_METERING = enumValues([[0, 'Center'], [1, 'Spot'], [2, 'Average']]);
const DYNAMIC_RANGE = enumValues([[0, 'Standard'], [1, 'Wide'], [2, 'High']]);
const NOISE_REDUCTION = enumValues([[0, 'Off'], [1, 'On'], [2, 'Light'], [3, 'Medium'], [4, 'High']]);
const ANTI_FLICKER = enumValues([[0, 'Off'], [1, '50 Hz'], [2, '60 Hz'], [3, 'Auto']]);
const LED_MODE = enumValues([[0, 'Always off'], [1, 'On when streaming'], [2, 'Always on']]);

// V4L2-backed properties. `ctrl` lists alternate control names across kernel versions.
const V4L2_PROPS = [
  { id: 'brightness', name: 'Brightness', category: 'picture', ctrl: ['brightness'] },
  { id: 'contrast', name: 'Contrast', category: 'picture', ctrl: ['contrast'] },
  { id: 'saturation', name: 'Saturation', category: 'picture', ctrl: ['saturation'] },
  { id: 'hue', name: 'Hue', category: 'picture', ctrl: ['hue'] },
  { id: 'gamma', name: 'Gamma', category: 'picture', ctrl: ['gamma'] },
  { id: 'sharpness', name: 'Sharpness', category: 'detail', ctrl: ['sharpness'] },
  { id: 'autoExposure', name: 'Auto exposure', category: 'exposure', ctrl: ['auto_exposure', 'exposure_auto'],
    dataType: 'bool', toDevice: (v) => (v ? 3 : 1), fromDevice: (v) => v !== 1 },
  { id: 'shutterSpeed', name: 'Shutter speed', category: 'exposure', unit: '100µs',
    ctrl: ['exposure_time_absolute', 'exposure_absolute'], dependsOn: ['autoExposure', false] },
  { id: 'iso', name: 'ISO / gain', category: 'exposure', ctrl: ['gain'], dependsOn: ['autoExposure', false] },
  { id: 'backlightCompensation', name: 'Backlight compensation', category: 'exposure', ctrl: ['backlight_compensation'] },
  { id: 'antiFlicker', name: 'Anti-flicker', category: 'exposure', ctrl: ['power_line_frequency'], dataType: 'enum', values: ANTI_FLICKER },
  { id: 'autoWhiteBalance', name: 'Auto white balance', category: 'whiteBalance',
    ctrl: ['white_balance_automatic', 'white_balance_temperature_auto'], dataType: 'bool' },
  { id: 'whiteBalance', name: 'Temperature', category: 'whiteBalance', unit: 'K',
    ctrl: ['white_balance_temperature'], dependsOn: ['autoWhiteBalance', false] },
  { id: 'autoFocus', name: 'Auto focus', category: 'focus', ctrl: ['focus_automatic_continuous', 'focus_auto'], dataType: 'bool' },
  { id: 'focus', name: 'Focus', category: 'focus', ctrl: ['focus_absolute'], dependsOn: ['autoFocus', false] },
  { id: 'zoom', name: 'Zoom', category: 'frame', ctrl: ['zoom_absolute'] },
  { id: 'pan', name: 'Pan', category: 'frame', ctrl: ['pan_absolute'] },
  { id: 'tilt', name: 'Tilt', category: 'frame', ctrl: ['tilt_absolute'] },
];

// XU-backed properties: [unitKey, selector, byteLength, signed].
const XU_PROPS = [
  { id: 'vibrancy', name: 'Vibrancy', category: 'picture', xu: ['XU1', 0x0e, 2, true] },
  { id: 'tint', name: 'Tint', category: 'whiteBalance', xu: ['XU1', 0x12, 2, true] },
  { id: 'autoExposureLock', name: 'Lock exposure', category: 'exposure', xu: ['XU1', 0x04, 1], dataType: 'bool' },
  { id: 'exposureMetering', name: 'Metering', category: 'exposure', xu: ['XU1', 0x02, 1], dataType: 'enum', values: METERING },
  { id: 'dynamicRange', name: 'Dynamic range', category: 'exposure', xu: ['XU1', 0x15, 1], dataType: 'enum', values: DYNAMIC_RANGE },
  { id: 'autoWhiteBalanceLock', name: 'Lock white balance', category: 'whiteBalance', xu: ['XU1', 0x0f, 1], dataType: 'bool' },
  { id: 'autoFocusLock', name: 'Lock focus', category: 'focus', xu: ['XU1', 0x1a, 1], dataType: 'bool' },
  { id: 'focusMetering', name: 'Focus area', category: 'focus', xu: ['XU1', 0x19, 1], dataType: 'enum', values: FOCUS_METERING },
  { id: 'noiseReduction', name: 'Noise reduction', category: 'detail', xu: ['XU1', 0x16, 1], dataType: 'enum', values: NOISE_REDUCTION },
  { id: 'lowLightMode', name: 'Low light mode', category: 'exposure', xu: ['XU2', 0x1d, 2], dataType: 'bool' },
];

// Older Facecam / Facecam Pro use their own unit with per-model selectors.
const LEGACY_PROPS = {
  FACECAM: [
    { id: 'exposureMetering', name: 'Metering', category: 'exposure', sel: 0x08, dataType: 'enum', values: METERING },
    { id: 'autoExposureLock', name: 'Lock exposure', category: 'exposure', sel: 0x19, dataType: 'bool' },
    { id: 'noiseReduction', name: 'Noise reduction', category: 'detail', sel: 0x12, dataType: 'enum', values: NOISE_REDUCTION.slice(0, 2) },
  ],
  FACECAM_PRO: [
    { id: 'exposureMetering', name: 'Metering', category: 'exposure', sel: 0x02, dataType: 'enum', values: METERING },
  ],
};

// Read-only live values used by the HUD overlay.
const LIVE = { iso: ['XU1', 0x08, 4], shutter: ['XU1', 0x0b, 4], whiteBalance: ['XU1', 0x11, 4], focus: ['XU1', 0x0d, 4] };

const LED_SEL = 0x04;
const LED_IDLE = 3;
const LED_STREAMING = 2;

function decodeInt(buf, signed) {
  const n = buf.length;
  if (n === 1) return signed ? buf.readInt8(0) : buf.readUInt8(0);
  if (n === 2) return signed ? buf.readInt16LE(0) : buf.readUInt16LE(0);
  if (n >= 4) return signed ? buf.readInt32LE(0) : buf.readUInt32LE(0);
  return 0;
}

function encodeInt(value, len, signed) {
  const b = Buffer.alloc(len);
  const v = Math.round(Number(value));
  if (len === 1) signed ? b.writeInt8(v) : b.writeUInt8(v & 0xff);
  else if (len === 2) signed ? b.writeInt16LE(v) : b.writeUInt16LE(v & 0xffff);
  else signed ? b.writeInt32LE(v) : b.writeUInt32LE(v >>> 0);
  return b;
}

function ledPayload(which, brightness) {
  return Buffer.from([0xff, 0x00, which, 0x00, 0x00, Math.max(0, Math.min(255, brightness)), 0, 0, 0, 0]);
}

class CameraController {
  constructor(device, { v4l2 = platform.controls, native = platform, units } = {}) {
    this.device = device;
    this.dev = device.videoNode;
    this.v4l2 = v4l2;
    this.xu = native.xu;
    this.extensionUnits = native.extensionUnits;
    this.units = units || {};
    this.unitsKnown = !!units;
    this.props = new Map();
    this.controls = new Map();
  }

  async findUnits() {
    const found = {};
    const units = this.extensionUnits ? await this.extensionUnits(this.dev, Object.values(GUID)) : [];
    for (const u of units) {
      for (const [key, guid] of Object.entries(GUID)) if (u.guid === guid) found[key] = u.unitId;
    }
    return found;
  }

  legacySet() {
    const type = this.device.model && this.device.model.type;
    if (this.units.LEGACY_FACECAM === undefined) return [];
    return LEGACY_PROPS[type] || [];
  }

  // Builds the property table from what the device actually exposes.
  async refresh() {
    if (!this.unitsKnown) {
      this.units = await this.findUnits().catch(() => ({}));
      this.unitsKnown = true;
    }
    this.props.clear();
    this.controls.clear();
    let ctrls = [];
    try { ctrls = await this.v4l2.listControls(this.dev); } catch { /* device busy or gone */ }
    for (const c of ctrls) this.controls.set(c.name, c);

    for (const p of V4L2_PROPS) {
      const name = p.ctrl.find((n) => this.controls.has(n));
      if (!name) continue;
      const c = this.controls.get(name);
      const dataType = p.dataType || (c.type === 'bool' ? 'bool' : c.type === 'menu' ? 'enum' : 'int');
      this.props.set(p.id, {
        ...p, source: 'v4l2', ctrlName: name, dataType,
        min: c.min, max: c.max, step: c.step || 1, def: p.fromDevice ? p.fromDevice(c.default) : c.default,
        values: p.values || (c.menu ? Object.entries(c.menu).map(([v, n]) => ({ value: Number(v), displayName: n })) : undefined),
      });
    }

    for (const p of XU_PROPS) {
      const [unitKey, sel, len, signed] = p.xu;
      const unit = this.units[unitKey];
      if (unit === undefined) continue;
      const meta = { ...p, source: 'xu', unitId: unit, sel, len, signed: !!signed, dataType: p.dataType || 'int' };
      if (meta.dataType === 'int') {
        try {
          meta.min = decodeInt(await this.xu.min(this.dev, unit, sel, len), signed);
          meta.max = decodeInt(await this.xu.max(this.dev, unit, sel, len), signed);
          meta.def = decodeInt(await this.xu.def(this.dev, unit, sel, len), signed);
        } catch {
          continue; // control not implemented by this firmware
        }
      }
      this.props.set(p.id, meta);
    }

    if (this.units.LEGACY_FACECAM !== undefined) {
      for (const p of this.legacySet()) {
        let len = 1;
        try { len = await this.xu.len(this.dev, this.units.LEGACY_FACECAM, p.sel); } catch { continue; }
        this.props.set(p.id, { ...p, source: 'xu', unitId: this.units.LEGACY_FACECAM, len, signed: false });
      }
    }

    if (this.units.XU2 !== undefined) {
      this.props.set('ledBrightness', { id: 'ledBrightness', name: 'LED brightness', category: 'device', source: 'led', dataType: 'int', min: 0, max: 100, step: 1, def: 100 });
      this.props.set('statusLed', { id: 'statusLed', name: 'Status LED', category: 'device', source: 'led', dataType: 'enum', values: LED_MODE, def: 1 });
    }
    return this.describe();
  }

  // The LED state can't be read back without addressing a slot by writing to it, so the
  // last written mode/brightness is tracked here instead.
  async writeLed(mode, brightnessPct) {
    const unit = this.units.XU2;
    const b = Math.round((brightnessPct * 255) / 100);
    const idle = mode === 2 ? b : 0;
    const streaming = mode === 0 ? 0 : b;
    await this.xu.set(this.dev, unit, LED_SEL, ledPayload(LED_IDLE, idle));
    await this.xu.set(this.dev, unit, LED_SEL, ledPayload(LED_STREAMING, streaming));
    this.ledState = { mode, brightness: brightnessPct };
  }

  async get(id) {
    const p = this.props.get(id);
    if (!p) throw new Error(`unknown property ${id}`);
    if (p.source === 'v4l2') {
      const ctrls = await this.v4l2.listControls(this.dev);
      const c = ctrls.find((x) => x.name === p.ctrlName);
      const v = c ? c.value : undefined;
      return p.fromDevice ? p.fromDevice(v) : p.dataType === 'bool' ? !!v : v;
    }
    if (p.source === 'xu') {
      const v = decodeInt(await this.xu.get(this.dev, p.unitId, p.sel, p.len), p.signed);
      return p.dataType === 'bool' ? v !== 0 : v;
    }
    if (p.source === 'led') {
      if (!this.ledState) this.ledState = { mode: 1, brightness: 100 };
      return id === 'statusLed' ? this.ledState.mode : this.ledState.brightness;
    }
    return undefined;
  }

  async set(id, value) {
    const p = this.props.get(id);
    if (!p) throw new Error(`unknown property ${id}`);
    if (p.source === 'v4l2') {
      let v = p.toDevice ? p.toDevice(value) : p.dataType === 'bool' ? (value ? 1 : 0) : Number(value);
      if (p.min !== undefined && p.dataType === 'int') v = Math.max(p.min, Math.min(p.max, v));
      await this.v4l2.setControl(this.dev, p.ctrlName, v);
      return;
    }
    if (p.source === 'xu') {
      const v = p.dataType === 'bool' ? (value ? 1 : 0) : Number(value);
      await this.xu.set(this.dev, p.unitId, p.sel, encodeInt(v, p.len, p.signed));
      return;
    }
    if (p.source === 'led') {
      const cur = this.ledState || { mode: 1, brightness: 100 };
      if (id === 'statusLed') await this.writeLed(Number(value), cur.brightness);
      else await this.writeLed(cur.mode, Number(value));
    }
  }

  async reset(id) {
    const p = this.props.get(id);
    if (p && p.def !== undefined) await this.set(id, p.def);
  }

  async resetCategory(categoryId) {
    for (const p of this.props.values()) if (p.category === categoryId) await this.reset(p.id).catch(() => {});
  }

  async live() {
    const out = {};
    if (this.units.XU1 === undefined) return out;
    for (const [k, [, sel, len]] of Object.entries(LIVE)) {
      try { out[k] = decodeInt(await this.xu.get(this.dev, this.units.XU1, sel, len), false); } catch { /* unsupported */ }
    }
    return out;
  }

  // Persists current settings in the camera's own memory (Studio's "Save to camera").
  async saveToCamera(slot = 0) {
    if (this.units.XU2 === undefined) throw new Error('camera has no profile storage');
    await this.xu.set(this.dev, this.units.XU2, 0x07, Buffer.from([slot]));
  }

  async loadFromCamera(slot = 0) {
    if (this.units.XU2 === undefined) throw new Error('camera has no profile storage');
    await this.xu.set(this.dev, this.units.XU2, 0x06, Buffer.from([slot]));
  }

  async oneTimeAutoFocus() {
    if (this.units.XU1 === undefined) throw new Error('unsupported');
    await this.xu.set(this.dev, this.units.XU1, 0x1e, encodeInt(1, 4, false));
  }

  describe() {
    return [...this.props.values()].map((p) => ({
      propertyId: p.id,
      name: p.name,
      dataType: p.dataType,
      categoryId: p.category,
      readOnly: false,
      canReset: p.def !== undefined,
      valueInfo: p.dataType === 'enum'
        ? { type: 'enum', values: p.values }
        : p.dataType === 'bool' ? { type: 'bool' }
          : { type: 'range', min: p.min, max: p.max, stepSize: p.step || 1, unit: p.unit },
      dependsOn: p.dependsOn,
    }));
  }

  actions() {
    const a = [];
    if (this.units.XU2 !== undefined) {
      a.push({ actionId: 'saveToCamera', name: 'Save settings to camera', categoryId: 'device', isEnabled: true });
      a.push({ actionId: 'loadFromCamera', name: 'Load settings from camera', categoryId: 'device', isEnabled: true });
    }
    if (this.units.XU1 !== undefined) a.push({ actionId: 'oneTimeAutoFocus', name: 'Focus once', categoryId: 'focus', isEnabled: true });
    return a;
  }

  async invoke(actionId, params = {}) {
    if (actionId === 'saveToCamera') return this.saveToCamera(params.slot || 0);
    if (actionId === 'loadFromCamera') return this.loadFromCamera(params.slot || 0);
    if (actionId === 'oneTimeAutoFocus') return this.oneTimeAutoFocus();
    throw new Error(`unknown action ${actionId}`);
  }
}

module.exports = { CameraController, CATEGORIES, GUID, encodeInt, decodeInt, ledPayload };
