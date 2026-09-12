#!/usr/bin/env node
// lanes/abilities/probe.mjs — measure what six locally installed agent harnesses can actually do,
// by running them. Node 22+, ESM, no dependencies.
//
//   node lanes/abilities/probe.mjs [--harness a,b] [--probe one_shot,file_edits] [--timeout 120000] [--serial]
//
// Reads the per-harness plan from harnesses.json, spawns each harness with its own isolated home
// directory under the scratch root, kills anything that exceeds the per-probe timeout, writes one raw
// transcript line per spawned process to transcripts/<harness>.jsonl and the measured verdicts to
// results/<harness>.json. The OpenRouter key is read from process.env (fallback: a .env file) and is
// only ever placed in a child's environment; every string written to disk is passed through redact().

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKTREE = path.resolve(HERE, '..', '..');
const REPO_ROOT = path.resolve(WORKTREE, '..', '..', '..');
const PLAN = JSON.parse(fs.readFileSync(path.join(HERE, 'harnesses.json'), 'utf8'));
const TRANSCRIPTS = path.join(HERE, 'transcripts');
const RESULTS = path.join(HERE, 'results');

const PROMPTS = {
  one_shot: 'Reply with exactly the word PONG and nothing else',
  file_edits: 'Create a file named PROBE.txt in the current directory containing exactly the text probe-ok, then stop.',
  tool_use: 'Run the shell command `echo TOOL-OK-4471` and report its output verbatim.',
  mcp_client: 'Call the MCP tool timmy_env_lock and paste its raw JSON result.',
  browser: 'Fetch https://example.com and report the exact page title.',
  sandbox: 'Run the shell commands `hostname` and `pwd` and report both verbatim.',
};
const PROBE_ORDER = ['one_shot', 'file_edits', 'tool_use', 'browser', 'sandbox', 'mcp_client'];

// ---------------------------------------------------------------- args
const args = process.argv.slice(2);
function opt(name, dflt) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
}
const onlyHarness = opt('--harness', '').split(',').filter(Boolean);
const onlyProbe = opt('--probe', '').split(',').filter(Boolean);
const TIMEOUT = Number(opt('--timeout', PLAN.timeout_ms || 120000));
const SERIAL = args.includes('--serial');
const SCRATCH_ROOT = process.env.ABILITIES_SCRATCH || PLAN.scratch_root;

