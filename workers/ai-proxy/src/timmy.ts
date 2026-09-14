// Timmy — a Level-2 durable agent (ORDER swarm-b3k7 step 4): one Durable Object
// per project room that IS a Timmy — it owns a mind (OpenRouter through the
// same core the commander uses), hands (Code Mode), a memory, a spend ledger
// under its project's budget, and its own receipt chain (subject timmy:<room>,
// mirrored to CUSTODY_KV as chain:timmy:<room>) — and EXPOSES MCP. The root
// commander connects to it over Durable Object RPC (agents' McpAgent RPC
// transport, no public hop) and calls its tools as swarm members of kind
// `timmy`; outside callers reach the same instance over HTTP at
// /timmy/:room/{state,think,receipts,profile} and over MCP at /timmy/mcp
// (a stateless handler whose tools name the room).
//
// Timmy-of-Timmys: the room is the project (project:ship, project:shelf, …),
// the profile is the project's profile.cue, and every think seals timmy.turn
// on the project's own chain, which the swarm.run receipt then cites.
import { McpAgent, RPC_DO_PREFIX } from 'agents/mcp';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { DynamicWorkerExecutor } from '@cloudflare/codemode';
import { z } from 'zod';
import { HttpError, type Executor } from './code.js';
import { type EdgeReceipt, appendEdgeReceipt, sha256Hex, verifyEdgeChain } from './chain.js';
import { type Env } from './tools.js';
import {
  type CommanderMode, type ModelCall, type Spend, type TurnRequest, applySpend, capFromEnv, executeTurn, isMode, newTurnId, turnReceiptData
} from './commander-core.js';

export type TimmyEnv = Env & { COMMANDER_SPEND_CAP_USD?: string; LOADER?: unknown };
export type TimmyProps = { room?: string };

export interface TimmyProfile {
  name: string;
  owner: string | null;
  /** budget.max_spend_usd from profile.cue */
  budget_usd: number;
  /** models.mind / models.actors from profile.cue */
  mind: string | null;
  actors: string[];
  standard: string | null;
  profile_sha256: string | null;
  set_at: string;
}

export interface TimmyState {
  v: 1;
  room: string;
  created_at: string;
  updated_at: string;
  profile: TimmyProfile | null;
  spend: Spend;
  turns: number;
  head: string | null;
  last_turn: string | null;
  memory_notes: number;
  /** How many MCP sessions (RPC or HTTP) have called this Timmy. */
  calls: number;
}

export const timmySubject = (room: string): string => `timmy:${room}`;
export const timmyChainKey = (room: string): string => `chain:timmy:${room}`;
/** The RPC MCP transport names the Durable Object `${RPC_DO_PREFIX}${room}`; the room is what the project calls it. */
export const roomOf = (doName: string): string => (doName.startsWith(RPC_DO_PREFIX) ? doName.slice(RPC_DO_PREFIX.length) : doName);
export type TimmyReceiptKind = 'timmy.turn' | 'timmy.profile' | 'timmy.remember' | 'timmy.cap';

export function initialTimmyState(room: string, now: string, capUsd: number): TimmyState {
  return {
    v: 1, room, created_at: now, updated_at: now, profile: null,
    spend: { usd: 0, cap_usd: capUsd, calls: 0, tokens_in: 0, tokens_out: 0, tokens_cached: 0, tokens_reasoning: 0, uncounted: 0, last_at: null, max_price: null },
    turns: 0, head: null, last_turn: null, memory_notes: 0, calls: 0
  };
}

/** Why this Timmy may not think right now. */
export function timmyGate(state: TimmyState): string | null {
  if (state.spend.usd >= state.spend.cap_usd) return `budget reached: ${state.spend.usd.toFixed(4)} USD of ${state.spend.cap_usd} USD (the project profile's max_spend_usd)`;
  return null;
}

export interface ThinkOut { ok: boolean; turn_id: string; room: string; answer: string; usd: number; ms: number; receipt: string; models: { role: string; model: string; ok: boolean }[]; hands: unknown; error?: string }

