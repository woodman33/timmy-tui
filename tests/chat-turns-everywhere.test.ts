/**
 * R4 lead (2026-10-12; the operator's 10:24 direction: "include chat receipts in Control Room/run details"): since H113 every
 * surface's chat turn is the one turn, sealed by the one seal (src/repl/seal.ts sealTurn): the REPL's as kind turn, the
 * Workbench's, a monitor's and a companion page's as kind chat ("chat.turn · workbench · 1 step · <model>"). Each is read back
 * wherever a turn is counted, through one reader (src/repl/seal.ts chatTurnOf):
 * - the operation it was sealed in ends as it did (src/ops/operations.ts): answered, failed or stopped, its why naming the
 *   surface and the receipt, never "answered" for a turn that failed;
 * - the Control Room (src/room/index.ts gatherRoom): one chat run per turn, its harness the surface it was sent from, its cost;
 * - the run detail (src/ops/run-detail.ts): the model, the surface as the harness, the cost; the verdict in the turn's words;
 * - the tools ladder's evidence (src/room/decisions.ts toolUses): the route's row and the surface's own;
 * - God's Eye View (src/overview, through the Control Room's runs);
 * - a kind chat receipt in H103's older words is a turn too; the old monitor commander's "chat.turn · commander" is not.
 *
 * Real: the seal, the signed chain, the operation log and its records, and every reader. No model is asked (the facts are
 * sealed as a turn's would be; FAKE model names say so).
 */
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { OperationLog, readOperationRecord, type OperationHandle } from '../src/ops/operations.js';
import { runDetail } from '../src/ops/run-detail.js';
import { buildOverview } from '../src/overview/index.js';
import { projectId } from '../src/project/index.js';
import { chatTurnOf, sealTurn, type TurnFacts } from '../src/repl/seal.js';
import { toolUses } from '../src/room/decisions.js';
import { gatherRoom, receiptCosts } from '../src/room/index.js';
import { appendReceipt, readChain } from '../src/utils/receipts.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function projectRoot(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'chat-turns-everywhere-')));
  dirs.push(root);
  return root;
}
const log = (): OperationLog => new OperationLog({ scrub: (t) => t, live: () => false, outcome: () => ({ state: 'succeeded', words: 'ok' }) });
const MODEL = 'fake/model-for-the-test';

/** One chat turn of `surface`, sealed inside an operation (as the Workbench's composer and the REPL seal theirs); the operation. */
async function turnIn(ops: OperationLog, root: string, surface: NonNullable<TurnFacts['surface']>, status: TurnFacts['status'], extra: Partial<TurnFacts> = {}): Promise<{ h: OperationHandle; receipt: string }> {
  const h = ops.begin({ request: `hello from the ${surface}`, via: surface === 'repl' ? 'repl' : 'workbench', root, project: 'demo' });
  const sealed = await ops.run(h, async () => sealTurn({
    prompt: 'hello', answer: status === 'ok' ? 'Hi.' : '', steps: 1, spend: 0.0012, costMeasured: status === 'ok', ms: 1500, status,
    tools: [{ tool: 'list_project_files', outcome: 'completed' }], ...(status === 'cancelled' ? { cancelledAt: 'after-tools' as const } : {}),
    project: 'demo', projectId: projectId(root), surface, model: MODEL, modelResolved: MODEL, ...extra,
  }, root));
  await ops.done(h);
  return { h, receipt: sealed.id };
}
const record = (root: string, id: string) => { const r = readOperationRecord(root, id); if (!r.ok) throw new Error(r.error); return r.record; };

