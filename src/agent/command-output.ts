import { randomBytes } from 'node:crypto';
import { closeSync, mkdirSync, openSync, writeSync } from 'node:fs';
import { join, relative } from 'node:path';
import { spawnProcess } from '../runtime/spawn-runtime.js';

/*
 * R2 output limit: what a command prints reaches the model as a bounded view, never whole. Each stream
 * keeps its first VIEW_HEAD_BYTES and its last VIEW_TAIL_BYTES (the end is where errors and summaries
 * usually are), so both streams together stay within 32 KiB plus their markers, and the marker says how
 * many bytes were left out and where the rest is. The workspace command's full output goes to a log under
 * the working folder's .timmy/runs/, up to a hard cap; large output alone no longer stops a command.
 */

/** The start of each stream the model sees. */
export const VIEW_HEAD_BYTES = 4 * 1024;
/** The end of each stream the model sees. */
export const VIEW_TAIL_BYTES = 12 * 1024;
/** The hard cap on one command's log: output past it stops the command, with that reason. */
export const LOG_CAP_BYTES = 256 * 1024 * 1024;

/** A byte count as people read it: 4,812,334. */
export const count = (n: number): string => n.toLocaleString('en-US');

/** The first and the last bytes of one stream, and how many there were; memory stays near head + tail. */
class StreamWindow {
  private head: Buffer[] = [];
  private headLen = 0;
  private tail: Buffer[] = [];
  private tailLen = 0;
  total = 0;

  constructor(private readonly headMax = VIEW_HEAD_BYTES, private readonly tailMax = VIEW_TAIL_BYTES) {}

  push(chunk: Buffer): void {
    this.total += chunk.length;
    let rest = chunk;
    if (this.headLen < this.headMax) {
      const take = Math.min(this.headMax - this.headLen, rest.length);
      this.head.push(Buffer.from(rest.subarray(0, take)));
      this.headLen += take;
      rest = rest.subarray(take);
    }
    if (rest.length === 0) return;
    this.tail.push(Buffer.from(rest));
    this.tailLen += rest.length;
    // Drop whole chunks from the front while what remains still covers the tail.
    while (this.tail.length > 1 && this.tailLen - this.tail[0].length >= this.tailMax) this.tailLen -= this.tail.shift()!.length;
  }

  /** Whether the view has to leave something out. */
  get over(): boolean {
    return this.total > this.headMax + this.tailMax;
  }

  /** The whole stream when it fits; otherwise its start, the marker on a line of its own, and its end. */
  view(marker: (omitted: number) => string): string {
    const head = Buffer.concat(this.head);
    const tail = Buffer.concat(this.tail);
    if (!this.over) return Buffer.concat([head, tail]).toString('utf8');
    // Never cut through a character: the head ends before one it holds only part of, the tail starts on one.
    let end = head.length;
    let lead = end - 1;
    while (lead > 0 && lead > end - 4 && (head[lead] & 0xc0) === 0x80) lead--;
    const first = head[lead] ?? 0;
    const width = first >= 0xf0 ? 4 : first >= 0xe0 ? 3 : first >= 0xc0 ? 2 : 1;
    if (lead + width > end) end = lead;
    let start = Math.max(0, tail.length - this.tailMax);
    while (start < tail.length && (tail[start] & 0xc0) === 0x80) start++;
    const omitted = this.total - end - (tail.length - start);
    return `${head.subarray(0, end).toString('utf8')}\n${marker(omitted)}\n${tail.subarray(start).toString('utf8')}`;
  }
}

/**
 * The bounded view of output that is already in memory (a program's report, a Daytona reply): unchanged
 * when it fits, otherwise its start and its end with a marker. Nothing of the middle is kept.
 */
export function boundOutput(text: string): string {
  if (Buffer.byteLength(text, 'utf8') <= VIEW_HEAD_BYTES + VIEW_TAIL_BYTES) return text;
  const w = new StreamWindow();
  w.push(Buffer.from(text, 'utf8'));
  return w.view((n) => `[… ${count(n)} bytes not shown …]`);
}

export interface LocalCommandOptions {
  /** The working folder: the command runs here and its log goes under .timmy/runs/ here. */
  cwd: string;
  /** Stop the command and its process group after this many ms. */
  timeoutMs: number;
  /** The log's hard cap (default LOG_CAP_BYTES). */
  logCapBytes?: number;
  /** Round R3: after a stop's SIGTERM (the time limit, the cap), SIGKILL follows this many ms later when the
   *  group has not ended (default the runner's KILL_GRACE_MS, 2 s). */
  killGraceMs?: number;
}

