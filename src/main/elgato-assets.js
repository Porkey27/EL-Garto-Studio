'use strict';
// Elgato's public device-asset list (the one Elgato Studio checks for firmware and EDID files),
// with a local cache. Every downloaded file is checked against the SHA-256 the list gives, when
// it gives one.

const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const crypto = require('crypto');

const MANIFEST_URL = 'https://gc-updates.elgato.com/windows/estw-update/final/device-update-check.json.php'
  + '?osName=Windows&osVersion=10.0.26300.0&osPlatform=x64&appVersion=2.0.0.3364&appPlatform=x64&appLanguage=en-US';
const CACHE = path.join(os.homedir(), '.cache', 'studio-for-elgato');
const MANIFEST_MAX_AGE_MS = 6 * 3600 * 1000;

function get(url, redirects = 5) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'studio-for-elgato' }, timeout: 20000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
        res.resume();
        resolve(get(new URL(res.headers.location, url).toString(), redirects - 1));
        return;
      }
      if (res.statusCode !== 200) { res.resume(); reject(new Error(`${url}: HTTP ${res.statusCode}`)); return; }
      const parts = [];
      res.on('data', (d) => parts.push(d));
      res.on('end', () => resolve(Buffer.concat(parts)));
    }).on('error', reject).on('timeout', function onTimeout() { this.destroy(new Error(`${url}: timed out`)); });
  });
}

// The list, refreshed at most every 6 hours; falls back to the cached copy when offline.
async function manifest({ maxAgeMs = MANIFEST_MAX_AGE_MS } = {}) {
  const file = path.join(CACHE, 'device-assets.json');
  let cached = null;
  try {
    cached = { data: JSON.parse(fs.readFileSync(file, 'utf8')), age: Date.now() - fs.statSync(file).mtimeMs };
  } catch { /* none yet */ }
  if (cached && cached.age < maxAgeMs) return cached.data;
  try {
    const data = JSON.parse((await get(MANIFEST_URL)).toString('utf8'));
    fs.mkdirSync(CACHE, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data));
    return data;
  } catch (e) {
    if (cached) return cached.data;
    throw new Error(`Could not reach Elgato's asset list: ${e.message}`);
  }
}

function hardwareEntry(m, pid) {
  return (m.hardwareDevices || []).find((d) => d.id && d.id.vendorId === 0x0fd9 && d.id.productId === pid) || null;
}

// "Base 26.08.25, MCU 26.09.07" -> { base: 260825, mcu: 260907 }
function parseFirmware(text) {
  const out = {};
  for (const m of String(text || '').matchAll(/(Base|MCU)\s+(\d+)\.(\d+)\.(\d+)/gi)) {
    out[m[1].toLowerCase()] = Number(m[2]) * 10000 + Number(m[3]) * 100 + Number(m[4]);
  }
  return out;
}

// EDID presets for a card, in Elgato Studio's order: the card's default, the shared presets, then
// the card's own custom ones. Presets needing newer firmware than the card has are left out.
function edidPresets(m, pid, firmwareText) {
  const own = hardwareEntry(m, pid);
  if (!own || !own.edidFiles || !own.edidFiles.length) return [];
  const shared = (m.hardwareDevices || []).filter((d) => d.isShared && d.category === own.category);
  const fw = parseFirmware(firmwareText);
  const ok = (f) => {
    const min = f.minimumFirmwareVersion;
    if (!min) return true;
    const have = fw[String(min.type).toLowerCase()];
    return have === undefined || have === null || have >= min.versionNumber;
  };
  const toPreset = (f, extra) => ({
    id: f.filename, name: f.name, url: f.downloadUrl, sha256: f.sha256 ? f.sha256.toLowerCase() : null, ...extra,
  });
  const defaults = own.edidFiles.filter((f) => f.type === 'default').map((f) => toPreset(f, { type: 'default', name: `${f.name} (Default)` }));
  const sharedList = shared.flatMap((d) => d.edidFiles || []).filter(ok).map((f) => toPreset(f, { type: 'custom' }));
  const ownCustom = own.edidFiles.filter((f) => f.type !== 'default').filter(ok).map((f) => toPreset(f, { type: 'custom' }));
  return [...defaults, ...sharedList, ...ownCustom];
}

// Downloads (or reads from the cache) one asset file and checks its SHA-256.
async function assetFile(asset, kind = 'edid') {
  const dir = path.join(CACHE, kind);
  const file = path.join(dir, path.basename(new URL(asset.url).pathname));
  const check = (buf) => !asset.sha256 || crypto.createHash('sha256').update(buf).digest('hex') === asset.sha256;
  try {
    const buf = fs.readFileSync(file);
    if (check(buf)) return buf;
  } catch { /* not cached */ }
  const buf = await get(asset.url);
  if (!check(buf)) throw new Error(`${asset.name}: downloaded file does not match Elgato's checksum`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, buf);
  return buf;
}

module.exports = { MANIFEST_URL, CACHE, get, manifest, hardwareEntry, edidPresets, assetFile, parseFirmware };
