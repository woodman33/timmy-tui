/**
 * R4 (H112): what a running job prints, for Activity (the operator's Workbench direction: "a separate expandable Activity strip
 * for running work, decisions and logs"; "Preserve text selection, scrolling and focus while output streams").
 *
 * A job's output is its own log (JobRecord.logPath, written by the job store as the job prints). OutputWatch reads only what
 * was added to it since its last look (from a byte offset), splits it into lines as the job store does (src/jobs LineSplitter),
 * and keeps each line the first time it sees it, with when it saw it (a log has no times of its own, so the time is when it
 * was read, within a tick of when it was printed) and a number in the order seen.
 *
 * upmd on a terminal (Timmy's /run, through workers/upmd/pty_run.py) does not print a line once: it draws a block (its header
 * ` [n/m] Lang`, its code, a blank line, its output so far and a drawn cursor), and for each new line of output moves the
 * cursor up (ESC[nA, by more rows than it drew: upmd 0.2.7's own bytes, tests/fixtures/upmd-0.2.7-pty-third.bin, move up 94,
 * 96 and 112 rows), erases below (ESC[J) and draws the block again; as the block ends it draws its summary (`==> name [block
 * n]`, its whole output again and `✔ exited with code 0` or `✘ exited with code <c>`). So each drawing is read as one
 * snapshot of that block's output: the header starts a snapshot, its code is not output, and a line of it is known by the
 * block, its words and how many lines of the same words come before it in the block. A redraw or the summary then adds
 * nothing already seen, a line printed again in a later block is that block's own, and nothing is shown twice. The exit line
 * is left out (the job's own events say how each block ended). Any other job's lines are each new, in order; one read adds the
 * newest PLAIN_MAX of them at most (the earlier ones are counted, and /jobs <id> in the REPL shows the log).
 *
 * Text only: every escape sequence and control character is removed, a home folder is written as ~ (the caller's scrub), a
 * line is cut at LINE_MAX. Nothing here writes, runs or seals; a log that cannot be read gives no lines.
 */
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import { LineSplitter } from '../jobs/index.js';

/** A job's line as Activity shows it. */
export interface OutputLine {
  job: string;
  /** its place in the order this Workbench saw the job's lines (from 1) */
  n: number;
  text: string;
  /** when this Workbench first read it (ISO) */
  at: string;
  operation?: string;
}

/** The longest line kept (a longer one is cut, its end said). */
const LINE_MAX = 400;
/** The most new lines of a job that is not a drawing one read adds (the rest are counted in one line). */
export const PLAIN_MAX = 40;
/** How much of a log is read at most in one look (a job first seen mid-run starts this far from its end). */
const READ_MAX = 64 * 1024;

