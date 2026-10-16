/**
 * R5 (H133): GET /api/workspace, the shared workspace frame (src/contracts/workspace.ts, made by src/ops/workspace-frame.ts from
 * the records) of the project named to the canvas, which the canvas page draws as the strip above tldraw. Read with the server's
 * token or a page session that counts now, as the canvas's own routes are; refused in words otherwise.
 *
 * Real HTTP to a real canvas server on 127.0.0.1, sessions made by its own grant and session routes (tests/helpers/canvas-auth.ts),
 * temporary folders only. The observations of Studio are a record a test writes (FAKE: no request was made to a Studio) and,
 * in one test (R5 lead), the record this Studio writes when it answers its page as the Studio the frame names.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer as createNetServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { TABS } from '../src/contracts/workspace.js';
import { writeConnections, readConnections, CONNECTIONS_SCHEMA, LIVE_FOR_MS, SELF_NOTE_MS } from '../src/ops/workspace-frame.js';
import { projectId } from '../src/project/index.js';
import { WORKSPACE_REFUSED } from '../src/studio/canvas-auth.js';
import { startStudioServer, type StudioServer } from '../src/studio/server.js';
import { bearer, call, nameProject, pageSession } from './helpers/canvas-auth.js';

const temps: string[] = [];
const temp = (prefix: string): string => { const d = mkdtempSync(join(tmpdir(), prefix)); temps.push(d); return d; };
const servers: StudioServer[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise<void>((done) => s.close(() => done()));
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
});

const HX = 'a'.repeat(32);
const HY = 'b'.repeat(32);

/** a port nothing listens on now (asked of the system, then let go), for a Studio that is the one the frame names */
const freePort = (): Promise<number> => new Promise((resolve, reject) => {
  const s = createNetServer();
  s.once('error', reject);
  s.listen(0, '127.0.0.1', () => { const p = (s.address() as AddressInfo).port; s.close(() => resolve(p)); });
});

async function world(o: { framesOwnPort?: boolean } = {}) {
  const home = temp('workspace-home-');
  // the frame reads Timmy's settings: this file's own folder (tests/isolation-setup.ts), never the account's
  const env: Record<string, string | undefined> = { TIMMY_HOME: home, HOME: home, TIMMY_SETTINGS_DIR: process.env.TIMMY_SETTINGS_DIR };
  // R5 lead: by default a Studio on a port of its own (0), so not the Studio the frame names (TIMMY_STUDIO_PORT, else 4337)
  const at = o.framesOwnPort ? await freePort() : 0;
  if (o.framesOwnPort) env.TIMMY_STUDIO_PORT = String(at);
  const server = await startStudioServer(at, { env });
  servers.push(server);
  const port = (server.address() as AddressInfo).port;
  const base = temp('workspace-projects-');
  const project = (name: string) => { const root = join(base, name); mkdirSync(root, { recursive: true }); return { root, name, id: projectId(root) }; };
  return { server, port, token: server.projectToken, env, project };
}

