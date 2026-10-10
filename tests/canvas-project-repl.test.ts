/**
 * Round R4 (H55): the REPL's side. It names its active project to Timmy Canvas (with its own server's token, or the one a
 * canvas server of this Timmy home keeps), never to a canvas off this machine; `/canvas` names the project the canvas shows
 * and `/canvas open` names this REPL's first; the board says whether the canvas is open on this same project; /board live's
 * address (never its token) reaches a canvas that shows this project. A real canvas server on 127.0.0.1, real Workspaces on
 * temporary projects; the page on the bridge, where one is needed, is a FAKE one (a WebSocket, as tests/studio-tools.test.ts).
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { kit } from '../src/repl/board-kit.js';
import { renderBoardBody, type BoardInput } from '../src/repl/board.js';
import { CanvasProject } from '../src/repl/canvas-project.js';
import { canvasView } from '../src/repl/canvas-view.js';
import { Workspace } from '../src/repl/workspace.js';
import { folderProject, projectId } from '../src/project/index.js';
import { startStudioServer, type StudioServer } from '../src/studio/server.js';
import { glyphSet } from '../src/term/glyphs.js';
import { canvasLineHtml } from '../src/repl/board-canvas.js';

const temps: string[] = [];
const temp = (prefix: string): string => { const d = mkdtempSync(join(tmpdir(), prefix)); temps.push(d); return d; };
const text = (lines: Array<Array<{ text: string }>>): string[] => lines.map((l) => l.map((s) => s.text).join(''));

describe("the REPL names its project to Timmy Canvas, and says what the canvas shows", () => {
  let home = '';
  let server: StudioServer;
  let base = '';
  const sockets: WebSocket[] = [];
  beforeAll(async () => {
    home = temp('canvas-repl-home-');
    server = await startStudioServer(0, { env: { TIMMY_HOME: home }, projectTokenFile: true });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(() => { for (const s of sockets.splice(0)) s.terminate(); });
  afterAll(async () => {
    await new Promise<void>((done) => server.close(() => done()));
    for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const projectAt = (name: string): { root: string; name: string } => {
    const root = join(temp('canvas-repl-'), name);
    mkdirSync(root, { recursive: true });
    return { root, name };
  };
  const client = (p: { root: string; name: string }, o: { own?: boolean; home?: string; base?: string; board?: () => string | null; fetch?: typeof fetch } = {}) => new CanvasProject({
    base: () => o.base ?? base, env: { TIMMY_HOME: o.home ?? home }, project: () => p, projectId,
    jobsDir: join(home, 'jobs'), receipts: () => join(home, 'store'), board: o.board ?? (() => null),
    ownToken: () => (o.own ? server.projectToken : null), ...(o.fetch ? { fetch: o.fetch } : {}),
  });
  const shown = async (): Promise<Record<string, unknown>> => (await fetch(`${base}/api/project`)).json() as Promise<Record<string, unknown>>;
  /** FAKE page: a WebSocket on the bridge, so the canvas says a page is open. */
  const fakePage = async (): Promise<void> => {
    const ws = new WebSocket(`${base.replace('http', 'ws')}/bridge`, { origin: base });
    sockets.push(ws);
    await new Promise<void>((resolve, reject) => { ws.once('open', () => resolve()); ws.once('error', reject); });
  };

  it("names the project to its own server with its token; the board says the canvas shows it, then that it is open on it", async () => {
    const p = projectAt('alpha');
    const c = client(p, { own: true });
    expect(c.boardLine()).toEqual({ tone: 'unknown', words: 'Timmy Canvas: not checked yet.', command: '/canvas' });
    expect(await c.handOff()).toEqual({ ok: true, name: 'alpha' });
    expect(c.follows).toBe(true);
    expect((await shown()).project).toEqual({ name: 'alpha', id: projectId(p.root) });
    await c.check();
    expect(c.boardLine()).toEqual({ tone: 'same', words: 'Timmy Canvas shows this project; no canvas page is open.', command: '/canvas open' });
    await fakePage();
    await c.check();
    expect(c.boardLine()).toEqual({ tone: 'same', words: 'Timmy Canvas is open on this project.', command: '/canvas' });
  });

  it("without its own server, uses the token the canvas keeps for this Timmy home; another home's REPL gets none, says why and sends nothing", async () => {
    const p = projectAt('beta');
    expect(await client(p).handOff()).toEqual({ ok: true, name: 'beta' });
    const stranger = projectAt('gamma');
    const r = await client(stranger, { home: temp('canvas-repl-other-home-') }).handOff();
    expect(r).toEqual({ ok: false, why: 'this canvas keeps no token for this REPL (an older Timmy Canvas, or one of another Timmy home): restart it with timmy studio, or let /canvas start one here' });
    expect((await shown()).project).toEqual({ name: 'beta', id: projectId(p.root) });
  });

  it('never sends a folder to a canvas off this machine (TIMMY_STUDIO_URL elsewhere), nor even asks it', async () => {
    const calls: string[] = [];
    // FAKE fetch: records what would have gone out.
    const spy = (async (url: string) => { calls.push(String(url)); throw new Error('not sent in this test'); }) as unknown as typeof fetch;
    const c = client(projectAt('delta'), { base: 'http://canvas.example.test:4337', fetch: spy });
    expect(await c.handOff()).toEqual({ ok: false, why: 'this canvas is at TIMMY_STUDIO_URL, not on this machine, and is never sent a folder' });
    expect(await c.check()).toEqual({ state: 'remote' });
    expect(calls).toEqual([]);
    expect(c.boardLine()).toEqual({ tone: 'unknown', words: 'Timmy Canvas is at TIMMY_STUDIO_URL, not on this machine; it is not told which project is active.' });
  });

  it('another REPL names its project: this one stops following (a switch is not passed on), and its board says the canvas shows another project', async () => {
    const a = client(projectAt('one'), { own: true });
    const b = client(projectAt('two <img src=x>'), { own: true });
    expect((await a.handOff()).ok).toBe(true);
    await a.check();
    expect(a.follows).toBe(true);
    expect((await b.handOff()).ok).toBe(true);
    await a.check();
    expect(a.follows).toBe(false);
    expect(a.boardLine()).toEqual({ tone: 'other', words: 'Timmy Canvas shows another project (two <img src=x>), not this one.', command: '/canvas open' });
    // On the board, as text.
    const html = canvasLineHtml(a.boardLine(), kit({ live: false, base: '../../' }));
    expect(html).toBe('<p class="canvas-line canvas-other" id="canvas">Timmy Canvas shows another project (two &lt;img src=x&gt;), not this one. <button type="button" class="cmd" data-cmd="/canvas open" title="Copy this command"><code>/canvas open</code></button></p>');
  });

  it('a canvas that is not running: the board says so, and a handoff says it did not answer', async () => {
    const closed = await startStudioServer(0, { env: { TIMMY_HOME: temp('canvas-repl-closed-') } });
    const at = `http://127.0.0.1:${(closed.address() as AddressInfo).port}`;
    await new Promise<void>((done) => closed.close(() => done()));
    const c = client(projectAt('epsilon'), { base: at, own: true });
    expect(await c.check()).toEqual({ state: 'not-running' });
    expect(c.boardLine()).toEqual({ tone: 'off', words: 'Timmy Canvas is not running.', command: '/canvas open' });
    expect(await c.handOff()).toEqual({ ok: false, why: `Timmy Canvas did not answer at ${at}/` });
  });

  it('/canvas names the project the canvas shows; /canvas open names this REPL\'s first, then opens the page', async () => {
    const p = projectAt('zeta');
    const c = client(p, { own: true });
    const mine = { name: 'zeta', id: projectId(p.root) };
    const deps = {
      base, ensure: async () => ({ state: 'already-running' as const }), health: async () => ({ state: 'running' as const, pageConnected: false, built: true, revision: 0, jobs: 0, latestJob: null, tldrawVersion: '5.5.2' }),
      open: () => 'Opened in a test.', glyphs: glyphSet(true), project: { handOff: () => c.handOff(), check: () => c.check(), mine: () => mine },
    };
    // Another REPL's project is shown first.
    expect((await client(projectAt('other'), { own: true }).handOff()).ok).toBe(true);
    expect(text(await canvasView('', deps))).toContain('  Project  other · another project; /canvas open shows zeta there');
    expect(text(await canvasView('open', deps))).toEqual(['  Opened in a test.', '  Project  zeta · named to the canvas; its Project panel shows its cards']);
    expect(text(await canvasView('', deps))).toContain("  Project  zeta · this REPL's project, in its Project panel");
  });

  it("the Workspace: the board carries the canvas line; /board live's bare address reaches a canvas on this project, and /board off takes it away", async () => {
    const root = temp('canvas-repl-ws-');
    // Wired as src/repl/main.ts wires it: the project and the live board are the Workspace's, read when the canvas is told.
    let ws: Workspace | undefined;
    const linked = new CanvasProject({
      base: () => base, env: { TIMMY_HOME: home }, project: () => ws!.project, projectId, jobsDir: join(home, 'jobs'), receipts: () => join(home, 'store'),
      board: () => ws!.liveBoard?.address ?? null, ownToken: () => server.projectToken,
    });
    ws = new Workspace({
      glyphs: glyphSet(true), env: {}, onPath: () => null, notify: () => {}, openWeb: (url) => `Open ${url}`, link: (t) => t,
      seal: () => undefined, jobsDir: join(temp('canvas-repl-jobs-'), 'jobs'), chdir: () => {}, receipts: () => [], recoverAtStart: false,
      canvas: () => linked.boardLine(),
      onBoardLive: () => { if (linked.follows) void linked.handOff(); },
    }, folderProject(root));
    try {
      expect((await linked.handOff()).ok).toBe(true);
      await linked.check();
      // The snapshot board says the canvas shows this project.
      ws.board('');
      const snapshot = readFileSync(join(root, '.timmy', 'board', 'index.html'), 'utf8');
      expect(snapshot).toContain('<p class="canvas-line canvas-same" id="canvas">Timmy Canvas shows this project; no canvas page is open. <button type="button" class="cmd" data-cmd="/canvas open"');
      // /board live: its bare address is named to the canvas, never its token.
      await ws.boardLive('live');
      const board = ws.liveBoard!;
      for (let i = 0; i < 40 && !(await shown()).board; i++) await new Promise((r) => setTimeout(r, 50));
      expect((await shown()).board).toEqual({ address: board.address });
      expect(JSON.stringify(await shown())).not.toContain(board.url.split('#t=')[1]);
      // The live board's own state carries the same line (its sections, as the page draws them).
      const state = await (await fetch(`${board.address}state`, { headers: { Authorization: `Bearer ${board.url.split('#t=')[1]}` } })).json() as { html: string };
      expect(state.html).toContain('<p class="canvas-line canvas-same" id="canvas">Timmy Canvas shows this project; no canvas page is open.');
      await ws.boardLive('off');
      for (let i = 0; i < 40 && (await shown()).board; i++) await new Promise((r) => setTimeout(r, 50));
      expect((await shown()).board).toBeNull();
    } finally {
      await ws.close();
    }
  });

  it('renderBoardBody draws the line first, escaped, with its command; without one, no line', () => {
    const input: BoardInput = { project: 'p', madeAt: 'now', base: '../../', references: [], workflows: [], jobs: [], outputs: [], observations: [] };
    expect(renderBoardBody(input).main).not.toContain('canvas-line');
    const main = renderBoardBody({ ...input, canvas: { tone: 'none', words: 'Timmy Canvas runs; no project is named to it yet.', command: '/canvas open' } }).main;
    expect(main.startsWith('<p class="canvas-line canvas-none" id="canvas">Timmy Canvas runs; no project is named to it yet. <button type="button" class="cmd" data-cmd="/canvas open"')).toBe(true);
  });
});
