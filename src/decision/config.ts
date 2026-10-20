/**
 * Round R4 (H120): where the decision model is reached, as the operator configured it in <TIMMY_HOME>/decision/clef.json:
 *
 *   {"transport": "workers-ai", "account_id": "<Cloudflare account id>", "token_file": "/path/to/a/0600/token",
 *    "model"?: "@cf/cloudflare/clef-omni", "pricing"?: {...}}
 *   {"transport": "systemone", "systemone_url": "http://127.0.0.1:8181", "model": "clef-flash:latest", "pricing"?: {...},
 *    "token_file"?: "...", "limits"?: {"questions"?: n, "context_tokens"?: n}}                  a SystemOne-compatible deployment
 *   {"transport": "none"}                                                                        decision-model routing off here
 *
 * R9 (H162): the model is named, never assumed: `model` is required for systemone (the model the deployment serves, as it
 * names it), and workers-ai keeps @cf/cloudflare/clef-omni as its default. Pricing is declared, never inferred:
 *
 *   {"usd_per_million_input": <dollars>, "billing": "per-request" | "per-question"}   per-question bills the whole input once
 *                                                                                     for each question, as Liquid documents
 *                                                                                     for d1-ultra
 *   {"free": "local"}   the operator's own statement that this endpoint runs the model on hardware they control, at no
 *                       per-call charge
 *
 * Nothing else makes a call free: not the transport's name, not a self-hosted or remote label, not a loopback address (a
 * localhost address can proxy paid inference: Ollama serves its cloud models there). No pricing means pricing unknown, and
 * unknown never becomes zero (src/decision/pricing.ts says what each one allows).
 *
 * No file, or one that cannot be read or used, means the provider is unavailable (the deterministic path is used, the reason
 * recorded); nothing is guessed. The token is read only through src/cloud/token.ts readTokenFile (a regular file of the
 * operator's own, 0600 or 0400, never through a link), at each call, and kept in memory for that call alone. The token and
 * the account id never enter a record, a receipt, a log line, an error message or anything a page or canvas could read:
 * every word that leaves a call goes through redactSecrets. A SystemOne address may be http:// only to this computer.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { redactToken } from '../cloud/token.js';
import { timmyHome } from '../setup/home.js';
import { scrubHomes, tildePath } from '../utils/home-scrub.js';
import { redactString } from '../utils/redact.js';

export type ClefTransportSetting = 'workers-ai' | 'systemone' | 'none';

export type Billing = 'per-request' | 'per-question';
/** Pricing as the operator declares it in clef.json; absent, the pricing is unknown. */
export type PricingSetting = { usd_per_million_input: number; billing: Billing } | { free: 'local' };
/** A model's limits as the operator states them (Clef-Omni's published limits apply to Clef-Omni whatever these say). */
export interface LimitsSetting { questions?: number; context_tokens?: number }

export interface ClefConfig {
  transport: ClefTransportSetting;
  account_id?: string;
  token_file?: string;
  systemone_url?: string;
  /** The model as the endpoint names it: required for systemone; workers-ai's default is @cf/cloudflare/clef-omni. */
  model?: string;
  pricing?: PricingSetting;
  limits?: LimitsSetting;
}

/** A model name as an endpoint gives it (an Ollama tag such as clef-flash:latest, hf.co/org/name:Q4_K_M, @cf/ns/name). */
export const MODEL_NAME = /^[A-Za-z0-9@][A-Za-z0-9@._:/+-]{0,199}$/;
/** A Workers AI model id (the REST path takes it): @cf/<namespace>/<name>. */
export const WORKERS_AI_MODEL = /^@cf\/[A-Za-z0-9._-]{1,80}\/[A-Za-z0-9._-]{1,120}$/;
/** The most a declared price may be, per million input tokens: a number above it is a mistake, never a price. */
export const MAX_USD_PER_MILLION = 10_000;
export const PRICING_SHAPES = '{"free": "local"} or {"usd_per_million_input": <dollars>, "billing": "per-request" | "per-question"}';