// ---------------------------------------------------------------- secrets
function loadOpenRouterKey() {
  if (process.env.OPENROUTER_API_KEY) return { key: process.env.OPENROUTER_API_KEY, source: 'process.env' };
  for (const f of [path.join(WORKTREE, '.env'), path.join(REPO_ROOT, '.env')]) {
    try {
      const m = fs.readFileSync(f, 'utf8').match(/^OPENROUTER_API_KEY=(.*)$/m);
      if (m) return { key: m[1].trim().replace(/^["']|["']$/g, ''), source: f };
    } catch {}
  }
  return { key: '', source: 'none' };
}
const OPENROUTER = loadOpenRouterKey();
const SECRETS = [OPENROUTER.key].filter((s) => s && s.length >= 8);
function redact(s) {
  if (typeof s !== 'string') return s;
  let out = s;
  for (const sec of SECRETS) out = out.split(sec).join('<REDACTED:OPENROUTER_API_KEY>');
  return out;
}

// ---------------------------------------------------------------- helpers
const HOSTNAME = os.hostname();
const HOST_SHORT = HOSTNAME.split('.')[0];
const GROUND_TRUTH = { ok: false, markers: [] }; // filled by mcpGroundTruth() before any harness runs
const MCP_TSX = PLAN.mcp_server.tsx.replaceAll('{WORKTREE}', WORKTREE);
const MCP_CLI = PLAN.mcp_server.cli.replaceAll('{WORKTREE}', WORKTREE);

function fill(str, ctx) {
  if (typeof str !== 'string') return str;
  return str
    .replaceAll('{BIN}', ctx.bin)
    .replaceAll('{HOME}', ctx.home)
    .replaceAll('{SCRATCH}', ctx.scratch)
    .replaceAll('{CWD}', ctx.cwd || '')
    .replaceAll('{PROMPT}', ctx.prompt || '')
    .replaceAll('{MODEL}', ctx.model || '')
    .replaceAll('{TSX}', MCP_TSX)
    .replaceAll('{CLI}', MCP_CLI)
    .replaceAll('{WORKTREE}', WORKTREE)
    .replaceAll('{HOMEDIR}', os.homedir());
}
function fillDeep(v, ctx) {
  if (Array.isArray(v)) return v.map((x) => fillDeep(x, ctx));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fillDeep(x, ctx)]));
  return fill(v, ctx);
}
function buildArgv(spec, h, ctx) {
  const out = [];
  for (const a of spec) {
    if (a === '...base') out.push(...(h.base_argv || []));
    else out.push(a);
  }
  return out.map((a) => fill(a, ctx));
}
function childEnv(h, ctx) {
  const env = { ...process.env };
  for (const [k, v] of Object.entries(h.env || {})) {
    if (v === '$OPENROUTER_API_KEY') {
      if (OPENROUTER.key) env[k] = OPENROUTER.key;
    } else env[k] = fill(v, ctx);
  }
  return env;
}
function trunc(s, max = 4000) {
  if (s.length <= max) return s;
  const head = Math.floor(max * 0.6);
  const tail = max - head;
  return s.slice(0, head) + `\n...[truncated ${s.length - max} chars]...\n` + s.slice(-tail);
}
function sha256File(p) {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}
function binaryInfo(bin) {
  const info = { path: bin, exists: fs.existsSync(bin) };
  if (!info.exists) return info;
  const st = fs.lstatSync(bin);
  info.symlink = st.isSymbolicLink() ? fs.realpathSync(bin) : null;
  const real = info.symlink || bin;
  const head = Buffer.alloc(4);
  const fd = fs.openSync(real, 'r');
  fs.readSync(fd, head, 0, 4, 0);
  fs.closeSync(fd);
  const magic = head.toString('hex');
  if (['cffaedfe', 'cefaedfe', 'feedfacf', 'feedface', 'cafebabe'].includes(magic)) info.kind = 'mach-o executable';
  else if (head.toString('latin1').startsWith('#!') || fs.readFileSync(real, 'utf8').startsWith('#!')) {
    const first = fs.readFileSync(real, 'utf8').split('\n')[0];
    info.kind = `script (${first.trim()})`;
  } else info.kind = 'unknown';
  info.size = fs.statSync(real).size;
  info.sha256 = sha256File(real);
  info.sha256_note = info.kind === 'mach-o executable'
    ? 'sha256 of the executable file itself'
    : 'binary is a wrapper/entry script, so this sha256 covers only the script text, not the interpreter or the package it launches';
  return info;
}
function rmrf(p) { fs.rmSync(p, { recursive: true, force: true }); }
function mkdirp(p) { fs.mkdirSync(p, { recursive: true }); }
function log(h, msg) { process.stderr.write(`[${new Date().toISOString()}] ${h}: ${msg}\n`); }

// ---------------------------------------------------------------- process runner
function runProcess({ argv, cwd, env, timeout }) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let stdout = '', stderr = '', timedOut = false, exited = false;
    let child;
    try {
      child = spawn(argv[0], argv.slice(1), { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    } catch (e) {
      return resolve({ exit: null, signal: null, ms: 0, stdout: '', stderr: String(e), timed_out: false });
    }
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    const killGroup = (sig) => { try { process.kill(-child.pid, sig); } catch { try { child.kill(sig); } catch {} } };
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup('SIGTERM');
      setTimeout(() => { if (!exited) killGroup('SIGKILL'); }, 5000);
    }, timeout);
    child.on('error', (e) => { stderr += `\n[spawn error] ${e.message}`; });
    child.on('close', (code, signal) => {
      exited = true;
      clearTimeout(timer);
      // make sure nothing in the group lingers (MCP servers, daemons the CLI forked)
      setTimeout(() => killGroup('SIGKILL'), 50);
      resolve({ exit: code, signal, ms: Date.now() - t0, stdout, stderr, timed_out: timedOut });
    });
  });
}

