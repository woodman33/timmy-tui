// R6 (H140; the R5 interaction review, claim c and REMAINING-DEFECTS #4 and #33): a connection is green "live" only while a
// current observation says it answered, at the address the frame names. A local surface's start is no answer; an answer is
// current for SURFACE_LIVE_MS (said on the card); a server killed before it could note its stop is seen gone by its process.
//
// FAKE pieces, labelled: the observations of the unit tests (records written by Timmy's own writer, their answers made up),
// and their process seam (`alive`). Real in the last test: a browser companion in a process of its own (tests/fixtures/
// h140-companion-child.mts), asked over HTTP with its token as its page asks it, then killed with SIGKILL, and the frame's
// own process check (src/ops/process-proof.ts writerState, which reads ps).
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { WorkspaceFrame } from '../src/contracts/workspace.js';
import {
  CONNECTIONS_SCHEMA, SELF_NOTE_MS, SURFACE_LIVE_MS, buildWorkspaceFrame, noteAnswered, noteListening, readConnections, surfaceConnectionOf, writeConnections,
  type ProcessAlive,
} from '../src/ops/workspace-frame.js';

let home: string;
let project: string;
let env: Record<string, string | undefined>;
const NOW = Date.parse('2026-10-16T18:00:00.000Z');
const children: ChildProcess[] = [];

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'h140-live-'));
  project = join(home, 'proj');
  mkdirSync(join(project, '.timmy', 'receipts'), { recursive: true });
  env = { HOME: home, TIMMY_HOME: join(home, 'timmy'), TIMMY_SETTINGS_DIR: join(home, 'settings'), PATH: process.env.PATH };
});
afterEach(() => {
  for (const c of children.splice(0)) { try { c.kill('SIGKILL'); } catch { /* ended */ } }
  rmSync(home, { recursive: true, force: true });
});

const frame = (now = NOW, alive?: ProcessAlive): Promise<WorkspaceFrame> =>
  buildWorkspaceFrame({ env, cwd: project, jobs: () => [], chain: () => [], onPath: () => null, now, ...(alive ? { alive } : {}) });
const card = (f: WorkspaceFrame, id: 'companion' | 'studio') => f.connections.find((c) => c.id === id)!;
const at = (msAgo: number): string => new Date(NOW - msAgo).toISOString();

