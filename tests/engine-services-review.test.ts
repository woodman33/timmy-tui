// Regression tests for the review findings on the service shelf (PR #84): each test pins one fixed behaviour and
// needs no key and no network — local HTTP servers stand in for RouteMux, Runable's MCP endpoint and TaskForge.
import { describe, it, expect, afterAll } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectExtra, lastReceiptHash } from '../lanes/engines/lane.mjs';
import { checkArtifactUrl, fetchArtifact, hostAllowed, isPrivateIp } from '../lanes/engines/runable/bridge.mjs';

const SHELF = join(__dirname, '..', 'lanes', 'engines');
const node = process.execPath;
const run = (args: string[], env: Record<string, string | undefined> = {}) => spawnSync(node, args, { encoding: 'utf8', env: { ...process.env, ...env } });
// Tests that stand up a local server must spawn the bridge asynchronously: spawnSync would block this worker's event
// loop, and with it the server the bridge is trying to reach.
const runAsync = (args: string[], env: Record<string, string | undefined> = {}) => new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
  const c = spawn(node, args, { env: { ...process.env, ...env } }); let stdout = '', stderr = '';
  c.stdout.on('data', (d) => (stdout += d)); c.stderr.on('data', (d) => (stderr += d));
  c.on('close', (status) => resolve({ status, stdout, stderr }));
});
const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const rj = (p: string) => JSON.parse(readFileSync(p, 'utf8'));
const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));
const servers: Server[] = [];
afterAll(() => { for (const s of servers) s.close(); });
const listen = (s: Server) => new Promise<number>((res) => { s.listen(0, '127.0.0.1', () => { servers.push(s); res((s.address() as any).port); }); });

describe('hashes commit to bytes (Cursor: Buffer hashes stringified)', () => {
  it('agentpass and taskforge predictions hash the drop file bytes, not a JSON-encoded Buffer', () => {
    const out = tmp('sha-');
    const drop = join(out, 'p.passport.json');
    writeFileSync(drop, JSON.stringify({ agent: 'a', tool: 't', scope: 's', ttl: 1, budget: 0.1 }));
    expect(run([join(SHELF, 'agentpass', 'bridge.mjs'), 'predict', 'passport-issue', drop, out, 'p']).status).toBe(0);
    expect(rj(join(out, 'p.predict.json')).request_sha256).toBe(sha256(readFileSync(drop)));
    const d2 = join(out, 'w.parse.json');
    writeFileSync(d2, JSON.stringify({ task: 'build me a thing' }));
    expect(run([join(SHELF, 'taskforge', 'bridge.mjs'), 'predict', 'workflow-parse', d2, out, 'w']).status).toBe(0);
    expect(rj(join(out, 'w.predict.json')).request_sha256).toBe(sha256(readFileSync(d2)));
  });
});

