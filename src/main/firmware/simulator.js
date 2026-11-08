'use strict';
// A simulated Game Capture 4K S for dry runs and tests. It speaks the same HID protocol as the
// real card (I2C over HID, the LDROM bootloader, flash-access reports), records every frame it is
// sent, and answers the way the card did in the USB captures.

class SimulatedFourKS {
  // state: 'app' (normal) or 'ldrom' (left in the bootloader by an interrupted update).
  // staleReads: chunk numbers (1-based) after which the first pointer read returns a stale buffer
  // echoing the command, as the real card does when it is read before it finishes programming.
  constructor({ base = [0x19, 0x07, 0x17], mcu = [0x19, 0x0c, 0x03], hdmiSignal = false, flashSize = 0x800000,
    state = 'app', staleReads = [] } = {}) {
    this.versions = { base: Buffer.from(base), mcu: Buffer.from(mcu) };
    this.hdmiSignal = hdmiSignal;
    this.flash = Buffer.alloc(flashSize, 0xff);
    this.flash[0x70000] = 1; // config page: firmware valid
    this.frames = []; // every output report, as sent (hex)
    this.state = state; // 'app' | 'ldrom' | 'running-new'
    this.staleReads = new Set(staleReads);
    this.chunks = 0;
    this.stale = null;
    this.pending = null; // what the next 1/3-byte bootloader read returns
    this.mcuReply = null;
    this.pointer = 0;
    this.lastStatus = 0;
    this.access = null;
    this.mcuImage = [];
  }

  // platform.hid-compatible interface
  hid() {
    return {
      write: async (_node, bytes) => this.onOutput(Buffer.from(bytes)),
      input: async (_node, id, len) => this.onInput(id, len),
      xfer: async (_node, bytes, id, len) => {
        this.onOutput(Buffer.from(bytes));
        return this.onInput(id, len);
      },
    };
  }

  onOutput(b) {
    this.frames.push(b.toString('hex'));
    const id = b[0];
    if (id === 0x06) return this.onI2c(b.subarray(1));
    if (id === 0x04) {
      if (b[1] === 0x07 && b[2] === 0x03) this.access = { mode: b[3], addr: b.readUInt32LE(4), off: 0 };
      else if (b[1] === 0x06 && b[2] === 0x05) this.access.len = b.readUInt32LE(3);
      return undefined;
    }
    if (id === 0x03) {
      const data = b.subarray(4, 4 + 0x1000);
      data.copy(this.flash, this.access.addr + this.access.off);
      this.access.off += data.length;
    }
    return undefined;
  }

  onI2c(p) {
    const [, op, addr, n] = p;
    const out = p.subarray(4, 4 + n);
    this.lastStatus = 0;
    if (op === 0x06) {
      if (addr === 0x66 && this.state === 'ldrom') this.lastStatus = 1; // application not running: NAK
      else if (addr === 0x66 && out[0] === 0xab) this.mcuReply = this.versions.mcu;
      else if (addr === 0x66 && out[0] === 0xaa) this.state = 'ldrom';
      else if (addr === 0x6c) this.onBootloader(out);
      else if (addr === 0x55) this.lastStatus = 0;
    } else if (op === 0x07) {
      this.readReq = { addr, reg: n ? out[0] : null, len: p[4 + n] };
    }
  }

  onBootloader(out) {
    // After RUN_APROM (a4, acknowledged with 0) the bootloader is gone: later writes answer 1.
    if (this.state !== 'ldrom') { this.lastStatus = 1; return; }
    const cmd = out[0];
    if (cmd === 0xac) this.pending = Buffer.from([0xab]);
    else if (cmd === 0xa2) { this.mcuImage = []; this.pointer = 0; }
    else if (cmd === 0xa3) this.pending = Buffer.from([0x15, 0x0b, 0x0a]);
    else if (cmd === 0xae) {
      this.mcuImage.push(...out.subarray(1));
      this.pointer += out.length - 1;
      const v = 0xc00000 + this.pointer;
      this.pending = Buffer.from([v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff]);
      if (this.staleReads.has(++this.chunks)) this.stale = Buffer.from(out.subarray(0, 3));
    } else if (cmd === 0xa4) {
      this.state = 'running-new';
    }
  }

  onInput(id, len) {
    if (id === 0x01) {
      const a = this.access;
      const chunk = this.flash.subarray(a.addr + a.off, a.addr + a.off + 0x1000);
      a.off += 0x1000;
      return Buffer.concat([Buffer.from([0x01]), chunk]);
    }
    // report 5: [id, status, data…]
    const r = this.readReq;
    this.readReq = null;
    if (!r) return Buffer.from([0x05, this.lastStatus]); // write acknowledgement
    let data = Buffer.alloc(r.len);
    if (r.addr === 0x55 && r.reg === 0x02) data = Buffer.concat([this.versions.base, this.versions.mcu, Buffer.alloc(r.len)]).subarray(0, r.len);
    else if (r.addr === 0x55 && r.reg === 0x00 && this.hdmiSignal) data = Buffer.from([0, 0x80, 0x07, 0x38, 0x04, 0x3c, 0x56, 0]);
    else if (r.addr === 0x66 && this.mcuReply) data = this.mcuReply;
    else if (r.addr === 0x6c && this.stale) {
      data = r.len === 1 ? this.stale.subarray(0, 1) : this.stale;
      if (r.len === 3) this.stale = null;
    } else if (r.addr === 0x6c && this.pending) data = r.len === 1 ? this.pending.subarray(0, 1) : this.pending;
    return Buffer.concat([Buffer.from([0x05, 0]), data, Buffer.alloc(Math.max(0, len - data.length))]).subarray(0, 2 + r.len);
  }
}

module.exports = { SimulatedFourKS };
