// Commander core — the pure part of the durable commander (mindship-v5c2 step 2,
// swarm-b3k7 step 6).
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
//
// swarm-b3k7 step 6 wires the OpenRouter "wire-now" capabilities on this one
// surface: every call carries app attribution (HTTP-Referer, X-Title,
// X-OpenRouter-Categories) and asks for router metadata; the request body
// passes through provider routing (order/only/ignore/sort/quantizations,
// max_price from the room cap, zdr, data_collection), plugins, reasoning,
// response_format (structured outputs), native tools[] (one execution round
// against the edge tools), model fallbacks (generate mode), session_id (sticky
// routing = the room); the call record keeps the provider and model that
// actually answered, the generation id (exact stats later), cached and
// reasoning tokens; an AbortSignal lets the kill switch abort in-flight calls.
import { HttpError, runCode, validateScript, type CodeResponse, type Executor } from './code.js';
import { type EdgeReceipt, appendEdgeReceipt, sha256Hex } from './chain.js';
import { type Env, type ToolCtx, allowlist, connectorFor, edgeTools, isAllowed, openrouterHeaders } from './tools.js';
import { z } from 'zod';

export type CommanderMode = 'bodybuilder' | 'fusion' | 'generate';
export const MODES: readonly CommanderMode[] = ['bodybuilder', 'fusion', 'generate'] as const;
export const isMode = (m: unknown): m is CommanderMode => typeof m === 'string' && (MODES as readonly string[]).includes(m);

/** Every route under /commander/:room/<action>. `state` is the bare room path. */
export type CommanderAction =
  | 'state' | 'spend' | 'turns' | 'receipts' | 'schedules' | 'memory' | 'ws' | 'swarms' | 'stats' | 'providers' | 'tools'
  | 'think' | 'turn' | 'mode' | 'handoff' | 'release' | 'kill' | 'revive' | 'schedule' | 'cancel' | 'remember' | 'cap' | 'swarm';

const READ: readonly CommanderAction[] = ['state', 'spend', 'turns', 'receipts', 'schedules', 'memory', 'ws', 'swarms', 'stats', 'providers', 'tools'] as const;
const WRITE: readonly CommanderAction[] = ['think', 'turn', 'mode', 'handoff', 'release', 'kill', 'revive', 'schedule', 'cancel', 'remember', 'cap', 'swarm'] as const;
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
  /** Prompt tokens OpenRouter served from its cache (prompt_tokens_details.cached_tokens). */
  tokens_cached: number;
  /** Reasoning tokens (completion_tokens_details.reasoning_tokens). */
  tokens_reasoning: number;
  /** Calls whose cost OpenRouter did not report (counted as 0 USD; flagged, not hidden). */
  uncounted: number;
  last_at: string | null;
  /** Optional per-request price ceiling (USD per million tokens) sent as provider.max_price. */
  max_price?: { prompt?: number; completion?: number } | null;
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
  /** Swarm runs recorded on this room (swarm-b3k7). */
  swarms?: number;
  last_swarm?: string | null;
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
    spend: { usd: 0, cap_usd: capUsd, calls: 0, tokens_in: 0, tokens_out: 0, tokens_cached: 0, tokens_reasoning: 0, uncounted: 0, last_at: null, max_price: null },
    turns: 0,
    head: null,
    last_turn: null,
    memory_notes: 0,
    swarms: 0,
    last_swarm: null
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

/** POST /cap { cap_usd } and/or { max_price: { prompt, completion } } (USD per million tokens; null clears). */
export function applyCap(state: CommanderState, cap: unknown, now: string, maxPrice?: unknown): { state: CommanderState; data: Record<string, unknown> } {
  let spend = { ...state.spend };
  const data: Record<string, unknown> = { spent: state.spend.usd };
  if (cap !== undefined) {
    const n = Number(cap);
    if (!Number.isFinite(n) || n < 0 || n > 1000) throw new HttpError(400, 'cap_usd must be a number in [0, 1000]');
    data.from = state.spend.cap_usd; data.to = n;
    spend = { ...spend, cap_usd: n };
  }
  if (maxPrice !== undefined) {
    if (maxPrice === null) spend = { ...spend, max_price: null };
    else {
      const mp = maxPrice as { prompt?: unknown; completion?: unknown };
      const out: { prompt?: number; completion?: number } = {};
      for (const k of ['prompt', 'completion'] as const) {
        if (mp[k] !== undefined) { const v = Number(mp[k]); if (!Number.isFinite(v) || v < 0) throw new HttpError(400, `max_price.${k} must be a number >= 0 (USD per million tokens)`); out[k] = v; }
      }
      spend = { ...spend, max_price: out };
    }
    data.max_price = spend.max_price;
  }
  if (cap === undefined && maxPrice === undefined) throw new HttpError(400, 'cap_usd or max_price required');
  return { state: { ...state, spend, updated_at: now }, data };
}

