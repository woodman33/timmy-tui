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
 * - the turn itself. R4 (H113): one turn implementation for every surface: the REPL's own (src/repl/turn.ts runTurn: the
 *   agent's events, each tool's outcome and its own receipt, describe_image's own charge, the cancel's stage, the cost as
 *   reported), streamed through the surface's hooks, and sealed by the REPL's own seal (src/repl/seal.ts sealTurn, whose
 *   subject names the surface: "chat.turn · workbench · 2 steps · qwen3:8b"), into the project's store: the project, the
 *   prompt and the answer as hashes (never raw), the model asked and the one that answered, the route (via ollama, the host,
 *   tools on or off, the cost's basis), the last-resort fallback when it answered (with OpenRouter's failure), each tool's
 *   outcome and the files the turn wrote, and the cost as the turn's receipts seal it (what was reported; cost_measured
 *   false when not all of it was, never a measured $0); a refused message reaches no turn and has no receipt.
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
import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { ChatRouteState, ChatSession, ChatSurface, ChatTurnHooks, ChatTurnResult } from '../contracts/chat-session.js';
import { gateTools, type ApprovalRequest, type Decision } from '../repl/approvals.js';
import { sealTurn, type SealedTurn, type TurnFacts } from '../repl/seal.js';
import type { TurnEvent } from '../repl/transcript.js';
import type { TurnSummary } from '../repl/turn.js';
import { projectId } from '../project/index.js';
import { loadConfig } from '../utils/config.js';
import { modelKeySource } from '../utils/model-key.js';
import { chatRouteNow, fallbackRoute, sealedRoute, type RouteNow } from './chat-route.js';
import { keyDecision, noteTurnKey, projectTurn, surfaceWords, type Continued, type TurnRouteStart } from './chat-turn.js';
import { inferenceAt, routePolicyNow } from './route-policy.js';
import { ollamaAt } from '../setup/ollama-models.js';
import { createAgent, type Agent } from './core.js';
import { createProjectTools, ProjectTurnFiles } from './project-tools.js';
import { defaultTools, neverSent, optedInTools } from './tools.js';

type Env = Record<string, string | undefined>;

/** What the session needs of an agent: src/agent/core.ts Agent has all of it. */
export type SessionAgent = Pick<Agent,
  'send' | 'on' | 'off' | 'getModel' | 'setTools' | 'setInstructions' | 'useLocalChat' | 'localChatRoute' | 'lastLocalTurn'
  | 'lastFallback' | 'hasModelKey' | 'isRunning' | 'openRouterModel' | 'updateApiKey' | 'useSessions' | 'setModel'
  | 'startSession' | 'keptConversation'>;

/** R4 (H113): seals a turn from its facts (src/repl/seal.ts sealTurn's shape); `dir`: the project's store when it is not this process's */
export type TurnSealer = (facts: TurnFacts & { model: string }, dir?: string) => SealedTurn;

export interface ChatSessionDeps {
  /** the surface's own agent (the monitor's, which also runs its lanes); else one per project in this process */
  agent?: SessionAgent;
  /** the model key and the OpenRouter model for an agent the session makes; default loadConfig() */
  config?: { apiKey?: string; model?: string };
  env?: Env;
  /** the tools offered to the model, gated here; default Timmy's default tools and the project's file tools */
  tools?: readonly unknown[];
  /**
   * seals a turn; default sealTurn (src/repl/seal.ts), the REPL's own seal, its subject naming the surface, into the project's
   * store; null seals nothing (the caller does)
   */
  seal?: TurnSealer | null;
  /** retry 429, 5xx and connection errors (src/agent/core.ts SendOptions.retry); default false (the REPL's turn passes true) */
  retry?: boolean;
  /**
   * R11 round 4 (H169; contract C1/C3): the settings this session reads at every message instead of this process's store
   * (loadConfig): a user's own, under the user's env (the key where the setup keeps it for that user, the model chosen in
   * that user's settings). The agent it makes takes the first reading; a model chosen since is the next turn's (as the
   * settings store's is); a key kept since is taken too.
   */
  settings?: () => { apiKey?: string; model?: string };
}

