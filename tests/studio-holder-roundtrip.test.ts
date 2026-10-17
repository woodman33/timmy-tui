/**
 * R7 (H149; R6 defect N1): the REPL that holds Timmy Canvas keeps it through tray → blank → tray, with no second /canvas open.
 *
 * Real pieces: the canvas server (src/studio/server.ts) with its follower of this test file's Timmy home's active-project record
 * (a short grace, so the server's own follow can win the race), the REPL's side as src/repl/main.ts wires it (a Workspace, a
 * CanvasProject that names the project with its holder id and asks for actions, and the follower of the record:
 * src/repl/project-follow.ts), the record written as src/project/index.ts saveActiveProject writes it (the Workbench's picker), and
 * the agent's draw as the canvas tools send it (POST /api/canvas/exec with the REPL's token, holder id and project). FAKE, said
 * where used: the canvas page is a `ws` client (tests/helpers/canvas-auth.ts fakePage) that joins with the session /canvas open's
 * grant gives and answers each call; it saves no board, so the boards on disk change only if the server writes them.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { activeProjectPath, projectId, saveActiveProject, type ActiveProject } from '../src/project/index.js';
import { CanvasProject } from '../src/repl/canvas-project.js';
import { ActiveProjectFollower } from '../src/repl/project-follow.js';
import { Workspace } from '../src/repl/workspace.js';
import { canvasDir } from '../src/studio/document.js';
import { startStudioServer, type StudioServer } from '../src/studio/server.js';
import { glyphSet } from '../src/term/glyphs.js';
import { appendReceipt } from '../src/utils/receipts.js';
import { bearer, call, fakePage, session } from './helpers/canvas-auth.js';

const g = glyphSet(true);
const made: string[] = [];
const stops: Array<() => unknown> = [];
afterEach(async () => {
  for (const s of stops.splice(0).reverse()) { try { await s(); } catch { /* stopped already */ } }
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
}, 30_000);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(what: () => Promise<boolean> | boolean, ms = 6000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await what()) return; await sleep(25); }
  throw new Error('waited too long');
}
function project(name: string): ActiveProject {
  const base = mkdtempSync(join(tmpdir(), `timmy-roundtrip-${name}-`));
  made.push(base);
  const root = join(base, name);
  mkdirSync(root, { recursive: true });
  return { name, root, chosen: true };
}
/** Every file under the canvas folder's boards, with its sha256. */
function boards(home: string): Record<string, string> {
  const dir = join(canvasDir({ TIMMY_HOME: home }), 'projects');
  const out: Record<string, string> = {};
  const walk = (d: string): void => {
    let names: string[] = [];
    try { names = readdirSync(d); } catch { return; }
    for (const n of names.sort()) { const f = join(d, n); if (statSync(f).isDirectory()) walk(f); else out[relative(dir, f)] = createHash('sha256').update(readFileSync(f)).digest('hex'); }
  };
  walk(dir);
  return out;
}

/** The canvas server and a REPL's side, wired as src/repl/main.ts wires them. */
async function world(o: { graceMs?: number; start?: ActiveProject } = {}) {
  const home = process.env.TIMMY_HOME!;
  // a Timmy home that has a project chosen already (its record, and so its state folder, exist): the REPL starts in it
  if (o.start) saveActiveProject(o.start, { by: 'repl' });
  const server = await startStudioServer(0, { env: { TIMMY_HOME: home }, projectTokenFile: true, followEveryMs: 50, followGraceMs: o.graceMs ?? 300 });
  stops.push(() => new Promise<void>((done) => server.close(() => done())));
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;
  const active = async () => (await call(port, 'GET', '/api/project/active', { headers: bearer(server.projectToken) })).json as { project: { name: string; id: string } | null; via: string | null };
  const actions = async () => ((await call(port, 'GET', '/api/project?detail=1', { headers: bearer(server.projectToken) })).json as { actions?: { holder: boolean; words: string } }).actions;

  function repl(start: ActiveProject) {
    const jobs = join(mkdtempSync(join(tmpdir(), 'timmy-roundtrip-jobs-')), 'jobs');
    made.push(join(jobs, '..'));
    const notes: string[] = [];
    let cp!: CanvasProject;
    const ws = new Workspace({
      glyphs: g, env: {}, onPath: () => null, notify: (l) => notes.push(l.map((s) => s.text).join('')), openWeb: (url) => `Open ${url}`, link: (t) => t,
      seal: (input) => appendReceipt('runs', input).hash.slice(7, 15), jobsDir: jobs, chdir: () => {}, recoverAtStart: false, runProgress: false, surface: 'repl',
      // as src/repl/main.ts's onSwitch: the canvas is passed the new project
      onSwitch: () => { void cp.switched(); return 'a new conversation, kept in this project'; },
    }, start);
    stops.push(() => ws.close());
    cp = new CanvasProject({
      base: () => base, env: { TIMMY_HOME: home }, project: () => ws.project, projectId, jobsDir: jobs, receipts: () => join(home, 'store'),
      board: () => null, ownToken: () => server.projectToken, act: async () => ({ status: 200, text: 'FAKE: no action runs in this test' }), pollMs: 30_000,
    });
    stops.push(() => cp.stop());
    const follower = new ActiveProjectFollower({ file: activeProjectPath(), current: () => ws.project, busy: () => ws.busy, move: (p) => ws.follow(p), running: (root) => ws.runningIn(root), notify: (l) => notes.push(l.map((s) => s.text).join('')), glyphs: g });
    ws.afterRequests(() => follower.idle());
    follower.start();
    stops.push(() => follower.stop());
    /** /canvas open: the project named with this REPL's holder, its grant traded by the (FAKE) page for a session */
    const open = async () => {
      const told = await cp.handOff({ grant: true });
      expect(told).toMatchObject({ ok: true });
      const t = cp.openTarget();
      const code = /#code=([0-9a-f]{32})$/.exec(t.target)?.[1];
      expect(code, t.target).toBeTruthy();
      const s = await session(port, code!);
      const page = await fakePage(port, { session: s, answer: (m) => ({ id: m.id, ok: true, result: 'FAKE page: nothing drawn', revision: 1, changed: false }) });
      stops.push(() => page.ws.close());
      return page;
    };
    /** a draw, as the agent's canvas tools send it */
    const draw = async () => {
      const c = cp.credentials();
      const r = await call(port, 'POST', '/api/canvas/exec', { headers: { ...bearer(c!.token), 'Content-Type': 'application/json' }, body: JSON.stringify({ code: 'return 1;', holder: c!.holder, project: c!.project }) });
      return { status: r.status, error: typeof r.json.error === 'string' ? r.json.error : null };
    };
    return { ws, cp, notes, open, draw, follower };
  }
  return { home, server, port, active, actions, repl };
}

