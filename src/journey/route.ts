/**
 * R10 (H164): the route the next chat turn takes, as every screen of the journey shows it (the terminal Workbench's header
 * and composer, the companion's, Studio's), from ONE source: src/agent/chat-route.ts chatRouteNow, the function the turn
 * itself reads at every message (src/agent/chat-session.ts send: the Workbench's, the monitor's; src/repl/main.ts prepareChat:
 * the REPL's), given the arguments that turn gives it:
 *
 *   argument          the turn's own                                   routeNow's default (a surface with the agent passes it)
 *   key               the agent has a key, or the setup stored one     the setup's stored key (src/utils/model-key.ts, from cwd)
 *                     (chat-session: agent.hasModelKey() ||
 *                     modelKeySource(env))
 *   openRouterModel   agent.openRouterModel()                          the settings' model (loadConfig().model), which the
 *                                                                      session's own agent is made with (chat-session agentFor)
 *   session           the REPL's /model on the local route             ctx.sessionModel
 *   surface           the surface that sends                           ctx.surface (default: the Workbench)
 *
 * The companion page's own Send (POST /chat, src/companion/chat-route.ts pageRoute) is another route: its own OpenRouter model
 * (OPENROUTER_MODEL) and no tools, and it seals no receipt; `surface: 'companion'` gives that one, so a page never shows the
 * session's model for what its Send would ask. R10 (H164; the lead's call (b)): it is this page's own chat, not the project's
 * conversation, and says so: `conversation: 'this page'`, `receipt: false`, and its words are the page's own label (pageRoute).
 *
 * What a turn took is read back from its sealed receipt (routeTaken): the provider that answered, the model asked and the one
 * that answered, and where, as src/repl/seal.ts sealed them. tests/journey-route.test.ts sends turns (a FAKE Ollama; a FAKE
 * OpenRouter client) and compares the two.
 *
 * Words follow the R9 rules: a price is OpenRouter's catalog's (declared) or unknown, never zero or free by inference (a local
 * address, an Ollama, a FAKE: none of them declares a price); a FAKE stand-in is labelled FAKE with what says so; never a key.
 * Reads the setup's files only: no request to anything.
 */
import { chatRouteNow, type ChatRoute, type ModelFrom } from '../agent/chat-route.js';
import { modelPrice, type ModelPrice } from '../agent/model-price.js';
import { OPENROUTER_MODEL, pageRoute } from '../companion/chat-route.js';
import type { ChatSurface } from '../contracts/chat-session.js';
import { chatTurnOf } from '../repl/seal.js';
import { cloudModelTag } from '../setup/ollama-models.js';
import { loadConfig } from '../utils/config.js';
import { modelKeySource, type KeySource } from '../utils/model-key.js';
import type { Receipt } from '../utils/receipts.js';

type Env = Record<string, string | undefined>;

export type RouteProvider = 'openrouter' | 'ollama' | 'fake' | 'none';
export type RouteWhere = 'this computer' | 'another computer' | 'cloud';

/** A price as declared (OpenRouter's catalog: free, or what it costs), or unknown: never free or $0 by inference. */
export type RoutePrice = { state: 'declared'; free: boolean; words: string } | { state: 'unknown'; words: string };

/** The one setup step a route that is not ready needs, in the sending surface's own words (`command`: its first command). */
export interface RouteStep {
  /** what is missing: a model key, a local model, a usable Ollama address, a free model (free-only is on), something else */
  kind: 'key' | 'local-model' | 'ollama-address' | 'free-model' | 'other';
  /** the first command the step names, or null when its words name none */
  command: string | null;
  /** the step as the route's refusal says it (its Try line without "Try: ") */
  words: string;
}

