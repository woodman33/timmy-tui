// Swarm core — the pure part of the swarm runtime (ORDER swarm-b3k7 steps 1, 2, 5).
//
// A swarm is one task run by N MEMBERS under one TOPOLOGY, one BUDGET, one
// JUDGE tier and one NETWORK policy. The spec shape is lanes/swarm/schemas/
// swarm.cue; parseSwarmSpec() is its TypeScript mirror and is applied to every
// body the durable commander accepts. Nothing here touches storage or the
// network directly: members are called through an injected MemberExecutor
// (the commander's executor speaks OpenRouter and Durable-Object MCP; the
// local lane's executor speaks Ollama slots, harnesses and Timmys over HTTPS),
// so the same topology code runs at the edge and on the operator's machine.
//
// Topologies:
//   fanout       every member answers; every answer is kept
//   fusion       fanout, then one judge merges
//   relay        a handoff chain: each member improves the previous answer
//   coordinator  the judge splits the task, members take a part, the judge composes
//   tournament   N candidates; the judge picks ONE; the losers are recorded, not dropped
//   council      R rounds of positions, then a weighted vote (no self-votes); ties → judge
//   crew         harness members with roles from harness.abilities; the judge plans + composes
//   closed       fanout+fusion over local members only, deny-all egress, no hands
//
// The cost governor stops issuing calls the moment the swarm's budget (usd,
// calls, wall time) is spent, or the room's kill switch fires: members that
// never ran are recorded as killed with the reason. The swarm.run receipt
// cites every member's receipt (the caller seals members as it runs them).
import { HttpError } from './code.js';
import { sha256Hex as sha256HexOf } from './chain.js';
import { type ModelCall } from './commander-core.js';

export type Topology = 'fanout' | 'fusion' | 'relay' | 'coordinator' | 'tournament' | 'council' | 'crew' | 'closed';
export const TOPOLOGIES: readonly Topology[] = ['fanout', 'fusion', 'relay', 'coordinator', 'tournament', 'council', 'crew', 'closed'] as const;
export type MemberKind = 'model' | 'harness' | 'timmy';
export type SwarmNode = 'edge' | 'mac' | 'spark1' | 'spark2' | 'spark3';
export type Sandbox = 'none' | 'openhands' | 'sbx' | 'closed';
export type JudgeTier = 'local' | 'edge' | 'frontier';
export type NetworkPolicy = 'open' | 'tailnet' | 'closed';
export const HARNESSES = ['jcode', 'opencode', 'pi', 'hermes', 'openhands', 'minds'] as const;

export interface SwarmMember {
  id: string;
  kind: MemberKind;
  node: SwarmNode;
  sandbox: Sandbox;
  weight: number;
  role?: string;
  model?: string;
  provider?: string;
  harness?: string;
  room?: string;
}

export interface SwarmSpec {
  v: 1;
  id: string;
  preset?: string;
  topology: Topology;
  members: SwarmMember[];
  size: number;
  budget: { usd: number; max_calls: number; max_ms: number };
  judge: { tier: JudgeTier; model?: string };
  network: { policy: NetworkPolicy; egress_allow: string[] };
  rounds: number;
  note?: string;
}

const ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const MEMBER_ID_RE = /^[a-z0-9][a-z0-9._:-]{0,39}$/;
const ROOM_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;
const ROLE_RE = /^[a-z][a-z0-9-]{0,23}$/;
const bad = (m: string): never => { throw new HttpError(400, `swarm spec: ${m}`); };

