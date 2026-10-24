/**
 * R10 (H170; CHAT-H170 item 6, the shared contract of CHAT-COMMON.txt): where each provider stands, for the terminal Chat
 * (H167) and the browser companion's (H171). Four providers: OpenRouter, Ollama on this computer, Ollama Cloud, and
 * Cloudflare (optional, read only).
 *
 *   providerStates(ctx)      read only, no network: the keys in use (./provider-keys.ts), Ollama's program or app here
 *                            (./ollama-local.ts), Cloudflare's settings, and the last observation of each, from the record
 *                            every check writes (<Timmy home>/state/connections.json, `timmy workspace check`'s record: an
 *                            observation counts only for the key or the address it asked, as the workspace frame reads it)
 *   describeCheck(id)        what a check sends, said before it is sent
 *   checkProvider(id, ctx)   the check: a request that runs no model and costs nothing (OpenRouter's key endpoint, through
 *                            src/capabilities/live.ts openRouterProbe; Ollama's version, list and loaded models at the loopback
 *                            address the chat asks; Ollama Cloud's model list with the key); Cloudflare is never asked (a
 *                            request to an AI Gateway can create one and bill), so its check sends nothing and says so
 *   sign-in, keys, the pull  re-exported: startOpenRouterSignIn, saveKey, forgetKey, confirmPull, ollamaPull
 *
 * The states (Timmy's honesty rules): installed is not running; configured is not verified; a saved key is "saved, not
 * checked" until a check answers; only an observed answer is "checked", with its time. Every state carries its words; a
 * key never enters them (its fingerprint and where it is kept only).
 */
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { timmyHome, privateDir, workspaceRoot, type Env } from './home.js';
import { KEY_PAGE, keyFingerprint, keyInUse, keyWhere, type KeyedProvider } from './provider-keys.js';
import { installSteps, observeOllama, ollamaInstalled, OLLAMA_LINKS, STARTER_MODELS, units } from './ollama-local.js';
import { readSetupState } from './questions.js';
import { probeOllama } from '../agent/providers.js';
import { readClefConfig } from '../decision/config.js';
import { ollamaAddress } from '../capabilities/ollama-route.js';

export { startOpenRouterSignIn, startOpenRouterSignIn as openRouterSignIn, MANUAL_WORDS, type SignIn, type SignInResult } from './openrouter-signin.js';
export { saveKey, forgetKey, keyWhere, checkKeyShape, KEY_PAGE } from './provider-keys.js';
export { confirmPull, localHardware, ollamaPull, STARTER_MODELS, SIZE_NOTE, type PullConfirmation, type PullProgress, type PullResult } from './ollama-local.js';
export { checkLocalModel, localModelGlyph, type LocalModelCheck, type LocalModelState, type LocalModelWhy } from './local-model-check.js';

export type ProviderId = 'openrouter' | 'ollama-local' | 'ollama-cloud' | 'cloudflare';
export const PROVIDERS: readonly ProviderId[] = ['openrouter', 'ollama-local', 'ollama-cloud', 'cloudflare'];

/**
 * The contract's states, and one more proposed to it (R10 H170, posted in the handoff): 'installed, not checked', Ollama's
 * program or app here and nothing observed yet (installed is not running, and nothing says it is stopped).
 */
export type ProviderStateWord = 'not set up' | 'pending' | 'saved, not checked' | 'checked' | 'refused' | 'unreachable' | 'not installed' | 'installed, stopped' | 'installed, not checked';

export interface ProviderState {
  id: ProviderId;
  state: ProviderStateWord;
  /** When the observation this state rests on was made (absent: nothing observed). */
  at?: string;
  words: string;
  /** The one next step, in words. */
  next?: string;
  /** More facts, a short line each (models held and loaded, Cloudflare's parts). */
  lines?: string[];
  /** Official pages for this provider's setup. */
  links?: Array<{ label: string; url: string }>;
}

/** The Ollama address the chat asks (src/capabilities/ollama-route.ts): ollamaPull's `origin`, Refresh's address. */
export const ollamaOrigin = (env: Env = process.env): string => ollamaAddress(env);

export const PROVIDER_LABEL: Readonly<Record<ProviderId, string>> ={ openrouter: 'OpenRouter', 'ollama-local': 'Ollama (this computer)', 'ollama-cloud': 'Ollama Cloud', cloudflare: 'Cloudflare (optional)' };