describe('the REPL that holds Timmy Canvas keeps it through tray → blank → tray (R7 H149, R6 N1)', () => {
  it('following the record each time: the same REPL draws on tray again with no /canvas open, and no board changes', async () => {
    const tray = project('tray');
    const blank = project('blank');
    const w = await world({ start: tray });
    const r = w.repl(tray);
    const page = await r.open();
    expect(await r.draw()).toEqual({ status: 200, error: null });
    const before = boards(w.home);
    saveActiveProject(blank, { by: 'workbench' });
    // the REPL follows within the server's grace and names blank itself, with its holder
    await until(async () => (await w.active()).project?.name === 'blank' && r.ws.project.name === 'blank');
    expect(await w.active()).toMatchObject({ project: { name: 'blank', id: projectId(blank.root) }, via: 'repl' });
    saveActiveProject(tray, { by: 'workbench' });
    await until(async () => (await w.active()).project?.name === 'tray' && r.ws.project.name === 'tray');
    await sleep(500); // past the server's grace: its own follow, had it one to make, has been made
    expect(await w.active()).toMatchObject({ project: { name: 'tray' }, via: 'repl' });
    expect(await r.draw()).toEqual({ status: 200, error: null });
    expect(page.seen.length).toBe(2);
    expect(boards(w.home)).toEqual(before);
  });

  it('the server\'s own follow first (the REPL busy with a turn): once the turn ends the REPL follows and takes the canvas back', async () => {
    const tray = project('tray');
    const blank = project('blank');
    const w = await world({ start: tray });
    const r = w.repl(tray);
    await r.open();
    let release!: () => void;
    const turn = r.ws.operate('draw me a tray', 'repl', () => new Promise<void>((done) => { release = done; }));
    saveActiveProject(blank, { by: 'workbench' });
    // no REPL names blank in the grace: the server follows it itself, with no holder
    await until(async () => (await w.active()).project?.name === 'blank');
    expect(await w.active()).toMatchObject({ via: 'active' });
    await r.cp.check(); // the REPL's own look at the canvas (every 5 s): it shows blank now
    expect(r.notes.join('\n')).toContain('this REPL follows blank once this turn ends; the turn finishes in tray.');
    release();
    await turn;
    expect(r.ws.project.name).toBe('blank');
    await until(async () => (await w.active()).via === 'repl');
    expect(await r.draw()).toEqual({ status: 200, error: null });
  });

  it('the record back on tray while the REPL could not follow: the server gives tray back to the REPL still in it; a REPL that ended is never given it', async () => {
    const tray = project('tray');
    const blank = project('blank');
    const w = await world({ start: tray });
    const r = w.repl(tray);
    await r.open();
    let release!: () => void;
    const turn = r.ws.operate('draw me a tray', 'repl', () => new Promise<void>((done) => { release = done; }));
    saveActiveProject(blank, { by: 'workbench' });
    await until(async () => (await w.active()).project?.name === 'blank');
    saveActiveProject(tray, { by: 'workbench' });
    await until(async () => (await w.active()).project?.name === 'tray');
    // the REPL never left tray (its turn ran throughout): it holds tray again, and its turn draws there with no /canvas open
    await until(async () => (await w.actions())?.holder === true);
    expect(await w.active()).toMatchObject({ project: { name: 'tray' }, via: 'repl' });
    expect(await r.draw()).toEqual({ status: 200, error: null });
    release();
    await turn;
    expect(r.ws.project.name).toBe('tray');

    // a REPL that ended: its canvas side stopped (its poll ends); the server never gives tray back to it
    r.cp.stop();
    await sleep(300);
    saveActiveProject(blank, { by: 'workbench' });
    await until(async () => (await w.active()).project?.name === 'blank');
    saveActiveProject(tray, { by: 'workbench' });
    await until(async () => (await w.active()).project?.name === 'tray');
    await sleep(600);
    expect(await w.active()).toMatchObject({ project: { name: 'tray' }, via: 'active' });
    expect((await w.actions())?.holder).toBe(false);
  });
});
