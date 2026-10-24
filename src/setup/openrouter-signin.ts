/**
 * R10 (H170; CHAT-H170 item 2): signing in with OpenRouter by PKCE (S256), so a person never gives Timmy a password: they
 * authorize Timmy on OpenRouter's own page, and Timmy exchanges the code that comes back for a key of their account.
 *
 * The flow, as OpenRouter's client SDK has it (@openrouter/sdk 0.12.35, installed here; its oAuthCreateSHA256CodeChallenge,
 * oAuthCreateAuthorizationUrl and oAuthExchangeAuthCodeForAPIKey, generated from OpenRouter's API):
 *   1. a code verifier (32 random bytes, base64url, RFC 7636) and its S256 challenge; the verifier stays in this process
 *   2. a callback server on 127.0.0.1, on a free port, answering one path that holds a random part, so that no other page's
 *      request is taken for OpenRouter's answer
 *   3. the authorization address, https://openrouter.ai/auth?callback_url=…&code_challenge=…&code_challenge_method=S256 (and
 *      limit=<dollars> when the person sets a credit limit for the key): shown to the person, and opened in a browser only by
 *      the person's own step (the caller's); a terminal without a browser shows it to copy. It holds no secret.
 *   4. OpenRouter sends the browser back to the callback with ?code=…; the code and the verifier are exchanged for a key:
 *      POST https://openrouter.ai/api/v1/auth/keys {code, code_verifier, code_challenge_method: "S256"} answers {key, user_id}
 *   5. the key is saved as a pasted one is (./provider-keys.ts saveKey: providers.json, 0600): saved, not checked
 * The manual way (the spec's "manual-code fallback"; MANUAL_WORDS): a browser on another computer cannot reach this one's
 * 127.0.0.1, so it ends on a page that does not load; its address holds the code, and the person types it into Timmy's own
 * field (submit), never into the conversation. It is exchanged as the callback's would be.
 * Cancel, a timeout (5 minutes unless the caller sets another), a declined sign-in and a refused exchange each end it with
 * nothing saved, in words; the server stops in every case. Nothing here touches a project, a conversation or a draft, so
 * cancelling keeps them as they are. The code, the verifier and the key never enter a word, a log or an error.
 */
import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Env } from './home.js';
import { saveKey, type SaveKeyResult } from './provider-keys.js';
import { HOMEBREW } from '../theme/tokens.js';

export const OPENROUTER_ORIGIN = 'https://openrouter.ai';
export const OPENROUTER_AUTH_URL = `${OPENROUTER_ORIGIN}/auth`;
export const OPENROUTER_EXCHANGE_URL = `${OPENROUTER_ORIGIN}/api/v1/auth/keys`;
export const SIGN_IN_TIMEOUT_MS = 5 * 60_000;

/** base64url without padding (RFC 4648 §5), as RFC 7636 asks. */
const b64url = (b: Buffer): string => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** A verifier and its S256 challenge (RFC 7636 §4.1, §4.2). */
export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = b64url(randomBytes(32));
  return { verifier, challenge: b64url(createHash('sha256').update(verifier, 'ascii').digest()) };
}

/** The authorization address for a callback and a challenge (the SDK's oAuthCreateAuthorizationUrl builds the same). */
export function authorizationUrl(callback: string, challenge: string, limit?: number): string {
  const u = new URL(OPENROUTER_AUTH_URL);
  u.searchParams.set('callback_url', callback);
  u.searchParams.set('code_challenge', challenge);
  u.searchParams.set('code_challenge_method', 'S256');
  if (limit !== undefined) u.searchParams.set('limit', String(limit));
  return u.toString();
}

export type SignInResult =
  | { ok: true; fingerprint: string; at: string; path: string; words: string }
  | { ok: false; reason: 'cancelled' | 'timeout' | 'declined' | 'refused' | 'unreachable' | 'not saved'; at: string; words: string };

export interface SignIn {
  /** The authorization address to show, and to open on the person's step. */
  url: string;
  /** Where OpenRouter sends the browser back (this computer only). */
  callback: string;
  port: number;
  /** What became of it; it settles once. */
  done: Promise<SignInResult>;
  /** Cancel: nothing is saved, and the server stops. */
  cancel: () => void;
  /**
   * The manual way, for a browser on another computer (MANUAL_WORDS): the address that browser ended on, or the code alone,
   * typed into Timmy's own field (never the conversation). Exchanged as the callback's would be; the answer says whether it
   * was taken, and `done` says what came of it.
   */
  submit: (pasted: string) => { ok: boolean; words: string };
}

/** The manual way, in words a surface shows beside the address (a headless terminal, or a browser on another computer). */
export const MANUAL_WORDS = 'If the browser is on another computer: open the address there and sign in. It ends on a page that does not load (an address on 127.0.0.1): copy that whole address into the field here, never into the chat.';

