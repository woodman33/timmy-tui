#!/usr/bin/env node
// Swarm slots — start and prove N parallel Ollama slots on a SECOND server that
// never touches the user's primary Ollama on :11434 (Ollama.app on the mac, the
// engine-room serve on spark2): its own port, its own pid file, its own log, and
// the shared model store opened with OLLAMA_NOPRUNE=1 so it never deletes a blob.
//
//   node lanes/swarm/slots.mjs start  --node mac|spark2 --parallel 5 [--model qwen3.8:27b-mlx] [--port 11435] [--ctx 8192] [--models ~/.ollama/models] [--no-warm]
//   node lanes/swarm/slots.mjs prove  --node mac|spark2 --parallel 5 [--model …] [--port 11435] [--ctx 8192] [--json] [--no-warm] [--solo-runs 2|--no-solo]
//   node lanes/swarm/slots.mjs stop   --node mac|spark2 [--port 11435]
//   node lanes/swarm/slots.mjs status --node mac|spark2 [--port 11435]
//
// mac    = this machine: `ollama serve` spawned detached with OLLAMA_HOST=127.0.0.1:<port> OLLAMA_NUM_PARALLEL=<N>
//          OLLAMA_KEEP_ALIVE=30m OLLAMA_MODELS=<dir>; log lanes/swarm/.cache/ollama-<port>.log, pid lanes/swarm/.cache/ollama-<port>.pid.
// spark2 = the same verbs over Tailscale SSH (BatchMode, ConnectTimeout 15 s); the server binds 0.0.0.0:<port> so `prove`
//          can reach it over the tailnet; unreachable → {ok:false, reason} and exit 3, never a hang.
// prove  = N concurrent POST /api/chat (stream:false, num_ctx) with N distinct prompts; overlap_ratio = Σ per-call ms / wall ms;
//          overlap_ratio > 1.5 with N ≥ 2 is `overlap_proven` (the order's criterion). Because a queue of N calls also scores
//          > 1.5 (call k waits for calls 1..k−1), `slots_proven` also needs the runner's own compute time to overlap:
//          work_overlap = Σ(prompt_eval_duration + eval_duration) / wall > 1.5 (≈ 1 means it served them one at a time).
//          A solo baseline gives speedup_vs_solo = N × solo_ms / wall, the throughput truth, reported separately.
//          300 s AbortController per call.
// Receipts are NOT sealed here — the caller seals.
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const HERE = join(ROOT, 'lanes', 'swarm');
const CACHE = join(HERE, '.cache');
const SIBLING_NODES = '<repo>/fleet/nodes.json';
const PROTECTED_PORT = 11434;
const DEFAULT_MODEL = { mac: 'qwen3.8:27b-mlx', spark2: 'hf.co/unsloth/Qwen3.8-27B-GGUF:UD-Q8_K_XL' };

const args = process.argv.slice(2);
const BOOL = new Set(['--json', '--no-warm', '--no-solo']);
const flag = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const has = (k) => args.includes(k);
const positional = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--') && !BOOL.has(args[i - 1])));
const cmd = positional[0] ?? 'status';
const out = (o) => console.log(JSON.stringify(o, null, 1));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rel = (p) => relative(ROOT, p);
const logPath = (port) => join(CACHE, `ollama-${port}.log`);
const pidPath = (port) => join(CACHE, `ollama-${port}.pid`);
const readPid = (port) => existsSync(pidPath(port)) ? Number(readFileSync(pidPath(port), 'utf8').trim()) || null : null;
const tail = (p, n = 5) => existsSync(p) ? readFileSync(p, 'utf8').trim().split('\n').slice(-n) : [];

// ------------------------------------------------------------------ nodes

function nodeEntry(id) {
  if (id === 'mac') return { id: 'mac', kind: 'local' };
  const file = [join(ROOT, 'fleet', 'nodes.json'), SIBLING_NODES].find((p) => existsSync(p));
  if (!file) throw new Error(`no fleet/nodes.json in this worktree and none at ${SIBLING_NODES}`);
  const nodes = JSON.parse(readFileSync(file, 'utf8')).nodes;
  const n = nodes.find((x) => x.id === id || x.tailnet_name === id);
  if (!n) throw new Error(`unknown node ${id}; ${rel(file) || file} has ${nodes.map((x) => x.id).join(', ')}`);
  return { ...n, kind: 'ssh', nodes_file: file };
}
const baseUrl = (n, port) => n.kind === 'local' ? `http://127.0.0.1:${port}` : `http://${n.tailnet_ip}:${port}`;

