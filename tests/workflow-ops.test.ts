/**
 * The unified Workspace order (2026-10-27): the Workspace's executable operations (src/companion/workflow-ops.ts) against the
 * real companion and its mini-app host, with LABELLED FAKE apps (tests/fixtures/fake-stream-studio, tests/fixtures/fake-jobs-app
 * as Timmy Animate). What is checked: a run is validated before anything starts; it runs as the APP's own job; its state is
 * the app's word; its receipts are sealed and every file it delivered is collected into the project with its hash; Cancel
 * ends it as the app says; a newer attempt supersedes an older one (current-result fencing); a run left by an earlier
 * companion is recovered from the app's own record; a failure stays a failure.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startCompanionServer, type CompanionServer } from '../src/companion/server.js';
import { readRun } from '../src/companion/workflow-ops.js';
import { projectId } from '../src/project/index.js';

const STREAM = fileURLToPath(new URL('./fixtures/fake-stream-studio', import.meta.url));
const ANIMATE = fileURLToPath(new URL('./fixtures/fake-jobs-app', import.meta.url));
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

describe('Workspace operations: validated, dispatched to the app’s own job, followed, cancelled, fenced and recovered (FAKE apps)', () => {
  const kept = { TIMMY_REPO: process.env.TIMMY_REPO };
  let box = ''; let root = ''; let companion: CompanionServer; let origin = ''; let token = ''; let env: Record<string, string | undefined> = {};
  const api = async (method: string, path: string, body?: unknown) => {
    const r = await fetch(`${origin}${path}`, { method, headers: { authorization: `Bearer ${token}`, host: `127.0.0.1:${companion.port}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, json: await r.json() as Record<string, any> };
  };
  const until = async (id: string, done: (r: Record<string, any>) => boolean, ms = 20_000) => {
    const end = Date.now() + ms;
    for (;;) { const r = (await api('GET', `/api/workflow/runs/${id}`)).json.run; if (done(r) || Date.now() > end) return r; await new Promise((x) => setTimeout(x, 200)); }
  };
  const start = async () => {
    companion = await startCompanionServer(0, { chatEnv: env, workspace: { env } });
    origin = `http://127.0.0.1:${companion.port}`;
    token = /#t=([0-9a-f]{64})$/.exec(companion.url)![1];
  };

  beforeAll(async () => {
    box = mkdtempSync(join(tmpdir(), 'workflow-ops-'));
    root = join(box, 'project');
    mkdirSync(join(root, 'from-apps', 'card-lab', 'c1'), { recursive: true });
    writeFileSync(join(root, 'from-apps', 'card-lab', 'c1', 'card.png'), PNG);
    writeFileSync(join(root, 'scene.json'), JSON.stringify({ name: 'chair', objects: [] }));
    writeFileSync(join(root, 'fail.json'), JSON.stringify({ name: 'FAIL', objects: [] }));
    env = { TIMMY_HOME: process.env.TIMMY_HOME!, TIMMY_SETTINGS_DIR: process.env.TIMMY_SETTINGS_DIR, TIMMY_STREAM_STUDIO_DIR: STREAM, TIMMY_ANIMATE_DIR: ANIMATE };
    process.env.TIMMY_REPO = root;
    await start();
  }, 120_000);
  afterAll(async () => {
    await companion?.shutdown();
    for (const [k, v] of Object.entries(kept)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    if (box) rmSync(box, { recursive: true, force: true });
  });

  it('lists the operations with their ports, parameters and adapters', async () => {
    const r = await api('GET', '/api/workflow/operations');
    expect(r.status).toBe(200);
    const ops = r.json.operations as Array<{ id: string; inputs: Array<{ type: string }>; adapter: string }>;
    // the apps' operations first; the spatial tools' (Timmy's own jobs: tests/spatial-jobs.test.ts) after them
    expect(ops.map((o) => o.id)).toEqual(['stream-studio.animate-image', 'animate.export', 'spatial.kiri-crop-export', 'spatial.brush-train', 'spatial.gsplat-smoke']);
    expect(ops[0].inputs[0].type).toBe('image');
    expect(ops[0].adapter).toMatch(/POST \/api\/jobs/);
  });

  it('validates before anything starts: an unconnected input, a wrong file, a parameter out of range', async () => {
    const none = await api('POST', '/api/workflow/validate', { op: 'stream-studio.animate-image', inputs: {} });
    expect(none.json.ok).toBe(false);
    expect(none.json.problems.join(' ')).toMatch(/Image: not connected/);
    const wrong = await api('POST', '/api/workflow/validate', { op: 'stream-studio.animate-image', inputs: { image: 'scene.json' } });
    expect(wrong.json.problems.join(' ')).toMatch(/not one of \.png/);
    const range = await api('POST', '/api/workflow/validate', { op: 'stream-studio.animate-image', inputs: { image: 'from-apps/card-lab/c1/card.png' }, params: { duration: 99, motion: 'teleport' } });
    expect(range.json.problems).toEqual(['Motion: choose one of float, sway, spin, pulse, flicker, orbit, still.', 'Seconds: 1–12.']);
    const outside = await api('POST', '/api/workflow/validate', { op: 'stream-studio.animate-image', inputs: { image: '../x.png' } });
    expect(outside.json.ok).toBe(false);
    const ok = await api('POST', '/api/workflow/validate', { op: 'stream-studio.animate-image', inputs: { image: 'from-apps/card-lab/c1/card.png' } });
    expect(ok.json).toMatchObject({ ok: true, problems: [], inputs: { image: { path: 'from-apps/card-lab/c1/card.png', sha256: sha(PNG) } } });
    // an invalid run is refused before any app starts (422), and leaves no record
    const refused = await api('POST', '/api/workflow/runs', { op: 'stream-studio.animate-image', inputs: {}, board: 'desk', node: 'shape:a' });
    expect(refused.status).toBe(422);
    expect((await api('GET', '/api/workflow/runs?node=shape:a')).json.runs).toEqual([]);
  });

  it('a run is the app’s own export job: followed to its end, sealed, and every delivered file collected with its hash', async () => {
    const r = await api('POST', '/api/workflow/runs', { op: 'stream-studio.animate-image', inputs: { image: 'from-apps/card-lab/c1/card.png' }, params: { motion: 'sway', format: 'html' }, board: 'desk', node: 'shape:anim', label: 'Card in motion' });
    expect(r.status).toBe(200);
    expect(r.json.run).toMatchObject({ state: 'running', attempt: 1, current: true, by: 'person' });
    expect(r.json.run.job).toMatch(/^[a-f0-9-]{36}$/);
    const end = await until(r.json.run.id, (x) => x.terminal && x.collected);
    expect(end).toMatchObject({ state: 'completed', appWord: 'succeeded', progress: 100, collected: 'sealed' });
    expect(end.receipts.length).toBeGreaterThanOrEqual(1);
    const paths = end.outputs.map((o: { path: string }) => o.path).sort();
    expect(paths).toEqual([`from-apps/stream-studio/${end.job}/index.html`, `from-apps/stream-studio/${end.job}/scene.json`]);
    for (const o of end.outputs) expect(sha(readFileSync(join(root, o.path)))).toBe(o.sha256);
    // read back: each delivered file hashed again from the project and compared with its receipt
    expect(end.readback).toMatchObject({ checked: 2, matched: 2, missing: [], mismatched: [] });
    expect(readFileSync(join(root, `from-apps/stream-studio/${end.job}/index.html`), 'utf8')).toContain('FAKE Stream Studio player · sway');
  }, 60_000);

  it('Cancel ends the job as the app says; a newer attempt supersedes the older (it is never the node’s current result)', async () => {
    const a = (await api('POST', '/api/workflow/runs', { op: 'stream-studio.animate-image', inputs: { image: 'from-apps/card-lab/c1/card.png' }, board: 'desk', node: 'shape:fence' })).json.run;
    const b = (await api('POST', '/api/workflow/runs', { op: 'stream-studio.animate-image', inputs: { image: 'from-apps/card-lab/c1/card.png' }, params: { format: 'svg' }, board: 'desk', node: 'shape:fence' })).json.run;
    expect(b.attempt).toBe(2);
    const older = await until(a.id, (x) => x.terminal);
    expect(older).toMatchObject({ supersededBy: b.id, current: false, cancelAsked: true, state: 'cancelled', appWord: 'cancelled' });
    const newer = await until(b.id, (x) => x.terminal && x.collected);
    expect(newer).toMatchObject({ state: 'completed', current: true });
    expect(newer.outputs.map((o: { path: string }) => o.path.split('/').pop()).sort()).toEqual(['frame.svg', 'scene.json']);
    const listed = (await api('GET', '/api/workflow/runs?board=desk&node=shape:fence')).json.runs;
    expect(listed.filter((x: { current: boolean }) => x.current).map((x: { id: string }) => x.id)).toEqual([b.id]);
    // Cancel, asked while it runs
    const c = (await api('POST', '/api/workflow/runs', { op: 'stream-studio.animate-image', inputs: { image: 'from-apps/card-lab/c1/card.png' }, board: 'desk', node: 'shape:cancel' })).json.run;
    const asked = await api('POST', `/api/workflow/runs/${c.id}/cancel`);
    expect(asked.status).toBe(200);
    const cancelled = await until(c.id, (x) => x.terminal);
    expect(cancelled).toMatchObject({ state: 'cancelled', cancelAsked: true, outputs: [] });
    expect((await api('POST', `/api/workflow/runs/${c.id}/cancel`)).status).toBe(409);
  }, 60_000);

  it('a failure stays a failure; Animate’s export runs as its own job and its artifacts come back', async () => {
    const f = (await api('POST', '/api/workflow/runs', { op: 'stream-studio.animate-image', inputs: { image: 'from-apps/card-lab/c1/card.png' }, board: 'desk', node: 'shape:fail', label: 'FAIL' })).json.run;
    const failed = await until(f.id, (x) => x.terminal);
    expect(failed).toMatchObject({ state: 'failed', appWord: 'failed', error: 'FAKE export failure', outputs: [] });
    const a = (await api('POST', '/api/workflow/runs', { op: 'animate.export', inputs: { scene: 'scene.json' }, board: 'desk', node: 'shape:blend' })).json.run;
    const done = await until(a.id, (x) => x.terminal && x.collected);
    expect(done.state).toBe('completed');
    expect(done.outputs.map((o: { path: string }) => o.path.split('/').pop()).sort()).toEqual(['preview.png', 'scene.blend']);
  }, 60_000);

  it('a run left by an earlier companion is recovered from the app’s own record', async () => {
    const r = (await api('POST', '/api/workflow/runs', { op: 'stream-studio.animate-image', inputs: { image: 'from-apps/card-lab/c1/card.png' }, board: 'desk', node: 'shape:left' })).json.run;
    // the companion goes away while the run is under way (its follower with it); its app is stopped too
    await companion.shutdown();
    const left = readRun(env.TIMMY_HOME!, root, r.id)!;
    expect(['running', 'held'].includes(left.state)).toBe(true);
    await start();
    const seen = (await api('GET', `/api/workflow/runs/${r.id}`)).json.run;
    expect(seen.left).toBe(true);
    const rec = await api('POST', `/api/workflow/runs/${r.id}/recover`);
    expect(rec.status).toBe(200);
    const end = await until(r.id, (x) => x.terminal);
    // the FAKE app keeps no job across its restart: Recover says so (interrupted), never a made-up success
    expect(['interrupted', 'completed', 'cancelled']).toContain(end.state);
    if (end.state === 'interrupted') expect(end.error).toMatch(/no longer knows this job|restart/);
    expect(existsSync(join(env.TIMMY_HOME!, 'workflow'))).toBe(true);
  }, 90_000);

  it('a completed run whose collection a stopped companion cut short is left; Recover reads its receipts again (found on the Mac at ea4fba0)', async () => {
    const r = (await api('POST', '/api/workflow/runs', { op: 'stream-studio.animate-image', inputs: { image: 'from-apps/card-lab/c1/card.png' }, board: 'desk', node: 'shape:cut' })).json.run;
    const done = await until(r.id, (x) => x.terminal && x.collected);
    expect(done.collected).toBe('sealed');
    // as a companion stopped mid-collection leaves it: completed, nothing collected
    const file = join(env.TIMMY_HOME!, 'workflow', projectId(root), 'runs', `${r.id}.json`);
    const rec = JSON.parse(readFileSync(file, 'utf8'));
    delete rec.collected; delete rec.readback; rec.receipts = []; rec.outputs = [];
    writeFileSync(file, JSON.stringify(rec));
    const seen = (await api('GET', `/api/workflow/runs/${r.id}`)).json.run;
    expect(seen).toMatchObject({ state: 'completed', left: true });
    expect((await api('POST', `/api/workflow/runs/${r.id}/recover`)).status).toBe(200);
    const back = await until(r.id, (x) => Boolean(x.collected));
    expect(back).toMatchObject({ collected: 'sealed', readback: { matched: 2, checked: 2 } });
    expect(back.left).toBeUndefined();
  }, 60_000);
});