// ── the record of observations (connections.json) ─────────────────────────────

/** The record `timmy workspace check` writes (src/ops/workspace-frame.ts CONNECTIONS_SCHEMA; a test checks they agree). */
export const CONNECTIONS_SCHEMA = 'timmy.connections/1';
export interface Observation { answer: 'accepted' | 'refused' | 'no answer' | 'no model' | 'not running' | 'not asked' | 'listening'; at: string; detail?: string; asked?: string }
/** The record's key for each provider: the workspace frame's ids, and ollama-cloud's own (proposed for ConnectionId). */
const RECORD_ID: Readonly<Record<ProviderId, string>> = { openrouter: 'openrouter', 'ollama-local': 'ollama', 'ollama-cloud': 'ollama-cloud', cloudflare: 'cloudflare' };

export const connectionsFile = (env: Env = process.env): string => join(timmyHome(env), 'state', 'connections.json');

/** The observations, or none (no record, or one that cannot be read). */
export function readObservations(env: Env = process.env): Record<string, Observation> {
  try {
    const raw = JSON.parse(readFileSync(connectionsFile(env), 'utf8')) as { schema?: unknown; checks?: unknown };
    if (raw?.schema === CONNECTIONS_SCHEMA && raw.checks && typeof raw.checks === 'object' && !Array.isArray(raw.checks)) return raw.checks as Record<string, Observation>;
  } catch { /* none yet */ }
  return {};
}

/** Writes one observation into the record, keeping the others: a temporary file (0600), flushed, renamed over it. */
export function writeObservation(id: ProviderId, o: Observation, env: Env = process.env): void {
  const file = connectionsFile(env);
  const checks = { ...readObservations(env), [RECORD_ID[id]]: o };
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  const fd = openSync(tmp, 'w', 0o600);
  try { writeSync(fd, `${JSON.stringify({ schema: CONNECTIONS_SCHEMA, checks }, null, 2)}\n`); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmp, file);
}

/** An observation counts only for what it asked (the key's fingerprint, the address), as the workspace frame's forNow. */
function forNow(o: Observation | undefined, asked: string | null): Observation | undefined {
  if (!o || typeof o.at !== 'string') return undefined;
  if (o.asked && asked !== null && o.asked.replace(/\/+$/, '') !== asked.replace(/\/+$/, '')) return undefined;
  return o;
}

