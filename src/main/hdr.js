'use strict';
// HDR (10-bit) recording on Windows. Chromium cannot open a capture card in P010, so the native
// helper egcap.exe does (Media Foundation) and pipes the raw frames and audio to ffmpeg, which
// encodes HEVC Main 10 on the GPU and tags the file HDR10 (or HLG). The card can only be opened by
// one program at a time, so while recording the helper also sends the preview (JPEG frames).

const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');
const { EventEmitter } = require('events');

// EOTF values of the HDMI Dynamic Range and Mastering InfoFrame (CTA-861).
const EOTF = { SDR: 0, HDR_GAMMA: 1, PQ: 2, HLG: 3 };

function helperPath() {
  if (process.platform !== 'win32') return null;
  const candidates = [
    process.resourcesPath && path.join(process.resourcesPath, 'native', 'egcap.exe'),
    path.join(__dirname, '../../native/build/egcap.exe'),
  ].filter(Boolean);
  return candidates.find((p) => fs.existsSync(p)) || null;
}

// Register 0x09 of a capture card mirrors the InfoFrame the source sends:
// 87 01 1a <checksum> <EOTF> <metadata id> <display primaries x,y ×3> <white point x,y>
// <max mastering luminance> <min mastering luminance ×0.0001> <MaxCLL> <MaxFALL>, all u16le.
// All zeros (or another type byte) means the source sends none, i.e. SDR.
function parseDrmInfoFrame(buf) {
  const b = Buffer.from(buf || []);
  if (b.length < 6 || b[0] !== 0x87) return { eotf: EOTF.SDR, label: 'SDR', hdr: false };
  const eotf = b[4] & 0x07;
  const out = { eotf, label: ({ 0: 'SDR', 1: 'HDR', 2: 'HDR10', 3: 'HLG' })[eotf] || 'SDR', hdr: eotf === EOTF.PQ || eotf === EOTF.HLG };
  if (b.length >= 30 && b[5] === 0) {
    const u = (o) => b.readUInt16LE(o);
    out.mastering = {
      primaries: [[u(6), u(8)], [u(10), u(12)], [u(14), u(16)]].map(([x, y]) => [x / 50000, y / 50000]),
      whitePoint: [u(18) / 50000, u(20) / 50000],
      maxLuminance: u(22),
      minLuminance: u(24) / 10000,
    };
    out.maxCll = u(26);
    out.maxFall = u(28);
  }
  return out;
}

