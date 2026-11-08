"""Extracts the firmware data Elgato Studio wrote during a captured 4K S update.

Usage: python -I tools/extract_fw_streams.py <mcu-run.tsv> <base-run.tsv> <outdir>
(the .tsv files come from tools/usbpcap_ctrl.py)

Writes:
  mcu_stream.bin        concatenated payloads of the I2C writes to bootloader 0x6C, register 0xAE
  mcu_transactions.txt  every I2C transaction of the MCU phase with full payloads and replies
  base_<addr>.bin       data burst-written to each flash address (report 3), header bytes stripped
  base_steps.txt        report 4 commands, burst sizes and read-back sizes in order
"""
import os
import struct
import sys


def rows(path):
    for line in open(path, encoding='utf-8-sig'):
        t, bm, req, wv, wi, wl, out, inp, st = line.rstrip('\n').split('\t')
        if wi != '0007':
            continue
        yield float(t), bm, req, wv, int(wl), bytes.fromhex(out), bytes.fromhex(inp), st


def mcu(path, outdir):
    stream = bytearray()
    log = []
    pending = None
    for t, bm, req, wv, wl, out, inp, st in rows(path):
        if bm == '21' and req == '09' and wv == '0206':
            p = out[1:]
            total, op, addr, n, reg = p[0], p[1], p[2], p[3], p[4]
            if addr in (0x55, 0x60, 0xa0, 0xaa):
                pending = None
                continue  # status polling / EDID, not part of the update
            if op == 6:
                data = p[5:5 + n - 1]
                if addr == 0x6c and reg == 0xae:
                    stream += data
                log.append(f'{t:9.3f} W {addr:02x}/{reg:02x} len={len(data)} {data[:16].hex(" ")}')
                pending = ('ack', t)
            elif op == 7:
                pending = ('read', t, addr, reg, p[5])
        elif bm == 'a1' and req == '01' and wv == '0105' and pending:
            if pending[0] == 'read':
                _, tt, addr, reg, n = pending
                log.append(f'{tt:9.3f} R {addr:02x}/{reg:02x} n={n} -> {inp[:n + 1].hex(" ")} (wLen {wl})')
            else:
                log.append(f'{t:9.3f}   reply (wLen {wl}) {inp[:8].hex(" ")}')
            pending = None
    open(os.path.join(outdir, 'mcu_stream.bin'), 'wb').write(stream)
    open(os.path.join(outdir, 'mcu_transactions.txt'), 'w').write('\n'.join(log))
    print(f'MCU: {len(stream)} bytes streamed to 0x6C/0xAE, {len(log)} logged transactions')


def base(path, outdir):
    steps = []
    addr = None
    mode = None
    length = None
    buf = {}
    reads = 0
    for t, bm, req, wv, wl, out, inp, st in rows(path):
        if bm == '21' and req == '09' and wv == '0204':
            p = out[1:]
            if p[0] == 0x07 and p[1] == 0x03:
                mode = p[2]
                addr = struct.unpack_from('<I', p, 3)[0]
                steps.append(f'{t:8.3f} ACCESS mode={mode} addr=0x{addr:06x}')
            elif p[0] == 0x06 and p[1] == 0x05:
                length = struct.unpack_from('<I', p, 2)[0]
                steps.append(f'{t:8.3f} SET_LEN 0x{length:x}')
            else:
                steps.append(f'{t:8.3f} rpt4 ?? {p[:12].hex(" ")}')
        elif bm == '21' and req == '09' and wv == '0203':
            payload = out[4:]  # report id + 3 header bytes
            buf.setdefault((addr, mode), bytearray()).extend(payload)
            steps.append(f'{t:8.3f}   DATA {len(payload)} first={payload[:8].hex(" ")}')
        elif bm == 'a1' and req == '01' and wv == '0101':
            reads += 1
            steps.append(f'{t:8.3f}   READ {len(inp)} first={inp[:8].hex(" ")}')
    # Collapse repeated DATA/READ lines for readability.
    collapsed = []
    for s in steps:
        key = s.split()[1] if len(s.split()) > 1 else ''
        if collapsed and key in ('DATA', 'READ') and collapsed[-1][0] == key:
            collapsed[-1][1] += 1
        else:
            collapsed.append([key, 1, s])
    open(os.path.join(outdir, 'base_steps.txt'), 'w').write('\n'.join(f'{c[2]}' + (f'  (x{c[1]})' if c[1] > 1 else '') for c in collapsed))
    for (a, m), data in buf.items():
        name = os.path.join(outdir, f'base_mode{m}_{a:06x}.bin')
        open(name, 'wb').write(data)
        print(f'Base: mode {m} addr 0x{a:06x}: {len(data)} bytes -> {os.path.basename(name)}')


if __name__ == '__main__':
    os.makedirs(sys.argv[3], exist_ok=True)
    mcu(sys.argv[1], sys.argv[3])
    base(sys.argv[2], sys.argv[3])
