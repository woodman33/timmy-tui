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
 *                                                 the total, the makers and where the rows came from
 *
 * Each needs the companion's token (refused, 401, before anything is read). Nothing here writes, sends a prompt or spends.
 * The one request it makes is the local Ollama's list of models (GET /api/tags on this computer's loopback, the address the
 * setup recorded): it runs no model and costs nothing. OpenRouter's catalog is the one this computer already has (the one
 * `timmy models --refresh` fetched into the Timmy home, else the snapshot shipped with Timmy), named with its date; nothing
 * asks OpenRouter from here. Ollama Cloud and Cloudflare are never asked from here (a Cloudflare request can create a
 * gateway and bill): their state is what this computer holds, and says so.
 *
 * The shared contract of the slice (the lead's CHAT-COMMON brief): H169's src/models/catalog.ts (CatalogRow, CatalogQuery,
 * queryCatalog, loadCatalog) and H170's src/setup/providers-state.ts (ProviderState, providerStates). Until they land, the
 * data that exists is read behind this file's own functions in the contract's shapes (companionCatalog, queryRows,
 * companionProviders), so the lead can switch each at the merge.
 */
import type express from 'express';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConversationManager } from '../agent/conversation.js';
import { freeOnlyOn } from '../agent/model-price.js';
import { cachePath, catalogPath } from '../models/registry.js';
import type { ActiveProject } from '../project/index.js';
import { chatTurnOf } from '../repl/seal.js';
import { cloudModelTag, listOllamaModels, ollamaAt, sizeWords } from '../setup/ollama-models.js';
import { OLLAMA_DEFAULT, readSetupState } from '../setup/questions.js';
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

// ── the shared contract's shapes (H169's src/models/catalog.ts; the lead switches these at the merge) ──

export type ModelSource = 'openrouter' | 'ollama-local' | 'ollama-cloud';
export interface CatalogRow {
  source: ModelSource;
  id: string;
  name: string;
  maker: string;
  description?: string;
  /** epoch seconds: when OpenRouter ADDED it, not its release */
  created?: number;
  contextLength?: number;
  price: { inPerM?: number; outPerM?: number; free: boolean | 'unknown' };
  /** undefined = unknown */
  caps: { tools?: boolean; vision?: boolean; reasoning?: boolean };
  inputModalities?: string[];
  installed?: boolean;
  running?: boolean;
  sizeBytes?: number;
}
export interface CatalogQuery {
  source: ModelSource;
  search?: string;
  sort: 'recent' | 'name' | 'price' | 'context';
  maker?: string;
  capability?: 'tools' | 'vision' | 'reasoning';
  cost?: 'free' | 'paid';
  minContext?: number;
}
export interface CatalogRead { rows: CatalogRow[]; from: 'live' | 'cache' | 'none'; fetchedAt?: string; error?: string; words: string }

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

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');
/** OpenRouter's per-token price as USD per million tokens; "-1" (a router's variable price) and anything else unreadable: unknown */
const perM = (raw: unknown): number | undefined => {
  if (typeof raw !== 'string' && typeof raw !== 'number') return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 1e6 * 1e6) / 1e6 : undefined;
};

/** The maker of an OpenRouter model: its name's part before ": " ("OpenAI: GPT-6 Astra"), else its id's before "/". */
export function makerOf(id: string, name?: string): string {
  const fromName = name && /^([^:]{1,40}):\s/.exec(name)?.[1]?.trim();
  if (fromName) return fromName;
  const prefix = id.includes('/') ? id.split('/')[0] : '';
  return prefix || 'unknown maker';
}

/** One OpenRouter catalog entry (its public /api/v1/models shape) as a row; null for one that is not a model. */
export function openRouterRow(m: unknown): CatalogRow | null {
  if (!isObject(m)) return null;
  const id = str(m.id);
  if (!id) return null;
  const name = str(m.name) ?? id;
  const pricing = isObject(m.pricing) ? m.pricing : {};
  const inPerM = perM(pricing.prompt);
  const outPerM = perM(pricing.completion);
  const known = inPerM !== undefined && outPerM !== undefined;
  const params = Array.isArray(m.supported_parameters) ? m.supported_parameters.filter((p): p is string => typeof p === 'string') : null;
  const arch = isObject(m.architecture) ? m.architecture : {};
  const inputs = Array.isArray(arch.input_modalities) ? arch.input_modalities.filter((p): p is string => typeof p === 'string') : null;
  const created = typeof m.created === 'number' && Number.isFinite(m.created) && m.created > 0 ? m.created : undefined;
  const ctx = typeof m.context_length === 'number' && m.context_length > 0 ? m.context_length : undefined;
  return {
    source: 'openrouter', id, name, maker: makerOf(id, name),
    ...(str(m.description) ? { description: str(m.description)!.slice(0, 2000) } : {}),
    ...(created ? { created } : {}),
    ...(ctx ? { contextLength: ctx } : {}),
    price: { ...(inPerM !== undefined ? { inPerM } : {}), ...(outPerM !== undefined ? { outPerM } : {}), free: known ? inPerM === 0 && outPerM === 0 : 'unknown' },
    caps: {
      ...(params ? { tools: params.includes('tools'), reasoning: params.includes('reasoning') || params.includes('include_reasoning') } : {}),
      ...(inputs ? { vision: inputs.includes('image') } : {}),
    },
    ...(inputs ? { inputModalities: inputs } : {}),
  };
}

