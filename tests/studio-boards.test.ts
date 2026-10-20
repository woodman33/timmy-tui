/**
 * R6 (H139): each project's own board on the canvas server (src/studio/boards.ts): the operator's words (2026-10-16, priority 1),
 * "Project identity, board, drafts, jobs, artifact links and save/action targets must change together ... prove neither project's
 * content is written into the other." And the old layout (one canvas for the whole Timmy home): its files never rewritten or
 * deleted, copied once into the project they belonged to, with a record.
 *
 * Real HTTP on 127.0.0.1 against the real studio server, with temporary Timmy homes and two FAKE disposable projects (alpha and
 * beta, folders made here). The page on the bridge is a FAKE page (a `ws` client with a real session, tests/helpers/canvas-auth.ts):
 * it answers as the real page does, by hand; the real page runs in Chromium in tests/studio-isolation-browser.test.ts. Every file
 * of both boards is hashed before and after each step.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { createCanvasTools } from '../src/agent/canvas-tools.js';
import { projectId } from '../src/project/index.js';
import { activeProjectFile } from '../src/studio/active-follow.js';
import { adoptOldLayout, ADOPTION_RECORD, boardDir, oldLayoutWords, pendingDrafts, projectsNamedIn } from '../src/studio/boards.js';
import { CanvasDocuments } from '../src/studio/document.js';
import { startStudioServer, type StudioServer } from '../src/studio/server.js';
import { bearer, call, exec, fakePage, nameProject, pageSession } from './helpers/canvas-auth.js';

const temps: string[] = [];
const temp = (prefix: string): string => { const d = mkdtempSync(join(tmpdir(), prefix)); temps.push(d); return d; };
const servers: StudioServer[] = [];
const sockets: WebSocket[] = [];
afterEach(async () => {
  for (const s of sockets.splice(0)) s.terminate();
  for (const s of servers.splice(0)) await new Promise<void>((done) => s.close(() => done()));
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
});

const HX = 'a'.repeat(32);
const SOURCE = 'cd'.repeat(32);
const sha = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');
/** Every file under `dir`, with its sha256 (the folder's bytes, as a map): what "unchanged" is checked against. */
function hashes(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string): void => {
    let names: string[] = [];
    try { names = readdirSync(d); } catch { return; }
    for (const n of names.sort()) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p); else out[relative(dir, p)] = sha(readFileSync(p));
    }
  };
  walk(dir);
  return out;
}
const snap = (shapes: Record<string, unknown>) => ({ schema: { schemaVersion: 2, sequences: {} }, store: { 'page:page': { id: 'page:page', typeName: 'page', name: 'Page 1', index: 'a1', meta: {} }, ...shapes } });
const geo = (id: string, text: string, meta: Record<string, unknown> = {}) => ({ id, typeName: 'shape', type: 'geo', x: 0, y: 0, rotation: 0, index: 'a1', parentId: 'page:page', isLocked: false, opacity: 1, meta, props: { w: 100, h: 50, text } });

interface World { server: StudioServer; port: number; token: string; home: string; canvas: string; project: (name: string) => { root: string; name: string; id: string } }
async function world(o: { home?: string; env?: Record<string, string> } = {}): Promise<World> {
  const home = o.home ?? temp('studio-boards-home-');
  const server = await startStudioServer(0, { env: { TIMMY_HOME: home, HOME: home, ...o.env } });
  servers.push(server);
  const port = (server.address() as AddressInfo).port;
  const base = temp('studio-boards-projects-');
  const project = (name: string) => { const root = join(base, name); mkdirSync(root, { recursive: true }); return { root, name, id: projectId(root) }; };
  return { server, port, token: server.projectToken, home, canvas: join(home, 'canvas'), project };
}
const json = { 'Content-Type': 'application/json' };
const put = (w: World, cred: string, body: Record<string, unknown>, origin = false) => call(w.port, 'PUT', '/api/canvas/document', { headers: { ...bearer(cred), ...json, ...(origin ? { Origin: `http://127.0.0.1:${w.port}` } : {}) }, body: JSON.stringify(body) });
const doc = (w: World, cred: string, q = '') => call(w.port, 'GET', `/api/canvas/document${q}`, { headers: bearer(cred) });

