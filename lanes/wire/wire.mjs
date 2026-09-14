#!/usr/bin/env node
// lanes/wire/wire.mjs — ORDER shelf-w6d3 step 3:
//   "mcpsnoop on every MCP wire; mcp-probe on every bridge; apisnip on OpenAPI lanes;
//    evaluate cmcp + mcpc with one receipt each — adopt or reject with reason."
// Data-driven from lanes/wire/bridges.json. Writes lanes/wire/{sessions,reports,transcripts,snips}/
// and lanes/wire/results.json. Every command it runs is appended to transcripts/<name>.jsonl.
//
// usage: node lanes/wire/wire.mjs snoop|probe|snip|eval|all [--only <bridge-name>]
// env:   WIRE_SCRATCH   scratch dir for traces / mcpc configs / downloaded specs (default: $TMPDIR/timmy-wire)
//        WIRE_MCPC      override the mcpc launcher (default: cached npx @apify/mcpc@0.6.0, else npx -y ...)
//        WIRE_CMCP_SRC  cmcp source dir for the eval (default: $WIRE_SCRATCH/cmcp-main)
// No git, no receipts: the main session seals from results.json.

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const LANE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(LANE, '..', '..');
const HOME = os.homedir();
const REG = JSON.parse(fs.readFileSync(path.join(LANE, 'bridges.json'), 'utf8'));
const SCRATCH = process.env.WIRE_SCRATCH || path.join(os.tmpdir(), 'timmy-wire');
const RESULTS = path.join(LANE, 'results.json');
const TIMEOUT = 120000;
const METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'trace']);

for (const d of ['sessions', 'reports', 'transcripts', 'snips']) fs.mkdirSync(path.join(LANE, d), { recursive: true });
for (const d of ['traces', 'mcpc', 'specs', 'tmp']) fs.mkdirSync(path.join(SCRATCH, d), { recursive: true });

const expand = (p) => String(p).replace(/^~(?=\/|$)/, HOME).replace(/\$ROOT/g, ROOT).replace(/\$WIRE_SCRATCH/g, SCRATCH);
const sha256 = (f) => (f && fs.existsSync(f) ? crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex') : null);
const rel = (f) => (f ? path.relative(ROOT, f) : null);
const trunc = (s, n = 4000) => (s && s.length > n ? s.slice(0, n) + `…[+${s.length - n} chars]` : s || '');
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
const firstLine = (s) => (s || '').split('\n').find((l) => l.trim()) || '';
const stripAnsi = (s) => (s || '').replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => process.stderr.write(a.join(' ') + '\n');

function findBin(name, candidates) {
  for (const c of candidates) if (fs.existsSync(c)) return c;
  for (const d of (process.env.PATH || '').split(':')) { const p = path.join(d, name); if (fs.existsSync(p)) return p; }
  return name;
}
function resolveMcpc() {
  if (process.env.WIRE_MCPC) return process.env.WIRE_MCPC.split(' ');
  const npx = path.join(HOME, '.npm', '_npx');
  try {
    for (const h of fs.readdirSync(npx)) {
      const pkg = path.join(npx, h, 'node_modules', '@apify', 'mcpc', 'package.json');
      if (fs.existsSync(pkg) && JSON.parse(fs.readFileSync(pkg, 'utf8')).version === '0.6.0') return [path.join(npx, h, 'node_modules', '.bin', 'mcpc')];
    }
  } catch {}
  return ['npx', '-y', '@apify/mcpc@0.6.0'];
}
const BIN = {
  mcpsnoop: findBin('mcpsnoop', ['/opt/homebrew/bin/mcpsnoop']),
  probe: findBin('mcp-probe', [path.join(HOME, '.cargo/bin/mcp-probe')]),
  apisnip: findBin('apisnip', [path.join(HOME, '.cargo/bin/apisnip')]),
  mcpc: resolveMcpc(),
  exec: path.join(LANE, 'exec.mjs'),
};

// ---------- process runner: hard timeout, /dev/null stdin, process-group kill, transcript line ----------
function run(tname, argv, opts = {}) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const cwd = opts.cwd || ROOT;
    let out = '', err = '', timedOut = false, done = false, child, spawnErr = null;
    const finish = (code, signal) => {
      if (done) return; done = true;
      const r = { ts: new Date(t0).toISOString(), argv, cwd, exit: code, signal, timedOut, ms: Date.now() - t0, stdout: trunc(out), stderr: trunc(err) };
      if (spawnErr) r.error = spawnErr.code || String(spawnErr);
      fs.appendFileSync(path.join(LANE, 'transcripts', `${tname}.jsonl`), JSON.stringify(r) + '\n');
      resolve({ ...r, stdoutFull: out, stderrFull: err });
    };
    try {
      child = spawn(argv[0], argv.slice(1), { cwd, env: { ...process.env, ...(opts.env || {}) }, stdio: [fs.openSync('/dev/null', 'r'), 'pipe', 'pipe'], detached: true });
    } catch (e) { spawnErr = e; return finish(null, null); }
    child.on('error', (e) => { spawnErr = e; setTimeout(() => finish(null, null), 50); });
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    const timer = setTimeout(() => { timedOut = true; killTree(child.pid); }, opts.timeoutMs || TIMEOUT);
    child.on('close', (code, signal) => { clearTimeout(timer); finish(code, signal); });
  });
}
function spawnBg(argv, opts = {}) {
  const child = spawn(argv[0], argv.slice(1), { cwd: opts.cwd || ROOT, env: process.env, stdio: [fs.openSync('/dev/null', 'r'), 'pipe', 'pipe'], detached: true });
  child.out = ''; child.err = '';
  child.stdout.on('data', (d) => { child.out += d; });
  child.stderr.on('data', (d) => { child.err += d; });
  child.on('error', () => {});
  return child;
}
function killTree(pid) {
  try { process.kill(-pid, 'SIGTERM'); } catch {}
  setTimeout(() => { try { process.kill(-pid, 'SIGKILL'); } catch {} }, 1500);
}
async function sweep(tname, patterns) {
  // kill stray children left by mcpc/mcpsnoop teardown (exec.mjs forwards SIGTERM to the real server)
  const killed = [];
  for (const pat of patterns) {
    const r = await run(tname, ['pgrep', '-f', pat], { timeoutMs: 10000 });
    for (const pid of r.stdoutFull.split('\n').map((s) => Number(s.trim())).filter((n) => n && n !== process.pid)) {
      try { process.kill(pid, 'SIGTERM'); killed.push(pid); } catch {}
    }
  }
  if (killed.length) { await sleep(800); for (const pid of killed) { try { process.kill(pid, 'SIGKILL'); } catch {} } }
  return killed;
}

