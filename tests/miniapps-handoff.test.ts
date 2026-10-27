/**
 * The integrated candidate's checklist A6 and A11 (src/companion/miniapps/routes.ts): which receipt names a project file
 * (GET /api/apps/provenance), and the one supported cross-app handoff — a project image (an Animate preview delivered into
 * from-apps/) as a new Card Lab run, sealed once as a handoff receipt naming the source's receipt and the target run.
 * Against a LABELLED FAKE Card Lab (tests/fixtures/fake-card-lab: its health and POST /api/runs, as the owner's create()).
 */
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mountMiniApps } from '../src/companion/miniapps/routes.js';
import type { MiniAppHost } from '../src/companion/miniapps/host.js';
import { appendReceipt, readChain } from '../src/utils/receipts.js';
import { projectId } from '../src/project/index.js';

const FAKE = fileURLToPath(new URL('./fixtures/fake-card-lab', import.meta.url));
// a 1×1 PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

describe('a project image handed to Card Lab, with its provenance (A6, A11)', () => {
  let base: string; let server: http.Server; let origin = ''; let host: MiniAppHost; let root = ''; let rootOf: (who: string) => string;
  beforeAll(async () => {
    base = mkdtempSync(join(tmpdir(), 'timmy-handoff-'));
    rootOf = (who) => join(base, who, 'projects', 'demo');
    const app = express();
    const withToken: express.RequestHandler = (req, res, next) => (req.headers.authorization === 'Bearer FAKE' ? next() : res.status(401).json({ ok: false }));
    const withUser: express.RequestHandler = (req, _res, next) => { const u = req.headers['x-fake-user']; (req as express.Request & { user?: unknown }).user = typeof u === 'string' ? { id: u, operator: false } : { operator: true }; next(); };
    host = mountMiniApps(app, {
      withToken, withUser, env: { ...process.env, TIMMY_CARD_LAB_DIR: FAKE },
      projectOf: (req) => { const u = req.headers['x-fake-user']; const who = typeof u === 'string' ? u : 'operator'; const r = rootOf(who); mkdirSync(r, { recursive: true }); return { name: 'demo', root: r, env: { TIMMY_HOME: join(base, who, 'home') } }; },
    });
    server = await new Promise<http.Server>((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    root = rootOf('operator');
    mkdirSync(join(root, 'from-apps', 'animate', 'j1'), { recursive: true });
    writeFileSync(join(root, 'from-apps', 'animate', 'j1', 'preview.png'), PNG);
    writeFileSync(join(root, 'notes.txt'), 'not an image');
    // the Animate job's receipt that named the delivered preview (as the watcher seals it)
    appendReceipt('runs', { kind: 'miniapp', subject: 'miniapp · animate · export · succeeded', policy: 'app-initiated', status: 'ok', project: 'demo', project_id: projectId(root),
      job: { id: 'j1', kind: 'export', label: 'export', state: 'succeeded' }, outputs: [{ path: 'from-apps/animate/j1/preview.png', sha256: sha(PNG), bytes: PNG.length }],
      miniapp: { app: 'animate', title: 'Timmy Animate', revision: null, record_sha256: sha('r'), started_by: 'x', principal: 'operator' } }, root);
  }, 60_000);
  afterAll(async () => { await host.stopAll(); await new Promise<void>((r) => server.close(() => r())); rmSync(base, { recursive: true, force: true }); });

  const call = async (method: string, path: string, body?: unknown, user?: string) => {
    const r = await fetch(`${origin}${path}`, { method, headers: { authorization: 'Bearer FAKE', 'content-type': 'application/json', ...(user ? { 'x-fake-user': user } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status, body: await r.json() as Record<string, unknown> };
  };

  it('names the receipt of a delivered file, and none for a file no receipt names', async () => {
    const p = await call('GET', '/api/apps/provenance?path=from-apps/animate/j1/preview.png');
    expect(p).toMatchObject({ status: 200, body: { ok: true, sha256: sha(PNG), receipt: { kind: 'miniapp', app: 'animate', job: 'j1' } } });
    expect((await call('GET', '/api/apps/provenance?path=notes.txt')).body).toMatchObject({ ok: true, receipt: null });
    expect((await call('GET', '/api/apps/provenance?path=../x')).status).toBe(400);
  });

  it('hands the preview to Card Lab: a new run holding its exact bytes, and one handoff receipt naming both ends', async () => {
    const r = await call('POST', '/api/apps/card-lab/handoff', { path: 'from-apps/animate/j1/preview.png' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, run: expect.stringMatching(/^card_/), sha256: sha(PNG), source: { app: 'animate', job: 'j1' } });
    const h = readChain('runs', root).filter((x) => x.kind === 'handoff');
    expect(h).toHaveLength(1);
    expect(h[0]).toMatchObject({ status: 'ok', project_id: projectId(root), handoff: { from: { path: 'from-apps/animate/j1/preview.png', sha256: sha(PNG), app: 'animate', job: 'j1' }, to: { app: 'card-lab', run: r.body.run, image_sha256: sha(PNG) }, principal: 'operator' } });
    expect(h[0].handoff!.from.receipt).toBe((r.body.source as { id: string }).id);
    // another person's project has neither the file nor the run
    expect((await call('POST', '/api/apps/card-lab/handoff', { path: 'from-apps/animate/j1/preview.png' }, 'erin')).status).toBe(404);
  }, 60_000);

  it('refuses what is not an image or leaves the project, and seals nothing', async () => {
    expect((await call('POST', '/api/apps/card-lab/handoff', { path: 'notes.txt' })).status).toBe(415);
    expect((await call('POST', '/api/apps/card-lab/handoff', { path: '../../x.png' })).status).toBe(400);
    expect((await call('POST', '/api/apps/card-lab/handoff', {})).status).toBe(400);
    expect(readChain('runs', root).filter((x) => x.kind === 'handoff')).toHaveLength(1);
  });
});
