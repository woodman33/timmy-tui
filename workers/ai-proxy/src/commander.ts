// Commander — the commander loop as a Cloudflare Agents SDK durable agent
// (one Durable Object per room, SQLite-backed). mindship-v5c2 step 2,
// swarm-b3k7 steps 2, 4, 5, 6.
//
//   memory     : SQL tables (turns, memory, receipts, swarms) + synced state
//   schedule   : this.schedule() steps that run the mind later (skipped, and
//                receipted as skipped, while held or killed)
//   websocket  : GET /commander/:room/ws — every state change and receipt is
//                pushed as {type:'commander.event'}; commands are accepted
//                over the socket with the caller token
//   mind       : OpenRouter (commander-core.chatOnce), modes generate /
//                bodybuilder / fusion, native routers, provider passthroughs
//   hands      : Code Mode (runCode in a Dynamic Worker isolate) when the mind
//                answers with a script; native tools[] when asked
//   handoff    : POST /handoff → any MCP-capable harness holds the role with a
//                hold token; OpenRouter is paused until POST /release; the
//                holder posts its own turns to POST /turn
//   spend      : live ledger in state, cap + price ceiling in state (POST /cap),
//                kill switch POST /kill (aborts in-flight calls; POST /revive)
//   swarm      : POST /swarm { spec, task } runs a swarm spec on this room
//                (swarm-core topologies); members of kind model run through
//                OpenRouter, members of kind timmy through the Timmy Durable
//                Objects over MCP RPC; every member call is sealed as
//                swarm.member and swarm.run cites them all; a per-swarm cost
//                governor kills what the budget cannot pay for
//
// Every mutation seals one receipt on the room's edge chain (subject
// commander:<room>) stored in SQL and mirrored to CUSTODY_KV as
// chain:commander:<room>, so the daily head lists it like every other chain.
import { Agent, type Connection, type ConnectionContext, type WSMessage } from 'agents';
import { DynamicWorkerExecutor } from '@cloudflare/codemode';
import { HttpError, type Executor } from './code.js';
import { type EdgeReceipt, sha256Hex, verifyEdgeChain } from './chain.js';
import { type Env, allowlist, edgeTools, isAllowed } from './tools.js';
import { corsHeaders } from './room-core.js';
import {
  type CommanderAction, type CommanderState, type HandoffRequest, type HolderTurn, type TurnRequest, type ChatMessage,
  applyCap, applyHandoff, applyKill, applyMode, applyRelease, applyRevive, applySpend, canThink, capFromEnv, chatOnce, chatOptionsFor,
  commanderChainKey, executeTurn, generationStats, holderTurnData, initialCommanderState, isReadAction, nativeTools, newTurnId, parseCommanderPath, providersList,
  sealCommander, turnReceiptData, type CommanderReceiptKind
} from './commander-core.js';
import {
  type CallOpts, type MemberCall, type SwarmMember, type SwarmResult, type SwarmSpec, memberReceiptData, parseSwarmSpec, runSwarm, swarmReceiptData
} from './swarm-core.js';
import type { Timmy, ThinkOut } from './timmy.js';

export type CommanderEnv = Env & { COMMANDER_SPEND_CAP_USD?: string; LOADER?: unknown; TIMMY?: DurableObjectNamespace<Timmy> };

const TAIL_TURNS = 20;
const json = (body: unknown, status = 200): Response => Response.json(body, { status, headers: corsHeaders() });

interface TurnRow { id: string; ts: string; mode: string; by: string; source: string; status: string; usd: number; receipt: string; task: string; answer: string }
interface SwarmRow { id: string; ts: string; swarm_id: string; topology: string; size: number; status: string; usd: number; receipt: string; task: string; answer: string }

export class Commander extends Agent<CommanderEnv, CommanderState> {
  initialState: CommanderState = initialCommanderState('', '1970-01-01T00:00:00.000Z');
  private tables = false;
  private sealChain: Promise<unknown> = Promise.resolve();
  /** In-flight mind/swarm calls; the kill switch aborts them. */
  private inflight = new Set<AbortController>();