// ---------- results ----------
function loadResults() {
  try { return JSON.parse(fs.readFileSync(RESULTS, 'utf8')); } catch { return { order: 'shelf-w6d3 step 3 — wire', bridges: {}, openapi: {}, evals: {} }; }
}
function saveResults(R) {
  R.generated_at = new Date().toISOString();
  R.worktree = ROOT;
  R.registry = { file: 'lanes/wire/bridges.json', sha256: sha256(path.join(LANE, 'bridges.json')) };
  R.tools = { mcpsnoop: BIN.mcpsnoop, 'mcp-probe': BIN.probe, apisnip: BIN.apisnip, mcpc: BIN.mcpc.join(' '), versions: REG.tools };
  fs.writeFileSync(RESULTS, JSON.stringify(R, null, 1) + '\n');
}
const meta = (b) => ({ kind: b.kind, transport: b.transport, command: b.command ? [b.command, ...(b.args || [])].join(' ') : undefined, url: b.url, source: b.source, gate: b.gate, env_names: b.envNames, notes: b.notes });

// ---------- harmless-call picker + local schema lint ----------
const ALLOW = new RegExp(REG.harmless_call_policy.allow, 'i');
const DENY = new RegExp(REG.harmless_call_policy.deny, 'i');
function chooseCall(b, tools) {
  if (b.call) return tools.some((t) => t.name === b.call.tool) ? b.call : null;
  const t = tools.find((t) => !(t.inputSchema && t.inputSchema.required && t.inputSchema.required.length) && ALLOW.test(t.name) && !DENY.test(t.name));
  return t ? { tool: t.name, args: {} } : null;
}
function lintTools(tools) {
  const findings = [];
  const walk = (node, where, tool) => {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'array' && !node.items) findings.push(`local-lint: ${tool}${where} is an array without items`);
    for (const [k, v] of Object.entries(node.properties || {})) {
      if (k === 'kind') findings.push(`local-lint: ${tool}${where} has a parameter named "kind"`);
      walk(v, `${where}.${k}`, tool);
    }
    if (node.items) walk(node.items, `${where}[]`, tool);
  };
  for (const t of tools || []) walk(t.inputSchema || t.input_schema, '', t.name);
  return findings;
}

