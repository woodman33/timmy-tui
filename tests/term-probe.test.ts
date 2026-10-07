import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { parseColorReplies, probeTerminalColors, type ProbeStreams } from '../src/term/probe.js';

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
    // Row 28: slots 1, 2, 3 and 5 too, so a meaning color that misses its floor on this terminal is dropped.
    expect(stdout.writes).toEqual(['\x1b]11;?\x07\x1b]4;7;?\x07\x1b]4;8;?\x07\x1b]4;1;?\x07\x1b]4;2;?\x07\x1b]4;3;?\x07\x1b]4;5;?\x07\x1b[c']);
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
  it('never queries a terminal that is not interactive (echo hi | timmy)', async () => {
    const { stdout, io } = streams('\x1b]11;rgb:0000/0000/0000\x07');
    expect(await probeTerminalColors(io, { interactive: false })).toEqual({ background: null, slots: {} });
    expect(stdout.writes).toEqual([]);
  });
});
