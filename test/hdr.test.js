'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { parseDrmInfoFrame, colorArgs, x265Params, videoMatch, EOTF } = require('../src/main/hdr');
const { remuxArgs } = require('../src/main/recorder');

// A PQ InfoFrame with BT.2020 primaries, D65, 1000 / 0.005 nits, MaxCLL 1000, MaxFALL 400.
function pqFrame() {
  const b = Buffer.alloc(32);
  b.set([0x87, 0x01, 0x1a, 0x00, 0x02, 0x00]);
  const prim = [[35400, 14600], [8500, 39850], [6550, 2300]]; // G, B, R as HDR10 sources usually send
  prim.forEach(([x, y], i) => { b.writeUInt16LE(x, 6 + i * 4); b.writeUInt16LE(y, 8 + i * 4); });
  b.writeUInt16LE(15635, 18);
  b.writeUInt16LE(16450, 20);
  b.writeUInt16LE(1000, 22);
  b.writeUInt16LE(50, 24);
  b.writeUInt16LE(1000, 26);
  b.writeUInt16LE(400, 28);
  return b;
}

test('no InfoFrame or an SDR one is SDR', () => {
  assert.deepStrictEqual(parseDrmInfoFrame(Buffer.alloc(32)), { eotf: 0, label: 'SDR', hdr: false });
  assert.strictEqual(parseDrmInfoFrame(Buffer.from('87011a5e00000000', 'hex')).hdr, false);
  assert.strictEqual(parseDrmInfoFrame(null).hdr, false);
});

test('PQ and HLG InfoFrames are HDR, with mastering metadata', () => {
  const pq = parseDrmInfoFrame(pqFrame());
  assert.strictEqual(pq.eotf, EOTF.PQ);
  assert.strictEqual(pq.label, 'HDR10');
  assert.strictEqual(pq.hdr, true);
  assert.strictEqual(pq.mastering.maxLuminance, 1000);
  assert.strictEqual(pq.mastering.minLuminance, 0.005);
  assert.strictEqual(pq.maxCll, 1000);
  assert.strictEqual(pq.maxFall, 400);
  const hlg = Buffer.alloc(32);
  hlg.set([0x87, 0x01, 0x1a, 0x00, 0x03]);
  assert.strictEqual(parseDrmInfoFrame(hlg).label, 'HLG');
});

test('encoder colour tags follow the transfer function', () => {
  assert.ok(colorArgs(EOTF.PQ).includes('smpte2084'));
  assert.ok(colorArgs(EOTF.HLG).includes('arib-std-b67'));
  assert.ok(colorArgs(EOTF.PQ).includes('bt2020nc'));
});

test('x265 gets master-display in G, B, R order', () => {
  const p = x265Params(EOTF.PQ, parseDrmInfoFrame(pqFrame()))[1];
  assert.match(p, /master-display=G\(8500,39850\)B\(6550,2300\)R\(35400,14600\)WP\(15635,16450\)L\(10000000,50\)/);
  assert.match(p, /max-cll=1000,400/);
});

test('device match uses the USB IDs from the symbolic link', () => {
  assert.strictEqual(videoMatch(0x0fd9, 0xaf), 'vid_0fd9&pid_00af');
});

test('HDR recordings are remuxed without re-encoding audio', () => {
  const tags = colorArgs(EOTF.PQ);
  const args = remuxArgs('in.mkv', 'out.mp4', 'mp4', 192, { hdr: tags });
  assert.ok(!args.includes('aac'));
  assert.ok(args.includes('hvc1'));
  assert.ok(args.includes('smpte2084'));
  assert.deepStrictEqual(remuxArgs('in.mkv', 'out.mkv', 'mkv', 192, { hdr: tags }), ['-i', 'in.mkv', '-c', 'copy', ...tags, 'out.mkv']);
  assert.ok(!remuxArgs('in.webm', 'out.mp4', 'mp4', 192).includes('smpte2084'));
});
