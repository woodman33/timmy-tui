/**
 * Round R4 (H51): whether the process a record names is still the one that wrote it, by the proof rule recovery uses
 * (src/repl/recover.ts): a pid alone is never enough, since pids are reused. A record names its writer by pid and by when
 * that process started; the writer is alive only when a process with that pid runs now AND it started then (the process
 * table's elapsed time, whole seconds, within a few seconds of the recorded start). A record whose writer is gone is
 * stale: it is shown as such and never trusted as a live hold.
 *
 * R4 (H82; the review of 6fb765a..4338fdb, finding 1): reading the process table is a program run (ps), and a board build
 * asked it once per record, inside a sort's comparator too: on the Mac (r22) one live-board page took about 16 minutes. A
 * view that checks many records runs inside withProcessTable: the table is read once for the whole view (every process at
 * once), and each record is looked up in that reading. Recovery and every other single check still ask about one pid, now.
 *
 * R10 (H163; the turn-holds latency, the lead's item (e)): a reading the event loop does not wait on. readProcessTable runs the
 * same ps -A as a child process and answers when it has; withProcessTable(fn, table) runs a view against a table so read, and
 * never runs a program: the Workbench's ticks and the workspace frame's builds read this way, so no key, timer or redraw waits
 * on ps (on a loaded computer 0.1 to 0.5 s each time). A pid that table does not list is no proof that its writer runs: a
 * writer that started before the table was read would be listed (ps -A lists every process), so it is gone and its pid is
 * another process's now; one that started after is unknown (taken as running, as when ps cannot answer) until the next reading.
 */
import { execFile, spawnSync } from 'node:child_process';

/** How far a process's start, as the process table reads it (whole seconds), may be from the start a record names. */
export const START_SLACK_MS = 3000;

/** This process as a record names it: its pid, and when it started (from its uptime). */
export const THIS_PROCESS: Readonly<{ pid: number; started: string }> = Object.freeze({
  pid: process.pid,
  started: new Date(Date.now() - Math.round(process.uptime() * 1000)).toISOString(),
});

/** ps's elapsed time ([[dd-]hh:]mm:ss) in seconds, or undefined. */
export function elapsedSeconds(t: string): number | undefined {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(t.trim());
  return m ? ((Number(m[1] ?? 0) * 24 + Number(m[2] ?? 0)) * 60 + Number(m[3])) * 60 + Number(m[4]) : undefined;
}

const pidAlive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
};

/** R4 (H82): how the process table is read, each way one run of ps. A seam: a test replaces it to count every reading. */
export interface ProcessTableReader {
  /** every process's pid and elapsed time in whole seconds (ps -A), or undefined when the table cannot be read */
  all(): Map<number, number> | undefined;
  /** one process's elapsed time in whole seconds (ps -p), or undefined when it cannot be read or runs no more */
  one(pid: number): number | undefined;
  /** R10 (H163): all(), answered by a child process the event loop does not wait on; a reader without it is asked all() */
  allAsync?(): Promise<Map<number, number> | undefined>;
}

const PS_ENV = (): NodeJS.ProcessEnv => ({ ...process.env, LC_ALL: 'C' });
const PS_ALL_ARGS = ['-A', '-o', 'pid=', '-o', 'etime='];

/** ps -A's lines: each process's pid and elapsed time in whole seconds. */
function tableOf(stdout: string): Map<number, number> {
  const rows = new Map<number, number>();
  for (const line of stdout.split('\n')) {
    const m = /^\s*(\d+)\s+(\S+)\s*$/.exec(line);
    const secs = m ? elapsedSeconds(m[2]) : undefined;
    if (m && secs !== undefined) rows.set(Number(m[1]), secs);
  }
  return rows;
}

/** The process table as ps reads it (macOS and Linux both take these options; src/repl/recover.ts reads it the same way). */
export const PS_READER: ProcessTableReader = {
  all: () => {
    try {
      const r = spawnSync('ps', PS_ALL_ARGS, { encoding: 'utf8', env: PS_ENV(), timeout: 5000, maxBuffer: 16 * 1024 * 1024 });
      if (r.status !== 0 || typeof r.stdout !== 'string') return undefined;
      return tableOf(r.stdout);
    } catch { return undefined; }
  },
  allAsync: () => new Promise((resolve) => {
    try {
      execFile('ps', PS_ALL_ARGS, { encoding: 'utf8', env: PS_ENV(), timeout: 5000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
        resolve(err || typeof stdout !== 'string' ? undefined : tableOf(stdout));
      });
    } catch { resolve(undefined); }
  }),
  one: (pid) => {
    try {
      const r = spawnSync('ps', ['-o', 'etime=', '-p', String(pid)], { encoding: 'utf8', env: PS_ENV(), timeout: 5000 });
      if (r.status !== 0 || typeof r.stdout !== 'string') return undefined;
      return elapsedSeconds(r.stdout.trim().split('\n')[0] ?? '');
    } catch { return undefined; }
  },
};