describe('each project has its own board', () => {
  it("saves, reads, jobs and drafts are the project's own: a write to alpha's board leaves beta's files byte for byte as they were, and the other way round", async () => {
    const w = await world();
    const alpha = w.project('alpha');
    const beta = w.project('beta');
    await nameProject(w.port, w.token, { root: alpha.root, name: 'alpha' });
    expect((await put(w, w.token, { snapshot: snap({ 'shape:a1': geo('shape:a1', 'alpha one') }), revision: 3, baseRevision: 0 })).json).toMatchObject({ ok: true, revision: 3, project: { id: alpha.id, name: 'alpha' } });
    await nameProject(w.port, w.token, { root: beta.root, name: 'beta' });
    const betaNew = await doc(w, w.token);
    expect(betaNew.json).toMatchObject({ revision: 0, snapshot: null, project: { id: beta.id, name: 'beta' } });
    expect(betaNew.body).not.toContain('alpha one');
    const alphaFiles = hashes(boardDir(w.canvas, alpha.id));
    expect(Object.keys(alphaFiles)).toEqual(['canvas.json']);
    expect((await put(w, w.token, { snapshot: snap({ 'shape:b1': geo('shape:b1', 'beta one') }), revision: 1, baseRevision: 0 })).status).toBe(200);
    // beta's save touched nothing of alpha's
    expect(hashes(boardDir(w.canvas, alpha.id))).toEqual(alphaFiles);
    const betaFiles = hashes(boardDir(w.canvas, beta.id));
    // back on alpha: its own board, as saved; beta's files as they were
    await nameProject(w.port, w.token, { root: alpha.root, name: 'alpha' });
    const back = await doc(w, w.token);
    expect(back.json).toMatchObject({ revision: 3, project: { id: alpha.id } });
    expect(back.body).toContain('alpha one');
    expect(back.body).not.toContain('beta one');
    expect(hashes(boardDir(w.canvas, beta.id))).toEqual(betaFiles);
    // the token reads any project's board by its id, whichever is named
    expect((await doc(w, w.token, `?project=${beta.id}`)).body).toContain('beta one');
    // nothing of the old layout was written
    for (const f of ['canvas.json', 'jobs.json', 'drafts.jsonl']) expect(existsSync(join(w.canvas, f)), f).toBe(false);
  });

  it("a call is stamped with the project named, runs nothing for a REPL that draws on another, and is recorded in its own project's ledger and drafts record even when the canvas switched while it ran", async () => {
    const w = await world();
    const alpha = w.project('alpha');
    const beta = w.project('beta');
    await nameProject(w.port, w.token, { root: alpha.root, name: 'alpha', holder: HX });
    const s = await pageSession(w.port, w.token);
    // a FAKE page that holds its answer until the test lets it go (a delayed answer, as a slow call or a slow network gives one)
    let release: (() => void) | null = null;
    const seen: Array<Record<string, unknown>> = [];
    const page = await fakePage(w.port, { session: s, answer: (m) => { seen.push(m as unknown as Record<string, unknown>); return undefined; } });
    sockets.push(page.ws);
    page.ws.on('message', (data) => {
      const m = JSON.parse(String(data)) as { type?: string; id: number; draft?: { id: string } };
      if (m.type !== 'exec') return;
      release = () => page.ws.send(JSON.stringify({ id: m.id, ok: true, result: 'drawn', revision: 7, sourceRevision: SOURCE, changed: true, ...(m.draft ? { draft: { id: m.draft.id, shapes: 2, from: 5 } } : {}) }));
    });
    const before = hashes(w.canvas);
    // a REPL that draws on beta while the canvas shows alpha: refused, nothing sent to the page
    const wrong = await exec(w.port, w.token, { code: 'return 1', holder: HX, project: beta.id });
    expect(wrong.status).toBe(409);
    // (beta was never named to this canvas, so it does not know beta's name)
    expect(wrong.json.error).toBe('Refused: this REPL draws on another project, but the canvas shows alpha now, so nothing ran. In this REPL: /canvas open names its project to the canvas again; then ask again.');
    expect(seen).toEqual([]);
    expect(hashes(w.canvas)).toEqual(before);
    // a draft for alpha: the page is told it is alpha's
    const pending = exec(w.port, w.token, { code: 'return 2', jobId: 'turn-alpha', holder: HX, draft: true, baseRevision: 5, project: alpha.id });
    await until(() => seen.length === 1 && release !== null);
    expect(seen[0].project).toEqual({ id: alpha.id, name: 'alpha' });
    // the canvas switches to beta (its REPL's /project) before the page answers; then the page answers
    const told: unknown[] = [];
    page.ws.on('message', (data) => { const m = JSON.parse(String(data)) as { type?: string }; if (m.type === 'project') told.push(m); });
    await nameProject(w.port, w.token, { root: beta.root, name: 'beta', holder: HX });
    await until(() => told.length === 1);
    expect(told[0]).toEqual({ type: 'project', project: { id: beta.id, name: 'beta' } });
    release!();
    const r = await pending;
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ ok: true, jobId: 'turn-alpha', project: { id: alpha.id, name: 'alpha' }, kept: expect.stringMatching(/^Kept for alpha: the canvas switched to beta while this call ran/) });
    // the REPL, still drawing on alpha, is refused now that the canvas shows beta (alpha's name is known here: it was named)
    const stillAlpha = await exec(w.port, w.token, { code: 'return 3', holder: HX, project: alpha.id });
    expect(stillAlpha.status).toBe(409);
    expect(stillAlpha.json.error).toBe('Refused: this REPL draws on alpha, but the canvas shows beta now, so nothing ran. In this REPL: /canvas open names its project to the canvas again; then ask again.');
    // recorded in alpha's ledger and drafts record only; nothing of it in beta's folder (which has none)
    const alphaDocs = new CanvasDocuments(boardDir(w.canvas, alpha.id));
    expect(alphaDocs.jobs()).toEqual([expect.objectContaining({ id: 'turn-alpha', project: alpha.id, revision: 7, sourceRevision: SOURCE })]);
    expect(alphaDocs.drafts()).toEqual([expect.objectContaining({ event: 'proposed', job: 'turn-alpha', project: alpha.id, shapes: 2, from: 5 })]);
    expect(existsSync(boardDir(w.canvas, beta.id))).toBe(false);
    // beta's jobs, read now (the canvas shows beta), are beta's: none
    expect((await call(w.port, 'GET', '/api/canvas/jobs', { headers: bearer(s) })).json).toEqual([]);
    // the receipt of alpha's turn is linked in alpha's ledger, though the canvas shows beta
    const link = await call(w.port, 'POST', '/api/canvas/jobs/turn-alpha/receipt', { headers: { ...bearer(w.token), ...json }, body: JSON.stringify({ receipt: '0f3c9a12' }) });
    expect(link.json).toEqual({ ok: true, job: 'turn-alpha', receipt: '0f3c9a12', project: { id: alpha.id, name: 'alpha' } });
    expect(alphaDocs.jobs()[0].receipt).toBe('0f3c9a12');
    expect(existsSync(boardDir(w.canvas, beta.id))).toBe(false);
  });

  it("a page's last save of alpha's board after the switch to beta lands on alpha's board (said so); a reading it asked for alpha is told the canvas shows beta; beta's files stay byte for byte as they were", async () => {
    const w = await world();
    const alpha = w.project('alpha');
    const beta = w.project('beta');
    await nameProject(w.port, w.token, { root: alpha.root, name: 'alpha', holder: HX });
    const s = await pageSession(w.port, w.token);
    expect((await put(w, s, { snapshot: snap({ 'shape:a1': geo('shape:a1', 'alpha first') }), revision: 2, baseRevision: 0, project: alpha.id }, true)).status).toBe(200);
    // the same REPL switches to beta (the session follows it), and beta gets a board of its own
    await nameProject(w.port, w.token, { root: beta.root, name: 'beta', holder: HX });
    expect((await put(w, s, { snapshot: snap({ 'shape:b1': geo('shape:b1', 'beta first') }), revision: 1, baseRevision: 0, project: beta.id }, true)).status).toBe(200);
    const betaBefore = hashes(boardDir(w.canvas, beta.id));
    // alpha's page's last save, on its way when the switch came: alpha's board, kept for it, and said so
    const late = await put(w, s, { snapshot: snap({ 'shape:a1': geo('shape:a1', 'alpha first'), 'shape:a2': geo('shape:a2', 'alpha late') }), revision: 3, baseRevision: 2, project: alpha.id }, true);
    expect(late.status).toBe(200);
    expect(late.json).toMatchObject({ ok: true, revision: 3, project: { id: alpha.id, name: 'alpha' }, kept: "Kept for alpha: written to alpha's own board, because the canvas shows beta now." });
    expect(hashes(boardDir(w.canvas, beta.id))).toEqual(betaBefore);
    expect(new CanvasDocuments(boardDir(w.canvas, alpha.id)).load().snapshot).toMatchObject({ store: { 'shape:a2': { props: { text: 'alpha late' } } } });
    // a decision on a draft of alpha's, recorded in alpha's record
    const decided = await call(w.port, 'POST', '/api/canvas/drafts', { headers: { ...bearer(s), ...json }, body: JSON.stringify({ draft: 'draft-0a1b2c3d4e5f', decision: 'accepted', shapes: 1, job: 'turn-a', from: 2, revision: 3, sourceRevision: late.json.sourceRevision, project: alpha.id }) });
    expect(decided.json).toMatchObject({ ok: true, recorded: { project: alpha.id, event: 'accepted' }, kept: expect.stringMatching(/^Kept for alpha/) });
    expect(hashes(boardDir(w.canvas, beta.id))).toEqual(betaBefore);
    // readings the page asked for alpha (before the switch) are refused now, saying what the canvas shows; nothing of either board
    for (const path of ['/api/canvas/document', '/api/canvas/jobs', '/api/canvas/drafts', '/api/canvas/health', '/api/workspace']) {
      const r = await call(w.port, 'GET', `${path}?project=${alpha.id}`, { headers: bearer(s) });
      expect(r.status, path).toBe(409);
      expect(r.json, path).toMatchObject({ ok: false, notShown: true, shows: { id: beta.id, name: 'beta' }, error: 'The canvas shows beta now, not the project this page asked for (alpha).' });
      expect(r.body, path).not.toMatch(/alpha (first|late)|beta first/);
    }
    // what it reads for beta is beta's
    expect((await doc(w, s, `?project=${beta.id}`)).body).toContain('beta first');
    // a session never given for (nor followed to) a project cannot write that project's board
    const gamma = w.project('gamma');
    const refused = await put(w, s, { snapshot: snap({}), revision: 1, baseRevision: 0, project: gamma.id }, true);
    expect(refused.status).toBe(401);
    expect(existsSync(boardDir(w.canvas, gamma.id))).toBe(false);
  });

  it("every page joined is told at once when the project named changes (a REPL's, or the active project followed); one whose session does not count is told only that it cannot show it", async () => {
    const home = temp('studio-boards-follow-home-');
    const server = await startStudioServer(0, { env: { TIMMY_HOME: home, HOME: home }, projectTokenFile: true, followEveryMs: 50, followGraceMs: 50 });
    servers.push(server);
    const port = (server.address() as AddressInfo).port;
    const base = temp('studio-boards-follow-projects-');
    const mk = (name: string) => { const root = join(base, name); mkdirSync(root, { recursive: true }); return { root, name, id: projectId(root) }; };
    const alpha = mk('alpha');
    const beta = mk('beta');
    const gamma = mk('gamma');
    await nameProject(port, server.projectToken, { root: alpha.root, name: 'alpha', holder: HX });
    const told: Array<Record<string, unknown>> = [];
    const page = await fakePage(port, { session: await pageSession(port, server.projectToken) });
    sockets.push(page.ws);
    page.ws.on('message', (data) => { const m = JSON.parse(String(data)) as Record<string, unknown>; if (m.type === 'project') told.push(m); });
    // the active project of this Timmy home changes to beta (as /project or the Workbench's p writes it): followed, and told
    const file = activeProjectFile({ TIMMY_HOME: home });
    mkdirSync(join(home, 'state'), { recursive: true });
    writeFileSync(file, `${JSON.stringify({ name: 'beta', root: beta.root, at: new Date().toISOString() })}\n`);
    await until(() => told.length === 1);
    expect(told[0]).toEqual({ type: 'project', project: { id: beta.id, name: 'beta' } });
    // another REPL names gamma: this page's session does not count for it, so it is not told which project, only why
    await nameProject(port, server.projectToken, { root: gamma.root, name: 'gamma', holder: 'b'.repeat(32) });
    await until(() => told.length === 2);
    expect(told[1]).toEqual({ type: 'project', project: null, paused: "Refused: this canvas page's session was given for another project than the one the canvas shows now. In Timmy: /canvas open, from the REPL that holds this project." });
    expect(JSON.stringify(told[1])).not.toContain('gamma');
  });
});