interface TurnRow { id: string; ts: string; mode: string; by: string; status: string; usd: number; receipt: string; task: string; answer: string }

export class Timmy extends McpAgent<TimmyEnv, TimmyState, TimmyProps> {
  server = new McpServer({ name: 'timmy', version: '1.0.0' });
  initialState: TimmyState = initialTimmyState('', '1970-01-01T00:00:00.000Z', 2);
  private tables = false;
  private sealChain: Promise<unknown> = Promise.resolve();

  private ensureTables(): void {
    if (this.tables) return;
    this.sql`CREATE TABLE IF NOT EXISTS turns (id TEXT PRIMARY KEY, ts TEXT NOT NULL, mode TEXT NOT NULL, by TEXT NOT NULL, status TEXT NOT NULL, usd REAL NOT NULL, receipt TEXT NOT NULL, task TEXT NOT NULL, answer TEXT NOT NULL)`;
    this.sql`CREATE TABLE IF NOT EXISTS memory (k TEXT PRIMARY KEY, v TEXT NOT NULL, ts TEXT NOT NULL)`;
    this.sql`CREATE TABLE IF NOT EXISTS receipts (seq INTEGER PRIMARY KEY AUTOINCREMENT, hash TEXT UNIQUE NOT NULL, kind TEXT NOT NULL, ts TEXT NOT NULL, body TEXT NOT NULL)`;
    this.tables = true;
    if (!this.state.room || this.state.room !== this.room) {
      const now = new Date().toISOString();
      this.setState({ ...initialTimmyState(this.room, now, capFromEnv(this.env)), room: this.room });
    }
  }

  /** The project room this Timmy is (the DO name minus the RPC prefix). */
  get room(): string {
    return roomOf(this.name);
  }

  // ------------------------------------------------------------ chain (one per Timmy)

  private chain(): EdgeReceipt[] {
    this.ensureTables();
    return [...this.sql<{ body: string }>`SELECT body FROM receipts ORDER BY seq ASC`].map((r) => JSON.parse(r.body) as EdgeReceipt);
  }

  /** Seals are serialised: two concurrent seals must not compute prev_hash from the same head. */
  private seal(kind: TimmyReceiptKind, data: Record<string, unknown>): Promise<EdgeReceipt> {
    const p = this.sealChain.then(async () => {
      const chain = this.chain();
      const rec = await appendEdgeReceipt(chain, { kind, subject: timmySubject(this.room), data });
      this.sql`INSERT INTO receipts (hash, kind, ts, body) VALUES (${rec.hash}, ${rec.kind}, ${rec.ts}, ${JSON.stringify(rec)})`;
      if (this.env.CUSTODY_KV) {
        try { await this.env.CUSTODY_KV.put(timmyChainKey(this.room), JSON.stringify(chain)); } catch { /* KV mirror is best effort; SQL is the record */ }
      }
      this.setState({ ...this.state, head: rec.hash, updated_at: rec.ts });
      return rec;
    });
    this.sealChain = p.catch(() => undefined);
    return p;
  }

  private executor(): Executor | undefined {
    if (!this.env.LOADER) return undefined;
    return new DynamicWorkerExecutor({ loader: this.env.LOADER as never, timeout: 60_000 }) as unknown as Executor;
  }

  // ------------------------------------------------------------ the Timmy's own verbs (RPC-callable from the worker)