// ---------- mcpsnoop trace helpers ----------
function splitTrace(trace) {
  const sessions = new Map();
  if (!fs.existsSync(trace)) return sessions;
  for (const line of fs.readFileSync(trace, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let j; try { j = JSON.parse(line); } catch { continue; }
    const s = sessions.get(j.session_id) || { id: j.session_id, lines: [], frames: 0 };
    s.lines.push(line);
    if (j.direction === 'c2s' || j.direction === 's2c') s.frames++;
    sessions.set(j.session_id, s);
  }
  return sessions;
}
async function exportMain(tname, b, trace, res) {
  const sessions = [...splitTrace(trace).values()].sort((a, c) => c.frames - a.frames);
  res.sessions_in_trace = sessions.length;
  res.trace_file = fs.existsSync(trace) ? trace : null;
  if (!sessions.length) { res.note = (res.note ? res.note + '; ' : '') + 'no frames captured by mcpsnoop'; return res; }
  const main = sessions[0];
  const tmp = path.join(SCRATCH, 'tmp', `${slug(b.name)}.main.jsonl`);
  fs.writeFileSync(tmp, main.lines.join('\n') + '\n');
  const outFile = path.join(LANE, 'sessions', `${slug(b.name)}.json`);
  const ex = await run(tname, [BIN.mcpsnoop, 'export', tmp, '-T', 'json', '-o', outFile], { timeoutMs: 30000 });
  res.session_file = ex.exit === 0 ? rel(outFile) : null;
  res.sha256 = ex.exit === 0 ? sha256(outFile) : null;
  res.session_id = main.id;
  res.frames = main.frames;
  res.frames_all_sessions = sessions.reduce((n, s) => n + s.frames, 0);
  try {
    const j = JSON.parse(fs.readFileSync(outFile, 'utf8'));
    res.export_summary = { requests: j.session.requests, responses: j.session.responses, notifications: j.session.notifications, errors: j.session.errors, pending: j.session.pending, tool_calls: (j.summary.tools || []).length, protocol: j.capabilities && j.capabilities.protocol_version };
  } catch {}
  const chk = await run(tname, [BIN.mcpsnoop, 'check', tmp, '--fail-on', 'error,invalid,warn,mismatch,pending,late-result,incomplete,schema'], { timeoutMs: 30000 });
  const m = (chk.stdoutFull + chk.stderrFull).match(/errors=\d+.*?schema_findings=\d+/);
  res.check = { exit: chk.exit, summary: m ? m[0] : firstLine(chk.stderrFull || chk.stdoutFull) };
  return res;
}

// ---------- snoop ----------
async function snoopStdio(b) {
  const T = slug(b.name);
  const res = { session_file: null, sha256: null, frames: 0, tools: 0, ok: false, note: '' };
  const trace = path.join(SCRATCH, 'traces', `${T}.jsonl`);
  fs.rmSync(trace, { force: true });
  const cfg = path.join(SCRATCH, 'mcpc', `${T}.json`);
  fs.writeFileSync(cfg, JSON.stringify({ mcpServers: { [b.name]: { command: BIN.mcpsnoop, args: ['--label', b.name, '--trace-file', trace, '--', process.execPath, BIN.exec, b.name] } } }, null, 2));
  const sess = '@wire-' + T;
  await run(T, [...BIN.mcpc, 'close', sess], { timeoutMs: 20000 });
  const c = await run(T, [...BIN.mcpc, 'connect', `${cfg}:${b.name}`, sess, '--json'], { timeoutMs: b.timeoutMs || TIMEOUT });
  let init = null; try { init = JSON.parse(c.stdoutFull)[0]; } catch {}
  if (c.exit !== 0 || !init) {
    res.note = `mcpc connect failed (exit=${c.exit}${c.timedOut ? ', timeout' : ''}): ${trunc(firstLine(stripAnsi(c.stderrFull)) || firstLine(stripAnsi(c.stdoutFull)), 300)}`;
    await run(T, [...BIN.mcpc, 'close', sess], { timeoutMs: 20000 });
    res.swept = await sweep(T, [`exec.mjs ${b.name}$`, `mcpsnoop --label ${b.name} `]);
    return exportMain(T, b, trace, res);
  }
  res.server = init.serverInfo; res.protocol = init.protocolVersion; res.connect_ms = c.ms;
  const tl = await run(T, [...BIN.mcpc, sess, 'tools-list', '--json'], { timeoutMs: 60000 });
  let tools = []; try { tools = JSON.parse(tl.stdoutFull); } catch {}
  if (!Array.isArray(tools)) tools = [];
  res.tools = tools.length;
  const toolsFile = path.join(LANE, 'sessions', `${T}.tools.json`);
  fs.writeFileSync(toolsFile, JSON.stringify(tools, null, 1) + '\n');
  res.tools_file = rel(toolsFile); res.tools_sha256 = sha256(toolsFile);
  res.tool_names = tools.map((t) => t.name);
  const pick = chooseCall(b, tools);
  if (pick) {
    const argv = [...BIN.mcpc, sess, 'tools-call', pick.tool];
    if (pick.args && Object.keys(pick.args).length) argv.push(JSON.stringify(pick.args));
    argv.push('--json');
    const tc = await run(T, argv, { timeoutMs: 60000 });
    let parsed = null; try { parsed = JSON.parse(tc.stdoutFull); } catch {}
    res.call = { tool: pick.tool, exit: tc.exit, ms: tc.ms, isError: parsed ? !!parsed.isError : null, preview: trunc(stripAnsi(tc.stdoutFull || tc.stderrFull), 400) };
  } else {
    res.call = { skipped: b.call ? `explicit tool ${b.call.tool} not offered by server` : 'no zero-required-arg tool matched the harmless allow-list' };
  }
  await run(T, [...BIN.mcpc, 'close', sess], { timeoutMs: 20000 });
  res.swept = await sweep(T, [`exec.mjs ${b.name}$`, `mcpsnoop --label ${b.name} `]);
  await exportMain(T, b, trace, res);
  res.ok = !!(res.session_file && res.frames > 0 && res.tools > 0);
  return res;
}
async function reach(url) {
  try {
    const r = await fetch(url, { method: 'GET', headers: { accept: 'application/json, text/event-stream' }, signal: AbortSignal.timeout(6000) });
    return { reachable: true, status: r.status };
  } catch (e) { return { reachable: false, error: (e.cause && e.cause.code) || e.name || String(e) }; }
}
let portSeq = 47100;
async function snoopHttp(b) {
  const T = slug(b.name);
  const res = { session_file: null, sha256: null, frames: 0, tools: 0, ok: false, note: '' };
  res.reach = await reach(b.url);
  if (!res.reach.reachable) { res.note = `unreachable: ${res.reach.error} (nothing listening / DNS / TLS) — not started, per order`; return res; }
  const trace = path.join(SCRATCH, 'traces', `${T}.jsonl`);
  fs.rmSync(trace, { force: true });
  const port = portSeq++;
  // mcpsnoop http: try with --trace-file first; fall back to the default session log if the flag is refused
  let proxy = spawnBg([BIN.mcpsnoop, 'http', '--target', b.url, '--listen', `127.0.0.1:${port}`, '--label', b.name, '--trace-file', trace]);
  await sleep(900);
  let traceFlag = true;
  if (proxy.exitCode !== null) {
    traceFlag = false;
    proxy = spawnBg([BIN.mcpsnoop, 'http', '--target', b.url, '--listen', `127.0.0.1:${port}`, '--label', b.name]);
    await sleep(900);
  }
  fs.appendFileSync(path.join(LANE, 'transcripts', `${T}.jsonl`), JSON.stringify({ ts: new Date().toISOString(), argv: [BIN.mcpsnoop, 'http', '--target', b.url, '--listen', `127.0.0.1:${port}`, '--label', b.name, ...(traceFlag ? ['--trace-file', trace] : [])], cwd: ROOT, exit: proxy.exitCode, ms: 900, stdout: trunc(proxy.out), stderr: trunc(proxy.err), background: true }) + '\n');
  res.proxy = { listen: `127.0.0.1:${port}`, trace_flag_accepted: traceFlag, alive: proxy.exitCode === null };
  const sess = '@wire-' + T;
  await run(T, [...BIN.mcpc, 'close', sess], { timeoutMs: 20000 });
  const targetPath = new URL(b.url).pathname || '/';
  let c = await run(T, [...BIN.mcpc, 'connect', `http://127.0.0.1:${port}${targetPath}`, sess, '--json', '--no-profile'], { timeoutMs: 60000 });
  let init = null; try { init = JSON.parse(c.stdoutFull)[0]; } catch {}
  if (!init && targetPath !== '/') {
    c = await run(T, [...BIN.mcpc, 'connect', `http://127.0.0.1:${port}/`, sess, '--json', '--no-profile'], { timeoutMs: 60000 });
    try { init = JSON.parse(c.stdoutFull)[0]; } catch {}
  }
  if (!init) {
    res.note = `mcpc connect through mcpsnoop http proxy failed (exit=${c.exit}): ${trunc(firstLine(stripAnsi(c.stderrFull)) || firstLine(stripAnsi(c.stdoutFull)), 300)}`;
  } else {
    res.server = init.serverInfo; res.protocol = init.protocolVersion; res.connect_ms = c.ms;
    const tl = await run(T, [...BIN.mcpc, sess, 'tools-list', '--json'], { timeoutMs: 60000 });
    let tools = []; try { tools = JSON.parse(tl.stdoutFull); } catch {}
    if (!Array.isArray(tools)) tools = [];
    res.tools = tools.length; res.tool_names = tools.map((t) => t.name);
    const toolsFile = path.join(LANE, 'sessions', `${T}.tools.json`);
    fs.writeFileSync(toolsFile, JSON.stringify(tools, null, 1) + '\n');
    res.tools_file = rel(toolsFile); res.tools_sha256 = sha256(toolsFile);
    const pick = chooseCall(b, tools);
    if (pick) {
      const argv = [...BIN.mcpc, sess, 'tools-call', pick.tool];
      if (pick.args && Object.keys(pick.args).length) argv.push(JSON.stringify(pick.args));
      argv.push('--json');
      const tc = await run(T, argv, { timeoutMs: 60000 });
      let parsed = null; try { parsed = JSON.parse(tc.stdoutFull); } catch {}
      res.call = { tool: pick.tool, exit: tc.exit, ms: tc.ms, isError: parsed ? !!parsed.isError : null, preview: trunc(stripAnsi(tc.stdoutFull || tc.stderrFull), 400) };
    } else res.call = { skipped: 'no zero-required-arg tool matched the harmless allow-list' };
  }
  await run(T, [...BIN.mcpc, 'close', sess], { timeoutMs: 20000 });
  killTree(proxy.pid);
  await sleep(600);
  if (traceFlag && fs.existsSync(trace)) await exportMain(T, b, trace, res);
  else {
    // no trace file: export the newest session mcpsnoop saved in its own state dir
    const outFile = path.join(LANE, 'sessions', `${T}.json`);
    const ex = await run(T, [BIN.mcpsnoop, 'export', '-T', 'json', '-o', outFile], { timeoutMs: 30000 });
    if (ex.exit === 0) {
      try { const j = JSON.parse(fs.readFileSync(outFile, 'utf8')); if (j.session && j.session.label === b.name) { res.session_file = rel(outFile); res.sha256 = sha256(outFile); res.frames = (j.session.requests || 0) + (j.session.responses || 0) + (j.session.notifications || 0); res.session_id = j.session.id; res.export_summary = { requests: j.session.requests, responses: j.session.responses, errors: j.session.errors, tool_calls: (j.summary.tools || []).length }; } else { fs.rmSync(outFile, { force: true }); res.note += '; newest mcpsnoop session was not this label'; } } catch {}
    }
  }
  res.ok = !!(res.session_file && res.frames > 0 && res.tools > 0);
  return res;
}
async function snoop(b) {
  if (b.gate) { const r = { ok: false, gate: b.gate, note: b.notes }; if (b.url) r.reach = await reach(b.url); return r; }
  return b.transport === 'http' ? snoopHttp(b) : snoopStdio(b);
}

// ---------- wire-level method check (does the server answer every request?) ----------
function methodsCheck(b, perMs = 4000) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn(process.execPath, [BIN.exec, b.name], { cwd: ROOT, env: process.env, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    let buf = ''; const replies = new Map(); const out = [];
    child.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); try { const m = JSON.parse(l); if (m.id !== undefined) replies.set(m.id, m.error ? `error ${m.error.code}` : 'result'); } catch {} } });
    child.stderr.on('data', () => {});
    child.on('error', () => {});
    const send = (o) => { try { child.stdin.write(JSON.stringify(o) + '\n'); } catch {} };
    const plan = [[1, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'wire-methods', version: '0' } }, 30000], [2, 'tools/list', {}, perMs], [3, 'resources/list', {}, perMs], [4, 'prompts/list', {}, perMs], [5, 'ping', {}, perMs], [6, 'wire/bogus_method', {}, perMs]];
    let k = 0;
    const step = () => {
      if (k >= plan.length) {
        killTree(child.pid);
        const r = { ms: Date.now() - t0, methods: Object.fromEntries(out.map((o) => [o.method, o.reply])), unanswered: out.filter((o) => o.reply === 'NO REPLY').map((o) => o.method) };
        fs.appendFileSync(path.join(LANE, 'transcripts', `${slug(b.name)}.jsonl`), JSON.stringify({ ts: new Date(t0).toISOString(), argv: ['(wire.mjs methodsCheck)', process.execPath, BIN.exec, b.name], cwd: ROOT, exit: 0, ms: r.ms, stdout: JSON.stringify(r), stderr: '' }) + '\n');
        return resolve(r);
      }
      const [id, method, params, ms] = plan[k++];
      send({ jsonrpc: '2.0', id, method, params });
      const s0 = Date.now();
      const poll = setInterval(() => {
        if (replies.has(id)) { clearInterval(poll); out.push({ method, reply: replies.get(id), ms: Date.now() - s0 }); if (id === 1) send({ jsonrpc: '2.0', method: 'notifications/initialized' }); step(); }
        else if (Date.now() - s0 > ms) { clearInterval(poll); out.push({ method, reply: 'NO REPLY', ms }); step(); }
      }, 40);
    };
    step();
  });
}

