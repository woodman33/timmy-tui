/**
 * The spatial tools order (2026-10-28): Brush, KIRI (in Blender) and gsplat in the one integration catalog and as Workspace
 * operations, run as Timmy's own durable process jobs (src/spatial/jobs.ts on src/jobs/index.ts) through the same
 * validate / run / follow / cancel / recover / collect routes as an app's job (src/companion/workflow-ops.ts). Against the
 * real companion with LABELLED FAKE tools (tests/fixtures/fake-spatial-tools.ts). What is checked:
 *   - the catalog keeps installed, configured, callable and verified apart; gsplat is never callable here (awaiting NVIDIA);
 *   - a file brought in from this computer lands at from-apps/import/… with its own receipt (a PLY's header facts);
 *   - a KIRI run is completed only on the worker's success AND its three value checks AND parseable artifacts; its files are
 *     delivered and ONE spatial receipt sealed; read back; a failure keeps its raw log and result;
 *   - Cancel stops the job's whole process group (a child the tool started is gone too);
 *   - a newer attempt supersedes an older one (current-result fencing); Brush's exit code alone is not success;
 *   - Recover of a left run collects it once (the native edit is never run again).
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startCompanionServer, type CompanionServer } from '../src/companion/server.js';
import { readRun } from '../src/companion/workflow-ops.js';
import { projectId } from '../src/project/index.js';
import { readChain } from '../src/utils/receipts.js';
import { FIXTURE_PLY, fakeSpatialTools } from './fixtures/fake-spatial-tools.js';

const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
/** a process still running (a zombie, ended and not yet reaped by its new parent, is not running) */
const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); } catch { return false; }
  try { return !/^State:\s+Z/m.test(readFileSync(`/proc/${pid}/status`, 'utf8')); } catch { return true; }
};

