/**
 * R13: each owner's app's ended jobs, read from that app's own record (src/companion/miniapps/app-jobs.ts), and sealed by
 * Timmy (src/companion/miniapps/receipts.ts). The fixtures are written in each app's record format as its owner's code
 * writes it (Model Studio docs/CONTRACT.md; Card Lab backend/core.mjs Store + backend/server.mjs launch; Film Room
 * server/store.mjs + server/runtime.mjs; Animate server.mjs): FAKE records, never an owner's data.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { animateJobs, APP_JOBS, cardLabJobs, filmRoomJobs, modelStudioJobs } from '../src/companion/miniapps/app-jobs.js';
import { sealFinished, type AppJobReceipt } from '../src/companion/miniapps/receipts.js';
import { miniAppOf } from '../src/companion/miniapps/registry.js';
import { installedSource } from '../src/companion/miniapps/host.js';

const U = (n: number) => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;
const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'timmy-appjobs-')); dirs.push(d); return d; };
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

describe('each app’s ended jobs, from its own record', () => {
  it('Model Studio: its /api/state jobs; only ended ones; its words kept; unsafe file names dropped', () => {
    const jobs = modelStudioJobs({ jobs: [
      { id: 'j1', kind: 'create', status: 'succeeded', engine: 'openscad', result: { asset: { id: 'a1', previewFilename: 'r1.glb', nativeFilename: '../x' } } },
      { id: 'j2', kind: 'create', status: 'interrupted', error: 'restarted' },
      { id: 'j3', kind: 'create', status: 'running' },
    ] });
    expect(jobs.map((j) => [j.id, j.status, j.outcome])).toEqual([['j1', 'succeeded', 'ok'], ['j2', 'interrupted', 'failed']]);
    expect(jobs[0]!.files).toEqual([{ name: 'a1/r1.glb', path: '/api/assets/a1/r1.glb' }]);
    expect(jobs[1]).toMatchObject({ error: 'restarted', files: [] });
    expect(modelStudioJobs(null)).toEqual([]);
  });

  it('Card Lab: one job per launch of a run; held is failed, cancel is cancelled; a launch still running is not reported; only the run’s latest ended launch carries its artifacts', () => {
    const a = `card_${U(1)}`, b = `card_${U(2)}`;
    const jobs = cardLabJobs([
      { id: a, revision: 3, events: [
        { id: 'e1', type: 'job_started', message: 'research started' }, { id: 'e2', type: 'held', message: 'provider unavailable' },
        { id: 'e3', type: 'job_started', message: 'research started' }, { id: 'e4', type: 'job_finished', message: 'research finished' },
        { id: 'e5', type: 'job_started', message: 'verify started' },
      ] },
      { id: b, events: [{ id: 'f1', type: 'cancel', message: 'before any launch' }, { id: 'f2', type: 'job_started', message: 'predict started' }, { id: 'f3', type: 'cancel', message: 'Cancellation requested' }] },
      { id: 'not-a-run', events: [] },
    ]);
    expect(jobs.map((j) => [j.id, j.kind, j.status, j.outcome])).toEqual([
      [`${a}/e1`, 'research', 'held', 'failed'], [`${a}/e3`, 'research', 'job_finished', 'ok'], [`${b}/f2`, 'predict', 'cancel', 'cancelled'],
    ]);
    expect(jobs[0]).toMatchObject({ error: 'provider unavailable', files: [] });
    expect(jobs[1]!.files.map((f) => f.path)).toEqual([`/api/runs/${a}/artifacts/card.analyze.json`, `/api/runs/${a}/artifacts/card.receipt.json`, `/api/runs/${a}/artifacts/card.summarize.md`]);
    expect(jobs[2]!.files).toEqual([]);
  });

  it('Film Room: complete is ok; a render’s accepted outputs keep their workspace scope; an ingest’s file is its managed asset; queued is not reported', () => {
    const r = U(10), i = U(11), f = U(12), q = U(13), asset = U(20);
    const jobs = filmRoomJobs([
      { id: r, type: 'render', state: 'complete', workspaceId: 'alpha', result: { clips: [{ id: 'c1', url: `/api/jobs/${r}/files/clip-001.mp4` }], reel: { url: `/api/jobs/${r}/files/highlight-reel.mp4` }, manifestUrl: `/api/jobs/${r}/files/manifest.json`, other: '/api/elsewhere' } },
      { id: i, type: 'import', state: 'complete', result: { asset: { id: asset, name: 'game.mp4' } } },
      { id: f, type: 'render', state: 'failed', error: 'ffmpeg exited 1' },
      { id: q, type: 'render', state: 'queued' },
    ]);
    expect(jobs.map((j) => [j.id, j.status, j.outcome])).toEqual([[r, 'complete', 'ok'], [i, 'complete', 'ok'], [f, 'failed', 'failed']]);
    expect(jobs[0]!.files).toEqual([
      { name: `${r}/clip-001.mp4`, path: `/api/jobs/${r}/files/clip-001.mp4?workspaceId=alpha` },
      { name: `${r}/highlight-reel.mp4`, path: `/api/jobs/${r}/files/highlight-reel.mp4?workspaceId=alpha` },
      { name: `${r}/manifest.json`, path: `/api/jobs/${r}/files/manifest.json?workspaceId=alpha` },
    ]);
    expect(jobs[1]!.files).toEqual([{ name: `assets/${asset}/game.mp4`, path: `/api/assets/${asset}/media` }]);
    expect(jobs[2]).toMatchObject({ error: 'ffmpeg exited 1', files: [] });
  });

  it('Animate: its native exports; interrupted is failed; the artifacts it lists', () => {
    const jobs = animateJobs([
      { id: U(30), status: 'succeeded', artifacts: [{ name: 'scene.blend' }, { name: 'preview.png' }, { name: '../etc' }] },
      { id: U(31), status: 'interrupted', error: 'The application restarted.' },
      { id: U(32), status: 'running' },
    ]);
    expect(jobs.map((j) => [j.status, j.outcome])).toEqual([['succeeded', 'ok'], ['interrupted', 'failed']]);
    expect(jobs[0]!.files.map((f) => f.path)).toEqual([`/api/artifacts/${U(30)}/scene.blend`, `/api/artifacts/${U(30)}/preview.png`]);
  });

  it('the disk readers read only the data folder Timmy gave the app (Card Lab, Film Room, Animate)', async () => {
    const data = tmp();
    mkdirSync(join(data, `card_${U(1)}`)); writeFileSync(join(data, `card_${U(1)}`, 'run.json'), JSON.stringify({ id: `card_${U(1)}`, events: [{ id: 'e1', type: 'job_started', message: 'x started' }, { id: 'e2', type: 'job_finished' }] }));
    mkdirSync(join(data, 'jobs')); writeFileSync(join(data, 'jobs', `${U(2)}.json`), JSON.stringify({ id: U(2), type: 'render', state: 'cancelled' }));
    writeFileSync(join(data, 'jobs', 'junk.json'), '{');
    mkdirSync(join(data, U(3))); writeFileSync(join(data, U(3), 'job.json'), JSON.stringify({ id: U(3), status: 'failed', error: 'no blender' }));
    mkdirSync(join(data, U(4))); writeFileSync(join(data, U(4), 'job.json'), '{ not json');
    const src = { json: async () => null, dataDir: data };
    expect((await APP_JOBS['card-lab'](src)).map((j) => j.outcome)).toEqual(['ok']);
    expect((await APP_JOBS['film-room'](src)).map((j) => j.outcome)).toEqual(['cancelled']);
    expect((await APP_JOBS.animate(src)).map((j) => j.outcome)).toEqual(['failed']);
    expect(await APP_JOBS.animate({ json: async () => null, dataDir: join(data, 'missing') })).toEqual([]);
  });
});

describe('sealing an app’s ended jobs', () => {
  it('Animate: the bytes the app serves are hashed by Timmy; a file it does not serve is named as not hashed; failed stays failed; each job sealed once', async () => {
    const data = tmp();
    const ok = U(40), bad = U(41);
    mkdirSync(join(data, ok)); writeFileSync(join(data, ok, 'job.json'), JSON.stringify({ id: ok, status: 'succeeded', artifacts: [{ name: 'scene.blend' }, { name: 'preview.png' }] }));
    mkdirSync(join(data, bad)); writeFileSync(join(data, bad, 'job.json'), JSON.stringify({ id: bad, status: 'failed', error: 'Blender did not complete all required outputs.' }));
    const server = http.createServer((req, res) => {
      if (req.url === `/api/artifacts/${ok}/scene.blend`) { res.writeHead(200); res.end('FAKE blend'); return; }
      res.writeHead(404); res.end();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    try {
      const sealedReceipts: AppJobReceipt[] = [];
      const o = { spec: miniAppOf('animate')!, workerPort: (server.address() as AddressInfo).port, dataDir: data, revision: null, principal: 'operator', seal: (r: AppJobReceipt) => { sealedReceipts.push(r); return `r${sealedReceipts.length}`; } };
      const sealed = new Set<string>();
      expect(await sealFinished(o, sealed)).toEqual(['r1', 'r2']);
      expect(await sealFinished(o, sealed)).toEqual([]);
      const good = sealedReceipts.find((r) => r.job.id === ok)!;
      expect(good).toMatchObject({ status: 'ok', job: { state: 'succeeded', kind: 'export' }, outputs_unhashed: [`apps/animate/${ok}/preview.png`] });
      expect(good.outputs).toEqual([{ path: `apps/animate/${ok}/scene.blend`, sha256: createHash('sha256').update('FAKE blend').digest('hex'), bytes: 10 }]);
      expect(sealedReceipts.find((r) => r.job.id === bad)).toMatchObject({ status: 'failed', job: { state: 'failed', error: 'Blender did not complete all required outputs.' }, outputs: [] });
      expect(sealedReceipts.find((r) => r.job.id === bad)).not.toHaveProperty('outputs_unhashed');
    } finally { server.close(); }
  });
});

describe('what an installed app was made from', () => {
  it('its commit when the package recorded one; else the owner archive’s label (Animate); else nothing', () => {
    const d = tmp();
    const spec = miniAppOf('animate')!;
    expect(installedSource(spec, {})).toBeNull();
    expect(installedSource(spec, { TIMMY_ANIMATE_DIR: d })).toBeNull();
    writeFileSync(join(d, '.timmy-source.json'), JSON.stringify({ app: 'animate', revision: null, label: 'v6 archive 68c2f853', from: 'owner archive' }));
    expect(installedSource(spec, { TIMMY_ANIMATE_DIR: d })).toBe('v6 archive 68c2f853');
    writeFileSync(join(d, '.timmy-source.json'), JSON.stringify({ app: 'animate', revision: 'f9db9fe074b1a7928db983b600879694a9404470', label: 'x' }));
    expect(installedSource(spec, { TIMMY_ANIMATE_DIR: d })).toBe('f9db9fe074b1a7928db983b600879694a9404470');
  });
});
