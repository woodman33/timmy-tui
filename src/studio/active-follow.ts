/**
 * R4 (H109): Timmy Canvas (Timmy Studio) follows the active project. The operator's direction (2026-10-11): Timmy is one project
 * with three connected workspaces (the terminal Workbench, the browser Companion, Studio) sharing the same project services; the
 * active project is <TIMMY_HOME>/state/active-project.json (src/project/index.ts: saveActiveProject writes it on /project,
 * readActiveProject reads it); "Following windows change project together; pinned windows keep their visibly identified project."
 *
 * What the canvas did before this (kept): the REPL names its project to the canvas server (POST /api/project/active,
 * src/studio/project-link.ts) on /canvas open, as its own server starts, on /project while the canvas still shows what it named,
 * and when /board live starts or stops. What this adds: the canvas server watches the active-project file for a change made
 * after it started (its content at start is left alone: the REPL that started the server names its own project), and when the
 * file names another project than the one the canvas shows and no REPL names that project within GRACE_MS (a REPL's own
 * /project names it at once, with its holder, so its actions keep working), the server names it itself: `via: 'active'`, with
 * the jobs folder and receipts store a REPL of this Timmy home named last (else the Timmy home's jobs folder and the project's
 * own store), and no holder (no REPL takes its cards' actions until /canvas open in Timmy). A page whose session follows (every
 * page, unless the board it shows is pinned: companion/studio-canvas/src/project.js) then shows it; a board pinned to a project
 * keeps that project (src/studio/card-relay.ts: what a session reaches).
 *
 * Only a name and an id ever leave the server (a hash of the folder, as receipts name it): never the folder itself.
 *
 * R7 (H149; R6 row 18: for about 2 s after a switch Studio still showed the old project and took edits for it): the file is
 * seen as it is written (a watch of its folder, as src/companion/project.ts watches it; the poll is kept, as a watch can miss a
 * change), and the switch is said to be pending at once (FollowDeps.pending, ActiveFollower.pending: the shape agreed with H151,
 * whose page blocks edits from it), until it is made (the server followed after the grace, or a REPL named the project) or
 * given up (the file names the project shown again, or a REPL named another project after the change: a REPL's naming stands
 * over the server's own follow, whichever comes first). A REPL that follows the file names its project at once with its holder
 * (src/repl/project-follow.ts, src/repl/canvas-project.ts switched), so the switch is usually made in well under the grace.
 */
import { lstatSync, readFileSync, statSync, watch, type FSWatcher } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { timmyHome, type Env } from '../setup/home.js';
import { projectId, sameFolder } from '../project/index.js';

/** <TIMMY_HOME>/state/active-project.json for the server's own environment (src/project/index.ts activeProjectPath). */
export const activeProjectFile = (env: Env): string => join(timmyHome(env), 'state', 'active-project.json');

/** The active project as its file names it: its name, folder, id and when it was chosen; null when there is none to follow. */
export interface ActiveFile { name: string; root: string; id: string; at: string | null }

/** How long a REPL has to name the project the file names, itself, before the server does (ms). */
export const GRACE_MS = 1500;
const FILE_MAX = 64 * 1024;

/**
 * The active project as the file names it, by readActiveProject's rule (src/project/index.ts): a folder that is one (its name
 * the file's, else the folder's); null when the file is absent, not a regular file, not JSON, or names no folder.
 */
export function readActiveFile(file: string): ActiveFile | null {
  try {
    const st = lstatSync(file);
    if (!st.isFile() || st.size > FILE_MAX) return null;
    const saved = JSON.parse(readFileSync(file, 'utf8')) as { name?: unknown; root?: unknown; at?: unknown };
    if (typeof saved.root !== 'string' || !saved.root || saved.root.includes('\0')) return null;
    let dir = false;
    try { dir = statSync(saved.root).isDirectory(); } catch { dir = false; }
    if (!dir) return null;
    const name = typeof saved.name === 'string' && saved.name.trim() ? saved.name.trim().slice(0, 120) : basename(saved.root) || saved.root;
    const at = typeof saved.at === 'string' && Number.isFinite(Date.parse(saved.at)) ? saved.at : null;
    return { name, root: saved.root, id: projectId(saved.root), at };
  } catch { return null; }
}

/** The file's identity as last seen (its time and size, and its text): a change of any of them is a change. */
const signature = (file: string): string => {
  try {
    const st = lstatSync(file);
    return `${st.mtimeMs}:${st.size}:${st.isFile() ? readFileSync(file, 'utf8').slice(0, FILE_MAX) : ''}`;
  } catch { return 'absent'; }
};

export interface FollowDeps {
  /** the active-project file to watch */
  file: string;
  /** the project the canvas shows now (its folder; R7 H149: how it came to be shown, and since when), or null */
  shown: () => { root: string; via?: 'repl' | 'active'; since?: string } | null;
  /** names the active project to the canvas (ProjectLink.follow, then the relay told who holds it) */
  follow: (a: ActiveFile) => void;
  /**
   * R7 (H149, the shape agreed with H151): a switch is pending (the file names `p`, another project than the one shown, and the
   * canvas waits up to the grace for a REPL to name it), or (null) no longer: made, or given up. Called at once, each time.
   */
  pending?: (p: PendingSwitch | null) => void;
  everyMs?: number;
  graceMs?: number;
}

/** R7 (H149): a switch the canvas is about to make: the project the file names (its id and name), and since when (ISO). */
export interface PendingSwitch { id: string; name: string; since: string }

