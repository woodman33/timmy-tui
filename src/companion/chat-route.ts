/**
 * R4 (H104, second part): the route the companion page's own chat (STREAMDOWN CHAT, POST /chat) takes: the one the setup
 * chose for Timmy's chat, read at every request as the REPL reads it (src/agent/chat-route.ts resolveChatRoute, H103's). R4
 * (H113): on or off, and why, from the one route every surface reads (src/agent/chat-route.ts chatRouteNow).
 *
 *   the setup's chat answer   the page's Send                                                     its label
 *   local, a model chosen     streams that model's answer from the recorded Ollama's /api/chat   "local <model> · Ollama · this page's own
 *                                                                                                 chat · no tools"
 *                             (src/agent/local-chat.ts runLocalTurn), offering no tools; never
 *                             OpenRouter; a cloud-backed model only when its name says cloud
 *                             (the model was chosen by that name), and the label says so
 *   local, no model or no     off, saying why and where to fix it (the REPL's /model, /setup chat)
 *   usable Ollama address
 *   OpenRouter (or none),     as before: qwen/qwen3.8-max through OpenRouter with this computer's  "qwen/qwen3.8-max · OpenRouter · this
 *   with a key                key (each message spends credits)                                  page's own chat · each message spends
 *                                                                                                 credits"
 *   OpenRouter (or none),     off, saying where chat happens (the REPL and the monitor) and how
 *   no key                    to give the chat a route (`timmy init`)
 *
 * R10 (H164; the lead's call (b) of 2026-10-22): the page's Send is this page's own chat, not the project's conversation (the one
 * the Workbench, the REPL and the monitor continue, src/agent/chat-session.ts): its request carries the page's own messages, it
 * offers no tools and it seals no receipt. Its label says "this page's own chat", its words begin with PAGE_SCOPE.words, and the
 * route's `scope` says it as data, so no screen shows it as the project's chat (src/journey/route.ts routeNow({ surface:
 * 'companion' }) takes its words from here).
 *
 * The OpenRouter key is looked for where the REPL looks (src/utils/config.ts loadConfig's order, as src/utils/model-key.ts
 * modelKeySource reads it): the environment (with the .env files the companion always read), a local timmy-tui.config.json,
 * the Timmy home's providers.json (`timmy init` keeps it there), then the monitor's settings. The key goes to OpenRouter only
 * and is never shown: the page is told where it was found, never what it is.
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { chatRouteNow, localRouteWords } from '../agent/chat-route.js';
import { modelPrice } from '../agent/model-price.js';
import { LocalChatError, runLocalTurn } from '../agent/local-chat.js';
import { atWords } from '../setup/ollama-models.js';
import { knownAnswers, readSetupState } from '../setup/questions.js';
import { settingsFile } from '../utils/model-key.js';

type Env = Record<string, string | undefined>;

/** The model the OpenRouter route asks (the page's chat as it was: TMX P3). */
export const OPENROUTER_MODEL = 'qwen/qwen3.8-max';

/** Where the OpenRouter key was found (never the key). */
export type KeyFrom = 'environment' | 'timmy-tui.config.json' | 'providers.json' | 'settings';

/**
 * What the page is told of its chat's route (GET /api/chat/route): never a key. R4 (H113): `refusal`, when Send is off, is the
 * one route's own lines (src/agent/chat-route.ts chatRouteNow, the companion's), the same why every surface gives.
 */
export type PageRoute =
  | { kind: 'local'; ready: true; label: string; words: string; model: string; host: string; cloud: boolean; loopback: boolean; numCtx?: number; scope: typeof PAGE_SCOPE }
  /** R5 (H132): `price`, what this computer knows of the model's price (src/agent/model-price.ts, never a guess); `freeOnly`,
   *  the free-only policy is on and passed (the model is known to be free) */
  | { kind: 'openrouter'; ready: true; label: string; words: string; model: string; keyFrom: KeyFrom; price: string; freeOnly: boolean; scope: typeof PAGE_SCOPE }
  | { kind: 'none'; ready: false; label: string; words: string; chat: 'local' | 'openrouter' | null; refusal: string[] };

/** R10 (H164): what the page's Send is, as data and in plain words: this page's own chat, not the project's conversation. */
export const PAGE_SCOPE = Object.freeze({
  conversation: 'this page' as const, tools: 'none' as const, receipt: false as const,
  words: 'This page\'s own chat, not the project\'s conversation (the Workbench\'s and the REPL\'s): no tools, no receipt.',
});
/** R10 (H164): the label's part that says so (beside the model and where it runs). */
export const PAGE_OWN = 'this page\'s own chat';

/** Where chat with Timmy happens, whatever this page can do (the end of every "Send is off" sentence). */
export const CHAT_HAPPENS = 'Chat with Timmy happens in its terminal: the REPL (timmy) and this monitor (timmy watch); the CHAT MIRROR tab shows it.';