  private ensureTables(): void {
    if (this.tables) return;
    this.sql`CREATE TABLE IF NOT EXISTS turns (id TEXT PRIMARY KEY, ts TEXT NOT NULL, mode TEXT NOT NULL, by TEXT NOT NULL, source TEXT NOT NULL, status TEXT NOT NULL, usd REAL NOT NULL, receipt TEXT NOT NULL, task TEXT NOT NULL, answer TEXT NOT NULL)`;
    this.sql`CREATE TABLE IF NOT EXISTS memory (k TEXT PRIMARY KEY, v TEXT NOT NULL, ts TEXT NOT NULL)`;
    this.sql`CREATE TABLE IF NOT EXISTS receipts (seq INTEGER PRIMARY KEY AUTOINCREMENT, hash TEXT UNIQUE NOT NULL, kind TEXT NOT NULL, ts TEXT NOT NULL, body TEXT NOT NULL)`;
    this.sql`CREATE TABLE IF NOT EXISTS swarms (id TEXT PRIMARY KEY, ts TEXT NOT NULL, swarm_id TEXT NOT NULL, topology TEXT NOT NULL, size INTEGER NOT NULL, status TEXT NOT NULL, usd REAL NOT NULL, receipt TEXT NOT NULL, task TEXT NOT NULL, answer TEXT NOT NULL)`;
    this.tables = true;
  }

  async onStart(): Promise<void> {
    this.ensureTables();
    if (!this.state.room || this.state.room !== this.name) {
      const now = new Date().toISOString();
      this.setState({ ...initialCommanderState(this.name, now, capFromEnv(this.env)), ...(this.state.room === this.name ? this.state : {}), room: this.name });
    }
  }

  // ------------------------------------------------------------ chain

  private chain(): EdgeReceipt[] {
    this.ensureTables();
    return [...this.sql<{ body: string }>`SELECT body FROM receipts ORDER BY seq ASC`].map((r) => JSON.parse(r.body) as EdgeReceipt);
  }

  /** Seals are serialised: parallel swarm members must not compute prev_hash from the same head. */
  private seal(kind: CommanderReceiptKind, data: Record<string, unknown>): Promise<EdgeReceipt> {
    const p = this.sealChain.then(async () => {
      const chain = this.chain();
      const rec = await sealCommander(chain, this.name, kind, data);
      this.sql`INSERT INTO receipts (hash, kind, ts, body) VALUES (${rec.hash}, ${rec.kind}, ${rec.ts}, ${JSON.stringify(rec)})`;
      if (this.env.CUSTODY_KV) {
        try { await this.env.CUSTODY_KV.put(commanderChainKey(this.name), JSON.stringify(chain)); } catch { /* KV mirror is best effort; SQL is the record */ }
      }
      return rec;
    });
    this.sealChain = p.catch(() => undefined);
    return p;
  }

  private commit(state: CommanderState, rec: EdgeReceipt, extra: Record<string, unknown> = {}): void {
    this.setState({ ...state, head: rec.hash, updated_at: rec.ts });
    this.broadcast(JSON.stringify({ type: 'commander.event', room: this.name, kind: rec.kind, receipt: { id: rec.id, hash: rec.hash, ts: rec.ts, data: rec.data }, state: this.state, ...extra }));
  }

  private turns(limit = TAIL_TURNS): TurnRow[] {
    this.ensureTables();
    return [...this.sql<TurnRow>`SELECT id, ts, mode, by, source, status, usd, receipt, task, answer FROM (SELECT * FROM turns ORDER BY ts DESC LIMIT ${limit}) ORDER BY ts ASC`];
  }

  private swarms(limit = TAIL_TURNS): SwarmRow[] {
    this.ensureTables();
    return [...this.sql<SwarmRow>`SELECT id, ts, swarm_id, topology, size, status, usd, receipt, task, answer FROM (SELECT * FROM swarms ORDER BY ts DESC LIMIT ${limit}) ORDER BY ts ASC`];
  }

  private authed(token: string | undefined): boolean {
    return !!this.env.TIMMY_EDGE_TOKEN && token === this.env.TIMMY_EDGE_TOKEN;
  }

  private executor(): Executor | undefined {
    if (!this.env.LOADER) return undefined;
    return new DynamicWorkerExecutor({ loader: this.env.LOADER as never, timeout: 60_000 }) as unknown as Executor;
  }

  private abortable<T>(fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const ac = new AbortController();
    this.inflight.add(ac);
    return fn(ac.signal).finally(() => this.inflight.delete(ac));
  }

  // ------------------------------------------------------------ commands (shared by http + ws + schedule)

