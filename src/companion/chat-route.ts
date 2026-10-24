/**
 * R4 (H104, second part): the route the companion page's chat (POST /api/chat/turn, src/companion/chat-run.ts) takes: the one the setup
 * chose for Timmy's chat, read at every request as the REPL reads it (src/agent/chat-route.ts resolveChatRoute, H103's). R4
 * (H113): on or off, and why, from the one route every surface reads (src/agent/chat-route.ts chatRouteNow).
 *
 *   the setup's chat answer   the page's Send                                                     its label
 *   local, a model chosen     the real turn on that model at the recorded Ollama (the agent's      "local <model> · Ollama · the project's
 *                             local route, src/agent/local-chat.ts, with the project's tools        conversation"
 *                             gated at NEEDS YOU); never OpenRouter; a ":cloud" name is Ollama's
 *                             cloud route (the model was chosen by that name), and the label says so
 *   local, no model or no     off, saying why and where to fix it (the REPL's /model, /setup chat)
 *   usable Ollama address
 *   OpenRouter (or none),     the model chosen in the settings (the one the Workbench's Models     "<model> · OpenRouter · the project's
 *   with a key, a model       chose: src/utils/model-choice.ts) through OpenRouter with this      conversation · each message spends credits"
 *   chosen                    computer's key (each message spends credits), the real turn
 *   OpenRouter, with a key,   off (R11 H169, Phase 0 item 2: there is no shipped default, and     "No model chosen: choose one in Models ·
 *   no model chosen           this page never asks a model nobody chose): reason 'no-model-chosen' Send is off"
 *   OpenRouter (or none),     off, saying where chat happens (the REPL and the monitor) and how
 *   no key                    to give the chat a route (`timmy init`)
 *
 * R11 round 4 (H169; the operator's order of 2026-10-23 19:17, contract C3; it supersedes R10's call (b) of 2026-10-22): the
 * page's Send is the REAL turn, the project's conversation the Workbench, the REPL and the monitor continue
 * (src/companion/chat-run.ts, through src/agent/chat-session.ts openChatSession({ surface: 'companion' })): the agent's tools,
 * gated at NEEDS YOU, and a receipt sealed for every turn. Its label ends in "the project's conversation", its words begin
 * with PAGE_SCOPE.words, and the route's `scope` says it as data (src/journey/route.ts routeNow({ surface: 'companion' })
 * takes its words from here).
 *
 * The OpenRouter key is looked for where the REPL looks (src/utils/config.ts loadConfig's order, as src/utils/model-key.ts
 * modelKeySource reads it): the environment (with the .env files the companion always read), a local timmy-tui.config.json,
 * the Timmy home's providers.json (`timmy init` keeps it there), then the monitor's settings. The key goes to OpenRouter only
 * and is never shown: the page is told where it was found, never what it is.
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { chatRouteNow, localRouteWords, NO_MODEL_CHOSEN_SENTENCE } from '../agent/chat-route.js';
import { modelPrice } from '../agent/model-price.js';
import { atWords } from '../setup/ollama-models.js';
import { knownAnswers, readSetupState } from '../setup/questions.js';
import { chosenModel } from '../utils/model-choice.js';
import { OLLAMA_CLOUD_TERMS } from '../models/catalog.js';
import { settingsFile } from '../utils/model-key.js';

type Env = Record<string, string | undefined>;

/**
 * R11 (H169, Phase 0 item 2): the OpenRouter model this page's Send asks: the one chosen in the settings, the same the Workbench's
 * Models chose (src/utils/model-choice.ts chosenModel: OPENROUTER_MODEL for one process, a local timmy-tui.config.json's model,
 * else the settings', never an older file's shipped default nobody chose), read by path as the key is; '' when none is chosen.
 * The page's own fixed model (qwen/qwen3.8-max, nobody's choice) is gone.
 */
