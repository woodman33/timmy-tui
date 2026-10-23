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
 *
 * The row types below mirror src/capabilities/inventory.ts (H170, r11/h170-p2 ae196542: InventoryRow, Fact, Exercised,
 * InventoryGroup, STATE_MEANS, rowWords, standingWord) structurally, so the page reads that inventory unchanged once the
 * lead merges both branches (the import replaces the mirror; `fromLadder` goes). Until then the companion's interim source is
 * the capability ladder (src/capabilities capabilities(liveDeps(…))) behind the same shape.
 */
import type { CapabilityRow, Kind } from '../../capabilities/index.js';
import { RUNGS } from '../../capabilities/ladder.js';
import { scrubHomes } from '../../utils/home-scrub.js';

// ── the shape (a mirror of src/capabilities/inventory.ts, H170) ───────────────

export type InventoryGroup = 'Models' | 'Tools' | 'Integrations' | 'Lanes' | 'Vision' | 'Receipts';
export const INVENTORY_GROUPS: readonly InventoryGroup[] = ['Models', 'Tools', 'Integrations', 'Lanes', 'Vision', 'Receipts'];

export type StateWord = 'available' | 'configured' | 'exercised';
export const STATE_MEANS: Readonly<Record<StateWord, string>> = {
  available: 'the files or binaries are here',
  configured: 'the key, setting or address is set',
  exercised: 'a receipt of a real run exists',
};

export interface FactFound { ok: boolean; found: string; source: string }
export interface Fact extends FactFound { words: string }
export type ExercisedFound =
  | { ok: true; receipt: string; hash: string; when: string; what: string; record?: string; source: string }
  | { ok: false; found: string; source: string };
export type Exercised = ExercisedFound & { words: string };

export interface InventoryRow {
  id: string;
  name: string;
  group: InventoryGroup;
  available: Fact;
  configured: Fact;
  exercised: Exercised;
  /** the one step to the next word, in the product's setup words; absent once exercised */
  next?: string;
}

/** "on 2026-10-23 at 19:39 UTC" for a receipt's time (inventory-words.ts whenWords). */
export const whenWords = (iso: string): string => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'at an unknown time';
  return `on ${d.toISOString().slice(0, 10)} at ${d.toISOString().slice(11, 16)} UTC`;
};
const sentence = (s: string): string => (/[.!?]$/.test(s) ? s : `${s}.`);

/** The three sentences of a row (inventory-words.ts rowWords). */
export function rowWords(r: { name: string; available: FactFound; configured: FactFound; exercised: ExercisedFound }): Record<StateWord, string> {
  return {
    available: sentence(r.available.ok ? `${r.name}: available, ${r.available.found}` : `${r.name}: not available, ${r.available.found}`),
    configured: sentence(r.configured.ok ? `${r.name}: configured, ${r.configured.found}` : `${r.name}: not configured, ${r.configured.found}`),
    exercised: sentence(r.exercised.ok
      ? `${r.name}: exercised ${whenWords(r.exercised.when)}, ${r.exercised.what} (receipt ${r.exercised.receipt})`
      : `${r.name}: not exercised, ${r.exercised.found}`),
  };
}

export type Standing = StateWord | 'none';
/** The one word a chip shows: exercised, else configured, else available, else none (inventory-words.ts standingWord). */
export function standingWord(r: Pick<InventoryRow, 'available' | 'configured' | 'exercised'>): Standing {
  if (r.exercised.ok) return 'exercised';
  if (r.configured.ok) return 'configured';
  if (r.available.ok) return 'available';
  return 'none';
}

// ── the page's reading of the rows ────────────────────────────────────────────

/** A next step that names a key, a token, a sign-in or an address: set in the terminal, never on this page. */
const CREDENTIAL = /\b(key|keys|token|secret|password|sign in|login|address|host|url|account)\b/i;
export const needsCredential = (next: string | undefined): boolean => Boolean(next && CREDENTIAL.test(next));

/** The inventory as src/capabilities/inventory.ts inventory(ctx) wraps its rows (the rows verbatim: what H172's check compares). */
export interface Inventory {
  schema: 'timmy.capability-inventory/1';
  readAt: string;
  means: Readonly<Record<StateWord, string>>;
  groups: readonly InventoryGroup[];
  rows: InventoryRow[];
}

/** What the page adds to a row: the chip's word and whether its next step is a credential (set in the terminal). */
export interface InventoryCard { id: string; group: InventoryGroup; standing: Standing; nextIsCredential: boolean }

export interface InventoryPage {
  inventory: Inventory;
  /** one per row, in INVENTORY_GROUPS order (the order the cards are drawn in) */
  cards: InventoryCard[];
  counts: Record<Standing, number>;
  /** one sentence: how many rows hold each word */
  words: string;
}

