#!/usr/bin/env node
// Seed cards-200, second half: auto-label the generated cards with the local
// observer (OCR + zero-shot boxes) and join the labels with the generator's
// provenance into dataset.synthetic-v0. Every row says where the pixels came
// from (generator, seed, params, svg+png sha) AND what the observer read, and
// whether they agree.
//   node lanes/sandbox/seeds/label-cards.mjs --cards <dir with provenance.jsonl> [--host http://localhost:9001] [--out lanes/sandbox/datasets/synthetic-v0.jsonl] [--limit N] [--no-seal]
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const has = (k) => args.includes(k);
const CARDS = resolve(flag('--cards', join(ROOT, 'out', 'cards')));
const OUT = resolve(flag('--out', join(ROOT, 'lanes', 'sandbox', 'datasets', 'synthetic-v0.jsonl')));
const LIMIT = Number(flag('--limit', 0));
// zero-shot boxes cost ~16 s per card on the CPU server; OCR carries the labels, so boxes run on the first N cards only
const BOXES_FIRST = Number(flag('--boxes-first', 20));
if (flag('--host')) process.argv.push('--host', flag('--host'));
const sha = (s) => createHash('sha256').update(s).digest('hex');

const observer = await import(pathToFileURL(join(ROOT, 'lanes', 'observer', 'subscriber.mjs')).href).catch(() => null);
if (!observer?.observeImage) { console.error('lanes/observer/subscriber.mjs must export observeImage'); process.exit(2); }

const rows = readFileSync(join(CARDS, 'provenance.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).slice(0, LIMIT || undefined);
const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const out = [];
const started = Date.now();
for (const r of rows) {
  const file = join(CARDS, r.file);
  if (!existsSync(file)) continue;
  const obs = await observer.observeImage(file, { source: { dataset: 'synthetic-v0', index: r.index } }, { boxes: out.length < BOXES_FIRST });
  const text = norm(obs.ocr.lines.join(' '));
  const agree = {
    name: text.includes(norm(r.labels.name)),
    serial: text.includes(norm(r.labels.serial)),
    set: text.includes(norm(r.labels.set)),
    role: text.includes(norm(r.labels.role)),
    rarity: text.includes(norm(r.labels.rarity)),
    number: text.includes(norm(r.labels.number).replace(' ', '')) || text.includes(norm(r.labels.number))
  };
  const score = Object.values(agree).filter(Boolean).length / Object.keys(agree).length;
  out.push({ v: 'synthetic-v0', index: r.index, file: r.file, png_sha256: r.png_sha256, svg_sha256: r.svg_sha256, provenance: { ...r.provenance, generator: r.generator, seed: r.seed, params: r.params }, labels: r.labels, auto: { ocr_lines: obs.ocr.lines, ocr_sha256: obs.ocr.text_sha256, boxes: obs.detection.boxes, detection_sha256: obs.detection.sha256, host: obs.host, observed_at: obs.observed_at }, agreement: { ...agree, score } });
  if (out.length % 20 === 0) console.error(`${out.length}/${rows.length} labelled · mean agreement ${(out.reduce((a, x) => a + x.agreement.score, 0) / out.length).toFixed(3)}`);
}
mkdirSync(dirname(OUT), { recursive: true });
const text = out.map((r) => JSON.stringify(r)).join('\n') + (out.length ? '\n' : '');
writeFileSync(OUT, text);
const digest = sha(text);
const mean = out.length ? out.reduce((a, x) => a + x.agreement.score, 0) / out.length : 0;
const fields = ['name', 'serial', 'set', 'role', 'rarity', 'number'];
const perField = Object.fromEntries(fields.map((f) => [f, out.length ? out.filter((x) => x.agreement[f]).length / out.length : 0]));
const summary = { dataset: 'synthetic-v0', out: OUT.replace(ROOT + '/', ''), rows: out.length, sha256: digest, mean_agreement: Number(mean.toFixed(4)), per_field: perField, boxes_total: out.reduce((a, x) => a + x.auto.boxes.length, 0), boxes_first: BOXES_FIRST, ms: Date.now() - started, cards_dir: CARDS };
if (!has('--no-seal')) {
  const a = ['tsx', 'src/cli.ts', 'seal', 'dataset.synthetic-v0', '--meta', `rows=${out.length}`, '--meta', `sha256=${digest}`, '--meta', `file=${summary.out}`, '--meta', `generator=${rows[0]?.generator ?? 'cards-200'}`, '--meta', `seed=${rows[0]?.seed ?? ''}`, '--meta', `mean_agreement=${summary.mean_agreement}`, '--meta', `per_field=${fields.map((f) => `${f}:${perField[f].toFixed(3)}`).join(',')}`, '--meta', `boxes_total=${summary.boxes_total}`, '--meta', `boxes_first=${BOXES_FIRST}`, '--meta', 'provenance=generator,seed,params,svg_sha256,png_sha256,renderer,ts per row', '--meta', `auto_labels=doctr ocr on every card + yolo_world boxes on the first ${BOXES_FIRST} via local Roboflow inference`, '--meta', `cards_dir=${CARDS.replace(process.env.HOME ?? '', '~')}`, '--meta', 'order=shelf-w6d3'];
  const r = spawnSync('npx', a, { cwd: ROOT, encoding: 'utf8' });
  process.stdout.write(r.stdout ?? ''); if (r.status !== 0) process.stderr.write(r.stderr ?? '');
}
console.log(JSON.stringify(summary, null, 1));