function ffmpegOk(args, timeout = 15000) {
  return new Promise((resolve) => {
    execFile('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...args], { timeout, windowsHide: true }, (err) => resolve(!err));
  });
}

// Encoders that can write HEVC Main 10, best first. Each is tried with a short test encode, since
// ffmpeg lists hardware encoders whether or not the GPU and driver can use them.
const ENCODERS = [
  { name: 'hevc_amf', label: 'AMD (AMF)', args: (b) => ['-profile:v', 'main10', '-quality', 'balanced', '-rc', 'vbr_peak', '-b:v', `${b}`, '-maxrate', `${Math.round(b * 1.5)}`] },
  { name: 'hevc_nvenc', label: 'NVIDIA (NVENC)', args: (b) => ['-profile:v', 'main10', '-preset', 'p5', '-rc', 'vbr', '-b:v', `${b}`, '-maxrate', `${Math.round(b * 1.5)}`, '-bufsize', `${b * 2}`] },
  { name: 'hevc_qsv', label: 'Intel (Quick Sync)', args: (b) => ['-profile:v', 'main10', '-preset', 'medium', '-b:v', `${b}`, '-maxrate', `${Math.round(b * 1.5)}`] },
  { name: 'libx265', label: 'CPU (x265)', software: true, args: (b) => ['-preset', 'ultrafast', '-pix_fmt', 'yuv420p10le', '-b:v', `${b}`, '-maxrate', `${Math.round(b * 1.5)}`, '-bufsize', `${b * 2}`] },
];

let encoderProbe = null;
function pickEncoder() {
  if (!encoderProbe) {
    encoderProbe = (async () => {
      for (const e of ENCODERS) {
        const ok = await ffmpegOk(['-f', 'lavfi', '-i', 'testsrc2=s=1280x720:r=30', '-frames:v', '5', '-pix_fmt', 'p010le', '-c:v', e.name, ...e.args(8e6), '-f', 'null', '-']);
        if (ok) return e;
      }
      return null;
    })();
  }
  return encoderProbe;
}

function colorArgs(eotf) {
  const trc = eotf === EOTF.HLG ? 'arib-std-b67' : 'smpte2084';
  return ['-color_primaries', 'bt2020', '-color_trc', trc, '-colorspace', 'bt2020nc', '-color_range', 'tv'];
}

// x265 can also carry the source's mastering display and light level metadata.
function x265Params(eotf, info) {
  const p = ['repeat-headers=1', `colorprim=bt2020`, `transfer=${eotf === EOTF.HLG ? 'arib-std-b67' : 'smpte2084'}`, 'colormatrix=bt2020nc', 'range=limited'];
  const m = info && info.mastering;
  if (eotf === EOTF.PQ && m && m.maxLuminance) {
    const c = (v) => Math.round(v * 50000);
    const [[rx, ry], [gx, gy], [bx, by]] = m.primaries;
    // x265 wants G, B, R order; the InfoFrame's order is not fixed, so sort by chromaticity.
    const prim = [[rx, ry], [gx, gy], [bx, by]];
    const g = prim.reduce((a, p) => (p[1] > a[1] ? p : a));
    const r = prim.reduce((a, p) => (p[0] > a[0] ? p : a));
    const bl = prim.find((p) => p !== g && p !== r) || [bx, by];
    p.push('hdr10=1', `master-display=G(${c(g[0])},${c(g[1])})B(${c(bl[0])},${c(bl[1])})R(${c(r[0])},${c(r[1])})WP(${c(m.whitePoint[0])},${c(m.whitePoint[1])})L(${m.maxLuminance * 10000},${Math.round(m.minLuminance * 10000)})`);
    if (info.maxCll) p.push(`max-cll=${info.maxCll},${info.maxFall || 0}`);
  }
  return ['-x265-params', p.join(':')];
}

class HdrCapture extends EventEmitter {
  // opts: { videoMatch, audioMatch, eotf, info, bitrate, maxHeight, maxFps, audioKbps, output }
  constructor(opts) {
    super();
    this.opts = opts;
    this.helper = null;
    this.ffmpeg = null;
    this.format = null;
    this.stats = null;
    this.error = null;
    this.stopping = false;
  }

  colorArgs() { return colorArgs(this.opts.eotf); }

  bytes() {
    try { return fs.statSync(this.opts.output).size; } catch { return 0; }
  }

  // Resolves once frames are flowing into the encoder.
  async start() {
    const exe = helperPath();
    if (!exe) throw new Error('egcap.exe is not built (run `npm run build:native`)');
    const encoder = await pickEncoder();
    if (!encoder) throw new Error('No HEVC Main 10 encoder works on this PC (checked AMD, NVIDIA, Intel and x265)');
    this.encoder = encoder;
    const id = `egcap-${process.pid}-${Date.now()}`;
    const o = this.opts;
    const args = ['capture', '--video', o.videoMatch, '--vpipe', `${id}-v`, '--eotf', String(o.eotf || 0), '--preview', '960x540'];
    if (o.audioMatch) args.push('--audio', o.audioMatch, '--apipe', `${id}-a`);
    const helper = spawn(exe, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.helper = helper;
    helper.stdin.on('error', () => {});

    // Preview frames: [u32le length][JPEG].
    let pending = Buffer.alloc(0);
    helper.stdout.on('data', (d) => {
      pending = pending.length ? Buffer.concat([pending, d]) : d;
      while (pending.length >= 4) {
        const len = pending.readUInt32LE(0);
        if (pending.length < 4 + len) break;
        this.emit('preview', pending.subarray(4, 4 + len));
        pending = pending.subarray(4 + len);
      }
    });

    return new Promise((resolve, reject) => {
      let started = false;
      let line = '';
      helper.stderr.on('data', (d) => {
        line += d;
        let i;
        while ((i = line.indexOf('\n')) >= 0) {
          const text = line.slice(0, i).trim();
          line = line.slice(i + 1);
          let ev;
          try { ev = JSON.parse(text); } catch { continue; }
          if (ev.event === 'format') {
            this.format = ev;
            this.emit('format', ev);
            this.startEncoder(`\\\\.\\pipe\\${id}-v`, ev.audio ? `\\\\.\\pipe\\${id}-a` : null);
          } else if (ev.event === 'started') {
            started = true;
            resolve(this.format);
          } else if (ev.event === 'stats' || ev.event === 'stopped') {
            this.stats = ev;
          } else if (ev.event === 'error') {
            this.error = this.error || ev.message;
            if (!started) reject(new Error(ev.message));
          } else if (ev.event === 'warning') {
            this.emit('warning', ev.message);
          }
        }
      });
      helper.on('exit', (code) => {
        this.helper = null;
        if (!started) reject(new Error(this.error || `egcap exited (${code})`));
        else if (!this.stopping) this.emit('ended', this.error || 'the capture helper stopped');
        // Without the helper the encoder only waits for pipe input that never comes.
        if (!started && this.ffmpeg) this.ffmpeg.kill();
      });
    });
  }

  startEncoder(videoPipe, audioPipe) {
    const o = this.opts;
    const f = this.format;
    const e = this.encoder;
    const args = ['-hide_banner', '-loglevel', 'error', '-y',
      '-thread_queue_size', '64', '-f', 'rawvideo', '-pix_fmt', 'p010le', '-s', `${f.width}x${f.height}`, '-framerate', `${f.fpsNum}/${f.fpsDen}`, '-i', videoPipe];
    if (audioPipe) args.push('-thread_queue_size', '1024', '-f', f.audio.format, '-ar', String(f.audio.rate), '-ac', String(f.audio.channels), '-i', audioPipe);
    const filters = [];
    if (o.maxHeight && f.height > o.maxHeight) filters.push(`scale=-2:${o.maxHeight}:flags=bicubic`);
    const fps = f.fpsNum / f.fpsDen;
    if (o.maxFps && fps > o.maxFps + 1) filters.push(`fps=${o.maxFps}`);
    if (filters.length) args.push('-vf', filters.join(','));
    args.push('-map', '0:v');
    if (audioPipe) args.push('-map', '1:a');
    args.push('-c:v', e.name, ...e.args(o.bitrate || 40e6), ...colorArgs(o.eotf));
    if (e.name === 'libx265') args.push(...x265Params(o.eotf, o.info));
    if (audioPipe) args.push('-c:a', 'aac', '-b:a', `${o.audioKbps || 192}k`);
    args.push('-f', 'matroska', o.output);
    const ff = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    this.ffmpeg = ff;
    let err = '';
    ff.stderr.on('data', (d) => { err = (err + d).slice(-4000); });
    this.ffmpegDone = new Promise((resolve) => ff.on('exit', (code) => {
      this.ffmpeg = null;
      if (code && !this.stopping) {
        this.error = this.error || `encoder failed: ${err.trim() || `ffmpeg exited ${code}`}`;
        this.emit('ended', this.error);
      }
      resolve({ code, err: err.trim() });
    }));
  }

  // Stops capturing; resolves when the file is complete.
  async stop() {
    this.stopping = true;
    const helper = this.helper;
    if (helper) {
      const gone = new Promise((r) => helper.once('exit', r));
      try { helper.stdin.end('q'); } catch { /* already gone */ }
      const t = setTimeout(() => helper.kill(), 10000);
      await gone;
      clearTimeout(t);
    }
    if (this.ffmpegDone) {
      const t = setTimeout(() => this.ffmpeg && this.ffmpeg.kill(), 60000);
      const r = await this.ffmpegDone;
      clearTimeout(t);
      if (r.code && !fs.existsSync(this.opts.output)) throw new Error(`encoder failed: ${r.err || r.code}`);
    }
    return this.stats;
  }
}

// P010 formats the helper sees on a device, matched by USB IDs ({ name, link, p010: [...] }).
async function deviceFormats(vid, pid) {
  const exe = helperPath();
  if (!exe) return null;
  const out = await new Promise((resolve) => {
    execFile(exe, ['list'], { timeout: 10000, windowsHide: true }, (err, stdout) => resolve(err ? null : stdout));
  });
  if (!out) return null;
  let list;
  try { list = JSON.parse(out).devices || []; } catch { return null; }
  const want = videoMatch(vid, pid);
  return list.find((d) => d.link.toLowerCase().includes(want)) || null;
}

const hex4 = (n) => Number(n).toString(16).padStart(4, '0');
const videoMatch = (vid, pid) => `vid_${hex4(vid)}&pid_${hex4(pid)}`;

module.exports = { HdrCapture, EOTF, helperPath, parseDrmInfoFrame, pickEncoder, deviceFormats, videoMatch, colorArgs, x265Params };
