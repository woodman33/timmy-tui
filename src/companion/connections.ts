/**
 * R11 round 4 (H170; contract C2 of R11-R4-COMMON.txt): the browser companion's Connections screen, server side: the four
 * providers a person connects independently (OpenRouter, Ollama on this computer, Ollama Cloud, Cloudflare), each under
 * the signed-in user's own Timmy home (C1: userEnv), each in H170's provider-state words (src/setup/providers-state.ts:
 * not set up / pending / saved, not checked / checked / refused / unreachable / not installed / installed, …). A selection
 * is never a connection; "checked" only after an observation that happened; never "free".
 *
 * Reused, never copied: the terminal's S256 PKCE sign-in (src/setup/openrouter-signin.ts: pkcePair, authorizationUrl and
 * exchangeOpenRouterCode — the companion IS the callback listener, so the terminal's loopback server is not started), the
 * key helpers (src/setup/provider-keys.ts), the local pull with its confirmation, progress and abort (src/setup/
 * ollama-local.ts), the checks and the observation record (src/setup/providers-state.ts).
 *
 * The routes, mounted by server.ts through mountConnections(app, deps); every one under deps.withUser (C1) but the sign-in's
 * callback, which carries no token and no session: OpenRouter's browser redirect lands there with the code alone, and a
 * one-time state value in the path matches it to the pending user.
 *   GET    /api/connections                              the four states, each card's words and next step, the screen's words
 *   POST   /api/connections/openrouter/start             { callback } → { url }: the verifier kept here per user (5 min, one at a time)
 *   GET    /api/connections/openrouter/callback/<state>  ?code=…: exchanged, saved (saveKey), observed, a plain page; the page told
 *   POST   /api/connections/openrouter/check             the key endpoint asked (no model called); the observation written
 *   POST   /api/connections/ollama-local/check           the local Ollama asked at the user's address; the observation written
 *   POST   /api/connections/ollama-local/pull            { model } → SSE: size, then waits for …/pull/confirm, then progress, done | cancelled | error
 *   POST   /api/connections/ollama-local/pull/confirm    { id }: the person's step (confirmPull); the download starts
 *   POST   /api/connections/ollama-local/pull/cancel     { id }: aborts; Ollama keeps what it downloaded
 *   POST   /api/connections/ollama-cloud/key             { key } (the JSON body only) → saved; never echoed
 *   POST   /api/connections/ollama-cloud/check           Ollama Cloud's model list asked with the key; the observation written
 *   POST   /api/connections/cloudflare                   { gatewayUrl?, cloudLogs? } → settings in the user's home; nothing sent to Cloudflare
 *   DELETE /api/connections/<openrouter|ollama-cloud|cloudflare>   forgets the key / the settings
 * A key never appears in a URL, a log, a page or an answer: fingerprints and places only.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import express from 'express';
import type { Env } from '../setup/home.js';
import { timmyHome } from '../setup/home.js';
import { authorizationUrl, codeShape, exchangeOpenRouterCode, pkcePair, SIGN_IN_TIMEOUT_MS } from '../setup/openrouter-signin.js';
import { checkKeyShape, forgetKey, keyFingerprint, keyInUse, KEY_PAGE, saveKey, type KeyedProvider } from '../setup/provider-keys.js';
import { confirmPull, installSteps, ollamaInstalled, ollamaPull, SIZE_NOTE, STARTER_MODELS, units, type PullConfirmation } from '../setup/ollama-local.js';
import { checkProvider, CLOUDFLARE_SETTINGS_SCHEMA, cloudflareSettingsFile, cloudflareSettingsLines, describeCheck, ollamaOrigin, providerStates, PROVIDER_LABEL, readCloudflareSettings, writeObservation, type CloudflareSettings, type ProviderId, type ProviderState } from '../setup/providers-state.js';
import { failRequest } from '../utils/server-failure.js';
import { HOMEBREW } from '../theme/tokens.js';

// ── the contract with the identity owner (C1) ──────────────────────────────────

/** The signed-in user, as C1's withUser puts it on the request (never from a body, a query or a default). */
export interface ConnectionsUser { id: string; username?: string; email?: string }
type UserRequest = express.Request & { user?: ConnectionsUser };

