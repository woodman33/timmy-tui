// R4 (H98, journey-2, item 7): src/repl/notice-wrap.ts, the REPL's lines wider than the terminal wrapped onto indented
// continuation rows instead of cut. The PTY test of the whole REPL is tests/repl-wrap-pty.test.ts.
import { describe, expect, it } from 'vitest';
import { wrapSegments } from '../src/repl/notice-wrap.js';
import { hyperlink } from '../src/term/marks.js';
import type { Segment } from '../src/term/theme.js';
import { visibleWidth } from '../src/term/width.js';

const text = (rows: Segment[][]): string[] => rows.map((r) => r.map((s) => s.text).join(''));
// a /run end line in the shape src/repl/workspace.ts writes (the ids made up here, in their real shapes)
const END: Segment[] = [
  { text: '  ✖ ' },
  { text: 'j7be74b failed', role: 'failure' },
  { text: '  WRAP.md › a-block-that-fails-on-purpose: a-block-that-fails-on-purpose exited 3 · /jobs j7be74b shows its output · operation o2ea424ae (/op o2ea424ae)', role: 'secondary' },
];

describe('wrapSegments: a line wider than the terminal', () => {
  it('a line that fits is the line itself, its segments as they were', () => {
    const line: Segment[] = [{ text: '  ✓ ' }, { text: 'j1a2b3c completed', role: 'strong' }];
    expect(wrapSegments(line, 80)).toEqual([line]);
  });

  it('breaks between words onto rows indented two columns more than the line; every word whole, every row within the width', () => {
    const rows = wrapSegments(END, 80);
    const t = text(rows);
    expect(t).toEqual([
      '  ✖ j7be74b failed  WRAP.md › a-block-that-fails-on-purpose:',
      '    a-block-that-fails-on-purpose exited 3 · /jobs j7be74b shows its output ·',
      '    operation o2ea424ae (/op o2ea424ae)',
    ]);
    for (const r of t) expect(visibleWidth(r)).toBeLessThanOrEqual(80);
    // nothing lost or added but the breaks: the words are the line's words
    expect(t.join(' ').split(/\s+/).filter(Boolean)).toEqual(END.map((s) => s.text).join('').split(/\s+/).filter(Boolean));
  });

  it('keeps each piece in its own role, and at 40 columns still never cuts an id', () => {
    const rows = wrapSegments(END, 40);
    for (const r of text(rows)) expect(visibleWidth(r)).toBeLessThanOrEqual(40);
    expect(rows[0]).toEqual([{ text: '  ✖ ' }, { text: 'j7be74b failed', role: 'failure' }, { text: '  WRAP.md ›', role: 'secondary' }]);
    expect(rows.slice(1).every((r) => r[0].text.startsWith('    ') && r.at(-1)!.role === 'secondary')).toBe(true);
    const words = text(rows).join(' ').split(/\s+/);
    for (const id of ['j7be74b', 'o2ea424ae', '(/op']) expect(words).toContain(id);
  });

  it('a link is one word that takes only its text\'s cells, and is never broken', () => {
    const link = hyperlink('WRAP.md', 'file:///tmp/project/WRAP.md', true);
    const rows = wrapSegments([{ text: `  ${'word '.repeat(14)}${link} after` }], 40);
    const joined = text(rows).join('\n');
    expect(joined).toContain(link);
    for (const r of text(rows)) expect(visibleWidth(r)).toBeLessThanOrEqual(40);
  });

  it('a word wider than a whole row (a long path) is broken by cells, every character kept', () => {
    const path = `/tmp/${'a'.repeat(50)}/${'b'.repeat(50)}.json`;
    const rows = text(wrapSegments([{ text: `  wrote ${path}` }], 40));
    for (const r of rows) expect(visibleWidth(r)).toBeLessThanOrEqual(40);
    expect(rows.map((r) => r.trim()).join('').replace(/^wrote/, '')).toBe(path);
  });

  it('a width it cannot use (0, or not a number) leaves the line as it is', () => {
    expect(wrapSegments(END, 0)).toEqual([END]);
    expect(wrapSegments(END, Number.NaN)).toEqual([END]);
  });
});