  /** One turn of this Timmy's mind under its project budget; seals timmy.turn on its chain. */
  async rpcThink(body: TurnRequest & { by?: string }): Promise<ThinkOut> {
    this.ensureTables();
    const gate = timmyGate(this.state);
    if (gate) throw new HttpError(402, gate);
    const mode: CommanderMode = isMode(body.mode) ? body.mode : 'generate';
    const profile = this.state.profile;
    // the project profile's models are the default mind/actors unless the caller names models
    const models = body.models?.length ? body.models : mode === 'generate' ? (profile?.mind ? [profile.mind] : undefined) : (profile?.actors?.length ? profile.actors : undefined);
    const req: TurnRequest = { ...body, ...(models ? { models } : {}), source: body.source ?? 'mcp' };
    const r = await executeTurn(req, mode, { env: this.env, executor: this.executor(), room: `timmy:${this.room}`, spend: this.state.spend });
    const now = new Date().toISOString();
    const spent = applySpend(this.state, r.calls, now);
    const by = String(body.by ?? 'openrouter').slice(0, 80);
    const rec = await this.seal('timmy.turn', { ...(await turnReceiptData(req, r, by)), room: this.room, project: profile?.name ?? null });
    this.sql`INSERT INTO turns (id, ts, mode, by, status, usd, receipt, task, answer) VALUES (${r.turn_id}, ${now}, ${r.mode}, ${by}, ${r.ok ? 'ok' : 'failed'}, ${r.usd}, ${rec.hash}, ${String(body.task).slice(0, 20000)}, ${r.answer.slice(0, 60000)})`;
    this.setState({ ...spent, head: rec.hash, turns: spent.turns + 1, last_turn: r.turn_id, calls: (this.state.calls ?? 0) + 1, updated_at: now });
    return { ok: r.ok, turn_id: r.turn_id, room: this.room, answer: r.answer, usd: r.usd, ms: r.ms, receipt: rec.hash, models: r.calls.map((c: ModelCall) => ({ role: c.role, model: c.model, ok: c.ok })), hands: r.hands };
  }

