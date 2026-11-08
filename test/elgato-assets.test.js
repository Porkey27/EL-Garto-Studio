'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { edidPresets, parseFirmware } = require('../src/main/elgato-assets');

const file = (name, type, extra = {}) => ({ name, filename: `${name}.bin`, downloadUrl: `https://example.invalid/${encodeURIComponent(name)}.bin`, sha256: 'AB', type, ...extra });

// Shape of Elgato's list (trimmed): the card's own files plus a shared entry for all capture cards.
const manifest = {
  hardwareDevices: [
    { name: 'Game Capture 4K S', category: 'capture', id: { vendorId: 0x0fd9, productId: 0xaf }, edidFiles: [file('Game Capture 4K S', 'default'), file('4K S Switch 2 VRR', 'custom')] },
    { name: 'Shared Capture Assets', category: 'capture', isShared: true, id: { vendorId: 0, productId: 0 }, edidFiles: [file('1080p', 'custom'), file('1440p HDR', 'custom', { minimumFirmwareVersion: { type: 'MCU', versionNumber: 270101 } })] },
    { name: 'Other', category: 'camera', isShared: true, id: { vendorId: 0, productId: 0 }, edidFiles: [file('camera thing', 'custom')] },
  ],
};

test('EDID presets come in Studio order: default, shared, then the card\'s own', () => {
  const list = edidPresets(manifest, 0xaf, null);
  assert.deepStrictEqual(list.map((p) => [p.type, p.name]), [
    ['default', 'Game Capture 4K S (Default)'],
    ['custom', '1080p'],
    ['custom', '1440p HDR'],
    ['custom', '4K S Switch 2 VRR'],
  ]);
  assert.strictEqual(list[0].sha256, 'ab');
});

test('presets needing newer firmware are left out', () => {
  const names = edidPresets(manifest, 0xaf, 'Base 26.08.25, MCU 26.09.07').map((p) => p.name);
  assert.ok(!names.includes('1440p HDR'));
  assert.ok(names.includes('1080p'));
  assert.deepStrictEqual(parseFirmware('Base 26.08.25, MCU 26.09.07'), { base: 260825, mcu: 260907 });
});

test('cards without EDID files get no presets', () => {
  assert.deepStrictEqual(edidPresets(manifest, 0x1234, null), []);
});
