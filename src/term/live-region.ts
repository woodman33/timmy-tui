/**
 * The inline renderer (playbook §16.1, §16.3, §17.6): finished lines are written once to scrollback
 * on stdout; a small live region (spinner, running step) redraws in place on stderr. Every region
 * frame is one synchronized write that overwrites its rows and erases below; it never clears the screen.
 */
import { cutAnsi } from './sanitize.js';

export const SYNC_START = '\x1b[?2026h';
export const SYNC_END = '\x1b[?2026l';
const EOL = '\x1b[K';
const ERASE_BELOW = '\x1b[J';

export interface Writer {
  write(s: string): unknown;
  isTTY?: boolean;
  columns?: number;
  rows?: number;
}

export class LiveRegion {
  private height = 0;
  /** Region row the terminal cursor rests on (the last row unless a caret was parked). */
  private cursorRow = 0;
  private lines: string[] = [];
  private caret: { row: number; col: number } | undefined;
  private closed = false;

  constructor(private readonly streams: { out: Writer; err: Writer }, private readonly opts: { live: boolean }) {}

  /** Whether this region redraws in place (stderr is a live terminal and the region is open). */
  get live(): boolean {
    return this.opts.live && !this.closed;
  }

  /** Back to the first row of the region, column 0. */
  private toStart(): string {
    return '\r' + (this.cursorRow > 0 ? `\x1b[${this.cursorRow}A` : '');
  }

  /** From the end of the last row to the caret, if one is parked. */
  private toCaret(): string {
    if (!this.caret || this.lines.length === 0) {
      this.cursorRow = Math.max(0, this.lines.length - 1);
      return '';
    }
    const row = Math.min(this.caret.row, this.lines.length - 1);
    const up = this.lines.length - 1 - row;
    this.cursorRow = row;
    return (up > 0 ? `\x1b[${up}A` : '') + '\r' + (this.caret.col > 0 ? `\x1b[${this.caret.col}C` : '');
  }

  /** Erase each row before drawing it (never after: that would wipe a tinted row's background). */
  private draw(lines: string[]): string {
    return lines.map((l) => EOL + l).join('\n') + ERASE_BELOW;
  }

  /**
   * Replace what the region shows; `caret` parks the cursor at a row and cell column inside it.
   * Rows are cut to the width minus one (a soft-wrapped row would break the redraw math) and the
   * region keeps at most rows minus one lines, the newest, so it can always be redrawn in place.
   */
  set(lines: string[], caret?: { row: number; col: number }): void {
    const columns = this.streams.err.columns && this.streams.err.columns > 0 ? this.streams.err.columns : 80;
    const rows = this.streams.err.rows && this.streams.err.rows > 0 ? this.streams.err.rows : 24;
    const drop = Math.max(0, lines.length - Math.max(1, rows - 1));
    this.lines = lines.slice(drop).map((l) => cutAnsi(l, columns - 1));
    this.caret = caret && { row: Math.max(0, caret.row - drop), col: Math.min(caret.col, columns - 1) };
    if (!this.live) return;
    const start = this.toStart();
    this.height = this.lines.length;
    this.streams.err.write(SYNC_START + start + this.draw(this.lines) + this.toCaret() + SYNC_END);
  }

  /** Write finished lines to scrollback above the region, then redraw the region below them. */
  commit(lines: string[]): void {
    if (lines.length === 0) return;
    if (!this.live) {
      this.streams.out.write(lines.map((l) => l + '\n').join(''));
      return;
    }
    // Erase each row before writing it, never after: a trailing erase would run after a tinted
    // row's reset and wipe its background (playbook §17.1). A piped stdout gets no erase codes:
    // the region itself lives on stderr, and the answer in the pipe stays plain text.
    const erase = this.streams.out.isTTY ? EOL : '';
    const body = lines.map((l) => erase + l + '\n').join('');
    if (this.height === 0) {
      this.streams.out.write(body);
      return;
    }
    this.streams.err.write(SYNC_START + this.toStart() + ERASE_BELOW);
    this.streams.out.write(body);
    this.height = this.lines.length;
    this.streams.err.write('\r' + this.draw(this.lines) + this.toCaret() + SYNC_END);
  }

  /** Erase the region for good; the cursor ends at the start of a clean line. */
  close(): void {
    if (this.live && this.height > 0) this.streams.err.write(SYNC_START + this.toStart() + ERASE_BELOW + SYNC_END);
    this.height = 0;
    this.cursorRow = 0;
    this.lines = [];
    this.caret = undefined;
    this.closed = true;
  }
}

export interface SpinnerOptions {
  frames: string[];
  label: string;
  /** Bar cells, full then empty (default █ ░). */
  bar?: [string, string];
  intervalMs?: number;
  /** Where the one static `Working...` line goes when the region is not live (stderr). */
  staticWriter?: (s: string) => void;
}

const BAR_CELLS = 20;

/** A spinner with elapsed time after 1s, and a bar with percent and ETA past 10s when the total is known. */
export class Spinner {
  private timer: ReturnType<typeof setInterval> | null = null;
  private frame = 0;
  private startedAt = 0;
  private done = 0;
  private total = 0;

  constructor(private readonly region: LiveRegion, private readonly opts: SpinnerOptions) {}

  start(): void {
    this.startedAt = Date.now();
    if (!this.region.live) {
      this.opts.staticWriter?.(`${this.opts.label}...\n`);
      return;
    }
    this.render();
    this.timer = setInterval(() => {
      this.frame++;
      this.render();
    }, this.opts.intervalMs ?? 80);
  }

  setLabel(label: string): void {
    this.opts.label = label;
  }

  progress(done: number, total: number): void {
    this.done = done;
    this.total = total;
  }

  line(): string {
    const seconds = (Date.now() - this.startedAt) / 1000;
    const head = `${this.opts.frames[this.frame % this.opts.frames.length]} ${this.opts.label}`;
    if (this.total > 0 && seconds > 10) {
      const ratio = Math.min(1, this.done / this.total);
      const [full, empty] = this.opts.bar ?? ['█', '░'];
      const filled = Math.round(ratio * BAR_CELLS);
      const eta = this.done > 0 ? Math.round((seconds * (this.total - this.done)) / this.done) : null;
      const tail = eta === null ? '' : `, about ${eta}s left`;
      return `${head} ${full.repeat(filled)}${empty.repeat(BAR_CELLS - filled)} ${Math.round(ratio * 100)}% ${seconds.toFixed(1)}s${tail}`;
    }
    return seconds >= 1 ? `${head} ${seconds.toFixed(1)}s` : head;
  }

  private render(): void {
    this.region.set([this.line()]);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.region.live) this.region.set([]);
  }
}
