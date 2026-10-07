/**
 * One turn through the agent: its events become the transcript; a good turn closes with a footer of
 * steps, spend and time; a failed turn prints its error in the flow and returns (playbook §17.8).
 * With a sealer (C-8), a finished turn, good or failed, closes with its receipt instead of the footer.
 */
import { bridgeAgent, type AgentEmitter } from './agent-bridge.js';
import type { CancelStage, SealedTurn, ToolOutcome, TurnFacts } from './seal.js';
import type { Transcript } from './transcript.js';

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

export async function runTurn(
  agent: TurnAgent,
  transcript: Transcript,
  text: string,
  clock: () => number = Date.now,
  marks?: TurnMarks,
  signal?: AbortSignal,
  seal?: (facts: TurnFacts) => SealedTurn,
  abandon?: TurnAbandon,
): Promise<TurnResult> {
  const started = clock();
  marks?.start();
  let steps = 0;
  let spend = 0;
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
  const onCost = (cost: number): void => {
    if (Number.isFinite(cost)) spend += cost;
  };
  agent.on('cost:update', onCost);
  let answer = '';
  let ended = false;
  const outcomesNow = (): ToolOutcome[] => [...tools.values()].map((t) => ({ ...t }));
  const stageOf = (o: ToolOutcome[]): CancelStage => (o.length === 0 ? 'before-tools' : o.some((t) => t.outcome === 'unknown') ? 'during-tool' : 'after-tools');
  const receipt = (r: SealedTurn, ms: number, isCancelled: boolean): void =>
    transcript.handle({ type: 'receipt', id: r.id, verified: r.verified, lanes: 0, steps, spend: `$${spend.toFixed(3)}`, seconds: Math.round(ms / 100) / 10, url: r.url, ...(isCancelled ? { cancelled: true } : {}) });
  const sealCancelled = (ms: number): void => {
    const o = outcomesNow();
    const at = stageOf(o);
    // A cancelled turn is sealed too, with what its tools actually did; nothing is rolled back.
    transcript.handle({ type: 'cancelled', at, tools: o });
    if (seal) receipt(seal({ prompt: text, answer: '', steps, spend, ms, status: 'cancelled', tools: o, cancelledAt: at }), ms, true);
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
    receipt(seal({ prompt: text, answer: typeof answer === 'string' ? answer : '', steps, spend, ms, status: failed ? 'failed' : 'ok', tools: outcomesNow() }), ms, false);
  } else if (!failed) transcript.handle({ type: 'footer', steps, spend: `$${spend.toFixed(3)}`, seconds: ms / 1000 });
  transcript.endTurn();
  marks?.end(cancelled ? 130 : failed ? 1 : 0);
  return cancelled ? 'cancelled' : failed ? 'failed' : 'ok';
}
