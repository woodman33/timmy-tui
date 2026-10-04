#!/usr/bin/env node
// AgentPass service lane bridge (engine-shelf/v0, service kind). Wraps the AgentPass TaskForge-bridge CLI:
//   python3 <repo>/scripts/agentpass.py taskforge health | status | audit --limit N | passport issue … | call-tool …
// JSON in, JSON out, no shell, no secrets in argv. Fake mode stays whatever AgentPass has configured.
//
//   node bridge.mjs cli     <out> <file>   taskforge <sub> [args…]     run one CLI command → <file> (raw JSON + exit code)
//   node bridge.mjs predict <workflow> <drop> <out> <stem>              seal what we expect before the gated action runs
//   node bridge.mjs act     <workflow> <out> <stem> <drop>              passport issue / call-tool from the dropped request
//   node bridge.mjs report  <workflow> <out> <stem>                     prediction vs actual → {stem}.agentpass.json
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const HOME = process.env.HOME ?? '';
const REPO = process.env.AGENTPASS_REPO_PATH ?? join(HOME, 'agent-cloud-lab', 'agentpass-lab');
const CLI = join(REPO, 'scripts', 'agentpass.py');
const PY = process.env.AGENTPASS_PYTHON ?? 'python3';
const sha = (s) => createHash('sha256').update(typeof s === 'string' ? s : JSON.stringify(s)).digest('hex');
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const writeJson = (p, o) => writeFileSync(p, JSON.stringify(o, null, 2) + '\n');
const now = () => new Date().toISOString();
const scrub = (s) => String(s ?? '').replace(HOME, '~');

function fail(out, stem, status, note, code = 3) {
  writeJson(join(out, `${stem}.agentpass.json`), { ok: false, status, note, at: now() });
  console.log(JSON.stringify({ ok: false, status, note }));
  process.exit(code);
}

function ensureCli(out, stem) {
  if (!existsSync(CLI)) fail(out, stem, 'not_configured', `AgentPass CLI not found at ${scrub(CLI)} (set AGENTPASS_REPO_PATH)`);
  const probe = spawnSync(PY, [CLI, 'taskforge', '--help'], { encoding: 'utf8', cwd: REPO, timeout: 60000 });
  if (probe.status !== 0) fail(out, stem, 'not_configured', `AgentPass CLI has no taskforge bridge yet (exit ${probe.status}): ${scrub((probe.stderr ?? '').slice(0, 200))}`);
}

function run(args) {
  const t0 = Date.now();
  const r = spawnSync(PY, [CLI, ...args], { encoding: 'utf8', cwd: REPO, timeout: 180000, env: { ...process.env } });
  let json = null; try { json = JSON.parse(r.stdout); } catch { /* raw */ }
  return { argv: ['agentpass.py', ...args.map((a) => (a.length > 200 ? a.slice(0, 200) + '…' : a))], exit: r.status, ms: Date.now() - t0, json, stdout: json ? undefined : scrub((r.stdout ?? '').slice(0, 4000)), stderr: scrub((r.stderr ?? '').slice(0, 2000)) || undefined, at: now() };
}

function cli([out, file, ...args]) {
  const stem = file.replace(/\..*$/, '');
  ensureCli(out, stem);
  const r = run(args);
  writeJson(join(out, file), r);
  console.log(JSON.stringify({ ok: r.exit === 0, exit: r.exit, ms: r.ms }));
  if (r.exit !== 0) process.exit(5);
}

function predict([workflow, drop, out, stem]) {
  const req = readJson(drop);
  let pred;
  if (workflow === 'passport-issue') {
    pred = { kind: 'agentpass.predict', workflow, at: now(), request_sha256: sha(readFileSync(drop)),
      predicted: { agent: req.agent ?? 'taskforge.local', tool: req.tool ?? 'github.create_issue', scope: req.scope ?? 'issues:write', ttl: req.ttl ?? 900, budget_usd: req.budget ?? 0.25, outcome: req.predict?.outcome ?? 'issued' },
      note: 'a passport is expected with exactly these fields; anything else is a finding' };
  } else if (workflow === 'call-tool') {
    const before = run(['taskforge', 'status']);
    const audit_before = before.json?.counts?.auditEvents ?? null;
    pred = { kind: 'agentpass.predict', workflow, at: now(), request_sha256: sha(readFileSync(drop)),
      predicted: { agent: req.agent ?? 'taskforge.local', tool: req.tool ?? 'github.create_issue', payload_sha256: sha(JSON.stringify(req.payload ?? {})), audit_events_before: audit_before, audit_delta: req.predict?.audit_delta ?? 1, outcome: req.predict?.outcome ?? 'ok' },
      status_before: before.json ?? null,
      note: 'one brokered call should add exactly audit_delta events to the AgentPass audit log' };
  } else { console.log(JSON.stringify({ ok: false, error: `no prediction for ${workflow}` })); process.exit(2); }
  writeJson(join(out, `${stem}.predict.json`), pred);
  console.log(JSON.stringify({ ok: true, predicted: pred.predicted }));
}

