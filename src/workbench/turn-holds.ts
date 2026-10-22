/**
 * R6 (H141; the interaction review of a77d80d, defect 3): the project's chat-turn holds (src/agent/chat-turn.ts), watched, so
 * the Workbench learns of a chat turn another process of the project answers (the REPL's, the monitor's, the companion's) as
 * soon as its hold is written, and of its end as soon as its hold is let go. Before, the Workbench saw another process's turn
 * only at its next workspace-frame reading (every few seconds): for the first 1 to 4.5 s of a REPL turn, x said "Stop current:
 * nothing runs" and the turn went on, while the run line said idle.
 *
 * How it watches: the folder's names, read every HOLDS_EVERY_MS (a directory listing, no process is asked), and the folder
 * itself through fs.watch where it is there and the platform tells of changes (a hold seen within milliseconds then; the
 * listing still catches what a watch misses). Before the project's first turn the folder is not there (the first hold makes
 * it): the watch is then on the nearest folder above it that is (.timmy, else the project's own) and moves onto the folder
 * once it is made (R8 H156: before, nothing was watched until then, so a project's first turn waited for the next listing).
 * When the names change the holds are
 * read at once (quickTurns: a fresh hold whose writer's pid runs is that writer's, without asking the process table, a program
 * run that takes hundreds of ms on a loaded computer); while a hold is there, again when its writer's pid runs no more and
 * every RECHECK_MS, and every PROOF_MS by the one reading every surface uses (runningTurns, which proves each writer by its pid
 * and its start). Read only: a hold whose writer has ended is no running turn, and is never removed here. A key that acts on a
 * turn (x, Enter on Stop the turn) reads them again (readNow) before it answers.
 */
import { lstatSync, readdirSync, readFileSync, statSync, watch, type FSWatcher } from 'node:fs';
import { dirname, join } from 'node:path';
import { CHAT_HOLD_SCHEMA, CHAT_TURNS_DIR, runningTurns, TURN_ID, type OtherTurn } from '../agent/chat-turn.js';
import type { ChatSurface } from '../contracts/chat-session.js';
import { THIS_PROCESS } from '../ops/process-proof.js';

/** How often the holds' names are listed (ms): a turn another process starts is seen within this, or at once by a watch. */
export const HOLDS_EVERY_MS = 200;
/** How often the holds are read in full while one is there (ms): a writer that ended without letting its hold go. */
export const RECHECK_MS = 1000;
/** How often, while a hold is there, its writer is proven by the process table too (its pid and when it started; ms). */
export const PROOF_MS = 5000;
/** A hold written this recently, by a pid that runs, is its writer's (ms): the process table is asked of older holds only. */
export const FRESH_MS = 10_000;

const pidRuns = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
};

/**
 * The holds read at once, without asking the process table (a program run, slow on a loaded computer): a hold of this process
 * is its own; another's counts as running while its pid runs and the hold was written in the last FRESH_MS (a pid is not
 * taken again within seconds of its process writing a hold); a hold whose pid runs no more is no running turn. Null when a
 * hold needs the full proof (an older one: its pid may be another process's now), or the folder is not plainly the project's
 * own (a link): runningTurns reads it then. Read only.
 */
export function quickTurns(root: string, now = Date.now()): OtherTurn[] | null {
  try { if (lstatSync(join(root, '.timmy')).isSymbolicLink() || lstatSync(join(root, CHAT_TURNS_DIR)).isSymbolicLink()) return null; } catch { return []; }
  const dir = join(root, CHAT_TURNS_DIR);
  let names: string[];
  try { names = readdirSync(dir).filter((n) => n.endsWith('.json') && TURN_ID.test(n.slice(0, -5))); } catch { return []; }
  const out: OtherTurn[] = [];
  for (const n of names) {
    let mtime: number;
    let rec: { schema?: unknown; surface?: unknown; owner?: { pid?: unknown; started?: unknown }; taken?: unknown };
    try {
      const st = lstatSync(join(dir, n));
      if (!st.isFile() || st.size > 16 * 1024) continue;
      mtime = st.mtimeMs;
      rec = JSON.parse(readFileSync(join(dir, n), 'utf8'));
    } catch { continue; }
    const pid = rec?.owner?.pid;
    if (!rec || rec.schema !== CHAT_HOLD_SCHEMA || typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 1 || typeof rec.owner?.started !== 'string') continue;
    const mine = pid === THIS_PROCESS.pid && rec.owner.started === THIS_PROCESS.started;
    if (!mine) {
      if (!pidRuns(pid)) continue;
      if (Math.abs(now - mtime) > FRESH_MS) return null;
    }
    out.push({ id: n.slice(0, -5), surface: rec.surface as ChatSurface, pid, taken: typeof rec.taken === 'string' ? rec.taken : '', mine, proof: 'alive' });
  }
  return out.sort((a, b) => a.taken.localeCompare(b.taken));
}

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
  proofMs?: number;
  /** false: no fs.watch (the listing alone) */
  watch?: boolean;
}

