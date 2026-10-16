/**
 * R6 (H141; the interaction review of a77d80d, defect 3): the project's chat-turn holds (src/agent/chat-turn.ts), watched, so
 * the Workbench learns of a chat turn another process of the project answers (the REPL's, the monitor's, the companion's) as
 * soon as its hold is written, and of its end as soon as its hold is let go. Before, the Workbench saw another process's turn
 * only at its next workspace-frame reading (every few seconds): for the first 1 to 4.5 s of a REPL turn, x said "Stop current:
 * nothing runs" and the turn went on, while the run line said idle.
 *
 * How it watches: the folder's names, read every HOLDS_EVERY_MS (a directory listing, no process is asked), and the folder
 * itself through fs.watch where it is there and the platform tells of changes (a hold seen within milliseconds then; the
 * listing still catches what a watch misses, and the folder made after the watch began). Only when the names change, and
 * every RECHECK_MS while a hold is there (its writer may have ended without letting it go), are the holds read in full, by the
 * one reading every surface uses (runningTurns, read only: a hold whose writer has ended is no running turn and is never
 * removed here). A key that acts on a turn (x, Enter on Stop the turn) reads them at once (readNow), before it answers.
 */
import { readdirSync, watch, type FSWatcher } from 'node:fs';
import { join } from 'node:path';
import { CHAT_TURNS_DIR, runningTurns, TURN_ID, type OtherTurn } from '../agent/chat-turn.js';

/** How often the holds' names are listed (ms): a turn another process starts is seen within this, or at once by a watch. */
export const HOLDS_EVERY_MS = 200;
/** How often the holds are read in full while one is there (ms): a writer that ended without letting its hold go. */
export const RECHECK_MS = 1000;

/** One reading of a project's chat-turn holds: the project's folder, when (this process's clock), and the turns held then. */
export interface HoldsReading { root: string; at: number; turns: OtherTurn[] }

/** The names of the holds in the project's chat-turns folder now, sorted (no process is asked); '' when there are none. */
export function holdNames(root: string): string {
  try {
    return readdirSync(join(root, CHAT_TURNS_DIR)).filter((n) => n.endsWith('.json') && TURN_ID.test(n.slice(0, -5))).sort().join(',');
  } catch { return ''; }
}

/** A reading's turns in a form two readings compare by: each turn's id and whether its writer was proven alive. */
const sigOf = (r: HoldsReading | null): string => (r ? `${r.root}|${r.turns.map((t) => `${t.id}:${t.proof}:${t.mine ? 1 : 0}`).join(',')}` : '');

export interface HoldWatchDeps {
  /** the project folder shown now (followed when it changes) */
  root: () => string;
  /** this process's clock (ms) */
  now: () => number;
  /** told when the holds read differ from the last reading (a turn began or ended, or the project changed) */
  onChange: (r: HoldsReading) => void;
  /** the holds in full (a test's FAKE); else runningTurns, read only */
  read?: (root: string) => OtherTurn[];
  everyMs?: number;
  recheckMs?: number;
  /** false: no fs.watch (the listing alone) */
  watch?: boolean;
}

export class HoldWatch {
  private names = '';
  private reading: HoldsReading | null = null;
  private timer: NodeJS.Timeout | null = null;
  private pending: NodeJS.Timeout | null = null;
  private watcher: FSWatcher | null = null;
  private watched = '';
  private closed = false;

  constructor(private readonly d: HoldWatchDeps) {}

  /** The last reading (null until the first). */
  get last(): HoldsReading | null { return this.reading; }

  start(): void {
    if (this.timer || this.closed) return;
    this.timer = setInterval(() => this.look(), this.d.everyMs ?? HOLDS_EVERY_MS);
    this.timer.unref?.();
    this.look();
  }

  /** Reads the holds in full now, whatever their names say (a key that acts on a turn); told on change as any reading is. */
  readNow(): HoldsReading {
    const root = this.d.root();
    return this.read(root, holdNames(root));
  }

  close(): void {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    if (this.pending) clearTimeout(this.pending);
    this.timer = null;
    this.pending = null;
    this.unwatch();
  }

  /** The names listed; the holds read in full when they changed, when the project changed, or (a hold there) every RECHECK_MS. */
  private look(): void {
    if (this.closed) return;
    const root = this.d.root();
    this.arm(root);
    const names = holdNames(root);
    const r = this.reading;
    const due = !r || r.root !== root || names !== this.names || (names !== '' && this.d.now() - r.at >= (this.d.recheckMs ?? RECHECK_MS));
    if (due) this.read(root, names);
  }

  private read(root: string, names: string): HoldsReading {
    let turns: OtherTurn[];
    try { turns = (this.d.read ?? ((x: string) => runningTurns(x, undefined, { readOnly: true })))(root); } catch { turns = []; }
    const next: HoldsReading = { root, at: this.d.now(), turns };
    const changed = sigOf(next) !== sigOf(this.reading);
    this.reading = next;
    this.names = names;
    if (changed && !this.closed) this.d.onChange(next);
    return next;
  }

  /** fs.watch on the project's chat-turns folder while it is there (a change is looked at in a few ms); never required. */
  private arm(root: string): void {
    if (this.d.watch === false) return;
    const dir = join(root, CHAT_TURNS_DIR);
    if (this.watcher && this.watched === dir) return;
    this.unwatch();
    try {
      this.watcher = watch(dir, { persistent: false }, () => this.soon());
      this.watcher.on('error', () => this.unwatch());
      this.watched = dir;
    } catch { /* not there yet (the first turn makes it), or not watchable here: the listing looks every HOLDS_EVERY_MS */ }
  }

  private unwatch(): void {
    try { this.watcher?.close(); } catch { /* closed */ }
    this.watcher = null;
    this.watched = '';
  }

  private soon(): void {
    if (this.pending || this.closed) return;
    this.pending = setTimeout(() => { this.pending = null; this.look(); }, 15);
    this.pending.unref?.();
  }
}