  async cmdThink(body: TurnRequest, source: string): Promise<Record<string, unknown>> {
    const gate = canThink(this.state);
    if (!gate.ok) throw new HttpError(gate.status, gate.reason);
    const mode = body.mode ?? this.state.mode;
    const req: TurnRequest = { ...body, source };
    const r = await this.abortable((signal) => executeTurn(req, mode, { env: this.env, executor: this.executor(), room: this.name, spend: this.state.spend, signal }));
    const now = new Date().toISOString();
    const spent = applySpend(this.state, r.calls, now);
    const rec = await this.seal('commander.turn', await turnReceiptData(req, r, 'openrouter'));
    this.sql`INSERT INTO turns (id, ts, mode, by, source, status, usd, receipt, task, answer) VALUES (${r.turn_id}, ${now}, ${r.mode}, ${'openrouter'}, ${source}, ${r.ok ? 'ok' : 'failed'}, ${r.usd}, ${rec.hash}, ${String(body.task).slice(0, 20000)}, ${r.answer.slice(0, 60000)})`;
    this.commit({ ...spent, turns: spent.turns + 1, last_turn: r.turn_id }, rec, { turn: { id: r.turn_id, ok: r.ok, usd: r.usd, mode: r.mode } });
    return { ok: r.ok, turn_id: r.turn_id, mode: r.mode, native: r.native, answer: r.answer, outputs: r.outputs, calls: r.calls, hands: r.hands, hands_note: r.hands_note, usd: r.usd, ms: r.ms, receipt: rec, spend: this.state.spend };
  }

  async cmdTurn(body: HolderTurn): Promise<Record<string, unknown>> {
    const id = newTurnId(Date.now());
    const data = await holderTurnData(this.state, body, id);
    const now = new Date().toISOString();
    const rec = await this.seal('commander.turn', data);
    this.sql`INSERT INTO turns (id, ts, mode, by, source, status, usd, receipt, task, answer) VALUES (${id}, ${now}, ${'held'}, ${String(data.by)}, ${'handoff'}, ${'ok'}, ${0}, ${rec.hash}, ${String(body.asked ?? '').slice(0, 20000)}, ${String(body.did).slice(0, 60000)})`;
    this.commit({ ...this.state, turns: this.state.turns + 1, last_turn: id }, rec, { turn: { id, by: data.by } });
    return { ok: true, turn_id: id, receipt: rec };
  }

  async cmdHandoff(body: HandoffRequest): Promise<Record<string, unknown>> {
    const now = new Date().toISOString();
    const h = await applyHandoff(this.state, body, now);
    const rec = await this.seal('commander.handoff', h.data);
    this.commit(h.state, rec);
    // The hold token travels back exactly once and is never stored.
    return { ok: true, hold_token: h.token, held_by: h.state.held_by, openrouter_paused: true, receipt: rec };
  }

  async cmdRelease(body: { hold_token?: string; force?: boolean }, operator: boolean): Promise<Record<string, unknown>> {
    const now = new Date().toISOString();
    const r = await applyRelease(this.state, body.hold_token, now, !!body.force && operator);
    const rec = await this.seal('commander.release', r.data);
    this.commit(r.state, rec);
    return { ok: true, released: r.data, receipt: rec };
  }

  async cmdKill(body: { reason?: string }): Promise<Record<string, unknown>> {
    const now = new Date().toISOString();
    const k = applyKill(this.state, now, body.reason);
    // stream-cancellation: abort every in-flight OpenRouter fetch, not only the next turn
    const aborted = this.inflight.size;
    for (const ac of this.inflight) ac.abort();
    const cancelled: string[] = [];
    for (const s of this.getSchedules()) { if (await this.cancelSchedule(s.id)) cancelled.push(s.id); }
    const rec = await this.seal('commander.kill', { ...k.data, schedules_cancelled: cancelled, aborted_inflight: aborted });
    this.commit(k.state, rec);
    return { ok: true, killed: true, schedules_cancelled: cancelled, aborted_inflight: aborted, receipt: rec };
  }

  async cmdRevive(): Promise<Record<string, unknown>> {
    const now = new Date().toISOString();
    const r = applyRevive(this.state, now);
    const rec = await this.seal('commander.revive', r.data);
    this.commit(r.state, rec);
    return { ok: true, killed: false, receipt: rec };
  }

  async cmdMode(body: { mode?: unknown }): Promise<Record<string, unknown>> {
    const now = new Date().toISOString();
    const m = applyMode(this.state, body.mode, now);
    const rec = await this.seal('commander.mode', m.data);
    this.commit(m.state, rec);
    return { ok: true, mode: m.state.mode, receipt: rec };
  }

  async cmdCap(body: { cap_usd?: unknown; max_price?: unknown }): Promise<Record<string, unknown>> {
    const now = new Date().toISOString();
    const c = applyCap(this.state, body.cap_usd, now, body.max_price);
    const rec = await this.seal('commander.cap', c.data);
    this.commit(c.state, rec);
    return { ok: true, spend: c.state.spend, receipt: rec };
  }

