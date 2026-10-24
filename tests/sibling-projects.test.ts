// R9 lead (item B): the PROJECTS line's folder listing, read asynchronously and bounded (src/tui/sibling-projects.ts).
// ShellV2's first render used to read it itself, synchronously and with no bound (tests/shell-first-frame.test.tsx).
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { siblingProjects, siblingProjectsWords, SIBLING_LIMIT } from '../src/tui/sibling-projects.js';

const made: string[] = [];
const folder = (): string => { const p = mkdtempSync(join(tmpdir(), 'timmy-sib-')); made.push(p); return p; };
afterEach(() => { for (const p of made.splice(0)) rmSync(p, { recursive: true, force: true }); });

describe('siblingProjects: the folders beside this one that hold a .timmy (R9 lead, item B)', () => {
  it('names the entries holding a .timmy, sorted, a link to such a folder included, and counts what it looked at', async () => {
    const p = folder();
    for (const d of ['gamma', 'alpha', 'beta', 'delta']) mkdirSync(join(p, d));
    mkdirSync(join(p, 'gamma', '.timmy'));
    mkdirSync(join(p, 'alpha', '.timmy'));
    writeFileSync(join(p, 'notes.txt'), 'a file holds no .timmy');
    symlinkSync(join(p, 'alpha'), join(p, 'alpha-link'));
    const r = await siblingProjects(p);
    expect(r).toEqual({ names: ['alpha', 'alpha-link', 'gamma'], looked: 6, more: false });
    expect(siblingProjectsWords(r)).toBe('PROJECTS  alpha · alpha-link +1');
  });

  it('looks at no more entries than its limit, and says that more were left unread', async () => {
    const p = folder();
    for (let i = 0; i < 30; i += 1) { mkdirSync(join(p, `p${i}`)); mkdirSync(join(p, `p${i}`, '.timmy')); }
    const some = await siblingProjects(p, { limit: 10 });
    expect(some.looked).toBe(10);
    expect(some.more).toBe(true);
    expect(some.names).toHaveLength(10);
    expect(siblingProjectsWords(some)).toMatch(/^PROJECTS {2}p\d+ · p\d+ \+8 · the first 10 entries read$/);
    expect(await siblingProjects(p, { limit: 30 })).toMatchObject({ looked: 30, more: false });
    expect(SIBLING_LIMIT).toBe(2000);
  });

  it('a folder that cannot be read gives no names; before it is read, the line says so', async () => {
    expect(await siblingProjects(join(tmpdir(), `timmy-sib-absent-${process.pid}-${Date.now()}`))).toEqual({ names: [], looked: 0, more: false });
    expect(siblingProjectsWords({ names: [], looked: 0, more: false })).toBe('PROJECTS  —');
    expect(siblingProjectsWords(null)).toBe('PROJECTS  being read');
  });
});