const readJson = (file: string): unknown => { try { return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) as unknown : undefined; } catch { return undefined; } };

/**
 * OpenRouter's catalog as this computer has it: the one `timmy models --refresh` fetched (the Timmy home's
 * models/openrouter-catalog.json), else the snapshot shipped with Timmy, else none. Asks nothing.
 */
export function openRouterCatalog(env: Env = process.env, files: { fetched?: string; shipped?: string } = {}): CatalogRead {
  const tries: Array<[string, 'fetched' | 'shipped']> = [[files.fetched ?? catalogPath(env), 'fetched'], [files.shipped ?? cachePath(), 'shipped']];
  for (const [file, kind] of tries) {
    const j = readJson(file);
    const list = Array.isArray(j) ? j : isObject(j) && Array.isArray(j.models) ? j.models : null;
    if (!list) continue;
    const at = isObject(j) ? str(j.fetchedAt) : undefined;
    const rows = list.map(openRouterRow).filter((r): r is CatalogRow => r !== null);
    const day = at ? at.slice(0, 10) : 'an unknown date';
    return {
      rows, from: 'cache', ...(at ? { fetchedAt: at } : {}),
      words: kind === 'fetched'
        ? `OpenRouter's public catalog as this computer fetched it on ${day} (timmy models --refresh fetches it again); not a live quote`
        : `OpenRouter's public catalog of ${day}, the snapshot shipped with Timmy (timmy models --refresh fetches a newer one); not a live quote`,
    };
  }
  return { rows: [], from: 'none', error: 'no catalog on this computer', words: 'No OpenRouter catalog on this computer yet: timmy models --refresh fetches its public list (no key, no model call).' };
}

/** The Ollama address the setup recorded (providers.json's ollama_host, else the setup's answer, else the default). */
export function recordedOllama(env: Env): string {
  const s = readSetupState(env);
  return s.providers.ollama ?? s.recorded?.answers.ollama ?? OLLAMA_DEFAULT;
}

/**
 * The local Ollama's models (GET /api/tags at the recorded address: no model runs, nothing is spent), each a row of its own
 * source: a cloud-backed tag is Ollama Cloud even when this computer's Ollama serves it (a cloud model served through
 * localhost is cloud). An address that is not this computer's is not asked: the local route is loopback only.
 */
export async function ollamaCatalog(env: Env, o: { timeoutMs?: number; now?: () => Date } = {}): Promise<CatalogRead & { observed?: ProviderState }> {
  const host = recordedOllama(env);
  const at = ollamaAt(host);
  const now = (o.now ?? (() => new Date()))().toISOString();
  if ('error' in at) {
    return { rows: [], from: 'none', error: at.error, words: `The recorded Ollama address is not one Timmy uses (${at.error}).`, observed: { id: 'ollama-local', state: 'refused', words: `Ollama's recorded address is not one Timmy uses: ${at.error}.`, next: 'In the REPL: /setup chat asks again.' } };
  }
  if (!at.loopback) {
    return { rows: [], from: 'none', error: 'not this computer', words: 'The recorded Ollama is another computer\'s: the local route asks only this computer\'s Ollama, so it was not asked.', observed: { id: 'ollama-local', state: 'refused', words: 'The recorded Ollama is another computer\'s; the local route is this computer\'s only.', next: 'In the REPL: /setup chat records this computer\'s Ollama.' } };
  }
  const list = await listOllamaModels(host, { timeoutMs: o.timeoutMs ?? 2000 });
  if (!list.ok) {
    return { rows: [], from: 'none', error: list.why, words: `Ollama on this computer did not answer (${list.why}).`, observed: { id: 'ollama-local', state: 'unreachable', at: now, words: `Ollama on this computer did not answer its list of models (${list.why}).`, next: 'Start Ollama (ollama serve), then Refresh.' } };
  }
  const rows: CatalogRow[] = list.models.map((m) => {
    const cloud = m.cloud || cloudModelTag(m.name);
    const maker = m.name.includes('/') ? m.name.split('/')[0] : m.name.split(':')[0];
    return {
      source: cloud ? 'ollama-cloud' : 'ollama-local', id: m.name, name: m.name, maker,
      description: cloud
        ? 'Listed by Ollama on this computer, served from Ollama\'s cloud: the chat leaves this computer.'
        : `Local weights on this computer${[m.parameterSize, m.quantization].filter(Boolean).length ? ` (${[m.parameterSize, m.quantization].filter(Boolean).join(', ')})` : ''}${m.size !== null ? `, ${sizeWords(m.size)} on disk (not the memory it needs to run)` : ''}.`,
      price: cloud ? { free: 'unknown' } : { inPerM: 0, outPerM: 0, free: true },
      caps: {},
      installed: !cloud,
      ...(m.size !== null ? { sizeBytes: m.size } : {}),
    };
  });
  const local = rows.filter((r) => r.source === 'ollama-local').length;
  return {
    rows, from: 'live', fetchedAt: now,
    words: `Ollama on this computer answered its list of models: ${local} installed here${rows.length > local ? `, ${rows.length - local} cloud-backed` : ''}. No model ran.`,
    observed: { id: 'ollama-local', state: 'checked', at: now, words: `${local} installed on this computer (its list of models; no model ran).` },
  };
}