  async cmdSchedule(body: { task?: string; mode?: unknown; in?: number; at?: string; cron?: string; models?: string[]; judge?: string }): Promise<Record<string, unknown>> {
    if (this.state.killed) throw new HttpError(423, 'killed: revive before scheduling');
    const task = String(body.task ?? '').trim();
    if (!task) throw new HttpError(400, 'task required');
    let when: number | Date | string;
    let kind: string;
    if (typeof body.cron === 'string' && body.cron.trim()) { when = body.cron.trim(); kind = 'cron'; }
    else if (typeof body.at === 'string' && !Number.isNaN(Date.parse(body.at))) { when = new Date(body.at); kind = 'at'; }
    else { const s = Number(body.in ?? 60); if (!Number.isFinite(s) || s < 1 || s > 30 * 86400) throw new HttpError(400, 'in: seconds in [1, 2592000]'); when = s; kind = 'delay'; }
    const payload = { task, mode: body.mode, models: body.models, judge: body.judge };
    const s = await this.schedule(when, 'scheduledThink', payload);
    const rec = await this.seal('commander.schedule', { schedule_id: s.id, kind, when: String(body.cron ?? body.at ?? body.in ?? 60), time: s.time, task_preview: task.slice(0, 200), mode: body.mode ?? this.state.mode });
    this.commit(this.state, rec, { schedule: { id: s.id, time: s.time } });
    return { ok: true, schedule: { id: s.id, time: s.time, kind }, receipt: rec };
  }

  async cmdCancel(body: { id?: string }): Promise<Record<string, unknown>> {
    const id = String(body.id ?? '');
    const ok = id ? await this.cancelSchedule(id) : false;
    const rec = await this.seal('commander.cancel', { schedule_id: id, cancelled: ok });
    this.commit(this.state, rec);
    return { ok, schedule_id: id, receipt: rec };
  }

  async cmdRemember(body: { k?: string; v?: unknown; forget?: boolean }): Promise<Record<string, unknown>> {
    const k = String(body.k ?? '').trim().slice(0, 120);
    if (!k) throw new HttpError(400, 'k required');
    const now = new Date().toISOString();
    if (body.forget) this.sql`DELETE FROM memory WHERE k = ${k}`;
    else this.sql`INSERT INTO memory (k, v, ts) VALUES (${k}, ${JSON.stringify(body.v ?? null).slice(0, 8000)}, ${now}) ON CONFLICT(k) DO UPDATE SET v = excluded.v, ts = excluded.ts`;
    const n = Number([...this.sql<{ n: number }>`SELECT COUNT(*) AS n FROM memory`][0]?.n ?? 0);
    const rec = await this.seal('commander.remember', { k, forget: !!body.forget, notes: n });
    this.commit({ ...this.state, memory_notes: n }, rec);
    return { ok: true, k, notes: n, receipt: rec };
  }

  // ------------------------------------------------------------ swarm (swarm-b3k7)

