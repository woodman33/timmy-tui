#!/usr/bin/env node
// lanes/factory/omma.mjs — omma.build(intent, inputs) → site | scene, the Timmy way (ORDER factory-f1d0 C2b).
//
//   node lanes/factory/omma.mjs predict --intent "…" --inputs data.json|csv|glb [--takes 3] [--out out]
//   node lanes/factory/omma.mjs build   --intent "…" --inputs data.csv [--takes 3] [--stub] [--out out] [--no-seal]
//
// Order of operations, never reordered: parse inputs → forecast → seal omma.prediction → privacy gate
// over the exact prompt → (refused: stop) → take 1..N through the transport → hash + status per take →
// seal omma.cost per real call → takes.json with forecast vs measured.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gatePrompt, promptText } from './gate.mjs';
import { measure, predict } from './predict.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(HERE, '..', '..');
const sha = (b) => 'sha256_' + createHash('sha256').update(b).digest('hex');

/** JSON, CSV or GLB → { kind, text (what the transport would see), sha256, bytes, data|rows|glb } */
export function parseInputs(file) {
  const buf = readFileSync(file);
  const ext = extname(file).toLowerCase();
  const base = { sha256: sha(buf), bytes: buf.length, file: basename(file) };
  if (ext === '.json') { const data = JSON.parse(buf.toString('utf8')); return { ...base, kind: 'json', data, text: JSON.stringify(data) }; }
  if (ext === '.csv') {
    const lines = buf.toString('utf8').split(/\r?\n/).filter((l) => l.trim());
    const head = (lines[0] ?? '').split(',').map((s) => s.trim());
    const rows = lines.slice(1).map((l) => { const c = l.split(','); return Object.fromEntries(head.map((h, i) => [h, (c[i] ?? '').trim()])); });
    return { ...base, kind: 'csv', head, rows, text: lines.join('\n') };
  }
  if (ext === '.glb') {
    if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'glTF') throw new Error(`${basename(file)}: not a GLB (missing glTF magic)`);
    const glb = { version: buf.readUInt32LE(4), length: buf.readUInt32LE(8) };
    // the transport sees the file name and size, never the bytes inline; the bytes travel as an attachment
    return { ...base, kind: 'glb', glb, text: `glb ${basename(file)} v${glb.version} ${buf.length} bytes ${base.sha256}` };
  }
  throw new Error(`${basename(file)}: inputs must be .json, .csv or .glb`);
}

