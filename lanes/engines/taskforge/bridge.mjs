#!/usr/bin/env node
// TaskForge service lane bridge (engine-shelf/v0, service kind). TaskForge is the local-first workflow OS:
// prose → workflow JSON → confidence gate → executors (shell, docker, tmux, ollama, litellm, pinokio, qdrant, redis,
// agentpass …). This bridge talks to its HTTP API; nothing here runs a shell.
//
//   node bridge.mjs health  <out> <stem>                 GET /runtime/health (+ /runtime/agentpass/health)     → {stem}.health.json
//   node bridge.mjs predict <workflow> <drop> <out> <stem>  seal the expectation before parse / execute       → {stem}.predict.json
//   node bridge.mjs parse   <out> <stem> <drop>          POST /parse                                           → {stem}.workflow.json
//   node bridge.mjs execute <out> <stem> <drop>          POST /execute, then GET /logs/stream/:taskId (SSE)    → {stem}.events.jsonl, {stem}.result.json
//   node bridge.mjs report  <workflow> <out> <stem>                                                            → {stem}.taskforge.json
//
// TASKFORGE_API_URL defaults to http://127.0.0.1:3001/api. Unreachable API → status=not_configured, exit 3.
// An execute that times out or fails writes {stem}.taskforge.json itself before exiting, so the receipt seals status=timed_out / failed.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';

const API = (process.env.TASKFORGE_API_URL ?? 'http://127.0.0.1:3001/api').replace(/\/$/, '');
const UA = 'timmy-tui/engine-shelf taskforge-lane';
// sha256 of bytes when given bytes (Buffer/Uint8Array), of the string when given a string, of JSON otherwise.
const sha = (s) => createHash('sha256').update(typeof s === 'string' || s instanceof Uint8Array ? s : JSON.stringify(s)).digest('hex');
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const writeJson = (p, o) => writeFileSync(p, JSON.stringify(o, null, 2) + '\n');
const now = () => new Date().toISOString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fail(out, stem, status, note, code = 3) {
  writeJson(join(out, `${stem}.taskforge.json`), { ok: false, status, note, at: now() });
  console.log(JSON.stringify({ ok: false, status, note }));
  process.exit(code);
}

async function api(method, path, body) {
  const t0 = Date.now();
  let r;
  try { r = await fetch(`${API}${path}`, { method, headers: { 'content-type': 'application/json', accept: 'application/json', 'user-agent': UA }, body: body ? JSON.stringify(body) : undefined }); }
  catch (e) { return { reachable: false, error: e.message, ms: Date.now() - t0 }; }
  const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch { /* text */ }
  return { reachable: true, status: r.status, ok: r.ok, json, text: json ? undefined : text.slice(0, 4000), ms: Date.now() - t0, request_id: r.headers.get('x-request-id') };
}

async function health([out, stem]) {
  const h = await api('GET', '/runtime/health');
  if (!h.reachable) fail(out, stem, 'not_configured', `TaskForge API not reachable at ${API}: ${h.error}`);
  const ap = await api('GET', '/runtime/agentpass/health');
  writeJson(join(out, `${stem}.health.json`), { at: now(), api: API, health: h, agentpass: ap });
  console.log(JSON.stringify({ ok: h.ok, executors: h.json?.executors?.length ?? null }));
  if (!h.ok) process.exit(5);
}

function predict([workflow, drop, out, stem]) {
  const req = readJson(drop);
  let pred;
  if (workflow === 'workflow-parse') {
    pred = { kind: 'taskforge.predict', workflow, at: now(), request_sha256: sha(readFileSync(drop)), task_sha256: sha(req.task ?? ''),
      predicted: { steps: req.predict?.steps ?? null, executors: req.predict?.executors ?? null, gate: req.predict?.gate ?? 'auto', outcome: req.predict?.outcome ?? 'parsed' },
      note: 'the confidence gate decision (auto | review | clarify) is the prediction that matters most' };
  } else if (workflow === 'workflow-execute') {
    const steps = req.workflow?.steps ?? [];
    pred = { kind: 'taskforge.predict', workflow, at: now(), request_sha256: sha(readFileSync(drop)), workflow_sha256: sha(req.workflow ?? {}), task_id: req.taskId ?? null,
      predicted: { steps: steps.length, executors: [...new Set(steps.map((s) => s.executor ?? s.type ?? s.runtime).filter(Boolean))], minutes: req.predict?.minutes ?? Math.max(1, steps.length), failures: req.predict?.failures ?? 0, outcome: req.predict?.outcome ?? 'completed' },
      flags: { autoAccept: !!req.autoAccept, userApproved: !!req.userApproved },
      note: 'autoAccept never bypasses ALWAYS_REVIEW actions (agentpass.issue_passport / call_tool); userApproved is the only signal that does, and it must come from the operator' };
  } else { console.log(JSON.stringify({ ok: false, error: `no prediction for ${workflow}` })); process.exit(2); }
  writeJson(join(out, `${stem}.predict.json`), pred);
  console.log(JSON.stringify({ ok: true, predicted: pred.predicted }));
}