/** Run one remote command over Tailscale SSH (BatchMode: never prompts; bounded by ConnectTimeout + spawn timeout). */
function ssh(n, script, { timeout = 60000 } = {}) {
  const host = n.tailnet_ip ?? n.tailnet_name;
  const target = n.ssh_user ? `${n.ssh_user}@${host}` : host; // Tailscale SSH policy names the remote user; the Mac login name is not it
  console.error(`$ ssh ${target} ${script.slice(0, 140).replace(/\n/g, ' ')}${script.length > 140 ? '…' : ''}`);
  const r = spawnSync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '-o', 'StrictHostKeyChecking=accept-new', target, script], { encoding: 'utf8', timeout, maxBuffer: 16 * 1024 * 1024 });
  return { ok: r.status === 0, status: r.status, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim(), timed_out: r.error?.code === 'ETIMEDOUT' };
}

function reach(n) {
  const r = ssh(n, 'echo ok', { timeout: 30000 });
  if (r.ok && r.out.endsWith('ok')) return { ok: true };
  return { ok: false, node: n.id, reason: r.timed_out ? `ssh to ${n.tailnet_ip} timed out (30 s)` : (r.err.split('\n').filter(Boolean).pop() || `ssh exit ${r.status}`), exit: 3 };
}

function parseKv(text) { const o = {}; for (const l of text.split('\n')) { const i = l.indexOf('='); if (i > 0) o[l.slice(0, i)] = l.slice(i + 1); } return o; }

// ------------------------------------------------------------------ http (never hangs)