/** How long ago, in words: "just now", "4 min ago", "3 h ago", "on 2026-10-21". */
export function ago(at: string, now: number = Date.now()): string {
  const ms = now - Date.parse(at);
  if (!Number.isFinite(ms)) return 'at an unknown time';
  if (ms < 60_000) return 'just now';
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)} min ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)} h ago`;
  return `on ${at.slice(0, 10)}`;
}

// ── the states ─────────────────────────────────────────────────────────────────

export interface StatesContext {
  env?: Env;
  cwd?: string;
  platform?: NodeJS.Platform;
  home?: string;
  now?: number;
  /** Providers with a sign-in or a download under way in this process (the caller holds them). */
  pending?: readonly ProviderId[];
  exists?: (p: string) => boolean;
}

const keyed = (id: KeyedProvider, ctx: StatesContext): ProviderState => {
  const env = ctx.env ?? process.env;
  const name = id === 'openrouter' ? 'OpenRouter' : 'Ollama Cloud';
  const links = id === 'openrouter'
    ? [{ label: 'OpenRouter keys', url: KEY_PAGE.openrouter }, { label: 'OpenRouter credits (separate, your decision)', url: 'https://openrouter.ai/settings/credits' }, { label: 'OpenRouter sign-in (PKCE)', url: 'https://openrouter.ai/docs/guides/overview/auth/oauth' }]
    : [{ label: 'Ollama API keys', url: KEY_PAGE['ollama-cloud'] }, { label: 'Ollama Cloud', url: 'https://docs.ollama.com/cloud' }, { label: 'Ollama pricing', url: 'https://ollama.com/pricing' }];
  const setup = id === 'openrouter'
    ? 'Sign in with OpenRouter (a browser page; Timmy never asks for your password), or paste a key from openrouter.ai/keys'
    : 'Paste an Ollama API key from ollama.com/settings/keys (no local install or download is needed for Ollama Cloud)';
  if (ctx.pending?.includes(id)) return { id, state: 'pending', words: id === 'openrouter' ? 'Waiting for the sign-in on OpenRouter\'s page: nothing is saved until the code is exchanged for a key.' : 'Waiting for the check to answer.', next: 'Cancel, to stop it', links };
  const k = keyWhere(id, env, ctx.cwd);
  if (!k) return { id, state: 'not set up', words: `No ${name} key is set up.`, next: setup, links };
  const o = forNow(readObservations(env)[RECORD_ID[id]], k.fingerprint);
  const kept = `the key (${k.fingerprint}) from ${k.words}`;
  const now = ctx.now ?? Date.now();
  if (!o || o.answer === 'not asked') return { id, state: 'saved, not checked', words: `Saved, not checked: ${kept}. A check asks ${id === 'openrouter' ? 'OpenRouter\'s key endpoint' : 'Ollama Cloud\'s model list'} (no model is run, no charge).`, next: `Check the key (${id === 'openrouter' ? 'GET /api/v1/key' : 'GET ollama.com/api/tags'}; no model is run)`, links };
  if (o.answer === 'accepted') return { id, state: 'checked', at: o.at, words: `Checked ${ago(o.at, now)}: ${name} took ${kept}${o.detail ? ` (${o.detail})` : ''}.`, links };
  if (o.answer === 'refused') {
    return { id, state: 'refused', at: o.at, links, next: id === 'openrouter' ? 'Sign in again, or paste a new key from openrouter.ai/keys' : 'Paste a new key from ollama.com/settings/keys',
      words: id === 'openrouter' ? `Refused ${ago(o.at, now)}: OpenRouter did not take ${kept}: it is invalid or was revoked.` : `Refused ${ago(o.at, now)}: Ollama Cloud did not take ${kept}: signed out, expired or revoked.` };
  }
  return { id, state: 'unreachable', at: o.at, words: `Unreachable ${ago(o.at, now)}: ${name} did not answer the check (${o.detail ?? 'no answer'}); ${kept} is kept as it was.`, next: 'Check again when the network is back', links };
};

function ollamaLocal(ctx: StatesContext): ProviderState {
  const env = ctx.env ?? process.env;
  const platform = ctx.platform ?? process.platform;
  const origin = (() => { try { return ollamaAddress(env); } catch { return 'http://127.0.0.1:11434'; } })();
  const host = origin.replace(/^https?:\/\//, '').replace(/\/+$/, '');
  const inst = ollamaInstalled({ env, platform, ...(ctx.home ? { home: ctx.home } : {}), ...(ctx.exists ? { exists: ctx.exists } : {}) });
  const steps = installSteps(platform);
  const links = [{ label: 'Download Ollama', url: steps.link }, { label: 'Ollama quickstart', url: OLLAMA_LINKS.quickstart }, { label: 'Ollama library', url: OLLAMA_LINKS.library }];
  const starter = STARTER_MODELS.find((s) => s.default)!;
  const now = ctx.now ?? Date.now();
  if (ctx.pending?.includes('ollama-local')) return { id: 'ollama-local', state: 'pending', words: 'A download is under way in Ollama.', next: 'Cancel, to stop it (Ollama keeps what it downloaded; pulling again resumes)', links };
  const o = forNow(readObservations(env).ollama, origin);
  const lines = o?.detail ? [o.detail] : undefined;
  if (o?.answer === 'accepted') return { id: 'ollama-local', state: 'checked', at: o.at, words: `Checked ${ago(o.at, now)}: Ollama answered at ${host} with local models (no account, no charge).`, ...(lines ? { lines } : {}), links };
  if (o?.answer === 'no model') return { id: 'ollama-local', state: 'checked', at: o.at, words: `Checked ${ago(o.at, now)}: Ollama answered at ${host}, and holds no local model Timmy can use yet.`, next: `Download a starter model (${starter.model}, ${starter.size}), with your confirmation`, ...(lines ? { lines } : {}), links };
  if (o && inst.installed) return { id: 'ollama-local', state: 'installed, stopped', at: o.at, words: `Ollama is ${inst.words}; it did not answer at ${host} when checked ${ago(o.at, now)}${o.detail ? ` (${o.detail})` : ''}.`, next: `Start it: ${steps.start}; then Refresh`, links };
  if (inst.installed) return { id: 'ollama-local', state: 'installed, not checked', words: `Ollama is ${inst.words}; whether it runs is not checked yet (Refresh asks it at ${host}, no charge).`, next: 'Refresh', links };
  if (o) return { id: 'ollama-local', state: 'not installed', at: o.at, words: `Ollama is ${inst.words}, and nothing answered at ${host} when checked ${ago(o.at, now)}.`, next: `Install it: ${steps.install}; then ${steps.start}`, links };
  return { id: 'ollama-local', state: 'not installed', words: `Ollama is ${inst.words}. Local models need no account and no key.`, next: `Install it: ${steps.install}; then ${steps.start}`, links };
}

// ── Cloudflare's optional settings (R11 round 4, H170: the companion's Connections screen writes them) ─────────────────

export const CLOUDFLARE_SETTINGS_SCHEMA = 'timmy.cloudflare-settings/1';
/** AI Gateway / model routing and cloud logs: two separate optional settings, kept in the Timmy home (state/cloudflare.json). */
export interface CloudflareSettings { gatewayUrl: string | null; cloudLogs: boolean; at?: string }
export const cloudflareSettingsFile = (env: Env = process.env): string => join(timmyHome(env), 'state', 'cloudflare.json');

/** The settings, or none (no file, or one that cannot be read). */
export function readCloudflareSettings(env: Env = process.env): CloudflareSettings {
  try {
    const raw = JSON.parse(readFileSync(cloudflareSettingsFile(env), 'utf8')) as Record<string, unknown>;
    if (raw?.schema !== CLOUDFLARE_SETTINGS_SCHEMA) return { gatewayUrl: null, cloudLogs: false };
    return { gatewayUrl: typeof raw.gateway_url === 'string' && raw.gateway_url ? raw.gateway_url : null, cloudLogs: raw.cloud_logs === true, ...(typeof raw.at === 'string' ? { at: raw.at } : {}) };
  } catch { return { gatewayUrl: null, cloudLogs: false }; }
}

/** The two settings in words: what each does, and that local logs stay local. */
export function cloudflareSettingsLines(s: CloudflareSettings, env: Env = process.env): string[] {
  const host = ((): string => { try { return new URL(s.gatewayUrl ?? '').host; } catch { return 'an address'; } })();
  const telemetry = env.TIMMY_TELEMETRY_URL?.trim() ? '; TIMMY_TELEMETRY_URL is set (the legacy shell\'s telemetry bridge sends run events there)' : '';
  return [
    s.gatewayUrl ? `AI Gateway / model routing: set (${host}); used only when a model call is routed through it; not checked here` : 'AI Gateway / model routing: not set (optional)',
    s.cloudLogs ? `Cloud logs: on (a copy of the run events is to be synced; the local logs stay the record)${telemetry}` : `Cloud logs: off; local logs are already part of the design${telemetry}`,
  ];
}

/** Cloudflare's parts, read only: what is configured here; nothing is ever sent to check it. */
function cloudflare(ctx: StatesContext): ProviderState {
  const env = ctx.env ?? process.env;
  const now = ctx.now ?? Date.now();
  const s = (() => { try { return readSetupState(env); } catch { return null; } })();
  const edge = s?.edgeHost ?? null;
  const overlay = (() => {
    try { return JSON.parse(readFileSync(join(privateDir(workspaceRoot(env), env), 'config.json'), 'utf8')) as Record<string, unknown>; } catch { return {}; }
  })();
  const ws = typeof overlay.commander_ws === 'string' && overlay.commander_ws.trim() && !/^<[a-z-]+>$/.test(overlay.commander_ws.trim()) ? 'the private overlay' : env.TIMMY_COMMANDER_WS?.trim() ? 'TIMMY_COMMANDER_WS' : null;
  // the one Cloudflare model path that exists: the decision model's Workers AI transport (src/decision/config.ts clef.json);
  // src/cloudflare's AI Search, Vectorize and Workers AI adapters are stubs nothing uses
  const clef = (() => { try { return readClefConfig(env); } catch { return null; } })();
  const workersAi = clef?.state === 'configured' && clef.config.transport === 'workers-ai'
    ? 'Workers AI: the decision model\'s transport is configured (clef.json); not checked here' : 'Workers AI: not configured (no decision model uses it)';
  const o = edge ? forNow(readObservations(env).cloudflare, `https://${edge}`) : undefined;
  const worker = !edge ? 'Worker: not set up (no edge host in the private overlay or TIMMY_EDGE_HOST)'
    : o?.answer === 'accepted' ? `Worker: ${edge} answered its /health ${ago(o.at, now)} (timmy workspace check; no inference)`
      : o ? `Worker: ${edge} did not answer its /health ${ago(o.at, now)} (timmy workspace check)` : `Worker: ${edge} configured, not checked here`;
  const settings = readCloudflareSettings(env);
  const [gateway, logs] = cloudflareSettingsLines(settings, env);
  const lines = [
    worker,
    `Commander: ${ws ? `an address is configured (${ws}); connected only while a Timmy surface holds its socket` : 'not set up (no commander_ws)'}`,
    gateway,
    workersAi,
    logs,
  ];
  const links = [
    { label: 'AI Gateway: get started', url: 'https://developers.cloudflare.com/ai-gateway/get-started/' },
    { label: 'AI Gateway: authentication', url: 'https://developers.cloudflare.com/ai-gateway/configuration/authentication/' },
    { label: 'Find your account ID', url: 'https://developers.cloudflare.com/fundamentals/account/find-account-and-zone-ids/' },
    { label: 'AI Gateway logging', url: 'https://developers.cloudflare.com/ai-gateway/observability/logging/' },
  ];
  const none = !edge && !ws && !env.TIMMY_TELEMETRY_URL?.trim() && !workersAi.endsWith('not checked here') && !settings.gatewayUrl && !settings.cloudLogs;
  const words = 'Optional, and read only here: Timmy never sends Cloudflare a request to check it (a request to an AI Gateway can create one and bill). The local app, its files and its logs need no Cloudflare account.';
  if (none) return { id: 'cloudflare', state: 'not set up', words, lines, links };
  if (o?.answer === 'accepted') return { id: 'cloudflare', state: 'checked', at: o.at, words, lines, links };
  return { id: 'cloudflare', state: 'saved, not checked', words, lines, links };
}