/** The declared pricing as clef.json has it, checked; or why it cannot be used. Nothing is assumed for what is not there. */
export function checkPricing(v: unknown): { pricing: PricingSetting } | { why: string } {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return { why: `pricing must be ${PRICING_SHAPES}` };
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o).sort().join(',');
  if (keys === 'free') {
    return o.free === 'local' ? { pricing: { free: 'local' } } : { why: `pricing.free must be "local" (the endpoint runs the model on hardware you control, at no per-call charge), not ${JSON.stringify(o.free)}` };
  }
  if (keys === 'billing,usd_per_million_input') {
    const n = o.usd_per_million_input;
    if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0 || n > MAX_USD_PER_MILLION) {
      return { why: `pricing.usd_per_million_input must be dollars above 0 and at most ${MAX_USD_PER_MILLION} (a price of 0 is not a price: an endpoint that charges nothing is declared {"free": "local"})` };
    }
    if (o.billing !== 'per-request' && o.billing !== 'per-question') return { why: `pricing.billing must be "per-request" or "per-question", not ${JSON.stringify(o.billing ?? null)}` };
    return { pricing: { usd_per_million_input: n, billing: o.billing } };
  }
  return { why: `pricing must be ${PRICING_SHAPES}, and nothing else (it has ${keys ? keys.split(',').join(', ') : 'no fields'})` };
}

/** Stated limits, checked: 2 to 64 questions a request (one choice question and human_review at least), a positive context. */
export function checkLimits(v: unknown): { limits: LimitsSetting } | { why: string } {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return { why: 'limits must be {"questions"?: 2 to 64, "context_tokens"?: tokens}' };
  const o = v as Record<string, unknown>;
  const extra = Object.keys(o).filter((k) => k !== 'questions' && k !== 'context_tokens');
  if (extra.length) return { why: `limits has ${extra.join(', ')}: only questions and context_tokens are read` };
  const out: LimitsSetting = {};
  if (o.questions !== undefined) {
    if (!Number.isInteger(o.questions) || (o.questions as number) < 2 || (o.questions as number) > 64) return { why: 'limits.questions must be a whole number from 2 to 64 (a request holds one choice question and human_review at least)' };
    out.questions = o.questions as number;
  }
  if (o.context_tokens !== undefined) {
    if (!Number.isInteger(o.context_tokens) || (o.context_tokens as number) < 1 || (o.context_tokens as number) > 10_000_000) return { why: 'limits.context_tokens must be a whole number of tokens from 1 to 10,000,000' };
    out.context_tokens = o.context_tokens as number;
  }
  return { limits: out };
}

/** A Cloudflare account id as the REST path takes it (letters and digits; long enough to be taken out of any text). */
export const ACCOUNT_ID = /^[A-Za-z0-9]{8,64}$/;

type Env = Record<string, string | undefined>;

export const clefConfigPath = (env: Env = process.env): string => join(timmyHome(env), 'decision', 'clef.json');

export type ClefConfigRead =
  | { state: 'configured'; config: ClefConfig; path: string }
  | { state: 'none yet' | 'off' | 'unreadable' | 'invalid'; why: string; path: string };

const LOOPBACK = new Set(['127.0.0.1', '[::1]', '::1', 'localhost']);

/** Whether an address's host is this computer. */
export const isLoopbackUrl = (url: string): boolean => {
  try { return LOOPBACK.has(new URL(url).hostname); } catch { return false; }
};

/** A SystemOne base address as kept (origin and path, no trailing slash), or why it is refused. Never echoes credentials. */
export function checkSystemOneUrl(raw: string): { url: string } | { why: string } {
  let u: URL;
  try { u = new URL(raw); } catch { return { why: 'systemone_url is not an address (http://127.0.0.1:<port>, or https://<host>)' }; }
  if (u.username || u.password) return { why: 'systemone_url holds a user name or password: give the address alone, and a token in token_file' };
  if (u.search || u.hash) return { why: 'systemone_url has a query or a fragment: give the base address alone' };
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { why: `systemone_url uses ${u.protocol}, not http: or https:` };
  if (u.protocol === 'http:' && !LOOPBACK.has(u.hostname)) return { why: 'systemone_url uses http:// to another computer: http:// is allowed only to this computer (127.0.0.1, ::1, localhost); use https://' };
  return { url: `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}` };
}

const expandHome = (p: string): string => (p === '~' ? homedir() : p.startsWith('~/') ? join(homedir(), p.slice(2)) : p);