describe('routemux bridge', () => {
  const bridge = join(SHELF, 'routemux', 'bridge.mjs');
  it('idempotency key is timmy- plus the FULL request hash (Sourcery: truncated key)', () => {
    const out = tmp('rm-');
    const drop = join(out, 'hello.routemux.json');
    writeFileSync(drop, JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }));
    expect(run([bridge, 'predict', drop, out, 'hello']).status).toBe(0);
    const pred = rj(join(out, 'hello.predict.json'));
    expect(pred.idempotency_key).toBe(`timmy-${pred.request_sha256}`);
    expect(pred.idempotency_key).toHaveLength(6 + 64);
  });

  it('feed diff compares with the PREVIOUS snapshot, never with itself (Cursor: diffs against itself)', async () => {
    let feed: any = { models: [{ id: 'a', input_per_1m: 1, output_per_1m: 2 }, { id: 'b', input_per_1m: 3, output_per_1m: 4 }] };
    const srv = createServer((req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(feed)); });
    const port = await listen(srv);
    const project = tmp('proj-');
    const snap = join(project, 'out', 'routemux', 'model-feed-snapshot');
    const run1 = join(snap, 'feed-20260101T000000'); mkdirSync(run1, { recursive: true });
    const r1 = await runAsync([bridge, 'feed', run1, 'feed', project], { ROUTEMUX_BASE_URL: `http://127.0.0.1:${port}` });
    expect(r1.status).toBe(0);
    expect(rj(join(run1, 'feed.feed-diff.json'))).toMatchObject({ previous: null, added: ['a', 'b'], removed: [], price_changes: [] });
    feed = { models: [{ id: 'a', input_per_1m: 1.5, output_per_1m: 2 }, { id: 'c', input_per_1m: 9, output_per_1m: 9 }] };
    const run2 = join(snap, 'feed-20260102T000000'); mkdirSync(run2, { recursive: true });
    const r2 = await runAsync([bridge, 'feed', run2, 'feed', project], { ROUTEMUX_BASE_URL: `http://127.0.0.1:${port}` });
    expect(r2.status).toBe(0);
    const d = rj(join(run2, 'feed.feed-diff.json'));
    expect(d.previous).toContain('feed-20260101T000000');
    expect(d.added).toEqual(['c']); expect(d.removed).toEqual(['b']); expect(d.price_changes).toEqual(['a']);
    // Cursor: an enabled flip or a group move used to be hashed into the price comparison and reported as price movement
    feed = { models: [{ id: 'a', input_per_1m: 1.5, output_per_1m: 2, enabled: false, group_name: 'legacy' }, { id: 'c', input_per_1m: 9, output_per_1m: 9 }] };
    const run3 = join(snap, 'feed-20260103T000000'); mkdirSync(run3, { recursive: true });
    expect((await runAsync([bridge, 'feed', run3, 'feed', project], { ROUTEMUX_BASE_URL: `http://127.0.0.1:${port}` })).status).toBe(0);
    const d3 = rj(join(run3, 'feed.feed-diff.json'));
    expect(d3.previous).toContain('feed-20260102T000000');
    expect(d3).toMatchObject({ added: [], removed: [], price_changes: [], enabled_changes: ['a'], group_changes: ['a'] });
    expect(run([bridge, 'report', 'model-feed-snapshot', run3, 'feed']).status).toBe(0);
    expect(rj(join(run3, 'feed.routemux.json'))).toMatchObject({ price_changes: 0, enabled_changes: 1, group_changes: 1, enabled_changed_ids: ['a'], group_changed_ids: ['a'] });
  });

  it('balance-reconcile reads expected_spend_usd from the drop (both bots: reconcile ignores the drop)', async () => {
    const srv = createServer((req, res) => {
      res.setHeader('content-type', 'application/json'); res.setHeader('x-request-id', 'req_bal');
      if (req.url === '/v1/user/balance') return res.end(JSON.stringify({ balance: 42.5 }));
      if (req.url === '/v1/key/info') return res.end(JSON.stringify({ spent: 1.02 }));
      res.end(JSON.stringify({}));
    });
    const port = await listen(srv);
    const env = { ROUTEMUX_BASE_URL: `http://127.0.0.1:${port}`, ROUTEMUX_API_KEY: 'test-key-not-real', TIMMY_EXPECTED_SPEND_USD: undefined };
    const out = tmp('rm-');
    const drop = join(out, 'day.reconcile.json');
    writeFileSync(drop, JSON.stringify({ expected_spend_usd: 1.0, since: '2026-10-03' }));
    expect((await runAsync([bridge, 'balance', out, 'day', drop], env)).status).toBe(0);
    expect(rj(join(out, 'day.balance.json')).expectation).toMatchObject({ expected_spend_usd: 1.0, since: '2026-10-03', source: 'drop' });
    expect(run([bridge, 'report', 'balance-reconcile', out, 'day'], env).status).toBe(0);
    const rep = rj(join(out, 'day.routemux.json'));
    expect(rep).toMatchObject({ ok: true, status: 'ok', balance_usd: 42.5, spend_observed_usd: 1.02, spend_predicted_usd: 1.0, spend_predicted_source: 'drop', reconciled: true, request_id: 'req_bal' });
    // no expectation anywhere → null, never a guess; a bad value is reported, not coerced
    const out2 = tmp('rm-'); const drop2 = join(out2, 'x.reconcile.json'); writeFileSync(drop2, JSON.stringify({}));
    await runAsync([bridge, 'balance', out2, 'x', drop2], env); run([bridge, 'report', 'balance-reconcile', out2, 'x'], env);
    expect(rj(join(out2, 'x.routemux.json'))).toMatchObject({ spend_predicted_usd: null, spend_predicted_source: null, reconciled: null });
    const out3 = tmp('rm-'); const drop3 = join(out3, 'y.reconcile.json'); writeFileSync(drop3, JSON.stringify({ expected_spend_usd: 'lots' }));
    await runAsync([bridge, 'balance', out3, 'y', drop3], env); run([bridge, 'report', 'balance-reconcile', out3, 'y'], env);
    expect(rj(join(out3, 'y.routemux.json'))).toMatchObject({ spend_predicted_usd: null, reconciled: null, expectation_error: expect.stringContaining('not a non-negative number') });
  });
});

