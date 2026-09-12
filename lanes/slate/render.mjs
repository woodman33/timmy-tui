#!/usr/bin/env node
// Slate 3D render lane: build the bundle, run the companion server against the
// pinned root bus, capture the board with Playwright (still + clip), record
// slate.render.start/done on the bus, and seal slate.render in the ROOT chain.
//   node lanes/slate/render.mjs [--board ledger] [--design <receipt id>] [--no-seal] [--no-mp4]
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, readdirSync, statSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { buildSlate, ROOT } from './build.mjs';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const BOARD = opt('--board', 'ledger');
const DESIGN = opt('--design', '');
const WAIT = Number(opt('--wait', 6000));
const REPO = process.env.TIMMY_REPO ?? '<repo>';
const PORT = Number(process.env.SLATE_PORT ?? 3111);
const OUT = join(ROOT, 'vault-custody', 'renders', 'slate3d');
const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
const busEvent = (kind, payload) => {
  // The one bus (main's src/bus) appends event envelopes beside the receipts in
  // .timmy/receipts/runs.jsonl; when that refactor is present publish there,
  // otherwise to the legacy events file the committed eventbus still uses.
  const oneBus = join(REPO, '.timmy', 'receipts', 'runs.jsonl');
  const p = existsSync(join(REPO, 'src', 'bus', 'index.ts')) && existsSync(oneBus) ? oneBus : join(REPO, '.timmy', 'runs', 'timmy-events.jsonl');
  mkdirSync(dirname(p), { recursive: true });
  appendFileSync(p, JSON.stringify({ v: 1, ts: new Date().toISOString(), kind, payload }) + '\n');
};

// 1. build
const manifest = buildSlate();
const bundle = manifest.outputs.find((o) => o.path === 'slate3d.js');
const boardPath = join(ROOT, 'companion', 'boards', `${BOARD}.mission.json`);
const boardSha = sha(boardPath);

// 2. companion server against the root bus
const server = spawn('npx', ['tsx', '-e', `import('./src/companion/server.ts').then(m => m.startCompanionServer(${PORT}))`], {
  cwd: ROOT, env: { ...process.env, TIMMY_REPO: REPO }, stdio: ['ignore', 'pipe', 'pipe'], detached: true,
});
const stopServer = () => { try { process.kill(-server.pid, 'SIGTERM'); } catch { try { server.kill('SIGTERM'); } catch { /* gone */ } } };
let serverLog = '';
server.stdout.on('data', (d) => { serverLog += d; });
server.stderr.on('data', (d) => { serverLog += d; });
const base = `http://127.0.0.1:${PORT}`;
const url = `${base}/slate3d/?board=${BOARD}`;
const deadline = Date.now() + 90000;
while (Date.now() < deadline) {
  try { const r = await fetch(`${base}/slate3d/manifest.json`); if (r.ok) break; } catch { /* not yet */ }
  await new Promise((r) => setTimeout(r, 500));
}

let result;
try {
  const { chromium } = await import(join(ROOT, 'vault-custody', 'node_modules', 'playwright', 'index.mjs'));
  mkdirSync(OUT, { recursive: true });
  busEvent('slate.render.start', { board: BOARD, url, bundle_sha256: bundle.sha256 });

  // 3a. the still (reduced motion, deterministic)
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`${url}&still=1`, { waitUntil: 'load' });
  await page.waitForTimeout(WAIT);
  busEvent('slate.render.capture', { board: BOARD, frame: 'still' });
  await page.waitForTimeout(2500);
  const still = join(OUT, `${BOARD}-3d.png`);
  await page.screenshot({ path: still });
  const evidence = await page.evaluate(() => ({
    bus: document.getElementById('bus-text')?.textContent,
    board: document.getElementById('board-name')?.textContent,
    ticker: [...document.querySelectorAll('#ticker li')].map((li) => li.textContent),
    podsLit: document.querySelectorAll('.lbl.lane.lit, .lbl.lane.human, .lbl.lane.refusal').length,
    pods: document.querySelectorAll('.lbl.lane').length,
    frames: document.querySelectorAll('.lbl.frame').length,
  }));
  await browser.close();

  // 3b. the clip (motion allowed)
  let mp4 = null;
  if (!args.includes('--no-mp4')) {
    const vdir = join(OUT, '.video');
    mkdirSync(vdir, { recursive: true });
    const b2 = await chromium.launch();
    const ctx = await b2.newContext({ viewport: { width: 1600, height: 1000 }, recordVideo: { dir: vdir, size: { width: 1600, height: 1000 } } });
    const p2 = await ctx.newPage();
    await p2.goto(url, { waitUntil: 'load' });
    await p2.waitForTimeout(1500);
    await p2.mouse.move(800, 500);
    await p2.mouse.down();
    for (let i = 0; i < 60; i++) { await p2.mouse.move(800 + i * 6, 500 - i * 1.2); await p2.waitForTimeout(90); }
    await p2.mouse.up();
    await p2.waitForTimeout(2500);
    const v = p2.video();
    await ctx.close();
    await b2.close();
    const webm = await v.path();
    mp4 = join(OUT, `${BOARD}-3d.mp4`);
    const ff = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', webm, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', mp4], { encoding: 'utf8' });
    if (ff.status !== 0) { console.error('ffmpeg failed', ff.stderr); mp4 = null; }
  }

  result = { still, still_sha256: sha(still), mp4, mp4_sha256: mp4 ? sha(mp4) : null, evidence, errors };
  busEvent('slate.render.done', { board: BOARD, still_sha256: result.still_sha256, pods_lit: evidence.podsLit, events_seen: evidence.ticker.length });
  console.log(JSON.stringify({ url, board_sha256: boardSha, bundle: bundle.sha256, ...result }, null, 1));
} finally {
  stopServer();
}
if (!result) { console.error(serverLog.slice(-2000)); process.exit(1); }
if (result.errors.length) console.error('page errors:', result.errors);

// 4. seal slate.render in the ROOT chain
if (!args.includes('--no-seal')) {
  const meta = [
    `board=${BOARD}`, `board_sha256=${boardSha}`, `bundle_sha256=${bundle.sha256}`, `three=${manifest.three}`,
    `still=vault-custody/renders/slate3d/${BOARD}-3d.png`, `still_sha256=${result.still_sha256}`,
    ...(result.mp4 ? [`mp4=vault-custody/renders/slate3d/${BOARD}-3d.mp4`, `mp4_sha256=${result.mp4_sha256}`] : []),
    `bus=companion-websocket`, `bus_status=${result.evidence.bus}`, `pods=${result.evidence.pods}`, `pods_lit=${result.evidence.podsLit}`,
    `frames=${result.evidence.frames}`, `events_seen=${result.evidence.ticker.length}`, `page_errors=${result.errors.length}`,
    ...(DESIGN ? [`design=${DESIGN}`] : []), 'viewer_spawns_work=false',
  ];
  const a = ['slate.render'];
  for (const m of meta) a.push('--meta', m);
  const r = spawnSync('npx', ['tsx', 'src/cli.ts', 'seal', ...a], { cwd: ROOT, stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status ?? 1);
}
