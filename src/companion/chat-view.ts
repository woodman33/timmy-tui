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
 * rail shows what this computer keeps, and asks no one for a catalog. Each provider's state is read behind this file's own
 * function in H170's shape (companionProviders, ProviderState) until src/setup/providers-state.ts is switched in.
 */
import type express from 'express';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { ConversationManager } from '../agent/conversation.js';
import { freeOnlyOn } from '../agent/model-price.js';
import { loadCatalog, queryCatalog, type CatalogLoad, type CatalogQuery, type CatalogRow, type ModelSource } from '../models/catalog.js';
import type { ActiveProject } from '../project/index.js';
import { chatTurnOf } from '../repl/seal.js';
import { scrubHomes, scrubStrings } from '../utils/home-scrub.js';
import { modelKeySource } from '../utils/model-key.js';
import { readChain, type Receipt } from '../utils/receipts.js';
import { PAGE_SCOPE, pageRoute } from './chat-route.js';

type Env = Record<string, string | undefined>;

export const CHAT_VIEW_ROUTES = { view: '/api/chat/view', models: '/api/chat/models' } as const;
/** The most rows one models answer carries (the rail lists them; search and the filters find the rest). */
export const MODELS_MAX = 80;
/** The most messages of the saved conversation one view answer carries (its newest). */
export const TURNS_MAX = 120;
/** The most characters of one message the page is given (a longer one is cut, and says so). */
export const TEXT_MAX = 16_000;

export type { CatalogQuery, CatalogRow, ModelSource };

// ── H170's ProviderState (src/setup/providers-state.ts; switched at the merge) ──

export interface ProviderState {
  id: 'openrouter' | 'ollama-local' | 'ollama-cloud' | 'cloudflare';
  state: 'not set up' | 'pending' | 'saved, not checked' | 'checked' | 'refused' | 'unreachable' | 'not installed' | 'installed, stopped';
  /** when observed */
  at?: string;
  words: string;
  next?: string;
}

const SOURCES: readonly ModelSource[] = ['openrouter', 'ollama-local', 'ollama-cloud'];
const SORTS: ReadonlyArray<CatalogQuery['sort']> = ['recent', 'name', 'price', 'context'];
const CAPS: ReadonlyArray<NonNullable<CatalogQuery['capability']>> = ['tools', 'vision', 'reasoning'];

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');
const day = (iso?: string): string => (iso ? iso.slice(0, 10) : 'an unknown date');

/** A source's rows as this computer keeps them (H169's loadCatalog, refresh never: nothing is asked for a catalog), in words. */
export interface CatalogRead extends CatalogLoad { words: string; observed?: ProviderState }

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
    const read: CatalogRead = load.from === 'live'
      ? { ...load, words: `Ollama on this computer answered its list of models: ${n} installed here. No model ran.`, observed: { id: 'ollama-local', state: 'checked', at, words: `${n} installed on this computer (its list of models; no model ran).` } }
      : { ...load, words: `Ollama on this computer did not answer: ${load.error ?? 'no answer'}.`, observed: { id: 'ollama-local', state: 'unreachable', at, words: `Ollama on this computer did not answer its list of models (${load.error ?? 'no answer'}).`, next: 'Start Ollama (the app, or ollama serve), then Refresh.' } };
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

/**
 * Each provider's state as this computer holds it, without asking anything (the stand-in for H170's providerStates): a saved
 * key is "saved, not checked" (Timmy has not asked the provider whether it takes it); Cloudflare is never asked from here.
 * The local Ollama's state is the one the catalog read just observed, when one did.
 */
export function companionProviders(env: Env, cwd: string, observed?: ProviderState): ProviderState[] {
  const key = modelKeySource(env, cwd);
  const keyAt = key === 'environment' ? 'in this companion\'s environment' : key === 'providers.json' ? 'in the Timmy home (providers.json)' : key ? `in ${key}` : '';
  const ollamaKey = Boolean(str(env.OLLAMA_API_KEY));
  const cf = Boolean(str(env.CLOUDFLARE_ACCOUNT_ID) || str(env.CF_ACCOUNT_ID));
  return [
    key
      ? { id: 'openrouter', state: 'saved, not checked', words: `A key is saved ${keyAt}; Timmy has not asked OpenRouter whether it takes it.`, next: 'In the REPL: /setup key checks it (a free request; no model call, no charge).' }
      : { id: 'openrouter', state: 'not set up', words: 'No OpenRouter key on this computer.', next: 'timmy init --openrouter - keeps a key (sign-in from this page is not in this revision).' },
    observed ?? { id: 'ollama-local', state: 'saved, not checked', words: 'Not asked yet from this page.' },
    ollamaKey
      ? { id: 'ollama-cloud', state: 'saved, not checked', words: 'An Ollama key is set in this companion\'s environment; Timmy has not asked Ollama\'s cloud whether it takes it.' }
      : { id: 'ollama-cloud', state: 'not set up', words: 'No Ollama Cloud key on this computer. Local weights are not needed for it.', next: 'Its sign-in and key are set up in the terminal (not in this revision of this page).' },
    cf
      ? { id: 'cloudflare', state: 'saved, not checked', words: 'A Cloudflare account is named in this companion\'s environment. Timmy never checks it from here: a request can create a gateway and bill.' }
      : { id: 'cloudflare', state: 'not set up', words: 'Optional. Not set up: chat and logs work without it. Timmy never checks it from here: a request can create a gateway and bill.' },
  ];
}

