// timmy-ai-proxy — hardened Cloudflare edge proxy for TIMMY, now with Code Mode.
// Secrets live at the edge that uses them (Worker secrets, never on disk):
//   OPENROUTER_API_KEY — upstream key
//   TIMMY_EDGE_TOKEN   — caller auth; every non-health route requires it
// Hardened 2026-08-15 per review: the old /code (new Function) was REMOVED —
// Workers disallow eval-class constructs and it was an unauthenticated exec
// surface. 2026-09-05: /code returns as CODE MODE — the script runs in a
// separate Dynamic Worker isolate (Worker Loader binding), never in this
// isolate; caller auth applies; every run seals one receipt (script hash,
// output hash, tool calls); paid tools inside the script still need the
// operator approval token. Undeployed until the owner says deploy.
// 2026-09-08 (swarm-b3k7): /commander/:room/swarm runs swarm specs; Timmy is a
// Level-2 durable agent at /timmy/:room/{state,think,turns,receipts,profile,
// remember} and exposes MCP over HTTP at /timmy/mcp (tools name the room) and
// over Durable Object RPC to the root commander; GET /providers is the live
// OpenRouter provider list; every upstream call carries app attribution.
import { DynamicWorkerExecutor } from '@cloudflare/codemode';
import { McpServer } from '@modelcontextprotocol/server';
import { RPC_DO_PREFIX, createMcpHandler } from 'agents/mcp';
import { z } from 'zod';
import { HttpError, runCode, type CodeRequest, type Executor } from './code.js';
import { computeDailyHead, readLatestHead, writeDailyHead } from './head.js';
import { type Env, edgeTools, isAllowed, openrouterHeaders, toolTypes } from './tools.js';
import { corsHeaders, parseRunsPath, validRoom } from './room-core.js';
import { isReadAction, parseCommanderPath, providersList, validCommanderRoom, type TurnRequest } from './commander-core.js';
import { getAgentByName } from 'agents';
import type { Commander } from './commander.js';
import type { Timmy, TimmyProfile } from './timmy.js';
export { SlateRoom } from './room.js';
export { Commander } from './commander.js';
export { Timmy } from './timmy.js';

let windowStart = 0;
let windowCount = 0;

const json = (body: unknown, status = 200): Response => Response.json(body, { status, headers: corsHeaders() });

type RoomEnv = Env & { LOADER?: unknown; SLATE_ROOM?: DurableObjectNamespace; COMMANDER?: DurableObjectNamespace<Commander>; TIMMY?: DurableObjectNamespace<Timmy> };

const TIMMY_ROOM_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;
/**
 * The Durable Object instance behind a Timmy room. The Agents SDK's RPC MCP
 * transport (what the root commander uses) addresses the McpAgent as
 * `${RPC_DO_PREFIX}${serverName}`, so the HTTP and MCP routes use the same
 * name and every caller lands on the ONE Timmy of that project.
 */
export const timmyDoName = (room: string): string => `${RPC_DO_PREFIX}${room}`;
type TimmyAction = 'state' | 'think' | 'turns' | 'receipts' | 'profile' | 'remember' | 'mcp';
const TIMMY_READS: readonly TimmyAction[] = ['state', 'turns', 'receipts'] as const;

/** /timmy/mcp (the stateless MCP endpoint) or /timmy/:room/<action>. */
export function parseTimmyPath(pathname: string): { room: string | null; action: TimmyAction } | null {
  const parts = pathname.split('/').filter(Boolean);
  if (parts[0] !== 'timmy' || parts.length < 2 || parts.length > 3) return null;
  if (parts.length === 2 && parts[1] === 'mcp') return { room: null, action: 'mcp' };
  const room = decodeURIComponent(parts[1]);
  const action = (parts[2] ?? 'state') as TimmyAction;
  if (!['state', 'think', 'turns', 'receipts', 'profile', 'remember'].includes(action)) return null;
  return { room, action };
}

