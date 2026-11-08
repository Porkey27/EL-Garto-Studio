'use strict';
// Runs the bundled `egctl` helper (see native/egctl.c) and parses its output.

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

function helperPath() {
  const candidates = [
    process.resourcesPath && path.join(process.resourcesPath, 'native', 'egctl'),
    path.join(__dirname, '../../../native/build/egctl'),
    '/usr/lib/elgato-studio-linux/egctl',
  ].filter(Boolean);
  return candidates.find((p) => fs.existsSync(p)) || null;
}

let cachedHelper;

function run(args, { timeoutMs = 3000 } = {}) {
  if (cachedHelper === undefined) cachedHelper = helperPath();
  if (!cachedHelper) return Promise.reject(new Error('egctl helper not built (run `npm run build:native`)'));
  return new Promise((resolve, reject) => {
    execFile(cachedHelper, args, { timeout: timeoutMs }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message).trim()));
      else resolve(stdout.trim());
    });
  });
}

const toHex = (buf) => Buffer.from(buf).toString('hex');
const fromHex = (s) => Buffer.from(s.replace(/\s+/g, ''), 'hex');

const xu = {
  get: (dev, unit, sel, len) => run(['xu', 'get', dev, String(unit), String(sel), String(len)]).then(fromHex),
  min: (dev, unit, sel, len) => run(['xu', 'min', dev, String(unit), String(sel), String(len)]).then(fromHex),
  max: (dev, unit, sel, len) => run(['xu', 'max', dev, String(unit), String(sel), String(len)]).then(fromHex),
  def: (dev, unit, sel, len) => run(['xu', 'def', dev, String(unit), String(sel), String(len)]).then(fromHex),
  len: (dev, unit, sel) => run(['xu', 'len', dev, String(unit), String(sel)]).then((s) => parseInt(s, 10)),
  set: (dev, unit, sel, data) => run(['xu', 'set', dev, String(unit), String(sel), toHex(data)]),
};

const hid = {
  write: (node, bytes) => run(['hid', 'write', node, toHex(bytes)]),
  input: (node, reportId, len) => run(['hid', 'input', node, String(reportId), String(len)]).then(fromHex),
  featureGet: (node, reportId, len) => run(['hid', 'feature-get', node, String(reportId), String(len)]).then(fromHex),
  featureSet: (node, bytes) => run(['hid', 'feature-set', node, toHex(bytes)]),
};

module.exports = { run, xu, hid, toHex, fromHex, helperPath };
