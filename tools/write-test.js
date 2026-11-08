'use strict';
// Hardware write test for an Elgato capture card: for each setting, records the current value,
// writes a different one, reads it back, then restores the original and reads again.
// Usage: node tools/write-test.js [--edid | --edid-only]
//   --edid       also backs up the EDID to captures/ and rewrites the identical bytes (EEPROM write path)
//   --edid-only  only the EDID test
// Close Elgato Studio first: it polls the same HID channel.

const fs = require('fs');
const path = require('path');
const platform = require('../src/main/platform');
const { CaptureController } = require('../src/main/devices/capture');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const devices = await platform.scan();
  const device = devices.find((d) => d.kind === 'capture' && d.controlHid);
  if (!device) throw new Error('no Elgato capture card with a control channel found');
  console.log(`Device: ${device.name} (${device.id}) on ${platform.name}`);
  const cap = new CaptureController(device);
  const props = await cap.refresh();
  console.log(`Firmware: ${await cap.firmwareVersion()}`);

  const results = [];
  for (const p of process.argv.includes('--edid-only') ? [] : props) {
    const original = await cap.get(p.propertyId);
    let target;
    if (p.dataType === 'bool') target = !original;
    else if (p.dataType === 'enum') target = p.valueInfo.values.map((v) => v.value).find((v) => v !== original);
    else {
      const { min, max } = p.valueInfo;
      target = original + 10 <= max ? original + 10 : Math.max(min, original - 10);
    }
    let after;
    let restored;
    let error = null;
    try {
      await cap.set(p.propertyId, target);
      await wait(300);
      after = await cap.get(p.propertyId);
      await cap.set(p.propertyId, original);
      await wait(300);
      restored = await cap.get(p.propertyId);
    } catch (e) {
      error = e.message;
    }
    const ok = !error && after === target && restored === original;
    results.push({ property: p.propertyId, original, target, after, restored, ok, error });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${p.propertyId.padEnd(15)} ${String(original).padStart(5)} -> ${String(target).padStart(5)} read ${String(after).padStart(5)}, restored ${String(restored).padStart(5)}${error ? `  (${error})` : ''}`);
  }

  if (process.argv.includes('--edid') || process.argv.includes('--edid-only')) {
    const before = await cap.readEdid();
    const backup = path.join(__dirname, '..', 'captures', `edid-backup-${Date.now()}.bin`);
    fs.mkdirSync(path.dirname(backup), { recursive: true });
    fs.writeFileSync(backup, before);
    console.log(`EDID backed up to ${backup}`);
    await cap.writeEdid(before);
    const after = await cap.readEdid();
    const ok = after.equals(before);
    results.push({ property: 'edid-rewrite', ok });
    console.log(`${ok ? 'PASS' : 'FAIL'}  EDID rewrite of identical 256 bytes, verified per chunk and re-read`);
  }

  // Let the deferred save-settings commit go out before exiting.
  await wait(1500);
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exitCode = failed.length ? 1 : 0;
}

main().catch((e) => {
  console.error(e.message);
  process.exitCode = 2;
});