describe('the old layout: one canvas for the whole Timmy home', () => {
  /** A Timmy home as an older Timmy left it: canvas.json, jobs.json and drafts.jsonl in its canvas folder. */
  function oldHome(o: { active?: { name: string; root: string } | null; cards?: Array<{ id: string; name: string }> } = {}) {
    const home = temp('studio-boards-old-home-');
    const canvas = join(home, 'canvas');
    mkdirSync(canvas, { recursive: true });
    const shapes: Record<string, unknown> = { 'shape:old': geo('shape:old', 'drawn before R6') };
    for (const [i, c] of (o.cards ?? []).entries()) shapes[`shape:c${i}`] = { ...geo(`shape:c${i}`, 'a card'), type: 'timmy-workflow', props: { card: 'workflow:A.md', projectId: c.id, project: c.name, data: null } };
    writeFileSync(join(canvas, 'canvas.json'), `${JSON.stringify({ format: 'timmy-canvas', version: 1, revision: 9, savedAt: '2026-10-15T12:00:00.000Z', sourceRevision: 'x', snapshot: snap(shapes) })}\n`, { mode: 0o600 });
    writeFileSync(join(canvas, 'jobs.json'), `${JSON.stringify([{ id: 'turn-old', ok: true, calls: 1, failed: 0, revision: 9, sourceRevision: SOURCE, at: '2026-10-15T12:00:00.000Z' }], null, 1)}\n`, { mode: 0o600 });
    writeFileSync(join(canvas, 'drafts.jsonl'), `${JSON.stringify({ at: '2026-10-15T12:00:00.000Z', draft: 'draft-00aa11bb22cc', event: 'proposed', job: 'turn-old', shapes: 1, from: 8, revision: 9, sourceRevision: SOURCE })}\n`, { mode: 0o600 });
    if (o.active) {
      mkdirSync(join(home, 'state'), { recursive: true });
      writeFileSync(join(home, 'state', 'active-project.json'), `${JSON.stringify({ ...o.active, at: '2026-10-15T11:00:00.000Z' })}\n`);
    }
    return { home, canvas };
  }
  const OLD = ['canvas.json', 'jobs.json', 'drafts.jsonl'];
  const bytes = (dir: string): Record<string, string> => Object.fromEntries(OLD.map((f) => [f, readFileSync(join(dir, f), 'latin1')]));

  it("becomes the board of the active project it followed, copied byte for byte with a record; the old files are never rewritten; another project's board starts blank; nothing is adopted twice", async () => {
    const projects = temp('studio-boards-old-projects-');
    const tray = join(projects, 'tray');
    const blank = join(projects, 'blank');
    mkdirSync(tray);
    mkdirSync(blank);
    const old = oldHome({ active: { name: 'tray', root: tray } });
    const before = bytes(old.canvas);
    const w = await world({ home: old.home });
    // copied into tray's board as it starts, byte for byte, with the record beside the old files and in tray's board
    const trayDir = boardDir(old.canvas, projectId(tray));
    for (const f of OLD) expect(readFileSync(join(trayDir, f), 'latin1'), f).toBe(before[f]);
    const record = JSON.parse(readFileSync(join(old.canvas, ADOPTION_RECORD), 'utf8'));
    expect(record).toMatchObject({ format: 'timmy-canvas-adoption', version: 1, project: { id: projectId(tray), name: 'tray' }, why: expect.stringMatching(/^the active project of this Timmy home/) });
    expect(record.files.map((f: { name: string; to: string; sha256: string }) => [f.name, f.to, f.sha256])).toEqual(OLD.map((f) => [f, `projects/${projectId(tray)}/${f}`, sha(Buffer.from(before[f], 'latin1'))]));
    expect(JSON.parse(readFileSync(join(trayDir, 'adopted.json'), 'utf8'))).toEqual(record);
    // tray, named: its board is the old canvas, saying so; its old job and draft are its own
    await nameProject(w.port, w.token, { root: tray, name: 'tray' });
    const t = await doc(w, w.token);
    expect(t.json).toMatchObject({ revision: 9, project: { name: 'tray' }, oldLayout: expect.stringMatching(/^This board is the canvas this Timmy home had before each project had its own \(canvas\.json, jobs\.json, drafts\.jsonl, copied 2026-/) });
    expect(t.body).toContain('drawn before R6');
    expect((await call(w.port, 'GET', '/api/canvas/jobs', { headers: bearer(w.token) })).json).toEqual([expect.objectContaining({ id: 'turn-old' })]);
    // the receipt of the old job links in tray's board; the old ledger is untouched
    expect((await call(w.port, 'POST', '/api/canvas/jobs/turn-old/receipt', { headers: { ...bearer(w.token), ...json }, body: JSON.stringify({ receipt: '0f3c9a12' }) })).json).toMatchObject({ ok: true, project: { id: projectId(tray) } });
    // a save of tray's board writes tray's file, never the old one
    expect((await put(w, w.token, { snapshot: snap({ 'shape:new': geo('shape:new', 'after R6') }), revision: 10, baseRevision: 9 })).status).toBe(200);
    // blank, named: a blank board of its own, and no word of the old canvas (it went to tray)
    await nameProject(w.port, w.token, { root: blank, name: 'blank' });
    const b = await doc(w, w.token);
    expect(b.json).toMatchObject({ revision: 0, snapshot: null, project: { name: 'blank' } });
    expect(b.json.oldLayout).toBeUndefined();
    expect(b.body).not.toContain('drawn before R6');
    // the old files: byte for byte as the older Timmy left them
    expect(bytes(old.canvas)).toEqual(before);
    // a second start adopts nothing again and changes nothing
    const recordBytes = readFileSync(join(old.canvas, ADOPTION_RECORD), 'latin1');
    const trayNow = hashes(trayDir);
    await world({ home: old.home });
    expect(readFileSync(join(old.canvas, ADOPTION_RECORD), 'latin1')).toBe(recordBytes);
    expect(hashes(trayDir)).toEqual(trayNow);
    expect(bytes(old.canvas)).toEqual(before);
  });

  it("with no active project recorded, it becomes the board of the one project its cards name; with none or several, no project's board shows it and each says so, and nothing is copied", async () => {
    const id = 'f'.repeat(16);
    const named = oldHome({ cards: [{ id, name: 'cards-project' }] });
    expect(projectsNamedIn(JSON.parse(readFileSync(join(named.canvas, 'canvas.json'), 'utf8')).snapshot)).toEqual(new Map([[id, 'cards-project']]));
    const a = adoptOldLayout(named.canvas);
    expect(a).toMatchObject({ project: { id, name: 'cards-project' }, why: expect.stringMatching(/^the one project the old canvas's cards name: cards-project/) });
    expect(readFileSync(join(boardDir(named.canvas, id), 'canvas.json'), 'utf8')).toBe(readFileSync(join(named.canvas, 'canvas.json'), 'utf8'));
    // two projects named, no active one: not adopted, kept where it is, said so on a project's board
    const two = oldHome({ cards: [{ id: '1'.repeat(16), name: 'one' }, { id: '2'.repeat(16), name: 'two' }] });
    const before = bytes(two.canvas);
    const w = await world({ home: two.home });
    expect(existsSync(join(two.canvas, ADOPTION_RECORD))).toBe(false);
    expect(existsSync(join(two.canvas, 'projects'))).toBe(false);
    const p = w.project('else');
    await nameProject(w.port, w.token, { root: p.root, name: 'else' });
    const r = await doc(w, w.token);
    expect(r.json).toMatchObject({ revision: 0, snapshot: null, oldLayout: expect.stringMatching(/^This Timmy home also keeps the canvas it had before each project had its own board \(canvas\.json, jobs\.json, drafts\.jsonl in .+\), unchanged: Timmy could not tell which project it belonged to/) });
    expect(oldLayoutWords(two.canvas, p.id)).toBe(r.json.oldLayout);
    expect(bytes(two.canvas)).toEqual(before);
  });
});

describe('pendingDrafts: what waits for a person on a project\'s board (for the shared frame)', () => {
  it('counts the drafts its saved board holds, with the jobs that drew them; none without a board; null when the board cannot be read', () => {
    const home = temp('studio-boards-pending-');
    const env = { TIMMY_HOME: home };
    const root = join(home, 'proj');
    mkdirSync(root);
    expect(pendingDrafts(root, env)).toEqual({ count: 0, jobs: [] });
    const docs = new CanvasDocuments(boardDir(join(home, 'canvas'), projectId(root)));
    const mark = (id: string, job: string | null) => ({ timmyDraft: { id, job, from: 1, at: '2026-10-16T10:00:00.000Z' } });
    expect(docs.save({ snapshot: snap({ 's:1': geo('s:1', 'a', mark('draft-0011223344aa', 'turn-a')), 's:2': geo('s:2', 'b', mark('draft-0011223344aa', 'turn-a')), 's:3': geo('s:3', 'c', mark('draft-5566778899bb', null)), 's:4': geo('s:4', 'mine') }), revision: 2, baseRevision: 0 }).ok).toBe(true);
    expect(pendingDrafts(root, env)).toEqual({ count: 2, jobs: ['turn-a'] });
    // accepted: the marks are gone, so nothing waits
    expect(docs.save({ snapshot: snap({ 's:1': geo('s:1', 'a', { timmyProposed: { by: 'Timmy' } }), 's:4': geo('s:4', 'mine') }), revision: 5, baseRevision: 2 }).ok).toBe(true);
    expect(pendingDrafts(root, env)).toEqual({ count: 0, jobs: [] });
    writeFileSync(join(boardDir(join(home, 'canvas'), projectId(root)), 'canvas.json'), 'not json, longer than before');
    expect(pendingDrafts(root, env)).toBeNull();
  });
});

describe('the agent\'s canvas tools keep each project\'s revision apart, and read the board again after an Accept or a reopen', () => {
  it("a draft after the person's Accept is made from the board's revision now (not refused as stale); after an edit of the person's, from what the model saw (the page refuses it); after a reopen, from the board now", async () => {
    const w = await world();
    const alpha = w.project('alpha');
    await nameProject(w.port, w.token, { root: alpha.root, name: 'alpha' });
    const s = await pageSession(w.port, w.token);
    // a FAKE page that answers with the revision the board is at (the test moves it, as a person's Accept or edit would)
    let revision = 3;
    const seen: Array<{ draft?: { baseRevision: number | null } }> = [];
    const page = await fakePage(w.port, { session: s, answer: (m) => { seen.push(m as never); return { ok: true, result: 1, revision, sourceRevision: SOURCE, changed: true }; } });
    sockets.push(page.ws);
    let opened = 0;
    let drawsOn = alpha.id;
    const tools = createCanvasTools({ baseUrl: `http://127.0.0.1:${w.port}`, auth: () => ({ token: w.token, holder: null, project: drawsOn, opened }) });
    const run = (args: Record<string, unknown>) => (tools.find((t) => t.function.name === 'canvas_exec')!.function.execute as (a: unknown) => Promise<Record<string, unknown>>)(args);
    const board = new CanvasDocuments(boardDir(w.canvas, alpha.id));
    expect(board.save({ snapshot: snap({}), revision: 3, baseRevision: 0 }).ok).toBe(true);
    await run({ code: 'draw 1' });
    expect(seen[0].draft!.baseRevision).toBeNull();
    // the person accepts the draft: the page saves revision 6 and records the decision with it
    const six = board.save({ snapshot: snap({ 's:1': geo('s:1', 'accepted') }), revision: 6, baseRevision: 3 });
    expect(six.ok).toBe(true);
    board.recordDraft({ draft: 'draft-0a1b2c3d4e5f', event: 'accepted', job: 'turn-1', shapes: 1, from: 3, revision: 6, sourceRevision: (six as { sourceRevision: string }).sourceRevision, by: 'page', project: alpha.id });
    revision = 6;
    await run({ code: 'draw 2' });
    expect(seen[1].draft!.baseRevision).toBe(6);
    // the person then edits the board by hand (revision 8, no decision): the draft keeps what the model saw (6), stale for the page
    expect(board.save({ snapshot: snap({ 's:1': geo('s:1', 'moved') }), revision: 8, baseRevision: 6 }).ok).toBe(true);
    await run({ code: 'draw 3' });
    expect(seen[2].draft!.baseRevision).toBe(6);
    // /canvas open again (a reopen): the next draft is made from what the board holds now
    revision = 8;
    expect(board.save({ snapshot: snap({ 's:1': geo('s:1', 'moved again') }), revision: 9, baseRevision: 8 }).ok).toBe(true);
    opened = 1;
    await run({ code: 'draw 4' });
    expect(seen[3].draft!.baseRevision).toBe(9);
    // another project's revision never stands for this one's: the same tools, once the REPL draws on beta (its page open for
    // beta), make beta's first draft from none (the page takes beta's revision), never from alpha's 9
    const beta = w.project('beta');
    await nameProject(w.port, w.token, { root: beta.root, name: 'beta' });
    const seenB: Array<{ draft?: { baseRevision: number | null }; project?: unknown }> = [];
    const pageB = await fakePage(w.port, { session: await pageSession(w.port, w.token), answer: (m) => { seenB.push(m as never); return { ok: true, result: 1, revision: 1, sourceRevision: SOURCE, changed: true }; } });
    sockets.push(pageB.ws);
    drawsOn = beta.id;
    await run({ code: 'draw on beta' });
    expect(seenB[0].draft!.baseRevision).toBeNull();
    expect(seenB[0].project).toEqual({ id: beta.id, name: 'beta' });
    // and back on alpha (its page open again), alpha's own last revision is the base again
    await nameProject(w.port, w.token, { root: alpha.root, name: 'alpha' });
    const pageA = await fakePage(w.port, { session: await pageSession(w.port, w.token), answer: (m) => { seen.push(m as never); return { ok: true, result: 1, revision: 9, sourceRevision: SOURCE, changed: true }; } });
    sockets.push(pageA.ws);
    drawsOn = alpha.id;
    await run({ code: 'draw on alpha again' });
    expect(seen.at(-1)!.draft!.baseRevision).toBe(8);
  });
});

async function until(ok: () => boolean | Promise<boolean>, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await ok())) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 20));
  }
}
