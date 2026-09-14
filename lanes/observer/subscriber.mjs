#!/usr/bin/env node
// Observer bus subscriber (shelf-w6d3 step 2): local Roboflow Inference in Docker
// reads every image or video artifact that a receipt names, and seals
// observer.evidence for it. The subscriber tails the root store (receipts and
// bus envelopes share runs.jsonl), keeps a cursor, and never observes the same
// artifact twice.
//
//   timmy observer subscribe [--host http://localhost:9001] [--once] [--every 15] [--limit N] [--no-seal]
//   timmy observer backfill --dir renders/observer/trailer-v17 --source "trailer v17 (renders/trailer-ch1-v17.mp4)" [--host …] [--no-seal]
//   timmy observer frames <video> --out <dir> [--fps 1]          extract frames with ffmpeg (1 fps default)
//   timmy observer coverage [--no-seal]                          how much of what receipts name has been observed
//   timmy observer doctor [--host …]                             is the inference server up, which models answer
//
// Detection = yolo_world zero-shot boxes (prompts tuned for Timmy's surfaces) +
// doctr OCR; every result is hashed into the receipt (ocr_sha256, detection_sha256),
// the raw JSON sits beside the image as <image>.observer.json.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const has = (k) => args.includes(k);
const positional = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--') && !['--no-seal', '--once'].includes(args[i - 1])));
const cmd = positional[0] ?? 'doctor';
const HOST = (flag('--host', process.env.ROBOFLOW_LOCAL_HOST ?? 'http://localhost:9001')).replace(/\/$/, '');
const LOCAL = /localhost|127\.0\.0\.1/.test(HOST);
const sha = (b) => createHash('sha256').update(b).digest('hex');
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const VIDEO_EXT = new Set(['.mp4', '.webm', '.mov']);
const PROMPTS = ['card', 'badge', 'banner', 'button', 'qr code', 'text block', 'box', 'seal sticker', 'phone', 'person', 'logo', 'chart'];
const STATE_DIR = join(ROOT, '.timmy', 'cache');
const STATE = join(STATE_DIR, 'observer-subscriber.json');

function loadKey() {
  if (process.env.ROBOFLOW_API_KEY) return process.env.ROBOFLOW_API_KEY;
  const p = join(ROOT, '.env');
  if (existsSync(p)) for (const l of readFileSync(p, 'utf8').split('\n')) if (l.startsWith('ROBOFLOW_API_KEY=')) return l.slice(17).trim().replace(/^["']|["']$/g, '');
  return '';
}
const KEY = loadKey();

function storePath() {
  const pin = join(ROOT, '.timmy', 'store-pin');
  return join(existsSync(pin) ? readFileSync(pin, 'utf8').trim() : join(ROOT, '.timmy', 'receipts'), 'runs.jsonl');
}

function seal(subject, meta) {
  const a = ['tsx', 'src/cli.ts', 'seal', subject];
  for (const [k, v] of Object.entries(meta)) if (v != null && v !== '') a.push('--meta', `${k}=${String(v).replace(/\n/g, ' ').slice(0, 1500)}`);
  const r = spawnSync('npx', a, { cwd: ROOT, encoding: 'utf8' });
  if (r.status !== 0) { process.stderr.write(r.stderr ?? ''); throw new Error(`seal ${subject} failed`); }
  const lines = readFileSync(storePath(), 'utf8').trim().split('\n');
  return JSON.parse(lines[lines.length - 1]).hash;
}

// ------------------------------------------------------------------ inference

async function call(path, body, ms = 180000) {
  const url = `${HOST}${path}${KEY ? `?api_key=${encodeURIComponent(KEY)}` : ''}`;
  const started = Date.now();
  let lastErr = null;
  // the CPU server drops a connection now and then under load; a dropped call is retried, never silently skipped
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...body, api_key: KEY || undefined }), signal: AbortSignal.timeout(ms) });
      const text = await r.text();
      let json; try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 400) }; }
      return { ok: r.ok, status: r.status, json, ms: Date.now() - started, attempts: attempt };
    } catch (e) {
      lastErr = e;
      await new Promise((res) => setTimeout(res, 3000 * attempt));
    }
  }
  return { ok: false, status: 0, json: { error: String(lastErr?.cause?.message ?? lastErr?.message ?? lastErr) }, ms: Date.now() - started, attempts: 3, error: String(lastErr?.message ?? lastErr) };
}

