/**
 * R4 (H103): which route answers the REPL's chat, from the setup's answers. A setup that answered the chat question with
 * the local model (`chat: local` in setup.json) sends every message to the Ollama the setup recorded (providers.json's
 * ollama_host, else 127.0.0.1:11434) with the model chosen: this session's /model, else TIMMY_CHAT_MODEL, else the setup's
 * answer (the chat question lists Ollama's models, src/setup/chat-question.ts). Any other setup is the OpenRouter route, as
 * before. It is read at every message, so a /setup in this REPL or in another terminal takes effect at the next one.
 *
 * Without a model the local route is off and says so; it never falls back to OpenRouter or to a cloud-backed model.
 */
import { chatRoute, knownAnswers, readSetupState, OLLAMA_DEFAULT, type SetupState } from '../setup/questions.js';
import { modelKeySource } from '../utils/model-key.js';
import { freeOnlyOn, freeOnlyRefusal, modelPrice, type ModelPrice } from './model-price.js';
// R10 (H169): the route policy (free-only and local-only) every model call is checked against
import { checkRoute, localOnlyOn, policyRefusalLines, type RoutePolicy } from './route-policy.js';
import { atWords, cloudModelTag, listOllamaModels, listProblem, modelFacts, ollamaAt, PULL_WORDS, validOllamaModelName, type ListedModel, type OllamaAt } from '../setup/ollama-models.js';
// R4 (H103): types only, so a surface can read the route (its header) without loading the agent or the local client
import type { LocalChatRoute, LocalTurnResult } from './local-chat.js';
import type { LastResortAnswer } from './core.js';
import type { ChatRouteState, ChatSurface } from '../contracts/chat-session.js';
import type { Segment } from '../term/theme.js';
import type { TurnFacts } from '../repl/seal.js';

type Env = Record<string, string | undefined>;

/** Where the local route's model comes from, in words. */
export type ModelFrom = 'this session (/model)' | 'TIMMY_CHAT_MODEL' | 'the setup';

export type ChatRoute =
  | { kind: 'openrouter' }
  | {
    kind: 'local';
    /** the address as recorded (providers.json ollama_host, else the setup's answer, else 127.0.0.1:11434) */
    host: string;
    at: OllamaAt | { error: string };
    model: string | null;
    from: ModelFrom | null;
    /** the model's name says it is a cloud model (Ollama's /api/show is asked again at each message) */
    cloud: boolean;
    /** TIMMY_CHAT_NUM_CTX: the context window the operator set for the chat (Ollama's num_ctx) */
    numCtx?: number;
    /** a variable that was set and not used, in words */
    note?: string;
  };

/** The route the setup's answers give now (`session`: this REPL's /model on the local route). */
export function resolveChatRoute(o: { env?: Env; state?: SetupState; session?: string | null } = {}): ChatRoute {
  const env = o.env ?? process.env;
  const s = o.state ?? readSetupState(env);
  if (knownAnswers(s).chat !== 'local') return { kind: 'openrouter' };
  const host = s.providers.ollama ?? s.recorded?.answers.ollama ?? OLLAMA_DEFAULT;
  const fromEnv = env.TIMMY_CHAT_MODEL?.trim();
  const recorded = s.recorded?.answers.model?.trim();
  let note: string | undefined;
  let model: string | null = null;
  let from: ModelFrom | null = null;
  if (o.session) { model = o.session; from = 'this session (/model)'; }
  else if (fromEnv && validOllamaModelName(fromEnv)) { model = fromEnv; from = 'TIMMY_CHAT_MODEL'; }
  else if (recorded) { model = recorded; from = 'the setup'; }
  if (fromEnv && !validOllamaModelName(fromEnv)) note = 'TIMMY_CHAT_MODEL is set to something that is not a model name, so it is not used';
  const ctx = Number(env.TIMMY_CHAT_NUM_CTX);
  const numCtx = Number.isInteger(ctx) && ctx >= 256 && ctx <= 1_048_576 ? ctx : undefined;
  return { kind: 'local', host, at: ollamaAt(host), model, from, cloud: model ? cloudModelTag(model) : false, ...(numCtx ? { numCtx } : {}), ...(note ? { note } : {}) };
}

type Local = Extract<ChatRoute, { kind: 'local' }>;

