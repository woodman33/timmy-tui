/**
 * R13 (the 2026-10-26 integration order): hosting an owner's mini-app behind Timmy, unchanged (src/companion/miniapps/).
 * Against a LABELLED FAKE app (tests/fixtures/fake-miniapp, shaped like Model Studio's server: its own Host check, its own
 * Origin check, frame-ancestors 'none'): no model, no network beyond loopback, no paid call.
 *
 * What is pinned: the worker runs as a durable server job of the principal's Timmy home and stops through it; the page
 * reaches it only through the gateway, which answers only the browser that used a one-time launch key; the app's own checks
 * still pass (Host and Origin become the worker's) and its frame-ancestors names Timmy's origin; the companion's provider
 * keys and tokens never reach the app; two principals and two projects get separate data folders and separate workers.
 */
import express from 'express';
import http from 'node:http';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { framedPolicy, hostProblem, MiniAppHost } from '../src/companion/miniapps/host.js';
import { mountMiniApps } from '../src/companion/miniapps/routes.js';
import { projectId } from '../src/project/index.js';
import { readChain, verifyChain } from '../src/utils/receipts.js';
import { createHash } from 'node:crypto';
import { MINI_APPS, miniAppOf } from '../src/companion/miniapps/registry.js';

const FAKE_APP = fileURLToPath(new URL('./fixtures/fake-miniapp', import.meta.url));

interface Got { status: number; headers: http.IncomingHttpHeaders; body: string }
function get(url: string, headers: Record<string, string> = {}, method = 'GET', body?: string): Promise<Got> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request({ host: u.hostname, port: u.port, path: `${u.pathname}${u.search}`, method, headers: { host: u.host, ...headers } }, (res) => {
      let b = ''; res.setEncoding('utf8'); res.on('data', (c) => { b += c; }); res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: b }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}
const cookieOf = (g: Got) => String((g.headers['set-cookie'] ?? [])[0] ?? '').split(';')[0];

