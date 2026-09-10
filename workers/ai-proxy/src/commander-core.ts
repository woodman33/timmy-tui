// Commander core — the pure part of the durable commander (mindship-v5c2 step 2).
//
// The Commander Durable Object (commander.ts) is thin: it persists state and
// receipts and relays events. Everything that can be wrong lives here, where
// it is testable without a Durable Object: the route grammar, the handoff
// state machine, the spend ledger, the three modes (generate / bodybuilder /
// fusion) and the turn that runs them, and the "hands" hook that hands a
// mind-authored script to Code Mode.
//
// Vocabulary (from the order): OpenRouter is the MIND, Code Mode is the HANDS.
// While an MCP-capable harness HOLDS the commander role, OpenRouter is paused:
// every think refuses with 423 until release. A kill switch stops everything.
import { HttpError, runCode, validateScript, type CodeResponse, type Executor } from './code.js';
import { type EdgeReceipt, appendEdgeReceipt, sha256Hex } from './chain.js';
import { type Env, allowlist } from './tools.js';

export type CommanderMode = 'bodybuilder' | 'fusion' | 'generate';
export const MODES: readonly CommanderMode[] = ['bodybuilder', 'fusion', 'generate'] as const;
export const isMode = (m: unknown): m is CommanderMode => typeof m === 'string' && (MODES as readonly string[]).includes(m);

/** Every route under /commander/:room/<action>. `state` is the bare room path. */
export type CommanderAction =
  | 'state' | 'spend' | 'turns' | 'receipts' | 'schedules' | 'memory' | 'ws'
  | 'think' | 'turn' | 'mode' | 'handoff' | 'release' | 'kill' | 'revive' | 'schedule' | 'cancel' | 'remember' | 'cap';

const READ: readonly CommanderAction[] = ['state', 'spend', 'turns', 'receipts', 'schedules', 'memory', 'ws'] as const;
const WRITE: readonly CommanderAction[] = ['think', 'turn', 'mode', 'handoff', 'release', 'kill', 'revive', 'schedule', 'cancel', 'remember', 'cap'] as const;
export const isReadAction = (a: CommanderAction): boolean => (READ as readonly string[]).includes(a);

const ROOM_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;
export const validCommanderRoom = (room: string): boolean => ROOM_RE.test(room);

export function parseCommanderPath(pathname: string): { room: string; action: CommanderAction } | null {
  const parts = pathname.split('/').filter(Boolean);
  if (parts[0] !== 'commander' || parts.length < 2 || parts.length > 3) return null;
  const room = decodeURIComponent(parts[1]);
  const action = (parts[2] ?? 'state') as CommanderAction;
  if (!(READ as readonly string[]).includes(action) && !(WRITE as readonly string[]).includes(action)) return null;
  return { room, action };
}

export interface Holder {
  /** Which harness holds the role (jcode, opencode, pi, hermes, minds, openhands, claude-code, …). */
  harness: string;
  /** Who is behind it (operator handle or session id). */
  holder: string;
  since: string;
  /** sha256 prefix of the hold token; the token itself is never stored. */
  token_fp: string;
  note?: string;
}

export interface Spend {
  usd: number;
  cap_usd: number;
  calls: number;
  tokens_in: number;
  tokens_out: number;
  /** Calls whose cost OpenRouter did not report (counted as 0 USD; flagged, not hidden). */
  uncounted: number;
  last_at: string | null;
}

export interface CommanderState {
  v: 1;
  room: string;
  mode: CommanderMode;
  created_at: string;
  updated_at: string;
  held_by: Holder | null;
  /** True exactly while held: the mind (OpenRouter) is paused. */
  openrouter_paused: boolean;
  killed: boolean;
  killed_at: string | null;
  spend: Spend;
  turns: number;
  /** Hash of the latest receipt on this room's chain. */
  head: string | null;
  last_turn: string | null;
  memory_notes: number;
}

export const DEFAULT_CAP_USD = 2;

