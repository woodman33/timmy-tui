/**
 * Round R4 (H83): the canvas server's own routes need a credential. The owner's order (00:01 PT): "Require authorization on
 * /api/canvas/exec and /api/canvas/document, with tests for unauthorized callers and project/session boundaries."
 *
 * Real HTTP to a real canvas server on 127.0.0.1, sessions made by its own grant and session routes (tests/helpers/canvas-auth.ts),
 * real temporary project folders, and on the bridge a FAKE page: a `ws` WebSocket client that joins as the canvas page does (its
 * Origin, its session as a subprotocol) and answers each call it is sent (the real page runs in a real Chromium in
 * tests/studio-canvas-auth-browser.test.ts). A session's 12 hours pass on the relay's own clock (StudioOptions.relay), never by
 * waiting. Everything lives under os.tmpdir().
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { projectId } from '../src/project/index.js';
import { runSlash, type ReplContext } from '../src/repl/commands.js';
import { glyphSet } from '../src/term/glyphs.js';
import { keepOthers, withholdOthers } from '../src/studio/canvas-auth.js';
import { CanvasDocuments } from '../src/studio/document.js';
import { startStudioServer, type StudioServer } from '../src/studio/server.js';
import { bearer, call, exec, fakePage, grant, nameProject, pageProtocols, pageSession, session, type Reply } from './helpers/canvas-auth.js';

const temps: string[] = [];
const temp = (prefix: string): string => { const d = mkdtempSync(join(tmpdir(), prefix)); temps.push(d); return d; };
const sockets: WebSocket[] = [];
const servers: StudioServer[] = [];
afterEach(async () => {
  for (const s of sockets.splice(0)) s.terminate();
  for (const s of servers.splice(0)) await new Promise<void>((done) => s.close(() => done()));
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
});

const HX = 'a'.repeat(32);
const HY = 'b'.repeat(32);
const TWELVE_HOURS = 12 * 60 * 60 * 1000;

interface World { server: StudioServer; port: number; token: string; home: string; clock: { now: number }; project: (name: string) => { root: string; name: string; id: string } }
async function world(o: { execTimeoutMs?: number } = {}): Promise<World> {
  const home = temp('canvas-auth-home-');
  const clock = { now: Date.now() };
  const server = await startStudioServer(0, { env: { TIMMY_HOME: home, HOME: home }, relay: { now: () => clock.now }, ...(o.execTimeoutMs ? { execTimeoutMs: o.execTimeoutMs } : {}) });
  servers.push(server);
  const port = (server.address() as AddressInfo).port;
  const base = temp('canvas-auth-projects-');
  const project = (name: string) => { const root = join(base, name); mkdirSync(root, { recursive: true }); return { root, name, id: projectId(root) }; };
  return { server, port, token: server.projectToken, home, clock, project };
}
/** A page /canvas open opened for `holder`'s project: named, granted, traded, joined (FAKE page, answering every call). */
async function openPage(w: World, p: { root: string; name: string }, holder: string | null, answer?: (m: { id: number; code: string; jobId: string }) => unknown) {
  await nameProject(w.port, w.token, { root: p.root, name: p.name, holder });
  const s = await pageSession(w.port, w.token);
  const page = await fakePage(w.port, { session: s, answer: answer ?? ((m) => ({ ok: true, result: m.code, revision: 1 })) });
  sockets.push(page.ws);
  return { session: s, ...page };
}
const words = (r: Reply): string => String(r.json.error ?? r.body);

