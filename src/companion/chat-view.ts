/**
 * R10 CHAT CHECKPOINT (H171; the operator's order of 2026-10-22, 16:01 PT: onboarding and ONE main Chat screen, LEFT menu,
 * CENTER chat, RIGHT models, BOTTOM controls): what the browser companion's Chat composition reads, read only, for the project
 * the page shows. src/companion/server.ts mounts the routes; src/companion/client/chat-shell.js draws them.
 *
 *   route                                         answers
 *   GET /api/chat/view                            the project's saved conversation (its newest one in .sessions, as the REPL,
 *                                                 the Workbench and the monitor keep it), each answer with the model that
 *                                                 answered it as its sealed receipt says (matched by the answer's hash, the
 *                                                 receipt's response_hash; a turn no receipt matches says so); the route this
 *                                                 page's Send takes now (src/companion/chat-route.ts pageRoute, never a key);
 *                                                 the free-only policy; each provider's state; where the logs are kept
 *   GET /api/chat/models?source=<s>&search=&sort=&maker=&capability=&cost=&context=
 *                                                 the catalog rows of one source (openrouter, ollama-local, ollama-cloud), sorted
 *                                                 and filtered (a sort never resets a filter), at most MODELS_MAX of them, with
 *                                                 how many the filters keep (matched), the source's rows (all), the makers and
 *                                                 where the rows came from
 *
 * Each needs the companion's token (refused, 401, before anything is read). Nothing here writes, sends a prompt or spends.
 * The one kind of request it makes is the local Ollama's list of models and their facts (GET /api/tags and POST /api/show at
 * the address the chat asks, src/capabilities/ollama-route.ts): no model runs and nothing is spent; its answer is kept
 * LOCAL_KEEP_MS, so the page's reads every few seconds do not ask each time. OpenRouter's catalog is the one this computer already has (the one
 * `timmy models --refresh` fetched into the Timmy home, else the snapshot shipped with Timmy), named with its date; nothing
 * asks OpenRouter from here. Ollama Cloud and Cloudflare are never asked from here (a Cloudflare request can create a
 * gateway and bill): their state is what this computer holds, and says so.
 *
 * The shared contract of the slice (the lead's CHAT-COMMON brief): the rows, their query and their load are H169's
 * (src/models/catalog.ts loadCatalog and queryCatalog, merged in from r10/review-build), read here with refresh 'never': the
 * rail shows what this computer keeps, and asks no one for a catalog. Each provider's state is H170's (src/setup/
 * providers-state.ts providerStates: files and the PATH, no request), with two things of this page's own: the local Ollama's
 * state rests on the list this page just asked for, when it asked (an observed answer, with its time), and each next step
 * says where it happens (this page signs in, keeps a key, checks and downloads nothing in this revision: the terminal does).
 * The policy is H169's (src/agent/route-policy.ts routePolicyNow: free-only and local-only, and where each is set).
 */
import type express from 'express';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { ConversationManager } from '../agent/conversation.js';
import { modelPrice } from '../agent/model-price.js';
import { permits, policyFrom, policyRefusalLines, routePolicyNow } from '../agent/route-policy.js';
import { ollamaAddress } from '../capabilities/ollama-route.js';
import { loadCatalog, queryCatalog, type CatalogLoad, type CatalogQuery, type CatalogRow, type ModelSource } from '../models/catalog.js';
import type { ActiveProject } from '../project/index.js';
import { chatTurnOf } from '../repl/seal.js';
import { checkLocalModel } from '../setup/local-model-check.js';
import { installSteps, ollamaInstalled, STARTER_MODELS } from '../setup/ollama-local.js';
import { providerStates, type ProviderState as SetupState } from '../setup/providers-state.js';
import { readSetupState } from '../setup/questions.js';
import { scrubHomes, scrubStrings } from '../utils/home-scrub.js';
import { readChain, type Receipt } from '../utils/receipts.js';
import { readSettings, saveSettings } from '../workbench/settings.js';
import { PAGE_SCOPE, pageRoute, type PageRoute } from './chat-route.js';

type Env = Record<string, string | undefined>;

export const CHAT_VIEW_ROUTES = { view: '/api/chat/view', models: '/api/chat/models', choose: '/api/chat/choose' } as const;
/** The most rows one models answer carries (the rail lists them; search and the filters find the rest). */
export const MODELS_MAX = 80;
/** The most messages of the saved conversation one view answer carries (its newest). */
export const TURNS_MAX = 120;
/** The most characters of one message the page is given (a longer one is cut, and says so). */
export const TEXT_MAX = 16_000;

export type { CatalogQuery, CatalogRow, ModelSource };

