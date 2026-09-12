#!/usr/bin/env node
// timmy jcode — JCODE AS CAPTAIN (ORDER captain-y9g4 step 2).
//
//   timmy jcode setup   [--home <dir>]              isolated JCODE_HOME: provider profiles
//        (openrouter + nvidia-nim@spark, Timmy MCP over stdio via the mcporter bridge)
//   timmy jcode run "<task>" [--model m] [--provider openrouter] [--home d] [--no-seal]
//        one real jcode one-shot (ndjson) → transcript + jcode.lane receipt
//   timmy jcode memory <list|search|stats> [--home d]     read jcode's own memory
//   timmy jcode serve   [--home d] [--socket s]     start `jcode serve` as the commander's handoff target (prints the socket)
//   timmy jcode stop    [--home d]
//   timmy jcode rebuild [--from <ref>] [--no-seal]  self-dev: seal jcode.rebuild when the binary changes
//
// jcode has no npm SDK; its programmatic surface is the CLI + the ndjson run
// stream + the background daemon (jcode serve / --socket) + the ACP adapter.
// This lane drives that surface in an isolated home so the user's ~/.jcode is
// never touched, and every real run seals a receipt with the transcript sha.
//
// Secrets: OPENROUTER_API_KEY (and NVIDIA_NIM_API_KEY, if the Sparks NIM is up)
// from the environment; only ever placed in the child's env, never printed.
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf(k); return i >= 0 && args[i + 1] !== undefined && !args[i + 1].startsWith('--') ? args[i + 1] : d; };
const has = (k) => args.includes(k);
const positional = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--') && !['--no-seal'].includes(args[i - 1])));
const cmd = positional[0];
// Two variants (captain-y9g4):
//   release (default) — the installed jcode release; pinned to semver 0.84.0
//     (`jcode update`, GitHub 1jehuang/jcode, jcode.sh/releases/latest.json all agree).
//   dev — jcode master built from source (cargo build --release) into its OWN
//     prefix (lanes/jcode/.dev-bin/jcode), NEVER over the release binary; pinned
//     to the exact commit. 0.9.x in the README is a dev build; master carries the
//     swarm / serve-connect / resume surface the release binary lacks.
// Each variant has a drift check so a silent change shows on the receipt.
const VARIANT = flag('--variant', 'release');
const PIN = {
  release: { bin: process.env.JCODE_BIN || join(homedir(), '.local', 'bin', 'jcode'), semver: '0.84.0', commit: '57d587899' },
  dev: { bin: process.env.JCODE_DEV_BIN || join(ROOT, 'lanes', 'jcode', '.dev-bin', 'jcode'), semver: '0.84.0', commit: 'e65e47c31af2ab79346458ff1511bea533930b59' }
};
const JCODE = (PIN[VARIANT] ?? PIN.release).bin;
const PINNED_JCODE = (PIN[VARIANT] ?? PIN.release).semver;
const PINNED_COMMIT = (PIN[VARIANT] ?? PIN.release).commit;
function jcodeVersion(bin = JCODE) {
  const r = spawnSync(bin, ['version', '--json'], { encoding: 'utf8' });
  try { const j = JSON.parse(r.stdout); return { semver: j.semver ?? 'unknown', commit: (j.version ?? '').match(/\(([0-9a-f]+)\)/)?.[1] ?? 'unknown' }; } catch { return { semver: 'unknown', commit: 'unknown' }; }
}
const TSX = join(ROOT, 'node_modules', '.bin', 'tsx');
const CLI = join(ROOT, 'src', 'cli.ts');
const HOME = resolve(flag('--home', join(ROOT, 'lanes', 'jcode', '.home')));
const sha = (s) => createHash('sha256').update(s).digest('hex');
const out = (o) => console.log(JSON.stringify(o, null, has('--compact') ? 0 : 1));
const orKey = () => process.env.OPENROUTER_API_KEY || (existsSync(join(ROOT, 'workers', 'ai-proxy', '.dev.vars')) ? '' : '');
const redact = (s) => String(s).replace(/sk-or-v1-[A-Za-z0-9]+/g, '[redacted]').replace(/nvapi-[A-Za-z0-9_-]+/g, '[redacted]');

