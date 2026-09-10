#!/usr/bin/env node
// timmy swarm — the SWARM RUNTIME's local side (ORDER swarm-b3k7).
//
//   timmy swarm list                                      the presets
//   timmy swarm vet [<preset>|<file.cue>]                 cue vet against schemas/swarm.cue
//   timmy swarm show <preset>                             the spec as JSON (what the runtime takes)
//   timmy swarm run <preset|file.cue|file.json> "<task>"  run it: at the edge (durable commander) when every
//        [--room r] [--edge|--local] [--max-tokens N]     member can run there, else here (Ollama slots,
//        [--ctx 8192] [--port 11435] [--no-seal]          harnesses, Timmys over HTTPS); seals swarm.member
//        [--no-record] [--dry]                            per call + swarm.run (+ swarm.airgap when closed)
//   timmy swarm kill [--room r] [--edge]                  local: drops the kill file the governor polls;
//                                                          --edge: the room's kill switch (aborts in-flight)
//   timmy swarm swarms [--room r]                         the room's swarm runs
//   timmy swarm timmys <name,name,…> [--no-seal]          Level 2: push each project's profile.cue into its
//                                                          Timmy Durable Object (project:<name>)
//   timmy swarm fit [--node mac|spark2] [--ctx N]         Level 0 fit math (lanes/swarm/fit.mjs)
//   timmy swarm slots <start|prove|stop|status> …        Level 0 parallel slots (lanes/swarm/slots.mjs)
//   timmy swarm airgap [--json]                           the closed topology's air-gap self-test
//
// Runs under tsx (`timmy swarm …` or `npx tsx lanes/swarm/swarm.mjs …`) so the
// topology code is the worker's own swarm-core.ts: the same fanout / fusion /
// relay / coordinator / tournament / council / crew / closed runs at the edge
// and here, only the member executor differs.
//
// Secrets: OPENROUTER_API_KEY from the environment; TIMMY_EDGE_TOKEN from the
// environment or workers/ai-proxy/.dev.vars. Never printed, never sealed.
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PRESETS, SCHEMA, PRESETS_DIR, presetSpec, vetPreset } from './presets.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const CACHE = join(HERE, '.cache');
const RUNS = join(HERE, 'runs');
const KILL_FILE = join(CACHE, 'kill');
const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf(k); return i >= 0 && args[i + 1] !== undefined && !args[i + 1].startsWith('--') ? args[i + 1] : d; };
const has = (k) => args.includes(k);
const VALUE_FLAGS = new Set(['--room', '--max-tokens', '--ctx', '--port', '--worker', '--node', '--model', '--parallel', '--sizes', '--timeout', '--topology', '--reason', '--limit']);
const positional = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && VALUE_FLAGS.has(args[i - 1])));
const WORKER = (flag('--worker', process.env.TIMMY_AI_PROXY ?? 'https://timmy-ai-proxy-preview.<hostname>')).replace(/\/$/, '');
const ROOM = flag('--room', process.env.TIMMY_COMMANDER_ROOM ?? 'war-room');
const ORDER = 'swarm-b3k7';
const log = (m) => process.stderr.write(`[swarm] ${m}\n`);
const out = (o) => console.log(JSON.stringify(o, null, has('--compact') ? 0 : 1));
const sha = (s) => createHash('sha256').update(s).digest('hex');

