'use strict';
// Firmware updater for the Game Capture 4K S (and the same PD575 generation), rebuilt from USB
// captures of Elgato Studio updating a real card (docs/FIRMWARE.md §3). Every frame below matches
// those captures byte for byte; see test/firmware-fourks.test.js.
//
// Transport: the card's vendor HID interface.
//   * I2C over HID: output report 6 [len, op, addr, n, bytes…(, readLen)], replies on input report 5
//     as [status, data…] (wLength 2047 for reads, 1791 for the acknowledgement after a write).
//   * Flash access (Base only): output report 4 (mode/address, length), output report 3 (4 KB data
//     bursts), input report 1 (4 KB read-back).

const REPLY_LEN_READ = 2047;
const REPLY_LEN_ACK = 1791;

const MCU_I2C = 0x66; // MCU command channel
const LDROM_I2C = 0x6c; // MCU bootloader once in LDROM

const JUMP_TO_LDROM = [0xaa, 0x03, 0x0d, 0x12, 0x04, 0x86, 0x54, 0x06, 0xaa]; // constant in Studio's Jump2LDROM
const GET_MCU_VERSION = [0xab, 0x03, 0x12, 0x34, 0x58]; // 0xAB = 0xAA|1: command with 3-byte read-back
const LD = { IDLE_CHECK: 0xac, ERASE_ALL: 0xa2, VERSION: 0xa3, RUN_APROM: 0xa4, PROGRAM: 0xae };
const LDROM_IDLE = 0xab;
const APROM_BASE = 0xc00000;
const MCU_CHUNK = 240;
const MCU_PADDING = 0x200; // Studio sends the image plus 512 zero bytes
const ERASE_WAIT_MS = 30000; // Studio waits ~30 s after "erase all" (1 s progress loop)
// Studio waits ~15 ms after each chunk's acknowledgement before reading the write pointer. Read
// too early and the card is still programming: the reply is a stale buffer (our own command echoed).
const CHUNK_SETTLE_MS = 15;
const POINTER_RETRIES = 20;

const CONFIG_PAGE = 0x70000;
const CONFIG_LEN = 0x1000;
const BASE_ADDR = 0x180000;
const FLASH_CHUNK = 0x1000;
// Extra regions Studio copies from the image after the main write (table in EGAVDeviceSupport.dll).
const BASE_SECTIONS = [{ addr: 0x4f0000, len: 0x10000 }, { addr: 0x500000, len: 0x20000 }];
const MODE = { MAIN: 0, CONFIG: 2, SECTION: 3 };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ymd = (b) => [...b].map((x) => String(x).padStart(2, '0')).join('.');

class UpdateError extends Error {}

// ---- image checks -------------------------------------------------------------------

function checkMcuImage(buf) {
  // The official 26.09.07 image is 71,320 bytes; anything outside 4 KB–128 KB is not an MCU image.
  if (buf.length < 0x1000 || buf.length >= 0x20000) throw new UpdateError(`MCU image size ${buf.length} is not plausible for the 4K S MCU`);
  // ARM Cortex-M vector table: initial stack pointer in SRAM, reset vector is a Thumb address in flash.
  const sp = buf.readUInt32LE(0);
  const reset = buf.readUInt32LE(4);
  if ((sp & 0xfff00000) !== 0x20000000) throw new UpdateError(`MCU image does not start with a vector table (SP 0x${sp.toString(16)})`);
  if (!(reset & 1) || reset >= buf.length + 0x1000) throw new UpdateError(`MCU image reset vector 0x${reset.toString(16)} is not a Thumb address inside the image`);
  return { size: buf.length };
}

