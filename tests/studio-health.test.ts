/**
 * Round R1, gap 4: the REPL finds Timmy Canvas and says what state it is in. One address for every
 * caller (TIMMY_STUDIO_URL, else TIMMY_STUDIO_PORT, else 4337); a health route that says whether a
 * canvas page is open, without running code in it; and a port held by another program is never
 * taken for Timmy.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { STUDIO_PORT, TLDRAW_VERSION, studioBaseUrl, studioPort } from '../src/studio/config.js';
import { studioHealth } from '../src/studio/health.js';
import { ensureStudioServer, startStudioServer } from '../src/studio/server.js';
import { receiptUrl, resolveWebTarget } from '../src/repl/web.js';

const servers: Server[] = [];
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((done) => s.close(() => done()))));
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'timmy-health-'));
  dirs.push(d);
  return d;
};
const portOf = (s: Server): number => (s.address() as AddressInfo).port;

describe('one address for Timmy Canvas', () => {
  it('reads TIMMY_STUDIO_URL, else TIMMY_STUDIO_PORT, else 4337', () => {
    expect(studioPort({})).toBe(STUDIO_PORT);
    expect(studioPort({ TIMMY_STUDIO_PORT: '5555' })).toBe(5555);
    expect(studioPort({ TIMMY_STUDIO_PORT: 'abc' })).toBe(STUDIO_PORT);
    expect(studioPort({ TIMMY_STUDIO_PORT: '70000' })).toBe(STUDIO_PORT);
    expect(studioBaseUrl({})).toBe('http://127.0.0.1:4337');
    expect(studioBaseUrl({ TIMMY_STUDIO_PORT: '5555' })).toBe('http://127.0.0.1:5555');
    expect(studioBaseUrl({ TIMMY_STUDIO_URL: 'http://127.0.0.1:9999/', TIMMY_STUDIO_PORT: '5555' })).toBe('http://127.0.0.1:9999');
  });
  it('the web views and receipt links use it too', () => {
    expect(resolveWebTarget('studio', { TIMMY_STUDIO_PORT: '5555' })).toBe('http://127.0.0.1:5555/');
    expect(receiptUrl('020b6885', { TIMMY_STUDIO_PORT: '5555' })).toBe('http://127.0.0.1:5555/receipts/020b6885');
    expect(receiptUrl('020b6885', {})).toBe('http://127.0.0.1:4337/receipts/020b6885');
  });
});

describe('GET /api/canvas/health', () => {
  it('says what this server is, whether a page is open, and what it saved; never the license', async () => {
    const server = await startStudioServer(0, { env: { TLDRAW_LICENSE_KEY: 'tldraw-synthetic-key' }, canvasDir: tmp() });
    servers.push(server);
    const res = await fetch(`http://127.0.0.1:${portOf(server)}/api/canvas/health`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const text = await res.text();
    expect(text).not.toContain('tldraw-synthetic-key');
    const body = JSON.parse(text);
    expect(body).toMatchObject({ ok: true, app: 'timmy-canvas', tldrawVersion: TLDRAW_VERSION, pageConnected: false, revision: 0, jobs: 0 });
    expect(typeof body.built).toBe('boolean');
  });
});

describe('studioHealth', () => {
  it('running: a Timmy Canvas answered, with no page open yet', async () => {
    const server = await startStudioServer(0, { env: {}, canvasDir: tmp() });
    servers.push(server);
    const h = await studioHealth(`http://127.0.0.1:${portOf(server)}`);
    expect(h).toMatchObject({ state: 'running', pageConnected: false, revision: 0, jobs: 0 });
  });
  it('not running: nothing listens there', async () => {
    const probe = createServer();
    await new Promise<void>((done) => probe.listen(0, '127.0.0.1', () => done()));
    const port = portOf(probe);
    await new Promise<void>((done) => probe.close(() => done()));
    expect(await studioHealth(`http://127.0.0.1:${port}`)).toEqual({ state: 'not-running' });
  });
  it('other: something else answers on that port', async () => {
    const other = createServer((_req, res) => res.writeHead(200, { 'Content-Type': 'text/html' }).end('<h1>not timmy</h1>'));
    await new Promise<void>((done) => other.listen(0, '127.0.0.1', () => done()));
    servers.push(other);
    const h = await studioHealth(`http://127.0.0.1:${portOf(other)}`);
    expect(h.state).toBe('other');
  });
});

describe('ensureStudioServer', () => {
  it('never takes another program on the port for Timmy Canvas', async () => {
    const other = createServer((_req, res) => res.writeHead(404).end());
    await new Promise<void>((done) => other.listen(0, '127.0.0.1', () => done()));
    servers.push(other);
    const r = await ensureStudioServer(portOf(other), { env: {}, canvasDir: tmp() });
    expect(r.state).toBe('failed');
    expect((r as { error: string }).error).toMatch(/another program/);
  });
});
