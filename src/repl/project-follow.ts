/**
 * R7 (H149): the REPL follows the active project. The operator (2026-10-16): "Make the REPL follow the selected project
 * consistently with Workbench, companion and Studio. Keep already-running operations attached to their original project."
 *
 * The active project is <TIMMY_HOME>/state/active-project.json (src/project/index.ts saveActiveProject: the REPL's /project and
 * the Workbench's picker write it). A change another process makes to it moves this REPL to that project through the same path
 * as /project (Workspace.follow: the folder, the project, its conversation, and the canvas's handoff while the canvas is this
 * REPL's), without writing the record again: the choice is the other surface's. The record's folder is watched (the record is
 * replaced by a rename, so its own file's watch would end there; src/companion/project.ts watches it the same way), and the
 * record is read again once a second besides, since a watch can miss a change.
 *
 * What the record says as the REPL starts is not a change (the REPL starts in its folder, as before R7), and a change that names
 * the project this REPL is in already (its own /project, or another surface following it there) moves nothing.
 *
 * What runs keeps the project it started in: jobs, flows, operations, VoxVision actions, recipes and code-agent runs carry their
 * own folder and project (their records, logs, receipts and stops). A request of this REPL that runs when the change arrives (a
 * chat turn, a typed command, a live-board or canvas action) finishes in its own project first: the REPL follows once it has
 * ended (idle), by the record as it is then, and says so when the change arrives ("follows blank once this turn ends").
 *
 * No REPL is pinned to a project: none could be before R7, and none is added.
 */
import { lstatSync, readFileSync, statSync, watch, type FSWatcher } from 'node:fs';
import { basename, dirname } from 'node:path';
import { sameFolder, type ActiveProject } from '../project/index.js';
import type { GlyphSet } from '../term/glyphs.js';
import type { Segment } from '../term/theme.js';

/** How often the record is read again besides the watch (the companion's rule: never more often than once a second). */
export const FOLLOW_POLL_MS = 1000;
/** A burst of watch events (a write, then its rename) is read once, this long after the last. */
const SETTLE_MS = 50;
const RECORD_MAX = 64 * 1024;

/** Where a choice was made, by the record's `by` (src/project/index.ts saveActiveProject); anything else is not said. */
export const CHOSEN_IN: Readonly<Record<string, string>> = {
  repl: 'another Timmy REPL', workbench: 'the Workbench', md: 'timmy md', act: 'timmy act',
};

/** The record as read: the project it names (a folder that is one), where it was chosen when it says, and its text. */
export interface ActiveRecord { project: ActiveProject; by: string | null; text: string }

/**
 * The record by readActiveProject's rule (src/project/index.ts): a folder that is one, its name (else the folder's); null when
 * the record is absent, not a regular file, not JSON, or names no folder. `by` only when it is one of CHOSEN_IN's.
 */
export function readActiveRecord(file: string): ActiveRecord | null {
  try {
    const st = lstatSync(file);
    if (!st.isFile() || st.size > RECORD_MAX) return null;
    const text = readFileSync(file, 'utf8');
    const saved = JSON.parse(text) as { name?: unknown; root?: unknown; by?: unknown };
    if (typeof saved.root !== 'string' || !saved.root || saved.root.includes('\0')) return null;
    if (!statSync(saved.root).isDirectory()) return null;
    const name = typeof saved.name === 'string' && saved.name ? saved.name : basename(saved.root);
    const by = typeof saved.by === 'string' && Object.prototype.hasOwnProperty.call(CHOSEN_IN, saved.by) ? saved.by : null;
    return { project: { name, root: saved.root, chosen: true }, by, text };
  } catch { return null; }
}

/** The record's text as it is now ('' when it cannot be read): a change of it is a change. */
const textOf = (file: string): string => {
  try { return lstatSync(file).isFile() ? readFileSync(file, 'utf8').slice(0, RECORD_MAX) : ''; } catch { return ''; }
};

