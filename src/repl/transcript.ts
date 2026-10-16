/**
 * One turn, one column (plan C-6; playbook §17.1, §17.4, §17.5): prompt, lanes, grouped tool steps,
 * streamed text, the receipt. Finished output is committed to scrollback once; the open tool group,
 * a partial line of text and the spinner live in the region below it until they finish.
 */
import { LiveRegion, Spinner } from '../term/live-region.js';
import { serialize, type Role, type Segment, type Theme } from '../term/theme.js';
import { hyperlink } from '../term/marks.js';
import { renderApproval } from './approvals.js';
import { truncate as cutTo, visibleWidth, wrap } from '../term/width.js';
import type { CancelStage, ToolOutcome } from './seal.js';
import { labelFor, plural, type StepLabel } from './steps.js';

export interface Lane {
  label: string;
  state: 'done' | 'running' | 'waiting';
}

/**
 * What a cancelled turn's tools did, in one sentence: none had started; or which finished, which
 * failed, and which were still running (their outcome unknown); and that nothing was rolled back.
 */
export function cancelOutcome(at: CancelStage, tools: ToolOutcome[]): string {
  if (at === 'before-tools' || tools.length === 0) return 'No tool had started.';
  const done = tools.filter((t) => t.outcome === 'completed').length;
  const failed = tools.filter((t) => t.outcome === 'failed').length;
  const running = tools.filter((t) => t.outcome === 'unknown').map((t) => t.tool);
  const parts = [
    ...(done ? [`${done} ${done === 1 ? 'tool' : 'tools'} finished`] : []),
    ...(failed ? [`${failed} failed`] : []),
    ...(running.length ? [`${running.join(', ')} ${running.length === 1 ? 'was' : 'were'} running: outcome unknown`] : []),
    ...(at === 'after-tools' ? ['no answer yet'] : []),
  ];
  return `${parts.join('; ')}. Nothing was rolled back.`;
}

/** Where to get help, under every error (playbook §16.5). */
export const HELP_ROW = '    Help: /help, or timmy repl --help';

/** One row of a turn's "where to inspect" block (round R1): a label, words, and an address to open. */
export interface InspectRow {
  label: string;
  text: string;
  /** Printed after the words (once, when it is the words), and linked where the terminal can (OSC 8). */
  url?: string;
  /** How else to get there, in words. */
  hint?: string;
}

export type TurnEvent =
  | { type: 'prompt'; text: string; cwd: string; echoed?: boolean; model?: string }
  | { type: 'thinking' }
  | { type: 'text'; id: string; text: string }
  | { type: 'lanes'; lanes: Lane[] }
  | { type: 'tool-start'; id: string; tool: string; args: Record<string, unknown> }
  | { type: 'tool-end'; id: string; ok: boolean; preview?: string; diff?: string }
  | { type: 'receipt'; id: string; verified: boolean | 'broken'; lanes: number; steps: number; spend: string; seconds: number; url?: string; cancelled?: boolean; model?: string }
  | { type: 'error'; message: string; cause?: string; fix?: string }
  | { type: 'footer'; steps: number; spend: string; seconds: number; model?: string }
  | { type: 'inspect'; rows: InspectRow[] }
  | { type: 'cancelling' }
  /** Round R1 (the Mac run): the turn ended, not cancelled, with calls that never answered (a step or spend limit). */
  | { type: 'unfinished'; count: number }
  // R5 lead: `by`, who asked the turn to stop when another surface did ("the companion")
  | { type: 'cancelled'; at?: CancelStage; tools?: ToolOutcome[]; by?: string }
  | { type: 'needs-you'; tool: string; reason: string; summary: string; detail?: string; session?: false }
  | { type: 'needs-you-answered'; tool: string; decision: 'once' | 'session' | 'deny' | 'no-terminal' };

interface Step {
  id: string;
  tool: string;
  label: StepLabel;
  approval?: 'once' | 'session' | 'deny' | 'no-terminal';
  // stopped: still running when the turn was cancelled; its outcome is unknown.
  state: 'running' | 'done' | 'failed' | 'stopped';
  /** When the step started (ms), for the elapsed time under the cancel note. */
  startedAt: number;
  preview?: string;
  diff?: string;
}

const RISK_ROLE: Record<StepLabel['risk'], Role> = { read: 'strong', write: 'estimate', exec: 'failure', network: 'ai' };
const DIFF_LINES = 12;
const PREVIEW_CAP = 200;

/**
 * R6 (H141): a word of a prose line: where it ends in the raw line (markup included; a span's last word, after its closing
 * marker), where it starts (a span's first word, at its opening marker), and whether it starts inside a span (a later word of
 * one: the line cannot be cut there and still read the same).
 */
