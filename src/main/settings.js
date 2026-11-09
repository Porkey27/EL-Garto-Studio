'use strict';
// JSON-file settings store with change notifications.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { EventEmitter } = require('events');

const DEFAULTS = {
  recordingsDir: path.join(os.homedir(), 'Videos', 'El-Garto Studio'),
  container: 'mp4',
  recMaxHeight: 0, // 0 = source
  recMaxFps: 0, // 0 = max
  recQuality: 2, // 0 Low … 3 Highest
  recCodec: 'hevc', // falls back to the first codec the recorder supports
  recHdr: false, // record HDR inputs in 10-bit HDR (Windows, cards with a P010 format)
  encoderRatio: {}, // codec -> actual/requested bitrate, learned from recordings
  audioBitrateKbps: 192,
  encoder: 'auto',
  flashbackMinutes: 0,
  limitWebSocketToStreamDeck: false,
  previewVolume: 1,
  previewMuted: false,
  lastDeviceId: null,
  devicePresets: {},
  deviceNames: {},
  theme: null, // see src/renderer/theme.js (null = the default dark theme)
  lastCustomEdid: {},
  framePresets: {},
  prompter: { fontSize: 64, speed: 3, mirror: false, lineHeight: 1.4, countdownSec: 3, fontFamily: 'sans-serif', margin: 10, cueLine: 0.33 },
};

class Settings extends EventEmitter {
  constructor(dir) {
    super();
    this.file = path.join(dir, 'settings.json');
    this.data = { ...DEFAULTS };
    try {
      Object.assign(this.data, JSON.parse(fs.readFileSync(this.file, 'utf8')));
    } catch { /* first run */ }
  }

  get(key) { return this.data[key]; }

  set(key, value) {
    this.data[key] = value;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2));
    this.emit('changed', key, value);
  }

  all() { return { ...this.data }; }
}

module.exports = { Settings, DEFAULTS };
