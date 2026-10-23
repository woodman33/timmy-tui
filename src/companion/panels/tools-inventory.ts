/**
 * R11 Phase 2 (H171): the page's Tools & integrations inventory: one card per capability row, the same rows the terminal's
 * Chat rail reads (H170's capability inventory, src/capabilities/inventory.ts: `inventory(ctx).rows`), said in the three
 * words every surface keeps apart (R11-P2-COMMON), never a fourth:
 *
 *   available    the files or binaries are here
 *   configured   the key, setting or address is set (whether a key is present and where; never its value)
 *   exercised    a receipt of a real run exists
 *
 * A card shows the row's own sentences (row.available.words, row.configured.words, row.exercised.words, one words file for
 * both surfaces) and row.next, the one next step. The chip shows the standing word (exercised > configured > available); a row
 * none holds for has no chip, as the terminal draws none: its found words say it. A next step that names a key, a token or an
 * address is set in Models & accounts, the environment or the .env file (the terminal's words): the card says so and sets nothing.
 */
import { INVENTORY_GROUPS, STATE_MEANS, type Inventory, type InventoryGroup, type InventoryRow, type StateWord } from '../../capabilities/inventory.js';
import { standingWord } from '../../capabilities/inventory-words.js';

export { INVENTORY_GROUPS, STATE_MEANS, standingWord };
export type { Inventory, InventoryGroup, InventoryRow, StateWord };

export type Standing = ReturnType<typeof standingWord>;

/** A next step that names a key, a token, a sign-in or an address: set in the terminal's places, never on this page. */
const CREDENTIAL = /\b(key|keys|token|secret|password|sign in|login|address|host|url|account)\b/i;
export const needsCredential = (next: string | undefined): boolean => Boolean(next && CREDENTIAL.test(next));

/** What the page adds to a row: the chip's word and whether its next step is a credential (set in the terminal). */
export interface InventoryCard { id: string; group: InventoryGroup; standing: Standing; nextIsCredential: boolean }

export interface InventoryPage {
  /** the inventory as inventory(ctx) wraps its rows: the rows verbatim (what the terminal reads; what H172's check compares) */
  inventory: Inventory;
  /** one per row, in INVENTORY_GROUPS order (the order the cards are drawn in) */
  cards: InventoryCard[];
  counts: Record<Standing, number>;
  /** one sentence: how many rows hold each word */
  words: string;
}

/** The inventory as the page shows it: itself, whole (the rows verbatim), the cards in its group order, the counts, one sentence. */
export function inventoryPage(inventory: Inventory): InventoryPage {
  const order = new Map(inventory.groups.map((g, i) => [g, i]));
  const cards: InventoryCard[] = inventory.rows.map((r) => ({ id: r.id, group: r.group, standing: standingWord(r), nextIsCredential: needsCredential(r.next) }))
    .sort((a, b) => (order.get(a.group) ?? 9) - (order.get(b.group) ?? 9));
  const counts: Record<Standing, number> = { available: 0, configured: 0, exercised: 0, none: 0 };
  for (const c of cards) counts[c.standing] += 1;
  const n = cards.length;
  const words = `${n} capabilit${n === 1 ? 'y' : 'ies'} here: ${counts.exercised} exercised, ${counts.configured} configured, ${counts.available} available, ${counts.none} with none of the three.`;
  return { inventory, cards, counts, words };
}

/** An inventory of given rows (a test's FAKE rows), as inventory(ctx) would wrap them. */
export const inventoryOfRows = (rows: readonly InventoryRow[], readAt = new Date().toISOString()): Inventory =>
  ({ schema: 'timmy.capability-inventory/1', readAt, means: STATE_MEANS, groups: INVENTORY_GROUPS, rows: [...rows] });
