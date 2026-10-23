/**
 * R11 Phase 2 (H171): the Tools & integrations inventory as the page reads it (src/companion/panels/tools-inventory.ts): rows in
 * the capability inventory's shape (H170's InventoryRow: three facts, each its own, with the sentence a surface shows; the one
 * next step), grouped in the inventory's order, counted by the standing word, never a fourth; the interim source, the ladder,
 * put behind the same shape. FAKE rows, named FAKE; nothing is asked of any program.
 */
import { homedir } from 'node:os';
import { describe, expect, it } from 'vitest';
import type { CapabilityRow } from '../src/capabilities/index.js';
import { fromLadder, fromLadderRow, inventoryPage, needsCredential, standingWord, INVENTORY_GROUPS, STATE_MEANS } from '../src/companion/panels/tools-inventory.js';
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
    const page = inventoryPage(FAKE_ROWS, '2026-10-23T20:05:00.000Z');
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

  describe('the interim source: the capability ladder behind the same shape', () => {
    const base = (o: Partial<CapabilityRow> & Pick<CapabilityRow, 'id' | 'kind' | 'name' | 'rung' | 'detail'>): CapabilityRow => ({
      ladder: { proposed: { plan: 'FAKE plan', section: 'FAKE', says: 'FAKE' }, installed: null, reachable: null, exercised: null, qualified: null },
      ...o,
    });
    const LADDER: CapabilityRow[] = [
      base({ id: 'fake-surface', kind: 'surface', name: 'FAKE browser companion', rung: 'reachable', detail: 'FAKE: this page' }),
      base({ id: 'fake-proposed', kind: 'adapter', name: 'FAKE Cinema 4D adapter', rung: 'proposed', detail: 'FAKE: the plan names it; no program found', notReached: { installed: 'c4dpy was not found on the PATH' } }),
      base({ id: 'fake-needs-key', kind: 'model', name: 'FAKE hosted models (OpenRouter)', rung: 'needs setup', detail: 'FAKE: no key saved',
        setup: 'timmy init --openrouter - saves the key, hidden, in the Timmy home (never in the repo)',
        ladder: { proposed: null, installed: { found: 'the OpenRouter client, built into Timmy', how: 'built into Timmy' }, reachable: null, exercised: null, qualified: null } }),
      base({ id: 'fake-reachable', kind: 'model', name: 'FAKE local models (Ollama)', rung: 'reachable', detail: 'FAKE: Ollama answered its list; 2 models', tools: ['ollama_chat'],
        // (a path under this process's own home: the row writes it from ~)
        ladder: { proposed: null, installed: { found: `ollama 0.6 at ${homedir()}/.local/bin/ollama`, where: `${homedir()}/.local/bin/ollama`, how: 'the PATH' }, reachable: { asked: 'GET /api/tags at 127.0.0.1:11434', at: '2026-10-23T20:00:00.000Z', answer: '2 models listed' }, exercised: null, qualified: null },
        notReached: { exercised: 'no sealed turn used a local model here yet: send a message with it chosen' } }),
      base({ id: 'fake-exercised', kind: 'vox', name: 'FAKE VoxVision measure', rung: 'exercised', detail: 'FAKE: measured an image here', exercised: '2026-10-23T19:30:00.000Z',
        ladder: { proposed: null, installed: { found: 'the vision bridge in this build', how: 'built into Timmy' }, reachable: { asked: 'the bridge, python3', at: '2026-10-23T19:29:00.000Z', answer: 'answered' }, exercised: { at: '2026-10-23T19:30:00.000Z', what: 'vox measure on shot.png, judged ok', receipt: 'a1b2c3d4', hash: 'sha256_a1b2c3d4', chain: 'verifyReceiptIn' }, qualified: null } }),
    ];

    it('a surface is no capability row; the kinds map to the inventory\'s groups', () => {
      expect(fromLadderRow(LADDER[0])).toBeNull();
      expect(fromLadder(LADDER).map((r) => [r.id, r.group])).toEqual([['fake-proposed', 'Integrations'], ['fake-needs-key', 'Models'], ['fake-reachable', 'Models'], ['fake-exercised', 'Tools']]);
    });

    it('proposed and not found: no word holds; the next step is what would install it', () => {
      const r = fromLadderRow(LADDER[1])!;
      expect(standingWord(r)).toBe('none');
      expect(r.available).toMatchObject({ ok: false, found: 'c4dpy was not found on the PATH' });
      expect(r.available.words).toBe('FAKE Cinema 4D adapter: not available, c4dpy was not found on the PATH.');
      expect(r.configured).toMatchObject({ ok: false, found: 'nothing to set until it is here' });
      expect(r.next).toBe('c4dpy was not found on the PATH');
    });

    it('needs a key: available (the code is here), not configured, the setup step next; the key is set in the terminal', () => {
      const r = fromLadderRow(LADDER[2])!;
      expect(standingWord(r)).toBe('available');
      expect(r.configured.words).toBe('FAKE hosted models (OpenRouter): not configured, not set: timmy init --openrouter - saves the key, hidden, in the Timmy home (never in the repo).');
      expect(r.next).toBe('timmy init --openrouter - saves the key, hidden, in the Timmy home (never in the repo)');
      expect(needsCredential(r.next)).toBe(true);
    });

    it('a probe answered: configured, with what was asked; a home path reads as ~; the next step is a real run', () => {
      const r = fromLadderRow(LADDER[3])!;
      expect(standingWord(r)).toBe('configured');
      expect(r.available.words).toBe('FAKE local models (Ollama): available, ollama 0.6 at ~/.local/bin/ollama.');
      expect(r.configured.words).toBe('FAKE local models (Ollama): configured, 2 models listed (asked: GET /api/tags at 127.0.0.1:11434).');
      expect(r.next).toBe('no sealed turn used a local model here yet: send a message with it chosen');
      expect(JSON.stringify(r)).not.toContain(homedir());
    });

    it('a run sealed: exercised with its receipt and time; nothing next', () => {
      const r = fromLadderRow(LADDER[4])!;
      expect(standingWord(r)).toBe('exercised');
      expect(r.exercised).toMatchObject({ ok: true, receipt: 'a1b2c3d4', hash: 'sha256_a1b2c3d4', when: '2026-10-23T19:30:00.000Z' });
      expect(r.exercised.words).toBe('FAKE VoxVision measure: exercised on 2026-10-23 at 19:30 UTC, vox measure on shot.png, judged ok (receipt a1b2c3d4).');
      expect(r.next).toBeUndefined();
    });
  });
});
