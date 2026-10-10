/**
 * Round R4 (H55): the REPL's side of "Timmy Canvas shows this project". The REPL names its active project to the canvas
 * server (POST /api/project/active with the server's token: src/studio/project-link.ts) on /canvas open, when the server is
 * this REPL's own as it starts, on a /project switch and when /board live starts or stops, the last three only while the
 * canvas still shows what this REPL named (another REPL may have named its own project since: then it is left to it).
 *
 * It names the project's folder, the jobs folder and the receipts store this REPL uses, so the server reads exactly what
 * this REPL reads, and only to a canvas on this machine (127.0.0.1, localhost or [::1]): a canvas at a TIMMY_STUDIO_URL
 * elsewhere is never sent a path. The token is the one the server this REPL started holds, or the one a canvas server of
 * this Timmy home keeps for its port (readProjectToken: a file whose process is gone is not used).
 *
 * It also asks the canvas what it shows (GET /api/project/active, every few seconds while the REPL runs), so /canvas and
 * the board can say whether the canvas is open on this same project (by the project's id, a hash of its folder).
 *
 * Round R4 (H75): a REPL given `act` (the Workspace's canvasAct) takes the actions of the canvas's drawn cards for the
 * project it names: it names itself with a random `holder` id in the handoff, then asks the canvas server for actions (GET
 * /api/project/inbox, a long poll, with the token and its holder id) while the canvas shows what it named, runs each through
 * `act` (the live board's own path, src/repl/canvas-actions.ts) and posts the answer back. It stops when the canvas says
 * another REPL (or none) holds the project, when the canvas goes away, and when the REPL ends. `/canvas open` asks the server
 * for a one-time grant and opens the page with it in the address's fragment (openTarget), so that page, and only a page
 * opened that way, can act; the grant is good once, for two minutes.
 */
import { randomBytes } from 'node:crypto';
import { canvasDir } from '../studio/document.js';
import { readProjectToken } from '../studio/project-link.js';
import type { BoardCanvas } from './board-canvas.js';

export interface CanvasProjectDeps {
  /** Timmy Canvas's address, without a trailing slash */
  base: () => string;
  env: Record<string, string | undefined>;
  /** the REPL's active project */
  project: () => { root: string; name: string };
  projectId: (root: string) => string;
  /** where this REPL keeps its job records */
  jobsDir: string;
  /** the receipts store this REPL seals to */
  receipts: () => string;
  /** /board live's bare address while it runs (never its token) */
  board: () => string | null;
  /** the token of the canvas server this REPL started, when it did */
  ownToken: () => string | null;
  fetch?: typeof fetch;
  /** R4 (H75): runs a drawn card's action through the live board's path (the Workspace's canvasAct); absent: this REPL takes none */
  act?: (envelope: unknown) => Promise<{ status: number; text: string }>;
  /** R4 (H75): how long one ask for actions waits at most (the server answers empty after 25 s) */
  pollMs?: number;
}

export type HandOff = { ok: true; name: string } | { ok: false; why: string };

/** What the canvas showed when it was last asked. */
export type CanvasSeen =
  | { state: 'unchecked' }
  | { state: 'remote' }
  | { state: 'not-running' }
  | { state: 'other'; detail: string }
  | { state: 'older' }
  | { state: 'running'; project: { name: string; id: string } | null; pageConnected: boolean; board: boolean };

const LOCAL = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i;
const SHORT_MS = 2000;
/** R4 (H75): a grant is kept for the page this long (the server keeps it for two minutes). */
const GRANT_KEEP_MS = 100_000;
const POLL_MS = 30_000;