// CSI (with its parameters and intermediates), OSC (to BEL or ST), two-character escapes, a lone ESC
const ESCAPE = /\x1b\[[0-9;?<=>]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[@-Z\\-_]|\x1b/g;
/** A cursor move up or an erase below: a terminal program is about to draw again. */
const REDRAW = /\x1b\[\d*[AJ]/;
const HEADER = /^ ?\[(\d+)\/\d+\] \S/;
const SUMMARY = /^==> (.+) \[block (\d+)\]$/;
const EXITED = /^[✔✘] exited with code -?\d+$/;

/** R6 (H141): a line made only of a rule's marks (and blanks between them). */
const RULE = /^[\s─━═╌╍┄┅┈┉\-–—_=~*]+$/u;

/**
 * R6 (H141; the R5 review's defect 23, REMAINING-DEFECTS #16): a line a job printed that is only a rule (eight or more of
 * ─ ━ ═ - = _ ~ * and their kin; upmd prints one between blocks), as Activity and the Control Room's panes say it: drawn as
 * printed, cut at the pane's edge, it read as the box's own border. Its first three marks, then the words that it is the job's
 * output, and how many marks it had; null for any other line (drawn as printed).
 */
export function ruleWords(text: string): string | null {
  const t = text.trim();
  if (!t || !RULE.test(t)) return null;
  const marks = [...t].filter((ch) => !/\s/.test(ch));
  if (marks.length < 8) return null;
  return `${marks.slice(0, 3).join('')} a rule in its output (${marks.length} ${marks[0]})`;
}

/** A line's text: escape sequences and control characters removed, tabs as two spaces, its trailing blanks dropped. */
export function lineText(raw: string): string {
  return raw.replace(ESCAPE, '').replace(/\t/g, '  ').replace(/[\x00-\x1f\x7f-\x9f]/g, '').replace(/\s+$/, '');
}

type Mode = 'plain' | 'redraw' | 'code' | 'gap' | 'out' | 'summary';

interface Watched {
  offset: number;
  /** a read that ends inside a character keeps its first bytes for the next */
  decode: StringDecoder;
  split: LineSplitter;
  mode: Mode;
  block: number;
  /** the block's lines in the drawing being read: each text's count so far (a line's place among its like) */
  counts: Map<string, number>;
  known: Set<string>;
  lines: OutputLine[];
  next: number;
  /** a drawing job (upmd on a pty): its blocks' drawings are read as snapshots */
  drawn: boolean;
  /** read once more after it ended, then no more */
  done: boolean;
}

export interface WatchedJob {
  id: string;
  operation?: string;
  /** its log (JobRecord.logPath) */
  logPath: string;
  /** upmd on a pty (src/workflows/upmd-live.ts isLiveRun): its lines are drawings */
  drawn: boolean;
  /** it runs now; once it has ended, its log is read one last time */
  live: boolean;
}

/** Reads `max` bytes at most of a file from `offset` (its bytes, where they began, and where they end); null when it cannot. */
export type ReadFrom = (path: string, offset: number, max: number) => { bytes: Buffer; size: number; from: number } | null;

export const readFrom: ReadFrom = (path, offset, max) => {
  let fd: number;
  try { fd = openSync(path, 'r'); } catch { return null; }
  try {
    const size = fstatSync(fd).size;
    // a log shorter than the offset was written anew: read it from its start
    const from = size < offset ? 0 : Math.max(offset, size - max, 0);
    const length = Math.max(0, size - from);
    if (!length) return { bytes: Buffer.alloc(0), size, from };
    const buf = Buffer.alloc(length);
    const read = readSync(fd, buf, 0, length, from);
    return { bytes: buf.subarray(0, read), size: from + read, from };
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
};

/** Each job's lines in the order this Workbench first saw them. */
export class OutputWatch {
  private readonly jobs = new Map<string, Watched>();

  constructor(private readonly o: { perJob?: number; jobs?: number; read?: ReadFrom } = {}) {}

  /** Reads what the job's log gained since the last look; the lines not seen before are kept, with `at`, and returned. */
  read(job: WatchedJob, at: string, scrub: (t: string) => string = (t) => t): OutputLine[] {
    let w = this.jobs.get(job.id);
    if (w?.done) return [];
    const got = (this.o.read ?? readFrom)(job.logPath, w?.offset ?? 0, READ_MAX);
    if (!got) return [];
    let bytes = got.bytes;
    if (!w) {
      // first seen: from the start of its log, or (a long one) from a line's start near its end
      w = { offset: 0, decode: new StringDecoder('utf8'), split: new LineSplitter(), mode: job.drawn && got.from > 0 ? 'redraw' : 'plain', block: 0, counts: new Map(), known: new Set(), lines: [], next: 1, drawn: job.drawn, done: false };
      this.jobs.set(job.id, w);
      const most = this.o.jobs ?? 24;
      while (this.jobs.size > most) this.jobs.delete(this.jobs.keys().next().value as string);
      if (got.from > 0) {
        const nl = bytes.indexOf(10);
        bytes = nl >= 0 ? bytes.subarray(nl + 1) : Buffer.alloc(0);
      }
    } else if (got.from > w.offset) {
      // more was added than one look reads: what lies between is skipped, and the drawing is read afresh from a line's start
      w.decode = new StringDecoder('utf8');
      w.split = new LineSplitter();
      w.mode = w.drawn ? 'redraw' : 'plain';
      const nl = bytes.indexOf(10);
      bytes = nl >= 0 ? bytes.subarray(nl + 1) : Buffer.alloc(0);
    }
    w.offset = got.size;
    const raw = w.split.push(w.decode.write(bytes));
    if (!job.live) { raw.push(...w.split.push(w.decode.end()), ...w.split.end()); w.done = true; }
    return this.feed(w, job, raw, at, scrub);
  }

  /** The job's raw lines, read in order (exported for the tests: `feed` without a file). */
  feedLines(job: Omit<WatchedJob, 'logPath'>, raw: readonly string[], at: string, scrub: (t: string) => string = (t) => t): OutputLine[] {
    let w = this.jobs.get(job.id);
    if (!w) {
      w = { offset: 0, decode: new StringDecoder('utf8'), split: new LineSplitter(), mode: 'plain', block: 0, counts: new Map(), known: new Set(), lines: [], next: 1, drawn: job.drawn, done: false };
      this.jobs.set(job.id, w);
    }
    return this.feed(w, job, raw, at, scrub);
  }

  private feed(w: Watched, job: Pick<WatchedJob, 'id' | 'operation'>, given: readonly string[], at: string, scrub: (t: string) => string): OutputLine[] {
    const added: OutputLine[] = [];
    const add = (text: string, key: string | null): void => {
      if (key !== null) {
        if (w.known.has(key)) return;
        w.known.add(key);
      }
      const shown = scrub(text);
      const line: OutputLine = { job: job.id, n: w.next++, text: shown.length > LINE_MAX ? `${shown.slice(0, LINE_MAX)}… (cut at ${LINE_MAX} characters)` : shown, at, ...(job.operation ? { operation: job.operation } : {}) };
      w.lines.push(line);
      added.push(line);
    };
    // a job that is not a drawing: the newest PLAIN_MAX lines of one look, the earlier ones counted (its log keeps them)
    let raw = given;
    if (!w.drawn) {
      const printed = given.filter((r) => lineText(r).trim());
      if (printed.length > PLAIN_MAX) {
        const skipped = printed.length - PLAIN_MAX;
        add(`… ${skipped} earlier line${skipped === 1 ? '' : 's'} printed (/jobs ${job.id} in the REPL shows its log)`, `more:${w.next}`);
        raw = printed.slice(-PLAIN_MAX);
      }
    }
    // a line of the block's drawing or summary: known by the block, its words and its place among its like in this drawing
    const drawnLine = (text: string): void => {
      const k = w.counts.get(text) ?? 0;
      w.counts.set(text, k + 1);
      add(text, `${w.block}\u0000${text}\u0000${k}`);
    };
    for (const r of raw) {
      const text = lineText(r).trimStart();
      if (w.drawn && REDRAW.test(r) && !text) { w.mode = 'redraw'; continue; }
      if (w.drawn) {
        const h = HEADER.exec(text);
        if (h) { w.block = Number(h[1]); w.mode = 'code'; w.counts = new Map(); continue; }
        const s = SUMMARY.exec(text);
        if (s) { w.block = Number(s[2]); w.mode = 'summary'; w.counts = new Map(); continue; }
      }
      switch (w.mode) {
        case 'redraw': if (text) { w.mode = 'plain'; add(text, null); } continue;
        case 'code': if (!text) w.mode = 'gap'; continue; // the block's code is the document's, not its output
        case 'gap': if (!text) continue; w.mode = 'out'; drawnLine(text); continue;
        case 'out': if (text) drawnLine(text); continue; // a blank is the drawn cursor
        case 'summary':
          if (!text) { w.mode = 'plain'; continue; } // the summary ends with a blank line
          if (!EXITED.test(text)) drawnLine(text);
          continue;
        default: if (text) add(text, null);
      }
    }
    const keep = this.o.perJob ?? 80;
    if (w.lines.length > keep) w.lines.splice(0, w.lines.length - keep);
    return added;
  }

  /** Whether this job's log is being read (it was seen running). */
  watching(job: string): boolean { return this.jobs.has(job); }

  /** A job's kept lines, oldest first. */
  lines(job: string): OutputLine[] { return [...(this.jobs.get(job)?.lines ?? [])]; }

  /** Every kept line, by job. */
  all(): OutputLine[] { return [...this.jobs.values()].flatMap((r) => r.lines); }
}