export interface ConnectionsDeps {
  /** C1: answers 401 in words without a verified session; sets req.user. */
  withUser: express.RequestHandler;
  /** C1: the user's own Timmy home (TIMMY_HOME, TIMMY_SETTINGS_DIR, TIMMY_MCP_HOME under <TIMMY_HOME>/users/<id>/). */
  userEnv: (user: ConnectionsUser) => Env;
  /** The requests to OpenRouter's exchange and key endpoint and to Ollama Cloud (a test's FAKE on 127.0.0.1); fetch when absent. */
  fetch?: typeof fetch;
  /** Tells the user's pages what changed (the socket): { type: 'connections', provider, state, words }. Absent: nothing told. */
  notify?: (userId: string, event: ConnectionsEvent) => void;
  platform?: NodeJS.Platform;
  /** A sign-in waits this long for the browser (SIGN_IN_TIMEOUT_MS when absent). */
  signInTimeoutMs?: number;
  /** A pull waits this long for its confirmation (10 minutes when absent). */
  confirmTimeoutMs?: number;
  now?: () => number;
}

export interface ConnectionsEvent { type: 'connections'; provider: ProviderId; state: ProviderState['state']; words: string }

// ── the screen's words (the operator's preview, exactly) ───────────────────────

export const SCREEN_WORDS = Object.freeze({
  kicker: 'CONNECT YOUR MODELS & TOOLS',
  title: 'Choose how you want to run.',
  lead: 'Pick one, connect all three, or explore first. You can change this later.',
  footerStrong: 'Local logs are already part of the design.',
  footer: 'A Cloudflare account is optional. Provider selections are not connections.',
  back: 'Back',
  explore: 'Explore without a model',
  continue: 'Continue to the workspace',
  note: 'No model installed? The local setup will guide you through installing Ollama and downloading a suitable model. Downloads require your explicit confirmation.',
});

export interface CardWords {
  id: ProviderId;
  title: string;
  subtitle: string;
  body: string;
  /** the card's main action, the preview's words ("Connect with OpenRouter"); the ↗ is the page's glyph */
  action: string;
  /** Ollama · local's two buttons */
  buttons?: string[];
}

export const CARD_WORDS: Readonly<Record<ProviderId, CardWords>> = {
  openrouter: { id: 'openrouter', title: 'OpenRouter', subtitle: 'One account. Many model providers.', body: 'Use models from many makers through your OpenRouter account.', action: 'Connect with OpenRouter' },
  'ollama-local': { id: 'ollama-local', title: 'Ollama · local', subtitle: 'On your computer', body: 'Run models on this computer. No provider account required.', action: 'Set up local Ollama', buttons: ['Install Ollama', 'Download a local model'] },
  'ollama-cloud': { id: 'ollama-cloud', title: 'Ollama · cloud', subtitle: 'Your Ollama account', body: 'Use models running on Ollama’s servers, under your account’s terms.', action: 'Sign in to Ollama' },
  cloudflare: { id: 'cloudflare', title: 'Cloudflare', subtitle: 'Optional · gateway, agents and sync', body: 'Connect AI Gateway and optional cloud logs. Local logs work without it.', action: 'Open Cloudflare setup' },
};

/** One card as GET /api/connections answers it: the provider's state (H170's words) and what the card shows. */
export interface ConnectionCard extends CardWords {
  state: ProviderState['state'];
  /** the state in a few words, as the terminal says it (providerStates) */
  words: string;
  /** the one next step */
  next?: string;
  at?: string;
  lines?: string[];
  links?: Array<{ label: string; url: string }>;
  /** a key is kept for this provider (its fingerprint, never the key) */
  key?: { fingerprint: string; from: string };
  /** Ollama · local: the program here or not, the install steps for this computer, the starter models with their sizes */
  local?: { installed: boolean; how?: 'program' | 'app'; install: string; start: string; link: string; address: string; starters: Array<{ model: string; size: string; bytes: number; use: string; default: boolean }>; sizeNote: string };
  /** Cloudflare: the optional settings kept in the user's home */
  cloudflare?: CloudflareSettings & { file: string };
}