export function initialCommanderState(room: string, now: string, capUsd: number = DEFAULT_CAP_USD): CommanderState {
  return {
    v: 1,
    room,
    mode: 'generate',
    created_at: now,
    updated_at: now,
    held_by: null,
    openrouter_paused: false,
    killed: false,
    killed_at: null,
    spend: { usd: 0, cap_usd: capUsd, calls: 0, tokens_in: 0, tokens_out: 0, uncounted: 0, last_at: null },
    turns: 0,
    head: null,
    last_turn: null,
    memory_notes: 0
  };
}

export function capFromEnv(env: { COMMANDER_SPEND_CAP_USD?: string }): number {
  const n = Number(env.COMMANDER_SPEND_CAP_USD ?? DEFAULT_CAP_USD);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_CAP_USD;
}

// ---------------------------------------------------------------- tokens

export async function fingerprintToken(token: string): Promise<string> {
  return (await sha256Hex(`commander-hold:${token}`)).slice(0, 16);
}

export function newHoldToken(): string {
  const b = new Uint8Array(24);
  crypto.getRandomValues(b);
  let s = '';
  for (const x of b) s += x.toString(16).padStart(2, '0');
  return `hold_${s}`;
}

// ---------------------------------------------------------------- refusals

export interface Refusal { ok: false; status: number; reason: string }

/** Why the mind may not run right now, in the order the order gives them. */
export function canThink(state: CommanderState): { ok: true } | Refusal {
  if (state.killed) return { ok: false, status: 423, reason: `killed: the kill switch is on since ${state.killed_at}; POST /revive to resume` };
  if (state.held_by) return { ok: false, status: 423, reason: `held by ${state.held_by.harness} (${state.held_by.holder}) since ${state.held_by.since}: OpenRouter is paused until release` };
  if (state.spend.usd >= state.spend.cap_usd) return { ok: false, status: 402, reason: `spend cap reached: ${state.spend.usd.toFixed(4)} USD of ${state.spend.cap_usd} USD; POST /cap to raise it` };
  return { ok: true };
}

// ---------------------------------------------------------------- handoff state machine

export interface HandoffRequest { harness: string; holder: string; note?: string }

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,79}$/;

export async function applyHandoff(state: CommanderState, req: HandoffRequest, now: string): Promise<{ state: CommanderState; token: string; data: Record<string, unknown> }> {
  if (state.killed) throw new HttpError(423, 'killed: revive before handing off');
  if (state.held_by) throw new HttpError(409, `already held by ${state.held_by.harness} (${state.held_by.holder}) since ${state.held_by.since}`);
  if (!NAME_RE.test(req.harness ?? '')) throw new HttpError(400, 'harness: 1-80 chars of [A-Za-z0-9._:@/-]');
  if (!NAME_RE.test(req.holder ?? '')) throw new HttpError(400, 'holder: 1-80 chars of [A-Za-z0-9._:@/-]');
  const token = newHoldToken();
  const token_fp = await fingerprintToken(token);
  const held_by: Holder = { harness: req.harness, holder: req.holder, since: now, token_fp, ...(req.note ? { note: String(req.note).slice(0, 400) } : {}) };
  const next: CommanderState = { ...state, held_by, openrouter_paused: true, updated_at: now };
  return { state: next, token, data: { ...held_by, openrouter_paused: true, previous_mode: state.mode } };
}

export async function verifyHold(state: CommanderState, token: string | undefined): Promise<Holder> {
  if (!state.held_by) throw new HttpError(409, 'not held: nobody holds the commander role');
  if (!token || (await fingerprintToken(token)) !== state.held_by.token_fp) throw new HttpError(403, 'bad hold token');
  return state.held_by;
}

