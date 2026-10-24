/**
 * R5 (H132): the browser companion serves the workspace frame (src/contracts/workspace.ts) of the project a page shows, and
 * changes the two start-up settings the terminal Workbench keeps, over real HTTP on 127.0.0.1 (src/companion/workspace.ts).
 *
 * Real pieces: the companion server, the frame's producer (src/ops/workspace-frame.ts) and the Workbench's settings file
 * (src/workbench/settings.ts), all in folders of this test's own (TIMMY_HOME, TIMMY_SETTINGS_DIR, the project's folder), so
 * nothing of this computer's is read or written. FAKE pieces, labelled: a settings saver that fails, and a frame producer that
 * throws. No network but 127.0.0.1.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { TABS, type WorkspaceFrame } from '../src/contracts/workspace.js';
import { buildWorkspaceFrame, readConnections } from '../src/ops/workspace-frame.js';
import { takeTurnHold } from '../src/agent/chat-turn.js';
import { COMPANION_BAD_REQUEST, COMPANION_REFUSED, PROJECT_UNKNOWN, startCompanionServer, type CompanionOptions, type CompanionServer } from '../src/companion/server.js';
import { PREFS_BAD_BODY } from '../src/companion/workspace.js';
import { projectId, saveActiveProject } from '../src/project/index.js';
import { readSettings, saveSettings, settingsPath, DEFAULT_SETTINGS } from '../src/workbench/settings.js';

type Env = Record<string, string | undefined>;

describe('the companion\'s workspace routes: GET /api/workspace and POST /api/workspace/prefs (R5 H132)', () => {
  const kept = { TIMMY_HOME: process.env.TIMMY_HOME, TIMMY_REPO: process.env.TIMMY_REPO, TIMMY_SETTINGS_DIR: process.env.TIMMY_SETTINGS_DIR };
  const boxes: string[] = [];
  const servers: CompanionServer[] = [];
  let box = '';
  let root = '';
  let env: Env = {};

  beforeAll(() => {
    box = mkdtempSync(join(tmpdir(), 'h132-api-'));
    boxes.push(box);
    root = join(box, 'FAKE-project');
    mkdirSync(join(root, '.timmy', 'receipts'), { recursive: true });
    // the producer reads the active project's record through this process's TIMMY_HOME: this test's own, with none in it
    process.env.TIMMY_HOME = join(box, 'home');
    env = { TIMMY_HOME: join(box, 'home'), TIMMY_SETTINGS_DIR: join(box, 'settings') };
  });
  afterEach(() => { rmSync(join(box, 'settings'), { recursive: true, force: true }); });
  afterAll(async () => {
    for (const s of servers) await s.shutdown();
    for (const [k, v] of Object.entries(kept)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    for (const d of boxes) rmSync(d, { recursive: true, force: true });
  });

  /** A companion of this test's own, its folder fixed to the FAKE project (TIMMY_REPO, read as it starts). */
  async function companion(workspace: CompanionOptions['workspace'] = {}): Promise<{ s: CompanionServer; base: string; token: string }> {
    process.env.TIMMY_REPO = root;
    try {
      const s = await startCompanionServer(0, { workspace: { env, ...workspace } });
      servers.push(s);
      return { s, base: `http://127.0.0.1:${s.port}`, token: /#t=([0-9a-f]{64})$/.exec(s.url)![1] };
    } finally { if (kept.TIMMY_REPO === undefined) delete process.env.TIMMY_REPO; else process.env.TIMMY_REPO = kept.TIMMY_REPO; }
  }
  const get = (c: { base: string; token: string }, path = '/api/workspace', token: string | null = c.token): Promise<Response> =>
    fetch(`${c.base}${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  const post = (c: { base: string; token: string }, body: unknown, o: { token?: string | null; raw?: string; path?: string } = {}): Promise<Response> => {
    const token = o.token === undefined ? c.token : o.token;
    return fetch(`${c.base}${o.path ?? '/api/workspace/prefs'}`, {
      method: 'POST', body: o.raw ?? JSON.stringify(body),
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    });
  };
  const frameOf = async (r: Response): Promise<WorkspaceFrame> => (await r.json()) as WorkspaceFrame;
  const saved = (): ReturnType<typeof readSettings> => readSettings(env);

  it('GET /api/workspace: 401 in words without the companion\'s token (and with another), as every content route; /api/auth keeps its 401', async () => {
    const c = await companion();
    for (const token of [null, 'ab'.repeat(32)]) {
      const r = await get(c, '/api/workspace', token);
      expect(r.status).toBe(401);
      expect(await r.text()).toContain(COMPANION_REFUSED);
    }
    expect((await get(c, '/api/auth', null)).status).toBe(401);
  });

  it('GET /api/workspace with the token: 200, no-store, the frame of the project this companion shows, as the producer makes it (the companion computes none of it)', async () => {
    const c = await companion();
    const r = await get(c);
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBe('no-store');
    const frame = await frameOf(r);
    expect(frame.schema).toBe('timmy.workspace/1');
    expect(frame.project.id).toBe(projectId(root));
    expect(frame.project.name).toBe('FAKE-project');
    // the ten tabs, keyed 1 to 9 then 0, in the contract's order; each tab's actions with at most one primary next step
    expect(frame.tabs.map((t) => [t.id, t.key])).toEqual(TABS.map((t) => [t.id, t.key]));
    for (const t of frame.tabs) expect(frame.actions[t.id].filter((a) => a.primary).length, t.id).toBeLessThanOrEqual(1);
    // nothing chosen yet: neither surface opens at start
    expect(frame.surfaces.companion.openAtStart).toBe(false);
    expect(frame.surfaces.studio.openAtStart).toBe(false);
    // the producer's own frame of the same records has the same revision (no time words: no connection was ever checked)
    const direct = await buildWorkspaceFrame({ cwd: root, env });
    expect(frame.revision).toBe(direct.revision);
    expect({ ...frame, at: '' }).toEqual({ ...direct, at: '' });
    // a project this companion does not know is not read
    const unknown = await get(c, `/api/workspace?project=${'0'.repeat(16)}`);
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual({ ok: false, error: PROJECT_UNKNOWN });
    // with the project's own id, the same frame
    expect((await frameOf(await get(c, `/api/workspace?project=${projectId(root)}`))).revision).toBe(frame.revision);
  });

  it('a page whose project is not the active one (here a folder TIMMY_REPO fixed, while the record names another) gets its own project\'s frame, never the active project\'s', async () => {
    // FAKE: another project, recorded as the active one (Timmy's own code writes the record, in this test's TIMMY_HOME)
    const other = join(box, 'FAKE-other');
    mkdirSync(other, { recursive: true });
    saveActiveProject({ name: 'FAKE-other', root: other, chosen: true });
    try {
      const c = await companion();
      const frame = await frameOf(await get(c));
      expect(frame.project.id).toBe(projectId(root));
      expect(frame.project.name).toBe('FAKE-project');
      // the producer, told the same project, makes the same frame
      expect(frame.revision).toBe((await buildWorkspaceFrame({ cwd: root, env, project: { name: 'FAKE-project', root } })).revision);
    } finally { rmSync(join(box, 'home', 'state'), { recursive: true, force: true }); }
  });

  it('R5 lead (the QA round, defect 4): a companion answering its page notes it, so the frame says it is live, not "not running" from an older check; its stop is noted too', async () => {
    const own: Env = { ...env, TIMMY_HOME: join(box, 'home-note') };
    const c = await companion({ env: own });
    // listening on a port the frame does not name (TIMMY_COMPANION_PORT, else 3001): nothing is noted for it
    expect(readConnections(own).checks.companion).toBeUndefined();
    own.TIMMY_COMPANION_PORT = String(c.s.port);
    const f = await frameOf(await get(c));
    expect(f.connections.find((x) => x.id === 'companion')).toMatchObject({ state: 'live', words: expect.stringContaining('its page asked for its frame') });
    expect(f.surfaces.companion.state).toBe('running');
    await c.s.shutdown();
    servers.splice(servers.indexOf(c.s), 1);
    expect(readConnections(own).checks.companion).toMatchObject({ answer: 'not running', detail: 'it stopped' });
  });

  it('R5 lead (the operator\'s 22:32 order, item 2): POST /api/chat/stop asks the shown project\'s turn to stop by its id: 401 without the token, 400 naming no turn, 409 for one not being answered, 200 with the request beside its hold', async () => {
    const c = await companion();
    const stop = (body: unknown, token?: string | null) => post(c, body, { path: '/api/chat/stop', ...(token === undefined ? {} : { token }) });
    expect((await stop({ turn: 't1-0000abcd' }, null)).status).toBe(401);
    for (const body of [{}, { turn: '../outside' }, { turn: 12 }]) {
      const r = await stop(body);
      expect(r.status).toBe(400);
      expect((await r.json()).error).toMatch(/^Not stopped: the request names no chat turn/);
    }
    const none = await stop({ turn: 't1-0000abcd' });
    expect(none.status).toBe(409);
    expect((await none.json()).error).toMatch(/^Not stopped: that chat turn is not being answered now/);
    // a turn of this project held now (this process holds it, as a surface holds the turn it answers)
    const t = takeTurnHold(root, 'repl');
    expect(t.ok).toBe(true);
    if (!t.ok) return;
    const file = join(root, '.timmy', 'chat-turns', `${t.hold.id}.stop`);
    try {
      const r = await stop({ turn: t.hold.id });
      expect(r.status).toBe(200);
      expect(r.headers.get('cache-control')).toBe('no-store');
      expect((await r.json()).words).toMatch(/^Stop asked of the turn being answered in the REPL: /);
      expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ schema: 'timmy.chat-turn-stop/1', by: 'companion' });
      // (R11 round 5, H171: the Chat sends the turn's id as H169's contract C3 names it, { id }; the operator's page is answered
      // here, so this route takes that name too — it answered { id } alone with 400 and left the turn running)
      rmSync(file, { force: true });
      const byId = await stop({ id: t.hold.id });
      expect(byId.status).toBe(200);
      expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ schema: 'timmy.chat-turn-stop/1', by: 'companion' });
    } finally {
      t.hold.release();
      rmSync(file, { force: true });
    }
  });

  it('POST /api/workspace/prefs: 401 without the token, before its body is read; nothing is written', async () => {
    const c = await companion();
    const { revision } = await frameOf(await get(c));
    const r = await post(c, { openCompanionAtStart: true, if_revision: revision }, { token: null });
    expect(r.status).toBe(401);
    expect(saved().state).toBe('none yet');
  });

  it('POST with the frame\'s revision saves through the Workbench\'s settings file (kept settings untouched) and answers {saved_at, frame} with the change in it', async () => {
    // the Workbench's settings as the terminal left them: a layout and a setting of its own, which a page's change keeps
    const layout = { workspace: 'overview' as const, tab: 'files' as const, activity: true };
    expect(saveSettings({ ...DEFAULT_SETTINGS, followActiveProject: false, layouts: { [projectId(root)]: layout } }, env).ok).toBe(true);
    const c = await companion();
    const before = await frameOf(await get(c));
    const t0 = Date.now();
    const r = await post(c, { openCompanionAtStart: true, if_revision: before.revision });
    expect(r.status).toBe(200);
    const body = await r.json() as { saved_at: string; frame: WorkspaceFrame };
    expect(Date.parse(body.saved_at)).toBeGreaterThanOrEqual(t0 - 1000);
    expect(body.frame.surfaces.companion.openAtStart).toBe(true);
    expect(body.frame.surfaces.studio.openAtStart).toBe(false);
    expect(body.frame.revision).not.toBe(before.revision);
    // in the file the terminal Workbench reads: the change, and what it kept
    const file = saved();
    expect(file.state).toBe('saved');
    expect(file.settings).toMatchObject({ openCompanionAtStart: true, openStudioAtStart: false, followActiveProject: false, layouts: { [projectId(root)]: layout } });
    expect(JSON.parse(readFileSync(settingsPath(env), 'utf8')).schema).toBe('timmy.workbench-settings/1');
    expect(statSync(settingsPath(env)).mode & 0o777).toBe(0o600);
    // the next GET is that frame
    expect((await frameOf(await get(c))).revision).toBe(body.frame.revision);
    // both at once, then Studio alone back off
    const both = await post(c, { openCompanionAtStart: false, openStudioAtStart: true, if_revision: body.frame.revision });
    const after = await both.json() as { frame: WorkspaceFrame };
    expect(both.status).toBe(200);
    expect([after.frame.surfaces.companion.openAtStart, after.frame.surfaces.studio.openAtStart]).toEqual([false, true]);
    expect(saved().settings).toMatchObject({ openCompanionAtStart: false, openStudioAtStart: true });
  });

  it('a stale revision is refused: 409 {error: "stale", frame} with the newer frame, and nothing is written over a change made elsewhere', async () => {
    const c = await companion();
    const shown = await frameOf(await get(c));
    // made up: a revision no frame has
    const made = await post(c, { openStudioAtStart: true, if_revision: 'FAKE0000revision' });
    expect(made.status).toBe(409);
    const refused = await made.json() as { error: string; frame: WorkspaceFrame };
    expect(refused.error).toBe('stale');
    expect(refused.frame.revision).toBe(shown.revision);
    expect(saved().state).toBe('none yet');
    // the terminal Workbench turns Studio on meanwhile (its own save): the page's revision is now stale
    expect(saveSettings({ ...DEFAULT_SETTINGS, openStudioAtStart: true, layouts: {} }, env).ok).toBe(true);
    const late = await post(c, { openStudioAtStart: false, if_revision: shown.revision });
    expect(late.status).toBe(409);
    const newer = await late.json() as { error: string; frame: WorkspaceFrame };
    expect(newer.error).toBe('stale');
    expect(newer.frame.surfaces.studio.openAtStart).toBe(true);
    expect(newer.frame.revision).not.toBe(shown.revision);
    // the Workbench's change stands
    expect(saved().settings.openStudioAtStart).toBe(true);
    // asked again against the newer frame, the page's change is saved
    const again = await post(c, { openStudioAtStart: false, if_revision: newer.frame.revision });
    expect(again.status).toBe(200);
    expect(saved().settings.openStudioAtStart).toBe(false);
  });

  it('two pages that showed one revision cannot both write: the saves are taken one at a time, and the second is told its revision is stale', async () => {
    const c = await companion();
    const { revision } = await frameOf(await get(c));
    const [a, b] = await Promise.all([
      post(c, { openCompanionAtStart: true, if_revision: revision }),
      post(c, { openCompanionAtStart: false, openStudioAtStart: true, if_revision: revision }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const winner = a.status === 200 ? { openCompanionAtStart: true, openStudioAtStart: false } : { openCompanionAtStart: false, openStudioAtStart: true };
    expect(saved().settings).toMatchObject(winner);
  });

  it('a body it cannot read is a 400 in words, and nothing is written: no setting, a setting that is not true or false, another key, no revision, not JSON', async () => {
    const c = await companion();
    const { revision } = await frameOf(await get(c));
    for (const body of [{}, { if_revision: revision }, { openCompanionAtStart: 'yes', if_revision: revision }, { openCompanionAtStart: true, followActiveProject: false, if_revision: revision }, { openCompanionAtStart: true }, { openCompanionAtStart: true, if_revision: 7 }, [true]]) {
      const r = await post(c, body);
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(await r.json(), JSON.stringify(body)).toEqual({ error: PREFS_BAD_BODY });
    }
    const raw = await post(c, null, { raw: '{not json' });
    expect(raw.status).toBe(400);
    expect(await raw.json()).toEqual({ ok: false, error: COMPANION_BAD_REQUEST });
    expect(saved().state).toBe('none yet');
  });

  it('a save that fails is a 500 with its words (the home folder as ~, no stack) and changes nothing; an unreadable settings file is not written over', async () => {
    // FAKE: a saver that fails as a full disk or a read-only folder would
    const failing = await companion({ save: () => ({ ok: false, error: `ENOSPC: no space left on device, write '${join(homedir(), '.config', 'FAKE', 'workbench.json')}'\n    at a stack line`, path: '' }) });
    const { revision } = await frameOf(await get(failing));
    const r = await post(failing, { openCompanionAtStart: true, if_revision: revision });
    expect(r.status).toBe(500);
    const { error } = await r.json() as { error: string };
    expect(error).toBe('the Workbench\'s settings file could not be written (ENOSPC: no space left on device, write \'~/.config/FAKE/workbench.json\'); nothing was changed');
    expect(error).not.toContain(homedir());
    expect(saved().state).toBe('none yet');
    expect((await frameOf(await get(failing))).revision).toBe(revision);
    // a settings file that is not the Workbench's (FAKE bytes): read as unreadable, never replaced
    mkdirSync(join(box, 'settings'), { recursive: true });
    writeFileSync(settingsPath(env), 'FAKE: not the settings file\n');
    const c = await companion();
    const now = await frameOf(await get(c));
    const over = await post(c, { openStudioAtStart: true, if_revision: now.revision });
    expect(over.status).toBe(500);
    expect((await over.json() as { error: string }).error).toMatch(/^the Workbench's settings file could not be read \(.+\), so nothing was written over it$/);
    expect(readFileSync(settingsPath(env), 'utf8')).toBe('FAKE: not the settings file\n');
  });

  it('a frame that cannot be made is a 500 in words (no stack, the home folder as ~), and a change cannot be checked against it, so nothing is written', async () => {
    // FAKE: a producer that fails
    const c = await companion({ frame: async () => { throw new Error(`FAKE: cannot read ${join(homedir(), 'FAKE-records', 'jobs')}\n    at a stack line`); } });
    const r = await get(c);
    expect(r.status).toBe(500);
    expect(await r.json()).toEqual({ ok: false, error: 'The workspace frame could not be made: FAKE: cannot read ~/FAKE-records/jobs. Nothing was changed.' });
    const p = await post(c, { openCompanionAtStart: true, if_revision: 'FAKE0000revision' });
    expect(p.status).toBe(500);
    expect((await p.json() as { error: string }).error).toBe('The workspace frame could not be made to check this change against: FAKE: cannot read ~/FAKE-records/jobs. Nothing was written.');
    expect(saved().state).toBe('none yet');
  });
});