export class HoldWatch {
  private names = '';
  private reading: HoldsReading | null = null;
  /** when the holds were last proven by the process table too (runningTurns), this process's clock */
  private provenAt = 0;
  /**
   * R10 (H163; the turn-holds latency): when the holds' names (or the project) last changed, this process's clock. A hold first
   * seen is its writer's by quickTurns' rule (fresh, its pid runs) and is proven by the process table once PROOF_MS has passed
   * since, never on the next look: that proof is a program run (ps, 20 to 125 ms on a loaded computer), and it ran between a
   * hold's discovery and the frame that names it.
   */
  private namesAt = 0;
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

  /** Reads the holds now, whatever their names say (a key that acts on a turn); told on change as any reading is. */
  readNow(): HoldsReading {
    const root = this.d.root();
    return this.read(root, holdNames(root), false);
  }

  close(): void {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    if (this.pending) clearTimeout(this.pending);
    this.timer = null;
    this.pending = null;
    this.unwatch();
  }

  /**
   * The names listed; the holds read again when they changed or the project did (at once: quickTurns), and, while a hold is
   * there, when its writer's pid runs no more (a writer that ended without letting its hold go), every RECHECK_MS, and with
   * the process table's proof every PROOF_MS (R10 H163: the first one PROOF_MS after the holds' names last changed).
   */
  private look(): void {
    if (this.closed) return;
    const root = this.d.root();
    this.arm(root);
    const names = holdNames(root);
    const r = this.reading;
    const now = this.d.now();
    if (!r || r.root !== root || names !== this.names) { this.read(root, names, false); return; }
    if (names === '') return;
    if (now - Math.max(this.provenAt, this.namesAt) >= (this.d.proofMs ?? PROOF_MS)) { this.read(root, names, true); return; }
    const ended = r.turns.some((t) => !t.mine && !pidRuns(t.pid));
    if (ended || now - r.at >= (this.d.recheckMs ?? RECHECK_MS)) this.read(root, names, false);
  }

  /** The holds read: at once where that can be told (quickTurns), else (and with `full`) with the process table's proof. */
  private read(root: string, names: string, full: boolean): HoldsReading {
    let turns: OtherTurn[];
    const now = this.d.now();
    if (names !== this.names || this.reading?.root !== root) this.namesAt = now;
    try {
      if (this.d.read) turns = this.d.read(root);
      else {
        const quick = full ? null : quickTurns(root, Date.now());
        turns = quick ?? runningTurns(root, undefined, { readOnly: true });
        if (!quick) this.provenAt = now;
      }
    } catch { turns = []; }
    const next: HoldsReading = { root, at: now, turns };
    const changed = sigOf(next) !== sigOf(this.reading);
    this.reading = next;
    this.names = names;
    if (changed && !this.closed) this.d.onChange(next);
    return next;
  }

  /**
   * fs.watch on the project's chat-turns folder while it is there (a change is looked at in a few ms); never required.
   * R8 (H156; R7's open item A): while the folder is not there yet, on the nearest folder above it that is (.timmy, else the
   * project's own), so the folder's making is looked at in a few ms as well, and the next look moves the watch onto it.
   * Before, nothing was watched until the listing after the folder was made: the project's first turn was seen only then
   * (up to HOLDS_EVERY_MS late, more on a loaded computer).
   */
  private arm(root: string): void {
    if (this.d.watch === false) return;
    const dir = join(root, CHAT_TURNS_DIR);
    const target = [dir, dirname(dir), root].find((d) => { try { return statSync(d).isDirectory(); } catch { return false; } });
    if (!target) { this.unwatch(); return; }
    if (this.watcher && this.watched === target) return;
    this.unwatch();
    try {
      this.watcher = watch(target, { persistent: false }, () => this.soon());
      this.watcher.on('error', () => this.unwatch());
      this.watched = target;
    } catch { /* not watchable here: the listing looks every HOLDS_EVERY_MS */ }
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