/**
 * R4 (H113): the store a project's turn is sealed into: this process's own (undefined) when the process works in the project,
 * else the project's (src/utils/receipts.ts receiptsDir: its store pin, else its .timmy/receipts), so every surface's turns of a
 * project, and the event each seal publishes (the companion's mirror reads the project's), are the project's.
 */
export function projectStore(root: string, cwd: string = process.cwd()): string | undefined {
  const real = (p: string): string => { try { return realpathSync(p); } catch { return resolve(p); } };
  return real(root) === real(cwd) ? undefined : root;
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

const dollars = (n: number): string => (n > 0 && n < 0.0001 ? `$${n.toPrecision(2)}` : `$${n.toFixed(4)}`);

/** An error as the turn's lines: what, its cause, its fix (the agent's "what\nReason: …\nNext: …"). */
function errorLines(err: unknown): string[] {
  if (err === undefined || err === null) return ['The turn failed, and no reason came back.'];
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
  /** R11 round 4 (H169): the surface whose turn runs now (the refusal of a second message names it) */
  surface?: ChatSurface;
  /** the files the running turn wrote, for its receipt */
  touched: ProjectTurnFiles;
  /** R10 CHAT (H167; H168's pass 3c, R24): the settings' OpenRouter model this agent last took (unset: none read yet) */
  modelSeen?: string | null;
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
  const offered = given ?? [...defaultTools, ...optedInTools(), ...createProjectTools({ root: () => root, touched: ctx.touched })];
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
  const readSettings = (): { apiKey?: string; model?: string } => { try { return deps.settings ? deps.settings() : loadConfig(); } catch { return {}; } };
  const config = deps.config ?? readSettings();
  const agent: SessionAgent = deps.agent ?? agentFor(o.project.root, config, o.surface);
  // NEEDS YOU: each call that needs a person is asked through the running turn's own hooks; with no turn running, denied.
  // The gate is the agent's (shared by its sessions), set again before each turn at the project of the session that sends.
  const ctx = contextFor(agent);
  gateAgent(agent, ctx, o.project.root, deps.tools);
  agent.setInstructions(chatInstructions(o.surface));

  const keyFound = (): boolean => agent.hasModelKey() || modelKeySource(env) !== null;
  // R10 CHAT (H167; H168's pass 3c, R24): the OpenRouter model the settings name, read at every message as the route and the key
  // are: one chosen since this agent last took it (the Workbench's Models writes the settings) is the next turn's, said by
  // route() at once and given to the agent as that turn starts; a turn under way keeps its own. A session given its own config
  // (the monitor's) follows that, not the settings; a model the agent was given otherwise stays until the settings name another.
  const settingsModel = (): string | null => readSettings().model || null;
  if (ctx.modelSeen === undefined) ctx.modelSeen = deps.config ? null : settingsModel();
  const modelChosen = (): string | null => { if (deps.config) return null; const m = settingsModel(); return m && m !== ctx.modelSeen ? m : null; };
  const routeNow = (): RouteNow => chatRouteNow({ env, key: keyFound(), openRouterModel: modelChosen() ?? agent.openRouterModel(), surface: o.surface });
  /** a key the setup stored since the agent started (the route is read at every message, the key with it) */
  const refreshKey = (): void => {
    if (agent.hasModelKey()) return;
    const key = readSettings().apiKey; if (key) agent.updateApiKey(key);
  };
  // R4 (H113): the REPL's own seal (src/repl/seal.ts), the surface named in its subject
  const seal: TurnSealer | null = deps.seal === undefined ? (facts, dir) => sealTurn(facts, dir) : deps.seal;

  const send = async (text: string, hooks: ChatTurnHooks, key?: string): Promise<ChatTurnResult> => {
    const typed = text.trim();
    const refused = (lines: string[]): ChatTurnResult => ({ status: 'refused', text: '', lines, sent: false, costWords: NO_REQUEST_COST });
    // R4 lead: a keyed message (sendOnce, src/contracts/chat-session.ts) is first looked up by its key: one that went out, runs
    // now, or ended unrecorded is refused before anything else is read (a repeat learns what became of the first); one that
    // sent nothing goes on, a retry
    if (key !== undefined) { const d = keyDecision(o.project.root, key); if (!d.send) return refused(d.lines); }
    if (!typed) return refused(['Not sent: the message is empty.']);
    if (typed.startsWith('/')) return refused(slashRefusal(typed, o.surface));
    // R7 lead (H148's N5; src/contracts/stop-words.ts: a chat turn a person stopped is stopped, never cancelled)
    if (hooks.signal?.aborted) return { status: 'cancelled', text: '', lines: ['Stopped before anything was sent.'], sent: false, costWords: NO_REQUEST_COST };
    refreshKey();
    const now = routeNow();
    if (!now.state.ready) return refused(now.state.refusal?.length ? [...now.state.refusal] : ['Not sent: the chat has no route to a model.', 'Nothing was sent to any model.']);
    if (agent.isRunning() || ctx.current) return refused([`Not sent: another chat turn of this project is running here${ctx.current && ctx.surface ? `, sent from ${surfaceWords(ctx.surface)}` : ''}.`, 'Try: send it again when that turn ends (Stop ends it). Nothing was sent to any model.']);
    // this session's gated tools, rules and route for this turn (another session, or the surface itself, may have set the
    // agent's since: its tools gated again here, never the ones it found)
    gateAgent(agent, ctx, o.project.root, deps.tools);
    agent.setInstructions(chatInstructions(o.surface));
    agent.useLocalChat(now.local ?? null);
    // (R24: the model chosen since the last message is this turn's: given to the agent now, as no turn runs on it)
    if (!now.local) { const chosen = modelChosen(); if (chosen) { agent.setModel(chosen); ctx.modelSeen = chosen; } }
    const requested = now.local ? now.local.model : agent.openRouterModel();
    // R10 (H169): the turn's route, snapshotted as it starts: a model chosen while it runs changes only the next turn, and its
    // receipt is never relabelled (src/agent/chat-turn.ts keeps it beside the turn's hold, under the turn's id)
    const snapshot: TurnRouteStart = now.local
      ? (() => { const at = ollamaAt(now.local.host); return { source: 'ollama-local' as const, model: requested, inference: inferenceAt({ source: 'ollama-local', model: requested, host: now.local.host }), endpoint: 'error' in at ? now.local.host : at.host, gateway: 'none' as const, policy: routePolicyNow(env) }; })()
      : { source: 'openrouter', model: requested, inference: 'cloud', endpoint: 'openrouter.ai', gateway: 'none', policy: routePolicyNow(env) };

    // R4 (H113): the turn is the REPL's own (src/repl/turn.ts runTurn): the surface is told the answer so far (the agent's
    // stream) and each tool as it starts and ends (the turn's own events), and gets what the turn did from its summary
    const onDelta = (_delta: string, full: string): void => { hooks.onText(full); };
    const names = new Map<string, string>();
    const sink = {
      handle: (e: TurnEvent): void => {
        if (e.type === 'tool-start') { names.set(e.id, e.tool); hooks.onTool?.({ id: e.id, name: e.tool, phase: 'start' }); }
        else if (e.type === 'tool-end') hooks.onTool?.({ id: e.id, name: names.get(e.id) ?? 'tool', phase: 'end', outcome: e.ok ? 'completed' : 'failed' });
      },
      endTurn: (): void => undefined,
    };
    let summary: TurnSummary | null = null;
    agent.on('stream:delta', onDelta);
    ctx.current = hooks;
    ctx.surface = o.surface;
    ctx.touched.close(); // nothing from before this turn
    // R4 (H113): the project's turn (src/agent/chat-turn.ts): one turn at a time across every surface, the project's kept
    // conversation continued from disk, a keyed message never sent twice
    let turn: Awaited<ReturnType<typeof projectTurn>>;
    let turnId: string | undefined;
    try {
      turn = await projectTurn({
        agent, project: o.project, surface: o.surface, text: typed, sink, signal: hooks.signal, ...(key !== undefined ? { key } : {}), route: snapshot,
        // R11 round 4 (H169): the turn's identity told to the surface as the hold is taken; the turn runs under this session's env
        onHold: (h) => { turnId = h.id; hooks.onTurn?.(h); }, env: env as NodeJS.ProcessEnv,
        more: {
          summary: (s) => { summary = s; }, retry: deps.retry ?? false,
          // a failure that never left this computer (no connection, no address) sent nothing
          notSent: (err) => neverSent(err),
        },
      });
    } finally {
      ctx.current = null;
      ctx.surface = undefined;
      agent.off('stream:delta', onDelta);
    }
    const files = ctx.touched.close();
    if (turn.status === 'refused') return refused(turn.lines);
    const s = summary as TurnSummary | null;
    if (!s) return { status: 'failed', text: '', lines: ['The turn ended without saying what it did, so whether anything was sent is not known.'], sent: false, costWords: 'cost unknown' };
    const r = finish(s, { requested, local: Boolean(now.local), files, continued: turn.continued, ...(turnId ? { turnId } : {}) });
    // the keyed turn's end with its receipt (projectTurn kept its start, and its end before the receipt was sealed)
    if (key !== undefined) noteTurnKey(o.project.root, key, o.surface, { sent: r.sent, status: r.status, ...(r.receipt ? { receipt: r.receipt } : {}) });
    return r;
  };

  /** The turn's answer in the contract's words, and its receipt: the REPL's seal, with this surface, into the project's store. */
  const finish = (s: TurnSummary, t: { requested: string; local: boolean; files: TurnFacts['files']; continued: Continued; turnId?: string }): ChatTurnResult => {
    const status: ChatTurnResult['status'] = s.result === 'ok' ? 'answered' : s.result;
    const sent = s.sent;
    const fb = agent.lastFallback();
    const local = agent.localChatRoute();
    const localTurn = local ? agent.lastLocalTurn() : null;
    const route = local ? sealedRoute(local, localTurn) : fb ? fallbackRoute(fb) : undefined;
    // R10 (H169): the model that answered, as the turn knows it: the one the provider named, else the one the turn used (a
    // fallback's included), never the model chosen since the turn started (agent.getModel() then)
    const told = agent as { lastReturnedModel?: () => string | null; lastTurnModel?: () => string | null };
    const model = fb ? `ollama/${fb.model}` : local ? (localTurn?.actualModel || local.model) : (told.lastReturnedModel?.() || told.lastTurnModel?.() || t.requested);
    // the cost: on the local route, no charge only when every report says this computer's endpoint; on OpenRouter's, what it
    // reported when it reported all of it; after the last-resort fallback, unknown (OpenRouter failed, and no charge came
    // back for its requests); otherwise unknown, with what was reported as a lower bound
    const measured = !sent ? false
      : t.local ? s.costReports > 0 && s.localReports === s.costReports && s.spend === 0
        : !fb && s.allComplete && s.costReports > 0 && s.localReports === 0;
    // describe_image's own request (src/repl/turn.ts: sealed on its own receipt, never in the turn's) in the REPL's words beside it
    const paidTool = /\((describe_image [^)]*)\)$/.exec(s.spendWords)?.[1];
    const costWords = (!sent ? NO_REQUEST_COST
      : measured ? (t.local ? LOCAL_COST : `${dollars(s.spend)} (as OpenRouter reported)`)
        : s.spend > 0 ? `cost unknown (at least ${dollars(s.spend)})` : 'cost unknown') + (paidTool ? `; ${paidTool}` : '');
    const notices = [...s.notices];
    // R4 (H113): the project's one conversation: what this turn continued, when another surface had added to it since
    if (t.continued.added > 0) notices.unshift(`This turn continued the project's conversation, with ${t.continued.added} ${t.continued.added === 1 ? 'message' : 'messages'} another surface added since ${surfaceWords(o.surface)} last sent (kept in .sessions).`);
    else if (t.continued.moved && t.continued.messages > 0) notices.unshift(`This turn continued the project's conversation (${t.continued.messages} ${t.continued.messages === 1 ? 'message' : 'messages'} kept in .sessions).`);
    // the receipt: every turn that reached the agent (refused messages reached nothing, and have none)
    let receipt: string | undefined;
    if (seal) {
      try {
        receipt = seal({
          ...s.facts, model: t.requested, surface: o.surface, project: o.project.name, projectId: projectId(o.project.root),
          ...(t.files?.length ? { files: t.files } : {}), ...(route ? { route } : {}),
          ...(sent || status === 'answered' ? { modelResolved: model } : {}),
        }, projectStore(o.project.root)).hash;
      } catch (err) { notices.push(`The turn's receipt could not be sealed: ${(err as Error)?.message ?? err}.`); }
    }
    // R11 round 4 (H169; contract C3): the facts apart from the words, for a surface that draws them (the companion's `done`)
    const facts = { steps: s.steps, costUsd: sent && s.costReports > 0 ? s.spend : null, costMeasured: measured, fellBack: Boolean(fb), ...(t.turnId ? { turnId: t.turnId } : {}) };
    const base = { sent, ...(receipt ? { receipt } : {}), costWords, ...(sent || status === 'answered' ? { model } : {}), ...facts };
    if (status === 'answered') return { status, text: s.answer, ...(notices.length ? { lines: notices } : {}), ...base };
    if (status === 'cancelled') {
      // R7 lead (H148's N5: the Workbench's notice read "Stopped: Cancelled after the request went out"): the turn's words
      return { status, text: s.streamed, lines: [`Stopped${sent ? ' after the request went out: what it did stands, and nothing was rolled back' : ': nothing was sent to any model'}.`, ...notices], ...base };
    }
    const lines = errorLines(s.error);
    if (!sent && !lines.some((l) => /nothing was sent/i.test(l))) lines.push('Nothing was sent to any model.');
    return { status, text: s.streamed, lines: [...notices, ...lines], ...base };
  };

  /**
   * R11 round 6 (H169): the REPL's /new for every surface — a conversation of its own on the project's one agent. The new
   * conversation is the project's newest for every surface and process at once: an empty file of it in the project's
   * .sessions (what the companion's view and another process's continueConversation read), where the REPL's own /new
   * keeps it in its process until the first message is written.
   */
  const newConversation = (): { ok: true; session: string } | { ok: false; why: string } => {
    if (agent.isRunning() || ctx.current) return { ok: false, why: `another chat turn of this project is running here${ctx.current && ctx.surface ? `, sent from ${surfaceWords(ctx.surface)}` : ''}: it ends first (Stop ends it), then a new conversation can start` };
    const id = agent.startSession();
    try {
      const dir = agent.keptConversation().directory;
      mkdirSync(dir, { recursive: true });
      const file = join(dir, `${id}.jsonl`);
      if (!existsSync(file)) writeFileSync(file, '');
    } catch { /* not written: this process still holds it as the newest (the REPL's own /new); another reader sees the saved one */ }
    return { ok: true, session: id };
  };

  return {
    route: (): ChatRouteState => routeNow().state,
    send: (text: string, hooks: ChatTurnHooks) => send(text, hooks),
    sendOnce: (key: string, text: string, hooks: ChatTurnHooks) => send(text, hooks, key),
    newConversation,
  };
}