export async function observeImage(file, extra = {}, opts = {}) {
  const bytes = readFileSync(file);
  const b64 = bytes.toString('base64');
  const imageSha = sha(bytes);
  const ocr = await call('/doctr/ocr', { image: { type: 'base64', value: b64 } });
  const det = opts.boxes === false ? { ok: false, status: 0, json: { predictions: [] }, ms: 0, skipped: 'boxes disabled for this image' } : await call('/yolo_world/infer', { image: { type: 'base64', value: b64 }, text: PROMPTS, confidence: 0.03 });
  const ocrText = ocr.ok ? String(ocr.json.result ?? ocr.json.text ?? '') : '';
  const ocrLines = ocrText.split('\n').map((s) => s.trim()).filter(Boolean);
  const preds = det.ok ? (det.json.predictions ?? []) : [];
  const boxes = preds.map((p) => ({ label: p.class ?? p.label, conf: Number((p.confidence ?? 0).toFixed(3)), x: Math.round(p.x), y: Math.round(p.y), w: Math.round(p.width), h: Math.round(p.height) }));
  const detection = { model: 'yolo_world', prompts: PROMPTS, boxes };
  const record = { v: 1, image: file, image_sha256: imageSha, host: HOST, local: LOCAL, ocr: { ok: ocr.ok, status: ocr.status, ms: ocr.ms, lines: ocrLines, text_sha256: sha(ocrText) }, detection: { ok: det.ok, status: det.status, ms: det.ms, ...detection, sha256: sha(JSON.stringify(detection)) }, observed_at: new Date().toISOString(), ...extra };
  try { writeFileSync(`${file}.observer.json`, JSON.stringify(record, null, 1)); } catch { /* read-only dir */ }
  return record;
}

export function sealEvidence(record, source = {}) {
  return seal('observer.evidence', {
    image: record.image.replace(ROOT + '/', '').replace(process.env.HOME ?? '', '~'), image_sha256: record.image_sha256, host: LOCAL ? 'local-docker' : HOST, ocr_ok: record.ocr.ok ? 'true' : 'false', ocr_sha256: record.ocr.text_sha256, ocr_lines: record.ocr.lines.length, ocr_preview: record.ocr.lines.slice(0, 4).join(' | ').slice(0, 200),
    detect_ok: record.detection.ok ? 'true' : 'false', detection_sha256: record.detection.sha256, boxes: record.detection.boxes.length, box_labels: [...new Set(record.detection.boxes.map((b) => b.label))].join(','), ms: (record.ocr.ms ?? 0) + (record.detection.ms ?? 0),
    ...Object.fromEntries(Object.entries(source).map(([k, v]) => [k, String(v)])), order: 'shelf-w6d3'
  });
}

// ------------------------------------------------------------------ artifacts named by receipts