// ── each provider's state: H170's ProviderState, and how many models this page's own read found (the local Ollama) ──

export type ProviderState = SetupState & { models?: number };

/**
 * What the local Ollama answered this page's read of its list of models (GET /api/tags; no model runs): `models` the chat
 * models (its /api/show check passed as local completion weights: the rows), `listed` how many it lists (R10 H171, H168's
 * pass 3b R20: a model that is not a chat model, or a cloud one, is listed but not a row), `left` why the others are not rows.
 */
export interface LocalAnswer { answered: boolean; models: number; listed?: number; left?: string; at: string; error?: string }

const SOURCES: readonly ModelSource[] = ['openrouter', 'ollama-local', 'ollama-cloud'];
const SORTS: ReadonlyArray<CatalogQuery['sort']> = ['recent', 'name', 'price', 'context'];
const CAPS: ReadonlyArray<NonNullable<CatalogQuery['capability']>> = ['tools', 'vision', 'reasoning'];

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');
const day = (iso?: string): string => (iso ? iso.slice(0, 10) : 'an unknown date');

/** A source's rows as this computer keeps them (H169's loadCatalog, refresh never: nothing is asked for a catalog), in words. */
export interface CatalogRead extends CatalogLoad { words: string; observed?: LocalAnswer; listed?: number; left?: string }

/** How many models the local Ollama lists, and why some are not rows, from H169's listing (src/models/ollama-list.ts: "Ollama lists N: …"). */
function listedOf(load: CatalogLoad): { listed: number; left?: string } {
  const m = /^Ollama lists (\d+): (.+)$/.exec(load.error ?? '');
  return m ? { listed: Number(m[1]), left: m[2] } : { listed: load.rows.length };
}

/** The local Ollama's last answer, kept a moment so the Chat's every-few-seconds read does not list Ollama each time. */
const LOCAL_KEEP_MS = 15_000;
let localKept: { at: number; key: string; read: CatalogRead } | null = null;

/**
 * One source's rows: OpenRouter's catalog as this computer keeps it (fetched into the Timmy home, else the snapshot shipped
 * with Timmy), the local Ollama's models (its list of models: no model runs, nothing is spent; the one request), or Ollama
 * Cloud's (read only when asked, so none here). Never throws.
 */
export async function companionCatalog(source: ModelSource, env: Env, o: { now?: () => number; fresh?: boolean } = {}): Promise<CatalogRead> {
  const now = (o.now ?? Date.now)();
  if (source === 'ollama-local') {
    const key = JSON.stringify([env.TIMMY_HOME, env.OLLAMA_HOST, env.OLLAMA_BASE_URL, env.TIMMY_CHAT_MODEL]);
    // `fresh` (the page's Refresh): Ollama is asked again now
    if (!o.fresh && localKept && localKept.key === key && now - localKept.at < LOCAL_KEEP_MS) return localKept.read;
    const load = await loadCatalog('ollama-local', { env, refresh: 'never', timeoutMs: 2000 });
    const at = load.fetchedAt ?? new Date(now).toISOString();
    const n = load.rows.length;
    const { listed, left } = listedOf(load);
    const read: CatalogRead = load.from === 'live'
      ? { ...load, listed, ...(left ? { left } : {}), words: listed > n ? `Ollama on this computer answered its list of models: it lists ${listed}, ${n} of them ${n === 1 ? 'a local chat model' : 'local chat models'}. No model ran.` : `Ollama on this computer answered its list of models: ${n} installed here. No model ran.`,
        observed: { answered: true, models: n, listed, ...(left ? { left } : {}), at } }
      : { ...load, words: `Ollama on this computer did not answer: ${load.error ?? 'no answer'}.`, observed: { answered: false, models: 0, at, ...(load.error ? { error: load.error } : {}) } };
    localKept = { at: now, key, read };
    return read;
  }
  const load = await loadCatalog(source, { env, refresh: 'never' });
  if (source === 'openrouter') {
    const words = load.from === 'none'
      ? 'No OpenRouter catalog on this computer yet: timmy models --refresh fetches its public list (no key, no model call).'
      : load.cache === 'fetched'
        ? `OpenRouter's public catalog as this computer fetched it on ${day(load.fetchedAt)} (timmy models --refresh fetches it again); not a live quote`
        : `OpenRouter's public catalog of ${day(load.fetchedAt)}, the snapshot shipped with Timmy (timmy models --refresh fetches a newer one); not a live quote`;
    return { ...load, words };
  }
  return { ...load, words: load.error ? `${load.error}.` : 'Ollama Cloud\'s list.' };
}

