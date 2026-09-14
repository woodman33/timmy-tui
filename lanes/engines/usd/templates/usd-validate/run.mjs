#!/usr/bin/env node
// USD · usd-validate: node run.mjs <drop file> <out dir> <stem>
// Parse-checks a dropped layer with Apple's usdcat (--loadOnly), then reads layer
// metadata and the composed prim list, and writes <stem>.validate.json. A layer
// that fails to load is a failed step (exit 1) — the report is still written.
import { spawnSync } from 'node:child_process';
import { statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

const USDCAT = '/usr/bin/usdcat';
const [drop, out, stem] = process.argv.slice(2);
const t0 = Date.now();
const lines = (s) => String(s ?? '').split('\n').map((l) => l.trimEnd()).filter(Boolean);
const run = (args) => {
  const r = spawnSync(USDCAT, args, { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024, timeout: 240000 });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error?.message ?? null };
};

const version = run(['--version']).stdout.trim();
const load = run(['--loadOnly', drop]);
const ok = load.status === 0 && /^OK\b/m.test(load.stdout);
const report = {
  kind: 'usd.validate', input: basename(drop), input_bytes: statSync(drop).size, ok, usdcat: version,
  load: { exit: load.status, stdout: lines(load.stdout), stderr: lines(load.stderr), error: load.error },
  prims: null, prim_types: {}, default_prim: null, up_axis: null, meters_per_unit: null, warnings: [], errors: [],
};
if (!ok) report.errors = [...lines(load.stderr), ...lines(load.stdout), ...(load.error ? [load.error] : [])];
else {
  const meta = run(['--layerMetadata', drop]);
  const head = meta.status === 0 ? meta.stdout : '';
  report.default_prim = head.match(/defaultPrim\s*=\s*"([^"]*)"/)?.[1] ?? null;
  report.up_axis = head.match(/upAxis\s*=\s*"([^"]*)"/)?.[1] ?? null;
  const mpu = head.match(/metersPerUnit\s*=\s*([0-9.eE+-]+)/);
  report.meters_per_unit = mpu ? Number(mpu[1]) : null;
  const flat = run(['--flatten', drop]);
  if (flat.status !== 0) { report.ok = false; report.errors = [...lines(flat.stderr), ...(flat.error ? [flat.error] : [])]; }
  else {
    const defs = [...flat.stdout.matchAll(/^\s*def\s+(?:([A-Za-z_]\w*)\s+)?"[^"]+"/gm)];
    report.prims = defs.length;
    for (const d of defs) { const t = d[1] ?? 'Prim'; report.prim_types[t] = (report.prim_types[t] ?? 0) + 1; }
    report.warnings = [...lines(load.stderr), ...lines(flat.stderr)];
    if (report.prims === 0) report.warnings.push('the composed stage defines no prims');
  }
}
report.ms = Date.now() - t0;
writeFileSync(join(out, `${stem}.validate.json`), JSON.stringify(report, null, 1));
console.log(JSON.stringify({ ok: report.ok, prims: report.prims, prim_types: report.prim_types, errors: report.errors }));
process.exit(report.ok ? 0 : 1);
