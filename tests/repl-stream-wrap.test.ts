// R6 (H141; the interaction review of a77d80d, defect 4): the REPL's live answer keeps visibly streaming at any width. A long
// single-paragraph answer streamed into the transcript (src/repl/transcript.ts) is drawn wrapped while it streams: each row
// of it that can no longer change goes to scrollback as it fills, the rest is drawn wrapped below, within the terminal's width,
// and the newest words are on screen after every chunk. Before, the paragraph was one live row cut at the width (159 cells at
// 160 columns) that stopped changing until the paragraph ended. What ends in scrollback is the very text the same answer
// written at once ends as, at every width and however it was chunked: markup, an unclosed `**`, headings, fences and lists
// included; and a pipe gets the same lines.
//
// The transcript and its live region are the REPL's own; the terminal is FAKE (a sink that records what is written, and the
// region's own rows are what it draws): the real terminal is tests/repl-stream-wrap-pty.test.ts's.
import { describe, expect, it } from 'vitest';
import { turnStopHead } from '../src/contracts/stop-words.js';
import { detectCapabilities } from '../src/term/capabilities.js';
import { LiveRegion } from '../src/term/live-region.js';
import { measuredFromPalette, TIMMY_NIGHT } from '../src/term/palettes.js';
import { buildTheme } from '../src/term/theme.js';
import { visibleWidth } from '../src/term/width.js';
import { Transcript, type TurnEvent } from '../src/repl/transcript.js';

class Sink { writes: string[] = []; constructor(public isTTY: boolean, public columns = 80, public rows = 45) {} write(s: string) { this.writes.push(s); return true; } get text() { return this.writes.join(''); } }

function themeFor(columns: number) {
  const stdout = { isTTY: false, columns, rows: 45 };
  const caps = detectCapabilities({ env: { TERM: 'xterm-256color', LANG: 'en_US.UTF-8' }, stdin: stdout, stdout, stderr: { isTTY: false } });
  return buildTheme(caps, measuredFromPalette(TIMMY_NIGHT));
}

/** The same events written at once (no live region): what scrollback holds at the end. */
function atOnce(events: TurnEvent[], columns: number): string {
  const out = new Sink(false, columns);
  const t = new Transcript(themeFor(columns), new LiveRegion({ out, err: new Sink(false) }, { live: false }), { columns });
  for (const e of events) t.handle(e);
  t.endTurn();
  return out.text;
}

/** A transcript drawing into a live region on a FAKE terminal of `columns` x `rows`. */
function live(columns: number, rows = 45) {
  const out = new Sink(false, columns, rows);
  const err = new Sink(true, columns, rows);
  const region = new LiveRegion({ out, err }, { live: true });
  const t = new Transcript(themeFor(columns), region, { columns, rows });
  const drawn = (): string[] => [...(region as unknown as { lines: string[] }).lines];
  const committed = (): string[] => out.text.split('\n').slice(0, -1);
  return { t, out, drawn, committed };
}

const words = (s: string): string => s.replace(/\s+/g, ' ').trim();
/** The FAKE model's long single paragraph (as the review's: 40 sentences on one line, no newline until its end). */
const PARAGRAPH = Array.from({ length: 40 }, (_, i) => `(FAKE model, line ${i + 1} of 40: a tray holds things.)`).join(' ');
const snapshots = (text: string, size: number): string[] => { const out: string[] = []; for (let n = size; n < text.length + size; n += size) out.push(text.slice(0, Math.min(n, text.length))); return out; };