/** A page's query as a CatalogQuery; anything it does not know is left out (never an error). */
export function catalogQueryOf(q: Record<string, unknown>): CatalogQuery {
  const one = (v: unknown): string | undefined => (typeof v === 'string' ? v.trim().slice(0, 120) : undefined);
  const source = SOURCES.find((x) => x === one(q.source)) ?? 'openrouter';
  const sort = SORTS.find((x) => x === one(q.sort)) ?? 'recent';
  const capability = CAPS.find((c) => c === one(q.capability));
  const cost = one(q.cost) === 'free' ? 'free' as const : one(q.cost) === 'paid' ? 'paid' as const : undefined;
  const ctx = Number(one(q.context));
  return {
    source, sort,
    ...(one(q.search) ? { search: one(q.search) } : {}),
    ...(one(q.maker) ? { maker: one(q.maker) } : {}),
    ...(capability ? { capability } : {}),
    ...(cost ? { cost } : {}),
    ...(Number.isInteger(ctx) && ctx > 0 && ctx <= 100_000_000 ? { minContext: ctx } : {}),
  };
}

/** Where each next step happens, for the states whose own step (sign in, paste a key, check, download) this page cannot take. */
const PAGE_NEXT: Readonly<Record<string, string>> = Object.freeze({
  'openrouter:not set up': 'In a terminal: timmy init --openrouter - keeps a key (it reads it from the keyboard); signing in from this page is not in this revision.',
  'openrouter:saved, not checked': 'In a terminal: timmy workspace check asks OpenRouter\'s key endpoint once (a free request; no model is run); this page then shows what answered.',
  'openrouter:refused': 'In a terminal: timmy init --openrouter - keeps a new key.',
  'openrouter:unreachable': 'In a terminal: timmy workspace check asks again when the network is back.',
  'ollama-cloud:not set up': 'Its key is read from OLLAMA_API_KEY or the Timmy home\'s providers.json; this page keeps no key and asks nothing.',
  'ollama-cloud:saved, not checked': 'In a terminal: timmy workspace check asks Ollama Cloud\'s model list once with the key (no model is run).',
  'ollama-cloud:refused': 'A new key from ollama.com/settings/keys, kept in OLLAMA_API_KEY or the Timmy home\'s providers.json; this page keeps no key.',
  'ollama-cloud:unreachable': 'In a terminal: timmy workspace check asks again when the network is back.',
  'ollama-local:installed, not checked': 'Refresh, in its setup, asks it for its list of models (no model runs, no charge).',
});

/**
 * Each provider's state as this computer holds it (H170's providerStates: files and the PATH, nothing asked), as this page
 * shows it: the local Ollama's rests on the answer this page's read just had (an observed answer, with its time), and a next
 * step this page cannot take says where it happens. A key never enters them (H170's words name its fingerprint and place).
 * `o` (tests): the platform and the file check H170's Ollama install reading uses.
 */
export function companionProviders(env: Env, cwd: string, local?: LocalAnswer, o: { platform?: NodeJS.Platform; exists?: (p: string) => boolean } = {}): ProviderState[] {
  const states = providerStates({ env, cwd, ...(o.platform ? { platform: o.platform } : {}), ...(o.exists ? { exists: o.exists } : {}) });
  return states.map((st): ProviderState => {
    if (st.id === 'ollama-local' && local) return { ...localState(env, local, o), ...(st.links ? { links: st.links } : {}) };
    const next = PAGE_NEXT[`${st.id}:${st.state}`];
    if (next) return { ...st, next };
    // the local Ollama's own steps (start it, install it) are the person's, outside Timmy, and stay as H170 says them
    if (st.id === 'ollama-local' && st.state === 'checked' && st.next) return { ...st, next: `Install a model yourself (ollama pull ${starter().model}, ${starter().size}); this page downloads nothing.` };
    return st;
  });
}

const starter = (): { model: string; size: string } => STARTER_MODELS.find((m) => m.default) ?? STARTER_MODELS[0];