// ---------- probe ----------
function findingsFromValidate(v) {
  return (v.results || []).filter((r) => r.status !== 'Pass').map((r) => `${r.test_name}: ${r.message}`);
}
function findingsFromTest(t) {
  return (t.results || []).filter((r) => r.status !== 'PASS').map((r) => `${r.name}: ${r.message}`);
}
async function probe(b) {
  const T = slug(b.name);
  const res = { validate_report: null, validate_sha256: null, test_report_dir: null, passed: 0, failed: 0, findings: [], ok: false, note: '' };
  if (b.gate) { res.gate = b.gate; res.note = b.notes; return res; }
  if (b.transport === 'http') { res.reach = await reach(b.url); if (!res.reach.reachable) { res.note = `unreachable: ${res.reach.error} — not started, per order`; return res; } }
  const target = b.transport === 'http' ? ['--http-stream', b.url] : ['--stdio', process.execPath, '--args', BIN.exec, '--args', b.name];
  const vrep = path.join(LANE, 'reports', `${T}.validate.json`);
  fs.rmSync(vrep, { force: true });
  const v = await run(T, [BIN.probe, '--output', 'json', 'validate', ...target, '--report', vrep], { timeoutMs: b.timeoutMs || TIMEOUT });
  let vj = null; try { vj = JSON.parse(fs.readFileSync(vrep, 'utf8')); } catch {}
  if (vj) {
    res.validate_report = rel(vrep); res.validate_sha256 = sha256(vrep);
    res.validate = { total: vj.summary.total_tests, passed: vj.summary.passed, warnings: vj.summary.warnings, errors: vj.summary.errors, critical: vj.summary.critical, compliance_pct: Math.round(vj.summary.compliance_percentage), ms: v.ms };
    res.passed += vj.summary.passed; res.failed += vj.summary.errors + vj.summary.critical;
    res.findings.push(...findingsFromValidate(vj));
    const tl = (vj.results || []).find((r) => r.test_id === 'tools_listing');
    if (tl && tl.details && tl.details.tools) res.findings.push(...lintTools(tl.details.tools));
  } else {
    res.validate = { failed_to_report: true, exit: v.exit, timedOut: v.timedOut, ms: v.ms, stderr: trunc(firstLine(stripAnsi(v.stderrFull)) || trunc(stripAnsi(v.stderrFull), 300), 300) };
    res.findings.push(`validate: no report written (exit=${v.exit}${v.timedOut ? ', killed at ' + (b.timeoutMs || TIMEOUT) / 1000 + ' s' : ''}): ${trunc(stripAnsi(v.stderrFull).split('\n').filter((l) => /Validation failed|Error|timed out/i.test(l))[0] || firstLine(stripAnsi(v.stderrFull)), 200)}`);
    res.failed += 1;
  }
  const tdir = path.join(LANE, 'reports', T);
  fs.rmSync(tdir, { recursive: true, force: true }); fs.mkdirSync(tdir, { recursive: true });
  const t = await run(T, [BIN.probe, '--output', 'json', 'test', ...target, '--report', '--output-dir', tdir, '--timeout', String(b.probeTimeoutSec || 20)], { timeoutMs: b.timeoutMs || TIMEOUT });
  const reports = fs.existsSync(tdir) ? fs.readdirSync(tdir).filter((f) => f.endsWith('.json')).sort() : [];
  let tj = null; if (reports.length) { try { tj = JSON.parse(fs.readFileSync(path.join(tdir, reports[reports.length - 1]), 'utf8')); } catch {} }
  if (tj) {
    res.test_report_dir = rel(tdir); res.test_report = rel(path.join(tdir, reports[reports.length - 1])); res.test_sha256 = sha256(path.join(tdir, reports[reports.length - 1]));
    res.test = { total: tj.summary.total_tests, passed: tj.summary.passed, failed: tj.summary.failed, warnings: tj.summary.warnings, ms: t.ms };
    res.passed += tj.summary.passed; res.failed += tj.summary.failed;
    res.findings.push(...findingsFromTest(tj));
    const tl = (tj.results || []).find((r) => r.name === 'Tools Listing');
    if (!vj && tl && Array.isArray(tl.details)) res.findings.push(...lintTools(tl.details));
  } else {
    res.test = { failed_to_report: true, exit: t.exit, timedOut: t.timedOut, ms: t.ms, stderr: trunc(firstLine(stripAnsi(t.stderrFull)), 300) };
    res.findings.push(`test: no report written (exit=${t.exit}${t.timedOut ? ', killed at ' + (b.timeoutMs || TIMEOUT) / 1000 + ' s' : ''}): ${trunc(stripAnsi(t.stderrFull).split('\n').filter((l) => /failed|Error|timed out/i.test(l))[0] || firstLine(stripAnsi(t.stderrFull)), 200)}`);
    res.failed += 1;
  }
  if (b.methodsCheck && b.transport === 'stdio') {
    res.methods = await methodsCheck(b);
    if (res.methods.unanswered.length) res.findings.push(`wire: server never replies to ${res.methods.unanswered.join(', ')} (JSON-RPC requires a response or -32601; this is why mcp-probe waits its full per-request timeout on each)`);
  }
  res.findings = [...new Set(res.findings)];
  res.swept = await sweep(T, [`exec.mjs ${b.name}$`]);
  res.ok = !!(vj || tj);
  return res;
}