/** The MCP server outside callers see at /timmy/mcp: every tool names the room, so one endpoint reaches every project's Timmy. */
function timmyMcpServer(env: RoomEnv): McpServer {
  const server = new McpServer({ name: 'timmy-of-timmys', version: '1.0.0' });
  const text = (o: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(o) }] });
  const fail = (e: unknown) => ({ isError: true, content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) }) }] });
  const stub = async (room: string) => {
    if (!env.TIMMY) throw new Error('no TIMMY binding on this deployment');
    if (!TIMMY_ROOM_RE.test(room)) throw new Error('bad room name');
    return getAgentByName(env.TIMMY, timmyDoName(room), { props: { room } });
  };
  server.registerTool('timmy_think', { description: 'Ask one project\'s Timmy (room, e.g. project:ship) to think on a task under its own budget; returns the answer and the timmy.turn receipt hash.', inputSchema: { room: z.string().min(1).max(100), task: z.string().min(1).max(20000), system: z.string().max(4000).optional(), mode: z.enum(['generate', 'bodybuilder', 'fusion']).optional(), models: z.array(z.string()).max(6).optional(), by: z.string().max(80).optional() } }, async (a) => {
    try { const s = await stub(a.room); return text(await s.rpcThink({ task: a.task, system: a.system, mode: a.mode, models: a.models, by: a.by ?? 'mcp' })); } catch (e) { return fail(e); }
  });
  server.registerTool('timmy_state', { description: 'One project Timmy\'s state: profile, spend, turns, memory, chain head.', inputSchema: { room: z.string().min(1).max(100) } }, async (a) => {
    try { const s = await stub(a.room); return text(await s.rpcState()); } catch (e) { return fail(e); }
  });
  server.registerTool('timmy_receipts', { description: 'The tail of one project Timmy\'s receipt chain (subject timmy:<room>), optionally verified.', inputSchema: { room: z.string().min(1).max(100), limit: z.number().int().min(1).max(500).optional(), verify: z.boolean().optional() } }, async (a) => {
    try { const s = await stub(a.room); return text(await s.rpcReceipts(a.limit ?? 50, !!a.verify)); } catch (e) { return fail(e); }
  });
  server.registerTool('timmy_remember', { description: 'Write or forget one memory note on a project Timmy.', inputSchema: { room: z.string().min(1).max(100), k: z.string().min(1).max(120), v: z.unknown().optional(), forget: z.boolean().optional() } }, async (a) => {
    try { const s = await stub(a.room); return text(await s.rpcRemember(a.k, a.v, !!a.forget)); } catch (e) { return fail(e); }
  });
  return server;
}

