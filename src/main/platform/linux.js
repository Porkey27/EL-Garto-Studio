'use strict';
// Linux backend: sysfs discovery, hidraw + UVC XU ioctls via native/egctl, v4l2-ctl for controls.

const fs = require('fs');
const path = require('path');
const discovery = require('../devices/discovery');
const descriptors = require('../devices/descriptors');
const native = require('../devices/native');
const v4l2 = require('../devices/v4l2');

module.exports = {
  name: 'linux',
  features: { virtualCamera: true },
  scanIntervalMs: 1500,
  scan: async () => discovery.scan(),
  hid: {
    write: native.hid.write,
    // HIDIOCGINPUT's length includes the report id byte the kernel puts in front.
    input: (node, reportId, wireLen) => native.hid.input(node, reportId, wireLen + 1),
  },
  hidReportSizes: descriptors.reportSizesForHidraw,
  controls: { listControls: v4l2.listControls, setControl: v4l2.setControl, listFormats: v4l2.listFormats },
  xu: native.xu,
  extensionUnits: async (dev) => descriptors.extensionUnitsForVideoNode(dev),
  helperPath: native.helperPath,
  // v4l2loopback devices: they are virtual (no USB parent) and expose v4l2loopback's own sysfs
  // attributes. Their name is whatever card_label says, so it can't be matched on.
  virtualCameraDevices() {
    const base = '/sys/class/video4linux';
    try {
      return fs.readdirSync(base).filter((v) => {
        const dir = path.join(base, v);
        let real = '';
        try { real = fs.realpathSync(dir); } catch { /* ignore */ }
        const name = (() => { try { return fs.readFileSync(path.join(dir, 'name'), 'utf8'); } catch { return ''; } })();
        return fs.existsSync(path.join(dir, 'max_openers')) || /loopback/i.test(name)
          || (real.includes('/devices/virtual/') && /virtual|studio|dummy/i.test(name));
      }).map((v) => `/dev/${v}`).sort((a, b) => Number(a.replace(/\D/g, '')) - Number(b.replace(/\D/g, '')));
    } catch {
      return [];
    }
  },
};