function seal(subject, meta) {
  if (has('--no-seal')) return null;
  const a = ['tsx', 'src/cli.ts', 'seal', subject];
  for (const [k, v] of Object.entries(meta)) if (v != null && v !== '') a.push('--meta', `${k}=${String(v).replace(/\n/g, ' ').slice(0, 1500)}`);
  const r = spawnSync('npx', a, { cwd: ROOT, encoding: 'utf8' });
  if (r.status !== 0) { process.stderr.write(r.stderr ?? ''); throw new Error(`seal ${subject} failed`); }
  const store = existsSync(join(ROOT, '.timmy', 'store-pin')) ? readFileSync(join(ROOT, '.timmy', 'store-pin'), 'utf8').trim() : join(ROOT, '.timmy', 'receipts');
  return JSON.parse(readFileSync(join(store, 'runs.jsonl'), 'utf8').trim().split('\n').pop()).hash;
}

function childEnv(extra = {}) {
  const env = { ...process.env, JCODE_HOME: HOME, JCODE_NO_TELEMETRY: '1', ...extra };
  return env;
}

/** The Sparks NIM base_url (nvidia-nim on spark2), read from the node registry overlay/template — never a raw literal. */
function sparkNimBase() {
  for (const p of [join(ROOT, '.timmy', 'private', 'fleet', 'nodes.json'), join(ROOT, 'fleet', 'nodes.json'), join(ROOT, 'fleet', 'nodes.example.json')]) {
    if (existsSync(p)) {
      try { const n = JSON.parse(readFileSync(p, 'utf8')).nodes?.find((x) => x.id === 'spark2'); if (n?.tailnet_ip && !String(n.tailnet_ip).startsWith('<')) return `http://${n.tailnet_ip}:8000/v1`; } catch { /* fall through */ }
    }
  }
  return null; // unknown until the overlay carries a real spark2 address
}

function setup() {
  mkdirSync(HOME, { recursive: true });
  // Timmy MCP over stdio via the mcporter bridge: jcode reads <JCODE_HOME>/mcp.json
  writeFileSync(join(HOME, 'mcp.json'), JSON.stringify({ servers: { timmy: { type: 'stdio', command: TSX, args: [CLI, 'mcp', 'serve'], env: {} } } }, null, 1));
  const profiles = [];
  // openrouter profile (proven when OPENROUTER_API_KEY is set)
  const orAdd = spawnSync(JCODE, ['provider', 'add', 'timmy-openrouter', '--base-url', 'https://openrouter.ai/api/v1', '--model', flag('--model', 'google/gemini-3.7-flash'), '--api-key-env', 'OPENROUTER_API_KEY'], { cwd: HOME, env: childEnv(), encoding: 'utf8' });
  profiles.push({ name: 'timmy-openrouter', base_url: 'https://openrouter.ai/api/v1', ok: orAdd.status === 0, note: redact((orAdd.stderr || orAdd.stdout || '').trim().split('\n').pop() || 'added') });
  // nvidia-nim @ spark2 profile (configured; proven only when the Spark's NIM is reachable)
  const nim = sparkNimBase();
  if (nim) {
    const nimAdd = spawnSync(JCODE, ['provider', 'add', 'spark2-nim', '--base-url', nim, '--model', flag('--nim-model', 'nvidia/llama-3.3-nemotron-super-49b-v1'), '--api-key-env', 'NVIDIA_NIM_API_KEY'], { cwd: HOME, env: childEnv(), encoding: 'utf8' });
    profiles.push({ name: 'spark2-nim', base_url: nim, ok: nimAdd.status === 0, note: 'nvidia-nim on spark2; proven only when the NIM server answers' });
  } else {
    profiles.push({ name: 'spark2-nim', base_url: null, ok: false, note: 'spark2 address not in the node overlay yet (engine-room WAITING-ON-WILL); profile deferred' });
  }
  return { home: HOME, mcp: join(HOME, 'mcp.json'), profiles };
}