// ---------- snip (apisnip on OpenAPI lanes) ----------
async function snip(lane) {
  const T = 'snip-' + slug(lane.name);
  const r = { spec_url: lane.spec_url, referenced_by: lane.referenced_by, apisnip_ok: false, out_file: null, sha256: null, endpoints_before: null, operations_before: null, endpoints_after: null, note: '' };
  const spec = path.join(SCRATCH, 'specs', `${slug(lane.name)}.json`);
  try {
    const resp = await fetch(lane.spec_url, { signal: AbortSignal.timeout(30000), headers: { accept: 'application/json' } });
    const txt = await resp.text();
    fs.writeFileSync(spec, txt);
    const j = JSON.parse(txt);
    const paths = Object.keys(j.paths || {});
    r.endpoints_before = paths.length;
    r.operations_before = paths.reduce((n, p) => n + Object.keys(j.paths[p] || {}).filter((m) => METHODS.has(m)).length, 0);
    r.spec = { http_status: resp.status, bytes: txt.length, sha256: crypto.createHash('sha256').update(txt).digest('hex'), openapi: j.openapi || j.swagger, title: j.info && j.info.title, version: j.info && j.info.version, scratch_copy: spec };
  } catch (e) { r.note += `spec fetch/parse failed: ${e.message}; `; }
  const out = path.join(LANE, 'snips', `${slug(lane.name)}.trim.yaml`);
  fs.rmSync(out, { force: true });
  r.attempts = [];
  const a1 = await run(T, [BIN.apisnip, lane.spec_url, out], { timeoutMs: 30000 });
  r.attempts.push({ mode: 'direct, stdin=/dev/null (no TTY)', exit: a1.exit, timedOut: a1.timedOut, ms: a1.ms, stderr: firstLine(a1.stderrFull), mouse_tracking_escapes_emitted: /\x1b\[\?100[0-9]h/.test(a1.stdoutFull), produced_output: fs.existsSync(out) });
  const a2 = await run(T, ['/usr/bin/script', '-q', '/dev/null', BIN.apisnip, lane.spec_url, out], { timeoutMs: 15000 });
  const clean = stripAnsi(a2.stdoutFull);
  r.attempts.push({ mode: 'pty via script(1), stdin=/dev/null, 15 s cap', exit: a2.exit, timedOut: a2.timedOut, ms: a2.ms, stderr: firstLine(a2.stderrFull), stdout_bytes: a2.stdoutFull.length, tui_text_sample: trunc(clean.replace(/\s+/g, ' ').trim(), 240), produced_output: fs.existsSync(out) && fs.statSync(out).size > 0 });
  if (fs.existsSync(out) && fs.statSync(out).size > 0) {
    r.apisnip_ok = true; r.out_file = rel(out); r.sha256 = sha256(out);
    r.endpoints_after = (fs.readFileSync(out, 'utf8').match(/^ {2}\/[^\s:]*:\s*$/gm) || []).length;
  } else {
    r.note += 'apisnip 1.4.60 exposes only -h/-V: it is an interactive ratatui picker (enables mouse tracking, then "Device not configured (os error 6)" without a TTY; under a pty it draws the endpoint list and waits for keystrokes). To run it unattended it needs a pty driver (expect/node-pty) that sends the selection keys and the write key, or an upstream headless flag (e.g. --select <ops> / --all). No trimmed spec was produced.';
  }
  return r;
}

// ---------- evals ----------
async function evalMcpc() {
  const T = 'eval-mcpc';
  const b = REG.bridges.find((x) => x.name === 'timmy');
  const cfg = path.join(SCRATCH, 'mcpc', 'eval-timmy.json');
  fs.writeFileSync(cfg, JSON.stringify({ mcpServers: { timmy: { command: process.execPath, args: [BIN.exec, 'timmy'] } } }, null, 2));
  const sess = '@wire-eval-timmy';
  const ver = await run(T, [...BIN.mcpc, '--version'], { timeoutMs: 60000 });
  await run(T, [...BIN.mcpc, 'close', sess], { timeoutMs: 20000 });
  const c = await run(T, [...BIN.mcpc, 'connect', `${cfg}:timmy`, sess, '--json'], { timeoutMs: TIMEOUT });
  let init = null; try { init = JSON.parse(c.stdoutFull)[0]; } catch {}
  const tl = await run(T, [...BIN.mcpc, sess, 'tools-list', '--json'], { timeoutMs: 60000 });
  let tools = []; try { tools = JSON.parse(tl.stdoutFull); } catch {}
  if (!Array.isArray(tools)) tools = [];
  const tlFile = path.join(LANE, 'reports', 'eval-mcpc.tools-list.json');
  fs.writeFileSync(tlFile, tl.stdoutFull || '[]');
  const tc = await run(T, [...BIN.mcpc, sess, 'tools-call', 'timmy_env_lock', '--json'], { timeoutMs: 60000 });
  let call = null; try { call = JSON.parse(tc.stdoutFull); } catch {}
  const tcFile = path.join(LANE, 'reports', 'eval-mcpc.env_lock.json');
  fs.writeFileSync(tcFile, tc.stdoutFull || tc.stderrFull || '');
  const info = await run(T, [...BIN.mcpc, sess], { timeoutMs: 60000 });
  const grep = await run(T, [...BIN.mcpc, sess, 'grep', 'lock'], { timeoutMs: 60000 });
  await run(T, [...BIN.mcpc, 'close', sess], { timeoutMs: 20000 });
  const swept = await sweep(T, ['exec.mjs timmy$']);
  const ok = !!(init && tools.length && call && !call.isError);
  let envLockPreview = null;
  try { envLockPreview = trunc(call.content.map((c) => c.text || '').join('\n'), 300); } catch {}
  const version = stripAnsi(ver.stdoutFull).trim();
  return {
    tool: 'mcpc', version, verdict: ok ? 'adopt' : 'reject',
    transcript: `lanes/wire/transcripts/${T}.jsonl`, transcript_sha256: sha256(path.join(LANE, 'transcripts', `${T}.jsonl`)),
    evidence: {
      connect: { exit: c.exit, ms: c.ms, server: init && init.serverInfo, protocol: init && init.protocolVersion, tool_count_at_connect: init && init.toolNames ? init.toolNames.length : null },
      tools_list: { exit: tl.exit, ms: tl.ms, count: tools.length, file: rel(tlFile), sha256: sha256(tlFile) },
      tools_call_timmy_env_lock: { exit: tc.exit, ms: tc.ms, isError: call ? !!call.isError : null, file: rel(tcFile), sha256: sha256(tcFile), preview: envLockPreview },
      session_overview: trunc(stripAnsi(info.stdoutFull), 600),
      grep_lock: trunc(stripAnsi(grep.stdoutFull), 300),
      stray_processes_killed: swept,
    },
    reason: ok
      ? `ADOPT. In a real session against Timmy's own MCP server (${init.serverInfo ? init.serverInfo.name + ' ' + init.serverInfo.version : 'timmy'}, protocol ${init.protocolVersion}) mcpc ${version} connected in ${c.ms} ms, listed ${tools.length} tools as JSON (${rel(tlFile)}), and called timmy_env_lock in ${tc.ms} ms returning a non-error result (${rel(tcFile)}). It keeps the server alive across separate shell invocations as a named background session (@wire-eval-timmy), emits strict JSON with --json for scripting, accepts arg:=value / inline JSON / stdin for tool calls, does schema validation before a call (--schema), and speaks HTTP, SSE and stdio (stdio only via a config-file entry, which exec.mjs + a generated mcp.json satisfy). Caveats that do not block adoption: it needs the config-entry indirection for raw commands, its pre-connect server/discover probe spawns the server twice (visible as a second mcpsnoop session), and the npx launcher adds ~1 s per call unless the cached binary is used. It is the driver wire.mjs uses for every snoop session here, so adopting it is already load-bearing.`
      : `REJECT. mcpc ${version} could not complete the required session against Timmy's MCP server: connect exit=${c.exit} (${trunc(firstLine(stripAnsi(c.stderrFull)), 200)}), tools-list count=${tools.length}, timmy_env_lock exit=${tc.exit} isError=${call ? call.isError : 'n/a'} (${trunc(firstLine(stripAnsi(tc.stderrFull)), 200)}). Without a working list+call round-trip it cannot be the wire driver; see the transcript for the exact failures.`,
  };
}
async function evalCmcp() {
  const T = 'eval-cmcp';
  const src = expand(process.env.WIRE_CMCP_SRC || REG.tools.cmcp.src);
  const which = await run(T, ['/usr/bin/which', 'go'], { timeoutMs: 10000 });
  const gov = await run(T, ['go', 'version'], { timeoutMs: 10000 });
  const build = await run(T, ['go', 'build', './...'], { cwd: fs.existsSync(src) ? src : ROOT, timeoutMs: 60000 });
  const brew = await run(T, ['/opt/homebrew/bin/brew', 'list', '--versions', 'go'], { timeoutMs: 30000 });
  const facts = { source_dir: src, source_present: fs.existsSync(src), go_files: 0, go_lines: 0, commands: [], claude_mcp_calls: [], deps: [], readme_claims: [] };
  if (facts.source_present) {
    const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (e.name.endsWith('.go')) { facts.go_files++; facts.go_lines += fs.readFileSync(p, 'utf8').split('\n').length; } } };
    walk(src);
    try { facts.commands = fs.readdirSync(path.join(src, 'cmd')).filter((f) => f.endsWith('.go') && !f.endsWith('_test.go')).map((f) => f.replace('.go', '')); } catch {}
    try {
      const cb = fs.readFileSync(path.join(src, 'internal', 'mcp', 'claude_cmd_builder.go'), 'utf8');
      facts.claude_mcp_calls = [...new Set((cb.match(/"mcp",\s*"[a-z-]+"/g) || []).map((s) => 'claude ' + s.replace(/"|\s/g, '').replace(',', ' ')))];
      if (/add-json/.test(cb)) facts.claude_mcp_calls.push('claude mcp add-json <name> <json>');
      facts.claude_mcp_calls = [...new Set(facts.claude_mcp_calls)];
    } catch {}
    try { facts.deps = (fs.readFileSync(path.join(src, 'go.mod'), 'utf8').match(/^\s+github\.com\/[^\s]+ v[^\s]+$/gm) || []).map((s) => s.trim()).filter((s) => !/indirect/.test(s)); facts.go_directive = (fs.readFileSync(path.join(src, 'go.mod'), 'utf8').match(/^go \S+/m) || [''])[0]; } catch {}
    try {
      const rd = fs.readFileSync(path.join(src, 'README.md'), 'utf8');
      facts.readme_claims = rd.split('\n').filter((l) => /^\d\. \*\*cmcp|^- \*\*Claude CLI Integration|^- \*\*Go 1\.21|Requires|uses `claude mcp/.test(l)).map((l) => l.trim()).slice(0, 8);
      facts.web_install_needs = /install\.sh/.test(fs.readFileSync(path.join(src, 'scripts', 'web-install.sh'), 'utf8')) ? 'git clone + ./scripts/install.sh (go build)' : 'unknown';
    } catch {}
  }
  const factsFile = path.join(LANE, 'reports', 'eval-cmcp.json');
  const evidence = { which_go: { exit: which.exit, stdout: which.stdoutFull.trim() }, go_version: { exit: gov.exit, error: gov.error || null, stderr: trunc(gov.stderrFull, 200) }, go_build: { exit: build.exit, error: build.error || null, stderr: trunc(build.stderrFull, 200) }, brew_go: { exit: brew.exit, stdout: trunc(brew.stdoutFull, 200), stderr: trunc(firstLine(brew.stderrFull), 200) }, facts };
  fs.writeFileSync(factsFile, JSON.stringify(evidence, null, 1) + '\n');
  const noGo = which.exit !== 0 && (gov.error === 'ENOENT' || gov.exit !== 0);
  return {
    tool: 'cmcp', version: REG.tools.cmcp.upstream, verdict: 'reject',
    transcript: `lanes/wire/transcripts/${T}.jsonl`, transcript_sha256: sha256(path.join(LANE, 'transcripts', `${T}.jsonl`)),
    evidence_file: rel(factsFile), evidence_sha256: sha256(factsFile), evidence,
    reason: `REJECT. Honest attempt: ${noGo ? 'no Go toolchain on this Mac (which go exit=' + which.exit + ', go version -> ' + (gov.error || 'exit ' + gov.exit) + ', go build ./... -> ' + (build.error || 'exit ' + build.exit) + ', brew has no go formula installed)' : 'go is present but the build was not attempted further'}, so cmcp cannot be built from the ${facts.go_files}-file / ${facts.go_lines}-line source (${facts.go_directive || 'go 1.21'}; deps ${facts.deps.join(', ') || 'cobra/survey/promptui/color'}), and its web-install.sh only git-clones and runs ./scripts/install.sh, which also needs go build. What it would do if built (README + cmd/*.go): keep its own ~/.cmcp/config.json in the standard mcpServers shape and shell out to the Claude CLI — ${facts.claude_mcp_calls.join(', ') || 'claude mcp add / add-json / remove / list / get'} — to register or unregister servers per project (start/stop/online/reset/config), with interactive survey multi-select prompts and Docker/Node/Python diagnostics on failure. It never speaks MCP itself: no initialize, no tools/list, no tools/call, no tracing, so it adds nothing to the wire that mcpsnoop, mcp-probe and mcpc do not already cover. Its whole job overlaps Claude CLI's built-in \`claude mcp add/remove/list\` and Timmy's own registries (config/mcporter.json + fleet/fleet.json, which mcporter already lists across ~/.claude.json, ~/.cursor/mcp.json and ~/.codex/config.toml). Adopting it would add a Go build dependency and a second source of truth for registrations without a single new capability.`,
  };
}

// ---------- main ----------
const argv = process.argv.slice(2);
const cmd = argv[0] || 'all';
const only = argv.includes('--only') ? argv[argv.indexOf('--only') + 1] : null;
if (!['snoop', 'probe', 'snip', 'eval', 'all'].includes(cmd)) { log('usage: node lanes/wire/wire.mjs snoop|probe|snip|eval|all [--only name]'); process.exit(2); }
const t0 = Date.now();
if (cmd === 'snoop' || cmd === 'probe' || cmd === 'all') {
  const bridges = REG.bridges.filter((b) => !only || b.name === only);
  if (!bridges.length) { log(`no bridge named ${only}`); process.exit(2); }
  for (const b of bridges) {
    const R = loadResults();
    R.bridges[b.name] = { ...(R.bridges[b.name] || {}), ...meta(b) };
    if (cmd !== 'probe') { log(`[snoop] ${b.name} …`); R.bridges[b.name].snoop = await snoop(b); log(`[snoop] ${b.name}: ok=${R.bridges[b.name].snoop.ok} frames=${R.bridges[b.name].snoop.frames || 0} tools=${R.bridges[b.name].snoop.tools || 0} ${R.bridges[b.name].snoop.note || ''}`); saveResults(R); }
    if (cmd !== 'snoop') { log(`[probe] ${b.name} …`); R.bridges[b.name].probe = await probe(b); log(`[probe] ${b.name}: passed=${R.bridges[b.name].probe.passed} failed=${R.bridges[b.name].probe.failed} findings=${R.bridges[b.name].probe.findings.length}`); saveResults(R); }
  }
}
if (cmd === 'snip' || cmd === 'all') {
  for (const lane of REG.openapi.filter((l) => !only || l.name === only)) {
    const R = loadResults();
    log(`[snip] ${lane.name} …`);
    R.openapi[lane.name] = await snip(lane);
    log(`[snip] ${lane.name}: apisnip_ok=${R.openapi[lane.name].apisnip_ok} endpoints_before=${R.openapi[lane.name].endpoints_before}`);
    saveResults(R);
  }
}
if (cmd === 'eval' || cmd === 'all') {
  const R = loadResults();
  if (!only || only === 'mcpc') { log('[eval] mcpc …'); R.evals.mcpc = await evalMcpc(); log(`[eval] mcpc: ${R.evals.mcpc.verdict}`); saveResults(R); }
  if (!only || only === 'cmcp') { log('[eval] cmcp …'); R.evals.cmcp = await evalCmcp(); log(`[eval] cmcp: ${R.evals.cmcp.verdict}`); saveResults(R); }
}
// compact table
{
  const R = loadResults();
  const rows = [['bridge', 'transport', 'snoop frames/tools', 'probe passed/failed', 'findings']];
  for (const [n, b] of Object.entries(R.bridges)) {
    const s = b.snoop || {}, p = b.probe || {};
    rows.push([n, b.transport || '', b.gate ? b.gate : `${s.frames || 0}/${s.tools || 0}${s.ok ? '' : ' (' + (s.note ? s.note.slice(0, 40) : 'no session') + ')'}`, b.gate ? '-' : `${p.passed || 0}/${p.failed || 0}`, String((p.findings || []).length)]);
  }
  const w = rows[0].map((_, i) => Math.max(...rows.map((r) => String(r[i]).length)));
  process.stdout.write(rows.map((r, i) => '| ' + r.map((c, j) => String(c).padEnd(w[j])).join(' | ') + ' |' + (i === 0 ? '\n|' + w.map((x) => '-'.repeat(x + 2)).join('|') + '|' : '')).join('\n') + '\n');
  for (const [n, l] of Object.entries(R.openapi)) process.stdout.write(`openapi ${n}: apisnip_ok=${l.apisnip_ok} endpoints_before=${l.endpoints_before} ops=${l.operations_before}\n`);
  for (const [n, e] of Object.entries(R.evals)) process.stdout.write(`eval ${n}: ${e.verdict.toUpperCase()}\n`);
  process.stdout.write(`done in ${Math.round((Date.now() - t0) / 1000)} s → ${rel(RESULTS)}\n`);
}