// ---------------------------------------------------------------- spend

export interface OpenRouterUsage {
  prompt_tokens?: number; completion_tokens?: number; total_tokens?: number; cost?: number;
  prompt_tokens_details?: { cached_tokens?: number }; completion_tokens_details?: { reasoning_tokens?: number };
}

export interface UsageCost { usd: number; tokens_in: number; tokens_out: number; counted: boolean; tokens_cached: number; tokens_reasoning: number }

/** OpenRouter reports cost when the request carries usage:{include:true}; a missing cost is counted, not hidden. */
export function usageCost(u: OpenRouterUsage | undefined): UsageCost {
  const usd = typeof u?.cost === 'number' && Number.isFinite(u.cost) ? u.cost : 0;
  return {
    usd, tokens_in: Number(u?.prompt_tokens ?? 0), tokens_out: Number(u?.completion_tokens ?? 0), counted: typeof u?.cost === 'number',
    tokens_cached: Number(u?.prompt_tokens_details?.cached_tokens ?? 0), tokens_reasoning: Number(u?.completion_tokens_details?.reasoning_tokens ?? 0)
  };
}

export function applySpend<S extends { spend: Spend; updated_at: string }>(state: S, calls: ModelCall[], now: string): S {
  const s = { ...state.spend };
  for (const c of calls) {
    s.calls += 1;
    s.usd += c.usd;
    s.tokens_in += c.tokens_in;
    s.tokens_out += c.tokens_out;
    s.tokens_cached = (s.tokens_cached ?? 0) + (c.tokens_cached ?? 0);
    s.tokens_reasoning = (s.tokens_reasoning ?? 0) + (c.tokens_reasoning ?? 0);
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
  /** Actor models (bodybuilder/fusion) or the mind + fallbacks (generate). Must be on the allowlist. */
  models?: string[];
  /** Fusion judge. Must be on the allowlist. */
  judge?: string;
  system?: string;
  max_tokens?: number;
  /** Hand a mind-authored `async () => …` script to Code Mode (default true). */
  hands?: boolean;
  /** Where the turn came from: http, ws, schedule. */
  source?: string;
  /** Use OpenRouter's own routers: fusion → openrouter/fusion, bodybuilder → openrouter/bodybuilder. */
  native?: boolean;
  /** Provider routing passthrough: { order, only, ignore, sort, quantizations, require_parameters, allow_fallbacks }. */
  provider?: Record<string, unknown>;
  /** Reasoning passthrough: { effort } | { max_tokens } | { exclude }. */
  reasoning?: Record<string, unknown>;
  /** Structured outputs: a JSON schema object → response_format { type: 'json_schema', json_schema: { name, strict, schema } }. */
  json_schema?: Record<string, unknown>;
  /** Native tool calling: expose the edge tools as tools[] and run one execution round. */
  tools?: boolean;
  plugins?: unknown[];
  /** Zero data retention / provider logging opt-out (project profile flags). */
  zdr?: boolean;
  data_collection?: 'allow' | 'deny';
  temperature?: number;
  /** Operator approval token for paid tools inside native tool calls. */
  approval?: string;
}

export interface PlannedCall { role: 'mind' | 'actor' | 'judge'; model: string }
export interface TurnPlan { mode: CommanderMode; calls: PlannedCall[]; judge: string | null; fallbacks: string[] }

export const MAX_ACTORS = 5;

export function planTurn(mode: CommanderMode, allow: string[], req: Pick<TurnRequest, 'models' | 'judge'>): TurnPlan {
  if (!allow.length) throw new HttpError(500, 'empty model allowlist (ALLOWED_MODELS)');
  const wanted = (req.models ?? []).map((m) => String(m).trim()).filter(Boolean);
  for (const m of wanted) if (!isAllowed(allow, m)) throw new HttpError(403, `model not on allowlist: ${m}`);
  // generate: the first model is the mind, the rest are OpenRouter fallbacks (body.models)
  if (mode === 'generate') return { mode, calls: [{ role: 'mind', model: wanted[0] ?? allow[0] }], judge: null, fallbacks: wanted.slice(1) };
  const actors = (wanted.length ? wanted : allow).slice(0, MAX_ACTORS);
  if (mode === 'bodybuilder') return { mode, calls: actors.map((model) => ({ role: 'actor', model })), judge: null, fallbacks: [] };
  const judge = req.judge ?? allow[allow.length - 1];
  if (!isAllowed(allow, judge)) throw new HttpError(403, `judge not on allowlist: ${judge}`);
  return { mode, calls: [...actors.map((model) => ({ role: 'actor' as const, model })), { role: 'judge', model: judge }], judge, fallbacks: [] };
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
  /** Provider and model that actually answered (router metadata), when reported. */
  provider_used: string | null;
  model_used: string | null;
  /** OpenRouter generation id: GET /api/v1/generation?id=… gives exact native cost. */
  generation_id: string | null;
  tokens_cached: number;
  tokens_reasoning: number;
  /** Native tool calls executed inside this call (tools: true). */
  tool_calls?: { name: string; ok: boolean; ms: number; error?: string }[];
}

export interface MindDeps { env: Env; fetch?: typeof fetch; now?: () => number }

export type ChatMessage = { role: 'system' | 'user' | 'assistant' | 'tool'; content: string; tool_call_id?: string; tool_calls?: unknown[] };
type ToolCallPart = { id: string; type?: string; function?: { name?: string; arguments?: string } };
type OpenRouterChat = { id?: string; model?: string; provider?: string; choices?: { message?: { content?: string; tool_calls?: ToolCallPart[] }; finish_reason?: string }[]; usage?: OpenRouterUsage; error?: unknown };

/** Per-call options: OpenRouter passthroughs (swarm-b3k7 step 6) and the abort signal. */
export interface ChatOptions {
  signal?: AbortSignal;
  /** Fallback models (OpenRouter tries them in order when the first fails). */
  models?: string[];
  provider?: Record<string, unknown>;
  plugins?: unknown[];
  reasoning?: Record<string, unknown>;
  response_format?: Record<string, unknown>;
  /** OpenAI-style tools[]; with onToolCall, one execution round runs. */
  tools?: unknown[];
  tool_choice?: unknown;
  onToolCall?: (name: string, args: unknown) => Promise<unknown>;
  /** Sticky routing: OpenRouter keeps a session on one provider. */
  session_id?: string;
  temperature?: number;
  max_price?: { prompt?: number; completion?: number } | null;
  zdr?: boolean;
  data_collection?: 'allow' | 'deny';
  title?: string;
}

export { openrouterHeaders, OPENROUTER_REFERER, OPENROUTER_CATEGORIES } from './tools.js';

/** The request body one chat completion sends: the passthroughs land here and nowhere else. */
export function chatBody(model: string, messages: ChatMessage[], maxTokens: number, opts: ChatOptions = {}): Record<string, unknown> {
  const provider: Record<string, unknown> = { ...(opts.provider ?? {}) };
  if (opts.max_price && (opts.max_price.prompt != null || opts.max_price.completion != null)) provider.max_price = opts.max_price;
  if (opts.zdr) provider.zdr = true;
  if (opts.data_collection) provider.data_collection = opts.data_collection;
  return {
    model,
    messages,
    max_tokens: maxTokens,
    usage: { include: true },
    ...(opts.models?.length ? { models: [model, ...opts.models] } : {}),
    ...(Object.keys(provider).length ? { provider } : {}),
    ...(opts.plugins?.length ? { plugins: opts.plugins } : {}),
    ...(opts.reasoning ? { reasoning: opts.reasoning } : {}),
    ...(opts.response_format ? { response_format: opts.response_format } : {}),
    ...(opts.tools?.length ? { tools: opts.tools, ...(opts.tool_choice ? { tool_choice: opts.tool_choice } : {}) } : {}),
    ...(opts.session_id ? { session_id: opts.session_id } : {}),
    ...(typeof opts.temperature === 'number' ? { temperature: opts.temperature } : {})
  };
}

/** One chat completion through OpenRouter with usage accounting on. Never throws: the call record carries the error. */
export async function chatOnce(role: ModelCall['role'], model: string, messages: ChatMessage[], deps: MindDeps, maxTokens = 2048, opts: ChatOptions = {}): Promise<{ call: ModelCall; content: string }> {
  const f = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  const started = now();
  const base: ModelCall = { role, model, ok: false, ms: 0, usd: 0, tokens_in: 0, tokens_out: 0, counted: false, content_sha256: null, error: null, provider_used: null, model_used: null, generation_id: null, tokens_cached: 0, tokens_reasoning: 0 };
  if (!deps.env.OPENROUTER_API_KEY) return { call: { ...base, ms: now() - started, error: 'OPENROUTER_API_KEY not set on worker' }, content: '' };
  const acc = { usd: 0, tokens_in: 0, tokens_out: 0, tokens_cached: 0, tokens_reasoning: 0, counted: true, any: false };
  const toolCalls: NonNullable<ModelCall['tool_calls']> = [];
  let convo = messages;
  try {
    for (let round = 0; round < 2; round++) {
      const r = await f('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: openrouterHeaders(deps.env, opts.title ?? 'TIMMY commander'),
        body: JSON.stringify(chatBody(model, convo, maxTokens, opts)),
        ...(opts.signal ? { signal: opts.signal } : {})
      });
      const j = (await r.json()) as OpenRouterChat;
      const cost = usageCost(j.usage);
      acc.usd += cost.usd; acc.tokens_in += cost.tokens_in; acc.tokens_out += cost.tokens_out; acc.tokens_cached += cost.tokens_cached; acc.tokens_reasoning += cost.tokens_reasoning;
      acc.counted = acc.counted && cost.counted; acc.any = true;
      const meta = { provider_used: j.provider ?? null, model_used: j.model ?? null, generation_id: j.id ?? null };
      if (!r.ok) return { call: { ...base, ...meta, ms: now() - started, usd: acc.usd, tokens_in: acc.tokens_in, tokens_out: acc.tokens_out, tokens_cached: acc.tokens_cached, tokens_reasoning: acc.tokens_reasoning, counted: acc.counted, error: `upstream ${r.status}: ${JSON.stringify(j.error ?? j).slice(0, 300)}` }, content: '' };
      const msg = j.choices?.[0]?.message;
      const wanted = Array.isArray(msg?.tool_calls) ? msg!.tool_calls! : [];
      if (wanted.length && opts.onToolCall && round === 0) {
        // one execution round: run every requested tool, feed the results back, ask once more
        const results: ChatMessage[] = [];
        for (const tc of wanted) {
          const name = tc.function?.name ?? '';
          const t0 = now();
          let args: unknown = {};
          try { args = tc.function?.arguments ? JSON.parse(tc.function.arguments) : {}; } catch { args = {}; }
          try {
            const out = await opts.onToolCall(name, args);
            toolCalls.push({ name, ok: true, ms: now() - t0 });
            results.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(out ?? null).slice(0, 20000) });
          } catch (e) {
            const err = e instanceof Error ? e.message : String(e);
            toolCalls.push({ name, ok: false, ms: now() - t0, error: err });
            results.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify({ error: err }) });
          }
        }
        convo = [...convo, { role: 'assistant', content: msg?.content ?? '', tool_calls: wanted }, ...results];
        continue;
      }
      const content = msg?.content ?? '';
      return { call: { ...base, ...meta, ok: true, ms: now() - started, usd: Math.round(acc.usd * 1e6) / 1e6, tokens_in: acc.tokens_in, tokens_out: acc.tokens_out, tokens_cached: acc.tokens_cached, tokens_reasoning: acc.tokens_reasoning, counted: acc.counted, content_sha256: await sha256Hex(content), ...(toolCalls.length ? { tool_calls: toolCalls } : {}) }, content };
    }
    return { call: { ...base, ms: now() - started, usd: acc.usd, tokens_in: acc.tokens_in, tokens_out: acc.tokens_out, counted: acc.counted, error: 'tool round did not converge', tool_calls: toolCalls }, content: '' };
  } catch (e) {
    const aborted = opts.signal?.aborted || (e instanceof Error && e.name === 'AbortError');
    return { call: { ...base, ms: now() - started, error: aborted ? 'aborted: kill switch' : e instanceof Error ? e.message : String(e) }, content: '' };
  }
}