/** Every provider's state now. Read only: files and the PATH, no request. */
export function providerStates(ctx: StatesContext = {}): ProviderState[] {
  return [keyed('openrouter', ctx), ollamaLocal(ctx), keyed('ollama-cloud', ctx), cloudflare(ctx)];
}

export const providerState = (id: ProviderId, ctx: StatesContext = {}): ProviderState => providerStates(ctx).find((p) => p.id === id)!;

// ── the checks ─────────────────────────────────────────────────────────────────

/** What a check sends, said before it is sent. */
export function describeCheck(id: ProviderId): { sends: string | null; words: string } {
  switch (id) {
    case 'openrouter': return { sends: 'GET https://openrouter.ai/api/v1/key', words: 'Asks OpenRouter\'s key endpoint whether it takes the key: no model is called, nothing is charged.' };
    case 'ollama-local': return { sends: 'GET /api/version, /api/tags, /api/show and /api/ps on this computer\'s Ollama', words: 'Asks the Ollama on this computer what it holds and what it has loaded: no model is run, no charge, nothing leaves this computer.' };
    case 'ollama-cloud': return { sends: 'GET https://ollama.com/api/tags', words: 'Asks Ollama Cloud for its model list with the key: it lists models and runs none, so nothing is charged.' };
    case 'cloudflare': return { sends: null, words: 'Sends nothing: Timmy reads Cloudflare\'s settings only (a request to an AI Gateway can create one and bill).' };
  }
}

