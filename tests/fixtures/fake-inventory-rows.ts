/**
 * R11 Phase 2 (H171): six FAKE rows in the capability inventory's shape (src/capabilities/inventory.ts InventoryRow: three facts, each its
 * own, with the sentence a surface shows, from rowWords; the one next step), one of each standing word and more, named FAKE on every
 * row. Given to the companion through CompanionOptions.inventory by the inventory tests and the capture script: nothing on
 * the machine decides the words.
 */
import type { InventoryRow } from '../../src/capabilities/inventory.js';
import { rowWords } from '../../src/capabilities/inventory-words.js';

const SRC = 'a FAKE source (tests/fixtures/fake-inventory-rows.ts)';
const row = (o: Omit<InventoryRow, 'available' | 'configured' | 'exercised'> & {
  available: { ok: boolean; found: string }; configured: { ok: boolean; found: string };
  exercised: { ok: true; receipt: string; hash: string; when: string; what: string } | { ok: false; found: string };
}): InventoryRow => {
  const available = { ...o.available, source: SRC };
  const configured = { ...o.configured, source: SRC };
  const exercised = { ...o.exercised, source: SRC };
  const w = rowWords({ name: o.name, available, configured, exercised });
  return { ...o, available: { ...available, words: w.available }, configured: { ...configured, words: w.configured }, exercised: { ...exercised, words: w.exercised } };
};

/** Six FAKE rows in the inventory's shape (the words from rowWords, as inventory() gives them), one of each state and more. */
export const FAKE_ROWS: InventoryRow[] = [
  row({ id: 'fake:vision:bridge', name: 'FAKE vision bridge', group: 'Vision',
    available: { ok: false, found: 'the bridge files are not in this build' }, configured: { ok: false, found: 'nothing to set until it is here' },
    exercised: { ok: false, found: 'no receipt of a real run on the runs chain' }, next: 'reinstall Timmy, or run it from a checkout of its repository' }),
  row({ id: 'fake:model:openrouter', name: 'FAKE hosted models (OpenRouter)', group: 'Models',
    available: { ok: true, found: 'the OpenRouter client is built into Timmy' }, configured: { ok: false, found: 'no key set (keys are looked for in the Timmy home, never in the repo)' },
    exercised: { ok: false, found: 'no sealed chat turn through OpenRouter on the runs chain' }, next: 'Sign in with OpenRouter, or paste a key from openrouter.ai/keys' }),
  row({ id: 'fake:tool:docker', name: 'FAKE Docker engine', group: 'Tools',
    available: { ok: true, found: 'docker 27.1 at ~/.local/bin/docker' }, configured: { ok: false, found: 'the daemon is not set to start' },
    exercised: { ok: false, found: 'no receipt of a real run on the runs chain' }, next: 'start Docker, then run a job' }),
  row({ id: 'fake:model:ollama-local', name: 'FAKE local models (Ollama)', group: 'Models',
    available: { ok: true, found: 'ollama 0.6 at ~/.local/bin/ollama' }, configured: { ok: true, found: 'the chosen model is FAKE-model:latest; the address is 127.0.0.1:11434' },
    exercised: { ok: false, found: 'no sealed chat turn through Ollama on the runs chain' }, next: 'Send a message in the chat (each answered turn seals a receipt)' }),
  row({ id: 'fake:vox:measure', name: 'FAKE VoxVision measure', group: 'Tools',
    available: { ok: true, found: 'the vision tools are built into Timmy' }, configured: { ok: true, found: 'a Python with OpenCV is set' },
    exercised: { ok: true, receipt: 'a1b2c3d4', hash: 'sha256_a1b2c3d4e5f6', when: '2026-10-23T19:30:00.000Z', what: 'vox measure on shot.png, judged ok' } }),
  row({ id: 'fake:receipts:chain', name: 'FAKE receipts (timmy receipts)', group: 'Receipts',
    available: { ok: true, found: 'the store .timmy/receipts is here' }, configured: { ok: true, found: 'the pin is set' },
    exercised: { ok: false, found: 'the chain holds no sealed run yet' }, next: 'any sealed run (a chat turn, /observe, /mcp call) appends a signed receipt' }),
];
