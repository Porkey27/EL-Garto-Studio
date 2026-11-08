'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { scan } = require('../src/main/devices/discovery');
const { parseExtensionUnits, parseReportSizes, guidFromBytes } = require('../src/main/devices/descriptors');
const { parseControls, parseFormats } = require('../src/main/devices/v4l2');
const catalog = require('../src/main/devices/catalog');

function guidBytes(guid) {
  const h = guid.replace(/-/g, '');
  const b = Buffer.from(h, 'hex');
  return Buffer.concat([Buffer.from([b[3], b[2], b[1], b[0], b[5], b[4], b[7], b[6]]), b.subarray(8)]);
}

function xuDescriptor(unitId, guid) {
  // bLength, CS_INTERFACE, VC_EXTENSION_UNIT, bUnitID, guid(16), bNumControls, bNrInPins, baSourceID, bControlSize, bmControls(2), iExtension
  const body = Buffer.concat([Buffer.from([0x24, 0x06, unitId]), guidBytes(guid), Buffer.from([0x18, 0x01, 0x02, 0x02, 0xff, 0xff, 0x00])]);
  return Buffer.concat([Buffer.from([body.length + 1]), body]);
}

test('guidFromBytes round-trips the USB mixed-endian layout', () => {
  const g = '23E49ED0-1178-4F31-AE52-D2FB8A8D3001';
  assert.strictEqual(guidFromBytes(guidBytes(g)), g);
});

test('parseExtensionUnits finds Elgato XUs among other descriptors', () => {
  const config = Buffer.from([0x09, 0x02, 0x00, 0x01, 0x02, 0x01, 0x00, 0x80, 0xfa]);
  const iface = Buffer.from([0x09, 0x04, 0x00, 0x00, 0x01, 0x0e, 0x01, 0x00, 0x00]);
  const buf = Buffer.concat([config, iface, xuDescriptor(4, '23E49ED0-1178-4F31-AE52-D2FB8A8D3001'), xuDescriptor(6, '2C49D16A-32B8-4485-3EA8-643A15236002')]);
  const units = parseExtensionUnits(buf);
  assert.deepStrictEqual(units.map((u) => [u.unitId, u.guid]), [
    [4, '23E49ED0-1178-4F31-AE52-D2FB8A8D3001'],
    [6, '2C49D16A-32B8-4485-3EA8-643A15236002'],
  ]);
  assert.strictEqual(units[0].numControls, 0x18);
});

test('parseReportSizes computes per-report sizes', () => {
  // Usage page vendor, collection, report id 6: 64 x 8-bit output; report id 5: 63 x 8-bit input
  const desc = Buffer.from([
    0x06, 0x00, 0xff, 0x09, 0x01, 0xa1, 0x01,
    0x85, 0x06, 0x75, 0x08, 0x95, 0x40, 0x09, 0x01, 0x91, 0x02,
    0x85, 0x05, 0x95, 0x3f, 0x09, 0x01, 0x81, 0x02,
    0xc0,
  ]);
  const s = parseReportSizes(desc);
  assert.strictEqual(s.output[6], 64);
  assert.strictEqual(s.input[5], 63);
});

test('catalog maps Elgato PIDs to models', () => {
  assert.strictEqual(catalog.lookup(0x0fd9, 0x82).name, 'Game Capture HD60 X');
  assert.strictEqual(catalog.lookup(0x0fd9, 0x94).type, 'FACECAM_MK2');
  assert.strictEqual(catalog.lookup(0x0fd9, 0x9d).name, 'Game Capture 4K X');
  assert.strictEqual(catalog.lookup(0x046d, 0x82), null);
  const pids = catalog.DEVICES.flatMap((d) => d.pids);
  assert.strictEqual(new Set(pids).size, pids.length, 'no PID listed twice');
});

test('scan maps a fake sysfs tree to video, hidraw and ALSA nodes', { skip: process.platform === 'win32' && 'sysfs names contain colons' }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sysfs-'));
  const dev = path.join(root, 'bus/usb/devices/3-1');
  const w = (p, v) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, v); };
  w(path.join(dev, 'idVendor'), '0fd9\n');
  w(path.join(dev, 'idProduct'), '0082\n');
  w(path.join(dev, 'serial'), 'ABC123\n');
  w(path.join(dev, 'speed'), '5000\n');
  w(path.join(dev, '3-1:1.0/bInterfaceNumber'), '00\n');
  w(path.join(dev, '3-1:1.0/video4linux/video2/index'), '0\n');
  w(path.join(dev, '3-1:1.0/video4linux/video2/name'), 'Game Capture HD60 X\n');
  w(path.join(dev, '3-1:1.0/video4linux/video3/index'), '1\n');
  w(path.join(dev, '3-1:1.7/bInterfaceNumber'), '07\n');
  w(path.join(dev, '3-1:1.7/0003:0FD9:0082.0004/hidraw/hidraw5/dev'), '');
  w(path.join(dev, '3-1:1.3/bInterfaceNumber'), '03\n');
  w(path.join(dev, '3-1:1.3/sound/card2/id'), 'X\n');
  const other = path.join(root, 'bus/usb/devices/1-2');
  w(path.join(other, 'idVendor'), '046d\n');
  w(path.join(other, 'idProduct'), 'c52b\n'); // a mouse: no video, ignored

  const [d, ...rest] = scan(root);
  assert.strictEqual(rest.length, 0);
  assert.strictEqual(d.name, 'Game Capture HD60 X');
  assert.strictEqual(d.kind, 'capture');
  assert.strictEqual(d.videoNode, '/dev/video2');
  assert.strictEqual(d.controlHid, '/dev/hidraw5');
  assert.strictEqual(d.alsaCard, 2);
  assert.strictEqual(d.speedMbps, 5000);
  assert.strictEqual(d.id, '0fd9:0082:ABC123');
  fs.rmSync(root, { recursive: true });
});

test('parseControls reads v4l2-ctl output including menus and flags', () => {
  const out = `
User Controls

                     brightness 0x00980900 (int)    : min=-64 max=64 step=1 default=0 value=12
        white_balance_automatic 0x0098090c (bool)   : default=1 value=1
           power_line_frequency 0x00980918 (menu)   : min=0 max=2 default=1 value=2 (60 Hz)
				0: Disabled
				1: 50 Hz
				2: 60 Hz
      white_balance_temperature 0x0098091a (int)    : min=2800 max=6500 step=10 default=4600 value=4600 flags=inactive
`;
  const c = parseControls(out);
  assert.strictEqual(c.length, 4);
  assert.deepStrictEqual(c[0], { name: 'brightness', id: 0x980900, type: 'int', min: -64, max: 64, step: 1, default: 0, value: 12, inactive: false, menu: undefined });
  assert.strictEqual(c[2].menu[2], '60 Hz');
  assert.strictEqual(c[3].inactive, true);
});

test('parseFormats reads sizes and frame rates', () => {
  const out = `ioctl: VIDIOC_ENUM_FMT
	Type: Video Capture

	[0]: 'NV12' (Y/UV 4:2:0)
		Size: Discrete 1920x1080
			Interval: Discrete 0.017s (60.000 fps)
			Interval: Discrete 0.033s (30.000 fps)
		Size: Discrete 3840x2160
			Interval: Discrete 0.033s (30.000 fps)
`;
  const f = parseFormats(out);
  assert.strictEqual(f[0].fourcc, 'NV12');
  assert.deepStrictEqual(f[0].sizes[0], { width: 1920, height: 1080, fps: [60, 30] });
  assert.strictEqual(f[0].sizes[1].width, 3840);
});