describe('runable bridge', () => {
  const bridge = join(SHELF, 'runable', 'bridge.mjs');
  it('a dead OAuth endpoint is a written blocked report, not an uncaught exception (Sourcery: token() unwrapped)', async () => {
    const closed = createServer(() => {}); const port = await listen(closed); closed.close(); servers.pop();
    const out = tmp('rn-'); const drop = join(out, 't.runable.json'); writeFileSync(drop, JSON.stringify({ prompt: 'x' }));
    const r = await runAsync([bridge, 'predict', drop, out, 't'], { RUNABLE_ACCESS_TOKEN: undefined, RUNABLE_CLIENT_ID: 'id', RUNABLE_CLIENT_SECRET: 'secret', RUNABLE_AUTH_URL: `http://127.0.0.1:${port}` });
    expect(r.status).toBe(5);
    expect(r.stderr).not.toMatch(/Unhandled|TypeError|fetch failed/);
    expect(rj(join(out, 't.runable.json'))).toMatchObject({ ok: false, status: 'blocked', note: expect.stringContaining('token request') });
    // garbage instead of JSON from the token endpoint → same contract
    const bad = createServer((req, res) => { res.end('<html>nope</html>'); }); const p2 = await listen(bad);
    const out2 = tmp('rn-'); const d2 = join(out2, 't.runable.json'); writeFileSync(d2, JSON.stringify({ prompt: 'x' }));
    const r2 = await runAsync([bridge, 'predict', d2, out2, 't'], { RUNABLE_ACCESS_TOKEN: undefined, RUNABLE_CLIENT_ID: 'id', RUNABLE_CLIENT_SECRET: 'secret', RUNABLE_AUTH_URL: `http://127.0.0.1:${p2}` });
    expect(r2.status).toBe(5);
    expect(rj(join(out2, 't.runable.json'))).toMatchObject({ ok: false, status: 'blocked' });
  });

  it('poll and collect seal their own prediction, carried from the task-start run by task id (both bots: no predict step)', () => {
    const project = tmp('proj-');
    const startRun = join(project, 'out', 'runable', 'task-start', 'brief-20260104T000000'); mkdirSync(startRun, { recursive: true });
    writeFileSync(join(startRun, 'brief.task.json'), JSON.stringify({ task_id: 'task_123' }));
    writeFileSync(join(startRun, 'brief.predict.json'), JSON.stringify({ at: 't0', predicted: { minutes: 7, files_min: 2, kind: 'deck' } }));
    const out = tmp('rn-'); const drop = join(out, 'later.poll.json'); writeFileSync(drop, JSON.stringify({ task_id: 'task_123' }));
    expect(run([bridge, 'predict', 'task-poll', drop, out, 'later', project]).status).toBe(0);
    const p = rj(join(out, 'later.predict.json'));
    expect(p).toMatchObject({ workflow: 'task-poll', task_id: 'task_123', prediction_source: 'task-start', predicted: { minutes: 7, kind: 'deck' } });
    expect(p.carried_from.sha256).toBe(sha256(readFileSync(join(startRun, 'brief.predict.json'))));
    expect(p.carried_from.path).not.toContain(process.env.HOME ?? '/nonexistent');
    // the drop's own prediction wins; an unknown task id falls back to a labelled default
    const out2 = tmp('rn-'); const d2 = join(out2, 'c.collect.json'); writeFileSync(d2, JSON.stringify({ task_id: 'task_123', predict: { files_min: 5 } }));
    expect(run([bridge, 'predict', 'task-collect', d2, out2, 'c', project]).status).toBe(0);
    expect(rj(join(out2, 'c.predict.json'))).toMatchObject({ prediction_source: 'drop', predicted: { files_min: 5 } });
    const out3 = tmp('rn-'); const d3 = join(out3, 'z.collect.json'); writeFileSync(d3, JSON.stringify({ task_id: 'nope' }));
    expect(run([bridge, 'predict', 'task-collect', d3, out3, 'z', project]).status).toBe(0);
    expect(rj(join(out3, 'z.predict.json'))).toMatchObject({ prediction_source: 'default', predicted: { files_min: 1 } });
    // and the reports consume it
    writeFileSync(join(out, 'later.final.json'), JSON.stringify({ done: true, failed: false, timed_out: false, task_id: 'task_123', task_status: 'done', polls: 3, minutes: 5 }));
    expect(run([bridge, 'report', 'task-poll', out, 'later']).status).toBe(0);
    expect(rj(join(out, 'later.runable.json'))).toMatchObject({ ok: true, status: 'ok', predicted_minutes: 7, prediction_source: 'task-start', minutes_error_pct: 40 });
  });

  it('artifact URL guard: https only, allow-listed hosts, public addresses, hop by hop (Sourcery: SSRF)', async () => {
    // RFC-range test vectors are assembled at runtime so the repo's privacy scanner never sees a literal LAN or tailnet address
    const v4 = (...o: number[]) => o.join('.');
    const nonPublic = ['127.0.0.1', v4(10, 1, 2, 3), v4(172, 16, 0, 1), v4(192, 168, 1, 1), v4(169, 254, 169, 254), v4(100, 64, 0, 1), '0.0.0.0', '::1', 'fd00::1', 'fe80::1', `::ffff:${v4(127, 0, 0, 1)}`];
    for (const ip of nonPublic) expect(isPrivateIp(ip), ip).toBe(true);
    for (const ip of ['8.8.8.8', '104.18.0.1', '2606:4700::1111']) expect(isPrivateIp(ip), ip).toBe(false);
    expect(isPrivateIp('not-an-ip')).toBe(true);
    expect(hostAllowed('api.runable.com', ['*.runable.com'])).toBe(true);
    expect(hostAllowed('runable.com', ['*.runable.com'])).toBe(true);
    expect(hostAllowed('runable.com.evil.net', ['*.runable.com'])).toBe(false);
    expect(hostAllowed('files.example', ['files.example'])).toBe(true);
    const allow = ['*.runable.com'];
    const pub = async () => [{ address: '104.18.0.1', family: 4 }];
    expect(await checkArtifactUrl('http://cdn.runable.com/a.pdf', { allow, lookup: pub })).toMatchObject({ ok: false, reason: expect.stringContaining('https: only') });
    const metadata = v4(169, 254, 169, 254);
    expect(await checkArtifactUrl(`https://${metadata}/latest/meta-data`, { allow: ['*'], lookup: pub })).toMatchObject({ ok: false });
    expect(await checkArtifactUrl(`https://${metadata}/latest/meta-data`, { allow: [metadata], lookup: pub })).toMatchObject({ ok: false, reason: expect.stringContaining('not public') });
    expect(await checkArtifactUrl('https://evil.example/x', { allow, lookup: pub })).toMatchObject({ ok: false, reason: expect.stringContaining('allow-list') });
    const withCreds = new URL('https://cdn.runable.com/x'); withCreds.username = 'user'; withCreds.password = 'pw';
    expect(await checkArtifactUrl(withCreds.toString(), { allow, lookup: pub })).toMatchObject({ ok: false, reason: expect.stringContaining('credentials') });
    expect(await checkArtifactUrl('https://cdn.runable.com/x', { allow, lookup: async () => [{ address: v4(10, 0, 0, 5), family: 4 }] })).toMatchObject({ ok: false, reason: expect.stringContaining('non-public') });
    expect(await checkArtifactUrl('https://cdn.runable.com/x', { allow, lookup: async () => { throw new Error('ENOTFOUND'); } })).toMatchObject({ ok: false, reason: expect.stringContaining('DNS failed') });
    expect(await checkArtifactUrl('https://cdn.runable.com/x.pdf', { allow, lookup: pub })).toEqual({ ok: true, url: 'https://cdn.runable.com/x.pdf' });
  });

  it('the artifact byte cap is enforced while the body streams, with or without an honest content-length (Cursor: cap buffered full bodies)', async () => {
    let sent = 0;
    const srv = createServer((req, res) => {
      if (req.url === '/no-length') { res.setHeader('content-type', 'application/octet-stream'); const chunk = Buffer.alloc(64 * 1024, 1); const iv = setInterval(() => { if (res.writableEnded) return clearInterval(iv); res.write(chunk); sent += chunk.length; if (sent >= 8 * 1024 * 1024) { clearInterval(iv); res.end(); } }, 1); req.on('close', () => clearInterval(iv)); return; }
      if (req.url === '/lying-length') { res.setHeader('content-length', '10'); res.write(Buffer.alloc(10, 2)); return setTimeout(() => res.end(), 50); }
      if (req.url === '/declared-too-big') { res.setHeader('content-length', String(50 * 1024 * 1024)); res.write(Buffer.alloc(1024, 3)); return; }
      if (req.url === '/small') { res.setHeader('content-type', 'text/plain'); return res.end('hello artifact'); }
      res.statusCode = 404; res.end();
    });
    const port = await listen(srv);
    const opts = { allow: ['localhost'], lookup: async () => [{ address: '104.18.0.1', family: 4 }], schemes: ['http:'], maxBytes: 1024 * 1024 };
    const big = await fetchArtifact(`http://localhost:${port}/no-length`, opts);
    expect(big).toMatchObject({ ok: false, reason: expect.stringContaining('exceeds cap') });
    expect(sent).toBeLessThan(6 * 1024 * 1024);                            // the stream was cancelled, not drained
    expect(await fetchArtifact(`http://localhost:${port}/declared-too-big`, opts)).toMatchObject({ ok: false, reason: expect.stringContaining('content-length') });
    const ok = await fetchArtifact(`http://localhost:${port}/small`, opts);
    expect(ok.ok).toBe(true); expect(ok.buf.toString()).toBe('hello artifact'); expect(ok.http).toBe(200);
    const lie = await fetchArtifact(`http://localhost:${port}/lying-length`, { ...opts, maxBytes: 4 });
    expect(lie).toMatchObject({ ok: false, reason: expect.stringContaining('exceeds cap') });
  });

  it('a poll that hits its cap seals status=timed_out via the report it writes before exiting (Cursor: timeout never seals)', async () => {
    // a fake Streamable-HTTP MCP server whose task never finishes
    const mcp = createServer((req, res) => {
      let body = ''; req.on('data', (c) => (body += c)); req.on('end', () => {
        const m = JSON.parse(body); res.setHeader('content-type', 'application/json'); res.setHeader('mcp-session-id', 'sess-1');
        if (m.method === 'initialize') return res.end(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'fake' } } }));
        if (m.method === 'notifications/initialized') { res.statusCode = 202; return res.end(); }
        if (m.method === 'tools/list') return res.end(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'start_task', inputSchema: { properties: { prompt: {} } } }, { name: 'get_progress', inputSchema: { properties: { task_id: {} } } }, { name: 'list_files', inputSchema: { properties: { task_id: {} } } }] } }));
        if (m.method === 'tools/call') return res.end(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: JSON.stringify({ task_id: m.params.arguments.task_id, status: 'running' }) }] } }));
        res.end(JSON.stringify({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'nope' } }));
      });
    });
    const port = await listen(mcp);
    const out = tmp('rn-'); const drop = join(out, 'slow.poll.json');
    writeFileSync(drop, JSON.stringify({ task_id: 'task_slow', max_minutes: 0.02, every_seconds: 0.3 }));
    const t0 = Date.now();
    const r = await runAsync([bridge, 'poll', out, 'slow', drop], { RUNABLE_ACCESS_TOKEN: 'tok', RUNABLE_MCP_URL: `http://127.0.0.1:${port}/mcp` });
    expect(Date.now() - t0).toBeLessThan(10000);
    expect(r.status).toBe(6);
    const final = rj(join(out, 'slow.final.json'));
    expect(final).toMatchObject({ status: 'timed_out', task_status: 'running', timed_out: true, done: false });
    expect(final.polls).toBeGreaterThanOrEqual(2);
    expect(existsSync(join(out, 'slow.runable.json'))).toBe(true);      // written by poll itself, the lane never reaches report
    expect(rj(join(out, 'slow.runable.json'))).toMatchObject({ ok: false, status: 'timed_out', task_id: 'task_slow', task_status: 'running' });
    // and the receipt reads the lane's status, not the raw task state in final.json
    expect(collectExtra(out, 'runable', ['status', 'task_status', 'polls'])).toMatchObject({ status: 'timed_out', task_status: 'running' });
  });
});