let reader: ProcessTableReader = PS_READER;
/** R4 (H82): the tests' seam: reads the process table through `r` until the returned function puts the previous reader back. */
export function useProcessTableReader(r: ProcessTableReader): () => void {
  const was = reader;
  reader = r;
  return () => { reader = was; };
}

/** One view's reading of the process table: taken when the view first needs a start, at `at`; null when ps could not answer.
 *  R10 (H163): `given`: read beforehand (readProcessTable), so a pid it does not list is never asked about by a program;
 *  `looked`: where the pids looked up in it are noted (the caller reads again what they decided once the table changes). */
interface TableReading { at: number; rows?: Map<number, number> | null; single: Map<number, number | undefined>; given?: boolean; looked?: Set<number> }
let reading: TableReading | undefined;

/** R10 (H163): the process table as read at `at` (this process's clock): each process's pid and elapsed whole seconds; null
 *  when ps could not answer. */
export interface ProcessTable { rows: Map<number, number> | null; at: number }

/**
 * R10 (H163; the turn-holds latency): the process table, read by ps -A as a child process the event loop does not wait on.
 * Never throws: a table ps could not give has null rows.
 */
export async function readProcessTable(): Promise<ProcessTable> {
  const r = reader;
  let rows: Map<number, number> | undefined;
  try { rows = r.allAsync ? await r.allAsync() : r.all(); } catch { rows = undefined; }
  return { rows: rows ?? null, at: Date.now() };
}

/** R10 (H163): what a table says of one pid: when that process started (ms, this process's clock), or null when it is not listed;
 *  undefined when the table could not be read. Two tables whose answers differ by more than START_SLACK_MS say different things. */
export function startIn(table: ProcessTable, pid: number): number | null | undefined {
  if (!table.rows) return undefined;
  const secs = table.rows.get(pid);
  return secs === undefined ? null : table.at - secs * 1000;
}

/**
 * R4 (H82): runs `fn` (synchronous: a board build, a view of many records) with one reading of the process table for all
 * it asks: the first start it needs reads every process at once; every later one is looked up in that reading. A pid the
 * reading does not hold (a process that started after it, or one ps did not list) is asked on its own, once per view. A
 * call inside another shares the outer reading. Nothing is cached past `fn`: the next view reads the table again.
 */
export function withProcessTable<T>(fn: () => T, table?: ProcessTable, looked?: Set<number>): T {
  if (reading) return fn();
  // R10 (H163): with `table`, the view runs against that reading and runs no program (a pid it does not list: see writerState)
  reading = table ? { at: table.at, rows: table.rows, single: new Map(), given: true, ...(looked ? { looked } : {}) } : { at: 0, single: new Map() };
  try { return fn(); } finally { reading = undefined; }
}

const startOf = (secs: number | undefined, at: number): number | undefined => (secs === undefined ? undefined : at - secs * 1000);

/** When the process with this pid started (ms), from the process table, or undefined when it cannot be read or runs no more. */
export function processStartMs(pid: number): number | undefined {
  const r = reading;
  if (!r) return startOf(reader.one(pid), Date.now());
  if (r.given) { r.looked?.add(pid); const at = startIn({ rows: r.rows ?? null, at: r.at }, pid); return at ?? undefined; }
  if (r.rows === undefined) { r.rows = reader.all() ?? null; r.at = Date.now(); }
  const secs = r.rows?.get(pid);
  if (secs !== undefined) return startOf(secs, r.at);
  if (!r.single.has(pid)) r.single.set(pid, startOf(reader.one(pid), Date.now()));
  return r.single.get(pid);
}

/**
 * Whether a record's writer runs now: 'alive' (this process, or a process with its pid that started when it did),
 * 'gone' (no such process, or one that started at another time: its pid was reused), or 'unknown' (a process with its
 * pid runs and the process table could not be read). A caller holding something for safety treats 'unknown' as alive.
 */
export function writerState(owner: { pid?: unknown; started?: unknown } | undefined): 'alive' | 'gone' | 'unknown' {
  const pid = owner?.pid;
  const started = typeof owner?.started === 'string' ? Date.parse(owner.started) : Number.NaN;
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 1 || Number.isNaN(started)) return 'gone';
  if (pid === THIS_PROCESS.pid) return owner?.started === THIS_PROCESS.started ? 'alive' : 'gone';
  if (!pidAlive(pid)) return 'gone';
  // R10 (H163): a table read beforehand that does not list this running pid: its writer, had it started before the table was
  // read, would be listed (so it is gone: the pid is another process's now); one that started after is unknown until the next
  // reading. No program is run for it.
  const r = reading;
  if (r?.given && r.rows) {
    r.looked?.add(pid);
    if (!r.rows.has(pid)) return started + START_SLACK_MS < r.at ? 'gone' : 'unknown';
  }
  const at = processStartMs(pid);
  if (at === undefined) return 'unknown';
  return Math.abs(at - started) <= START_SLACK_MS ? 'alive' : 'gone';
}
