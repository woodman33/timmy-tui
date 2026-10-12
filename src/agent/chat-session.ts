/**
 * R4 (H103): the one chat path for every surface (src/contracts/chat-session.ts: ChatSession, OpenChatSession). The monitor
 * (`timmy watch`) calls it now; the terminal Workbench (H110), the REPL and later the companion can call it. It holds:
 *
 * - the route, read from the setup at every message (src/agent/chat-route.ts): the local model the setup chose (this
 *   computer's Ollama or the one it named), OpenRouter when a model key is found, or none;
 * - the honest refusal: a message with no ready route gets the words of why and the fix, and nothing is sent (no request to
 *   OpenRouter, none to an Ollama: no fallback to a model nobody chose). "Nothing was sent to any model" only when true;
 * - the NEEDS YOU gate (src/repl/approvals.ts gateTools: the same rule as the REPL's, on both routes): a tool that needs a
 *   person waits for the surface's `askPerson`, and a surface that cannot show the box answers 'deny' and says where the
 *   person can decide; a slash command (a line that starts with /) never reaches a model;
 * - the turn itself (the agent's send: src/agent/core.ts), streamed through the surface's hooks, with its receipt: the
 *   project, the prompt and the answer as hashes (never raw), the model asked and the one that answered, the route (via
 *   ollama, the host, tools on or off, the cost's basis), the last-resort fallback when it answered (with OpenRouter's
 *   failure), each tool's outcome and the files the turn wrote, and the cost: what OpenRouter reported, unknown when it did
 *   not report it all, no charge on a local endpoint, absent when no request went out.
 *
 * No UI here: a surface only draws what it returns. One agent per project in a process: a surface that has an agent already
 * (the monitor's, which also runs its lanes) hands it over (`deps.agent`); otherwise the session makes one for the project and
 * every later session of that project in this process shares it, so opening a second view never starts a second agent.
 *
 * Use (H110, the Workbench's composer):
 *
 *   import { openChatSession } from '../agent/chat-session.js';
 *   const chat = await openChatSession({ project: { name, root }, surface: 'workbench' });
 *   chat.route();                      // { kind, words, ready, refusal? }: the top line's words; refusal: the lines to show
 *   const r = await chat.send(text, {
 *     onText: (full) => draw(full),    // the answer so far
 *     onTool: (e) => card(e),          // { id, name, phase: 'start' | 'end', outcome? }
 *     askPerson: (req) => box(req),    // NEEDS YOU: 'once' | 'session' | 'deny' (a surface with no box: 'deny', and say where)
 *     signal,                          // optional: a cancel
 *   });
 *   // r: { status: 'answered' | 'refused' | 'failed' | 'cancelled', text, lines?, sent, receipt?, costWords, model? }
 *   // lines: a refusal's or a failure's words (cause and fix), and on an answered turn what must be read beside it (the
 *   // last-resort fallback that answered, tools off for a model that takes none)
 */
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { ChatRouteState, ChatSession, ChatSurface, ChatTurnHooks, ChatTurnResult } from '../contracts/chat-session.js';
import { gateTools, type ApprovalRequest, type Decision } from '../repl/approvals.js';
import { failedOutput } from '../repl/agent-bridge.js';
import { OUTCOME_RULE } from '../repl/seal.js';
import { projectId } from '../project/index.js';
import { loadConfig } from '../utils/config.js';
import { modelKeySource } from '../utils/model-key.js';
import { appendReceipt, type ReceiptInput } from '../utils/receipts.js';
import { chatRouteNow, fallbackRoute, sealedRoute, type RouteNow } from './chat-route.js';
import { createAgent, type Agent } from './core.js';
import { createProjectTools, ProjectTurnFiles } from './project-tools.js';
import { defaultTools, neverSent } from './tools.js';

type Env = Record<string, string | undefined>;

