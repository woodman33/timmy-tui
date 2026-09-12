#!/usr/bin/env node
// Cloudflare as first mate (mindship-v5c2 step 3): the war-room pane FEED and
// the six verbs. The TUI renders; this lane only produces the feed and runs
// the verbs, so src/tui stays untouched.
//
//   timmy cf pane [--watch] [--every 30] [--tail-seconds 6] [--out companion/boards/cf.pane.json] [--no-seal]
//   timmy cf deploy [--prod]               wrangler deploy (preview by default) → seals cf.deploy
//   timmy cf tail [--seconds N] [--prod]   wrangler tail as NDJSON (Ctrl-C to stop)
//   timmy cf code (--script <file> | --task "<task>" [--approval <token>]) [--model m]   POST /code
//   timmy cf workflow [list]               wrangler workflows list
//   timmy cf kv [list [--prefix p]] | get <key>       CUSTODY_KV (chain:*, head:*)
//   timmy cf r2 [buckets | list <bucket> [--prefix p]]
//
// Feed shape (companion/boards/cf.pane.json, one JSON object, also printed):
//   { v, generated_at, worker, tail, do, queues, cron, spend, sources }
// Every source records ok/ms/note so a dead source shows as dead, not as zero.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const WORKER_DIR = join(ROOT, 'workers', 'ai-proxy');
const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const has = (k) => args.includes(k);
const verb = args.find((a) => !a.startsWith('--')) ?? 'pane';
const PROD = has('--prod');
const NAME = PROD ? 'timmy-ai-proxy' : 'timmy-ai-proxy-preview';
const WORKER = (flag('--worker', PROD ? 'https://timmy-ai-proxy.wmeldman33.workers.dev' : 'https://timmy-ai-proxy-preview.wmeldman33.workers.dev')).replace(/\/$/, '');
const ROOM = flag('--room', 'war-room');
const SLATE_ROOM = flag('--slate-room', 'slate:ledger');
const KV_ID = '8d783470266e44d9ab49143de5b88436';

