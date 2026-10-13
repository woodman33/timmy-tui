/**
 * Round R4 (helper H82; H73's open item, from the review of 6fb765a..4338fdb): a chat turn that failed before any cost came
 * back was sealed with cost_measured true and cost_usd 0, a measured $0. The rule: a request that went out and returned no
 * cost is unknown, never 0. Here a turn runs through runTurn and is sealed by sealTurn on a real receipts chain in a
 * temporary project; the Control Room (receiptCosts, gatherRoom) and God's Eye View (buildOverview over that store) read
 * the receipt back.
 *
 * FAKE: the chat agent (a TEST DOUBLE emitting the events Timmy's agent emits: stream:start when its request goes out,
 * cost:update with what came back, error and a thrown error when it fails); no model is asked. The receipts, their chain
 * and every reader are real.
 */
import { EventEmitter } from 'node:events';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildOverview } from '../src/overview/index.js';
import { projectId } from '../src/project/index.js';
import { sealTurn } from '../src/repl/seal.js';
import { runTurn } from '../src/repl/turn.js';
import { gatherRoom, receiptCosts } from '../src/room/index.js';
import { readChain } from '../src/utils/receipts.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** FAKE chat agent: `script` emits its events; it fails (as Timmy's agent does: an error event, then a throw) when `fail`. */
class FakeAgent extends EventEmitter {
  constructor(private readonly script: (a: FakeAgent) => void, private readonly fail: boolean) { super(); }
  async send(): Promise<string> {
    this.emit('thinking:start');
    this.script(this);
    if (this.fail) { const e = new Error('OpenRouter request failed for fake/model.\nReason: 502 Bad Gateway (FAKE).'); this.emit('error', e); throw e; }
    return 'ok';
  }
}
const sink = { handle: () => {}, endTurn: () => {} };

/** One turn, sealed on the project's own chain; its receipt. */
async function turn(root: string, agent: FakeAgent): Promise<{ result: string; receipt: Record<string, unknown> }> {
  const result = await runTurn(agent, sink as never, 'hello', Date.now, undefined, undefined, (facts) => sealTurn({ ...facts, model: 'fake/model (FAKE)', project: 'p', projectId: projectId(root) }, root));
  const receipt = readChain('runs', root).at(-1) as unknown as Record<string, unknown>;
  return { result, receipt };
}

describe('a failed chat turn\'s cost, sealed and read back (real chain, FAKE agent)', () => {
  it('failed after its request went out and before any cost came back: sealed unknown, never 0; the Control Room and God\'s Eye View count it unknown', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'h82-turn-')));
    dirs.push(root);
    const t = await turn(root, new FakeAgent((a) => { a.emit('stream:start'); }, true));
    expect(t.result).toBe('failed');
    expect(t.receipt).toMatchObject({ kind: 'turn', status: 'failed', cost_measured: false });
    const chain = readChain('runs', root);
    const costs = [...receiptCosts(chain, projectId(root)).values()];
    expect(costs).toHaveLength(1);
    expect(costs[0].cost).toEqual({ kind: 'unknown', words: 'unknown: its receipt marks the cost incomplete (a cancel, a failed turn no cost came back for, or a response that reported no charge)' });
    const room = gatherRoom({ root, project: 'p', projectId: projectId(root), jobs: [], chain, mine: () => false, activeFlows: [], scrub: (x) => x });
    expect(room.view.costs).toMatchObject({ known: 0, unknown: 1, free: 0 });
    const chat = room.all.find((r) => r.kind === 'chat');
    expect(chat?.cost.kind).toBe('unknown');
    const o = buildOverview(root, { store: join(root, '.timmy', 'receipts') });
    expect(o.history.costs).toMatchObject({ unknown: { runs: 1 } });
    expect(o.history.costs.reported).toBeUndefined();
    expect(o.agents.items.find((i) => i.kind === 'chat')?.cost).toMatchObject({ kind: 'unknown', usd: null });
  });

  it('a turn that reported its cost and then failed keeps it: a measured amount', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'h82-turn-')));
    dirs.push(root);
    const t = await turn(root, new FakeAgent((a) => { a.emit('stream:start'); a.emit('cost:update', 0.0021, 0.0021, { complete: true }); }, true));
    expect(t.receipt).toMatchObject({ kind: 'turn', status: 'failed', cost_usd: 0.0021, cost_measured: true });
    const costs = [...receiptCosts(readChain('runs', root), projectId(root)).values()];
    expect(costs[0].cost).toMatchObject({ kind: 'known', usd: 0.0021 });
  });

  it('a turn that answered and reported its cost keeps it (unchanged)', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'h82-turn-')));
    dirs.push(root);
    const t = await turn(root, new FakeAgent((a) => { a.emit('stream:start'); a.emit('cost:update', 0.004, 0.004, { complete: true }); }, false));
    expect(t.result).toBe('ok');
    expect(t.receipt).toMatchObject({ kind: 'turn', status: 'ok', cost_usd: 0.004, cost_measured: true });
  });
});