/** The TypeScript mirror of lanes/swarm/schemas/swarm.cue. Throws HttpError(400) with the CUE constraint that failed. */
export function parseSwarmSpec(raw: unknown): SwarmSpec {
  if (!raw || typeof raw !== 'object') bad('object required');
  const o = raw as Record<string, unknown>;
  if (o.v !== 1) bad('v must be 1');
  if (typeof o.id !== 'string' || !ID_RE.test(o.id)) bad('id must match ^[a-z0-9][a-z0-9._-]{0,63}$');
  if (!TOPOLOGIES.includes(o.topology as Topology)) bad(`topology must be one of ${TOPOLOGIES.join(', ')}`);
  const topology = o.topology as Topology;
  if (!Array.isArray(o.members) || o.members.length < 1 || o.members.length > 32) bad('members: 1..32 entries');
  const members: SwarmMember[] = (o.members as unknown[]).map((raw, i) => {
    if (!raw || typeof raw !== 'object') bad(`members[${i}] must be an object`);
    const m = raw as Record<string, unknown>;
    if (typeof m.id !== 'string' || !MEMBER_ID_RE.test(m.id)) bad(`members[${i}].id must match ^[a-z0-9][a-z0-9._:-]{0,39}$`);
    if (!['model', 'harness', 'timmy'].includes(String(m.kind))) bad(`members[${i}].kind must be model | harness | timmy`);
    const kind = m.kind as MemberKind;
    const node = (m.node ?? 'edge') as SwarmNode;
    if (!['edge', 'mac', 'spark1', 'spark2', 'spark3'].includes(node)) bad(`members[${i}].node must be edge | mac | spark1 | spark2 | spark3`);
    const sandbox = (m.sandbox ?? 'none') as Sandbox;
    if (!['none', 'openhands', 'sbx', 'closed'].includes(sandbox)) bad(`members[${i}].sandbox must be none | openhands | sbx | closed`);
    const weight = m.weight == null ? 1 : Number(m.weight);
    if (!Number.isInteger(weight) || weight < 1 || weight > 5) bad(`members[${i}].weight must be an integer in [1, 5]`);
    if (m.role != null && (typeof m.role !== 'string' || !ROLE_RE.test(m.role))) bad(`members[${i}].role must match ^[a-z][a-z0-9-]{0,23}$`);
    const out: SwarmMember = { id: String(m.id), kind, node, sandbox, weight, ...(m.role ? { role: String(m.role) } : {}) };
    if (kind === 'model') {
      if (typeof m.model !== 'string' || !m.model) bad(`members[${i}].model required for kind model`);
      const provider = String(m.provider ?? 'openrouter');
      if (!(provider === 'openrouter' || provider === 'ollama-cloud' || /^ollama:(mac|spark[123])$/.test(provider))) bad(`members[${i}].provider must be openrouter | ollama-cloud | ollama:<mac|spark1|spark2|spark3>`);
      out.model = String(m.model); out.provider = provider;
    } else if (kind === 'harness') {
      if (!(HARNESSES as readonly string[]).includes(String(m.harness))) bad(`members[${i}].harness must be one of ${HARNESSES.join(', ')}`);
      if (node === 'edge') bad(`members[${i}]: a harness never runs at the edge (node must be mac | spark1 | spark2 | spark3)`);
      out.harness = String(m.harness);
      if (m.model != null) out.model = String(m.model);
    } else {
      if (typeof m.room !== 'string' || !ROOM_RE.test(m.room)) bad(`members[${i}].room required for kind timmy (a Durable Object room name)`);
      if (node !== 'edge') bad(`members[${i}]: a timmy member runs at the edge`);
      out.room = String(m.room);
    }
    return out;
  });
  const ids = new Set(members.map((m) => m.id));
  if (ids.size !== members.length) bad('member ids must be unique');
  if (o.size != null && Number(o.size) !== members.length) bad(`size (${String(o.size)}) must equal len(members) (${members.length})`);
  const b = (o.budget ?? {}) as Record<string, unknown>;
  const usd = Number(b.usd);
  if (!Number.isFinite(usd) || usd < 0) bad('budget.usd must be a number >= 0');
  const max_calls = b.max_calls == null ? 64 : Number(b.max_calls);
  if (!Number.isInteger(max_calls) || max_calls < 1) bad('budget.max_calls must be an integer >= 1');
  const max_ms = b.max_ms == null ? 600000 : Number(b.max_ms);
  if (!Number.isInteger(max_ms) || max_ms < 1000) bad('budget.max_ms must be an integer >= 1000');
  const j = (o.judge ?? {}) as Record<string, unknown>;
  if (!['local', 'edge', 'frontier'].includes(String(j.tier))) bad('judge.tier must be local | edge | frontier');
  const judge: SwarmSpec['judge'] = { tier: j.tier as JudgeTier, ...(j.model ? { model: String(j.model) } : {}) };
  const n = (o.network ?? {}) as Record<string, unknown>;
  if (!['open', 'tailnet', 'closed'].includes(String(n.policy))) bad('network.policy must be open | tailnet | closed');
  const egress_allow = Array.isArray(n.egress_allow) ? n.egress_allow.map(String) : [];
  const rounds = o.rounds == null ? 2 : Number(o.rounds);
  if (!Number.isInteger(rounds) || rounds < 1 || rounds > 6) bad('rounds must be an integer in [1, 6]');
  const network = { policy: n.policy as NetworkPolicy, egress_allow };

  // cross-field constraints, same as the CUE conditionals
  if (topology === 'closed' || network.policy === 'closed') {
    if (topology !== 'closed') bad('network.policy closed requires topology closed');
    if (network.policy !== 'closed') bad('topology closed requires network.policy closed');
    if (egress_allow.length) bad('a closed swarm has an empty egress_allow');
    if (judge.tier !== 'local') bad('a closed swarm needs judge.tier local');
    for (const m of members) {
      if (m.sandbox !== 'closed') bad(`closed swarm: member ${m.id} must have sandbox closed`);
      if (m.kind === 'model' && !String(m.provider).startsWith('ollama:')) bad(`closed swarm: member ${m.id} must use an ollama:<node> provider`);
      if (m.kind === 'timmy') bad(`closed swarm: member ${m.id} (timmy) would leave the air gap`);
    }
  }
  if (['fusion', 'tournament', 'coordinator', 'crew'].includes(topology) && !judge.model) bad(`topology ${topology} needs judge.model`);
  if (topology === 'council' && members.length < 3) bad('a council needs at least 3 members');
  if (topology === 'council' && rounds < 2) bad('a council needs at least 2 rounds');
  if ((topology === 'relay' || topology === 'tournament') && members.length < 2) bad(`a ${topology} needs at least 2 members`);
  return {
    v: 1, id: String(o.id), ...(o.preset ? { preset: String(o.preset) } : {}), topology, members, size: members.length,
    budget: { usd, max_calls, max_ms }, judge, network, rounds, ...(o.note ? { note: String(o.note).slice(0, 400) } : {})
  };
}