async function http(url, { method = 'GET', body, timeoutMs = 8000 } = {}) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  const started = performance.now();
  try {
    const r = await fetch(url, { method, headers: body ? { 'content-type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined, signal: ac.signal });
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
    return { ok: r.ok, status: r.status, json, text, ms: Math.round(performance.now() - started) };
  } catch (e) {
    return { ok: false, status: 0, json: null, text: '', ms: Math.round(performance.now() - started), error: e.name === 'AbortError' ? `timeout after ${timeoutMs} ms` : (e.cause?.code ?? e.message) };
  } finally { clearTimeout(t); }
}

async function waitVersion(base, maxMs, isDead = () => false) {
  const started = Date.now();
  while (Date.now() - started < maxMs) {
    const r = await http(`${base}/api/version`, { timeoutMs: 2000 });
    if (r.ok) return r.json?.version ?? 'unknown';
    if (isDead()) return null;
    await sleep(500);
  }
  return null;
}

/** Load the model with num_ctx (empty prompt = load only) so slots are allocated before anyone times a call. */
async function warm(base, model, ctx) {
  const r = await http(`${base}/api/generate`, { method: 'POST', timeoutMs: 300000, body: { model, prompt: '', keep_alive: '30m', options: { num_ctx: ctx } } });
  return { ok: r.ok && !r.json?.error, ms: r.ms, error: r.ok && !r.json?.error ? null : (r.json?.error ?? r.error ?? `http ${r.status}`) };
}

// ------------------------------------------------------------------ mac (local) verbs

async function startLocal({ port, parallel, model, ctx, modelsDir, doWarm }) {
  const base = baseUrl({ kind: 'local' }, port);
  const v = await http(`${base}/api/version`, { timeoutMs: 3000 });
  if (v.ok) {
    const res = { ok: true, node: 'mac', port, already_running: true, version: v.json?.version, pid: readPid(port), note: `a server already answers on ${base}; not spawning another (stop it first to change --parallel)` };
    if (doWarm) res.warm = await warm(base, model, ctx);
    res.ps = (await http(`${base}/api/ps`)).json ?? null;
    return res;
  }
  mkdirSync(CACHE, { recursive: true });
  writeFileSync(join(CACHE, '.gitignore'), 'ollama-*.log\nollama-*.pid\n'); // only this lane's runtime files; other lanes share .cache
  const env = { ...process.env, OLLAMA_HOST: `127.0.0.1:${port}`, OLLAMA_NUM_PARALLEL: String(parallel), OLLAMA_KEEP_ALIVE: '30m', OLLAMA_MODELS: modelsDir, OLLAMA_NOPRUNE: '1' };
  const shown = { OLLAMA_HOST: env.OLLAMA_HOST, OLLAMA_NUM_PARALLEL: env.OLLAMA_NUM_PARALLEL, OLLAMA_KEEP_ALIVE: env.OLLAMA_KEEP_ALIVE, OLLAMA_MODELS: env.OLLAMA_MODELS, OLLAMA_NOPRUNE: env.OLLAMA_NOPRUNE };
  console.error(`$ ${Object.entries(shown).map(([k, v]) => `${k}=${v}`).join(' ')} ollama serve  (detached → ${rel(logPath(port))})`);
  const fd = openSync(logPath(port), 'a');
  let spawnError = null;
  const child = spawn('ollama', ['serve'], { detached: true, stdio: ['ignore', fd, fd], env });
  child.on('error', (e) => { spawnError = e; });
  child.unref();
  closeSync(fd);
  writeFileSync(pidPath(port), `${child.pid ?? ''}\n`);
  const version = await waitVersion(base, 30000, () => spawnError || child.exitCode != null);
  if (!version) {
    if (existsSync(pidPath(port))) unlinkSync(pidPath(port));
    return { ok: false, node: 'mac', port, pid: child.pid ?? null, reason: spawnError ? `spawn failed: ${spawnError.message}` : child.exitCode != null ? `ollama serve exited ${child.exitCode}` : 'no /api/version answer within 30 s', log: rel(logPath(port)), log_tail: tail(logPath(port)), exit: 1 };
  }
  const res = { ok: true, node: 'mac', port, pid: child.pid, version, parallel, model, ctx, models_dir: modelsDir, env: shown, log: rel(logPath(port)), pid_file: rel(pidPath(port)) };
  if (doWarm) res.warm = await warm(base, model, ctx);
  res.ps = (await http(`${base}/api/ps`)).json ?? null;
  res.next = `node lanes/swarm/slots.mjs prove --node mac --parallel ${parallel} --model ${model} --port ${port} --ctx ${ctx} --json`;
  return res;
}

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

async function stopLocal(port) {
  const pid = readPid(port);
  if (!pid) return { ok: false, node: 'mac', port, reason: `no pid file ${rel(pidPath(port))}; this lane only stops servers it started`, exit: 1 };
  const command = (spawnSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' }).stdout ?? '').trim();
  if (!command) { unlinkSync(pidPath(port)); return { ok: true, node: 'mac', port, pid, already_stopped: true }; }
  if (!/ollama/.test(command) || !/serve/.test(command)) return { ok: false, node: 'mac', port, pid, reason: `pid ${pid} is not an "ollama serve" process (${command.slice(0, 80)}); refusing to kill it`, exit: 1 };
  const primary = (spawnSync('lsof', ['-nP', `-tiTCP:${PROTECTED_PORT}`, '-sTCP:LISTEN'], { encoding: 'utf8' }).stdout ?? '').split('\n').map(Number);
  if (primary.includes(pid)) return { ok: false, node: 'mac', port, pid, reason: `pid ${pid} is the listener on :${PROTECTED_PORT} (the user's server); refusing`, exit: 1 };
  process.kill(pid, 'SIGTERM');
  let signal = 'SIGTERM';
  for (let i = 0; i < 20 && alive(pid); i++) await sleep(500);
  if (alive(pid)) { process.kill(pid, 'SIGKILL'); signal = 'SIGKILL'; await sleep(1000); }
  const stopped = !alive(pid);
  if (stopped) unlinkSync(pidPath(port));
  return { ok: stopped, node: 'mac', port, pid, signal, stopped, still_listening: (await http(`${baseUrl({ kind: 'local' }, port)}/api/version`, { timeoutMs: 2000 })).ok };
}

async function statusLocal(port) {
  const base = baseUrl({ kind: 'local' }, port);
  const v = await http(`${base}/api/version`, { timeoutMs: 3000 });
  const ps = v.ok ? (await http(`${base}/api/ps`)).json : null;
  const pid = readPid(port);
  const listener = (spawnSync('lsof', ['-nP', `-tiTCP:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' }).stdout ?? '').trim().split('\n').filter(Boolean).map(Number);
  const parallel = existsSync(logPath(port)) ? [...readFileSync(logPath(port), 'utf8').matchAll(/OLLAMA_NUM_PARALLEL:(\d+)/g)].map((m) => m[1]).pop() ?? null : null; // the "server config" line at the top of the log
  return { ok: v.ok, node: 'mac', port, base, serving: v.ok, version: v.json?.version ?? null, reason: v.ok ? null : (v.error ?? `http ${v.status}`), pid, pid_alive: pid ? alive(pid) : false, listener_pids: listener, parallel_from_log: parallel ? Number(parallel) : null, ps, log: rel(logPath(port)), log_tail: tail(logPath(port), 3) };
}

// ------------------------------------------------------------------ spark2 (ssh) verbs

const REMOTE_PATH = 'export PATH=$HOME/ollama/bin:$HOME/.local/bin:$PATH; D=$HOME/.timmy/swarm; mkdir -p $D;';

async function startRemote(n, { port, parallel, model, ctx, modelsDir, doWarm }) {
  const r0 = reach(n); if (!r0.ok) return r0;
  const models = modelsDir ? `OLLAMA_MODELS=${modelsDir} ` : '';
  const script = `set -e; ${REMOTE_PATH}
if curl -s --max-time 3 http://127.0.0.1:${port}/api/version >/dev/null; then echo state=already-serving; else
  ${models}OLLAMA_HOST=0.0.0.0:${port} OLLAMA_NUM_PARALLEL=${parallel} OLLAMA_KEEP_ALIVE=30m OLLAMA_NOPRUNE=1 nohup ollama serve > $D/ollama-${port}.log 2>&1 &
  echo $! > $D/ollama-${port}.pid; echo state=started; fi
echo pid=$(cat $D/ollama-${port}.pid 2>/dev/null)
for i in $(seq 1 60); do V=$(curl -s --max-time 2 http://127.0.0.1:${port}/api/version) && [ -n "$V" ] && break; sleep 0.5; done
echo version=$V`;
  const r = ssh(n, script, { timeout: 60000 });
  const kv = parseKv(r.out);
  if (!r.ok || !kv.version) return { ok: false, node: n.id, port, reason: r.timed_out ? 'ssh timed out' : (r.err.split('\n').filter(Boolean).pop() || 'no /api/version answer within 30 s'), remote: kv, exit: 1 };
  const base = baseUrl(n, port);
  const here = await http(`${base}/api/version`, { timeoutMs: 10000 });
  const res = { ok: true, node: n.id, port, base, remote_state: kv.state, pid: Number(kv.pid) || null, version: kv.version, reachable_from_here: here.ok, parallel, model, ctx, log: `~/.timmy/swarm/ollama-${port}.log (on ${n.tailnet_name})`, pid_file: `~/.timmy/swarm/ollama-${port}.pid (on ${n.tailnet_name})` };
  if (doWarm && here.ok) res.warm = await warm(base, model, ctx);
  if (here.ok) res.ps = (await http(`${base}/api/ps`)).json ?? null;
  res.next = `node lanes/swarm/slots.mjs prove --node ${n.id} --parallel ${parallel} --model ${model} --port ${port} --ctx ${ctx} --json`;
  return res;
}

async function stopRemote(n, port) {
  const r0 = reach(n); if (!r0.ok) return r0;
  const script = `set +e; ${REMOTE_PATH} P=$(cat $D/ollama-${port}.pid 2>/dev/null)
if [ -z "$P" ]; then echo state=no-pid-file; exit 0; fi
if ps -p $P -o command= | grep -q 'ollama serve'; then kill $P; sleep 2; ps -p $P >/dev/null 2>&1 && { kill -9 $P; sleep 1; }; ps -p $P >/dev/null 2>&1 && echo state=still-alive || echo state=stopped; else echo state=pid-not-ollama-serve; fi
echo pid=$P; rm -f $D/ollama-${port}.pid`;
  const r = ssh(n, script, { timeout: 60000 });
  const kv = parseKv(r.out);
  return { ok: kv.state === 'stopped', node: n.id, port, pid: Number(kv.pid) || null, state: kv.state ?? null, reason: r.ok ? (kv.state === 'stopped' ? null : kv.state) : (r.err.split('\n').filter(Boolean).pop() || `ssh exit ${r.status}`), exit: kv.state === 'stopped' ? 0 : 1 };
}

async function statusRemote(n, port) {
  const r0 = reach(n); if (!r0.ok) return r0;
  const script = `${REMOTE_PATH} P=$(cat $D/ollama-${port}.pid 2>/dev/null || echo 0)
echo "version=$(curl -s --max-time 3 http://127.0.0.1:${port}/api/version)"
echo "ps=$(curl -s --max-time 5 http://127.0.0.1:${port}/api/ps)"
echo "pid=$P"; echo "alive=$(ps -p $P -o pid= 2>/dev/null | tr -d ' ')"
echo "parallel=$(grep -o 'OLLAMA_NUM_PARALLEL:[0-9]*' $D/ollama-${port}.log 2>/dev/null | tail -1 | cut -d: -f2)"`;
  const r = ssh(n, script, { timeout: 60000 });
  const kv = parseKv(r.out);
  const j = (s) => { try { return JSON.parse(s); } catch { return null; } };
  const here = await http(`${baseUrl(n, port)}/api/version`, { timeoutMs: 8000 });
  return { ok: !!j(kv.version)?.version, node: n.id, port, base: baseUrl(n, port), serving: !!j(kv.version)?.version, version: j(kv.version)?.version ?? null, reachable_from_here: here.ok, pid: Number(kv.pid) || null, pid_alive: !!kv.alive, parallel_from_log: Number(kv.parallel) || null, ps: j(kv.ps), log: `~/.timmy/swarm/ollama-${port}.log (on ${n.tailnet_name})` };
}

// ------------------------------------------------------------------ prove (either node, over HTTP)

/** One chat call: wall ms measured here plus the server-side durations Ollama reports. */
async function chat(base, model, ctx, i, label = `SLOT-${i}`) {
  const r = await http(`${base}/api/chat`, { method: 'POST', timeoutMs: 300000, body: { model, stream: false, think: false, keep_alive: '30m', messages: [{ role: 'user', content: `Reply with the single word ${label}` }], options: { num_ctx: ctx, temperature: 0 } } });
  const j = r.json ?? {};
  const ok = r.ok && !j.error && typeof j.message?.content === 'string';
  const ms = (ns) => ns ? Math.round(ns / 1e6) : null;
  return { i, ok, ms: r.ms, server_total_ms: ms(j.total_duration), load_ms: ms(j.load_duration), prompt_eval_ms: ms(j.prompt_eval_duration), eval_ms: ms(j.eval_duration), prompt_eval_count: j.prompt_eval_count ?? null, eval_count: j.eval_count ?? null, eval_tok_per_s: j.eval_count && j.eval_duration ? +(j.eval_count / (j.eval_duration / 1e9)).toFixed(2) : null, answer_preview: (j.message?.content ?? '').replace(/\s+/g, ' ').trim().slice(0, 80), error: ok ? null : (j.error ?? r.error ?? `http ${r.status}`) };
}

// overlap_ratio (Σ per-call wall / batch wall) is the order's criterion, but a runner that QUEUES N calls
// also scores > 1.5 (call k waits for calls 1..k−1). So prove also times a solo call and reports
// speedup_vs_solo = N × solo_ms / batch wall: ≈ N means real parallel slots, ≈ 1 means a queue.
async function prove(n, { port, parallel, model, ctx, doWarm, soloRuns }) {
  const base = baseUrl(n, port);
  const v = await http(`${base}/api/version`, { timeoutMs: 8000 });
  if (!v.ok) return { ok: false, node: n.id, port, reason: `no Ollama answering at ${base}/api/version (${v.error ?? `http ${v.status}`}); run: node lanes/swarm/slots.mjs start --node ${n.id} --parallel ${parallel} --port ${port}`, exit: 3 };
  let warm_ms = null;
  if (doWarm) { const w = await warm(base, model, ctx); warm_ms = w.ms; if (!w.ok) return { ok: false, node: n.id, port, model, reason: `warm-up load failed: ${w.error}`, exit: 1 }; }
  // solo baseline: sequential single calls; the first also absorbs the runner's first-forward page-in, the last is the steady-state solo wall
  const solo = [];
  for (let k = 0; k < soloRuns; k++) { console.error(`solo baseline ${k + 1}/${soloRuns} → ${base}/api/chat`); solo.push(await chat(base, model, ctx, 0, `SOLO-${k + 1}`)); }
  const solo_ms = solo.length ? Math.min(...solo.map((s) => s.ms)) : null; // best of the runs: background load only ever inflates a solo call
  console.error(`firing ${parallel} concurrent POST ${base}/api/chat (model ${model}, num_ctx ${ctx}, think:false, 300 s per-call timeout)`);
  const t0 = performance.now();
  const per_call = await Promise.all(Array.from({ length: parallel }, (_, k) => chat(base, model, ctx, k + 1)));
  const total_ms = Math.round(performance.now() - t0);
  const completed = per_call.filter((c) => c.ok).length;
  const sum_ms = per_call.reduce((a, c) => a + c.ms, 0);
  const overlap_ratio = total_ms > 0 ? +(sum_ms / total_ms).toFixed(2) : 0;
  const walls = per_call.map((c) => c.ms);
  const finish_spread_ms = Math.max(...walls) - Math.min(...walls);
  const speedup_vs_solo = solo_ms && total_ms ? +((parallel * solo_ms) / total_ms).toFixed(2) : null;
  const stagger_ratio = solo_ms && parallel > 1 ? +(finish_spread_ms / ((parallel - 1) * solo_ms)).toFixed(2) : null; // ≈1 = finishes staggered one solo apart (queue), ≈0 = finished together
  const overlap_proven = parallel >= 2 && completed >= 2 && overlap_ratio > 1.5; // the order's criterion
  // Server-side truth, immune to queue wait and to a noisy solo baseline: Ollama's prompt_eval_duration + eval_duration is the time the
  // runner actually spent computing each request. Σ work ≈ wall → the runner did them one at a time; Σ work ≫ wall → they ran together.
  const work_ms = per_call.reduce((a, c) => a + (c.prompt_eval_ms ?? 0) + (c.eval_ms ?? 0), 0);
  const work_overlap = work_ms > 0 && total_ms > 0 ? +(work_ms / total_ms).toFixed(2) : null;
  const concurrent = work_overlap != null ? work_overlap > 1.5 : stagger_ratio == null ? null : stagger_ratio < 0.5;
  const slots_proven = overlap_proven && concurrent !== false;
  const throughput_gain = speedup_vs_solo == null ? null : speedup_vs_solo > 1.5;
  const ps = (await http(`${base}/api/ps`, { timeoutMs: 8000 })).json ?? null;
  const loaded = ps?.models?.find((m) => m.name === model || m.model === model) ?? null;
  const verdict = parallel < 2 ? 'N < 2 cannot prove parallelism'
    : !overlap_proven ? `NOT proven: overlap_ratio ${overlap_ratio} ≤ 1.5 or too few completed (${completed}/${parallel})`
    : concurrent === false ? `overlap_ratio ${overlap_ratio} > 1.5 but the calls were QUEUED, not parallel: the runner's own compute time Σ(prompt_eval+eval) = ${work_ms} ms ≈ the ${total_ms} ms wall (work_overlap ${work_overlap}), i.e. it served them one at a time; finishes staggered ${finish_spread_ms} ms apart (stagger ${stagger_ratio}), speedup vs solo ${speedup_vs_solo}×`
    : concurrent === null ? `parallel slots proven by the order's criterion only (overlap ${overlap_ratio}×); no server-side durations and no solo baseline, so a queue cannot be ruled out`
    : throughput_gain ? `parallel slots proven: ${completed}/${parallel} ran concurrently (runner compute Σ ${work_ms} ms in a ${total_ms} ms wall, work_overlap ${work_overlap}) and ${speedup_vs_solo}× faster than ${parallel} solo calls`
    : `parallel slots proven (${completed}/${parallel} ran concurrently: runner compute Σ ${work_ms} ms in a ${total_ms} ms wall, work_overlap ${work_overlap}; finished within ${finish_spread_ms} ms of each other) BUT no throughput gain: ${parallel} concurrent calls took ${total_ms} ms vs ${parallel} × ${solo_ms} ms solo (speedup ${speedup_vs_solo}×) — the slots exist, the runner just does not batch efficiently on this hardware`;
  return {
    ok: completed === parallel, node: n.id, port, base, model, ctx, version: v.json?.version ?? null, parallel_requested: parallel, completed, total_ms, sum_ms, overlap_ratio, overlap_proven,
    work_ms, work_overlap, solo_ms, solo_runs_ms: solo.map((s) => s.ms), speedup_vs_solo, throughput_gain, finish_spread_ms, stagger_ratio, concurrent, slots_proven, verdict,
    ps_context_length: loaded?.context_length ?? null, // Ollama 0.33.1 reports the per-slot num_ctx here for both runners — not evidence of slot count either way
    warm_ms, per_call, ps, sealed: false
  };
}

// ------------------------------------------------------------------ main

try {
  const nodeId = flag('--node', 'mac');
  const port = Number(flag('--port', 11435));
  const parallel = Number(flag('--parallel', 5));
  const ctx = Number(flag('--ctx', 8192));
  const model = flag('--model', DEFAULT_MODEL[nodeId] ?? DEFAULT_MODEL.mac);
  const doWarm = !has('--no-warm');
  if (!['start', 'prove', 'stop', 'status'].includes(cmd)) { console.error('usage: node lanes/swarm/slots.mjs start|prove|stop|status --node mac|spark2 [--parallel N] [--model tag] [--port 11435] [--ctx 8192] [--models dir] [--json] [--no-warm]'); process.exit(2); }
  if (!Number.isInteger(port) || port <= 0 || !Number.isInteger(parallel) || parallel <= 0 || !Number.isInteger(ctx) || ctx <= 0) throw new Error('--port, --parallel and --ctx must be positive integers');
  if (port === PROTECTED_PORT) { console.error(`port ${PROTECTED_PORT} is the node's primary Ollama server (Ollama.app on the mac, engine-room serve on spark2); the swarm server must use another port (default 11435)`); process.exit(2); }
  const n = nodeEntry(nodeId);
  const modelsDir = n.kind === 'local' ? flag('--models', process.env.OLLAMA_MODELS ?? join(homedir(), '.ollama', 'models')) : flag('--models', null);
  let res;
  switch (cmd) {
    case 'start': res = n.kind === 'local' ? await startLocal({ port, parallel, model, ctx, modelsDir, doWarm }) : await startRemote(n, { port, parallel, model, ctx, modelsDir, doWarm }); break;
    case 'stop': res = n.kind === 'local' ? await stopLocal(port) : await stopRemote(n, port); break;
    case 'status': res = n.kind === 'local' ? await statusLocal(port) : await statusRemote(n, port); break;
    case 'prove': res = await prove(n, { port, parallel, model, ctx, doWarm, soloRuns: has('--no-solo') ? 0 : Number(flag('--solo-runs', 2)) }); break;
  }
  const exit = res.exit ?? (res.ok ? 0 : 1);
  delete res.exit;
  if (cmd === 'prove' && res.ok !== false && !has('--json')) {
    console.log(`prove · ${res.node}:${res.port} · ${res.model} · num_ctx ${res.ctx} · ${res.completed}/${res.parallel_requested} completed · wall ${res.total_ms} ms · Σ ${res.sum_ms} ms · overlap ${res.overlap_ratio}× · runner work Σ ${res.work_ms} ms (work_overlap ${res.work_overlap ?? '-'}) · solo ${res.solo_ms ?? '-'} ms · stagger ${res.stagger_ratio ?? '-'} · speedup_vs_solo ${res.speedup_vs_solo ?? '-'}× · slots_proven ${res.slots_proven}`);
    for (const c of res.per_call) console.log(`  SLOT-${c.i}  ${c.ok ? 'ok ' : 'ERR'}  ${String(c.ms).padStart(6)} ms wall (server ${c.server_total_ms ?? '-'} ms: prompt ${c.prompt_eval_ms ?? '-'} + eval ${c.eval_ms ?? '-'})  ${String(c.eval_count ?? '-').padStart(3)} tok @ ${c.eval_tok_per_s ?? '-'} tok/s  "${c.answer_preview}"${c.error ? `  ${c.error}` : ''}`);
    console.log(`  ${res.verdict}`);
    if (res.ps_context_length) console.log(`  ps: context_length ${res.ps_context_length} (Ollama 0.33.1 shows the per-slot num_ctx here for both runners; not evidence of slot count)`);
  } else out(res);
  process.exit(exit);
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
