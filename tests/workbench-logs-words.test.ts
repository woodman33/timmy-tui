// R7 (H150; H148's N5, REMAINING-DEFECTS rows 8 and 15): tab 0 says a stopped chat turn and a cancelled job in the one table's
// words (src/contracts/stop-words.ts): a chat turn "stopped", with who asked, never "cancelled" (H148 saw "repl · cancelled");
// a job "cancelled", never "stopped". Receipts keep the words they were sealed with; only what is shown changes.
//
// Over a real project in a temporary folder: the turns' receipts sealed by the REPL's own sealTurn (FIXTURE facts: no model
// answered them) and a job's receipt by appendReceipt, into the project's own store (hash-chained and signed).
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { projectStore } from '../src/agent/chat-session.js';
import { projectId } from '../src/project/index.js';
import { sealTurn } from '../src/repl/seal.js';
import { appendReceipt, readChain, type ReceiptInput } from '../src/utils/receipts.js';
import { readLogs } from '../src/workbench/logs-tab.js';

const boxes: string[] = [];
afterAll(() => { for (const b of boxes) rmSync(b, { recursive: true, force: true }); });

describe('tab 0\'s stop words (R7 H150; H148\'s N5)', () => {
  it('a stopped chat turn reads "stopped" with who asked, never "cancelled"; a cancelled job reads "cancelled", never "stopped"; the sealed words are kept', () => {
    const box = realpathSync(mkdtempSync(join(tmpdir(), 'wb-logs-words-')));
    boxes.push(box);
    const root = join(box, 'tray');
    const home = join(box, 'home');
    mkdirSync(join(root, '.timmy'), { recursive: true });
    mkdirSync(join(home, 'jobs'), { recursive: true });
    writeFileSync(join(root, '.timmy', 'store-pin'), join(root, '.timmy', 'receipts'));
    const pid = projectId(root);
    const env: Record<string, string | undefined> = { ...process.env };
    delete env.TIMMY_STORE;
    const turn = { prompt: 'FIXTURE prompt', answer: '', steps: 0, spend: 0, costMeasured: false, ms: 500, status: 'cancelled' as const, model: 'fixture/chat-model', project: 'tray', projectId: pid };
    // the REPL's own turn, stopped there (Ctrl+C), and the REPL's turn stopped from the Workbench (x, then y)
    const own = sealTurn({ ...turn, surface: 'repl' }, projectStore(root));
    const asked = sealTurn({ ...turn, surface: 'repl', stoppedBy: 'workbench' }, projectStore(root));
    const wb = sealTurn({ ...turn, surface: 'workbench' }, projectStore(root));
    // a workflow job a cancel ended
    const job = appendReceipt('runs', { kind: 'workflow', subject: 'build.md › build: cancelled, 1 of 2 blocks', policy: 'auto', status: 'cancelled', project: 'tray', project_id: pid, job: { id: 'jfixture1', kind: 'workflow', label: 'build.md › build', state: 'cancelled', exit_code: 130 } } as ReceiptInput, root);
    // (the receipts keep what they were sealed with)
    const chain = readChain('runs', root);
    expect(chain.find((r) => r.hash === own.hash)?.subject).toBe('repl · cancelled · 0 steps');

    const d = readLogs({ home, root, env });
    const ev = (hash: string) => d.events.find((e) => e.hash === hash)!;
    expect(ev(own.hash)).toMatchObject({ summary: 'repl · stopped (asked from the REPL) · 0 steps', status: { word: 'stopped' } });
    expect(ev(asked.hash)).toMatchObject({ summary: 'repl · stopped (asked from the Workbench) · 0 steps', status: { word: 'stopped' } });
    expect(ev(wb.hash).summary).toMatch(/^chat\.turn · workbench · stopped \(asked from the Workbench\) · 0 steps/);
    expect(ev(wb.hash).status.word).toBe('stopped');
    for (const h of [own.hash, asked.hash, wb.hash]) expect(ev(h).summary, 'a turn is never "cancelled"').not.toMatch(/cancelled/);
    expect(ev(job.hash)).toMatchObject({ summary: 'build.md › build: cancelled, 1 of 2 blocks', status: { word: 'cancelled' } });
    expect(ev(job.hash).summary, 'a job is never "stopped"').not.toMatch(/stopped/);
  });
});