/** The header's words for the local route: "chat: local <model> · Ollama". */
export function localRouteWords(r: Local): string {
  if ('error' in r.at) return 'chat: local · the Ollama address is not usable · /setup chat';
  if (!r.model) return 'chat: local · no model chosen · /model';
  const where = r.at.loopback ? 'Ollama' : `Ollama at ${r.at.host} (not this computer)`;
  return r.cloud ? `chat: ${r.model} · ${where}, cloud-backed` : `chat: local ${r.model} · ${where}`;
}

/** The agent's route for a turn, or why there is none (the lines a message gets instead of a turn). */
export function prepareLocal(r: Local, glyphs: { fail: string }): { route: LocalChatRoute & { numCtx?: number } } | { refusal: Segment[][] } {
  const quiet = (text: string): Segment[] => [{ text, role: 'secondary' }];
  const head = (words: string): Segment[] => [{ text: `${glyphs.fail} Error:`, role: 'failure' }, { text: ` ${words}` }];
  if ('error' in r.at) {
    return { refusal: [head('the chat is set to the local model, and its Ollama address is not one Timmy uses.'), quiet(`  Cause: ${r.host}: ${r.at.error}.`), quiet('  Try: /setup chat (it asks again), or timmy init --ollama <host>'), quiet('  Nothing was sent to any model.')] };
  }
  if (!r.model) {
    return { refusal: [head('the chat is set to the local model, and no model is chosen.'), quiet(`  Cause: the setup recorded none for ${atWords(r.at)}${r.note ? `; ${r.note}` : ''}.`), quiet('  Try: /model (lists what Ollama has), then /model <name>; /setup chat keeps one'), quiet('  Nothing was sent to any model.')] };
  }
  return { route: { host: r.host, model: r.model, ...(r.numCtx ? { numCtx: r.numCtx } : {}) } };
}

/**
 * R4 (H103, D1): a message with no route: no model key, and the setup did not choose the local model. Nothing is sent; these
 * words say why and the fix, from any terminal (the REPL's own words name /setup; every surface can run these).
 */
export const NO_ROUTE_REFUSAL: readonly string[] = [
  'Error: no model key, and the chat is not set to the local model, so this message was not sent.',
  'Cause: no OPENROUTER_API_KEY, and the setup stored no key; its chat answer is OpenRouter, or none yet.',
  'Try: timmy init --chat openrouter (it asks for the key, hidden), or the local model: timmy init --chat local --model <name>',
  'Nothing was sent to any model.',
];

/** Segments as plain lines (a refusal's words without its colours or glyph). */
const plainLines = (rows: Segment[][]): string[] => rows.map((row) => row.map((s) => s.text).join('').trim()).filter(Boolean);

/** The route now, as every surface shows it (ChatRouteState), and the agent's local route when that one is ready. */
export interface RouteNow {
  route: ChatRoute;
  state: ChatRouteState;
  /** the local route as the agent takes it (Agent.useLocalChat), when the chat is local and ready */
  local?: LocalChatRoute & { numCtx?: number };
}

/** R4 (H113): the REPL's own way to a key or the local model (its /setup key and /setup chat), in place of NO_ROUTE_REFUSAL's Try. */
export const REPL_NO_ROUTE_TRY = 'Try: /setup key (it asks for the key, hidden), or the local model: /setup chat';

/**
 * R11 (H169, Phase 0 item 1; the operator's order of 2026-10-23: no default paid model anywhere, "Disable an unsafe Send path
 * rather than using an unchosen model"): a key, and no OpenRouter model chosen for the next turn. Nothing is sent until a
 * person chooses one; the same words on every surface, each with its own way to choose. The route's words end in
 * NO_MODEL_CHOSEN_WORDS, so a surface can tell this refusal by them.
 */
export const NO_MODEL_CHOSEN_WORDS = 'no model chosen';
/** The one sentence every surface says (the lead's words; H172's test asserts it on each): the REPL's own way to choose. */
export const NO_MODEL_CHOSEN_SENTENCE = 'No model chosen. /model <id> chooses one (/model free lists free ones).';
export const NO_MODEL_CHOSEN_REFUSAL: readonly string[] = [
  `Error: ${NO_MODEL_CHOSEN_SENTENCE}`,
  'Cause: an OpenRouter key is set up, and no model is chosen for the next turn: nothing is sent to a model nobody chose.',
  'Try: Models (M) in timmy workbench, /model <id> in the REPL (timmy), or timmy init --chat openrouter --model <id>',
  'Nothing was sent to any model.',
];
/** The refusal in the words of a surface: the REPL's own command is in the sentence already (no Try); elsewhere, where to choose. */
export const noModelChosenRefusal = (surface: ChatSurface): string[] => NO_MODEL_CHOSEN_REFUSAL.filter((l) => !(surface === 'repl' && /^Try:/.test(l)));