/** The edge tools as OpenAI-style tools[] for native tool calling. */
export function nativeTools(): unknown[] {
  return edgeTools().map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: z.toJSONSchema(t.input) } }));
}

/** GET /api/v1/generation?id=… — exact native cost and provider for one call (generation-stats). */
export async function generationStats(env: Env, id: string, f: typeof fetch = fetch): Promise<Record<string, unknown>> {
  if (!env.OPENROUTER_API_KEY) return { id, error: 'OPENROUTER_API_KEY not set on worker' };
  try {
    const r = await f(`https://openrouter.ai/api/v1/generation?id=${encodeURIComponent(id)}`, { headers: openrouterHeaders(env, 'TIMMY commander stats') });
    const j = (await r.json()) as { data?: Record<string, unknown>; error?: unknown };
    if (!r.ok) return { id, error: `upstream ${r.status}: ${JSON.stringify(j.error ?? j).slice(0, 200)}` };
    const d = j.data ?? {};
    return { id, model: d.model ?? null, provider: d.provider_name ?? null, total_cost: d.total_cost ?? null, native_tokens_prompt: d.native_tokens_prompt ?? null, native_tokens_completion: d.native_tokens_completion ?? null, native_tokens_reasoning: d.native_tokens_reasoning ?? null, cache_discount: d.cache_discount ?? null, latency_ms: d.latency ?? null, generation_time_ms: d.generation_time ?? null, finish_reason: d.finish_reason ?? null, created_at: d.created_at ?? null };
  } catch (e) {
    return { id, error: e instanceof Error ? e.message : String(e) };
  }
}

