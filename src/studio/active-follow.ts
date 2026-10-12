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
 */
import { lstatSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
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
  /** the project the canvas shows now (its folder), or null */
  shown: () => { root: string } | null;
  /** names the active project to the canvas (ProjectLink.follow, then the relay told who holds it) */
  follow: (a: ActiveFile) => void;
  everyMs?: number;
  graceMs?: number;
}

/** Watches the active-project file and follows a change of it (see this module's comment). */
export class ActiveFollower {
  private seen = '';
  private started = false;
  private timer?: NodeJS.Timeout;
  private pending?: NodeJS.Timeout;
  /** the last change followed, or why not, for the tests and the health of the canvas */
  last: { at: string; name: string; followed: boolean; why?: string } | null = null;

  /** Nothing is read until start(): the server starts it once it listens. */
  constructor(private readonly d: FollowDeps) {}

  /** The active project as its file names it now (name and id only leave the server); null before start(). */
  active(): ActiveFile | null { return this.started ? readActiveFile(this.d.file) : null; }

  start(): void {
    if (this.timer) return;
    this.started = true;
    // what the file says as the server starts is not a change: the REPL that started the server names its own project
    this.seen = signature(this.d.file);
    this.timer = setInterval(() => this.tick(), this.d.everyMs ?? 1000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.pending) clearTimeout(this.pending);
    this.timer = undefined;
    this.pending = undefined;
  }

  /** One look at the file: a change that names another project than the canvas shows is followed after the grace period. */
  tick(): void {
    if (!this.started) return;
    const now = signature(this.d.file);
    if (now === this.seen) return;
    this.seen = now;
    const a = readActiveFile(this.d.file);
    if (!a) return;
    const shown = this.d.shown();
    if (shown && sameFolder(shown.root, a.root)) return;
    if (this.pending) clearTimeout(this.pending);
    this.pending = setTimeout(() => this.settle(a.root), this.d.graceMs ?? GRACE_MS);
    this.pending.unref();
  }

  /** After the grace period: still the file's project, and still not the one shown (no REPL named it meanwhile): followed. */
  private settle(root: string): void {
    this.pending = undefined;
    const a = readActiveFile(this.d.file);
    if (!a || !sameFolder(a.root, root)) return;
    const shown = this.d.shown();
    if (shown && sameFolder(shown.root, a.root)) { this.last = { at: new Date().toISOString(), name: a.name, followed: false, why: 'a REPL named it first' }; return; }
    this.d.follow(a);
    this.last = { at: new Date().toISOString(), name: a.name, followed: true };
  }
}
