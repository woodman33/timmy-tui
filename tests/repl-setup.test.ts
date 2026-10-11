import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { glyphSet } from '../src/term/glyphs.js';
import { visibleWidth } from '../src/term/width.js';
import { setupCheck } from '../src/repl/setup.js';
import { readChain } from '../src/utils/receipts.js';

// C-14: the setup check a first run offers. Four lines within 60 columns (identity, model key, receipts,
// palette: the palette offer), then the check is sealed as a receipt; the receipt line turns green only
// when the chain verifies after the write (C-8).
const dirs: string[] = [];
const store = (): string => { const d = mkdtempSync(join(tmpdir(), 'timmy-setup-')); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const text = (lines: Array<Array<{ text: string }>>): string[] => lines.map((l) => l.map((s) => s.text).join(''));
const g = glyphSet(true);

describe('the setup check', () => {
  it('on a blank home: says what is missing and how to fix it, offers the palette, and seals the first receipt', () => {
    const dir = store();
    const r = setupCheck({ operator: null, key: false, palette: null, themes: '/opt/timmy/assets/themes' }, g, dir);
    const out = text(r.lines).join('\n');
    expect(out).toMatch(/identity.*timmy init/);
    expect(out).toMatch(/model key.*OPENROUTER_API_KEY/);
    expect(out).toMatch(/palette.*Timmy Homebrew, Night or Day/);
    // C-10: the offer is the command that installs it (it knows where the files are).
    expect(out).toMatch(/install\s+timmy theme install/);
    const chain = readChain('runs', dir);
    expect({ receipts: chain.length, kind: chain[0]?.kind, verified: r.receipt.verified, hash: r.receipt.hash === chain[0]?.hash }).toEqual({ receipts: 1, kind: 'check', verified: true, hash: true });
    expect(chain[0].discrepancies).toEqual(['identity', 'model key', 'palette']);
    expect(text(r.lines).filter((l) => visibleWidth(l) > 60)).toEqual([]);
  });
  it('on an ASCII-only terminal every line is ASCII (the middle dot leaked before)', () => {
    const r = setupCheck({ operator: null, key: false, palette: null, themes: '/opt/timmy/assets/themes' }, glyphSet(false), store());
    expect(text(r.lines).filter((l) => /[^\x20-\x7e]/.test(l))).toEqual([]);
  });
  it('with everything in place: names the operator and the palette, and nothing is missing', () => {
    const dir = store();
    const r = setupCheck({ operator: 'Sample', key: true, palette: 'night', themes: '/x' }, g, dir);
    const out = text(r.lines).join('\n');
    expect(out).toContain('Sample');
    expect(out).toContain('Timmy Night');
    expect(out).not.toContain(g.fail);
    expect(readChain('runs', dir)[0].discrepancies).toEqual([]);
  });
  it('the receipt line is green only after a real verify: a broken chain shows ✖', () => {
    const dir = store();
    const r = setupCheck({ operator: 'Sample', key: true, palette: 'day', themes: '/x' }, g, dir, () => ({ ok: false, count: 1, reason: 'hash mismatch' }));
    const last = r.lines[r.lines.length - 1];
    expect({ verified: r.receipt.verified, roles: last.map((s) => s.role).filter(Boolean) }).toEqual({ verified: false, roles: ['failure', 'secondary'] });
  });
});
