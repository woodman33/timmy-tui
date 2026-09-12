#!/usr/bin/env node
// Seal harness.abilities per harness from lanes/abilities/results/<harness>.json,
// citing the probe transcript (path + sha256 + evidence line ids). Sequential seals.
//   node lanes/abilities/seal.mjs [--harness x] [--dry]
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const DIR = join(ROOT, 'lanes', 'abilities');
const args = process.argv.slice(2);
const only = (() => { const i = args.indexOf('--harness'); return i >= 0 ? args[i + 1] : null; })();
const DRY = args.includes('--dry');
const ABILITIES = ['mcp_client', 'tool_use', 'file_edits', 'browser', 'sandbox', 'one_shot'];
const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');

function seal(subject, meta) {
  const a = ['tsx', 'src/cli.ts', 'seal', subject];
  for (const [k, v] of Object.entries(meta)) if (v != null && v !== '') a.push('--meta', `${k}=${String(v).replace(/\n/g, ' ').slice(0, 900)}`);
  if (DRY) { console.log(a.slice(3).join(' ')); return null; }
  const r = spawnSync('npx', a, { cwd: ROOT, encoding: 'utf8' });
  if (r.status !== 0) { process.stderr.write(r.stderr ?? ''); throw new Error(`seal ${subject} failed`); }
  return ((r.stdout ?? '').match(/sha256_[0-9a-f]+/) ?? [null])[0];
}

const files = readdirSync(join(DIR, 'results')).filter((f) => f.endsWith('.json')).sort();
const out = [];
for (const f of files) {
  const harness = f.replace(/\.json$/, '');
  if (only && harness !== only) continue;
  const r = JSON.parse(readFileSync(join(DIR, 'results', f), 'utf8'));
  const abilities = r.abilities ?? r;
  const transcript = join(DIR, 'transcripts', `${harness}.jsonl`);
  const tExists = existsSync(transcript);
  const tLines = tExists ? readFileSync(transcript, 'utf8').trim().split('\n').filter(Boolean).length : 0;
  const bin = r.path && typeof r.path === 'object' ? r.path : { path: r.path ?? r.binary, sha256: r.sha256, sha256_note: r.sha256_note };
  const meta = {
    harness,
    version: r.version ?? 'unknown',
    path: bin.path ?? 'unknown',
    binary_kind: bin.kind ?? null,
    binary_symlink: bin.symlink ?? null,
    binary_sha256: bin.sha256 ?? 'n/a',
    binary_note: bin.sha256_note ?? null,
    model_route: typeof r.model_route === 'string' ? r.model_route : r.model_route ? JSON.stringify(r.model_route).slice(0, 300) : null,
    isolation: typeof r.isolation === 'string' ? r.isolation : r.isolation ? JSON.stringify(r.isolation).slice(0, 300) : null,
    docker: 'daemon not running during the probes (OrbStack socket refused); sandbox=false means tools ran on the host',
    method: 'measured by running the harness (lanes/abilities/probe.mjs); no docs read for values',
    transcript: tExists ? `lanes/abilities/transcripts/${harness}.jsonl` : 'missing',
    transcript_sha256: tExists ? sha(transcript) : 'n/a',
    transcript_lines: tLines,
    results: `lanes/abilities/results/${harness}.json`,
    results_sha256: sha(join(DIR, 'results', f)),
    order: 'mindship-v5c2'
  };
  const summary = [];
  for (const k of ABILITIES) {
    const a = abilities[k];
    if (a == null) { meta[k] = 'unmeasured'; summary.push(`${k}=unmeasured`); continue; }
    const v = typeof a === 'object' ? a.value : a;
    const val = v === true ? 'true' : v === false ? 'false' : 'null';
    meta[k] = val;
    if (typeof a === 'object') {
      if (a.evidence) meta[`${k}_evidence`] = Array.isArray(a.evidence) ? a.evidence.join(',') : String(a.evidence);
      if (a.note) meta[`${k}_note`] = String(a.note);
      if (a.method) meta[`${k}_method`] = String(a.method);
    }
    summary.push(`${k}=${val}`);
  }
  meta.summary = summary.join(' ');
  const hash = seal('harness.abilities', meta);
  out.push({ harness, receipt: hash, summary: meta.summary, version: meta.version });
  console.error(`${harness.padEnd(10)} ${meta.summary}  → ${hash ?? '(dry)'}`);
}
console.log(JSON.stringify(out, null, 1));