// ---------------------------------------------------------------- members

export type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string };

/** One member's answer to one prompt: the model call record plus the text. */
export interface MemberCall extends ModelCall {
  member: string;
  kind: MemberKind;
  content: string;
  /** Receipt hash the caller sealed for this call (filled by the caller). */
  receipt: string | null;
  /** answer, relay, judge, coordinate, work, compose, candidate, pick, position, vote, tiebreak, plan */
  phase?: string;
  round?: number;
  /** Never ran: the governor or the kill switch stopped it; `error` says why. */
  killed?: boolean;
  /** Crew role, or `judge` for the judge's own calls. */
  crew_role?: string;
  /** A receipt the member sealed on its own chain (a Timmy's turn receipt, a harness run). */
  receipt_external?: string | null;
}

export interface CallOpts {
  maxTokens: number;
  signal?: AbortSignal;
  /** Ask for a JSON object (structured outputs where the provider supports it). */
  json?: boolean;
  /** Phase label for receipts: answer, relay, judge, coordinate, compose, vote, plan … */
  phase: string;
  round?: number;
}

/** Executes one member call. Never throws: failures come back as ok:false with an error. */
export type MemberExecutor = (member: SwarmMember, messages: ChatMessage[], opts: CallOpts) => Promise<MemberCall>;

/** Executes one judge call (the swarm's judge.model on the judge tier). Never throws. */
export type JudgeExecutor = (messages: ChatMessage[], opts: CallOpts) => Promise<MemberCall>;

/** Measured abilities per harness (lanes/abilities/results/<harness>.json → abilities[k].value). */
export type Abilities = Record<string, Partial<Record<'one_shot' | 'file_edits' | 'tool_use' | 'mcp_client' | 'browser' | 'sandbox', boolean>>>;

export interface SwarmDeps {
  exec: MemberExecutor;
  judge: JudgeExecutor;
  now?: () => number;
  signal?: AbortSignal;
  abilities?: Abilities;
  /** Room-level gate, checked before every call (kill switch, hold). Returns a reason or null. */
  gate?: () => string | null;
  maxTokens?: number;
}

// ---------------------------------------------------------------- governor

export interface BudgetLedger { usd: number; spent: number; max_calls: number; calls: number; max_ms: number; ms: number; exhausted: string | null; kills: { member: string; phase: string; reason: string }[] }