async function parse([out, stem, drop]) {
  const req = readJson(drop);
  const r = await api('POST', '/parse', { task: req.task, ...(req.context ? { context: req.context } : {}), ...(req.clarification != null ? { clarification: req.clarification } : {}) });
  if (!r.reachable) fail(out, stem, 'not_configured', `TaskForge API not reachable at ${API}: ${r.error}`);
  writeJson(join(out, `${stem}.workflow.json`), { at: now(), api: API, response: r });
  console.log(JSON.stringify({ ok: r.ok, status: r.status, steps: r.json?.workflow?.steps?.length ?? null, ms: r.ms }));
  if (!r.ok) fail(out, stem, 'failed', `POST /parse HTTP ${r.status}`, 5);
}

const TERMINAL = /^(completed|complete|done|succeeded|failed|error|cancelled|canceled|stopped)$/i;

async function execute([out, stem, drop]) {
  const req = readJson(drop);
  const pred = existsSync(join(out, `${stem}.predict.json`)) ? readJson(join(out, `${stem}.predict.json`)) : null;
  if (pred && pred.workflow_sha256 !== sha(req.workflow ?? {})) fail(out, stem, 'failed', 'workflow changed between predict and execute', 5);
  if (!req.taskId || !req.workflow) fail(out, stem, 'failed', 'drop needs {taskId, workflow} (copy them from a workflow-parse response)', 2);
  const r = await api('POST', '/execute', { taskId: req.taskId, workflow: req.workflow, ...(req.autoAccept ? { autoAccept: true } : {}), ...(req.userApproved ? { userApproved: true } : {}) });
  if (!r.reachable) fail(out, stem, 'not_configured', `TaskForge API not reachable at ${API}: ${r.error}`);
  const log = join(out, `${stem}.events.jsonl`);
  appendFileSync(log, JSON.stringify({ at: now(), event: 'execute', http: r.status, response: r.json ?? r.text }) + '\n');
  if (!r.ok) { writeJson(join(out, `${stem}.result.json`), { at: now(), task_id: req.taskId, execute: r, status: 'rejected' }); fail(out, stem, 'failed', `POST /execute HTTP ${r.status}`, 5); }
  // SSE log stream + status polling, whichever finishes first, within the cap. The stream is aborted the moment the
  // status poll sees a terminal state or the cap expires, so no fetch or reader outlives the bridge.
  const capMs = Number(req.max_minutes ?? process.env.TASKFORGE_MAX_MINUTES ?? 30) * 60000; const t0 = Date.now();
  const pollEvery = Number(req.poll_seconds ?? process.env.TASKFORGE_POLL_SECONDS ?? 5) * 1000;
  let events = 0, final = null;
  const ac = new AbortController();
  const capTimer = setTimeout(() => ac.abort(new Error('time cap reached')), capMs);
  const streaming = (async () => {
    try {
      const res = await fetch(`${API}/logs/stream/${encodeURIComponent(req.taskId)}`, { headers: { accept: 'text/event-stream', 'user-agent': UA }, signal: ac.signal });
      if (!res.ok || !res.body) { appendFileSync(log, JSON.stringify({ at: now(), event: 'stream_unavailable', http: res.status }) + '\n'); return; }
      const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = '';
      while (!final) {
        const { value, done } = await reader.read(); if (done) break;
        buf += dec.decode(value, { stream: true });
        let i; while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2);
          const ev = (block.match(/^event: (.*)$/m) ?? [])[1] ?? 'message'; const data = (block.match(/^data: (.*)$/m) ?? [])[1];
          let j = null; try { j = JSON.parse(data ?? ''); } catch { /* text */ }
          appendFileSync(log, JSON.stringify({ at: now(), event: ev, data: j ?? data, sha256: sha(data ?? '') }) + '\n'); events++;
        }
      }
    } catch (e) { appendFileSync(log, JSON.stringify({ at: now(), event: ac.signal.aborted ? 'stream_closed' : 'stream_error', error: e?.message ?? String(e) }) + '\n'); }
  })();
  while (Date.now() - t0 < capMs) {
    const s = await api('GET', `/status/${encodeURIComponent(req.taskId)}`);
    const st = s.json?.task?.status ?? s.json?.status ?? null;
    if (st && TERMINAL.test(st)) { final = { status: st, snapshot: s.json }; break; }
    await sleep(Math.min(pollEvery, Math.max(0, capMs - (Date.now() - t0))));
  }
  clearTimeout(capTimer);
  ac.abort(new Error(final ? 'task reached a terminal state' : 'time cap reached'));
  await Promise.race([streaming, sleep(2000)]);
  const s = final?.snapshot ?? (await api('GET', `/status/${encodeURIComponent(req.taskId)}`)).json;
  const stepRows = s?.steps ?? [];
  const failedTask = !!final && /fail|error|cancel|stop/i.test(final.status);
  // `status` is the lane's verdict (ok | failed | timed_out); the task's own terminal state is `task_status`
  const result = { kind: 'taskforge.result', at: now(), task_id: req.taskId, task_status: final?.status ?? null, status: !final ? 'timed_out' : failedTask ? 'failed' : 'ok', timed_out: !final, cap_minutes: capMs / 60000, minutes: Math.round((Date.now() - t0) / 600) / 100, events, steps: stepRows.length, steps_failed: stepRows.filter((x) => /fail|error/i.test(x.status ?? '')).length, steps_by_status: stepRows.reduce((a, x) => ({ ...a, [x.status ?? 'unknown']: (a[x.status ?? 'unknown'] ?? 0) + 1 }), {}), snapshot: s ?? null };
  writeJson(join(out, `${stem}.result.json`), result);
  console.log(JSON.stringify({ ok: result.status === 'ok', status: result.status, task_status: result.task_status, events, minutes: result.minutes }));
  if (result.status !== 'ok') { reportFor('workflow-execute', out, stem); process.exit(result.timed_out ? 6 : 5); }   // report sealed before the lane stops
}