const readJson = (file: string): unknown => {
  try { return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) as unknown : undefined; } catch { return undefined; }
};
const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const keyIn = (v: unknown, field: string): string | null => (isObject(v) && typeof v[field] === 'string' && (v[field] as string) ? v[field] as string : null);

/**
 * The OpenRouter key where the REPL finds it, and where that was; null when there is none. `env` already holds what the
 * .env files set (the server loads them into the environment as it always did, unless a test gives an environment of its own).
 */
export function openRouterKey(env: Env, cwd: string): { key: string; from: KeyFrom } | null {
  if (env.OPENROUTER_API_KEY) return { key: env.OPENROUTER_API_KEY, from: 'environment' };
  const local = readJson(resolve(cwd, 'timmy-tui.config.json'));
  const fromLocal = keyIn(local, 'apiKey');
  if (fromLocal) return { key: fromLocal, from: 'timmy-tui.config.json' };
  const providers = keyIn(readJson(join(env.TIMMY_HOME || join(homedir(), 'timmy'), 'providers.json')), 'openrouter_api_key');
  if (providers) return { key: providers, from: 'providers.json' };
  // a local file that sets the key to nothing hides the settings' key (loadConfig's spread)
  if (isObject(local) && 'apiKey' in local) return null;
  const settings = keyIn(readJson(settingsFile(env)), 'apiKey');
  return settings ? { key: settings, from: 'settings' } : null;
}

/**
 * The chat's route now, in the page's words. R4 (H113): on or off, and why, from the one route every surface reads
 * (src/agent/chat-route.ts chatRouteNow, as the companion: its key looked for where the REPL looks, from `cwd`); the words are
 * the page's own, about what its Send does.
 */
export function pageRoute(env: Env, cwd: string): PageRoute {
  // R5 (H132, the lead's free-only policy, 39d21ec): the page's own model is named, so its price can be known; without one,
  // free-only refuses (unknown is never free)
  const now = chatRouteNow({ env, cwd, surface: 'companion', openRouterModel: OPENROUTER_MODEL });
  const r = now.route;
  const refusal = [...(now.state.refusal ?? [])];
  if (r.kind === 'local') {
    if ('error' in r.at) {
      return { kind: 'none', ready: false, chat: 'local', refusal, label: 'chat: local · its Ollama address is not usable · Send is off',
        words: `Send is off: the setup chose the local model for chat, and its Ollama address (${r.host}) is not one Timmy uses: ${r.at.error}. In the REPL, /setup chat asks again. Nothing is sent from this page until then. ${CHAT_HAPPENS}` };
    }
    if (!r.model || !now.state.ready) {
      return { kind: 'none', ready: false, chat: 'local', refusal, label: 'chat: local · no model chosen · Send is off',
        words: `Send is off: the setup chose the local model for chat, and no model is chosen${r.note ? ` (${r.note})` : ''}. In the REPL, /model lists what ${atWords(r.at)} has and /setup chat keeps one. Nothing is sent from this page until then. ${CHAT_HAPPENS}` };
    }
    const where = r.cloud
      ? 'Its name says it is cloud-backed: Ollama sends the chat off this computer, and no cost comes back (unknown).'
      : r.at.loopback ? 'No charge: Ollama on this computer, with the model\'s local weights (Ollama is asked again at each message whether it sends the model elsewhere; then nothing is sent).'
        : 'The chat leaves this computer for that one, and no cost comes back (unknown).';
    return {
      kind: 'local', ready: true, model: r.model, host: r.host, cloud: r.cloud, loopback: r.at.loopback, ...(r.numCtx ? { numCtx: r.numCtx } : {}),
      label: `${localRouteWords(r).replace(/^chat: /, '')} · ${PAGE_OWN} · no tools`, scope: PAGE_SCOPE,
      words: `${PAGE_SCOPE.words} Send asks ${r.model} (chosen by name in ${r.from === 'TIMMY_CHAT_MODEL' ? 'TIMMY_CHAT_MODEL' : 'the setup'}) on ${atWords(r.at)}, through its /api/chat, offering no tools: it cannot read or change files or run anything from here. Never OpenRouter. ${where}`,
    };
  }
  // R5 (H132): free-only is on and the page's model is not known to be free: Send is off, in the policy's own words (its
  // refusal: what, Cause, Try), never "no key" (the key is there; the policy refuses)
  if (now.state.kind === 'openrouter' && !now.state.ready) {
    const lines = refusal.map((l) => l.trim()).filter(Boolean);
    const first = (lines.find((l) => /^Error:/.test(l)) ?? lines[0] ?? 'free-only is on, and this model is not known to be free.').replace(/^Error:\s*/, '');
    const said = [first, lines.find((l) => /^Cause:/.test(l)), lines.find((l) => /^Try:/.test(l))].filter(Boolean).join(' ');
    return { kind: 'none', ready: false, chat: 'openrouter', refusal, label: 'free-only · Send is off',
      words: `Send is off: ${said} Nothing is sent from this page until then. ${CHAT_HAPPENS}` };
  }
  // the page's own request needs the key itself (where it was found is said, never the key); the one route found it where
  // this does (src/utils/model-key.ts and openRouterKey look in the same places, in the same order)
  const key = now.state.ready ? openRouterKey(env, cwd) : null;
  if (!key) {
    const chat = knownAnswers(readSetupState(env)).chat;
    const chose = chat === 'openrouter' ? 'the setup chose OpenRouter for chat' : 'the setup has not chosen a route for chat';
    return { kind: 'none', ready: false, chat: chat === 'openrouter' ? 'openrouter' : null, refusal, label: 'no chat route here · Send is off',
      words: `Send is off: ${chose}, and no OpenRouter key is set (not in this companion's environment or .env, a timmy-tui.config.json, the Timmy home's providers.json or the monitor's settings), so this page asks no model. \`timmy init\` keeps a key, or chooses the local model. ${CHAT_HAPPENS}` };
  }
  // R5 (H132): the model's price as this computer knows it (src/agent/model-price.ts); free-only passed says so (the one
  // route's words end in "· free-only" when it did)
  const price = modelPrice(OPENROUTER_MODEL);
  const freeOnly = /· free-only$/.test(now.state.words);
  const found = key.from === 'environment' ? 'the environment' : key.from;
  return {
    kind: 'openrouter', ready: true, model: OPENROUTER_MODEL, keyFrom: key.from, price: price.words, freeOnly,
    label: freeOnly ? `${OPENROUTER_MODEL} · OpenRouter · ${PAGE_OWN} · free-only: free` : `${OPENROUTER_MODEL} · OpenRouter · ${PAGE_OWN} · each message spends credits`, scope: PAGE_SCOPE,
    words: freeOnly
      ? `${PAGE_SCOPE.words} Send asks ${OPENROUTER_MODEL} through OpenRouter with this computer's key (found in ${found}). Free-only is on, and this model is free: ${price.words}.`
      : `${PAGE_SCOPE.words} Send asks ${OPENROUTER_MODEL} through OpenRouter with this computer's key (found in ${found}): each message spends its credits. Its price: ${price.words}.`,
  };
}

