/**
 * The integrated candidate's checklist B1–B8: the Control Room's runs (src/companion/control-runs.ts) — propose (the adapter's
 * own plan, nothing started), Approve and start (a copy of the project, act on it), Stop (act's own stop path), the end and
 * its receipt in the project's chain, the diff against the project, an interrupted run and its Recover, and that a run is
 * never another principal's or another project's. `timmy act` is a FAKE here (tests/fixtures/fake-act.mjs): it does what act
 * prints and writes, so the live harnesses are not run by this test (that is the Mac's qualification).
 */
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import express from 'express';
import { ControlRuns, mountControlRuns, type ControlScope } from '../src/companion/control-runs.js';
import { readChain } from '../src/utils/receipts.js';

const dirs: string[] = [];
const tmp = (p = 'timmy-ctl-'): string => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d; };
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const FAKE = join(__dirname, 'fixtures', 'fake-act.mjs');
const sleep = (ms: number): Promise<void> => new Promise((r) => { setTimeout(r, ms); });

/** A project with a file, a .git and a node_modules (left out of the copy), a FAKE qwen on PATH and a Timmy home. */
function setup(mode: string, principal = 'operator') {
  const base = tmp();
  const root = join(base, 'demo');
  mkdirSync(join(root, '.git'), { recursive: true }); writeFileSync(join(root, '.git', 'HEAD'), 'ref: x\n');
  mkdirSync(join(root, 'node_modules', 'x'), { recursive: true }); writeFileSync(join(root, 'node_modules', 'x', 'i.js'), '1');
  writeFileSync(join(root, 'package.json'), '{"name":"demo"}\n');
  writeFileSync(join(root, 'a.txt'), 'one\n');
  const bin = join(base, 'bin'); mkdirSync(bin);
  writeFileSync(join(bin, 'qwen'), '#!/bin/sh\necho qwen 0.25.1\n'); chmodSync(join(bin, 'qwen'), 0o755);
  const home = join(base, 'home');
  const env = { PATH: `${bin}:/usr/bin:/bin`, TIMMY_HOME: home, FAKE_ACT_MODE: mode, OPENROUTER_API_KEY: 'sk-or-should-not-pass', HOME: base };
  const scope: ControlScope = { principal, project: { name: 'demo', root }, env };
  const fetchTags = (async () => new Response(JSON.stringify({ models: [{ name: 'gemma4:12b-it-qat' }, { name: 'gpt-oss:120b-cloud' }] }), { status: 200 })) as typeof fetch;
  const runs = new ControlRuns({ timmy: [process.execPath, FAKE], fetch: fetchTags });
  return { base, root, home, env, scope, runs, fetchTags };
}

async function until<T>(f: () => T | undefined | null | false, ms = 8000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) { const v = f(); if (v) return v; if (Date.now() > end) throw new Error('timed out'); await sleep(50); }
}