  /** One Timmy member call: connect to the project's Timmy over Durable Object RPC MCP and call its `think` tool. */
  private async callTimmy(m: SwarmMember, messages: ChatMessage[], o: CallOpts): Promise<{ content: string; out: Partial<ThinkOut>; error: string | null }> {
    if (!this.env.TIMMY) return { content: '', out: {}, error: 'no TIMMY binding on this deployment' };
    const room = String(m.room);
    const serverId = `timmy_${room}`.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 60);
    const conn = await this.addMcpServer(room, this.env.TIMMY, { id: serverId, props: { room } });
    const system = messages.find((x) => x.role === 'system')?.content;
    const task = messages.filter((x) => x.role === 'user').map((x) => x.content).join('\n\n');
    const res = (await this.mcp.callTool({ serverId: conn.id, name: 'think', arguments: { task, ...(system ? { system } : {}), max_tokens: o.maxTokens, by: `swarm:${this.name}` } })) as { content?: { type: string; text?: string }[]; isError?: boolean };
    const textPart = (res.content ?? []).find((c) => c.type === 'text')?.text ?? '';
    let out: Partial<ThinkOut> & { error?: string } = {};
    try { out = JSON.parse(textPart) as Partial<ThinkOut> & { error?: string }; } catch { out = { answer: textPart }; }
    if (res.isError || out.ok === false) return { content: '', out, error: out.error ?? 'timmy refused' };
    return { content: String(out.answer ?? ''), out, error: null };
  }

  /** Every member the edge can run: OpenRouter models and Timmys. Local members (Ollama slots, harnesses) are refused here and run through `timmy swarm run`. */
  private memberExecutor(spec: SwarmSpec, runId: string, task: string, base: ReturnType<typeof chatOptionsFor>) {
    const allow = allowlist(this.env);
    const exec = async (m: SwarmMember, messages: ChatMessage[], o: CallOpts): Promise<MemberCall> => {
      const started = Date.now();
      let mc: MemberCall;
      if (m.kind === 'model' && m.provider === 'openrouter') {
        if (!isAllowed(allow, String(m.model))) {
          mc = { role: 'actor', model: String(m.model), ok: false, ms: 0, usd: 0, tokens_in: 0, tokens_out: 0, counted: true, content_sha256: null, error: `model not on allowlist: ${m.model}`, provider_used: null, model_used: null, generation_id: null, tokens_cached: 0, tokens_reasoning: 0, member: m.id, kind: m.kind, content: '', receipt: null };
        } else {
          const r = await chatOnce('actor', String(m.model), messages, { env: this.env }, o.maxTokens, { ...base, signal: o.signal, ...(o.json ? { response_format: { type: 'json_object' } } : {}), title: `TIMMY swarm ${spec.topology}` });
          mc = { ...r.call, member: m.id, kind: m.kind, content: r.content, receipt: null };
        }
      } else if (m.kind === 'timmy') {
        try {
          const t = await this.callTimmy(m, messages, o);
          const usd = Number(t.out.usd ?? 0);
          mc = { role: 'actor', model: `timmy:${m.room}`, ok: !t.error, ms: Date.now() - started, usd, tokens_in: 0, tokens_out: 0, counted: true, content_sha256: t.content ? await sha256Hex(t.content) : null, error: t.error, provider_used: 'timmy', model_used: t.out.models?.map((x) => x.model).join(',') ?? null, generation_id: null, tokens_cached: 0, tokens_reasoning: 0, member: m.id, kind: m.kind, content: t.content, receipt: null, receipt_external: t.out.receipt ?? null };
        } catch (e) {
          mc = { role: 'actor', model: `timmy:${m.room}`, ok: false, ms: Date.now() - started, usd: 0, tokens_in: 0, tokens_out: 0, counted: true, content_sha256: null, error: `timmy ${m.room}: ${e instanceof Error ? e.message : String(e)}`, provider_used: 'timmy', model_used: null, generation_id: null, tokens_cached: 0, tokens_reasoning: 0, member: m.id, kind: m.kind, content: '', receipt: null };
        }
      } else {
        mc = { role: 'actor', model: m.model ?? m.harness ?? m.id, ok: false, ms: 0, usd: 0, tokens_in: 0, tokens_out: 0, counted: true, content_sha256: null, error: `member ${m.id} (${m.kind}, ${m.provider ?? m.harness}, node ${m.node}) runs locally, not at the edge: use \`timmy swarm run\``, provider_used: null, model_used: null, generation_id: null, tokens_cached: 0, tokens_reasoning: 0, member: m.id, kind: m.kind, content: '', receipt: null };
      }
      const rec = await this.seal('swarm.member', await memberReceiptData(spec, runId, task, { ...mc, phase: o.phase, round: o.round }));
      return { ...mc, receipt: rec.hash };
    };
    const judge = async (messages: ChatMessage[], o: CallOpts): Promise<MemberCall> => {
      const model = spec.judge.model ?? allow[allow.length - 1];
      let mc: MemberCall;
      if (spec.judge.tier !== 'edge') {
        mc = { role: 'judge', model, ok: false, ms: 0, usd: 0, tokens_in: 0, tokens_out: 0, counted: true, content_sha256: null, error: `judge tier ${spec.judge.tier} runs locally, not at the edge: use \`timmy swarm run\``, provider_used: null, model_used: null, generation_id: null, tokens_cached: 0, tokens_reasoning: 0, member: 'judge', kind: 'model', content: '', receipt: null };
      } else if (!isAllowed(allow, model)) {
        mc = { role: 'judge', model, ok: false, ms: 0, usd: 0, tokens_in: 0, tokens_out: 0, counted: true, content_sha256: null, error: `judge not on allowlist: ${model}`, provider_used: null, model_used: null, generation_id: null, tokens_cached: 0, tokens_reasoning: 0, member: 'judge', kind: 'model', content: '', receipt: null };
      } else {
        const r = await chatOnce('judge', model, messages, { env: this.env }, o.maxTokens, { ...base, signal: o.signal, ...(o.json ? { response_format: { type: 'json_object' } } : {}), title: `TIMMY swarm judge` });
        mc = { ...r.call, member: 'judge', kind: 'model', content: r.content, receipt: null };
      }
      const rec = await this.seal('swarm.member', await memberReceiptData(spec, runId, task, { ...mc, phase: o.phase, round: o.round }));
      return { ...mc, receipt: rec.hash };
    };
    return { exec, judge };
  }

  /** POST /swarm { spec, task, max_tokens? } runs at the edge; POST /swarm { record: { spec, task, result, by, extra? } } records a lane-run swarm on this room's chain. */
  async cmdSwarm(body: { spec?: unknown; task?: string; max_tokens?: number; record?: { spec: unknown; task: string; result: SwarmResult; by?: string; extra?: Record<string, unknown> } }, source: string): Promise<Record<string, unknown>> {
    const now = () => new Date().toISOString();
    if (body.record) {
      const spec = parseSwarmSpec(body.record.spec);
      const r = body.record.result;
      if (!r || typeof r !== 'object' || !Array.isArray(r.calls)) throw new HttpError(400, 'record.result must be a SwarmResult');
      const by = String(body.record.by ?? 'lane').slice(0, 80);
      const rec = await this.seal('swarm.run', await swarmReceiptData(spec, String(body.record.task ?? ''), r, by, { recorded: true, source, ...(body.record.extra ?? {}) }));
      this.sql`INSERT INTO swarms (id, ts, swarm_id, topology, size, status, usd, receipt, task, answer) VALUES (${r.run_id}, ${now()}, ${spec.id}, ${spec.topology}, ${spec.size}, ${r.ok ? 'ok' : 'failed'}, ${r.usd}, ${rec.hash}, ${String(body.record.task ?? '').slice(0, 20000)}, ${String(r.answer ?? '').slice(0, 60000)})`;
      this.commit({ ...this.state, swarms: (this.state.swarms ?? 0) + 1, last_swarm: r.run_id }, rec, { swarm: { id: r.run_id, ok: r.ok, usd: r.usd, topology: spec.topology, recorded: true } });
      return { ok: true, recorded: true, run_id: r.run_id, receipt: rec };
    }
    const gate = canThink(this.state);
    if (!gate.ok) throw new HttpError(gate.status, gate.reason);
    const spec = parseSwarmSpec(body.spec);
    const task = String(body.task ?? '').trim();
    if (!task) throw new HttpError(400, 'task required');
    if (spec.topology === 'closed') throw new HttpError(400, 'a closed swarm never runs at the edge: use `timmy swarm run closed-3` (air gap on the operator\'s machine)');
    const roomCapLeft = this.state.spend.cap_usd - this.state.spend.usd;
    if (spec.budget.usd > roomCapLeft) throw new HttpError(402, `swarm budget ${spec.budget.usd} USD exceeds what the room cap leaves (${roomCapLeft.toFixed(4)} USD); POST /cap to raise it`);
    const maxTokens = Math.min(8192, Math.max(64, Number(body.max_tokens ?? 1024)));
    const base = chatOptionsFor({ task }, this.name, this.state.spend);
    const runId = `swarm_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const { exec, judge } = this.memberExecutor(spec, runId, task, base);
    const result = await this.abortable((signal) => runSwarm(spec, task, { exec, judge, signal, maxTokens, gate: () => (this.state.killed ? 'kill switch' : null) }));
    const r = { ...result, run_id: runId };
    const ts = now();
    const spent = applySpend(this.state, r.calls, ts);
    const rec = await this.seal('swarm.run', await swarmReceiptData(spec, task, r, 'commander', { source }));
    this.sql`INSERT INTO swarms (id, ts, swarm_id, topology, size, status, usd, receipt, task, answer) VALUES (${r.run_id}, ${ts}, ${spec.id}, ${spec.topology}, ${spec.size}, ${r.ok ? 'ok' : 'failed'}, ${r.usd}, ${rec.hash}, ${task.slice(0, 20000)}, ${r.answer.slice(0, 60000)})`;
    this.commit({ ...spent, swarms: (this.state.swarms ?? 0) + 1, last_swarm: r.run_id }, rec, { swarm: { id: r.run_id, ok: r.ok, usd: r.usd, topology: spec.topology } });
    return { ok: r.ok, run_id: r.run_id, swarm_id: spec.id, topology: spec.topology, size: spec.size, answer: r.answer, winner: r.winner, losers: r.losers, votes: r.votes, roles: r.roles, assignments: r.assignments, calls: r.calls.map((c) => ({ member: c.member, phase: c.phase, round: c.round, model: c.model, ok: c.ok, killed: !!c.killed, ms: c.ms, usd: c.usd, receipt: c.receipt, receipt_external: c.receipt_external ?? null, error: c.error, preview: c.content.slice(0, 240) })), budget: r.budget, usd: r.usd, ms: r.ms, receipt: rec, spend: this.state.spend };
  }

  /** Scheduled step handler: runs the mind later, or seals the skip when it may not. */
  async scheduledThink(payload: { task: string; mode?: unknown; models?: string[]; judge?: string }): Promise<void> {
    const gate = canThink(this.state);
    if (!gate.ok) {
      const rec = await this.seal('commander.turn', { turn_id: newTurnId(Date.now()), by: 'schedule', source: 'schedule', mode: this.state.mode, ok: false, skipped: true, reason: gate.reason, usd: 0 });
      this.commit(this.state, rec, { skipped: gate.reason });
      return;
    }
    const mode = payload.mode;
    await this.cmdThink({ task: payload.task, models: payload.models, judge: payload.judge, ...(typeof mode === 'string' ? { mode: mode as TurnRequest['mode'] } : {}) }, 'schedule');
  }

  // ------------------------------------------------------------ reads

  private async read(action: CommanderAction, url: URL): Promise<Record<string, unknown>> {
    switch (action) {
      case 'state': return { ok: true, room: this.name, state: this.state, viewers: [...this.getConnections()].length, schedules: this.getSchedules().length, inflight: this.inflight.size };
      case 'spend': return { ok: true, room: this.name, spend: this.state.spend, killed: this.state.killed, held: !!this.state.held_by, openrouter_paused: this.state.openrouter_paused };
      case 'turns': return { ok: true, room: this.name, turns: this.turns(Math.min(200, Math.max(1, Number(url.searchParams.get('limit') ?? TAIL_TURNS)))) };
      case 'swarms': return { ok: true, room: this.name, swarms: this.swarms(Math.min(200, Math.max(1, Number(url.searchParams.get('limit') ?? TAIL_TURNS)))) };
      case 'receipts': { const chain = this.chain(); return { ok: true, room: this.name, count: chain.length, receipts: chain.slice(-Math.min(500, Math.max(1, Number(url.searchParams.get('limit') ?? 50)))) }; }
      case 'schedules': return { ok: true, room: this.name, schedules: this.getSchedules().map((s) => ({ id: s.id, callback: s.callback, time: s.time, type: s.type, payload: s.payload })) };
      case 'memory': return { ok: true, room: this.name, memory: [...this.sql<{ k: string; v: string; ts: string }>`SELECT k, v, ts FROM memory ORDER BY ts DESC LIMIT 200`].map((r) => ({ k: r.k, v: JSON.parse(r.v), ts: r.ts })) };
      case 'stats': {
        // generation-stats: exact native cost per generation, by generation id or for one turn's calls
        const id = url.searchParams.get('id');
        if (id) return { ok: true, room: this.name, stats: [await generationStats(this.env, id)] };
        const turn = url.searchParams.get('turn') ?? this.state.last_turn ?? '';
        const rec = this.chain().reverse().find((r) => r.kind === 'commander.turn' && (r.data as { turn_id?: string }).turn_id === turn);
        const ids = ((rec?.data as { models?: { generation_id?: string | null }[] })?.models ?? []).map((m) => m.generation_id).filter((g): g is string => !!g);
        return { ok: true, room: this.name, turn, generation_ids: ids, stats: await Promise.all(ids.map((g) => generationStats(this.env, g))) };
      }
      case 'providers': return { room: this.name, ...(await providersList(this.env)) };
      case 'tools': return { ok: true, room: this.name, edge: edgeTools().map((t) => ({ name: t.name, paid: !!t.paid, destructive: !!t.destructive })), native: nativeTools() };
      default: return { ok: false, error: 'not a read' };
    }
  }

  private async write(action: CommanderAction, body: Record<string, unknown>, source: string, operator: boolean): Promise<Record<string, unknown>> {
    switch (action) {
      case 'think': return this.cmdThink(body as unknown as TurnRequest, source);
      case 'turn': return this.cmdTurn(body as unknown as HolderTurn);
      case 'handoff': return this.cmdHandoff(body as unknown as HandoffRequest);
      case 'release': return this.cmdRelease(body as { hold_token?: string; force?: boolean }, operator);
      case 'kill': return this.cmdKill(body as { reason?: string });
      case 'revive': return this.cmdRevive();
      case 'mode': return this.cmdMode(body);
      case 'cap': return this.cmdCap(body);
      case 'schedule': return this.cmdSchedule(body as Parameters<Commander['cmdSchedule']>[0]);
      case 'cancel': return this.cmdCancel(body as { id?: string });
      case 'remember': return this.cmdRemember(body as { k?: string; v?: unknown; forget?: boolean });
      case 'swarm': return this.cmdSwarm(body as Parameters<Commander['cmdSwarm']>[0], source);
      default: throw new HttpError(405, 'not a command');
    }
  }

  // ------------------------------------------------------------ http

  async onRequest(request: Request): Promise<Response> {
    this.ensureTables();
    const url = new URL(request.url);
    const parsed = parseCommanderPath(url.pathname);
    if (!parsed) return json({ ok: false, error: 'not a commander route' }, 404);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders() });
    const { action } = parsed;
    if (isReadAction(action)) {
      if (action === 'ws') return json({ ok: false, error: 'expected websocket upgrade' }, 426);
      if (action === 'receipts' && url.searchParams.get('verify') === '1') {
        const chain = this.chain();
        return json({ ok: true, room: this.name, verify: await verifyEdgeChain(chain), count: chain.length });
      }
      // stats and providers spend upstream calls: caller token required like a command
      if ((action === 'stats' || action === 'providers') && !this.authed((request.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, ''))) return json({ ok: false, error: 'unauthorized' }, 401);
      return json(await this.read(action, url));
    }
    if (request.method !== 'POST') return json({ ok: false, error: 'method not allowed' }, 405);
    // /turn and /release are the holder's calls: authenticated by the hold token, not the operator token.
    const operator = this.authed((request.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, ''));
    if (!operator && action !== 'turn' && action !== 'release') return json({ ok: false, error: 'unauthorized' }, 401);
    let body: Record<string, unknown> = {};
    try { const t = await request.text(); body = t ? (JSON.parse(t) as Record<string, unknown>) : {}; } catch { return json({ ok: false, error: 'bad json' }, 400); }
    try {
      return json(await this.write(action, body, 'http', operator));
    } catch (e) {
      if (e instanceof HttpError) return json({ ok: false, error: e.message, state: this.state }, e.status);
      return json({ ok: false, error: e instanceof Error ? e.message : String(e) }, 500);
    }
  }

  // ------------------------------------------------------------ websocket (TUI + companion)

  async onConnect(connection: Connection, _ctx: ConnectionContext): Promise<void> {
    this.ensureTables();
    connection.send(JSON.stringify({ type: 'commander.hello', room: this.name, state: this.state, turns: this.turns(), schedules: this.getSchedules().length }));
  }

  async onMessage(connection: Connection, message: WSMessage): Promise<void> {
    if (typeof message !== 'string') return;
    let msg: { cmd?: string; token?: string; body?: Record<string, unknown>; id?: unknown };
    try { msg = JSON.parse(message) as typeof msg; } catch { connection.send(JSON.stringify({ type: 'commander.reply', ok: false, error: 'bad json' })); return; }
    const cmd = String(msg.cmd ?? 'state') as CommanderAction;
    const reply = (r: Record<string, unknown>, status = 200) => connection.send(JSON.stringify({ type: 'commander.reply', cmd, id: msg.id ?? null, status, ...r }));
    if (cmd === 'hello' as string) { reply({ ok: true, room: this.name, state: this.state, turns: this.turns() }); return; }
    const operator = this.authed(msg.token);
    if (isReadAction(cmd)) {
      if ((cmd === 'stats' || cmd === 'providers') && !operator) { reply({ ok: false, error: 'unauthorized' }, 401); return; }
      reply(await this.read(cmd, new URL(`https://ws.local/commander/${encodeURIComponent(this.name)}/${cmd}`)));
      return;
    }
    if (!operator && cmd !== 'turn' && cmd !== 'release') { reply({ ok: false, error: 'unauthorized' }, 401); return; }
    try {
      reply(await this.write(cmd, msg.body ?? {}, 'ws', operator));
    } catch (e) {
      if (e instanceof HttpError) reply({ ok: false, error: e.message }, e.status);
      else reply({ ok: false, error: e instanceof Error ? e.message : String(e) }, 500);
    }
  }

  async onClose(connection: Connection): Promise<void> {
    try { connection.close(); } catch { /* already closed */ }
  }
}