/** What the session needs of an agent: src/agent/core.ts Agent has all of it. */
export type SessionAgent = Pick<Agent,
  'send' | 'on' | 'off' | 'getModel' | 'setTools' | 'setInstructions' | 'useLocalChat' | 'localChatRoute' | 'lastLocalTurn'
  | 'lastFallback' | 'hasModelKey' | 'isRunning' | 'openRouterModel' | 'updateApiKey'>;

export interface ChatSessionDeps {
  /** the surface's own agent (the monitor's, which also runs its lanes); else one per project in this process */
  agent?: SessionAgent;
  /** the model key and the OpenRouter model for an agent the session makes; default loadConfig() */
  config?: { apiKey?: string; model?: string };
  env?: Env;
  /** the tools offered to the model, gated here; default Timmy's default tools and the project's file tools */
  tools?: readonly unknown[];
  /** seals a turn; default appendReceipt('runs', …) into this process's store; null seals nothing (the caller does) */
  seal?: ((input: ReceiptInput) => { hash: string }) | null;
  /** retry 429, 5xx and connection errors (src/agent/core.ts SendOptions.retry); default false */
  retry?: boolean;
}

/** What the chat's model is told on every surface: Timmy's rules, the project's tools, and that commands are not sent to it. */
export function chatInstructions(surface: ChatSurface): string {
  const where = surface === 'repl' ? 'the REPL' : surface === 'monitor' ? 'the monitor (timmy watch)' : surface === 'workbench' ? 'the Workbench' : 'the companion';
  return [
    `You are Timmy, the chat of the operator's project, answering in Timmy's ${where}.`,
    'Be concise. Name files and paths exactly.',
    'Verify with tools before you report a result, and say plainly what you could not verify.',
    'Never claim a receipt, a signature, a verification or a tool result that a tool did not return.',
    'Your working folder is the operator\'s active project: list_project_files and read_project_file work inside it; write_project_file asks the operator first. Read a file before you change it, and write whole files.',
    'A tool that needs the operator waits for their answer; a denied one did not run, so never say it did.',
    'Commands (lines that start with /) are typed in Timmy\'s REPL and never sent to you; when the operator needs one, name it.',
  ].join(' ');
}

/** The words a slash command gets when it reaches the session: it is a command, never a message to a model. */
export function slashRefusal(text: string, surface: ChatSurface): string[] {
  const cmd = text.trim().split(/\s+/)[0];
  return [
    `Not sent: ${cmd} is a command, and a command never goes to a model.`,
    surface === 'repl' ? 'Try: /help lists the REPL\'s commands.' : `Try: the REPL runs it: timmy, then ${cmd}.`,
  ];
}

/** "no request, no cost": the words when nothing went out (the contract's costWords is always a string). */
export const NO_REQUEST_COST = 'no request, no cost';
export const LOCAL_COST = 'no charge (local endpoint)';

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');
const SYSTEM_PREFIX = /^\s*⚙️?\s*\*\*\[SYSTEM\]\*\*\s*/u;
const dollars = (n: number): string => (n > 0 && n < 0.0001 ? `$${n.toPrecision(2)}` : `$${n.toFixed(4)}`);

/** An error as the turn's lines: what, its cause, its fix (the agent's "what\nReason: …\nNext: …"). */
function errorLines(err: unknown): string[] {
  const lines = String((err as Error)?.message ?? err).replace(/\b(sk|pk|rk)-[A-Za-z0-9_-]{8,}/g, '[key]').split('\n').map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return ['The turn failed, and no reason came back.'];
  return lines.map((l) => l.replace(/^Reason:\s*/i, 'Cause: ').replace(/^Next:\s*/i, 'Try: '));
}

/** The agents this process made for a project (one per project root): every session of that project shares it. */
const agents = new Map<string, Agent>();

/**
 * What the sessions of one agent share: the gate and the turn's files belong to the agent, not to a session, so two views of
 * one project (a Workbench and a companion, each with its own session) ask the person through whichever runs the turn.
 */