export async function applyRelease(state: CommanderState, token: string | undefined, now: string, force = false): Promise<{ state: CommanderState; data: Record<string, unknown> }> {
  if (!state.held_by) throw new HttpError(409, 'not held: nothing to release');
  if (!force) await verifyHold(state, token);
  const held = state.held_by;
  const next: CommanderState = { ...state, held_by: null, openrouter_paused: false, updated_at: now };
  const heldMs = Date.parse(now) - Date.parse(held.since);
  return { state: next, data: { harness: held.harness, holder: held.holder, since: held.since, token_fp: held.token_fp, forced: force, held_ms: Number.isFinite(heldMs) ? heldMs : null, openrouter_paused: false } };
}

export function applyKill(state: CommanderState, now: string, reason?: string): { state: CommanderState; data: Record<string, unknown> } {
  const next: CommanderState = { ...state, killed: true, killed_at: state.killed ? state.killed_at : now, openrouter_paused: true, updated_at: now };
  return { state: next, data: { reason: reason ? String(reason).slice(0, 400) : null, was_held: !!state.held_by, openrouter_paused: true } };
}

export function applyRevive(state: CommanderState, now: string): { state: CommanderState; data: Record<string, unknown> } {
  if (!state.killed) throw new HttpError(409, 'not killed');
  const next: CommanderState = { ...state, killed: false, killed_at: null, openrouter_paused: !!state.held_by, updated_at: now };
  return { state: next, data: { killed_since: state.killed_at, still_held: !!state.held_by } };
}

export function applyMode(state: CommanderState, mode: unknown, now: string): { state: CommanderState; data: Record<string, unknown> } {
  if (!isMode(mode)) throw new HttpError(400, `mode must be one of ${MODES.join(', ')}`);
  return { state: { ...state, mode, updated_at: now }, data: { from: state.mode, to: mode } };
}

export function applyCap(state: CommanderState, cap: unknown, now: string): { state: CommanderState; data: Record<string, unknown> } {
  const n = Number(cap);
  if (!Number.isFinite(n) || n < 0 || n > 1000) throw new HttpError(400, 'cap_usd must be a number in [0, 1000]');
  return { state: { ...state, spend: { ...state.spend, cap_usd: n }, updated_at: now }, data: { from: state.spend.cap_usd, to: n, spent: state.spend.usd } };
}

// ---------------------------------------------------------------- spend

export interface OpenRouterUsage { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number; cost?: number }

/** OpenRouter reports cost when the request carries usage:{include:true}; a missing cost is counted, not hidden. */
export function usageCost(u: OpenRouterUsage | undefined): { usd: number; tokens_in: number; tokens_out: number; counted: boolean } {
  const usd = typeof u?.cost === 'number' && Number.isFinite(u.cost) ? u.cost : 0;
  return { usd, tokens_in: Number(u?.prompt_tokens ?? 0), tokens_out: Number(u?.completion_tokens ?? 0), counted: typeof u?.cost === 'number' };
}

export function applySpend(state: CommanderState, calls: ModelCall[], now: string): CommanderState {
  const s = { ...state.spend };
  for (const c of calls) {
    s.calls += 1;
    s.usd += c.usd;
    s.tokens_in += c.tokens_in;
    s.tokens_out += c.tokens_out;
    if (!c.counted) s.uncounted += 1;
    s.last_at = now;
  }
  s.usd = Math.round(s.usd * 1e6) / 1e6;
  return { ...state, spend: s, updated_at: now };
}

// ---------------------------------------------------------------- turn planning

export interface TurnRequest {
  task: string;
  mode?: CommanderMode;
  /** Actor models (bodybuilder/fusion) or the mind (generate). Must be on the allowlist. */
  models?: string[];
  /** Fusion judge. Must be on the allowlist. */
  judge?: string;
  system?: string;
  max_tokens?: number;
  /** Hand a mind-authored `async () => …` script to Code Mode (default true). */
  hands?: boolean;
  /** Where the turn came from: http, ws, schedule. */
  source?: string;
}

export interface PlannedCall { role: 'mind' | 'actor' | 'judge'; model: string }
export interface TurnPlan { mode: CommanderMode; calls: PlannedCall[]; judge: string | null }