// ── the user's environment, isolated ──────────────────────────────────────────

/**
 * The environment a user's routes read and write with: the user's own home (C1), with this process's provider keys struck
 * out (OPENROUTER_API_KEY, OLLAMA_API_KEY: a user's keys are the user's own providers.json, never the operator's shell).
 */
function envOf(deps: ConnectionsDeps, user: ConnectionsUser): Env {
  const env: Env = { ...deps.userEnv(user) };
  delete env.OPENROUTER_API_KEY;
  delete env.OLLAMA_API_KEY;
  return env;
}
/** The folder a user's lookups treat as "the project": the user's Timmy home (no .env or timmy-tui.config.json of this process is read). */
const cwdOf = (env: Env): string => timmyHome(env);

// ── Cloudflare's optional settings: kept by src/setup/providers-state.ts (the card's lines come from there) ────────────

/** An AI Gateway address a person pastes: https, no credentials in it (a key never enters a URL), nothing else judged. */
export function checkGatewayUrl(raw: unknown): { url: string } | { why: string } {
  if (typeof raw !== 'string' || !raw.trim()) return { why: 'no gateway address was given' };
  let u: URL;
  try { u = new URL(raw.trim()); } catch { return { why: 'that is not an address (https://…)' }; }
  if (u.protocol !== 'https:') return { why: 'an AI Gateway address is https; nothing else is kept' };
  if (u.username || u.password) return { why: 'the address holds a name or a password: a credential never goes into a URL. Paste the gateway address alone' };
  if (/[\s\x00-\x1f\x7f]/.test(raw)) return { why: 'the address holds a space or a control character' };
  return { url: u.toString() };
}

// ── the cards ─────────────────────────────────────────────────────────────────

function cards(deps: ConnectionsDeps, env: Env, pending: ProviderId[]): ConnectionCard[] {
  const platform = deps.platform ?? process.platform;
  const states = providerStates({ env, cwd: cwdOf(env), platform, pending });
  return states.map((s): ConnectionCard => {
    const base: ConnectionCard = { ...CARD_WORDS[s.id], state: s.state, words: s.words, ...(s.next ? { next: s.next } : {}), ...(s.at ? { at: s.at } : {}), ...(s.lines ? { lines: s.lines } : {}), ...(s.links ? { links: s.links } : {}) };
    if (s.id === 'openrouter' || s.id === 'ollama-cloud') {
      const k = keyInUse(s.id, env, cwdOf(env));
      if (k) base.key = { fingerprint: keyFingerprint(k.key), from: k.from };
    }
    if (s.id === 'ollama-local') {
      const inst = ollamaInstalled({ env, platform });
      const steps = installSteps(platform);
      base.local = { installed: inst.installed, ...(inst.how ? { how: inst.how } : {}), install: steps.install, start: steps.start, link: steps.link, address: ollamaOrigin(env), starters: STARTER_MODELS.map((m) => ({ model: m.model, size: m.size, bytes: m.bytes, use: m.use, default: m.default })), sizeNote: SIZE_NOTE };
    }
    if (s.id === 'cloudflare') base.cloudflare = { ...readCloudflareSettings(env), file: 'state/cloudflare.json' };
    return base;
  });
}

// ── pages (the sign-in's callback answers a browser, not the page's script) ───

