'use strict';
const test = require('node:test');
const assert = require('node:assert');

const { CameraController, encodeInt, decodeInt, ledPayload } = require('../src/main/devices/camera');
const { CaptureController, HidI2c } = require('../src/main/devices/capture');

function fakeXu(store = {}) {
  const calls = [];
  const key = (u, s) => `${u}:${s}`;
  return {
    calls,
    xu: {
      get: async (_d, u, s, len) => { calls.push(['get', u, s]); return Buffer.from(store[key(u, s)] || Buffer.alloc(len)); },
      set: async (_d, u, s, data) => { calls.push(['set', u, s, Buffer.from(data).toString('hex')]); store[key(u, s)] = Buffer.from(data); },
      min: async (_d, _u, _s, len) => encodeInt(-50, len, true),
      max: async (_d, _u, _s, len) => encodeInt(50, len, true),
      def: async (_d, _u, _s, len) => encodeInt(0, len, true),
      len: async () => 1,
    },
  };
}

const fakeV4l2 = (controls) => {
  const set = [];
  return {
    set,
    listControls: async () => controls.map((c) => ({ ...c })),
    setControl: async (_d, name, v) => { set.push([name, v]); const c = controls.find((x) => x.name === name); if (c) c.value = v; },
  };
};

test('int encoding is little-endian and respects sign/size', () => {
  assert.strictEqual(encodeInt(-2, 2, true).toString('hex'), 'feff');
  assert.strictEqual(encodeInt(300, 4, false).toString('hex'), '2c010000');
  assert.strictEqual(decodeInt(Buffer.from('feff', 'hex'), true), -2);
  assert.strictEqual(ledPayload(2, 128).toString('hex'), 'ff000200008000000000');
});

test('camera exposes V4L2 and XU properties and writes the right selectors', async () => {
  const native = fakeXu();
  const v4l2 = fakeV4l2([
    { name: 'brightness', type: 'int', min: 0, max: 255, step: 1, default: 128, value: 100 },
    { name: 'auto_exposure', type: 'menu', min: 0, max: 3, default: 3, value: 3, menu: { 1: 'Manual', 3: 'Aperture' } },
    { name: 'exposure_time_absolute', type: 'int', min: 1, max: 10000, step: 1, default: 166, value: 166 },
  ]);
  const cam = new CameraController({ videoNode: '/dev/video0', model: { type: 'FACECAM_MK2' } }, { v4l2, native, units: { XU1: 4, XU2: 6 } });
  const desc = await cam.refresh();
  const ids = desc.map((p) => p.propertyId);
  for (const id of ['brightness', 'autoExposure', 'shutterSpeed', 'vibrancy', 'tint', 'exposureMetering', 'dynamicRange', 'noiseReduction', 'statusLed', 'ledBrightness']) {
    assert.ok(ids.includes(id), `missing ${id}`);
  }
  assert.deepStrictEqual(desc.find((p) => p.propertyId === 'vibrancy').valueInfo, { type: 'range', min: -50, max: 50, stepSize: 1, unit: undefined });

  assert.strictEqual(await cam.get('autoExposure'), true);
  await cam.set('autoExposure', false);
  assert.deepStrictEqual(v4l2.set.pop(), ['auto_exposure', 1]);
  await cam.set('brightness', 999);
  assert.deepStrictEqual(v4l2.set.pop(), ['brightness', 255], 'clamped to max');

  await cam.set('dynamicRange', 2);
  assert.deepStrictEqual(native.calls.pop(), ['set', 4, 0x15, '02']);
  await cam.set('tint', -3);
  assert.deepStrictEqual(native.calls.pop(), ['set', 4, 0x12, 'fdff']);
  assert.strictEqual(await cam.get('tint'), -3);

  await cam.set('statusLed', 2);
  const led = native.calls.slice(-2).map((c) => c[3]);
  assert.deepStrictEqual(led, [ledPayload(3, 255).toString('hex'), ledPayload(2, 255).toString('hex')]);
  await cam.set('statusLed', 0);
  assert.deepStrictEqual(native.calls.slice(-2).map((c) => c[3]), [ledPayload(3, 0).toString('hex'), ledPayload(2, 0).toString('hex')]);

  await cam.invoke('saveToCamera');
  assert.deepStrictEqual(native.calls.pop(), ['set', 6, 0x07, '00']);
});

test('camera without Elgato XUs only shows standard controls', async () => {
  const cam = new CameraController({ videoNode: '/dev/video0' }, {
    v4l2: fakeV4l2([{ name: 'zoom_absolute', type: 'int', min: 100, max: 400, step: 1, default: 100, value: 100 }]),
    native: fakeXu(), units: {},
  });
  const desc = await cam.refresh();
  assert.deepStrictEqual(desc.map((p) => p.propertyId), ['zoom']);
  assert.deepStrictEqual(cam.actions(), []);
});

function fakeHid(responses) {
  const writes = [];
  return {
    writes,
    hid: {
      write: async (_n, bytes) => { writes.push(Buffer.from(bytes).toString('hex')); },
      input: async (_n, id, len) => { const r = Buffer.alloc(len); r[0] = id; (responses[id] || Buffer.alloc(0)).copy(r, 1); return r; },
    },
  };
}

test('HidI2c new framing matches the decompiled layout', async () => {
  const f = fakeHid({ 5: Buffer.from([0x00, 0x02]) }); // status byte, then data
  const i2c = new HidI2c('/dev/hidraw0', { newProtocol: true, native: f, sizes: { input: { 5: 8 }, output: {}, feature: {} } });
  await i2c.write(0x55, 0x12, [1]);
  // [reportId 6] + [len+5, opcode 6 (write), addr, len+1, reg, data]
  assert.strictEqual(f.writes[0], '06' + '06' + '06' + '55' + '02' + '12' + '01');
  const v = await i2c.read(0x55, 0x0b, 1);
  assert.strictEqual(f.writes[1], '06' + '06' + '07' + '55' + '01' + '0b' + '01');
  assert.deepStrictEqual([...v], [0x02]);
});