/** A burst of watch events (a write, then its rename) is read once, this long after the last. */
const SETTLE_MS = 50;

/** Watches the active-project file and follows a change of it (see this module's comment). */
export class ActiveFollower {
  private seen = '';
  private started = false;
  private timer?: NodeJS.Timeout;
  private waiting?: NodeJS.Timeout;
  /** R7 (H149): the switch pending now (its folder too, kept here only), and when this server saw the change (ms) */
  private switching: (PendingSwitch & { root: string; seenAt: number }) | null = null;
  private watcher: FSWatcher | null = null;
  private burst?: NodeJS.Timeout;
  /** the last change followed, or why not, for the tests and the health of the canvas */
  last: { at: string; name: string; followed: boolean; why?: string } | null = null;

  /** Nothing is read until start(): the server starts it once it listens. */
  constructor(private readonly d: FollowDeps) {}

  /** The active project as its file names it now (name and id only leave the server); null before start(). */
  active(): ActiveFile | null { return this.started ? readActiveFile(this.d.file) : null; }

  /**
   * R7 (H149): the switch pending now (the file names another project than the one shown, and no REPL has named it yet), or null.
   * Never the folder: its id, name and since when.
   */
  get pending(): PendingSwitch | null {
    const s = this.switching;
    if (!s) return null;
    const shown = this.d.shown();
    if (shown && sameFolder(shown.root, s.root)) return null;
    return { id: s.id, name: s.name, since: s.since };
  }

  start(): void {
    if (this.timer) return;
    this.started = true;
    // what the file says as the server starts is not a change: the REPL that started the server names its own project
    this.seen = signature(this.d.file);
    this.watchFile();
    this.timer = setInterval(() => { this.watchFile(); this.tick(); }, this.d.everyMs ?? 1000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.waiting) clearTimeout(this.waiting);
    if (this.burst) clearTimeout(this.burst);
    this.timer = undefined;
    this.waiting = undefined;
    this.burst = undefined;
    this.watcher?.close();
    this.watcher = null;
  }

  /**
   * One look at the file: a change that names another project than the canvas shows is said pending at once and followed after
   * the grace period. R7 (H149): and a pending switch a REPL has made meanwhile (it named that project) is said made.
   */
  tick(): void {
    if (!this.started) return;
    const now = signature(this.d.file);
    if (now === this.seen) {
      if (this.switching && !this.pending) this.clear();
      return;
    }
    this.seen = now;
    const a = readActiveFile(this.d.file);
    if (!a) return;
    const shown = this.d.shown();
    if (shown && sameFolder(shown.root, a.root)) {
      // the file names the project shown (again): nothing to follow, and a switch that was pending is given up
      if (this.waiting) { clearTimeout(this.waiting); this.waiting = undefined; }
      if (this.switching) this.clear();
      return;
    }
    if (this.waiting) clearTimeout(this.waiting);
    this.switching = { id: a.id, name: a.name, since: a.at ?? new Date().toISOString(), root: a.root, seenAt: Date.now() };
    this.say({ id: a.id, name: a.name, since: this.switching.since });
    this.waiting = setTimeout(() => this.settle(a.root), this.d.graceMs ?? GRACE_MS);
    this.waiting.unref();
  }

  /**
   * After the grace period: still the file's project, and still not the one shown (no REPL named it meanwhile): followed. R7
   * (H149): unless a REPL named another project after the change (its /canvas open): its naming stands over the file's.
   */
  private settle(root: string): void {
    this.waiting = undefined;
    const seenAt = this.switching?.seenAt ?? 0;
    const a = readActiveFile(this.d.file);
    if (!a || !sameFolder(a.root, root)) { this.clear(); return; }
    const shown = this.d.shown();
    if (shown && sameFolder(shown.root, a.root)) { this.last = { at: new Date().toISOString(), name: a.name, followed: false, why: 'a REPL named it first' }; this.clear(); return; }
    const named = shown?.via === 'repl' && shown.since ? Date.parse(shown.since) : NaN;
    if (Number.isFinite(named) && named >= seenAt) {
      this.last = { at: new Date().toISOString(), name: a.name, followed: false, why: 'a REPL named another project after the change' };
      this.clear();
      return;
    }
    // the switch is made by the follow: the page learns its project from it (src/studio/bridge.ts announce), then not pending
    this.d.follow(a);
    this.last = { at: new Date().toISOString(), name: a.name, followed: true };
    this.clear();
  }

  /** R7 (H149): no switch pending any more (made, or given up): said once. */
  private clear(): void {
    if (!this.switching) return;
    this.switching = null;
    this.say(null);
  }

  private say(p: PendingSwitch | null): void {
    try { this.d.pending?.(p); } catch { /* the page is told on its next reading (GET /api/project/active) */ }
  }

  /** R7 (H149): watches the file's folder (the file is replaced by a rename: its own watch would end there); a burst is read once. */
  private watchFile(): void {
    if (this.watcher || !this.started) return;
    try {
      const name = basename(this.d.file);
      this.watcher = watch(dirname(this.d.file), { persistent: false }, (_event, file) => {
        if (file && !String(file).startsWith(name)) return;
        if (this.burst) clearTimeout(this.burst);
        this.burst = setTimeout(() => { this.burst = undefined; this.tick(); }, SETTLE_MS);
        this.burst.unref();
      });
      this.watcher.on('error', () => { this.watcher?.close(); this.watcher = null; });
    } catch {
      // no state folder yet: the poll watches again once it is there
      this.watcher = null;
    }
  }
}