function reportFor(workflow, out, stem) {
  const rd = (n) => (existsSync(join(out, n)) ? readJson(join(out, n)) : null);
  let rep;
  if (workflow === 'runtime-health') {
    const h = rd(`${stem}.health.json`); const ex = h?.health?.json?.executors ?? [];
    const up = ex.filter((e) => e.available ?? e.healthy ?? e.ok ?? /ok|healthy|available/i.test(e.status ?? ''));
    rep = { ok: !!h?.health?.ok, status: h?.health?.ok ? 'ok' : 'failed', executors: ex.length, executors_available: up.length, executor_ids: ex.map((e) => e.type ?? e.id ?? e.name).filter(Boolean), agentpass_hook: h?.agentpass?.ok ? (h.agentpass.json?.ok ? 'on' : 'off') : 'unreachable', api_ms: h?.health?.ms ?? null, at: now() };
  } else if (workflow === 'workflow-parse') {
    const p = rd(`${stem}.predict.json`)?.predicted ?? {}, w = rd(`${stem}.workflow.json`)?.response?.json ?? null;
    const steps = w?.workflow?.steps ?? []; const executors = [...new Set(steps.map((s) => s.executor ?? s.type ?? s.runtime).filter(Boolean))];
    const gate = w?.gate ?? w?.permission ?? w?.confidence?.decision ?? w?.decision ?? null; const confidence = w?.confidence?.score ?? w?.confidence ?? null;
    rep = { ok: !!w && !w.error, status: w && !w.error ? 'ok' : 'failed', task_id: w?.taskId ?? w?.task_id ?? null, steps: steps.length, executors: executors.join(','), gate: typeof gate === 'object' ? JSON.stringify(gate) : gate, confidence: typeof confidence === 'number' ? confidence : null, steps_as_predicted: p.steps == null ? null : p.steps === steps.length, gate_as_predicted: p.gate == null || gate == null ? null : String(gate).toLowerCase() === String(p.gate).toLowerCase(), workflow_sha256: w?.workflow ? sha(w.workflow) : null, mock_parser: w?.mock ?? w?.parser === 'mock' ? true : null, at: now() };
  } else if (workflow === 'workflow-execute') {
    const p = rd(`${stem}.predict.json`)?.predicted ?? {}, r = rd(`${stem}.result.json`);
    rep = { ok: r?.status === 'ok', status: r?.status ?? 'failed', task_id: r?.task_id ?? null, task_status: r?.task_status ?? null, cap_minutes: r?.cap_minutes ?? null, steps: r?.steps ?? null, steps_failed: r?.steps_failed ?? null, events: r?.events ?? null, minutes: r?.minutes ?? null, predicted_minutes: p.minutes ?? null, failures_as_predicted: p.failures == null || r?.steps_failed == null ? null : p.failures === r.steps_failed, minutes_error_pct: p.minutes && r?.minutes ? Math.round(Math.abs(p.minutes - r.minutes) / r.minutes * 1000) / 10 : null, at: now() };
  } else { console.log(JSON.stringify({ ok: false, error: `unknown workflow ${workflow}` })); process.exit(2); }
  writeJson(join(out, `${stem}.taskforge.json`), rep);
  return rep;
}

function report([workflow, out, stem]) {
  const rep = reportFor(workflow, out, stem);
  console.log(JSON.stringify(rep));
  if (!rep.ok) process.exit(5);
}

const [cmd, ...rest] = process.argv.slice(2);
const cmds = { health, predict, parse, execute, report };
if (!cmds[cmd]) { console.log(JSON.stringify({ ok: false, error: 'usage: bridge.mjs health|predict|parse|execute|report …' })); process.exit(2); }
await cmds[cmd](rest);