export class Governor {
  readonly ledger: BudgetLedger;
  private readonly started: number;
  constructor(readonly spec: SwarmSpec, private readonly now: () => number, private readonly gate?: () => string | null, private readonly signal?: AbortSignal) {
    this.started = now();
    this.ledger = { usd: spec.budget.usd, spent: 0, max_calls: spec.budget.max_calls, calls: 0, max_ms: spec.budget.max_ms, ms: 0, exhausted: null, kills: [] };
  }
  /** Why the next call may not run, or null. The first reason found is sticky as `exhausted`. */
  allow(): string | null {
    const l = this.ledger;
    l.ms = this.now() - this.started;
    let reason: string | null = null;
    if (this.signal?.aborted) reason = 'killed: aborted';
    else if (this.gate) { const g = this.gate(); if (g) reason = `killed: ${g}`; }
    if (!reason && l.usd > 0 && l.spent >= l.usd) reason = `budget: ${l.spent.toFixed(4)} USD of ${l.usd} USD spent`;
    if (!reason && l.calls >= l.max_calls) reason = `budget: ${l.calls} of ${l.max_calls} calls used`;
    if (!reason && l.ms >= l.max_ms) reason = `budget: ${l.ms} ms of ${l.max_ms} ms used`;
    if (reason && !l.exhausted) l.exhausted = reason;
    return reason;
  }
  record(c: MemberCall): void {
    this.ledger.calls += 1;
    this.ledger.spent = Math.round((this.ledger.spent + c.usd) * 1e6) / 1e6;
    this.ledger.ms = this.now() - this.started;
  }
  kill(member: string, phase: string, reason: string): void {
    this.ledger.kills.push({ member, phase, reason });
  }
}

const killedCall = (m: SwarmMember, phase: string, reason: string, round?: number): MemberCall => ({
  role: 'actor', model: m.model ?? m.harness ?? m.room ?? m.id, ok: false, ms: 0, usd: 0, tokens_in: 0, tokens_out: 0, counted: true,
  content_sha256: null, error: reason, provider_used: null, model_used: null, generation_id: null, tokens_cached: 0, tokens_reasoning: 0,
  member: m.id, kind: m.kind, content: '', receipt: null, phase, ...(round != null ? { round } : {}), killed: true
});

// ---------------------------------------------------------------- prompts

const ANSWER_SYSTEM = 'You are one member of a TIMMY swarm. Answer the task directly and concretely. Output the answer only.';
const RELAY_SYSTEM = 'You are one link in a relay. You receive the task and the previous link\'s answer. Improve it: fix what is wrong, add what is missing, keep what is right. Output the improved answer only.';
const FUSION_SYSTEM = 'You are the swarm judge. You receive one task and several candidate answers. Produce the single best answer: merge what is right, drop what is wrong, and say in one line at the end which candidates you drew on. Output the answer only.';
const PICK_SYSTEM = 'You are the tournament judge. You receive one task and numbered candidate answers. Pick exactly one winner. Reply with ONLY a JSON object: {"winner": <candidate number>, "reason": "<one line>"}.';
const COUNCIL_OPEN_SYSTEM = 'You are one seat on a council. State your position on the task in at most 200 words. Output the position only.';
const COUNCIL_VOTE_SYSTEM = 'You are one seat on a council. You receive the task, every seat\'s current position (including yours), and the list of seat ids. Restate your position (you may change it after reading the others), then vote for the ONE seat whose position is best — you may NOT vote for yourself. Reply with ONLY a JSON object: {"position": "<your position>", "vote": "<seat id>", "why": "<one line>"}.';
const COORD_PLAN_SYSTEM = 'You are the coordinator of a swarm. Split the task into one focused subtask per worker so the parts compose into a complete answer. Reply with ONLY a JSON object: {"assignments": [{"member": "<member id>", "subtask": "<what that worker does>"}]} using every member id given, each exactly once.';
const COORD_COMPOSE_SYSTEM = 'You are the coordinator of a swarm. You receive the task and each worker\'s answer to its subtask. Compose the single complete answer to the task. Output the answer only.';
const CREW_PLAN_SYSTEM = 'You are the crew lead. Each crew member is an agent harness with a role and measured abilities. Give every member one instruction that fits its role, so the crew completes the task together. Reply with ONLY a JSON object: {"assignments": [{"member": "<member id>", "instruction": "<what it does>"}]} using every member id given, each exactly once.';
const CREW_COMPOSE_SYSTEM = 'You are the crew lead. You receive the task, the roles, and what each member did. Write the crew\'s report: what was done, by whom, what is left. Output the report only.';