interface AgentContext {
  /** the hooks of the turn running on this agent: its NEEDS YOU asks go to them; with no turn running, a call is denied */
  current: ChatTurnHooks | null;
  /** the files the running turn wrote, for its receipt */
  touched: ProjectTurnFiles;
}
const contexts = new WeakMap<object, AgentContext>();

function contextFor(agent: SessionAgent): AgentContext {
  let ctx = contexts.get(agent);
  if (!ctx) { ctx = { current: null, touched: new ProjectTurnFiles() }; contexts.set(agent, ctx); }
  return ctx;
}

/**
 * Roots the agent's tools at this project, gated (the same NEEDS YOU rule as the REPL's): when a session opens, and again
 * before each of its turns, so a turn never runs on tools something else set on the agent since (another session's
 * project, or a surface's own tools set on a shared agent).
 */
function gateAgent(agent: SessionAgent, ctx: AgentContext, root: string, given: readonly unknown[] | undefined): void {
  const offered = given ?? [...defaultTools, ...createProjectTools({ root: () => root, touched: ctx.touched })];
  const ask = (req: ApprovalRequest): Promise<Decision> => (ctx.current ? ctx.current.askPerson(req) : Promise.resolve<Decision>('deny'));
  agent.setTools(gateTools(offered, ask) as Parameters<Agent['setTools']>[0]);
}

function agentFor(root: string, config: { apiKey?: string; model?: string }, surface: ChatSurface): Agent {
  const made = agents.get(root);
  if (made) return made;
  const agent = createAgent({ apiKey: config.apiKey ?? '', model: config.model ?? '', instructions: chatInstructions(surface), maxSteps: 10, maxCost: 1 }, { multiplexer: 'none' });
  // the project keeps its conversation (.sessions in the project), as the REPL's /project does
  agent.useSessions(join(root, '.sessions'));
  agents.set(root, agent);
  return agent;
}

/**
 * Opens the chat for a project on a surface (src/contracts/chat-session.ts OpenChatSession; `deps` is optional and the
 * contract's callers pass none). The agent's tools are gated from here on, and its instructions are the chat's.
 */
