/**
 * One turn through the agent: its events become the transcript; a good turn closes with a footer of
 * steps, spend and time; a failed turn prints its error in the flow and returns (playbook §17.8).
 * With a sealer (C-8), a finished turn, good or failed, closes with its receipt instead of the footer.
 */
import { bridgeAgent, type AgentEmitter } from './agent-bridge.js';
import type { SealedTurn, TurnFacts } from './seal.js';
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

export async function runTurn(
  agent: TurnAgent,
  transcript: Transcript,
  text: string,
  clock: () => number = Date.now,
  marks?: TurnMarks,
  signal?: AbortSignal,
  seal?: (facts: TurnFacts) => SealedTurn,
): Promise<TurnResult> {
  const started = clock();
  marks?.start();
  let steps = 0;
  let spend = 0;
  let failed = false;
  let cancelled = false;
  const stop = bridgeAgent(agent, (e) => {
    if (e.type === 'tool-start') steps++;
    if (e.type === 'error') failed = true;
    transcript.handle(e);
  });
  const onCost = (cost: number): void => {
    if (Number.isFinite(cost)) spend += cost;
  };
  agent.on('cost:update', onCost);
  let answer = '';
  try {
    answer = await agent.send(text, { signal, retry: true });
  } catch (err) {
    if ((err as Error)?.name === 'AbortError' || signal?.aborted) cancelled = true;
    else failed = true;
  } finally {
    stop();
    agent.off('cost:update', onCost);
  }
  const ms = clock() - started;
  if (cancelled) transcript.handle({ type: 'cancelled' });
  else if (seal) {
    const r = seal({ prompt: text, answer: typeof answer === 'string' ? answer : '', steps, spend, ms, status: failed ? 'failed' : 'ok' });
    transcript.handle({ type: 'receipt', id: r.id, verified: r.verified, lanes: 0, steps, spend: `$${spend.toFixed(3)}`, seconds: Math.round(ms / 100) / 10, url: r.url });
  } else if (!failed) transcript.handle({ type: 'footer', steps, spend: `$${spend.toFixed(3)}`, seconds: ms / 1000 });
  transcript.endTurn();
  marks?.end(cancelled ? 130 : failed ? 1 : 0);
  return cancelled ? 'cancelled' : failed ? 'failed' : 'ok';
}
