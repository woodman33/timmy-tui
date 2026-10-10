/**
 * One turn through the agent: its events become the transcript; a good turn closes with a footer of
 * steps, spend and time; a failed turn prints its error in the flow and returns (playbook §17.8).
 * With a sealer (C-8), a finished turn, good or failed, closes with its receipt instead of the footer.
 */
import type { TurnEvent } from './transcript.js';
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

/** R4 (H30): the tool that asks a model in a request of its own, outside the agent's: cost:update never reports it. */
const PAID_TOOL = 'describe_image';

/**
 * R4 (H30): what a describe_image call says it spent, from its own result (src/agent/vision-tools.ts): `cost` is the
 * reported amount, null when a request went out and no cost came back, absent when no request went out (anything
 * else in that field is unknown, never a number); `receipt`, the observe receipt that sealed it.
 */
export function toolSpent(output: unknown): { cost?: number | null; receipt?: string } {
  let v = output;
  if (typeof v === 'string') {
    try { v = JSON.parse(v); } catch { return {}; }
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  const o = v as Record<string, unknown>;
  const cost = !('cost_usd' in o) ? undefined : typeof o.cost_usd === 'number' && Number.isFinite(o.cost_usd) && o.cost_usd >= 0 ? o.cost_usd : null;
  const receipt = typeof o.receipt === 'string' && /^[\w-]{1,64}$/.test(o.receipt) ? o.receipt : undefined;
  return { ...(cost !== undefined ? { cost } : {}), ...(receipt ? { receipt } : {}) };
}

/** Dollars to three places, as the turn's line has them; a nonzero amount is never shown as zero. */
const usd = (n: number): string => (n > 0 && n < 0.001 ? `$${n.toPrecision(2)}` : `$${n.toFixed(3)}`);

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
  let sawError = false;
  let cancelled = false;
  // Each tool as it actually ends (third order, checkpoint 1): unknown until its result arrives.
  const tools = new Map<string, ToolOutcome>();
  // R4 (H30): describe_image's own charge, sealed on its observe receipt, never reported by cost:update. The line adds
  // what each call reported, once per call id: a number, or unknown (no cost came back, or no result came before the
  // turn ended). The turn's receipt keeps sealing only the agent's own spend and names each call's receipt instead,
  // so no charge is sealed twice.
  const paid = new Map<string, { answered: boolean; cost?: number | null }>();
  const stop = bridgeAgent(agent, (e) => {
    if (e.type === 'tool-start') {
      steps++;
      tools.set(e.id, { tool: e.tool, outcome: 'unknown' });
      if (e.tool === PAID_TOOL) paid.set(e.id, { answered: false });
    }
    if (e.type === 'tool-end') {
      const t = tools.get(e.id);
      if (t) t.outcome = e.ok ? 'completed' : 'failed';
    }
    if (e.type === 'error') { failed = true; sawError = true; }
    transcript.handle(e);
  });
  const onCost = (cost: number, _total?: number, info?: { complete?: boolean }): void => {
    if (Number.isFinite(cost)) spend += cost;
    if (info?.complete === false) costMeasured = false;
  };
  // R4 (H30): a describe_image call's result, read once per call (a repeated item is not counted again).
  const onItem = (item: any): void => {
    if (item?.type !== 'function_call_output') return;
    const id = String(item.callId || '');
    const call = paid.get(id);
    if (!call || call.answered) return;
    const said = toolSpent(item.output);
    call.answered = true;
    if (said.cost !== undefined) call.cost = said.cost;
    const t = tools.get(id);
    if (t && said.receipt) t.receipt = said.receipt;
  };
  const spendText = (): string => {
    let toolSum = 0;
    let toolUnknown = false;
    let toolCalls = 0;
    for (const c of paid.values()) {
      if (c.answered && c.cost === undefined) continue; // it answered, and no request went out: nothing was charged
      toolCalls++;
      if (typeof c.cost === 'number') toolSum += c.cost;
      else toolUnknown = true; // no cost came back, or no result came: it may have been charged
    }
    const total = spend + toolSum;
    const head = costMeasured && !toolUnknown ? usd(total) : total > 0 ? `at least ${usd(total)}` : 'cost unknown';
    if (!toolCalls) return head;
    return `${head} (${PAID_TOOL} ${toolUnknown ? (toolSum > 0 ? `at least ${usd(toolSum)}` : 'cost unknown') : usd(toolSum)})`;
  };
  agent.on('cost:update', onCost);
  agent.on('item:update', onItem);
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
    else {
      failed = true;
      // A request that threw without an error event of its own still says why (R1 workspace demo: a
      // conversation log that could not be written ended a turn in 0 ms with nothing on screen).
      if (!sawError) transcript.handle(thrownError(err));
    }
  } finally {
    stop();
    agent.off('cost:update', onCost);
    agent.off('item:update', onItem);
  }
  if (ended) return 'cancelled'; // sealed already, by the caller's abandon.now()
  ended = true;
  const ms = clock() - started;
  // Round R1 (the Mac run): a turn that ended at its limit with calls still open says so, instead of a
  // step that looks done; the receipt keeps their outcome unknown.
  const open = cancelled ? 0 : outcomesNow().filter((t) => t.outcome === 'unknown').length;
  if (open) transcript.handle({ type: 'unfinished', count: open });
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

/** A thrown error as the transcript's error line: its first line, its Reason and its Next; keys redacted. */
export function thrownError(err: unknown): Extract<TurnEvent, { type: 'error' }> {
  const raw = String((err as Error)?.message ?? err).replace(/\b(sk|pk|rk)-[A-Za-z0-9_-]{8,}/g, '[key]');
  const lines = raw.split('\n').map((l) => l.trim()).filter(Boolean);
  const reason = lines.find((l) => /^Reason:/i.test(l))?.replace(/^Reason:\s*/i, '');
  const next = lines.find((l) => /^Next:/i.test(l))?.replace(/^Next:\s*/i, '');
  const other = lines.slice(1).find((l) => !/^(Reason|Next):/i.test(l));
  return { type: 'error', message: lines[0] ?? 'The request failed.', ...(reason ?? other ? { cause: reason ?? other } : {}), ...(next ? { fix: next } : {}) };
}
