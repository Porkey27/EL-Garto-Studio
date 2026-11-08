'use strict';
// Firmware update flow for the Game Capture 4K S, as used by the app. Same steps as
// tools/firmware-update.js (verified on a real card): check versions against Elgato's list,
// download and validate the files, rehearse on the simulator, write the MCU part (or resume it
// from the bootloader), wait for a replug, write the Base part, wait for a replug, verify.

const fs = require('fs');
const path = require('path');

const assets = require('../elgato-assets');
const { FourKSUpdater, Link, UpdateError, checkMcuImage, baseLayout } = require('./fourks');
const { SimulatedFourKS } = require('./simulator');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const versionNumber = (v) => Number(String(v).split('.').map((x) => x.padStart(2, '0')).join(''));
const older = (have, want) => !have || versionNumber(have) < versionNumber(want);

class FirmwareFlow {
  // platform: { scan(), hid }; emit(event, payload) reports progress to the UI.
  // wait: the updater's sleep (tests pass a no-op to skip the 30 s erase wait).
  constructor(platform, { emit = () => {}, wait, pollMs = 500, stableMs } = {}) {
    this.platform = platform;
    this.emit = emit;
    this.wait = wait;
    this.pollMs = pollMs;
    this.stableMs = stableMs;
  }

  async findCards() {
    return (await this.platform.scan()).filter((d) => d.model && d.model.type === '4K_S');
  }

  async connect(serial) {
    const card = (await this.findCards()).find((d) => d.serial === serial && d.controlHid);
    if (!card) return null;
    return { card, link: new Link(this.platform.hid, card.controlHid) };
  }