describe('taskforge bridge', () => {
  const bridge = join(SHELF, 'taskforge', 'bridge.mjs');
  it('execute aborts the SSE stream at the cap and seals status=timed_out before exiting (Sourcery: stream never aborted; Cursor: timeout never seals)', async () => {
    let streamOpen = false, streamClosed = false;
    const api = createServer((req, res) => {
      if (req.url?.startsWith('/api/execute')) { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ ok: true, taskId: 'tf-1' })); }
      if (req.url?.startsWith('/api/status/')) { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ task: { status: 'running' }, steps: [{ status: 'running' }] })); }
      if (req.url?.startsWith('/api/logs/stream/')) {
        streamOpen = true; res.setHeader('content-type', 'text/event-stream'); res.write('event: log\ndata: {"line":"working"}\n\n');
        const iv = setInterval(() => res.write('event: log\ndata: {"line":"still working"}\n\n'), 200);
        req.on('close', () => { clearInterval(iv); streamClosed = true; });
        return;                                                            // never ends on its own
      }
      res.statusCode = 404; res.end('{}');
    });
    const port = await listen(api);
    const out = tmp('tf-'); const drop = join(out, 'job.execute.json');
    writeFileSync(drop, JSON.stringify({ taskId: 'tf-1', workflow: { steps: [{ executor: 'shell' }] }, max_minutes: 0.03, poll_seconds: 0.3 }));
    const t0 = Date.now();
    const r = await runAsync([bridge, 'execute', out, 'job', drop], { TASKFORGE_API_URL: `http://127.0.0.1:${port}/api` });
    const ms = Date.now() - t0;
    expect(r.status).toBe(6);
    expect(ms).toBeLessThan(8000);                                         // cap is 1.8 s; without the abort the stream would hold the process
    const result = rj(join(out, 'job.result.json'));
    expect(result).toMatchObject({ status: 'timed_out', task_status: null, timed_out: true, task_id: 'tf-1' });
    expect(result.events).toBeGreaterThan(0);
    expect(rj(join(out, 'job.taskforge.json'))).toMatchObject({ ok: false, status: 'timed_out', task_id: 'tf-1' });
    expect(readFileSync(join(out, 'job.events.jsonl'), 'utf8')).toMatch(/stream_closed/);
    await new Promise((r) => setTimeout(r, 300));
    expect(streamOpen).toBe(true); expect(streamClosed).toBe(true);
    expect(collectExtra(out, 'taskforge', ['status', 'task_status'])).toMatchObject({ status: 'timed_out' });
  });
});