describe('spatial tools: catalog rows and Workspace operations as Timmy’s own jobs (FAKE Brush, FAKE Blender for KIRI)', () => {
  const kept = { TIMMY_REPO: process.env.TIMMY_REPO };
  let box = ''; let root = ''; let companion: CompanionServer; let origin = ''; let token = ''; let env: Record<string, string | undefined> = {};
  const headers = () => ({ authorization: `Bearer ${token}`, host: `127.0.0.1:${companion.port}` });
  const api = async (method: string, path: string, body?: unknown) => {
    const r = await fetch(`${origin}${path}`, { method, headers: { ...headers(), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, json: await r.json() as Record<string, any> };
  };
  const until = async (id: string, done: (r: Record<string, any>) => boolean, ms = 20_000) => {
    const end = Date.now() + ms;
    for (;;) { const r = (await api('GET', `/api/workflow/runs/${id}`)).json.run; if (done(r) || Date.now() > end) return r; await new Promise((x) => setTimeout(x, 150)); }
  };
  const importFile = async (name: string, body: string | Buffer) => {
    const r = await fetch(`${origin}/api/files/import`, { method: 'POST', headers: { ...headers(), 'content-type': 'application/octet-stream', 'x-file-name': name }, body });
    return { status: r.status, json: await r.json() as Record<string, any> };
  };
  const start = async () => {
    companion = await startCompanionServer(0, { chatEnv: env, workspace: { env } });
    origin = `http://127.0.0.1:${companion.port}`;
    token = /#t=([0-9a-f]{64})$/.exec(companion.url)![1];
  };

  beforeAll(async () => {
    box = mkdtempSync(join(tmpdir(), 'spatial-jobs-'));
    root = join(box, 'project');
    mkdirSync(root, { recursive: true });
    const fake = fakeSpatialTools(box);
    env = { TIMMY_HOME: process.env.TIMMY_HOME!, TIMMY_SETTINGS_DIR: process.env.TIMMY_SETTINGS_DIR, HOME: box, TMPDIR: tmpdir(), ...fake.env };
    process.env.TIMMY_REPO = root;
    await start();
  }, 120_000);
  afterAll(async () => {
    await companion?.shutdown();
    for (const [k, v] of Object.entries(kept)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    if (box) rmSync(box, { recursive: true, force: true });
  });

  it('the catalog: Brush and KIRI installed and callable (not verified until a run here), gsplat awaiting an NVIDIA worker', async () => {
    const r = await api('GET', '/api/catalog');
    const rows = (r.json.catalog.entries as Array<Record<string, any>>).filter((e) => e.id.startsWith('spatial:'));
    expect(rows.map((e) => e.id)).toEqual(['spatial:brush', 'spatial:kiri', 'spatial:gsplat']);
    const [brush, kiri, gsplat] = rows;
    expect(brush.states.installed.ok).toBe(true);
    expect(brush.states.callable.ok).toBe(process.platform === 'darwin');
    expect(brush.setup).toMatch(/posed dataset/);
    expect(kiri.states.configured).toMatchObject({ ok: true });
    expect(kiri.states.callable.ok).toBe(true);
    expect(kiri.operations[0]).toMatchObject({ id: 'spatial.kiri-crop-export', where: ['canvas', 'control-room'] });
    for (const e of [brush, kiri, gsplat]) expect(e.states.verified.ok).toBeNull(); // no run here yet: unknown, never "qualified"
    expect(gsplat.states).toMatchObject({ installed: { ok: false }, callable: { ok: false } });
    expect(gsplat.operations[0].where).toEqual([]);
    expect(gsplat.setup).toMatch(/awaiting a powered NVIDIA worker/);
    expect(JSON.stringify(rows)).not.toContain(box); // no home path in the catalog's words
    const ops = (await api('GET', '/api/workflow/operations')).json.operations as Array<Record<string, any>>;
    const avail = Object.fromEntries(ops.filter((o) => o.executor === 'local').map((o) => [o.id, o.available.ok]));
    expect(avail).toEqual({ 'spatial.kiri-crop-export': true, 'spatial.brush-train': process.platform === 'darwin', 'spatial.gsplat-smoke': false });
  });

  let fixture = '';
  it('a file from this computer: brought into from-apps/import/… with its own receipt and its PLY header facts', async () => {
    const r = await importFile('fixture.ply', FIXTURE_PLY);
    expect(r.status).toBe(200);
    fixture = r.json.result.files[0].path;
    expect(fixture).toMatch(/^from-apps\/import\/i[0-9a-f]{10}\/fixture\.ply$/);
    expect(readFileSync(join(root, fixture), 'utf8')).toBe(FIXTURE_PLY);
    expect(r.json.ply).toMatchObject({ ok: true, vertices: 2, fixture: true, format: 'ascii' });
    const rc = readChain('runs', root).find((x) => x.kind === 'import');
    expect(rc).toMatchObject({ status: 'ok', outputs: [{ path: fixture, sha256: sha(FIXTURE_PLY) }], imported: { name: 'fixture.ply', gaussian: true, fixture: true } });
    expect((await importFile('notes.txt', 'x')).status).toBe(415);
    // listed with the apps' results (the Workspace's import menu), and served as media
    const outs = (await api('GET', '/api/apps/outputs')).json.results as Array<Record<string, any>>;
    expect(outs.some((x) => x.app === 'import' && x.files[0].path === fixture)).toBe(true);
    const media = await fetch(`${origin}/api/files/media?path=${encodeURIComponent(fixture)}`, { headers: headers() });
    expect(media.status).toBe(200);
  });

  let first = '';
  it('KIRI: completed only on the worker’s success and its three value checks; delivered, ONE receipt, read back', async () => {
    const r = await api('POST', '/api/workflow/runs', { op: 'spatial.kiri-crop-export', inputs: { splat: fixture }, params: { keep: 'x ≤ 0' }, board: 'desk', node: 'shape:k1' });
    expect(r.status).toBe(200);
    first = r.json.run.id;
    const done = await until(first, (x) => x.terminal && Boolean(x.collected));
    expect(done).toMatchObject({ state: 'completed', progress: 100, collected: 'sealed', current: true });
    expect(done.appWord).toMatch(/success, 3\/3 value checks/);
    const names = (done.outputs as Array<{ path: string }>).map((o) => o.path.split('/').pop()).sort();
    expect(names).toEqual(['edited.blend', 'edited.ply', 'job.log', 'request.json', 'result.json']);
    expect(done.outputs.every((o: { path: string }) => o.path.startsWith(`from-apps/spatial/${first}/`))).toBe(true);
    expect(done.readback).toMatchObject({ checked: 5, matched: 5, missing: [], mismatched: [] });
    // the crop kept the x ≤ 0 Gaussian only (the FAKE does what it was asked; the real check runs in Blender on the Mac)
    expect(readFileSync(join(root, `from-apps/spatial/${first}/edited.ply`), 'utf8')).toMatch(/element vertex 1\n/);
    const rc = readChain('runs', root).filter((x) => x.kind === 'spatial');
    expect(rc).toHaveLength(1);
    expect(rc[0]).toMatchObject({ status: 'ok', subject: 'kiri.spatial.kiri-crop-export', job: { id: first, state: 'completed' }, spatial: { tool: 'kiri', version: '5.1.0', fixture: true, run: first, attempt: 1, input: { path: fixture, sha256: sha(FIXTURE_PLY) } } });
    expect(rc[0].spatial!.checks.map((c) => c.stage)).toEqual(['crop_values_verified', 'native_values_verified', 'export_values_verified']);
    expect(rc[0].spatial!.log_sha256).toMatch(/^[0-9a-f]{64}$/);
    // the catalog now says verified, and that it was the synthetic fixture only
    const kiri = (await api('GET', '/api/catalog')).json.catalog.entries.find((e: { id: string }) => e.id === 'spatial:kiri');
    expect(kiri.states.verified).toMatchObject({ ok: true });
    expect(kiri.states.verified.words).toMatch(/synthetic fixture only/);
  });

  it('a failure stays a failure: the worker’s own error, its raw log and result delivered, the receipt failed', async () => {
    const f = await importFile('fail-fixture.ply', FIXTURE_PLY);
    const r = await api('POST', '/api/workflow/runs', { op: 'spatial.kiri-crop-export', inputs: { splat: f.json.result.files[0].path }, board: 'desk', node: 'shape:k2' });
    const done = await until(r.json.run.id, (x) => x.terminal && Boolean(x.collected));
    expect(done.state).toBe('failed');
    expect(done.error).toMatch(/FAKE failure after import/);
    expect(done.appWord).toMatch(/exit 11/);
    const log = done.outputs.find((o: { path: string }) => o.path.endsWith('job.log'));
    expect(readFileSync(join(root, log.path), 'utf8')).toMatch(/Traceback: FAKE failure/);
    expect(readChain('runs', root).filter((x) => x.kind === 'spatial').at(-1)).toMatchObject({ status: 'failed', job: { state: 'failed' } });
  });

  it('Cancel stops the job’s whole process group: the tool and a child it started are both gone', async () => {
    const f = await importFile('slow-fixture.ply', FIXTURE_PLY);
    const r = await api('POST', '/api/workflow/runs', { op: 'spatial.kiri-crop-export', inputs: { splat: f.json.result.files[0].path }, board: 'desk', node: 'shape:k3' });
    const id = r.json.run.id;
    await until(id, (x) => x.appWord === 'registered');
    const pidsFile = join(process.env.TIMMY_HOME!, 'spatial', projectId(root), 'runs', id, 'out', 'pids.json');
    const pids = JSON.parse(readFileSync(pidsFile, 'utf8')) as { blender: number; child: number };
    expect(alive(pids.blender) && alive(pids.child)).toBe(true);
    const c = await api('POST', `/api/workflow/runs/${id}/cancel`);
    expect(c.status).toBe(200);
    const done = await until(id, (x) => x.terminal && Boolean(x.collected));
    expect(done).toMatchObject({ state: 'cancelled', cancelAsked: true });
    expect(done.appWord).toMatch(/process group gone/);
    expect(alive(pids.blender)).toBe(false);
    expect(alive(pids.child)).toBe(false);
    expect(readChain('runs', root).filter((x) => x.kind === 'spatial').at(-1)).toMatchObject({ status: 'cancelled' });
  });

  it('a newer attempt on the node supersedes the older (current-result fencing); the older keeps its record', async () => {
    const r = await api('POST', '/api/workflow/runs', { op: 'spatial.kiri-crop-export', inputs: { splat: fixture }, params: { keep: 'all' }, board: 'desk', node: 'shape:k1' });
    const second = await until(r.json.run.id, (x) => x.terminal && Boolean(x.collected));
    expect(second).toMatchObject({ attempt: 2, current: true, state: 'completed' });
    expect(readRun(process.env.TIMMY_HOME!, root, first)).toMatchObject({ supersededBy: second.id, state: 'completed' });
    expect((await api('GET', `/api/workflow/runs/${first}`)).json.run.current).toBe(false);
  });

  it('gsplat is refused before anything starts (awaiting an NVIDIA worker); a bad input is refused by validation', async () => {
    const g = await api('POST', '/api/workflow/runs', { op: 'spatial.gsplat-smoke', inputs: {}, board: 'desk', node: 'shape:g1' });
    expect(g.status).toBe(409);
    expect(g.json).toMatchObject({ refused: 'setup' });
    expect(g.json.error).toMatch(/awaiting a powered NVIDIA worker/);
    const bad = await api('POST', '/api/workflow/runs', { op: 'spatial.kiri-crop-export', inputs: { splat: fixture }, params: { keep: 'teleport' }, board: 'desk', node: 'shape:k9' });
    expect(bad.status).toBe(422);
  });

  it.runIf(process.platform === 'darwin')('Brush: its final export must parse; an exit 0 without it is a failure', async () => {
    const ds = await importFile('scene.zip', Buffer.from('PK FAKE dataset'));
    const ok = await api('POST', '/api/workflow/runs', { op: 'spatial.brush-train', inputs: { dataset: ds.json.result.files[0].path }, params: { steps: 100 }, board: 'desk', node: 'shape:b1' });
    expect((await until(ok.json.run.id, (x) => x.terminal && Boolean(x.collected))).state).toBe('completed');
    const none = await importFile('noexport.zip', Buffer.from('PK FAKE dataset'));
    const bad = await api('POST', '/api/workflow/runs', { op: 'spatial.brush-train', inputs: { dataset: none.json.result.files[0].path }, params: { steps: 100 }, board: 'desk', node: 'shape:b2' });
    const done = await until(bad.json.run.id, (x) => x.terminal && Boolean(x.collected));
    expect(done.state).toBe('failed');
    expect(done.error).toMatch(/an exit code alone is not success/);
  });

  it('Recover: a run left by a stopped companion is judged from its job and collected once; nothing runs again', async () => {
    const r = await api('POST', '/api/workflow/runs', { op: 'spatial.kiri-crop-export', inputs: { splat: fixture }, board: 'desk', node: 'shape:k4' });
    const id = r.json.run.id;
    await until(id, (x) => x.terminal && Boolean(x.collected));
    const sealed = readChain('runs', root).filter((x) => x.kind === 'spatial').length;
    // as if the companion had stopped while it ran: the record still says running, uncollected
    const rec = readRun(process.env.TIMMY_HOME!, root, id)!;
    const dir = join(process.env.TIMMY_HOME!, 'workflow', projectId(root), 'runs');
    writeFileSync(join(dir, `${id}.json`), JSON.stringify({ ...rec, state: 'running', endedAt: null, collected: undefined, receipts: [], outputs: [] }));
    await companion.shutdown(); await start();
    expect((await api('GET', `/api/workflow/runs/${id}`)).json.run.left).toBe(true);
    const rv = await api('POST', `/api/workflow/runs/${id}/recover`);
    expect(rv.status).toBe(200);
    const back = await until(id, (x) => x.terminal && Boolean(x.collected));
    expect(back).toMatchObject({ state: 'completed', collected: 'sealed' });
    expect(readChain('runs', root).filter((x) => x.kind === 'spatial').length).toBe(sealed); // the same receipt, not a new run
    expect(existsSync(join(process.env.TIMMY_HOME!, 'spatial', projectId(root), 'runs', id, 'sealed.json'))).toBe(true);
  });
});