export class CanvasProject {
  private seen: CanvasSeen = { state: 'unchecked' };
  /** the id of the project this REPL last named and the canvas accepted */
  private named: string | null = null;
  private checking?: Promise<CanvasSeen>;
  private timer?: NodeJS.Timeout;
  private closed = false;
  /** R4 (H75): this REPL's id as the holder of its project's card actions */
  readonly holder = randomBytes(16).toString('hex');
  private listening = false;
  private asking?: AbortController;
  private grant: { code: string; at: number } | null = null;
  /** R4 (H75): what the last ask for actions ended with (for /canvas and the tests) */
  private heard: 'not asked' | 'listening' | 'stopped: another REPL holds the project' | 'stopped: the canvas names no project now' | 'stopped: the canvas did not answer' | 'stopped: the REPL is ending' = 'not asked';

  constructor(private readonly d: CanvasProjectDeps) {}

  private get http(): typeof fetch { return this.d.fetch ?? fetch; }
  private base(): string { return this.d.base().replace(/\/+$/, ''); }

  /** Whether the canvas's address is on this machine (only such a canvas is named a project). */
  local(): boolean { return LOCAL.test(this.base()); }

  /** The canvas still shows the project this REPL named last (so a switch, or the board, is passed on). */
  get follows(): boolean {
    return this.named !== null && this.seen.state === 'running' && this.seen.project?.id === this.named;
  }

  /** The token for the canvas at the address: the REPL's own server's, else the one its server keeps for this Timmy home. */
  private token(): string | null {
    const own = this.d.ownToken();
    if (own) return own;
    const port = Number(new URL(this.base()).port || 80);
    return readProjectToken(canvasDir(this.d.env), port);
  }

