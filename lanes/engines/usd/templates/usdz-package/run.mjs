#!/usr/bin/env node
// USD · usdz-package: node run.mjs <drop file> <out dir> <stem>
// Packages a dropped layer (and whatever it resolves) into <stem>.usdz with Apple's
// usdzip --asset, lists and dumps the package, re-loads it with usdcat, and writes
// <stem>.usdz.json. usdzip's --checkCompliance is skipped: it crashes (SIGBUS) in
// Apple USD Tools 0.25.2 on this Mac, so the 64-byte alignment is checked here instead.
import { spawnSync } from 'node:child_process';
import { existsSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

const USDZIP = '/usr/bin/usdzip';
const USDCAT = '/usr/bin/usdcat';
const [drop, out, stem] = process.argv.slice(2);
const t0 = Date.now();
const lines = (s) => String(s ?? '').split('\n').map((l) => l.trimEnd()).filter(Boolean);
const run = (bin, args) => {
  const r = spawnSync(bin, args, { cwd: dirname(drop), encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, timeout: 240000 });
  return { status: r.status, signal: r.signal ?? null, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error?.message ?? null };
};

const usdz = join(out, `${stem}.usdz`);
const version = run(USDZIP, ['--version']).stdout.trim();
const pack = run(USDZIP, ['-v', '-a', drop, usdz]);
const packed = pack.status === 0 && existsSync(usdz) && statSync(usdz).size > 0;
const report = {
  kind: 'usdz.package', input: basename(drop), input_bytes: statSync(drop).size, usdz: basename(usdz), bytes: packed ? statSync(usdz).size : 0,
  usdzip: version, pack: { exit: pack.status, signal: pack.signal, stdout: lines(pack.stdout), stderr: lines(pack.stderr), error: pack.error },
  entries: [], entry_count: 0, root_layer: null, aligned_64: null, load_ok: false, compliance: 'skipped: usdzip --checkCompliance crashes (SIGBUS) in Apple USD Tools 0.25.2', errors: [],
};
if (!packed) report.errors = [...lines(pack.stderr), ...(pack.error ? [pack.error] : []), `usdzip exit ${pack.status} signal ${pack.signal}`];
else {
  report.entries = lines(run(USDZIP, ['-l', '-', usdz]).stdout);
  report.entry_count = report.entries.length;
  report.root_layer = report.entries[0] ?? null;
  const dump = run(USDZIP, ['-d', '-', usdz]).stdout;
  const rows = [...dump.matchAll(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S.*)$/gm)].map((m) => ({ offset: Number(m[1]), compressed: Number(m[2]), bytes: Number(m[3]), name: m[4].trim() }));
  report.files = rows;
  report.aligned_64 = rows.length > 0 && rows.every((r) => r.offset % 64 === 0);
  report.stored_uncompressed = rows.every((r) => r.compressed === r.bytes);
  const load = run(USDCAT, ['--loadOnly', usdz]);
  report.load_ok = load.status === 0 && /^OK\b/m.test(load.stdout);
  if (!report.load_ok) report.errors.push(...lines(load.stderr), ...lines(load.stdout));
  if (!report.entry_count) report.errors.push('the package lists no entries');
  if (!report.aligned_64) report.errors.push('an entry is not 64-byte aligned');
}
report.ok = packed && report.load_ok && report.entry_count > 0 && report.aligned_64 === true;
report.ms = Date.now() - t0;
writeFileSync(join(out, `${stem}.usdz.json`), JSON.stringify(report, null, 1));
console.log(JSON.stringify({ ok: report.ok, usdz: report.usdz, bytes: report.bytes, entries: report.entries, errors: report.errors }));
process.exit(report.ok ? 0 : 1);