/** The local Ollama's state from this page's read: answered (checked, with how many models), or not (installed or not). */
function localState(env: Env, local: LocalAnswer, o: { platform?: NodeJS.Platform; exists?: (p: string) => boolean }): ProviderState {
  const host = (() => { try { return ollamaAddress(env).replace(/^https?:\/\//, '').replace(/\/+$/, ''); } catch { return '127.0.0.1:11434'; } })();
  if (local.answered) {
    const listed = local.listed ?? local.models;
    return { id: 'ollama-local', state: 'checked', at: local.at, models: local.models,
      words: listed > local.models
        ? `Ollama answered its list of models at ${host}: it lists ${listed}, ${local.models} of them ${local.models === 1 ? 'a local chat model' : 'local chat models'} (no model ran, no charge).`
        : `Ollama answered its list of models at ${host}: ${local.models} installed here (no model ran, no charge).`,
      ...(local.left ? { lines: [`Not shown as local chat models: ${local.left}.`] } : {}),
      ...(local.models === 0 ? { next: `Install a model yourself (ollama pull ${starter().model}, ${starter().size}); this page downloads nothing.` } : {}) };
  }
  const inst = ollamaInstalled({ env, ...(o.platform ? { platform: o.platform } : {}), ...(o.exists ? { exists: o.exists } : {}) });
  const steps = installSteps(o.platform ?? process.platform);
  const why = local.error ? ` (${local.error})` : '';
  return inst.installed
    ? { id: 'ollama-local', state: 'installed, stopped', at: local.at, models: 0, words: `Ollama is ${inst.words}; it did not answer its list of models at ${host} just now${why}.`, next: `Start it (${steps.start}), then Refresh in its setup.` }
    : { id: 'ollama-local', state: 'not installed', at: local.at, models: 0, words: `Ollama is ${inst.words}, and nothing answered at ${host} just now${why}.`, next: `Install it yourself (${steps.install}), then start it (${steps.start}); Timmy installs nothing.` };
}

/**
 * The official pages this page's setup steps name (the handoff's PROVIDER_SETUP_GUIDE, checked on 2026-10-22; each provider's
 * state also carries H170's own links). The page shows them as links and loads none of them.
 */
export const SETUP_LINKS: Readonly<Record<ProviderState['id'], ReadonlyArray<{ label: string; url: string }>>> = Object.freeze({
  'openrouter': [{ label: 'openrouter.ai/keys', url: 'https://openrouter.ai/keys' }, { label: 'OpenRouter’s sign-in for apps (PKCE)', url: 'https://openrouter.ai/docs/guides/overview/auth/oauth' }],
  'ollama-local': [{ label: 'docs.ollama.com/quickstart', url: 'https://docs.ollama.com/quickstart' }, { label: 'ollama.com/library/qwen3:0.6b', url: 'https://ollama.com/library/qwen3:0.6b' }],
  'ollama-cloud': [{ label: 'ollama.com/settings/keys', url: 'https://ollama.com/settings/keys' }, { label: 'ollama.com/pricing', url: 'https://ollama.com/pricing' }],
  'cloudflare': [{ label: 'developers.cloudflare.com/ai-gateway', url: 'https://developers.cloudflare.com/ai-gateway/get-started/' }],
});

// ── the page's model: chosen or not, and how ready (R11 step 1; the operator's order: explicit model selection on every surface) ──

/**
 * What the next turn of this page would ask, whether anyone CHOSE it, and how ready it is as this page observed it. The route
 * is H169's pageRoute (src/companion/chat-route.ts, Phase 0 item 2): on OpenRouter it names the model chosen in the settings
 * (src/utils/model-choice.ts chosenModel, the same choice the Workbench's Models makes), or it is none with reason
 * 'no-model-chosen' (a key, and no model chosen: Send is off, "No model chosen: choose one in Models"); on the local route the
 * setup's model (or TIMMY_CHAT_MODEL) is the choice. This page adds its own observation: for a local model, its read of
 * Ollama's /api/tags + /api/show; for OpenRouter, the key's state (H170's providerStates: checked, saved not checked, refused).
 */
export interface PageChoice {
  chosen: boolean;
  source?: 'ollama-local' | 'openrouter';
  model?: string;
  /** where the choice is recorded, in words (never a path) */
  from?: string;
  /**
   * how ready the chosen model is, as this page observed it: `ready` only after an answer (Ollama's /api/show for this model
   * at this page's read, or OpenRouter's key check); `unknown` when nothing has answered yet (a key saved, not checked);
   * `failed` with why (the model is not listed, Ollama did not answer, no key, a policy refusal)
   */
  check: { state: 'ready' | 'unknown' | 'failed'; at?: string; words: string };
  /** the one line beside Send */
  words: string;
}

const NO_MODEL_WORDS = 'No model chosen: choose one in Models.';

/**
 * The page's choice beside its route: `local` is this page's read of Ollama's list (its rows passed /api/show), `states`
 * H170's state of the key. The route is returned as pageRoute gave it (nothing of the page's own is read into it).
 */
export function pageChoice(env: Env, route: PageRoute, local: { rows: CatalogRow[]; observed?: LocalAnswer }, states: ProviderState[]): { choice: PageChoice; route: PageRoute } {
  if (route.kind === 'local') {
    const host = (() => { try { return ollamaAddress(env).replace(/^https?:\/\//, '').replace(/\/+$/, ''); } catch { return '127.0.0.1:11434'; } })();
    const listed = local.rows.find((r) => r.id === route.model);
    const o = local.observed;
    const check: PageChoice['check'] = !o ? { state: 'unknown', words: 'Ollama not asked yet from this page.' }
      : !o.answered ? { state: 'failed', at: o.at, words: `Ollama did not answer at ${host}${o.error ? ` (${o.error})` : ''}.` }
        : listed ? { state: 'ready', at: o.at, words: `Ollama answered at ${host}: ${route.model} is listed as a local chat model (its /api/show check passed; no model ran).` }
          : { state: 'failed', at: o.at, words: `Ollama answered at ${host}, but does not list ${route.model} as a local chat model${o.left ? ` (${o.left})` : ''}.` };
    return { route, choice: { chosen: true, source: 'ollama-local', model: route.model, from: route.words.includes('TIMMY_CHAT_MODEL') ? 'TIMMY_CHAT_MODEL' : 'the setup', check, words: `Next turn: ${route.model} on this computer.` } };
  }
  if (route.kind === 'none') {
    // no model chosen (H169's reason on the OpenRouter route; the local route's own label says it): Send is off with the words
    const noModel = route.reason === 'no-model-chosen' || /no model chosen/i.test(route.label);
    return { route, choice: { chosen: false, check: { state: 'failed', words: route.words }, words: noModel ? NO_MODEL_WORDS : route.words } };
  }
  // the chosen OpenRouter model, as the route names it; the key's state is this page's readiness (saved is not checked)
  const key = states.find((p) => p.id === 'openrouter');
  const keyCheck: PageChoice['check'] = !key || key.state === 'not set up' ? { state: 'failed', words: 'No OpenRouter key is set up.' }
    : key.state === 'checked' ? { state: 'ready', ...(key.at ? { at: key.at } : {}), words: key.words }
      : key.state === 'refused' || key.state === 'unreachable' ? { state: 'failed', ...(key.at ? { at: key.at } : {}), words: key.words }
        : { state: 'unknown', words: `${key.words}${key.next ? ` ${key.next}` : ''}` };
  const price = modelPrice(route.model);
  const from = env.OPENROUTER_MODEL?.trim() === route.model ? 'OPENROUTER_MODEL in this companion\'s environment' : 'the settings (the model chosen in Models, /model or timmy init --chat openrouter --model)';
  return { route, choice: { chosen: true, source: 'openrouter', model: route.model, from, check: keyCheck, words: `Next turn: ${route.model} on OpenRouter (${price.free === true ? 'free' : price.free === false ? `paid: ${price.words}` : 'price unknown'}).` } };
}

/** What a choice wrote, as names under the Timmy home or the project (never a path of this computer). */
function writtenWords(files: readonly string[], env: Env, root: string): string[] {
  const home = env.TIMMY_HOME?.trim();
  return files.map((f) => (home && f.startsWith(home) ? `<Timmy home>${f.slice(home.length)}` : f.startsWith(root) ? `<project>${f.slice(root.length)}` : f.split('/').pop() ?? f));
}

/** The settings' writer (src/utils/config.ts saveConfig: the process's own store), imported when a choice is made. */
type ChooseResult = { ok: true; state: 'ready'; source: 'ollama-local' | 'openrouter'; model: string; at: string; words: string; written: string[] }
  | { ok: false; state: 'not a chat model' | 'not installed' | 'unreachable' | 'not listed' | 'refused' | 'not kept'; model: string; words: string };

/**
 * A model chosen on this page for the next turn, written through the same paths the terminal Workbench writes (never a setting
 * of the page's own): a local model is first asked of Ollama's /api/show by its exact /api/tags name (no model runs), then kept as
 * the setup's answer (src/utils/init.ts applySetup, as timmy init --chat local --model writes it; on a home with no identity it
 * makes one, as timmy init would); an OpenRouter model must be a row of the catalog this computer keeps and pass the route policy,
 * needs a key, and is kept in the settings (saveConfig) and as Models' record (workbench.json openRouterModel). Every failure
 * says what it is and that nothing was changed.
 */
export async function chooseModel(env: Env, root: string, body: unknown): Promise<ChooseResult> {
  const b = body && typeof body === 'object' ? body as { source?: unknown; model?: unknown } : {};
  const model = typeof b.model === 'string' ? b.model.trim() : '';
  const source = b.source === 'ollama-local' || b.source === 'openrouter' ? b.source : null;
  if (!source || !model || model.length > 512) return { ok: false, state: 'not kept', model, words: 'Not chosen: the request names no model ({ source: "ollama-local" | "openrouter", model: <its id> }). Nothing was changed.' };
  if (source === 'ollama-local') {
    // H170's one readiness check, shared with the terminal (src/setup/local-model-check.ts): one /api/show by the exact name,
    // no model run, loopback only; its states and words are the terminal's ("Not chosen: …" on its status row)
    const check = await checkLocalModel(model, { env, timeoutMs: 4000 });
    if (check.state !== 'ready') {
      const state = check.state === 'not-a-chat-model' ? 'not a chat model' : check.state === 'not-installed' ? 'not installed' : 'unreachable';
      return { ok: false, state, model, words: `Not chosen: ${check.words} Nothing was changed.` };
    }
    const { applySetup } = await import('../utils/init.js');
    try {
      const s = readSetupState(env, root);
      // (the Ollama address the chat asks stays what it is: applySetup would record the default on a home with no providers.json)
      const ollama = s.providers.ollama ?? s.recorded?.answers.ollama;
      const r = applySetup({ chat: 'local', model, ...(ollama ? { ollama } : {}) }, { by: 'timmy watch (the companion page)', repoRoot: root, state: s });
      return { ok: true, state: 'ready', source, model, at: new Date().toISOString(), words: `Next turn: ${model} on this computer.`, written: writtenWords(r.written, env, root) };
    } catch (e) { return { ok: false, state: 'not kept', model, words: `${model} is not chosen: nothing was written (${e instanceof Error ? e.message : String(e)}).` }; }
  }
  // (as the Workbench: an OpenRouter model needs the OpenRouter route; the setup's local answer stands until the terminal changes it)
  const now = pageRoute(env, root);
  if (now.kind === 'local' || (now.kind === 'none' && now.chat === 'local')) return { ok: false, state: 'refused', model, words: `${model} runs on OpenRouter, and the chat's route is local (the setup's answer): timmy init --chat openrouter, in a terminal, makes OpenRouter the route. Nothing was changed.` };
  const load = await loadCatalog('openrouter', { env, refresh: 'never' });
  const row = load.rows.find((r) => r.id === model);
  if (!row) return { ok: false, state: 'not listed', model, words: `${model} is not chosen: it is not in OpenRouter's catalog as this computer keeps it. Nothing was changed.` };
  const policy = permits(row, routePolicyNow(env));
  if (!policy.ok) return { ok: false, state: 'refused', model, words: `${model} is not chosen: ${policyRefusalLines(policy).map((l) => l.trim()).filter(Boolean).join(' ')} Nothing was changed.` };
  if (!providerStates({ env, cwd: root }).some((p) => p.id === 'openrouter' && p.state !== 'not set up')) return { ok: false, state: 'refused', model, words: `${model} runs on OpenRouter: connect OpenRouter first (its key, in the terminal). Nothing was changed.` };
  try {
    const { saveConfig, getConfig } = await import('../utils/config.js');
    saveConfig({ model });
    const written = [getConfig().path];
    const rec = saveSettings({ ...readSettings(env).settings, openRouterModel: model }, env);
    if (rec.ok) written.push(rec.path);
    const said = written.map((w) => `<settings>/${w.split('/').pop() ?? w}`);
    return { ok: true, state: 'ready', source, model, at: new Date().toISOString(), words: `Next turn: ${model} on OpenRouter (${row.price.free === true ? 'free' : row.price.free === false ? `paid: ${modelPrice(model).words}` : 'price unknown'}).`, written: said };
  } catch (e) { return { ok: false, state: 'not kept', model, words: `${model} is not chosen: nothing was written (${e instanceof Error ? e.message : String(e)}).` }; }
}

// ── the project's saved conversation ──

export interface ConvTurn {
  kind: 'you' | 'timmy' | 'tool';
  text: string;
  /** the message's text was longer than TEXT_MAX and is cut */
  cut?: true;
  /** ISO time the conversation kept */
  at?: string;
  /** a tool message's tool */
  tool?: string;
  /**
   * the model that answered, as the turn's sealed receipt says (its model_resolved, else model_requested); null when no
   * receipt of this project matches the answer
   */
  model?: string | null;
  /** the receipt that sealed the turn: its id (the hash's first 8), how it ended, the surface that sent it */
  receipt?: { id: string; status: string; surface: string };
  /**
   * R10 (H171; H168's pass 3b R19): a turn stopped before its answer ended. The conversation keeps Timmy's record of the stop
   * (src/agent/core.ts cancelRecord) where its answer would be: `text` is the answer written before the stop (none: ''), and
   * `record` the whole record, said apart (never as Timmy's words); `by` the surface that asked for the stop, when another did
   */
  stopped?: { record: string; by?: string };
}
export interface SavedConversation { session: string | null; total: number; turns: ConvTurn[]; error?: string }

const chainOf = (root: string, env: Env): readonly Receipt[] => { try { return env.TIMMY_STORE ? readChain('runs') : readChain('runs', root); } catch { return []; } };

/** Timmy's record of a stopped turn, as src/agent/core.ts cancelRecord writes it into the conversation. */
const STOP_RECORD = /^\[Cancelled by the user before I (?:finished answering|answered)\./;
const WRITTEN = 'What I had written so far: ';

/** A stop record's answer written before the stop (its JSON-quoted part), '' when none was written or it cannot be read. */
export function stoppedAnswerOf(record: string): string {
  const at = record.indexOf(WRITTEN);
  if (at < 0 || record[at + WRITTEN.length] !== '"') return '';
  const from = at + WRITTEN.length;
  for (let i = from + 1, esc = false; i < record.length; i += 1) {
    const c = record[i];
    if (esc) { esc = false; continue; }
    if (c === '\\') { esc = true; continue; }
    if (c === '"') { try { const v: unknown = JSON.parse(record.slice(from, i + 1)); return typeof v === 'string' ? v : ''; } catch { return ''; } }
  }
  return '';
}

/**
 * The newest conversation the project keeps (.sessions), its newest TURNS_MAX messages: the person's, Timmy's and each tool's
 * result; each answer with the model its sealed receipt names (the receipt whose response_hash is the answer's sha256).
 * Reads only.
 */
export function savedConversation(root: string, env: Env = process.env): SavedConversation {
  let session: string | null = null;
  try {
    const conv = new ConversationManager(join(root, '.sessions'));
    const sessions = conv.listSessions();
    if (!sessions.length) return { session: null, total: 0, turns: [] };
    session = sessions[0];
    const all = conv.load(session);
    // each turn's receipt: by its answer's hash (response_hash); else, as the page's turn list knows a turn, by the person's
    // message it answers (prompt_hash), the first such receipt sealed after that message and not already another answer's:
    // a stopped turn's answer in the conversation is Timmy's record of the stop, not the text its receipt hashed
    type TurnReceipt = Receipt & { response_hash?: unknown; prompt_hash?: unknown; model_resolved?: unknown; model_requested?: unknown; status?: unknown; stopped_by?: unknown; ts?: unknown };
    const byAnswer = new Map<string, TurnReceipt>();
    const byPrompt = new Map<string, TurnReceipt[]>();
    for (const r of chainOf(root, env) as readonly TurnReceipt[]) {
      if (!chatTurnOf(r)) continue;
      if (typeof r.response_hash === 'string') byAnswer.set(r.response_hash, r);
      if (typeof r.prompt_hash === 'string') byPrompt.set(r.prompt_hash, [...(byPrompt.get(r.prompt_hash) ?? []), r]);
    }
    const used = new Set<string>();
    let asked: { hash: string; at: number | null } | null = null;
    const msgs = all.filter((m) => m.role === 'user' || m.role === 'assistant' || m.role === 'tool');
    const turnsAll: ConvTurn[] = msgs.map((m) => {
      const full = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
      const at = typeof m.timestamp === 'number' && Number.isFinite(m.timestamp) ? new Date(m.timestamp).toISOString() : undefined;
      const said = (t: string): Pick<ConvTurn, 'text' | 'cut' | 'at'> => ({ text: t.length > TEXT_MAX ? t.slice(0, TEXT_MAX) : t, ...(t.length > TEXT_MAX ? { cut: true as const } : {}), ...(at ? { at } : {}) });
      if (m.role === 'user') { asked = { hash: sha256(full), at: typeof m.timestamp === 'number' ? m.timestamp : null }; return { kind: 'you', ...said(full) }; }
      if (m.role === 'tool') return { kind: 'tool', ...said(full), ...(m.name ? { tool: m.name } : {}) };
      let rr = byAnswer.get(sha256(full));
      if (rr && used.has(String(rr.hash))) rr = undefined;
      const q = asked as { hash: string; at: number | null } | null;
      if (!rr && q) {
        // (a receipt is sealed when its turn ends, after the person's message; 5 s of clock between surfaces allowed)
        rr = (byPrompt.get(q.hash) ?? []).find((c) => !used.has(String(c.hash)) && (q.at === null || !(Date.parse(String(c.ts)) < q.at - 5000)));
      }
      if (rr) used.add(String(rr.hash));
      const model = rr ? [rr.model_resolved, rr.model_requested].find((x): x is string => typeof x === 'string' && x.trim() !== '') ?? null : null;
      const stop = STOP_RECORD.test(full);
      return {
        kind: 'timmy', ...said(stop ? stoppedAnswerOf(full) : full), model,
        ...(rr ? { receipt: { id: String(rr.hash).slice(7, 15), status: typeof rr.status === 'string' ? rr.status : 'ok', surface: chatTurnOf(rr)?.surface ?? 'unknown' } } : {}),
        ...(stop ? { stopped: { record: full.length > TEXT_MAX ? full.slice(0, TEXT_MAX) : full, ...(rr && typeof rr.stopped_by === 'string' ? { by: rr.stopped_by } : {}) } } : {}),
      };
    });
    return { session, total: all.length, turns: turnsAll.slice(-TURNS_MAX) };
  } catch (e) {
    return { session, total: 0, turns: [], error: e instanceof Error ? e.message : String(e) };
  }
}

// ── the routes ──

export interface ChatViewContext {
  withToken: express.RequestHandler;
  /** the JSON body reader for the choose route (express.json with a small limit) */
  json: express.RequestHandler;
  projectFor: (req: express.Request) => ActiveProject | null;
  projectUnknown: string;
  /** the environment the page's chat route and key are read from (src/companion/server.ts chatEnv) */
  chatEnv: () => Env;
  /** the environment the project's records are read with (a test's TIMMY_HOME), else this process's */
  env: Env;
}

const FAILED = 'The companion could not read what the Chat needs, so it answers with nothing. It is still running.';

export function mountChatView(app: express.Application, ctx: ChatViewContext): void {
  const answer = (res: express.Response, body: unknown, status = 200): void => {
    res.status(status).set('Cache-Control', 'no-store').json(scrubStrings(body, (t) => scrubHomes(t)));
  };
  app.get(CHAT_VIEW_ROUTES.view, ctx.withToken, async (req, res) => {
    const project = ctx.projectFor(req);
    if (!project) { answer(res, { ok: false, error: ctx.projectUnknown }, 404); return; }
    try {
      const env = ctx.chatEnv();
      const local = await companionCatalog('ollama-local', env, { fresh: req.query.fresh === '1' });
      const providers = companionProviders(env, process.cwd(), local.observed);
      const { route, choice } = pageChoice(env, pageRoute(env, process.cwd()), local, providers);
      answer(res, {
        ok: true,
        at: new Date().toISOString(),
        project: { name: project.name },
        conversation: savedConversation(project.root, ctx.env),
        route,
        choice,
        scope: PAGE_SCOPE,
        policy: { ...routePolicyNow(env), from: policyFrom(env) },
        providers,
        links: SETUP_LINKS,
        logs: { words: 'Logs and receipts stay on this computer: the project\'s .timmy folder and its conversation in .sessions.', cloud: 'Cloud copies: off (not set up).' },
      });
    } catch { answer(res, { ok: false, error: FAILED }, 500); }
  });
  app.get(CHAT_VIEW_ROUTES.models, ctx.withToken, async (req, res) => {
    const project = ctx.projectFor(req);
    if (!project) { answer(res, { ok: false, error: ctx.projectUnknown }, 404); return; }
    try {
      const q = catalogQueryOf(req.query as Record<string, unknown>);
      const read = await companionCatalog(q.source, ctx.chatEnv(), { fresh: req.query.fresh === '1' });
      // queryCatalog's total is the source's rows before the search and the filters; matched, the rows they keep
      const out = queryCatalog(read.rows, q);
      answer(res, {
        ok: true, query: q, from: read.from, ...(read.fetchedAt ? { fetchedAt: read.fetchedAt } : {}), ...(read.cache ? { cache: read.cache } : {}), ...(read.error ? { error: read.error } : {}),
        words: read.words, matched: out.rows.length, all: out.total, makers: out.makers, rows: out.rows.slice(0, MODELS_MAX),
        // (the local Ollama: how many it lists, and why those that are not rows are not)
        ...(read.listed !== undefined ? { listed: read.listed } : {}), ...(read.left ? { left: read.left } : {}),
      });
    } catch { answer(res, { ok: false, error: FAILED }, 500); }
  });
  // R11 step 1: a model chosen on the page for the next turn (the Workbench's own write paths; see chooseModel)
  app.post(CHAT_VIEW_ROUTES.choose, ctx.withToken, ctx.json, async (req, res) => {
    const project = ctx.projectFor(req);
    if (!project) { answer(res, { ok: false, error: ctx.projectUnknown }, 404); return; }
    try {
      const r = await chooseModel(ctx.chatEnv(), project.root, req.body);
      // the local Ollama's memo is stale once a choice was made: the next view read asks again
      if (r.ok) localKept = null;
      answer(res, r, r.ok ? 200 : 409);
    } catch { answer(res, { ok: false, state: 'not kept', words: FAILED }, 500); }
  });
}