export const MAX_ACTORS = 5;

export function planTurn(mode: CommanderMode, allow: string[], req: Pick<TurnRequest, 'models' | 'judge'>): TurnPlan {
  if (!allow.length) throw new HttpError(500, 'empty model allowlist (ALLOWED_MODELS)');
  const wanted = (req.models ?? []).map((m) => String(m).trim()).filter(Boolean);
  for (const m of wanted) if (!allow.includes(m)) throw new HttpError(403, `model not on allowlist: ${m}`);
  if (mode === 'generate') return { mode, calls: [{ role: 'mind', model: wanted[0] ?? allow[0] }], judge: null };
  const actors = (wanted.length ? wanted : allow).slice(0, MAX_ACTORS);
  if (mode === 'bodybuilder') return { mode, calls: actors.map((model) => ({ role: 'actor', model })), judge: null };
  const judge = req.judge ?? allow[allow.length - 1];
  if (!allow.includes(judge)) throw new HttpError(403, `judge not on allowlist: ${judge}`);
  return { mode, calls: [...actors.map((model) => ({ role: 'actor' as const, model })), { role: 'judge', model: judge }], judge };
}

// ---------------------------------------------------------------- the mind

export interface ModelCall {
  role: 'mind' | 'actor' | 'judge';
  model: string;
  ok: boolean;
  ms: number;
  usd: number;
  tokens_in: number;
  tokens_out: number;
  counted: boolean;
  content_sha256: string | null;
  error: string | null;
  /** OpenRouter generation id (e.g. "gen-..."). The join key from this in-call ledger to
   *  the authoritative OpenRouter generations-API ledger; `timmy reconcile` amends against it.
   *  Optional so older ModelCall literals stay valid; chatOnce always sets it (null when absent). */
  generation_id?: string | null;
  /** Provider OpenRouter actually served the call from — the served-tier record (ledger-r4k2). */
  served_provider?: string | null;
}

export interface MindDeps { env: Env; fetch?: typeof fetch; now?: () => number }

type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string };
type OpenRouterChat = { id?: string; provider?: string; choices?: { message?: { content?: string } }[]; usage?: OpenRouterUsage; error?: unknown };

/** One chat completion through OpenRouter with usage accounting on. Never throws: the call record carries the error. */
export async function chatOnce(role: ModelCall['role'], model: string, messages: ChatMessage[], deps: MindDeps, maxTokens = 2048): Promise<{ call: ModelCall; content: string }> {
  const f = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  const started = now();
  const base = { role, model, ok: false, ms: 0, usd: 0, tokens_in: 0, tokens_out: 0, counted: false, content_sha256: null, error: null, generation_id: null, served_provider: null } as ModelCall;
  if (!deps.env.OPENROUTER_API_KEY) return { call: { ...base, ms: now() - started, error: 'OPENROUTER_API_KEY not set on worker' }, content: '' };
  try {
    const r = await f('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${deps.env.OPENROUTER_API_KEY}`, 'X-Title': 'TIMMY commander' },
      body: JSON.stringify({ model, messages, max_tokens: maxTokens, usage: { include: true } })
    });
    const j = (await r.json()) as OpenRouterChat;
    const cost = usageCost(j.usage);
    // capture the generation id + served provider even on an upstream error, if the body carried them.
    const gen = { generation_id: typeof j.id === 'string' ? j.id : null, served_provider: typeof j.provider === 'string' ? j.provider : null };
    if (!r.ok) return { call: { ...base, ms: now() - started, ...cost, ...gen, error: `upstream ${r.status}: ${JSON.stringify(j.error ?? j).slice(0, 300)}` }, content: '' };
    const content = j.choices?.[0]?.message?.content ?? '';
    return { call: { ...base, ok: true, ms: now() - started, ...cost, ...gen, content_sha256: await sha256Hex(content) }, content };
  } catch (e) {
    return { call: { ...base, ms: now() - started, error: e instanceof Error ? e.message : String(e) }, content: '' };
  }
}

