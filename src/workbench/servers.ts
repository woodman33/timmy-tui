/**
 * R4 (H110): Companion · Show and Studio · Show, and their separate Stop serving.
 *
 * Companion · Show starts the browser companion (src/companion/server.ts) on 127.0.0.1 the first time, and every press opens
 * it again; it never starts a second server. Studio · Show is the REPL's /canvas open (src/repl/main.ts, canvas-view.ts): it
 * serves Timmy Canvas from this process unless another Timmy already does, names this Workbench's project to it, takes a
 * one-time grant, and opens the page with it. Like the REPL, this Workbench then takes the project's card actions (each runs
 * through its own Workspace, as the live board's buttons do), until another surface names the project.
 *
 * A browser opens only on that press, and only where this computer has an opener (`open` on macOS, `xdg-open` elsewhere). The
 * token or grant never goes on a command line, into a log or onto this screen: it is in a private launch page
 * (src/utils/launch-page.ts: a folder only this user can open, removed a minute later at the latest), and the opener is given
 * that page's file address. Without an opener the words name the bare address and the launch page's file.
 */
import { spawn } from 'node:child_process';
import type { CompanionServer } from '../companion/server.js';
import { CanvasProject } from '../repl/canvas-project.js';
import type { StudioServer } from '../studio/server.js';
import { studioBaseUrl, studioPort } from '../studio/config.js';
import { writeLaunchPage } from '../utils/launch-page.js';
import type { ServerState } from './model.js';

type Env = Record<string, string | undefined>;

export interface Opener {
  /** the program that opens a page, or null when this computer has none */
  program: string | null;
  /** opens `href` (a file:// launch page or a bare address); words back */
  open(href: string): { ok: true } | { ok: false; why: string };
}

/** This computer's browser opener: `open` on macOS, `xdg-open` elsewhere, found on PATH; none otherwise. */
export function systemOpener(env: Env, onPath: (cmd: string) => string | null, platform: NodeJS.Platform = process.platform): Opener {
  const name = platform === 'darwin' ? 'open' : platform === 'win32' ? null : 'xdg-open';
  const program = name ? onPath(name) : null;
  return {
    program,
    open: (href) => {
      if (!program) return { ok: false, why: 'this computer has no browser opener here (open on macOS, xdg-open elsewhere)' };
      try {
        const child = spawn(program, [href], { detached: true, stdio: 'ignore', env: env as NodeJS.ProcessEnv });
        child.on('error', () => undefined);
        child.unref();
        return { ok: true };
      } catch (e) {
        return { ok: false, why: e instanceof Error ? e.message : String(e) };
      }
    },
  };
}

/** Opens `url` through a private launch page when it carries a secret; the words say what happened, never the secret. */
function openPage(url: string, secret: boolean, opener: Opener, what: string, bare: string): string {
  if (!secret) {
    const r = opener.open(url);
    return r.ok ? `${what} opened in your browser: ${bare}` : `${what} is at ${bare}; ${r.why}, so open it yourself`;
  }
  let page: ReturnType<typeof writeLaunchPage>;
  try { page = writeLaunchPage(url); } catch (e) { return `${what} is at ${bare}, but its private page could not be written (${e instanceof Error ? e.message : String(e)})`; }
  const r = opener.open(page.href);
  if (r.ok) return `${what} opened in your browser (${bare}), through a private page that carries its key`;
  return `${what} is at ${bare}; ${r.why}. Its key is in a private page only you can read, for a minute: ${page.path}`;
}

export interface CompanionDeps {
  opener: Opener;
  /** a test's start (FAKE); absent: the real companion server */
  start?: (port: number) => Promise<Pick<CompanionServer, 'port' | 'url' | 'address' | 'shutdown'>>;
}

export class CompanionControl {
  private server: Pick<CompanionServer, 'port' | 'url' | 'address' | 'shutdown'> | null = null;
  private starting: Promise<unknown> | null = null;
  private last: string | null = null;

  constructor(private readonly d: CompanionDeps) {}

  state(): ServerState {
    return { serving: !!this.server, address: this.server ? this.server.address : null, last: this.last, ...(this.starting ? { starting: true } : {}) };
  }

  /** Starts it once (on 127.0.0.1, a free port), then opens it; a second press opens the same one. */
  async show(): Promise<string> {
    if (this.starting) { await this.starting; }
    if (!this.server) {
      const start = this.d.start ?? (async (port: number) => (await import('../companion/server.js')).startCompanionServer(port));
      const p = start(0);
      this.starting = p;
      try { this.server = await p; } catch (e) {
        this.starting = null;
        this.last = `The Companion did not start: ${e instanceof Error ? e.message : String(e)}`;
        return this.last;
      }
      this.starting = null;
    }
    const s = this.server;
    this.last = openPage(s.url, true, this.d.opener, 'The Companion', s.address);
    return this.last;
  }

