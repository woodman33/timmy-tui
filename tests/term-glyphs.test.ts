import { describe, expect, it } from 'vitest';
import { glyphSet } from '../src/term/glyphs.js';

const printableAscii = (s: string): boolean => [...s].every((ch) => ch >= ' ' && ch <= '~');

describe('glyph sets', () => {
  it('pairs every Unicode glyph with an ASCII word or mark (playbook §16.7)', () => {
    const u = glyphSet(true), a = glyphSet(false);
    expect(Object.keys(a).sort()).toEqual(Object.keys(u).sort());
    expect([u.ok, u.fail, u.warn, u.ai]).toEqual(['✓', '✖', '⚠', '◉']);
    expect([a.ok, a.fail, a.warn, a.ai, a.info]).toEqual(['[OK]', '[FAIL]', '[WARN]', '[AI]', '[INFO]']);
    expect(a.spinner).toEqual(['|', '/', '-', '\\']);
    expect(u.spinner).toHaveLength(10);
  });
  it('keeps the ASCII set pure ASCII, including the separator that leaked as a middle dot', () => {
    const a = glyphSet(false);
    expect(a.sep).toBe('-');
    for (const [name, value] of Object.entries(a)) {
      const values = Array.isArray(value) ? value : [value];
      for (const v of values) expect(printableAscii(v), `${name} = ${JSON.stringify(v)}`).toBe(true);
    }
  });
});
