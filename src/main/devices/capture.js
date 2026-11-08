'use strict';
// Capture card controller: talks to the card's I2C bus through its vendor HID interface
// (see docs/PROTOCOL.md §2) and to the UVC processing unit for picture settings.

const platform = require('../platform');

const ADDR_MAIN = 0x55;

// GET_REPORT lengths Studio uses (wLength on the wire, without a report id). The cards stall
// longer requests, so these must not be taken from the report descriptor's maximum.
const REPLY_LEN_NEW = 0x7ff;
const REPLY_LEN_LEGACY = 0x24;
const REG = {
  SIGNAL: 0x00, PIPE_MODE: 0x01, FW_VERSION: 0x02, AUDIO_INPUT: 0x08, HDR_PACKET: 0x09,
  HDR_TONEMAP: 0x0a, COLOR_RANGE: 0x0b, LINE_IN_GAIN_NEW: 0x0d, LINE_IN_GAIN_LEGACY: 0x0e,
  EDID_MODE: 0x12, SAVE_SETTINGS: 0x13, SCALER: 0x19, USB_GEN: 0x1c, PASSTHROUGH_MONITOR: 0x2d,
};

// Studio writes 1 to SAVE_SETTINGS about a second after each change (seen in a USB capture of a
// 4K S); without it changes apply but are not kept across a power cycle.
const SAVE_DELAY_MS = 1000;

// Device generations that use the newer HID framing (elgatoDeviceType mask 0xd9423000).
const NEW_PROTOCOL_TYPES = new Set(['CAMLINK_4K_MK2', 'HD60_X', 'HD60_XPLUS', 'GAMECAPTURE_NEO', 'CAMLINK_4K_REV3', '4K_S', 'CAMLINK_4K_REV4']);
const LEGACY_GAIN_TYPES = new Set(['CAMLINK', 'CAMLINK_4K', 'HD60_SPLUS']);

const EDID_MODES = [{ value: 0, displayName: 'Internal' }, { value: 1, displayName: 'Display (pass-through)' }, { value: 2, displayName: 'Mix' }];
const COLOR_RANGES = [{ value: 0, displayName: 'Bypass' }, { value: 1, displayName: 'Expand' }, { value: 2, displayName: 'Shrink' }];
const AUDIO_INPUTS = [{ value: 0, displayName: 'HDMI' }, { value: 1, displayName: 'Analog (line in)' }];

class HidI2c {
  constructor(node, { newProtocol, native = platform, sizes } = {}) {
    this.node = node;
    this.newProtocol = !!newProtocol;
    this.hid = native.hid;
    this.sizes = sizes || (native.hidReportSizes ? native.hidReportSizes(node) : { input: {}, output: {}, feature: {} });
    this.queue = Promise.resolve();
  }

  // Sends a request report and reads the reply. Backends that can do both in one step (Windows)
  // provide hid.xfer; the reply is always [reportId, wire bytes…].
  async request(writeBytes, replyId, replyLen) {
    if (this.hid.xfer) return this.hid.xfer(this.node, writeBytes, replyId, replyLen);
    await this.hid.write(this.node, writeBytes);
    return this.hid.input(this.node, replyId, replyLen);
  }

  // Serialises transactions: each write/read pair must not interleave with another.
  exclusive(fn) {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => {});
    return run;
  }

  frame(reportId, payload) {
    const size = this.sizes.output[reportId];
    const body = size && size > payload.length ? Buffer.concat([payload, Buffer.alloc(size - payload.length)]) : payload;
    return Buffer.concat([Buffer.from([reportId]), body]);
  }

  write(addr, reg, data) {
    const d = Buffer.from(data);
    return this.exclusive(() => {
      if (this.newProtocol) {
        return this.hid.write(this.node, this.frame(0x06, Buffer.from([d.length + 5, 0x06, addr, d.length + 1, reg, ...d])));
      }
      return this.hid.write(this.node, this.frame(0x0b, Buffer.from([addr, reg, d.length, ...d])));
    });
  }

  read(addr, reg, len) {
    return this.exclusive(async () => {
      if (this.newProtocol) {
        const resp = await this.request(this.frame(0x06, Buffer.from([0x06, 0x07, addr, 0x01, reg, len])), 0x05, REPLY_LEN_NEW);
        return resp.subarray(2, 2 + len); // [reportId, status, data…]
      }
      const resp = await this.request(this.frame(0x09, Buffer.from([addr, reg, len])), 0x0a, REPLY_LEN_LEGACY);
      return resp.subarray(1, 1 + len); // [reportId, data…]
    });
  }
}

