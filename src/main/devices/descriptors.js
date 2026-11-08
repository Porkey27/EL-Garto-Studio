'use strict';
// Parsers for raw USB configuration descriptors (sysfs `descriptors`) and HID report
// descriptors (sysfs `report_descriptor`).

const fs = require('fs');
const path = require('path');

// USB GUIDs are stored as Data1/Data2/Data3 little-endian followed by 8 raw bytes.
function guidFromBytes(b) {
  const h = (x) => x.toString(16).padStart(2, '0');
  const d1 = [b[3], b[2], b[1], b[0]].map(h).join('');
  const d2 = [b[5], b[4]].map(h).join('');
  const d3 = [b[7], b[6]].map(h).join('');
  const d4 = [b[8], b[9]].map(h).join('');
  const d5 = [...b.slice(10, 16)].map(h).join('');
  return `${d1}-${d2}-${d3}-${d4}-${d5}`.toUpperCase();
}

const CS_INTERFACE = 0x24;
const VC_EXTENSION_UNIT = 0x06;

// Returns [{ unitId, guid, numControls, controlsBitmap }] for every UVC extension unit.
function parseExtensionUnits(buf) {
  const units = [];
  let i = 0;
  while (i + 2 <= buf.length) {
    const len = buf[i];
    if (len < 2 || i + len > buf.length) break;
    const type = buf[i + 1];
    if (type === CS_INTERFACE && len >= 24 && buf[i + 2] === VC_EXTENSION_UNIT) {
      const unitId = buf[i + 3];
      const guid = guidFromBytes(buf.subarray(i + 4, i + 20));
      const numControls = buf[i + 20];
      const nrInPins = buf[i + 21];
      const ctrlSizeOff = i + 22 + nrInPins;
      const ctrlSize = ctrlSizeOff < i + len ? buf[ctrlSizeOff] : 0;
      const controlsBitmap = buf.subarray(ctrlSizeOff + 1, ctrlSizeOff + 1 + ctrlSize);
      units.push({ unitId, guid, numControls, controlsBitmap: Buffer.from(controlsBitmap) });
    }
    i += len;
  }
  return units;
}

// Finds the USB device directory that owns a /dev/videoN node and parses its XUs.
function extensionUnitsForVideoNode(videoNode, sysRoot = '/sys') {
  const name = path.basename(videoNode);
  let dir;
  try {
    dir = fs.realpathSync(path.join(sysRoot, 'class/video4linux', name, 'device'));
  } catch {
    return [];
  }
  // Walk up from the interface to the USB device that has `descriptors`.
  for (let d = dir; d !== path.dirname(d); d = path.dirname(d)) {
    const p = path.join(d, 'descriptors');
    if (fs.existsSync(p) && fs.existsSync(path.join(d, 'idVendor'))) {
      return parseExtensionUnits(fs.readFileSync(p));
    }
  }
  return [];
}

// Minimal HID report-descriptor walk: returns { input: {id: bytes}, output: {...}, feature: {...} }
// where bytes excludes the report-id byte.
function parseReportSizes(desc) {
  const sizes = { input: {}, output: {}, feature: {} };
  const bits = { input: {}, output: {}, feature: {} };
  let reportSize = 0;
  let reportCount = 0;
  let reportId = 0;
  const stack = [];
  let i = 0;
  while (i < desc.length) {
    const prefix = desc[i];
    if (prefix === 0xfe) { // long item
      i += 3 + desc[i + 1];
      continue;
    }
    const size = [0, 1, 2, 4][prefix & 0x03];
    const type = (prefix >> 2) & 0x03;
    const tag = (prefix >> 4) & 0x0f;
    let value = 0;
    for (let k = 0; k < size; k++) value |= desc[i + 1 + k] << (8 * k);
    value >>>= 0;
    i += 1 + size;
    if (type === 0) { // main
      const kind = tag === 0x8 ? 'input' : tag === 0x9 ? 'output' : tag === 0xb ? 'feature' : null;
      if (kind) bits[kind][reportId] = (bits[kind][reportId] || 0) + reportSize * reportCount;
    } else if (type === 1) { // global
      if (tag === 0x7) reportSize = value;
      else if (tag === 0x9) reportCount = value;
      else if (tag === 0x8) reportId = value;
      else if (tag === 0xa) stack.push({ reportSize, reportCount, reportId });
      else if (tag === 0xb && stack.length) ({ reportSize, reportCount, reportId } = stack.pop());
    }
  }
  for (const kind of Object.keys(bits)) {
    for (const [id, b] of Object.entries(bits[kind])) sizes[kind][id] = Math.ceil(b / 8);
  }
  return sizes;
}

function reportSizesForHidraw(hidrawNode, sysRoot = '/sys') {
  const name = path.basename(hidrawNode);
  try {
    const desc = fs.readFileSync(path.join(sysRoot, 'class/hidraw', name, 'device/report_descriptor'));
    return parseReportSizes(desc);
  } catch {
    return { input: {}, output: {}, feature: {} };
  }
}

module.exports = {
  guidFromBytes,
  parseExtensionUnits,
  extensionUnitsForVideoNode,
  parseReportSizes,
  reportSizesForHidraw,
};
