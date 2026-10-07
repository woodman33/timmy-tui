import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { parseColorReplies, probeTerminalColors, type ProbeStreams } from '../src/term/probe.js';
import { detectCapabilities } from '../src/term/capabilities.js';
import { SLOT_NAMES, TERMINAL_CLEAR_DARK, type TerminalPalette } from '../src/term/palettes.js';
import { buildTheme } from '../src/term/theme.js';

// OSC 11 asks for the background, OSC 4 for palette slots 7 and 8, and DA1 is the sentinel every
// terminal answers, so a terminal that ignores OSC queries ends the wait early (playbook §17.3).
class FakeIn extends EventEmitter {
  isTTY = true;
  isRaw = false;
  paused = true;
  setRawMode(v: boolean) { this.isRaw = v; return this; }
  resume() { this.paused = false; return this; }
  pause() { this.paused = true; return this; }
}
class FakeOut {
  isTTY = true;
  writes: string[] = [];
  constructor(private stdin: FakeIn, private reply: string | null, private delayMs = 5) {}
  write(s: string) {
    this.writes.push(s);
    const reply = this.reply;
    if (reply !== null) setTimeout(() => this.stdin.emit('data', Buffer.from(reply)), this.delayMs);
    return true;
  }
}
const streams = (reply: string | null, delayMs?: number) => {
  const stdin = new FakeIn();
  const stdout = new FakeOut(stdin, reply, delayMs);
  return { stdin, stdout, io: { stdin, stdout } as unknown as ProbeStreams };
};

describe('parseColorReplies', () => {
  it('reads OSC 11 and OSC 4 replies ended by BEL or ST', () => {
    const r = parseColorReplies('\x1b]11;rgb:0000/0000/0000\x07\x1b]4;7;rgb:d0d0/d0d0/d0d0\x1b\\\x1b]4;8;rgb:6c6c/6c6c/6c6c\x07');
    expect(r.background).toBe('#000000');
    expect(r.slots).toEqual({ 7: '#D0D0D0', 8: '#6C6C6C' });
  });
  it('scales 1-, 2- and 4-digit channels', () => {
    expect(parseColorReplies('\x1b]11;rgb:ff/80/00\x07').background).toBe('#FF8000');
    expect(parseColorReplies('\x1b]11;rgb:f/8/0\x07').background).toBe('#FF8800');
    expect(parseColorReplies('\x1b]11;rgb:ffff/8080/0000\x07').background).toBe('#FF8000');
  });
});

describe('probeTerminalColors', () => {
  it('asks once, reads the replies, then restores raw mode and pauses stdin', async () => {
    const { stdin, stdout, io } = streams('\x1b]11;rgb:0000/0000/0000\x07\x1b]4;7;rgb:d0d0/d0d0/d0d0\x07\x1b]4;8;rgb:6c6c/6c6c/6c6c\x07\x1b[?62;22c');
    const result = await probeTerminalColors(io, { interactive: true });
    // Row 28: slots 1, 2, 3 and 5 too, so a meaning color that misses its floor on this terminal is dropped;
    // fourth order, step 2: and their bright twins 9, 10, 11 and 13, which a meaning takes when its own misses.
    expect(stdout.writes).toEqual(['\x1b]11;?\x07\x1b]4;7;?\x07\x1b]4;8;?\x07\x1b]4;1;?\x07\x1b]4;2;?\x07\x1b]4;3;?\x07\x1b]4;5;?\x07\x1b]4;9;?\x07\x1b]4;10;?\x07\x1b]4;11;?\x07\x1b]4;13;?\x07\x1b[c']);
    expect(result).toEqual({ background: '#000000', slots: { 7: '#D0D0D0', 8: '#6C6C6C' } });
    expect([stdin.isRaw, stdin.paused, stdin.listenerCount('data')]).toEqual([false, true, 0]);
  });
  it('ends early when only the DA1 sentinel answers', async () => {
    const { io } = streams('\x1b[?1;2c');
    const started = Date.now();
    expect(await probeTerminalColors(io, { interactive: true })).toEqual({ background: null, slots: {} });
    expect(Date.now() - started).toBeLessThan(150);
  });
  it('gives up after 200ms with no answer and still restores the terminal', async () => {
    const { stdin, io } = streams(null);
    const started = Date.now();
    expect(await probeTerminalColors(io, { interactive: true })).toEqual({ background: null, slots: {} });
    expect(Date.now() - started).toBeGreaterThanOrEqual(190);
    expect([stdin.isRaw, stdin.paused, stdin.listenerCount('data')]).toEqual([false, true, 0]);
  });
  // Fourth order, step 2, found in Terminal on the Mac: the twin rule (row 51) needs the bright twins
  // measured, and the probe did not ask for them. A fake terminal that answers only what it is asked,
  // with the colors macOS Terminal "Clear Dark" answered there (red 3.09:1, bright red 4.61:1).
  it('asks for the bright twins too, so a meaning can take one: failure in bright red on Clear Dark', async () => {
    const terminal = (p: TerminalPalette) => {
      const stdin = new FakeIn();
      const hex = (h: string) => [1, 3, 5].map((i) => h.slice(i, i + 2).toLowerCase().repeat(2)).join('/');
      const stdout = {
        isTTY: true,
        write(q: string) {
          const asked = [...q.matchAll(/\x1b\]4;(\d+);\?\x07/g)].map((m) => Number(m[1]));
          const reply = `\x1b]11;rgb:${hex(p.background)}\x07${asked.map((n) => `\x1b]4;${n};rgb:${hex(p[SLOT_NAMES[n]])}\x07`).join('')}\x1b[?1;2;4c`;
          setTimeout(() => stdin.emit('data', Buffer.from(reply)), 5);
          return true;
        },
      };
      return { stdin, stdout } as unknown as ProbeStreams;
    };
    const measured = await probeTerminalColors(terminal(TERMINAL_CLEAR_DARK), { interactive: true });
    expect(Object.keys(measured.slots).map(Number).sort((a, b) => a - b)).toEqual([1, 2, 3, 5, 7, 8, 9, 10, 11, 13]);
    const tty = { isTTY: true, columns: 80, rows: 24 };
    const theme = buildTheme(detectCapabilities({ env: { TERM: 'xterm-256color', COLORTERM: 'truecolor', LANG: 'en_US.UTF-8' }, stdin: tty, stdout: tty, stderr: tty }), measured);
    expect([theme.open('failure'), theme.open('ai'), theme.open('secondary')]).toEqual(['\x1b[1;91m', '\x1b[35m', '\x1b[37m']);
  });
  it('never queries a terminal that is not interactive (echo hi | timmy)', async () => {
    const { stdout, io } = streams('\x1b]11;rgb:0000/0000/0000\x07');
    expect(await probeTerminalColors(io, { interactive: false })).toEqual({ background: null, slots: {} });
    expect(stdout.writes).toEqual([]);
  });
});