function token() {
  if (process.env.TIMMY_EDGE_TOKEN) return process.env.TIMMY_EDGE_TOKEN;
  const p = join(WORKER_DIR, '.dev.vars');
  if (!existsSync(p)) return '';
  for (const line of readFileSync(p, 'utf8').split('\n')) if (line.startsWith('TIMMY_EDGE_TOKEN=')) return line.slice('TIMMY_EDGE_TOKEN='.length).trim().replace(/^["']|["']$/g, '');
  return '';
}

/** Run wrangler from the worker dir; returns {ok, code, out, err, ms}. Never throws. */
function wrangler(argv, { timeout = 60000 } = {}) {
  const started = Date.now();
  const r = spawnSync('npx', ['wrangler', ...argv], { cwd: WORKER_DIR, encoding: 'utf8', timeout, env: { ...process.env, WRANGLER_SEND_METRICS: 'false' } });
  return { ok: r.status === 0, code: r.status, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim(), ms: Date.now() - started, timed_out: r.error?.code === 'ETIMEDOUT' };
}

function tryJson(s) { try { return JSON.parse(s); } catch { return null; } }

async function getJson(url, headers = {}, ms = 8000) {
  const started = Date.now();
  try {
    const r = await fetch(url, { headers, signal: AbortSignal.timeout(ms) });
    const text = await r.text();
    return { ok: r.ok, status: r.status, body: tryJson(text) ?? text.slice(0, 500), ms: Date.now() - started };
  } catch (e) {
    return { ok: false, status: 0, body: null, error: e.message, ms: Date.now() - started };
  }
}

// ------------------------------------------------------------------ cron

function cronField(f, min, max) {
  if (f === '*') return null;
  const set = new Set();
  for (const part of f.split(',')) {
    const m = part.match(/^(\d+)(?:-(\d+))?(?:\/(\d+))?$/);
    if (!m) continue;
    const a = Number(m[1]); const b = m[2] ? Number(m[2]) : a; const step = m[3] ? Number(m[3]) : 1;
    for (let i = a; i <= Math.min(b, max); i += step) if (i >= min) set.add(i);
  }
  return set;
}

/** Next UTC occurrence of a 5-field cron after `from`. Plain fields, lists, ranges and steps; no names. */
export function nextCronUtc(expr, from = new Date()) {
  const [mi, ho, dom, mon, dow] = expr.trim().split(/\s+/);
  const f = { mi: cronField(mi, 0, 59), ho: cronField(ho, 0, 23), dom: cronField(dom, 1, 31), mon: cronField(mon, 1, 12), dow: cronField(dow, 0, 6) };
  const t = new Date(from.getTime());
  t.setUTCSeconds(0, 0);
  t.setUTCMinutes(t.getUTCMinutes() + 1);
  for (let i = 0; i < 366 * 24 * 60; i++) {
    const ok = (!f.mi || f.mi.has(t.getUTCMinutes())) && (!f.ho || f.ho.has(t.getUTCHours())) && (!f.dom || f.dom.has(t.getUTCDate())) && (!f.mon || f.mon.has(t.getUTCMonth() + 1)) && (!f.dow || f.dow.has(t.getUTCDay()));
    if (ok) return t.toISOString();
    t.setUTCMinutes(t.getUTCMinutes() + 1);
  }
  return null;
}

function cronsFromConfig() {
  const cfg = readFileSync(join(WORKER_DIR, 'wrangler.jsonc'), 'utf8');
  const m = cfg.match(/"crons"\s*:\s*\[([^\]]*)\]/);
  if (!m) return [];
  return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
}

// ------------------------------------------------------------------ tail window

function tailWindow(seconds) {
  return new Promise((resolve) => {
    if (!seconds) return resolve({ ok: true, window_s: 0, events: 0, last: [], note: 'tail window disabled (--tail-seconds 0)' });
    const started = Date.now();
    const child = spawn('npx', ['wrangler', 'tail', NAME, '--format', 'json'], { cwd: WORKER_DIR, env: { ...process.env, WRANGLER_SEND_METRICS: 'false' } });
    const events = [];
    let stderr = '';
    let buf = '';
    child.stdout.on('data', (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line) continue;
        const j = tryJson(line);
        if (!j) continue;
        const req = j.event?.request;
        events.push({ ts: j.eventTimestamp ? new Date(j.eventTimestamp).toISOString() : null, outcome: j.outcome, method: req?.method ?? null, url: req?.url ? new URL(req.url).pathname : (j.event?.cron ?? null), status: j.event?.response?.status ?? null, logs: (j.logs ?? []).length, exceptions: (j.exceptions ?? []).length });
      }
    });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    const done = (note) => { try { child.kill('SIGINT'); } catch { /* gone */ } resolve({ ok: !/error/i.test(stderr) || events.length > 0, window_s: seconds, events: events.length, last: events.slice(-12), ms: Date.now() - started, note: note ?? (stderr.split('\n').filter((l) => /error|fail/i.test(l)).slice(0, 2).join(' | ') || null) }); };
    setTimeout(() => done(), seconds * 1000);
    child.on('error', (e) => done(`tail spawn failed: ${e.message}`));
  });
}

// ------------------------------------------------------------------ the feed