function act([workflow, out, stem, drop]) {
  ensureCli(out, stem);
  const pred = readJson(join(out, `${stem}.predict.json`)).predicted;
  let r;
  if (workflow === 'passport-issue') {
    r = run(['taskforge', 'passport', 'issue', '--agent', pred.agent, '--tool', pred.tool, '--scope', pred.scope, '--ttl', String(pred.ttl), '--budget', String(pred.budget_usd)]);
    writeJson(join(out, `${stem}.passport.json`), r);
  } else if (workflow === 'call-tool') {
    let payload = '{}';
    try { payload = JSON.stringify(readJson(drop).payload ?? {}); } catch { /* empty payload */ }
    if (sha(payload) !== pred.payload_sha256) fail(out, stem, 'failed', 'payload changed between predict and act', 5);
    r = run(['taskforge', 'call-tool', '--agent', pred.agent, '--tool', pred.tool, '--payload', payload]);
    writeJson(join(out, `${stem}.call.json`), r);
    writeJson(join(out, `${stem}.status-after.json`), run(['taskforge', 'status']));
  } else { console.log(JSON.stringify({ ok: false, error: `no action for ${workflow}` })); process.exit(2); }
  console.log(JSON.stringify({ ok: r.exit === 0, exit: r.exit, ms: r.ms }));
  if (r.exit !== 0) fail(out, stem, 'failed', `agentpass.py exited ${r.exit}: ${r.stderr ?? ''}`.slice(0, 300), 5);
}

function report([workflow, out, stem]) {
  const rd = (n) => (existsSync(join(out, n)) ? readJson(join(out, n)) : null);
  let rep;
  if (workflow === 'broker-health') {
    const h = rd(`${stem}.health.json`)?.json ?? null, s = rd(`${stem}.status.json`)?.json ?? null;
    rep = { ok: !!h?.ok && !!s?.ok, status: h?.ok ? 'ok' : 'failed', mode: h?.mode ?? null, fake_mode: h?.fakeMode ?? null, broker_available: h?.brokerAvailable ?? null,
      packs: s?.counts?.packs ?? (s?.packs?.length ?? null), tools: s?.counts?.tools ?? (s?.tools?.length ?? null), audit_events: s?.counts?.auditEvents ?? null, pending_approvals: s?.counts?.pendingApprovals ?? null,
      pack_ids: (s?.packs ?? []).map((p) => p.id), at: now() };
  } else if (workflow === 'passport-issue') {
    const p = rd(`${stem}.predict.json`)?.predicted ?? {}, r = rd(`${stem}.passport.json`), j = r?.json ?? {};
    const pp = j.passport ?? j;
    const got = { agent: pp.agent ?? pp.agent_id ?? null, tool: pp.tool ?? (Array.isArray(pp.tools) ? pp.tools[0] : null), scope: pp.scope ?? (Array.isArray(pp.scopes) ? pp.scopes[0] : null), ttl: pp.ttl ?? pp.ttl_seconds ?? null, budget_usd: pp.budget ?? pp.budget_usd ?? null };
    const match = Object.fromEntries(Object.keys(got).map((k) => [k, got[k] == null ? null : String(got[k]) === String(p[k])]));
    rep = { ok: r?.exit === 0 && j?.ok !== false, status: r?.exit === 0 ? 'ok' : 'failed', passport_id: pp.id ?? pp.passport_id ?? null, ...got, fields_as_predicted: Object.values(match).every((v) => v !== false), match, passport_sha256: r ? sha(JSON.stringify(j)) : null, at: now() };
  } else if (workflow === 'call-tool') {
    const p = rd(`${stem}.predict.json`)?.predicted ?? {}, c = rd(`${stem}.call.json`), a = rd(`${stem}.status-after.json`);
    const after = a?.json?.counts?.auditEvents ?? null;
    const delta = after != null && p.audit_events_before != null ? after - p.audit_events_before : null;
    rep = { ok: c?.exit === 0 && c?.json?.ok !== false, status: c?.exit === 0 ? 'ok' : 'failed', agent: p.agent, tool: p.tool, approval_required: c?.json?.approvalRequired ?? c?.json?.permission?.approvalRequired ?? null,
      audit_events_before: p.audit_events_before, audit_events_after: after, audit_delta: delta, audit_delta_ok: delta == null ? null : delta === (p.audit_delta ?? 1), result_sha256: c ? sha(JSON.stringify(c.json ?? c.stdout ?? '')) : null, at: now() };
  } else { console.log(JSON.stringify({ ok: false, error: `unknown workflow ${workflow}` })); process.exit(2); }
  writeJson(join(out, `${stem}.agentpass.json`), rep);
  console.log(JSON.stringify(rep));
  if (!rep.ok) process.exit(5);
}

const [cmd, ...rest] = process.argv.slice(2);
const cmds = { cli, predict, act, report };
if (!cmds[cmd]) { console.log(JSON.stringify({ ok: false, error: 'usage: bridge.mjs cli|predict|act|report …' })); process.exit(2); }
cmds[cmd](rest);