export interface CheckContext extends StatesContext {
  /** The requests (a test's FAKE servers on 127.0.0.1). */
  fetch?: typeof fetch;
  /** OpenRouter's key check (default: src/capabilities/live.ts openRouterProbe). */
  openRouterProbe?: (key: string | null, fetcher: typeof fetch) => Promise<'accepted' | 'rejected' | 'unreachable' | 'no-key' | 'not-asked'>;
  timeoutMs?: number;
}

/** Runs the check (describeCheck says what it sends), records what came back, and returns the state it gives. */
export async function checkProvider(id: ProviderId, ctx: CheckContext = {}): Promise<ProviderState> {
  const env = ctx.env ?? process.env;
  const doFetch = ctx.fetch ?? fetch;
  const at = (): string => new Date().toISOString();
  if (id === 'cloudflare') return { ...cloudflare(ctx), words: `${describeCheck('cloudflare').words} ${cloudflare(ctx).words}` };
  if (id === 'openrouter') {
    const k = keyInUse('openrouter', env, ctx.cwd);
    if (!k) return providerState('openrouter', ctx);
    const probe = ctx.openRouterProbe ?? (await import('../capabilities/live.js')).openRouterProbe;
    const answer = await probe(k.key, doFetch);
    const asked = keyFingerprint(k.key);
    if (answer === 'accepted') writeObservation('openrouter', { answer: 'accepted', at: at(), detail: 'the key endpoint took the key; no model was called', asked }, env);
    else if (answer === 'rejected') writeObservation('openrouter', { answer: 'refused', at: at(), detail: 'the key endpoint rejected the key', asked }, env);
    else if (answer === 'unreachable') writeObservation('openrouter', { answer: 'no answer', at: at(), detail: 'the key endpoint did not answer', asked }, env);
    return providerState('openrouter', ctx);
  }
  if (id === 'ollama-cloud') {
    const k = keyInUse('ollama-cloud', env, ctx.cwd);
    if (!k) return providerState('ollama-cloud', ctx);
    const asked = keyFingerprint(k.key);
    let rec: Observation;
    try {
      const res = await doFetch('https://ollama.com/api/tags', { headers: { Authorization: `Bearer ${k.key}` }, signal: AbortSignal.timeout(ctx.timeoutMs ?? 5000), redirect: 'error' });
      if (res.status === 401 || res.status === 403) { try { await res.body?.cancel(); } catch { /* none */ } rec = { answer: 'refused', at: at(), detail: `HTTP ${res.status}`, asked }; }
      else if (!res.ok) { try { await res.body?.cancel(); } catch { /* none */ } rec = { answer: 'no answer', at: at(), detail: `HTTP ${res.status}`, asked }; }
      else {
        let n: number | null = null;
        try { const j = await res.json() as { models?: unknown }; n = Array.isArray(j?.models) ? j.models.length : null; } catch { n = null; }
        rec = { answer: 'accepted', at: at(), detail: n === null ? 'it answered; no model was run' : `it lists ${n} model${n === 1 ? '' : 's'}; none was run`, asked };
      }
    } catch { rec = { answer: 'no answer', at: at(), detail: 'no network, or Ollama Cloud did not answer', asked }; }
    writeObservation('ollama-cloud', rec, env);
    return providerState('ollama-cloud', ctx);
  }
  // Ollama on this computer, at the address the chat asks
  const origin = ollamaAddress(env);
  const seen = await observeOllama(origin, { fetch: doFetch, ...(ctx.timeoutMs ? { timeoutMs: ctx.timeoutMs } : {}) });
  if (!seen.answered) {
    writeObservation('ollama-local', { answer: 'no answer', at: seen.at, detail: seen.why, asked: origin }, env);
    return providerState('ollama-local', ctx);
  }
  const probe = await probeOllama(Math.min(ctx.timeoutMs ?? 2500, 120_000), origin);
  const local = seen.models.filter((m) => !m.cloud);
  const size = (b: number | null): string => (b === null ? '' : ` (${units(b)})`);
  const held = local.length ? `holds ${local.map((m) => `${m.name}${size(m.size)}`).join(', ')}` : 'holds no local model';
  const cloud = seen.models.length - local.length;
  const loaded = seen.running === null ? 'what is loaded is not known' : seen.running.length ? `loaded now: ${seen.running.map((r) => r.name).join(', ')}` : 'none loaded now';
  const detail = `Ollama ${seen.version ?? '(version not given)'} ${held}${cloud ? `, and lists ${cloud} cloud model${cloud === 1 ? '' : 's'} (cloud, not local)` : ''}; ${probe.models.length} pass${probe.models.length === 1 ? 'es' : ''} the local check; ${loaded}`;
  writeObservation('ollama-local', { answer: probe.ok ? 'accepted' : 'no model', at: seen.at, detail, asked: origin }, env);
  return providerState('ollama-local', ctx);
}
