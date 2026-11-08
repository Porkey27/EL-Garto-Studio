'use strict';
// Firmware updater for the Elgato Game Capture 4K S (Windows and Linux).
//
//   node tools/firmware-update.js            check versions, download and validate files, show the plan
//   node tools/firmware-update.js --write    actually update (asks for confirmation)
//
// Options: --mcu-only, --base-only, --force (reflash even if up to date),
//          --mcu-file <path>, --base-file <path> (use local files instead of downloading).
//
// It replays exactly what Elgato Studio sends (verified byte for byte against a USB capture; see
// docs/FIRMWARE.md). Close Elgato Studio first. Keep the USB cable in during each write step.

const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { execFileSync } = require('child_process');

const platform = require('../src/main/platform');
const { FourKSUpdater, Link, UpdateError, checkMcuImage, baseLayout } = require('../src/main/firmware/fourks');
const { SimulatedFourKS } = require('../src/main/firmware/simulator');
const { FirmwareFlow } = require('../src/main/firmware/flow');

const { manifest: loadManifest, get, CACHE: ASSET_CACHE } = require('../src/main/elgato-assets');
const CACHE = path.join(ASSET_CACHE, 'firmware');

const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const opt = (f) => (args.includes(f) ? args[args.indexOf(f) + 1] : null);
const WRITE = flag('--write');

const say = (s = '') => console.log(s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((r) => rl.question(question, (a) => { rl.close(); r(a.trim()); }));
}

function studioRunning() {
  try {
    if (process.platform === 'win32') return /Elgato\.Studio\.exe/i.test(execFileSync('tasklist', ['/FI', 'IMAGENAME eq Elgato.Studio.exe'], { encoding: 'utf8' }));
  } catch { /* tasklist unavailable */ }
  return false;
}

async function findCards() {
  return (await platform.scan()).filter((d) => d.model && d.model.type === '4K_S');
}

async function connect(serial) {
  const card = (await findCards()).find((d) => d.serial === serial);
  if (!card || !card.controlHid) return null;
  return { card, link: new Link(platform.hid, card.controlHid) };
}

async function waitFor(serial, present, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = (await findCards()).some((d) => d.serial === serial && d.controlHid);
    if (found === present) return true;
    await sleep(500);
  }
  if (label) throw new UpdateError(`timed out waiting for the card to ${label}`);
  return false;
}

// Physical replug, as Studio requires between and after the two parts.
async function replug(serial, why) {
  say(`\n>>> ${why}`);
  say('>>> Unplug the 4K S USB cable now, wait 5 seconds, then plug it back into the SAME port.');
  await waitFor(serial, false, 5 * 60000, 'be unplugged');
  say('    Unplugged. Waiting for it to come back…');
  await waitFor(serial, true, 5 * 60000, 'be plugged back in');
  // The card can drop off USB once more while it finishes starting; wait until it has settled.
  say('    Back. Waiting for it to finish starting…');
  await new FirmwareFlow(platform).waitStable(serial);
  say('    Ready.');
}

async function loadFirmware(entry, localPath) {
  if (localPath) return fs.readFileSync(localPath);
  fs.mkdirSync(CACHE, { recursive: true });
  const file = path.join(CACHE, path.basename(new URL(entry.downloadUrl).pathname));
  if (!fs.existsSync(file)) {
    say(`  Downloading ${path.basename(file)}…`);
    fs.writeFileSync(file, await get(entry.downloadUrl));
  }
  return fs.readFileSync(file);
}

const versionNumber = (v) => Number(v.split('.').map((x) => x.padStart(2, '0')).join(''));

