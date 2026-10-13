import { describe, expect, it } from 'vitest';
import { detectCapabilities } from '../src/term/capabilities.js';
import { LiveRegion } from '../src/term/live-region.js';
import { measuredFromPalette, TIMMY_NIGHT } from '../src/term/palettes.js';
import { buildTheme } from '../src/term/theme.js';
import { visibleWidth } from '../src/term/width.js';
import { Transcript, type TurnEvent } from '../src/repl/transcript.js';
import { DEMO_LOADER, DEMO_TURN } from '../src/repl/demo.js';

// Round R1, assignment 1: `timmy repl --demo` is a recording of the renderer. It says so on screen,
// first and last, in words: it is scripted, no model answered, no tool ran, no receipt was written.
class Sink { writes: string[] = []; constructor(public isTTY: boolean) {} write(s: string) { this.writes.push(s); return true; } get text() { return this.writes.join(''); } }

function render(events: TurnEvent[], opts: { columns?: number; unicode?: boolean } = {}): string {
  const columns = opts.columns ?? 80;
  const stdout = { isTTY: false, columns, rows: 24 };
  const env: Record<string, string> = { TERM: 'xterm-256color', COLORTERM: 'truecolor', LANG: opts.unicode === false ? 'C' : 'en_US.UTF-8' };
  const caps = detectCapabilities({ env, stdin: stdout, stdout, stderr: { isTTY: false } });
  const out = new Sink(false), err = new Sink(false);
  const t = new Transcript(buildTheme(caps, measuredFromPalette(TIMMY_NIGHT)), new LiveRegion({ out, err }, { live: false }), { columns });
  for (const e of events) t.handle(e);
  t.endTurn();
  return out.text;
}

const rowsOf = (e: TurnEvent): string => (e.type === 'inspect' ? e.rows.map((r) => `${r.label} ${r.text}`).join(' ') : '');

describe('the scripted demonstration says what it is', () => {
  for (const [name, script] of [['--demo', DEMO_TURN], ['--demo-loader', DEMO_LOADER]] as const) {
    it(`${name} opens on a label before anything else happens`, () => {
      const first = script[0].event;
      expect(first.type).toBe('inspect');
      const words = rowsOf(first);
      expect(words).toMatch(/scripted demonstration/i);
      expect(words).toMatch(/no model answered/i);
      expect(words).toMatch(/no tool ran/i);
      expect(script[0].delayMs).toBe(0);
    });
    it(`${name} shows the label in the rendered output, wide and narrow, with and without Unicode`, () => {
      for (const columns of [40, 60, 80]) {
        for (const unicode of [true, false]) {
          const text = render(script.map((s) => s.event), { columns, unicode });
          const flat = text.replace(/\s+/g, ' ');
          expect(flat, `${columns} cols, unicode ${unicode}`).toMatch(/scripted/i);
          expect(flat).toMatch(/no model/i);
          for (const line of text.split('\n')) expect(visibleWidth(line)).toBeLessThanOrEqual(columns);
        }
      }
    });
  }

  it('--demo closes on a label that names the receipt as not written, after the scripted receipt', () => {
    const events = DEMO_TURN.map((s) => s.event);
    const receipt = events.findIndex((e) => e.type === 'receipt');
    expect(receipt).toBeGreaterThan(0);
    const after = events.slice(receipt + 1);
    const words = after.map(rowsOf).join(' ');
    expect(words).toMatch(/scripted/i);
    expect(words).toMatch(/not written/i);
    expect(words).toMatch(/spend none/i);
  });

  it('keeps its own words honest: the labels never claim a verification or a result', () => {
    for (const e of [DEMO_TURN[0].event, DEMO_TURN[DEMO_TURN.length - 1].event, DEMO_LOADER[0].event]) {
      expect(rowsOf(e)).not.toMatch(/signed and verified|VERIFIED|passed|succeeded/i);
    }
    expect(rowsOf(DEMO_TURN[0].event)).not.toMatch(/\$\d/);
  });

  it('is still deterministic, byte for byte', () => {
    expect(render(DEMO_TURN.map((s) => s.event))).toBe(render(DEMO_TURN.map((s) => s.event)));
  });
});
