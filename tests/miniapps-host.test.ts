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
import net from 'node:net';
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

  it('the register: four launch apps and Animate; the four with owner checkpoints are hostable, Stream Studio says it has no owner', () => {
    expect(MINI_APPS.map((a) => a.id)).toEqual(['card-lab', 'film-room', 'model-studio', 'stream-studio', 'animate']);
    expect(MINI_APPS.filter((a) => a.availability === 'hostable').map((a) => a.id)).toEqual(['card-lab', 'film-room', 'model-studio', 'animate']);
    expect(miniAppOf('stream-studio')!.availability).toBe('no-owner');
    // every hostable app's env: its port and data folder set, no provider key or paid switch passed whatever the companion holds
    for (const a of MINI_APPS.filter((x) => x.host)) {
      const env = a.host!.env({ port: 1234, dataDir: '/data', base: { OPENROUTER_API_KEY: 'k', CARDLAB_CLOUDFLARE_AGENT_TOKEN: 't', STUDIO_ALLOW_PAID: '1', ROBOFLOW_API_KEY: 'r', PATH: '/bin', TLDRAW_LICENSE_KEY: 'x' } });
      expect(Object.keys(env).filter((k) => /KEY|TOKEN|PAID|SECRET/.test(k) && k !== 'TLDRAW_LICENSE_KEY')).toEqual([]);
      expect(Object.values(env)).toContain('/data');
      expect(Object.values(env)).toContain('1234');
    }
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
    expect(by['card-lab']).toMatchObject({ hostable: false, availability: 'hostable', problem: expect.stringMatching(/not installed with this Timmy/) });
    expect(by['stream-studio']).toMatchObject({ hostable: false, availability: 'no-owner' });
    const refused = await get(`${timmy}/api/apps/stream-studio/open`, { authorization: 'Bearer FAKE', 'content-type': 'application/json' }, 'POST', '{}');
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
    const stateOf = async (x: { url: string }) => {
      const l = await get(x.url);
      return JSON.parse((await get(`http://127.0.0.1:${new URL(x.url).port}/api/state`, { cookie: cookieOf(l) })).body).dataDir as string;
    };
    // (each launch address is entered before the same principal opens another project, which ends it)
    const a = await open('alice', 'one');
    const da = await stateOf(a);
    const b = await open('bob', 'one');
    const db = await stateOf(b);
    const a2 = await open('alice', 'two');
    const da2 = await stateOf(a2);
    const ports = [a, b, a2].map((x) => new URL(x.url).port);
    expect(new Set(ports).size).toBe(3);
    expect(da.startsWith(join(base, 'alice', 'home', 'apps'))).toBe(true);
    expect(db.startsWith(join(base, 'bob', 'home', 'apps'))).toBe(true);
    expect(da2).not.toBe(da);
    // alice's cookie is not bob's gateway's
    const la = await get((await open('alice', 'one')).url);
    expect((await get(`http://127.0.0.1:${new URL(b.url).port}/api/state`, { cookie: cookieOf(la) })).status).toBe(401);
    // the same principal and project reuse their worker
    expect(new URL((await open('alice', 'one')).url).port).toBe(ports[0]);
  }, 90_000);

  it('receipts: each job the app reports ended is sealed once into the project’s runs chain with its principal, project, app job and source; outcomes never upgraded; output bytes hashed by Timmy; no second seal after a restart that replays history, even without the sealed-ids file', async () => {
    const H = { authorization: 'Bearer FAKE', 'content-type': 'application/json' };
    const opened = JSON.parse((await get(`${timmy}/api/apps/model-studio/open?p=receipts`, H, 'POST', '{}')).body);
    const gateway = `http://127.0.0.1:${new URL(opened.url).port}`;
    const cookie = cookieOf(await get(opened.url));
    const post = async (body: string) => JSON.parse((await get(`${gateway}/api/jobs`, { cookie, 'content-type': 'application/json' }, 'POST', body)).body);
    const ok = await post('{}');
    const bad = await post('{"fail":true}');
    const stopped = await post('{"cancel":true}');
    const root = join(base, 'operator', 'projects', 'receipts');
    const key = `model-studio:operator:${projectId(root)}`;
    const hosted = host.get(key)!;
    expect(hosted).toBeTruthy();
    expect(await hosted.sealNow()).toHaveLength(3);
    expect(await hosted.sealNow()).toEqual([]);  // sealed once
    const chain = () => readChain('runs', root).filter((r) => r.kind === 'miniapp');
    expect(chain()).toHaveLength(3);
    const good = chain().find((r) => r.job?.id === ok.id)!;
    expect(good).toMatchObject({ status: 'ok', policy: 'app-initiated', project: 'receipts', project_id: projectId(root), job: { kind: 'create', state: 'succeeded' } });
    expect(good.miniapp).toMatchObject({ app: 'model-studio', principal: 'operator', started_by: expect.stringMatching(/not observed by Timmy/), record_sha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
    // the checklist's A6: each output is in the project's own Files too (from-apps/<app>/<job>/), the bytes the receipt hashed
    expect(good.outputs).toEqual([
      { path: `from-apps/model-studio/${ok.id}/${ok.result.asset.id}/r1-model.glb`, sha256: createHash('sha256').update('FAKE glb bytes').digest('hex'), bytes: 14 },
      { path: `from-apps/model-studio/${ok.id}/${ok.result.asset.id}/r1-model.blend`, sha256: createHash('sha256').update('FAKE blend bytes').digest('hex'), bytes: 16 },
    ]);
    for (const o2 of good.outputs!) expect(createHash('sha256').update(readFileSync(join(root, o2.path))).digest('hex')).toBe(o2.sha256);
    // a failed job stays failed and a cancelled one cancelled: a receipt records the outcome, it does not make it a success
    expect(chain().find((r) => r.job?.id === bad.id)).toMatchObject({ status: 'failed', job: { state: 'failed', error: 'FAKE failure' }, outputs: [] });
    expect(chain().find((r) => r.job?.id === stopped.id)).toMatchObject({ status: 'cancelled', job: { state: 'cancelled' }, outputs: [] });
    expect(verifyChain('runs', root).ok).toBe(true);
    // the app restarts and reports its saved jobs again; the sealed-ids file is gone: the chain itself says they are sealed
    await get(`${timmy}/api/apps/model-studio/stop?p=receipts`, H, 'POST', '{}');
    const ids = join(base, 'operator', 'home', 'apps', 'model-studio', `${projectId(root)}.timmy-sealed.json`);
    expect(existsSync(ids)).toBe(true);
    rmSync(ids);
    JSON.parse((await get(`${timmy}/api/apps/model-studio/open?p=receipts`, H, 'POST', '{}')).body);
    expect(await host.get(key)!.sealNow()).toEqual([]);
    expect(chain()).toHaveLength(3);
    await get(`${timmy}/api/apps/model-studio/stop?p=receipts`, H, 'POST', '{}');
  }, 60_000);

  it('isolation: a project switch ends the old project’s grants; sign-out revocation ends only that principal’s; one principal cannot stop another’s app; Range bytes pass; the worker port is never handed out; a restart issues new grants', async () => {
    const H = (user: string | null) => ({ authorization: 'Bearer FAKE', 'content-type': 'application/json', ...(user ? { 'x-fake-user': user } : {}) });
    const open = async (user: string | null, p: string) => JSON.parse((await get(`${timmy}/api/apps/model-studio/open?p=${p}`, H(user), 'POST', '{}')).body);
    const enter = async (url: string) => cookieOf(await get(url));
    const gw = (o: { url: string }) => `http://127.0.0.1:${new URL(o.url).port}`;

    // carol in project iso-a, then she switches to iso-b: her grants in iso-a end, her app there keeps running
    const a = await open('carol', 'iso-a');
    const ca = await enter(a.url);
    expect((await get(`${gw(a)}/api/state`, { cookie: ca })).status).toBe(200);
    const b = await open('carol', 'iso-b');
    expect(b.revokedElsewhere).toBe(1);
    expect((await get(`${gw(a)}/api/state`, { cookie: ca })).status).toBe(401);
    const cb = await enter(b.url);
    expect((await get(`${gw(b)}/api/state`, { cookie: cb })).status).toBe(200);
    // opening iso-a again gives her a fresh grant there
    const a2 = await open('carol', 'iso-a');
    expect(gw(a2)).toBe(gw(a));
    const ca2 = await enter(a2.url);
    expect((await get(`${gw(a)}/api/state`, { cookie: ca2 })).status).toBe(200);
    // (and that ended her iso-b grants in turn: one project at a time per app; she opens iso-b again to go on)
    expect((await get(`${gw(b)}/api/state`, { cookie: cb })).status).toBe(401);
    const bAgain = await open('carol', 'iso-b');
    const cbx = await enter(bAgain.url);
    expect((await get(`${gw(b)}/api/state`, { cookie: cbx })).status).toBe(200);

    // renew keeps a live grant; a renew for a project with no app answers 404
    expect(JSON.parse((await get(`${timmy}/api/apps/model-studio/renew?p=iso-b`, H('carol'), 'POST', '{}')).body)).toMatchObject({ ok: true, grants: 1 });
    expect((await get(`${timmy}/api/apps/model-studio/renew?p=nowhere`, H('carol'), 'POST', '{}')).status).toBe(404);

    // dave cannot stop carol's app (his stop names his own key); his revoke ends only his grants
    const d = await open('dave', 'iso-a');
    const cd = await enter(d.url);
    expect(JSON.parse((await get(`${timmy}/api/apps/model-studio/stop?p=iso-b`, H('dave'), 'POST', '{}')).body)).toEqual({ ok: true, stopped: false });
    expect((await get(`${gw(b)}/api/state`, { cookie: cbx })).status).toBe(200);
    expect(JSON.parse((await get(`${timmy}/api/apps/revoke`, H('dave'), 'POST', '{}')).body).revoked).toBe(1);
    expect((await get(`${gw(d)}/api/state`, { cookie: cd })).status).toBe(401);
    expect((await get(`${gw(b)}/api/state`, { cookie: cbx })).status).toBe(200);

    // an artifact's Range request reaches the app and its 206 comes back whole through the gateway
    const job = JSON.parse((await get(`${gw(b)}/api/jobs`, { cookie: cbx, 'content-type': 'application/json' }, 'POST', '{}')).body);
    const part = await get(`${gw(b)}/api/assets/${job.result.asset.id}/r1-model.glb`, { cookie: cbx, range: 'bytes=0-3' });
    expect(part.status).toBe(206);
    expect(part.body).toBe('FAKE');
    expect(part.headers['content-range']).toBe('bytes 0-3/14');

    // the worker's own port is never in what the companion answers
    const listed = (await get(`${timmy}/api/apps?p=iso-b`, H('carol'))).body;
    const hostedB = host.get(`model-studio:${'u-' + createHash('sha256').update('timmy-app:carol').digest('hex').slice(0, 16)}:${projectId(join(base, 'carol', 'projects', 'iso-b'))}`)!;
    expect(hostedB).toBeTruthy();
    expect(listed).not.toContain(String(hostedB.workerPort));
    expect(JSON.stringify(b)).not.toContain(String(hostedB.workerPort));

    // a restart of the host: every grant is new; an old cookie opens nothing
    await host.stopAll();
    await expect(get(`${gw(b)}/api/state`, { cookie: cbx })).rejects.toThrow();
    const b2 = await open('carol', 'iso-b');
    expect((await get(`${gw(b2)}/api/state`, { cookie: cbx })).status).toBe(401);
    expect((await get(`${gw(b2)}/api/state`, { cookie: await enter(b2.url) })).status).toBe(200);
  }, 120_000);
  it('the worker port (R13, the 15:31 order): every route refused to a client without Timmy’s worker secret — state, events, artifacts, cancel, upgrade; two users and two projects: each one’s cache, events, artifacts and cancellation reach only through that one’s grant; sign-out, project switch and revoked grants hold directly as through the gateway', async () => {
    const H = (user: string | null) => ({ authorization: 'Bearer FAKE', 'content-type': 'application/json', ...(user ? { 'x-fake-user': user } : {}) });
    const open = async (user: string | null, p: string) => JSON.parse((await get(`${timmy}/api/apps/model-studio/open?p=${p}`, H(user), 'POST', '{}')).body);
    const enter = async (url: string) => cookieOf(await get(url));
    const gw = (o: { url: string }) => `http://127.0.0.1:${new URL(o.url).port}`;
    const keyOf = (user: string, p: string) => `model-studio:${'u-' + createHash('sha256').update(`timmy-app:${user}`).digest('hex').slice(0, 16)}:${projectId(join(base, user, 'projects', p))}`;
    const upgrade = (port: number, headers: Record<string, string> = {}) => new Promise<string>((resolve) => {
      const sock = net.connect(port, '127.0.0.1', () => sock.write(`GET /ws HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n${Object.entries(headers).map(([k, v]) => `${k}: ${v}\r\n`).join('')}\r\n`));
      let b = ''; sock.on('data', (c) => { b += c.toString(); }); sock.on('close', () => resolve(b.split('\r\n')[0] ?? '')); sock.on('error', () => resolve(''));
      setTimeout(() => { sock.destroy(); resolve(b.split('\r\n')[0] ?? ''); }, 1500);
    });

    // erin in project w-1, frank in project w-2: separate workers, each makes a job through its own grant
    const e = await open('erin', 'w-1'); const ce = await enter(e.url);
    const f = await open('frank', 'w-2'); const cf = await enter(f.url);
    const he = host.get(keyOf('erin', 'w-1'))!; const hf = host.get(keyOf('frank', 'w-2'))!;
    expect(he.workerPort).not.toBe(hf.workerPort);
    const ej = JSON.parse((await get(`${gw(e)}/api/jobs`, { cookie: ce, 'content-type': 'application/json' }, 'POST', '{}')).body);
    const fj = JSON.parse((await get(`${gw(f)}/api/jobs`, { cookie: cf, 'content-type': 'application/json' }, 'POST', '{}')).body);
    const ePath = `/api/assets/${ej.result.asset.id}/r1-model.glb`;
    const fPath = `/api/assets/${fj.result.asset.id}/r1-model.glb`;

    // DIRECT to the worker port (any local program), with its own Host as the app expects: refused, every route
    for (const [port, path] of [[he.workerPort, '/api/state'], [he.workerPort, '/api/events'], [he.workerPort, ePath], [he.workerPort, '/'], [hf.workerPort, '/api/state'], [hf.workerPort, fPath]] as const) {
      const r = await get(`http://127.0.0.1:${port}${path}`);
      expect(r.status, `${port}${path}`).toBe(403);
      expect(r.body).toMatch(/only through Timmy/);
    }
    expect((await get(`http://127.0.0.1:${he.workerPort}/api/jobs/${ej.id}/cancel`, { 'content-type': 'application/json' }, 'POST', '{}')).status).toBe(403);
    expect((await get(`http://127.0.0.1:${he.workerPort}/api/jobs`, { 'content-type': 'application/json' }, 'POST', '{}')).status).toBe(403);
    // a cookie is no key to the worker, nor a guessed or another worker's secret
    expect((await get(`http://127.0.0.1:${he.workerPort}/api/state`, { cookie: ce })).status).toBe(403);
    expect((await get(`http://127.0.0.1:${he.workerPort}/api/state`, { 'x-timmy-worker': 'f'.repeat(64) })).status).toBe(403);
    expect(await upgrade(he.workerPort)).toMatch(/^HTTP\/1\.1 403/);
    // the direct cancel changed nothing: erin's job is still succeeded
    const eState = JSON.parse((await get(`${gw(e)}/api/state`, { cookie: ce })).body);
    expect(eState.jobs.find((j: { id: string }) => j.id === ej.id).status).toBe('succeeded');

    // THROUGH the gateway: each one's cache, events and artifacts with that one's grant only
    expect(eState.dataDir).toBe(he.dataDir);
    const fState = JSON.parse((await get(`${gw(f)}/api/state`, { cookie: cf })).body);
    expect(fState.dataDir).toBe(hf.dataDir);
    expect(he.dataDir).not.toBe(hf.dataDir);
    expect(fState.jobs.map((j: { id: string; result?: { asset?: { id: string } } }) => j.result?.asset?.id)).not.toContain(ej.result.asset.id);
    const ev = await get(`${gw(e)}/api/events`, { cookie: ce });
    expect(ev.status).toBe(200);
    expect(ev.body).toContain(JSON.stringify(he.dataDir).slice(1, -1));
    expect((await get(`${gw(e)}${ePath}`, { cookie: ce })).body).toBe('FAKE glb bytes');
    expect((await get(`${gw(f)}${ePath}`, { cookie: cf })).status).toBe(404); // erin's artifact is not in frank's worker
    expect((await get(`${gw(e)}${ePath}`, { cookie: cf })).status).toBe(401); // nor frank's grant at erin's gateway
    expect((await get(`${gw(e)}/api/events`, { cookie: cf })).status).toBe(401);
    expect((await get(`${gw(e)}/api/jobs/${ej.id}/cancel`, { cookie: cf, 'content-type': 'application/json' }, 'POST', '{}')).status).toBe(401);
    // the gateway never forwards a client's own worker header, and the app never sees the secret in its env or headers
    const env = JSON.parse((await get(`${gw(e)}/api/env`, { cookie: ce, 'x-timmy-worker': 'mine' })).body);
    expect(env.keys).not.toContain('TIMMY_WORKER_SECRET');
    expect(JSON.stringify(env)).not.toMatch(/x-timmy-worker/i);
    expect(await upgrade(Number(new URL(e.url).port), { cookie: ce })).toMatch(/^HTTP\/1\.1 501/);

    // erin cancels her own job through her grant
    const cancelled = JSON.parse((await get(`${gw(e)}/api/jobs/${ej.id}/cancel`, { cookie: ce, 'content-type': 'application/json' }, 'POST', '{}')).body);
    expect(cancelled.status).toBe('cancelled');

    // project switch: erin opens w-2; her w-1 grant ends; her w-1 worker still refuses direct clients
    const e2 = await open('erin', 'w-2'); const ce2 = await enter(e2.url);
    expect((await get(`${gw(e)}/api/state`, { cookie: ce })).status).toBe(401);
    expect((await get(`http://127.0.0.1:${he.workerPort}/api/state`)).status).toBe(403);
    const he2 = host.get(keyOf('erin', 'w-2'))!;
    expect(he2.workerPort).not.toBe(hf.workerPort); // her w-2 is not frank's w-2
    expect(JSON.parse((await get(`${gw(e2)}/api/state`, { cookie: ce2 })).body).jobs).toEqual([]);
    // sign-out (revoke): erin's grants end; frank's do not; neither worker answers directly
    expect(JSON.parse((await get(`${timmy}/api/apps/revoke`, H('erin'), 'POST', '{}')).body).revoked).toBeGreaterThan(0);
    expect((await get(`${gw(e2)}/api/state`, { cookie: ce2 })).status).toBe(401);
    expect((await get(`${gw(f)}/api/state`, { cookie: cf })).status).toBe(200);
    expect((await get(`http://127.0.0.1:${he2.workerPort}/api/state`)).status).toBe(403);
    // the receipt reader still reads through the guard (it holds the secret): erin's w-1 jobs are sealed, and the cancel too
    expect((await he.sealNow()).length + readChain('runs', join(base, 'erin', 'projects', 'w-1')).filter((r) => r.kind === 'miniapp').length).toBeGreaterThan(0);
    // a stopped worker: nothing answers on its port at all
    await host.stop(keyOf('erin', 'w-1'));
    await expect(get(`http://127.0.0.1:${he.workerPort}/api/state`)).rejects.toThrow();
  }, 120_000);
});
