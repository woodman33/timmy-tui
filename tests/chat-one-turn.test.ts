// R4 (H113, part 1): one turn implementation. The REPL's chat turn (src/repl/turn.ts runTurn, sealed by src/repl/seal.ts
// sealTurn) and the shared chat session's send (src/agent/chat-session.ts, which the monitor and the terminal Workbench use)
// are the same code: the same agent events give the same sealed facts on both paths (the prompt and the answer as hashes,
// each tool's outcome and the tool's own receipt, the cost and whether it is measured, the outcome rule); only the subject
// differs, naming the surface. Before this change the session had a turn of its own, which kept no tool's own receipt and
// said nothing of describe_image's own charge.
//
// The agent is the real one (src/agent/core.ts) with a FAKE OpenRouter client: it records what it is asked and plays the
// items the SDK would stream (no request leaves this process: the network is a recording fetch, FAKE, that refuses
// everything). The receipts are real signed chains in this test's own stores.
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openChatSession } from '../src/agent/chat-session.js';
import { createAgent, type Agent } from '../src/agent/core.js';
import { projectId } from '../src/project/index.js';
import { sealTurn } from '../src/repl/seal.js';
import type { TurnEvent } from '../src/repl/transcript.js';
import { runTurn } from '../src/repl/turn.js';
import { readChain, verifyChain } from '../src/utils/receipts.js';
import { recordFetch } from './fixtures/recording-fetch.js';

const VARS = ['TIMMY_HOME', 'TIMMY_SETTINGS_DIR', 'OPENROUTER_API_KEY', 'TIMMY_CHAT_MODEL', 'OLLAMA_HOST'] as const;
const kept = Object.fromEntries(VARS.map((v) => [v, process.env[v]]));
let box = '';
let project = '';
let restoreNet: (() => void) | null = null;
beforeEach(() => {
  box = mkdtempSync(join(tmpdir(), 'chat-one-turn-'));
  project = join(box, 'project');
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, 'README.md'), '# demo\n');
  process.env.TIMMY_HOME = join(box, 'home', 'timmy');
  process.env.TIMMY_SETTINGS_DIR = join(box, 'settings');
  for (const v of ['OPENROUTER_API_KEY', 'TIMMY_CHAT_MODEL', 'OLLAMA_HOST'] as const) delete process.env[v];
  restoreNet = recordFetch(() => false).restore;
});
afterEach(() => {
  restoreNet?.();
  restoreNet = null;
  for (const v of VARS) { if (kept[v] === undefined) delete process.env[v]; else process.env[v] = kept[v]; }
  rmSync(box, { recursive: true, force: true });
});

const sha = (s: string): string => createHash('sha256').update(s).digest('hex');

/** The items one turn streams, as the SDK would: a tool whose own answer names its receipt, describe_image with its own charge, the answer. */
const PLAN = (): unknown[] => [
  { type: 'function_call', callId: 'call-1', name: 'observe_image', arguments: '{"path":"refs/a.png"}', status: 'completed' },
  { type: 'function_call_output', callId: 'call-1', output: JSON.stringify({ ok: true, measurements: 3, receipt: 'abcd1234' }) },
  { type: 'function_call', callId: 'call-2', name: 'describe_image', arguments: '{"path":"refs/a.png"}', status: 'completed' },
  { type: 'function_call_output', callId: 'call-2', output: JSON.stringify({ ok: true, answer: 'a tray', cost_usd: 0.002, receipt: 'beefcafe' }) },
  { type: 'message', id: 'm1', content: [{ text: 'Measured: 3 values. The model says a tray.' }] },
];

/** The real agent with a FAKE OpenRouter client that plays PLAN and reports $0.0040 for the turn's own requests. */
function fakeAgent(): { agent: Agent; asked: string[] } {
  const agent = createAgent({ apiKey: 'sk-or-FAKE-key', model: 'fake/model', instructions: '', maxSteps: 3, maxCost: 1 }, { multiplexer: 'none' });
  agent.useSessions(join(box, `sessions-${Math.random().toString(36).slice(2, 8)}`));
  const asked: string[] = [];
  (agent as unknown as { client: unknown }).client = {
    callModel: (req: { model: string }) => {
      asked.push(req.model);
      return {
        async *getItemsStream() { for (const item of PLAN()) yield item; },
        getResponse: async () => ({ id: 'resp-fake', usage: { cost: 0.004 } }),
        cancel: async () => undefined,
      };
    },
  };
  return { agent, asked };
}

const facts = (r: Record<string, unknown>) => ({
  status: r.status, prompt_hash: r.prompt_hash, response_hash: r.response_hash, model_requested: r.model_requested,
  tool_outcomes: r.tool_outcomes, outcome_rule: r.outcome_rule, cost_usd: r.cost_usd, cost_measured: r.cost_measured,
  project: r.project, project_id: r.project_id, policy: r.policy,
});