/**
 * R4 (H103): the chat's route from the setup now, in the words of the contract (src/contracts/chat-session.ts): local (the
 * Ollama and model the setup chose: ready, or why not), OpenRouter (a model key is found), or none (no key, and the setup
 * did not choose the local model: refused, nothing sent). `key`: whether a model key is found; `openRouterModel`: the
 * OpenRouter route's model, named in its words; `short`: the model's last part only (the monitor's narrow top line).
 * Reads the setup's files only: no request to anything.
 *
 * R4 (H113): the one route of every surface: the REPL's header and its refusals (src/repl/main.ts), the chat session's route
 * (the monitor's and the terminal Workbench's, src/agent/chat-session.ts), the monitor's top line (ShellV2) and the companion
 * page's Send, on or off and why (src/companion/chat-route.ts pageRoute) all read it, so they agree for every setup. A surface
 * that does not know whether a key is found gives no `key`: it is looked for where the REPL looks (src/utils/model-key.ts,
 * from `cwd`). Each surface's own way to the fix: the REPL's commands in the REPL; the monitor's /setup on its top line; a
 * command any terminal runs elsewhere.
 */
export function chatRouteNow(o: {
  env?: Env; cwd?: string; state?: SetupState; session?: string | null; key?: boolean; openRouterModel?: string | null; short?: boolean; surface?: ChatSurface;
  /** R5: free-only now (absent: TIMMY_CHAT_FREE_ONLY, else the settings' freeOnly); `price` answers what a model costs (a test's) */
  freeOnly?: boolean; price?: (id: string) => ModelPrice;
  /** R10 (H169): local-only now (absent: TIMMY_CHAT_LOCAL_ONLY, else the settings' localOnly) */
  localOnly?: boolean;
}): RouteNow {
  const surface = o.surface ?? 'repl';
  const route = resolveChatRoute({ env: o.env, state: o.state, session: o.session });
  // R10 (H169): the policy, read at every message (src/agent/route-policy.ts): local-only, then free-only
  const policy: RoutePolicy = { freeOnly: o.freeOnly ?? freeOnlyOn(o.env ?? process.env), localOnly: o.localOnly ?? localOnlyOn(o.env ?? process.env) };
  const tag = (words: string): string => `${words}${policy.localOnly ? ' · local-only' : ''}`;
  // the monitor's top line names its own /setup (it answers where the setup happens): never the REPL's /model or /setup chat
  const said = (words: string): string => (surface === 'monitor' ? words.replace(/ · \/(model|setup chat)$/, ' · /setup') : words);
  if (route.kind === 'local') {
    const words = said(localRouteWords(route));
    const ready = prepareLocal(route, { fail: '' });
    if ('route' in ready) {
      // R10 (H169): a cloud model through this Ollama, or another computer's Ollama, is refused by local-only; free-only
      // refuses what it cannot know to be free (a model with local weights here costs nothing)
      if (policy.localOnly || policy.freeOnly) {
        const c = checkRoute({ source: 'ollama-local', model: ready.route.model, host: ready.route.host, role: 'turn' }, policy, o.price ? { price: o.price } : {});
        if (!c.ok) return { route, state: { kind: 'local', words: `${words} · ${c.reason === 'cloud-under-local-only' ? 'local-only' : 'free-only'}: not sent`, ready: false, refusal: policyRefusalLines(c, surface !== 'repl') } };
      }
      return { route, state: { kind: 'local', words: tag(words), ready: true }, local: ready.route };
    }
    // the fix in the words of the surface: the REPL's own commands there, a command any terminal runs elsewhere
    const away = surface !== 'repl';
    const refusal = plainLines(ready.refusal).map((l) => (!away || !/^Try:/.test(l) ? l
      : 'error' in route.at ? 'Try: timmy init --chat local --ollama <host> (in a terminal), or /setup chat in the REPL'
        : 'Try: timmy init --chat local --model <name> (in a terminal: Timmy checks that Ollama lists it), or /model in the REPL'));
    return { route, state: { kind: 'local', words, ready: false, refusal } };
  }
  const key = o.key ?? (() => { try { return modelKeySource(o.env ?? process.env, o.cwd ?? process.cwd()) !== null; } catch { return false; } })();
  if (key) {
    // R11 (H169, Phase 0 item 1): a key and no model chosen: refused before anything, on every surface, whatever the policy
    if (!String(o.openRouterModel ?? '').trim()) {
      return { route, state: { kind: 'openrouter', words: `${said(chatRoute({ key: true, model: null, short: o.short }))} · ${NO_MODEL_CHOSEN_WORDS}`, ready: false, refusal: noModelChosenRefusal(surface) } };
    }
    const words = said(chatRoute({ key: true, model: o.openRouterModel ?? null, short: o.short }));
    // R10 (H169): local-only refuses OpenRouter, whatever the model costs
    if (policy.localOnly) {
      const c = checkRoute({ source: 'openrouter', model: o.openRouterModel ?? 'the chat\'s OpenRouter model', role: 'turn' }, policy, o.price ? { price: o.price } : {});
      if (!c.ok) return { route, state: { kind: 'openrouter', words: `${words} · local-only: not sent`, ready: false, refusal: policyRefusalLines(c, surface !== 'repl') } };
    }
    // R5: free-only refuses a model not known to be free (unknown is refused, never passed), on every surface alike
    if (policy.freeOnly) {
      const model = o.openRouterModel ?? null;
      const refusal = freeOnlyRefusal(model, model ? (o.price ?? ((id: string) => modelPrice(id)))(model) : null, surface !== 'repl');
      if (refusal) return { route, state: { kind: 'openrouter', words: `${words} · free-only: not sent`, ready: false, refusal } };
      return { route, state: { kind: 'openrouter', words: `${words} · free-only`, ready: true } };
    }
    return { route, state: { kind: 'openrouter', words, ready: true } };
  }
  const refusal = surface === 'repl' ? NO_ROUTE_REFUSAL.map((l) => (/^Try:/.test(l) ? REPL_NO_ROUTE_TRY : l)) : [...NO_ROUTE_REFUSAL];
  return { route, state: { kind: 'none', words: said(chatRoute({ key: false })), ready: false, refusal } };
}