type RawWord = Segment & { end: number; start: number; inSpan: boolean };
/** R6 (H141): a wrapped row of prose, with its first word's start and its last word's end in the raw line. */
type ProseRow = { segs: Segment[]; start: number; end: number; inSpan: boolean };

export class Transcript {
  private readonly emitted = new Map<string, number>();
  private textId: string | null = null;
  private tail = '';
  /**
   * R6 (H141; the interaction review of a77d80d, defect 4): the start of the line being streamed is already in scrollback, as
   * the rows of it that could no longer change (settle); `tail` is that line from the start of a row (whose first rows may be
   * in scrollback), and `cutAt` where in `tail` the part not yet in scrollback begins (the end of the last row kept).
   */
  private contd = false;
  private cutAt = 0;
  private inFence = false;
  private group: Step[] = [];
  /** The last plain line written to each destination (prose and the log can be different streams). */
  private readonly lastLines = new Map<LiveRegion, string>();
  private spinner: Spinner | null = null;
  private needBlank = false;
  private laneStates: Map<string, Lane['state']> | null = null;
  /** Set between Ctrl+C and the end of the turn: a row under everything saying how to quit. */
  private cancelNote: string | null = null;
  /** Refreshes the cancel note's elapsed time once a second while the cancel is pending. */
  private cancelTimer: ReturnType<typeof setInterval> | null = null;
  /** What the region shows, without the cancel note. */
  private shown: string[] = [];

  /** `log`: where steps, lanes, receipts, footers and errors go when prose has its own stream (a pipe). */
  constructor(
    private readonly theme: Theme,
    private readonly region: LiveRegion,
    private readonly opts: { columns: number; rows?: number; err?: { write(s: string): unknown }; log?: LiveRegion },
  ) {}

  private get g() {
    return this.theme.glyphs;
  }

  /** Cut to `width` cells with this terminal's ellipsis (`...` without Unicode). */
  private cut(text: string, width: number): string {
    return cutTo(text, width, this.g.ellipsis);
  }

  private get proseWidth(): number {
    return Math.min(this.opts.columns, 80);
  }

  private line(segments: Segment[]): string {
    return serialize(segments, this.theme);
  }

  /** The cancel note: how to quit, and how long the running step has run (third order, checkpoint 2). */
  private cancelLine(): string {
    const step = [...this.group].reverse().find((s) => s.state === 'running');
    const ran = step ? ` The step has run ${Math.floor((Date.now() - step.startedAt) / 1000)}s.` : '';
    return this.line([{ text: `  Cancelling.${ran} Press Ctrl+C again to quit.`, role: 'secondary' }]);
  }

  private stopCancelTimer(): void {
    if (this.cancelTimer) clearInterval(this.cancelTimer);
    this.cancelTimer = null;
  }

  /** Every region frame goes through here, so the cancel note stays under whatever is showing. */
  private show(lines: string[]): void {
    this.shown = lines;
    this.region.set(this.cancelNote ? [...lines, this.cancelNote] : lines);
  }

  /** Where a stream's lines go: prose to the region, everything else to the log when there is one. */
  private dest(stream: 'prose' | 'meta'): LiveRegion {
    return stream === 'prose' ? this.region : (this.opts.log ?? this.region);
  }

  private commit(lines: string[], plain: string[], stream: 'prose' | 'meta' = 'meta'): void {
    if (lines.length === 0) return;
    const to = this.dest(stream);
    to.commit(lines);
    this.lastLines.set(to, plain[plain.length - 1]);
  }

  /** A blank line between blocks, judged per destination, so a pipe never starts with one. */
  private blank(stream: 'prose' | 'meta' = 'meta'): void {
    const last = this.lastLines.get(this.dest(stream));
    if (last !== undefined && last !== '') this.commit([''], [''], stream);
  }