/** GET /api/v1/providers — the live provider list (providers-list). */
export async function providersList(env: Env, f: typeof fetch = fetch): Promise<Record<string, unknown>> {
  if (!env.OPENROUTER_API_KEY) return { ok: false, error: 'OPENROUTER_API_KEY not set on worker' };
  const r = await f('https://openrouter.ai/api/v1/providers', { headers: openrouterHeaders(env, 'TIMMY commander providers') });
  const j = (await r.json()) as { data?: { name?: string; slug?: string; privacy_policy_url?: string; terms_of_service_url?: string; status_page_url?: string }[]; error?: unknown };
  if (!r.ok) return { ok: false, error: `upstream ${r.status}: ${JSON.stringify(j.error ?? j).slice(0, 200)}` };
  const providers = (j.data ?? []).map((p) => ({ name: p.name ?? null, slug: p.slug ?? null, privacy_policy: p.privacy_policy_url ?? null, terms: p.terms_of_service_url ?? null, status: p.status_page_url ?? null }));
  return { ok: true, count: providers.length, providers, sha256: await sha256Hex(JSON.stringify(providers)) };
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

/** Turn-level options → per-call options (the room's session id and price ceiling ride along). */
export function chatOptionsFor(req: TurnRequest, room: string | null, spend: Pick<Spend, 'max_price'> | null, signal?: AbortSignal, fallbacks: string[] = [], onToolCall?: ChatOptions['onToolCall']): ChatOptions {
  return {
    ...(signal ? { signal } : {}),
    ...(fallbacks.length ? { models: fallbacks } : {}),
    ...(req.provider ? { provider: req.provider } : {}),
    ...(req.plugins?.length ? { plugins: req.plugins } : {}),
    ...(req.reasoning ? { reasoning: req.reasoning } : {}),
    ...(req.json_schema ? { response_format: { type: 'json_schema', json_schema: { name: 'answer', strict: true, schema: req.json_schema } } } : {}),
    ...(req.tools ? { tools: nativeTools(), ...(onToolCall ? { onToolCall } : {}) } : {}),
    ...(room ? { session_id: `commander:${room}` } : {}),
    ...(typeof req.temperature === 'number' ? { temperature: req.temperature } : {}),
    ...(spend?.max_price ? { max_price: spend.max_price } : {}),
    ...(req.zdr ? { zdr: true } : {}),
    ...(req.data_collection ? { data_collection: req.data_collection } : {})
  };
}

// ---------------------------------------------------------------- the turn

export interface TurnDeps extends MindDeps {
  /** Code Mode executor (DynamicWorkerExecutor in production). Absent = hands unavailable, recorded as such. */
  executor?: Executor;
  /** The room name (sticky routing session id) — null outside a room. */
  room?: string | null;
  /** The room's spend (price ceiling). */
  spend?: Pick<Spend, 'max_price'> | null;
  signal?: AbortSignal;
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
  /** OpenRouter's own router did the fan-out / fusion. */
  native: boolean;
}

export const newTurnId = (now: number): string => `turn_${now.toString(36)}_${Math.random().toString(36).slice(2, 6)}`;

export const NATIVE_FUSION = 'openrouter/fusion';
export const NATIVE_BODYBUILDER = 'openrouter/bodybuilder';

/** A tool-call executor over the edge tools for native tools[] (gated like Code Mode: paid tools need the approval token). */
export function edgeToolRunner(env: Env, approval: string | undefined, f?: typeof fetch): { run: ChatOptions['onToolCall']; calls: ToolCtx['calls'] } {
  const ctx: ToolCtx = { env, approval, calls: [], chain: [], runId: `native_${Date.now().toString(36)}`, fetch: f };
  const connector = connectorFor(ctx, edgeTools());
  return { run: async (name, args) => { const fn = connector.fns[name]; if (!fn) throw new Error(`unknown tool ${name}`); return fn(args); }, calls: ctx.calls };
}

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
  const tools = req.tools ? edgeToolRunner(deps.env, req.approval, deps.fetch) : null;
  const opts = chatOptionsFor(req, deps.room ?? null, deps.spend ?? null, deps.signal, plan.fallbacks, tools?.run);
  const native = !!req.native && mode !== 'generate';

  let calls: ModelCall[] = [];
  let outputs: TurnResult['outputs'] = [];
  let answer = '';

  if (native && mode === 'fusion') {
    // server-tool-fusion: OpenRouter's fusion router runs the analysis models and the merge itself
    const j = await chatOnce('judge', NATIVE_FUSION, [{ role: 'system', content: system }, { role: 'user', content: task }], deps, maxTokens, { ...opts, models: undefined });
    calls = [j.call];
    outputs = [{ role: 'judge', model: NATIVE_FUSION, content: j.content }];
    answer = j.content;
  } else if (native && mode === 'bodybuilder') {
    // body-builder: the router writes the request bodies, the commander runs the ones on the allowlist
    const b = await chatOnce('mind', NATIVE_BODYBUILDER, [{ role: 'system', content: system }, { role: 'user', content: task }], deps, maxTokens, { ...opts, models: undefined });
    calls = [b.call];
    const reqs = parseBodybuilder(b.content);
    outputs = [{ role: 'mind', model: NATIVE_BODYBUILDER, content: b.content }];
    const runnable = reqs.filter((r) => isAllowed(allow, r.model)).slice(0, MAX_ACTORS);
    const results = await Promise.all(runnable.map((r) => chatOnce('actor', r.model, r.messages.length ? r.messages : [{ role: 'user', content: task }], deps, maxTokens, opts)));
    calls.push(...results.map((r) => r.call));
    outputs.push(...results.map((r, i) => ({ role: 'actor' as const, model: runnable[i].model, content: r.content })));
    const skipped = reqs.filter((r) => !isAllowed(allow, r.model)).map((r) => r.model);
    answer = results.map((r, i) => `[${i + 1}] ${runnable[i].model}\n${r.content.trim()}`).join('\n\n') + (skipped.length ? `\n\n(not on the allowlist, not run: ${skipped.join(', ')})` : '');
  } else {
    const actorCalls = plan.calls.filter((c) => c.role !== 'judge');
    const results = await Promise.all(actorCalls.map((c) => chatOnce(c.role, c.model, [{ role: 'system', content: system }, { role: 'user', content: task }], deps, maxTokens, opts)));
    calls = results.map((r) => r.call);
    outputs = results.map((r, i) => ({ role: actorCalls[i].role, model: actorCalls[i].model, content: r.content }));
    if (mode === 'generate') {
      answer = outputs[0]?.content ?? '';
    } else if (mode === 'bodybuilder') {
      answer = outputs.map((o, i) => `[${i + 1}] ${o.model}\n${o.content.trim()}`).join('\n\n');
    } else {
      const good = outputs.filter((o, i) => calls[i].ok && o.content.trim());
      if (good.length) {
        const j = await chatOnce('judge', plan.judge as string, [{ role: 'system', content: JUDGE_SYSTEM }, { role: 'user', content: fusionPrompt(task, good) }], deps, maxTokens, { ...opts, tools: undefined, onToolCall: undefined, response_format: undefined });
        calls.push(j.call);
        outputs.push({ role: 'judge', model: plan.judge as string, content: j.content });
        answer = j.content;
      }
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
    ms: now() - started,
    native
  };
}

/** openrouter/bodybuilder answers with the request bodies to run: {"requests":[{model, messages}]}. Tolerates fences and a bare array. */
export function parseBodybuilder(text: string): { model: string; messages: ChatMessage[] }[] {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = (fenced ? fenced[1] : text).trim();
  const i = Math.min(...[body.indexOf('{'), body.indexOf('[')].filter((n) => n >= 0));
  if (!Number.isFinite(i)) return [];
  let v: unknown;
  try { v = JSON.parse(body.slice(i, Math.max(body.lastIndexOf('}'), body.lastIndexOf(']')) + 1)); } catch { return []; }
  const list = Array.isArray(v) ? v : Array.isArray((v as { requests?: unknown })?.requests) ? (v as { requests: unknown[] }).requests : [];
  return list
    .filter((r): r is { model: string; messages?: unknown } => !!r && typeof r === 'object' && typeof (r as { model?: unknown }).model === 'string')
    .map((r) => ({ model: r.model, messages: Array.isArray(r.messages) ? (r.messages as ChatMessage[]).filter((m) => m && typeof m.content === 'string' && ['system', 'user', 'assistant'].includes(String(m.role))) : [] }));
}

/** Receipt data for a mind turn: hashes and numbers, never the full texts (those live in the room's turns table). */
export async function turnReceiptData(req: TurnRequest, r: TurnResult, by: string): Promise<Record<string, unknown>> {
  return {
    turn_id: r.turn_id,
    by,
    source: req.source ?? 'http',
    mode: r.mode,
    native: r.native,
    ok: r.ok,
    task_sha256: await sha256Hex(String(req.task ?? '')),
    answer_sha256: await sha256Hex(r.answer),
    models: r.calls.map((c) => ({ role: c.role, model: c.model, ok: c.ok, ms: c.ms, usd: c.usd, tokens_in: c.tokens_in, tokens_out: c.tokens_out, tokens_cached: c.tokens_cached, tokens_reasoning: c.tokens_reasoning, counted: c.counted, provider_used: c.provider_used, model_used: c.model_used, generation_id: c.generation_id, tool_calls: c.tool_calls?.length ?? 0, error: c.error })),
    passthrough: { provider: !!req.provider, reasoning: !!req.reasoning, json_schema: !!req.json_schema, tools: !!req.tools, plugins: req.plugins?.length ?? 0, zdr: !!req.zdr, data_collection: req.data_collection ?? null, fallbacks: r.mode === 'generate' ? Math.max(0, (req.models?.length ?? 1) - 1) : 0 },
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

export type CommanderReceiptKind = 'commander.turn' | 'commander.handoff' | 'commander.release' | 'commander.kill' | 'commander.revive' | 'commander.mode' | 'commander.schedule' | 'commander.cancel' | 'commander.cap' | 'commander.remember' | 'swarm.member' | 'swarm.run' | 'swarm.kill';

export async function sealCommander(chain: EdgeReceipt[], room: string, kind: CommanderReceiptKind, data: Record<string, unknown>): Promise<EdgeReceipt> {
  return appendEdgeReceipt(chain, { kind, subject: commanderSubject(room), data });
}