export function candidatesBlock(task: string, outputs: { id: string; content: string }[]): string {
  const parts = outputs.map((o, i) => `--- candidate ${i + 1} (${o.id}) ---\n${o.content.trim() || '(empty)'}`);
  return `TASK:\n${task}\n\n${parts.join('\n\n')}`;
}

/** First JSON object in a model reply, tolerating fences and prose around it. */
export function firstJson(text: string): Record<string, unknown> | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : text;
  const i = body.indexOf('{');
  const k = body.lastIndexOf('}');
  if (i < 0 || k < i) return null;
  try { const v = JSON.parse(body.slice(i, k + 1)); return v && typeof v === 'object' ? (v as Record<string, unknown>) : null; } catch { return null; }
}

// ---------------------------------------------------------------- roles (crew)

export const ROLE_OF: readonly { role: string; needs: (keyof Abilities[string])[] }[] = [
  { role: 'builder', needs: ['file_edits', 'tool_use'] },
  { role: 'operator', needs: ['sandbox', 'tool_use'] },
  { role: 'bridge', needs: ['mcp_client'] },
  { role: 'scout', needs: ['browser'] },
  { role: 'editor', needs: ['file_edits'] },
  { role: 'answerer', needs: ['one_shot'] }
];

/** The crew role a harness earns from what it was measured to do (first match wins), or `unmeasured`. */
export function roleFor(harness: string, abilities?: Abilities): string {
  const a = abilities?.[harness];
  if (!a) return 'unmeasured';
  for (const r of ROLE_OF) if (r.needs.every((k) => a[k] === true)) return r.role;
  return 'unmeasured';
}

// ---------------------------------------------------------------- the run

export interface RoundRecord { round: number; phase: string; calls: { member: string; ok: boolean; vote?: string | null; content_sha256: string | null }[] }

export interface SwarmResult {
  swarm_id: string;
  run_id: string;
  topology: Topology;
  size: number;
  ok: boolean;
  answer: string;
  /** Every member/judge call in the order it ran (each one is sealed as its own receipt by the caller). */
  calls: MemberCall[];
  rounds: RoundRecord[];
  winner: string | null;
  losers: string[];
  votes: Record<string, number> | null;
  roles: Record<string, string> | null;
  assignments: Record<string, string> | null;
  budget: BudgetLedger;
  usd: number;
  ms: number;
}

export const newSwarmRunId = (now: number): string => `swarm_${now.toString(36)}_${Math.random().toString(36).slice(2, 6)}`;

