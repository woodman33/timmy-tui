// R5 (H131): the terminal Workbench's line helpers added in the QA round (src/workbench/text.ts): wrapSegs (a line of several
// voices wrapped at its spaces, a word wider than a row broken just after a separator, never with an ellipsis) and pickRanked
// (pieces kept whole or left out, the least needed first, drawn in their order). Pure: no terminal, no files.
import { describe, expect, it } from 'vitest';
import { clip, cut, fit, lineCells, pickRanked, plain, trimTo, wrapSegs, type Line } from '../src/workbench/text.js';

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

// R8 (H157; the R7 package's item E): cut() ends after the last whole word that fits, never through a word (it ended at a
// space only in the room's last third: "Connect a Cloudro..." at 20 cells, "Check con…" at 10); a first word wider than the
// whole room shows its start (an id, as DESIGN.md §2.4 draws a hash); raw content is clipped where the row ends
describe('cut, clip and trimTo', () => {
  it('cut ends after the last whole word that fits, in both ellipses, and trims the separator before it', () => {
    expect(cut('Connect a Cloudroom Core', 20, '...')).toBe('Connect a...');
    expect(cut('Check connections', 10)).toBe('Check…');
    expect(cut('After Effects composition', 24)).toBe('After Effects…');
    // all of the room when the text goes on with a space there
    expect(cut('a person should decide', 16)).toBe('a person should…');
    expect(cut('Use Clef routing: off (the default)', 18)).toBe('Use Clef routing…');
    expect(cut('fits whole', 10)).toBe('fits whole');
    expect(cut('anything', 0)).toBe('');
    expect(cut('anything', 1)).toBe('…');
  });

  it('a first word wider than the whole room shows its start (an id), and clip cuts raw content where the row ends', () => {
    expect(cut('f97cd105c0ffee', 6)).toBe('f97cd…');
    expect(clip('fetched xxxxxxxxxxxxxxxxxxxxxxxx', 14)).toBe('fetched xxxxx…');
    expect(clip('{"v":1,"type":"job.end"}', 10, '...')).toBe('{"v":1,...');
    expect(clip('short', 10)).toBe('short');
  });

  it('a segment after others whose first word does not fit ends the row with the ellipsis after the words before it; a raw one is clipped', () => {
    // a wrapped row holds one word a segment (src/workbench/text.ts wrapSegs): the word that does not fit is not cut through
    const row: Line = [S('or', 'secondary'), S(' ', 'secondary'), S('set', 'secondary'), S(' ', 'secondary'), S('OPENROUTER_API_KEY', 'secondary')];
    expect(plain(trimTo(row, 12))).toBe('or set…');
    expect(plain(fit(row, 12))).toBe('or set…     ');
    expect(lineCells(fit(row, 12))).toBe(12);
    // what a job printed is evidence: as much of it as fits
    expect(plain(fit([S('    raw ', 'secondary'), { text: '{"v":1,"type":"job.end","id":"j1"}', role: 'secondary', raw: true }], 24))).toBe('    raw {"v":1,"type":"…');
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

  // R8 (H157; the R7 package's item E): in one fixed order: a shorter, less important piece never takes the place of a more
  // important one that does not fit
  it('once a piece does not fit, every less important one is left out too', () => {
    const long = { line: [S('[s]', 'action'), S(' a long piece that does not fit', 'secondary')] as Line, rank: 1 };
    const pieces = [h('a', 0), long, h('b', 2)];
    // room for [a] and [b], not for the long piece: [b] (rank 2) is not drawn in its place
    expect(plain(pickRanked(pieces, 30))).toBe('[a] a-words');
    // room for all three: all of them, in their order
    expect(plain(pickRanked(pieces, 200))).toBe('[a] a-words  [s] a long piece that does not fit  [b] b-words');
  });
});