describe('POST /api/canvas/exec: the server token, from the REPL that holds the project', () => {
  it('refuses a caller without the token, with a wrong one, with the token in the address or the body, from a page, or with a session; the page is sent nothing', async () => {
    const w = await world();
    const page = await openPage(w, w.project('alpha'), HX);
    const code = { code: 'return 1', jobId: 'x1', holder: HX };
    const cases: Array<[string, Promise<Reply>, number, RegExp]> = [
      ['no token', exec(w.port, null, code), 401, /^Refused: code runs on Timmy Canvas only for Timmy's REPL, with the token .*In Timmy: \/canvas open/],
      ['a wrong token', exec(w.port, 'f'.repeat(64), code), 401, /^Refused: code runs on Timmy Canvas only for Timmy's REPL/],
      ['a malformed token', exec(w.port, w.token.slice(1), code), 401, /^Refused: code runs/],
      ['the token in the address', exec(w.port, null, code, {}, `/api/canvas/exec?token=${w.token}`), 401, /^Refused: the token goes in an Authorization header, never in an address/],
      ['the token in the address and the header', exec(w.port, w.token, code, {}, `/api/canvas/exec?token=${w.token}`), 401, /never in an address/],
      ['the token in the body', exec(w.port, null, { ...code, token: w.token }), 401, /^Refused: code runs/],
      ['the token in the body, and the header', exec(w.port, w.token, { ...code, token: w.token }), 400, /^Unknown field: "token"\. The fields are code, jobId and holder\./],
      ['a page (Origin) with the token', exec(w.port, w.token, code, { Origin: `http://127.0.0.1:${w.port}` }), 403, /^Refused: this route is for Timmy's REPL, never a page\./],
      ['the page\'s session as the token', exec(w.port, page.session, code), 401, /^Refused: code runs/],
      ['another site', exec(w.port, w.token, code, { Origin: 'http://evil.example' }), 403, /answers 127\.0\.0\.1 and localhost only|never a page/],
      ['a rebound name', exec(w.port, w.token, code, { Host: `evil.example:${w.port}` }), 403, /answers 127\.0\.0\.1 and localhost only/],
    ];
    for (const [what, pending, status, said] of cases) {
      const r = await pending;
      expect(r.status, what).toBe(status);
      expect(words(r), what).toMatch(said);
      expect(r.body, what).not.toContain(w.token);
      expect(r.body, what).not.toContain(page.session);
    }
    expect(page.seen).toEqual([]);
    // The REPL holding the project, with the token in its header and its holder id: run, and answered.
    const ok = await exec(w.port, w.token, code);
    expect(ok.status).toBe(200);
    expect(ok.json).toMatchObject({ ok: true, result: 'return 1', jobId: 'x1' });
    expect(page.seen.map((m) => m.code)).toEqual(['return 1']);
  });

  it('while a project is named, only the REPL that holds it runs code there; another REPL is refused (409) with what to type', async () => {
    const w = await world();
    const alpha = w.project('alpha');
    const page = await openPage(w, alpha, HX);
    const fromY = await exec(w.port, w.token, { code: 'return "from Y"', holder: HY });
    expect(fromY.status).toBe(409);
    expect(words(fromY)).toBe('Refused: the canvas is held by another Timmy REPL now (it shows alpha for it), and only the REPL that holds the canvas runs code there. In this REPL: /canvas open names this REPL\'s project to the canvas and opens it; then ask again.');
    // a caller with the token but no holder id (not the REPL holding the project) likewise
    expect((await exec(w.port, w.token, { code: 'return "no holder"' })).status).toBe(409);
    expect((await exec(w.port, w.token, { code: 'x', holder: 'not hex' })).status).toBe(400);
    expect(page.seen).toEqual([]);
    expect((await exec(w.port, w.token, { code: 'return "from X"', holder: HX })).json).toMatchObject({ ok: true, result: 'return "from X"' });
  });

  it("after REPL Y names its project, the page REPL X opened is sent no code (and loads no canvas) until /canvas open from Y; then Y's page is", async () => {
    const w = await world();
    const pageX = await openPage(w, w.project('alpha'), HX);
    expect((await exec(w.port, w.token, { code: 'return "X before"', holder: HX })).status).toBe(200);
    // Y names its project (as its REPL does on a /project switch while it follows the canvas, or on /canvas open).
    await nameProject(w.port, w.token, { root: w.project('beta').root, name: 'beta', holder: HY });
    const y = await exec(w.port, w.token, { code: 'return "Y, no page yet"', holder: HY });
    expect(y.status).toBe(409);
    expect(words(y)).toBe('Refused: the canvas page open now was opened for another project than the one the canvas shows now, so it runs no code for it. In Timmy: /canvas open, from the REPL that holds the project.');
    expect((await exec(w.port, w.token, { code: 'return "X after"', holder: HX })).status).toBe(409);
    // X's page neither loads nor saves the canvas now
    const doc = await call(w.port, 'GET', '/api/canvas/document', { headers: bearer(pageX.session) });
    expect(doc.status).toBe(401);
    expect(doc.json).toMatchObject({ ok: false, session: 'project', error: expect.stringMatching(/given for another project.*\/canvas open/) });
    expect(pageX.seen.map((m) => m.code)).toEqual(['return "X before"']);
    // the canvas says no page is open (a page that cannot act for the project named is not counted)
    expect((await call(w.port, 'GET', '/api/canvas/health')).json.pageConnected).toBe(false);
    // /canvas open from Y: a grant for beta and Y, a new page; Y's code goes to it, never to X's
    const sY = await pageSession(w.port, w.token);
    const pageY = await fakePage(w.port, { session: sY, answer: (m) => ({ ok: true, result: m.code, revision: 2 }) });
    sockets.push(pageY.ws);
    expect((await exec(w.port, w.token, { code: 'return "Y with a page"', holder: HY })).json).toMatchObject({ ok: true, result: 'return "Y with a page"' });
    expect(pageY.seen.map((m) => m.code)).toEqual(['return "Y with a page"']);
    expect(pageX.seen.map((m) => m.code)).toEqual(['return "X before"']);
    expect((await call(w.port, 'GET', '/api/canvas/document', { headers: bearer(sY) })).status).toBe(200);
  });
});

describe('the bridge: a page joins only with a session that counts now', () => {
  it('a client that forges the Origin without a session (or with a made-up one, the token, or two) is refused before any code, and is sent none', async () => {
    const w = await world();
    const page = await openPage(w, w.project('alpha'), HX);
    const tries: Array<[string, Parameters<typeof fakePage>[1], number]> = [
      ['no session', { protocols: [] }, 401],
      ['only timmy-canvas', { protocols: ['timmy-canvas'] }, 401],
      ['a session this server never made', { session: 'c'.repeat(64) }, 401],
      ['the server token as a session', { session: w.token }, 401],
      ['two sessions', { protocols: ['timmy-canvas', `timmy-session.${page.session}`, `timmy-session.${'d'.repeat(64)}`] }, 400],
      ['a session without timmy-canvas', { protocols: [`timmy-session.${page.session}`] }, 400],
    ];
    for (const [what, o, status] of tries) {
      const refused = await fakePage(w.port, { ...o, answer: () => ({ ok: true, result: 'forged' }) }).then((p) => { sockets.push(p.ws); return null; }, (e: Error & { status?: number; body?: string }) => e);
      expect(refused, what).not.toBeNull();
      expect(refused!.status, what).toBe(status);
      if (status === 401) expect(refused!.body, what).toMatch(/\/canvas open/);
    }
    // the session in the address is not how a page joins: refused like none
    const inUrl = await new Promise<number>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${w.port}/bridge?session=${page.session}`, { origin: `http://127.0.0.1:${w.port}` });
      ws.once('unexpected-response', (_q, r) => { resolve(r.statusCode ?? 0); ws.terminate(); });
      ws.once('open', () => { resolve(101); ws.terminate(); });
      ws.once('error', () => resolve(-1));
    });
    expect(inUrl).toBe(401);
    // The real page still gets the call, and its answer is the one taken.
    const r = await exec(w.port, w.token, { code: 'return "real"', holder: HX });
    expect(r.json).toMatchObject({ ok: true, result: 'return "real"' });
    expect(page.seen).toHaveLength(1);
  });

  it("an answer is taken only from the page the call was sent to: another page's forged answer for the same call is not", async () => {
    const w = await world({ execTimeoutMs: 2000 });
    const alpha = w.project('alpha');
    // an older page of the same session holder (it counts too), which answers every call it hears of with a forgery
    await nameProject(w.port, w.token, { root: alpha.root, name: 'alpha', holder: HX });
    const older = await fakePage(w.port, { session: await pageSession(w.port, w.token) });
    sockets.push(older.ws);
    // the newest page (the one sent the call) answers late; meanwhile the older page sends an answer for the call's id
    let sent: { id: number } | null = null;
    const newest = await fakePage(w.port, { session: await pageSession(w.port, w.token), answer: (m) => { sent = m; return undefined; } });
    sockets.push(newest.ws);
    const pending = exec(w.port, w.token, { code: 'return "real"', holder: HX });
    for (let i = 0; i < 50 && !sent; i++) await new Promise((r) => setTimeout(r, 20));
    expect(sent).not.toBeNull();
    older.ws.send(JSON.stringify({ id: sent!.id, ok: true, result: 'forged', revision: 99 }));
    await new Promise((r) => setTimeout(r, 200));
    newest.ws.send(JSON.stringify({ id: sent!.id, ok: true, result: 'real', revision: 3 }));
    const r = await pending;
    expect(r.json).toMatchObject({ ok: true, result: 'real', revision: 3 });
    expect(older.seen).toEqual([]);
  });

  it('a session past its 12 hours is refused everywhere: the bridge sends no code and closes the page, and nothing loads, saves or reads', async () => {
    const w = await world();
    const alpha = w.project('alpha');
    const page = await openPage(w, alpha, HX);
    const closed = new Promise<number>((resolve) => page.ws.once('close', (code) => resolve(code)));
    expect((await exec(w.port, w.token, { code: 'return "in time"', holder: HX })).status).toBe(200);
    w.clock.now += TWELVE_HOURS;
    const late = await exec(w.port, w.token, { code: 'return "too late"', holder: HX });
    expect(late.status).toBe(409);
    expect(words(late)).toBe('Refused: the canvas page\'s session has ended (a session lasts 12 hours), so it runs no code. In Timmy: /canvas open gives the page a new one.');
    expect(await closed).toBe(4401);
    expect(page.seen.map((m) => m.code)).toEqual(['return "in time"']);
    const s = bearer(page.session);
    const json = { 'Content-Type': 'application/json' };
    for (const [what, r] of [
      ['document', await call(w.port, 'GET', '/api/canvas/document', { headers: s })],
      ['save', await call(w.port, 'PUT', '/api/canvas/document', { headers: { ...s, ...json, Origin: `http://127.0.0.1:${w.port}` }, body: JSON.stringify({ snapshot: { store: {}, schema: {} }, revision: 1, baseRevision: 0 }) })],
      ['jobs', await call(w.port, 'GET', '/api/canvas/jobs', { headers: s })],
      ['cards', await call(w.port, 'GET', '/api/project', { headers: s })],
      ['detail', await call(w.port, 'GET', '/api/project?detail=1', { headers: s })],
      ['image', await call(w.port, 'GET', '/api/project/image?p=x.png', { headers: s })],
      ['act', await call(w.port, 'POST', '/api/project/act', { headers: { ...s, ...json, Origin: `http://127.0.0.1:${w.port}` }, body: JSON.stringify({ project: alpha.id, card: 'workflow:RUN.md', act: { action: 'run', doc: 'RUN.md', block: 'b' } }) })],
    ] as Array<[string, Reply]>) {
      expect(r.status, what).toBe(401);
      expect(r.body, what).toMatch(/\/canvas open/);
    }
    const rejoin = await fakePage(w.port, { session: page.session }).then(() => null, (e: Error & { status?: number }) => e);
    expect(rejoin?.status).toBe(401);
    // a new /canvas open gives a new page a new session, which counts
    expect((await call(w.port, 'GET', '/api/canvas/document', { headers: bearer(await pageSession(w.port, w.token)) })).status).toBe(200);
  });
});

/** A drawn card as the canvas page saves it (companion/studio-canvas/src/cards.js): a tldraw shape with the card's kept detail. */
const drawn = (id: string, type: string, p: { id: string; name: string }, card: string, data: unknown, x = 0) => ({
  id, typeName: 'shape', type, x, y: 0, rotation: 0, index: 'a1', parentId: 'page:page', isLocked: false, opacity: 1, meta: {},
  props: { w: 380, h: 160, card, kind: card.split(':')[0], projectId: p.id, project: p.name, title: `${card} title`, command: `/run ${card}`, data, readAt: '2026-10-11T01:00:00.000Z', open: false, gone: false },
});
const A_DETAIL = { type: 'workflow', doc: 'A.md', blocks: [{ name: 'build', command: ['echo secret-of-alpha'] }] };
const B_DETAIL = { type: 'params', file: 'b.params.json', values: [{ name: 'width', value: 42 }], secret: 'beta-values-42' };

describe('GET and PUT /api/canvas/document: the token, or a session that counts now', () => {
  async function seeded(w: World) {
    const a = w.project('alpha');
    const b = w.project('beta');
    const snapshot = {
      store: {
        'page:page': { id: 'page:page', typeName: 'page', name: 'Page 1', index: 'a1', meta: {} },
        'shape:a1': drawn('shape:a1', 'timmy-workflow', a, 'workflow:A.md', A_DETAIL),
        'shape:b1': drawn('shape:b1', 'timmy-params', b, 'params:b.params.json', B_DETAIL, 400),
        'shape:b2': drawn('shape:b2', 'timmy-result', b, 'flow:fbeta', { type: 'result', facts: ['beta-fact'] }, 800),
        'shape:n1': { id: 'shape:n1', typeName: 'shape', type: 'note', x: 0, y: 300, props: { text: 'a note anyone drew' }, meta: {} },
      },
      schema: { schemaVersion: 2, sequences: {} },
    };
    const saved = await call(w.port, 'PUT', '/api/canvas/document', { headers: { ...bearer(w.token), 'Content-Type': 'application/json' }, body: JSON.stringify({ snapshot, revision: 1, baseRevision: 0 }) });
    expect(saved.status).toBe(200);
    return { a, b, snapshot };
  }

  it('refuses no credential, a wrong one, a session the server never made and an expired one, saying what to do; nothing is read or written', async () => {
    const w = await world();
    const { a } = await seeded(w);
    await nameProject(w.port, w.token, { root: a.root, name: 'alpha', holder: HX });
    const expiring = await pageSession(w.port, w.token);
    w.clock.now += TWELVE_HOURS;
    const file = join(w.home, 'canvas', 'canvas.json');
    const before = readFileSync(file, 'utf8');
    const put = (h: Record<string, string>) => call(w.port, 'PUT', '/api/canvas/document', { headers: { ...h, 'Content-Type': 'application/json' }, body: JSON.stringify({ snapshot: { store: {}, schema: {} }, revision: 2, baseRevision: 1 }) });
    // one after another: an expired session is let go when it is first refused
    const cases: Array<[string, () => Promise<Reply>, string]> = [
      ['GET, no credential', () => call(w.port, 'GET', '/api/canvas/document'), 'none'],
      ['GET, a wrong one', () => call(w.port, 'GET', '/api/canvas/document', { headers: bearer('f'.repeat(64)) }), 'unknown'],
      ['GET, malformed', () => call(w.port, 'GET', '/api/canvas/document', { headers: { Authorization: 'Bearer nope' } }), 'none'],
      ['GET, an expired session', () => call(w.port, 'GET', '/api/canvas/document', { headers: bearer(expiring) }), 'expired'],
      ['PUT, no credential', () => put({}), 'none'],
      ['PUT, a wrong one', () => put(bearer('e'.repeat(64))), 'unknown'],
      ['PUT, the expired session (let go since)', () => put(bearer(expiring)), 'unknown'],
    ];
    for (const [what, send, why] of cases) {
      const r = await send();
      expect(r.status, what).toBe(401);
      expect(r.json, what).toMatchObject({ ok: false, session: why });
      expect(words(r), what).toMatch(/\/canvas open/);
      expect(r.body, what).not.toContain('secret-of-alpha');
      expect(r.body, what).not.toContain('beta-values-42');
    }
    expect((await call(w.port, 'GET', '/api/canvas/document')).json.error).toBe('Refused: the canvas is loaded and saved only by a canvas page Timmy opened (it has a session) or by Timmy\'s REPL (with its token). A page opened by its address, a bookmark or a reload has no session. In Timmy: /canvas open.');
    expect(readFileSync(file, 'utf8')).toBe(before);
  });

  it("a session for project A gets B's cards with their kept detail withheld (saying so, with B's commands), cannot change or erase B's kept detail by PUT, while the token reads it whole", async () => {
    const w = await world();
    const { a, b, snapshot } = await seeded(w);
    await nameProject(w.port, w.token, { root: a.root, name: 'alpha', holder: HX });
    const sA = await pageSession(w.port, w.token);
    const got = await call(w.port, 'GET', '/api/canvas/document', { headers: bearer(sA) });
    expect(got.status).toBe(200);
    expect(got.body).toContain('secret-of-alpha');
    expect(got.body).not.toContain('beta-values-42');
    expect(got.body).not.toContain('beta-fact');
    expect(got.json.withheld).toBe(2);
    const shown = got.json.snapshot as typeof snapshot;
    expect(shown.store['shape:a1'].props.data).toEqual(A_DETAIL);
    expect(shown.store['shape:b1'].props.data).toEqual({
      type: 'withheld', project: 'beta',
      words: 'Withheld: this card\'s kept detail (its commands and values) belongs to beta, and this page\'s session is for another project. To read it, open Timmy in beta\'s folder and type /canvas open there; in a Timmy REPL open elsewhere, /project followed by the path of beta\'s folder opens it first.',
      commands: ['/canvas open', "/project <the path of beta's folder>"],
    });
    expect(shown.store['shape:b1'].props.readAt).toBe('');
    expect(shown.store['shape:b1'].props.title).toBe('params:b.params.json title');
    expect(shown.store['shape:n1']).toEqual(snapshot.store['shape:n1']);
    // The page saves what it was given, with its own edits: B's card moved, B's other card relabelled as A's and its detail
    // emptied, A's card changed, a new card that claims B's project with detail of its own, and B's result card deleted.
    const edited = JSON.parse(JSON.stringify(shown)) as typeof snapshot & { store: Record<string, ReturnType<typeof drawn>> };
    edited.store['shape:b1'].x = 1234;
    edited.store['shape:b1'].props.open = true;
    edited.store['shape:b1'].props.data = null as never;
    edited.store['shape:b2'] = { ...edited.store['shape:b2'], props: { ...edited.store['shape:b2'].props, projectId: a.id, project: 'alpha', data: { type: 'result', facts: ['rewritten'] } } };
    edited.store['shape:a1'].props.data = { ...A_DETAIL, doc: 'A2.md' } as never;
    edited.store['shape:x9'] = drawn('shape:x9', 'timmy-params', b, 'params:forged.json', { type: 'params', secret: 'forged-by-page' });
    // (the relabelled copy is kept for a later save; this save deletes B's result card)
    const relabelled = edited.store['shape:b2'];
    delete (edited.store as Record<string, unknown>)['shape:b2'];
    const put = await call(w.port, 'PUT', '/api/canvas/document', { headers: { ...bearer(sA), 'Content-Type': 'application/json', Origin: `http://127.0.0.1:${w.port}` }, body: JSON.stringify({ snapshot: edited, revision: 2, baseRevision: 1 }) });
    expect(put.status).toBe(200);
    // What is on disk: B's card keeps its kept detail and identity, the page's move and its open Details stand
    const disk = new CanvasDocuments(join(w.home, 'canvas')).storedSnapshot() as typeof snapshot & { store: Record<string, ReturnType<typeof drawn>> };
    expect(disk.store['shape:b1'].props.data).toEqual(B_DETAIL);
    expect(disk.store['shape:b1'].props.readAt).toBe('2026-10-11T01:00:00.000Z');
    expect(disk.store['shape:b1'].props.projectId).toBe(b.id);
    expect(disk.store['shape:b1'].x).toBe(1234);
    expect(disk.store['shape:b1'].props.open).toBe(true);
    // A's card as the page changed it; the forged card of B saved with no kept detail; the deleted card stays deleted
    expect((disk.store['shape:a1'].props.data as { doc: string }).doc).toBe('A2.md');
    expect(disk.store['shape:x9'].props.data).toBeNull();
    expect(JSON.stringify(disk)).not.toContain('forged-by-page');
    expect(disk.store['shape:b2']).toBeUndefined();
    // A relabel (B's card claimed for A) on a later save: the saved copy's identity and kept detail win. And B's result card,
    // brought back as the page was given it (withheld): the save no longer holds it, so it comes back with no kept detail (a
    // page of B fills it again from B's records); a card A's page relabels as its own is A's (A's page may write A's cards).
    const again = JSON.parse(JSON.stringify((await call(w.port, 'GET', '/api/canvas/document', { headers: bearer(sA) })).json.snapshot)) as typeof edited;
    again.store['shape:b1'] = { ...again.store['shape:b1'], props: { ...again.store['shape:b1'].props, projectId: a.id, project: 'alpha', data: { type: 'params', secret: 'relabelled' } as never } };
    again.store['shape:b2'] = shown.store['shape:b2'] as never;
    again.store['shape:b3'] = { ...relabelled, id: 'shape:b3' };
    expect((await call(w.port, 'PUT', '/api/canvas/document', { headers: { ...bearer(sA), 'Content-Type': 'application/json' }, body: JSON.stringify({ snapshot: again, revision: 3, baseRevision: 2 }) })).status).toBe(200);
    // B's REPL reads it whole with the token
    const whole = await call(w.port, 'GET', '/api/canvas/document', { headers: bearer(w.token) });
    expect(whole.status).toBe(200);
    expect(whole.json.withheld).toBeUndefined();
    const wholeStore = (whole.json.snapshot as typeof snapshot & { store: Record<string, ReturnType<typeof drawn>> }).store;
    expect(wholeStore['shape:b1'].props).toMatchObject({ projectId: b.id, project: 'beta', data: B_DETAIL });
    expect(whole.body).not.toContain('relabelled');
    expect(wholeStore['shape:b2'].props).toMatchObject({ projectId: b.id, data: null, readAt: '' });
    expect(wholeStore['shape:b3'].props).toMatchObject({ projectId: a.id, data: { type: 'result', facts: ['rewritten'] } });
    expect(whole.body).toContain('secret-of-alpha');
  });

  it("the token's save is the document as sent; a stale save is still refused (409), never merged", async () => {
    const w = await world();
    const { a } = await seeded(w);
    await nameProject(w.port, w.token, { root: a.root, name: 'alpha', holder: HX });
    const sA = await pageSession(w.port, w.token);
    const shown = (await call(w.port, 'GET', '/api/canvas/document', { headers: bearer(sA) })).json.snapshot;
    const stale = await call(w.port, 'PUT', '/api/canvas/document', { headers: { ...bearer(sA), 'Content-Type': 'application/json' }, body: JSON.stringify({ snapshot: shown, revision: 1, baseRevision: 0 }) });
    expect(stale.status).toBe(409);
    expect(stale.json).toMatchObject({ ok: false, conflict: true, revision: 1 });
  });
});

describe('the other routes: content only with a credential', () => {
  it('the jobs list, the receipt link, the cards, the highlight, the named project and the license key each need theirs; the page, the look, the templates and health stay open', async () => {
    const w = await world();
    const a = w.project('alpha');
    new CanvasDocuments(join(w.home, 'canvas')).recordJob('model-named-job', { ok: true, revision: 1, sourceRevision: 'ab'.repeat(32) });
    await nameProject(w.port, w.token, { root: a.root, name: 'alpha', holder: HX });
    const sA = await pageSession(w.port, w.token);
    // the jobs list: the token or a session
    const jobs = await call(w.port, 'GET', '/api/canvas/jobs');
    expect(jobs.status).toBe(401);
    expect(jobs.json.error).toBe('Refused: the canvas jobs are read with Timmy\'s token or a canvas page\'s session. In Timmy: /canvas open.');
    expect(jobs.body).not.toContain('model-named-job');
    for (const t of [w.token, sA]) expect((await call(w.port, 'GET', '/api/canvas/jobs', { headers: bearer(t) })).body).toContain('model-named-job');
    // the receipt link: a write, the token only (no Origin, no address)
    const link = (h: Record<string, string>, path = '/api/canvas/jobs/model-named-job/receipt') => call(w.port, 'POST', path, { headers: { 'Content-Type': 'application/json', ...h }, body: JSON.stringify({ receipt: '0f3c9a12' }) });
    expect((await link({})).status).toBe(401);
    expect((await link({})).json.error).toMatch(/^Refused: a receipt is linked to a canvas job only by Timmy's REPL/);
    expect((await link(bearer(sA))).status).toBe(401);
    expect((await link({ ...bearer(w.token), Origin: `http://127.0.0.1:${w.port}` })).status).toBe(403);
    expect((await link(bearer(w.token), `/api/canvas/jobs/model-named-job/receipt?t=${w.token}`)).status).toBe(401);
    expect((await call(w.port, 'GET', '/api/canvas/jobs', { headers: bearer(w.token) })).body).not.toContain('0f3c9a12');
    expect((await link(bearer(w.token))).json).toEqual({ ok: true, job: 'model-named-job', receipt: '0f3c9a12' });
    // the cards and a highlight: the token or a session
    expect((await call(w.port, 'GET', '/api/project')).status).toBe(401);
    expect((await call(w.port, 'GET', '/api/project')).json.error).toBe('Refused: the project\'s cards are read with Timmy\'s token or a canvas page\'s session. In Timmy: /canvas open.');
    expect((await call(w.port, 'GET', '/api/project', { headers: bearer(sA) })).status).toBe(200);
    expect((await call(w.port, 'GET', '/api/project/image?p=results/vox/x.png')).status).toBe(401);
    expect((await call(w.port, 'GET', '/api/project/image?p=results/vox/x.png', { headers: bearer(sA) })).status).toBe(404);
    // which project is named: told with a credential; without, only that one is
    const open = await call(w.port, 'GET', '/api/project/active');
    expect(open.json).toMatchObject({ ok: true, app: 'timmy-canvas', project: null, named: true, hidden: true });
    expect(open.body).not.toContain('alpha');
    expect((await call(w.port, 'GET', '/api/project/active', { headers: bearer(w.token) })).json.project).toEqual({ name: 'alpha', id: a.id });
    expect((await call(w.port, 'GET', '/api/project/active', { headers: bearer(sA) })).json.project).toEqual({ name: 'alpha', id: a.id });
    // health: open, with no job's id unless the token is sent
    const health = await call(w.port, 'GET', '/api/canvas/health');
    expect(health.json).toMatchObject({ ok: true, app: 'timmy-canvas', jobs: 1, latestJob: null });
    expect(health.body).not.toContain('model-named-job');
    expect((await call(w.port, 'GET', '/api/canvas/health', { headers: bearer(w.token) })).json.latestJob).toMatchObject({ id: 'model-named-job', receipt: '0f3c9a12' });
    // open, as nothing of a project is in them: the look, the templates
    expect((await call(w.port, 'GET', '/timmy-theme.css')).status).toBe(200);
    expect((await call(w.port, 'GET', '/api/canvas/templates')).status).toBe(200);
  });

  it("studio-config.json holds no secret for anyone without a credential: the license key only with the token or a session", async () => {
    const home = temp('canvas-auth-license-');
    const server = await startStudioServer(0, { env: { TIMMY_HOME: home, HOME: home, TLDRAW_LICENSE_KEY: 'tldraw-synthetic/AAAA.BBBB' } });
    servers.push(server);
    const port = (server.address() as AddressInfo).port;
    const open = await call(port, 'GET', '/studio-config.json');
    expect(open.json).toEqual({ licenseKey: null, tldrawVersion: expect.any(String), canvasDir: join(home, 'canvas') });
    expect(open.body).not.toContain('tldraw-synthetic');
    expect((await call(port, 'GET', '/studio-config.json', { headers: bearer(server.projectToken) })).json.licenseKey).toBe('tldraw-synthetic/AAAA.BBBB');
    const p = join(temp('canvas-auth-license-p-'), 'p');
    mkdirSync(p);
    await nameProject(port, server.projectToken, { root: p, name: 'p', holder: HX });
    expect((await call(port, 'GET', '/studio-config.json', { headers: bearer(await session(port, await grant(port, server.projectToken))) })).json.licenseKey).toBe('tldraw-synthetic/AAAA.BBBB');
  });

  it('pageProtocols is what the page sends (the helper and the page agree)', () => {
    const cards = readFileSync('companion/studio-canvas/src/cards.js', 'utf8');
    expect(cards).toContain("export const CANVAS_PROTOCOL = 'timmy-canvas';");
    expect(cards).toContain('const second = `timmy-session.${session}`;');
    expect(pageProtocols('x')).toEqual(['timmy-canvas', 'timmy-session.x']);
  });
});

describe('every way Timmy opens the canvas page gives it a grant', () => {
  it('/web studio (and /browser studio) is /canvas open: the page opens with a one-time grant; other /web pages are as they were', async () => {
    const asked: string[] = [];
    const opened: string[] = [];
    const printed: string[] = [];
    const ctx: ReplContext = {
      agent: { getModel: () => 'm', setModel: () => {}, startSession: () => 's' },
      print: (segments) => printed.push(segments.map((x) => x.text).join('')),
      glyphs: glyphSet(false),
      openWeb: (target) => { opened.push(target); return `Open ${target}.`; },
      canvas: async (args) => { asked.push(args); return [[{ text: '  Opened with a grant (test).' }]]; },
    };
    for (const line of ['/web studio', '/browser studio', '/web map']) await runSlash(line, ctx);
    expect(asked).toEqual(['open', 'open']);
    expect(opened).toEqual(['map']);
    expect(printed).toEqual(['  Opened with a grant (test).', '  Opened with a grant (test).', '  Open map.']);
  });
});

describe('the withholding rules themselves', () => {
  it('a record a page names __proto__ stays a record of its own, through a reading and a save (no store gets a prototype from it)', () => {
    const page = JSON.parse('{"store":{"__proto__":{"id":"__proto__","typeName":"shape","type":"geo","props":{"w":1}},"shape:b":{"id":"shape:b","typeName":"shape","type":"timmy-params","props":{"projectId":"bbbbbbbbbbbbbbbb","project":"beta","data":{"secret":"b"}}}},"schema":{}}') as { store: Record<string, unknown> };
    const shown = withholdOthers(page, 'aaaaaaaaaaaaaaaa');
    const text = JSON.stringify(shown.snapshot);
    const own = (o: unknown, k: string): { type?: string } | undefined => Object.getOwnPropertyDescriptor(o, k)?.value as { type?: string } | undefined;
    expect(own(JSON.parse(text).store, '__proto__')?.type).toBe('geo');
    expect(text).not.toContain('"secret"');
    const kept = keepOthers(JSON.parse(text), page, 'aaaaaaaaaaaaaaaa');
    const saved = JSON.parse(JSON.stringify(kept.snapshot)) as { store: Record<string, { props: Record<string, unknown> }> };
    expect(Object.keys(saved.store).sort()).toEqual(['__proto__', 'shape:b']);
    expect(saved.store['shape:b'].props.data).toEqual({ secret: 'b' });
    expect(kept.kept).toBe(1);
  });
});