/**
 * The official pages each provider's setup links to (the handoff's PROVIDER_SETUP_GUIDE, checked on 2026-10-22; H170's
 * ProviderState.links replaces these at the merge). The page shows them as links and loads none of them.
 */
export const SETUP_LINKS: Readonly<Record<ProviderState['id'], ReadonlyArray<{ label: string; url: string }>>> = Object.freeze({
  'openrouter': [{ label: 'openrouter.ai/keys', url: 'https://openrouter.ai/keys' }, { label: 'OpenRouter’s sign-in for apps (PKCE)', url: 'https://openrouter.ai/docs/guides/overview/auth/oauth' }],
  'ollama-local': [{ label: 'docs.ollama.com/quickstart', url: 'https://docs.ollama.com/quickstart' }, { label: 'ollama.com/library/qwen3:0.6b', url: 'https://ollama.com/library/qwen3:0.6b' }],
  'ollama-cloud': [{ label: 'ollama.com/settings/keys', url: 'https://ollama.com/settings/keys' }, { label: 'ollama.com/pricing', url: 'https://ollama.com/pricing' }],
  'cloudflare': [{ label: 'developers.cloudflare.com/ai-gateway', url: 'https://developers.cloudflare.com/ai-gateway/get-started/' }],
});

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
}
export interface SavedConversation { session: string | null; total: number; turns: ConvTurn[]; error?: string }

const chainOf = (root: string, env: Env): readonly Receipt[] => { try { return env.TIMMY_STORE ? readChain('runs') : readChain('runs', root); } catch { return []; } };

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
    const byAnswer = new Map<string, Receipt>();
    for (const r of chainOf(root, env)) {
      if (!chatTurnOf(r)) continue;
      const h = (r as Receipt & { response_hash?: unknown }).response_hash;
      if (typeof h === 'string') byAnswer.set(h, r);
    }
    const shown = all.filter((m) => m.role === 'user' || m.role === 'assistant' || m.role === 'tool').slice(-TURNS_MAX);
    const turns: ConvTurn[] = shown.map((m) => {
      const full = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
      const text = full.length > TEXT_MAX ? full.slice(0, TEXT_MAX) : full;
      const at = typeof m.timestamp === 'number' && Number.isFinite(m.timestamp) ? new Date(m.timestamp).toISOString() : undefined;
      const base = { text, ...(full.length > TEXT_MAX ? { cut: true as const } : {}), ...(at ? { at } : {}) };
      if (m.role === 'user') return { kind: 'you', ...base };
      if (m.role === 'tool') return { kind: 'tool', ...base, ...(m.name ? { tool: m.name } : {}) };
      const r = byAnswer.get(sha256(full));
      const rr = r as (Receipt & { model_resolved?: unknown; model_requested?: unknown; status?: unknown }) | undefined;
      const model = rr ? [rr.model_resolved, rr.model_requested].find((x): x is string => typeof x === 'string' && x.trim() !== '') ?? null : null;
      return {
        kind: 'timmy', ...base, model,
        ...(rr ? { receipt: { id: String(rr.hash).slice(7, 15), status: typeof rr.status === 'string' ? rr.status : 'ok', surface: chatTurnOf(rr)?.surface ?? 'unknown' } } : {}),
      };
    });
    return { session, total: all.length, turns };
  } catch (e) {
    return { session, total: 0, turns: [], error: e instanceof Error ? e.message : String(e) };
  }
}

// ── the routes ──

export interface ChatViewContext {
  withToken: express.RequestHandler;
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
      const route = pageRoute(env, process.cwd());
      answer(res, {
        ok: true,
        at: new Date().toISOString(),
        project: { name: project.name },
        conversation: savedConversation(project.root, ctx.env),
        route,
        scope: PAGE_SCOPE,
        policy: { freeOnly: freeOnlyOn(env), localOnly: null, localOnlyWords: 'Local-only is not in this revision (it comes with the route policy).' },
        providers: companionProviders(env, process.cwd(), local.observed),
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
      });
    } catch { answer(res, { ok: false, error: FAILED }, 500); }
  });
}