  async stopServing(): Promise<string> {
    if (!this.server) { this.last = 'This Workbench serves no Companion: nothing to stop.'; return this.last; }
    const s = this.server;
    this.server = null;
    try { await s.shutdown(); this.last = `The Companion at ${s.address} stopped serving.`; } catch (e) { this.last = `The Companion's stop failed: ${e instanceof Error ? e.message : String(e)}`; }
    return this.last;
  }
}

export interface StudioDeps {
  env: Env;
  opener: Opener;
  project: () => { root: string; name: string };
  projectId: (root: string) => string;
  jobsDir: string;
  receipts: () => string;
  /** runs a drawn card's action through this Workbench's Workspace (the live board's own path) */
  act?: (envelope: unknown) => Promise<{ status: number; text: string }>;
  /** a test's (FAKE); absent: the real ensureStudioServer */
  ensure?: (port: number) => Promise<{ state: 'started'; server: Pick<StudioServer, 'projectToken' | 'close'> } | { state: 'already-running' } | { state: 'failed'; error: string }>;
  health?: (base: string) => Promise<{ state: string; detail?: string }>;
}

export class StudioControl {
  private owned: Pick<StudioServer, 'projectToken' | 'close'> | null = null;
  private other = false;
  private last: string | null = null;
  private busy: Promise<string> | null = null;
  private readonly canvas: CanvasProject;

  constructor(private readonly d: StudioDeps) {
    this.canvas = new CanvasProject({
      base: () => studioBaseUrl(d.env), env: d.env, project: d.project, projectId: d.projectId, jobsDir: d.jobsDir, receipts: d.receipts,
      board: () => null, ownToken: () => this.owned?.projectToken ?? null, ...(d.act ? { act: d.act } : {}),
    });
  }

  private base(): string { return studioBaseUrl(this.d.env).replace(/\/+$/, ''); }

  state(): ServerState {
    return { serving: !!this.owned, address: this.owned || this.other ? `${this.base()}/` : null, last: this.last, ...(this.other ? { other: true } : {}), ...(this.busy ? { starting: true } : {}) };
  }

  /** As the REPL's /canvas open: serve it (unless another Timmy does), name this project to it, open it with a one-time grant. */
  show(): Promise<string> {
    this.busy ??= this.showNow().finally(() => { this.busy = null; });
    return this.busy;
  }

  private async showNow(): Promise<string> {
    const base = this.base();
    if (this.d.env.TIMMY_STUDIO_URL?.trim()) {
      this.last = openPage(`${base}/`, false, this.d.opener, 'Studio (at TIMMY_STUDIO_URL, served elsewhere)', `${base}/`);
      return this.last;
    }
    if (!this.owned) {
      const ensure = this.d.ensure ?? (async (port: number) => (await import('../studio/server.js')).ensureStudioServer(port, { env: this.d.env, projectTokenFile: true }));
      const r = await ensure(studioPort(this.d.env));
      if (r.state === 'failed') { this.last = `Studio is not running: ${r.error}`; return this.last; }
      if (r.state === 'started') this.owned = r.server;
      else this.other = true;
    }
    const health: { state: string; detail?: string } = await (this.d.health ?? (async (b: string) => (await import('../studio/health.js')).studioHealth(b)))(base);
    if (health.state !== 'running') { this.last = `Studio does not answer at ${base}/ (${health.state}${health.detail ? `: ${health.detail}` : ''})`; return this.last; }
    const told = await this.canvas.handOff({ grant: true });
    const t = this.canvas.openTarget();
    const opened = openPage(t.target === 'studio' ? `${base}/` : t.target, t.secret, this.d.opener, 'Studio', `${base}/`);
    this.last = `${opened}. ${told.ok ? `It shows ${told.name}.` : `The project was not named to it: ${told.why}.`}${this.other ? ' Another Timmy serves it.' : ''}`;
    return this.last;
  }

  async stopServing(): Promise<string> {
    if (!this.owned) {
      this.last = this.other ? 'Another Timmy serves Studio: stop it there (this Workbench did not start it).' : 'This Workbench serves no Studio: nothing to stop.';
      return this.last;
    }
    const s = this.owned;
    this.owned = null;
    await new Promise<void>((resolve) => { try { s.close(() => resolve()); } catch { resolve(); } });
    this.last = `Studio at ${this.base()}/ stopped serving.`;
    return this.last;
  }

  close(): void { try { this.canvas.stop(); } catch { /* stopped */ } }
}
