#!/usr/bin/env node
// Two-browser check (ledger board acceptance: "two browsers share one board
// through the Durable Object"). Serves the viewer locally, opens it in two
// isolated browser contexts pointed at the same room, posts one fresh event
// into the room, and confirms both viewers received it. Seals slate.room.
//   node lanes/slate/room-check.mjs [--room slate:ledger] [--worker <url>] [--no-seal]
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { buildSlate, ROOT } from './build.mjs';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const ROOM = opt('--room', 'slate:ledger');
const WORKER = opt('--worker', 'https://timmy-ai-proxy-preview.wmeldman33.workers.dev').replace(/\/$/, '');
const REPO = process.env.TIMMY_REPO ?? '<repo>';
const PORT = Number(process.env.SLATE_PORT ?? 3112);
const OUT = join(ROOT, 'vault-custody', 'renders', 'slate3d');
const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');

function token() {
  if (process.env.TIMMY_EDGE_TOKEN) return process.env.TIMMY_EDGE_TOKEN;
  const p = join(ROOT, 'workers', 'ai-proxy', '.dev.vars');
  if (!existsSync(p)) return '';
  for (const raw of readFileSync(p, 'utf8').split('\n')) if (raw.startsWith('TIMMY_EDGE_TOKEN=')) return raw.slice('TIMMY_EDGE_TOKEN='.length).trim().replace(/^["']|["']$/g, '');
  return '';
}

buildSlate();
const server = spawn('npx', ['tsx', '-e', `import('./src/companion/server.ts').then(m => m.startCompanionServer(${PORT}))`], { cwd: ROOT, env: { ...process.env, TIMMY_REPO: REPO }, stdio: 'ignore', detached: true });
const stopServer = () => { try { process.kill(-server.pid, 'SIGTERM'); } catch { try { server.kill('SIGTERM'); } catch { /* gone */ } } };
const base = `http://127.0.0.1:${PORT}`;
for (let i = 0; i < 120; i++) { try { if ((await fetch(`${base}/slate3d/manifest.json`)).ok) break; } catch { /* wait */ } await new Promise((r) => setTimeout(r, 500)); }

let result;
try {
  const { chromium } = await import(join(ROOT, 'vault-custody', 'node_modules', 'playwright', 'index.mjs'));
  const browser = await chromium.launch();
  const url = `${base}/slate3d/?board=ledger&still=1&room=${encodeURIComponent(ROOM)}&worker=${encodeURIComponent(WORKER)}`;
  const ctxs = [await browser.newContext({ viewport: { width: 1280, height: 800 } }), await browser.newContext({ viewport: { width: 1280, height: 800 } })];
  const pages = await Promise.all(ctxs.map((c) => c.newPage()));
  await Promise.all(pages.map((p) => p.goto(url, { waitUntil: 'load' })));
  await pages[0].waitForTimeout(7000);
  const before = await Promise.all(pages.map((p) => p.evaluate(() => ({ bus: document.getElementById('bus-text')?.textContent, ticker: [...document.querySelectorAll('#ticker li')].map((li) => li.textContent) }))));

  // one fresh event through the room, from here, not from either browser
  const marker = `slate.room.check ${new Date().toISOString()}`;
  const r = await fetch(`${WORKER}/runs/${encodeURIComponent(ROOM)}/event`, { method: 'POST', headers: { 'content-type': 'application/json', Authorization: `Bearer ${token()}` }, body: JSON.stringify({ kind: 'slate.room.check', payload: { marker, room: ROOM } }) });
  const posted = await r.json();
  await pages[0].waitForTimeout(12000);
  const after = await Promise.all(pages.map((p) => p.evaluate(() => ({ bus: document.getElementById('bus-text')?.textContent, ticker: [...document.querySelectorAll('#ticker li')].map((li) => li.textContent), lit: document.querySelectorAll('.lbl.lane.lit, .lbl.lane.human').length }))));
  mkdirSync(OUT, { recursive: true });
  const shots = [];
  for (let i = 0; i < pages.length; i++) { const p = join(OUT, `room-check-${i + 1}.png`); await pages[i].screenshot({ path: p }); shots.push({ path: p, sha256: sha(p) }); }
  await browser.close();
  const seen = after.map((a) => a.ticker.some((t) => t.includes('slate.room.check')));
  result = { url, room: ROOM, worker: WORKER, posted, before, after, seen, shots };
  console.log(JSON.stringify({ room: ROOM, posted, seen, bus: after.map((a) => a.bus), lit: after.map((a) => a.lit), shots: shots.map((s) => s.sha256.slice(0, 16)) }, null, 1));
} finally {
  stopServer();
}
if (!result) process.exit(1);
const ok = result.seen.every(Boolean) && result.posted?.ok;
if (!args.includes('--no-seal')) {
  const meta = [`room=${ROOM}`, `worker=${WORKER}`, `viewers=2`, `both_saw_live_event=${ok}`, `posted_seq=${result.posted?.next ?? ''}`,
    `bus_status=${result.after.map((a) => a.bus).join('|')}`, `pods_lit=${result.after.map((a) => a.lit).join('|')}`,
    ...result.shots.map((s, i) => `shot${i + 1}_sha256=${s.sha256}`), 'room_spawns_work=false'];
  const a = ['slate.room'];
  for (const m of meta) a.push('--meta', m);
  const s = spawnSync('npx', ['tsx', 'src/cli.ts', 'seal', ...a], { cwd: ROOT, stdio: 'inherit' });
  if (s.status !== 0) process.exit(s.status ?? 1);
}
process.exit(ok ? 0 : 3);
