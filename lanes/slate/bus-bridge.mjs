#!/usr/bin/env node
// Bus → SlateRoom bridge. Tails the pinned root bus (the one bus beside the
// receipts and the legacy events file) and forwards each envelope to a room on
// the preview worker, so two browsers anywhere share one board through the
// Durable Object. Opt-in: nothing is forwarded unless this runs.
//   node lanes/slate/bus-bridge.mjs --room slate:ledger --worker https://<hostname> [--replay 200] [--once]
// Auth: TIMMY_EDGE_TOKEN from the environment or workers/ai-proxy/.dev.vars (never printed).
import { existsSync, openSync, readFileSync, readSync, closeSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { edgeUrlOrInert } from '../privacy/overlay.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const REPO = process.env.TIMMY_REPO ?? '<repo>';
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const ROOM = opt('--room', 'slate:ledger');
const WORKER = opt('--worker', process.env.TIMMY_AI_PROXY ?? edgeUrlOrInert()).replace(/\/$/, '');
const REPLAY = Number(opt('--replay', 200));
const ONCE = args.includes('--once');

function token() {
  if (process.env.TIMMY_EDGE_TOKEN) return process.env.TIMMY_EDGE_TOKEN;
  const p = join(ROOT, 'workers', 'ai-proxy', '.dev.vars');
  if (!existsSync(p)) return '';
  for (const raw of readFileSync(p, 'utf8').split('\n')) {
    const line = raw.trim();
    if (line.startsWith('TIMMY_EDGE_TOKEN=')) return line.slice('TIMMY_EDGE_TOKEN='.length).replace(/^["']|["']$/g, '');
  }
  return '';
}
const TOKEN = token();
if (!TOKEN) { console.error('no TIMMY_EDGE_TOKEN (env or workers/ai-proxy/.dev.vars)'); process.exit(2); }

const files = [join(REPO, '.timmy', 'receipts', 'runs.jsonl'), join(REPO, '.timmy', 'runs', 'timmy-events.jsonl')];
const isEvent = (o) => Boolean(o && typeof o.kind === 'string' && o.payload && typeof o.payload === 'object' && o.ts && !o.hash && !o.sig);
const parse = (text) => text.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(isEvent);
// stable id per envelope so replays and restarts never duplicate a row in the room
const idOf = (e) => `bus_${Buffer.from(`${e.ts}|${e.kind}|${JSON.stringify(e.payload)}`).toString('base64url').slice(0, 60)}`;

async function post(events) {
  if (!events.length) return { stored: 0, skipped: 0 };
  const r = await fetch(`${WORKER}/runs/${encodeURIComponent(ROOM)}/event`, {
    method: 'POST', headers: { 'content-type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(events.map((e) => ({ id: idOf(e), ts: e.ts, kind: e.kind, payload: e.payload }))),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`room refused ${r.status}: ${JSON.stringify(j).slice(0, 200)}`);
  return j;
}

// 1. replay the recent tail so a fresh room has history
const offsets = files.map((f) => { try { return statSync(f).size; } catch { return 0; } });
if (REPLAY > 0) {
  const all = files.flatMap((f) => { try { return parse(readFileSync(f, 'utf8')).slice(-REPLAY); } catch { return []; } })
    .sort((a, b) => String(a.ts).localeCompare(String(b.ts))).slice(-REPLAY);
  const j = await post(all);
  console.log(`replayed ${all.length} → stored ${j.stored} skipped ${j.skipped} (room ${ROOM} @ ${WORKER})`);
}
if (ONCE) process.exit(0);

// 2. live tail: whole lines only
console.log(`bridging live bus → ${WORKER}/runs/${ROOM} (ctrl-c to stop)`);
setInterval(async () => {
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    let size = 0;
    try { size = statSync(f).size; } catch { continue; }
    if (size < offsets[i]) offsets[i] = 0;
    if (size === offsets[i]) continue;
    let chunk = '';
    try {
      const fd = openSync(f, 'r');
      const buf = Buffer.alloc(size - offsets[i]);
      readSync(fd, buf, 0, buf.length, offsets[i]);
      closeSync(fd);
      chunk = buf.toString('utf8');
    } catch { continue; }
    const cut = chunk.lastIndexOf('\n');
    if (cut < 0) continue;
    const whole = chunk.slice(0, cut + 1);
    offsets[i] += Buffer.byteLength(whole, 'utf8');
    const events = parse(whole);
    if (!events.length) continue;
    try { const j = await post(events); console.log(`${new Date().toISOString()} forwarded ${events.length} → stored ${j.stored}`); }
    catch (e) { console.error(String(e)); }
  }
}, 700);
