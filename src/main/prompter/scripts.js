'use strict';
// Prompter script library: one JSON file per script. Imports .txt, .md, .rtf and .docx.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

// Reads one entry from a ZIP archive (enough for .docx; no ZIP64 support).
function readZipEntry(buf, wanted) {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new Error('not a zip file');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    if (name === wanted) {
      const lNameLen = buf.readUInt16LE(localOff + 26);
      const lExtraLen = buf.readUInt16LE(localOff + 28);
      const start = localOff + 30 + lNameLen + lExtraLen;
      const data = buf.subarray(start, start + compSize);
      return method === 0 ? data : zlib.inflateRawSync(data);
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  throw new Error(`${wanted} not found`);
}

function decodeXmlEntities(s) {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, d) => String.fromCodePoint(Number(d))).replace(/&amp;/g, '&');
}

function docxToText(buf) {
  const xml = readZipEntry(buf, 'word/document.xml').toString('utf8');
  return xml.split(/<\/w:p>/).map((para) => {
    const runs = [];
    for (const m of para.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:tab\/>|<w:br\/>/g)) {
      if (m[0] === '<w:tab/>') runs.push('\t');
      else if (m[0] === '<w:br/>') runs.push('\n');
      else runs.push(decodeXmlEntities(m[1]));
    }
    return runs.join('');
  }).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function rtfToText(s) {
  return s
    .replace(/\\par[d]?/g, '\n')
    .replace(/\\'([0-9a-f]{2})/gi, (_m, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\u(-?\d+)\??/g, (_m, d) => String.fromCharCode((Number(d) + 65536) % 65536))
    .replace(/\{\\\*[^{}]*\}/g, '')
    .replace(/\\[a-z]+-?\d* ?/gi, '')
    .replace(/[{}]/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function fileToText(file) {
  const ext = path.extname(file).toLowerCase();
  const buf = fs.readFileSync(file);
  if (ext === '.docx') return docxToText(buf);
  if (ext === '.rtf') return rtfToText(buf.toString('latin1'));
  return buf.toString('utf8');
}

class ScriptStore {
  constructor(dir) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
  }

  file(id) {
    if (!/^[a-f0-9-]+$/.test(id)) throw new Error('bad script id');
    return path.join(this.dir, `${id}.json`);
  }

  list() {
    return fs.readdirSync(this.dir).filter((f) => f.endsWith('.json')).map((f) => {
      try {
        const s = JSON.parse(fs.readFileSync(path.join(this.dir, f), 'utf8'));
        return { id: s.id, title: s.title, updated: s.updated, words: (s.text.match(/\S+/g) || []).length };
      } catch { return null; }
    }).filter(Boolean).sort((a, b) => b.updated - a.updated);
  }

  get(id) { return JSON.parse(fs.readFileSync(this.file(id), 'utf8')); }

  save({ id, title, text }) {
    const s = { id: id || crypto.randomUUID(), title: (title || 'Untitled script').slice(0, 200), text: text || '', updated: Date.now() };
    fs.writeFileSync(this.file(s.id), JSON.stringify(s, null, 2));
    return s;
  }

  remove(id) { fs.rmSync(this.file(id), { force: true }); }

  importFile(file) {
    return this.save({ title: path.basename(file, path.extname(file)), text: fileToText(file) });
  }
}

module.exports = { ScriptStore, docxToText, rtfToText, readZipEntry };