const MIND_SYSTEM = 'You are the TIMMY commander mind. Answer the task directly and concretely. If the task is best done by running a script against the edge tools, reply with ONE JavaScript async arrow function `async () => { ... }` that calls `await timmy.<tool>(args)` and returns a JSON-serialisable value; otherwise reply in plain text.';
const JUDGE_SYSTEM = 'You are the fusion judge. You receive one task and several candidate answers from different models. Produce the single best answer: merge what is right, drop what is wrong, and say in one line at the end which candidates you drew on. Output the answer only.';

export function fusionPrompt(task: string, outputs: { model: string; content: string }[]): string {
  const parts = outputs.map((o, i) => `--- candidate ${i + 1} (${o.model}) ---\n${o.content.trim() || '(empty)'}`);
  return `TASK:\n${task}\n\n${parts.join('\n\n')}`;
}

/** The mind may answer with a script; if it does, that script is the hands' work order. */
export function extractHandsScript(text: string): string | null {
  const fenced = text.match(/```(?:js|javascript|ts|typescript)?\s*([\s\S]*?)```/);
  const body = (fenced ? fenced[1] : text).trim();
  const i = body.indexOf('async');
  if (i < 0) return null;
  const script = body.slice(i).trim();
  try {
    validateScript(script);
    return script;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- the turn

export interface TurnDeps extends MindDeps {
  /** Code Mode executor (DynamicWorkerExecutor in production). Absent = hands unavailable, recorded as such. */
  executor?: Executor;
}

export interface TurnResult {
  turn_id: string;
  mode: CommanderMode;
  ok: boolean;
  answer: string;
  outputs: { role: PlannedCall['role']; model: string; content: string }[];
  calls: ModelCall[];
  hands: { run_id: string; ok: boolean; error: string | null; receipt: string; tool_calls: number } | null;
  hands_note: string | null;
  usd: number;
  ms: number;
}

export const newTurnId = (now: number): string => `turn_${now.toString(36)}_${Math.random().toString(36).slice(2, 6)}`;

/**
 * Run one turn of the mind in the given mode. Pure with respect to storage:
 * the caller persists state and seals the receipt. Refusals (held, killed,
 * cap) are the caller's to check with canThink first; this function assumes
 * it may spend.
 */
export async function executeTurn(req: TurnRequest, mode: CommanderMode, deps: TurnDeps): Promise<TurnResult> {
  const now = deps.now ?? Date.now;
  const started = now();
  const task = String(req.task ?? '').trim();
  if (!task) throw new HttpError(400, 'task required');
  if (task.length > 20000) throw new HttpError(400, 'task too long');
  const allow = allowlist(deps.env);
  const plan = planTurn(mode, allow, req);
  const system = req.system ? String(req.system).slice(0, 4000) : MIND_SYSTEM;
  const maxTokens = Math.min(8192, Math.max(64, Number(req.max_tokens ?? 2048)));

  const actorCalls = plan.calls.filter((c) => c.role !== 'judge');
  const results = await Promise.all(actorCalls.map((c) => chatOnce(c.role, c.model, [{ role: 'system', content: system }, { role: 'user', content: task }], deps, maxTokens)));
  const calls: ModelCall[] = results.map((r) => r.call);
  const outputs = results.map((r, i) => ({ role: actorCalls[i].role, model: actorCalls[i].model, content: r.content }));

  let answer = '';
  if (mode === 'generate') {
    answer = outputs[0]?.content ?? '';
  } else if (mode === 'bodybuilder') {
    answer = outputs.map((o, i) => `[${i + 1}] ${o.model}\n${o.content.trim()}`).join('\n\n');
  } else {
    const good = outputs.filter((o, i) => calls[i].ok && o.content.trim());
    if (good.length) {
      const j = await chatOnce('judge', plan.judge as string, [{ role: 'system', content: JUDGE_SYSTEM }, { role: 'user', content: fusionPrompt(task, good) }], deps, maxTokens);
      calls.push(j.call);
      outputs.push({ role: 'judge', model: plan.judge as string, content: j.content });
      answer = j.content;
    }
  }

  let hands: TurnResult['hands'] = null;
  let hands_note: string | null = null;
  const script = req.hands === false ? null : extractHandsScript(answer);
  if (script) {
    if (!deps.executor) {
      hands_note = 'mind returned a script but this deployment has no Code Mode executor (LOADER); script not run';
    } else {
      try {
        const out: CodeResponse = await runCode({ script }, deps.env, { executor: deps.executor, fetch: deps.fetch, now: deps.now });
        hands = { run_id: out.run_id, ok: out.ok, error: out.error ?? null, receipt: out.receipt.hash, tool_calls: out.tool_calls.length };
      } catch (e) {
        hands_note = `hands failed: ${e instanceof Error ? e.message : String(e)}`;
      }
    }
  }

  const ok = calls.some((c) => c.ok) && (mode !== 'fusion' || !!answer);
  return {
    turn_id: newTurnId(started),
    mode,
    ok,
    answer,
    outputs,
    calls,
    hands,
    hands_note,
    usd: Math.round(calls.reduce((a, c) => a + c.usd, 0) * 1e6) / 1e6,
    ms: now() - started
  };
}

/** Receipt data for a mind turn: hashes and numbers, never the full texts (those live in the room's turns table). */
export async function turnReceiptData(req: TurnRequest, r: TurnResult, by: string): Promise<Record<string, unknown>> {
  return {
    turn_id: r.turn_id,
    by,
    source: req.source ?? 'http',
    mode: r.mode,
    ok: r.ok,
    task_sha256: await sha256Hex(String(req.task ?? '')),
    answer_sha256: await sha256Hex(r.answer),
    models: r.calls.map((c) => ({ role: c.role, model: c.model, ok: c.ok, ms: c.ms, usd: c.usd, tokens_in: c.tokens_in, tokens_out: c.tokens_out, counted: c.counted, error: c.error, generation_id: c.generation_id ?? null, served_provider: c.served_provider ?? null })),
    hands: r.hands,
    hands_note: r.hands_note,
    usd: r.usd,
    ms: r.ms
  };
}

/** A turn authored by the holding harness while OpenRouter is paused. */
export interface HolderTurn { hold_token?: string; asked?: string; known?: string; did: string; model?: string | null; note?: string }

export async function holderTurnData(state: CommanderState, body: HolderTurn, turnId: string): Promise<Record<string, unknown>> {
  const held = await verifyHold(state, body.hold_token);
  const did = String(body.did ?? '').trim();
  if (!did) throw new HttpError(400, 'did required: what the holder did this turn');
  return {
    turn_id: turnId,
    by: held.harness,
    holder: held.holder,
    source: 'handoff',
    mode: 'held',
    ok: true,
    asked_sha256: await sha256Hex(String(body.asked ?? '')),
    known_sha256: await sha256Hex(String(body.known ?? '')),
    did_sha256: await sha256Hex(did),
    did_preview: did.slice(0, 200),
    model: body.model ?? null,
    note: body.note ? String(body.note).slice(0, 400) : null,
    openrouter_paused: true,
    usd: 0
  };
}

// ---------------------------------------------------------------- receipts

export const commanderSubject = (room: string): string => `commander:${room}`;
export const commanderChainKey = (room: string): string => `chain:commander:${room}`;

export type CommanderReceiptKind = 'commander.turn' | 'commander.handoff' | 'commander.release' | 'commander.kill' | 'commander.revive' | 'commander.mode' | 'commander.schedule' | 'commander.cancel' | 'commander.cap' | 'commander.remember';

export async function sealCommander(chain: EdgeReceipt[], room: string, kind: CommanderReceiptKind, data: Record<string, unknown>): Promise<EdgeReceipt> {
  return appendEdgeReceipt(chain, { kind, subject: commanderSubject(room), data });
}