async function main() {
  say('Game Capture 4K S firmware updater (unofficial)');
  say(WRITE ? 'Mode: WRITE — the card will be updated.\n' : 'Mode: dry run — nothing is written. Add --write to update.\n');

  if (studioRunning()) throw new UpdateError('Elgato Studio is running. Quit it from the tray first (it polls the card and would interfere).');

  const cards = await findCards();
  if (!cards.length) throw new UpdateError('No Game Capture 4K S found.');
  if (cards.length > 1) throw new UpdateError('More than one 4K S is connected. Leave only the one to update plugged in.');
  const card = cards[0];
  say(`Card: ${card.name}, serial ${card.serial}, USB ID 0fd9:${card.pid.toString(16).padStart(4, '0')}`);
  if (!card.controlHid) throw new UpdateError('The card has no HID control channel (driver or permissions; on Linux install the udev rule).');

  const manifest = await loadManifest({ maxAgeMs: 0 });
  const entry = (manifest.hardwareDevices || []).find((d) => d.id && d.id.vendorId === 0x0fd9 && d.id.productId === card.pid);
  const fw = entry && entry.firmware && entry.firmware.length ? entry.firmware : null;
  if (!fw) {
    throw new UpdateError(`Elgato publishes no firmware for USB ID 0fd9:${card.pid.toString(16)}. If that is the USB 2.0 ID (00ae), `
      + 'connect the card to a USB 3 port with its own cable.');
  }
  const target = { mcu: fw.find((f) => f.type === 'MCU'), base: fw.find((f) => f.type === 'Base') };

  const { link } = await connect(card.serial);
  const updater = new FourKSUpdater(link, { log: (m) => say(`  ${m}`), progress: progressBar });

  // An interrupted MCU update leaves the MCU in its bootloader. Its application (and the version
  // registers it serves) is gone until the MCU part is written again, so go straight to that.
  const mcu = await updater.mcuState();
  const resume = mcu.mode === 'ldrom';
  if (mcu.mode === 'unknown') throw new UpdateError("The card's MCU does not answer. Replug the card and try again.");
  let current = { base: '?', mcu: '?' };
  if (resume) {
    say('The MCU is in its bootloader: an earlier update stopped part-way. The MCU part will be written again.');
    say('Keep the card plugged in until it finishes.');
  } else {
    current = await updater.versions();
  }
  say(`Installed: Base ${current.base}, MCU ${current.mcu}`);
  say(`Latest:    Base ${target.base.version}, MCU ${target.mcu.version}\n`);

  const older = (a, b) => a === '?' || versionNumber(a) < versionNumber(b);
  const doMcu = resume || (!flag('--base-only') && (flag('--force') || older(current.mcu, target.mcu.version)));
  // The running Base reports its version even if an interrupted update left its flash copy marked
  // invalid, so check the flag as well.
  const baseInterrupted = !resume && !(await updater.baseValid());
  if (baseInterrupted) say('The Base firmware is marked invalid: an earlier Base update did not finish. It will be written again.');
  const doBase = !resume && !flag('--mcu-only') && (baseInterrupted || flag('--force') || older(current.base, target.base.version));
  if (!doMcu && !doBase) { say('Already up to date. Nothing to do (use --force to reflash).'); return; }
  if (resume && !flag('--mcu-only')) say('After the MCU part, run this tool again for the Base part if it is still needed.\n');

  const mcuFile = doMcu ? await loadFirmware(target.mcu, opt('--mcu-file')) : null;
  const baseFile = doBase ? await loadFirmware(target.base, opt('--base-file')) : null;
  if (mcuFile) checkMcuImage(mcuFile);
  if (baseFile) baseLayout(baseFile);

  // Rehearse the whole update against the simulated card: proves the files are usable and shows
  // exactly how many reports will be sent.
  const sim = new SimulatedFourKS();
  const rehearsal = new FourKSUpdater(new Link(sim.hid(), 'sim'), { wait: async () => {} });
  if (mcuFile) await rehearsal.updateMcu(mcuFile);
  if (baseFile) await rehearsal.updateBase(baseFile);
  say('Plan:');
  if (doMcu) say(`  1. MCU  ${current.mcu} -> ${target.mcu.version}  (${mcuFile.length} bytes; ~1 min)`);
  if (doMcu) say('     then unplug and replug the USB cable');
  if (doBase) say(`  ${doMcu ? 2 : 1}. Base ${current.base} -> ${target.base.version}  (256 KB + 192 KB; ~30 s)`);
  if (doBase) say('     then unplug and replug the USB cable');
  say(`  Rehearsal on a simulated card: OK (${sim.frames.length} reports).`);

  if (!WRITE) { say('\nDry run finished. Run again with --write to update the card.'); return; }

  say('\nDo not unplug the card or close this window during a write step.');
  const answer = await ask(`Type the last 4 characters of the serial (${card.serial.slice(-4)}) to start: `);
  if (answer.toUpperCase() !== card.serial.slice(-4).toUpperCase()) throw new UpdateError('Confirmation did not match. Nothing was written.');

  let busy = null;
  process.on('SIGINT', () => {
    if (busy) say(`\n  Ignoring Ctrl+C: ${busy} is in progress and must not be interrupted.`);
    else process.exit(130);
  });

  if (doMcu) {
    say('\n== MCU update ==');
    busy = 'the MCU update';
    await updater.updateMcu(mcuFile);
    busy = null;
    say('  MCU written. Waiting for the card to restart…');
    await waitFor(card.serial, false, 15000); // it re-enumerates by itself within a few seconds
    await waitFor(card.serial, true, 30000, 'restart after the MCU update');
    await replug(card.serial, 'MCU done. A power cycle is needed before the Base update (Studio asks for this too).');
    const v = await new FourKSUpdater((await connect(card.serial)).link).versions();
    say(`  MCU now ${v.mcu}`);
    if (v.mcu !== target.mcu.version) throw new UpdateError(`MCU reports ${v.mcu}, expected ${target.mcu.version}. Stopping before the Base update.`);
  }

  if (doBase) {
    say('\n== Base update ==');
    const conn = await connect(card.serial);
    const base = new FourKSUpdater(conn.link, { log: (m) => say(`  ${m}`), progress: progressBar });
    busy = 'the Base update';
    await base.updateBase(baseFile);
    busy = null;
    await replug(card.serial, 'Base written and verified. Replug once more to start it.');
  }

  const final = await new FourKSUpdater((await connect(card.serial)).link).versions();
  say(`\nDone. Installed now: Base ${final.base}, MCU ${final.mcu}`);
  if ((doBase && final.base !== target.base.version) || (doMcu && final.mcu !== target.mcu.version)) {
    throw new UpdateError('The card does not report the expected versions. Run this tool again (or use Elgato Studio).');
  }
}

let lastBar = '';
function progressBar(phase, f) {
  const bar = `${phase.padEnd(14)} [${'#'.repeat(Math.round(f * 30)).padEnd(30)}] ${Math.round(f * 100)}%`;
  if (bar !== lastBar) process.stdout.write(`\r  ${bar}`);
  if (f >= 1) process.stdout.write('\n');
  lastBar = bar;
}

main().catch((e) => {
  console.error(`\nERROR: ${e.message}`);
  process.exitCode = 1;
});
