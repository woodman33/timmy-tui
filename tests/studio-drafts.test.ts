/**
 * R5 (H133): drafts on the canvas server, its record of them, and a page's copy kept when a newer canvas is on disk.
 *
 * Real HTTP on 127.0.0.1 against the real studio server, with its own temporary HOME and TIMMY_HOME. The page on the bridge is a
 * FAKE page (a `ws` client with a real session, tests/helpers/canvas-auth.ts fakePage): it answers as the real page does, by
 * hand, so this file checks what the server carries and records, never what the page draws (tests/studio-drafts-browser.test.ts
 * runs the real page in Chromium).
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCanvasTools } from '../src/agent/canvas-tools.js';
import { projectId } from '../src/project/index.js';
import { startStudioServer, type StudioServer } from '../src/studio/server.js';
import { bearer, call, exec, fakePage, nameProject, pageSession } from './helpers/canvas-auth.js';
import { guardRealHome } from './fixtures/home-guard.js';

const realHome = guardRealHome();
afterAll(() => { expect(realHome.check(), 'changed under the real home\'s timmy folders while these tests ran').toEqual([]); });

const SOURCE = 'ab'.repeat(32);
let server: StudioServer;
let home = '';
let port = 0;
const sockets: Array<{ close: () => void }> = [];
beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'studio-drafts-home-'));
  server = await startStudioServer(0, { env: { HOME: home, TIMMY_HOME: home } });
  port = (server.address() as AddressInfo).port;
  await nameProject(port, server.projectToken, { root: home, name: 'drafts' });
});
afterEach(async () => {
  for (const s of sockets.splice(0)) s.close();
  await new Promise<void>((done) => server.close(() => done()));
  rmSync(home, { recursive: true, force: true });
});
/** R6 (H139): the project named here (its folder is the test's home), and its own board's folder, where its records are */
const drafts = () => ({ id: projectId(home), name: 'drafts' });
const canvasDir = () => join(home, 'canvas', 'projects', projectId(home));
const records = () => (existsSync(join(canvasDir(), 'drafts.jsonl')) ? readFileSync(join(canvasDir(), 'drafts.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>) : []);
type Seen = { id: number; code: string; jobId: string; draft?: { id: string; baseRevision: number | null } };

/** A FAKE page that answers each call with `reply(message)`, as the real page would after its save. */
async function page(reply: (m: Seen) => Record<string, unknown>): Promise<Seen[]> {
  const session = await pageSession(port, server.projectToken);
  const p = await fakePage(port, { session, answer: (m) => reply(m as Seen) });
  sockets.push({ close: () => p.ws.terminate() });
  return p.seen as Seen[];
}

describe('a call sent as a draft', () => {
  it('reaches the page with a draft id the server made and the revision it was made from; the page\'s draft answer comes back and is recorded as proposed', async () => {
    const seen = await page((m) => ({ ok: true, result: 'drawn', revision: 6, sourceRevision: SOURCE, changed: true, draft: { id: m.draft!.id, shapes: 2, from: 4 } }));
    const r = await exec(port, server.projectToken, { code: 'return 1', jobId: 'turn-a', draft: true, baseRevision: 4 });
    expect(r.status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0].draft).toEqual({ id: expect.stringMatching(/^draft-[0-9a-f]{12}$/), baseRevision: 4 });
    expect(r.json).toEqual({ ok: true, result: 'drawn', jobId: 'turn-a', revision: 6, sourceRevision: SOURCE, changed: true, draft: { id: seen[0].draft!.id, shapes: 2, from: 4 }, project: drafts() });
    expect(records()).toEqual([{ draft: seen[0].draft!.id, event: 'proposed', job: 'turn-a', shapes: 2, from: 4, revision: 6, sourceRevision: SOURCE, project: drafts().id, at: expect.any(String) }]);
    expect(statSync(join(canvasDir(), 'drafts.jsonl')).mode & 0o777).toBe(0o600);
  });
  it('takes the page\'s refusal of a stale draft (nothing ran), records it with why, and keeps no draft of another call\'s', async () => {
    await page((m) => ({ ok: false, error: 'Refused: this draft was made from revision 1, but the canvas is at revision 3 now.', stale: true, revision: 3, sourceRevision: SOURCE, changed: false, draft: { id: m.draft!.id, refused: 'stale', from: 1, now: 3 } }));
    const r = await exec(port, server.projectToken, { code: 'return 1', jobId: 'turn-b', draft: true, baseRevision: 1 });
    expect(r.json).toMatchObject({ ok: false, stale: true, draft: { refused: 'stale', from: 1, now: 3 } });
    expect(records()).toEqual([expect.objectContaining({ event: 'refused', reason: 'stale', job: 'turn-b', shapes: 0, from: 1, why: expect.stringMatching(/^Refused: this draft was made from revision 1/) })]);
    // an answer naming another draft's id, or a stale flag on a call that was not a draft, is not taken
    sockets.splice(0).forEach((s) => s.close());
    await page(() => ({ ok: false, error: 'x', stale: true, revision: 3, sourceRevision: SOURCE, draft: { id: 'draft-000000000000', refused: 'stale' } }));
    const plain = await exec(port, server.projectToken, { code: 'return 1', jobId: 'turn-c' });
    expect(plain.json.draft).toBeUndefined();
    expect(plain.json.stale).toBeUndefined();
    expect(records()).toHaveLength(1);
  });
  it('is not a draft unless asked: the page gets no draft, and nothing is recorded', async () => {
    const seen = await page(() => ({ ok: true, result: 1, revision: 1, sourceRevision: SOURCE, changed: true }));
    await exec(port, server.projectToken, { code: 'return 1', jobId: 'turn-d' });
    expect(seen[0].draft).toBeUndefined();
    expect(records()).toEqual([]);
  });
  it('refuses a draft flag or a base revision that is not one', async () => {
    for (const [body, words] of [[{ draft: 'yes' }, /^draft is true/], [{ draft: true, baseRevision: -1 }, /^baseRevision is the canvas revision/], [{ draft: true, baseRevision: 1.5 }, /^baseRevision/]] as const) {
      const r = await exec(port, server.projectToken, { code: 'return 1', ...body });
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(String(r.json.error)).toMatch(words);
    }
  });
  it("the agent's canvas_exec sends a draft by default, from the revision the last answer named; draft: false sends none", async () => {
    const seen = await page((m) => ({ ok: true, result: 1, revision: 8, sourceRevision: SOURCE, changed: true, ...(m.draft ? { draft: { id: m.draft.id, shapes: 1, from: m.draft.baseRevision ?? 7 } } : {}) }));
    const tools = createCanvasTools({ baseUrl: `http://127.0.0.1:${port}`, auth: () => ({ token: server.projectToken, holder: null }) });
    const run = (name: string, args: Record<string, unknown>) => (tools.find((t) => t.function.name === name)!.function.execute as (a: unknown) => Promise<Record<string, unknown>>)(args);
    const first = await run('canvas_exec', { code: 'return 1' });
    expect(first).toMatchObject({ ok: true, draft: { shapes: 1 } });
    expect(seen[0].draft).toEqual({ id: expect.stringMatching(/^draft-/), baseRevision: null });
    await run('canvas_exec', { code: 'return 2' });
    expect(seen[1].draft).toEqual({ id: expect.stringMatching(/^draft-/), baseRevision: 8 });
    await run('canvas_exec', { code: 'return 3', baseRevision: 5 });
    expect(seen[2].draft!.baseRevision).toBe(5);
    await run('canvas_exec', { code: 'return 4', draft: false });
    expect(seen[3].draft).toBeUndefined();
    // reading draws nothing, so it is never a draft; listing the project's cards neither, placing one is
    await run('canvas_read', {});
    expect(seen[4].draft).toBeUndefined();
    await run('canvas_place_project_card', {});
    expect(seen[5].draft).toBeUndefined();
    await run('canvas_place_project_card', { card: 'flow:f1a2b3c4d' });
    expect(seen[6].draft).toEqual({ id: expect.stringMatching(/^draft-/), baseRevision: 8 });
    // a REPL whose tools are made without drafts sends none
    const plain = createCanvasTools({ baseUrl: `http://127.0.0.1:${port}`, drafts: false, auth: () => ({ token: server.projectToken, holder: null }) });
    await (plain.find((t) => t.function.name === 'canvas_exec')!.function.execute as (a: unknown) => Promise<unknown>)({ code: 'return 5' });
    expect(seen[7].draft).toBeUndefined();
  });
});

describe('a decision on a draft', () => {
  const save = async (revision: number, base: number) => call(port, 'PUT', '/api/canvas/document', { headers: { ...bearer(server.projectToken), 'Content-Type': 'application/json' }, body: JSON.stringify({ snapshot: { store: {}, schema: { schemaVersion: 2, sequences: {} } }, revision, baseRevision: base }) });
  const decide = (token: string | null, body: Record<string, unknown>) => call(port, 'POST', '/api/canvas/drafts', { headers: { 'Content-Type': 'application/json', ...(token ? bearer(token) : {}) }, body: JSON.stringify(body) });
  it('is recorded with the save that holds it, by a page with a session (or the REPL\'s token), and runs nothing', async () => {
    const saved = await save(3, 0);
    expect(saved.status).toBe(200);
    const jobsBefore = existsSync(join(canvasDir(), 'jobs.json'));
    const canvasBefore = readFileSync(join(canvasDir(), 'canvas.json'), 'utf8');
    const session = await pageSession(port, server.projectToken);
    const body = { draft: 'draft-0a1b2c3d4e5f', decision: 'accepted', shapes: 2, job: 'turn-a', from: 1, at: '2026-10-15T20:00:00.000Z', revision: 3, sourceRevision: saved.json.sourceRevision };
    const r = await decide(session, body);
    expect(r.status).toBe(200);
    expect(r.json.recorded).toEqual({ draft: 'draft-0a1b2c3d4e5f', event: 'accepted', job: 'turn-a', shapes: 2, from: 1, revision: 3, sourceRevision: saved.json.sourceRevision, by: 'page', proposed: false, project: drafts().id, at: '2026-10-15T20:00:00.000Z' });
    expect((await decide(server.projectToken, { ...body, decision: 'discarded' })).json.recorded).toMatchObject({ event: 'discarded', by: 'token' });
    expect(records().map((x) => x.event)).toEqual(['accepted', 'discarded']);
    // nothing else was touched: no job, and the canvas file is as the save left it
    expect(existsSync(join(canvasDir(), 'jobs.json'))).toBe(jobsBefore);
    expect(readFileSync(join(canvasDir(), 'canvas.json'), 'utf8')).toBe(canvasBefore);
    // the record is read with the same credentials
    expect((await call(port, 'GET', '/api/canvas/drafts', { headers: bearer(session) })).json.drafts).toHaveLength(2);
    expect((await call(port, 'GET', '/api/canvas/drafts')).status).toBe(401);
  });
  it('is refused without credentials, with a field it does not know, in a shape it does not take, or for a save not on disk', async () => {
    await save(3, 0);
    const good = { draft: 'draft-0a1b2c3d4e5f', decision: 'discarded', shapes: 1, job: null, from: null, revision: 3, sourceRevision: SOURCE };
    expect((await decide(null, good)).status).toBe(401);
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ ...good, extra: 1 }, /^Unknown field: "extra"/],
      [{ ...good, draft: 'draft-XYZ' }, /^draft is the draft's id/],
      [{ ...good, decision: 'maybe' }, /^decision is accepted or discarded/],
      [{ ...good, shapes: -1 }, /^shapes is how many/],
      [{ ...good, job: 'bad job id' }, /^job is the draft's job id/],
      [{ ...good, sourceRevision: 'nope' }, /^revision and sourceRevision/],
    ];
    for (const [body, words] of cases) {
      const r = await decide(server.projectToken, body);
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(String(r.json.error)).toMatch(words);
    }
    const ahead = await decide(server.projectToken, { ...good, revision: 9 });
    expect(ahead.status).toBe(409);
    expect(records()).toEqual([]);
  });
});

describe("a page's copy, kept when a newer canvas is on disk", () => {
  const snapshot = { store: { 'shape:a': { id: 'shape:a', typeName: 'shape' } }, schema: { schemaVersion: 2, sequences: {} } };
  const keep = (token: string | null, body: unknown) => call(port, 'POST', '/api/canvas/document/copy', { headers: { 'Content-Type': 'application/json', ...(token ? bearer(token) : {}) }, body: JSON.stringify(body) });
  it('goes beside the canvas file, readable by its owner only, and never touches the canvas file', async () => {
    const put = await call(port, 'PUT', '/api/canvas/document', { headers: { ...bearer(server.projectToken), 'Content-Type': 'application/json' }, body: JSON.stringify({ snapshot: { store: {}, schema: {} }, revision: 9, baseRevision: 0 }) });
    expect(put.status).toBe(200);
    const before = readFileSync(join(canvasDir(), 'canvas.json'), 'utf8');
    const session = await pageSession(port, server.projectToken);
    const r = await keep(session, { snapshot, revision: 5, baseRevision: 4 });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ ok: true, kept: expect.stringMatching(/^copies\/canvas-r5-.+\.json$/), revision: 5, sourceRevision: expect.stringMatching(/^[0-9a-f]{64}$/), path: expect.stringContaining('copies') });
    const file = join(canvasDir(), String(r.json.kept));
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ format: 'timmy-canvas-copy', revision: 5, baseRevision: 4, snapshot });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(canvasDir(), 'canvas.json'), 'utf8')).toBe(before);
    expect((await keep(null, { snapshot, revision: 5, baseRevision: 4 })).status).toBe(401);
    expect((await keep(session, { snapshot: 'x', revision: 5, baseRevision: 4 })).status).toBe(400);
  });
  it('asks for room once the folder holds as many copies as it keeps', async () => {
    const copies = join(canvasDir(), 'copies');
    const { mkdirSync } = await import('node:fs');
    mkdirSync(copies, { recursive: true });
    for (let i = 0; i < 50; i++) writeFileSync(join(copies, `canvas-r${i}-x.json`), '{}');
    const r = await keep(server.projectToken, { snapshot, revision: 1, baseRevision: 0 });
    expect(r.status).toBe(507);
    expect(String(r.json.error)).toMatch(/^Timmy keeps at most 50 copies of the canvas/);
    expect(readdirSync(copies)).toHaveLength(50);
  });
});
