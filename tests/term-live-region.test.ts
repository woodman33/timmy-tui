import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LiveRegion, Spinner, SYNC_END, SYNC_START } from '../src/term/live-region.js';
import { visibleWidth } from '../src/term/width.js';

// Playbook §16.1/§16.5/§17.6: finished lines go to scrollback once (stdout); a small live region
// (spinner, step) redraws in place on stderr, one synchronized frame at a time, never clearing the screen.
class Sink {
  writes: string[] = [];
  rows?: number;
  constructor(public isTTY: boolean, public columns = 80) {}
  write(s: string) { this.writes.push(s); return true; }
  get text() { return this.writes.join(''); }
}
const make = (errTTY = true) => {
  const out = new Sink(true), err = new Sink(errTTY);
  return { out, err, region: new LiveRegion({ out, err }, { live: errTTY }) };
};

describe('LiveRegion', () => {
  it('draws the region on stderr as one synchronized write that overwrites, never clears', () => {
    const { out, err, region } = make();
    region.set(['⠋ Working']);
    region.set(['⠙ Working', '  Read package.json']);
    region.set(['⠹ Working']);
    expect(out.writes).toEqual([]);
    expect(err.writes).toHaveLength(3);
    for (const w of err.writes) {
      expect(w.startsWith(SYNC_START) && w.endsWith(SYNC_END)).toBe(true);
      expect(w).not.toContain('\x1b[2J');
    }
    expect(err.writes[0]).toBe(`${SYNC_START}\r\x1b[K⠋ Working\x1b[J${SYNC_END}`);
    expect(err.writes[1]).toBe(`${SYNC_START}\r\x1b[K⠙ Working\n\x1b[K  Read package.json\x1b[J${SYNC_END}`);
    expect(err.writes[2]).toBe(`${SYNC_START}\r\x1b[1A\x1b[K⠹ Working\x1b[J${SYNC_END}`);
  });
  it('commits finished lines to stdout above the region and redraws the region below them', () => {
    const { out, err, region } = make();
    region.set(['⠋ Working']);
    region.commit(['✓ Read package.json']);
    expect(out.text).toBe('\x1b[K✓ Read package.json\n');
    expect(err.writes.slice(1)).toEqual([`${SYNC_START}\r\x1b[J`, `\r\x1b[K⠋ Working\x1b[J${SYNC_END}`]);
  });
  it('writes no erase codes into stdout when stdout is not a terminal (piped output stays clean)', () => {
    const out = new Sink(false), err = new Sink(true);
    const region = new LiveRegion({ out, err }, { live: true });
    region.set(['⠋ Working']);
    region.commit(['The answer is 4.']);
    expect(out.text).toBe('The answer is 4.\n');
  });
  it("keeps a tinted row's background: erase before the row, never after its reset", () => {
    const { out, region } = make();
    region.set(['⠋ Working']);
    region.commit(['\x1b[48;2;31;31;31m\x1b[K › hi\x1b[49m']);
    expect(out.text).toBe('\x1b[K\x1b[48;2;31;31;31m\x1b[K › hi\x1b[49m\n');
  });
  it('can park the cursor inside the region (the input caret) and redraws from the region top', () => {
    const { err, region } = make();
    region.set(['pad', ' › hi', 'pad'], { row: 1, col: 5 });
    expect(err.writes[0]).toBe(`${SYNC_START}\r\x1b[Kpad\n\x1b[K › hi\n\x1b[Kpad\x1b[J\x1b[1A\r\x1b[5C${SYNC_END}`);
    region.set(['x']);
    expect(err.writes[1]).toBe(`${SYNC_START}\r\x1b[1A\x1b[Kx\x1b[J${SYNC_END}`);
  });
  it('keeps a tinted row tinted inside the region too (no erase after its reset)', () => {
    const { err, region } = make();
    region.set(['\x1b[48;2;31;31;31m\x1b[K › hi\x1b[49m']);
    expect(err.writes[0]).not.toMatch(/\x1b\[49m\x1b\[K/);
  });
  it('erases itself on close and leaves the cursor at a clean line start', () => {
    const { err, region } = make();
    region.set(['a', 'b']);
    region.close();
    expect(err.writes.at(-1)).toBe(`${SYNC_START}\r\x1b[1A\x1b[J${SYNC_END}`);
    region.set(['c']);
    expect(err.writes).toHaveLength(2);
  });
  it('without a live terminal, never draws a region and commits plain lines', () => {
    const { out, err, region } = make(false);
    region.set(['⠋ Working']);
    region.commit(['done']);
    expect(err.writes).toEqual([]);
    expect(out.text).toBe('done\n');
  });
});

describe('LiveRegion bounds (review finding: rows wider or taller than the terminal)', () => {
  it('cuts every row to the width minus one, so no row soft-wraps and the redraw math holds', () => {
    const out = new Sink(true), err = new Sink(true, 40);
    const region = new LiveRegion({ out, err }, { live: true });
    region.set([`\x1b[1m${'x'.repeat(100)}\x1b[22m`, 'short']);
    const rows = err.writes[0].replace(SYNC_START, '').replace(SYNC_END, '').split('\n');
    for (const row of rows) expect(visibleWidth(row)).toBeLessThanOrEqual(39);
  });
  it('shows at most rows minus one lines (the newest), keeping a parked caret on its line', () => {
    const out = new Sink(true), err = Object.assign(new Sink(true, 80), { rows: 6 });
    const region = new LiveRegion({ out, err }, { live: true });
    region.set(Array.from({ length: 12 }, (_, i) => `line ${i}`), { row: 11, col: 3 });
    const frame = err.writes[0];
    expect(frame).not.toContain('line 6');
    expect(frame).toContain('line 7');
    expect(frame).toContain('line 11');
    expect(frame.endsWith(`\r\x1b[3C${SYNC_END}`)).toBe(true);
    region.set(['x']);
    expect(err.writes[1].startsWith(`${SYNC_START}\r\x1b[4A`)).toBe(true);
  });
  it('draws a line with a newline in it as separate rows, so the next frame starts at the region top', () => {
    // LIVE-01 (row 65): a tool argument with newlines (canvas code) left stale copies of the step in
    // the scrollback, because the region counted one row where the terminal drew three.
    const { err, region } = make();
    region.set(['● canvas_exec', 'const a = 1;\nconst b = 2;']);
    region.set(['⠋ Working']);
    expect(err.writes[0]).toBe(`${SYNC_START}\r\x1b[K● canvas_exec\n\x1b[Kconst a = 1;\n\x1b[Kconst b = 2;\x1b[J${SYNC_END}`);
    expect(err.writes[1].startsWith(`${SYNC_START}\r\x1b[2A`)).toBe(true);
  });
});

describe('Spinner', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  const frames = ['⠋', '⠙', '⠹'];
  it('animates every 80ms and shows elapsed time after one second', () => {
    const { err, region } = make();
    const spinner = new Spinner(region, { frames, label: 'Working' });
    spinner.start();
    expect(err.text).toContain('⠋ Working');
    vi.advanceTimersByTime(80);
    expect(err.writes.at(-1)).toContain('⠙ Working');
    vi.advanceTimersByTime(1200);
    expect(err.writes.at(-1)).toMatch(/Working 1\.\ds/);
    const count = err.writes.length;
    spinner.stop();
    vi.advanceTimersByTime(400);
    expect(err.writes.length).toBe(count + 1);
    expect(err.writes.at(-1)).toBe(`${SYNC_START}\r\x1b[J${SYNC_END}`);
  });
  // Third order, checkpoint 2: progress comes only from real counts, and no time left is ever estimated.
  it('switches to a 20-cell bar past 10 seconds when a step reports real counts, with no estimated time left', () => {
    const { err, region } = make();
    const spinner = new Spinner(region, { frames, label: 'Rendering' });
    spinner.start();
    spinner.progress(5, 20);
    vi.advanceTimersByTime(12_000);
    spinner.progress(10, 20);
    vi.advanceTimersByTime(80);
    expect(err.writes.at(-1)).toContain('Rendering ██████████░░░░░░░░░░ 10 of 20 12.1s');
    expect(err.writes.at(-1)).not.toMatch(/left|ETA|%/);
  });
  it('prints one static line instead of animating when the region is not live', () => {
    const { out, err, region } = make(false);
    const spinner = new Spinner(region, { frames, label: 'Working', staticWriter: (s) => err.write(s) });
    spinner.start();
    vi.advanceTimersByTime(1000);
    spinner.stop();
    expect(err.writes).toEqual(['Working...\n']);
    expect(out.writes).toEqual([]);
  });
});
