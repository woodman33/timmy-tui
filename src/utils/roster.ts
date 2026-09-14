// DOCTRINE §11 — the roster. A gate that can be forgotten is not a gate.
// render.cut seals only against a scorecard carrying a row for every
// roster gate (pass or fail, never absent); the roster itself changes
// only through a roster.amend seal with a reason.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface RosterGate { id: string; spec: string; tool?: string; basis?: string }
export interface Roster { schema: string; version: number; gates: RosterGate[] }

export const loadRoster = (root: string): Roster | null => {
  const p = join(root, 'gates', 'roster.json');
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, 'utf8')) as Roster;
};

export const scorecardRows = (sc: unknown): string[] => {
  if (!sc || typeof sc !== 'object') return [];
  const o = sc as Record<string, unknown>;
  const g = o.gates ?? o.rows;
  if (Array.isArray(g)) {
    return g.map((r) => String((r as Record<string, unknown>)?.gate ?? (r as Record<string, unknown>)?.id ?? ''));
  }
  if (g && typeof g === 'object') return Object.keys(g as object);
  return Object.keys(o).filter((k) => !['version', 'cut', 'schema'].includes(k));
};

export const missingGates = (roster: Roster, rows: string[]): string[] =>
  roster.gates.map((g) => g.id).filter((id) => !rows.includes(id));