/**
 * R4 (H113): a refusal's lines (chatRouteNow's) as the REPL prints them: the first, an error, with the failure glyph; the rest
 * quiet and indented (as prepareLocal's segments always were).
 */
export function refusalSegments(lines: readonly string[], glyphs: { fail: string }): Segment[][] {
  return lines.map((l): Segment[] => {
    const m = /^Error:\s*(.*)$/.exec(l);
    return m ? [{ text: `${glyphs.fail} Error:`, role: 'failure' }, { text: ` ${m[1]}` }] : [{ text: `  ${l}`, role: 'secondary' }];
  });
}

/**
 * R4 (H103, D1c): what a turn answered by the last-resort fallback is sealed with (src/repl/seal.ts route): this computer's
 * Ollama, no tools (the fallback offers none), the model that answered and no charge on that local endpoint. A receipt that
 * uses it also names OpenRouter's failure (`cause`).
 */
export function fallbackRoute(fb: LastResortAnswer): NonNullable<TurnFacts['route']> {
  // R4 (H113): its role and OpenRouter's failure on every surface's receipt (the chat session sealed them; the REPL's did not)
  return { host: fb.host, endpoint: 'local', tools: 'off', modelResolved: `ollama/${fb.model}`, costBasis: 'local endpoint', role: 'last-resort fallback', openrouterFailed: fb.cause };
}

/** What a local turn is sealed with (src/repl/seal.ts route): `last` is the turn's own report, null when it did not finish. */
export function sealedRoute(route: LocalChatRoute, last: LocalTurnResult | null): NonNullable<TurnFacts['route']> {
  const at = ollamaAt(route.host);
  const local = last ? last.localEndpoint : !('error' in at) && at.loopback && !cloudModelTag(route.model);
  return {
    host: 'error' in at ? route.host : at.host, endpoint: local ? 'local' : 'remote',
    tools: last ? (last.toolsOn ? 'on' : 'off') : 'unknown', ...(last?.actualModel ? { modelResolved: last.actualModel } : {}),
    costBasis: local ? 'local endpoint' : 'unknown',
  };
}

const pad = (s: string, n: number): string => (s.length >= n ? s : s + ' '.repeat(n - s.length));