export interface JourneyRoute {
  /** what the next turn asks: OpenRouter, an Ollama, a FAKE stand-in the caller declared, or none (refused: nothing is sent) */
  provider: RouteProvider;
  /** the model the turn asks for (its receipt's model_requested), or null when none is chosen */
  model: string | null;
  /** where it runs: this computer's Ollama (a loopback address, a model with local weights), another computer's Ollama, or a
   *  cloud (OpenRouter, or a cloud-backed Ollama model); null with no route or no usable address */
  where: RouteWhere | null;
  price: RoutePrice;
  /** a FAKE stand-in (its model's name says FAKE, or the caller declared one): every screen labels it FAKE */
  fake: boolean;
  /** what says FAKE, when fake */
  fakeWhy?: string;
  /** a message would be sent now; false: it is refused and nothing is sent */
  ready: boolean;
  /** when not ready: why, as a state ("no model key, and the chat is not set to the local model") */
  why?: string;
  /** when not ready: the cause, as the refusal says it */
  cause?: string;
  /** when not ready: the one setup step */
  step?: RouteStep;
  /** the header's words, as every surface's top line says the route (chatRouteNow's) */
  words: string;
  /** the surface whose turn this is the route of */
  surface: ChatSurface;
  /** the tools the turn offers: Timmy's gated tools (the chat session, the REPL), none (the companion page's own Send) */
  tools: 'gated' | 'none';
  /** whose conversation the turn continues: the project's (the one the Workbench, the REPL and the monitor share, kept in
   *  .sessions), or this page's own (the companion page's Send: its request carries the page's own messages) */
  conversation: 'project' | 'this page';
  /** whether the turn is sealed as a receipt (a project's turn is, once it reaches the model; the page's own Send is not) */
  receipt: boolean;
  /** for an inspector only (never a key): the Ollama address as recorded, where the model came from, where the key was found,
   *  the free-only policy, the context window set, a variable set and not used */
  details: { host?: string; modelFrom?: ModelFrom | 'the settings' | 'the companion page'; keyFrom: KeySource | null; freeOnly: boolean; numCtx?: number; note?: string };
}

/** What routeNow needs of the agent a surface holds (src/agent/core.ts Agent has both). */
export interface RouteAgent { openRouterModel(): string; hasModelKey(): boolean }

export interface RouteCtx {
  env?: Env;
  /** where the key is looked for (a local timmy-tui.config.json): the sending process's folder (default process.cwd()) */
  cwd?: string;
  /** the surface whose turn this is the route of (default: the terminal Workbench) */
  surface?: ChatSurface;
  /** the agent of the surface's chat session, when the surface holds it (its model and key are the turn's) */
  agent?: RouteAgent;
  /** the REPL's /model for this session on the local route */
  sessionModel?: string | null;
  /** what a model costs (a test's catalog); default the catalog this computer has (src/agent/model-price.ts) */
  price?: (id: string) => ModelPrice;
  /** a FAKE stand-in the caller declares (a scripted demo, a test's FAKE client): the route is it */
  fake?: { model: string; why: string };
}

/** A model name that says FAKE (a word of its own: "fake/model", "fake-chat:1b", "qwen3:8b-FAKE"; not "mistake"). */
export const FAKE_NAME = /(?:^|[^a-z0-9])fake(?:$|[^a-z0-9])/i;

const after = (line: string | undefined, head: RegExp): string | undefined => (line ? line.replace(head, '').trim() : undefined);

