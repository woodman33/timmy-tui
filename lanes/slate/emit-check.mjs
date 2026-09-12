#!/usr/bin/env node
// Step 6 acceptance: the scene emits controller calls and never spawns. Opens
// the viewer on one capsule, clicks "compile" then "send to the controller",
// reads what the controller returned, and checks the bus: a slate.emit.* line
// per click, a dispatch.created for the stored plan, and no launch of it.
// Seals slate.emit with the plan hash and the verdict.
//   node lanes/slate/emit-check.mjs [--capsule p6.capsule] [--no-seal]
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { buildSlate, ROOT } from './build.mjs';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const CAPSULE = opt('--capsule', 'p6.capsule');
const REPO = process.env.TIMMY_REPO ?? '<repo>';
const PORT = Number(process.env.SLATE_PORT ?? 3114);
const GATEWAY = `http://127.0.0.1:${process.env.TIMMY_LOGS_PORT ?? 4310}`;

// per file, so new lines on one bus file are diffed against that file only
const BUS_FILES = [join(REPO, '.timmy', 'receipts', 'runs.jsonl'), join(REPO, '.timmy', 'runs', 'timmy-events.jsonl')];
const busLines = (f) => {
  const out = [];
  try { for (const l of readFileSync(f, 'utf8').split('\n')) { if (!l) continue; try { const o = JSON.parse(l); if (o && typeof o.kind === 'string' && o.payload && !o.hash) out.push(o); } catch { /* skip */ } } } catch { /* none */ }
  return out;
};
const gatewayUp = await fetch(`${GATEWAY}/health`).then((r) => r.ok).catch(() => false);
console.log(`controller gateway ${GATEWAY}: ${gatewayUp ? 'up' : 'DOWN (emit will report not_configured)'}`);
const before = BUS_FILES.map((f) => busLines(f).length);

buildSlate();
// detached so the whole group (npx → tsx → server) dies with one signal
const server = spawn('npx', ['tsx', '-e', `import('./src/companion/server.ts').then(m => m.startCompanionServer(${PORT}))`], { cwd: ROOT, env: { ...process.env, TIMMY_REPO: REPO }, stdio: 'ignore', detached: true });
const stopServer = () => { try { process.kill(-server.pid, 'SIGTERM'); } catch { try { server.kill('SIGTERM'); } catch { /* gone */ } } };
const base = `http://127.0.0.1:${PORT}`;
for (let i = 0; i < 120; i++) { try { if ((await fetch(`${base}/slate3d/manifest.json`)).ok) break; } catch { /* wait */ } await new Promise((r) => setTimeout(r, 500)); }

let result;
try {
  const { chromium } = await import(join(ROOT, 'vault-custody', 'node_modules', 'playwright', 'index.mjs'));
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  await page.goto(`${base}/slate3d/?board=ledger&still=1&source=ws&open=${encodeURIComponent(CAPSULE)}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !document.getElementById('capsule-panel').hidden, null, { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(1500);
  const panelOpen = await page.evaluate(() => !document.getElementById('capsule-panel').hidden);
  // dispatch through the DOM: the render loop can hold the main thread for
  // whole frames in headless GPU mode, which makes hit-tested clicks time out
  await page.evaluate(() => document.getElementById('cp-compile').click());
  await page.waitForFunction(() => /"ok"|failed|controller/.test(document.getElementById('cp-out').textContent), null, { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(500);
  const compileOut = await page.evaluate(() => document.getElementById('cp-out').textContent);
  await page.evaluate(() => document.getElementById('cp-store').click());
  await page.waitForFunction(() => /plan_hash|nothing sent|not_configured|failed/.test(document.getElementById('cp-out').textContent), null, { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(800);
  const storeOut = await page.evaluate(() => document.getElementById('cp-out').textContent);
  await page.screenshot({ path: join(ROOT, 'vault-custody', 'renders', 'slate3d', 'emit-check.png') });
  await browser.close();
  let compile = null, store = null;
  try { compile = JSON.parse(compileOut); } catch { /* text */ }
  try { store = JSON.parse(storeOut); } catch { /* text */ }
  result = { panelOpen, compile: compile ? { ok: compile.ok, state: compile.state ?? null, plans: compile.plans?.length ?? 0, errors: compile.errors ?? [] } : compileOut.slice(0, 200), store: store ? { ok: store.ok, state: store.state ?? null, id: store.id ?? null, plan_hash: store.plan_hash ?? null, note: store.note ?? null } : storeOut.slice(0, 200) };
} finally {
  stopServer();
}
await new Promise((r) => setTimeout(r, 1200));
const after = BUS_FILES.flatMap((f, i) => busLines(f).slice(before[i]));
const emits = after.filter((e) => e.kind.startsWith('slate.emit.'));
const planHash = result.store?.plan_hash ?? null;
const created = after.filter((e) => e.kind === 'dispatch.created' && (!planHash || e.payload?.plan_hash === planHash));
const launched = after.filter((e) => /^dispatch\.(launched|container_started|armed)$/.test(e.kind) && (!planHash || e.payload?.plan_hash === planHash));
const verdict = { emitted: emits.map((e) => e.kind), dispatch_created: created.length, launched_or_armed: launched.length, never_spawned: launched.length === 0 };
console.log(JSON.stringify({ capsule: CAPSULE, gatewayUp, ...result, ...verdict }, null, 1));

if (!args.includes('--no-seal')) {
  const shot = join(ROOT, 'vault-custody', 'renders', 'slate3d', 'emit-check.png');
  const meta = [`capsule=${CAPSULE}`, `gateway=${GATEWAY}`, `gateway_up=${gatewayUp}`, `panel_open=${result.panelOpen}`,
    `compile=${typeof result.compile === 'object' ? `ok:${result.compile.ok} plans:${result.compile.plans}` : 'text'}`,
    `store=${typeof result.store === 'object' ? `ok:${result.store.ok} id:${result.store.id ?? ''} state:${result.store.state ?? ''}` : 'text'}`,
    `plan_hash=${planHash ?? ''}`, `emitted=${verdict.emitted.join(',')}`, `dispatch_created=${verdict.dispatch_created}`, `launched_or_armed=${verdict.launched_or_armed}`, `never_spawned=${verdict.never_spawned}`,
    `shot_sha256=${createHash('sha256').update(readFileSync(shot)).digest('hex')}`];
  const a = ['slate.emit']; for (const m of meta) a.push('--meta', m);
  const r = spawnSync('npx', ['tsx', 'src/cli.ts', 'seal', ...a], { cwd: ROOT, stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status ?? 1);
}
