'use strict';
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { FourKSUpdater, Link, UpdateError, checkMcuImage, baseLayout, constants } = require('../src/main/firmware/fourks');
const { SimulatedFourKS } = require('../src/main/firmware/simulator');

const noWait = async () => {};

function fakeMcuImage(size = 0x2000) {
  const b = crypto.randomBytes(size);
  b.writeUInt32LE(0x20001c10, 0); // stack pointer in SRAM
  b.writeUInt32LE(0x000000d5, 4); // Thumb reset vector
  return b;
}

function fakeBaseImage() {
  const b = Buffer.alloc(0x800000, 0);
  b.write('SMEDIA02', 0, 'latin1');
  b.write('SMEDIA02', constants.BASE_ADDR, 'latin1');
  b.writeUInt32BE(0x3a8, constants.BASE_ADDR + 0x0c);
  b.writeUInt32BE(0x3030e, constants.BASE_ADDR + 0x10);
  crypto.randomBytes(0x40000 - 0x20).copy(b, constants.BASE_ADDR + 0x20);
  crypto.randomBytes(0x20000).copy(b, 0x500000);
  return b;
}

test('image checks reject files that are not 4K S firmware', () => {
  assert.throws(() => checkMcuImage(Buffer.alloc(0x2000)), UpdateError);
  assert.throws(() => checkMcuImage(Buffer.alloc(0x20000)), /size/);
  assert.doesNotThrow(() => checkMcuImage(fakeMcuImage()));
  assert.throws(() => baseLayout(Buffer.alloc(0x800000)), /SMEDIA02/);
  assert.deepStrictEqual(baseLayout(fakeBaseImage()).main, { addr: 0x180000, len: 0x40000 }, '(0x3a8 + 0x3030e) rounded to 64 KB');
});

test('MCU update runs the bootloader protocol and checks every chunk', async () => {
  const card = new SimulatedFourKS();
  const up = new FourKSUpdater(new Link(card.hid(), 'sim'), { wait: noWait });
  const img = fakeMcuImage(0x2345);
  await up.updateMcu(img);
  assert.deepStrictEqual(Buffer.from(card.mcuImage), Buffer.concat([img, Buffer.alloc(constants.MCU_PADDING)]));
  assert.strictEqual(card.state, 'running-new');
});

test('MCU update stops at the first write the bootloader did not take', async () => {
  const card = new SimulatedFourKS();
  const hid = card.hid();
  let chunks = 0;
  const orig = card.onBootloader.bind(card);
  card.onBootloader = (out) => {
    if (out[0] === 0xae && ++chunks === 3) return; // drop the third chunk
    orig(out);
  };
  const up = new FourKSUpdater(new Link(hid, 'sim'), { wait: noWait });
  await assert.rejects(up.updateMcu(fakeMcuImage()), /write pointer/);
  assert.strictEqual(card.state, 'ldrom', 'still in the bootloader, so the update can be rerun');
});

test('a stale pointer reply (card still programming) is re-read, not treated as a failure', async () => {
  const card = new SimulatedFourKS({ staleReads: [35] }); // the chunk that failed on the real card
  const up = new FourKSUpdater(new Link(card.hid(), 'sim'), { wait: noWait });
  const img = fakeMcuImage(0x4000);
  await up.updateMcu(img);
  assert.deepStrictEqual(Buffer.from(card.mcuImage), Buffer.concat([img, Buffer.alloc(constants.MCU_PADDING)]));
  assert.strictEqual(card.state, 'running-new');
});

test('an MCU left in its bootloader is detected and the update resumes without the jump', async () => {
  const card = new SimulatedFourKS({ state: 'ldrom' });
  const up = new FourKSUpdater(new Link(card.hid(), 'sim'), { wait: noWait });
  assert.deepStrictEqual(await up.mcuState(), { mode: 'ldrom' });
  const img = fakeMcuImage();
  await up.updateMcu(img);
  assert.ok(!card.frames.some((h) => h.startsWith('060d066609aa')), 'no jump-to-bootloader sent');
  assert.deepStrictEqual(Buffer.from(card.mcuImage), Buffer.concat([img, Buffer.alloc(constants.MCU_PADDING)]));
  assert.strictEqual(card.state, 'running-new');
});