  handle(e: TurnEvent): void {
    if (e.type !== 'text' || e.id !== this.textId) this.stopSpinner();
    switch (e.type) {
      case 'prompt':
        return this.prompt(e.text, e.model ? `${e.cwd} ${this.g.sep} ${e.model}` : e.cwd, e.echoed);
      case 'thinking':
        return this.startSpinner('Working');
      case 'text':
        return this.text(e.id, e.text);
      case 'lanes':
        return this.lanes(e.lanes);
      case 'tool-start':
        return this.toolStart(e.id, e.tool, e.args);
      case 'tool-end':
        return this.toolEnd(e.id, e.ok, e.preview, e.diff);
      case 'receipt':
        return this.receipt(e);
      case 'error':
        return this.error(e.message, e.cause, e.fix);
      case 'footer':
        return this.footer(e.steps, e.spend, e.seconds, e.model);
      case 'inspect':
        return this.inspect(e.rows);
      case 'cancelling':
        // A stream that ignores the cancel keeps drawing; the note keeps the way out visible.
        this.cancelNote = this.cancelLine();
        this.stopCancelTimer();
        this.cancelTimer = setInterval(() => {
          this.cancelNote = this.cancelLine();
          this.show(this.shown);
        }, 1000);
        this.cancelTimer.unref?.();
        return this.show(this.shown);
      case 'cancelled': {
        this.stopCancelTimer();
        this.cancelNote = null;
        this.flushText();
        // A step still running when the cancel came is shown as running, never as done.
        for (const s of this.group) if (s.state === 'running') s.state = 'stopped';
        this.flushGroup();
        this.blank();
        // What the tools did, said with the cancel (third order, checkpoint 1): a cancel never undoes.
        // R5 lead (QA: the REPL said only "Cancelled." for a turn another surface stopped, while its receipt and every other
        // surface named who asked): the line names them too, in the shared stop words
        const head = e.by ? `Cancelled: stopped, asked from ${e.by}.` : 'Cancelled.';
        const said = e.at ? `${head} ${cancelOutcome(e.at, e.tools ?? [])}` : head;
        const rows = wrap(said, Math.max(20, this.opts.columns - 2)).map((l) => `  ${l}`);
        return this.commit(rows.map((r) => this.line([{ text: r, role: 'secondary' }])), rows);
      }
      case 'unfinished': {
        this.flushText();
        // A call the turn never heard back from is not done: it says so, like a cancelled one.
        for (const s of this.group) if (s.state === 'running') s.state = 'stopped';
        this.flushGroup();
        const n = e.count === 1 ? '1 call' : `${e.count} calls`;
        const said = `The turn ended at its step or spend limit before ${n} answered, so ${e.count === 1 ? 'it' : 'they'} may not have run. Send another message to go on.`;
        const rows = wrap(said, Math.max(20, this.opts.columns - 2)).map((l) => `  ${l}`);
        return this.commit(rows.map((r) => this.line([{ text: r, role: 'secondary' }])), rows);
      }
      case 'needs-you':
        return this.needsYou(e);
      case 'needs-you-answered':
        return this.answered(e.tool, e.decision);
    }
  }

  /** Flush everything still open (text tail, tool group) and clear the live region. */
  endTurn(): void {
    this.stopSpinner();
    this.flushText();
    this.flushGroup();
    this.stopCancelTimer();
    this.cancelNote = null;
    this.show([]);
  }

  // ── prompt ────────────────────────────────────────────────────────────────
  private prompt(text: string, cwd: string, echoed = false): void {
    const shown = this.cut(text, this.opts.columns - 3);
    if (echoed) {
      this.commit([this.line([{ text: `  ${this.cut(cwd, this.opts.columns - 2)}`, role: 'secondary' }])], [cwd]);
      return;
    }
    if (this.theme.tint) {
      const row = (s: string): string => `\x1b[${this.theme.tint}m\x1b[K${s}\x1b[49m`;
      this.commit([row(''), row(` ${this.line([{ text: this.g.prompt, role: 'accent' }])} ${shown}`), row('')], ['', shown, '']);
    } else {
      this.commit([this.line([{ text: this.g.prompt, role: 'accent' }, { text: ` ${shown}`, role: 'strong' }])], [shown]);
    }
    this.commit([this.line([{ text: `  ${this.cut(cwd, this.opts.columns - 2)}`, role: 'secondary' }])], [cwd]);
  }

  // ── spinner ───────────────────────────────────────────────────────────────
  private startSpinner(label: string): void {
    this.stopSpinner();
    if (this.cancelNote) return; // no spinner over the cancel note
    this.spinner = new Spinner(this.region, {
      frames: this.g.spinner,
      bar: [this.g.barFull, this.g.barEmpty],
      label,
      staticWriter: (s) => this.opts.err?.write(s),
    });
    this.spinner.start();
  }

  private stopSpinner(): void {
    this.spinner?.stop();
    this.spinner = null;
  }