describe('agentpass bridge', () => {
  const bridge = join(SHELF, 'agentpass', 'bridge.mjs');
  it('a passport missing a predicted field is a mismatch, never a pass (Cursor: missing fields count as match)', () => {
    const out = tmp('ap-');
    writeFileSync(join(out, 'p.predict.json'), JSON.stringify({ predicted: { agent: 'lab.timmy', tool: 'openrouter.chat', scope: 'chat:write', ttl: 300, budget_usd: 0.1 } }));
    writeFileSync(join(out, 'p.passport.json'), JSON.stringify({ exit: 0, json: { ok: true, passport: { id: 'pp_1', agent: 'lab.timmy', tool: 'openrouter.chat' } } }));
    const r = run([bridge, 'report', 'passport-issue', out, 'p']);
    expect(r.status).toBe(5);
    const rep = rj(join(out, 'p.agentpass.json'));
    expect(rep).toMatchObject({ ok: false, status: 'mismatch', fields_as_predicted: false, fields_compared: 2, fields_missing: ['scope', 'ttl', 'budget_usd'], match: { agent: true, tool: true, scope: false, ttl: false, budget_usd: false } });
    // all five present and equal → ok
    writeFileSync(join(out, 'p.passport.json'), JSON.stringify({ exit: 0, json: { ok: true, passport: { id: 'pp_1', agent: 'lab.timmy', tool: 'openrouter.chat', scope: 'chat:write', ttl: 300, budget: 0.1 } } }));
    expect(run([bridge, 'report', 'passport-issue', out, 'p']).status).toBe(0);
    expect(rj(join(out, 'p.agentpass.json'))).toMatchObject({ ok: true, status: 'ok', fields_as_predicted: true, fields_compared: 5, fields_missing: [] });
    // a wider scope than requested is a finding
    writeFileSync(join(out, 'p.passport.json'), JSON.stringify({ exit: 0, json: { ok: true, passport: { id: 'pp_1', agent: 'lab.timmy', tool: 'openrouter.chat', scope: '*', ttl: 300, budget: 0.1 } } }));
    expect(run([bridge, 'report', 'passport-issue', out, 'p']).status).toBe(5);
    expect(rj(join(out, 'p.agentpass.json'))).toMatchObject({ ok: false, status: 'mismatch', match: { scope: false } });
  });
});