function baseLayout(buf) {
  if (buf.length !== 0x800000) throw new UpdateError(`Base image must be an 8 MB flash image (got ${buf.length} bytes)`);
  if (buf.toString('latin1', 0, 8) !== 'SMEDIA02' || buf.toString('latin1', BASE_ADDR, BASE_ADDR + 8) !== 'SMEDIA02') {
    throw new UpdateError('Base image does not carry the SMEDIA02 headers at 0 and 0x180000');
  }
  const headerLen = buf.readUInt32BE(BASE_ADDR + 0x0c);
  const bootSize = buf.readUInt32BE(BASE_ADDR + 0x10);
  const len = (headerLen + bootSize + 0xffff) & ~0xffff; // rounded up to 64 KB, as Studio does
  if (!headerLen || !bootSize || len > 0x200000) throw new UpdateError(`Base image header looks wrong (header 0x${headerLen.toString(16)}, boot 0x${bootSize.toString(16)})`);
  return { main: { addr: BASE_ADDR, len }, sections: BASE_SECTIONS };
}

// ---- transport ------------------------------------------------------------------------

// Output report sizes on the wire (report id included), as captured from Studio. hidraw sends
// exactly what it is given, so frames are padded here; Windows pads to the HID caps size itself.
const REPORT_SIZE = { 0x03: 4100, 0x04: 32, 0x06: 255 };
const pad = (bytes) => {
  const b = Buffer.from(bytes);
  const size = REPORT_SIZE[b[0]];
  return size && b.length < size ? Buffer.concat([b, Buffer.alloc(size - b.length)]) : b;
};

class Link {
  // hid: platform.hid-like { write(node, bytes), input(node, id, wireLen), xfer? }; node: HID path.
  constructor(hid, node) {
    this.hid = hid;
    this.node = node;
  }

  async request(bytes, replyId, replyLen) {
    if (this.hid.xfer) return this.hid.xfer(this.node, pad(bytes), replyId, replyLen);
    await this.hid.write(this.node, pad(bytes));
    return this.hid.input(this.node, replyId, replyLen);
  }

  // I2C write of raw bytes; returns the status byte of the acknowledgement Studio reads after it.
  async i2cWrite(addr, bytes, { ack = true } = {}) {
    const frame = [0x06, 4 + bytes.length, 0x06, addr, bytes.length, ...bytes];
    if (!ack) return this.hid.write(this.node, pad(frame));
    const r = await this.request(frame, 0x05, REPLY_LEN_ACK);
    return r[1]; // [reportId, status]
  }

  // I2C read: optional register/command bytes, then n bytes back. Returns { status, data }.
  async i2cRead(addr, outBytes, n) {
    const frame = [0x06, 5 + outBytes.length, 0x07, addr, outBytes.length, ...outBytes, n];
    const r = await this.request(frame, 0x05, REPLY_LEN_READ);
    return { status: r[1], data: r.subarray(2, 2 + n) };
  }

  async flashAccess(mode, addr) {
    const b = Buffer.alloc(8);
    b[0] = 0x04; b[1] = 0x07; b[2] = 0x03; b[3] = mode;
    b.writeUInt32LE(addr, 4);
    await this.hid.write(this.node, pad(b));
  }

  async flashLength(len) {
    const b = Buffer.alloc(7);
    b[0] = 0x04; b[1] = 0x06; b[2] = 0x05;
    b.writeUInt32LE(len, 3);
    await this.hid.write(this.node, pad(b));
  }

  async flashWriteChunk(data) {
    await this.hid.write(this.node, pad(Buffer.concat([Buffer.from([0x03, 0, 0, 0]), data])));
  }

  async flashReadChunk() {
    const r = await this.hid.input(this.node, 0x01, FLASH_CHUNK + 1);
    return r.subarray(1, 1 + FLASH_CHUNK); // [reportId, data…]
  }
}

// ---- updater --------------------------------------------------------------------------

class FourKSUpdater {
  // link: Link; opts.log(msg), opts.progress(phase, fraction), opts.sleep (tests)
  constructor(link, { log = () => {}, progress = () => {}, wait = sleep } = {}) {
    this.link = link;
    this.log = log;
    this.progress = progress;
    this.sleep = wait;
  }

  async versions() {
    const { data } = await this.link.i2cRead(0x55, [0x02], 6);
    return { base: ymd(data.subarray(0, 3)), mcu: ymd(data.subarray(3, 6)) };
  }

  async hdmiSignal() {
    const { data } = await this.link.i2cRead(0x55, [0x00], 8);
    return data.readUInt16LE(1) > 0;
  }