/** Clef's config as the operator wrote it, checked; never reads the token itself. */
export function readClefConfig(env: Env = process.env): ClefConfigRead {
  const path = clefConfigPath(env);
  const shown = tildePath(path);
  let raw: string;
  try { raw = readFileSync(path, 'utf8'); } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return code === 'ENOENT'
      ? { state: 'none yet', why: `no decision model is set up: no ${shown} (transport workers-ai or systemone)`, path }
      : { state: 'unreadable', why: `${shown} cannot be read (${code ?? 'error'})`, path };
  }
  let v: Record<string, unknown>;
  try {
    v = JSON.parse(raw) as Record<string, unknown>;
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('not an object');
  } catch {
    return { state: 'unreadable', why: `${shown} is not a JSON object`, path };
  }
  const bad = (why: string): ClefConfigRead => ({ state: 'invalid', why: `${shown}: ${why}`, path });
  const transport = v.transport;
  if (transport === 'none') return { state: 'off', why: `the decision model is turned off in ${shown} (transport "none")`, path };
  let tokenFile: string | undefined;
  if (v.token_file !== undefined) {
    if (typeof v.token_file !== 'string' || !v.token_file.trim()) return bad('token_file must be the path of the token file');
    tokenFile = expandHome(v.token_file.trim());
    if (!isAbsolute(tokenFile)) return bad('token_file must be an absolute path (or start with ~/)');
  }
  // R9 (H162): the model, its declared pricing and its stated limits, each checked; none is ever assumed
  let declared: Pick<ClefConfig, 'pricing' | 'limits'> = {};
  if (v.pricing !== undefined) {
    const pr = checkPricing(v.pricing);
    if ('why' in pr) return bad(pr.why);
    declared = { pricing: pr.pricing };
  }
  if (v.limits !== undefined) {
    const li = checkLimits(v.limits);
    if ('why' in li) return bad(li.why);
    declared = { ...declared, limits: li.limits };
  }
  if (v.model !== undefined && (typeof v.model !== 'string' || !MODEL_NAME.test(v.model.trim()))) {
    return bad('model must be the model\'s name as the endpoint gives it: letters, digits and @ . _ : / + -, 200 at most');
  }
  const model = typeof v.model === 'string' ? v.model.trim() : undefined;
  if (transport === 'workers-ai') {
    if (typeof v.account_id !== 'string' || !ACCOUNT_ID.test(v.account_id)) return bad('workers-ai needs account_id: the Cloudflare account id, 8 to 64 letters and digits');
    if (!tokenFile) return bad('workers-ai needs token_file: a file of yours (0600) holding an API token with Workers AI access');
    if (model !== undefined && !WORKERS_AI_MODEL.test(model)) return bad(`workers-ai's model must be a Workers AI model id (@cf/<namespace>/<name>), not ${JSON.stringify(model)}`);
    if (declared.pricing && 'free' in declared.pricing) return bad('workers-ai runs on Cloudflare\'s hardware, not yours: {"free": "local"} cannot be declared for it; declare its price');
    return { state: 'configured', config: { transport, account_id: v.account_id, token_file: tokenFile, ...(model ? { model } : {}), ...declared }, path };
  }
  if (transport === 'systemone') {
    if (typeof v.systemone_url !== 'string') return bad('systemone needs systemone_url: the deployment\'s base address');
    const u = checkSystemOneUrl(v.systemone_url);
    if ('why' in u) return bad(u.why);
    if (!model) return bad('systemone needs model: the model the deployment serves, as it names it (for example clef-flash:latest); Timmy never assumes one');
    return { state: 'configured', config: { transport, systemone_url: u.url, model, ...(tokenFile ? { token_file: tokenFile } : {}), ...declared }, path };
  }
  return bad(`transport must be "workers-ai", "systemone" or "none", not ${JSON.stringify(transport ?? null)}`);
}

/**
 * `text` with the token and the account id taken out in every form they could take (as is, JSON-escaped, URL-encoded,
 * base64), then any other key-shaped string (src/utils/redact.ts) and home folders (written from ~).
 */
export function redactSecrets(text: string, s: { token?: string; accountId?: string }): string {
  let out = redactToken(text, s.token);
  const id = s.accountId;
  if (id && id.length >= 8) {
    const forms = [id, JSON.stringify(id).slice(1, -1), encodeURIComponent(id), Buffer.from(id, 'utf8').toString('base64')];
    for (const f of [...new Set(forms)].filter((x) => x.length >= 8).sort((a, b) => b.length - a.length)) out = out.split(f).join('[REDACTED_ACCOUNT_ID]');
  }
  return scrubHomes(redactString(out));
}