function rebuild() {
  const src = join(ROOT, 'lanes', 'jcode', '.dev');
  const binDir = join(ROOT, 'lanes', 'jcode', '.dev-bin');
  const dst = join(binDir, 'jcode');
  const ref = flag('--from', PIN.dev.commit);
  if (!existsSync(src)) {
    const clone = spawnSync('git', ['clone', 'https://github.com/1jehuang/jcode.git', src], { cwd: ROOT, encoding: 'utf8' });
    if (clone.status !== 0) throw new Error(`git clone jcode failed: ${(clone.stderr || clone.stdout || '').trim()}`);
  }
  const fetch = spawnSync('git', ['fetch', '--all', '--tags', '--prune'], { cwd: src, encoding: 'utf8' });
  if (fetch.status !== 0) throw new Error(`git fetch jcode failed: ${(fetch.stderr || fetch.stdout || '').trim()}`);
  const checkout = spawnSync('git', ['checkout', '--detach', ref], { cwd: src, encoding: 'utf8' });
  if (checkout.status !== 0) throw new Error(`git checkout ${ref} failed: ${(checkout.stderr || checkout.stdout || '').trim()}`);
  const started = Date.now();
  const build = spawnSync('cargo', ['build', '--release', '--bin', 'jcode'], { cwd: src, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (build.status !== 0) throw new Error(`cargo build jcode failed: ${(build.stderr || build.stdout || '').trim().split('\n').slice(-5).join(' ')}`);
  mkdirSync(binDir, { recursive: true });
  copyFileSync(join(src, 'target', 'release', 'jcode'), dst);
  chmodSync(dst, 0o755);
  const commit = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: src, encoding: 'utf8' }).stdout.trim();
  const jv = jcodeVersion(dst);
  const binarySha256 = sha(readFileSync(dst));
  const receipt = seal('jcode.rebuild', { variant: 'dev', from: ref, jcode_semver: jv.semver, jcode_commit: commit || jv.commit, pinned_commit: PIN.dev.commit.slice(0, 9), binary: dst.replace(ROOT + '/', ''), binary_sha256: binarySha256, build: 'cargo build --release --bin jcode', ms: Date.now() - started, order: 'captain-y9g4' });
  return { ok: true, variant: 'dev', from: ref, commit: commit || jv.commit, semver: jv.semver, binary: dst.replace(ROOT + '/', ''), binary_sha256: binarySha256, receipt };
}

