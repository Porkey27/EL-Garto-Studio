'use strict';
// Recordings library: lists videos and snapshots in the recordings folder, makes
// thumbnails with ffmpeg and watches for changes.

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { EventEmitter } = require('events');

const VIDEO_EXT = new Set(['.mp4', '.mkv', '.webm', '.mov']);
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg']);

class Library extends EventEmitter {
  constructor(getDir) {
    super();
    this.getDir = getDir;
    this.watcher = null;
  }

  dir() {
    const d = this.getDir();
    fs.mkdirSync(d, { recursive: true });
    return d;
  }

  list() {
    const d = this.dir();
    return fs.readdirSync(d)
      .filter((f) => !f.startsWith('.'))
      .map((f) => {
        const ext = path.extname(f).toLowerCase();
        const type = VIDEO_EXT.has(ext) ? 'video' : IMAGE_EXT.has(ext) ? 'snapshot' : null;
        if (!type) return null;
        const full = path.join(d, f);
        const st = fs.statSync(full);
        return { name: f, path: full, type, size: st.size, mtime: st.mtimeMs };
      })
      .filter(Boolean)
      .sort((a, b) => b.mtime - a.mtime);
  }

  last() { return this.list()[0] || null; }

  thumbnail(file, width = 320) {
    const cacheDir = path.join(this.dir(), '.thumbs');
    fs.mkdirSync(cacheDir, { recursive: true });
    const out = path.join(cacheDir, `${path.basename(file)}.${width}.jpg`);
    if (fs.existsSync(out) && fs.statSync(out).mtimeMs >= fs.statSync(file).mtimeMs) return Promise.resolve(out);
    return new Promise((resolve, reject) => {
      execFile('ffmpeg', ['-y', '-loglevel', 'error', '-ss', '1', '-i', file, '-frames:v', '1', '-vf', `scale=${width}:-2`, out],
        { timeout: 15000 }, (err) => {
          if (!err) return resolve(out);
          // Very short clips have no frame at 1 s; retry at the start.
          execFile('ffmpeg', ['-y', '-loglevel', 'error', '-i', file, '-frames:v', '1', '-vf', `scale=${width}:-2`, out],
            { timeout: 15000 }, (err2) => (err2 ? reject(err2) : resolve(out)));
        });
    });
  }

  rename(file, newName) {
    const safe = path.basename(newName);
    const target = path.join(path.dirname(file), safe + (path.extname(safe) ? '' : path.extname(file)));
    if (fs.existsSync(target)) throw new Error('a file with that name already exists');
    fs.renameSync(file, target);
    return target;
  }

  watch() {
    if (this.watcher) return;
    let t = null;
    try {
      this.watcher = fs.watch(this.dir(), () => {
        clearTimeout(t);
        t = setTimeout(() => this.emit('changed', this.list()), 300);
      });
    } catch { /* inotify limits; manual refresh still works */ }
  }

  unwatch() {
    if (this.watcher) this.watcher.close();
    this.watcher = null;
  }
}

module.exports = { Library };
