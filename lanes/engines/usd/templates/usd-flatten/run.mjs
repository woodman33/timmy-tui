#!/usr/bin/env node
// USD · usd-flatten: node run.mjs <drop file> <out dir> <stem>
// Composes the dropped layer with Apple's usdcat --flatten into one self-contained
// <stem>.flat.usdc (variants selected, references/payloads/sublayers/inherits baked
// in), re-loads it, counts prims, and writes <stem>.flat.json.
import { spawnSync } from 'node:child_process';
import { existsSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

const USDCAT = '/usr/bin/usdcat';
const [drop, out, stem] = process.argv.slice(2);
const t0 = Date.now();
const lines = (s) => String(s ?? '').split('\n').map((l) => l.trimEnd()).filter(Boolean);
const run = (args) => {
  const r = spawnSync(USDCAT, args, { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024, timeout: 240000 });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error?.message ?? null };
};
const ARCS = { variantSets: /\bvariantSets\s*=/g, references: /\breferences\s*=/g, payload: /\bpayload\s*=/g, inherits: /\binherits\s*=/g, specializes: /\bspecializes\s*=/g, subLayers: /\bsubLayers\s*=/g };
const arcs = (text) => Object.fromEntries(Object.entries(ARCS).map(([k, re]) => [k, (text.match(re) ?? []).length]));
const prims = (text) => {
  const defs = [...text.matchAll(/^\s*def\s+(?:([A-Za-z_]\w*)\s+)?"[^"]+"/gm)];
  const types = {};
  for (const d of defs) { const t = d[1] ?? 'Prim'; types[t] = (types[t] ?? 0) + 1; }
  return { count: defs.length, types };
};

const outFile = join(out, `${stem}.flat.usdc`);
const version = run(['--version']).stdout.trim();
const source = run([drop]);
const flat = run(['--flatten', drop, '-o', outFile]);
const written = flat.status === 0 && existsSync(outFile) && statSync(outFile).size > 0;
const report = {
  kind: 'usd.flatten', input: basename(drop), input_bytes: statSync(drop).size, output: basename(outFile), bytes: written ? statSync(outFile).size : 0,
  usdcat: version, flatten: { exit: flat.status, stderr: lines(flat.stderr), error: flat.error },
  prims: null, prim_types: {}, default_prim: null, up_axis: null, source_arcs: source.status === 0 ? arcs(source.stdout) : null, flat_arcs: null, load_ok: false, errors: [],
};
if (!written) report.errors = [...lines(flat.stderr), ...(flat.error ? [flat.error] : []), `usdcat exit ${flat.status}`];
else {
  const load = run(['--loadOnly', outFile]);
  report.load_ok = load.status === 0 && /^OK\b/m.test(load.stdout);
  if (!report.load_ok) report.errors.push(...lines(load.stderr), ...lines(load.stdout));
  const text = run([outFile]);
  if (text.status === 0) {
    const p = prims(text.stdout);
    report.prims = p.count;
    report.prim_types = p.types;
    report.default_prim = text.stdout.match(/defaultPrim\s*=\s*"([^"]*)"/)?.[1] ?? null;
    report.up_axis = text.stdout.match(/upAxis\s*=\s*"([^"]*)"/)?.[1] ?? null;
    report.flat_arcs = arcs(text.stdout);
    const left = Object.entries(report.flat_arcs).filter(([, n]) => n > 0).map(([k]) => k);
    if (left.length) report.errors.push(`composition arcs survive in the flattened layer: ${left.join(', ')}`);
    if (p.count === 0) report.errors.push('the flattened stage defines no prims');
  } else report.errors.push(...lines(text.stderr));
}
report.ok = written && report.load_ok && report.errors.length === 0;
report.ms = Date.now() - t0;
writeFileSync(join(out, `${stem}.flat.json`), JSON.stringify(report, null, 1));
console.log(JSON.stringify({ ok: report.ok, output: report.output, bytes: report.bytes, prims: report.prims, source_arcs: report.source_arcs, errors: report.errors }));
process.exit(report.ok ? 0 : 1);
