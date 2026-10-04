#!/usr/bin/env node
// Runable service lane bridge (engine-shelf/v0, service kind). Runable exposes a remote MCP server
// (Streamable HTTP, OAuth 2.1). This bridge speaks MCP JSON-RPC directly with Node's fetch — no MCP CLI needed —
// so a task can be started now, polled later and collected later still, each from its own drop and receipt.
//
//   node bridge.mjs predict <drop> <out> <stem>        tools/list snapshot + the expected deliverable         → {stem}.predict.json, {stem}.tools.json
//   node bridge.mjs start   <out> <stem> <drop>        tools/call <start task>                                 → {stem}.task.json
//   node bridge.mjs poll    <out> <stem> <drop>        tools/call <progress> until done / failed / time cap    → {stem}.progress.jsonl, {stem}.final.json
//   node bridge.mjs collect <out> <stem> <drop>        tools/call <files> and download what it lists           → files/*, {stem}.files.json
//   node bridge.mjs report  <workflow> <out> <stem>                                                            → {stem}.runable.json
//
// Auth: RUNABLE_ACCESS_TOKEN, or RUNABLE_CLIENT_ID + RUNABLE_CLIENT_SECRET (client_credentials against the server's
// OAuth metadata). Tokens never land in files. No token → status=not_configured, exit 3 (honesty clause).
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { join, basename } from 'node:path';

const MCP_URL = process.env.RUNABLE_MCP_URL ?? 'https://api.runable.com/api/mcp';
const AUTH_BASE = process.env.RUNABLE_AUTH_URL ?? 'https://api.runable.com';
const UA = 'timmy-tui/engine-shelf runable-lane';
const sha = (s) => createHash('sha256').update(typeof s === 'string' ? s : JSON.stringify(s)).digest('hex');
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
  const r = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: 'Basic ' + Buffer.from(`${id}:${secret}`).toString('base64'), 'user-agent': UA }, body });
  if (!r.ok) fail(out, stem, 'blocked', `token endpoint ${endpoint} returned HTTP ${r.status}`, 5);
  const j = await r.json();
  if (!j.access_token) fail(out, stem, 'blocked', 'token response had no access_token', 5);
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

async function predict([drop, out, stem]) {
  const req = readJson(drop);
  const tok = await token(out, stem);
  const mcp = new Mcp(tok);
  let tools = [];
  try { await mcp.open(); tools = await mcp.tools(); } catch (e) { fail(out, stem, e.status === 401 || e.status === 403 ? 'blocked' : 'failed', e.message, 5); }
  writeJson(join(out, `${stem}.tools.json`), { at: now(), count: tools.length, tools: tools.map((t) => ({ name: t.name, description: (t.description ?? '').slice(0, 200), input: Object.keys(t.inputSchema?.properties ?? {}) })), request_ids: mcp.requestIds });
  const chosen = { start: pick(tools, 'start'), progress: pick(tools, 'progress'), followup: pick(tools, 'followup'), stop: pick(tools, 'stop'), files: pick(tools, 'files') };
  const pred = { kind: 'runable.predict', at: now(), request_sha256: sha(readFileSync(drop)), tools_sha256: sha(tools.map((t) => t.name).sort().join(',')), chosen,
    predicted: { minutes: req.predict?.minutes ?? 10, files_min: req.predict?.files_min ?? 1, kind: req.predict?.kind ?? req.kind ?? 'document', outcome: req.predict?.outcome ?? 'done' },
    task: { prompt: req.prompt ?? req.task, mode: req.mode ?? 'agent', model: req.model ?? null, extra: req.arguments ?? {} },
    note: chosen.start ? `start via ${chosen.start}` : 'no start-task tool found in tools/list' };
  writeJson(join(out, `${stem}.predict.json`), pred);
  if (!chosen.start) fail(out, stem, 'failed', 'Runable MCP exposes no start-task tool under the expected names; see tools.json', 5);
  console.log(JSON.stringify({ ok: true, tools: tools.length, chosen }));
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
  const task = { kind: 'runable.task', at: now(), tool: pred.chosen.start, args_keys: Object.keys(args), task_id: findId(j) ?? findId({ t: textOf(result) }) ?? null, status: findStatus(j), raw: j ?? textOf(result).slice(0, 4000), ms: Date.now() - t0, request_ids: mcp.requestIds, session: !!mcp.session };
  writeJson(join(out, `${stem}.task.json`), task);
  if (!task.task_id) fail(out, stem, 'failed', 'start returned no task id; see task.json', 5);
  console.log(JSON.stringify({ ok: true, task_id: task.task_id, status: task.status, ms: task.ms }));
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
  while (Date.now() - t0 < capMin * 60000) {
    let result; try { result = await mcp.call(progressTool, { [idKey]: ref.id }); } catch (e) { appendFileSync(log, JSON.stringify({ at: now(), error: e.message }) + '\n'); await sleep(every * 1000); continue; }
    const j = jsonOf(result); last = { at: now(), n: ++n, status: findStatus(j), sha256: sha(j ?? textOf(result)), raw: j ?? textOf(result).slice(0, 2000) };
    appendFileSync(log, JSON.stringify(last) + '\n');
    if (last.status && (DONE.test(last.status) || FAILED.test(last.status))) break;
    await sleep(every * 1000);
  }
  const final = { kind: 'runable.final', at: now(), task_id: ref.id, task_id_from: ref.from, polls: n, minutes: Math.round((Date.now() - t0) / 600) / 100, status: last?.status ?? null, done: !!last?.status && DONE.test(last.status), failed: !!last?.status && FAILED.test(last.status), timed_out: !(last?.status && (DONE.test(last.status) || FAILED.test(last.status))), progress_tool: progressTool, request_ids: mcp.requestIds.length };
  writeJson(join(out, `${stem}.final.json`), final);
  console.log(JSON.stringify({ ok: final.done, status: final.status, polls: n, minutes: final.minutes }));
  if (!final.done) process.exit(final.timed_out ? 6 : 5);
}