describe('GET /api/workspace: the shared frame of the project named now, for the token or a page session', () => {
  it('refuses a caller with no credential, and one whose session is not one this server made (401, in words)', async () => {
    const w = await world();
    const demo = w.project('demo');
    await nameProject(w.port, w.token, { root: demo.root, name: demo.name, holder: HX });
    const none = await call(w.port, 'GET', '/api/workspace');
    expect(none.status).toBe(401);
    expect(none.json).toMatchObject({ ok: false, error: WORKSPACE_REFUSED, session: 'none' });
    expect(none.body).not.toContain(demo.root);
    const forged = await call(w.port, 'GET', '/api/workspace', { headers: bearer('f'.repeat(64)) });
    expect(forged.status).toBe(401);
    expect(forged.json.ok).toBe(false);
    expect(String(forged.json.error)).toMatch(/\/canvas open/);
    expect(forged.body).not.toContain(demo.name);
  });

  it('serves a page session the frame of the project named: its name and id, the ten tabs, Studio\'s actions with one primary', async () => {
    const w = await world();
    const demo = w.project('demo');
    await nameProject(w.port, w.token, { root: demo.root, name: demo.name, holder: HX });
    const s = await pageSession(w.port, w.token);
    const r = await call(w.port, 'GET', '/api/workspace', { headers: bearer(s) });
    expect(r.status).toBe(200);
    expect(r.headers['cache-control']).toBe('no-store');
    const frame = r.json.frame as Record<string, any>;
    expect(r.json.ok).toBe(true);
    expect(frame).toMatchObject({ schema: 'timmy.workspace/1', version: 1, project: { name: 'demo', id: demo.id, chosen: true } });
    expect(frame.revision).toMatch(/^[0-9a-f]{16}$/);
    expect(frame.tabs.map((t: { id: string; key: string }) => `${t.key} ${t.id}`)).toEqual(TABS.map((t) => `${t.key} ${t.id}`));
    const studio = frame.actions.studio as Array<{ label: string; command: string; primary: boolean }>;
    expect(studio.filter((a) => a.primary)).toHaveLength(1);
    // nothing observed Studio yet: the frame's own next step is to open it
    expect(studio.find((a) => a.primary)).toMatchObject({ label: 'Open Studio', command: '/studio' });
    expect(frame.activity).toMatchObject({ running: 0, waitingOnYou: 0, stopCurrent: { job: null } });
    // the same records, the same revision (a reader redraws only on a new one)
    const again = await call(w.port, 'GET', '/api/workspace', { headers: bearer(s) });
    expect(again.json.frame.revision).toBe(frame.revision);
    // a Studio other than the one the frame names (its port) records nothing about Studio
    expect(readConnections(w.env).checks.studio).toBeUndefined();
  });

  it('the Studio the frame names, answering its page, is an answer observed now: Studio answered, and its next step is to have Timmy draw', async () => {
    const w = await world({ framesOwnPort: true });
    const demo = w.project('demo');
    await nameProject(w.port, w.token, { root: demo.root, name: demo.name, holder: HX });
    const s = await pageSession(w.port, w.token);
    const r = await call(w.port, 'GET', '/api/workspace', { headers: bearer(s) });
    expect(r.status).toBe(200);
    const frame = r.json.frame as Record<string, any>;
    const studio = frame.actions.studio as Array<{ label: string; command: string; primary: boolean }>;
    expect(studio.filter((a) => a.primary)).toEqual([expect.objectContaining({ label: 'Ask Timmy to draw: /canvas open in the REPL, then ask', command: '/canvas open' })]);
    expect(frame.connections.find((c: { id: string }) => c.id === 'studio')).toMatchObject({ state: 'live', words: 'answered just now (the canvas page asked for its frame)' });
    const noted = readConnections(w.env).checks.studio!;
    expect(noted).toMatchObject({ answer: 'accepted', detail: 'the canvas page asked for its frame' });
    // noted at most once in SELF_NOTE_MS: a page asking again soon leaves the record (and so the frame's revision) as it was
    const again = await call(w.port, 'GET', '/api/workspace', { headers: bearer(s) });
    expect(readConnections(w.env).checks.studio!.at).toBe(noted.at);
    expect(again.json.frame.revision).toBe(frame.revision);
    expect(SELF_NOTE_MS).toBeLessThan(LIVE_FOR_MS);
  });

  it('with Studio observed live (a FAKE check record), Studio\'s next step is to have Timmy draw on it', async () => {
    const w = await world();
    const demo = w.project('demo');
    await nameProject(w.port, w.token, { root: demo.root, name: demo.name, holder: HX });
    writeConnections({ schema: CONNECTIONS_SCHEMA, checks: { studio: { answer: 'accepted', at: new Date().toISOString(), detail: 'FAKE: written by the test' } } }, w.env);
    const r = await call(w.port, 'GET', '/api/workspace', { headers: bearer(await pageSession(w.port, w.token)) });
    expect(r.status).toBe(200);
    const studio = r.json.frame.actions.studio as Array<{ label: string; command: string; primary: boolean }>;
    expect(studio.filter((a) => a.primary)).toEqual([expect.objectContaining({ label: 'Ask Timmy to draw: /canvas open in the REPL, then ask', command: '/canvas open' })]);
  });

  it('serves the token too; with no project named there is none to show (404, in words)', async () => {
    const w = await world();
    const unnamed = await call(w.port, 'GET', '/api/workspace', { headers: bearer(w.token) });
    expect(unnamed.status).toBe(404);
    expect(unnamed.json).toMatchObject({ ok: false, error: expect.stringMatching(/^No project is named to this canvas/) });
    const demo = w.project('demo');
    await nameProject(w.port, w.token, { root: demo.root, name: demo.name, holder: HX });
    const named = await call(w.port, 'GET', '/api/workspace', { headers: bearer(w.token) });
    expect(named.status).toBe(200);
    expect(named.json.frame.project).toMatchObject({ name: 'demo', id: demo.id });
  });

  it('a session given for another project than the one named now (by another REPL) is refused, and told nothing of it', async () => {
    const w = await world();
    const demo = w.project('demo');
    await nameProject(w.port, w.token, { root: demo.root, name: demo.name, holder: HX });
    const s = await pageSession(w.port, w.token);
    const other = w.project('other');
    await nameProject(w.port, w.token, { root: other.root, name: other.name, holder: HY });
    const r = await call(w.port, 'GET', '/api/workspace', { headers: bearer(s) });
    expect(r.status).toBe(401);
    expect(r.json).toMatchObject({ ok: false, session: 'project' });
    expect(r.body).not.toContain(other.root);
    expect(r.json.frame).toBeUndefined();
  });
});