describe('mini-apps hosted behind Timmy (FAKE app)', () => {
  let base: string;
  let server: http.Server;
  let timmy = '';
  let host: MiniAppHost;
  const kept = { OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY, TIMMY_SECRET_TOKEN: process.env.TIMMY_SECRET_TOKEN };

  beforeAll(async () => {
    base = mkdtempSync(join(tmpdir(), 'timmy-miniapps-'));
    // what the companion's own environment holds that an app must never see
    process.env.OPENROUTER_API_KEY = 'sk-or-FAKE-never-forwarded';
    process.env.TIMMY_SECRET_TOKEN = 'FAKE-token-never-forwarded';
    const app = express();
    // FAKE guards: the launch token as a header; a user named by a test header (the companion's withToken / withUser)
    const withToken: express.RequestHandler = (req, res, next) => (req.headers.authorization === 'Bearer FAKE' ? next() : res.status(401).json({ ok: false }));
    const withUser: express.RequestHandler = (req, _res, next) => {
      const u = req.headers['x-fake-user'];
      (req as express.Request & { user?: unknown }).user = typeof u === 'string' ? { id: u, operator: false } : { operator: true };
      next();
    };
    const env = { ...process.env, TIMMY_MODEL_STUDIO_DIR: FAKE_APP };
    host = mountMiniApps(app, {
      withToken, withUser, env,
      projectOf: (req) => {
        const u = req.headers['x-fake-user'];
        const who = typeof u === 'string' ? u : 'operator';
        const proj = typeof req.query.p === 'string' ? req.query.p : 'one';
        const root = join(base, who, 'projects', proj);
        mkdirSync(root, { recursive: true });
        return { name: proj, root, env: { TIMMY_HOME: join(base, who, 'home') } };
      },
    });
    server = await new Promise<http.Server>((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    timmy = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await host.stopAll();
    await new Promise<void>((r) => server.close(() => r()));
    for (const [k, v] of Object.entries(kept)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    rmSync(base, { recursive: true, force: true });
  });

  it('the register: four launch apps and Animate; only Model Studio is hostable, the rest say the step they wait on', () => {
    expect(MINI_APPS.map((a) => a.id)).toEqual(['card-lab', 'film-room', 'model-studio', 'stream-studio', 'animate']);
    expect(MINI_APPS.filter((a) => a.availability === 'hostable').map((a) => a.id)).toEqual(['model-studio']);
    for (const a of MINI_APPS) expect(a.observed?.next).toBeTruthy();
    const ms = miniAppOf('model-studio')!;
    expect(hostProblem(ms, {})).toMatch(/not installed with this Timmy/);
    expect(hostProblem(ms, { TIMMY_MODEL_STUDIO_DIR: join(base, 'nowhere') })).toMatch(/has no server\.mjs/);
    expect(hostProblem(ms, { TIMMY_MODEL_STUDIO_DIR: FAKE_APP })).toBeNull();
    expect(framedPolicy("default-src 'self'; frame-ancestors 'none'", ['http://127.0.0.1:1'])).toBe("default-src 'self'; frame-ancestors http://127.0.0.1:1");
  });

  it('GET /api/apps needs the token, and lists each app honestly', async () => {
    expect((await get(`${timmy}/api/apps`)).status).toBe(401);
    const r = JSON.parse((await get(`${timmy}/api/apps`, { authorization: 'Bearer FAKE' })).body);
    expect(r.ok).toBe(true);
    const by = Object.fromEntries(r.apps.map((a: { id: string }) => [a.id, a]));
    expect(by['model-studio']).toMatchObject({ hostable: true, running: false, problem: null });
    expect(by['card-lab']).toMatchObject({ hostable: false, availability: 'awaiting-owner-checkpoint' });
    expect(by['stream-studio']).toMatchObject({ hostable: false, availability: 'no-owner' });
    const refused = await get(`${timmy}/api/apps/card-lab/open`, { authorization: 'Bearer FAKE', 'content-type': 'application/json' }, 'POST', '{}');
    expect(refused.status).toBe(409);
  });

  it('open: a durable job runs the app; the gateway answers only the launched browser, keeps the app’s own checks, frames for Timmy, forwards no secret; stop ends the job', async () => {
    const opened = await get(`${timmy}/api/apps/model-studio/open`, { authorization: 'Bearer FAKE', 'content-type': 'application/json' }, 'POST', '{}');
    expect(opened.status).toBe(200);
    const o = JSON.parse(opened.body);
    expect(o.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/__timmy\/launch\?k=[0-9a-f]{48}$/);
    expect(o.job).toMatch(/^j[0-9a-f]{6}$/);
    const gw = new URL(o.url);
    const gateway = `http://127.0.0.1:${gw.port}`;

    // the job record is Timmy's own, in the principal's home
    const record = JSON.parse(readFileSync(join(base, 'operator', 'home', 'jobs', `${o.job}.json`), 'utf8'));
    expect(record).toMatchObject({ kind: 'server', state: 'ready' });

    // no cookie: refused; the launch key: a cookie and the page; used again: refused
    expect((await get(`${gateway}/`)).status).toBe(401);
    const launched = await get(o.url);
    expect(launched.status).toBe(302);
    const cookie = cookieOf(launched);
    expect(String(launched.headers['set-cookie'])).toMatch(/HttpOnly; SameSite=Strict; Path=\//);
    expect((await get(o.url)).status).toBe(403);

    const pageRes = await get(`${gateway}/`, { cookie });
    expect(pageRes.status).toBe(200);
    expect(pageRes.body).toContain('FAKE mini-app page');
    // the app's frame-ancestors 'none' names Timmy's origin instead
    expect(String(pageRes.headers['content-security-policy'])).toContain(`frame-ancestors http://127.0.0.1:${new URL(timmy).port} http://localhost:${new URL(timmy).port}`);
    expect(String(pageRes.headers['content-security-policy'])).not.toContain("frame-ancestors 'none'");
    expect(pageRes.headers['x-frame-options']).toBeUndefined();

    // the app's own Origin check still passes for its own page's requests, and another origin is refused at the gateway
    const echoed = await get(`${gateway}/api/echo`, { cookie, origin: gateway, 'content-type': 'application/json' }, 'POST', '{"a":1}');
    expect(JSON.parse(echoed.body)).toEqual({ echoed: '{"a":1}' });
    expect((await get(`${gateway}/api/state`, { cookie, origin: 'http://evil.example' })).status).toBe(403);
    expect((await get(`http://127.0.0.1:${gw.port}/api/state`, { cookie, host: `localhost:${gw.port}` })).status).toBe(403);

    // what the app sees: no provider key, no token, no gateway cookie, no referer; its data folder is the principal's
    const seen = JSON.parse((await get(`${gateway}/api/env`, { cookie, referer: `${timmy}/app` })).body);
    expect(seen.keys).not.toContain('OPENROUTER_API_KEY');
    expect(seen.keys).not.toContain('TIMMY_SECRET_TOKEN');
    expect(seen.keys).not.toContain('STUDIO_ALLOW_PAID');
    expect(seen.keys).toEqual(expect.arrayContaining(['STUDIO_PORT', 'STUDIO_DATA_DIR', 'PYTHONDONTWRITEBYTECODE']));
    expect(seen.cookie).toBeNull();
    expect(seen.referer).toBeNull();
    const state = JSON.parse((await get(`${gateway}/api/state`, { cookie })).body);
    expect(state.dataDir.startsWith(join(base, 'operator', 'home', 'apps', 'model-studio'))).toBe(true);

    const listed = JSON.parse((await get(`${timmy}/api/apps`, { authorization: 'Bearer FAKE' })).body);
    expect(listed.apps.find((a: { id: string }) => a.id === 'model-studio').running).toBe(true);

    const stopped = JSON.parse((await get(`${timmy}/api/apps/model-studio/stop`, { authorization: 'Bearer FAKE', 'content-type': 'application/json' }, 'POST', '{}')).body);
    expect(stopped).toEqual({ ok: true, stopped: true });
    const after = JSON.parse(readFileSync(join(base, 'operator', 'home', 'jobs', `${o.job}.json`), 'utf8'));
    expect(after.state).toBe('cancelled');
    expect(existsSync(join(state.dataDir, 'stopped.json'))).toBe(true);
    await expect(get(`${gateway}/`, { cookie })).rejects.toThrow();
  }, 60_000);

  it('two principals and two projects: separate data folders, separate workers, and one’s launch never opens the other’s', async () => {
    const open = async (user: string | null, p: string) => JSON.parse((await get(`${timmy}/api/apps/model-studio/open?p=${p}`, { authorization: 'Bearer FAKE', 'content-type': 'application/json', ...(user ? { 'x-fake-user': user } : {}) }, 'POST', '{}')).body);
    const a = await open('alice', 'one');
    const b = await open('bob', 'one');
    const a2 = await open('alice', 'two');
    const ports = [a, b, a2].map((x) => new URL(x.url).port);
    expect(new Set(ports).size).toBe(3);
    const stateOf = async (x: { url: string }) => {
      const l = await get(x.url);
      return JSON.parse((await get(`http://127.0.0.1:${new URL(x.url).port}/api/state`, { cookie: cookieOf(l) })).body).dataDir as string;
    };
    const [da, db, da2] = [await stateOf(a), await stateOf(b), await stateOf(a2)];
    expect(da.startsWith(join(base, 'alice', 'home', 'apps'))).toBe(true);
    expect(db.startsWith(join(base, 'bob', 'home', 'apps'))).toBe(true);
    expect(da2).not.toBe(da);
    // alice's cookie is not bob's gateway's
    const la = await get((await open('alice', 'one')).url);
    expect((await get(`http://127.0.0.1:${new URL(b.url).port}/api/state`, { cookie: cookieOf(la) })).status).toBe(401);
    // the same principal and project reuse their worker
    expect(new URL((await open('alice', 'one')).url).port).toBe(ports[0]);
  }, 90_000);

  it('receipts: each job the app reports ended is sealed once into the project’s runs chain, its files hashed by Timmy from the app’s bytes', async () => {
    const opened = JSON.parse((await get(`${timmy}/api/apps/model-studio/open?p=receipts`, { authorization: 'Bearer FAKE', 'content-type': 'application/json' }, 'POST', '{}')).body);
    const l = await get(opened.url);
    const gateway = `http://127.0.0.1:${new URL(opened.url).port}`;
    const cookie = cookieOf(l);
    const ok = JSON.parse((await get(`${gateway}/api/jobs`, { cookie, 'content-type': 'application/json' }, 'POST', '{}')).body);
    const bad = JSON.parse((await get(`${gateway}/api/jobs`, { cookie, 'content-type': 'application/json' }, 'POST', '{"fail":true}')).body);
    const root = join(base, 'operator', 'projects', 'receipts');
    const hosted = host.get(`model-studio:operator:${projectId(root)}`)!;
    expect(hosted).toBeTruthy();
    const ids = await hosted.sealNow();
    expect(ids).toHaveLength(2);
    expect(await hosted.sealNow()).toEqual([]);  // sealed once
    const chain = readChain('runs', root).filter((r) => r.kind === 'miniapp');
    expect(chain).toHaveLength(2);
    const good = chain.find((r) => r.job?.id === ok.id)!;
    expect(good).toMatchObject({ status: 'ok', policy: 'app-initiated', project: 'receipts', job: { kind: 'create', state: 'succeeded' } });
    expect(good.miniapp).toMatchObject({ app: 'model-studio', started_by: expect.stringMatching(/not observed by Timmy/) });
    expect(good.outputs).toEqual([
      { path: `apps/model-studio/${ok.result.asset.id}/r1-model.glb`, sha256: createHash('sha256').update('FAKE glb bytes').digest('hex'), bytes: 14 },
      { path: `apps/model-studio/${ok.result.asset.id}/r1-model.blend`, sha256: createHash('sha256').update('FAKE blend bytes').digest('hex'), bytes: 16 },
    ]);
    const failed = chain.find((r) => r.job?.id === bad.id)!;
    expect(failed).toMatchObject({ status: 'failed', job: { state: 'failed', error: 'FAKE failure' }, outputs: [] });
    expect(verifyChain('runs', root).ok).toBe(true);
    // a restart of the app seals nothing again (the sealed ids are kept beside its data)
    await get(`${timmy}/api/apps/model-studio/stop?p=receipts`, { authorization: 'Bearer FAKE', 'content-type': 'application/json' }, 'POST', '{}');
    expect(readChain('runs', root).filter((r) => r.kind === 'miniapp')).toHaveLength(2);
  }, 60_000);
});