async function runOnce(task) {
  mkdirSync(HOME, { recursive: true });
  if (!existsSync(join(HOME, 'mcp.json'))) setup();
  const model = flag('--model', 'x-ai/grok-4.6');
  const provider = flag('--provider', 'openrouter');
  // schema gate (captain-y9g4): a harness lane picks a model only if the tool schema it presents passes that
  // model's validator. jcode exposes Timmy's MCP tools; if any has a strict-schema issue and the model is
  // strict (e.g. Gemini), refuse with the reason instead of a raw 400.
  if (provider === 'openrouter' && !has('--no-gate')) {
    try {
      const { strictIssues, schemaGate, timmyTools } = await import('../schema/lane.mjs');
      const mapPath = join(ROOT, 'lanes', 'schema', 'model-strictness.json');
      const strictness = existsSync(mapPath) ? (JSON.parse(readFileSync(mapPath, 'utf8')).rows.find((r) => r.model === model)?.tool_schema ?? 'unknown') : 'unknown';
      const tools = await timmyTools();
      const issues = tools.reduce((n, t) => n + strictIssues(t.name, t.inputSchema).length, 0);
      const g = schemaGate(strictness, issues);
      if (!g.ok) { out({ ok: false, refused: true, model, tool_schema: strictness, timmy_schema_issues: issues, reason: g.reason }); return 3; }
    } catch { /* the gate is best-effort; a probe failure never blocks a run */ }
  }
  const cwd = join(HOME, 'work'); mkdirSync(cwd, { recursive: true });
  const argv = [JCODE, 'run', '--no-update', '--ndjson', '-p', provider, '-m', model, '--socket', join(HOME, 'jcode.sock'), '-C', cwd, task];
  const started = Date.now();
  const r = await new Promise((res) => {
    let so = '', se = '', done = false;
    const child = spawn(argv[0], argv.slice(1), { cwd, env: childEnv(), stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    const timer = setTimeout(() => { if (!done) { try { process.kill(-child.pid, 'SIGTERM'); } catch { /* gone */ } setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ } }, 3000); } }, Number(flag('--timeout', 180000)));
    child.stdout.on('data', (d) => { so += d; });
    child.stderr.on('data', (d) => { se += d; });
    child.on('exit', (code, signal) => { done = true; clearTimeout(timer); res({ code, signal, so, se }); });
    child.on('error', (e) => { done = true; clearTimeout(timer); res({ code: -1, signal: null, so, se: se + String(e) }); });
  });
  // ndjson: collect the assistant text deltas and any tool calls
  const lines = r.so.split('\n').filter(Boolean);
  const texts = [], tools = [];
  for (const l of lines) { let j; try { j = JSON.parse(l); } catch { continue; } if (j.type === 'text_delta' && typeof j.text === 'string') texts.push(j.text); if (j.type === 'tool_start' || j.type === 'tool_exec') tools.push(j.name); }
  const answer = texts.join('').trim();
  const transcript = join(ROOT, 'lanes', 'jcode', 'transcripts', `run-${started.toString(36)}.jsonl`);
  mkdirSync(join(ROOT, 'lanes', 'jcode', 'transcripts'), { recursive: true });
  writeFileSync(transcript, redact(r.so));
  const ok = r.code === 0 && !!answer;
  const jv = jcodeVersion();
  const drift = jv.commit !== 'unknown' && !PINNED_COMMIT.startsWith(jv.commit) && !jv.commit.startsWith(PINNED_COMMIT.slice(0, 9)) ? 'DRIFT from pin' : 'ok';
  const receipt = seal('jcode.lane', { variant: VARIANT, home: 'lanes/jcode/.home (isolated)', jcode_semver: jv.semver, jcode_commit: jv.commit, pinned_commit: PINNED_COMMIT.slice(0, 9), drift, provider, model, ok, ms: Date.now() - started, exit: r.code, answer_sha256: answer ? sha(answer) : '', answer_preview: answer.slice(0, 200), tool_calls: [...new Set(tools)].join(','), transcript: transcript.replace(ROOT + '/', ''), transcript_sha256: sha(readFileSync(transcript, 'utf8')), mcp: 'timmy stdio via <home>/mcp.json', order: 'captain-y9g4' });
  out({ ok, provider, model, ms: Date.now() - started, exit: r.code, answer_preview: answer.slice(0, 400), tool_calls: [...new Set(tools)], transcript: transcript.replace(ROOT + '/', ''), receipt, error: ok ? null : redact((r.se || '').trim().split('\n').slice(-3).join(' ')).slice(0, 300) });
  return ok ? 0 : 1;
}

try {
  if (cmd === 'setup') { out(setup()); }
  else if (cmd === 'run') { const t = positional[1]; if (!t) { console.error('usage: timmy jcode run "<task>"'); process.exit(2); } process.exit(await runOnce(t)); }
  else if (cmd === 'memory') { const sub = positional[1] ?? 'stats'; const r = spawnSync(JCODE, ['memory', sub, ...(positional[2] ? [positional[2]] : [])], { cwd: HOME, env: childEnv(), encoding: 'utf8' }); process.stdout.write(r.stdout ?? ''); process.exit(r.status ?? 1); }
  else if (cmd === 'serve') { mkdirSync(HOME, { recursive: true }); const sock = flag('--socket', join(HOME, 'jcode.sock')); const child = spawn(JCODE, ['serve', '--socket', sock], { cwd: HOME, env: childEnv(), stdio: 'ignore', detached: true }); child.unref(); out({ ok: true, serving: true, socket: sock, pid: child.pid, note: 'jcode daemon started as the commander handoff target; stop with `timmy jcode stop`' }); }
  else if (cmd === 'stop') { const r = spawnSync(JCODE, ['server', 'stop'], { cwd: HOME, env: childEnv(), encoding: 'utf8' }); out({ ok: r.status === 0, note: (r.stdout || r.stderr || '').trim() }); }
  else if (cmd === 'rebuild') { out(rebuild()); }
  else if (cmd === 'clean') { rmSync(HOME, { recursive: true, force: true }); out({ ok: true, cleaned: HOME }); }
  else { console.error('usage: timmy jcode <setup|run|memory|serve|stop|rebuild|clean> …'); process.exit(2); }
} catch (e) { console.error(`[jcode] ${e instanceof Error ? e.message : String(e)}`); process.exit(1); }
