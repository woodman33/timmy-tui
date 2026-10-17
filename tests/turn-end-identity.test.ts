// R6 lead (PR #100; CI at 8d17ec0, attempt 2): a previous turn's receipt never ends the current turn in the REPL's terminal
// tests, wherever it is on screen. The screens below are drawn as the REPL draws them (a receipt line, the composer's rules,
// the prompt, the answer), with the FAKE model's words; the second turn's end is told by tests/helpers/turn-end.ts.
//
// The R6 check, kept here as a negative control: it looked for a receipt line after this turn's prompt, and on the whole
// screen while that prompt was not on screen yet. On CI's slower runner the first screen read came before the 120-column
// prompt reached the screen, the previous turn's receipt was taken for this turn's end, and no streaming screen counted.
import { describe, expect, it } from 'vitest';
import { newReceipt, receiptsOn } from './helpers/turn-end.js';

const ASK = 'stream a long answer at 120 columns';
const RULE = '─'.repeat(60);
const previousEnd = [
  '(FAKE model, 160 columns, line 39 of 40: a tray holds things.) (FAKE model, 160 columns, line 40 of 40: a tray holds',
  'things.)',
  '',
  '✓ RECEIPT 3f9a0c21 signed and verified',
  '  0 steps · no charge (local endpoint) · 6.4s · qwen3:8b',
  '  Receipt  http://127.0.0.1:4337/receipts/3f9a0c21 · or timmy receipts',
  '',
];
const composer = (typed = ''): string[] => [RULE, `› ${typed}`, RULE, '  ~/demo · qwen3:8b · Enter to send'];
const streaming = (upTo: number): string[] => Array.from({ length: upTo }, (_, i) => `(FAKE model, 120 columns, line ${i + 1} of 40: a tray holds things.)`);
const screen = (...parts: string[][]): string => parts.flat().join('\n');

/** The R6 check, as tests/repl-stream-wrap-pty.test.ts had it at 4a2e4b2. */
const r6Ended = (s: string): boolean => /RECEIPT [0-9a-f]{8} signed and verified/.test(s.includes(ASK) ? s.slice(s.lastIndexOf(ASK)) : s);

describe('a turn ends at a receipt the terminal had not shown before it was sent (R6 lead, PR #100)', () => {
  // what the scrollback showed just before Enter: the first turn, ended
  const before = receiptsOn(screen(previousEnd, composer()));

  it('the scrollback before Enter names the previous turn\'s receipt by its identity', () => {
    expect([...before]).toEqual(['3f9a0c21']);
  });

  it('a screen read before this turn\'s prompt reached the screen: the previous receipt is no end (the race CI hit)', () => {
    const s = screen(previousEnd, composer());
    expect(s.includes(ASK)).toBe(false);
    expect(newReceipt(s, before)).toBeNull();
    // negative control: the R6 check took the previous turn's receipt for this turn's end on this very screen
    expect(r6Ended(s)).toBe(true);
  });

  it('the prompt typed but not sent yet, the previous receipt above it: no end', () => {
    const s = screen(previousEnd, composer(ASK));
    expect(newReceipt(s, before)).toBeNull();
  });

  it('both on screen after the new prompt appears, the answer streaming under it: no end', () => {
    const s = screen(previousEnd, [`› ${ASK}`, ''], streaming(6), composer());
    expect(s.includes(ASK)).toBe(true);
    expect(s).toContain('RECEIPT 3f9a0c21 signed and verified');
    expect(newReceipt(s, before)).toBeNull();
  });

  it('the previous receipt drawn again below this turn\'s prompt (a /receipts listing, say): still no end', () => {
    const s = screen([`› ${ASK}`, ''], streaming(3), ['✓ RECEIPT 3f9a0c21 signed and verified'], composer());
    expect(newReceipt(s, before)).toBeNull();
    expect(r6Ended(s)).toBe(true);
  });

  it('this turn\'s own receipt ends it, with the previous one still on screen above', () => {
    const s = screen(previousEnd, [`› ${ASK}`, ''], streaming(40), ['', '✓ RECEIPT 7be41d06 signed and verified', '  0 steps · no charge (local endpoint) · 6.2s · qwen3:8b'], composer());
    expect(newReceipt(s, before)).toBe('7be41d06');
  });

  it('this turn\'s own receipt ends it once its prompt and the previous receipt have scrolled off', () => {
    const s = screen(streaming(40).slice(20), ['', '✓ RECEIPT 7be41d06 signed and verified'], composer());
    expect(s.includes(ASK)).toBe(false);
    expect(newReceipt(s, before)).toBe('7be41d06');
  });

  it('a line that only looks like a receipt (no 8 hex digits) is none', () => {
    expect(receiptsOn('RECEIPT 3f9a0c2 signed and verified\nRECEIPT 3F9A0C21 signed and verified').size).toBe(0);
  });
});
