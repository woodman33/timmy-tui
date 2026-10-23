/**
 * R11 Phase 2 (H171): the Tools & integrations inventory as the page reads it (src/companion/panels/tools-inventory.ts): the
 * capability inventory's rows (src/capabilities/inventory.ts InventoryRow: three facts, each its own, with the sentence a
 * surface shows; the one next step), grouped in the inventory's order, counted by the standing word, never a fourth. FAKE
 * rows, named FAKE; nothing is asked of any program.
 */
import { describe, expect, it } from 'vitest';
import { inventoryOfRows, inventoryPage, needsCredential, standingWord, INVENTORY_GROUPS, STATE_MEANS } from '../src/companion/panels/tools-inventory.js';
import { FAKE_ROWS } from './fixtures/fake-inventory-rows.js';

describe('the Tools & integrations inventory as the page reads it: the three words apart, never a fourth (R11 Phase 2, H171)', () => {
  it('the words of a row are its own sentences, one per fact, as the one words file makes them', () => {
    expect(FAKE_ROWS[1].available.words).toBe('FAKE hosted models (OpenRouter): available, the OpenRouter client is built into Timmy.');
    expect(FAKE_ROWS[1].configured.words).toBe('FAKE hosted models (OpenRouter): not configured, no key set (keys are looked for in the Timmy home, never in the repo).');
    expect(FAKE_ROWS[1].exercised.words).toBe('FAKE hosted models (OpenRouter): not exercised, no sealed chat turn through OpenRouter on the runs chain.');
    expect(FAKE_ROWS[4].exercised.words).toBe('FAKE VoxVision measure: exercised on 2026-10-23 at 19:30 UTC, vox measure on shot.png, judged ok (receipt a1b2c3d4).');
    expect(FAKE_ROWS[0].available.words).toBe('FAKE vision bridge: not available, the bridge files are not in this build.');
  });

  it('the standing word is the highest that holds; none when none does', () => {
    expect(FAKE_ROWS.map(standingWord)).toEqual(['none', 'available', 'available', 'configured', 'exercised', 'configured']);
  });

  it('a next step that names a key, a sign-in or an address is set in the terminal; a plain step is not', () => {
    expect(needsCredential(FAKE_ROWS[1].next)).toBe(true);
    expect(needsCredential('set the address of the Ollama host')).toBe(true);
    expect(needsCredential(FAKE_ROWS[3].next)).toBe(false);
    expect(needsCredential(undefined)).toBe(false);
  });

  it('the page: the rows in the inventory\'s group order, the counts by standing word, one sentence; the three meanings', () => {
    const page = inventoryPage(inventoryOfRows(FAKE_ROWS, '2026-10-23T20:05:00.000Z'));
    // the inventory whole, the rows verbatim (what the terminal reads for the same state; what H172's check compares)
    expect(page.inventory).toEqual({ schema: 'timmy.capability-inventory/1', readAt: '2026-10-23T20:05:00.000Z', means: STATE_MEANS, groups: INVENTORY_GROUPS, rows: FAKE_ROWS });
    expect(INVENTORY_GROUPS).toEqual(['Models', 'Tools', 'Integrations', 'Lanes', 'Vision', 'Receipts']);
    expect(Object.keys(STATE_MEANS)).toEqual(['available', 'configured', 'exercised']);
    // the cards in the inventory's group order, each with its standing word and whether its step is a credential
    expect(page.cards.map((c) => c.id)).toEqual(['fake:model:openrouter', 'fake:model:ollama-local', 'fake:tool:docker', 'fake:vox:measure', 'fake:vision:bridge', 'fake:receipts:chain']);
    expect(page.cards.map((c) => [c.group, c.standing, c.nextIsCredential])).toEqual([['Models', 'available', true], ['Models', 'configured', false], ['Tools', 'available', false], ['Tools', 'exercised', false], ['Vision', 'none', false], ['Receipts', 'configured', false]]);
    expect(page.counts).toEqual({ available: 2, configured: 2, exercised: 1, none: 1 });
    expect(page.words).toBe('6 capabilities here: 1 exercised, 2 configured, 2 available, 1 with none of the three.');
    // the exercised row has nothing next; every other row has one step
    expect(FAKE_ROWS.find((r) => r.id === 'fake:vox:measure')?.next).toBeUndefined();
    for (const r of FAKE_ROWS.filter((r) => standingWord(r) !== 'exercised')) expect(r.next).toBeTruthy();
    // no row carries a key's value anywhere in its words
    expect(JSON.stringify(page)).not.toMatch(/sk-or-|Bearer /);
  });
});
