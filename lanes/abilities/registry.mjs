#!/usr/bin/env node
// timmy abilities — the capability registry, APPEND-ONLY (ORDER captain-y9g4 doctrine).
//
//   timmy abilities history [harness]     the full timeline per harness (every measured row kept forever)
//   timmy abilities latest  [harness]      the most recent row per harness (what most views default to)
//   timmy abilities fleet                  the LIBRARY › FLEET table: one line per harness × version, oldest→newest
//   timmy abilities seal <harness> --results <file> --meta k=v …   seal harness.abilities citing its PREDECESSOR
//
// Doctrine (Will, 2026-09-09): a measured row is never overwritten, only
// appended. A registry that records what a tool COULDN'T do last month is worth
// more than one that only shows today — it is how we tell, months out, whether
// a harness is improving or drifting, and the receipts already carry the dates.
// So: results files are versioned (jcode.json, jcode.v2.json, …), never edited
// in place; every harness.abilities seal cites the previous receipt for the same
// harness (prev_abilities); and the FLEET view reads the whole history, not just
// the latest. This module is the reader and the predecessor-citing sealer.
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf(k); return i >= 0 && args[i + 1] !== undefined && !args[i + 1].startsWith('--') ? args[i + 1] : d; };
const valueFlags = new Set(['--harness', '--meta', '--results']);
const positional = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && valueFlags.has(args[i - 1])));
const cmd = positional[0] ?? 'fleet';
const has = (k) => args.includes(k);
const out = (o) => console.log(JSON.stringify(o, null, has('--compact') ? 0 : 1));

function store() {
  const pin = join(ROOT, '.timmy', 'store-pin');
  return existsSync(pin) ? readFileSync(pin, 'utf8').trim() : join(ROOT, '.timmy', 'receipts');
}

/** Every harness.abilities receipt, oldest → newest, as {ts, harness, version, hash, prev, results, dims}. */
export function abilitiesHistory() {
  const file = join(store(), 'runs.jsonl');
  if (!existsSync(file)) return [];
  const rows = readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  return rows.filter((r) => r.subject === 'harness.abilities').map((r) => {
    const s = r.sources?.[0] ?? {};
    return { ts: r.ts, harness: s.harness ?? '?', version: s.version ?? s.jcode_version ?? 'v1', abilities_version: s.abilities_version ?? (s.version && String(s.version).startsWith('v') ? s.version : 'v1'), hash: r.hash, prev: s.prev_abilities ?? null, results: s.results ?? null, tool_schema: s.tool_schema ?? null };
  });
}

/** The predecessor receipt hash for a harness (the newest existing harness.abilities for it), or null. */
export function predecessor(harness) {
  const h = abilitiesHistory().filter((r) => r.harness === harness);
  return h.length ? h[h.length - 1].hash : null;
}

function fleetTable() {
  const h = abilitiesHistory();
  const byHarness = {};
  for (const r of h) (byHarness[r.harness] ??= []).push(r);
  const lines = [];
  for (const [harness, rows] of Object.entries(byHarness)) {
    for (const r of rows) lines.push({ harness, when: r.ts.slice(0, 10), version: r.version, row: r.abilities_version, receipt: r.hash.slice(0, 16), prev: r.prev ? String(r.prev).slice(0, 16) : null });
  }
  return lines;
}

if (cmd === 'history' || cmd === 'latest' || cmd === 'fleet') {
  const harness = flag('--harness') ?? positional[1];
  let h = abilitiesHistory();
  if (harness) h = h.filter((r) => r.harness === harness);
  if (cmd === 'latest') {
    const by = {}; for (const r of h) by[r.harness] = r; // newest wins (list is oldest→newest)
    out({ ok: true, latest: Object.values(by) });
  } else if (cmd === 'fleet') {
    out({ ok: true, note: 'append-only: every measured row kept; a harness that regressed shows both rows', fleet: harness ? fleetTable().filter((l) => l.harness === harness) : fleetTable() });
  } else {
    out({ ok: true, harness: harness ?? 'all', count: h.length, history: h });
  }
} else if (cmd === 'seal') {
  // seal harness.abilities citing the predecessor for the same harness
  const harness = flag('--harness') ?? positional[1];
  if (!harness) { console.error('usage: timmy abilities seal <harness> --results <file> [--meta k=v]…'); process.exit(2); }
  const prev = predecessor(harness);
  const seal = ['tsx', 'src/cli.ts', 'seal', 'harness.abilities', '--meta', `harness=${harness}`];
  if (prev) seal.push('--meta', `prev_abilities=${prev}`);
  // pass through --meta pairs from argv
  for (let i = 0; i < args.length; i++) if (args[i] === '--meta' && args[i + 1]) seal.push('--meta', args[++i]);
  const results = flag('--results');
  if (results) {
    try {
      const result = JSON.parse(readFileSync(resolve(ROOT, results), 'utf8'));
      if (result.abilities_version) seal.push('--meta', `abilities_version=${result.abilities_version}`);
    } catch { /* results metadata is best-effort; sealing still records the path */ }
    seal.push('--meta', `results=${results}`);
  }
  const r = spawnSync('npx', seal, { cwd: ROOT, stdio: 'inherit' });
  process.exit(r.status ?? 1);
} else { console.error('usage: timmy abilities <history|latest|fleet|seal> [harness] …'); process.exit(2); }