test('HidI2c legacy framing pads to the descriptor output size', async () => {
  const f = fakeHid({ 0x0a: Buffer.from([0x01]) });
  const i2c = new HidI2c('/dev/hidraw0', { newProtocol: false, native: f, sizes: { input: { 0x0a: 36 }, output: { 0x0b: 6 }, feature: {} } });
  await i2c.write(0x55, 0x08, [1]);
  assert.strictEqual(f.writes[0], '0b' + '550801' + '01' + '0000');
  const v = await i2c.read(0x55, 0x08, 1);
  assert.strictEqual(f.writes[1], '09' + '550801');
  assert.deepStrictEqual([...v], [1]);
});

test('capture controller maps settings to registers (incl. HD60 S+ colour range swap)', async () => {
  const writes = [];
  const regs = { 0x0b: 1 };
  const i2c = {
    write: async (addr, reg, data) => { writes.push([addr, reg, [...data]]); regs[reg] = data[0]; },
    read: async (_a, reg, len) => Buffer.alloc(len, regs[reg] || 0),
  };
  const v4l2 = fakeV4l2([{ name: 'hue', type: 'int', min: -10, max: 10, step: 1, default: 0, value: 0 }]);
  const make = (type, features) => new CaptureController({ videoNode: '/dev/video0', model: { type, features } }, { i2c, v4l2 });

  const hd60s = make('HD60_SPLUS', { edidMode: true, colorRange: true, hdrTonemapping: true, audioInputs: 3, customEdid: true });
  await hd60s.refresh();
  await hd60s.set('colorRange', 1); // expand
  assert.deepStrictEqual(writes.pop(), [0x55, 0x0b, [2]]);
  assert.strictEqual(await hd60s.get('colorRange'), 1);
  await hd60s.set('lineInGain', 0x10);
  assert.deepStrictEqual(writes.pop(), [0x55, 0x0e, [0x20]], 'legacy register, clamped to min');
  assert.strictEqual(hd60s.edidEepromAddr, 0x51);

  const hd60x = make('HD60_X', { edidMode: true, colorRange: true, hdrTonemapping: true, audioInputs: 3, pictureSettings: true });
  const desc = await hd60x.refresh();
  assert.ok(desc.some((p) => p.propertyId === 'hue'));
  await hd60x.set('colorRange', 1);
  assert.deepStrictEqual(writes.pop(), [0x55, 0x0b, [1]]);
  await hd60x.set('edidMode', 2);
  assert.deepStrictEqual(writes.pop(), [0x55, 0x12, [2]]);
  await hd60x.set('hdrTonemapping', false);
  assert.deepStrictEqual(writes.pop(), [0x55, 0x0a, [0]]);
  await hd60x.set('lineInGain', 0x90);
  assert.deepStrictEqual(writes.pop(), [0x55, 0x0d, [0x90]]);
  assert.strictEqual(hd60x.edidEepromAddr, 0xa0);
});

test('EDID write validates header and checksum before touching the device', async () => {
  const writes = [];
  const i2c = { write: async (...a) => writes.push(a), read: async (_a, _r, len) => Buffer.alloc(len) };
  const cap = new CaptureController({ model: { type: 'HD60_X', features: { customEdid: true } } }, { i2c, v4l2: fakeV4l2([]) });
  await assert.rejects(cap.writeEdid(Buffer.alloc(128)), /bad header/);
  const edid = Buffer.alloc(128);
  Buffer.from('00ffffffffffff00', 'hex').copy(edid);
  edid[127] = 1; // wrong checksum
  await assert.rejects(cap.writeEdid(edid), /checksum/);
  assert.strictEqual(writes.length, 0);
});

test('video scaler changes wait for the card to come back after its restart', async () => {
  let reads = 0;
  const writes = [];
  const i2c = {
    write: async (...a) => writes.push(a),
    read: async (_a, _reg, len) => {
      reads += 1;
      if (reads <= 2) throw new Error('error: open: 0x00000002'); // card is off the bus
      return Buffer.alloc(len, 1);
    },
  };
  const cap = new CaptureController({ model: { type: '4K_S', features: { pictureSettings: true } } }, { i2c, v4l2: fakeV4l2([]) });
  await cap.refresh();
  const started = Date.now();
  await cap.set('videoScaler', true);
  assert.strictEqual(reads, 3, 'polled until the card answered');
  assert.ok(Date.now() - started >= 1500, 'gave the card time to drop off first');
  assert.deepStrictEqual(writes[0], [0x55, 0x19, [1]]);
  assert.strictEqual(writes.length, 1, 'no save while the card was offline');
  await new Promise((r) => setTimeout(r, 1100));
  assert.deepStrictEqual(writes[1], [0x55, 0x13, [1]], 'save commit after the card is back');
});

test('EDID offsets above 255 use the original +1 quirk', () => {
  const cap = new CaptureController({ model: { type: 'HD60_X', features: {} } }, { i2c: {}, v4l2: fakeV4l2([]) });
  assert.strictEqual(cap.edidOffsetReg(0), 0);
  assert.strictEqual(cap.edidOffsetReg(248), 248);
  assert.strictEqual(cap.edidOffsetReg(256), 1);
  assert.strictEqual(cap.edidOffsetReg(264), 9);
});
