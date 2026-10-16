// R5 (H131): the terminal Workbench's line helpers added in the QA round (src/workbench/text.ts): wrapSegs (a line of several
// voices wrapped at its spaces, a word wider than a row broken just after a separator, never with an ellipsis) and pickRanked
// (pieces kept whole or left out, the least needed first, drawn in their order). Pure: no terminal, no files.
import { describe, expect, it } from 'vitest';
import { lineCells, pickRanked, plain, wrapSegs, type Line } from '../src/workbench/text.js';

const S = (text: string, role: Line[number]['role'] = 'text'): Line[number] => ({ text, role });

describe('wrapSegs', () => {
  it('a line that fits is the line itself', () => {
    const line: Line = [S('Kept in ', 'secondary'), S('~/x.json', 'action')];
    expect(wrapSegs(line, 40)).toEqual([line]);
  });

  it('wraps at spaces, each piece keeping its role, rows after the first starting with the indent, none wider than the row', () => {
    const line: Line = [S('[x]', 'action'), S(' Remember layout', 'strong'), S('  the workspace, tab and Activity come back per project', 'secondary')];
    const rows = wrapSegs(line, 30, '    ');
    expect(rows.length).toBeGreaterThan(1);
    for (const r of rows) expect(lineCells(r)).toBeLessThanOrEqual(30);
    expect(rows.slice(1).every((r) => plain(r).startsWith('    '))).toBe(true);
    // the words, in order, with nothing cut or added (the rows joined at their breaks)
    expect(rows.map((r) => plain(r).trim()).join(' ').replace(/\s+/g, ' ')).toBe(plain(line).replace(/\s+/g, ' ').trim());
    // the roles: the key is still the key's, the label the label's
    expect(rows[0][0]).toEqual(S('[x]', 'action'));
    expect(rows.flat().filter((s) => s.text.includes('Remember')).every((s) => s.role === 'strong')).toBe(true);
  });

  it('a path wider than the row breaks just after a /, never mid-name and never with an ellipsis', () => {
    const path = '/tmp/wb-render-abc123/timmy/settings/workbench.json.';
    const rows = wrapSegs([S('Kept in ', 'secondary'), S(path, 'secondary')], 30);
    for (const r of rows) expect(lineCells(r)).toBeLessThanOrEqual(30);
    // the words before it on their row; the path on the next rows, broken after its last / that fits
    expect(rows.map(plain)).toEqual(['Kept in', '/tmp/wb-render-abc123/timmy/', 'settings/workbench.json.']);
  });
});

describe('pickRanked', () => {
  const h = (k: string, rank: number) => ({ line: [S(`[${k}]`, 'action'), S(` ${k}-words`, 'secondary')] as Line, rank });

  it('keeps every piece that fits, in the order given', () => {
    expect(plain(pickRanked([h('a', 2), h('b', 0), h('c', 1)], 200))).toBe('[a] a-words  [b] b-words  [c] c-words');
  });

  it('leaves out the least needed first (the highest rank), never cutting a piece, and keeps the order of the rest', () => {
    const pieces = [h('1–0', 1), h('Enter', 2), h('x', 3), h('?', 0)];
    const all = lineCells(pickRanked(pieces, 200));
    // one cell short of all of them: the least needed (x, rank 3) goes; ? (rank 0) stays, at the end
    expect(plain(pickRanked(pieces, all - 1))).toBe('[1–0] 1–0-words  [Enter] Enter-words  [?] ?-words');
    // room for one: the most needed alone
    expect(plain(pickRanked(pieces, 12))).toBe('[?] ?-words');
    expect(pickRanked(pieces, 3)).toEqual([]);
  });
});