export function sealSubject(subject, { note, sources = [], json = {}, status = 'ok' }) {
  const a = ['tsx', 'lanes/factory/seal.mts', subject, '--note', note, '--status', status, '--sources', sources.join(','), '--json', JSON.stringify(json)];
  const r = spawnSync('npx', a, { cwd: ROOT, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`seal ${subject} failed: ${(r.stderr || '').trim().slice(0, 300)}`);
  return JSON.parse(r.stdout.trim().split('\n').pop());
}

export async function build({ intent, inputsPath, takes = 3, stub = false, out = join(HERE, 'out'), seal = true, transport: injected } = {}) {
  if (!intent) throw new Error('intent is required');
  mkdirSync(join(out, 'takes'), { recursive: true });
  const inputs = inputsPath ? parseInputs(inputsPath) : null;
  // 1. forecast first — sealed before any send
  const prediction = predict(intent, inputs, { takes });
  writeFileSync(join(out, 'predictions.json'), JSON.stringify(prediction, null, 1) + '\n');
  const predSeal = seal ? sealSubject('omma.prediction', { note: `omma.build forecast: ${prediction.target}, ${prediction.pages} page(s), ${prediction.elements} element(s), ${prediction.named_text.length} named text, ${takes} take(s)`, sources: [relative(ROOT, join(out, 'predictions.json'))], json: { target: prediction.target, pages: prediction.pages, elements: prediction.elements, take_count: takes, inputs_kind: inputs?.kind ?? null, inputs_sha256: inputs?.sha256 ?? null, prediction_sha256: prediction.sha256 } }) : null;
  // 2. the gate — over the exact bytes a transport would receive
  const prompt = promptText(intent, inputs);
  const gate = gatePrompt(prompt);
  const record = { schema: 'timmy.omma-build/1', intent_sha256: prediction.intent_sha256, prompt_sha256: sha(prompt), inputs: inputs ? { kind: inputs.kind, file: inputs.file, sha256: inputs.sha256, bytes: inputs.bytes } : null, prediction_sha256: prediction.sha256, prediction_seal: predSeal?.hash ?? null, gate, transport: null, takes: [] };
  if (!gate.ok) {
    record.status = 'REFUSED';
    writeFileSync(join(out, 'takes.json'), JSON.stringify(record, null, 1) + '\n');
    return record;
  }
  // 3. the transport is constructed only after the gate passed
  const transport = injected ?? (stub ? await import('./transports/stub.mjs') : await import('./transports/documented.mjs'));
  record.transport = transport.name;
  for (let take = 1; take <= takes; take++) {
    const t0 = Date.now();
    let res;
    try { res = await transport.send({ intent, inputs, prediction, take }, { root: ROOT }); } catch (e) {
      record.takes.push({ take, status: 'REFUSED', reason: e.code ?? e.message, latency_ms: Date.now() - t0 });
      record.status = 'REFUSED';
      writeFileSync(join(out, 'takes.json'), JSON.stringify(record, null, 1) + '\n');
      return record;
    }
    const latency_ms = Date.now() - t0;
    const ext = res.contentType === 'text/html' ? 'html' : 'json';
    const file = join(out, 'takes', `take-${take}.${ext}`);
    writeFileSync(file, res.output);
    const t = { take, status: transport.status, file: relative(ROOT, file), sha256: sha(res.output), bytes: Buffer.byteLength(res.output), latency_ms, cost: res.cost, measured: measure(res.output, prediction.target) };
    t.matches_forecast = t.measured.pages === prediction.pages && t.measured.elements === prediction.elements;
    // 4. the cost of every REAL call is sealed; a stub costs nothing and is not a receipt
    if (transport.status === 'GENERATED' && seal) t.cost_seal = sealSubject('omma.cost', { note: `omma.build take ${take}/${takes}`, sources: [t.file], json: { cost_usd: res.cost?.usd ?? 0, credits: res.cost?.credits ?? null, model: res.cost?.model ?? null, latency_ms, take_sha256: t.sha256, prediction_sha256: prediction.sha256 } }).hash;
    record.takes.push(t);
  }
  record.status = record.takes.every((t) => t.status === 'GENERATED') ? 'GENERATED' : 'STUB';
  writeFileSync(join(out, 'takes.json'), JSON.stringify(record, null, 1) + '\n');
  return record;
}

if (process.argv[1] && basename(process.argv[1]) === 'omma.mjs') {
  const args = process.argv.slice(2);
  const cmd = args[0];
  const flag = (k, d) => { const i = args.indexOf(k); return i >= 0 && args[i + 1] !== undefined && !args[i + 1].startsWith('--') ? args[i + 1] : d; };
  const opts = { intent: flag('--intent'), inputsPath: flag('--inputs'), takes: Number(flag('--takes', 3)), stub: args.includes('--stub'), out: resolve(flag('--out', join(HERE, 'out'))), seal: !args.includes('--no-seal') };
  if (cmd === 'predict') {
    const inputs = opts.inputsPath ? parseInputs(opts.inputsPath) : null;
    console.log(JSON.stringify(predict(opts.intent, inputs, { takes: opts.takes }), null, 1));
  } else if (cmd === 'build') {
    const r = await build(opts);
    console.log(JSON.stringify({ status: r.status, prediction_seal: r.prediction_seal, gate: r.gate.ok ? 'passed' : r.gate.reason, transport: r.transport, takes: r.takes.map((t) => ({ take: t.take, status: t.status, sha256: t.sha256?.slice(0, 19), latency_ms: t.latency_ms, matches_forecast: t.matches_forecast, reason: t.reason })) }, null, 1));
    process.exit(r.status === 'REFUSED' ? 3 : 0);
  } else { console.error('usage: omma.mjs predict|build --intent "…" [--inputs f] [--takes n] [--stub] [--out dir] [--no-seal]'); process.exit(2); }
}
