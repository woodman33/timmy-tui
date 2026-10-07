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

export type TurnEvent =
  | { type: 'prompt'; text: string; cwd: string; echoed?: boolean }
  | { type: 'thinking' }
  | { type: 'text'; id: string; text: string }
  | { type: 'lanes'; lanes: Lane[] }
  | { type: 'tool-start'; id: string; tool: string; args: Record<string, unknown> }
  | { type: 'tool-end'; id: string; ok: boolean; preview?: string; diff?: string }
  | { type: 'receipt'; id: string; verified: boolean | 'broken'; lanes: number; steps: number; spend: string; seconds: number; url?: string; cancelled?: boolean }
  | { type: 'error'; message: string; cause?: string; fix?: string }
  | { type: 'footer'; steps: number; spend: string; seconds: number }
  | { type: 'cancelling' }
  | { type: 'cancelled'; at?: CancelStage; tools?: ToolOutcome[] }
  | { type: 'needs-you'; tool: string; reason: string; summary: string }
  | { type: 'needs-you-answered'; tool: string; decision: 'once' | 'session' | 'deny' | 'no-terminal' };

interface Step {
  id: string;
  tool: string;
  label: StepLabel;
  approval?: 'once' | 'session' | 'deny' | 'no-terminal';
  // stopped: still running when the turn was cancelled; its outcome is unknown.
  state: 'running' | 'done' | 'failed' | 'stopped';
  preview?: string;
  diff?: string;
}

const RISK_ROLE: Record<StepLabel['risk'], Role> = { read: 'strong', write: 'estimate', exec: 'failure', network: 'ai' };
const DIFF_LINES = 12;
const PREVIEW_CAP = 200;

export class Transcript {
  private readonly emitted = new Map<string, number>();
  private textId: string | null = null;
  private tail = '';
  private inFence = false;
  private group: Step[] = [];
  /** The last plain line written to each destination (prose and the log can be different streams). */
  private readonly lastLines = new Map<LiveRegion, string>();
  private spinner: Spinner | null = null;
  private needBlank = false;
  private laneStates: Map<string, Lane['state']> | null = null;
  /** Set between Ctrl+C and the end of the turn: a row under everything saying how to quit. */
  private cancelNote: string | null = null;
  /** What the region shows, without the cancel note. */
  private shown: string[] = [];

  /** `log`: where steps, lanes, receipts, footers and errors go when prose has its own stream (a pipe). */
  constructor(
    private readonly theme: Theme,
    private readonly region: LiveRegion,
    private readonly opts: { columns: number; err?: { write(s: string): unknown }; log?: LiveRegion },
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
        return this.prompt(e.text, e.cwd, e.echoed);
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
        return this.footer(e.steps, e.spend, e.seconds);
      case 'cancelling':
        // A stream that ignores the cancel keeps drawing; the note keeps the way out visible.
        this.cancelNote = this.line([{ text: '  Cancelling. Press Ctrl+C again to quit.', role: 'secondary' }]);
        return this.show(this.shown);
      case 'cancelled': {
        this.cancelNote = null;
        this.flushText();
        // A step still running when the cancel came is shown as running, never as done.
        for (const s of this.group) if (s.state === 'running') s.state = 'stopped';
        this.flushGroup();
        this.blank();
        // What the tools did, said with the cancel (third order, checkpoint 1): a cancel never undoes.
        const said = e.at ? `Cancelled. ${cancelOutcome(e.at, e.tools ?? [])}` : 'Cancelled.';
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
      this.commit([row(''), row(` ${this.g.prompt} ${shown}`), row('')], ['', shown, '']);
    } else {
      this.commit([this.line([{ text: `${this.g.prompt} ${shown}`, role: 'strong' }])], [shown]);
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
    for (const raw of parts) this.textLine(raw);
    this.show(this.tail ? [this.line(this.inline(this.tail))] : []);
  }

  private flushText(): void {
    if (this.tail) this.textLine(this.tail);
    this.tail = '';
    this.textId = null;
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
    for (const row of this.wrapSegments(this.inline(raw), this.proseWidth)) {
      this.commit([this.line(row)], [row.map((s) => s.text).join('')], 'prose');
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

  /** Greedy word wrap over styled segments, by display width. */
  private wrapSegments(segments: Segment[], width: number): Segment[][] {
    const words: Segment[] = [];
    for (const s of segments) for (const w of s.text.split(/(\s+)/)) if (w) words.push({ text: w, role: s.role });
    const rows: Segment[][] = [[]];
    let used = 0;
    for (const w of words) {
      const ww = visibleWidth(w.text);
      const isSpace = /^\s+$/.test(w.text);
      if (isSpace) {
        if (used > 0 && used + 1 <= width) {
          rows[rows.length - 1].push({ text: ' ', role: w.role });
          used += 1;
        }
        continue;
      }
      if (used > 0 && used + ww > width) {
        const row = rows[rows.length - 1];
        while (row.length && /^\s+$/.test(row[row.length - 1].text)) row.pop();
        rows.push([]);
        used = 0;
      }
      rows[rows.length - 1].push(w.text.length && ww > width ? { ...w, text: this.cut(w.text, width) } : w);
      used += Math.min(ww, width);
    }
    return rows.filter((r) => r.length).map((r) => this.merge(r));
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
    this.group.push({ id, tool, label, state: 'running' });
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
    const failed = steps.some((s) => s.state === 'failed');
    const glyph = failed ? g.fail : label.risk === 'network' ? g.ai : g.bullet;
    const role: Role = failed ? 'failure' : RISK_ROLE[label.risk];
    // While a step runs (or was stopped by a cancel) the head says what it is doing, never that it is done.
    const live = steps.some((s) => s.state === 'running' || s.state === 'stopped');
    const head = `${glyph} ${live ? label.present : label.verb}`;
    const subject = steps.length === 1 ? label.arg : `${steps.length} ${plural(label.noun, steps.length)}`;
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
      }
    } else {
      steps.forEach((s, i) => push(fit(`  ${i === steps.length - 1 ? g.branchEnd : g.branch} `, s.label.arg, s.state === 'stopped' ? 'outcome unknown' : s.preview)));
    }
    return { lines, plain };
  }

  // ── NEEDS YOU ─────────────────────────────────────────────────────────────
  /** The box shows below the open step only while it waits; the answer is kept under the step. */
  private needsYou(req: { tool: string; reason: string; summary: string }): void {
    const box = renderApproval(req, this.theme, this.opts.columns);
    this.show([...(this.group.length ? this.groupLines().lines : []), '', ...box]);
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
    const facts = [...(e.lanes ? [`${e.lanes} ${plural('lane', e.lanes)}`] : []), `${e.steps} ${plural('step', e.steps)}`, e.spend, `${e.seconds}s`, ...(e.cancelled ? ['cancelled'] : [])].join(` ${g.sep} `);
    this.commit([this.line(head), this.line([{ text: `  ${this.cut(facts, this.opts.columns - 2)}`, role: 'secondary' }])], [
      head.map((s) => s.text).join(''),
      facts,
    ]);
  }

  private footer(steps: number, spend: string, seconds: number): void {
    this.flushText();
    this.flushGroup();
    this.blank();
    const facts = [`${steps} ${plural('step', steps)}`, spend, `${seconds.toFixed(1)}s`].join(` ${this.g.sep} `);
    this.commit([this.line([{ text: `  ${this.cut(facts, this.opts.columns - 2)}`, role: 'secondary' }])], [facts]);
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
