'use strict';
// Finds Elgato (and generic UVC) devices by walking sysfs, and maps each USB device
// to its V4L2 capture node, hidraw nodes (by interface number) and ALSA card.

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const catalog = require('./catalog');

function readText(p) {
  try { return fs.readFileSync(p, 'utf8').trim(); } catch { return null; }
}

function listDir(p) {
  try { return fs.readdirSync(p); } catch { return []; }
}

// Walks the interface subtree of a USB device collecting class nodes.
function collectNodes(usbDir, out, depth = 0, intfNum = null) {
  if (depth > 5) return;
  const here = readText(path.join(usbDir, 'bInterfaceNumber'));
  const intf = here !== null ? parseInt(here, 16) : intfNum;
  for (const entry of listDir(usbDir)) {
    const full = path.join(usbDir, entry);
    if (entry === 'video4linux') {
      for (const v of listDir(full)) {
        const index = parseInt(readText(path.join(full, v, 'index')) || '0', 10);
        out.video.push({ node: `/dev/${v}`, index, interface: intf, name: readText(path.join(full, v, 'name')) });
      }
    } else if (entry === 'hidraw') {
      for (const h of listDir(full)) out.hidraw.push({ node: `/dev/${h}`, interface: intf });
    } else if (entry === 'sound') {
      for (const c of listDir(full)) {
        const m = /^card(\d+)$/.exec(c);
        if (m) out.alsa.push({ card: parseInt(m[1], 10), id: readText(path.join(full, c, 'id')) });
      }
    } else if (/^\d+-[\d.]+:\d+\.\d+$/.test(entry) || /^\d{4}:[0-9A-F]{4}:[0-9A-F]{4}\.[0-9A-F]+$/i.test(entry)) {
      // USB interface dir, or HID device dir (e.g. 0003:0FD9:0082.0005)
      collectNodes(full, out, depth + 1, intf);
    }
  }
}

function scan(sysRoot = '/sys') {
  const usbRoot = path.join(sysRoot, 'bus/usb/devices');
  const found = [];
  for (const entry of listDir(usbRoot)) {
    if (entry.includes(':')) continue; // interfaces, not devices
    const dir = path.join(usbRoot, entry);
    const vid = parseInt(readText(path.join(dir, 'idVendor')) || '', 16);
    const pid = parseInt(readText(path.join(dir, 'idProduct')) || '', 16);
    if (Number.isNaN(vid) || Number.isNaN(pid)) continue;
    const nodes = { video: [], hidraw: [], alsa: [] };
    collectNodes(dir, nodes);
    const model = catalog.lookup(vid, pid);
    const capture = nodes.video.filter((v) => v.index === 0).sort((a, b) => a.node.localeCompare(b.node, undefined, { numeric: true }))[0];
    if (!model && !capture) continue; // not ours and not a camera
    const speedMbps = parseInt(readText(path.join(dir, 'speed')) || '0', 10);
    const serial = readText(path.join(dir, 'serial'));
    found.push({
      id: `${vid.toString(16).padStart(4, '0')}:${pid.toString(16).padStart(4, '0')}:${serial || entry}`,
      usbPath: entry,
      vid,
      pid,
      serial,
      name: model ? model.name : (readText(path.join(dir, 'product')) || capture.name || 'USB camera'),
      kind: model ? model.kind : 'generic',
      model,
      speedMbps,
      usb2Fallback: !!(model && model.usb2Pid === pid && model.pids.length > 1),
      videoNode: capture ? capture.node : null,
      videoName: capture ? capture.name : null,
      hidraw: nodes.hidraw,
      controlHid: model && model.hidInterface != null
        ? (nodes.hidraw.find((h) => h.interface === model.hidInterface) || {}).node || null
        : null,
      alsaCard: nodes.alsa[0] ? nodes.alsa[0].card : null,
      alsaId: nodes.alsa[0] ? nodes.alsa[0].id : null,
    });
  }
  return found;
}

// Polls the platform's device scan for hotplug (sysfs on Linux, SetupAPI on Windows); no udev or
// WM_DEVICECHANGE binding needed.
class DeviceMonitor extends EventEmitter {
  constructor(scanFn = async () => scan('/sys'), intervalMs = 1500) {
    super();
    this.scan = scanFn;
    this.intervalMs = intervalMs;
    this.devices = new Map();
    this.timer = null;
    this.busy = false;
  }

  async start() {
    await this.poll();
    this.timer = setInterval(() => this.poll(), this.intervalMs);
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  async poll() {
    if (this.busy) return;
    this.busy = true;
    let list;
    try {
      list = await this.scan();
    } catch (e) {
      this.emit('error', e);
      return;
    } finally {
      this.busy = false;
    }
    const now = new Map(list.map((d) => [d.id, d]));
    let changed = false;
    for (const [id, d] of now) {
      const prev = this.devices.get(id);
      if (!prev) { this.emit('added', d); changed = true; }
      else if (prev.videoNode !== d.videoNode || prev.controlHid !== d.controlHid) changed = true;
    }
    for (const [id, d] of this.devices) {
      if (!now.has(id)) { this.emit('removed', d); changed = true; }
    }
    this.devices = now;
    if (changed) this.emit('changed', [...now.values()]);
  }

  list() {
    return [...this.devices.values()];
  }
}

module.exports = { scan, DeviceMonitor };
