/**
 * R11 round 4 (H169; the operator's order of 2026-10-23 19:17: "Wire the actual AgentCore SDK tool loop (installed
 * @openrouter/sdk client.callModel), not merely the legacy raw POST /chat stream. Preserve SDK events, policy, job identity,
 * cancellation and native receipts."): the companion page's chat is the REAL turn, the one every other surface runs:
 *
 *   src/agent/chat-session.ts openChatSession({ project, surface: 'companion' })
 *     → src/agent/chat-turn.ts projectTurn (the project's turn hold: one turn at a time across every surface; the keyed
 *       message sent once; the route snapshotted; Stop through requestTurnStop by the turn's id)
 *     → src/repl/turn.ts runTurn with the Agent of src/agent/core.ts (@openrouter/sdk client.callModel's tool loop on the
 *       OpenRouter route; src/agent/local-chat.ts on the local route), the route policy (free-only, local-only), the
 *       NEEDS YOU gate (src/repl/approvals.ts gateTools: a tool that needs a person waits for the page's answer), and the
 *       REPL's own seal (src/repl/seal.ts sealTurn) into the project's store, the receipt naming surface 'companion'.
 *
 * Contract C3 (R11-R4-COMMON): POST /api/chat/turn (the launch token, then the user's session: withUser) with JSON
 * { message, key?, project: { root } } answers Server-Sent Events, in this order:
 *
 *   route      { kind, label, model, where }                       before anything is sent; with no ready route an `error`
 *                                                                  carries the refusal's words and NOTHING is sent anywhere
 *   turn       { id, surface: 'companion', startedAt, receiptPending: true }   the hold taken: the id Stop names
 *   delta      { text }                                            the answer as it streams (text: what was added)
 *   tool       { call, name, status, words }                       each tool as the loop runs it: 'asked' (the model asked
 *                                                                  for it), 'ran', 'failed', 'refused' (NEEDS YOU denied)
 *   needs-you  { id, turn, tool, words, detail?, options }          the NEEDS YOU gate: the page answers with
 *                                                                  POST /api/chat/answer { id, choice }; a page that never
 *                                                                  answers denies after NEEDS_YOU_TIMEOUT_MS, said in a `tool`
 *   done       { status, receipt, model, steps, cost, costUsd, costMeasured, fellBack, sent, turn, lines? }
 *                                                                  sealTurn's facts: hashes and numbers, never the words
 *   error      { words, lines }                                    a refusal (nothing sent) or a failure
 *
 * POST /api/chat/answer { id, choice: 'once' | 'session' | 'deny' } answers a NEEDS YOU of this user's turn.
 * POST /api/chat/stop { id } asks a turn this page started to stop (requestTurnStop by the hold's id, the one `turn` carried);
 * a turn of another surface names its project too ({ id, project: { root } }). The turn, or the project, must be this
 * user's, so one user never stops another's turn.
 *
 * The user: every request runs under userEnv(user) (contract C1, src/companion/identity: the user's own Timmy home, settings
 * and credentials), never process.env, and only for a project isOwnedRoot(user, root, env) says is the user's (400 otherwise).
 * One agent per project in this process (chat-session.ts), the agent's key and model read from the user's settings at every
 * message (ChatSessionDeps.settings). Nothing of a request is logged with its key.
 */
import type express from 'express';
import { basename } from 'node:path';
import { openChatSession } from '../agent/chat-session.js';
import { requestTurnStop, surfaceWords, TURN_ID } from '../agent/chat-turn.js';
import { CHAT_KEY, type ChatTurnHooks, type ChatTurnResult } from '../contracts/chat-session.js';
import type { ApprovalRequest, Decision } from '../repl/approvals.js';
import { keyInUse } from '../setup/provider-keys.js';
import { pageModel, pageRoute, type PageRoute } from './chat-route.js';

type Env = Record<string, string | undefined>;

/** The user a verified session names (contract C1: verifySession's user; `withUser` puts it on the request). */
export interface ChatUser { id: string; username?: string; email?: string }