export async function openChatSession(o: { project: { name: string; root: string }; surface: ChatSurface }, deps: ChatSessionDeps = {}): Promise<ChatSession> {
  const env = deps.env ?? process.env;
  const config = deps.config ?? (() => { try { return loadConfig(); } catch { return {}; } })();
  const agent: SessionAgent = deps.agent ?? agentFor(o.project.root, config, o.surface);
  // NEEDS YOU: each call that needs a person is asked through the running turn's own hooks; with no turn running, denied.
  // The gate is the agent's (shared by its sessions), set again before each turn at the project of the session that sends.
  const ctx = contextFor(agent);
  gateAgent(agent, ctx, o.project.root, deps.tools);
  agent.setInstructions(chatInstructions(o.surface));

  const keyFound = (): boolean => agent.hasModelKey() || modelKeySource(env) !== null;
  const routeNow = (): RouteNow => chatRouteNow({ env, key: keyFound(), openRouterModel: agent.openRouterModel(), surface: o.surface });
  /** a key the setup stored since the agent started (the route is read at every message, the key with it) */
  const refreshKey = (): void => {
    if (agent.hasModelKey()) return;
    try { const key = loadConfig().apiKey; if (key) agent.updateApiKey(key); } catch { /* none readable: the route refuses */ }
  };
  const seal = deps.seal === undefined ? (input: ReceiptInput) => appendReceipt('runs', input) : deps.seal;

  const send = async (text: string, hooks: ChatTurnHooks): Promise<ChatTurnResult> => {
    const typed = text.trim();
    const refused = (lines: string[]): ChatTurnResult => ({ status: 'refused', text: '', lines, sent: false, costWords: NO_REQUEST_COST });
    if (!typed) return refused(['Not sent: the message is empty.']);
    if (typed.startsWith('/')) return refused(slashRefusal(typed, o.surface));
    if (hooks.signal?.aborted) return { status: 'cancelled', text: '', lines: ['Cancelled before anything was sent.'], sent: false, costWords: NO_REQUEST_COST };
    refreshKey();
    const now = routeNow();
    if (!now.state.ready) return refused(now.state.refusal?.length ? [...now.state.refusal] : ['Not sent: the chat has no route to a model.', 'Nothing was sent to any model.']);
    if (agent.isRunning() || ctx.current) return refused(['Not sent: another chat turn of this project is running here.', 'Try: send it again when that turn ends. Nothing was sent to any model.']);
    // this session's gated tools, rules and route for this turn (another session, or the surface itself, may have set the
    // agent's since: its tools gated again here, never the ones it found)
    gateAgent(agent, ctx, o.project.root, deps.tools);
    agent.setInstructions(chatInstructions(o.surface));
    agent.useLocalChat(now.local ?? null);
    const requested = now.local ? now.local.model : agent.openRouterModel();

    // what the turn did, from the agent's own events
    let streamed = '';
    let started = false;
    let costReports = 0;
    let localReports = 0;
    let amount = 0;
    /** every OpenRouter report said it was the whole charge */
    let complete = true;
    const notices: string[] = [];
    const names = new Map<string, string>();
    const outcomes = new Map<string, { name: string; outcome: 'completed' | 'failed' | 'unknown' }>();
    const on = {
      'stream:start': () => { started = true; },
      'stream:delta': (_delta: string, full: string) => { streamed = full; hooks.onText(full); },
      'cost:update': (cost: number, _total: number, info?: { complete: boolean; basis?: string }) => {
        costReports++;
        if (info?.basis === 'local endpoint') localReports++;
        if (Number.isFinite(cost)) amount += cost;
        if (info?.complete !== true) complete = false;
      },
      'message:user': (m: { role?: string; content?: unknown }) => {
        if (m?.role === 'assistant' && typeof m.content === 'string') notices.push(m.content.replace(SYSTEM_PREFIX, '').trim());
      },
      'item:update': (item: { type?: string; callId?: string; id?: string; name?: string; status?: string; output?: unknown }) => {
        const id = String(item?.callId || item?.id || '');
        if (item?.type === 'function_call' && item.status === 'completed' && !outcomes.has(id)) {
          const name = String(item.name || 'tool');
          names.set(id, name);
          outcomes.set(id, { name, outcome: 'unknown' });
          hooks.onTool?.({ id, name, phase: 'start' });
        } else if (item?.type === 'function_call_output') {
          const name = names.get(id) ?? 'tool';
          const outcome = failedOutput(item.output) ? 'failed' : 'completed';
          outcomes.set(id, { name, outcome });
          hooks.onTool?.({ id, name, phase: 'end', outcome });
        }
      },
    };
    for (const [event, fn] of Object.entries(on)) agent.on(event as never, fn as never);
    ctx.current = hooks;
    ctx.touched.close(); // nothing from before this turn
    const t0 = Date.now();
    let answer = '';
    let status: ChatTurnResult['status'] = 'answered';
    let failure: unknown = null;
    try {
      const opts = { ...(hooks.signal ? { signal: hooks.signal } : {}), ...(deps.retry ? { retry: true } : {}) };
      answer = Object.keys(opts).length ? await agent.send(typed, opts) : await agent.send(typed);
    } catch (err) {
      if ((err as Error)?.name === 'AbortError' || hooks.signal?.aborted) status = 'cancelled';
      else { status = 'failed'; failure = err; }
    } finally {
      ctx.current = null;
      for (const [event, fn] of Object.entries(on)) agent.off(event as never, fn as never);
    }
    const files = ctx.touched.close();
    const ms = Date.now() - t0;
    // a request went out: an answer came, a stream started, or a cost came back; a failure that never left this computer
    // (no connection, no address) did not send one, and an error that says nothing was sent did not either
    const notSent = failure !== null && ((failure as { sent?: unknown }).sent === false || neverSent(failure) || /nothing was sent/i.test(String((failure as Error)?.message ?? '')));
    const sent = !notSent && (status === 'answered' || started || costReports > 0);
    const fb = agent.lastFallback();
    const local = agent.localChatRoute();
    const localTurn = local ? agent.lastLocalTurn() : null;
    const route = local ? sealedRoute(local, localTurn) : fb ? fallbackRoute(fb) : null;
    const model = fb ? `ollama/${fb.model}` : local ? (localTurn?.actualModel || local.model) : agent.getModel();
    // the cost: on the local route, no charge only when every report says this computer's endpoint; on OpenRouter's, what it
    // reported when it reported all of it; after the last-resort fallback, unknown (OpenRouter failed, and no charge came
    // back for its requests); otherwise unknown, with what was reported as a lower bound
    const measured = !sent ? false
      : now.local ? costReports > 0 && localReports === costReports && amount === 0
        : !fb && complete && costReports > 0 && localReports === 0;
    const costWords = !sent ? NO_REQUEST_COST
      : measured ? (now.local ? LOCAL_COST : `${dollars(amount)} (as OpenRouter reported)`)
        : amount > 0 ? `cost unknown (at least ${dollars(amount)})` : 'cost unknown';

    // the receipt: every turn that reached the agent (refused messages reached nothing, and have none)
    let receipt: string | undefined;
    if (seal) {
      const tools = [...outcomes.values()];
      const input: ReceiptInput = {
        kind: 'chat',
        subject: `chat.turn · ${o.surface}${status === 'answered' ? '' : ` · ${status}`} · ${model}`,
        policy: 'human-gated',
        status: status === 'answered' ? 'ok' : status === 'cancelled' ? 'cancelled' : 'failed',
        project: o.project.name,
        project_id: projectId(o.project.root),
        prompt_hash: sha256(typed),
        response_hash: sha256(status === 'answered' ? answer : streamed),
        model_requested: requested,
        ...(sent || status === 'answered' ? { model_resolved: model } : {}),
        ...(route ? { via: 'ollama', sources: [{
          kind: 'ollama', host: route.host, endpoint: route.endpoint, tools: route.tools, cost_basis: route.costBasis,
          ...(fb ? { role: 'last-resort fallback', openrouter_failed: fb.cause } : {}),
        }] } : {}),
        ...(tools.length ? { tool_outcomes: tools.map((t) => ({ name: t.name, outcome: t.outcome })), outcome_rule: OUTCOME_RULE } : {}),
        ...(files.length ? { files } : {}),
        // absent when no request went out; a lower bound (cost_measured false) when not all of it was reported
        ...(sent ? { cost_usd: Math.round(amount * 1e6) / 1e6, cost_measured: measured } : {}),
        ms,
      };
      try { receipt = seal(input).hash; } catch (err) { notices.push(`The turn's receipt could not be sealed: ${(err as Error)?.message ?? err}.`); }
    }

    const base = { sent, ...(receipt ? { receipt } : {}), costWords, ...(sent || status === 'answered' ? { model } : {}) };
    if (status === 'answered') return { status, text: answer, ...(notices.length ? { lines: notices } : {}), ...base };
    if (status === 'cancelled') {
      return { status, text: streamed, lines: [`Cancelled${sent ? ' after the request went out: what it did stands, and nothing was rolled back' : ': nothing was sent to any model'}.`, ...notices], ...base };
    }
    const lines = errorLines(failure);
    if (!sent && !lines.some((l) => /nothing was sent/i.test(l))) lines.push('Nothing was sent to any model.');
    return { status, text: streamed, lines: [...notices, ...lines], ...base };
  };

  return { route: (): ChatRouteState => routeNow().state, send };
}
