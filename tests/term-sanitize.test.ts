import { describe, expect, it } from 'vitest';
import { cutAnsi, sanitize } from '../src/term/sanitize.js';
import { visibleWidth } from '../src/term/width.js';

// Text from the model, tools and the network is untrusted (review finding): control characters can
// erase what a box shows (backspace), and escape sequences can set the clipboard (OSC 52) or plant
// links (OSC 8). Tabs are expanded so width math holds.
describe('sanitize', () => {
  it('keeps text and newlines, expands tabs, and drops every control character and escape sequence', () => {
    expect(sanitize('a\tb\nc')).toBe('a    b\nc');
    expect(sanitize('del build\b\b\b\b\b\b\b\b\bls build')).toBe('del buildls build');
    expect(sanitize('x\x1b]52;c;ZXZpbA==\x07y\x1b[2Jz\x1b]8;;http://evil.test\x1b\\w')).toBe('xyzw');
    expect(sanitize('one\r\ntwo\rthree\u009b31m\u0007!')).toBe('one\ntwothree31m!');
  });
});

describe('cutAnsi', () => {
  it('cuts a styled line to a display width, keeps its escapes, and closes what it cut open', () => {
    const line = `\x1b[1;31m✖ Error:\x1b[22;39m ${'x'.repeat(60)}`;
    const cut = cutAnsi(line, 20);
    expect(visibleWidth(cut)).toBe(20);
    expect(cut.startsWith('\x1b[1;31m✖ Error:')).toBe(true);
    expect(cut.endsWith('\x1b[0m')).toBe(true);
    expect(cutAnsi('short', 20)).toBe('short');
    expect(visibleWidth(cutAnsi('日本語のテロップ', 7))).toBeLessThanOrEqual(7);
    const linked = cutAnsi('\x1b]8;;http://127.0.0.1:4590/r/1\x1b\\RECEIPT 0001 long long long\x1b]8;;\x1b\\', 10);
    expect(linked.endsWith('\x1b]8;;\x1b\\\x1b[0m')).toBe(true);
  });
});