describe('a local surface, from its last observation (FAKE observations, FAKE process seam)', () => {
  const base = { now: NOW, setup: 'timmy watch', startWords: 'c in the Workbench, or timmy watch, starts it' };
  const alive = () => 'alive' as const;
  const gone = () => 'gone' as const;
  it('a start record is no answer: listening, not live, and it says nothing has asked it', () => {
    const c = surfaceConnectionOf('companion', 'Browser companion', { ...base, alive, check: { answer: 'listening', at: at(2000), detail: 'it started listening', pid: 4242, started: at(3000) } });
    expect(c).toMatchObject({ state: 'configured', words: 'listening, since it started just now; nothing has asked it since, so not live: a page, or timmy workspace check, asks it' });
    // Studio's words say its canvas server listens, never that anyone opened Studio
    const s = surfaceConnectionOf('studio', 'Timmy Studio (tldraw)', { ...base, alive, check: { answer: 'listening', at: at(2000), detail: 'it started listening', pid: 4242, started: at(3000) } });
    expect(s).toMatchObject({ state: 'configured', words: 'its canvas server is listening, since it started just now; nothing has asked it since, so not live: a page, or timmy workspace check, asks it' });
    expect(`${c.words} ${s.words}`).not.toMatch(/opened|; live:/);
  });
  it('an answer its process noted is live within the bound the card states; older, not live, and it names the check', () => {
    const answered = { answer: 'accepted' as const, detail: 'its page asked for its frame', pid: 4242, started: at(99_000) };
    expect(surfaceConnectionOf('companion', 'Browser companion', { ...base, alive, check: { ...answered, at: at(SURFACE_LIVE_MS - 1000) } }))
      .toMatchObject({ state: 'live', words: 'answered just now (its page asked for its frame); live: an answer within the last 60 s' });
    // at the bound itself still live; the words say its age as every card does (minutes from 60 s)
    expect(surfaceConnectionOf('companion', 'Browser companion', { ...base, alive, check: { ...answered, at: at(SURFACE_LIVE_MS) } }).state).toBe('live');
    expect(surfaceConnectionOf('companion', 'Browser companion', { ...base, alive, check: { ...answered, at: at(SURFACE_LIVE_MS + 1000) } }))
      .toMatchObject({ state: 'configured', words: 'last answered 1 min ago (its page asked for its frame); not live: no answer in the last 60 s (timmy workspace check asks it now)' });
    expect(surfaceConnectionOf('studio', 'Timmy Studio (tldraw)', { ...base, alive, check: { ...answered, detail: 'the canvas page asked for its frame', at: at(5000) } }).words)
      .toBe('its canvas server answered just now (the canvas page asked for its frame); live: an answer within the last 60 s');
    // a check names no process: its answer counts for the same bound
    expect(surfaceConnectionOf('companion', 'Browser companion', { ...base, check: { answer: 'accepted', at: at(5000), detail: 'running' } }))
      .toMatchObject({ state: 'live', words: 'answered just now (running); live: an answer within the last 60 s' });
    expect(surfaceConnectionOf('companion', 'Browser companion', { ...base, check: { answer: 'accepted', at: at(10 * 60_000), detail: 'running' } }).state).toBe('configured');
  });
  it('killed before it could note its stop: its process is gone, so it is not running at once, whatever the time', () => {
    const c = surfaceConnectionOf('companion', 'Browser companion', { ...base, alive: gone, check: { answer: 'accepted', at: at(1000), detail: 'its page asked for its frame', pid: 4242, started: at(99_000) } });
    expect(c).toMatchObject({ state: 'configured', words: 'not running: the process that served it ended without noting its stop; it last answered just now (its page asked for its frame); c in the Workbench, or timmy watch, starts it' });
    const l = surfaceConnectionOf('studio', 'Timmy Studio (tldraw)', { ...base, startWords: 's starts it', alive: gone, check: { answer: 'listening', at: at(1000), pid: 4242, started: at(2000) } });
    expect(l.words).toBe('not running: the process that served it ended without noting its stop; its canvas server started listening just now and nothing had asked it; s starts it');
  });
});

describe('the frame\'s cards and surfaces (FAKE observations; this process notes its own, as a surface does)', () => {
  beforeEach(() => { env.TIMMY_COMPANION_PORT = '3999'; });
  it('noteListening and noteAnswered name this process; the frame follows them, and the surface runs only while it listens or answers', async () => {
    const t = Date.now();
    expect(noteListening('companion', env, t)).toBe(true);
    expect(readConnections(env).checks.companion).toMatchObject({ answer: 'listening', pid: process.pid, asked: 'http://127.0.0.1:3999' });
    let f = await frame(t + 1000);
    expect(card(f, 'companion').state).toBe('configured');
    expect(f.surfaces.companion).toMatchObject({ state: 'running', url: 'http://127.0.0.1:3999/' });
    expect(f.connections.filter((c) => c.state === 'live')).toEqual([]);
    // the start words, as the servers pass them, are a listening note too (never an answer)
    expect(noteAnswered('companion', 'it started listening', env, t + 2000)).toBe(true);
    expect(readConnections(env).checks.companion?.answer).toBe('listening');
    // its page asked: an answer; a second within SELF_NOTE_MS writes nothing
    expect(noteAnswered('companion', 'its page asked for its frame', env, t + 3000)).toBe(true);
    expect(noteAnswered('companion', 'its page asked for its frame', env, t + 3000 + SELF_NOTE_MS - 1)).toBe(false);
    f = await frame(t + 4000);
    expect(card(f, 'companion')).toMatchObject({ state: 'live', words: 'answered just now (its page asked for its frame); live: an answer within the last 60 s' });
    // nothing asked it for longer than the bound: not live, said how old
    f = await frame(t + 3000 + SURFACE_LIVE_MS + 5000);
    expect(card(f, 'companion')).toMatchObject({ state: 'configured', words: expect.stringMatching(/^last answered 1 min ago \(its page asked for its frame\); not live: no answer in the last 60 s/) });
    expect(f.surfaces.companion).toMatchObject({ state: 'unknown', url: null });
  });
  it('a note of a process that is gone (the seam says so) is not running at once, and the frame says no surface runs', async () => {
    writeConnections({ schema: CONNECTIONS_SCHEMA, checks: { companion: { answer: 'accepted', at: at(1000), detail: 'its page asked for its frame', asked: 'http://127.0.0.1:3999', pid: 4242, started: at(60_000) } } }, env);
    const f = await frame(NOW, () => 'gone');
    expect(card(f, 'companion')).toMatchObject({ state: 'configured', words: expect.stringMatching(/^not running: the process that served it ended without noting its stop; /) });
    expect(f.surfaces.companion).toMatchObject({ state: 'not running', url: null });
  });
});

