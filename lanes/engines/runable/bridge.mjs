#!/usr/bin/env node
// Runable service lane bridge (engine-shelf/v0, service kind). Runable exposes a remote MCP server
// (Streamable HTTP, OAuth 2.1). This bridge speaks MCP JSON-RPC directly with Node's fetch — no MCP CLI needed —
// so a task can be started now, polled later and collected later still, each from its own drop and receipt.
//
//   node bridge.mjs predict <drop> <out> <stem>                       tools/list snapshot + the expected deliverable  → {stem}.predict.json, {stem}.tools.json
//   node bridge.mjs predict task-poll|task-collect <drop> <out> <stem> [<project>]
//                                                                     carry the start run's prediction forward (or the drop's own) → {stem}.predict.json
//   node bridge.mjs start   <out> <stem> <drop>                       tools/call <start task>                        → {stem}.task.json
//   node bridge.mjs poll    <out> <stem> <drop>                       tools/call <progress> until done / failed / cap → {stem}.progress.jsonl, {stem}.final.json
//   node bridge.mjs collect <out> <stem> <drop>                       tools/call <files> and download what it lists  → files/*, {stem}.files.json
//   node bridge.mjs report  <workflow> <out> <stem>                                                                   → {stem}.runable.json
//
// Auth: RUNABLE_ACCESS_TOKEN, or RUNABLE_CLIENT_ID + RUNABLE_CLIENT_SECRET (client_credentials against the server's
// OAuth metadata). Tokens never land in files. No token → status=not_configured, exit 3 (honesty clause).
// A poll that hits its cap or a start/collect that fails writes {stem}.runable.json itself before exiting, so the
// engine.run receipt seals status=timed_out / failed even though the lane stops before its report step.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, appendFileSync } from 'node:fs';
import { join, basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isIP } from 'node:net';
import dns from 'node:dns/promises';

const MCP_URL = process.env.RUNABLE_MCP_URL ?? 'https://api.runable.com/api/mcp';
const AUTH_BASE = process.env.RUNABLE_AUTH_URL ?? 'https://api.runable.com';
const UA = 'timmy-tui/engine-shelf runable-lane';
// sha256 of bytes when given bytes (Buffer/Uint8Array), of the string when given a string, of JSON otherwise.
const sha = (s) => createHash('sha256').update(typeof s === 'string' || s instanceof Uint8Array ? s : JSON.stringify(s)).digest('hex');
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const writeJson = (p, o) => writeFileSync(p, JSON.stringify(o, null, 2) + '\n');
const now = () => new Date().toISOString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fail(out, stem, status, note, code = 3) {
  writeJson(join(out, `${stem}.runable.json`), { ok: false, status, note, at: now() });
  console.log(JSON.stringify({ ok: false, status, note }));
  process.exit(code);
}

async function token(out, stem) {
  if (process.env.RUNABLE_ACCESS_TOKEN) return process.env.RUNABLE_ACCESS_TOKEN;
  const id = process.env.RUNABLE_CLIENT_ID, secret = process.env.RUNABLE_CLIENT_SECRET;
  if (!id || !secret) fail(out, stem, 'not_configured', 'set RUNABLE_ACCESS_TOKEN or RUNABLE_CLIENT_ID + RUNABLE_CLIENT_SECRET');
  let endpoint = `${AUTH_BASE}/api/auth/token`;
  try { const m = await fetch(`${AUTH_BASE}/.well-known/oauth-authorization-server`, { headers: { 'user-agent': UA } }); if (m.ok) endpoint = (await m.json()).token_endpoint ?? endpoint; } catch { /* use default */ }
  const body = new URLSearchParams({ grant_type: 'client_credentials', scope: 'mcp:tasks.read mcp:tasks.write' });
  // every failure here is a written report, never an uncaught exception: the honesty clause applies to configured credentials too
  let j;
  try {
    const r = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: 'Basic ' + Buffer.from(`${id}:${secret}`).toString('base64'), 'user-agent': UA }, body });
    if (!r.ok) fail(out, stem, 'blocked', `token endpoint ${endpoint} returned HTTP ${r.status}`, 5);
    j = await r.json();
  } catch (e) {
    fail(out, stem, 'blocked', `token request to ${endpoint} failed: ${e instanceof Error ? e.message : String(e)}`, 5);
  }
  if (!j || typeof j.access_token !== 'string' || !j.access_token) fail(out, stem, 'blocked', 'token response had no access_token', 5);
  return j.access_token;
}