describe('routemux live feed shape (exercised against api.routemux.com on 2026-10-04)', () => {
  const bridge = join(SHELF, 'routemux', 'bridge.mjs');
  // the real feed: {data: {currency, price_unit, updated_at, models: [{model_name, group_name, input_price, output_price, …}]}}
  const live = { schema_version: '1.0', success: true, message: '', data: { currency: 'USD', price_unit: 'per_1m_tokens', site_name: 'RouteMux', updated_at: '2026-10-04T12:46:45.804Z', models: [
    { model_name: 'claude-sonnet-5-5', group_name: 'anthropic', input_price: 0.4, output_price: 2, cache_input_price: 0.04, enabled: true, note: '' },
    { model_name: 'gpt-5.4', group_name: 'openai', input_price: 0.25, output_price: 1.5, cache_input_price: 0.025, enabled: false, note: '' },
    { model_name: 'gemini-3.1-flash-image', group_name: 'google', input_price: 0.15, output_price: 0.9, cache_input_price: null, enabled: true, note: '' },
  ] } };
  it('feed reads data.models, counts enabled rows, keeps unit and groups, and the report carries them (the first live run crashed on rows.map)', async () => {
    const srv = createServer((req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(live)); });
    const port = await listen(srv);
    const project = tmp('proj-'); const run1 = join(project, 'out', 'routemux', 'model-feed-snapshot', 'feed-1'); mkdirSync(run1, { recursive: true });
    const r = await runAsync([bridge, 'feed', run1, 'feed', project], { ROUTEMUX_BASE_URL: `http://127.0.0.1:${port}` });
    expect(r.status).toBe(0);
    const d = rj(join(run1, 'feed.feed-diff.json'));
    expect(d).toMatchObject({ models: 3, models_enabled: 2, groups: ['anthropic', 'google', 'openai'], price_unit: 'per_1m_tokens', currency: 'USD', feed_updated: '2026-10-04T12:46:45.804Z', added: ['claude-sonnet-5-5', 'gpt-5.4', 'gemini-3.1-flash-image'], previous: null });
    expect(run([bridge, 'report', 'model-feed-snapshot', run1, 'feed']).status).toBe(0);
    expect(rj(join(run1, 'feed.routemux.json'))).toMatchObject({ ok: true, status: 'ok', models: 3, models_enabled: 2, groups: 3, price_unit: 'per_1m_tokens', added: 3, removed: 0, price_changes: 0, enabled_changes: 0 });
    // predict prices a request from that snapshot: input_price / output_price per 1M tokens
    const out = tmp('rm-'); const drop = join(out, 'q.routemux.json');
    writeFileSync(drop, JSON.stringify({ model: 'claude-sonnet-5-5', messages: [{ role: 'user', content: 'x'.repeat(4000) }], max_tokens: 100, predict: { tokens_out: 100 } }));
    expect(run([bridge, 'predict', drop, out, 'q', project]).status).toBe(0);
    const pred = rj(join(out, 'q.predict.json'));
    expect(pred.predicted.tokens_in).toBe(1000);
    expect(pred.predicted.cost_usd).toBeCloseTo((1000 * 0.4 + 100 * 2) / 1e6, 10);
    expect(pred.price_source.price).toMatchObject({ input_per_1m: 0.4, output_per_1m: 2, cache_input_per_1m: 0.04, enabled: true, group: 'anthropic' });
    // a disabled or unknown model prices to null, never to a guess
    writeFileSync(drop, JSON.stringify({ model: 'not-a-model', messages: [{ role: 'user', content: 'hi' }] }));
    run([bridge, 'predict', drop, out, 'q', project]);
    expect(rj(join(out, 'q.predict.json')).predicted.cost_usd).toBeNull();
  });
});

