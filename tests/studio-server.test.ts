import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { studioConfig, TLDRAW_VERSION } from '../src/studio/config.js';
import { ensureStudioServer, startStudioServer } from '../src/studio/server.js';

// F-4, slice 1: Timmy's canvas (companion/studio-canvas) on one pinned tldraw, licensed from
// TLDRAW_LICENSE_KEY at run time: the same name as the operator's GitHub Actions secret, which a
// workflow maps in. Never stored in the repo, never printed. Without it, tldraw runs in
// development mode, which needs no key on 127.0.0.1.
const KEY = 'tldraw-test/eyJ0ZXN0Ijp0cnVlfQ.c2ln';

describe('studio config', () => {
  it('reads the tldraw license from TLDRAW_LICENSE_KEY at run time, trimmed; blank or unset means none', () => {
    expect(studioConfig({})).toEqual({ licenseKey: null, tldrawVersion: TLDRAW_VERSION });
    expect(studioConfig({ TLDRAW_LICENSE_KEY: '  \n' }).licenseKey).toBeNull();
    expect(studioConfig({ TLDRAW_LICENSE_KEY: ` ${KEY}\n` }).licenseKey).toBe(KEY);
  });
  it('pins one exact tldraw version', () => {
    expect(TLDRAW_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe('the studio server', () => {
  let server: Server | undefined;
  afterEach(() => new Promise<void>((done) => (server ? server.close(() => done()) : done())));
  const port = (): number => (server!.address() as AddressInfo).port;
  const get = (path: string, host?: string) =>
    new Promise<{ status: number; body: string; headers: Record<string, unknown> }>((resolve, reject) => {
      const req = request({ hostname: '127.0.0.1', port: port(), path, headers: host ? { Host: host } : {} }, (res) => {
        let body = '';
        res.on('data', (c) => { body += String(c); });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
      });
      req.on('error', reject);
      req.end();
    });

  it('listens on 127.0.0.1 only', async () => {
    server = await startStudioServer(0, { env: {} });
    expect((server.address() as AddressInfo).address).toBe('127.0.0.1');
  });
  it('hands the page its license and tldraw version, never cached', async () => {
    server = await startStudioServer(0, { env: { TLDRAW_LICENSE_KEY: KEY } });
    const r = await get('/studio-config.json');
    expect(r.status).toBe(200);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(JSON.parse(r.body)).toEqual({ licenseKey: KEY, tldrawVersion: TLDRAW_VERSION });
  });
  it('answers only requests addressed to this machine (a rebound DNS name gets 403, not the key)', async () => {
    server = await startStudioServer(0, { env: { TLDRAW_LICENSE_KEY: KEY } });
    for (const host of [`127.0.0.1:${port()}`, `localhost:${port()}`, `[::1]:${port()}`]) expect((await get('/studio-config.json', host)).status).toBe(200);
    const evil = await get('/studio-config.json', `evil.example:${port()}`);
    expect(evil.status).toBe(403);
    expect(evil.body).not.toContain(KEY);
  });
  // Fourth order, step 5: the page's code is bundled on this machine (scripts/canvas/build.mjs) from
  // companion/studio-canvas/src/canvas.js; the page loads dist/canvas.js beside it.
  const pageCode = readFileSync('companion/studio-canvas/src/canvas.js', 'utf8');
  const canvasRoot = (built: boolean): string => {
    const dir = mkdtempSync(join(tmpdir(), 'timmy-studio-root-'));
    writeFileSync(join(dir, 'index.html'), readFileSync('companion/studio-canvas/index.html'));
    if (built) {
      mkdirSync(join(dir, 'dist'));
      writeFileSync(join(dir, 'dist', 'canvas.js'), '// built');
    }
    return dir;
  };
  it('serves the canvas page, which loads the bundle built beside it', async () => {
    const root = canvasRoot(true);
    try {
      server = await startStudioServer(0, { env: {}, root });
      const page = await get('/');
      expect(page.status).toBe(200);
      expect(page.body).toContain('src="dist/canvas.js"');
      expect((await get('/dist/canvas.js')).body).toBe('// built');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it('a canvas not built yet gets a page that says so and how to build it, not a blank page', async () => {
    const root = canvasRoot(false);
    try {
      server = await startStudioServer(0, { env: {}, root });
      for (const path of ['/', '/index.html']) {
        const page = await get(path);
        expect(page.status).toBe(503);
        expect(page.headers['content-type']).toMatch(/^text\/html/);
        expect(page.body).toContain('Timmy Canvas is not built yet');
        expect(page.body).toContain('npm run build:canvas');
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it("the page's code: the license passed to <Tldraw>, the editor handed to Timmy, and the bundle's tldraw checked against the pin", () => {
    expect(pageCode).toContain("fetch('/studio-config.json'");
    expect(pageCode).toMatch(/licenseKey: config\.licenseKey/);
    expect(pageCode).toContain('window.timmyCanvas');
    expect(pageCode).toContain('config.tldrawVersion !== BUILT_WITH');
  });
  it('shows tldraw\'s own license verdict, never "licensed" just because a key is set', () => {
    expect(pageCode).toContain('editor.licenseManager?.state.get()');
    expect(pageCode).not.toMatch(/licenseKey \? ['"`][^'"`]*licensed/); // the old page did exactly this
  });
});

// Fourth order, step 5: the canvas is saved by Timmy in its home (canvas/canvas.json) and opened
// from there, so it reopens where it was and every surface reads the same document and revision.
describe('the canvas file through the server', () => {
  let server: Server | undefined;
  let home = '';
  afterEach(async () => {
    await new Promise<void>((done) => (server ? server.close(() => done()) : done()));
    server = undefined;
    rmSync(home, { recursive: true, force: true });
  });
  const start = async (options: { maxCanvasBytes?: number } = {}) => {
    home = mkdtempSync(join(tmpdir(), 'timmy-canvas-home-'));
    server = await startStudioServer(0, { env: { TIMMY_HOME: home }, ...options });
  };
  const call = async (method: string, path: string, body?: unknown, contentType = 'application/json') => {
    const r = await fetch(`http://127.0.0.1:${(server!.address() as AddressInfo).port}${path}`, {
      method, headers: body === undefined ? {} : { 'Content-Type': contentType }, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
    return { status: r.status, cache: r.headers.get('cache-control'), body: await r.json() as Record<string, unknown> };
  };
  const SNAP = { store: { 'page:page': { id: 'page:page', typeName: 'page', name: 'Page 1', index: 'a1', meta: {} } }, schema: { schemaVersion: 2, sequences: {} } };
  const sha = (o: unknown): string => createHash('sha256').update(JSON.stringify(o)).digest('hex');

  it('a new home opens a blank canvas, never cached', async () => {
    await start();
    expect(await call('GET', '/api/canvas/document')).toEqual({ status: 200, cache: 'no-store', body: { revision: 0, sourceRevision: null, savedAt: null, snapshot: null } });
  });
  it('saves what the page sends (JSON only) and opens it again from the file in Timmy\'s home', async () => {
    await start();
    expect((await call('PUT', '/api/canvas/document', 'snapshot', 'text/plain')).status).toBe(415);
    const saved = await call('PUT', '/api/canvas/document', { snapshot: SNAP, revision: 2, baseRevision: 0 });
    expect(saved).toEqual({ status: 200, cache: 'no-store', body: { ok: true, revision: 2, sourceRevision: sha(SNAP), savedAt: expect.any(String) } });
    expect((await call('GET', '/api/canvas/document')).body).toEqual({ revision: 2, sourceRevision: sha(SNAP), savedAt: saved.body.savedAt, snapshot: SNAP });
    expect(JSON.parse(readFileSync(join(home, 'canvas', 'canvas.json'), 'utf8'))).toMatchObject({ revision: 2, snapshot: SNAP });
  });
  it('a save from an older revision gets 409 with the revision that won; a malformed save gets 400', async () => {
    await start();
    await call('PUT', '/api/canvas/document', { snapshot: SNAP, revision: 5, baseRevision: 0 });
    const stale = await call('PUT', '/api/canvas/document', { snapshot: SNAP, revision: 3, baseRevision: 0 });
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({ ok: false, conflict: true, revision: 5 });
    expect((await call('PUT', '/api/canvas/document', { snapshot: 'x', revision: -1 })).status).toBe(400);
  });
  it("links a sealed receipt to a canvas job: JSON only, an unknown job 404, a malformed receipt ID 400", async () => {
    await start();
    // A job exists only once a page has answered a call with a source revision; write the ledger directly.
    const { CanvasDocuments } = await import('../src/studio/document.js');
    new CanvasDocuments(join(home, 'canvas')).recordJob('turn-1', { ok: true, revision: 2, sourceRevision: sha(SNAP) });
    expect((await call('POST', '/api/canvas/jobs/turn-1/receipt', 'r', 'text/plain')).status).toBe(415);
    expect((await call('POST', '/api/canvas/jobs/turn-9/receipt', { receipt: '0f3c9a12' }))).toMatchObject({ status: 404, body: { ok: false, error: 'No canvas job turn-9.' } });
    expect((await call('POST', '/api/canvas/jobs/turn-1/receipt', { receipt: '<b>' })).status).toBe(400);
    expect(await call('POST', '/api/canvas/jobs/turn-1/receipt', { receipt: '0f3c9a12' })).toEqual({ status: 200, cache: 'no-store', body: { ok: true, job: 'turn-1', receipt: '0f3c9a12' } });
    expect((await call('GET', '/api/canvas/jobs')).body).toEqual([expect.objectContaining({ id: 'turn-1', receipt: '0f3c9a12' })]);
  });
  it('a canvas too large to save gets 413 and says so', async () => {
    await start({ maxCanvasBytes: 300 });
    const big = await call('PUT', '/api/canvas/document', { snapshot: { ...SNAP, big: 'x'.repeat(1000) }, revision: 1, baseRevision: 0 });
    expect(big).toMatchObject({ status: 413, body: { ok: false, error: 'This canvas is too large to save (over 300 bytes).' } });
  });
});

describe('/web studio in the REPL', () => {
  it('starts Timmy Canvas inside the REPL when nothing serves it, and uses the one already running when the port is taken', async () => {
    const first = await ensureStudioServer(0, { env: {} });
    expect(first.state).toBe('started');
    const port = ((first as { server: Server }).server.address() as AddressInfo).port;
    const second = await ensureStudioServer(port, { env: {} });
    expect(second).toEqual({ state: 'already-running' });
    await new Promise<void>((done) => (first as { server: Server }).server.close(() => done()));
  });
});

describe('the license check workflow', () => {
  it('checks the pinned tldraw version, runs the controls before the secret, and never prints hosts', () => {
    const wf = readFileSync('.github/workflows/tldraw-license.yml', 'utf8');
    expect(wf).toContain(`for v in ${TLDRAW_VERSION} `);
    expect(wf).toContain('workflow_dispatch');
    expect(wf).not.toMatch(/^\s*(push|pull_request|schedule):/m); // by hand only
    expect(wf.indexOf('license-check.test.mjs')).toBeLessThan(wf.indexOf('secrets.TLDRAW_LICENSE_KEY'));
    expect(wf).not.toContain('--show-hosts');
    expect(wf.match(/secrets\./g)).toHaveLength(1); // the key reaches one step only
  });
});
