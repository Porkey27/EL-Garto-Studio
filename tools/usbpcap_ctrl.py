"""Extracts class-specific control transfers (HID reports, UVC XU/PU) from a USBPcap pcap.

Usage: python -I tools/usbpcap_ctrl.py <file.pcap> [--device N] > transfers.tsv

Each output line: time, request type, bRequest, wValue, wIndex, wLength, OUT data hex, IN data hex,
USBD status. Bulk and isochronous packets (video/audio) are skipped without being parsed.
"""
import struct
import sys

URB_CONTROL = 2
STAGE_SETUP, STAGE_DATA, STAGE_STATUS, STAGE_COMPLETE = 0, 1, 2, 3


def packets(path):
    with open(path, 'rb') as f:
        magic = f.read(24)[:4]
        endian = '<' if magic in (b'\xd4\xc3\xb2\xa1', b'\x4d\x3c\xb2\xa1') else '>'
        nano = magic in (b'\x4d\x3c\xb2\xa1', b'\xa1\xb2\x3c\x4d')
        while True:
            rec = f.read(16)
            if len(rec) < 16:
                return
            sec, frac, incl, _orig = struct.unpack(endian + 'IIII', rec)
            data = f.read(incl)
            yield sec + frac / (1e9 if nano else 1e6), data


def main():
    path = sys.argv[1]
    want_dev = int(sys.argv[sys.argv.index('--device') + 1]) if '--device' in sys.argv else None
    pending = {}  # irp id -> transfer dict
    t0 = None
    for ts, d in packets(path):
        if len(d) < 27:
            continue
        hlen, irp, status, _func, info, _bus, dev, ep, ttype, dlen = struct.unpack_from('<HQIHBHHBBI', d, 0)
        if ttype != URB_CONTROL or (want_dev is not None and dev != want_dev):
            continue
        t0 = ts if t0 is None else t0
        stage = d[27]
        payload = d[hlen:hlen + dlen]
        completion = info & 1
        if stage == STAGE_SETUP and not completion:
            bm, req, wval, widx, wlen = struct.unpack_from('<BBHHH', payload, 0)
            if bm & 0x60 != 0x20:  # class requests only
                continue
            # OUT data may follow the setup bytes in the same packet.
            pending[irp] = dict(t=ts - t0, bm=bm, req=req, wval=wval, widx=widx, wlen=wlen,
                                out=payload[8:], inp=b'', status=0)
        elif irp in pending:
            x = pending[irp]
            if stage == STAGE_DATA:
                if completion:
                    x['inp'] += payload
                else:
                    x['out'] += payload
            elif completion and stage in (STAGE_STATUS, STAGE_COMPLETE):
                x['status'] = status
                if payload and x['bm'] & 0x80 and not x['inp']:
                    x['inp'] = payload
                del pending[irp]
                print('\t'.join([f"{x['t']:.3f}", f"{x['bm']:02x}", f"{x['req']:02x}", f"{x['wval']:04x}",
                                 f"{x['widx']:04x}", str(x['wlen']), x['out'].hex(), x['inp'].hex(), f"{x['status']:08x}"]))


if __name__ == '__main__':
    main()
