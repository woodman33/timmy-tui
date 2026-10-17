/**
 * R4 (H109): Timmy Canvas follows the active project of its Timmy home (src/studio/active-follow.ts) unless a board is pinned,
 * over real HTTP on 127.0.0.1 against the real canvas server with a real temporary Timmy home: the REPL's handoff
 * (POST /api/project/active), a page's one-time grant traded for its session (tests/helpers/canvas-auth.ts, as the page trades
 * it), and <TIMMY_HOME>/state/active-project.json written as src/project/index.ts saveActiveProject writes it. FAKE: no REPL
 * takes card actions here (a holder id is named, nothing asks for actions).
 */
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { activeProjectFile, readActiveFile } from '../src/studio/active-follow.js';
import { PIN_WORDS } from '../src/studio/card-relay.js';
import { PIN_UNKNOWN } from '../src/studio/project-link.js';
import { startStudioServer, type StudioServer } from '../src/studio/server.js';
import { projectId } from '../src/project/index.js';
import { bearer, call, nameProject, pageSession } from './helpers/canvas-auth.js';

const H = 'a'.repeat(32);
const H2 = 'b'.repeat(32);
const made: string[] = [];
const servers: StudioServer[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise<void>((done) => s.close(() => done()));
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});
const temp = (prefix: string): string => { const d = mkdtempSync(join(tmpdir(), prefix)); made.push(d); return d; };
const until = async (what: () => Promise<boolean>, ms = 5000): Promise<void> => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await what()) return; await new Promise((r) => setTimeout(r, 50)); }
  throw new Error('waited too long');
};

/** The active project, written as saveActiveProject writes it (whole, then renamed into place). */
function choose(home: string, p: { name: string; root: string }): void {
  const file = activeProjectFile({ TIMMY_HOME: home });
  mkdirSync(join(home, 'state'), { recursive: true });
  writeFileSync(`${file}.tmp`, `${JSON.stringify({ name: p.name, root: p.root, at: new Date().toISOString() })}\n`, { mode: 0o600 });
  renameSync(`${file}.tmp`, file);
}

async function world(o: { follow?: boolean } = {}) {
  const home = temp('timmy-follow-home-');
  const server = await startStudioServer(0, { env: { TIMMY_HOME: home }, projectTokenFile: true, ...(o.follow === false ? { followActive: false } : {}), followEveryMs: 50, followGraceMs: 150 });
  servers.push(server);
  const port = (server.address() as AddressInfo).port;
  const project = (name: string) => { const root = join(temp(`timmy-follow-${name}-`), name); mkdirSync(root, { recursive: true }); return { name, root, id: projectId(root) }; };
  const active = async (token = server.projectToken) => (await call(port, 'GET', '/api/project/active', { headers: bearer(token) })).json;
  return { home, server, port, project, active, token: server.projectToken };
}

describe('the active project file', () => {
  it('is read as readActiveProject reads it: a folder that is one, its name (else the folder\'s), its id; nothing else', () => {
    const home = temp('timmy-follow-read-');
    const file = activeProjectFile({ TIMMY_HOME: home });
    expect(file).toBe(join(home, 'state', 'active-project.json'));
    expect(readActiveFile(file)).toBeNull();
    const root = join(temp('timmy-follow-p-'), 'tray25');
    mkdirSync(root);
    choose(home, { name: 'tray25', root });
    expect(readActiveFile(file)).toMatchObject({ name: 'tray25', root, id: projectId(root) });
    writeFileSync(file, JSON.stringify({ root }));
    expect(readActiveFile(file)!.name).toBe('tray25');
    writeFileSync(file, JSON.stringify({ name: 'gone', root: join(root, 'nope') }));
    expect(readActiveFile(file)).toBeNull();
    writeFileSync(file, 'not json');
    expect(readActiveFile(file)).toBeNull();
  });
});

