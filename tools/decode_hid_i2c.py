"""Decodes I2C-over-HID transactions (new framing, report 6 out / report 5 in) from the output of
usbpcap_ctrl.py, pairing each read request with the input report that answers it.

Usage: python -I tools/decode_hid_i2c.py transfers.tsv [--summary]
"""
import sys
from collections import OrderedDict


def rows(path):
    for line in open(path, encoding='utf-8-sig'):
        t, bm, req, wval, widx, _wlen, out, inp, status = line.rstrip('\n').split('\t')
        yield float(t), bm, req, int(wval, 16), int(widx, 16), bytes.fromhex(out), bytes.fromhex(inp), status


def decode(path):
    pending_read = None
    for t, bm, req, wval, widx, out, inp, status in rows(path):
        if bm == '21' and req == '09' and wval == 0x0206:
            p = out[1:] if out[:1] == b'\x06' else out  # report id may be included in the data stage
            total, op, addr, n, reg = p[0], p[1], p[2], p[3], p[4]
            if op == 0x06:
                yield t, 'W', addr, reg, p[5:5 + n - 1], status
            elif op == 0x07:
                pending_read = (t, addr, reg, p[5])
            else:
                yield t, f'?op{op:02x}', addr, reg, p[:total], status
        elif bm == 'a1' and req == '01' and wval == 0x0105 and pending_read:
            t0, addr, reg, n = pending_read
            # On the wire the reply is [status, data...]; Windows adds the report id in front.
            yield t0, 'R', addr, reg, inp[: n + 1], status
            pending_read = None


def main():
    summary = '--summary' in sys.argv
    if not summary:
        for t, kind, addr, reg, data, status in decode(sys.argv[1]):
            print(f'{t:9.3f} {kind} addr={addr:02x} reg={reg:02x} {data.hex(" ")} {"" if status == "00000000" else status}')
        return
    # Summary: per (kind, addr, reg) the distinct payloads in order of first appearance, with time.
    seen = OrderedDict()
    for t, kind, addr, reg, data, _ in decode(sys.argv[1]):
        key = (kind, addr, reg)
        vals = seen.setdefault(key, OrderedDict())
        h = data.hex(' ')
        if h not in vals:
            vals[h] = (t, 0)
        vals[h] = (vals[h][0], vals[h][1] + 1)
    for (kind, addr, reg), vals in seen.items():
        print(f'{kind} addr={addr:02x} reg={reg:02x}  ({sum(c for _, c in vals.values())}x)')
        for h, (t, c) in list(vals.items())[:12]:
            print(f'      t={t:8.2f} x{c:<4} {h}')
        if len(vals) > 12:
            print(f'      … {len(vals) - 12} more distinct values')


if __name__ == '__main__':
    main()
