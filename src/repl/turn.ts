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
  /**
   * R4 (H113): told once, as the turn ends (after its receipt, before the inspector), what it did: a surface that draws the
   * turn itself (the chat session, src/agent/chat-session.ts) builds its answer from this; the REPL's transcript is unchanged.
   */
  summary?: (s: TurnSummary) => void;
  /** R4 (H113): retry 429, 5xx and connection errors (src/agent/core.ts SendOptions.retry); the REPL's default, true */
  retry?: boolean;
  /** R4 (H113): the surface's own test that a failure never left this process (the chat session's: src/agent/tools.ts neverSent) */
  notSent?: (err: unknown) => boolean;
  /**
   * R5 lead (the operator's 22:32 order, item 2): who asked this turn to stop, in words ("the companion"), when another surface
   * did (src/agent/chat-turn.ts watchTurnStop); the cancel line says it, as the receipt (stopped_by) and every surface do
   */
  stoppedBy?: () => string | undefined;
}

/**
 * R4 (H113): what one turn did, from the agent's own events, for the surfaces that are not the REPL's transcript: one turn
 * implementation (this file) for every surface, each drawing it in its own words.
 */
export interface TurnSummary {
  result: TurnResult;
  /** the answer as the agent returned it ('' when it returned none) */
  answer: string;
  /** the answer as it streamed (the agent's stream:delta, the whole text so far): what a cancelled or failed turn had written */
  streamed: string;
  steps: number;
  /** what the agent's own requests reported spending (cost:update), in dollars; describe_image's own charge is not in it */
  spend: number;
  /** the turn's own measure, as its receipt seals it (cost_measured) */
  costMeasured: boolean;
  /** how many cost reports came back, how many of them from a local endpoint, and whether every one said it was the whole charge */
  costReports: number;
  localReports: number;
  allComplete: boolean;
  /** the spend in the REPL's words ("$0.004", "at least $0.012", "no charge (local endpoint)", "cost unknown") */
  spendWords: string;
  /** whether the agent's stream started (a request was on its way) */
  streamStarted: boolean;
  /** whether a request left this process for a model (an answer, a stream or a cost, and no failure that says nothing was sent) */
  sent: boolean;
  tools: ToolOutcome[];
  /** what the agent said beside the answer (the last-resort fallback that answered, tools off for a model that takes none) */
  notices: string[];
  /** the failure, as thrown (a failed turn) */
  error?: unknown;
  /** the model the agent names after the turn (a fallback switches it) */
  model?: string;
  /** the receipt runTurn's own sealer made (none when it was given none) */
  sealed: SealedTurn | null;
  /** the facts runTurn sealed, or would have sealed with a sealer: a surface that seals after the turn seals these (src/repl/seal.ts) */
  facts: TurnFacts;
  ms: number;
}

/** The fallback's and the local route's notices arrive as assistant messages on `message:user` (src/agent/core.ts, local-chat.ts). */
const NOTICE_PREFIX = /^\s*⚙️?\s*\*\*\[SYSTEM\]\*\*\s*/u;

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

/**
 * R4 (H40): the tools whose own answer names a receipt sealed during the call, and the field that names it (read in
 * src/agent/*-tools.ts): the observe receipt of observe_image and describe_image (through the REPL's workspace), the
 * mcp.call receipt of call_mcp_tool, and run_recipe's sealed prediction. The turn's receipt names it beside the
 * tool's outcome. A tool that answers with a job or flow id only (run_native, iterate_recipe, iterate_native) has no
 * receipt yet when it answers, so none is named for it.
 */
export const TOOL_RECEIPT_FIELD: Readonly<Record<string, string>> = {
  describe_image: 'receipt', observe_image: 'receipt', call_mcp_tool: 'receipt', run_recipe: 'prediction_receipt',
};