/** What of this REPL runs now: a chat turn, a typed command, or an action of the live board or the canvas. */
export type Busy = 'turn' | 'command' | 'action';

/** A run that keeps its project (a job, a flow): its id and what it is, as /jobs names it. */
export interface StillRunning { id: string; what: string }

export interface ProjectFollowDeps {
  /** the active-project record (src/project/index.ts activeProjectPath) */
  file: string;
  /** the project this REPL is in now */
  current: () => ActiveProject;
  /** what of this REPL runs now (the follow waits for it to end), or null */
  busy: () => Busy | null;
  /** moves this REPL to `p` (Workspace.follow): the record is not written again */
  move: (p: ActiveProject) => void;
  /** what this REPL started that still runs in a project's folder (said as staying there) */
  running: (root: string) => StillRunning[];
  /** a notice above the prompt */
  notify: (line: Segment[]) => void;
  glyphs: GlyphSet;
  pollMs?: number;
}

/** Control characters out of a name a record gave (it is printed in the terminal). */
const shown = (s: string): string => s.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').slice(0, 120);
const where = (by: string | null): string => (by ? `chosen in ${CHOSEN_IN[by]}` : 'chosen elsewhere');
const WAITS: Record<Busy, (from: string) => string> = {
  turn: (from) => `once this turn ends; the turn finishes in ${from}`,
  command: (from) => `once this command ends; it finishes in ${from}`,
  action: (from) => `once the action running now ends; it finishes in ${from}`,
};