/** The rows as the page shows them: the inventory whole (rows verbatim), the cards in the inventory's group order, the counts, one sentence. */
export function inventoryPage(rows: readonly InventoryRow[], readAt = new Date().toISOString()): InventoryPage {
  const order = new Map(INVENTORY_GROUPS.map((g, i) => [g, i]));
  const cards: InventoryCard[] = rows.map((r) => ({ id: r.id, group: r.group, standing: standingWord(r), nextIsCredential: needsCredential(r.next) }))
    .sort((a, b) => (order.get(a.group) ?? 9) - (order.get(b.group) ?? 9));
  const counts: Record<Standing, number> = { available: 0, configured: 0, exercised: 0, none: 0 };
  for (const c of cards) counts[c.standing] += 1;
  const n = cards.length;
  const words = `${n} capabilit${n === 1 ? 'y' : 'ies'} here: ${counts.exercised} exercised, ${counts.configured} configured, ${counts.available} available, ${counts.none} with none of the three.`;
  return { inventory: { schema: 'timmy.capability-inventory/1', readAt, means: STATE_MEANS, groups: INVENTORY_GROUPS, rows: [...rows] }, cards, counts, words };
}

// ── the interim source: the capability ladder behind the same shape ───────────

const LADDER_GROUP: Readonly<Record<Kind, InventoryGroup | null>> = {
  model: 'Models', tool: 'Tools', vox: 'Tools', harness: 'Integrations', adapter: 'Integrations',
  // the ladder's surfaces (this page, the terminal) are not capabilities of the inventory
  surface: null,
};
const LADDER = 'capabilities (src/capabilities/index.ts), the ladder: files and settings read, local programs asked';

/** One ladder row in the inventory's shape; null for a kind the inventory has no row for. */
export function fromLadderRow(r: CapabilityRow): InventoryRow | null {
  const group = LADDER_GROUP[r.kind];
  if (!group) return null;
  const l = r.ladder;
  const at = RUNGS.indexOf(r.rung as (typeof RUNGS)[number]);
  const availableOk = Boolean(l?.installed) || at >= RUNGS.indexOf('installed');
  const configuredOk = Boolean(l?.reachable) || at >= RUNGS.indexOf('reachable');
  const name = r.name.trim();
  const available: FactFound = {
    ok: availableOk,
    found: scrubHomes(l?.installed?.found || (availableOk ? 'found' : r.notReached?.installed || r.detail || 'not found on this computer')),
    source: LADDER,
  };
  const configured: FactFound = {
    ok: configuredOk,
    found: scrubHomes(configuredOk
      ? (l?.reachable ? `${l.reachable.answer} (asked: ${l.reachable.asked})` : 'set')
      : r.rung === 'needs setup' ? (r.setup ? `not set: ${r.setup}` : 'not set') : (r.notReached?.reachable || (availableOk ? 'not asked, or it did not answer' : 'nothing to set until it is here'))),
    source: LADDER,
  };
  // exercised only with the ladder's own receipt (its exercised evidence, else a qualification record's): never an invented one
  const exercised: ExercisedFound = l?.exercised
    ? { ok: true, receipt: l.exercised.receipt, hash: l.exercised.hash ?? '', when: l.exercised.at, what: scrubHomes(l.exercised.what), ...(l.exercised.record ? { record: l.exercised.record } : {}), source: LADDER }
    : l?.qualified
      ? { ok: true, receipt: l.qualified.receipt, hash: l.qualified.hash ?? '', when: l.qualified.at ?? r.exercised ?? '', what: scrubHomes(l.qualified.what), record: l.qualified.record, source: LADDER }
      : { ok: false, found: scrubHomes(r.notReached?.exercised || 'no receipt of a real run on the runs chain'), source: LADDER };
  const words = rowWords({ name, available, configured, exercised });
  const nextRung = exercised.ok ? null : configuredOk ? 'exercised' : availableOk ? 'reachable' : 'installed';
  const next = exercised.ok ? undefined
    : r.rung === 'needs setup' && r.setup ? r.setup
    : nextRung && r.notReached?.[nextRung] ? r.notReached[nextRung]
    : r.setup;
  return {
    id: r.id, name, group,
    available: { ...available, words: words.available },
    configured: { ...configured, words: words.configured },
    exercised: { ...exercised, words: words.exercised },
    ...(next ? { next: scrubHomes(next) } : {}),
  };
}

/** The ladder's rows in the inventory's shape (the interim source; H170's inventory() replaces it on the merge). */
export function fromLadder(rows: readonly CapabilityRow[]): InventoryRow[] {
  return rows.map(fromLadderRow).filter((r): r is InventoryRow => r !== null);
}
