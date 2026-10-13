/**
 * Round R4 (H40): a turn's receipt names each tool's own receipt where the tool's answer gives one (src/repl/turn.ts
 * TOOL_RECEIPT_FIELD): the mcp.call receipt of call_mcp_tool, the observe receipt of observe_image and describe_image,
 * and run_recipe's sealed prediction; never a receipt a tool gives in another field, nor one from a tool that answers
 * with a job id only. The receipt page names them as each tool's own receipt; only describe_image's is said to seal its
 * own cost, and only then is the turn's spend said to leave tools out.
 *
 * A LABELLED FAKE agent replays the items the SDK emits during a turn (no model, nothing sent); the answers are made
 * up, in the shapes the tools return. The turn is sealed by the REPL's own sealer (sealTurn) into a temporary store.
 */
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createMcpTools } from '../src/agent/mcp-tools.js';
import { createRecipeTools } from '../src/agent/recipe-tools.js';
import { createVisionTools } from '../src/agent/vision-tools.js';
import { sealTurn, type TurnFacts } from '../src/repl/seal.js';
import { Transcript } from '../src/repl/transcript.js';
import { runTurn, toolReceipt, TOOL_RECEIPT_FIELD } from '../src/repl/turn.js';
import { receiptFacts } from '../src/studio/receipt-page.js';
import { detectCapabilities } from '../src/term/capabilities.js';
import { LiveRegion } from '../src/term/live-region.js';
import { buildTheme } from '../src/term/theme.js';
import { readChain } from '../src/utils/receipts.js';

