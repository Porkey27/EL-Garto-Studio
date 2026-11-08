'use strict';
// Byte sequences recorded with USBPcap from Elgato Studio driving a Game Capture 4K S
// (0fd9:00af, 2026-11-08). Output reports are shown as they appear on the wire (report id first);
// input replies are the wire bytes [status, data...] with the report id Linux adds in front.
const test = require('node:test');
const assert = require('node:assert');

const { CaptureController, HidI2c } = require('../src/main/devices/capture');

const RECORDED_WRITES = {
  edidModeDisplay: '06060655021201',
  colorRangeShrink: '06060655020b02',
  audioAnalog: '06060655020801',
  lineInGain9b: '06060655020d9b',
  saveSettings: '06060655021301',
  edidBank1: '060906aa050312346901',
  edidChunk0: '060d06a0090000ffffffffffff00',
  readAudioInput: '06060755010801',
  readEdidChunk8: '060607a0010808',
};

function recorder(replies = {}) {
  const writes = [];
  let lastRead = null;
  const hid = {
    write: async (_n, bytes) => {
      const hex = Buffer.from(bytes).toString('hex');
      writes.push(hex);
      if (bytes[2] === 0x07) lastRead = `${bytes[3].toString(16)}:${bytes[5].toString(16)}`;
    },
    input: async (_n, id, len) => {
      const r = Buffer.alloc(len);
      r[0] = id;
      Buffer.from(replies[lastRead] || '00', 'hex').copy(r, 1);
      return r;
    },
  };
  return { writes, native: { hid } };
}

const strip = (hex) => hex.replace(/(00)+$/, '');

test('new-protocol framing matches the recorded writes byte for byte', async () => {
  const rec = recorder({ '55:8': '0001', 'a0:8': '0014e1af0000000000' });
  const i2c = new HidI2c('/dev/hidraw0', { newProtocol: true, native: rec.native, sizes: { input: { 5: 64 }, output: { 6: 255 }, feature: {} } });
  const cap = new CaptureController({ model: { type: '4K_S', features: { edidMode: true, colorRange: true, audioInputs: 3, customEdid: true } } }, { i2c, v4l2: { listControls: async () => [] } });
  await cap.refresh();

  await cap.set('edidMode', 1);
  await cap.set('colorRange', 2);
  await cap.set('audioInput', 1);
  await cap.set('lineInGain', 0x9b);
  assert.deepStrictEqual(rec.writes.map(strip), [
    RECORDED_WRITES.edidModeDisplay, RECORDED_WRITES.colorRangeShrink, RECORDED_WRITES.audioAnalog, RECORDED_WRITES.lineInGain9b,
  ]);
  assert.strictEqual(rec.writes[0].length, 256 * 2, 'padded to the 255-byte output report plus id');

  assert.strictEqual(await cap.get('audioInput'), 1);
  assert.strictEqual(strip(rec.writes.at(-1)), RECORDED_WRITES.readAudioInput);

  await cap.selectEdidBank(1);
  assert.strictEqual(strip(rec.writes.at(-1)), RECORDED_WRITES.edidBank1);
  const chunk = await i2c.read(0xa0, 0x08, 8);
  assert.strictEqual(strip(rec.writes.at(-1)), RECORDED_WRITES.readEdidChunk8);
  assert.strictEqual(chunk.toString('hex'), '14e1af0000000000');
  clearTimeout(cap.saveTimer);
});

test('settings changes are followed by the save-settings write', async () => {
  const rec = recorder();
  const i2c = new HidI2c('/dev/hidraw0', { newProtocol: true, native: rec.native, sizes: { input: {}, output: {}, feature: {} } });
  const cap = new CaptureController({ model: { type: '4K_S', features: { colorRange: true } } }, { i2c, v4l2: { listControls: async () => [] } });
  await cap.refresh();
  await cap.set('colorRange', 1);
  await cap.set('colorRange', 0);
  await new Promise((r) => setTimeout(r, 1200));
  assert.deepStrictEqual(rec.writes.slice(2), [RECORDED_WRITES.saveSettings], 'one save after the burst of changes');
});

test('EDID chunk writes use the recorded framing', async () => {
  const rec = recorder();
  const i2c = new HidI2c('/dev/hidraw0', { newProtocol: true, native: rec.native, sizes: { input: {}, output: {}, feature: {} } });
  await i2c.write(0xa0, 0x00, Buffer.from('00ffffffffffff00', 'hex'));
  assert.strictEqual(rec.writes[0], RECORDED_WRITES.edidChunk0);
});

test('firmware version and signal replies decode as Studio shows them', async () => {
  const rec = recorder({ '55:2': '001a08191a0907', '55:0': '0000800738043c5600' });
  const i2c = new HidI2c('/dev/hidraw0', { newProtocol: true, native: rec.native, sizes: { input: { 5: 64 }, output: {}, feature: {} } });
  const cap = new CaptureController({ model: { type: '4K_S', features: {} } }, { i2c, v4l2: { listControls: async () => [] } });
  assert.strictEqual(await cap.firmwareVersion(), 'Base 26.08.25, MCU 26.09.07');
  const sig = await cap.signal();
  assert.deepStrictEqual([sig.hasSignal, sig.width, sig.height, sig.framerate], [true, 1920, 1080, 60]);
});
