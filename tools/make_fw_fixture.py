"""Builds test/fixtures/fourks-update-frames.json from the captured Studio update (usbpcap_ctrl.py
output of the MCU run and the Base run). Only hashes and short command frames are stored, never
firmware bytes, so the fixture can be committed.

Usage: python -I tools/make_fw_fixture.py <mcu-run.tsv> <base-run.tsv> <out.json>
"""
import hashlib
import json
import sys


def frames(path):
    for line in open(path, encoding='utf-8-sig'):
        t, bm, req, wv, wi, wl, out, inp, st = line.rstrip('\n').split('\t')
        if wi == '0007' and bm == '21' and req == '09':
            yield int(wv, 16) & 0xff, bytes.fromhex(out)


def main():
    mcu_chunks = []
    mcu_commands = []
    for rid, f in frames(sys.argv[1]):
        if rid != 0x06:
            continue
        op, addr, n = f[2], f[3], f[4]
        if addr not in (0x66, 0x6c):
            continue
        if op == 0x06 and addr == 0x6c and f[5] == 0xae:
            mcu_chunks.append(f)
        elif op == 0x06:
            hexf = f[:5 + n].hex()
            if hexf not in mcu_commands:
                mcu_commands.append(hexf)
    flash = [f for rid, f in frames(sys.argv[2]) if rid in (0x03, 0x04)]

    def digest(items):
        h = hashlib.sha256()
        for i in items:
            h.update(i)
        return h.hexdigest()

    out = {
        'source': 'USBPcap of Elgato Studio 2.0.0.3364 updating a Game Capture 4K S (0fd9:00af) from '
                  'Base 25.07.23 / MCU 25.12.03 to Base 26.08.25 / MCU 26.09.07, 2026-11-08',
        'firmware': {'mcu': 'FW_4K_S_MCU_26.09.07.bin', 'base': 'FW_4K_S_Base_26.08.25.bin'},
        'mcuChunks': {'count': len(mcu_chunks), 'frameLen': len(mcu_chunks[0]), 'sha256': digest(mcu_chunks)},
        'mcuCommands': mcu_commands,
        'flashFrames': {'count': len(flash), 'sha256': digest(flash)},
    }
    json.dump(out, open(sys.argv[3], 'w'), indent=2)
    print(json.dumps({k: v for k, v in out.items() if k != 'source'}, indent=2))


if __name__ == '__main__':
    main()