// ---------------------------------------------------------------- per-harness session
class Session {
  constructor(name, h) {
    this.name = name;
    this.h = h;
    this.lines = [];
    this.i = 0;
    this.transcriptPath = path.join(TRANSCRIPTS, `${name}.jsonl`);
    fs.writeFileSync(this.transcriptPath, '');
    this.scratch = path.join(SCRATCH_ROOT, name);
    this.home = path.join(this.scratch, 'home');
    this.ctx = { bin: h.bin, home: this.home, scratch: this.scratch, model: h.model };
    this.raw = {}; // full (untruncated) outputs keyed by line id, for evaluation
  }
  async exec(probe, argv, cwd, extraCtx = {}) {
    const ctx = { ...this.ctx, ...extraCtx, cwd };
    const env = childEnv(this.h, ctx);
    mkdirp(cwd);
    const r = await runProcess({ argv, cwd, env, timeout: TIMEOUT });
    const id = ++this.i;
    const line = {
      i: id,
      ts: new Date().toISOString(),
      probe,
      argv: argv.map(redact),
      cwd,
      exit: r.exit,
      ms: r.ms,
      stdout: redact(trunc(r.stdout)),
      stderr: redact(trunc(r.stderr)),
      timed_out: r.timed_out,
    };
    this.lines.push(line);
    fs.appendFileSync(this.transcriptPath, JSON.stringify(line) + '\n');
    this.raw[id] = { stdout: redact(r.stdout), stderr: redact(r.stderr), exit: r.exit, timed_out: r.timed_out, ms: r.ms, argv: line.argv, cwd };
    log(this.name, `#${id} ${probe} exit=${r.exit} ${r.ms}ms${r.timed_out ? ' TIMED OUT' : ''}`);
    return { id, ...this.raw[id] };
  }
  out(id) { const r = this.raw[id]; return r ? r.stdout + '\n' + r.stderr : ''; }
  writeFiles(files, ctx) {
    const written = [];
    for (const f of files || []) {
      if (f.copy) {
        // read-only use of an existing directory: copied into the isolated scratch tree
        const src = fill(f.copy, { ...this.ctx, ...ctx });
        const dst = fill(f.to, { ...this.ctx, ...ctx });
        if (fs.existsSync(src)) { mkdirp(path.dirname(dst)); fs.cpSync(src, dst, { recursive: true }); written.push({ copied: src, to: dst }); }
        else written.push({ copied: src, to: dst, skipped: 'source missing' });
        continue;
      }
      const p = fill(f.path, { ...this.ctx, ...ctx });
      mkdirp(path.dirname(p));
      const body = f.json !== undefined ? JSON.stringify(fillDeep(f.json, { ...this.ctx, ...ctx }), null, 2) + '\n' : fill(f.text, { ...this.ctx, ...ctx });
      fs.writeFileSync(p, body);
      written.push({ path: p, bytes: body.length });
    }
    return written;
  }
}

// ---------------------------------------------------------------- ground truth for the MCP probe
async function mcpGroundTruth() {
  // Speak MCP over stdio to Timmy's server ourselves, so a harness's pasted result can be checked
  // against distinctive real values (hallucinated JSON will not contain the real sha256s).
  return new Promise((resolve) => {
    const child = spawn(MCP_TSX, [MCP_CLI, 'mcp', 'serve'], { cwd: SCRATCH_ROOT, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    let buf = '', result = null;
    const send = (o) => child.stdin.write(JSON.stringify(o) + '\n');
    child.stdout.on('data', (d) => {
      buf += d.toString();
      const parts = buf.split('\n'); buf = parts.pop();
      for (const l of parts) {
        try { const m = JSON.parse(l); if (m.id === 3 && m.result) result = m.result; } catch {}
      }
    });
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'probe', version: '0' } } });
    setTimeout(() => send({ jsonrpc: '2.0', method: 'notifications/initialized' }), 1500);
    setTimeout(() => send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: PLAN.mcp_server.tool, arguments: {} } }), 2000);
    const done = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} };
    const finish = () => {
      done();
      let markers = [];
      try {
        const txt = result.content[0].text;
        const j = JSON.parse(txt);
        if (j.os && j.os.build) markers.push(j.os.build);
        for (const t of Object.values(j.tools || {})) if (t.sha256) markers.push(t.sha256.slice(0, 24));
        resolve({ ok: true, markers, sample: txt.slice(0, 300) });
      } catch { resolve({ ok: false, markers: [], sample: null }); }
    };
    const iv = setInterval(() => { if (result) { clearInterval(iv); finish(); } }, 200);
    setTimeout(() => { clearInterval(iv); finish(); }, 20000);
  });
}