/** The models as /model lists them: each with what it is, the current one marked. */
function listing(models: ListedModel[], at: OllamaAt, current: string | null, mark: string): Segment[][] {
  const width = Math.min(40, Math.max(8, ...models.map((m) => m.name.length)));
  return models.map((m, i) => [
    { text: `  ${m.name === current ? mark : ' '} ${String(i + 1).padStart(2)}  ` , role: 'secondary' as const },
    { text: pad(m.name, width), ...(m.name === current ? { role: 'strong' as const } : {}) },
    { text: `  ${modelFacts(m, at)}`, role: (m.cloud ? 'estimate' : 'secondary') as Segment['role'] },
  ]);
}

/**
 * The REPL's /model on the local route: with no argument, what Ollama lists (each labelled local weights or cloud-backed)
 * and the model in use; with a name (or a number from that list), that model for this session, only when Ollama lists it.
 * A cloud-backed one is taken only by its own name or number, and says that the chat then leaves this computer. Nothing is
 * downloaded. `set` takes the new model for this session.
 */
export async function localModelCommand(args: string, r: Local, o: { set: (model: string) => void; glyphs: { ok: string; fail: string; arrow: string; bullet: string } }): Promise<Segment[][]> {
  const quiet = (text: string): Segment[] => [{ text, role: 'secondary' }];
  const out: Segment[][] = [];
  if ('error' in r.at) return [[{ text: `  ${o.glyphs.fail} `, role: 'failure' }, { text: `The setup's Ollama address (${r.host}) is not one Timmy uses: ${r.at.error}.` }], quiet('  /setup chat asks again.')];
  const list = await listOllamaModels(r.host, { timeoutMs: 5000 });
  const want = args.trim();
  if (!want) {
    out.push([{ text: '  Chat     ', role: 'secondary' }, { text: `local · ${atWords(r.at)}` }]);
    out.push([{ text: '  Model    ', role: 'secondary' }, r.model ? { text: r.model, role: 'strong' } : { text: 'none chosen' }, ...(r.from ? [{ text: ` (${r.from})`, role: 'secondary' as const }] : [])]);
    if (!list.ok) {
      out.push(quiet(`  Not listed: ${listProblem(list, r.host)}.`));
      return out;
    }
    if (!list.models.length) {
      out.push(quiet(`  ${atWords(r.at)} lists no model. ${PULL_WORDS}`));
      return out;
    }
    out.push(...listing(list.models, r.at, r.model, o.glyphs.bullet));
    out.push(quiet('  /model <name or number> switches for this session; /setup chat keeps one for every start.'));
    return out;
  }
  if (!list.ok) return [[{ text: `  ${o.glyphs.fail} `, role: 'failure' }, { text: `Nothing changed: ${listProblem(list, r.host)}, so Timmy cannot check that it has ${want}.` }]];
  const byNumber = /^\d{1,3}$/.test(want) ? list.models[Number(want) - 1] : undefined;
  const chosen = byNumber ?? list.models.find((m) => m.name === want);
  if (!chosen) {
    return [
      [{ text: `  ${o.glyphs.fail} `, role: 'failure' }, { text: `Nothing changed: ${atWords(r.at)} lists no model ${/^\d{1,3}$/.test(want) ? `number ${want}` : `named ${want}`}.` }],
      quiet(`  /model lists what it has. ${PULL_WORDS}`),
    ];
  }
  // what the model can do, asked of Ollama now (a turn asks again)
  let tools = 'tool calls: checked at the next message';
  const { showModel, LocalChatError } = await import('./local-chat.js');
  try {
    const shown = await showModel(r.at, chosen.name, undefined, 5000);
    tools = shown.capabilities === null ? 'tool calls: Ollama does not say' : shown.capabilities.includes('tools') ? 'takes tool calls' : 'does not take tool calls: turns run without tools';
  } catch (err) {
    tools = err instanceof LocalChatError ? `tool calls: not known (${err.message.split('\n')[0]})` : tools;
  }
  o.set(chosen.name);
  out.push([{ text: `  ${o.glyphs.ok} `, role: 'verified' }, { text: 'Chat model ' }, { text: `${r.model ?? 'none'} ${o.glyphs.arrow} `, role: 'secondary' }, { text: chosen.name, role: 'strong' }, { text: ' for this session', role: 'secondary' }]);
  out.push(quiet(`  ${modelFacts(chosen, r.at)} · ${tools}`));
  if (chosen.cloud) out.push([{ text: '  Cloud-backed: Ollama sends the chat off this computer, and no cost comes back (unknown).', role: 'estimate' }]);
  out.push(quiet('  /setup chat keeps a model for every start.'));
  return out;
}