  // ---- MCU (APROM via the LDROM bootloader at I2C 0x6C) ----

  async expectAck(addr, bytes, what, expected = 0) {
    const status = await this.link.i2cWrite(addr, bytes);
    if (status !== expected) throw new UpdateError(`${what}: card answered status ${status}, expected ${expected}`);
  }

  async enterBootloader() {
    for (let attempt = 1; attempt <= 5; attempt++) {
      await this.expectAck(MCU_I2C, JUMP_TO_LDROM, 'jump to bootloader');
      await this.sleep(1200);
      await this.expectAck(LDROM_I2C, [LD.IDLE_CHECK], 'bootloader idle check');
      const { data } = await this.link.i2cRead(LDROM_I2C, [], 1);
      if (data[0] === LDROM_IDLE) return;
      this.log(`bootloader not idle yet (0x${data[0].toString(16)}), retrying (${attempt}/5)`);
    }
    throw new UpdateError('MCU did not enter its bootloader');
  }

  // Where the MCU is: running its application ({ mode: 'app', version }), sitting in its bootloader
  // after an interrupted update ({ mode: 'ldrom' }), or neither answering ({ mode: 'unknown' }).
  async mcuState() {
    if (await this.link.i2cWrite(MCU_I2C, GET_MCU_VERSION) === 0) {
      await this.sleep(50);
      const ver = (await this.link.i2cRead(MCU_I2C, [], 3)).data;
      if (ver[0] >= 0x14 && ver[0] <= 0x28) return { mode: 'app', version: ymd(ver) };
    }
    if (await this.link.i2cWrite(LDROM_I2C, [LD.IDLE_CHECK]) === 0) {
      const { data } = await this.link.i2cRead(LDROM_I2C, [], 1);
      if (data[0] === LDROM_IDLE) return { mode: 'ldrom' };
    }
    return { mode: 'unknown' };
  }

  // Reads the bootloader's write pointer until it reaches `want`. Re-reading is harmless; a chunk is
  // never sent twice.
  async waitForPointer(want, after) {
    let got = null;
    for (let i = 0; i < POINTER_RETRIES; i++) {
      await this.sleep(i ? 10 : CHUNK_SETTLE_MS);
      await this.link.i2cRead(LDROM_I2C, [], 1);
      const ptr = (await this.link.i2cRead(LDROM_I2C, [], 3)).data;
      got = ptr[0] | (ptr[1] << 8) | (ptr[2] << 16);
      if (got === want) return;
    }
    throw new UpdateError(`bootloader write pointer 0x${got.toString(16)} after ${after} bytes, expected 0x${want.toString(16)}. `
      + 'The card is still in its bootloader: do not unplug it, run the update again.');
  }

  async updateMcu(file) {
    checkMcuImage(file);
    const image = Buffer.concat([file, Buffer.alloc(MCU_PADDING)]);

    const state = await this.mcuState();
    if (state.mode === 'app') {
      this.log(`MCU reports ${state.version}`);
      // From here the card's controller runs its bootloader. If anything fails before RUN_APROM,
      // the bootloader stays in charge and the update can simply be run again.
      this.log('Entering the MCU bootloader');
      await this.enterBootloader();
    } else if (state.mode === 'ldrom') {
      this.log('MCU is already in its bootloader (an earlier update stopped part-way); resuming');
    } else {
      throw new UpdateError('the MCU answers neither as running firmware nor as its bootloader; refusing to continue');
    }

    this.log('Erasing MCU flash (about 30 s)');
    await this.expectAck(LDROM_I2C, [LD.ERASE_ALL], 'erase');
    for (let s = 0; s < ERASE_WAIT_MS / 1000; s++) {
      this.progress('mcu-erase', s / (ERASE_WAIT_MS / 1000));
      await this.sleep(1000);
    }

    await this.expectAck(LDROM_I2C, [LD.VERSION], 'bootloader version');
    await this.link.i2cRead(LDROM_I2C, [], 1);
    const ld = (await this.link.i2cRead(LDROM_I2C, [], 3)).data;
    this.log(`Bootloader ${ld.toString('hex')}`);

    this.log(`Writing ${image.length} bytes`);
    for (let off = 0; off < image.length; off += MCU_CHUNK) {
      const chunk = image.subarray(off, Math.min(off + MCU_CHUNK, image.length));
      await this.expectAck(LDROM_I2C, [LD.PROGRAM, ...chunk], `write at ${off}`);
      await this.waitForPointer(APROM_BASE + off + chunk.length, off + chunk.length);
      this.progress('mcu-write', (off + chunk.length) / image.length);
    }

    this.log('Starting the new MCU firmware');
    await this.expectAck(LDROM_I2C, [LD.RUN_APROM], 'run firmware');
    await this.link.i2cWrite(LDROM_I2C, [LD.IDLE_CHECK]); // answers 1 once the bootloader hands over
    await this.link.i2cRead(LDROM_I2C, [], 1).catch(() => {});
  }