export interface SignInOptions {
  env?: Env;
  cwd?: string;
  /** The exchange's request (a test's FAKE OpenRouter; nothing else is ever asked). */
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** A credit limit for the key, in dollars: the person's choice, never a default. */
  limit?: number;
  /** Cancel from outside (the UI's Cancel or Esc). */
  signal?: AbortSignal;
  /** Saves the key (default: providers.json through saveKey). */
  save?: (key: string) => SaveKeyResult;
}

const PAGE_HEAD = { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'", 'Referrer-Policy': 'no-referrer' };
const page = (title: string, body: string): string =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head><body style="background:${HOMEBREW.ground};color:${HOMEBREW.text};font:16px monospace;padding:2em"><h1 style="font-size:18px">${title}</h1><p>${body}</p></body></html>`;

/** A code as OpenRouter's answer holds one (never shown); anything else is no code. */
export const codeShape = (v: string | null): v is string => typeof v === 'string' && v.length > 0 && v.length <= 2048 && /^[\x21-\x7e]+$/.test(v);

export type ExchangeResult =
  | { ok: true; fingerprint: string; at: string; path: string; words: string }
  | { ok: false; reason: 'refused' | 'unreachable' | 'not saved'; at: string; words: string };

/**
 * R11 round 4 (H170): the exchange alone, step 4 and 5 of the flow above, for any surface that received a code (the terminal's
 * callback server below, the browser companion's callback route): POST OPENROUTER_EXCHANGE_URL {code, code_verifier,
 * code_challenge_method S256}; the key in the answer saved with `save` (providers.json through saveKey when none is given).
 * Nothing of the code, the verifier or the key enters a word. One exchange per code: the caller sees to that.
 */
export async function exchangeOpenRouterCode(code: string, verifier: string, o: { fetch?: typeof fetch; signal?: AbortSignal; save?: (key: string) => SaveKeyResult; env?: Env; cwd?: string } = {}): Promise<ExchangeResult> {
  const doFetch = o.fetch ?? fetch;
  const at = (): string => new Date().toISOString();
  const refused = (words: string): ExchangeResult => ({ ok: false, reason: 'refused', at: at(), words });
  let res: Response;
  try {
    res = await doFetch(OPENROUTER_EXCHANGE_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, redirect: 'error',
      signal: o.signal ? AbortSignal.any([o.signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
      body: JSON.stringify({ code, code_verifier: verifier, code_challenge_method: 'S256' }),
    });
  } catch {
    return { ok: false, reason: 'unreachable', at: at(), words: 'OpenRouter did not answer the exchange (no network, or it is down): nothing was saved. Try again, or paste a key from openrouter.ai/keys.' };
  }
  if (!res.ok) {
    try { await res.body?.cancel(); } catch { /* nothing to read */ }
    const why = res.status === 400 ? 'the code challenge method did not match'
      : res.status === 403 ? 'the code or its verifier is not valid, or the sign-in expired' : 'it refused the exchange';
    return refused(`OpenRouter refused the exchange (HTTP ${res.status}: ${why}): nothing was saved. Sign in again, or paste a key from openrouter.ai/keys.`);
  }
  let key: unknown;
  try { key = ((await res.json()) as { key?: unknown } | null)?.key; } catch { key = undefined; }
  if (typeof key !== 'string' || !key) return refused('OpenRouter\'s answer to the exchange holds no key: nothing was saved. Sign in again, or paste a key from openrouter.ai/keys.');
  const saved = (o.save ?? ((k: string) => saveKey('openrouter', k, o.env ?? process.env, o.cwd ?? process.cwd())))(key);
  if (!saved.ok) return { ok: false, reason: 'not saved', at: at(), words: `OpenRouter gave a key, and it was not saved: ${saved.why}` };
  return { ok: true, fingerprint: saved.fingerprint, at: at(), path: saved.path, words: `Signed in: ${saved.words}` };
}

/**
 * Starts a sign-in: the callback server listens before this returns, so the address shown works at once. Refused (thrown)
 * only when no port on 127.0.0.1 can be had, or the limit is not a positive number of dollars.
 */
export async function startOpenRouterSignIn(o: SignInOptions = {}): Promise<SignIn> {
  if (o.limit !== undefined && (!Number.isFinite(o.limit) || o.limit <= 0 || o.limit > 1_000_000)) throw new Error('the credit limit must be a number of dollars above 0');
  const env = o.env ?? process.env;
  const cwd = o.cwd ?? process.cwd();
  const doFetch = o.fetch ?? fetch;
  const timeoutMs = o.timeoutMs ?? SIGN_IN_TIMEOUT_MS;
  const { verifier, challenge } = pkcePair();
  const path = `/openrouter/callback/${b64url(randomBytes(16))}`;
  const exchange = new AbortController();
  let settle!: (r: SignInResult) => void;
  let settled = false;
  /** the first code that came back: one sign-in, one exchange */
  let received = false;
  const done = new Promise<SignInResult>((resolve) => { settle = resolve; });
  const server = createServer();
  const stopServer = (): void => { server.close(); server.closeAllConnections(); };
  let timer: NodeJS.Timeout | undefined;
  const finish = (r: SignInResult): void => {
    if (settled) return;
    settled = true;
    if (timer) clearTimeout(timer);
    exchange.abort();
    stopServer();
    settle(r);
  };
  const failed = (reason: Extract<SignInResult, { ok: false }>['reason'], words: string): void => finish({ ok: false, reason, at: new Date().toISOString(), words });

  // the exchange itself is exchangeOpenRouterCode (R11 round 4: the browser companion's callback route redeems the same way)
  const redeem = async (code: string): Promise<void> => {
    const r = await exchangeOpenRouterCode(code, verifier, { fetch: doFetch, signal: exchange.signal, env, cwd, ...(o.save ? { save: o.save } : {}) });
    if (settled) return;
    if (r.ok) finish(r);
    else failed(r.reason, r.words);
  };

  server.on('request', (req: IncomingMessage, res: ServerResponse) => {
    const u = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (req.method !== 'GET' || u.pathname !== path) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('not found'); return; }
    if (settled || received) { res.writeHead(410, PAGE_HEAD); res.end(page('This sign-in has an answer already', 'Go back to Timmy: it says what happened.')); return; }
    const code = u.searchParams.get('code');
    if (!codeShape(code)) {
      res.writeHead(200, PAGE_HEAD);
      res.end(page('The sign-in did not finish', 'No code came back from OpenRouter (it was declined or cancelled there). Nothing was saved: go back to Timmy.'));
      failed('declined', 'The sign-in did not finish: OpenRouter sent no code back (declined or cancelled on its page). Nothing was saved.');
      return;
    }
    received = true;
    res.writeHead(200, PAGE_HEAD);
    res.end(page('Timmy received the sign-in', 'You can close this page and go back to Timmy: it exchanges the code for a key and says when it is saved.'));
    void redeem(code);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  // a sign-in never keeps a process alive by itself: a surface that quits ends it, with nothing saved (a one-shot command
  // with nothing else running holds a handle of its own while it waits)
  server.unref();
  const port = (server.address() as AddressInfo).port;
  const callback = `http://127.0.0.1:${port}${path}`;
  const waited = timeoutMs >= 1000 ? `${Math.round(timeoutMs / 1000)} s` : `${timeoutMs} ms`;
  timer = setTimeout(() => failed('timeout', `The sign-in timed out after ${waited} with no answer from the browser: nothing was saved. Start it again, or paste a key from openrouter.ai/keys.`), timeoutMs);
  timer.unref();
  const cancel = (): void => failed('cancelled', 'The sign-in was cancelled: nothing was saved.');
  if (o.signal) {
    if (o.signal.aborted) cancel();
    else o.signal.addEventListener('abort', cancel, { once: true });
  }
  const submit = (pasted: string): { ok: boolean; words: string } => {
    if (settled) return { ok: false, words: 'This sign-in has ended: start it again.' };
    if (received) return { ok: false, words: 'This sign-in has its code already: it is being exchanged.' };
    const raw = typeof pasted === 'string' ? pasted.trim() : '';
    let code: string | null = raw;
    if (/^https?:\/\//i.test(raw)) {
      let u: URL | null = null;
      try { u = new URL(raw); } catch { u = null; }
      if (!u) return { ok: false, words: 'That is not an address: paste the whole address the browser ended on, or the code alone.' };
      // another sign-in's address holds another sign-in's code: its exchange could only fail
      if (u.pathname !== path) return { ok: false, words: 'That address is from another sign-in (its path differs): open this sign-in\'s address, then paste where it ends.' };
      code = u.searchParams.get('code');
    } else if (/^[?&]?code=/i.test(raw)) code = new URLSearchParams(raw.replace(/^[?&]/, '')).get('code');
    if (!codeShape(code)) return { ok: false, words: 'That holds no code from OpenRouter: paste the whole address the browser ended on (it holds code=…), or the code alone.' };
    received = true;
    void redeem(code);
    return { ok: true, words: 'Taken: the code is being exchanged for a key; nothing is saved until OpenRouter answers.' };
  };
  return { url: authorizationUrl(callback, challenge, o.limit), callback, port, done, cancel, submit };
}
