#!/usr/bin/env node
// fake-freecad-readback.mjs: a FAKE readback worker, a TEST DOUBLE for /freecad readback (tests/native-freecad.test.ts).
// It is NOT workers/readback/step_readback.py: it imports no CAD library and measures nothing. It reads and hashes the
// file it is given (that part is real) and reports as "measured" the numbers the stand-in Part module wrote into the
// FAKE STEP file's TIMMY-STUB-MEASURE comment: the stand-in's own measurement, not a reading of any geometry. It prints
// one JSON line shaped like the real worker's.
//
// Usage: fake-freecad-readback.mjs <mode> <file> [--as <name>]
//   match       the stand-in's numbers
//   differ      the stand-in's numbers with the volume 1 mm3 larger and the x maximum 0.5 mm larger
//   invalid     the stand-in's numbers, the shape not valid
//   fail        {"ok": false, ...}, exit 2
//   garbage     prints text and no JSON, exit 0
//   wrongbytes  the stand-in's numbers, with the sha256 of other bytes
//   sleep       waits 30 s (for /stop), then prints nothing
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

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
  const found = /TIMMY-STUB-MEASURE (\{.*\}) \*\//.exec(bytes.toString('utf8'));
  if (!found) {
    emit({ ok: false, worker, error: { code: 'no-shape', message: 'FAKE: the file holds no stand-in measurement' } });
    process.exit(2);
  }
  const m = JSON.parse(found[1]);
  const min = [...m.bounds.min];
  const max = [...m.bounds.max];
  let volume = m.volume_mm3;
  if (mode === 'differ') { volume += 1; max[0] += 0.5; }
  console.error('FAKE readback: numbers copied from the stand-in\'s comment, not measured (a test double)');
  emit({
    ok: true, worker, python: null, engine: { fake: true }, source: { name, sha256, bytes: bytes.length }, units: 'mm', unit_in_effect: 'MM',
    read: { roots: 1, shapes: 1, importer: 'FAKE' }, tier: 'FAKE: not measured', scope: 'FAKE',
    valid: mode === 'invalid' ? false : m.valid, solids: m.solids,
    bounds: { min, max, size: max.map((v, i) => v - min[i]), method: 'FAKE' },
    volume_mm3: volume, volume_method: 'FAKE',
  });
  process.exit(0);
}