describe('the live answer keeps streaming at any width (R6 H141; the interaction review of a77d80d, defect 4)', () => {
  for (const columns of [160, 120, 80]) {
    it(`a long single paragraph at ${columns} columns: wrapped as it streams, each settled row in scrollback, the newest words on screen after every chunk; the end reads as the answer written at once`, () => {
      const { t, drawn, committed } = live(columns);
      const width = Math.min(columns, 80);
      let grew = 0;
      let before = 0;
      for (const snap of snapshots(PARAGRAPH, 23)) {
        t.handle({ type: 'text', id: 'a', text: snap });
        const rows = drawn();
        const kept = committed();
        // within the width: scrollback's rows as the prose width, the live rows one cell narrower than the terminal
        for (const r of kept) expect(visibleWidth(r), r).toBeLessThanOrEqual(width);
        for (const r of rows) expect(visibleWidth(r), r).toBeLessThanOrEqual(columns - 1);
        // nothing lost, nothing twice: scrollback and the live rows together are the text so far
        expect(words([...kept, ...rows].join(' '))).toBe(words(snap));
        // the newest words are on screen: at the bottom of it (the rows just kept, then the live rows), the very newest one in
        // the live part
        const newest = words(snap).split(' ');
        expect(words([...kept.slice(-2), ...rows].join(' ')).endsWith(newest.slice(-3).join(' ')), `the screen's bottom rows at ${snap.length} characters: ${JSON.stringify([...kept.slice(-2), ...rows])}`).toBe(true);
        expect(words(rows.join(' ')).endsWith(newest[newest.length - 1])).toBe(true);
        // and the live part stays small: the row still growing (two, where the terminal is one cell narrower than a full row)
        expect(rows.length).toBeLessThanOrEqual(2);
        if (kept.length > before) grew++;
        before = kept.length;
      }
      // rows went to scrollback while it streamed, not only at its end
      expect(grew).toBeGreaterThan(5);
      t.endTurn();
      expect(committed().join('\n') + '\n').toBe(atOnce([{ type: 'text', id: 'a', text: PARAGRAPH }], columns));
    });
  }

  it('markup that closes later is never settled half-drawn: **bold** and `code` across row breaks, streamed a character at a time, end as written at once; an unclosed ** keeps the rest live (wrapped) until the line ends', () => {
    const marked = Array.from({ length: 12 }, (_, i) => `step ${i + 1} runs **the tray check number ${i + 1}** with \`npm test -- tray-${i + 1}\` and then`).join(' ') + ' ends.';
    for (const columns of [160, 80, 60]) {
      const { t, drawn, committed } = live(columns);
      for (const snap of snapshots(marked, 1)) {
        t.handle({ type: 'text', id: 'a', text: snap });
        // no marker of a span is ever in scrollback (each settles only once it is closed and drawn as strong text)
        for (const r of committed()) { expect(r).not.toContain('**'); expect(r).not.toContain('`'); }
        for (const r of drawn()) expect(visibleWidth(r)).toBeLessThanOrEqual(columns - 1);
      }
      t.endTurn();
      expect(committed().join('\n') + '\n').toBe(atOnce([{ type: 'text', id: 'a', text: marked }], columns));
    }
    // an operator's ** that never closes: the rest of the line cannot settle, and is drawn wrapped, newest words in view
    const power = `2 ** 10 is 1024, ${'and the tray holds more than that '.repeat(12)}at the end.`;
    const { t, drawn, committed } = live(80);
    for (const snap of snapshots(power, 17)) {
      t.handle({ type: 'text', id: 'a', text: snap });
      const rows = drawn();
      for (const r of rows) expect(visibleWidth(r)).toBeLessThanOrEqual(79);
      expect(words([...committed(), ...rows].join(' '))).toBe(words(snap));
      const newest = words(snap).split(' ');
      expect(words([...committed().slice(-2), ...rows].join(' ')).endsWith(newest.slice(-2).join(' '))).toBe(true);
      expect(words(rows.join(' ')).endsWith(newest[newest.length - 1])).toBe(true);
    }
    t.endTurn();
    expect(committed().join('\n') + '\n').toBe(atOnce([{ type: 'text', id: 'a', text: power }], 80));
  });

  it('a whole answer of paragraphs, a heading, a list, a fence with a long code line and a closing paragraph: however it is chunked, scrollback ends as written at once, at 160, 120, 80 and 60 columns', () => {
    const answer = [
      'Here is the plan for the tray, in three parts, each a paragraph long enough to wrap at every width this test draws it at, so that rows settle while it streams.',
      '',
      '## The parts',
      '- the **base**, cut from one sheet, with `tray-base.svg` as its drawing and a long description that wraps onto a second row',
      '- the walls',
      '',
      '```bash',
      `openscad -o tray.stl tray.scad ${'-D wall=2 '.repeat(20)}`,
      '```',
      PARAGRAPH,
    ].join('\n');
    for (const columns of [160, 120, 80, 60]) {
      const once = atOnce([{ type: 'text', id: 'a', text: answer }], columns);
      for (const size of [1, 3, 7, 50, 400]) {
        const { t, committed, drawn } = live(columns);
        for (const snap of snapshots(answer, size)) {
          t.handle({ type: 'text', id: 'a', text: snap });
          for (const r of drawn()) expect(visibleWidth(r)).toBeLessThanOrEqual(columns - 1);
        }
        t.endTurn();
        expect(committed().join('\n') + '\n', `at ${columns} columns, chunks of ${size}`).toBe(once);
      }
    }
  });

  it('a text, tool, text turn and a cancel mid-paragraph: the settled rows and the rest are each said once, the cancel line after them, and no row of the answer is drawn again under it', () => {
    const { t, committed, drawn } = live(80);
    for (const snap of snapshots(PARAGRAPH.slice(0, 600), 31)) t.handle({ type: 'text', id: 'a', text: snap });
    t.handle({ type: 'tool-start', id: 't1', tool: 'file_read', args: { path: 'package.json' } });
    t.handle({ type: 'tool-end', id: 't1', ok: true, preview: '{"name": "timmy-tui"}' });
    for (const snap of snapshots(PARAGRAPH.slice(0, 500), 29)) t.handle({ type: 'text', id: 'b', text: snap });
    expect(drawn().length).toBeGreaterThan(0);
    t.handle({ type: 'cancelled', at: 'after-tools', tools: [{ tool: 'file_read', outcome: 'completed' }] });
    // the stop: the line's rest is in scrollback, above the cancel line, and the live region draws none of it again
    expect(drawn()).toEqual([]);
    // (the stop-words table's words, R6 H140: a chat turn stopped here is "Stopped by you.")
    expect(committed().pop()).toContain(`${turnStopHead()} 1 tool finished; no answer yet. Nothing was rolled back.`);
    t.endTurn();
    const once = atOnce([
      { type: 'text', id: 'a', text: PARAGRAPH.slice(0, 600) },
      { type: 'tool-start', id: 't1', tool: 'file_read', args: { path: 'package.json' } },
      { type: 'tool-end', id: 't1', ok: true, preview: '{"name": "timmy-tui"}' },
      { type: 'text', id: 'b', text: PARAGRAPH.slice(0, 500) },
      { type: 'cancelled', at: 'after-tools', tools: [{ tool: 'file_read', outcome: 'completed' }] },
    ], 80);
    expect(committed().join('\n') + '\n').toBe(once);
    expect(once).toContain(`${turnStopHead()} 1 tool finished; no answer yet. Nothing was rolled back.`);
  });

  it('into a pipe (no live region) the answer\'s lines are the same, in the same order', () => {
    const out = new Sink(false, 80);
    const t = new Transcript(themeFor(80), new LiveRegion({ out, err: new Sink(false) }, { live: false }), { columns: 80 });
    for (const snap of snapshots(PARAGRAPH, 41)) t.handle({ type: 'text', id: 'a', text: snap });
    t.endTurn();
    expect(out.text).toBe(atOnce([{ type: 'text', id: 'a', text: PARAGRAPH }], 80));
  });
});