const dirs: string[] = [];
const temp = (prefix: string): string => { const d = mkdtempSync(join(tmpdir(), prefix)); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

class Sink { writes: string[] = []; isTTY = false; write(s: string) { this.writes.push(s); return true; } }
/** A LABELLED FAKE agent: replays the items it is given, then answers. */
class FakeAgent extends EventEmitter {
  constructor(private readonly script: (a: FakeAgent) => void) { super(); }
  async send(_text: string): Promise<string> { this.script(this); return 'done'; }
}
const transcript = (): Transcript => {
  const caps = detectCapabilities({ env: { LANG: 'en_US.UTF-8' }, stdin: { isTTY: false }, stdout: { isTTY: false }, stderr: { isTTY: false } });
  return new Transcript(buildTheme(caps), new LiveRegion({ out: new Sink(), err: new Sink() }, { live: false }), { columns: 120 });
};
type Call = { id: string; tool: string; outputs: unknown[] };
/** A turn whose tools answered with these outputs, sealed by the REPL's own sealer into `store`: the facts and the receipt. */
async function turn(calls: Call[], store: string) {
  const agent = new FakeAgent((a) => {
    for (const c of calls) {
      a.emit('item:update', { type: 'function_call', callId: c.id, name: c.tool, arguments: '{}', status: 'completed' });
      for (const o of c.outputs) a.emit('item:update', { type: 'function_call_output', callId: c.id, output: JSON.stringify(o) });
    }
    a.emit('cost:update', 0.003, 0.003);
    a.emit('item:update', { type: 'message', id: 'm1', content: [{ text: 'done' }] });
  });
  let facts: TurnFacts | undefined;
  let t = 0;
  await runTurn(agent, transcript(), 'do it', () => (t += 1000), undefined, undefined, (f) => { facts = f; return sealTurn({ ...f, model: 'fake/model' }, store); });
  return { facts: facts!, receipt: readChain('runs', store).at(-1)! };
}

describe("a turn names its tools' own receipts", () => {
  it("toolReceipt reads only each tool's own field, and only a receipt id's shape", () => {
    expect(toolReceipt('call_mcp_tool', '{"ok":true,"text":"echo: hi","receipt":"ab12cd34"}')).toBe('ab12cd34');
    // a failed call is still kept and sealed: its receipt is named
    expect(toolReceipt('call_mcp_tool', { ok: false, isError: true, error: 'the server said: no', receipt: 'ab12cd35' })).toBe('ab12cd35');
    expect(toolReceipt('run_recipe', { ok: true, job: 'j123456', prediction_receipt: '0f0f0f0f', receipt: 'nope' })).toBe('0f0f0f0f');
    expect(toolReceipt('run_recipe', { ok: true, receipt: '0f0f0f0f' })).toBeUndefined();
    expect(toolReceipt('observe_image', { ok: true, recorded: true, receipt: '1a2b3c4d' })).toBe('1a2b3c4d');
    expect(toolReceipt('describe_image', { ok: true, cost_usd: 0.002, receipt: '0a1b2c3d' })).toBe('0a1b2c3d');
    // a tool that answers with a job or flow id only names none, whatever its answer holds
    for (const tool of ['run_native', 'iterate_recipe', 'iterate_native', 'write_project_file', 'constructor', '__proto__']) expect(toolReceipt(tool, { ok: true, receipt: '99999999' }), tool).toBeUndefined();
    for (const bad of [{ receipt: 'a b' }, { receipt: 7 }, { receipt: 'x'.repeat(65) }, { receipt: '' }, ['ab12cd34'], 'not json', null]) expect(toolReceipt('call_mcp_tool', bad), JSON.stringify(bad)).toBeUndefined();
    // every tool named here is one of the agent's tools, by its exact name
    const names = [...createMcpTools(), ...createVisionTools({ root: () => '.' }), ...createRecipeTools({ start: async () => ({}) })].map((x) => (x as unknown as { function: { name: string } }).function.name);
    for (const tool of Object.keys(TOOL_RECEIPT_FIELD)) expect(names, tool).toContain(tool);
  });

  it("the turn's receipt names each one beside its outcome; the page says which seals a cost", async () => {
    const store = temp('turn-receipts-');
    const { facts, receipt } = await turn([
      { id: 'c1', tool: 'call_mcp_tool', outputs: [{ ok: true, route: 'sdk', text: 'echo: hi', record: '.timmy/mcp/m00000001/call.json', receipt: 'ab12cd34' }, { ok: true, receipt: 'ffffffff' }] },
      { id: 'c2', tool: 'run_recipe', outputs: [{ ok: true, job: 'j123456', operation: 'op', prediction_receipt: '0f0f0f0f' }] },
      { id: 'c3', tool: 'observe_image', outputs: [{ ok: true, recorded: true, observation_file: 'results/observations/a.json', receipt: '1a2b3c4d' }] },
      { id: 'c4', tool: 'run_native', outputs: [{ ok: true, job: 'j654321', receipt: '99999999' }] },
      { id: 'c5', tool: 'call_mcp_tool', outputs: [{ ok: false, error: 'which server?' }] },
      { id: 'c6', tool: 'describe_image', outputs: [{ ok: true, cost_usd: 0.002, receipt: '0a1b2c3d' }] },
    ], store);
    expect(facts.tools).toEqual([
      { tool: 'call_mcp_tool', outcome: 'completed', receipt: 'ab12cd34' },
      { tool: 'run_recipe', outcome: 'completed', receipt: '0f0f0f0f' },
      { tool: 'observe_image', outcome: 'completed', receipt: '1a2b3c4d' },
      { tool: 'run_native', outcome: 'completed' },
      { tool: 'call_mcp_tool', outcome: 'failed' },
      { tool: 'describe_image', outcome: 'completed', receipt: '0a1b2c3d' },
    ]);
    expect(receipt.tool_outcomes).toEqual([
      { name: 'call_mcp_tool', outcome: 'completed', receipt: 'ab12cd34' },
      { name: 'run_recipe', outcome: 'completed', receipt: '0f0f0f0f' },
      { name: 'observe_image', outcome: 'completed', receipt: '1a2b3c4d' },
      { name: 'run_native', outcome: 'completed' },
      { name: 'call_mcp_tool', outcome: 'failed' },
      { name: 'describe_image', outcome: 'completed', receipt: '0a1b2c3d' },
    ]);
    // The turn still seals only the agent's own spend (describe_image's is on its observe receipt).
    expect(receipt).toMatchObject({ kind: 'turn', cost_usd: 0.003 });
    const page = Object.fromEntries(receiptFacts(receipt));
    expect(page.tools).toBe('call_mcp_tool completed (its own receipt ab12cd34), run_recipe completed (its own receipt 0f0f0f0f), observe_image completed (its own receipt 1a2b3c4d), run_native completed, call_mcp_tool failed, describe_image completed (receipt 0a1b2c3d seals its own cost)');
    expect(page.spend).toBe('$0.0030; not counting the tools sealed on their own receipts (see tools)');
  });

  it('without a tool that spends on its own, the spend is not said to leave tools out', async () => {
    const { receipt } = await turn([{ id: 'c1', tool: 'call_mcp_tool', outputs: [{ ok: true, text: 'echo: hi', receipt: 'ab12cd34' }] }], temp('turn-receipts-'));
    const page = Object.fromEntries(receiptFacts(receipt));
    expect(page.tools).toBe('call_mcp_tool completed (its own receipt ab12cd34)');
    expect(page.spend).toBe('$0.0030');
  });
});