export async function buildFeed({ tailSeconds = 6 } = {}) {
  const generated_at = new Date().toISOString();
  const sources = [];
  const src = (id, r, note) => { sources.push({ id, ok: !!r.ok, ms: r.ms ?? null, note: note ?? r.error ?? r.err?.split('\n')[0] ?? null }); return r; };

  // worker: health + latest version
  const health = src('worker.health', await getJson(`${WORKER}/health`));
  const versions = src('worker.versions', wrangler(['versions', 'list', '--name', NAME, '--json'], { timeout: 45000 }));
  const versionList = tryJson(versions.out);
  // wrangler lists versions oldest first; the pane wants the newest
  const latest = Array.isArray(versionList) && versionList.length ? [...versionList].sort((a, b) => String(b.metadata?.created_on ?? '').localeCompare(String(a.metadata?.created_on ?? '')))[0] : null;
  const worker = {
    name: NAME,
    url: WORKER,
    health: health.ok ? health.body : null,
    version: latest ? { id: latest.id, created_on: latest.metadata?.created_on ?? null, source: latest.metadata?.source ?? null, message: latest.annotations?.['workers/message'] ?? null } : null,
    versions_note: versions.ok ? null : (versions.err.split('\n')[0] || 'wrangler versions list failed')
  };

  // do: rooms + commander
  const slate = src('do.slate_room', await getJson(`${WORKER}/runs/${encodeURIComponent(SLATE_ROOM)}`));
  const commander = src('do.commander', await getJson(`${WORKER}/commander/${encodeURIComponent(ROOM)}/state`));
  const doState = {
    rooms: [{ room: SLATE_ROOM, events: slate.body?.events ?? null, viewers: slate.body?.viewers ?? null, ok: slate.ok }],
    commander: commander.ok ? { room: ROOM, mode: commander.body.state?.mode, held_by: commander.body.state?.held_by, openrouter_paused: commander.body.state?.openrouter_paused, killed: commander.body.state?.killed, turns: commander.body.state?.turns, head: commander.body.state?.head, spend: commander.body.state?.spend, viewers: commander.body.viewers, schedules: commander.body.schedules } : null
  };

  // queues: what wrangler reports for this account
  // wrangler 4.129 `queues list` has no --json; parse its table (name | id | created | producers | consumers). Depth is not
  // reported by wrangler at all, so it is null with a note rather than a fake zero.
  const ql = src('queues.list', wrangler(['queues', 'list'], { timeout: 45000 }));
  let queues = [];
  if (ql.ok && ql.out) {
    const rows = ql.out.split('\n').filter((l) => /│/.test(l)).map((l) => l.split('│').map((c) => c.trim()).filter(Boolean));
    const header = rows[0] ?? [];
    queues = rows.slice(1).filter((r) => r.length >= 2 && r[0] !== header[0]).map((r) => {
      const o = {};
      header.forEach((h, i) => { o[h.toLowerCase().replace(/[^a-z0-9]+/g, '_')] = r[i] ?? null; });
      return { ...o, depth: null, depth_note: 'wrangler does not report backlog depth; needs the Queues API' };
    });
  }

  // cron: next runs (UTC) from the worker config + the local anchor LaunchAgent
  const head = src('head.latest', await getJson(`${WORKER}/head`));
  const cron = cronsFromConfig().map((expr) => ({ expr, where: NAME, next_utc: nextCronUtc(expr), last_head: head.ok ? { date: head.body.date, receipts: head.body.receipts, subjects: head.body.subjects, combined: String(head.body.combined_sha256 ?? '').slice(0, 12) } : null }));
  cron.push({ expr: '30 9 * * * (local, launchd dev.timmy.anchor)', where: 'laptop', next_utc: nextAnchorLocal(), last_head: null });

  // spend: commander ledger + OpenRouter credits/key (key from env, never printed)
  const orKey = process.env.OPENROUTER_API_KEY ?? '';
  const credits = orKey ? src('spend.openrouter.credits', await getJson('https://openrouter.ai/api/v1/credits', { Authorization: `Bearer ${orKey}` })) : src('spend.openrouter.credits', { ok: false, error: 'OPENROUTER_API_KEY not in env' });
  const keyInfo = orKey ? src('spend.openrouter.key', await getJson('https://openrouter.ai/api/v1/auth/key', { Authorization: `Bearer ${orKey}` })) : { ok: false };
  // analytics (swarm-b3k7 step 6): spend by model per day from GET /api/v1/activity. The endpoint is a
  // management call and needs the provisioning key; without one the source shows as dead, not as zero.
  const provKey = process.env.OPENROUTER_PROVISIONING_KEY ?? '';
  const activity = provKey ? src('spend.openrouter.activity', await getJson('https://openrouter.ai/api/v1/activity', { Authorization: `Bearer ${provKey}` })) : src('spend.openrouter.activity', { ok: false, error: 'OPENROUTER_PROVISIONING_KEY not in env (management endpoint)' });
  const byModelDay = activity.ok ? (activity.body.data ?? []).slice(0, 200).map((r) => ({ date: r.date ?? null, model: r.model ?? null, usage: r.usage ?? null, requests: r.requests ?? null, prompt_tokens: r.prompt_tokens ?? null, completion_tokens: r.completion_tokens ?? null })) : null;
  const spend = {
    commander: commander.ok ? commander.body.state?.spend ?? null : null,
    openrouter: {
      credits: credits.ok ? credits.body.data ?? credits.body : null,
      // the key label is key-identifying, so it stays out of the feed; usage and limits are what the pane needs
      key: keyInfo.ok ? { usage: keyInfo.body.data?.usage ?? null, limit: keyInfo.body.data?.limit ?? null, limit_remaining: keyInfo.body.data?.limit_remaining ?? null, is_free_tier: keyInfo.body.data?.is_free_tier ?? null } : null,
      activity: byModelDay
    }
  };

  // tail: a short live window
  const tail = src('worker.tail', await tailWindow(tailSeconds));

  return { v: 1, generated_at, worker, tail, do: doState, queues, cron, spend, sources };
}

