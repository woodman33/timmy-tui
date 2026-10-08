/**
 * One turn through the agent: its events become the transcript; a good turn closes with a footer of
 * steps, spend and time; a failed turn prints its error in the flow and returns (playbook §17.8).
 * With a sealer (C-8), a finished turn, good or failed, closes with its receipt instead of the footer.
 */
import { bridgeAgent, type AgentEmitter } from './agent-bridge.js';
import type { CancelStage, SealedTurn, ToolOutcome, TurnFacts } from './seal.js';
import type { InspectRow, Transcript } from './transcript.js';

export interface TurnAgent extends AgentEmitter {
  send(text: string, opts?: { signal?: AbortSignal; retry?: boolean }): Promise<string>;
}

export interface TurnMarks {
  start(): void;
  /** 0 done, 1 failed, 130 cancelled. */
  end(status: number): void;
}

export type TurnResult = 'ok' | 'failed' | 'cancelled';

/**
 * Filled in by `runTurn` while a turn runs: `now()` seals the turn as it stands, as cancelled, for the
 * caller that is about to quit before the turn could end (a second Ctrl+C on a stream that ignored
 * the cancel). It does nothing once the turn has ended on its own.
 */
export interface TurnAbandon {
  now?: () => void;
}

/** Round R1: after the receipt, where to inspect what the turn did (its canvas job, the receipt's page). */
export interface TurnInspect {
  inspect?: (sealed: SealedTurn | null, result: TurnResult) => Promise<InspectRow[]>;
}

export async function runTurn(
  agent: TurnAgent,
  transcript: Transcript,
  text: string,
  clock: () => number = Date.now,
  marks?: TurnMarks,
  signal?: AbortSignal,
  seal?: (facts: TurnFacts) => SealedTurn,
  abandon?: TurnAbandon,
  more: TurnInspect = {},
): Promise<TurnResult> {
  const started = clock();
  // Round R1: the model that answered, read after the turn (a fallback switches it for the session).
  const modelNow = (): string | undefined => (agent as { getModel?: () => string }).getModel?.() || undefined;
  marks?.start();
  let steps = 0;
  let spend = 0;
  // LIVE-01 (ledger row 65): the spend is what OpenRouter charged; a cancel, or a response with no
  // charge reported, leaves it a lower bound, and the line says so instead of a flat $0.000.
  let costMeasured = true;
  let failed = false;
  let cancelled = false;
  // Each tool as it actually ends (third order, checkpoint 1): unknown until its result arrives.
  const tools = new Map<string, ToolOutcome>();
  const stop = bridgeAgent(agent, (e) => {
    if (e.type === 'tool-start') {
      steps++;
      tools.set(e.id, { tool: e.tool, outcome: 'unknown' });
    }
    if (e.type === 'tool-end') {
      const t = tools.get(e.id);
      if (t) t.outcome = e.ok ? 'completed' : 'failed';
    }
    if (e.type === 'error') failed = true;
    transcript.handle(e);
  });
  const onCost = (cost: number, _total?: number, info?: { complete?: boolean }): void => {
    if (Number.isFinite(cost)) spend += cost;
    if (info?.complete === false) costMeasured = false;
  };
  const spendText = (): string => (costMeasured ? `$${spend.toFixed(3)}` : spend > 0 ? `at least $${spend.toFixed(3)}` : 'cost unknown');
  agent.on('cost:update', onCost);
  let answer = '';
  let ended = false;
  const outcomesNow = (): ToolOutcome[] => [...tools.values()].map((t) => ({ ...t }));
  const stageOf = (o: ToolOutcome[]): CancelStage => (o.length === 0 ? 'before-tools' : o.some((t) => t.outcome === 'unknown') ? 'during-tool' : 'after-tools');
  let sealed: SealedTurn | null = null;
  const receipt = (r: SealedTurn, ms: number, isCancelled: boolean): void => {
    sealed = r;
    const model = modelNow();
    transcript.handle({ type: 'receipt', id: r.id, verified: r.verified, lanes: 0, steps, spend: spendText(), seconds: Math.round(ms / 100) / 10, url: r.url, ...(isCancelled ? { cancelled: true } : {}), ...(model ? { model } : {}) });
  };
  const sealCancelled = (ms: number): void => {
    const o = outcomesNow();
    const at = stageOf(o);
    // A cancelled request may still be charged: a cancel is never the whole cost.
    costMeasured = false;
    // A cancelled turn is sealed too, with what its tools actually did; nothing is rolled back.
    transcript.handle({ type: 'cancelled', at, tools: o });
    if (seal) receipt(seal({ prompt: text, answer: '', steps, spend, costMeasured, ms, status: 'cancelled', tools: o, cancelledAt: at }), ms, true);
  };
  if (abandon) abandon.now = () => {
    if (ended) return;
    ended = true;
    sealCancelled(clock() - started);
    transcript.endTurn();
  };
  try {
    answer = await agent.send(text, { signal, retry: true });
  } catch (err) {
    if ((err as Error)?.name === 'AbortError' || signal?.aborted) cancelled = true;
    else failed = true;
  } finally {
    stop();
    agent.off('cost:update', onCost);
  }
  if (ended) return 'cancelled'; // sealed already, by the caller's abandon.now()
  ended = true;
  const ms = clock() - started;
  if (cancelled) sealCancelled(ms);
  else if (seal) {
    receipt(seal({ prompt: text, answer: typeof answer === 'string' ? answer : '', steps, spend, costMeasured, ms, status: failed ? 'failed' : 'ok', tools: outcomesNow() }), ms, false);
  } else if (!failed) {
    const model = modelNow();
    transcript.handle({ type: 'footer', steps, spend: spendText(), seconds: ms / 1000, ...(model ? { model } : {}) });
  }
  const result: TurnResult = cancelled ? 'cancelled' : failed ? 'failed' : 'ok';
  if (more.inspect) {
    try {
      transcript.handle({ type: 'inspect', rows: await more.inspect(sealed, result) });
    } catch {
      // Where to look is help, not the turn: a failed lookup never fails the turn.
    }
  }
  transcript.endTurn();
  marks?.end(cancelled ? 130 : failed ? 1 : 0);
  return result;
}