function token() {
  if (process.env.TIMMY_EDGE_TOKEN) return process.env.TIMMY_EDGE_TOKEN;
  const p = join(ROOT, 'workers', 'ai-proxy', '.dev.vars');
  if (!existsSync(p)) return '';
  for (const line of readFileSync(p, 'utf8').split('\n')) if (line.startsWith('TIMMY_EDGE_TOKEN=')) return line.slice('TIMMY_EDGE_TOKEN='.length).trim().replace(/^["']|["']$/g, '');
  return '';
}

// ------------------------------------------------------------------ receipts (root store, sequential)

function seal(subject, meta) {
  if (has('--no-seal')) return null;
  const a = ['tsx', 'src/cli.ts', 'seal', subject];
  for (const [k, v] of Object.entries(meta)) if (v != null && v !== '') a.push('--meta', `${k}=${String(typeof v === 'object' ? JSON.stringify(v) : v).replace(/\n/g, ' ').slice(0, 1500)}`);
  const r = spawnSync('npx', a, { cwd: ROOT, encoding: 'utf8' });
  if (r.status !== 0) { process.stderr.write(r.stderr ?? ''); throw new Error(`seal ${subject} failed`); }
  const store = existsSync(join(ROOT, '.timmy', 'store-pin')) ? readFileSync(join(ROOT, '.timmy', 'store-pin'), 'utf8').trim() : join(ROOT, '.timmy', 'receipts');
  const lines = readFileSync(join(store, 'runs.jsonl'), 'utf8').trim().split('\n');
  const last = JSON.parse(lines[lines.length - 1]);
  if (last.subject !== subject) throw new Error(`seal ${subject}: last receipt is ${last.subject}`);
  return last.hash;
}

// ------------------------------------------------------------------ the core (the worker's own topology code)

async function core() {
  return import(new URL('../../workers/ai-proxy/src/swarm-core.ts', import.meta.url).href);
}

// ------------------------------------------------------------------ specs

function cueExport(file) {
  const r = spawnSync('cue', ['export', file, '-e', 'swarm', '--out', 'json'], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`cue export ${file}: ${(r.stderr || '').trim().split('\n')[0]}`);
  return JSON.parse(r.stdout);
}

function vetFile(file) {
  const r = spawnSync('cue', ['vet', '-c', SCHEMA, file], { encoding: 'utf8' });
  return { ok: r.status === 0, note: (r.stderr || r.stdout || '').trim().split('\n').slice(0, 3).join(' ') || 'ok' };
}

/** A preset name, a .cue file, or a .json spec → { spec, source, vet }. JSON specs are vetted through a generated .cue. */
function loadSpec(ref) {
  if (PRESETS[ref]) {
    const file = join(PRESETS_DIR, `${ref}.cue`);
    const vet = existsSync(file) ? vetPreset(file) : { ok: false, note: 'preset .cue missing: run presets.mjs write' };
    return { spec: presetSpec(ref), source: file, vet };
  }
  const file = resolve(ref);
  if (!existsSync(file)) throw new Error(`unknown preset or missing file: ${ref} (presets: ${Object.keys(PRESETS).join(', ')})`);
  if (file.endsWith('.cue')) return { spec: cueExport(file), source: file, vet: vetFile(file) };
  const spec = JSON.parse(readFileSync(file, 'utf8'));
  mkdirSync(CACHE, { recursive: true });
  const tmp = join(CACHE, `vet-${sha(file).slice(0, 8)}.cue`);
  writeFileSync(tmp, `package swarm\n\nswarm: ${JSON.stringify(spec.swarm ?? spec, null, 1)}\n`);
  return { spec: spec.swarm ?? spec, source: file, vet: vetFile(tmp) };
}

// ------------------------------------------------------------------ members (local executors)

function nodes() {
  for (const p of [join(ROOT, 'fleet', 'nodes.json'), resolve(ROOT, '..', 'order-shelf-w6d3', 'fleet', 'nodes.json')]) {
    if (existsSync(p)) return JSON.parse(readFileSync(p, 'utf8')).nodes ?? [];
  }
  return [];
}

async function alive(base) {
  try { const r = await fetch(`${base}/api/version`, { signal: AbortSignal.timeout(4000) }); return r.ok; } catch { return false; }
}

/** Where each ollama:<node> / ollama-cloud member is reached from this machine. */
async function endpoints(spec) {
  const map = {};
  const want = new Set(spec.members.map((m) => m.provider).filter((p) => p && p !== 'openrouter'));
  if (spec.judge.tier === 'local') want.add(spec.members.find((m) => String(m.provider).startsWith('ollama'))?.provider ?? 'ollama:mac');
  for (const p of want) {
    if (p === 'ollama:mac') {
      const port = Number(flag('--port', 11435));
      map[p] = (await alive(`http://127.0.0.1:${port}`)) ? `http://127.0.0.1:${port}` : `http://127.0.0.1:11434`;
    } else if (p === 'ollama-cloud') map[p] = 'http://127.0.0.1:11434';
    else if (p.startsWith('ollama:')) {
      const id = p.slice('ollama:'.length);
      const n = nodes().find((x) => x.id === id);
      map[p] = `http://${n?.tailnet_ip ?? (id === 'spark2' ? '<tailnet-ip>' : id === 'spark1' ? '<tailnet-ip>' : '<tailnet-ip>')}:11434`;
    }
  }
  return map;
}

const blank = (member, model) => ({ role: 'actor', model, ok: false, ms: 0, usd: 0, tokens_in: 0, tokens_out: 0, counted: true, content_sha256: null, error: null, provider_used: null, model_used: null, generation_id: null, tokens_cached: 0, tokens_reasoning: 0, member: member.id, kind: member.kind, content: '', receipt: null });

async function ollamaChat(base, member, model, messages, o, ctx) {
  const started = Date.now();
  const c = blank(member, model);
  try {
    // thinking models (kimi, qwen) would spend the whole num_predict on hidden reasoning: ask for think:false,
    // and retry without the field for a model that does not know it
    const body = (think) => JSON.stringify({ model, messages: messages.map((m) => ({ role: m.role, content: m.content })), stream: false, ...(think ? { think: false } : {}), ...(o.json ? { format: 'json' } : {}), options: { num_ctx: ctx, num_predict: o.maxTokens, temperature: 0.2 } });
    let r = await fetch(`${base}/api/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, signal: o.signal ?? AbortSignal.timeout(600000), body: body(true) });
    let j = await r.json();
    if ((!r.ok || j.error) && /think/i.test(String(j.error ?? ''))) {
      r = await fetch(`${base}/api/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, signal: o.signal ?? AbortSignal.timeout(600000), body: body(false) });
      j = await r.json();
    }
    if (!r.ok || j.error) return { ...c, ms: Date.now() - started, error: `ollama ${r.status}: ${String(j.error ?? '').slice(0, 200)}` };
    const content = String(j.message?.content ?? '') || String(j.message?.thinking ?? '');
    return { ...c, ok: true, ms: Date.now() - started, tokens_in: Number(j.prompt_eval_count ?? 0), tokens_out: Number(j.eval_count ?? 0), content_sha256: sha(content), provider_used: member.provider, model_used: String(j.model ?? model), content, eval_tok_per_s: j.eval_duration ? Math.round((Number(j.eval_count ?? 0) / (Number(j.eval_duration) / 1e9)) * 10) / 10 : null, load_ms: j.load_duration ? Math.round(Number(j.load_duration) / 1e6) : null };
  } catch (e) {
    return { ...c, ms: Date.now() - started, error: e?.name === 'AbortError' || e?.name === 'TimeoutError' ? 'aborted: kill or timeout' : e instanceof Error ? e.message : String(e) };
  }
}