function nextAnchorLocal() {
  const now = new Date();
  const t = new Date(now);
  t.setHours(9, 30, 0, 0);
  if (t <= now) t.setDate(t.getDate() + 1);
  return t.toISOString();
}

function seal(subject, meta) {
  const a = ['tsx', 'src/cli.ts', 'seal', subject];
  for (const [k, v] of Object.entries(meta)) if (v != null) a.push('--meta', `${k}=${v}`);
  const r = spawnSync('npx', a, { cwd: ROOT, encoding: 'utf8' });
  process.stdout.write(r.stdout ?? '');
  if (r.status !== 0) process.stderr.write(r.stderr ?? '');
  const m = (r.stdout ?? '').match(/sha256_[0-9a-f]+/);
  return m ? m[0] : null;
}

async function paneOnce() {
  const feed = await buildFeed({ tailSeconds: Number(flag('--tail-seconds', 6)) });
  const out = flag('--out', join(ROOT, 'companion', 'boards', 'cf.pane.json'));
  mkdirSync(join(out, '..'), { recursive: true });
  const text = JSON.stringify(feed, null, 1);
  writeFileSync(out, text);
  const hash = createHash('sha256').update(text).digest('hex');
  console.log(text);
  console.error(`feed → ${out} sha256 ${hash.slice(0, 16)} · sources ok ${feed.sources.filter((s) => s.ok).length}/${feed.sources.length}`);
  return { feed, hash, out };
}

// ------------------------------------------------------------------ verbs

const out = (o) => console.log(JSON.stringify(o, null, 1));