  async waitFor(serial, present, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const found = (await this.findCards()).some((d) => d.serial === serial && d.controlHid);
      if (found === present) return true;
      await sleep(500);
    }
    return false;
  }

  // What is installed, what Elgato offers, and what an update would do. Reads only.
  async check(serial) {
    const conn = await this.connect(serial);
    if (!conn) throw new UpdateError('The card is not connected (or its control channel is unavailable).');
    const { card, link } = conn;
    const m = await assets.manifest();
    const entry = assets.hardwareEntry(m, card.pid);
    const fw = entry && entry.firmware && entry.firmware.length ? entry.firmware : null;
    if (!fw) {
      return { supported: false, reason: card.usb2Fallback || card.pid === 0xae
        ? 'The card is connected over USB 2.0. Elgato publishes firmware only for its USB 3 mode: use a USB 3 port.'
        : 'Elgato publishes no firmware for this card.' };
    }
    const target = { mcu: fw.find((f) => f.type === 'MCU'), base: fw.find((f) => f.type === 'Base') };
    const updater = new FourKSUpdater(link);
    const mcu = await updater.mcuState();
    if (mcu.mode === 'unknown') throw new UpdateError("The card's MCU does not answer. Replug the card and try again.");
    const resume = mcu.mode === 'ldrom';
    const current = resume ? { base: null, mcu: null } : await updater.versions();
    // The running Base reports its version even when its flash copy is half-written, so also check
    // the valid flag an interrupted Base update leaves at 0.
    const baseInterrupted = !resume && !(await updater.baseValid());
    const doMcu = resume || older(current.mcu, target.mcu.version);
    const doBase = !resume && (baseInterrupted || older(current.base, target.base.version));
    return {
      supported: true, serial, resume, baseInterrupted, current,
      latest: { base: target.base.version, mcu: target.mcu.version },
      updateAvailable: doMcu || doBase, parts: { mcu: doMcu, base: doBase },
      importance: [target.mcu, target.base].some((t) => t.importance && t.importance !== 'regular') ? 'important' : 'regular',
    };
  }

  async loadFile(entry) {
    const dir = path.join(assets.CACHE, 'firmware');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, path.basename(new URL(entry.downloadUrl).pathname));
    if (!fs.existsSync(file)) {
      this.emit('status', { message: `Downloading ${path.basename(file)}…` });
      fs.writeFileSync(file, await assets.get(entry.downloadUrl));
    }
    return fs.readFileSync(file);
  }

  // Runs the update. waitForReplug(why) resolves once the user has replugged the card (the flow
  // also detects it itself); the UI uses it to show instructions.
  async run(serial, { force = false } = {}) {
    const info = await this.check(serial);
    if (!info.supported) throw new UpdateError(info.reason);
    const doMcu = info.parts.mcu || (force && !info.resume);
    const doBase = info.parts.base || (force && !info.resume);
    if (!doMcu && !doBase) return { updated: false, versions: info.current };

    const m = await assets.manifest();
    const { card } = await this.connect(serial);
    const fw = assets.hardwareEntry(m, card.pid).firmware;
    const target = { mcu: fw.find((f) => f.type === 'MCU'), base: fw.find((f) => f.type === 'Base') };

    const mcuFile = doMcu ? await this.loadFile(target.mcu) : null;
    const baseFile = doBase ? await this.loadFile(target.base) : null;
    if (mcuFile) checkMcuImage(mcuFile);
    if (baseFile) baseLayout(baseFile);

    this.emit('status', { message: 'Checking the files on a simulated card…' });
    const sim = new SimulatedFourKS();
    const rehearsal = new FourKSUpdater(new Link(sim.hid(), 'sim'), { wait: async () => {} });
    if (mcuFile) await rehearsal.updateMcu(mcuFile);
    if (baseFile) await rehearsal.updateBase(baseFile);

    const steps = [doMcu && 'mcu', doBase && 'base'].filter(Boolean);
    this.emit('plan', { steps, from: info.current, to: info.latest, resume: info.resume });
    const progress = (phase, f) => this.emit('progress', { phase, fraction: f });
    const log = (msg) => this.emit('status', { message: msg });

    if (doMcu) {
      this.emit('step', { step: 'mcu', state: 'writing' });
      const { link } = await this.connect(serial);
      await new FourKSUpdater(link, { log, progress, wait: this.wait }).updateMcu(mcuFile);
      log('MCU written. Waiting for the card to restart…');
      await this.waitFor(serial, false, 15000);
      if (!(await this.waitFor(serial, true, 30000))) throw new UpdateError('The card did not come back after the MCU update. Replug it, then run the update again.');
      await this.replug(serial, 'The MCU part is done. Unplug the card\'s USB cable, wait 5 seconds, and plug it back into the same port.');
      const v = await new FourKSUpdater((await this.connect(serial)).link).versions();
      if (v.mcu !== target.mcu.version) throw new UpdateError(`The MCU reports ${v.mcu}, expected ${target.mcu.version}. Stopped before the Base part.`);
      this.emit('step', { step: 'mcu', state: 'done', version: v.mcu });
    }

    if (doBase) {
      this.emit('step', { step: 'base', state: 'writing' });
      // The Base part can be rerun safely (clear flag, write, verify, set flag), so if the card's
      // connection drops during it, wait for the card and run it again.
      for (let attempt = 1; ; attempt++) {
        try {
          const conn = await this.connect(serial);
          if (!conn) throw new UpdateError('The card is not connected.');
          await new FourKSUpdater(conn.link, { log, progress, wait: this.wait }).updateBase(baseFile);
          break;
        } catch (e) {
          if (attempt >= 3 || /verify failed/.test(e.message)) {
            throw new UpdateError(`${e.message}. The Base part did not finish: leave the card plugged in and run the update again (Finish update).`);
          }
          log(`The card's connection dropped (${e.message}). Waiting for it and retrying the Base part…`);
          await this.waitStable(serial);
        }
      }
      await this.replug(serial, 'The Base part is written and verified. Unplug the card\'s USB cable, wait 5 seconds, and plug it back in to start it.');
      this.emit('step', { step: 'base', state: 'done' });
    }

    const final = await new FourKSUpdater((await this.connect(serial)).link).versions();
    if ((doBase && final.base !== target.base.version) || (doMcu && final.mcu !== target.mcu.version)) {
      throw new UpdateError(`The card reports Base ${final.base}, MCU ${final.mcu}, not the expected versions. Run the update again.`);
    }
    return { updated: true, versions: final };
  }

  // After a replug the card can drop off USB once more while it finishes starting. Wait until it has
  // stayed connected for `stableMs` and answers, before talking to it.
  async waitStable(serial, { stableMs = this.stableMs ?? 8000, timeoutMs = 90000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    let since = null;
    while (Date.now() < deadline) {
      const present = (await this.findCards()).some((d) => d.serial === serial && d.controlHid);
      if (!present) since = null;
      else if (since === null) since = Date.now();
      else if (Date.now() - since >= stableMs) {
        try {
          const conn = await this.connect(serial);
          if (conn) { await new FourKSUpdater(conn.link).versions(); return; }
        } catch { since = null; }
      }
      await sleep(this.pollMs);
    }
    throw new UpdateError('The card did not settle after reconnecting. Leave it plugged in and run the update again.');
  }

  async replug(serial, message) {
    this.emit('replug', { message, state: 'waiting-unplug' });
    if (!(await this.waitFor(serial, false, 10 * 60000))) throw new UpdateError('Timed out waiting for the card to be unplugged.');
    this.emit('replug', { message, state: 'waiting-plug' });
    if (!(await this.waitFor(serial, true, 10 * 60000))) throw new UpdateError('Timed out waiting for the card to be plugged back in.');
    this.emit('status', { message: 'Waiting for the card to finish starting…' });
    await this.waitStable(serial);
    this.emit('replug', { message, state: 'done' });
  }
}

module.exports = { FirmwareFlow, older };