  // ---- Base (video chip flash through flash-access reports) ----

  async readFlash(mode, addr, len) {
    await this.link.flashAccess(mode, addr);
    await this.link.flashLength(len);
    const parts = [];
    for (let off = 0; off < len; off += FLASH_CHUNK) parts.push(await this.link.flashReadChunk());
    return Buffer.concat(parts);
  }

  async writeFlash(mode, addr, data, phase) {
    await this.link.flashAccess(mode, addr);
    await this.link.flashLength(data.length);
    for (let off = 0; off < data.length; off += FLASH_CHUNK) {
      await this.link.flashWriteChunk(data.subarray(off, off + FLASH_CHUNK));
      if (phase) this.progress(phase, (off + FLASH_CHUNK) / data.length);
    }
  }

  async setConfigValid(valid) {
    const page = await this.readFlash(MODE.CONFIG, CONFIG_PAGE, CONFIG_LEN);
    const updated = Buffer.from(page);
    updated[0] = valid ? 1 : 0;
    await this.writeFlash(MODE.CONFIG, CONFIG_PAGE, updated);
    return page[0];
  }

  // The Base "valid" flag (config page byte 0). An update clears it first and sets it again only
  // after the new image is verified, so 0 means a Base update was interrupted.
  async baseValid() {
    const page = await this.readFlash(MODE.CONFIG, CONFIG_PAGE, CONFIG_LEN);
    return page[0] === 1;
  }

  async updateBase(file) {
    const layout = baseLayout(file);
    const main = file.subarray(layout.main.addr, layout.main.addr + layout.main.len);

    const was = await this.setConfigValid(false);
    if (was !== 1) this.log(`note: config flag was ${was} before the update (1 = valid)`);
    await this.sleep(300);

    // Risky window starts: the card's video firmware is being replaced.
    this.log(`Writing ${main.length} bytes at 0x${layout.main.addr.toString(16)}`);
    await this.writeFlash(MODE.MAIN, layout.main.addr, main, 'base-write');
    await this.sleep(300);

    this.log('Verifying');
    const back = await this.readFlash(MODE.MAIN, layout.main.addr, main.length);
    if (!back.equals(main)) {
      const at = [...main].findIndex((b, i) => back[i] !== b);
      throw new UpdateError(`verify failed at +0x${at.toString(16)}; the card is NOT marked valid. Run the update again before unplugging.`);
    }
    await this.setConfigValid(true);
    // Risky window ends: the new image is verified and marked valid.

    for (const s of layout.sections) {
      await this.sleep(300);
      this.log(`Writing section 0x${s.addr.toString(16)} (${s.len} bytes)`);
      await this.writeFlash(MODE.SECTION, s.addr, file.subarray(s.addr, s.addr + s.len), 'base-sections');
    }
  }
}

module.exports = {
  FourKSUpdater, Link, UpdateError, checkMcuImage, baseLayout,
  constants: { APROM_BASE, MCU_CHUNK, MCU_PADDING, BASE_ADDR, CONFIG_PAGE, BASE_SECTIONS, JUMP_TO_LDROM, GET_MCU_VERSION },
};