switch (verb) {
  case 'pane': {
    if (has('--watch')) {
      const every = Number(flag('--every', 30));
      for (;;) { await paneOnce(); await new Promise((r) => setTimeout(r, every * 1000)); }
    }
    const { feed, hash, out: outPath } = await paneOnce();
    if (!has('--no-seal')) {
      seal('cf.pane', { worker: NAME, feed_sha256: hash, feed: outPath.replace(ROOT, '').replace(/^\//, ''), sources_ok: `${feed.sources.filter((s) => s.ok).length}/${feed.sources.length}`, tail_events: feed.tail.events, commander_room: ROOM, commander_turns: feed.do.commander?.turns ?? 'n/a', queues: feed.queues.length, cron_next_utc: feed.cron[0]?.next_utc ?? 'n/a', head_date: feed.cron[0]?.last_head?.date ?? 'n/a', verbs: 'deploy,tail,code,workflow,kv,r2' });
    }
    break;
  }
  case 'deploy': {
    if (PROD && !has('--yes')) { console.error('production deploy needs --yes (the owner\'s word); preview needs nothing'); process.exit(2); }
    const r = wrangler(PROD ? ['deploy'] : ['deploy', '--name', NAME], { timeout: 240000 });
    process.stdout.write(`${r.out}\n`); if (!r.ok) process.stderr.write(`${r.err}\n`);
    const ver = (r.out.match(/Version ID:\s*([0-9a-f-]+)/) ?? [])[1] ?? null;
    if (r.ok && !has('--no-seal')) seal('cf.deploy', { worker: NAME, version: ver ?? 'unknown', url: WORKER, ms: r.ms });
    process.exit(r.ok ? 0 : 1);
  }
  case 'tail': {
    const seconds = Number(flag('--seconds', 0));
    const child = spawn('npx', ['wrangler', 'tail', '--name', NAME, '--format', 'json'], { cwd: WORKER_DIR, stdio: ['ignore', 'inherit', 'inherit'] });
    if (seconds) setTimeout(() => child.kill('SIGINT'), seconds * 1000);
    child.on('exit', (c) => process.exit(c ?? 0));
    await new Promise(() => {});
    break;
  }
  case 'code': {
    const t = token();
    if (!t) { console.error('no TIMMY_EDGE_TOKEN (env or workers/ai-proxy/.dev.vars)'); process.exit(2); }
    const body = {};
    if (flag('--script')) body.script = readFileSync(flag('--script'), 'utf8');
    else if (flag('--task')) { body.task = flag('--task'); if (flag('--approval')) body.approval = flag('--approval'); if (flag('--model')) body.model = flag('--model'); }
    else { console.error('usage: timmy cf code --script <file> | --task "<task>" [--approval <token>]'); process.exit(2); }
    const r = await fetch(`${WORKER}/code`, { method: 'POST', headers: { 'content-type': 'application/json', Authorization: `Bearer ${t}` }, body: JSON.stringify(body) });
    const j = await r.json();
    out({ status: r.status, ok: j.ok, run_id: j.run_id, result: j.result, error: j.error, tool_calls: j.tool_calls, receipt: j.receipt?.hash });
    process.exit(r.ok ? 0 : 1);
  }
  case 'workflow': {
    const r = wrangler(['workflows', 'list'], { timeout: 45000 });
    process.stdout.write(`${r.out}\n`); if (!r.ok) process.stderr.write(`${r.err}\n`);
    process.exit(r.ok ? 0 : 1);
  }
  case 'kv': {
    const sub = args.filter((a) => !a.startsWith('--'))[1] ?? 'list';
    const r = sub === 'get'
      ? wrangler(['kv', 'key', 'get', args.filter((a) => !a.startsWith('--'))[2] ?? '', '--namespace-id', KV_ID, '--remote'], { timeout: 45000 })
      : wrangler(['kv', 'key', 'list', '--namespace-id', KV_ID, ...(flag('--prefix') ? ['--prefix', flag('--prefix')] : []), '--remote'], { timeout: 45000 });
    process.stdout.write(`${r.out}\n`); if (!r.ok) process.stderr.write(`${r.err}\n`);
    process.exit(r.ok ? 0 : 1);
  }
  case 'r2': {
    const sub = args.filter((a) => !a.startsWith('--'))[1] ?? 'buckets';
    if (sub === 'buckets') {
      const r = wrangler(['r2', 'bucket', 'list'], { timeout: 45000 });
      process.stdout.write(`${r.out}\n`); if (!r.ok) process.stderr.write(`${r.err}\n`);
      process.exit(r.ok ? 0 : 1);
    }
    const bucket = args.filter((a) => !a.startsWith('--'))[2];
    if (!bucket) { console.error('usage: timmy cf r2 buckets | r2 list <bucket> [--prefix p]'); process.exit(2); }
    const r = wrangler(['r2', 'bucket', 'info', bucket], { timeout: 45000 });
    process.stdout.write(`${r.out}\n`); if (!r.ok) process.stderr.write(`${r.err}\n`);
    console.error('note: wrangler has no object-list command; `r2 list` reports bucket info. Object listing needs the Cloudflare API (CLOUDFLARE_API_TOKEN), which this lane does not read.');
    process.exit(r.ok ? 0 : 1);
  }
  default:
    console.error('usage: timmy cf pane|deploy|tail|code|workflow|kv|r2');
    process.exit(2);
}
