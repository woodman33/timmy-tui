#!/usr/bin/env node
// timmy commander — local client for the durable Commander on timmy-ai-proxy
// (mindship-v5c2 step 2). Speaks the /commander/:room/* contract; `watch`
// opens the WebSocket feed the TUI and the companion use and prints one JSON
// event per line.
//
//   timmy commander state   [--room r] [--worker url]
//   timmy commander spend|turns|receipts|schedules|memory
//   timmy commander think "<task>" [--mode generate|bodybuilder|fusion] [--models a,b] [--judge m] [--no-hands]
//   timmy commander mode <generate|bodybuilder|fusion>
//   timmy commander hold --harness <name> --holder <who> [--note "..."]     → prints the hold token ONCE
//   timmy commander turn --token <hold_token> --did "..." [--asked "..."] [--known "..."] [--model m]
//   timmy commander release --token <hold_token> | --force
//   timmy commander kill [--reason "..."] · revive
//   timmy commander cap <usd>
//   timmy commander schedule "<task>" (--in <seconds> | --at <iso> | --cron "<5 fields>") [--mode m]
//   timmy commander cancel <schedule-id>
//   timmy commander remember <k> <json-or-text> | forget <k>
//   timmy commander watch [--room r]
//   timmy commander ws <cmd> [--json '{...}']   (send one command over the socket)
//
// Auth: TIMMY_EDGE_TOKEN from the environment or workers/ai-proxy/.dev.vars (never printed).
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { edgeUrlOrInert } from '../privacy/overlay.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const has = (k) => args.includes(k);
const positional = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--') && !['--no-hands', '--force', '--json-out'].includes(args[i - 1])));

const WORKER = (flag('--worker', process.env.TIMMY_AI_PROXY ?? edgeUrlOrInert())).replace(/\/$/, '');
const ROOM = flag('--room', process.env.TIMMY_COMMANDER_ROOM ?? 'war-room');

function token() {
  if (process.env.TIMMY_EDGE_TOKEN) return process.env.TIMMY_EDGE_TOKEN;
  const p = join(ROOT, 'workers', 'ai-proxy', '.dev.vars');
  if (!existsSync(p)) return '';
  for (const line of readFileSync(p, 'utf8').split('\n')) if (line.startsWith('TIMMY_EDGE_TOKEN=')) return line.slice('TIMMY_EDGE_TOKEN='.length).trim().replace(/^["']|["']$/g, '');
  return '';
}

const base = `${WORKER}/commander/${encodeURIComponent(ROOM)}`;
const out = (o) => console.log(JSON.stringify(o, null, has('--compact') ? 0 : 1));

async function get(action, qs = '') {
  const r = await fetch(`${base}/${action}${qs}`);
  return { status: r.status, body: await r.json() };
}

async function post(action, body, auth = true) {
  const headers = { 'content-type': 'application/json' };
  if (auth) {
    const t = token();
    if (!t) { console.error('no TIMMY_EDGE_TOKEN (env or workers/ai-proxy/.dev.vars)'); process.exit(2); }
    headers.Authorization = `Bearer ${t}`;
  }
  const r = await fetch(`${base}/${action}`, { method: 'POST', headers, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
}

const cmd = positional[0];
const usage = () => { console.error('usage: timmy commander <state|spend|turns|receipts|schedules|memory|think|mode|hold|turn|release|kill|revive|cap|schedule|cancel|remember|forget|watch|ws> …'); process.exit(2); };
if (!cmd) usage();

let res;
switch (cmd) {
  case 'state': case 'spend': case 'turns': case 'schedules': case 'memory':
    res = await get(cmd); break;
  case 'receipts':
    res = await get('receipts', has('--verify') ? '?verify=1' : `?limit=${flag('--limit', 50)}`); break;
  case 'think': {
    const task = positional[1];
    if (!task) usage();
    const body = { task, hands: !has('--no-hands') };
    if (flag('--mode')) body.mode = flag('--mode');
    if (flag('--models')) body.models = flag('--models').split(',').map((s) => s.trim()).filter(Boolean);
    if (flag('--judge')) body.judge = flag('--judge');
    if (flag('--system')) body.system = flag('--system');
    res = await post('think', body); break;
  }
  case 'mode': res = await post('mode', { mode: positional[1] }); break;
  case 'hold': {
    res = await post('handoff', { harness: flag('--harness'), holder: flag('--holder', process.env.USER ?? 'operator'), note: flag('--note') });
    if (res.body?.hold_token) console.error(`hold token (shown once, never stored): ${res.body.hold_token}`);
    break;
  }
  case 'turn':
    res = await post('turn', { hold_token: flag('--token'), did: flag('--did'), asked: flag('--asked'), known: flag('--known'), model: flag('--model') ?? null, note: flag('--note') }, false); break;
  case 'release':
    res = has('--force') ? await post('release', { force: true }) : await post('release', { hold_token: flag('--token') }, false); break;
  case 'kill': res = await post('kill', { reason: flag('--reason') }); break;
  case 'revive': res = await post('revive', {}); break;
  case 'cap': res = await post('cap', { cap_usd: Number(positional[1]) }); break;
  case 'schedule': {
    const task = positional[1];
    if (!task) usage();
    const body = { task };
    if (flag('--cron')) body.cron = flag('--cron'); else if (flag('--at')) body.at = flag('--at'); else body.in = Number(flag('--in', 60));
    if (flag('--mode')) body.mode = flag('--mode');
    res = await post('schedule', body); break;
  }
  case 'cancel': res = await post('cancel', { id: positional[1] }); break;
  case 'remember': {
    let v = positional.slice(2).join(' ');
    try { v = JSON.parse(v); } catch { /* keep as text */ }
    res = await post('remember', { k: positional[1], v }); break;
  }
  case 'forget': res = await post('remember', { k: positional[1], forget: true }); break;
  case 'watch': case 'ws': {
    const url = `${WORKER.replace(/^http/, 'ws')}/commander/${encodeURIComponent(ROOM)}/ws`;
    const ws = new WebSocket(url);
    const once = cmd === 'ws';
    ws.addEventListener('open', () => {
      console.error(`connected ${url}`);
      if (once) {
        const body = flag('--json') ? JSON.parse(flag('--json')) : {};
        ws.send(JSON.stringify({ cmd: positional[1] ?? 'state', token: token(), body, id: Date.now() }));
      }
    });
    ws.addEventListener('message', (ev) => {
      console.log(String(ev.data));
      if (once) { try { const m = JSON.parse(String(ev.data)); if (m.type === 'commander.reply') { ws.close(); process.exit(m.ok ? 0 : 1); } } catch { /* keep listening */ } }
    });
    ws.addEventListener('close', (ev) => { console.error(`closed ${ev.code}`); process.exit(0); });
    ws.addEventListener('error', (ev) => { console.error(`error ${ev.message ?? ev}`); process.exit(1); });
    await new Promise(() => {});
    break;
  }
  default: usage();
}
out(res.body);
process.exit(res.status < 400 ? 0 : 1);
