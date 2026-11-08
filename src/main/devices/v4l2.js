'use strict';
// Thin wrapper around `v4l2-ctl` (v4l-utils) for standard UVC controls and formats.

const { execFile } = require('child_process');

function v4l2ctl(args) {
  return new Promise((resolve, reject) => {
    execFile('v4l2-ctl', args, { timeout: 5000 }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message).trim()));
      else resolve(stdout);
    });
  });
}

const CTRL_RE = /^\s*(\w+)\s+0x([0-9a-f]+)\s+\((\w+)\)\s*:\s*(.*)$/;
const MENU_RE = /^\s+(-?\d+):\s+(.*)$/;

function parseControls(text) {
  const controls = [];
  let current = null;
  for (const line of text.split('\n')) {
    const m = CTRL_RE.exec(line);
    if (m) {
      const attrs = {};
      for (const kv of m[4].matchAll(/(\w+)=(-?\w+)/g)) attrs[kv[1]] = kv[2];
      current = {
        name: m[1],
        id: parseInt(m[2], 16),
        type: m[3],
        min: attrs.min !== undefined ? Number(attrs.min) : undefined,
        max: attrs.max !== undefined ? Number(attrs.max) : undefined,
        step: attrs.step !== undefined ? Number(attrs.step) : undefined,
        default: attrs.default !== undefined ? Number(attrs.default) : undefined,
        value: attrs.value !== undefined ? Number(attrs.value) : undefined,
        inactive: /flags=.*inactive/.test(m[4]),
        menu: m[3] === 'menu' || m[3] === 'intmenu' ? {} : undefined,
      };
      controls.push(current);
      continue;
    }
    const mm = MENU_RE.exec(line);
    if (mm && current && current.menu) current.menu[Number(mm[1])] = mm[2].trim();
  }
  return controls;
}

function parseFormats(text) {
  const formats = [];
  let fmt = null;
  let size = null;
  for (const line of text.split('\n')) {
    let m = /\[\d+\]:\s+'(\w+)'\s+\((.*)\)/.exec(line);
    if (m) { fmt = { fourcc: m[1], description: m[2], sizes: [] }; formats.push(fmt); continue; }
    m = /Size:\s+Discrete\s+(\d+)x(\d+)/.exec(line);
    if (m && fmt) { size = { width: Number(m[1]), height: Number(m[2]), fps: [] }; fmt.sizes.push(size); continue; }
    m = /Interval:\s+Discrete\s+[\d.]+s\s+\(([\d.]+)\s+fps\)/.exec(line);
    if (m && size) size.fps.push(Number(m[1]));
  }
  return formats;
}

const listControls = (dev) => v4l2ctl(['-d', dev, '--list-ctrls-menus']).then(parseControls);
const listFormats = (dev) => v4l2ctl(['-d', dev, '--list-formats-ext']).then(parseFormats);
const setControl = (dev, name, value) => v4l2ctl(['-d', dev, `--set-ctrl=${name}=${Math.round(value)}`]);
const setControls = (dev, pairs) =>
  v4l2ctl(['-d', dev, `--set-ctrl=${pairs.map(([n, v]) => `${n}=${Math.round(v)}`).join(',')}`]);

module.exports = { parseControls, parseFormats, listControls, listFormats, setControl, setControls };