  /** Set the project profile (from ~/timmy/projects/<name>/profile.cue); seals timmy.profile. */
  async rpcProfile(p: Partial<TimmyProfile> & { name: string }): Promise<{ ok: true; profile: TimmyProfile; receipt: string }> {
    this.ensureTables();
    if (!p || typeof p.name !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,39}$/.test(p.name)) throw new HttpError(400, 'profile.name required (project-folder/v0 name)');
    const now = new Date().toISOString();
    const budget = Number(p.budget_usd ?? 2);
    if (!Number.isFinite(budget) || budget < 0) throw new HttpError(400, 'budget_usd must be a number >= 0');
    const profile: TimmyProfile = {
      name: p.name, owner: p.owner ? String(p.owner).slice(0, 80) : null, budget_usd: budget, mind: p.mind ? String(p.mind) : null,
      actors: Array.isArray(p.actors) ? p.actors.map(String).slice(0, 8) : [], standard: p.standard ? String(p.standard) : null,
      profile_sha256: p.profile_sha256 ? String(p.profile_sha256) : null, set_at: now
    };
    const rec = await this.seal('timmy.profile', { ...profile, room: this.room, previous_budget: this.state.spend.cap_usd });
    this.setState({ ...this.state, profile, spend: { ...this.state.spend, cap_usd: budget }, head: rec.hash, updated_at: now });
    return { ok: true, profile, receipt: rec.hash };
  }

  async rpcRemember(k: string, v: unknown, forget = false): Promise<{ ok: true; k: string; notes: number; receipt: string }> {
    this.ensureTables();
    const key = String(k ?? '').trim().slice(0, 120);
    if (!key) throw new HttpError(400, 'k required');
    const now = new Date().toISOString();
    if (forget) this.sql`DELETE FROM memory WHERE k = ${key}`;
    else this.sql`INSERT INTO memory (k, v, ts) VALUES (${key}, ${JSON.stringify(v ?? null).slice(0, 8000)}, ${now}) ON CONFLICT(k) DO UPDATE SET v = excluded.v, ts = excluded.ts`;
    const n = Number([...this.sql<{ n: number }>`SELECT COUNT(*) AS n FROM memory`][0]?.n ?? 0);
    const rec = await this.seal('timmy.remember', { k: key, forget, notes: n, room: this.room });
    this.setState({ ...this.state, memory_notes: n, head: rec.hash, updated_at: now });
    return { ok: true, k: key, notes: n, receipt: rec.hash };
  }

  rpcState(): Record<string, unknown> {
    this.ensureTables();
    return { ok: true, room: this.room, state: this.state, memory: [...this.sql<{ k: string; v: string; ts: string }>`SELECT k, v, ts FROM memory ORDER BY ts DESC LIMIT 50`].map((r) => ({ k: r.k, v: JSON.parse(r.v), ts: r.ts })) };
  }

  rpcTurns(limit = 20): TurnRow[] {
    this.ensureTables();
    return [...this.sql<TurnRow>`SELECT id, ts, mode, by, status, usd, receipt, task, answer FROM (SELECT * FROM turns ORDER BY ts DESC LIMIT ${Math.min(200, Math.max(1, limit))}) ORDER BY ts ASC`];
  }

  async rpcReceipts(limit = 50, verify = false): Promise<Record<string, unknown>> {
    const chain = this.chain();
    return { ok: true, room: this.room, count: chain.length, ...(verify ? { verify: await verifyEdgeChain(chain) } : {}), receipts: chain.slice(-Math.min(500, Math.max(1, limit))) };
  }

  // ------------------------------------------------------------ MCP surface (the same verbs as tools)

  async init(): Promise<void> {
    const text = (o: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(o) }] });
    const fail = (e: unknown) => ({ isError: true, content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e), status: e instanceof HttpError ? e.status : 500 }) }] });

    this.server.registerTool('whoami', { description: 'Which Timmy this is: its room (project), profile, budget, turns, chain head.', inputSchema: {} }, async () => {
      this.ensureTables();
      return text({ ok: true, room: this.room, do_name: this.name, props_room: this.props?.room ?? null, profile: this.state.profile, spend: this.state.spend, turns: this.state.turns, head: this.state.head });
    });

    this.server.registerTool('think', {
      description: 'One turn of this Timmy\'s mind on a task, under its project budget. Seals timmy.turn on the project chain and returns the answer with the receipt hash.',
      inputSchema: { task: z.string().min(1).max(20000), system: z.string().max(4000).optional(), mode: z.enum(['generate', 'bodybuilder', 'fusion']).optional(), models: z.array(z.string()).max(6).optional(), max_tokens: z.number().int().min(64).max(8192).optional(), hands: z.boolean().optional(), by: z.string().max(80).optional() }
    }, async (a) => {
      try { return text(await this.rpcThink(a as TurnRequest & { by?: string })); } catch (e) { return fail(e); }
    });

    this.server.registerTool('state', { description: 'This Timmy\'s state: profile, spend ledger, turns, memory notes, chain head.', inputSchema: {} }, async () => text(this.rpcState()));

    this.server.registerTool('remember', { description: 'Write (or forget) one memory note on this Timmy; seals timmy.remember.', inputSchema: { k: z.string().min(1).max(120), v: z.unknown().optional(), forget: z.boolean().optional() } }, async (a) => {
      try { return text(await this.rpcRemember(a.k, a.v, !!a.forget)); } catch (e) { return fail(e); }
    });

    this.server.registerTool('receipts', { description: 'The tail of this Timmy\'s receipt chain (subject timmy:<room>), optionally verified from genesis.', inputSchema: { limit: z.number().int().min(1).max(500).optional(), verify: z.boolean().optional() } }, async (a) => text(await this.rpcReceipts(a.limit ?? 50, !!a.verify)));

    this.server.registerTool('profile', { description: 'Set this Timmy\'s project profile (name, owner, budget_usd, mind, actors, profile_sha256); the budget becomes the spend cap. Seals timmy.profile.', inputSchema: { name: z.string().min(1).max(40), owner: z.string().max(80).optional(), budget_usd: z.number().min(0).optional(), mind: z.string().optional(), actors: z.array(z.string()).max(8).optional(), standard: z.string().optional(), profile_sha256: z.string().optional() } }, async (a) => {
      try { return text(await this.rpcProfile(a as Partial<TimmyProfile> & { name: string })); } catch (e) { return fail(e); }
    });
  }
}