async function openrouterChat(member, model, messages, o) {
  const started = Date.now();
  const c = blank(member, model);
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) return { ...c, error: 'OPENROUTER_API_KEY not in env' };
  try {
    const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST', signal: o.signal,
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${key}`, 'HTTP-Referer': 'https://custody.timmy.dev', 'X-Title': 'TIMMY swarm lane', 'X-OpenRouter-Categories': 'cli-agents,programming', 'X-OpenRouter-Metadata': 'enabled' },
      body: JSON.stringify({ model, messages, max_tokens: o.maxTokens, usage: { include: true }, session_id: `swarm-lane:${ROOM}`, ...(o.json ? { response_format: { type: 'json_object' } } : {}) })
    });
    const j = await r.json();
    if (!r.ok) return { ...c, ms: Date.now() - started, error: `upstream ${r.status}: ${JSON.stringify(j.error ?? j).slice(0, 200)}` };
    const content = String(j.choices?.[0]?.message?.content ?? '');
    const u = j.usage ?? {};
    return { ...c, ok: true, ms: Date.now() - started, usd: Number(u.cost ?? 0), counted: typeof u.cost === 'number', tokens_in: Number(u.prompt_tokens ?? 0), tokens_out: Number(u.completion_tokens ?? 0), tokens_cached: Number(u.prompt_tokens_details?.cached_tokens ?? 0), tokens_reasoning: Number(u.completion_tokens_details?.reasoning_tokens ?? 0), provider_used: j.provider ?? null, model_used: j.model ?? null, generation_id: j.id ?? null, content_sha256: sha(content), content };
  } catch (e) {
    return { ...c, ms: Date.now() - started, error: e?.name === 'AbortError' ? 'aborted: kill' : e instanceof Error ? e.message : String(e) };
  }
}

async function timmyThink(member, messages, o) {
  const started = Date.now();
  const c = blank(member, `timmy:${member.room}`);
  const t = token();
  if (!t) return { ...c, error: 'no TIMMY_EDGE_TOKEN' };
  const system = messages.find((m) => m.role === 'system')?.content;
  const task = messages.filter((m) => m.role === 'user').map((m) => m.content).join('\n\n');
  try {
    const r = await fetch(`${WORKER}/timmy/${encodeURIComponent(member.room)}/think`, { method: 'POST', signal: o.signal, headers: { 'content-type': 'application/json', Authorization: `Bearer ${t}` }, body: JSON.stringify({ task, ...(system ? { system } : {}), max_tokens: o.maxTokens, by: `swarm-lane:${ROOM}` }) });
    const j = await r.json();
    if (!r.ok || !j.ok) return { ...c, ms: Date.now() - started, usd: Number(j.usd ?? 0), error: `timmy ${member.room}: ${j.error ?? `HTTP ${r.status}`}` };
    const content = String(j.answer ?? '');
    return { ...c, ok: true, ms: Date.now() - started, usd: Number(j.usd ?? 0), provider_used: 'timmy', model_used: (j.models ?? []).map((m) => m.model).join(','), content_sha256: sha(content), content, receipt_external: j.receipt ?? null };
  } catch (e) {
    return { ...c, ms: Date.now() - started, error: e instanceof Error ? e.message : String(e) };
  }
}

// ---- harnesses: the launch plans measured by lanes/abilities (harnesses.json), one isolated home per member per run

function harnessPlan() {
  return JSON.parse(readFileSync(join(ROOT, 'lanes', 'abilities', 'harnesses.json'), 'utf8')).harnesses;
}

function fill(v, ctx) { return typeof v === 'string' ? v.replace(/\{(BIN|MODEL|HOME|CWD|PROMPT|SCRATCH|TSX|CLI|WORKTREE|HOMEDIR)\}/g, (_, k) => ctx[k] ?? '') : v; }
function fillDeep(v, ctx) { return Array.isArray(v) ? v.map((x) => fillDeep(x, ctx)) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fillDeep(x, ctx)])) : fill(v, ctx); }

/** What a harness printed, reduced to its answer text (jcode ndjson, opencode json lines, hermes/pi plain). */
export function extractAnswer(harness, stdout) {
  const lines = stdout.split('\n').filter(Boolean);
  const texts = [];
  for (const l of lines) {
    let j; try { j = JSON.parse(l); } catch { continue; }
    if (harness === 'jcode' && j.type === 'text_delta' && typeof j.text === 'string') texts.push(j.text);
    else if (harness === 'opencode' && (j.type === 'text' || j.type === 'message') && typeof (j.part?.text ?? j.text) === 'string') texts.push(j.part?.text ?? j.text);
    else if (harness === 'pi' && (j.type === 'text' || j.type === 'assistant') && typeof (j.text ?? j.content) === 'string') texts.push(j.text ?? j.content);
  }
  if (texts.length) return texts.join('');
  return stdout.trim().slice(-4000);
}

async function harnessRun(member, messages, o, runId) {
  const started = Date.now();
  const h = harnessPlan()[member.harness];
  const c = blank(member, `${member.harness}:${member.model ?? h?.model ?? ''}`);
  if (!h) return { ...c, error: `no launch plan for harness ${member.harness} in lanes/abilities/harnesses.json` };
  if (!existsSync(h.bin)) return { ...c, error: `harness binary missing: ${h.bin}` };
  const home = join(CACHE, 'harness', runId, member.id, 'home');
  const cwd = join(CACHE, 'harness', runId, member.id, 'work');
  mkdirSync(home, { recursive: true }); mkdirSync(cwd, { recursive: true });
  const prompt = messages.map((m) => (m.role === 'system' ? `(${m.content})` : m.content)).join('\n\n');
  const ctx = { BIN: h.bin, MODEL: member.model ?? h.model, HOME: home, CWD: cwd, PROMPT: prompt, SCRATCH: join(CACHE, 'harness', runId), TSX: join(ROOT, 'node_modules', '.bin', 'tsx'), CLI: join(ROOT, 'src', 'cli.ts'), WORKTREE: ROOT, HOMEDIR: homedir() };
  for (const f of h.setup_files ?? []) { const p = fill(f.path, ctx); mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, f.json ? JSON.stringify(fillDeep(f.json, ctx), null, 1) : fill(f.text ?? '', ctx)); }
  const plan = (Array.isArray(h.probes) ? h.probes.find((p) => p.name === 'one_shot') : h.probes?.one_shot) ?? { argv: ['...base', '{PROMPT}'] };
  const argv = plan.argv.flatMap((a) => (a === '...base' ? h.base_argv ?? [] : [a])).map((a) => fill(a, ctx));
  const env = { ...process.env };
  for (const [k, v] of Object.entries(h.env ?? {})) env[k] = v === '$OPENROUTER_API_KEY' ? (process.env.OPENROUTER_API_KEY ?? '') : fill(v, ctx);
  const timeout = Number(flag('--timeout', 300000));
  const r = await new Promise((res) => {
    let stdout = '', stderr = '', done = false;
    const child = spawn(argv[0], argv.slice(1), { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    const timer = setTimeout(() => { if (!done) { try { process.kill(-child.pid, 'SIGTERM'); } catch { /* gone */ } setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ } }, 3000); } }, timeout);
    const onAbort = () => { try { process.kill(-child.pid, 'SIGTERM'); } catch { /* gone */ } };
    o.signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('exit', (code, signal) => { done = true; clearTimeout(timer); o.signal?.removeEventListener('abort', onAbort); res({ code, signal, stdout, stderr }); });
    child.on('error', (e) => { done = true; clearTimeout(timer); res({ code: -1, signal: null, stdout, stderr: stderr + String(e) }); });
  });
  const content = extractAnswer(member.harness, r.stdout).replace(prompt, '').trim();
  const ok = r.code === 0 && !!content;
  const tlog = join(CACHE, 'harness', runId, member.id, 'transcript.json');
  const redact = (s) => String(s).replace(/sk-or-v1-[A-Za-z0-9]+/g, '[redacted]');
  writeFileSync(tlog, JSON.stringify({ argv: argv.map((a) => (a === prompt ? '{PROMPT}' : a)), cwd, exit: r.code, signal: r.signal, stdout: redact(r.stdout).slice(0, 20000), stderr: redact(r.stderr).slice(0, 8000), ms: Date.now() - started }, null, 1));
  return { ...c, ok, ms: Date.now() - started, provider_used: `harness:${member.harness}`, model_used: ctx.MODEL, content_sha256: content ? sha(content) : null, content, error: ok ? null : `exit ${r.code}${r.signal ? ' ' + r.signal : ''}${content ? '' : ' (no answer)'}: ${redact(r.stderr).trim().split('\n').slice(-2).join(' ').slice(0, 200)}`, transcript: tlog };
}

function loadAbilities() {
  const dir = join(ROOT, 'lanes', 'abilities', 'results');
  const out = {};
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.json'))) {
    try { const j = JSON.parse(readFileSync(join(dir, f), 'utf8')); out[j.harness ?? f.replace('.json', '')] = Object.fromEntries(Object.entries(j.abilities ?? {}).map(([k, v]) => [k, v?.value === true])); } catch { /* skip */ }
  }
  return out;
}

/** True when the durable commander can run every member and the judge itself. */
function edgeRunnable(spec) {
  return spec.topology !== 'closed' && spec.judge.tier === 'edge' && spec.members.every((m) => (m.kind === 'model' && m.provider === 'openrouter') || m.kind === 'timmy');
}

async function post(path, body, auth = true) {
  const headers = { 'content-type': 'application/json' };
  if (auth) { const t = token(); if (!t) throw new Error('no TIMMY_EDGE_TOKEN (env or workers/ai-proxy/.dev.vars)'); headers.Authorization = `Bearer ${t}`; }
  const r = await fetch(`${WORKER}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
}