describe('one turn implementation (R4 H113, part 1)', () => {
  it('the REPL\'s turn and the session\'s send seal the same facts for the same agent events; only the subject names the surface', async () => {
    // the REPL's path: runTurn into its transcript (a sink here), sealed by the REPL's seal
    const repl = fakeAgent();
    const events: TurnEvent[] = [];
    const result = await runTurn(repl.agent, { handle: (e: TurnEvent) => { events.push(e); }, endTurn: () => undefined } as never, 'measure refs/a.png', Date.now, undefined, undefined,
      (f) => sealTurn({ ...f, model: repl.agent.getModel(), project: 'demo', projectId: projectId(project) }));
    expect(result).toBe('ok');
    const fromRepl = readChain('runs').at(-1)! as unknown as Record<string, unknown>;
    // the session's path (the monitor's and the Workbench's), on its own agent with the same FAKE client
    const ws = fakeAgent();
    const chat = await openChatSession({ project: { name: 'demo', root: project }, surface: 'workbench' }, { agent: ws.agent });
    const tools: Array<{ name: string; phase: string; outcome?: string }> = [];
    const r = await chat.send('measure refs/a.png', { onText: () => undefined, onTool: (e) => { tools.push(e); }, askPerson: async () => 'deny' });
    const fromSession = readChain('runs', project).at(-1)! as unknown as Record<string, unknown>;

    expect(repl.asked).toEqual(['fake/model']);
    expect(ws.asked).toEqual(['fake/model']);
    // the same facts, field by field: each tool's own receipt included (the session's own turn kept none before)
    expect(facts(fromSession)).toEqual(facts(fromRepl));
    expect(fromSession.tool_outcomes).toEqual([{ name: 'observe_image', outcome: 'completed', receipt: 'abcd1234' }, { name: 'describe_image', outcome: 'completed', receipt: 'beefcafe' }]);
    expect(fromSession).toMatchObject({ prompt_hash: sha('measure refs/a.png'), response_hash: sha('Measured: 3 values. The model says a tray.'), cost_usd: 0.004, cost_measured: true });
    // the subject names the surface: the REPL's as before, the Workbench's with its steps and the model that answered
    expect(fromRepl).toMatchObject({ kind: 'turn', subject: 'repl · 2 steps' });
    expect(fromSession).toMatchObject({ kind: 'chat', subject: 'chat.turn · workbench · 2 steps · fake/model', model_resolved: 'fake/model' });
    // the surface's own words for the same turn: the answer, each tool as it started and ended, and the cost with
    // describe_image's own charge beside it (the REPL's line says it the same way)
    expect(r).toMatchObject({ status: 'answered', text: 'Measured: 3 values. The model says a tray.', sent: true, receipt: fromSession.hash, costWords: '$0.0040 (as OpenRouter reported); describe_image $0.002' });
    expect(tools.map((t) => `${t.name} ${t.phase}${t.outcome ? ` ${t.outcome}` : ''}`)).toEqual(['observe_image start', 'observe_image end completed', 'describe_image start', 'describe_image end completed']);
    const receiptRow = events.find((e) => e.type === 'receipt') as { spend?: string } | undefined;
    // the REPL's line: the total, the tool's own share beside it
    expect(receiptRow?.spend).toBe('$0.006 (describe_image $0.002)');
    // both chains verify
    expect(verifyChain('runs').ok).toBe(true);
    expect(verifyChain('runs', project).ok).toBe(true);
  });

  it('a cancelled turn: the session seals what the REPL seals (the stage of the cancel, the tool still running unknown, nothing rolled back)', async () => {
    const hang = (agent: Agent) => {
      (agent as unknown as { client: unknown }).client = {
        callModel: () => {
          let stop: () => void = () => undefined;
          const stopped = new Promise<void>((done) => { stop = done; });
          return {
            async *getItemsStream() {
              yield { type: 'function_call', callId: 'call-1', name: 'list_project_files', arguments: '{}', status: 'completed' };
              await stopped;
            },
            getResponse: async () => undefined,
            cancel: async () => { stop(); },
          };
        },
      };
    };
    const repl = fakeAgent();
    hang(repl.agent);
    const a = new AbortController();
    setTimeout(() => a.abort(), 100);
    const sink = { handle: () => undefined, endTurn: () => undefined };
    expect(await runTurn(repl.agent, sink as never, 'list', Date.now, undefined, a.signal, (f) => sealTurn({ ...f, model: repl.agent.getModel(), project: 'demo', projectId: projectId(project) }))).toBe('cancelled');
    const fromRepl = readChain('runs').at(-1)! as unknown as Record<string, unknown>;
    const ws = fakeAgent();
    hang(ws.agent);
    const chat = await openChatSession({ project: { name: 'demo', root: project }, surface: 'monitor' }, { agent: ws.agent });
    const b = new AbortController();
    setTimeout(() => b.abort(), 100);
    const r = await chat.send('list', { onText: () => undefined, askPerson: async () => 'deny', signal: b.signal });
    const fromSession = readChain('runs', project).at(-1)! as unknown as Record<string, unknown>;
    expect(r).toMatchObject({ status: 'cancelled', sent: true, lines: ['Cancelled after the request went out: what it did stands, and nothing was rolled back.'] });
    expect(facts(fromSession)).toEqual(facts(fromRepl));
    expect(fromSession).toMatchObject({ status: 'cancelled', cancelled_at: 'during-tool', rollback: 'none', tool_outcomes: [{ name: 'list_project_files', outcome: 'unknown' }], cost_measured: false });
    expect(fromRepl).toMatchObject({ subject: 'repl · cancelled · 1 step', cancelled_at: 'during-tool', rollback: 'none' });
    expect(fromSession.subject).toBe('chat.turn · monitor · cancelled · 1 step · fake/model');
  });
});