  /** Names the active project to the canvas; says why not when it cannot. R4 (H75): `grant`, for /canvas open's page. */
  async handOff(o: { grant?: boolean } = {}): Promise<HandOff> {
    if (this.closed) return { ok: false, why: 'this REPL is ending' };
    if (!this.local()) return { ok: false, why: 'this canvas is at TIMMY_STUDIO_URL, not on this machine, and is never sent a folder' };
    const token = this.token();
    if (!token) return { ok: false, why: 'this canvas keeps no token for this REPL (an older Timmy Canvas, or one of another Timmy home): restart it with timmy studio, or let /canvas start one here' };
    const p = this.d.project();
    let res: Response;
    try {
      res = await this.http(`${this.base()}/api/project/active`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ root: p.root, name: p.name, jobs: this.d.jobsDir, receipts: this.d.receipts(), board: this.d.board(), ...(this.d.act ? { holder: this.holder } : {}) }),
        signal: AbortSignal.timeout(SHORT_MS),
      });
    } catch {
      return { ok: false, why: `Timmy Canvas did not answer at ${this.base()}/` };
    }
    let body: { ok?: unknown; error?: unknown; project?: { name?: unknown; id?: unknown }; board?: unknown } = {};
    try { body = await res.json() as typeof body; } catch { /* not JSON: an older canvas, or another program */ }
    if (res.status === 404 && body.ok === undefined) return { ok: false, why: 'this Timmy Canvas is older and cannot show projects: restart it' };
    if (!res.ok || body.ok !== true || typeof body.project?.id !== 'string' || typeof body.project?.name !== 'string') {
      return { ok: false, why: `the canvas refused it: ${typeof body.error === 'string' ? body.error : `HTTP ${res.status}`}` };
    }
    this.named = body.project.id;
    this.seen = { state: 'running', project: { name: body.project.name, id: body.project.id }, pageConnected: this.seen.state === 'running' ? this.seen.pageConnected : false, board: body.board === true };
    // R4 (H75): this REPL takes the project's card actions, and /canvas open's page gets its grant.
    if (this.d.act) void this.listen();
    if (o.grant) await this.askGrant(token);
    return { ok: true, name: body.project.name };
  }

  /** R4 (H75): a one-time grant for the page /canvas open opens (kept until openTarget takes it). */
  private async askGrant(token: string): Promise<void> {
    this.grant = null;
    try {
      const res = await this.http(`${this.base()}/api/project/grant`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(SHORT_MS) });
      const body = await res.json() as { ok?: unknown; grant?: unknown };
      if (res.ok && body.ok === true && typeof body.grant === 'string' && /^[0-9a-f]{32}$/.test(body.grant)) this.grant = { code: body.grant, at: Date.now() };
    } catch { /* an older canvas: its page opens without one, and its cards give the typed commands */ }
  }

  /**
   * R4 (H75): what /canvas open opens: the canvas's address with this REPL's grant in its fragment (a secret: opened through
   * a private launch page, never a command line), taken once; without a grant, the canvas's own address.
   */
  openTarget(): { target: string; secret: boolean } {
    const g = this.grant;
    this.grant = null;
    if (!g || Date.now() - g.at > GRANT_KEEP_MS) return { target: 'studio', secret: false };
    return { target: `${this.base()}/#code=${g.code}`, secret: true };
  }

  /** R4 (H75): what the last ask for the card actions ended with. */
  get actions(): string { return this.heard; }

  /**
   * R4 (H75): asks the canvas server for the drawn cards' actions (a long poll) while it gives them to this REPL, runs each
   * through `act` and posts its answer. One loop at a time; it ends when the canvas says another holds the project, when
   * the canvas does not answer twice in a row, and when the REPL ends.
   */
  private async listen(): Promise<void> {
    if (this.listening || this.closed || !this.d.act) return;
    this.listening = true;
    this.heard = 'listening';
    let misses = 0;
    try {
      while (!this.closed) {
        const token = this.token();
        if (!token) { this.heard = 'stopped: the canvas did not answer'; return; }
        this.asking = new AbortController();
        const timeout = AbortSignal.timeout(this.d.pollMs ?? POLL_MS);
        const asked = Date.now();
        let res: Response;
        try {
          res = await this.http(`${this.base()}/api/project/inbox?holder=${this.holder}`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.any([this.asking.signal, timeout]) });
        } catch {
          if (this.closed) { this.heard = 'stopped: the REPL is ending'; return; }
          if (timeout.aborted) continue;
          if (++misses >= 2) { this.heard = 'stopped: the canvas did not answer'; return; }
          await new Promise((r) => setTimeout(r, 1000).unref());
          continue;
        }
        misses = 0;
        if (res.status === 204) {
          await res.body?.cancel();
          // An empty answer is the server's 25 s wait ending; one that came at once is not asked again at once.
          if (Date.now() - asked < 1000) await new Promise((r) => setTimeout(r, 1000).unref());
          continue;
        }
        if (!res.ok) {
          await res.body?.cancel();
          this.heard = res.status === 409 ? 'stopped: another REPL holds the project' : res.status === 404 ? 'stopped: the canvas names no project now' : 'stopped: the canvas did not answer';
          return;
        }
        let envelope: { id?: unknown } | undefined;
        try { envelope = ((await res.json()) as { action?: { id?: unknown } }).action; } catch { envelope = undefined; }
        if (!envelope || typeof envelope.id !== 'string' || !/^[0-9a-f-]{36}$/.test(envelope.id)) continue;
        let answer: { status: number; text: string };
        try { answer = await this.d.act(envelope); } catch (e) { answer = { status: 500, text: `This REPL could not run the action: ${e instanceof Error ? e.message : String(e)}` }; }
        try {
          await this.http(`${this.base()}/api/project/inbox/${envelope.id}`, {
            method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify({ holder: this.holder, status: answer.status, text: answer.text.slice(0, 60_000) }), signal: AbortSignal.timeout(SHORT_MS),
          }).then((r) => r.body?.cancel());
        } catch { /* the canvas went away: the page says the action is unanswered */ }
      }
      this.heard = 'stopped: the REPL is ending';
    } finally {
      this.listening = false;
      this.asking = undefined;
    }
  }

  /** Asks the canvas what it shows now (one local request, a short timeout); concurrent asks share one request. */
  check(): Promise<CanvasSeen> {
    this.checking ??= this.ask().then((seen) => { this.seen = seen; return seen; }).finally(() => { this.checking = undefined; });
    return this.checking;
  }

  private async ask(): Promise<CanvasSeen> {
    if (!this.local()) return { state: 'remote' };
    let res: Response;
    try {
      res = await this.http(`${this.base()}/api/project/active`, { signal: AbortSignal.timeout(SHORT_MS) });
    } catch (error) {
      const e = error as { name?: string; cause?: { code?: string; errors?: Array<{ code?: string }> } };
      const codes = [e?.cause?.code, ...(e?.cause?.errors ?? []).map((x) => x?.code)].filter((c): c is string => typeof c === 'string');
      if (codes.length && codes.every((c) => c === 'ECONNREFUSED')) return { state: 'not-running' };
      return { state: 'other', detail: e?.name === 'TimeoutError' ? 'it did not answer in time' : 'it does not answer as Timmy Canvas' };
    }
    let body: { app?: unknown; project?: { name?: unknown; id?: unknown } | null; pageConnected?: unknown; board?: unknown } = {};
    try { body = await res.json() as typeof body; } catch { /* not JSON */ }
    if (res.ok && body.app === 'timmy-canvas') {
      const p = body.project && typeof body.project.name === 'string' && typeof body.project.id === 'string' ? { name: body.project.name, id: body.project.id } : null;
      return { state: 'running', project: p, pageConnected: body.pageConnected === true, board: body.board === true };
    }
    // A Timmy Canvas from before the project routes still has its health route.
    if (res.status === 404) {
      try {
        const health = await this.http(`${this.base()}/api/canvas/health`, { signal: AbortSignal.timeout(SHORT_MS) });
        const h = await health.json() as { app?: unknown };
        if (h.app === 'timmy-canvas') return { state: 'older' };
      } catch { /* not Timmy Canvas */ }
    }
    return { state: 'other', detail: `HTTP ${res.status}, not Timmy Canvas` };
  }

  /** What the canvas showed when last asked. */
  shown(): CanvasSeen { return this.seen; }

  /** The board's line: whether the canvas is open on this same project, and what to type. */
  boardLine(): BoardCanvas {
    const s = this.seen;
    if (s.state === 'unchecked') return { tone: 'unknown', words: 'Timmy Canvas: not checked yet.', command: '/canvas' };
    if (s.state === 'remote') return { tone: 'unknown', words: 'Timmy Canvas is at TIMMY_STUDIO_URL, not on this machine; it is not told which project is active.' };
    if (s.state === 'not-running') return { tone: 'off', words: 'Timmy Canvas is not running.', command: '/canvas open' };
    if (s.state === 'other') return { tone: 'off', words: `Timmy Canvas's port is held by another program (${s.detail}).`, command: '/canvas' };
    if (s.state === 'older') return { tone: 'unknown', words: 'Timmy Canvas runs, but it is older and cannot show projects.', command: '/canvas' };
    if (!s.project) return { tone: 'none', words: 'Timmy Canvas runs; no project is named to it yet.', command: '/canvas open' };
    if (s.project.id === this.d.projectId(this.d.project().root)) {
      // R4 (H75): and whether its drawn cards' Run, Save and Rebuild come to this REPL.
      const acts = this.heard === 'listening' ? ' Its cards\' Run, Save and Rebuild act through this REPL.' : '';
      return s.pageConnected
        ? { tone: 'same', words: `Timmy Canvas is open on this project.${acts}`, command: '/canvas' }
        : { tone: 'same', words: `Timmy Canvas shows this project; no canvas page is open.${acts}`, command: '/canvas open' };
    }
    return { tone: 'other', words: `Timmy Canvas shows another project (${s.project.name}), not this one.`, command: '/canvas open' };
  }

  /** Asks now and every `everyMs` while the REPL runs (the timer never holds the process open). */
  start(everyMs = 5000): void {
    if (this.timer || this.closed) return;
    void this.check();
    this.timer = setInterval(() => { void this.check(); }, everyMs);
    this.timer.unref();
  }

  /** The REPL is ending: no more asks, no more handoffs, and (R4 H75) no more card actions. */
  stop(): void {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.asking?.abort();
  }
}
