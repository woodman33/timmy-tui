import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

// R10 (H167; the lead's F3 finding in the companion check of 11c027d): the run view's words for its face (src/companion/client/
// panel-run.js rvFace), run as the page runs them. The face names no id the run gives the page, whatever its digits: a receipt's
// id of eight digits (about 2% of them) is no hex word to the pattern, which asks for a letter so that a count is never taken
// for an id. The page knows the run's ids (its operation's, each receipt's and what each links to) and drops each of them; the
// whole words stay in the Details beside the face (rvSaid, rvMoreRows), as before.
const code = readFileSync(new URL('../src/companion/client/panel-run.js', import.meta.url), 'utf8');

interface RunPage { rvFace: (words: string) => string; rvKnowIds: (detail: unknown, inspection: unknown) => void }
function runPage(): RunPage {
  const on = (): void => undefined;
  // the page's script, with what it reaches for at load: listeners on the document and the window (nothing else runs then)
  const context: Record<string, unknown> = { document: { addEventListener: on }, window: { addEventListener: on }, requestAnimationFrame: on };
  runInNewContext(code, context);
  return context as unknown as RunPage;
}

/** The chain's words as src/ops/run-detail.ts writes them for a chain that verifies (receiptsInspected). */
const chainWords = (id: string): string => `the chain verifies from the start of epoch 1 up to receipt ${id}: 5 receipts, every link and body hash, and ${id}'s signature (verifyReceiptIn, now)`;
/** A run as the page holds it: its run detail and its inspection, each receipt by its id. */
const run = (id: string, prev: string) => [
  { operation: 'o1a2b3c4d', receipts: [{ id: prev, kind: 'predict' }, { id, kind: 'workflow' }], prediction: { receipt: prev } },
  { receipts: { list: [{ id: prev, prev: 'genesis' }, { id, prev }] } },
] as const;

describe("the run view's face names none of the run's ids, whatever their digits (R10 H167)", () => {
  it("drops a receipt's id of eight digits as it drops one with a letter: the same words either way", () => {
    const page = runPage();
    page.rvKnowIds(...run('51405796', '00a1b2c3'));
    const digits = page.rvFace(chainWords('51405796'));
    expect(digits).not.toContain('51405796');
    expect(digits).toBe('the chain verifies from the start of epoch 1 up to its receipt');
    page.rvKnowIds(...run('5140579a', '00a1b2c3'));
    expect(page.rvFace(chainWords('5140579a'))).toBe(digits);
  });

  it('drops every id the run gives the page wherever the words name it, and leaves a count alone', () => {
    const page = runPage();
    page.rvKnowIds(...run('51405796', '12345678'));
    expect(page.rvFace("51405796's signature verifies, and receipt 12345678 links to it")).toBe('its signature verifies, and its receipt links to it');
    expect(page.rvFace('sealed by 12345678 at the end of 2 steps')).toBe('sealed at the end of 2 steps');
    expect(page.rvFace('5 receipts, 12345679 bytes')).toBe('5 receipts, 12345679 bytes');
  });
});