/** R4 (H40): the receipt a tool's own answer names (TOOL_RECEIPT_FIELD), only in the shape of a receipt id; never another field. */
export function toolReceipt(tool: string, output: unknown): string | undefined {
  if (!Object.hasOwn(TOOL_RECEIPT_FIELD, tool)) return undefined;
  let v = output;
  if (typeof v === 'string') {
    try { v = JSON.parse(v); } catch { return undefined; }
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const id = (v as Record<string, unknown>)[TOOL_RECEIPT_FIELD[tool]];
  return typeof id === 'string' && /^[\w-]{1,64}$/.test(id) ? id : undefined;
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
  // R4 (H82; H73's open item): how many cost reports came back (cost:update), so a failed turn with none is not a measured $0.
  let costReports = 0;
  // R4 (H103): how many of them came from a local endpoint (the chat's Ollama route on this computer, src/agent/local-chat.ts)
  let localReports = 0;
  // R4 (H113): whether every report said it was the whole charge (the chat session's measure is this strict one)
  let allComplete = true;
  const onCost = (cost: number, _total?: number, info?: { complete?: boolean; basis?: string }): void => {
    costReports++;
    if (info?.basis === 'local endpoint') localReports++;
    if (Number.isFinite(cost)) spend += cost;
    if (info?.complete === false) costMeasured = false;
    if (info?.complete !== true) allComplete = false;
  };
  // R4 (H113): for the summary: the stream's start, the text as it streamed, and the notices said beside the answer
  let streamStarted = false;
  let streamed = '';
  const notices: string[] = [];
  const onStreamStart = (): void => { streamStarted = true; };
  const onDelta = (_delta: string, full: string): void => { if (typeof full === 'string') streamed = full; };
  const onNotice = (m: { role?: string; content?: unknown }): void => {
    if (m?.role === 'assistant' && typeof m.content === 'string') notices.push(m.content.replace(NOTICE_PREFIX, '').trim());
  };
  // the error as the agent reported it (a turn that failed by its event alone keeps its words for the summary)
  let reported: unknown;
  const onError = (err: unknown): void => { reported = err; };
  // R4 (H113): the last-resort fallback answered (src/agent/core.ts lastFallback): OpenRouter was asked first and failed, and
  // whether its requests were charged did not come back, so the turn's cost is unknown, never a local endpoint's no charge
  // (the chat session's rule, now the one turn's)
  let fellBack = false;
  /** R4 (H103): every cost report of the turn came from a local endpoint, none charged: no charge, a cancel's included. */
  const localOnly = (): boolean => !fellBack && costReports > 0 && localReports === costReports && spend === 0;
  // R4 (H40): each call's first answer is read once for the tool's own receipt (TOOL_RECEIPT_FIELD).
  const answered = new Set<string>();
  // R4 (H30): a describe_image call's result, read once per call (a repeated item is not counted again).
  const onItem = (item: any): void => {
    if (item?.type !== 'function_call_output') return;
    const id = String(item.callId || '');
    const t = tools.get(id);
    if (t && !answered.has(id)) {
      answered.add(id);
      const own = toolReceipt(t.tool, item.output);
      if (own) t.receipt = own;
    }
    const call = paid.get(id);
    if (!call || call.answered) return;
    const said = toolSpent(item.output);
    call.answered = true;
    if (said.cost !== undefined) call.cost = said.cost;
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
    // R4 (H103): the chat's own requests on a local endpoint cost nothing; a paid tool's charge is said after it
    const head = localOnly() ? `${toolCalls ? 'chat ' : ''}no charge (local endpoint)` : costMeasured && !toolUnknown ? usd(total) : total > 0 ? `at least ${usd(total)}` : 'cost unknown';
    if (!toolCalls) return head;
    return `${head} (${PAID_TOOL} ${toolUnknown ? (toolSum > 0 ? `at least ${usd(toolSum)}` : 'cost unknown') : usd(toolSum)})`;
  };
  agent.on('cost:update', onCost);
  agent.on('item:update', onItem);
  agent.on('stream:start', onStreamStart);
  agent.on('stream:delta', onDelta);
  agent.on('message:user', onNotice);
  agent.on('error', onError);
  let answer = '';
  let ended = false;
  let thrown: unknown;
  const outcomesNow = (): ToolOutcome[] => [...tools.values()].map((t) => ({ ...t }));
  const stageOf = (o: ToolOutcome[]): CancelStage => (o.length === 0 ? 'before-tools' : o.some((t) => t.outcome === 'unknown') ? 'during-tool' : 'after-tools');
  let sealed: SealedTurn | null = null;
  // R4 (H113): the facts the turn seals (or would seal, with no sealer), built in one place for the seal and the summary
  let facts: TurnFacts | null = null;
  const receipt = (r: SealedTurn, ms: number, isCancelled: boolean): void => {
    sealed = r;
    const model = modelNow();
    transcript.handle({ type: 'receipt', id: r.id, verified: r.verified, lanes: 0, steps, spend: spendText(), seconds: Math.round(ms / 100) / 10, url: r.url, ...(isCancelled ? { cancelled: true } : {}), ...(model ? { model } : {}) });
  };
  const sealCancelled = (ms: number): void => {
    const o = outcomesNow();
    const at = stageOf(o);
    // A cancelled request may still be charged: a cancel is never the whole cost. R4 (H103): except on a local endpoint.
    if (!localOnly()) costMeasured = false;
    // A cancelled turn is sealed too, with what its tools actually did; nothing is rolled back.
    const by = more.stoppedBy?.();
    transcript.handle({ type: 'cancelled', at, tools: o, ...(by ? { by } : {}) });
    facts = { prompt: text, answer: '', steps, spend, costMeasured, ms, status: 'cancelled', tools: o, cancelledAt: at };
    if (seal) receipt(seal(facts), ms, true);
  };
  if (abandon) abandon.now = () => {
    if (ended) return;
    ended = true;
    sealCancelled(clock() - started);
    transcript.endTurn();
  };
  try {
    // the options only when there are some (a surface that cancels nothing and retries nothing sends the text alone, as before)
    const opts = { ...(signal ? { signal } : {}), ...((more.retry ?? true) ? { retry: true } : {}) };
    answer = Object.keys(opts).length ? await agent.send(text, opts) : await agent.send(text);
  } catch (err) {
    if ((err as Error)?.name === 'AbortError' || signal?.aborted) cancelled = true;
    else {
      failed = true;
      thrown = err;
      // A request that threw without an error event of its own still says why (R1 workspace demo: a
      // conversation log that could not be written ended a turn in 0 ms with nothing on screen).
      if (!sawError) transcript.handle(thrownError(err));
    }
  } finally {
    stop();
    agent.off('cost:update', onCost);
    agent.off('item:update', onItem);
    agent.off('stream:start', onStreamStart);
    agent.off('stream:delta', onDelta);
    agent.off('message:user', onNotice);
    agent.off('error', onError);
  }
  if (ended) return 'cancelled'; // sealed already, by the caller's abandon.now()
  ended = true;
  const ms = clock() - started;
  try { fellBack = Boolean((agent as { lastFallback?: () => unknown }).lastFallback?.()); } catch { fellBack = false; }
  if (fellBack) costMeasured = false;
  // Round R1 (the Mac run): a turn that ended at its limit with calls still open says so, instead of a
  // step that looks done; the receipt keeps their outcome unknown.
  const open = cancelled ? 0 : outcomesNow().filter((t) => t.outcome === 'unknown').length;
  if (open) transcript.handle({ type: 'unfinished', count: open });
  // R4 (H82; H73's open item): a turn that failed before any cost came back is sealed unknown (cost_measured: false), never a
  // measured $0. Timmy's agent (src/agent/core.ts) ends each request to OpenRouter with one cost:update, complete: false when
  // it failed or was cancelled, so a failed request is unknown already; a turn failed with no report at all went wrong where
  // no cost could come back (before its request, or at the local fallback), and whether a request went out is not known here.
  if (!cancelled && failed && costReports === 0) costMeasured = false;
  if (cancelled) sealCancelled(ms);
  else {
    facts = { prompt: text, answer: typeof answer === 'string' ? answer : '', steps, spend, costMeasured, ms, status: failed ? 'failed' : 'ok', tools: outcomesNow() };
    if (seal) receipt(seal(facts), ms, false);
    else if (!failed) {
      const model = modelNow();
      transcript.handle({ type: 'footer', steps, spend: spendText(), seconds: ms / 1000, ...(model ? { model } : {}) });
    }
  }
  const result: TurnResult = cancelled ? 'cancelled' : failed ? 'failed' : 'ok';
  // R4 (H113): what the turn did, for a surface that draws it itself (never throws into the turn). Whether a request left this
  // process: an answer came, the stream started or a cost came back, and no failure says nothing was sent (its own `sent:
  // false`, its words, or the surface's own test: the chat session's knows the connection errors that happen before a send).
  if (more.summary) {
    const failure = failed ? thrown ?? reported : undefined;
    const said = String((failure as Error | undefined)?.message ?? '');
    const notSent = failure !== undefined && ((failure as { sent?: unknown }).sent === false || /nothing was sent/i.test(said) || more.notSent?.(failure) === true);
    try {
      more.summary({
        result, answer: typeof answer === 'string' ? answer : '', streamed, steps, spend, costMeasured, costReports, localReports, allComplete,
        spendWords: spendText(), streamStarted, sent: !notSent && (result === 'ok' || streamStarted || costReports > 0),
        tools: outcomesNow(), notices: [...notices], ...(failure !== undefined ? { error: failure } : {}),
        ...(modelNow() ? { model: modelNow() } : {}), sealed, facts: facts!, ms,
      });
    } catch { /* a surface's drawing never fails the turn */ }
  }
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
