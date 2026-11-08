'use strict';
// Linux virtual microphone: a null sink the app plays its audio into ("El-Gato Virtual Audio") and a
// source remapped from that sink's monitor ("El-Gato Virtual Microphone"), which Discord, OBS and
// browsers list as an ordinary microphone. Works with PulseAudio and with PipeWire (pipewire-pulse),
// through pactl.

const { execFile } = require('child_process');

const SINK = 'el_gato_virtual_audio';
const OLD_NAMES = ['studio_virtual_audio', 'studio_virtual_mic']; // from before the rename, removed if left over
const SOURCE = 'el_gato_virtual_mic';
const SINK_LABEL = 'El-Gato Virtual Audio';
const SOURCE_LABEL = 'El-Gato Virtual Microphone';

function pactl(...args) {
  return new Promise((resolve, reject) => {
    execFile('pactl', args, { timeout: 10000 }, (err, stdout, stderr) => {
      if (err) {
        const msg = err.code === 'ENOENT'
          ? 'pactl not found: install pulseaudio-utils (PipeWire systems need pipewire-pulse too)'
          : (stderr || err.message).trim();
        reject(new Error(msg));
      } else resolve(stdout.trim());
    });
  });
}

// "pactl list short modules" lines: id \t name \t args
async function ourModules() {
  const out = await pactl('list', 'short', 'modules');
  return out.split('\n').map((l) => l.split('\t')).filter((c) => c.length >= 3)
    .filter(([, name, args]) => (name === 'module-null-sink' && [SINK, OLD_NAMES[0]].some((n) => args.includes(`sink_name=${n}`)))
      || (name === 'module-remap-source' && [SOURCE, OLD_NAMES[1]].some((n) => args.includes(`source_name=${n}`))))
    .map(([id, name]) => ({ id, name }));
}

async function available() {
  if (process.platform !== 'linux') return false;
  try { await pactl('info'); return true; } catch { return false; }
}

// Creates both devices (removing leftovers from a crashed run first). Returns the sink's label,
// which the renderer uses to find it among audio outputs.
async function start() {
  await stop();
  await pactl('load-module', 'module-null-sink', `sink_name=${SINK}`,
    `sink_properties="device.description='${SINK_LABEL}'"`, 'channels=2', 'rate=48000');
  try {
    await pactl('load-module', 'module-remap-source', `master=${SINK}.monitor`, `source_name=${SOURCE}`,
      `source_properties="device.description='${SOURCE_LABEL}'"`, 'channels=2');
  } catch (e) {
    await stop();
    throw e;
  }
  return { sinkLabel: SINK_LABEL, sourceLabel: SOURCE_LABEL };
}

async function stop() {
  let mods = [];
  try { mods = await ourModules(); } catch { return; }
  // Remove the remapped source before the sink it reads from.
  mods.sort((a) => (a.name === 'module-remap-source' ? -1 : 1));
  for (const m of mods) await pactl('unload-module', m.id).catch(() => {});
}

module.exports = { available, start, stop, SINK_LABEL, SOURCE_LABEL };