export interface LocalCommandRun {
  status: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  /** The spawn error (ENOENT …), or why the run settled while its output was still open after a stop
   *  (a process it started outside its group may still run); null when the command ran to its end. */
  error: string | null;
  /** Round R3: how far a stop went: 'SIGTERM', or 'SIGKILL' when the group outlived the grace period; null
   *  when nothing was stopped. */
  killed: 'SIGTERM' | 'SIGKILL' | null;
  /** The bounded views the model gets. */
  stdout: string;
  stderr: string;
  /** Everything the command printed on each stream (up to the cap, when it was reached). */
  stdoutBytes: number;
  stderrBytes: number;
  /** The log, relative to the working folder; '' when the output fit the view and no log was needed. */
  log: string;
  /** The output reached the cap, and the command was stopped with its process group. */
  logFull: boolean;
  logCapBytes: number;
  /** Why the full output could not be kept, when it could not. */
  logError: string | null;
}

/**
 * Runs `sh -c command` in its own process group with a time limit (as the workspace command always has),
 * streaming its output instead of holding it: each stream into a bounded view, and both together, in the
 * order they arrive, into .timmy/runs/command-<time>-<random>.log (mode 0600). The log is written only
 * when the view has to leave something out; until then the little there is stays in memory.
 *
 * The log holds the output as the text the command printed, decoded as UTF-8: output that is valid UTF-8
 * is kept byte for byte; bytes that are not (binary output) are written as U+FFFD.
 */
export async function runLocalCommand(command: string, o: LocalCommandOptions): Promise<LocalCommandRun> {
  const cap = o.logCapBytes && o.logCapBytes > 0 ? o.logCapBytes : LOG_CAP_BYTES;
  const out = new StreamWindow();
  const err = new StreamWindow();
  let pending: Buffer[] | null = [];
  let fd: number | null = null;
  let logPath = '';
  let seen = 0;
  let logFull = false;
  let logError: string | null = null;
  let stop = (): void => {};

  const runs = join(o.cwd, '.timmy', 'runs');
  const openLog = (): void => {
    try {
      mkdirSync(runs, { recursive: true });
      for (let attempt = 0; fd === null; attempt++) {
        const name = `command-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomBytes(4).toString('hex')}.log`;
        try {
          fd = openSync(join(runs, name), 'wx', 0o600);
          logPath = join(runs, name);
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'EEXIST' || attempt >= 5) throw e;
        }
      }
    } catch (e) {
      logError = `could not create a log in ${relative(o.cwd, runs)}: ${(e as Error).message}`;
    }
  };
  const write = (chunk: Buffer): void => {
    if (fd === null) return;
    try {
      for (let off = 0; off < chunk.length;) off += writeSync(fd, chunk, off, chunk.length - off);
    } catch (e) {
      logError = `could not write ${relative(o.cwd, logPath)}: ${(e as Error).message}`;
      try { closeSync(fd); } catch { /* already failing */ }
      fd = null;
    }
  };
  const take = (win: StreamWindow, text: string): void => {
    // Past the cap nothing more is kept or counted: the view and the log end at the same byte.
    if (logFull || text.length === 0) return;
    let chunk = Buffer.from(text, 'utf8');
    let reached = false;
    if (logError === null && seen + chunk.length > cap) {
      chunk = chunk.subarray(0, cap - seen);
      reached = true;
    }
    seen += chunk.length;
    win.push(chunk);
    if (pending) {
      pending.push(chunk);
      if (out.over || err.over || reached) {
        openLog();
        for (const p of pending) write(p);
        pending = null;
      }
    } else {
      write(chunk);
    }
    if (reached && logError === null) {
      logFull = true;
      stop();
    }
  };

  const run = spawnProcess('sh', ['-c', command], {
    cwd: o.cwd,
    detached: true,
    timeoutMs: o.timeoutMs,
    capture: false,
    ...(o.killGraceMs !== undefined ? { killGraceMs: o.killGraceMs } : {}),
    onStdout: (text) => take(out, text),
    onStderr: (text) => take(err, text),
  });
  // The cap's stop is the time limit's: SIGTERM to the group, SIGKILL after the grace period (round R3).
  stop = () => { run.stop(); };
  const r = await run.outcome;
  if (fd !== null) {
    try { closeSync(fd); } catch { /* the bytes are written; a failed close loses nothing */ }
    fd = null;
  }

  const log = logPath ? relative(o.cwd, logPath) : '';
  const where = logError !== null
    ? `no full copy was kept: ${logError}`
    : logFull
      ? `the log holds only the first ${count(cap)} bytes (its limit), in ${log}`
      : `the full output is in ${log}`;
  const marker = (n: number): string => `[… ${count(n)} bytes not shown; ${where} …]`;
  return {
    status: r.status,
    signal: r.signal,
    timedOut: r.timedOut,
    error: r.error,
    killed: r.killed,
    stdout: out.view(marker),
    stderr: err.view(marker),
    stdoutBytes: out.total,
    stderrBytes: err.total,
    log,
    logFull,
    logCapBytes: cap,
    logError,
  };
}
