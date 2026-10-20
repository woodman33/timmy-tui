/**
 * R6 (H140; the one waiting count, the operator's order of 2026-10-16, priority 2; the R5 interaction review, defect 2: Studio
 * said "1 waiting on you" while the Workbench and the page said 0): the NEEDS YOU boxes a Timmy process waits on, shared with
 * every other process of this Timmy home. src/repl/approvals.ts keeps them in its process's memory (waitingApprovals); each
 * process that waits on one keeps them here as well, <TIMMY_HOME>/state/waiting/<pid>.json (0600, written whole), naming its
 * process (pid and start, src/ops/process-proof.ts) and the folder it works in; the file goes when its last box is answered.
 * A reader counts the boxes of the live processes working in its project (its own from memory, never from here); a record whose
 * process is gone is no box (a killed process left it), and is not counted.
 *
 * It names a box's tool, its reason and summary (as the box shows them), when it began to wait and the operation it belongs
 * to; never an argument's full value.
 */
import { chmodSync, closeSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { timmyHome } from '../setup/home.js';
import { THIS_PROCESS, writerState } from './process-proof.js';

type Env = Record<string, string | undefined>;

export const WAITING_SCHEMA = 'timmy.waiting/1' as const;

/** A box as another process reads it (the fields of src/repl/approvals.ts WaitingApproval that say what waits). */
export interface SharedBox {
  tool: string;
  reason: string;
  summary: string;
  session: boolean;
  since: number;
  shown: boolean;
  operation?: string;
  words?: { title: string; needed: string; why: string; commands: string[]; keys: boolean; kind?: string };
}

/** Another process's boxes, with where it waits. */
export interface ElsewhereBox extends SharedBox { pid: number }

export const waitingDir = (env: Env = process.env): string => join(timmyHome(env), 'state', 'waiting');

/**
 * R6 (H140): the map src/repl/approvals.ts keeps its waiting boxes in: each box set or deleted keeps this process's boxes for
 * the others at once (publishWaiting), so a box counts in every process while it waits and in none once it is answered. A
 * record that cannot be written leaves this process counting its own, as before.
 */
export class SharedWaiting<K, V extends SharedBox> extends Map<K, V> {
  set(key: K, value: V): this { super.set(key, value); this.share(); return this; }
  delete(key: K): boolean { const had = super.delete(key); if (had) this.share(); return had; }
  private share(): void { try { publishWaiting([...this.values()]); } catch { /* not shared */ } }
}

const real = (p: string): string => { try { return realpathSync(p); } catch { return p; } };

/**
 * Keeps this process's boxes for the other processes (an empty list removes its record). `root`: the folder it works in (its
 * project's; this process's folder when not given). A record that cannot be written changes nothing here.
 */
export function publishWaiting(boxes: readonly SharedBox[], o: { root?: string; env?: Env } = {}): boolean {
  const env = o.env ?? process.env;
  const file = join(waitingDir(env), `${THIS_PROCESS.pid}.json`);
  try {
    if (!boxes.length) { rmSync(file, { force: true }); return true; }
    // a folder only its owner reads (0700), each record 0600: they name what a box shows on screen, never more
    mkdirSync(waitingDir(env), { recursive: true, mode: 0o700 });
    chmodSync(waitingDir(env), 0o700);
    const kept = boxes.map((b) => ({
      tool: b.tool, reason: b.reason, summary: b.summary, session: b.session, since: b.since, shown: b.shown, ...(b.operation ? { operation: b.operation } : {}),
      ...(b.words ? { words: { title: b.words.title, needed: b.words.needed, why: b.words.why, commands: [...b.words.commands], keys: b.words.keys, ...(b.words.kind ? { kind: b.words.kind } : {}) } } : {}),
    }));
    const body = { schema: WAITING_SCHEMA, pid: THIS_PROCESS.pid, started: THIS_PROCESS.started, root: real(o.root ?? process.cwd()), at: new Date().toISOString(), boxes: kept };
    const tmp = `${file}.tmp`;
    const fd = openSync(tmp, 'w', 0o600);
    try { writeSync(fd, `${JSON.stringify(body)}\n`); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}

/**
 * The boxes other live processes wait on in the project at `root` (never this process's: it reads its own from memory). A
 * record of a process that is gone, or one that cannot be read, is no box.
 */
export function othersWaiting(root: string, o: { env?: Env; alive?: (owner: { pid?: unknown; started?: unknown }) => 'alive' | 'gone' | 'unknown' } = {}): ElsewhereBox[] {
  const env = o.env ?? process.env;
  const alive = o.alive ?? writerState;
  const here = real(root);
  let names: string[] = [];
  try { names = readdirSync(waitingDir(env)).filter((n) => /^\d+\.json$/.test(n)); } catch { return []; }
  const out: ElsewhereBox[] = [];
  for (const n of names) {
    try {
      const r = JSON.parse(readFileSync(join(waitingDir(env), n), 'utf8')) as { schema?: unknown; pid?: unknown; started?: unknown; root?: unknown; boxes?: unknown };
      if (r?.schema !== WAITING_SCHEMA || typeof r.pid !== 'number' || r.pid === THIS_PROCESS.pid || typeof r.root !== 'string' || real(r.root) !== here || !Array.isArray(r.boxes)) continue;
      if (alive({ pid: r.pid, started: r.started }) === 'gone') continue;
      for (const b of r.boxes as SharedBox[]) {
        if (b && typeof b.tool === 'string' && typeof b.since === 'number') out.push({ ...b, pid: r.pid as number });
      }
    } catch { /* unreadable: no box */ }
  }
  return out.sort((a, b) => a.since - b.since);
}