export function pageModel(env: Env, cwd: string): string {
  if (env.OPENROUTER_MODEL?.trim()) return env.OPENROUTER_MODEL.trim();
  const local = readJson(resolve(cwd, 'timmy-tui.config.json'));
  const fromLocal = keyIn(local, 'model');
  if (fromLocal) return fromLocal;
  const file = settingsFile(env);
  return chosenModel({ settings: readJson(file) as { model?: unknown; modelChosen?: unknown } | undefined, workbench: readJson(join(dirname(file), 'workbench.json')) as { openRouterModel?: unknown } | undefined, env: {} });
}
/** The sentence every "no model chosen" label and words carry (H172's test reads it on this surface). */
export const NO_MODEL_CHOSEN_PAGE = 'No model chosen: choose one in Models';

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
  /** R11 (H169): `reason` 'no-model-chosen': a key, and no OpenRouter model chosen for the next turn (Send is off until one is) */
  | { kind: 'none'; ready: false; label: string; words: string; chat: 'local' | 'openrouter' | null; refusal: string[]; reason?: 'no-model-chosen' };

/**
 * R11 round 4 (H169; contract C3): what the page's Send is, as data and in plain words: the project's conversation (the real
 * turn: the agent's tools gated at NEEDS YOU, a receipt sealed for every turn), the same the Workbench and the REPL continue.
 */