const ARTIFACT_RE = /(?:^|[\s"',:=])((?:~|\/|\.{0,2}\/)?[\w@./+-]*\.(?:png|jpe?g|webp|mp4|webm|mov))(?=$|[\s"',:)])/gi;

/** Every image/video path a receipt or bus envelope mentions, resolved to disk. */
export function artifactsOf(rec) {
  const found = new Set();
  const scan = (v, ctx) => {
    if (typeof v === 'string') {
      for (const m of v.matchAll(ARTIFACT_RE)) {
        let p = m[1].replace(/^~/, process.env.HOME ?? '');
        if (!p.startsWith('/')) {
          const base = ctx.out_dir ? ctx.out_dir.replace(/^~/, process.env.HOME ?? '') : ROOT;
          p = existsSync(join(base, p)) ? join(base, p) : existsSync(join(ROOT, p)) ? join(ROOT, p) : join(base, p);
        }
        if (existsSync(p) && statSync(p).isFile()) found.add(resolve(p));
      }
    } else if (Array.isArray(v)) v.forEach((x) => scan(x, ctx));
    else if (v && typeof v === 'object') { const c = { ...ctx, out_dir: v.out_dir ?? ctx.out_dir }; for (const x of Object.values(v)) scan(x, c); }
  };
  scan(rec.sources ?? rec.payload ?? {}, {});
  return [...found];
}

function readState() { try { return JSON.parse(readFileSync(STATE, 'utf8')); } catch { return { v: 1, line: 0, observed: {} }; } }
function writeState(s) { mkdirSync(STATE_DIR, { recursive: true }); writeFileSync(STATE, JSON.stringify(s, null, 1)); }

export function extractFrames(video, outDir, fps = 1) {
  mkdirSync(outDir, { recursive: true });
  const r = spawnSync('ffmpeg', ['-loglevel', 'error', '-y', '-i', video, '-vf', `fps=${fps}`, '-start_number', '0', join(outDir, 'frame-%03d.png')], { encoding: 'utf8', timeout: 600000 });
  if (r.status !== 0) throw new Error(`ffmpeg: ${(r.stderr ?? '').trim()}`);
  return readdirSync(outDir).filter((f) => f.endsWith('.png')).sort().map((f) => join(outDir, f));
}

async function observeArtifact(file, source, state, noSeal, limitFrames = 90) {
  const ext = extname(file).toLowerCase();
  const results = [];
  if (IMAGE_EXT.has(ext)) {
    const rec = await observeImage(file, { source });
    const receipt = noSeal ? null : sealEvidence(rec, source);
    results.push({ file, receipt, ocr_lines: rec.ocr.lines.length, boxes: rec.detection.boxes.length, ok: rec.ocr.ok || rec.detection.ok });
  } else if (VIDEO_EXT.has(ext)) {
    const vsha = sha(readFileSync(file)).slice(0, 12);
    const frames = extractFrames(file, join(ROOT, 'renders', 'observer', `${basename(file, ext)}-${vsha}`)).slice(0, limitFrames);
    let i = 0;
    for (const f of frames) {
      const rec = await observeImage(f, { source: { ...source, video: file, video_sha256_12: vsha, frame: i, frames: frames.length } });
      const receipt = noSeal ? null : sealEvidence(rec, { ...source, video: basename(file), video_sha256_12: vsha, frame: i, frames: frames.length });
      results.push({ file: f, receipt, ocr_lines: rec.ocr.lines.length, boxes: rec.detection.boxes.length, ok: rec.ocr.ok || rec.detection.ok });
      i++;
    }
  }
  state.observed[file] = { at: new Date().toISOString(), results: results.length, receipts: results.map((r) => r.receipt).filter(Boolean) };
  return results;
}

// ------------------------------------------------------------------ commands

async function doctor() {
  const root = await fetch(`${HOST}/`, { signal: AbortSignal.timeout(8000) }).then((r) => ({ ok: r.ok, status: r.status })).catch((e) => ({ ok: false, error: e.message }));
  const tiny = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
  const b64 = tiny.toString('base64');
  const ocr = root.ok ? await call('/doctr/ocr', { image: { type: 'base64', value: b64 } }, 300000).catch((e) => ({ ok: false, error: e.message })) : null;
  const det = root.ok ? await call('/yolo_world/infer', { image: { type: 'base64', value: b64 }, text: ['box'] }, 300000).catch((e) => ({ ok: false, error: e.message })) : null;
  return { host: HOST, local: LOCAL, key: !!KEY, root, doctr: ocr ? { ok: ocr.ok, status: ocr.status, ms: ocr.ms, error: ocr.error ?? (ocr.ok ? null : JSON.stringify(ocr.json).slice(0, 200)) } : null, yolo_world: det ? { ok: det.ok, status: det.status, ms: det.ms, error: det.error ?? (det.ok ? null : JSON.stringify(det.json).slice(0, 200)) } : null };
}

async function subscribe({ once, every, limit, noSeal }) {
  const state = readState();
  for (;;) {
    const lines = readFileSync(storePath(), 'utf8').split('\n');
    let n = 0;
    for (let i = state.line; i < lines.length; i++) {
      const l = lines[i];
      if (!l) continue;
      let rec; try { rec = JSON.parse(l); } catch { continue; }
      const files = artifactsOf(rec).filter((f) => !state.observed[f] && (IMAGE_EXT.has(extname(f).toLowerCase()) || VIDEO_EXT.has(extname(f).toLowerCase())) && !f.endsWith('.observer.json'));
      for (const f of files) {
        if (limit && n >= limit) break;
        const source = { source_receipt: rec.hash ?? rec.id ?? `line:${i}`, source_subject: rec.subject ?? rec.kind ?? 'bus' };
        const res = await observeArtifact(f, source, state, noSeal);
        n += res.length;
        console.error(`${(rec.subject ?? rec.kind ?? 'bus').padEnd(24)} ${f.replace(ROOT + '/', '').replace(process.env.HOME ?? '', '~')} → ${res.length} evidence${noSeal ? ' (unsealed)' : ''}`);
      }
      state.line = i + 1;
      writeState(state);
      if (limit && n >= limit) break;
    }
    console.log(JSON.stringify({ cursor: state.line, observed_total: Object.keys(state.observed).length, new_evidence: n }));
    if (once) break;
    await new Promise((r) => setTimeout(r, every * 1000));
  }
}

async function backfill({ dir, source, noSeal, limit }) {
  const d = resolve(dir);
  const files = readdirSync(d).filter((f) => IMAGE_EXT.has(extname(f).toLowerCase())).sort().map((f) => join(d, f)).slice(0, limit || undefined);
  const state = readState();
  const results = [];
  const started = Date.now();
  let skipped = 0;
  // receipts already in the store for these frames (a crashed pass sealed them without updating the cursor)
  const sealedFor = new Map();
  if (!noSeal) {
    for (const l of readFileSync(storePath(), 'utf8').split('\n')) {
      if (!l.includes('observer.evidence') || !l.includes(basename(d))) continue;
      try { const j = JSON.parse(l); const img = j.sources?.[0]?.image; if (j.subject === 'observer.evidence' && img && j.hash) sealedFor.set(basename(img), j.hash); } catch { /* envelope */ }
    }
  }
  for (let i = 0; i < files.length; i++) {
    // resumable: a frame with a sealed receipt (cursor state or the store itself) is not observed twice
    let prior = state.observed[files[i]];
    if (!prior && sealedFor.has(basename(files[i])) && existsSync(`${files[i]}.observer.json`)) prior = { receipts: [sealedFor.get(basename(files[i]))], recovered: true };
    if (prior && (prior.receipts?.length || noSeal) && existsSync(`${files[i]}.observer.json`)) {
      if (prior.recovered) state.observed[files[i]] = { at: new Date().toISOString(), results: 1, receipts: prior.receipts, recovered_from_store: true };
      const rec = JSON.parse(readFileSync(`${files[i]}.observer.json`, 'utf8'));
      results.push({ file: basename(files[i]), receipt: prior.receipts?.[0] ?? null, ocr_lines: rec.ocr.lines.length, boxes: rec.detection.boxes.length, ok: rec.ocr.ok || rec.detection.ok, ocr_ok: rec.ocr.ok, det_ok: rec.detection.ok, resumed: true });
      skipped++;
      continue;
    }
    const rec = await observeImage(files[i], { source: { backfill: source, frame: i, frames: files.length } });
    const receipt = noSeal ? null : sealEvidence(rec, { backfill: source, frame: i, frames: files.length });
    results.push({ file: basename(files[i]), receipt, ocr_lines: rec.ocr.lines.length, boxes: rec.detection.boxes.length, ok: rec.ocr.ok || rec.detection.ok, ocr_ok: rec.ocr.ok, det_ok: rec.detection.ok });
    state.observed[files[i]] = { at: new Date().toISOString(), results: 1, receipts: receipt ? [receipt] : [] };
    writeState(state);
    if (i % 10 === 0) console.error(`${i + 1}/${files.length} ${basename(files[i])} ocr ${rec.ocr.lines.length} lines · ${rec.detection.boxes.length} boxes`);
  }
  if (skipped) console.error(`${skipped} frames already observed (resumed)`);
  writeState(state);
  const summary = { dir: d.replace(ROOT + '/', ''), source, frames: files.length, observed: results.filter((r) => r.ok).length, ocr_ok: results.filter((r) => r.ocr_ok).length, det_ok: results.filter((r) => r.det_ok).length, frames_with_text: results.filter((r) => r.ocr_lines > 0).length, frames_with_boxes: results.filter((r) => r.boxes > 0).length, boxes: results.reduce((a, r) => a + r.boxes, 0), ocr_lines: results.reduce((a, r) => a + r.ocr_lines, 0), ms: Date.now() - started, receipts: results.map((r) => r.receipt).filter(Boolean) };
  const coverage = noSeal ? null : seal('observer.coverage', { backfill: source, dir: summary.dir, frames: summary.frames, observed: summary.observed, ocr_ok: summary.ocr_ok, det_ok: summary.det_ok, frames_with_text: summary.frames_with_text, frames_with_boxes: summary.frames_with_boxes, boxes: summary.boxes, ocr_lines: summary.ocr_lines, coverage: `${summary.observed}/${summary.frames}`, first: summary.receipts[0] ?? 'none', last: summary.receipts[summary.receipts.length - 1] ?? 'none', host: LOCAL ? 'local-docker' : HOST, ms: summary.ms, order: 'shelf-w6d3' });
  console.log(JSON.stringify({ ...summary, receipts: summary.receipts.length, coverage_receipt: coverage }, null, 1));
}

function coverage({ noSeal }) {
  const lines = readFileSync(storePath(), 'utf8').split('\n');
  const named = new Set(); const byKind = {};
  for (const l of lines) { if (!l) continue; let rec; try { rec = JSON.parse(l); } catch { continue; } for (const f of artifactsOf(rec)) { if (f.endsWith('.observer.json')) continue; named.add(f); (byKind[rec.subject ?? rec.kind ?? 'bus'] ??= new Set()).add(f); } }
  const state = readState();
  const observed = [...named].filter((f) => state.observed[f] || existsSync(`${f}.observer.json`));
  const summary = { artifacts_named: named.size, observed: observed.length, unobserved: [...named].filter((f) => !observed.includes(f)).slice(0, 30).map((f) => f.replace(ROOT + '/', '').replace(process.env.HOME ?? '', '~')), by_subject: Object.fromEntries(Object.entries(byKind).map(([k, v]) => [k, `${[...v].filter((f) => observed.includes(f)).length}/${v.size}`])), cursor: state.line, evidence_receipts: Object.values(state.observed).reduce((a, o) => a + (o.receipts?.length ?? 0), 0) };
  const receipt = noSeal ? null : seal('observer.coverage', { scope: 'root-store', artifacts_named: summary.artifacts_named, observed: summary.observed, coverage: `${summary.observed}/${summary.artifacts_named}`, by_subject: Object.entries(summary.by_subject).map(([k, v]) => `${k}=${v}`).join(','), evidence_receipts: summary.evidence_receipts, host: LOCAL ? 'local-docker' : HOST, order: 'shelf-w6d3' });
  console.log(JSON.stringify({ ...summary, receipt }, null, 1));
}

switch (cmd) {
  case 'doctor': console.log(JSON.stringify(await doctor(), null, 1)); break;
  case 'subscribe': await subscribe({ once: has('--once'), every: Number(flag('--every', 15)), limit: Number(flag('--limit', 0)), noSeal: has('--no-seal') }); break;
  case 'backfill': await backfill({ dir: flag('--dir'), source: flag('--source', basename(flag('--dir', 'frames'))), noSeal: has('--no-seal'), limit: Number(flag('--limit', 0)) }); break;
  case 'frames': { const files = extractFrames(positional[1], flag('--out', join(ROOT, 'renders', 'observer', basename(positional[1], extname(positional[1])))), Number(flag('--fps', 1))); console.log(JSON.stringify({ frames: files.length, dir: dirname(files[0] ?? '') })); break; }
  case 'coverage': coverage({ noSeal: has('--no-seal') }); break;
  default: console.error('usage: timmy observer doctor|subscribe|backfill|frames|coverage'); process.exit(2);
}