  // ── streamed text ─────────────────────────────────────────────────────────
  /**
   * A snapshot of a message's text (the whole text so far). Its complete lines go to scrollback, wrapped. R6 (H141; the
   * interaction review of a77d80d, defect 4): so does each row of the line still being streamed once it can no longer change
   * (settle), and the rest of that line is drawn wrapped below them, so a long paragraph keeps visibly streaming at any width
   * and its newest words stay in view. Before, the line was one live row cut at the terminal's width: at 160 columns it grew
   * to 159 characters, then nothing changed on screen until the paragraph ended.
   */
  private text(id: string, snapshot: string): void {
    this.flushGroup();
    if (id !== this.textId) {
      this.flushText();
      this.textId = id;
      this.needBlank = true;
    }
    const sent = this.emitted.get(id) ?? 0;
    if (snapshot.length <= sent) return;
    this.tail += snapshot.slice(sent);
    this.emitted.set(id, snapshot.length);
    const parts = this.tail.split('\n');
    this.tail = parts.pop() ?? '';
    for (const raw of parts) this.lineEnd(raw);
    this.settle();
    this.show(this.tailRows());
  }

  private flushText(): void {
    if (this.tail) this.lineEnd(this.tail);
    this.tail = '';
    this.contd = false;
    this.cutAt = 0;
    this.textId = null;
  }

  /**
   * A line has ended (its newline came, or its message ended). R6 (H141): a line whose first rows are in scrollback ends as
   * prose: its rows after the last one kept (the whole line wrapped, as it would be written at once).
   */
  private lineEnd(raw: string): void {
    if (!this.contd) return this.textLine(raw);
    const from = this.cutAt;
    this.contd = false;
    this.cutAt = 0;
    for (const row of this.wrapWords(this.rawWords(raw), this.proseWidth)) {
      if (row.end > from) this.commit([this.line(row.segs)], [row.segs.map((s) => s.text).join('')], 'prose');
    }
  }

  /**
   * R6 (H141): whether the line being streamed is prose already (rows of it can settle): not inside a code fence, not a fence
   * or a heading line, and not a start that could still become one ("`", "##", blanks).
   */
  private streamsProse(raw: string): boolean {
    if (this.contd) return true;
    if (this.inFence) return false;
    const t = raw.replace(/^\s+/, '');
    if (!t || /^`{1,2}$/.test(t) || /^```/.test(t)) return false;
    if (/^#{1,3}(\s|$)/.test(raw)) return false;
    return true;
  }

  /**
   * R6 (H141): where the part of a streamed line ends whose look cannot change with what comes next: before the first `**` or
   * backtick that is not closed yet (the rest may become strong text, which takes no markers' width), and before a last `*`
   * (it may be the first of a `**`).
   */
  private safeEnd(raw: string): number {
    const opener = (from: number, to: number): number => {
      for (let i = from; i < to; i++) {
        if (raw[i] === '`') return i;
        if (raw[i] === '*' && (raw[i + 1] === '*' || i === raw.length - 1)) return i;
      }
      return -1;
    };
    let at = 0;
    for (const m of raw.matchAll(/\*\*([^*]+)\*\*|`([^`]+)`/g)) {
      const open = opener(at, m.index!);
      if (open >= 0) return open;
      at = m.index! + m[0].length;
    }
    const open = opener(at, raw.length);
    return open >= 0 ? open : raw.length;
  }

  /**
   * R6 (H141): the rows of the line being streamed that can no longer change go to scrollback now: every row of its settled
   * part (safeEnd) but the last, which may still grow. Greedy wrapping decides a row only from the words before its break, and
   * the settled part is drawn as the whole line will be (markup that closes later starts after it), so these rows are the very
   * rows the whole line wraps to: a paragraph streamed reads the same in scrollback as one written at once.
   */
  private settle(): void {
    if (!this.tail || !this.streamsProse(this.tail)) return;
    const rows = this.wrapWords(this.rawWords(this.tail.slice(0, this.safeEnd(this.tail))), this.proseWidth);
    const last = rows.length - 1;
    const fresh = rows.slice(0, Math.max(0, last)).filter((r) => r.end > this.cutAt);
    if (!fresh.length) return;
    if (this.needBlank) {
      this.blank('prose');
      this.needBlank = false;
    }
    for (const row of fresh) this.commit([this.line(row.segs)], [row.segs.map((s) => s.text).join('')], 'prose');
    this.contd = true;
    this.cutAt = fresh[fresh.length - 1].end;
    // what is kept is let go of where the next row starts outside a span (the rest reads the same from there), so each chunk
    // wraps only the line's last rows; inside a span the line is kept whole, and `cutAt` says where the rest begins
    const next = rows[rows.indexOf(fresh[fresh.length - 1]) + 1];
    if (next && !next.inSpan) {
      this.tail = this.tail.slice(next.start);
      this.cutAt = 0;
    }
  }

  /**
   * R6 (H141): the part of the line being streamed that is not in scrollback, as the live region draws it: prose wrapped (one
   * cell narrower than the terminal, as the region draws every row), so its newest words are in view; a code line or a heading
   * as one row, as it will be kept.
   */
  private tailRows(): string[] {
    if (!this.tail) return [];
    if (!this.streamsProse(this.tail)) return [this.line(this.inFence ? [{ text: this.tail, role: 'secondary' }] : this.inline(this.tail))];
    const width = Math.max(10, Math.min(this.proseWidth, this.opts.columns - 1));
    return this.wrapWords(this.rawWords(this.tail).filter((w) => w.end > this.cutAt), width).map((row) => this.line(row.segs));
  }

  private textLine(raw: string): void {
    if (this.needBlank) {
      this.blank('prose');
      this.needBlank = false;
    }
    if (/^\s*```/.test(raw)) {
      this.inFence = !this.inFence;
      return;
    }
    if (this.inFence) {
      const code = this.cut(raw, this.opts.columns);
      return this.commit([this.line([{ text: code, role: 'secondary' }])], [code], 'prose');
    }
    const heading = /^#{1,3}\s+(.*)$/.exec(raw);
    if (heading) {
      this.blank('prose');
      return this.commit([this.line([{ text: heading[1], role: 'strong' }])], [heading[1]], 'prose');
    }
    if (raw.trim() === '') return this.blank('prose');
    // R6 (H141): the one wrap a streamed line's settled rows use too (settle), so both read the same
    for (const row of this.wrapWords(this.rawWords(raw), this.proseWidth)) {
      this.commit([this.line(row.segs)], [row.segs.map((s) => s.text).join('')], 'prose');
    }
  }

