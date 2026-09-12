import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadRoster, missingGates, scorecardRows } from '../src/utils/roster';
import type { Roster } from '../src/utils/roster';

const ROSTER = {
  schema: 'roster/1',
  version: 1,
  gates: [
    { id: 'runtime', spec: '<=61.0' },
    { id: 'coverage', spec: 'tiles 0..total_s' },
  ],
} as Roster;

describe('roster (DOCTRINE §11)', () => {
  it('loads <root>/gates/roster.json and null when absent', () => {
    const root = mkdtempSync(join(tmpdir(), 'roster-'));
    mkdirSync(join(root, 'gates'));
    writeFileSync(join(root, 'gates', 'roster.json'), JSON.stringify(ROSTER));
    expect(loadRoster(root)?.gates).toHaveLength(2);
    expect(loadRoster(mkdtempSync(join(tmpdir(), 'roster-empty-')))).toBeNull();
  });

  it('reads rows from array and map scorecards', () => {
    expect(scorecardRows({ gates: [{ gate: 'runtime' }, { gate: 'coverage' }] }))
      .toEqual(['runtime', 'coverage']);
    expect(scorecardRows({ gates: { runtime: {}, coverage: {} } }))
      .toEqual(['runtime', 'coverage']);
    expect(scorecardRows(null)).toEqual([]);
  });

  it('absent rows are missing; pass-or-fail rows are complete', () => {
    expect(missingGates(ROSTER, ['runtime'])).toEqual(['coverage']);
    expect(missingGates(ROSTER, ['runtime', 'coverage'])).toEqual([]);
  });
});