export default {
  async fetch(req: Request, env: RoomEnv, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === '/health') {
      return json({ ok: true, worker: 'timmy-ai-proxy', auth: true, code_mode: !!env.LOADER, daily_head: !!env.CUSTODY_KV, slate_room: !!env.SLATE_ROOM, commander: !!env.COMMANDER, timmy: !!env.TIMMY, swarm: !!env.COMMANDER, tools: edgeTools().map((t) => t.name) });
    }

    // Commander (Agents SDK durable agent, mindship-v5c2 step 2). Reads and the
    // WebSocket feed are public like the rooms; every command needs the caller
    // token, except the holder's own /turn and /release which carry the hold token.
    const cmd = parseCommanderPath(url.pathname);
    if (cmd) {
      if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders() });
      if (!env.COMMANDER) return json({ ok: false, error: 'no COMMANDER binding on this deployment' }, 503);
      if (!validCommanderRoom(cmd.room)) return json({ ok: false, error: 'bad room name' }, 400);
      const holderRoute = cmd.action === 'turn' || cmd.action === 'release';
      if (!isReadAction(cmd.action) && !holderRoute) {
        const want = `Bearer ${env.TIMMY_EDGE_TOKEN ?? ''}`;
        if (!env.TIMMY_EDGE_TOKEN || (req.headers.get('Authorization') ?? '') !== want) return json({ ok: false, error: 'unauthorized' }, 401);
      }
      const agent = await getAgentByName(env.COMMANDER, cmd.room);
      return agent.fetch(req);
    }

    // Timmy-of-Timmys (swarm-b3k7 step 4): one durable Timmy per project room.
    // Reads are public like the commander's; think/profile/remember and the MCP
    // endpoint need the caller token.
    const tm = parseTimmyPath(url.pathname);
    if (tm) {
      if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders() });
      if (!env.TIMMY) return json({ ok: false, error: 'no TIMMY binding on this deployment' }, 503);
      const authed = !!env.TIMMY_EDGE_TOKEN && (req.headers.get('Authorization') ?? '') === `Bearer ${env.TIMMY_EDGE_TOKEN}`;
      if (tm.action === 'mcp') {
        if (!authed) return json({ ok: false, error: 'unauthorized' }, 401);
        return createMcpHandler(() => timmyMcpServer(env))(req, env, ctx);
      }
      const room = tm.room as string;
      if (!TIMMY_ROOM_RE.test(room)) return json({ ok: false, error: 'bad room name' }, 400);
      const agent = await getAgentByName(env.TIMMY, timmyDoName(room), { props: { room } });
      try {
        if ((TIMMY_READS as readonly string[]).includes(tm.action)) {
          if (tm.action === 'state') return json(await agent.rpcState());
          if (tm.action === 'turns') return json({ ok: true, room, turns: await agent.rpcTurns(Math.min(200, Math.max(1, Number(url.searchParams.get('limit') ?? 20)))) });
          return json(await agent.rpcReceipts(Math.min(500, Math.max(1, Number(url.searchParams.get('limit') ?? 50))), url.searchParams.get('verify') === '1'));
        }
        if (req.method !== 'POST') return json({ ok: false, error: 'method not allowed' }, 405);
        if (!authed) return json({ ok: false, error: 'unauthorized' }, 401);
        let body: Record<string, unknown> = {};
        try { const t = await req.text(); body = t ? (JSON.parse(t) as Record<string, unknown>) : {}; } catch { return json({ ok: false, error: 'bad json' }, 400); }
        if (tm.action === 'think') return json(await agent.rpcThink({ ...(body as unknown as TurnRequest), by: String(body.by ?? 'http'), source: 'http' }));
        if (tm.action === 'profile') return json(await agent.rpcProfile(body as unknown as Partial<TimmyProfile> & { name: string }));
        return json(await agent.rpcRemember(String(body.k ?? ''), body.v, !!body.forget));
      } catch (e) {
        if (e instanceof HttpError) return json({ ok: false, error: e.message }, e.status);
        const msg = e instanceof Error ? e.message : String(e);
        const status = /^\d{3}\b/.test(msg) ? Number(msg.slice(0, 3)) : 500;
        return json({ ok: false, error: msg }, status >= 400 && status < 600 ? status : 500);
      }
    }

    // Slate rooms (Durable Object). Reads and the WebSocket are public like
    // /head; writes need the caller token. The room only stores and relays.
    const runs = parseRunsPath(url.pathname);
    if (runs) {
      if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders() });
      if (!env.SLATE_ROOM) return json({ ok: false, error: 'no SLATE_ROOM binding on this deployment' }, 503);
      if (runs.action !== 'create' && !validRoom(runs.room)) return json({ ok: false, error: 'bad room name' }, 400);
      if (req.method === 'POST') {
        const want = `Bearer ${env.TIMMY_EDGE_TOKEN ?? ''}`;
        if (!env.TIMMY_EDGE_TOKEN || (req.headers.get('Authorization') ?? '') !== want) return json({ ok: false, error: 'unauthorized' }, 401);
      }
      if (runs.action === 'create') return json({ ok: true, note: 'rooms exist on first write' });
      const stub = env.SLATE_ROOM.get(env.SLATE_ROOM.idFromName(runs.room));
      return stub.fetch(req);
    }

    // Public: the daily edge chain head (anyone can recompute the chains from the public log).
    if (url.pathname === '/head' && req.method === 'GET') {
      if (!env.CUSTODY_KV) return json({ ok: false, error: 'no CUSTODY_KV on this deployment' }, 503);
      const head = await readLatestHead(env.CUSTODY_KV);
      if (!head) return json({ ok: false, error: 'no head yet; the daily cron has not run' }, 404);
      // public data; browsers (Slate 3D capsule evidence) read it cross-origin
      return Response.json(head, { headers: corsHeaders() });
    }

    // Caller auth on everything else.
    const want = `Bearer ${env.TIMMY_EDGE_TOKEN ?? ''}`;
    if (!env.TIMMY_EDGE_TOKEN || (req.headers.get('Authorization') ?? '') !== want) {
      return json({ ok: false, error: 'unauthorized' }, 401);
    }

    // Ops: compute + publish today's head now (same code path as the daily cron).
    if (url.pathname === '/head/compute' && req.method === 'POST') {
      if (!env.CUSTODY_KV) return json({ ok: false, error: 'no CUSTODY_KV on this deployment' }, 503);
      const head = await computeDailyHead(env.CUSTODY_KV);
      await writeDailyHead(env.CUSTODY_KV, head);
      return json({ ok: true, head });
    }

    if (url.pathname === '/code/tools' && req.method === 'GET') {
      return json({ ok: true, types: toolTypes(), tools: edgeTools().map((t) => ({ name: t.name, description: t.description, paid: !!t.paid, destructive: !!t.destructive, schema: z.toJSONSchema(t.input) })) });
    }

    if (url.pathname === '/code' && req.method === 'POST') {
      if (!env.LOADER) return json({ ok: false, error: 'code_mode unavailable: no LOADER (worker_loaders) binding on this deployment' }, 503);
      let body: CodeRequest;
      try {
        body = (await req.json()) as CodeRequest;
      } catch {
        return json({ ok: false, error: 'bad json' }, 400);
      }
      const executor = new DynamicWorkerExecutor({ loader: env.LOADER as never, timeout: 60_000 }) as unknown as Executor;
      try {
        const out = await runCode(body, env, { executor });
        return json(out, out.ok ? 200 : 422);
      } catch (e) {
        if (e instanceof HttpError) return json({ ok: false, error: e.message }, e.status);
        return json({ ok: false, error: e instanceof Error ? e.message : String(e) }, 500);
      }
    }

    const key = env.OPENROUTER_API_KEY;
    if (!key) return json({ ok: false, error: 'OPENROUTER_API_KEY secret not set on worker' }, 500);
    const auth = openrouterHeaders(env, 'TIMMY');

    // providers-list: the live provider list, with a sha so a receipt can cite the list it saw.
    if (url.pathname === '/providers' && req.method === 'GET') {
      const p = await providersList(env);
      return json(p, p.ok ? 200 : 502);
    }

    if (url.pathname === '/models') {
      const r = await fetch('https://openrouter.ai/api/v1/models', { headers: auth });
      if (!r.ok) return new Response(await r.text(), { status: r.status }); // preserve upstream
      const j = (await r.json()) as { data?: { id: string; context_length?: number; pricing?: { prompt?: string; completion?: string } }[] };
      const slim = (j.data ?? []).map((m) => ({ id: m.id, ctx: m.context_length, in: m.pricing?.prompt, out: m.pricing?.completion }));
      return json(slim);
    }

    if (url.pathname === '/chat') {
      // Spend guard: model allowlist (+ variant suffixes) + per-minute rate limit.
      const allow = String(env.ALLOWED_MODELS ?? 'google/gemini-3.7-flash,x-ai/grok-4.6')
        .split(',')
        .map((s: string) => s.trim())
        .filter(Boolean);
      let body: { model?: string };
      try {
        body = (await req.json()) as { model?: string };
      } catch {
        return json({ ok: false, error: 'bad json' }, 400);
      }
      if (!isAllowed(allow, String(body?.model ?? ''))) {
        return json({ ok: false, error: 'model not on allowlist', allow }, 403);
      }
      const limit = Number(env.RATE_LIMIT_PER_MIN ?? 20);
      const now = Date.now();
      if (now - windowStart > 60000) {
        windowStart = now;
        windowCount = 0;
      }
      if (++windowCount > limit) {
        return json({ ok: false, error: 'rate limited' }, 429);
      }
      const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: auth,
        body: JSON.stringify(body)
      });
      // Preserve upstream status AND error bodies verbatim.
      return new Response(r.body, { status: r.status, headers: { 'Content-Type': 'application/json' } });
    }

    return json({ ok: false, error: 'not found; routes: /health /head /models /providers /chat /code /code/tools /runs/:room/{events,event,ws} /commander/:room/{state,spend,turns,swarms,receipts,schedules,memory,stats,providers,tools,ws,think,swarm,turn,mode,handoff,release,kill,revive,schedule,cancel,remember,cap} /timmy/mcp /timmy/:room/{state,turns,receipts,think,profile,remember}' }, 404);
  },

  // Daily cron (wrangler.toml [triggers]): walk every chain, publish the head.
  async scheduled(_event: { scheduledTime: number }, env: Env, ctx: { waitUntil(p: Promise<unknown>): void }): Promise<void> {
    if (!env.CUSTODY_KV) return;
    const kv = env.CUSTODY_KV;
    ctx.waitUntil(
      (async () => {
        const head = await computeDailyHead(kv);
        await writeDailyHead(kv, head);
      })()
    );
  }
};