describe('every surface\'s chat turn, read back wherever a turn is counted (R4 lead)', () => {
  it('the operation a turn was sealed in ends as the turn did: answered, failed or stopped, naming the surface and the receipt', async () => {
    const root = projectRoot();
    const ops = log();
    const ok = await turnIn(ops, root, 'workbench', 'ok');
    expect(record(root, ok.h.id)).toMatchObject({ state: 'answered', why: `the Workbench's chat turn answered (receipt ${ok.receipt})`, via: 'workbench' });
    const failed = await turnIn(ops, root, 'workbench', 'failed');
    expect(record(root, failed.h.id)).toMatchObject({ state: 'failed', why: `the Workbench's chat turn failed (receipt ${failed.receipt})` });
    const stopped = await turnIn(ops, root, 'monitor', 'cancelled');
    expect(record(root, stopped.h.id)).toMatchObject({ state: 'stopped', why: `the monitor's chat turn was stopped (receipt ${stopped.receipt})` });
    const repl = await turnIn(ops, root, 'repl', 'ok');
    expect(record(root, repl.h.id)).toMatchObject({ state: 'answered', why: `the REPL's chat turn answered (receipt ${repl.receipt})`, via: 'repl' });
    // the receipts: the REPL's kind turn, every other surface's kind chat naming itself; each carries its operation
    const chain = readChain('runs', root);
    expect(chain.map((r) => [r.kind, r.subject, r.operation_id])).toEqual([
      ['chat', `chat.turn · workbench · 1 step · ${MODEL}`, ok.h.id],
      ['chat', `chat.turn · workbench · failed · 1 step · ${MODEL}`, failed.h.id],
      ['chat', `chat.turn · monitor · cancelled · 1 step · ${MODEL}`, stopped.h.id],
      ['turn', 'repl · 1 step', repl.h.id],
    ]);
    expect(chain.map((r) => chatTurnOf(r)?.surface)).toEqual(['workbench', 'workbench', 'monitor', 'repl']);
  });

  it('the Control Room lists every surface\'s turns, each with the surface it was sent from, and counts each one\'s cost once', async () => {
    const root = projectRoot();
    const ops = log();
    await turnIn(ops, root, 'workbench', 'ok');
    await turnIn(ops, root, 'companion', 'ok');
    await turnIn(ops, root, 'repl', 'ok');
    // H103's older words for a monitor's turn (kind chat, no steps) are a turn too; the old commander's are no project's turn
    appendReceipt('runs', { kind: 'chat', subject: `chat.turn · monitor · ${MODEL}`, policy: 'human-gated', status: 'ok', project: 'demo', project_id: projectId(root), model_requested: MODEL, cost_usd: 0.002, cost_measured: true, ms: 900 }, root);
    appendReceipt('runs', { kind: 'chat', subject: 'chat.turn · commander', policy: 'human-gated', status: 'ok', project_id: projectId(root) }, root);
    const chain = readChain('runs', root);
    const costs = [...receiptCosts(chain, projectId(root)).values()].filter((c) => c.key.startsWith('turn:'));
    expect(costs.map((c) => c.cost)).toEqual([
      { kind: 'known', usd: 0.0012, words: expect.any(String) }, { kind: 'known', usd: 0.0012, words: expect.any(String) },
      { kind: 'known', usd: 0.0012, words: expect.any(String) }, { kind: 'known', usd: 0.002, words: expect.any(String) },
    ]);
    const room = gatherRoom({ root, project: 'demo', projectId: projectId(root), jobs: [], chain, mine: () => false, activeFlows: [], scrub: (x) => x });
    const chats = room.all.filter((r) => r.kind === 'chat');
    expect(chats.map((r) => r.harness).sort()).toEqual([
      'Timmy REPL (version not recorded)', 'Timmy Workbench, timmy workbench (version not recorded)',
      'Timmy monitor, timmy watch (version not recorded)', 'a Timmy companion page (version not recorded)',
    ].sort());
    expect(chats.every((r) => r.state === 'answered' && r.cost.kind === 'known')).toBe(true);
    expect(room.view.costs).toMatchObject({ known: 4 });
    const group = room.view.groups.find((g) => g.kind === 'chat');
    expect(group?.note).toContain('from whichever surface sent it (the REPL, the Workbench, the monitor)');
    // God's Eye View reads the Control Room's runs: every surface's turn is there too
    const o = buildOverview(root, { store: join(root, '.timmy', 'receipts') });
    expect(o.agents.items.filter((i) => i.kind === 'chat')).toHaveLength(4);
  });

  it('the run detail of a Workbench chat turn\'s operation names its model, the surface, the route and the cost; a failed turn\'s is failed', async () => {
    const root = projectRoot();
    const ops = log();
    const ok = await turnIn(ops, root, 'workbench', 'ok');
    const d = runDetail(ok.h.id, { project: root, jobs: [], chain: readChain('runs', root) });
    expect(d.verdict).toMatchObject({ state: 'completed', words: `answered: the Workbench's chat turn answered (receipt ${ok.receipt})` });
    expect(d.worker.model).toEqual({ value: MODEL, from: `receipt ${ok.receipt}` });
    expect(d.worker.harness).toEqual({ value: 'Timmy Workbench (timmy workbench) chat, the OpenRouter route', from: `receipt ${ok.receipt}` });
    expect(d.cost).toMatchObject({ usd: 0.0012, measured: true, from: `receipt ${ok.receipt}` });
    expect(d.receipts).toEqual([{ id: ok.receipt, kind: 'chat', subject: `chat.turn · workbench · 1 step · ${MODEL}` }]);
    // on the local route through Ollama: said so
    const local = await turnIn(ops, root, 'workbench', 'ok', { route: { host: '127.0.0.1:11434', endpoint: 'local', tools: 'on', modelResolved: 'qwen3:8b', costBasis: 'local endpoint' }, spend: 0, costMeasured: true });
    expect(runDetail(local.h.id, { project: root, jobs: [], chain: readChain('runs', root) }).worker).toMatchObject({ model: { value: 'qwen3:8b' }, harness: { value: 'Timmy Workbench (timmy workbench) chat, the local route through Ollama' } });
    const failed = await turnIn(ops, root, 'workbench', 'failed');
    const f = runDetail(failed.h.id, { project: root, jobs: [], chain: readChain('runs', root) });
    expect(f.verdict).toMatchObject({ state: 'failed', words: `failed: the Workbench's chat turn failed (receipt ${failed.receipt})` });
    // its request's cost did not all come back: unknown, never a sum
    expect(f.cost).toMatchObject({ usd: null, measured: false, why: `unknown: a chat turn from Timmy Workbench (timmy workbench) (receipt ${failed.receipt})` });
  });

  it('the tools ladder\'s evidence: each turn uses the route\'s row and its surface\'s own', async () => {
    const root = projectRoot();
    const ops = log();
    await turnIn(ops, root, 'monitor', 'ok');
    await turnIn(ops, root, 'workbench', 'ok', { route: { host: '127.0.0.1:11434', endpoint: 'local', tools: 'on', modelResolved: 'qwen3:8b', costBasis: 'local endpoint' }, spend: 0, costMeasured: true });
    const uses = toolUses({ root, chain: readChain('runs', root), projectId: projectId(root), scrub: (t) => t }, { list: [], more: 0 });
    expect([...uses.keys()].sort()).toEqual(['monitor', 'ollama', 'openrouter', 'workbench']);
    expect(uses.get('workbench')?.by).toMatch(/^a chat turn from the Workbench \(receipt [0-9a-f]{8}\)$/);
    expect(uses.get('monitor')?.by).toMatch(/^a chat turn from the monitor \(receipt [0-9a-f]{8}\)$/);
  });
});
