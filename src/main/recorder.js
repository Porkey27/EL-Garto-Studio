'use strict';
// Receives MediaRecorder chunks from the renderer, writes them to disk and remuxes the
// result into the user's chosen container. Also keeps the rolling Flashback buffer and
// feeds the virtual camera.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFile } = require('child_process');
const { EventEmitter } = require('events');

function timestampName(prefix, ext, date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${prefix} ${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ${p(date.getHours())}-${p(date.getMinutes())}-${p(date.getSeconds())}.${ext}`;
}

function ffmpeg(args) {
  return new Promise((resolve, reject) => {
    execFile('ffmpeg', ['-y', '-loglevel', 'error', ...args], { timeout: 10 * 60 * 1000 }, (err, _o, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolve();
    });
  });
}

// Remux settings per target container; mp4 needs AAC because Opus-in-MP4 support is spotty.
// HDR recordings (hdr = their colour tag arguments) already have AAC audio; their HEVC gets the
// hvc1 tag players expect in MP4. The colour tags are set again because the capture's MKV only
// has them in the HEVC stream, and players read the container's.
function remuxArgs(input, output, container, audioKbps, { hdr = null } = {}) {
  if (container === 'mkv' || container === 'webm') return ['-i', input, '-c', 'copy', ...(hdr || []), output];
  if (hdr) return ['-i', input, '-c', 'copy', ...hdr, '-tag:v', 'hvc1', '-movflags', '+faststart', output];
  return ['-i', input, '-c:v', 'copy', '-c:a', 'aac', '-b:a', `${audioKbps}k`, '-movflags', '+faststart', output];
}

class Recorder extends EventEmitter {
  constructor(settings) {
    super();
    this.settings = settings;
    this.session = null;
    this.flashback = { dir: fs.mkdtempSync(path.join(os.tmpdir(), 'egs-flashback-')), segments: [] };
    this.vcam = null;
  }

  get isRecording() { return !!this.session; }

  status() {
    if (!this.session) return { isRecording: false, durationSec: 0, sizeBytes: 0 };
    const s = this.session;
    return {
      isRecording: true,
      durationSec: Math.floor((Date.now() - s.started) / 1000),
      sizeBytes: s.capture ? s.capture.bytes() : s.bytes,
      file: s.final,
      hdr: !!s.capture,
    };
  }

  paths(deviceName, mimeType) {
    const dir = this.settings.get('recordingsDir');
    fs.mkdirSync(dir, { recursive: true });
    let ext = this.settings.get('container') || 'mp4';
    // WebM only holds VP8/VP9/AV1; H.264 and HEVC recordings go to MKV instead.
    if (ext === 'webm' && !/vp8|vp9|av01|webm(?!;)/i.test(mimeType)) ext = 'mkv';
    const final = path.join(dir, timestampName(deviceName.replace(/[\\/:*?"<>|]/g, ''), ext));
    const rawExt = /mp4/.test(mimeType) ? 'mp4' : /matroska/.test(mimeType) ? 'mkv' : 'webm';
    const raw = path.join(dir, `.${path.basename(final)}.part.${rawExt}`);
    return { final, raw };
  }

  start({ deviceName = 'Recording', mimeType = 'video/webm' } = {}) {
    if (this.session) throw new Error('already recording');
    const { final, raw } = this.paths(deviceName, mimeType);
    this.session = { final, raw, stream: fs.createWriteStream(raw), bytes: 0, started: Date.now(), mimeType };
    this.emit('changed', this.status());
    return this.status();
  }

  // A recording written by another process (the HDR capture helper and ffmpeg). makeCapture(raw)
  // returns an object with start() (resolves once recording), stop() and bytes().
  async startExternal({ deviceName = 'Recording', makeCapture }) {
    if (this.session) throw new Error('already recording');
    const { final, raw } = this.paths(deviceName, 'video/x-matroska;codecs=hvc1');
    const capture = makeCapture(raw);
    const session = { final, raw, capture, bytes: 0, started: Date.now(), mimeType: 'video/x-matroska;codecs=hvc1' };
    this.session = session;
    try {
      await capture.start();
    } catch (e) {
      if (this.session === session) this.session = null;
      fs.rm(raw, () => {});
      throw e;
    }
    session.started = Date.now();
    this.emit('changed', this.status());
    return this.status();
  }

  chunk(buf) {
    if (!this.session || !this.session.stream) return;
    this.session.stream.write(Buffer.from(buf));
    this.session.bytes += buf.byteLength;
  }

  async stop() {
    const s = this.session;
    if (!s) return null;
    this.session = null;
    this.emit('changed', this.status());
    if (s.capture) {
      try {
        await s.capture.stop();
      } catch (e) {
        this.emit('error', e);
      }
      this.emit('released');
      if (!fs.existsSync(s.raw)) return null;
    } else {
      await new Promise((r) => s.stream.end(r));
    }
    try {
      await ffmpeg(remuxArgs(s.raw, s.final, path.extname(s.final).slice(1), this.settings.get('audioBitrateKbps'), { hdr: s.capture ? s.capture.colorArgs() : null }));
      fs.unlinkSync(s.raw);
    } catch (e) {
      // Keep the raw capture so nothing is lost if remuxing fails.
      const fallback = s.final.replace(/\.\w+$/, path.extname(s.raw));
      fs.renameSync(s.raw, fallback);
      this.emit('error', new Error(`remux failed, kept ${fallback}: ${e.message}`));
      return fallback;
    }
    this.emit('saved', s.final);
    return s.final;
  }

  snapshot(pngBuffer, deviceName = 'Snapshot') {
    const dir = this.settings.get('recordingsDir');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, timestampName(deviceName.replace(/[\\/:*?"<>|]/g, ''), 'png'));
    fs.writeFileSync(file, Buffer.from(pngBuffer));
    this.emit('saved', file);
    return file;
  }

  // Flashback: the renderer sends self-contained segments (each a full WebM file).
  flashbackSegment(buf, durationSec) {
    const minutes = this.settings.get('flashbackMinutes');
    if (!minutes) return;
    const file = path.join(this.flashback.dir, `seg-${Date.now()}.webm`);
    fs.writeFileSync(file, Buffer.from(buf));
    this.flashback.segments.push({ file, durationSec });
    let total = this.flashback.segments.reduce((a, s) => a + s.durationSec, 0);
    while (total > minutes * 60 && this.flashback.segments.length > 1) {
      const old = this.flashback.segments.shift();
      total -= old.durationSec;
      fs.rm(old.file, () => {});
    }
  }

  async saveFlashback(deviceName = 'Flashback') {
    const segs = [...this.flashback.segments];
    if (!segs.length) throw new Error('Flashback buffer is empty');
    const list = path.join(this.flashback.dir, 'list.txt');
    fs.writeFileSync(list, segs.map((s) => `file '${s.file.replace(/'/g, "'\\''")}'`).join('\n'));
    const dir = this.settings.get('recordingsDir');
    const ext = this.settings.get('container') || 'mp4';
    const out = path.join(dir, timestampName(`${deviceName} Flashback`, ext));
    const args = ext === 'mp4'
      ? ['-f', 'concat', '-safe', '0', '-i', list, '-c:v', 'copy', '-c:a', 'aac', '-movflags', '+faststart', out]
      : ['-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', out];
    await ffmpeg(args);
    this.emit('saved', out);
    return out;
  }

  clearFlashback() {
    for (const s of this.flashback.segments) fs.rm(s.file, () => {});
    this.flashback.segments = [];
  }

  // Virtual camera: pipes a low-latency WebM stream into a v4l2loopback device.
  startVirtualCamera(device = '/dev/video10', { width = 1920, height = 1080 } = {}) {
    if (this.vcam) return;
    // Apps that read virtual cameras (Discord, browsers, OBS) top out at 1080p, and scaling 4K in
    // software would cost more CPU than the rest of the app, so cap the output there.
    if (height > 1080) { width = Math.round((width * 1080) / height / 2) * 2; height = 1080; }
    // Start quickly (small probe) but don't use -fflags nobuffer or -flags low_delay: with either,
    // ffmpeg fails to decode large VP8 frames ("Invalid data found"), so a 4K source stays black.
    const proc = spawn('ffmpeg', ['-loglevel', 'error',
      '-probesize', '32768', '-analyzeduration', '0', '-f', 'matroska', '-i', 'pipe:0',
      '-vf', `scale=${width}:${height}:flags=fast_bilinear,format=yuyv422`, '-f', 'v4l2', device],
    { stdio: ['pipe', 'ignore', 'pipe'] });
    let err = '';
    proc.stderr.on('data', (d) => { err += d; });
    proc.on('exit', (code) => {
      this.vcam = null;
      this.emit('vcam', { running: false, error: code ? err.trim() || `ffmpeg exited ${code}` : null });
    });
    proc.stdin.on('error', () => {});
    this.vcam = proc;
    this.emit('vcam', { running: true, device });
  }

  virtualCameraChunk(buf) {
    if (this.vcam) this.vcam.stdin.write(Buffer.from(buf));
  }

  stopVirtualCamera() {
    if (this.vcam) this.vcam.stdin.end();
  }

  dispose() {
    this.stopVirtualCamera();
    fs.rm(this.flashback.dir, { recursive: true, force: true }, () => {});
  }
}

module.exports = { Recorder, timestampName, remuxArgs };
