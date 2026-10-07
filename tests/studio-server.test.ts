import { afterEach, describe, expect, it } from 'vitest';
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