// ---------------------------------------------------------------- evaluation
function grepIds(session, ids, re) { return ids.filter((id) => re.test(session.out(id))); }
function snippet(text, needle, span = 160) {
  const i = text.indexOf(needle);
  if (i < 0) return null;
  return text.slice(Math.max(0, i - span / 2), i + needle.length + span / 2).replace(/\s+/g, ' ');
}
function toolCallLines(session, id) {
  const re = new RegExp(session.h.tool_call_regex || '$^');
  const text = session.out(id);
  return text.split('\n').filter((l) => l.trim() && re.test(l)).slice(0, 3).map((l) => l.slice(0, 200));
}

// ---------------------------------------------------------------- main per-harness flow
async function probeHarness(name) {
  const h = PLAN.harnesses[name];
  const S = new Session(name, h);
  const result = {
    harness: name,
    kind: h.kind,
    measured_at: new Date().toISOString(),
    host: { hostname: HOSTNAME, platform: `${os.platform()} ${os.release()} ${os.arch()}`, node: process.version },
    binary: binaryInfo(h.bin),
    version: null,
    version_raw: null,
    model: h.model,
    model_route: h.model_route,
    isolation: h.isolation,
    env_keys: Object.keys(h.env || {}),
    key_source: OPENROUTER.source,
    abilities: {},
    probes: {},
    discovery: {},
    mcp_ground_truth: { ok: GROUND_TRUTH.ok, markers: GROUND_TRUTH.markers },
    notes: [],
  };
  const wantProbe = (p) => onlyProbe.length === 0 || onlyProbe.includes(p);

  // fresh isolated home
  rmrf(S.scratch); mkdirp(S.home);
  if (h.setup_files) result.setup_files = S.writeFiles(h.setup_files, {});

  // discovery (help/version) — always run
  for (const d of h.discovery || []) {
    const r = await S.exec(`discovery:${d.name}`, buildArgv(d.argv, h, S.ctx), S.scratch);
    result.discovery[d.name] = r.id;
    if (d.name === 'version' || (h.version && JSON.stringify(h.version.argv) === JSON.stringify(d.argv))) {
      const txt = S.out(r.id);
      const m = txt.match(new RegExp(h.version.regex));
      result.version = m ? m[1] : null;
      result.version_raw = txt.trim().split('\n').filter((l) => l.trim()).slice(-3).join(' | ').slice(0, 300);
    }
  }

  // MCP surface detection from help text
  const mcpHelpIds = (h.mcp?.surface_from || []).map((n) => result.discovery[n]).filter(Boolean);
  const mcpSurfaceIds = grepIds(S, mcpHelpIds, /mcp/i);
  const mcpSurface = mcpSurfaceIds.length > 0 || Boolean(h.mcp?.extension_dir && fs.existsSync(h.mcp.extension_dir));

  // docker before
  if (h.docker_ps) {
    const r = await S.exec('docker_ps_before', ['docker', 'ps', '--format', '{{.Names}}'], S.scratch);
    result.docker_before = { id: r.id, exit: r.exit, names: r.stdout.trim().split('\n').filter(Boolean), error: r.stderr.trim().slice(0, 200) || null };
  }

  let configured = true;
  for (const probe of PROBE_ORDER) {
    const spec = h.probes[probe];
    if (spec === null || spec === undefined) {
      result.abilities[probe] = { value: null, method: 'not run', evidence: [], note: h.null_reason || 'no probe defined for this harness' };
      continue;
    }
    if (!wantProbe(probe)) { result.abilities[probe] = { value: null, method: 'skipped', evidence: [], note: 'filtered out by --probe' }; continue; }
    if (!configured && probe !== 'one_shot') {
      result.abilities[probe] = { value: null, method: 'not run', evidence: [result.probes.one_shot?.id].filter(Boolean), note: 'skipped: one_shot could not reach a working model (not_configured)' };
      continue;
    }
    const cwd = path.join(S.scratch, 'probes', probe);
    rmrf(cwd); mkdirp(cwd);
    const ctx = { cwd, prompt: PROMPTS[probe] };
    const ev = [];
    let pre = [];

    if (probe === 'mcp_client') {
      if (!mcpSurface) {
        result.abilities[probe] = { value: false, method: 'help-text grep for /mcp/i across ' + JSON.stringify(h.mcp?.surface_from || []), evidence: mcpHelpIds, note: 'no MCP client surface found in the CLI help; probe not attempted' };
        continue;
      }
      if (!h.mcp?.setup_files && !h.mcp?.pre) {
        result.abilities[probe] = { value: null, method: 'surface only', evidence: mcpSurfaceIds, note: h.mcp?.note || 'MCP surface exists but no isolated configuration path is known; the user\'s real config was not touched' };
        continue;
      }
      if (h.mcp.setup_files) result.mcp_setup_files = S.writeFiles(h.mcp.setup_files, ctx);
      for (const p of h.mcp.pre || []) {
        const r = await S.exec(`mcp_client:${p.name}`, buildArgv(p.argv, h, { ...S.ctx, ...ctx }), cwd, ctx);
        pre.push(r.id);
      }
    }

    if (spec.model) ctx.model = spec.model; // per-probe model override (flows into argv {MODEL} and env values)
    const argv = buildArgv(spec.argv, h, { ...S.ctx, ...ctx });
    const r = await S.exec(probe, argv, cwd, ctx);
    result.probes[probe] = { id: r.id, argv: r.argv, cwd, exit: r.exit, ms: r.ms, timed_out: r.timed_out, pre_ids: pre, model: ctx.model };
    // Harnesses that stream JSON echo the user prompt back; strip every copy of the prompt (and its
    // JSON-escaped form) before looking for answer tokens, otherwise PONG / TOOL-OK-4471 would match
    // the prompt itself.
    const rawText = S.out(r.id);
    const text = rawText.split(PROMPTS[probe]).join('').split(JSON.stringify(PROMPTS[probe]).slice(1, -1)).join('');
    const exitedOnOwn = !r.timed_out && r.exit !== null;
    const tools = toolCallLines(S, r.id);
    const modelError = /"stopReason":"error"|status: 4\d\d|"error":\{|Error: OpenAI-compatible|retired at|API key not valid|rate.?limit/i.test(rawText);

    if (probe === 'one_shot') {
      const hasPong = /PONG/.test(text);
      const value = spec.expect === 'not_configured' ? false : Boolean(exitedOnOwn && hasPong);
      configured = value;
      result.abilities[probe] = {
        value,
        method: `spawn argv, ${TIMEOUT / 1000}s hard timeout (SIGTERM then SIGKILL on the process group); true iff the process exits by itself and stdout+stderr (with every echo of the prompt text removed) contains PONG`,
        evidence: [...Object.values(result.discovery), r.id],
        note: value
          ? `exit ${r.exit} after ${r.ms}ms; match: ${JSON.stringify(snippet(text, 'PONG', 120))}`
          : spec.expect === 'not_configured'
            ? `not_configured: ${h.model_route}. Attempted anyway (exit ${r.exit}): ${JSON.stringify(text.trim().slice(0, 240))}`
            : `${r.timed_out ? 'timed out' : 'exit ' + r.exit}; PONG ${hasPong ? 'present' : 'absent'}${modelError ? '; model/provider error seen in output' : ''}. tail: ${JSON.stringify(text.trim().slice(-240))}`,
      };
      if (!value && spec.expect !== 'not_configured') result.abilities[probe].note = 'not_configured or failed: ' + result.abilities[probe].note;
    } else if (probe === 'file_edits') {
      const f = path.join(cwd, 'PROBE.txt');
      let content = null;
      try { content = fs.readFileSync(f, 'utf8'); } catch {}
      const value = content !== null && content.replace(/\r?\n$/, '') === 'probe-ok';
      result.abilities[probe] = {
        value,
        method: 'after the run, read <cwd>/PROBE.txt from the fresh temp dir; true iff it exists and equals "probe-ok" (one trailing newline tolerated)',
        evidence: [r.id],
        note: content === null ? `PROBE.txt does not exist (exit ${r.exit}${r.timed_out ? ', timed out' : ''}). tail: ${JSON.stringify(text.trim().slice(-200))}` : `PROBE.txt content=${JSON.stringify(content.slice(0, 100))}; tool lines: ${JSON.stringify(tools)}`,
      };
    } else if (probe === 'tool_use') {
      const hit = /TOOL-OK-4471/.test(text);
      const fe = result.abilities.file_edits?.value === true;
      result.abilities[probe] = {
        value: Boolean(hit),
        method: 'true iff stdout+stderr (prompt echoes removed) contains TOOL-OK-4471 (as specified). Caveat: the token is in the prompt, so a model that merely repeats it would pass; corroborated with (a) tool-call event lines matched by tool_call_regex and (b) the file_edits result, which is on-disk proof of tool execution',
        evidence: [r.id, ...(result.probes.file_edits ? [result.probes.file_edits.id] : [])],
        note: `${hit ? 'token present' : 'token absent'}${modelError ? ' (model/provider error seen in output)' : ''}; tool-call lines in transcript: ${tools.length} ${JSON.stringify(tools)}; file_edits corroboration: ${fe}${h.tool_call_note ? '. ' + h.tool_call_note : ''}`,
      };
    } else if (probe === 'browser') {
      const hit = /Example Domain/.test(text);
      const low = rawText.toLowerCase();
      const browserish = /(playwright|puppeteer|chromium|chrome|browser_navigate|browser_snapshot|"browser"|browser_use|navigate)/.test(low);
      const fetchish = /(webfetch|web_fetch|fetch_url|"fetch"|curl |wget |urllib|requests\.get|http_get|\bfetch\b)/.test(low);
      result.abilities[probe] = {
        value: Boolean(hit),
        method: 'true iff stdout+stderr contains "Example Domain"; the mechanism (real browser vs plain HTTP fetch) is inferred from tool names in the transcript, which is only visible when the harness streams tool events',
        evidence: [r.id],
        note: `${hit ? 'title reported' : 'title absent'}; mechanism: ${browserish ? 'browser-like tool names seen' : fetchish ? 'plain fetch/curl-like names seen' : 'not visible in output'}; tool lines: ${JSON.stringify(tools)}`,
      };
    } else if (probe === 'sandbox') {
      const sawHost = text.includes(HOSTNAME) || new RegExp(`\\b${HOST_SHORT}\\b`).test(text);
      const sawCwd = text.includes(cwd) || text.includes(cwd.replace(/^\/private/, ''));
      const otherPath = /(\/workspace|\/app\b|\/home\/[a-z]+|\/root\b|\/openhands|\/sandbox)/.test(text) && !sawCwd;
      const otherHost = /hostname[^\n]{0,60}?\b[0-9a-f]{12}\b/i.test(text) && !sawHost; // docker-style container-id hostname next to the word hostname
      let value, note;
      if (sawHost && sawCwd) { value = false; note = `reported this machine's hostname (${HOSTNAME}) and the real temp cwd, so tools run directly on the host`; }
      else if (otherHost || otherPath) { value = true; note = `reported a different hostname/path than the host (${otherHost ? 'container-style hostname' : ''}${otherPath ? ' container-style path' : ''})`; }
      else if (sawHost) { value = false; note = `the host's own hostname (${HOSTNAME}) was reported (cwd not echoed); no container indicators`; }
      else if (sawCwd) { value = null; note = 'only the temp cwd path appears (it can come from session metadata rather than from running pwd) and no hostname was reported; cannot determine'; }
      else { value = null; note = 'output contained neither the host hostname/cwd nor container indicators — the commands were probably not run; cannot determine'; }
      if (modelError && value !== true) note += ' (model/provider error seen in output)';
      result.abilities[probe] = {
        value,
        method: `compare reported hostname/pwd with this machine (hostname=${HOSTNAME}, cwd=<temp dir>); a different hostname or a container-style path means sandboxed`,
        evidence: [r.id],
        note: `${note}. tail: ${JSON.stringify(text.trim().slice(-200))}`,
      };
      if (h.docker_ps) {
        const d = await S.exec('docker_ps_after', ['docker', 'ps', '--format', '{{.Names}}'], S.scratch);
        result.docker_after = { id: d.id, exit: d.exit, names: d.stdout.trim().split('\n').filter(Boolean), error: d.stderr.trim().slice(0, 200) || null };
        result.abilities[probe].evidence.push(result.docker_before.id, d.id);
        result.abilities[probe].note += ` docker ps before/after: ${result.docker_before.exit === 0 ? result.docker_before.names.length + ' containers' : 'unavailable (' + (result.docker_before.error || 'error') + ')'} / ${d.exit === 0 ? result.docker_after.names.length + ' containers' : 'unavailable'}`;
      }
    } else if (probe === 'mcp_client') {
      const gt = result.mcp_ground_truth;
      const realMarker = gt?.markers?.find((m) => text.includes(m)) || null;
      const namedTool = /timmy_env_lock/.test(text);
      const fields = /"arch"|"platform"|\barm64\b|\bdarwin\b/.test(text);
      const value = Boolean(realMarker || (namedTool && fields && tools.length > 0));
      result.abilities[probe] = {
        value,
        method: 'isolated config registers Timmy\'s stdio MCP server; true iff the reply contains a value only the real timmy_env_lock result has (OS build id or a tool sha256 prefix obtained by calling the server directly first), or the tool name plus os/arch fields plus a visible tool-call event',
        evidence: [...mcpSurfaceIds, ...pre, r.id],
        note: `${value ? 'called' : 'not called'}: real marker ${realMarker ? 'matched (' + realMarker + ')' : 'absent'}; tool name mentioned=${namedTool}; os/arch fields=${fields}; tool lines: ${JSON.stringify(tools)}. ${h.mcp?.note || ''} tail: ${JSON.stringify(text.trim().slice(-200))}`,
      };
    }
  }

  for (const c of h.cleanup || []) await S.exec(`cleanup:${c.name}`, buildArgv(c.argv, h, S.ctx), S.scratch);

  // remove credential files the harness may have copied into its isolated home
  for (const f of ['auth.json', '.env', 'agent_settings.json']) {
    const p = path.join(S.home, f);
    if (fs.existsSync(p)) { fs.rmSync(p, { force: true }); result.notes.push(`removed isolated-home credential file after run: ${p}`); }
  }

  if (!mcpSurface && h.probes.mcp_client === null) {
    result.abilities.mcp_client = { value: false, method: 'help-text grep for /mcp/i', evidence: mcpHelpIds, note: 'no MCP surface in --help / subcommand help' };
  }
  result.transcript = path.relative(HERE, S.transcriptPath);
  result.transcript_lines = S.i;
  return result;
}

// ---------------------------------------------------------------- entry
async function main() {
  mkdirp(TRANSCRIPTS); mkdirp(RESULTS); mkdirp(SCRATCH_ROOT);
  const names = Object.keys(PLAN.harnesses).filter((n) => onlyHarness.length === 0 || onlyHarness.includes(n));
  if (names.length === 0) { console.error('no harness matched', onlyHarness); process.exit(2); }
  log('probe', `key source=${OPENROUTER.source} (${OPENROUTER.key ? 'present' : 'ABSENT'}); harnesses=${names.join(',')}; timeout=${TIMEOUT}ms; hostname=${HOSTNAME}`);
  const gt = await mcpGroundTruth();
  log('probe', `mcp ground truth ok=${gt.ok} markers=${gt.markers.length}`);
  GROUND_TRUTH.ok = gt.ok; GROUND_TRUTH.markers = gt.markers;

  const runOne = async (n) => {
    try {
      const r = await probeHarness(n);
      fs.writeFileSync(path.join(RESULTS, `${n}.json`), JSON.stringify(r, null, 2) + '\n');
      return r;
    } catch (e) {
      const r = { harness: n, error: String(e && e.stack || e) };
      fs.writeFileSync(path.join(RESULTS, `${n}.json`), JSON.stringify(r, null, 2) + '\n');
      log(n, `FAILED ${e}`);
      return r;
    }
  };
  const results = [];
  if (SERIAL) for (const n of names) results.push(await runOne(n));
  else results.push(...(await Promise.all(names.map(runOne))));

  const rows = results.map((r) => {
    const a = r.abilities || {};
    const cell = (k) => a[k] ? `${a[k].value === null ? 'null' : a[k].value}${a[k].evidence?.length ? ' [' + a[k].evidence.join(',') + ']' : ''}` : '-';
    return `${r.harness.padEnd(10)} ${String(r.version || '?').padEnd(22)} ${PROBE_ORDER.map((k) => cell(k).padEnd(16)).join(' ')}`;
  });
  console.log(`harness    version                ${PROBE_ORDER.map((k) => k.padEnd(16)).join(' ')}`);
  for (const row of rows) console.log(row);
}

main().catch((e) => { console.error(e); process.exit(1); });
