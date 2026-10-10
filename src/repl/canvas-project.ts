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
 */
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

export class CanvasProject {
  private seen: CanvasSeen = { state: 'unchecked' };
  /** the id of the project this REPL last named and the canvas accepted */
  private named: string | null = null;
  private checking?: Promise<CanvasSeen>;
  private timer?: NodeJS.Timeout;
  private closed = false;

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

  /** Names the active project to the canvas; says why not when it cannot. */
  async handOff(): Promise<HandOff> {
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
        body: JSON.stringify({ root: p.root, name: p.name, jobs: this.d.jobsDir, receipts: this.d.receipts(), board: this.d.board() }),
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
    return { ok: true, name: body.project.name };
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
      return s.pageConnected
        ? { tone: 'same', words: 'Timmy Canvas is open on this project.', command: '/canvas' }
        : { tone: 'same', words: 'Timmy Canvas shows this project; no canvas page is open.', command: '/canvas open' };
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

  /** The REPL is ending: no more asks, and no more handoffs. */
  stop(): void {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