/** The first command a Try line names: what comes before its first "(", "," or "in the REPL"/"in a terminal". */
function firstCommand(words: string): string | null {
  const body = words.replace(/^choose a free model:\s*/, '');
  const m = /^((?:timmy|\/)[^,(]*?)(?=\s+\(|,|\s+in (?:the REPL|a terminal)|\s+lists\b|$)/.exec(body);
  return m ? m[1].trim() : null;
}

/** Why, the cause and the step, from the one route's refusal lines (Error, Cause, Try). */
function notReady(refusal: readonly string[], kind: RouteStep['kind']): Pick<JourneyRoute, 'why' | 'cause' | 'step'> {
  const lines = refusal.map((l) => l.trim());
  const error = after(lines.find((l) => /^Error:/.test(l)), /^Error:\s*/);
  const cause = after(lines.find((l) => /^Cause:/.test(l)), /^Cause:\s*/);
  const tryWords = after(lines.find((l) => /^Try:/.test(l)), /^Try:\s*/);
  const why = error ? error.replace(/,? so this message was not sent\.?$/, '').replace(/\.$/, '') : 'the chat has no route to a model';
  return {
    why,
    ...(cause ? { cause } : {}),
    ...(tryWords ? { step: { kind, command: firstCommand(tryWords), words: tryWords } } : {}),
  };
}

/** The settings' OpenRouter model, as the session's own agent is made with it (loadConfig), else null. */
function settingsModel(): string | null {
  try { return loadConfig().model || null; } catch { return null; }
}

function priceOf(p: ModelPrice): RoutePrice {
  return p.free === null ? { state: 'unknown', words: p.words } : { state: 'declared', free: p.free, words: p.words };
}

const LOCAL_PRICE = 'no price declared: a turn on this computer\'s Ollama is sealed as no charge only when Ollama reports the model\'s local weights';
const AWAY_PRICE = 'unknown: Ollama reports no cost for a cloud-backed model or another computer\'s';

/**
 * The route the next chat turn of `ctx.surface` takes now, from the function the turn reads (chatRouteNow), with the arguments
 * the turn gives it. Reads the setup's files: call it once per reading of a surface, not once per frame.
 */
export function routeNow(ctx: RouteCtx = {}): JourneyRoute {
  const env = ctx.env ?? process.env;
  const cwd = ctx.cwd ?? process.cwd();
  const surface: ChatSurface = ctx.surface ?? 'workbench';
  const page = surface === 'companion';
  const tools: JourneyRoute['tools'] = page ? 'none' : 'gated';
  const conversation: JourneyRoute['conversation'] = page ? 'this page' : 'project';
  const receipt = !page;
  const keyFrom = (() => { try { return modelKeySource(env, cwd); } catch { return null; } })();
  if (ctx.fake) {
    return {
      provider: 'fake', model: ctx.fake.model, where: 'this computer', price: { state: 'unknown', words: 'FAKE: no model is asked, so no price applies' },
      fake: true, fakeWhy: ctx.fake.why, ready: true, words: `chat: ${ctx.fake.model} · FAKE`, surface, tools, conversation, receipt, details: { keyFrom, freeOnly: false },
    };
  }
  // the companion page's own Send asks its own model (src/companion/chat-route.ts pageRoute); every other surface's turn, the
  // agent's (the session's own agent is made with the settings' model)
  const openRouterModel = surface === 'companion' ? OPENROUTER_MODEL : ctx.agent ? ctx.agent.openRouterModel() : settingsModel();
  const key = ctx.agent ? ctx.agent.hasModelKey() || keyFrom !== null : keyFrom !== null;
  const now = chatRouteNow({ env, cwd, session: ctx.sessionModel ?? null, key, openRouterModel, surface, ...(ctx.price ? { price: ctx.price } : {}) });
  const s = now.state;
  // the page's own Send says itself in its own label (src/companion/chat-route.ts pageRoute): one set of words for its chip and here
  const words = page ? (() => { try { return pageRoute(env, cwd).label; } catch { return s.words; } })() : s.words;
  const freeOnly = s.kind === 'openrouter' && /· free-only(?:: not sent)?$/.test(s.words);
  const refusal = s.refusal ?? [];
  const r: ChatRoute = now.route;
  if (r.kind === 'local' && s.kind === 'local') {
    const bad = 'error' in r.at;
    const where: RouteWhere | null = bad ? null : r.cloud ? 'cloud' : (r.at as { loopback: boolean }).loopback ? 'this computer' : 'another computer';
    const fakeWhy = r.model && FAKE_NAME.test(r.model) ? `its model's name says FAKE (${r.model})` : undefined;
    const kind: RouteStep['kind'] = bad ? 'ollama-address' : !r.model ? 'local-model' : 'other';
    return {
      provider: 'ollama', model: r.model, where,
      price: { state: 'unknown', words: where === 'this computer' ? LOCAL_PRICE : AWAY_PRICE },
      fake: !!fakeWhy, ...(fakeWhy ? { fakeWhy } : {}),
      ready: s.ready, ...(s.ready ? {} : notReady(refusal, kind)),
      words, surface, tools, conversation, receipt,
      details: { host: r.host, ...(r.from ? { modelFrom: r.from } : {}), keyFrom, freeOnly: false, ...(r.numCtx ? { numCtx: r.numCtx } : {}), ...(r.note ? { note: r.note } : {}) },
    };
  }
  if (s.kind === 'openrouter') {
    const model = openRouterModel;
    const price = model ? priceOf((ctx.price ?? ((id: string) => modelPrice(id)))(model)) : { state: 'unknown' as const, words: 'price unknown: no model is named' };
    const fakeWhy = model && FAKE_NAME.test(model) ? `its model's name says FAKE (${model})` : undefined;
    return {
      provider: 'openrouter', model, where: 'cloud', price, fake: !!fakeWhy, ...(fakeWhy ? { fakeWhy } : {}),
      ready: s.ready, ...(s.ready ? {} : notReady(refusal, freeOnly ? 'free-model' : 'other')),
      words, surface, tools, conversation, receipt,
      details: { modelFrom: surface === 'companion' ? 'the companion page' : 'the settings', keyFrom, freeOnly },
    };
  }
  return {
    provider: 'none', model: null, where: null, price: { state: 'unknown', words: 'no route: nothing is asked' }, fake: false,
    ready: false, ...notReady(refusal, 'key'), words, surface, tools, conversation, receipt, details: { keyFrom, freeOnly: false },
  };
}

/** What a sealed chat turn took, from its receipt (src/repl/seal.ts sealTurn's fields), or null for a receipt that is not one. */
export interface RouteTaken {
  /** the provider that answered: an Ollama (via ollama), else OpenRouter */
  provider: 'openrouter' | 'ollama';
  /** the model the turn asked for (model_requested) */
  requested: string | null;
  /** the model that answered (model_resolved), or null when the receipt names none */
  answeredBy: string | null;
  where: RouteWhere;
  /** the last-resort fallback answered after OpenRouter failed (the asked model was OpenRouter's) */
  fallback: boolean;
  /** the model asked or the one that answered says FAKE */
  fake: boolean;
  surface: ChatSurface;
}

const LOOPBACK = /^(?:localhost|\[::1\]|127(?:\.\d{1,3}){3})(?::\d+)?$/;

export function routeTaken(r: Receipt | null | undefined): RouteTaken | null {
  const turn = chatTurnOf(r);
  if (!r || !turn) return null;
  const rec = r as unknown as Record<string, unknown>;
  const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);
  const src = Array.isArray(rec.sources) ? (rec.sources as Array<Record<string, unknown>>).find((x) => x && x.kind === 'ollama') : undefined;
  const ollama = rec.via === 'ollama' || !!src;
  const requested = str(rec.model_requested);
  const answeredBy = str(rec.model_resolved);
  let where: RouteWhere = 'cloud';
  if (ollama) {
    const host = str(src?.host) ?? '';
    const model = answeredBy ?? requested ?? '';
    where = src?.endpoint === 'local' ? 'this computer' : LOOPBACK.test(host) || cloudModelTag(model) ? 'cloud' : 'another computer';
  }
  return {
    provider: ollama ? 'ollama' : 'openrouter', requested, answeredBy, where, fallback: src?.role === 'last-resort fallback',
    fake: [requested, answeredBy].some((m) => !!m && FAKE_NAME.test(m)), surface: turn.surface,
  };
}
