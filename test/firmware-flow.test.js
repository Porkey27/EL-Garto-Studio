'use strict';
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');

const assets = require('../src/main/elgato-assets');
const { FirmwareFlow } = require('../src/main/firmware/flow');
const { SimulatedFourKS } = require('../src/main/firmware/simulator');
const { constants } = require('../src/main/firmware/fourks');

function mcuImage() {
  const b = crypto.randomBytes(0x3000);
  b.writeUInt32LE(0x20001c10, 0);
  b.writeUInt32LE(0xd5, 4);
  return b;
}
function baseImage() {
  const b = Buffer.alloc(0x800000);
  b.write('SMEDIA02', 0, 'latin1');
  b.write('SMEDIA02', constants.BASE_ADDR, 'latin1');
  b.writeUInt32BE(0x3a8, constants.BASE_ADDR + 0x0c);
  b.writeUInt32BE(0x3030e, constants.BASE_ADDR + 0x10);
  return b;
}

const manifest = {
  hardwareDevices: [{
    name: 'Game Capture 4K S', category: 'capture', id: { vendorId: 0x0fd9, productId: 0xaf },
    firmware: [
      { type: 'Base', version: '26.08.25', downloadUrl: 'https://example.invalid/base.bin', importance: 'regular' },
      { type: 'MCU', version: '26.09.07', downloadUrl: 'https://example.invalid/mcu.bin', importance: 'regular' },
    ],
  }],
};

// A simulated card on a simulated USB bus: it drops off after RUN_APROM and when "replugged",
// and reports the new versions afterwards.
function rig({ state = 'app', dropDuringBase = 0 } = {}) {
  const card = new SimulatedFourKS({ base: [0x19, 0x07, 0x17], mcu: [0x19, 0x0c, 0x03], state });
  let present = true;
  const origBoot = card.onBootloader.bind(card);
  card.onBootloader = (out) => {
    origBoot(out);
    if (out[0] === 0xa4) { present = false; setTimeout(() => { present = true; }, 600); }
  };
  // Optionally make the card's HID path vanish during the next N Base writes (it re-enumerates).
  let drops = dropDuringBase;
  const hid = card.hid();
  const write = hid.write;
  hid.write = async (n, bytes) => {
    if (drops > 0 && bytes[0] === 0x03 && card.access && card.access.off >= 0x10000) {
      drops--;
      present = false;
      setTimeout(() => { present = true; }, 200);
      throw new Error('open: 0x00000002');
    }
    return write(n, bytes);
  };
  const platform = {
    hid,
    scan: async () => (present ? [{ model: { type: '4K_S' }, serial: 'SIM1', pid: 0xaf, controlHid: 'sim' }] : []),
  };
  const events = [];
  const flow = new FirmwareFlow(platform, {
    wait: async () => {},
    pollMs: 20,
    stableMs: 100,
    emit: (event, payload) => {
      events.push({ event, ...payload });
      if (event === 'replug' && payload.state === 'waiting-unplug') {
        // The user unplugs, then plugs back in; the card restarts on its new firmware.
        setTimeout(() => { present = false; }, 100);
        setTimeout(() => {
          card.versions.mcu = Buffer.from([0x1a, 0x09, 0x07]);
          if (events.some((e) => e.event === 'step' && e.step === 'base')) card.versions.base = Buffer.from([0x1a, 0x08, 0x19]);
          card.state = 'app';
          present = true;
        }, 900);
      }
    },
  });
  flow.loadFile = async (entry) => (entry.type === 'MCU' ? mcuImage() : baseImage());
  return { card, flow, events };
}

test('app update flow: check, MCU, replug, Base, replug, verify', { timeout: 60000 }, async (t) => {
  t.mock.method(assets, 'manifest', async () => manifest);
  const { flow, events } = rig();
  const info = await flow.check('SIM1');
  assert.deepStrictEqual(info.parts, { mcu: true, base: true });
  assert.strictEqual(info.current.mcu, '25.12.03');
  const out = await flow.run('SIM1');
  assert.deepStrictEqual(out, { updated: true, versions: { base: '26.08.25', mcu: '26.09.07' } });
  const steps = events.filter((e) => e.event === 'step').map((e) => `${e.step}:${e.state}`);
  assert.deepStrictEqual(steps, ['mcu:writing', 'mcu:done', 'base:writing', 'base:done']);
  assert.strictEqual(events.filter((e) => e.event === 'replug' && e.state === 'waiting-unplug').length, 2);
});

test('app update flow resumes an MCU left in its bootloader', { timeout: 60000 }, async (t) => {
  t.mock.method(assets, 'manifest', async () => manifest);
  const { flow } = rig({ state: 'ldrom' });
  const info = await flow.check('SIM1');
  assert.strictEqual(info.resume, true);
  assert.deepStrictEqual(info.parts, { mcu: true, base: false });
  const out = await flow.run('SIM1');
  assert.strictEqual(out.versions.mcu, '26.09.07');
});

test('app update flow retries the Base part when the card drops off USB during it', { timeout: 60000 }, async (t) => {
  t.mock.method(assets, 'manifest', async () => manifest);
  const { flow, card, events } = rig({ dropDuringBase: 1 });
  const out = await flow.run('SIM1');
  assert.strictEqual(out.updated, true);
  assert.strictEqual(card.flash[0x70000], 1, 'valid flag set after the retried, verified write');
  assert.ok(events.some((e) => e.event === 'status' && /retrying the Base part/.test(e.message)));
});

test('a Base left marked invalid is offered as an update even when the version matches', { timeout: 60000 }, async (t) => {
  t.mock.method(assets, 'manifest', async () => manifest);
  const { flow, card } = rig();
  card.versions.mcu = Buffer.from([0x1a, 0x09, 0x07]);
  card.versions.base = Buffer.from([0x1a, 0x08, 0x19]);
  assert.strictEqual((await flow.check('SIM1')).updateAvailable, false);
  card.flash[0x70000] = 0;
  const info = await flow.check('SIM1');
  assert.strictEqual(info.baseInterrupted, true);
  assert.deepStrictEqual(info.parts, { mcu: false, base: true });
});
