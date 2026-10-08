import { describe, expect, it } from 'vitest';
import { hyperlink, markPromptRows, OSC133 } from '../src/term/marks.js';

// DESIGN.md §10 B8: receipts carry OSC 8 links, turns carry OSC 133 marks (jump between turns).
describe('OSC 133 turn marks', () => {
  it('marks the start and end of the kept prompt block, and the turn output and its exit status', () => {
    expect(markPromptRows(['pad', ' › hi', 'pad'])).toEqual(['\x1b]133;A\x07pad', ' › hi', 'pad\x1b]133;B\x07']);
    expect(markPromptRows([])).toEqual([]);
    expect([OSC133.outputStart, OSC133.end(0), OSC133.end(1)]).toEqual(['\x1b]133;C\x07', '\x1b]133;D;0\x07', '\x1b]133;D;1\x07']);
  });
});

describe('OSC 8 links', () => {
  it('wraps the text in a link on a terminal, and prints the URL in full elsewhere', () => {
    expect(hyperlink('RECEIPT 0142', 'http://127.0.0.1:4590/r/0142', true)).toBe('\x1b]8;;http://127.0.0.1:4590/r/0142\x1b\\RECEIPT 0142\x1b]8;;\x1b\\');
    expect(hyperlink('RECEIPT 0142', 'http://127.0.0.1:4590/r/0142', false)).toBe('RECEIPT 0142 (http://127.0.0.1:4590/r/0142)');
  });
});