/** A port nothing listens on now. */
const freePort = (): Promise<number> => new Promise((resolve, reject) => {
  const s = createServer();
  s.once('error', reject);
  s.listen(0, '127.0.0.1', () => { const a = s.address(); const p = typeof a === 'object' && a ? a.port : 0; s.close(() => resolve(p)); });
});
const LOADER = createRequire(import.meta.url).resolve('tsx');
const CHILD = join(import.meta.dirname, 'fixtures', 'h140-companion-child.mts');

/** A real companion in its own process at the address the frame names; resolves with its first line (its token kept in memory). */
async function companionChild(): Promise<{ child: ChildProcess; port: number; token: string; pid: number; exited: Promise<void> }> {
  const port = await freePort();
  env.TIMMY_COMPANION_PORT = String(port);
  env.TIMMY_REPO = project;
  const child = spawn(process.execPath, ['--import', LOADER, CHILD], { cwd: project, env: env as NodeJS.ProcessEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  let err = '';
  child.stderr!.setEncoding('utf8').on('data', (d: string) => { err += d; });
  const line = await new Promise<string>((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => reject(new Error(`the companion child said nothing in 30 s: ${err.slice(-400)}`)), 30_000);
    child.stdout!.setEncoding('utf8').on('data', (d: string) => { out += d; const i = out.indexOf('\n'); if (i >= 0) { clearTimeout(timer); resolve(out.slice(0, i)); } });
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`the companion child ended (${code}): ${err.slice(-400)}`)); });
  });
  const hello = JSON.parse(line) as { port: number; url: string; pid: number };
  return { child, port: hello.port, token: /#t=([0-9a-f]{64})$/.exec(hello.url)![1], pid: hello.pid, exited };
}

describe('a real companion in a process of its own, killed with SIGKILL (the R5 review\'s claim c)', () => {
  it('listening is not live; answering its page is live, with the bound; killed, it is not running at once and never green', async () => {
    const c = await companionChild();
    expect(c.port).toBe(Number(env.TIMMY_COMPANION_PORT));
    // its start note: listening, by its own process
    expect(readConnections(env).checks.companion).toMatchObject({ answer: 'listening', pid: c.pid });
    let f = await frame(Date.now());
    expect(card(f, 'companion')).toMatchObject({ state: 'configured', words: expect.stringMatching(/^listening, since it started just now; nothing has asked it since, so not live/) });
    expect(f.surfaces.companion.state).toBe('running');
    // its page asks for its frame (as companion.js does, with the token)
    const r = await fetch(`http://127.0.0.1:${c.port}/api/workspace`, { headers: { Authorization: `Bearer ${c.token}` } });
    expect(r.status).toBe(200);
    const served = await r.json() as WorkspaceFrame;
    expect(card(served, 'companion')).toMatchObject({ state: 'live', words: 'answered just now (its page asked for its frame); live: an answer within the last 60 s' });
    f = await frame(Date.now());
    expect(card(f, 'companion').state).toBe('live');
    // killed: no stop is noted, and the record still says it answered
    c.child.kill('SIGKILL');
    await c.exited;
    expect(readConnections(env).checks.companion).toMatchObject({ answer: 'accepted', pid: c.pid });
    f = await frame(Date.now());
    expect(card(f, 'companion')).toMatchObject({
      state: 'configured',
      words: 'not running: the process that served it ended without noting its stop; it last answered just now (its page asked for its frame); c in the Workbench, or timmy watch, starts it',
    });
    expect(f.surfaces.companion).toMatchObject({ state: 'not running', url: null });
    expect(f.connections.filter((x) => x.state === 'live').map((x) => x.id)).toEqual([]);
  }, 60_000);
});