export async function runSwarm(spec: SwarmSpec, task: string, deps: SwarmDeps): Promise<SwarmResult> {
  const now = deps.now ?? Date.now;
  const started = now();
  const t = String(task ?? '').trim();
  if (!t) throw new HttpError(400, 'task required');
  if (t.length > 20000) throw new HttpError(400, 'task too long');
  const gov = new Governor(spec, now, deps.gate, deps.signal);
  const calls: MemberCall[] = [];
  const rounds: RoundRecord[] = [];
  const maxTokens = deps.maxTokens ?? 2048;
  const run_id = newSwarmRunId(started);

  const call = async (m: SwarmMember, messages: ChatMessage[], phase: string, json = false, round?: number): Promise<MemberCall> => {
    const why = gov.allow();
    let c: MemberCall;
    if (why) { gov.kill(m.id, phase, why); c = killedCall(m, phase, why, round); }
    else {
      c = await deps.exec(m, messages, { maxTokens, signal: deps.signal, json, phase, round });
      c = { ...c, member: m.id, kind: m.kind, phase, ...(round != null ? { round } : {}) };
      gov.record(c);
    }
    calls.push(c);
    return c;
  };
  const judgeMember: SwarmMember = { id: 'judge', kind: 'model', node: spec.judge.tier === 'edge' ? 'edge' : 'mac', sandbox: 'none', weight: 1, model: spec.judge.model, provider: spec.judge.tier === 'edge' ? 'openrouter' : 'ollama:mac' };
  const judge = async (messages: ChatMessage[], phase: string, json = false, round?: number): Promise<MemberCall> => {
    const why = gov.allow();
    let c: MemberCall;
    if (why) { gov.kill('judge', phase, why); c = killedCall(judgeMember, phase, why, round); }
    else {
      c = await deps.judge(messages, { maxTokens, signal: deps.signal, json, phase, round });
      c = { ...c, member: 'judge', kind: 'model', crew_role: 'judge', phase, ...(round != null ? { round } : {}) };
      gov.record(c);
    }
    calls.push(c);
    return c;
  };
  const ask = (m: SwarmMember, user: string, system = ANSWER_SYSTEM): ChatMessage[] => [{ role: 'system', content: system }, { role: 'user', content: user }];
  const good = (cs: MemberCall[]): MemberCall[] => cs.filter((c) => c.ok && c.content.trim());
  const fanout = (phase = 'answer', prompt = t): Promise<MemberCall[]> => Promise.all(spec.members.map((m) => call(m, ask(m, prompt), phase)));

  let answer = '';
  let winner: string | null = null;
  let losers: string[] = [];
  let votes: Record<string, number> | null = null;
  let roles: Record<string, string> | null = null;
  let assignments: Record<string, string> | null = null;

  switch (spec.topology) {
    case 'fanout': {
      const outs = await fanout();
      answer = outs.map((c, i) => `[${i + 1}] ${c.member}${c.ok ? '' : ' (failed)'}\n${c.content.trim() || c.error || ''}`).join('\n\n');
      break;
    }
    case 'closed':
    case 'fusion': {
      const outs = await fanout();
      const g = good(outs);
      if (g.length) {
        const j = await judge([{ role: 'system', content: FUSION_SYSTEM }, { role: 'user', content: candidatesBlock(t, g.map((c) => ({ id: c.member, content: c.content }))) }], 'judge');
        answer = j.ok ? j.content : g.map((c, i) => `[${i + 1}] ${c.member}\n${c.content.trim()}`).join('\n\n');
      }
      break;
    }
    case 'relay': {
      let prev: MemberCall | null = null;
      for (const m of spec.members) {
        const user = prev ? `TASK:\n${t}\n\nPREVIOUS LINK (${prev.member}):\n${prev.content.trim()}` : `TASK:\n${t}`;
        const c = await call(m, ask(m, user, prev ? RELAY_SYSTEM : ANSWER_SYSTEM), 'relay');
        if (c.ok && c.content.trim()) prev = c; // a broken link is skipped, the chain continues from the last good one
      }
      answer = prev?.content ?? '';
      winner = prev?.member ?? null;
      break;
    }
    case 'coordinator': {
      const ids = spec.members.map((m) => m.id);
      const plan = await judge([{ role: 'system', content: COORD_PLAN_SYSTEM }, { role: 'user', content: `TASK:\n${t}\n\nMEMBERS: ${ids.join(', ')}` }], 'coordinate', true);
      const parsed = firstJson(plan.content);
      const list = Array.isArray(parsed?.assignments) ? (parsed!.assignments as { member?: string; subtask?: string }[]) : [];
      assignments = {};
      for (const m of spec.members) assignments[m.id] = String(list.find((a) => a.member === m.id)?.subtask ?? t); // no plan → everyone takes the whole task
      const outs = await Promise.all(spec.members.map((m) => call(m, ask(m, `TASK:\n${t}\n\nYOUR PART:\n${assignments![m.id]}`), 'work')));
      const g = good(outs);
      if (g.length) {
        const parts = g.map((c) => `--- ${c.member} (${assignments![c.member]}) ---\n${c.content.trim()}`).join('\n\n');
        const fin = await judge([{ role: 'system', content: COORD_COMPOSE_SYSTEM }, { role: 'user', content: `TASK:\n${t}\n\n${parts}` }], 'compose');
        answer = fin.ok ? fin.content : parts;
      }
      break;
    }
    case 'tournament': {
      const outs = await fanout('candidate');
      const g = good(outs);
      if (g.length === 1) { winner = g[0].member; answer = g[0].content; }
      else if (g.length > 1) {
        const pick = await judge([{ role: 'system', content: PICK_SYSTEM }, { role: 'user', content: candidatesBlock(t, g.map((c) => ({ id: c.member, content: c.content }))) }], 'pick', true);
        const parsed = firstJson(pick.content);
        const n = Number(parsed?.winner);
        const w = Number.isInteger(n) && n >= 1 && n <= g.length ? g[n - 1] : g[0]; // an unparsable pick falls back to the first candidate, and the receipt shows it
        winner = w.member;
        answer = w.content;
      }
      losers = outs.map((c) => c.member).filter((id) => id !== winner);
      break;
    }
    case 'council': {
      const ids = spec.members.map((m) => m.id);
      let positions = await Promise.all(spec.members.map((m) => call(m, ask(m, `TASK:\n${t}`, COUNCIL_OPEN_SYSTEM), 'position', false, 1)));
      rounds.push({ round: 1, phase: 'position', calls: positions.map((c) => ({ member: c.member, ok: c.ok, content_sha256: c.content_sha256 })) });
      const tally: Record<string, number> = Object.fromEntries(ids.map((id) => [id, 0]));
      let latest: Record<string, string> = Object.fromEntries(positions.map((c) => [c.member, c.content]));
      for (let r = 2; r <= spec.rounds; r++) {
        for (const id of ids) tally[id] = 0;
        const board = ids.map((id) => `--- seat ${id} ---\n${(latest[id] ?? '').trim() || '(no position)'}`).join('\n\n');
        positions = await Promise.all(spec.members.map((m) => call(m, ask(m, `TASK:\n${t}\n\nSEATS: ${ids.join(', ')}\nYOU ARE: ${m.id}\n\n${board}`, COUNCIL_VOTE_SYSTEM), 'vote', true, r)));
        const rec: RoundRecord = { round: r, phase: 'vote', calls: [] };
        const next: Record<string, string> = { ...latest };
        for (const c of positions) {
          const parsed = c.ok ? firstJson(c.content) : null;
          const pos = typeof parsed?.position === 'string' && parsed.position.trim() ? parsed.position : (c.ok ? c.content : latest[c.member] ?? '');
          next[c.member] = pos;
          const vote = typeof parsed?.vote === 'string' ? parsed.vote.trim() : null;
          const valid = !!vote && ids.includes(vote) && vote !== c.member; // self-votes and unknown seats do not count
          if (valid) tally[vote!] += spec.members.find((m) => m.id === c.member)?.weight ?? 1;
          rec.calls.push({ member: c.member, ok: c.ok, vote: valid ? vote : null, content_sha256: c.content_sha256 });
        }
        latest = next;
        rounds.push(rec);
      }
      votes = tally;
      const max = Math.max(...Object.values(tally));
      const tied = ids.filter((id) => tally[id] === max && (latest[id] ?? '').trim());
      if (tied.length === 1) winner = tied[0];
      else if (tied.length > 1) {
        const pick = await judge([{ role: 'system', content: PICK_SYSTEM }, { role: 'user', content: candidatesBlock(t, tied.map((id) => ({ id, content: latest[id] }))) }], 'tiebreak', true);
        const n = Number(firstJson(pick.content)?.winner);
        winner = Number.isInteger(n) && n >= 1 && n <= tied.length ? tied[n - 1] : tied[0];
      }
      answer = winner ? latest[winner] ?? '' : '';
      losers = ids.filter((id) => id !== winner);
      break;
    }
    case 'crew': {
      roles = {};
      for (const m of spec.members) roles[m.id] = m.role ?? (m.kind === 'harness' ? roleFor(String(m.harness), deps.abilities) : 'model');
      const roster = spec.members.map((m) => `${m.id}: ${m.kind === 'harness' ? m.harness : m.kind}, role ${roles![m.id]}${deps.abilities?.[String(m.harness)] ? ', abilities ' + Object.entries(deps.abilities[String(m.harness)]).filter(([, v]) => v).map(([k]) => k).join('/') : ''}`).join('\n');
      const plan = await judge([{ role: 'system', content: CREW_PLAN_SYSTEM }, { role: 'user', content: `TASK:\n${t}\n\nCREW:\n${roster}` }], 'plan', true);
      const parsed = firstJson(plan.content);
      const list = Array.isArray(parsed?.assignments) ? (parsed!.assignments as { member?: string; instruction?: string }[]) : [];
      assignments = {};
      for (const m of spec.members) assignments[m.id] = String(list.find((a) => a.member === m.id)?.instruction ?? t);
      const outs = await Promise.all(spec.members.map((m) => call(m, ask(m, `TASK:\n${t}\n\nYOUR ROLE: ${roles![m.id]}\nYOUR INSTRUCTION:\n${assignments![m.id]}`), 'work')));
      const done = outs.map((c) => `--- ${c.member} (${roles![c.member]}) ${c.ok ? 'did' : 'failed: ' + (c.error ?? '')} ---\n${c.content.trim()}`).join('\n\n');
      const fin = await judge([{ role: 'system', content: CREW_COMPOSE_SYSTEM }, { role: 'user', content: `TASK:\n${t}\n\nROLES: ${JSON.stringify(roles)}\n\n${done}` }], 'compose');
      answer = fin.ok ? fin.content : done;
      break;
    }
  }

  const memberCalls = calls.filter((c) => c.member !== 'judge');
  const ok = memberCalls.some((c) => c.ok) && (['fusion', 'closed', 'tournament', 'council', 'coordinator', 'crew', 'relay'].includes(spec.topology) ? !!answer.trim() : true);
  gov.allow(); // final ms
  return {
    swarm_id: spec.id, run_id, topology: spec.topology, size: spec.size, ok, answer, calls, rounds, winner, losers, votes, roles, assignments,
    budget: gov.ledger, usd: Math.round(calls.reduce((a, c) => a + c.usd, 0) * 1e6) / 1e6, ms: now() - started
  };
}