export interface ChatRunDeps {
  /** the launch token's check (src/companion/server.ts withToken), first on every route */
  withToken: express.RequestHandler;
  /** contract C1: the user's verified session (401 with words when absent or invalid); puts `req.user` */
  withUser: express.RequestHandler;
  json: express.RequestHandler;
  /** contract C1: the user's own environment (the user's Timmy home, settings dir, credentials), from this process's */
  userEnv: (user: ChatUser, base?: Env) => Env;
  /** contract C1: whether a project root is one of this user's (the registry, or a folder under the user's projects) */
  isOwnedRoot: (user: ChatUser, root: string, env: Env) => boolean;
  /** how long a NEEDS YOU waits for the page before it is denied (default NEEDS_YOU_TIMEOUT_MS) */
  needsYouTimeoutMs?: number;
  /** opens the session (default openChatSession: the real turn); a test may count its calls, never replace the turn */
  open?: typeof openChatSession;
}

/** A NEEDS YOU nobody answered on the page is denied after this long (the gate then tells the model). */
export const NEEDS_YOU_TIMEOUT_MS = 120_000;
export const DECISIONS: readonly Decision[] = ['once', 'session', 'deny'];

const userOf = (req: express.Request): ChatUser | null => {
  const u = (req as express.Request & { user?: unknown }).user;
  return u && typeof u === 'object' && typeof (u as ChatUser).id === 'string' && (u as ChatUser).id ? (u as ChatUser) : null;
};
const text = (v: unknown, max: number): string | null => (typeof v === 'string' && v.trim() && v.length <= max ? v : null);
const rootOf = (body: unknown): string | null => {
  const p = body && typeof body === 'object' ? (body as { project?: unknown }).project : undefined;
  return p && typeof p === 'object' ? text((p as { root?: unknown }).root, 4096) : null;
};

/** Where the route's model answers, in words, from the page's route. */
export function whereOf(r: PageRoute): string {
  if (r.kind === 'openrouter') return 'OpenRouter (cloud)';
  if (r.kind === 'local') return r.cloud ? 'Ollama\'s servers (your Ollama account)' : r.loopback ? 'this computer' : `the Ollama at ${r.host} (another computer)`;
  return 'nowhere: no route';
}

/** The user's own settings, read by path under the user's env at every message (never this process's store). */
export function userSettings(env: Env, cwd: string): { apiKey?: string; model?: string } {
  const key = (() => { try { return keyInUse('openrouter', env, cwd)?.key; } catch { return undefined; } })();
  const model = (() => { try { return pageModel(env, cwd); } catch { return ''; } })();
  return { ...(key ? { apiKey: key } : {}), ...(model ? { model } : {}) };
}

/** One SSE writer: events in order, nothing after the end. */
function sseWriter(res: express.Response): { send(event: string, data: unknown): void; end(): void } {
  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  return {
    send: (event, data) => { if (res.writableEnded || res.destroyed) return; try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch { /* the page went away */ } },
    end: () => { try { if (!res.writableEnded) res.end(); } catch { /* the socket is gone */ } },
  };
}

/** The NEEDS YOU asks waiting for a page's answer, by id; each belongs to one user. */
interface PendingAsk { user: string; resolve: (d: Decision) => void }