type Send = (event: string, data: unknown) => void;
const NOTICE = /^⚙️ \*\*\[SYSTEM\]\*\* /;

/**
 * One answer on the local route, streamed to the page as the REPL's local turn makes it (src/agent/local-chat.ts runLocalTurn,
 * no tools): `delta` (text), `notice` (what the turn says beside its answer: a cloud-backed model, a cut answer), `cost`
 * (none on this computer's Ollama with local weights; otherwise unknown, with why), then `done`, or `error` with the turn's
 * own words (what, Reason, Next). A cancel (the page went away) ends it quietly.
 */
export async function streamLocalChat(o: { route: Extract<PageRoute, { kind: 'local' }>; messages: Array<{ role: string; content: string }>; signal: AbortSignal; send: Send }): Promise<void> {
  const { route, send } = o;
  try {
    const result = await runLocalTurn({
      route: { host: route.host, model: route.model }, history: o.messages, tools: [], maxSteps: 1, signal: o.signal,
      ...(route.numCtx ? { numCtx: route.numCtx } : {}),
      hooks: {
        emit: (event: string, ...args: unknown[]) => {
          if (event === 'stream:delta' && typeof args[0] === 'string') send('delta', args[0]);
          else if (event === 'message:user') send('notice', { text: String((args[0] as { content?: unknown } | undefined)?.content ?? '').replace(NOTICE, '') });
          else if (event === 'cost:update') {
            const info = args[2] as { complete?: boolean; basis?: string } | undefined;
            send('cost', info?.complete && info.basis === 'local endpoint'
              ? { usd: 0, measured: true, basis: 'local endpoint', words: 'no charge: Ollama on this computer, the model\'s local weights' }
              : { usd: null, measured: false, why: 'Ollama reports no cost for a cloud-backed model or another computer\'s', words: 'cost unknown: Ollama reports none for this route' });
          }
        },
        call: () => undefined, output: () => undefined, text: () => undefined,
      },
    });
    send('done', { ok: true, route: 'local', model: result.actualModel, localEndpoint: result.localEndpoint });
  } catch (err) {
    if ((err as { name?: unknown } | null)?.name === 'AbortError' || o.signal.aborted) return;
    send('error', { route: 'local', error: err instanceof LocalChatError ? err.message : `The local model's answer failed: ${err instanceof Error ? err.message : String(err)}. Nothing else was asked.` });
  }
}