/** "j1a2b3c4 (docs/x.md › build)", "a and b", "a, b, c and 2 more". */
function listed(runs: StillRunning[]): string {
  const names = runs.slice(0, 3).map((r) => (r.what ? `${r.id} (${shown(r.what).slice(0, 60)})` : r.id));
  const more = runs.length - names.length;
  if (more > 0) return `${names.join(', ')} and ${more} more`;
  return names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/**
 * The notice of a follow: which project, where it was chosen, and what stays where it started. One line (the REPL wraps it).
 * Exported for the tests, which read these words.
 */
export function followedLine(from: ActiveProject, to: ActiveRecord, left: StillRunning[], g: GlyphSet): Segment[] {
  const stays = left.length
    ? ` ${listed(left)}, started in ${shown(from.name)}, ${left.length === 1 ? 'keeps' : 'keep'} running there, with ${left.length === 1 ? 'its' : 'their'} records, logs and receipts.`
    : '; /project shows it.';
  return [
    { text: `  ${g.arrow} ` },
    { text: `Now in ${shown(to.project.name)}`, role: 'strong' },
    { text: `: the active project changed (${where(to.by)}), and this REPL follows it${left.length ? '.' : ''}${stays}`, role: 'secondary' },
  ];
}

/** The notice of a follow that waits for this REPL's request to end. */
export function waitLine(from: ActiveProject, to: ActiveRecord, busy: Busy, g: GlyphSet): Segment[] {
  return [
    { text: `  ${g.arrow} ` },
    { text: `The active project is now ${shown(to.project.name)}`, role: 'strong' },
    { text: ` (${where(to.by)}): this REPL follows ${shown(to.project.name)} ${WAITS[busy](shown(from.name))}.`, role: 'secondary' },
  ];
}

/** The notice when the record names this REPL's project again before a follow it waited for happened. */
export function staysLine(here: ActiveProject, g: GlyphSet): Segment[] {
  return [{ text: `  ${g.arrow} ` }, { text: `The active project is ${shown(here.name)} again`, role: 'strong' }, { text: `: this REPL stays in ${shown(here.name)}.`, role: 'secondary' }];
}

/** Watches the active-project record and moves this REPL with a change of it (see this module's comment). */
export class ActiveProjectFollower {
  /** the record's text as last read: what it was is not a change */
  private seen = '';
  /** the project a follow waits for while this REPL's request runs (said once per project) */
  private waiting: ActiveRecord | null = null;
  private watcher: FSWatcher | null = null;
  private poll: NodeJS.Timeout | null = null;
  private settle: NodeJS.Timeout | null = null;
  private started = false;
  private stopped = false;
  /** each follow, for the tests: the project left, the project followed, and when */
  readonly moves: Array<{ from: string; to: string; at: number }> = [];

  constructor(private readonly d: ProjectFollowDeps) {}

  /** Starts following: what the record says now is not a change. */
  start(): void {
    if (this.started || this.stopped) return;
    this.started = true;
    this.seen = textOf(this.d.file);
    this.watchRecord();
    this.poll = setInterval(() => { this.watchRecord(); this.check(); }, Math.max(50, this.d.pollMs ?? FOLLOW_POLL_MS));
    this.poll.unref();
  }

  stop(): void {
    this.stopped = true;
    if (this.poll) clearInterval(this.poll);
    if (this.settle) clearTimeout(this.settle);
    this.poll = null;
    this.settle = null;
    this.watcher?.close();
    this.watcher = null;
  }

  /** Whether a follow waits for this REPL's request to end (the project it waits to follow). */
  get pending(): string | null { return this.waiting ? this.waiting.project.name : null; }

  /** Reads the record now: a change of it that names another project moves this REPL (now, or once its request has ended). */
  check(): void {
    if (!this.started || this.stopped) return;
    const text = textOf(this.d.file);
    if (text === this.seen) return;
    this.seen = text;
    const rec = readActiveRecord(this.d.file);
    if (rec) this.consider(rec);
  }

  /** This REPL's request has ended: a follow that waited for it happens now, by the record as it is now. */
  idle(): void {
    if (!this.waiting || this.stopped || this.d.busy()) return;
    this.waiting = null;
    this.seen = textOf(this.d.file);
    const rec = readActiveRecord(this.d.file);
    const here = this.d.current();
    if (!rec) return;
    if (sameFolder(rec.project.root, here.root)) { this.d.notify(staysLine(here, this.d.glyphs)); return; }
    this.follow(rec);
  }

  private consider(rec: ActiveRecord): void {
    const here = this.d.current();
    if (sameFolder(rec.project.root, here.root)) {
      // this REPL's own /project, or a surface that followed it: nothing moves; a follow that waited is given up, and said so
      if (this.waiting) { this.waiting = null; this.d.notify(staysLine(here, this.d.glyphs)); }
      return;
    }
    const busy = this.d.busy();
    if (busy) {
      if (!this.waiting || !sameFolder(this.waiting.project.root, rec.project.root)) this.d.notify(waitLine(here, rec, busy, this.d.glyphs));
      this.waiting = rec;
      return;
    }
    this.waiting = null;
    this.follow(rec);
  }

  private follow(rec: ActiveRecord): void {
    const from = this.d.current();
    const left = this.d.running(from.root);
    this.d.move(rec.project);
    this.moves.push({ from: from.name, to: rec.project.name, at: Date.now() });
    this.d.notify(followedLine(from, rec, left, this.d.glyphs));
  }

  /** Watches the record's folder (again, once it exists); a burst of events is read once. */
  private watchRecord(): void {
    if (this.watcher || this.stopped) return;
    try {
      const name = basename(this.d.file);
      this.watcher = watch(dirname(this.d.file), { persistent: false }, (_event, file) => {
        // the record, or the temporary file its writer renames over it (src/project/index.ts saveActiveProject)
        if (file && !String(file).startsWith(name)) return;
        if (this.settle) clearTimeout(this.settle);
        this.settle = setTimeout(() => { this.settle = null; this.check(); }, SETTLE_MS);
        this.settle.unref();
      });
      this.watcher.on('error', () => { this.watcher?.close(); this.watcher = null; });
    } catch {
      // no state folder yet: the poll watches again once it is there
      this.watcher = null;
    }
  }
}