export function mountChatRun(app: express.Express, deps: ChatRunDeps): void {
  const open = deps.open ?? openChatSession;
  const timeoutMs = deps.needsYouTimeoutMs ?? NEEDS_YOU_TIMEOUT_MS;
  const waitWords = timeoutMs >= 1000 ? `${Math.round(timeoutMs / 1000)} s` : `${timeoutMs} ms`;
  const pending = new Map<string, PendingAsk>();
  /** the turns this page started and still running, by the hold's id: whose, and in which project (so Stop needs only the id) */
  const turns = new Map<string, { user: string; root: string }>();
  let askSeq = 0;

  app.post('/api/chat/turn', deps.withToken, deps.withUser, deps.json, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const user = userOf(req);
    if (!user) { res.status(401).json({ ok: false, error: 'Not sent: no signed-in user on this request.' }); return; }
    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as { message?: unknown; key?: unknown };
    const message = text(body.message, 64_000);
    if (!message) { res.status(400).json({ ok: false, error: 'Not sent: the request names no message ({ message, project: { root } }).' }); return; }
    const key = body.key === undefined ? undefined : typeof body.key === 'string' && CHAT_KEY.test(body.key) ? body.key : null;
    if (key === null) { res.status(400).json({ ok: false, error: 'Not sent: the message\'s key is not one (8 to 80 letters, digits, - or _).' }); return; }
    const root = rootOf(req.body);
    if (!root) { res.status(400).json({ ok: false, error: 'Not sent: the request names no project ({ project: { root } }).' }); return; }
    const env = deps.userEnv(user);
    if (!deps.isOwnedRoot(user, root, env)) { res.status(400).json({ ok: false, error: 'Not sent: that project is not one of this account\'s projects, so nothing runs in it.' }); return; }

    const sse = sseWriter(res);
    let session: Awaited<ReturnType<typeof openChatSession>>;
    try {
      session = await open({ project: { name: basename(root), root }, surface: 'companion' }, { env, settings: () => userSettings(env, root) });
    } catch (err) {
      sse.send('error', { words: `The chat could not be opened: ${(err as Error)?.message ?? String(err)}.`, lines: ['Nothing was sent to any model.'] });
      sse.end();
      return;
    }
    // the route first, as every surface reads it: not ready, the refusal's words and nothing sent anywhere
    const state = session.route();
    const page = pageRoute(env, root);
    if (!state.ready) {
      const lines = state.refusal?.length ? [...state.refusal] : ['Not sent: the chat has no route to a model.', 'Nothing was sent to any model.'];
      sse.send('error', { words: lines.join('\n'), lines });
      sse.end();
      return;
    }
    sse.send('route', { kind: page.kind, label: page.label, model: page.kind === 'none' ? null : page.model, where: whereOf(page) });

    let turnId: string | undefined;
    let last = '';
    const calls = new Map<string, string>();
    const denied = new Set<string>();
    const hooks: ChatTurnHooks = {
      onTurn: (t) => { turnId = t.id; turns.set(t.id, { user: user.id, root }); sse.send('turn', { id: t.id, surface: 'companion', startedAt: t.startedAt, receiptPending: true }); },
      onText: (full) => {
        const added = full.startsWith(last) ? full.slice(last.length) : full;
        if (added || !full.startsWith(last)) sse.send('delta', { text: added, ...(full.startsWith(last) ? {} : { reset: true }) });
        last = full;
      },
      onTool: (e) => {
        if (e.phase === 'start') { calls.set(e.id, e.name); sse.send('tool', { call: e.id, name: e.name, status: 'asked', words: `${e.name}: the model asked for it` }); return; }
        const status = e.outcome === 'completed' ? 'ran' : denied.has(e.name) ? 'refused' : 'failed';
        if (status === 'refused') denied.delete(e.name);
        sse.send('tool', { call: e.id, name: e.name, status, words: status === 'ran' ? `${e.name} ran` : status === 'refused' ? `${e.name} did not run: denied at NEEDS YOU` : `${e.name} failed` });
      },
      askPerson: (ask: ApprovalRequest): Promise<Decision> => new Promise<Decision>((resolve) => {
        const id = `ask-${Date.now().toString(36)}-${++askSeq}`;
        const options = ask.session === false ? (['once', 'deny'] as Decision[]) : [...DECISIONS];
        const timer = setTimeout(() => {
          if (!pending.has(id)) return;
          pending.delete(id);
          denied.add(ask.tool);
          sse.send('tool', { call: id, name: ask.tool, status: 'refused', words: `${ask.tool} did not run: nobody decided on this page within ${waitWords}, so it was denied. Next time, answer the NEEDS YOU here, or run the turn in the REPL (timmy) or the Workbench, where the box waits.` });
          resolve('deny');
        }, timeoutMs);
        pending.set(id, { user: user.id, resolve: (d) => { clearTimeout(timer); pending.delete(id); if (d === 'deny') denied.add(ask.tool); resolve(d); } });
        sse.send('needs-you', { id, turn: turnId ?? null, tool: ask.tool, words: `${ask.summary} (${ask.reason})`, ...(ask.detail ? { detail: ask.detail } : {}), options });
      }),
    };
    let result: ChatTurnResult;
    try {
      result = key !== undefined ? await session.sendOnce(key, message, hooks) : await session.send(message, hooks);
    } catch (err) {
      sse.send('error', { words: `The turn failed: ${(err as Error)?.message ?? String(err)}.`, lines: [] });
      sse.end();
      return;
    } finally {
      if (turnId) turns.delete(turnId);
    }
    const facts = {
      status: result.status, sent: result.sent, ...(result.receipt ? { receipt: result.receipt } : {}), ...(result.model ? { model: result.model } : {}),
      steps: result.steps ?? 0, cost: result.costWords, costUsd: result.costUsd ?? null, costMeasured: result.costMeasured ?? false, fellBack: result.fellBack ?? false,
      turn: result.turnId ?? turnId ?? null, ...(result.lines?.length ? { lines: result.lines } : {}),
    };
    if (result.status === 'refused') sse.send('error', { words: (result.lines ?? []).join('\n'), lines: result.lines ?? [] });
    else {
      if (result.status === 'failed') sse.send('error', { words: (result.lines ?? []).join('\n'), lines: result.lines ?? [] });
      sse.send('done', facts);
    }
    sse.end();
  });

  app.post('/api/chat/answer', deps.withToken, deps.withUser, deps.json, (req, res) => {
    res.set('Cache-Control', 'no-store');
    const user = userOf(req);
    if (!user) { res.status(401).json({ ok: false, error: 'Not answered: no signed-in user on this request.' }); return; }
    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as { id?: unknown; choice?: unknown };
    const id = text(body.id, 80);
    const choice = typeof body.choice === 'string' && (DECISIONS as readonly string[]).includes(body.choice) ? body.choice as Decision : null;
    if (!id || !choice) { res.status(400).json({ ok: false, error: 'Not answered: the request names no NEEDS YOU ({ id, choice: once | session | deny }).' }); return; }
    const ask = pending.get(id);
    if (!ask || ask.user !== user.id) { res.status(404).json({ ok: false, error: 'Not answered: no NEEDS YOU of this account waits under that id (it was answered, denied after its wait, or is another account\'s).' }); return; }
    ask.resolve(choice);
    res.json({ ok: true, id, choice });
  });

  // R5 lead's Stop (requestTurnStop by the turn's id), now for the user's own project only
  app.post('/api/chat/stop', deps.withToken, deps.withUser, deps.json, (req, res) => {
    res.set('Cache-Control', 'no-store');
    const user = userOf(req);
    if (!user) { res.status(401).json({ ok: false, error: 'Not stopped: no signed-in user on this request.' }); return; }
    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as { id?: unknown; turn?: unknown };
    const id = text(body.id ?? body.turn, 80);
    if (!id || !TURN_ID.test(id)) { res.status(400).json({ ok: false, error: 'Not stopped: the request names no chat turn ({ id: <the turn\'s id> }).' }); return; }
    // a turn this page started is known by its id (contract C3: { id } alone); a turn seen elsewhere names its project too
    const known = turns.get(id);
    if (known && known.user !== user.id) { res.status(400).json({ ok: false, error: 'Not stopped: that turn is another account\'s, so it is not yours to stop.' }); return; }
    const root = rootOf(req.body) ?? known?.root ?? null;
    if (!root) { res.status(400).json({ ok: false, error: 'Not stopped: no running turn of this page has that id; a turn of another surface names its project ({ id, project: { root } }).' }); return; }
    const env = deps.userEnv(user);
    if (!deps.isOwnedRoot(user, root, env)) { res.status(400).json({ ok: false, error: 'Not stopped: that project is not one of this account\'s projects, so no turn of it is yours to stop.' }); return; }
    const r = requestTurnStop(root, id, 'companion');
    if (!r.ok) { res.status(409).json({ ok: false, error: `Not stopped: ${r.why}.` }); return; }
    res.json({ ok: true, words: `Stop asked of the turn being answered in ${surfaceWords(r.surface)}: it stops there at once, and its receipt says it was stopped, asked from this page.` });
  });
}
