'use strict';
// Selects the OS backend. Both expose the same interface:
//   name, features { virtualCamera }
//   scan() -> Promise<device[]>, scanIntervalMs
//   hid { write(node, bytes), input(node, reportId, wireLen) -> [reportId, wire bytes…], xfer? }
//   hidReportSizes(node)
//   controls { listControls(dev), setControl(dev, name, value), listFormats(dev) }  (V4L2 control names)
//   xu { get, set, min, max, def, len }, extensionUnits(dev, guids) -> [{ unitId, guid }]
//   helperPath(), virtualCameraDevices()

module.exports = process.platform === 'win32' ? require('./win32') : require('./linux');