describe('Timmy Canvas follows the active project, unless a board is pinned', () => {
  it('follows a change of the file made after it started (never what it said at start); a REPL that names the project first keeps it, holder and all', async () => {
    const w = await world();
    const a = w.project('alpha');
    const b = w.project('beta');
    const c = w.project('gamma');
    await nameProject(w.port, w.token, { root: a.root, name: 'alpha', holder: H });
    expect(await w.active()).toMatchObject({ project: { name: 'alpha', id: a.id }, via: 'repl', active: null });
    // the file changes: after the grace period the canvas shows beta, followed from the file, with no holder
    choose(w.home, b);
    await until(async () => (await w.active()).project?.name === 'beta');
    expect(await w.active()).toMatchObject({ project: { name: 'beta', id: b.id }, via: 'active', active: { name: 'beta', id: b.id } });
    // a REPL's own /project names its project at once (its handoff) and the file says the same: the REPL's naming stands
    choose(w.home, c);
    await nameProject(w.port, w.token, { root: c.root, name: 'gamma', holder: H });
    await new Promise((r) => setTimeout(r, 400));
    expect(await w.active()).toMatchObject({ project: { name: 'gamma' }, via: 'repl' });
    const read = await call(w.port, 'GET', '/api/project?detail=1', { headers: bearer(w.token) });
    expect(read.json).toMatchObject({ project: { name: 'gamma' }, via: 'repl', active: { name: 'gamma', id: c.id } });
    // never a folder in what is said
    expect(read.body).not.toContain(c.root);
    expect(JSON.stringify(await w.active())).not.toContain(c.root);
  });

  it('what the file says as the server starts is not followed; a server made without a Timmy home to serve follows nothing', async () => {
    const pre = temp('timmy-follow-pre-');
    const z = join(temp('timmy-follow-z-'), 'zeta');
    mkdirSync(z);
    choose(pre, { name: 'zeta', root: z });
    const server = await startStudioServer(0, { env: { TIMMY_HOME: pre }, projectTokenFile: true, followEveryMs: 50, followGraceMs: 50 });
    servers.push(server);
    const port = (server.address() as AddressInfo).port;
    await new Promise((r) => setTimeout(r, 300));
    expect((await call(port, 'GET', '/api/project/active', { headers: bearer(server.projectToken) })).json).toMatchObject({ project: null, named: false, active: { name: 'zeta' } });
    const quiet = await world({ follow: false });
    const q = quiet.project('quiet');
    await nameProject(quiet.port, quiet.token, { root: q.root, name: 'quiet', holder: H });
    choose(quiet.home, quiet.project('other'));
    await new Promise((r) => setTimeout(r, 400));
    expect(await quiet.active()).toMatchObject({ project: { name: 'quiet' }, via: 'repl' });
    expect((await quiet.active()).active).toBeUndefined();
  });

  it("a page's session follows its own REPL's next project and the followed active project; never another REPL's; a board pinned to a project it reached keeps reading it", async () => {
    const w = await world();
    const a = w.project('alpha');
    const b = w.project('beta');
    const e = w.project('epsilon');
    const f = w.project('phi');
    await nameProject(w.port, w.token, { root: a.root, name: 'alpha', holder: H });
    const s = await pageSession(w.port, w.token);
    const page = bearer(s);
    expect((await call(w.port, 'GET', '/api/project?detail=1', { headers: page })).json).toMatchObject({ project: { name: 'alpha' } });
    // the active project changes (the file): the page follows it
    choose(w.home, b);
    await until(async () => (await w.active()).project?.name === 'beta');
    const followed = await call(w.port, 'GET', '/api/project?detail=1', { headers: page });
    expect(followed.status).toBe(200);
    expect(followed.json).toMatchObject({ project: { name: 'beta' }, via: 'active', actions: { holder: false, words: expect.stringMatching(/^No Timmy REPL takes beta's card actions: the canvas followed it as the active project of this Timmy home/) } });
    expect(followed.json.notes).toEqual(expect.arrayContaining([expect.stringMatching(/^Timmy Canvas follows the active project of this Timmy home \(state\/active-project\.json\): beta\./)]));
    // a board pinned to alpha keeps reading alpha (read only), and is told what the canvas shows
    const pinned = await call(w.port, 'GET', `/api/project?detail=1&project=${a.id}`, { headers: page });
    expect(pinned.status).toBe(200);
    expect(pinned.json).toMatchObject({ project: { name: 'alpha', id: a.id }, pinned: true, shown: { name: 'beta', id: b.id }, board: null, actions: { holder: false } });
    expect(pinned.json.actions.words).toBe('This board is pinned to alpha, and the canvas shows beta now: alpha\'s cards are read here and act through no Timmy REPL. To act on them: /canvas open in Timmy, in alpha.');
    // its own REPL names another project (its /project): the page follows
    await nameProject(w.port, w.token, { root: e.root, name: 'epsilon', holder: H });
    expect((await call(w.port, 'GET', '/api/project?detail=1', { headers: page })).json).toMatchObject({ project: { name: 'epsilon' }, via: 'repl' });
    // another REPL names its project: refused, as before (the session was given by another REPL); R5 (H137): the session is
    // paused, so the panel's reading is answered with a plain 200 that says why, and nothing of phi (src/studio/session-pause.ts)
    await nameProject(w.port, w.token, { root: f.root, name: 'phi', holder: H2 });
    const other = await call(w.port, 'GET', '/api/project?detail=1', { headers: page });
    expect(other.status).toBe(200);
    expect(other.json).toEqual({ ok: false, session: 'project', error: expect.stringMatching(/given for another project/) });
    expect(other.body).not.toContain('phi');
    // ... while a board pinned to a project it reached still reads it, and is not told which project the canvas shows
    const still = await call(w.port, 'GET', `/api/project?detail=1&project=${e.id}`, { headers: page });
    expect(still.status).toBe(200);
    expect(still.json).toMatchObject({ project: { name: 'epsilon' }, pinned: true, shown: null });
    expect(still.body).not.toContain('phi');
    // a project the page never counted for: refused, with why; one this server never named: unknown. R5 (H137): a pinned board's
    // reading is the panel's own too: to a session this server keeps, a plain 200 that says why, and nothing of the project
    const s2 = await pageSession(w.port, w.token);
    const never = await call(w.port, 'GET', `/api/project?detail=1&project=${a.id}`, { headers: bearer(s2) });
    expect(never.status).toBe(200);
    expect(never.json).toEqual({ ok: false, session: 'project', error: PIN_WORDS, pinned: true });
    const unknown = await call(w.port, 'GET', `/api/project?detail=1&project=${'0'.repeat(16)}`, { headers: page });
    expect(unknown.status).toBe(200);
    expect(unknown.json).toMatchObject({ ok: false, session: 'project', pinned: true });
    // a session this server never made, refused as before (401)
    expect((await call(w.port, 'GET', `/api/project?detail=1&project=${a.id}`, { headers: bearer('f'.repeat(64)) })).status).toBe(401);
    const unknownByToken = await call(w.port, 'GET', `/api/project?detail=1&project=${'0'.repeat(16)}`, { headers: bearer(w.token) });
    expect(unknownByToken.status).toBe(404);
    expect(unknownByToken.json).toMatchObject({ ok: false, error: PIN_UNKNOWN });
    // without a credential, nothing; a malformed id, refused
    expect((await call(w.port, 'GET', `/api/project?detail=1&project=${a.id}`)).status).toBe(401);
    expect((await call(w.port, 'GET', '/api/project?detail=1&project=../x', { headers: page })).status).toBe(400);
  });

  it("the saved canvas a following page loads withholds no card of a project it reached, and every other project's still", async () => {
    const w = await world();
    const a = w.project('alpha');
    const b = w.project('beta');
    const z = w.project('zed');
    await nameProject(w.port, w.token, { root: a.root, name: 'alpha', holder: H });
    const card = (id: string, p: { id: string; name: string }) => ({
      id, typeName: 'shape', type: 'timmy-params', x: 0, y: 0, rotation: 0, index: 'a1', parentId: 'page:page', isLocked: false, opacity: 1, meta: {},
      props: { w: 360, h: 160, card: 'params:recipes/tray.params.json', kind: 'params', projectId: p.id, project: p.name, title: 't', command: '/recipe tray', data: { kept: `${p.name}-kept-detail` }, readAt: '2026-10-11T00:00:00.000Z', open: false, gone: false },
    });
    // R6 (H139): beta's own board, holding a card of alpha and one of zed (as a board of the old home-wide canvas could)
    const snapshot = { schema: { schemaVersion: 2, sequences: {} }, store: { 'shape:a': card('shape:a', a), 'shape:z': card('shape:z', z) } };
    const put = await call(w.port, 'PUT', '/api/canvas/document', { headers: { ...bearer(w.token), 'Content-Type': 'application/json' }, body: JSON.stringify({ snapshot, revision: 1, baseRevision: 0, project: b.id }) });
    expect(put.status).toBe(200);
    const s = await pageSession(w.port, w.token);
    // the page, given for alpha, loads alpha's own board (blank: nothing of beta's)
    const own = await call(w.port, 'GET', '/api/canvas/document', { headers: bearer(s) });
    expect(own.json).toMatchObject({ revision: 0, snapshot: null, project: { id: a.id, name: 'alpha' } });
    choose(w.home, b);
    await until(async () => (await w.active()).project?.name === 'beta');
    // followed to beta, it loads beta's board: the card of alpha (a project it reached) whole, zed's withheld
    const doc = await call(w.port, 'GET', '/api/canvas/document', { headers: bearer(s) });
    expect(doc.status).toBe(200);
    expect(doc.json.project).toEqual({ id: b.id, name: 'beta' });
    expect(doc.body).toContain('alpha-kept-detail');
    expect(doc.body).not.toContain('zed-kept-detail');
    expect(doc.json.withheld).toBe(1);
    // and a reading the page asked for alpha's board (asked before the switch) is told the canvas shows beta now
    const late = await call(w.port, 'GET', `/api/canvas/document?project=${a.id}`, { headers: bearer(s) });
    expect(late.status).toBe(409);
    expect(late.json).toMatchObject({ ok: false, notShown: true, shows: { id: b.id, name: 'beta' }, error: 'The canvas shows beta now, not the project this page asked for (alpha).' });
    expect(late.body).not.toContain('kept-detail');
  });
});
