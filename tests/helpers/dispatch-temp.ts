// R9 (H161; R8's open item K): a temporary folder of the test file's own for the copies its dispatches make, and a check,
// after the file's tests, that they left no `timmy-dp-*` folder in it.
//
// src/utils/dispatch.ts makes each dispatch's host-ephemeral copy with mkdtemp in the temporary folder (`timmy-dp-<plan id>-…`;
// os.tmpdir(), so $TMPDIR). Up to R8 nothing removed one: 9 more after each run of the dispatch tests (6 from
// tests/fleet-dispatch.test.ts, 2 from tests/context-cone-dispatch.test.ts, 1 from tests/dispatch.test.ts), and the files that
// ran beside them shared the folder, so a count there could not say which file made what. This helper points TMPDIR at a
// folder made for the file (inside the temporary folder the run was given) for the file's whole run, counts the copies there
// before its tests and after them, and removes that folder afterwards. A copy the product rightly keeps (outputs it could not
// keep) is the test's to remove, by the path its record names, before the file ends.
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect } from 'vitest';

/** Call once at a test file's top level, before the file's own beforeAll (so the folders it makes land in this one too). */
export function dispatchTempOfItsOwn(): { folder: () => string; copies: () => string[] } {
  let folder = '';
  let given: string | undefined;
  let before: string[] = [];
  const copies = (): string[] => (folder ? readdirSync(folder).filter((n) => n.startsWith('timmy-dp-')).sort() : []);
  beforeAll(() => {
    given = process.env.TMPDIR;
    folder = mkdtempSync(join(tmpdir(), 'timmy-test-dpt-'));
    process.env.TMPDIR = folder;
    before = copies();
  });
  afterAll(() => {
    const left = copies().filter((n) => !before.includes(n));
    if (given === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = given;
    rmSync(folder, { recursive: true, force: true });
    expect(left, `timmy-dp-* copies this file's dispatches left in its own temporary folder (${before.length} were there before its tests)`).toEqual([]);
  });
  return { folder: () => folder, copies };
}