async function collect([out, stem, drop]) {
  const ref = taskIdFrom(out, stem, drop); if (!ref) fail(out, stem, 'failed', 'no task id in the drop or a previous start in this folder', 2);
  const mcp = new Mcp(await token(out, stem)); await mcp.open();
  const tools = await mcp.tools(); const filesTool = pick(tools, 'files'); if (!filesTool) fail(out, stem, 'failed', 'no files tool exposed', 5);
  const props = Object.keys(tools.find((t) => t.name === filesTool)?.inputSchema?.properties ?? {}); const idKey = props.find((p) => /task.?id|^id$/i.test(p)) ?? 'task_id';
  let result; try { result = await mcp.call(filesTool, { [idKey]: ref.id }); } catch (e) { fail(out, stem, 'failed', e.message, 5); }
  const j = jsonOf(result); const dir = join(out, 'files'); mkdirSync(dir, { recursive: true });
  const urls = []; (function walk(o) { if (!o) return; if (typeof o === 'string' && /^https?:\/\//.test(o)) urls.push(o); else if (typeof o === 'object') Object.values(o).forEach(walk); })(j);
  const files = [];
  for (const u of [...new Set(urls)].slice(0, 50)) {
    try { const r = await fetch(u, { headers: { 'user-agent': UA } }); const buf = Buffer.from(await r.arrayBuffer()); const name = basename(new URL(u).pathname) || `file-${files.length}`; const p = join(dir, name.replace(/[^A-Za-z0-9._-]+/g, '_')); writeFileSync(p, buf); files.push({ url: u, file: basename(p), bytes: buf.length, sha256: sha(buf), http: r.status, type: r.headers.get('content-type') }); }
    catch (e) { files.push({ url: u, error: e.message }); }
  }
  const resources = (result?.content ?? []).filter((c) => c.type === 'resource' && c.resource?.text).map((c, i) => { const p = join(dir, basename(c.resource.uri ?? `resource-${i}`).replace(/[^A-Za-z0-9._-]+/g, '_')); writeFileSync(p, c.resource.text); return { uri: c.resource.uri, file: basename(p), bytes: Buffer.byteLength(c.resource.text), sha256: sha(c.resource.text) }; });
  writeJson(join(out, `${stem}.files.json`), { kind: 'runable.files', at: now(), task_id: ref.id, files_tool: filesTool, listing: j ?? textOf(result).slice(0, 4000), files: [...files, ...resources], request_ids: mcp.requestIds });
  console.log(JSON.stringify({ ok: files.length + resources.length > 0, files: files.length + resources.length }));
  if (files.length + resources.length === 0) process.exit(5);
}

function report([workflow, out, stem]) {
  const rd = (n) => (existsSync(join(out, n)) ? readJson(join(out, n)) : null);
  let rep;
  if (workflow === 'task-start') {
    const p = rd(`${stem}.predict.json`), t = rd(`${stem}.task.json`), tl = rd(`${stem}.tools.json`);
    rep = { ok: !!t?.task_id, status: t?.task_id ? 'ok' : 'failed', task_id: t?.task_id ?? null, task_status: t?.status ?? null, tool: t?.tool ?? null, tools_count: tl?.count ?? null, tools_sha256: p?.tools_sha256 ?? null, predicted_minutes: p?.predicted?.minutes ?? null, predicted_files_min: p?.predicted?.files_min ?? null, start_ms: t?.ms ?? null, request_ids: (t?.request_ids ?? []).length, at: now() };
  } else if (workflow === 'task-poll') {
    const f = rd(`${stem}.final.json`), p = rd(`${stem}.predict.json`);
    rep = { ok: !!f?.done, status: f ? (f.done ? 'ok' : f.timed_out ? 'timed_out' : 'failed') : 'failed', task_id: f?.task_id ?? null, task_status: f?.status ?? null, polls: f?.polls ?? null, minutes: f?.minutes ?? null, predicted_minutes: p?.predicted?.minutes ?? null, minutes_error_pct: p?.predicted?.minutes && f?.minutes ? Math.round(Math.abs(p.predicted.minutes - f.minutes) / f.minutes * 1000) / 10 : null, at: now() };
  } else if (workflow === 'task-collect') {
    const fl = rd(`${stem}.files.json`), p = rd(`${stem}.predict.json`);
    const n = fl?.files?.filter((x) => x.sha256).length ?? 0;
    rep = { ok: n > 0, status: n > 0 ? 'ok' : 'failed', task_id: fl?.task_id ?? null, files: n, bytes: (fl?.files ?? []).reduce((a, x) => a + (x.bytes ?? 0), 0), files_sha256: fl ? sha((fl.files ?? []).map((x) => x.sha256 ?? '').join(',')) : null, predicted_files_min: p?.predicted?.files_min ?? null, files_as_predicted: p?.predicted?.files_min != null ? n >= p.predicted.files_min : null, at: now() };
  } else { console.log(JSON.stringify({ ok: false, error: `unknown workflow ${workflow}` })); process.exit(2); }
  writeJson(join(out, `${stem}.runable.json`), rep);
  console.log(JSON.stringify(rep));
  if (!rep.ok) process.exit(5);
}

const [cmd, ...rest] = process.argv.slice(2);
const cmds = { predict, start, poll, collect, report };
if (!cmds[cmd]) { console.log(JSON.stringify({ ok: false, error: 'usage: bridge.mjs predict|start|poll|collect|report …' })); process.exit(2); }
await cmds[cmd](rest);
