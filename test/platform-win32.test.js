'use strict';
// Windows backend logic, fed with real egctl.exe output recorded on a PC with a Game Capture 4K S
// and a generic 2K webcam (2026-11-08).
const test = require('node:test');
const assert = require('node:assert');

const win = require('../src/main/platform/win32')._internal;

const LIST = {
  hid: [{
    path: '\\\\?\\hid#vid_0fd9&pid_00af&mi_07#8&18851a66&0&0000#{4d1e55b2-f16f-11cf-88cb-001111000030}',
    vid: 4057, pid: 175, interface: 7, usagePage: 65440, input: 4097, output: 4100, feature: 0,
    parent: 'USB\\VID_0FD9&PID_00AF\\AC8KB0000TEST1',
  }],
  video: [
    { name: 'Elgato 4K S', path: '\\\\?\\usb#vid_0fd9&pid_00af&mi_00#7&2f30fe46&0&0000#{65e8773d-8f56-11d0-a3b9-00a0c9223196}\\global', parent: 'USB\\VID_0FD9&PID_00AF\\AC8KB0000TEST1' },
    { name: '2K USB Camera', path: '\\\\?\\usb#vid_0c75&pid_6396&mi_00#9&355bf9e4&0&0000#{65e8773d-8f56-11d0-a3b9-00a0c9223196}\\global', parent: 'USB\\VID_0C75&PID_6396\\SN0001' },
  ],
};

const WEBCAM_CONTROLS = [
  { set: 'procamp', prop: 0, min: -64, max: 64, step: 1, default: 0, caps: 2, value: 0, flags: 2 },
  { set: 'procamp', prop: 7, min: 2800, max: 6500, step: 1, default: 4600, caps: 3, value: 4600, flags: 1 },
  { set: 'procamp', prop: 13, min: 0, max: 2, step: 1, default: 1, caps: 0, value: 1, flags: 0 },
  { set: 'camera', prop: 4, min: -13, max: -1, step: 1, default: -6, caps: 3, value: -6, flags: 1 },
];

test('device list groups HID and video interfaces by their USB parent', () => {
  const devs = win.buildDevices(LIST);
  assert.strictEqual(devs.length, 2);
  const s = devs.find((d) => d.vid === 0x0fd9);
  assert.strictEqual(s.name, 'Game Capture 4K S');
  assert.strictEqual(s.kind, 'capture');
  assert.strictEqual(s.id, '0fd9:00af:AC8KB0000TEST1');
  assert.strictEqual(s.controlHid, LIST.hid[0].path, 'HID interface 7 is the control channel');
  assert.strictEqual(s.videoNode, LIST.video[0].path);
  assert.strictEqual(s.videoName, 'Elgato 4K S');
  const cam = devs.find((d) => d.vid === 0x0c75);
  assert.strictEqual(cam.kind, 'generic');
  assert.strictEqual(cam.name, '2K USB Camera');
  assert.strictEqual(cam.controlHid, null);
});

test('DirectShow controls map to V4L2 names, including auto flags and exposure units', () => {
  const c = Object.fromEntries(win.mapControls(WEBCAM_CONTROLS).map((x) => [x.name, x]));
  assert.deepStrictEqual(Object.keys(c).sort(), ['auto_exposure', 'brightness', 'exposure_time_absolute', 'power_line_frequency', 'white_balance_automatic', 'white_balance_temperature']);
  assert.strictEqual(c.brightness.min, -64);
  assert.strictEqual(c.white_balance_automatic.value, 1);
  assert.strictEqual(c.white_balance_temperature.inactive, true, 'manual value is inactive while auto is on');
  assert.strictEqual(c.auto_exposure.value, 3, 'auto exposure on maps to aperture priority');
  assert.strictEqual(c.power_line_frequency.menu[2], '60 Hz');
  // 2^-6 s = 15.625 ms = 156 × 100 µs; range 2^-13 s .. 2^-1 s.
  assert.strictEqual(c.exposure_time_absolute.value, 156);
  assert.strictEqual(c.exposure_time_absolute.min, 1);
  assert.strictEqual(c.exposure_time_absolute.max, 5000);
  assert.strictEqual(win.expFromV4l2(156), -6);
  assert.strictEqual(win.expFromV4l2(333), -5, '1/30 s rounds to the nearest power of two');
});

test('KS basic-support replies decode to min/max/default', () => {
  const len = 2;
  const desc = Buffer.alloc(40);
  desc.writeUInt32LE(2, 32); // two member lists
  const ranges = Buffer.alloc(16 + 3 * len);
  ranges.writeUInt32LE(2, 0); // KSPROPERTY_MEMBER_STEPPEDRANGES
  ranges.writeUInt32LE(3 * len, 4);
  ranges.writeUInt32LE(1, 8);
  ranges.writeInt16LE(1, 16); // resolution
  ranges.writeInt16LE(-50, 18); // min
  ranges.writeInt16LE(50, 20); // max
  const def = Buffer.alloc(16 + len);
  def.writeUInt32LE(3, 0); // KSPROPERTY_MEMBER_VALUES
  def.writeUInt32LE(len, 4);
  def.writeUInt32LE(1, 8);
  def.writeUInt32LE(1, 12); // KSPROPERTY_MEMBER_FLAG_DEFAULT
  def.writeInt16LE(7, 16);
  const b = win.parseBasicSupport(Buffer.concat([desc, ranges, def]), len);
  assert.strictEqual(b.min.readInt16LE(0), -50);
  assert.strictEqual(b.max.readInt16LE(0), 50);
  assert.strictEqual(b.def.readInt16LE(0), 7);
});

test('USB parent ids parse to vid/pid/serial', () => {
  assert.deepStrictEqual(win.parseParent('USB\\VID_0FD9&PID_00AF\\AC8KB0000TEST1'), { vid: 0x0fd9, pid: 0xaf, serial: 'AC8KB0000TEST1' });
  assert.strictEqual(win.parseParent('ROOT\\something'), null);
});