test('Base update clears the valid flag, writes, verifies, then sets it again', async () => {
  const card = new SimulatedFourKS();
  const up = new FourKSUpdater(new Link(card.hid(), 'sim'), { wait: noWait });
  const img = fakeBaseImage();
  await up.updateBase(img);
  assert.ok(card.flash.subarray(0x180000, 0x1c0000).equals(img.subarray(0x180000, 0x1c0000)));
  assert.ok(card.flash.subarray(0x500000, 0x520000).equals(img.subarray(0x500000, 0x520000)));
  assert.strictEqual(card.flash[0x70000], 1);
});

test('Base update leaves the card marked invalid when verification fails', async () => {
  const card = new SimulatedFourKS();
  const hid = card.hid();
  const input = hid.input;
  hid.input = async (n, id, len) => {
    const r = await input(n, id, len);
    if (id === 0x01 && card.access.mode === 0) r[100] ^= 0xff; // corrupt the read-back
    return r;
  };
  const up = new FourKSUpdater(new Link(hid, 'sim'), { wait: noWait });
  await assert.rejects(up.updateBase(fakeBaseImage()), /verify failed/);
  assert.strictEqual(card.flash[0x70000], 0, 'config flag stays "update in progress"');
});

// Byte-for-byte comparison with Elgato Studio's own update, using the official files if present
// (they are not redistributed: run tools/firmware-update.js once to download them).
const FW_DIR = path.join(__dirname, '..', 'captures', 'firmware');
const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'fourks-update-frames.json'), 'utf8'));
const haveFiles = ['mcu', 'base'].every((k) => fs.existsSync(path.join(FW_DIR, fixture.firmware[k])));

test('frames sent match the captured Studio update exactly', { skip: !haveFiles && 'official firmware files not in captures/firmware' }, async () => {
  const mcu = fs.readFileSync(path.join(FW_DIR, fixture.firmware.mcu));
  const base = fs.readFileSync(path.join(FW_DIR, fixture.firmware.base));
  const card = new SimulatedFourKS();
  const up = new FourKSUpdater(new Link(card.hid(), 'sim'), { wait: noWait });
  await up.updateMcu(mcu);
  await up.updateBase(base);
  const frames = card.frames.map((h) => Buffer.from(h, 'hex'));

  const chunks = frames.filter((f) => f[0] === 0x06 && f[2] === 0x06 && f[3] === 0x6c && f[5] === 0xae);
  const h1 = crypto.createHash('sha256');
  chunks.forEach((c) => h1.update(c));
  assert.strictEqual(chunks.length, fixture.mcuChunks.count);
  assert.strictEqual(chunks[0].length, fixture.mcuChunks.frameLen);
  assert.strictEqual(h1.digest('hex'), fixture.mcuChunks.sha256, 'MCU chunk frames identical to Studio');

  const commands = [];
  for (const f of frames) {
    if (f[0] !== 0x06 || f[2] !== 0x06 || ![0x66, 0x6c].includes(f[3]) || f[5] === 0xae) continue;
    const hex = f.subarray(0, 5 + f[4]).toString('hex');
    if (!commands.includes(hex)) commands.push(hex);
  }
  assert.deepStrictEqual(commands, fixture.mcuCommands, 'same bootloader commands in the same order');

  const flash = frames.filter((f) => f[0] === 0x03 || f[0] === 0x04);
  const h2 = crypto.createHash('sha256');
  flash.forEach((f) => h2.update(f));
  assert.strictEqual(flash.length, fixture.flashFrames.count);
  assert.strictEqual(h2.digest('hex'), fixture.flashFrames.sha256, 'Base flash frames identical to Studio');
});
