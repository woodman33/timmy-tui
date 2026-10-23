/**
 * R11 Phase 2 (H170): the one words file of the capability inventory (./inventory.ts), for the terminal's Chat rail (H167)
 * and the browser companion (H171): one sentence per state word per row, built from the row's own facts, so both surfaces
 * say the same thing. Three words, kept apart: available (the files or binaries are here), configured (the key, setting
 * or address is set), exercised (a receipt of a real run exists). A sentence never carries a key's value: the facts it is
 * built from never do (a key is "present" and "from <where>", or "not set").
 */
import type { ExercisedFound, FactFound, InventoryGroup } from './inventory.js';

/** What the inventory needs of a row to word it (its facts, before their sentences). */
export interface Wordable {
  id: string;
  name: string;
  group: InventoryGroup;
  available: FactFound;
  configured: FactFound;
  exercised: ExercisedFound;
}

export interface RowWords { available: string; configured: string; exercised: string }

/** "on 2026-10-23 at 19:39" for a receipt's time, in UTC as the chain records it. */
export const whenWords = (iso: string): string => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'at an unknown time';
  return `on ${d.toISOString().slice(0, 10)} at ${d.toISOString().slice(11, 16)} UTC`;
};

const sentence = (s: string): string => (/[.!?]$/.test(s) ? s : `${s}.`);

/** The three sentences of a row. */
export function rowWords(r: Wordable): RowWords {
  return {
    available: sentence(r.available.ok ? `${r.name}: available, ${r.available.found}` : `${r.name}: not available, ${r.available.found}`),
    configured: sentence(r.configured.ok ? `${r.name}: configured, ${r.configured.found}` : `${r.name}: not configured, ${r.configured.found}`),
    exercised: sentence(r.exercised.ok
      ? `${r.name}: exercised ${whenWords(r.exercised.when)}, ${r.exercised.what} (receipt ${r.exercised.receipt})`
      : `${r.name}: not exercised, ${r.exercised.found}`),
  };
}

/**
 * The one word a glyph or a column shows for a row: exercised when a receipt exists, else configured when its setting is
 * set, else available when its files are here, else none. The three facts stay on the row, each its own; this picks only
 * which to show first.
 */
export function standingWord(r: Pick<Wordable, 'available' | 'configured' | 'exercised'>): 'exercised' | 'configured' | 'available' | 'none' {
  if (r.exercised.ok) return 'exercised';
  if (r.configured.ok) return 'configured';
  if (r.available.ok) return 'available';
  return 'none';
}