export const PAGE_SCOPE = Object.freeze({
  conversation: 'project' as const, tools: 'gated' as const, receipt: true as const,
  words: 'The project\'s conversation, the one the Workbench and the REPL continue: the agent\'s tools, gated at NEEDS YOU; every turn sealed with a receipt.',
});
/** The label's part that says so (beside the model and where it runs). */
export const PAGE_OWN = 'the project\'s conversation';

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
  // R5 (H132, the lead's free-only policy, 39d21ec): the page's model is named, so its price can be known; without one,
  // free-only refuses (unknown is never free). R11 (H169): the model is the settings' chosen one, or none
  const model = pageModel(env, cwd);
  const now = chatRouteNow({ env, cwd, surface: 'companion', openRouterModel: model || null });
  const r = now.route;
  const refusal = [...(now.state.refusal ?? [])];
  if (r.kind === 'local') {
    if ('error' in r.at) {
      return { kind: 'none', ready: false, chat: 'local', refusal, label: 'chat: local · its Ollama address is not usable · Send is off',
        words: `Send is off: the setup chose the local model for chat, and its Ollama address (${r.host}) is not one Timmy uses: ${r.at.error}. In the REPL, /setup chat asks again. Nothing is sent from this page until then. ${CHAT_HAPPENS}` };
    }
    // R10 (H169): a model is chosen and the route policy refuses it (local-only: a cloud model, or another computer's Ollama;
    // free-only: a price this computer cannot know): Send is off in the policy's own words, never "no model chosen"
    const rule = /^Error: (local-only|free-only) is on/.exec(refusal[0] ?? '')?.[1];
    if (r.model && !now.state.ready && rule) {
      const lines = refusal.map((l) => l.trim()).filter(Boolean);
      const said = [lines.find((l) => /^Cause:/.test(l)), lines.find((l) => /^Try:/.test(l))].filter(Boolean).join(' ');
      return { kind: 'none', ready: false, chat: 'local', refusal, label: `${rule} · Send is off`,
        words: `Send is off: ${rule} is on, and this page would ask ${r.model} on ${atWords(r.at)}. ${said} Nothing is sent from this page until then. ${CHAT_HAPPENS}` };
    }
    if (!r.model || !now.state.ready) {
      return { kind: 'none', ready: false, chat: 'local', refusal, label: 'chat: local · no model chosen · Send is off',
        words: `Send is off: the setup chose the local model for chat, and no model is chosen${r.note ? ` (${r.note})` : ''}. In the REPL, /model lists what ${atWords(r.at)} has and /setup chat keeps one. Nothing is sent from this page until then. ${CHAT_HAPPENS}` };
    }
    // R11 Phase 2 (H169, item c): a ":cloud" name runs on Ollama's servers under the person's Ollama account (never "free")
    const where = r.cloud
      ? `Its name says cloud: it ${OLLAMA_CLOUD_TERMS}. Ollama sends the chat off this computer, and no cost comes back (unknown).`
      : r.at.loopback ? 'No charge: Ollama on this computer, with the model\'s local weights (Ollama is asked again at each message whether it sends the model elsewhere; then nothing is sent).'
        : 'The chat leaves this computer for that one, and no cost comes back (unknown).';
    return {
      kind: 'local', ready: true, model: r.model, host: r.host, cloud: r.cloud, loopback: r.at.loopback, ...(r.numCtx ? { numCtx: r.numCtx } : {}),
      label: `${localRouteWords(r).replace(/^chat: /, '')} · ${PAGE_OWN}`, scope: PAGE_SCOPE,
      words: `${PAGE_SCOPE.words} Send asks ${r.model} (chosen by name in ${r.from === 'TIMMY_CHAT_MODEL' ? 'TIMMY_CHAT_MODEL' : 'the setup'}) on ${atWords(r.at)}, through its /api/chat, with the project's tools (each that needs you waits at NEEDS YOU). Never OpenRouter. ${where}`,
    };
  }
  // R11 (H169, Phase 0 item 2): a key and no model chosen: Send is off until one is chosen (in Models, the same choice as the
  // Workbench's), never a model nobody chose
  if (now.state.kind === 'openrouter' && !now.state.ready && refusal[0] === `Error: ${NO_MODEL_CHOSEN_SENTENCE}`) {
    return { kind: 'none', ready: false, chat: 'openrouter', reason: 'no-model-chosen', refusal, label: `${NO_MODEL_CHOSEN_PAGE} · Send is off`,
      words: `Send is off: ${NO_MODEL_CHOSEN_PAGE} (this page's Chat, or M in timmy workbench: the same choice serves both), and nothing is sent to a model nobody chose. Nothing is sent from this page until then. ${CHAT_HAPPENS}` };
  }
  // R5 (H132): free-only is on and the page's model is not known to be free: Send is off, in the policy's own words (its
  // refusal: what, Cause, Try), never "no key" (the key is there; the policy refuses)
  if (now.state.kind === 'openrouter' && !now.state.ready) {
    const lines = refusal.map((l) => l.trim()).filter(Boolean);
    const first = (lines.find((l) => /^Error:/.test(l)) ?? lines[0] ?? 'free-only is on, and this model is not known to be free.').replace(/^Error:\s*/, '');
    const said = [first, lines.find((l) => /^Cause:/.test(l)), lines.find((l) => /^Try:/.test(l))].filter(Boolean).join(' ');
    // R10 (H169): local-only refuses OpenRouter whatever it costs; its label names it
    const rule = /^local-only is on/.test(first) ? 'local-only' : 'free-only';
    return { kind: 'none', ready: false, chat: 'openrouter', refusal, label: `${rule} · Send is off`,
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
  const price = modelPrice(model);
  const freeOnly = /· free-only$/.test(now.state.words);
  const found = key.from === 'environment' ? 'the environment' : key.from;
  return {
    kind: 'openrouter', ready: true, model, keyFrom: key.from, price: price.words, freeOnly,
    label: freeOnly ? `${model} · OpenRouter · ${PAGE_OWN} · free-only: free` : `${model} · OpenRouter · ${PAGE_OWN} · each message spends credits`, scope: PAGE_SCOPE,
    words: freeOnly
      ? `${PAGE_SCOPE.words} Send asks ${model} (the model chosen in Models) through OpenRouter with this computer's key (found in ${found}). Free-only is on, and this model is free: ${price.words}.`
      : `${PAGE_SCOPE.words} Send asks ${model} (the model chosen in Models) through OpenRouter with this computer's key (found in ${found}): each message spends its credits. Its price: ${price.words}.`,
  };
}

// R11 round 4 (H169): streamLocalChat, the page's raw local stream (no tools, no hold, no receipt), is gone with the legacy
// POST /chat: the page's chat is the real turn (src/companion/chat-run.ts, through openChatSession({ surface: 'companion' })).