// ---------------------------------------------------------------- receipts

/** The swarm.run receipt: hashes and numbers, every member call with its own receipt hash, never the texts. */
export async function swarmReceiptData(spec: SwarmSpec, task: string, r: SwarmResult, by: string, extra: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  return {
    run_id: r.run_id,
    swarm_id: spec.id,
    preset: spec.preset ?? null,
    by,
    topology: spec.topology,
    size: spec.size,
    ok: r.ok,
    task_sha256: await sha256HexOf(task),
    answer_sha256: await sha256HexOf(r.answer),
    spec_sha256: await sha256HexOf(JSON.stringify(spec)),
    members: spec.members.map((m) => ({ id: m.id, kind: m.kind, node: m.node, sandbox: m.sandbox, ...(m.model ? { model: m.model } : {}), ...(m.provider ? { provider: m.provider } : {}), ...(m.harness ? { harness: m.harness } : {}), ...(m.room ? { room: m.room } : {}), ...(r.roles?.[m.id] ? { role: r.roles[m.id] } : {}) })),
    calls: r.calls.map((c) => ({ member: c.member, phase: c.phase ?? null, round: c.round ?? null, model: c.model, ok: c.ok, killed: !!c.killed, ms: c.ms, usd: c.usd, tokens_in: c.tokens_in, tokens_out: c.tokens_out, counted: c.counted, provider_used: c.provider_used, generation_id: c.generation_id, content_sha256: c.content_sha256, receipt: c.receipt, error: c.error })),
    winner: r.winner,
    losers: r.losers,
    votes: r.votes,
    rounds: r.rounds.length,
    judge: spec.judge,
    network: spec.network,
    budget: r.budget,
    usd: r.usd,
    ms: r.ms,
    ...extra
  };
}

/** The receipt data of one member call (sealed before swarm.run so swarm.run can cite it). */
export async function memberReceiptData(spec: SwarmSpec, run_id: string, task: string, c: MemberCall): Promise<Record<string, unknown>> {
  const m = spec.members.find((x) => x.id === c.member);
  return {
    run_id, swarm_id: spec.id, topology: spec.topology, member: c.member, kind: c.kind, phase: c.phase ?? null, round: c.round ?? null,
    node: m?.node ?? (c.member === 'judge' ? (spec.judge.tier === 'edge' ? 'edge' : 'mac') : null), model: c.model, provider_used: c.provider_used, model_used: c.model_used, generation_id: c.generation_id,
    ok: c.ok, killed: !!c.killed, ms: c.ms, usd: c.usd, tokens_in: c.tokens_in, tokens_out: c.tokens_out, tokens_cached: c.tokens_cached, tokens_reasoning: c.tokens_reasoning, counted: c.counted,
    task_sha256: await sha256HexOf(task), content_sha256: c.content_sha256, error: c.error,
    ...(c.receipt_external ? { external_receipt: c.receipt_external } : {})
  };
}