// Minimal Streamable-HTTP MCP client: initialize → notifications/initialized → tools/list|call. Answers may be JSON or SSE.
class Mcp {
  constructor(tok) { this.tok = tok; this.session = null; this.id = 0; this.requestIds = []; }
  async rpc(method, params, notify = false) {
    const msg = { jsonrpc: '2.0', method, ...(params !== undefined ? { params } : {}), ...(notify ? {} : { id: ++this.id }) };
    const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${this.tok}`, 'user-agent': UA, 'mcp-protocol-version': '2025-06-18' };
    if (this.session) headers['mcp-session-id'] = this.session;
    const r = await fetch(MCP_URL, { method: 'POST', headers, body: JSON.stringify(msg) });
    const rid = r.headers.get('x-request-id'); if (rid) this.requestIds.push(rid);
    const sid = r.headers.get('mcp-session-id'); if (sid) this.session = sid;
    if (notify) return null;
    if (!r.ok) throw Object.assign(new Error(`MCP ${method} HTTP ${r.status}: ${(await r.text()).slice(0, 300)}`), { status: r.status });
    const text = await r.text();
    if ((r.headers.get('content-type') ?? '').includes('text/event-stream')) {
      for (const line of text.split('\n')) if (line.startsWith('data:')) { try { const j = JSON.parse(line.slice(5).trim()); if (j.id === msg.id) return j; } catch { /* keep scanning */ } }
      throw new Error(`MCP ${method}: no JSON-RPC response for id ${msg.id} in the event stream`);
    }
    return JSON.parse(text);
  }
  async open() { const init = await this.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'timmy-tui', version: 'engine-shelf/v0' } }); await this.rpc('notifications/initialized', {}, true); return init.result ?? init; }
  async tools() { const r = await this.rpc('tools/list', {}); return r.result?.tools ?? []; }
  async call(name, args) { const r = await this.rpc('tools/call', { name, arguments: args }); if (r.error) throw new Error(`${name}: ${JSON.stringify(r.error).slice(0, 300)}`); return r.result; }
}

// Tool names are discovered, never hard-coded: the first tool whose name matches wins and the choice is recorded.
const PICK = {
  start: [/start.*task|create.*task|new.*task|run.*task|^start$/i, /start|create|run/i],
  progress: [/progress|status|check/i],
  followup: [/follow/i],
  stop: [/stop|cancel/i],
  files: [/list.*file|files|download|open.*file|artifact/i],
};
function pick(tools, kind) { for (const re of PICK[kind]) { const t = tools.find((x) => re.test(x.name)); if (t) return t.name; } return null; }
const textOf = (result) => (result?.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
function jsonOf(result) { if (result?.structuredContent) return result.structuredContent; try { return JSON.parse(textOf(result)); } catch { return null; } }
const findId = (o) => { if (!o || typeof o !== 'object') return null; for (const k of ['task_id', 'taskId', 'id', 'task']) if (typeof o[k] === 'string') return o[k]; for (const v of Object.values(o)) { const r = findId(v); if (r) return r; } return null; };
const findStatus = (o) => { if (!o || typeof o !== 'object') return null; for (const k of ['status', 'state', 'phase']) if (typeof o[k] === 'string') return o[k]; for (const v of Object.values(o)) { const r = findStatus(v); if (r) return r; } return null; };
const DONE = /^(done|complete|completed|succeeded|success|finished)$/i, FAILED = /^(failed|error|cancelled|canceled|stopped)$/i;

// ---------------------------------------------------------------------------------------------------------------
// Artifact download guard. `collect` only follows URLs the files tool returned, and only when they are https, on an
// allow-listed host (the MCP server's host, *.runable.com, and RUNABLE_ARTIFACT_HOSTS), and resolve to public
// addresses. A task result is attacker-influenced text, so loopback / link-local / private / metadata ranges are
// refused after DNS resolution, redirects are followed by hand with the same checks, and only 2xx bodies are saved.
export function isPrivateIp(ip) {
  const v = isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 0) || (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
  }
  if (v === 6) {
    const s = ip.toLowerCase();
    if (s === '::' || s === '::1') return true;
    if (s.startsWith('::ffff:')) return isPrivateIp(s.slice(7));          // IPv4-mapped
    return /^(fc|fd)/.test(s) || /^fe[89ab]/.test(s) || s.startsWith('ff') || s.startsWith('64:ff9b') || s.startsWith('2001:db8') || s.startsWith('100::');
  }
  return true;                                                               // not an address at all → treat as unsafe
}
export function hostAllowed(hostname, allow) {
  const h = String(hostname ?? '').toLowerCase().replace(/\.$/, '');
  if (!h) return false;
  return allow.some((pat) => { const p = String(pat).toLowerCase(); return p.startsWith('*.') ? h === p.slice(2) || h.endsWith(p.slice(1)) : h === p; });
}
export function defaultArtifactHosts() {
  const hosts = ['*.runable.com'];
  try { hosts.unshift(new URL(MCP_URL).hostname); } catch { /* keep defaults */ }
  for (const h of (process.env.RUNABLE_ARTIFACT_HOSTS ?? '').split(',').map((x) => x.trim()).filter(Boolean)) hosts.push(h);
  return [...new Set(hosts)];
}
// Resolves to {ok:true, url} or {ok:false, reason}. `lookup` is injectable for tests; the default is DNS.
export async function checkArtifactUrl(raw, { allow = defaultArtifactHosts(), lookup = (h) => dns.lookup(h, { all: true }) } = {}) {
  let u; try { u = new URL(raw); } catch { return { ok: false, reason: 'not a URL' }; }
  if (u.protocol !== 'https:') return { ok: false, reason: `scheme ${u.protocol} refused (https only)` };
  if (u.username || u.password) return { ok: false, reason: 'credentials in URL refused' };
  if (!hostAllowed(u.hostname, allow)) return { ok: false, reason: `host ${u.hostname} is not in the artifact allow-list` };
  const literal = u.hostname.replace(/^\[|\]$/g, '');
  if (isIP(literal)) return isPrivateIp(literal) ? { ok: false, reason: `address ${literal} is not public` } : { ok: true, url: u.toString() };
  let addrs; try { addrs = await lookup(u.hostname); } catch (e) { return { ok: false, reason: `DNS failed: ${e.message}` }; }
  const list = (Array.isArray(addrs) ? addrs : [addrs]).map((a) => (typeof a === 'string' ? a : a.address)).filter(Boolean);
  if (!list.length) return { ok: false, reason: 'DNS returned no addresses' };
  const bad = list.find((a) => isPrivateIp(a));
  return bad ? { ok: false, reason: `${u.hostname} resolves to non-public ${bad}` } : { ok: true, url: u.toString() };
}
const MAX_FILE_BYTES = Number(process.env.RUNABLE_MAX_FILE_MB ?? 200) * 1024 * 1024;
async function fetchArtifact(raw, opts = {}) {
  let url = raw;
  for (let hop = 0; hop <= 3; hop++) {
    const chk = await checkArtifactUrl(url, opts);
    if (!chk.ok) return { ok: false, url, reason: chk.reason, hop };
    const r = await fetch(chk.url, { headers: { 'user-agent': UA }, redirect: 'manual' });
    if (r.status >= 300 && r.status < 400) {
      const loc = r.headers.get('location'); if (!loc) return { ok: false, url, reason: `redirect ${r.status} without location`, hop };
      url = new URL(loc, chk.url).toString(); continue;                     // re-checked on the next hop
    }
    if (!r.ok) return { ok: false, url, reason: `HTTP ${r.status}`, http: r.status, hop };
    const declared = Number(r.headers.get('content-length') ?? 0);
    if (declared > MAX_FILE_BYTES) return { ok: false, url, reason: `content-length ${declared} exceeds cap ${MAX_FILE_BYTES}`, http: r.status, hop };
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > MAX_FILE_BYTES) return { ok: false, url, reason: `body ${buf.length} exceeds cap ${MAX_FILE_BYTES}`, http: r.status, hop };
    return { ok: true, url, buf, http: r.status, type: r.headers.get('content-type'), hop };
  }
  return { ok: false, url, reason: 'too many redirects' };
}
// ---------------------------------------------------------------------------------------------------------------

// Find the task-start run that produced <taskId> under <project>/out/runable/task-start/*/ and return its prediction.
function startPrediction(project, taskId) {
  if (!project || !taskId) return null;
  const dir = join(project, 'out', 'runable', 'task-start');
  if (!existsSync(dir)) return null;
  const runs = readdirSync(dir).map((n) => join(dir, n)).filter((p) => statSync(p).isDirectory()).sort().reverse();
  for (const r of runs) {
    for (const f of readdirSync(r).filter((n) => n.endsWith('.task.json'))) {
      try {
        const t = readJson(join(r, f));
        if (t.task_id !== taskId) continue;
        const pf = join(r, f.replace(/\.task\.json$/, '.predict.json'));
        if (!existsSync(pf)) continue;
        const bytes = readFileSync(pf);
        return { path: pf, sha256: sha(bytes), prediction: JSON.parse(bytes.toString('utf8')) };
      } catch { /* next */ }
    }
  }
  return null;
}

async function predict(args) {
  // follow-up form: predict task-poll|task-collect <drop> <out> <stem> [<project>]
  if (args[0] === 'task-poll' || args[0] === 'task-collect') return predictFollowup(args);
  const [drop, out, stem] = args;
  const req = readJson(drop);
  const tok = await token(out, stem);
  const mcp = new Mcp(tok);
  let tools = [];
  try { await mcp.open(); tools = await mcp.tools(); } catch (e) { fail(out, stem, e.status === 401 || e.status === 403 ? 'blocked' : 'failed', e.message, 5); }
  writeJson(join(out, `${stem}.tools.json`), { at: now(), count: tools.length, tools: tools.map((t) => ({ name: t.name, description: (t.description ?? '').slice(0, 200), input: Object.keys(t.inputSchema?.properties ?? {}) })), request_ids: mcp.requestIds });
  const chosen = { start: pick(tools, 'start'), progress: pick(tools, 'progress'), followup: pick(tools, 'followup'), stop: pick(tools, 'stop'), files: pick(tools, 'files') };
  const pred = { kind: 'runable.predict', workflow: 'task-start', at: now(), request_sha256: sha(readFileSync(drop)), tools_sha256: sha(tools.map((t) => t.name).sort().join(',')), chosen,
    predicted: { minutes: req.predict?.minutes ?? 10, files_min: req.predict?.files_min ?? 1, kind: req.predict?.kind ?? req.kind ?? 'document', outcome: req.predict?.outcome ?? 'done' },
    task: { prompt: req.prompt ?? req.task, mode: req.mode ?? 'agent', model: req.model ?? null, extra: req.arguments ?? {} },
    note: chosen.start ? `start via ${chosen.start}` : 'no start-task tool found in tools/list' };
  writeJson(join(out, `${stem}.predict.json`), pred);
  if (!chosen.start) fail(out, stem, 'failed', 'Runable MCP exposes no start-task tool under the expected names; see tools.json', 5);
  console.log(JSON.stringify({ ok: true, tools: tools.length, chosen }));
}

// task-poll / task-collect are their own drops, so each seals its own prediction before acting: the drop's own
// predict block wins, else the task-start run's sealed prediction for this task id (found by id under the project,
// its file hashed into this prediction), else an explicit default that the report labels as such.
function predictFollowup([workflow, drop, out, stem, projectArg]) {
  const req = readJson(drop);
  const project = projectArg ?? process.env.TIMMY_PROJECT_DIR ?? req.project ?? null;
  const task_id = req.task_id ?? req.taskId ?? req.id ?? null;
  if (!task_id) fail(out, stem, 'failed', 'drop needs a task_id', 2);
  const carried = startPrediction(project, task_id);
  const own = req.predict ?? {};
  const base = carried?.prediction?.predicted ?? {};
  const field = workflow === 'task-poll' ? 'minutes' : 'files_min';
  const fallback = workflow === 'task-poll' ? 10 : 1;
  const source = own[field] != null ? 'drop' : base[field] != null ? 'task-start' : 'default';
  const value = own[field] ?? base[field] ?? fallback;
  const pred = { kind: 'runable.predict', workflow, at: now(), request_sha256: sha(readFileSync(drop)), task_id,
    predicted: { [field]: value, outcome: own.outcome ?? (workflow === 'task-poll' ? 'done' : 'collected'), kind: own.kind ?? base.kind ?? null },
    prediction_source: source,
    carried_from: carried ? { path: carried.path.replace(process.env.HOME ?? '', '~'), sha256: carried.sha256, at: carried.prediction.at ?? null } : null,
    note: source === 'default' ? `no ${field} in the drop and no task-start prediction for ${task_id} under this project: default ${fallback} used and labelled` : `${field} taken from ${source}` };
  writeJson(join(out, `${stem}.predict.json`), pred);
  console.log(JSON.stringify({ ok: true, task_id, predicted: pred.predicted, prediction_source: source }));
}

async function start([out, stem]) {
  const pred = readJson(join(out, `${stem}.predict.json`));
  const mcp = new Mcp(await token(out, stem)); await mcp.open();
  const tools = await mcp.tools(); const tool = tools.find((t) => t.name === pred.chosen.start);
  const props = Object.keys(tool?.inputSchema?.properties ?? {});
  const args = { ...pred.task.extra };
  const promptKey = props.find((p) => /prompt|task|message|instruction|query|input|text/i.test(p)) ?? 'prompt';
  args[promptKey] = pred.task.prompt;
  if (pred.task.mode && props.find((p) => /mode/i.test(p))) args[props.find((p) => /mode/i.test(p))] = pred.task.mode;
  if (pred.task.model && props.find((p) => /model|tier/i.test(p))) args[props.find((p) => /model|tier/i.test(p))] = pred.task.model;
  const t0 = Date.now();
  let result; try { result = await mcp.call(pred.chosen.start, args); } catch (e) { fail(out, stem, 'failed', e.message, 5); }
  const j = jsonOf(result);
  const task = { kind: 'runable.task', at: now(), tool: pred.chosen.start, args_keys: Object.keys(args), task_id: findId(j) ?? findId({ t: textOf(result) }) ?? null, task_status: findStatus(j), raw: j ?? textOf(result).slice(0, 4000), ms: Date.now() - t0, request_ids: mcp.requestIds, session: !!mcp.session };
  writeJson(join(out, `${stem}.task.json`), task);
  if (!task.task_id) fail(out, stem, 'failed', 'start returned no task id; see task.json', 5);
  console.log(JSON.stringify({ ok: true, task_id: task.task_id, status: task.task_status, ms: task.ms }));
}

function taskIdFrom(out, stem, drop) {
  for (const p of [join(out, `${stem}.task.json`), drop]) if (p && existsSync(p)) { try { const j = readJson(p); const id = j.task_id ?? j.taskId ?? j.id ?? null; if (id) return { id, from: basename(p) }; } catch { /* next */ } }
  return null;
}

async function poll([out, stem, drop]) {
  const ref = taskIdFrom(out, stem, drop); if (!ref) fail(out, stem, 'failed', 'no task id in the drop or a previous start in this folder', 2);
  const req = existsSync(drop) ? readJson(drop) : {};
  const capMin = Number(req.max_minutes ?? process.env.RUNABLE_POLL_MINUTES ?? 20), every = Number(req.every_seconds ?? 20);
  const mcp = new Mcp(await token(out, stem)); await mcp.open();
  const tools = await mcp.tools(); const progressTool = pick(tools, 'progress'); if (!progressTool) fail(out, stem, 'failed', 'no progress tool exposed', 5);
  const props = Object.keys(tools.find((t) => t.name === progressTool)?.inputSchema?.properties ?? {}); const idKey = props.find((p) => /task.?id|^id$/i.test(p)) ?? 'task_id';
  const log = join(out, `${stem}.progress.jsonl`); const t0 = Date.now(); let last = null, n = 0;
  writeFileSync(log, '');
  while (Date.now() - t0 < capMin * 60000) {
    let result; try { result = await mcp.call(progressTool, { [idKey]: ref.id }); } catch (e) { appendFileSync(log, JSON.stringify({ at: now(), error: e.message }) + '\n'); await sleep(every * 1000); continue; }
    const j = jsonOf(result); last = { at: now(), n: ++n, status: findStatus(j), sha256: sha(j ?? textOf(result)), raw: j ?? textOf(result).slice(0, 2000) };
    appendFileSync(log, JSON.stringify(last) + '\n');
    if (last.status && (DONE.test(last.status) || FAILED.test(last.status))) break;
    await sleep(every * 1000);
  }
  const done = !!last?.status && DONE.test(last.status), failed = !!last?.status && FAILED.test(last.status);
  // `status` is the lane's verdict (ok | failed | timed_out); the task's own last state is `task_status`
  const final = { kind: 'runable.final', at: now(), task_id: ref.id, task_id_from: ref.from, polls: n, minutes: Math.round((Date.now() - t0) / 600) / 100, task_status: last?.status ?? null, status: done ? 'ok' : failed ? 'failed' : 'timed_out', done, failed, timed_out: !done && !failed, cap_minutes: capMin, progress_tool: progressTool, request_ids: mcp.requestIds.length };
  writeJson(join(out, `${stem}.final.json`), final);
  console.log(JSON.stringify({ ok: final.done, status: final.status, task_status: final.task_status, polls: n, minutes: final.minutes }));
  if (!final.done) { reportFor('task-poll', out, stem); process.exit(final.timed_out ? 6 : 5); }   // report sealed before the lane stops
}

async function collect([out, stem, drop]) {
  const ref = taskIdFrom(out, stem, drop); if (!ref) fail(out, stem, 'failed', 'no task id in the drop or a previous start in this folder', 2);
  const mcp = new Mcp(await token(out, stem)); await mcp.open();
  const tools = await mcp.tools(); const filesTool = pick(tools, 'files'); if (!filesTool) fail(out, stem, 'failed', 'no files tool exposed', 5);
  const props = Object.keys(tools.find((t) => t.name === filesTool)?.inputSchema?.properties ?? {}); const idKey = props.find((p) => /task.?id|^id$/i.test(p)) ?? 'task_id';
  let result; try { result = await mcp.call(filesTool, { [idKey]: ref.id }); } catch (e) { fail(out, stem, 'failed', e.message, 5); }
  const j = jsonOf(result); const dir = join(out, 'files'); mkdirSync(dir, { recursive: true });
  const urls = []; (function walk(o) { if (!o) return; if (typeof o === 'string' && /^https?:\/\//i.test(o)) urls.push(o); else if (typeof o === 'object') Object.values(o).forEach(walk); })(j);
  const allow = defaultArtifactHosts();
  const files = [], skipped = [];
  for (const u of [...new Set(urls)].slice(0, 50)) {
    try {
      const got = await fetchArtifact(u, { allow });
      if (!got.ok) { skipped.push({ url: u, reason: got.reason, http: got.http ?? null }); continue; }
      const name = basename(new URL(got.url).pathname) || `file-${files.length}`; const p = join(dir, name.replace(/[^A-Za-z0-9._-]+/g, '_') || `file-${files.length}`);
      writeFileSync(p, got.buf);
      files.push({ url: u, final_url: got.url === u ? undefined : got.url, file: basename(p), bytes: got.buf.length, sha256: sha(got.buf), http: got.http, type: got.type });
    } catch (e) { skipped.push({ url: u, reason: e.message }); }
  }
  const resources = (result?.content ?? []).filter((c) => c.type === 'resource' && c.resource?.text).map((c, i) => { const p = join(dir, basename(c.resource.uri ?? `resource-${i}`).replace(/[^A-Za-z0-9._-]+/g, '_')); writeFileSync(p, c.resource.text); return { uri: c.resource.uri, file: basename(p), bytes: Buffer.byteLength(c.resource.text), sha256: sha(c.resource.text) }; });
  writeJson(join(out, `${stem}.files.json`), { kind: 'runable.files', at: now(), task_id: ref.id, files_tool: filesTool, artifact_hosts: allow, listing: j ?? textOf(result).slice(0, 4000), files: [...files, ...resources], skipped, request_ids: mcp.requestIds });
  const n = files.length + resources.length;
  console.log(JSON.stringify({ ok: n > 0, files: n, skipped: skipped.length }));
  if (n === 0) { reportFor('task-collect', out, stem); process.exit(5); }
}

function reportFor(workflow, out, stem) {
  const rd = (n) => (existsSync(join(out, n)) ? readJson(join(out, n)) : null);
  let rep;
  if (workflow === 'task-start') {
    const p = rd(`${stem}.predict.json`), t = rd(`${stem}.task.json`), tl = rd(`${stem}.tools.json`);
    rep = { ok: !!t?.task_id, status: t?.task_id ? 'ok' : 'failed', task_id: t?.task_id ?? null, task_status: t?.task_status ?? null, tool: t?.tool ?? null, tools_count: tl?.count ?? null, tools_sha256: p?.tools_sha256 ?? null, predicted_minutes: p?.predicted?.minutes ?? null, predicted_files_min: p?.predicted?.files_min ?? null, start_ms: t?.ms ?? null, request_ids: (t?.request_ids ?? []).length, at: now() };
  } else if (workflow === 'task-poll') {
    const f = rd(`${stem}.final.json`), p = rd(`${stem}.predict.json`);
    const pm = p?.predicted?.minutes ?? null;
    rep = { ok: !!f?.done, status: f ? (f.done ? 'ok' : f.timed_out ? 'timed_out' : 'failed') : 'failed', task_id: f?.task_id ?? null, task_status: f?.task_status ?? null, polls: f?.polls ?? null, minutes: f?.minutes ?? null, cap_minutes: f?.cap_minutes ?? null,
      predicted_minutes: pm, prediction_source: p?.prediction_source ?? null, minutes_error_pct: pm && f?.minutes ? Math.round(Math.abs(pm - f.minutes) / f.minutes * 1000) / 10 : null, at: now() };
  } else if (workflow === 'task-collect') {
    const fl = rd(`${stem}.files.json`), p = rd(`${stem}.predict.json`);
    const n = fl?.files?.filter((x) => x.sha256).length ?? 0; const fm = p?.predicted?.files_min ?? null;
    rep = { ok: n > 0 && (fm == null || n >= fm), status: n > 0 ? (fm == null || n >= fm ? 'ok' : 'short') : 'failed', task_id: fl?.task_id ?? null, files: n, skipped: fl?.skipped?.length ?? 0, bytes: (fl?.files ?? []).reduce((a, x) => a + (x.bytes ?? 0), 0), files_sha256: fl ? sha((fl.files ?? []).map((x) => x.sha256 ?? '').join(',')) : null,
      predicted_files_min: fm, prediction_source: p?.prediction_source ?? null, files_as_predicted: fm != null ? n >= fm : null, at: now() };
  } else { console.log(JSON.stringify({ ok: false, error: `unknown workflow ${workflow}` })); process.exit(2); }
  writeJson(join(out, `${stem}.runable.json`), rep);
  return rep;
}

function report([workflow, out, stem]) {
  const rep = reportFor(workflow, out, stem);
  console.log(JSON.stringify(rep));
  if (!rep.ok) process.exit(5);
}

const isMain = !!process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const [cmd, ...rest] = process.argv.slice(2);
  const cmds = { predict, start, poll, collect, report };
  if (!cmds[cmd]) { console.log(JSON.stringify({ ok: false, error: 'usage: bridge.mjs predict|start|poll|collect|report …' })); process.exit(2); }
  await cmds[cmd](rest);
}