// ------------------------------------------------------------------ run

async function run() {
  const ref = positional[1];
  const task = positional[2];
  if (!ref || !task) { console.error('usage: timmy swarm run <preset|file> "<task>" [--room r] [--edge|--local] [--max-tokens N] [--ctx N] [--port 11435] [--no-seal] [--no-record] [--dry]'); process.exit(2); }
  const { parseSwarmSpec, runSwarm, swarmReceiptData, memberReceiptData } = await core();
  const loaded = loadSpec(ref);
  if (!loaded.vet.ok) throw new Error(`spec fails cue vet: ${loaded.vet.note}`);
  // --topology lets one preset prove two shapes (the order's "fanout+fusion" on the same five slots); the rules still apply
  const spec = parseSwarmSpec(flag('--topology') ? { ...loaded.spec, topology: flag('--topology'), id: `${loaded.spec.id}-${flag('--topology')}` } : loaded.spec);
  const maxTokens = Number(flag('--max-tokens', 1024));
  const ctx = Number(flag('--ctx', 8192));
  const atEdge = has('--edge') || (!has('--local') && edgeRunnable(spec));
  const specSha = sha(JSON.stringify(spec));
  log(`spec ${spec.id} (${spec.topology}, ${spec.size} members, budget $${spec.budget.usd}) vet ok · ${atEdge ? 'edge run on room ' + ROOM : 'local run'}`);
  mkdirSync(RUNS, { recursive: true });

  if (atEdge) {
    if (has('--dry')) { out({ dry: true, where: 'edge', room: ROOM, spec }); return; }
    const res = await post(`/commander/${encodeURIComponent(ROOM)}/swarm`, { spec, task, max_tokens: maxTokens });
    if (res.status >= 400) { out(res.body); process.exit(1); }
    const b = res.body;
    const memberReceipts = (b.calls ?? []).map((c) => c.receipt).filter(Boolean);
    const receipt = seal('swarm.run', { run_id: b.run_id, swarm_id: spec.id, preset: spec.preset ?? '', topology: spec.topology, size: spec.size, where: 'edge', room: ROOM, ok: b.ok, task_sha256: sha(task), answer_sha256: sha(String(b.answer ?? '')), spec_sha256: specSha, edge_receipt: b.receipt?.hash, member_receipts: memberReceipts.join(','), members: spec.members.map((m) => m.id).join(','), winner: b.winner ?? '', losers: (b.losers ?? []).join(','), votes: b.votes ? JSON.stringify(b.votes) : '', roles: b.roles ? JSON.stringify(b.roles) : '', calls: (b.calls ?? []).length, killed: (b.calls ?? []).filter((c) => c.killed).length, budget_usd: spec.budget.usd, spent_usd: b.usd, ms: b.ms, judge: `${spec.judge.tier}:${spec.judge.model ?? ''}`, network: spec.network.policy, order: ORDER });
    const rec = { where: 'edge', room: ROOM, worker: WORKER, spec, task, result: b, receipt };
    writeFileSync(join(RUNS, `${b.run_id}.json`), JSON.stringify(rec, null, 1));
    out({ ok: b.ok, where: 'edge', run_id: b.run_id, topology: spec.topology, answer: b.answer, winner: b.winner, losers: b.losers, votes: b.votes, roles: b.roles, calls: b.calls, budget: b.budget, usd: b.usd, ms: b.ms, edge_receipt: b.receipt?.hash, receipt, run_file: join(RUNS, `${b.run_id}.json`) });
    process.exit(b.ok ? 0 : 1);
  }

  // ---- local run
  const eps = await endpoints(spec);
  const abilities = loadAbilities();
  const runId = `swarm_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  try { unlinkSync(KILL_FILE); } catch { /* none */ }
  const ac = new AbortController();
  const sealed = [];
  const closed = spec.topology === 'closed';
  let airgap = null;
  if (closed) {
    airgap = await import('./airgap.mjs');
    for (const [p, base] of Object.entries(eps)) if (!airgap.isPrivateEndpoint(base)) throw new Error(`closed swarm: endpoint for ${p} is not private: ${base}`);
  }
  const callMember = async (m, messages, o) => {
    let c;
    if (has('--dry')) c = { ...blank(m, m.model ?? m.harness ?? m.room), ok: true, content: `(dry) ${m.id} answers`, content_sha256: sha(`(dry) ${m.id} answers`) };
    else if (m.kind === 'model' && m.provider === 'openrouter') c = await openrouterChat(m, m.model, messages, o);
    else if (m.kind === 'model') c = await ollamaChat(eps[m.provider], m, m.model, messages, o, ctx);
    else if (m.kind === 'timmy') c = await timmyThink(m, messages, o);
    else c = await harnessRun(m, messages, o, runId);
    if (closed && airgap && c.content && /async\s*\(/.test(c.content)) {
      // hands under sbx deny-all: a member's script never leaves the air gap
      const script = c.content.slice(c.content.indexOf('async'));
      const h = await airgap.runHandsClosed(`return (${script})()`, { context: {}, timeout: 10000 });
      c.hands = { ok: h.ok, exception: h.exception ? String(h.exception).slice(0, 200) : null, ms: h.ms, sandbox: 'sbx-lockdown' };
    }
    const receipt = seal('swarm.member', { run_id: runId, swarm_id: spec.id, topology: spec.topology, member: c.member, kind: c.kind, phase: o.phase, round: o.round ?? '', node: m.node, model: c.model, provider: m.provider ?? m.harness ?? 'timmy', endpoint: m.kind === 'model' && m.provider !== 'openrouter' ? eps[m.provider] : '', provider_used: c.provider_used ?? '', model_used: c.model_used ?? '', generation_id: c.generation_id ?? '', ok: c.ok, ms: c.ms, usd: c.usd, tokens_in: c.tokens_in, tokens_out: c.tokens_out, eval_tok_per_s: c.eval_tok_per_s ?? '', task_sha256: sha(task), content_sha256: c.content_sha256 ?? '', external_receipt: c.receipt_external ?? '', transcript: c.transcript ?? '', hands: c.hands ? JSON.stringify(c.hands) : '', error: c.error ?? '', order: ORDER });
    sealed.push({ member: c.member, phase: o.phase, receipt });
    log(`${c.member.padEnd(10)} ${o.phase.padEnd(10)} ${c.ok ? 'ok ' : 'FAIL'} ${String(c.ms).padStart(6)} ms  ${c.tokens_out} tok${c.eval_tok_per_s ? ' @ ' + c.eval_tok_per_s + ' tok/s' : ''}${c.usd ? ' $' + c.usd : ''}${c.error ? '  ' + c.error.slice(0, 80) : ''}`);
    return { ...c, receipt };
  };
  const judgeMember = { id: 'judge', kind: 'model', node: spec.judge.tier === 'edge' ? 'edge' : 'mac', sandbox: 'none', weight: 1, model: spec.judge.model, provider: spec.judge.tier === 'edge' ? 'openrouter' : (spec.members.find((m) => String(m.provider).startsWith('ollama'))?.provider ?? 'ollama:mac') };
  const judge = (messages, o) => callMember(judgeMember, messages, o);
  const gate = () => (existsSync(KILL_FILE) ? 'kill file (timmy swarm kill)' : null);
  const started = Date.now();
  const runIt = () => runSwarm(spec, task, { exec: callMember, judge, signal: ac.signal, maxTokens, abilities, gate });
  let result;
  let snoop = null;
  if (closed && airgap) {
    // the whole run happens on a snooped MCP wire to Timmy's own server; the export proves zero egress
    snoop = await airgap.snoopSession(`swarm-${spec.id}`, async (call) => { result = await runIt(); await call('timmy_env_lock', {}); }, { egressRe: /fetch|http|browser|web|url|openrouter|curl|llm_call|gen_run|apify|openhands|roboflow|allyson|oapi|promo/i });
  } else {
    result = await runIt();
  }
  result = { ...result, run_id: runId };
  const data = await swarmReceiptData(spec, task, result, 'lane', { where: 'local', endpoints: eps });
  const memberReceipts = result.calls.map((c) => c.receipt).filter(Boolean);
  const receipt = seal('swarm.run', { run_id: runId, swarm_id: spec.id, preset: spec.preset ?? '', topology: spec.topology, size: spec.size, where: 'local', room: ROOM, ok: result.ok, task_sha256: data.task_sha256, answer_sha256: data.answer_sha256, spec_sha256: specSha, member_receipts: memberReceipts.join(','), members: spec.members.map((m) => `${m.id}:${m.kind}:${m.provider ?? m.harness ?? m.room}`).join(','), endpoints: JSON.stringify(eps), winner: result.winner ?? '', losers: result.losers.join(','), votes: result.votes ? JSON.stringify(result.votes) : '', roles: result.roles ? JSON.stringify(result.roles) : '', rounds: result.rounds.length, calls: result.calls.length, killed: result.budget.kills.length, budget_usd: spec.budget.usd, budget_max_calls: spec.budget.max_calls, spent_usd: result.usd, exhausted: result.budget.exhausted ?? '', ms: Date.now() - started, judge: `${spec.judge.tier}:${spec.judge.model ?? ''}`, network: spec.network.policy, order: ORDER });
  let airgapReceipt = null;
  if (closed && airgap) {
    const policy = airgap.policyFor(spec);
    airgapReceipt = seal('swarm.airgap', { run_id: runId, swarm_id: spec.id, swarm_run: receipt, policy: JSON.stringify(policy), policy_sha256: airgap.policyHash(policy), egress: snoop?.egress ?? 'n/a', egress_tools: (snoop?.egress_tools ?? []).join(','), wire_frames: snoop?.frames ?? '', wire_tool_calls: (snoop?.tool_calls ?? []).length, tools_listed: snoop?.tools_listed ?? '', snoop_session: snoop?.session_file ?? '', endpoints: JSON.stringify(eps), endpoints_private: Object.values(eps).every((b) => airgap.isPrivateEndpoint(b)), hands: 'sbx-lockdown', hands_runs: result.calls.filter((c) => c.hands).length, members: spec.size, order: ORDER });
  }
  if (!has('--no-record') && !has('--no-seal')) {
    try {
      const res = await post(`/commander/${encodeURIComponent(ROOM)}/swarm`, { record: { spec, task, result: { ...result, calls: result.calls.map((c) => ({ ...c, content: '' })) }, by: 'lane', extra: { root_receipt: receipt, ...(airgapReceipt ? { airgap_receipt: airgapReceipt } : {}) } } });
      if (res.status >= 400) log(`record on ${ROOM} refused: ${res.status} ${res.body?.error ?? ''}`); else log(`recorded on ${ROOM}: ${res.body.receipt?.hash}`);
      result.recorded = res.body?.receipt?.hash ?? null;
    } catch (e) { log(`record on ${ROOM} failed: ${e.message}`); }
  }
  const file = join(RUNS, `${runId}.json`);
  writeFileSync(file, JSON.stringify({ where: 'local', room: ROOM, spec, task, endpoints: eps, result, sealed, receipt, airgap_receipt: airgapReceipt, snoop: snoop ? { egress: snoop.egress, frames: snoop.frames, session_file: snoop.session_file } : null }, null, 1));
  out({ ok: result.ok, where: 'local', run_id: runId, topology: spec.topology, endpoints: eps, answer: result.answer, winner: result.winner, losers: result.losers, votes: result.votes, roles: result.roles, assignments: result.assignments, calls: result.calls.map((c) => ({ member: c.member, phase: c.phase, round: c.round, model: c.model, ok: c.ok, killed: !!c.killed, ms: c.ms, usd: c.usd, tokens_out: c.tokens_out, eval_tok_per_s: c.eval_tok_per_s ?? null, receipt: c.receipt, external_receipt: c.receipt_external ?? null, error: c.error, preview: c.content.slice(0, 200) })), budget: result.budget, usd: result.usd, ms: Date.now() - started, receipt, airgap_receipt: airgapReceipt, egress: snoop?.egress ?? null, recorded: result.recorded ?? null, run_file: file });
  process.exit(result.ok ? 0 : 1);
}

// ------------------------------------------------------------------ timmys (Level 2)

async function timmys() {
  const names = (positional[1] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!names.length) { console.error('usage: timmy swarm timmys <name,name,…>'); process.exit(2); }
  const results = [];
  for (const name of names) {
    const dir = join(homedir(), 'timmy', 'projects', name);
    const file = join(dir, 'profile.cue');
    if (!existsSync(file)) { results.push({ name, ok: false, error: `no profile: ${file}` }); continue; }
    const r = spawnSync('cue', ['export', file, '-e', 'profile', '--out', 'json'], { encoding: 'utf8' });
    if (r.status !== 0) { results.push({ name, ok: false, error: `cue export: ${(r.stderr || '').trim().split('\n')[0]}` }); continue; }
    const p = JSON.parse(r.stdout);
    const body = { name: p.name, owner: p.owner, budget_usd: p.budget?.max_spend_usd ?? 2, mind: p.models?.mind ?? null, actors: p.models?.actors ?? [], standard: p.standard ?? null, profile_sha256: sha(readFileSync(file, 'utf8')) };
    const room = `project:${name}`;
    const res = await post(`/timmy/${encodeURIComponent(room)}/profile`, body);
    const ok = res.status < 400 && res.body?.ok;
    const receipt = ok ? seal('timmy.profile', { room, project: name, dir, profile_sha256: body.profile_sha256, budget_usd: body.budget_usd, mind: body.mind ?? '', actors: body.actors.join(','), edge_receipt: res.body.receipt, worker: WORKER, order: ORDER }) : null;
    results.push({ name, room, ok, status: res.status, edge_receipt: res.body?.receipt ?? null, receipt, error: ok ? null : res.body?.error ?? null, profile: ok ? res.body.profile : null });
    log(`${room}: ${ok ? 'profile set' : 'FAILED'} ${res.body?.error ?? ''}`);
  }
  out({ ok: results.every((r) => r.ok), timmys: results });
  process.exit(results.every((r) => r.ok) ? 0 : 1);
}

// ------------------------------------------------------------------ dispatch

const cmd = positional[0];
try {
  switch (cmd) {
    case 'list': {
      for (const [name, p] of Object.entries(PRESETS)) console.log(`${name.padEnd(14)} ${p.swarm.topology.padEnd(12)} size ${p.swarm.members.length}  budget $${p.swarm.budget.usd}  judge ${p.swarm.judge.tier}${p.swarm.judge.model ? ' ' + p.swarm.judge.model : ''}  net ${p.swarm.network.policy}  ${edgeRunnable(presetSpec(name)) ? 'edge' : 'local'}`);
      break;
    }
    case 'vet': {
      if (positional[1]) { const l = loadSpec(positional[1]); out({ ok: l.vet.ok, source: l.source, vet: l.vet.note, schema: SCHEMA }); process.exit(l.vet.ok ? 0 : 1); }
      const r = spawnSync('node', [join(HERE, 'presets.mjs'), 'vet'], { encoding: 'utf8' }); process.stdout.write(r.stdout); process.exit(r.status ?? 1);
      break;
    }
    case 'show': { const l = loadSpec(positional[1] ?? ''); out({ source: l.source, vet: l.vet, where: edgeRunnable(l.spec) ? 'edge' : 'local', spec: l.spec }); break; }
    case 'run': await run(); break;
    case 'kill': {
      if (has('--edge')) { const res = await post(`/commander/${encodeURIComponent(ROOM)}/kill`, { reason: flag('--reason', 'timmy swarm kill') }); out(res.body); process.exit(res.status < 400 ? 0 : 1); }
      mkdirSync(CACHE, { recursive: true }); writeFileSync(KILL_FILE, new Date().toISOString()); out({ ok: true, kill_file: KILL_FILE, note: 'the local governor refuses every further call; the file is cleared when the next run starts' });
      break;
    }
    case 'swarms': { const r = await fetch(`${WORKER}/commander/${encodeURIComponent(ROOM)}/swarms?limit=${flag('--limit', 20)}`); out(await r.json()); break; }
    case 'timmys': await timmys(); break;
    case 'fit': case 'slots': case 'airgap': {
      const file = join(HERE, cmd === 'fit' ? 'fit.mjs' : cmd === 'slots' ? 'slots.mjs' : 'airgap.mjs');
      const r = spawnSync('node', [file, ...args.slice(1)], { stdio: 'inherit' }); process.exit(r.status ?? 1);
      break;
    }
    case 'clean': { rmSync(join(CACHE, 'harness'), { recursive: true, force: true }); out({ ok: true, cleaned: join(CACHE, 'harness') }); break; }
    default:
      console.error('usage: timmy swarm <list|vet|show|run|kill|swarms|timmys|fit|slots|airgap|clean> …');
      process.exit(2);
  }
} catch (e) {
  console.error(`[swarm] ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}
