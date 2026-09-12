#!/usr/bin/env node
// lanes/factory/tournament.mjs — C3: takes → tournament (structure / latency / cost) → ONE winner, losers recorded →
// hana.frame finish request → verifiers. Weights are declared here, not tuned per run.
//   node lanes/factory/tournament.mjs [--out out] [--hana]
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as jsoup from './verifiers/jsoup.mjs';
import * as playwright from './verifiers/playwright.mjs';
import * as ocr from './verifiers/ocr.mjs';
import * as instatic from './verifiers/instatic.mjs';
import { prepareFinish } from './finish.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(HERE, '..', '..');
export const WEIGHTS = { structure: 0.6, latency: 0.2, cost: 0.2 };

export async function tournament({ out = join(HERE, 'out'), hana = false } = {}) {
  const record = JSON.parse(readFileSync(join(out, 'takes.json'), 'utf8'));
  const prediction = JSON.parse(readFileSync(join(out, 'predictions.json'), 'utf8'));
  if (record.status === 'REFUSED') return { status: 'REFUSED', reason: 'no takes to rank', gate: record.gate };
  const vdir = join(out, 'verify'); mkdirSync(vdir, { recursive: true });
  const entries = [];
  for (const t of record.takes) {
    const file = join(ROOT, t.file);
    const shot = prediction.target === 'site' ? join(vdir, `take-${t.take}.png`) : null;
    const v = {};
    if (prediction.target === 'site') {
      v.jsoup = jsoup.verify(file, prediction);
      v.playwright = await playwright.verify(file, prediction, { screenshot: shot });
      v.ocr = ocr.verify(shot, prediction);
    } else v.structure = { name: 'scene-structure', ran: true, ok: t.measured.elements === prediction.elements, checks: { elements: t.measured.elements === prediction.elements } };
    v.instatic_snapshot = instatic.verify(file, prediction, { dir: join(out, 'snapshot'), take: t.take, status: t.status });
    const ran = Object.values(v).filter((x) => x.ran);
    const structure = ran.length ? ran.filter((x) => x.ok).length / ran.length : 0;
    const latency = 1 / (1 + (t.latency_ms ?? 0) / 1000);
    const cost = 1 / (1 + (t.cost?.usd ?? 0));
    const score = WEIGHTS.structure * structure + WEIGHTS.latency * latency + WEIGHTS.cost * cost;
    entries.push({ take: t.take, status: t.status, sha256: t.sha256, latency_ms: t.latency_ms, cost: t.cost, verifiers: v, scores: { structure, latency, cost, total: Number(score.toFixed(6)) } });
  }
  const ranking = [...entries].sort((a, b) => b.scores.total - a.scores.total || a.take - b.take);
  const winner = ranking[0];
  const losers = ranking.slice(1).map((e) => ({ take: e.take, sha256: e.sha256, total: e.scores.total }));
  const finish = await prepareFinish({ out, take: record.takes.find((t) => t.take === winner.take), prediction, hana });
  const result = { schema: 'timmy.omma-tournament/1', weights: WEIGHTS, prediction_sha256: prediction.sha256, entries, winner: { take: winner.take, sha256: winner.sha256, status: winner.status, total: winner.scores.total }, losers, finish };
  writeFileSync(join(out, 'tournament.json'), JSON.stringify(result, null, 1) + '\n');
  return result;
}

if (process.argv[1]?.endsWith('tournament.mjs')) {
  const args = process.argv.slice(2);
  const flag = (k, d) => { const i = args.indexOf(k); return i >= 0 && args[i + 1] !== undefined && !args[i + 1].startsWith('--') ? args[i + 1] : d; };
  const r = await tournament({ out: resolve(flag('--out', join(HERE, 'out'))), hana: args.includes('--hana') });
  console.log(JSON.stringify(r.status === 'REFUSED' ? r : { winner: r.winner, losers: r.losers, finish: r.finish.status, verifiers: r.entries.map((e) => ({ take: e.take, ...Object.fromEntries(Object.entries(e.verifiers).map(([k, v]) => [k, v.ran ? (v.ok ? 'ok' : 'fail') : 'not-run'])) })) }, null, 1));
}