const PAGE_HEAD = { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'", 'Referrer-Policy': 'no-referrer' };
const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] ?? c));
const page = (title: string, body: string): string =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(title)}</title></head><body style="background:${HOMEBREW.ground};color:${HOMEBREW.text};font:16px monospace;padding:2em"><h1 style="font-size:1.2em">${esc(title)}</h1><p>${esc(body)}</p></body></html>`;

// ── SSE ───────────────────────────────────────────────────────────────────────

function sseOpen(res: express.Response): void {
  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
}
const sseSend = (res: express.Response, event: string, data: unknown): void => { if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };

// ── the routes ────────────────────────────────────────────────────────────────

interface PendingSignIn { user: ConnectionsUser; state: string; verifier: string; callback: string; at: number; timer: NodeJS.Timeout }
interface PendingPull { id: string; user: ConnectionsUser; env: Env; model: string; origin: string; res: express.Response; controller: AbortController; confirmed: boolean; timer: NodeJS.Timeout }

const b64url = (b: Buffer): string => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const STATE_SHAPE = /^[A-Za-z0-9_-]{22}$/;
const PULL_ID = /^p[0-9a-f]{16}$/;
const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;

export const CONNECTIONS_NO_USER = 'Refused: no signed-in user on this request.';

export function mountConnections(app: express.Express, deps: ConnectionsDeps): { pendingSignIns: () => number; pendingPulls: () => number; close: () => void } {
  const doFetch = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  const signIns = new Map<string, PendingSignIn>(); // by user id: one at a time
  const byState = new Map<string, string>(); // state → user id
  const pulls = new Map<string, PendingPull>();
  const userOf = (req: express.Request, res: express.Response): ConnectionsUser | null => {
    const u = (req as UserRequest).user;
    if (!u || typeof u.id !== 'string' || !u.id) { failRequest(res, 401, CONNECTIONS_NO_USER); return null; }
    return u;
  };
  const tell = (user: ConnectionsUser, env: Env, provider: ProviderId): ProviderState => {
    const s = providerStates({ env, cwd: cwdOf(env), platform: deps.platform ?? process.platform }).find((p) => p.id === provider)!;
    try { deps.notify?.(user.id, { type: 'connections', provider, state: s.state, words: s.words }); } catch { /* the page is told next time it asks */ }
    return s;
  };
  const endSignIn = (userId: string): void => {
    const p = signIns.get(userId);
    if (!p) return;
    clearTimeout(p.timer);
    byState.delete(p.state);
    signIns.delete(userId);
  };
  const endPull = (p: PendingPull, event: string, data: unknown): void => {
    clearTimeout(p.timer);
    pulls.delete(p.id);
    sseSend(p.res, event, data);
    if (!p.res.writableEnded) p.res.end();
  };
  const bodyJson = (limit: string): express.RequestHandler => express.json({ limit });

  // GET /api/connections: the four states and the screen's words (files only: nothing is asked of any provider)
  app.get('/api/connections', deps.withUser, (req, res) => {
    const user = userOf(req, res); if (!user) return;
    const env = envOf(deps, user);
    const pending: ProviderId[] = [...(signIns.has(user.id) ? ['openrouter' as const] : []), ...([...pulls.values()].some((p) => p.user.id === user.id) ? ['ollama-local' as const] : [])];
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ok: true, schema: 'timmy.connections-screen/1', screen: SCREEN_WORDS, cards: cards(deps, env, pending), checks: Object.fromEntries((['openrouter', 'ollama-local', 'ollama-cloud', 'cloudflare'] as const).map((id) => [id, describeCheck(id)])), readAt: new Date(now()).toISOString() });
  });

  // POST /api/connections/openrouter/start { callback }: the verifier stays here; the page gets the address to open
  app.post('/api/connections/openrouter/start', deps.withUser, bodyJson('4kb'), (req, res) => {
    const user = userOf(req, res); if (!user) return;
    const raw = (req.body as { callback?: unknown } | undefined)?.callback;
    let cb: URL;
    try { cb = new URL(String(raw ?? '')); } catch { failRequest(res, 400, 'the callback must be this companion\'s address (the page\'s origin) with the path /api/connections/openrouter/callback'); return; }
    const host = String(req.headers.host ?? '');
    if (!['http:', 'https:'].includes(cb.protocol) || cb.host !== host || cb.pathname.replace(/\/+$/, '') !== '/api/connections/openrouter/callback' || cb.search || cb.hash || cb.username || cb.password) {
      failRequest(res, 400, `the callback must be this companion's own address (${host || 'the page\'s origin'}) with the path /api/connections/openrouter/callback and nothing else`); return;
    }
    endSignIn(user.id);
    const { verifier, challenge } = pkcePair();
    const state = b64url(randomBytes(16));
    const callback = `${cb.origin}/api/connections/openrouter/callback/${state}`;
    const timeoutMs = deps.signInTimeoutMs ?? SIGN_IN_TIMEOUT_MS;
    const timer = setTimeout(() => { endSignIn(user.id); try { deps.notify?.(user.id, { type: 'connections', provider: 'openrouter', state: 'not set up', words: 'The sign-in timed out with no answer from the browser: nothing was saved. Start it again, or paste a key from openrouter.ai/keys.' }); } catch { /* none */ } }, timeoutMs);
    timer.unref();
    signIns.set(user.id, { user, state, verifier, callback, at: now(), timer });
    byState.set(state, user.id);
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ok: true, url: authorizationUrl(callback, challenge), callback, expiresAt: new Date(now() + timeoutMs).toISOString(), words: 'Sign in on OpenRouter\'s page (it opens in the browser; Timmy never asks for your password). It comes back here with a code, which is exchanged for a key of your account and saved, not checked.' });
  });

  // GET /api/connections/openrouter/callback/<state>?code=…: the one route without the token; the state matches the user
  app.get('/api/connections/openrouter/callback/:state', async (req, res) => {
    const state = String(req.params.state ?? '');
    const userId = STATE_SHAPE.test(state) ? byState.get(state) : undefined;
    const p = userId ? signIns.get(userId) : undefined;
    res.set(PAGE_HEAD);
    if (!p || p.state !== state) { res.status(410).send(page('This sign-in has ended', 'It expired, was already used, or was started again. Go back to Timmy and start the sign-in once more.')); return; }
    endSignIn(p.user.id); // one state, one answer: a second visit is 410
    const code = typeof req.query.code === 'string' ? req.query.code : null;
    if (!codeShape(code)) {
      res.status(200).send(page('The sign-in did not finish', 'No code came back from OpenRouter (it was declined or cancelled there). Nothing was saved: go back to Timmy.'));
      try { deps.notify?.(p.user.id, { type: 'connections', provider: 'openrouter', state: 'not set up', words: 'The sign-in did not finish: OpenRouter sent no code back (declined or cancelled on its page). Nothing was saved.' }); } catch { /* none */ }
      return;
    }
    const env = envOf(deps, p.user);
    const r = await exchangeOpenRouterCode(code, p.verifier, { fetch: doFetch, env, cwd: cwdOf(env) });
    if (!r.ok) {
      res.status(200).send(page('The sign-in did not finish', `${r.words} Go back to Timmy.`));
      try { deps.notify?.(p.user.id, { type: 'connections', provider: 'openrouter', state: 'not set up', words: r.words }); } catch { /* none */ }
      return;
    }
    // the exchange itself is an observation: OpenRouter issued this key now (no model was called)
    writeObservation('openrouter', { answer: 'accepted', at: r.at, detail: 'issued by the sign-in (the PKCE exchange); no model was called', asked: r.fingerprint }, env);
    res.status(200).send(page('Connected. Return to Timmy.', 'OpenRouter signed you in and Timmy saved a key of your account (never shown). You can close this page.'));
    tell(p.user, env, 'openrouter');
  });

  // POST /api/connections/openrouter/check: the key endpoint, no model called (describeCheck says what is sent)
  app.post('/api/connections/openrouter/check', deps.withUser, async (req, res) => {
    const user = userOf(req, res); if (!user) return;
    const env = envOf(deps, user);
    const s = await checkProvider('openrouter', { env, cwd: cwdOf(env), fetch: doFetch, platform: deps.platform ?? process.platform });
    try { deps.notify?.(user.id, { type: 'connections', provider: 'openrouter', state: s.state, words: s.words }); } catch { /* none */ }
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ok: true, state: s });
  });

  // POST /api/connections/ollama-local/check: the Ollama at the user's address (this computer), nothing leaves it
  app.post('/api/connections/ollama-local/check', deps.withUser, async (req, res) => {
    const user = userOf(req, res); if (!user) return;
    const env = envOf(deps, user);
    const s = await checkProvider('ollama-local', { env, cwd: cwdOf(env), fetch: doFetch, platform: deps.platform ?? process.platform, timeoutMs: 4000 });
    try { deps.notify?.(user.id, { type: 'connections', provider: 'ollama-local', state: s.state, words: s.words }); } catch { /* none */ }
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ok: true, state: s });
  });

  // POST /api/connections/ollama-local/pull { model }: SSE. First `size` (the catalog's, else Ollama's /api/show, else unknown),
  // then it waits for the person's confirmation (…/pull/confirm), then `progress`, and `done` | `cancelled` | `error`.
  app.post('/api/connections/ollama-local/pull', deps.withUser, bodyJson('2kb'), async (req, res) => {
    const user = userOf(req, res); if (!user) return;
    const model = String((req.body as { model?: unknown } | undefined)?.model ?? '').trim();
    if (!MODEL_NAME.test(model)) { failRequest(res, 400, 'that is not a model name Ollama pulls (letters, digits and . _ : / -)'); return; }
    for (const other of pulls.values()) if (other.user.id === user.id) { failRequest(res, 409, `a download is under way already (${other.model}): cancel it first, or wait for it`); return; }
    const env = envOf(deps, user);
    const origin = ollamaOrigin(env);
    const id = `p${randomBytes(8).toString('hex')}`;
    sseOpen(res);
    const starter = STARTER_MODELS.find((m) => m.model === model);
    let bytes: number | null = starter?.bytes ?? null;
    let from = starter ? 'the starter catalog' : 'unknown';
    if (bytes === null) {
      // Ollama's own answer for a model it already holds (nothing is downloaded by asking)
      try {
        const shown = await doFetch(`${origin}/api/show`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model }), signal: AbortSignal.timeout(3000), redirect: 'error' });
        if (shown.ok) {
          const j = (await shown.json()) as { size?: unknown; details?: unknown } | null;
          const n = typeof j?.size === 'number' ? j.size : null;
          if (n !== null && n > 0) { bytes = n; from = 'Ollama (/api/show: it holds this model already)'; }
        } else { try { await shown.body?.cancel(); } catch { /* none */ } }
      } catch { /* not held, or Ollama not answering: the size stays unknown */ }
    }
    const confirmTimeoutMs = deps.confirmTimeoutMs ?? 10 * 60_000;
    const controller = new AbortController();
    const p: PendingPull = { id, user, env, model, origin, res, controller, confirmed: false, timer: setTimeout(() => { if (!p.confirmed) endPull(p, 'cancelled', { id, model, words: `Not downloaded: ${model} waited ${Math.round(confirmTimeoutMs / 60_000)} minutes for your confirmation.` }); }, confirmTimeoutMs) };
    p.timer.unref();
    pulls.set(id, p);
    res.on('close', () => { if (pulls.has(id)) { clearTimeout(p.timer); pulls.delete(id); controller.abort(); } });
    sseSend(res, 'size', { id, model, bytes, size: bytes === null ? 'size unknown' : units(bytes), from, note: SIZE_NOTE, origin, words: bytes === null
      ? `${model}: size unknown (not a starter model, and Ollama does not hold it yet). Confirm to download it into the Ollama on this computer from Ollama's library; nothing else is installed.`
      : `Download ${model} (${units(bytes)}, ${from}; ${SIZE_NOTE}) into the Ollama on this computer from Ollama's library; nothing else is installed. It starts only when you confirm.` });
    sseSend(res, 'waiting', { id, words: 'Waiting for your confirmation.' });
  });

  // POST /api/connections/ollama-local/pull/confirm { id }: the person's step, then the download with its progress
  app.post('/api/connections/ollama-local/pull/confirm', deps.withUser, bodyJson('1kb'), async (req, res) => {
    const user = userOf(req, res); if (!user) return;
    const id = String((req.body as { id?: unknown } | undefined)?.id ?? '');
    const p = PULL_ID.test(id) ? pulls.get(id) : undefined;
    if (!p || p.user.id !== user.id) { failRequest(res, 404, 'no download of yours is waiting under that id'); return; }
    if (p.confirmed) { failRequest(res, 409, 'that download is confirmed already'); return; }
    const c = confirmPull(p.model, { env: p.env });
    if (!c.ok) { endPull(p, 'error', { id, model: p.model, words: c.words }); res.json({ ok: false, error: c.words }); return; }
    p.confirmed = true;
    clearTimeout(p.timer);
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ok: true, id, words: c.words });
    sseSend(p.res, 'confirmed', { id, model: p.model, words: c.words });
    const confirmation: PullConfirmation = c.confirmation;
    const result = await ollamaPull(p.model, (prog) => sseSend(p.res, 'progress', { id, model: p.model, status: prog.status, done: prog.done, total: prog.total, words: prog.words }), p.controller.signal, { confirmation, origin: p.origin, fetch: doFetch });
    if (!pulls.has(id)) return; // the page went away: nothing more to say
    if (result.ok) {
      // the local Ollama holds the model now: the observation says so once it is asked (the check), not before
      endPull(p, 'done', { id, model: p.model, at: result.at, words: result.words });
      tell(user, p.env, 'ollama-local');
    } else endPull(p, result.reason === 'cancelled' ? 'cancelled' : 'error', { id, model: p.model, at: result.at, reason: result.reason, words: result.words });
  });

  // POST /api/connections/ollama-local/pull/cancel { id }: aborts; Ollama keeps what it downloaded, a later pull resumes
  app.post('/api/connections/ollama-local/pull/cancel', deps.withUser, bodyJson('1kb'), (req, res) => {
    const user = userOf(req, res); if (!user) return;
    const id = String((req.body as { id?: unknown } | undefined)?.id ?? '');
    const p = PULL_ID.test(id) ? pulls.get(id) : undefined;
    if (!p || p.user.id !== user.id) { failRequest(res, 404, 'no download of yours is under way under that id'); return; }
    if (!p.confirmed) endPull(p, 'cancelled', { id, model: p.model, words: `Cancelled before it started: ${p.model} was not downloaded.` });
    else p.controller.abort(); // ollamaPull answers 'cancelled' and the stream ends with it
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ok: true, id, words: p.confirmed ? `Cancelling: Ollama keeps what it downloaded of ${p.model}, and pulling it again resumes there.` : `Cancelled before it started: ${p.model} was not downloaded.` });
  });

  // POST /api/connections/ollama-cloud/key { key }: the key in the JSON body only; saved under the user's home; never echoed
  app.post('/api/connections/ollama-cloud/key', deps.withUser, bodyJson('4kb'), (req, res) => {
    const user = userOf(req, res); if (!user) return;
    const raw = (req.body as { key?: unknown } | undefined)?.key;
    const shape = checkKeyShape('ollama-cloud', raw);
    if ('why' in shape) { failRequest(res, 400, shape.why); return; }
    const env = envOf(deps, user);
    const saved = saveKey('ollama-cloud', shape.key, env, cwdOf(env));
    if (!saved.ok) { failRequest(res, 500, saved.why); return; }
    const s = tell(user, env, 'ollama-cloud');
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ok: true, fingerprint: saved.fingerprint, words: `${saved.words} ${describeCheck('ollama-cloud').words}`, state: s, page: KEY_PAGE['ollama-cloud'] });
  });

  // POST /api/connections/ollama-cloud/check: Ollama Cloud's model list with the key (no model run)
  app.post('/api/connections/ollama-cloud/check', deps.withUser, async (req, res) => {
    const user = userOf(req, res); if (!user) return;
    const env = envOf(deps, user);
    const s = await checkProvider('ollama-cloud', { env, cwd: cwdOf(env), fetch: doFetch, platform: deps.platform ?? process.platform });
    try { deps.notify?.(user.id, { type: 'connections', provider: 'ollama-cloud', state: s.state, words: s.words }); } catch { /* none */ }
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ok: true, state: s });
  });

  // POST /api/connections/cloudflare { gatewayUrl?, cloudLogs? }: optional settings in the user's home; nothing sent to Cloudflare
  app.post('/api/connections/cloudflare', deps.withUser, bodyJson('4kb'), (req, res) => {
    const user = userOf(req, res); if (!user) return;
    const body = (req.body ?? {}) as { gatewayUrl?: unknown; cloudLogs?: unknown };
    const env = envOf(deps, user);
    const was = readCloudflareSettings(env);
    let gatewayUrl = was.gatewayUrl;
    if ('gatewayUrl' in body) {
      if (body.gatewayUrl === null || body.gatewayUrl === '') gatewayUrl = null;
      else { const g = checkGatewayUrl(body.gatewayUrl); if ('why' in g) { failRequest(res, 400, g.why); return; } gatewayUrl = g.url; }
    }
    const cloudLogs = 'cloudLogs' in body ? body.cloudLogs === true : was.cloudLogs;
    const file = cloudflareSettingsFile(env);
    try {
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      writeFileSync(file, `${JSON.stringify({ schema: CLOUDFLARE_SETTINGS_SCHEMA, gateway_url: gatewayUrl, cloud_logs: cloudLogs, at: new Date(now()).toISOString() }, null, 2)}\n`, { mode: 0o600 });
    } catch { failRequest(res, 500, 'the Cloudflare settings could not be written in your Timmy home'); return; }
    const settings = readCloudflareSettings(env);
    const s = tell(user, env, 'cloudflare');
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ok: true, settings, lines: cloudflareSettingsLines(settings, env), words: `Saved in your Timmy home (state/cloudflare.json). ${describeCheck('cloudflare').words} Local logs are already part of the design.`, state: s });
  });

  // DELETE /api/connections/<id>: forgets a key or the settings; Ollama on this computer keeps nothing to forget
  app.delete('/api/connections/:id', deps.withUser, (req, res) => {
    const user = userOf(req, res); if (!user) return;
    const id = String(req.params.id ?? '') as ProviderId;
    const env = envOf(deps, user);
    if (id === 'openrouter' || id === 'ollama-cloud') {
      endSignIn(user.id);
      const r = forgetKey(id as KeyedProvider, env, cwdOf(env));
      if (!r.ok) { failRequest(res, 500, r.why); return; }
      const s = tell(user, env, id);
      res.setHeader('Cache-Control', 'no-store');
      res.json({ ok: true, removed: r.removed, words: r.words, state: s });
      return;
    }
    if (id === 'cloudflare') {
      const file = cloudflareSettingsFile(env);
      let removed = false;
      try { if (existsSync(file)) { unlinkSync(file); removed = true; } } catch { failRequest(res, 500, 'the Cloudflare settings could not be removed'); return; }
      const s = tell(user, env, 'cloudflare');
      res.setHeader('Cache-Control', 'no-store');
      res.json({ ok: true, removed, words: removed ? 'The Cloudflare settings were removed from your Timmy home; local logs stay as they are.' : 'No Cloudflare settings were kept.', state: s });
      return;
    }
    if (id === 'ollama-local') { failRequest(res, 400, `nothing is kept for ${PROVIDER_LABEL['ollama-local']}: its models stay in Ollama (ollama rm <model> removes one there)`); return; }
    failRequest(res, 404, 'no such provider: openrouter, ollama-local, ollama-cloud or cloudflare');
  });

  return {
    pendingSignIns: () => signIns.size,
    pendingPulls: () => pulls.size,
    close: () => {
      for (const p of signIns.values()) clearTimeout(p.timer);
      signIns.clear(); byState.clear();
      for (const p of [...pulls.values()]) { p.controller.abort(); endPull(p, 'cancelled', { id: p.id, model: p.model, words: 'The companion is shutting down: the download was cancelled (Ollama keeps what it downloaded).' }); }
    },
  };
}