class CaptureController {
  constructor(device, { native = platform, v4l2 = platform.controls, i2c } = {}) {
    this.device = device;
    this.model = device.model || { features: {} };
    this.features = this.model.features || {};
    this.type = this.model.type;
    this.dev = device.videoNode;
    this.v4l2 = v4l2;
    this.i2c = i2c || (device.controlHid ? new HidI2c(device.controlHid, { newProtocol: NEW_PROTOCOL_TYPES.has(this.type), native }) : null);
    this.props = new Map();
    this.picture = new Map();
  }

  get swapsColorRange() { return this.type === 'HD60_SPLUS'; }
  get edidEepromAddr() {
    if (NEW_PROTOCOL_TYPES.has(this.type)) return 0xa0;
    return this.type === 'HD60_SPLUS' ? 0x51 : 0x50;
  }

  async readByte(reg) { return (await this.i2c.read(ADDR_MAIN, reg, 1))[0]; }

  async writeByte(reg, v) {
    await this.i2c.write(ADDR_MAIN, reg, [v & 0xff]);
    this.scheduleSave();
  }

  scheduleSave() {
    if (!NEW_PROTOCOL_TYPES.has(this.type)) return;
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.i2c.write(ADDR_MAIN, REG.SAVE_SETTINGS, [1]).catch(() => {});
    }, SAVE_DELAY_MS);
    if (this.saveTimer.unref) this.saveTimer.unref();
  }

  async refresh() {
    this.props.clear();
    const f = this.features;
    const hid = !!this.i2c;
    if (hid && f.edidMode) this.props.set('edidMode', { id: 'edidMode', name: 'Input EDID mode', category: 'input', dataType: 'enum', values: EDID_MODES, def: 0 });
    if (hid && f.colorRange) this.props.set('colorRange', { id: 'colorRange', name: 'HDMI color range', category: 'input', dataType: 'enum', values: COLOR_RANGES, def: 0 });
    if (hid && f.hdrTonemapping) this.props.set('hdrTonemapping', { id: 'hdrTonemapping', name: 'HDR tone mapping for third-party apps', category: 'input', dataType: 'bool', def: true });
    if (hid && f.audioInputs > 1) this.props.set('audioInput', { id: 'audioInput', name: 'Audio input', category: 'audio', dataType: 'enum', values: AUDIO_INPUTS, def: 0 });
    if (hid && f.audioInputs > 1) this.props.set('lineInGain', { id: 'lineInGain', name: 'Line-in gain', category: 'audio', dataType: 'int', min: 0x20, max: 0xb0, step: 1, def: 0x80 });
    if (hid && f.pictureSettings && NEW_PROTOCOL_TYPES.has(this.type)) {
      this.props.set('videoScaler', { id: 'videoScaler', name: 'Video scaler (card restarts)', category: 'input', dataType: 'bool', def: false });
    }
    if (this.dev) {
      try {
        const ctrls = await this.v4l2.listControls(this.dev);
        for (const name of ['brightness', 'contrast', 'hue', 'saturation']) {
          const c = ctrls.find((x) => x.name === name);
          if (!c) continue;
          this.picture.set(name, c);
          this.props.set(name, { id: name, name: name[0].toUpperCase() + name.slice(1), category: 'picture', dataType: 'int', min: c.min, max: c.max, step: c.step || 1, def: c.default, v4l2: name });
        }
      } catch { /* device busy */ }
    }
    return this.describe();
  }

  async get(id) {
    const p = this.props.get(id);
    if (!p) throw new Error(`unknown property ${id}`);
    if (p.v4l2) {
      const c = (await this.v4l2.listControls(this.dev)).find((x) => x.name === p.v4l2);
      return c ? c.value : undefined;
    }
    switch (id) {
      case 'edidMode': return this.readByte(REG.EDID_MODE);
      case 'colorRange': {
        const raw = await this.readByte(REG.COLOR_RANGE);
        return this.swapsColorRange && raw ? 3 - raw : raw;
      }
      case 'hdrTonemapping': return (await this.readByte(REG.HDR_TONEMAP)) !== 0;
      case 'audioInput': return (await this.readByte(REG.AUDIO_INPUT)) ? 1 : 0;
      case 'lineInGain': return this.readByte(LEGACY_GAIN_TYPES.has(this.type) ? REG.LINE_IN_GAIN_LEGACY : REG.LINE_IN_GAIN_NEW);
      case 'videoScaler': return (await this.readByte(REG.SCALER)) !== 0;
      default: return undefined;
    }
  }

  async set(id, value) {
    const p = this.props.get(id);
    if (!p) throw new Error(`unknown property ${id}`);
    if (p.v4l2) return this.v4l2.setControl(this.dev, p.v4l2, Math.max(p.min, Math.min(p.max, Number(value))));
    const v = Number(value);
    switch (id) {
      case 'edidMode': return this.writeByte(REG.EDID_MODE, [0, 1, 2].includes(v) ? v : 0);
      case 'colorRange': return this.writeByte(REG.COLOR_RANGE, this.swapsColorRange && v ? 3 - v : v);
      case 'hdrTonemapping': return this.writeByte(REG.HDR_TONEMAP, value ? 1 : 0);
      case 'audioInput': return this.writeByte(REG.AUDIO_INPUT, v === 1 ? 1 : 0);
      case 'lineInGain': {
        const g = Math.max(p.min, Math.min(p.max, v));
        return this.writeByte(LEGACY_GAIN_TYPES.has(this.type) ? REG.LINE_IN_GAIN_LEGACY : REG.LINE_IN_GAIN_NEW, g);
      }
      case 'videoScaler':
        // Cancel any pending save: it would fire while the card is offline and be lost (seen in a
        // capture). Commit once the card answers again instead.
        clearTimeout(this.saveTimer);
        await this.i2c.write(ADDR_MAIN, REG.SCALER, [value ? 1 : 0]);
        await this.waitForReconnect();
        this.scheduleSave();
        return undefined;
      default: return undefined;
    }
  }

  // Changing the video scaler makes the card restart: on a 4K S it leaves USB about 1.1 s after
  // the write and is back about 0.6 s later, with the new value kept. Wait until it answers again.
  async waitForReconnect({ settleMs = 1500, timeoutMs = 10000 } = {}) {
    await new Promise((r) => setTimeout(r, settleMs));
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        await this.readByte(REG.SCALER);
        return;
      } catch (e) {
        if (Date.now() > deadline) throw new Error(`device did not come back after restart: ${e.message}`);
        await new Promise((r) => setTimeout(r, 250));
      }
    }
  }

  async reset(id) {
    const p = this.props.get(id);
    if (p && p.def !== undefined) await this.set(id, p.def);
  }

  async resetCategory(categoryId) {
    for (const p of this.props.values()) if (p.category === categoryId) await this.reset(p.id).catch(() => {});
  }

  // New devices return Base then MCU as decimal YY MM DD bytes (a 4K S answers 1a 08 19 1a 09 07,
  // i.e. Base 26.08.25, MCU 26.09.07). The legacy layout is unconfirmed, so it is shown raw.
  async firmwareVersion() {
    if (!this.i2c) return null;
    const ymd = (b) => [...b].map((x) => String(x).padStart(2, '0')).join('.');
    if (NEW_PROTOCOL_TYPES.has(this.type)) {
      const b = await this.i2c.read(ADDR_MAIN, REG.FW_VERSION, 6);
      return `Base ${ymd(b.subarray(0, 3))}, MCU ${ymd(b.subarray(3, 6))}`;
    }
    const b = await this.i2c.read(ADDR_MAIN, REG.FW_VERSION, 4);
    return [...b].join('.');
  }

  // Register 0: [?, width u16le, height u16le, fps, ?, ?]; all zero without a signal.
  async signal() {
    if (!this.i2c) return null;
    const b = await this.i2c.read(ADDR_MAIN, REG.SIGNAL, 8);
    const width = b.readUInt16LE(1);
    const height = b.readUInt16LE(3);
    return { hasSignal: width > 0 && height > 0, width, height, framerate: b[5], raw: b.toString('hex') };
  }

  // Register 9: the HDMI Dynamic Range and Mastering InfoFrame the source sends (Studio reads
  // 32 bytes about once a second). See hdr.parseDrmInfoFrame.
  async hdrPacket() {
    if (!this.i2c) return null;
    return this.i2c.read(ADDR_MAIN, REG.HDR_PACKET, 32);
  }

  async isPassthroughMonitorConnected() {
    if (!this.i2c) return false;
    return (await this.readByte(REG.PASSTHROUGH_MONITOR)) !== 0;
  }

  edidOffsetReg(off) { return off < 0x100 ? off & 0xff : ((off & 0xff) + 1) & 0xff; }

  // Magic 12 34, command 0x69, bank. Studio always selects bank 1 before EDID access.
  async selectEdidBank(bank) {
    if (NEW_PROTOCOL_TYPES.has(this.type)) await this.i2c.write(0xaa, 0x03, [0x12, 0x34, 0x69, bank]);
  }

  async readEdid(size = 256) {
    if (!this.i2c || !this.features.customEdid) throw new Error('EDID access not supported on this device');
    await this.selectEdidBank(1);
    const out = Buffer.alloc(size);
    for (let off = 0; off < size; off += 8) {
      const chunk = await this.i2c.read(this.edidEepromAddr, this.edidOffsetReg(off), 8);
      chunk.copy(out, off);
    }
    return out;
  }

  // Writes an EDID to the card's EEPROM, verifying each 8-byte chunk.
  async writeEdid(edid, { onProgress } = {}) {
    if (!this.i2c || !this.features.customEdid) throw new Error('EDID access not supported on this device');
    const data = Buffer.from(edid);
    if (data.length % 128 !== 0 || data.length > 256) throw new Error('EDID must be 128 or 256 bytes');
    if (data.readUInt32BE(0) !== 0x00ffffff || data.readUInt32BE(4) !== 0xffffff00) throw new Error('not an EDID (bad header)');
    for (let blk = 0; blk < data.length; blk += 128) {
      let sum = 0;
      for (let i = 0; i < 128; i++) sum += data[blk + i];
      if (sum & 0xff) throw new Error(`EDID block ${blk / 128} checksum invalid`);
    }
    await this.selectEdidBank(1);
    for (let off = 0; off < data.length; off += 8) {
      const chunk = data.subarray(off, off + 8);
      await this.i2c.write(this.edidEepromAddr, this.edidOffsetReg(off), chunk);
      await new Promise((r) => setTimeout(r, 10));
      const back = await this.i2c.read(this.edidEepromAddr, this.edidOffsetReg(off), 8);
      if (!back.equals(chunk)) throw new Error(`EDID verify failed at offset ${off}`);
      if (onProgress) onProgress((off + 8) / data.length);
    }
    this.scheduleSave();
  }

  async setRecordingLed(on) {
    if (!this.i2c) return;
    await this.i2c.write(0x66, 0xaa, [0x12, 0, 0, on ? 1 : 0, 0, 0, 0, 0]);
  }

  describe() {
    return [...this.props.values()].map((p) => ({
      propertyId: p.id,
      name: p.name,
      dataType: p.dataType,
      categoryId: p.category,
      readOnly: false,
      canReset: p.def !== undefined,
      valueInfo: p.dataType === 'enum' ? { type: 'enum', values: p.values }
        : p.dataType === 'bool' ? { type: 'bool' }
          : { type: 'range', min: p.min, max: p.max, stepSize: p.step || 1 },
    }));
  }

  actions() {
    return [];
  }

  async invoke(actionId) {
    throw new Error(`unknown action ${actionId}`);
  }
}

const CAPTURE_CATEGORIES = [
  { categoryId: 'input', name: 'Input', canReset: true },
  { categoryId: 'picture', name: 'Picture', canReset: true },
  { categoryId: 'audio', name: 'Audio', canReset: true },
];

module.exports = { CaptureController, HidI2c, CAPTURE_CATEGORIES, NEW_PROTOCOL_TYPES, REG };