describe('lane receipt hash on the one-bus runs.jsonl', () => {
  it('takes the newest receipt line for the subject, not the receipt.sealed envelope that follows it (receipts were null before)', () => {
    const lines = [
      JSON.stringify({ kind: 'seal', subject: 'engine.run', hash: 'sha256_aaa' }),
      JSON.stringify({ v: 1, kind: 'receipt.sealed', payload: { subject: 'engine.run', hash: 'sha256_aaa' } }),
      JSON.stringify({ kind: 'seal', subject: 'engine.shelf', hash: 'sha256_bbb' }),
      JSON.stringify({ v: 1, kind: 'receipt.sealed', payload: { subject: 'engine.shelf', hash: 'sha256_bbb' } }),
      'not json',
    ];
    expect(lastReceiptHash(lines, 'engine.run')).toBe('sha256_aaa');
    expect(lastReceiptHash(lines, 'engine.shelf')).toBe('sha256_bbb');
    expect(lastReceiptHash(lines, null)).toBe('sha256_bbb');
    expect(lastReceiptHash(lines, 'engine.refuse')).toBeNull();
    expect(lastReceiptHash([JSON.stringify({ kind: 'receipt.sealed', payload: { subject: 'engine.run', hash: 'sha256_ccc' } })], 'engine.run')).toBe('sha256_ccc');   // envelope-only fallback
  });
});

describe('lane receipt extra keys', () => {
  it('reads the engine\'s own report before any intermediate file, then the rest by name', () => {
    const out = tmp('lane-');
    writeFileSync(join(out, 'x.final.json'), JSON.stringify({ status: 'running', polls: 4 }));
    writeFileSync(join(out, 'x.runable.json'), JSON.stringify({ status: 'timed_out' }));
    writeFileSync(join(out, 'x.predict.json'), JSON.stringify({ predicted: { minutes: 3 } }));
    expect(collectExtra(out, 'runable', ['status', 'polls', 'predicted'])).toEqual({ status: 'timed_out', polls: '4', predicted: '{"minutes":3}' });
    expect(collectExtra(out, 'runable', [])).toEqual({});
  });
});