describe('the Control Room runs a code agent through timmy act (B1–B8)', () => {
  it('proposes from the adapter\'s own plan, refuses what it cannot start, and starts nothing', async () => {
    const s = setup('ok');
    expect(await s.runs.propose(s.scope, { harness: 'claude', task: 'x', model: 'm' })).toMatchObject({ ok: false, refused: 'usage' });
    expect(await s.runs.propose(s.scope, { harness: 'qwen', task: ' ', model: 'gemma4:12b-it-qat' })).toMatchObject({ ok: false, refused: 'usage' });
    expect(await s.runs.propose(s.scope, { harness: 'qwen', task: 'x', model: 'no such; rm' })).toMatchObject({ ok: false, refused: 'usage' });
    expect(await s.runs.propose(s.scope, { harness: 'qwen', task: 'x', model: 'gemma4:12b-it-qat', limit: 99 })).toMatchObject({ ok: false, refused: 'usage' });
    // a model the Ollama does not list: Qwen Code's own preflight words
    const missing = await s.runs.propose(s.scope, { harness: 'qwen', task: 'x', model: 'llama9:1b' });
    expect(missing).toMatchObject({ ok: false, refused: 'setup' });
    // a remote endpoint is never started here (planAgent's paid refusal)
    const remote = await s.runs.propose({ ...s.scope, env: { ...s.env, TIMMY_AGENT_BASE_URL: 'https://example.com/v1' } }, { harness: 'qwen', task: 'x', model: 'gemma4:12b-it-qat' });
    expect(remote).toMatchObject({ ok: false, refused: 'paid' });
    const p = await s.runs.propose(s.scope, { harness: 'qwen', task: 'add a line', model: 'gemma4:12b-it-qat', limit: 5 });
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.proposal).toMatchObject({ harness: 'qwen', title: 'Qwen Code', model: 'gemma4:12b-it-qat', endpoint: 'local', charge: 'local endpoint, no charge', wall_time: '5m' });
    expect(p.proposal.plan_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(existsSync(join(s.home, 'control-runs'))).toBe(false); // nothing written, nothing started
  });

  it('starts on a copy of the project, ends as act says, seals once in the project, and shows the diff', async () => {
    const s = setup('ok');
    const p = await s.runs.propose(s.scope, { harness: 'qwen', task: 'add a line', model: 'gemma4:12b-it-qat' });
    if (!p.ok) throw new Error(p.error);
    // another principal, or the same proposal twice, starts nothing
    expect(s.runs.start({ ...s.scope, principal: 'user:other' }, { proposal: p.proposal.id })).toMatchObject({ ok: false, status: 404 });
    const started = s.runs.start(s.scope, { proposal: p.proposal.id });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    expect(s.runs.start(s.scope, { proposal: p.proposal.id })).toMatchObject({ ok: false, status: 404 });
    const id = started.run.id;
    const done = await until(() => { const r = s.runs.read(s.scope, id); return r && r.state !== 'running' ? r : null; });
    expect(done.state).toBe('succeeded');
    expect(done.act).toMatchObject({ operation: 'o1a2b3c4d', exit_code: 0 });
    // the act was given the project's copy, the chosen model and wall time, and no key of Timmy's
    const dir = join(s.home, 'control-runs');
    const seen = JSON.parse(readFileSync(join(dir, done.project.id, id, 'work', 'fake-act-seen.json'), 'utf8'));
    expect(seen.argv.slice(0, 4)).toEqual(['act', '/agent qwen add a line', '--wait', '--json']);
    expect(seen.env).toMatchObject({ TIMMY_AGENT_MODEL: 'gemma4:12b-it-qat', TIMMY_AGENT_WALL_TIME: '10m' });
    expect(seen.env.OPENROUTER_API_KEY).toBeUndefined();
    expect(seen.copy).toEqual(expect.arrayContaining(['a.txt', 'package.json']));
    expect(seen.copy).not.toContain('.git'); expect(seen.copy).not.toContain('node_modules');
    // the project itself is not changed
    expect(readFileSync(join(s.root, 'a.txt'), 'utf8')).toBe('one\n');
    // its receipt: in the project's chain, once, with the operation, the job, the files and the control run
    const chain = () => readChain('runs', s.root).filter((r) => r.kind === 'control-run');
    expect(chain()).toHaveLength(1);
    const rc = chain()[0];
    expect(rc).toMatchObject({ status: 'ok', project: 'demo', operation_id: 'o1a2b3c4d', job: { id: 'j0a0b0c', kind: 'agent' }, control_run: { run: id, harness: 'qwen', model: 'gemma4:12b-it-qat', endpoint: 'local', principal: 'operator', act: { exit_code: 0 }, agent: { run: 'a1b2c3d4e', receipt: 'feedbeef' } } });
    expect(rc.files?.[0]).toMatchObject({ path: 'a.txt', sha256: createHash('sha256').update('one\ntwo\n').digest('hex') });
    const v = s.runs.view(s.scope, s.runs.read(s.scope, id)!);
    expect(v).toMatchObject({ operation: 'o1a2b3c4d', job: 'j0a0b0c', agent_run: 'a1b2c3d4e', receipt: rc.hash.slice(7, 15), result: { outcome: 'completed', agent_receipt: 'feedbeef', final_message: 'Added a line.', files: { changed: ['a.txt'] } } });
    expect(v.log.join('\n')).toMatch(/qwen: editing a\.txt/);
    expect(JSON.stringify(v)).not.toContain(s.base); // no path of this computer
    s.runs.read(s.scope, id); // read again: never sealed twice
    expect(chain()).toHaveLength(1);
    const d = s.runs.diff(s.scope, id);
    expect(d.ok).toBe(true);
    if (d.ok) {
      expect(d.files).toHaveLength(1);
      expect(d.files[0].diff).toMatch(/\+two/);
      expect(d.files[0].diff).not.toContain(s.base);
    }
  });

  it('stops through act\'s own stop: the run says stopped because act\'s end says so, its receipt says cancelled', async () => {
    const s = setup('wait');
    const p = await s.runs.propose(s.scope, { harness: 'qwen', task: 'long task', model: 'gemma4:12b-it-qat' });
    if (!p.ok) throw new Error(p.error);
    const started = s.runs.start(s.scope, { proposal: p.proposal.id });
    if (!started.ok) throw new Error(started.error);
    const id = started.run.id;
    await until(() => s.runs.view(s.scope, s.runs.read(s.scope, id)!).log.some((l) => /waiting/.test(l)));
    expect(s.runs.stop({ ...s.scope, principal: 'user:other' }, id)).toMatchObject({ ok: false, status: 404 });
    const st = s.runs.stop(s.scope, id);
    expect(st).toMatchObject({ ok: true, run: { state: 'stopping' } });
    const done = await until(() => { const r = s.runs.read(s.scope, id); return r && r.state !== 'stopping' && r.state !== 'running' ? r : null; });
    expect(done).toMatchObject({ state: 'stopped', act: { exit_code: 3, outcome: 'stopped' }, stop: { by: 'the Control Room\'s Stop' } });
    expect(readChain('runs', s.root).filter((r) => r.kind === 'control-run')[0]).toMatchObject({ status: 'cancelled', control_run: { state: 'stopped', stopped_by: 'the Control Room\'s Stop' } });
  });

  it('reads an act gone without its end as interrupted (never a result), and Recover settles it', async () => {
    const s = setup('die');
    const p = await s.runs.propose(s.scope, { harness: 'qwen', task: 'x', model: 'gemma4:12b-it-qat' });
    if (!p.ok) throw new Error(p.error);
    const started = s.runs.start(s.scope, { proposal: p.proposal.id });
    if (!started.ok) throw new Error(started.error);
    const id = started.run.id;
    const done = await until(() => { const r = s.runs.read(s.scope, id); return r && r.state !== 'running' ? r : null; });
    expect(done.state).toBe('interrupted');
    expect(done.why).toMatch(/without printing its end/);
    expect(readChain('runs', s.root).filter((r) => r.kind === 'control-run')).toHaveLength(0);
    expect(s.runs.diff(s.scope, id)).toMatchObject({ ok: true, files: [] });
    const rec = s.runs.recover(s.scope, id);
    expect(rec).toMatchObject({ ok: true, run: { state: 'interrupted' } });
    if (rec.ok) expect(rec.run.why).toMatch(/recovered \(timmy act \/recover exited 0\)/);
    // the interrupted run's receipt says failed (its result is not known), sealed once after Recover
    expect(readChain('runs', s.root).filter((r) => r.kind === 'control-run')).toMatchObject([{ status: 'failed', control_run: { state: 'interrupted', act: null } }]);
    expect(s.runs.recover(s.scope, id)).toMatchObject({ ok: true });
    expect(readChain('runs', s.root).filter((r) => r.kind === 'control-run')).toHaveLength(1);
  });

  it('keeps each principal\'s runs to that principal and project, over the routes too', async () => {
    const s = setup('ok');
    const p = await s.runs.propose(s.scope, { harness: 'qwen', task: 'x', model: 'gemma4:12b-it-qat' });
    if (!p.ok) throw new Error(p.error);
    const started = s.runs.start(s.scope, { proposal: p.proposal.id });
    if (!started.ok) throw new Error(started.error);
    const id = started.run.id;
    await until(() => s.runs.read(s.scope, id)?.state === 'succeeded');
    // the same home, another principal: nothing listed, nothing read
    const other: ControlScope = { ...s.scope, principal: 'user:erin' };
    expect(s.runs.list(other)).toEqual([]);
    expect(s.runs.read(other, id)).toBeNull();
    // another project of the same principal: nothing
    const other2: ControlScope = { ...s.scope, project: { name: 'other', root: join(s.base, 'other') } };
    mkdirSync(other2.project.root);
    expect(s.runs.list(other2)).toEqual([]);
    // the routes: the token, the principal, its project
    const app = express();
    const who = (req: express.Request): string => String(req.headers['x-who'] ?? 'operator');
    mountControlRuns(app, {
      withToken: (req, res, next) => { if (req.headers['x-token'] === 't') next(); else res.status(401).json({ ok: false }); },
      withUser: (_req, _res, next) => next(), json: express.json(), runs: s.runs, fetch: s.fetchTags,
      scopeOf: (req) => ({ ...s.scope, principal: who(req) }),
    });
    const server = app.listen(0);
    try {
      const port = (server.address() as { port: number }).port;
      const get = (p2: string, h: Record<string, string> = { 'x-token': 't' }) => fetch(`http://127.0.0.1:${port}${p2}`, { headers: h });
      expect((await get('/api/control/runs', {})).status).toBe(401);
      const mine = await (await get('/api/control/runs')).json() as { runs: Array<{ id: string }> };
      expect(mine.runs.map((r) => r.id)).toEqual([id]);
      const theirs = await (await get('/api/control/runs', { 'x-token': 't', 'x-who': 'user:erin' })).json() as { runs: unknown[] };
      expect(theirs.runs).toEqual([]);
      expect((await get(`/api/control/runs/${id}`, { 'x-token': 't', 'x-who': 'user:erin' })).status).toBe(404);
      expect((await fetch(`http://127.0.0.1:${port}/api/control/runs/${id}/stop`, { method: 'POST', headers: { 'x-token': 't', 'x-who': 'user:erin' } })).status).toBe(404);
      const h = await (await get('/api/control/harnesses')).json() as { harnesses: Array<{ id: string; found: boolean }>; models: string[] };
      expect(h.harnesses.map((x) => x.id)).toEqual(['openhands', 'qwen']);
      expect(h.models).toEqual(['gemma4:12b-it-qat']); // no cloud tag
    } finally { server.close(); }
  });
});