/** The rows of one source as this computer can read them now (the stand-in for H169's loadCatalog). */
export async function companionCatalog(source: ModelSource, env: Env): Promise<CatalogRead & { observed?: ProviderState }> {
  if (source === 'openrouter') return openRouterCatalog(env);
  const local = await ollamaCatalog(env);
  const rows = local.rows.filter((r) => r.source === source);
  if (source === 'ollama-local') return { ...local, rows };
  // Ollama Cloud: only what this computer's Ollama lists as cloud-backed; its own catalog needs a key and H170's adapter
  return { ...local, rows, words: rows.length
    ? `${rows.length} cloud-backed model${rows.length === 1 ? '' : 's'} listed by Ollama on this computer (served from Ollama's cloud). Ollama Cloud's own list needs its key (not set up here).`
    : 'Ollama Cloud\'s own list needs its key, which is not set up on this computer; Ollama on this computer lists no cloud-backed model.' };
}

const lower = (s: string | undefined): string => (s ?? '').toLowerCase();

/** Sort and filter rows (the stand-in for H169's queryCatalog): pure; a sort never resets a filter; unknown sorts last. */
export function queryRows(rows: readonly CatalogRow[], q: CatalogQuery): { rows: CatalogRow[]; total: number; makers: string[] } {
  const words = lower(q.search).split(/\s+/).filter(Boolean);
  const makers = [...new Set(rows.map((r) => r.maker))].sort((a, b) => a.localeCompare(b));
  const kept = rows.filter((r) => {
    if (q.maker && r.maker !== q.maker) return false;
    if (q.capability && r.caps[q.capability] !== true) return false;
    if (q.cost === 'free' && r.price.free !== true) return false;
    if (q.cost === 'paid' && r.price.free !== false) return false;
    if (q.minContext && !(typeof r.contextLength === 'number' && r.contextLength >= q.minContext)) return false;
    if (words.length) {
      const hay = `${lower(r.id)} ${lower(r.name)} ${lower(r.maker)} ${lower(r.description)}`;
      if (!words.every((w) => hay.includes(w))) return false;
    }
    return true;
  });
  const price = (r: CatalogRow): number | undefined => (r.price.inPerM !== undefined && r.price.outPerM !== undefined ? r.price.inPerM + r.price.outPerM : undefined);
  const known = <T>(a: T | undefined, b: T | undefined, cmp: (x: T, y: T) => number): number => (a === undefined && b === undefined ? 0 : a === undefined ? 1 : b === undefined ? -1 : cmp(a, b));
  const byName = (a: CatalogRow, b: CatalogRow): number => a.name.localeCompare(b.name);
  const sorted = [...kept].sort((a, b) => {
    const c = q.sort === 'recent' ? known(a.created, b.created, (x, y) => y - x)
      : q.sort === 'price' ? known(price(a), price(b), (x, y) => x - y)
        : q.sort === 'context' ? known(a.contextLength, b.contextLength, (x, y) => y - x) : 0;
    return c || byName(a, b);
  });
  return { rows: sorted, total: kept.length, makers };
}

/** A page's query as a CatalogQuery; anything it does not know is left out (never an error). */
export function catalogQueryOf(q: Record<string, unknown>): CatalogQuery {
  const one = (v: unknown): string | undefined => (typeof v === 'string' ? v.trim().slice(0, 120) : undefined);
  const source = SOURCES.find((s) => s === one(q.source)) ?? 'openrouter';
  const sort = SORTS.find((s) => s === one(q.sort)) ?? 'recent';
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
      const local = await ollamaCatalog(env);
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
        logs: { words: 'Logs and receipts stay on this computer: the project\'s .timmy folder and its conversation in .sessions.', cloud: 'Cloud copies: off (not set up).' },
      });
    } catch { answer(res, { ok: false, error: FAILED }, 500); }
  });
  app.get(CHAT_VIEW_ROUTES.models, ctx.withToken, async (req, res) => {
    const project = ctx.projectFor(req);
    if (!project) { answer(res, { ok: false, error: ctx.projectUnknown }, 404); return; }
    try {
      const q = catalogQueryOf(req.query as Record<string, unknown>);
      const read = await companionCatalog(q.source, ctx.chatEnv());
      const out = queryRows(read.rows, q);
      answer(res, {
        ok: true, query: q, from: read.from, ...(read.fetchedAt ? { fetchedAt: read.fetchedAt } : {}), ...(read.error ? { error: read.error } : {}),
        words: read.words, total: out.total, all: read.rows.length, makers: out.makers, rows: out.rows.slice(0, MODELS_MAX),
      });
    } catch { answer(res, { ok: false, error: FAILED }, 500); }
  });
}
