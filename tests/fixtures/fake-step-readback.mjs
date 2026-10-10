#!/usr/bin/env node
// fake-step-readback.mjs: a FAKE readback worker, a TEST DOUBLE for /iterate's readback step (tests/iterate.test.ts).
// It is NOT workers/readback/step_readback.py: it imports no CAD library and measures nothing. It reads and hashes the
// file it is given (that part is real), and reports as "measured" values it did NOT measure: those of the
// prediction.json delivered beside the file (the recipe's FAKE executor writes SYNTHETIC exports, which hold no
// geometry). It prints one JSON line shaped like the real worker's.
//
// Usage: fake-step-readback.mjs <mode> <file> [--as <name>]
//   match       the prediction's own values
//   differ      the prediction's values with the width 0.5 mm larger
//   fail        {"ok": false, ...}, exit 2
//   garbage     prints text and no JSON, exit 0
//   sleep       waits 30 s (for /stop), then prints nothing
//   wrongbytes  the prediction's values, with the sha256 of other bytes
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

const argv = process.argv.slice(2);
const [mode, file] = argv;
const asAt = argv.indexOf('--as');
const name = asAt > 0 ? argv[asAt + 1] : basename(file ?? '');
const worker = { name: 'fake-step-readback', version: '0.0.0-fake (a FAKE readback, not a measurement)' };
const emit = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);

if (mode === 'sleep') {
  console.error('FAKE readback: sleeping (a test double)');
  setTimeout(() => process.exit(0), 30_000);
} else if (mode === 'garbage') {
  console.log('FAKE readback: this line is not JSON');
  process.exit(0);
} else if (mode === 'fail') {
  console.error('FAKE readback: a reported failure (a test double)');
  emit({ ok: false, worker, error: { code: 'not-step', message: 'FAKE: OpenCascade could not read the file as STEP' } });
  process.exit(2);
} else {
  const bytes = readFileSync(file);
  const sha256 = createHash('sha256').update(mode === 'wrongbytes' ? Buffer.concat([bytes, Buffer.from('other')]) : bytes).digest('hex');
  const pred = JSON.parse(readFileSync(join(dirname(file), 'prediction.json'), 'utf8'));
  const size = [...pred.bounds];
  if (mode === 'differ') size[0] += 0.5;
  console.error('FAKE readback: values copied from prediction.json, not measured (a test double)');
  emit({
    ok: true, worker, python: null, engine: { fake: true }, source: { name, sha256, bytes: bytes.length }, units: 'mm', unit_in_effect: 'MM',
    read: { roots: 1, shapes: 1, importer: 'FAKE' }, tier: 'FAKE: not measured', scope: 'FAKE',
    valid: true, solids: 1,
    bounds: { min: [-size[0] / 2, -size[1] / 2, 0], max: [size[0] / 2, size[1] / 2, size[2]], size, method: 'FAKE' },
    volume_mm3: pred.volumeMm3, volume_method: 'FAKE',
  });
  process.exit(0);
}