  /** `**bold**` and `code` become strong text (the law has no cyan; DESIGN.md §10). */
  private inline(raw: string): Segment[] {
    const out: Segment[] = [];
    const re = /\*\*([^*]+)\*\*|`([^`]+)`/g;
    let at = 0;
    for (const m of raw.matchAll(re)) {
      if (m.index! > at) out.push({ text: raw.slice(at, m.index) });
      out.push({ text: m[1] ?? m[2], role: 'strong' });
      at = m.index! + m[0].length;
    }
    if (at < raw.length) out.push({ text: raw.slice(at) });
    return out;
  }

  /**
   * A prose line's words as inline() styles them (`**bold**` and `code` strong, the markers left out), split at whitespace
   * runs; R6 (H141): each with the offset in the raw line its last character ends at (a span's last word: after its closing
   * marker), so a streamed line's settled rows can be cut off it (settle).
   */
  private rawWords(raw: string): RawWord[] {
    const out: RawWord[] = [];
    // a piece of the line: its words from raw offset `from` (a span's inner text, after its opening marker at `open`) to `to`
    const push = (text: string, role: Role | undefined, from: number, to: number, open?: number): void => {
      let k = 0;
      for (const w of text.split(/(\s+)/)) {
        if (!w) continue;
        const first = k === 0;
        k += w.length;
        const start = open !== undefined && first ? open : from + k - w.length;
        out.push({ text: w, role, start, end: k === text.length ? to : from + k, inSpan: open !== undefined && !first });
      }
    };
    let at = 0;
    for (const m of raw.matchAll(/\*\*([^*]+)\*\*|`([^`]+)`/g)) {
      const i = m.index!;
      if (i > at) push(raw.slice(at, i), undefined, at, i);
      push(m[1] ?? m[2], 'strong', i + (m[1] !== undefined ? 2 : 1), i + m[0].length, i);
      at = i + m[0].length;
    }
    if (at < raw.length) push(raw.slice(at), undefined, at, raw.length);
    return out;
  }

  /** Greedy word wrap over styled words, by display width; R6 (H141): each row with where its words start and end in the raw line. */
  private wrapWords(words: RawWord[], width: number): ProseRow[] {
    const rows: ProseRow[] = [{ segs: [], start: 0, end: 0, inSpan: false }];
    let used = 0;
    for (const w of words) {
      const ww = visibleWidth(w.text);
      const isSpace = /^\s+$/.test(w.text);
      if (isSpace) {
        if (used > 0 && used + 1 <= width) {
          rows[rows.length - 1].segs.push({ text: ' ', role: w.role });
          used += 1;
        }
        continue;
      }
      if (used > 0 && used + ww > width) {
        const row = rows[rows.length - 1].segs;
        while (row.length && /^\s+$/.test(row[row.length - 1].text)) row.pop();
        rows.push({ segs: [], start: 0, end: 0, inSpan: false });
        used = 0;
      }
      const row = rows[rows.length - 1];
      if (!row.segs.length) { row.start = w.start; row.inSpan = w.inSpan; }
      row.segs.push({ text: w.text.length && ww > width ? this.cut(w.text, width) : w.text, role: w.role });
      row.end = w.end;
      used += Math.min(ww, width);
    }
    return rows.filter((r) => r.segs.length).map((r) => ({ ...r, segs: this.merge(r.segs) }));
  }

  private merge(row: Segment[]): Segment[] {
    const out: Segment[] = [];
    for (const s of row) {
      const prev = out[out.length - 1];
      if (prev && prev.role === s.role) prev.text += s.text;
      else out.push({ ...s });
    }
    return out;
  }

  // ── lanes ─────────────────────────────────────────────────────────────────
  /** The first checklist prints whole; later updates list only the lanes whose state changed. */
  private lanes(lanes: Lane[]): void {
    let running = false;
    const normalized = lanes.map((lane) => {
      const state = lane.state === 'running' && running ? 'waiting' : lane.state;
      running ||= state === 'running';
      return { ...lane, state };
    });
    const previous = this.laneStates;
    this.laneStates = new Map(normalized.map((l) => [l.label, l.state]));
    const shown = previous ? normalized.filter((l) => previous.get(l.label) !== l.state) : normalized;
    if (shown.length === 0) return;
    this.flushText();
    this.flushGroup();
    this.blank();
    const done = normalized.filter((l) => l.state === 'done').length;
    const rows = [this.line([{ text: 'Lanes', role: 'strong' }, { text: `  ${done} of ${lanes.length} done`, role: 'secondary' }])];
    const plain = [`Lanes  ${done} of ${lanes.length} done`];
    for (const { state, ...lane } of shown) {
      const mark = state === 'done' ? '[x]' : state === 'running' ? '[~]' : '[ ]';
      const label = this.cut(lane.label, this.opts.columns - 6);
      rows.push(this.line(state === 'waiting'
        ? [{ text: `  ${mark} ${label}`, role: 'secondary' }]
        : [{ text: '  ' }, { text: mark, role: 'strong' }, { text: ` ${label}` }]));
      plain.push(`  ${mark} ${label}`);
    }
    this.commit(rows, plain);
  }

  // ── tool steps ────────────────────────────────────────────────────────────
  private toolStart(id: string, tool: string, args: Record<string, unknown>): void {
    this.flushText();
    const label = labelFor(tool, args);
    const open = this.group[0]?.label;
    if (!open || open.verb !== label.verb || open.risk !== label.risk) {
      this.flushGroup();
      this.blank();
    }
    this.group.push({ id, tool, label, state: 'running', startedAt: Date.now() });
    this.showGroup();
    this.startSpinner(`${label.present} ${label.arg}`);
  }

  private toolEnd(id: string, ok: boolean, preview?: string, diff?: string): void {
    const step = this.group.find((s) => s.id === id);
    if (!step) return;
    step.state = ok ? 'done' : 'failed';
    step.preview = preview?.split('\n').find((l) => l.trim())?.slice(0, PREVIEW_CAP);
    step.diff = diff;
    this.showGroup();
  }

  private showGroup(): void {
    if (this.group.length) this.show(this.groupLines().lines);
  }

  private flushGroup(): void {
    if (!this.group.length) return;
    const { lines, plain } = this.groupLines();
    this.group = [];
    this.show([]);
    this.commit(lines, plain);
  }

  private groupLines(): { lines: string[]; plain: string[] } {
    const g = this.g;
    const steps = this.group;
    const label = steps[0].label;
    const failedCount = steps.filter((s) => s.state === 'failed').length;
    const failed = failedCount > 0;
    const glyph = failed ? g.fail : label.risk === 'network' ? g.ai : g.bullet;
    const role: Role = failed ? 'failure' : RISK_ROLE[label.risk];
    // While a step runs (or was stopped by a cancel) the head says what it is doing, never that it is done.
    const live = steps.some((s) => s.state === 'running' || s.state === 'stopped');
    // A failed step's head says it failed in words, not only by the glyph, and never "Ran": a run that
    // failed may not have started (round R1 review). The step's own answer below says which.
    const ended = failed && !live;
    // A step the operator denied never started: it says so plainly ("Not run"), not "failed".
    const denied = steps.length === 1 && (steps[0].approval === 'deny' || steps[0].approval === 'no-terminal');
    const head = ended ? `${glyph} ${denied ? 'Not run' : label.failed}:` : `${glyph} ${live ? label.present : label.verb}`;
    const subject = steps.length === 1
      ? label.arg
      : ended ? `${failedCount} of ${steps.length} ${plural(label.noun, steps.length)}` : `${steps.length} ${plural(label.noun, steps.length)}`;
    const room = this.opts.columns - visibleWidth(head) - 1;
    const shownSubject = this.cut(subject, room);
    const tail = shownSubject ? ` ${shownSubject}` : '';
    const lines = [this.line([{ text: head, role }, ...(tail ? [{ text: tail }] : [])])];
    const plain = [`${head}${tail}`];
    const push = (segments: Segment[]): void => {
      lines.push(this.line(segments));
      plain.push(segments.map((s) => s.text).join(''));
    };
    const fit = (prefix: string, main: string, extra?: string): Segment[] => {
      const room = this.opts.columns - visibleWidth(prefix);
      const shownMain = this.cut(main, room);
      const left = room - visibleWidth(shownMain) - 2;
      const tail = extra && left > 1 ? [{ text: `  ${this.cut(extra, left)}`, role: 'secondary' as Role }] : [];
      return [{ text: prefix, role: 'secondary' }, { text: shownMain }, ...tail];
    };
    if (steps.length === 1) {
      const s = steps[0];
      const approval = this.approvalSegments(s);
      if (approval) push([{ text: `  ${s.diff || s.preview ? g.branch : g.branchEnd} `, role: 'secondary' }, ...approval]);
      if (s.diff) {
        const diffLines = s.diff.split('\n');
        const added = diffLines.filter((l) => l.startsWith('+') && !l.startsWith('+++')).length;
        const removed = diffLines.filter((l) => l.startsWith('-') && !l.startsWith('---')).length;
        push(fit(`  ${g.branchEnd} `, `${added} added, ${removed} removed`));
        for (const d of diffLines.slice(0, DIFF_LINES)) {
          const text = this.cut(d, this.opts.columns - 4);
          const r: Role | undefined = d.startsWith('@@') ? 'secondary' : d.startsWith('+') ? 'diffAdd' : d.startsWith('-') ? 'diffRemove' : undefined;
          push([{ text: '    ' }, { text, role: r }]);
        }
        if (diffLines.length > DIFF_LINES) push([{ text: `    ${g.ellipsis} ${diffLines.length - DIFF_LINES} more lines`, role: 'secondary' }]);
      } else if (s.preview) {
        push(fit(`  ${g.branchEnd} `, s.preview));
      } else if (s.state === 'stopped') {
        // It never answered: whether it ran is not known (round R1, the Mac run).
        push(fit(`  ${g.branchEnd} `, 'outcome unknown'));
      }
    } else {
      steps.forEach((s, i) => push(fit(`  ${i === steps.length - 1 ? g.branchEnd : g.branch} `, s.label.arg,
        s.state === 'stopped' ? 'outcome unknown' : s.state === 'failed' ? `failed${s.preview ? `: ${s.preview}` : ''}` : s.preview)));
    }
    return { lines, plain };
  }

  // ── NEEDS YOU ─────────────────────────────────────────────────────────────
  /** The box shows below the open step only while it waits; the answer is kept under the step. */
  private needsYou(req: { tool: string; reason: string; summary: string; detail?: string; session?: false }): void {
    const group = this.group.length ? this.groupLines().lines : [];
    // The whole box stays on screen: the region holds rows minus one lines, and the step above it, a
    // blank and the box's six fixed rows come first; the code gets what is left (at least three rows).
    const room = Math.max(3, (this.opts.rows ?? 24) - 1 - group.length - 1 - 6);
    const box = renderApproval(req, this.theme, this.opts.columns, room);
    this.show([...group, '', ...box]);
  }

  private answered(tool: string, decision: NonNullable<Step['approval']>): void {
    const step = [...this.group].reverse().find((s) => s.tool === tool && s.state === 'running');
    if (step) step.approval = decision;
    this.showGroup();
    if (step && decision !== 'deny' && decision !== 'no-terminal') this.startSpinner(`${step.label.present} ${step.label.arg}`);
  }

  private approvalSegments(s: Step): Segment[] | null {
    const g = this.g;
    switch (s.approval) {
      case 'once':
        return [{ text: 'Approved', role: 'strong' }, { text: ' once', role: 'secondary' }];
      case 'session':
        return [{ text: 'Approved', role: 'strong' }, { text: ' for this session', role: 'secondary' }];
      case 'deny':
        return [{ text: `${g.fail} Denied`, role: 'failure' }, { text: ' by you' }];
      case 'no-terminal':
        return [{ text: `${g.fail} Denied`, role: 'failure' }, { text: ': no terminal to ask', role: 'secondary' }];
      default:
        return null;
    }
  }

  // ── receipt and errors ────────────────────────────────────────────────────
  private receipt(e: Extract<TurnEvent, { type: 'receipt' }>): void {
    this.flushText();
    this.flushGroup();
    this.blank();
    const g = this.g;
    const name = (glyph: string): string => {
      const text = `${glyph} RECEIPT ${e.id}`;
      return e.url ? hyperlink(text, e.url, this.theme.caps.cursor) : text;
    };
    const head: Segment[] =
      e.verified === true
        ? [{ text: name(g.ok), role: 'verified' }, { text: ' signed and verified' }]
        : e.verified === 'broken'
          ? [{ text: name(g.fail), role: 'failure' }, { text: ' chain broken' }]
          : [{ text: name(g.bullet), role: 'strong' }, { text: ' signed, not verified yet', role: 'secondary' }];
    // A REPL turn has no lanes (C-8): a lane count of 0 is left out rather than printed.
    // Round R1: and which model answered (after a fallback, the one that actually did); a cancel stays last.
    const facts = [...(e.lanes ? [`${e.lanes} ${plural('lane', e.lanes)}`] : []), `${e.steps} ${plural('step', e.steps)}`, e.spend, `${e.seconds}s`, ...(e.model ? [e.model] : []), ...(e.cancelled ? ['cancelled'] : [])].join(` ${g.sep} `);
    this.commit([this.line(head), this.line([{ text: `  ${this.cut(facts, this.opts.columns - 2)}`, role: 'secondary' }])], [
      head.map((s) => s.text).join(''),
      facts,
    ]);
  }

  private footer(steps: number, spend: string, seconds: number, model?: string): void {
    this.flushText();
    this.flushGroup();
    this.blank();
    const facts = [`${steps} ${plural('step', steps)}`, spend, `${seconds.toFixed(1)}s`, ...(model ? [model] : [])].join(` ${this.g.sep} `);
    this.commit([this.line([{ text: `  ${this.cut(facts, this.opts.columns - 2)}`, role: 'secondary' }])], [facts]);
  }

  /**
   * Round R1: where to inspect what the turn did, one row each: a label, the words, the address in
   * plain text (linked where the terminal can, and never only linked: a terminal without OSC 8 would
   * show nothing), and how else to get there. A row that does not fit drops its hint, then is cut.
   */
  private inspect(rows: InspectRow[]): void {
    this.flushText();
    this.flushGroup();
    if (!rows.length) return;
    const sep = ` ${this.g.sep} `;
    const width = Math.max(10, rows.reduce((n, r) => Math.max(n, visibleWidth(r.label)), 0) + 2);
    const lines: string[] = [];
    const plain: string[] = [];
    for (const r of rows) {
      const head = `  ${r.label}${' '.repeat(Math.max(1, width - visibleWidth(r.label) - 2))} `;
      const urlPart = r.url && r.url !== r.text ? r.url : '';
      const fits = (parts: string[]): boolean => visibleWidth(head + parts.filter(Boolean).join(sep)) <= this.opts.columns;
      let hint = r.hint ?? '';
      if (!fits([r.text, urlPart, hint])) hint = '';
      const text = fits([r.text, urlPart]) ? r.text : this.cut(r.text, Math.max(4, this.opts.columns - visibleWidth(head) - (urlPart ? visibleWidth(urlPart) + sep.length : 0)));
      const link = (u: string): string => (this.theme.caps.cursor ? hyperlink(u, u, true) : u);
      const segments: Segment[] = [
        { text: head, role: 'secondary' },
        { text: r.url && r.url === r.text ? link(text) : text },
        ...(urlPart && fits([text, urlPart]) ? [{ text: sep, role: 'secondary' as Role }, { text: link(urlPart) }] : []),
        ...(hint ? [{ text: `${sep}${hint}`, role: 'secondary' as Role }] : []),
      ];
      lines.push(this.line(segments));
      plain.push(segments.map((x) => x.text).join(''));
    }
    this.commit(lines, plain);
  }

  private error(message: string, cause?: string, fix?: string): void {
    this.flushText();
    this.flushGroup();
    this.blank();
    // Room is measured from each row's real prefix ([FAIL] is wider than ✗).
    const head = `${this.g.fail} Error:`;
    const rows: Segment[][] = [[{ text: '  ' }, { text: head, role: 'failure' }, { text: ` ${this.cut(message, this.opts.columns - 3 - visibleWidth(head))}` }]];
    const causeAt = '    Cause: ';
    const tryAt = '    Try: ';
    if (cause) rows.push([{ text: `${causeAt}${this.cut(cause, this.opts.columns - causeAt.length)}`, role: 'secondary' }]);
    if (fix) rows.push([{ text: tryAt, role: 'secondary' }, { text: this.cut(fix, this.opts.columns - tryAt.length) }]);
    // Playbook §16.5: and where to get help.
    rows.push([{ text: this.cut(HELP_ROW, this.opts.columns), role: 'secondary' }]);
    this.commit(rows.map((r) => this.line(r)), rows.map((r) => r.map((s) => s.text).join('')));
  }
}
