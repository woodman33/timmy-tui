/**
 * Round R4 (H120): the decision provider, behind three transports:
 *
 *   workers-ai   POST https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/run/{model} with
 *                `Authorization: Bearer <token>`: Cloudflare's hosted service, off this computer (model default
 *                @cf/cloudflare/clef-omni)
 *   systemone    POST {systemone_url}/v1/systemone: a SystemOne-compatible deployment serving the model clef.json names
 *                (the Clef-Omni model card says it takes the same body and gives the same answer); local only when its host
 *                is 127.0.0.1, ::1 or localhost and its model tag is not a cloud tag
 *   fixture      reads a response file named for the call (tests and the offline slice only): no service, no charge
 *
 * R9 (H162): the provider names its model (`<transport>:<model>`, systemone:clef-flash:latest; "clef-omni" only when
 * Clef-Omni is the model), sends that model in the body, and describes the pricing as clef.json declares it
 * (src/decision/pricing.ts): free only for a declared {"free": "local"}, never because of the transport's name, a
 * self-hosted label or a loopback address. The service refuses before any byte is sent what the pricing does not allow.
 *
 * The same body goes to each (src/decision/clef-contract.ts), and every answer passes the same checks: unwrapBody (an
 * envelope or a bare body) and checkAnswer (the published schema, against the questions asked). HTTP non-2xx, a network
 * error, a timeout (an AbortController, settings.timeoutMs), an envelope that failed or any schema problem is a
 * ProviderFailure {unavailable | timeout | malformed}, in words; nothing is repaired or retried here.
 *
 * The operator's rule it keeps: this provider only scores options. It is never OpenRouter and never a chat or
 * text-generation wrapper: the only paths it ever asks are the scoring path above (and, R9, Ollama's read-only model list,
 * GET /api/tags, for a local digest). `fetch` is injected (default: globalThis.fetch, looked up at each call). The token is
 * read with readTokenFile at each call and never kept; the token and the account id never leave a call: every word and
 * every kept response body goes through redactSecrets, and a description names the kind of endpoint, never its address. A
 * fixture's bytes are never kept (only their sha256 and size). `baseUrl` is an internal override for tests only (a FAKE
 * endpoint on 127.0.0.1); the default stays https://api.cloudflare.com, and no config file can set it.
 */
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { readTokenFile } from '../cloud/token.js';
import { tildePath } from '../utils/home-scrub.js';
import { checkAnswer, CLEF_OMNI_MODEL, CLEF_OMNI_MODEL_ID, unwrapBody, type ClefRequest } from './clef-contract.js';
import { checkSystemOneUrl, isLoopbackUrl, redactSecrets, type ClefConfig, type ClefConfigRead } from './config.js';
import { FIXTURE_PRICING, isClefOmni, isCloudModel, limitsOf, pricingOf, type ModelLimits } from './pricing.js';
import { boundedText } from '../setup/ollama-models.js';
import type {
  DecisionProvider, ObservedIdentity, ProviderAnswer, ProviderCallOptions, ProviderDescription, ProviderFailure, RawRef, TransportKind,
} from './types.js';

export type { DecisionProvider, ProviderAnswer, ProviderDescription, ProviderFailure } from './types.js';

export const WORKERS_AI_BASE = 'https://api.cloudflare.com';
export const workersAiPath = (accountId: string, model: string = CLEF_OMNI_MODEL_ID): string => `/client/v4/accounts/${encodeURIComponent(accountId)}/ai/run/${model}`;
export const SYSTEMONE_PATH = '/v1/systemone';

/** An answer larger than this is refused unread. */
export const MAX_ANSWER_BYTES = 1024 * 1024;
/** A fixture larger than this is refused unread. */
export const MAX_FIXTURE_BYTES = 4 * 1024 * 1024;
/** A response body is kept (redacted) in the record only up to this many characters; above it, only its sha256 and size. */
export const KEEP_BODY_CHARS = 4096;

export interface ClefProviderOptions {
  transport: TransportKind;
  config?: ClefConfig;
  fetch?: typeof fetch;
  /** Internal, tests only: where the Workers AI REST API is (default https://api.cloudflare.com). */
  baseUrl?: string;
}

const sha256 = (s: string | Buffer): string => createHash('sha256').update(s).digest('hex');

/** A response as a record keeps it: the sha256 and size of its redacted text, and that text when it is small. */
export function rawOf(text: string, secrets: { token?: string; accountId?: string }): RawRef {
  const redacted = redactSecrets(text, secrets);
  const bytes = Buffer.byteLength(redacted, 'utf8');
  return { sha256: sha256(redacted), bytes, ...(redacted.length <= KEEP_BODY_CHARS ? { body: redacted } : {}) };
}

/** The model a transport asks for: the config's (Workers AI's default is Clef-Omni; the fixture's FAKE answers are in Clef-Omni's shape). */
export function modelOf(transport: TransportKind, config?: ClefConfig): string {
  if (transport === 'fixture') return CLEF_OMNI_MODEL;
  if (transport === 'workers-ai') return config?.model ?? CLEF_OMNI_MODEL_ID;
  return config?.model ?? '';
}

/** R9 (H162): the most a model list from GET /api/tags is read, and how long it may take (it is never retried). */
export const MAX_TAGS_BYTES = 2 * 1024 * 1024;
export const TAGS_TIMEOUT_MS = 2000;
/** A digest as Ollama lists it: a sha256, bare or prefixed. */
const DIGEST = /^(?:sha256:)?[0-9a-f]{64}$/i;
const notAvailable = (why: string): Pick<ObservedIdentity, 'digest' | 'digest_source'> => ({ digest: 'not available', digest_source: why });

/** The same model under Ollama's naming: a name without a tag is its :latest. */
export const sameModel = (a: string, b: string): boolean => {
  const x = a.trim();
  const y = b.trim();
  return x === y || x === `${y}:latest` || y === `${x}:latest`;
};

/** The answer's top-level fields that name a version, as received (at most 4, each at most 200 characters, redacted). */
function versionFields(r: unknown, secrets: { token?: string; accountId?: string }): Record<string, string> | undefined {
  if (!r || typeof r !== 'object' || Array.isArray(r)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(r as Record<string, unknown>)) {
    if (!/version/i.test(k) || k.length > 64 || (typeof v !== 'string' && typeof v !== 'number')) continue;
    out[redactSecrets(k, secrets)] = redactSecrets(String(v), secrets).slice(0, 200);
    if (Object.keys(out).length >= 4) break;
  }
  return Object.keys(out).length ? out : undefined;
}

/** The limits of a provider that cannot be asked: none apply, so the fewest. */
const NO_MODEL_LIMITS: ModelLimits = Object.freeze({ source: 'default', questions: 2, media: false, words: 'no decision model is set up' }) as ModelLimits;

export class ClefOmniProvider implements DecisionProvider {
  readonly id: string;

  constructor(private readonly o: ClefProviderOptions) {
    // R9 (H162): the id names the model: workers-ai:@cf/cloudflare/clef-omni, systemone:clef-flash:latest, fixture:clef-omni
    this.id = `${o.transport}:${modelOf(o.transport, o.config) || 'no-model'}`;
  }

  describe(): ProviderDescription {
    const { transport, config } = this.o;
    const model = modelOf(transport, config);
    if (transport === 'fixture') {
      return {
        id: this.id, available: true, transport, endpoint: 'fixture-file', model, requestModel: model, paid: false, local: true, cloudModel: false,
        pricing: FIXTURE_PRICING, limits: limitsOf(model),
      };
    }
    if (transport === 'workers-ai') {
      const pricing = pricingOf(model, config?.pricing, { workersAi: true });
      const d: ProviderDescription = {
        id: this.id, available: true, transport, endpoint: 'workers-ai-rest', model, requestModel: isClefOmni(model) ? CLEF_OMNI_MODEL : model,
        paid: pricing.kind !== 'free-local', local: false, cloudModel: false, pricing, limits: limitsOf(model, config?.limits),
      };
      if (!config?.account_id) return { ...d, available: false, reason: 'Workers AI needs an account id in clef.json' };
      if (!config.token_file) return { ...d, available: false, reason: 'Workers AI needs a token_file in clef.json' };
      return d;
    }
    const url = config?.systemone_url ? checkSystemOneUrl(config.systemone_url) : { why: 'SystemOne needs systemone_url in clef.json' };
    const loopback = 'url' in url && isLoopbackUrl(url.url);
    const cloudModel = model !== '' && isCloudModel(model);
    const pricing = model ? pricingOf(model, config?.pricing) : { kind: 'unknown' as const, why: 'no model is named', words: 'unknown: no model is named' };
    const d: ProviderDescription = {
      id: this.id, available: true, transport, endpoint: loopback ? 'systemone-loopback' : 'systemone-remote', model: model || 'no-model', requestModel: model,
      // a loopback address is this computer; a cloud model tag sends what it is given to a cloud from there too
      paid: pricing.kind !== 'free-local', local: loopback && !cloudModel, cloudModel, pricing, limits: model ? limitsOf(model, config?.limits) : NO_MODEL_LIMITS,
    };
    if ('why' in url) return { ...d, available: false, reason: url.why };
    if (!model) return { ...d, available: false, reason: 'SystemOne needs model in clef.json: the model the deployment serves, as it names it' };
    return d;
  }

  async decide(request: ClefRequest, o: ProviderCallOptions): Promise<ProviderAnswer | ProviderFailure> {
    return this.o.transport === 'fixture' ? this.fromFixture(request, o) : this.overHttp(request, o);
  }

  private settle(body: unknown, request: ClefRequest, started: number, raw: RawRef, secrets: { token?: string; accountId?: string }, digest: Pick<ObservedIdentity, 'digest' | 'digest_source'>): ProviderAnswer | ProviderFailure {
    const u = unwrapBody(body);
    // R9 (H162): the model and the version fields the answer names, as received (redacted), kept with whatever follows
    const said = u.ok && u.response && typeof u.response === 'object' ? u.response as Record<string, unknown> : undefined;
    const returned = typeof said?.model === 'string' && said.model.trim() ? redactSecrets(said.model.trim(), secrets).slice(0, 200) : undefined;
    const version = versionFields(said, secrets);
    const identity: ObservedIdentity = { ...digest, ...(returned ? { returned } : {}), ...(version ? { version } : {}) };
    const fail = (kind: ProviderFailure['kind'], reason: string): ProviderFailure => ({ ok: false, kind, reason: redactSecrets(reason, secrets), latencyMs: Date.now() - started, raw, identity });
    if (!u.ok) return fail(/success=false/.test(u.problem) ? 'unavailable' : 'malformed', u.problem);
    const c = checkAnswer(u.response, request.questions);
    if (!c.ok) return fail('malformed', `the answer does not match the published schema: ${c.problems.join('; ')}`);
    return { ok: true, response: c.response, usageReported: c.usageReported, latencyMs: Date.now() - started, raw, identity };
  }

  /**
   * R9 (H162): the model's local digest, read before the call from Ollama's model list (GET /api/tags at the endpoint's own
   * origin: read-only, no inference, no token sent, bounded in size and time), only for a SystemOne endpoint on this computer.
   * Anything else, or a list that does not name the model with a sha256, is "not available", with why; never invented.
   */
  private async localDigest(desc: ProviderDescription, f: typeof fetch, o: ProviderCallOptions): Promise<Pick<ObservedIdentity, 'digest' | 'digest_source'>> {
    if (this.o.transport !== 'systemone') return notAvailable('Workers AI is Cloudflare\'s hosted service: there is no local digest');
    if (desc.endpoint !== 'systemone-loopback') return notAvailable('the endpoint is not on this computer, so there is no local digest to read');
    let origin: string;
    try { origin = new URL(this.o.config?.systemone_url ?? '').origin; } catch { return notAvailable('the endpoint\'s address cannot be read'); }
    const timer = AbortSignal.timeout(Math.min(TAGS_TIMEOUT_MS, o.timeoutMs));
    const signal = o.signal ? AbortSignal.any([o.signal, timer]) : timer;
    const said = 'the endpoint on this computer';
    let res: Response;
    try { res = await f(`${origin}/api/tags`, { method: 'GET', headers: { accept: 'application/json' }, signal, redirect: 'error' }); } catch {
      return notAvailable(timer.aborted ? `${said} did not list its models (GET /api/tags) within ${Math.min(TAGS_TIMEOUT_MS, o.timeoutMs)} ms` : `${said} did not answer GET /api/tags`);
    }
    if (!res.ok) return notAvailable(`${said} answered GET /api/tags with HTTP ${res.status}: it does not list models as Ollama does`);
    let models: unknown;
    try { models = (JSON.parse(await boundedText(res, MAX_TAGS_BYTES)) as { models?: unknown })?.models; } catch {
      return notAvailable(`${said} answered GET /api/tags with something that is not Ollama's list of models`);
    }
    if (!Array.isArray(models)) return notAvailable(`${said} answered GET /api/tags without a list of models, as Ollama gives one`);
    const entry = models.find((m) => m && typeof m === 'object' && [(m as { name?: unknown }).name, (m as { model?: unknown }).model].some((n) => typeof n === 'string' && sameModel(n, desc.model))) as { digest?: unknown } | undefined;
    if (!entry) return notAvailable(`Ollama's list on this computer (GET /api/tags) does not name ${desc.model}`);
    if (typeof entry.digest !== 'string' || !DIGEST.test(entry.digest.trim())) return notAvailable(`Ollama's list on this computer names ${desc.model} without a sha256 digest`);
    return { digest: entry.digest.trim(), digest_source: 'Ollama\'s list on this computer (GET /api/tags; no inference)' };
  }

  private fromFixture(request: ClefRequest, o: ProviderCallOptions): ProviderAnswer | ProviderFailure {
    const started = Date.now();
    const fail = (kind: ProviderFailure['kind'], reason: string, raw?: RawRef): ProviderFailure => ({ ok: false, kind, reason, latencyMs: Date.now() - started, ...(raw ? { raw } : {}) });
    if (!o.fixture) return fail('unavailable', 'the fixture transport needs a fixture file, and none was named');
    const shown = tildePath(o.fixture);
    let size: number;
    try {
      const st = lstatSync(o.fixture);
      if (!st.isFile()) return fail('unavailable', `the fixture ${shown} is not a regular file`);
      size = st.size;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      return fail('unavailable', code === 'ENOENT' ? `the fixture ${shown} does not exist` : `the fixture ${shown} cannot be read (${code ?? 'error'})`);
    }
    if (size > MAX_FIXTURE_BYTES) return fail('malformed', `the fixture ${shown} is larger than ${MAX_FIXTURE_BYTES / 1024 / 1024} MiB`);
    let bytes: Buffer;
    try { bytes = readFileSync(o.fixture); } catch (e) { return fail('unavailable', `the fixture ${shown} cannot be read (${(e as NodeJS.ErrnoException).code ?? 'error'})`); }
    // a fixture's bytes are never kept: only their digest and size
    const raw: RawRef = { sha256: sha256(bytes), bytes: bytes.length };
    let body: unknown;
    try { body = JSON.parse(bytes.toString('utf8')); } catch { return fail('malformed', `the fixture ${shown} is not JSON`, raw); }
    return this.settle(body, request, started, raw, {}, notAvailable('a fixture file answered: no model, so no digest'));
  }

  private async overHttp(request: ClefRequest, o: ProviderCallOptions): Promise<ProviderAnswer | ProviderFailure> {
    const started = Date.now();
    const desc = this.describe();
    const config = this.o.config ?? ({} as ClefConfig);
    const secrets: { token?: string; accountId?: string } = { accountId: config.account_id };
    let observed: Pick<ObservedIdentity, 'digest' | 'digest_source'> | undefined;
    const fail = (kind: ProviderFailure['kind'], reason: string, raw?: RawRef): ProviderFailure =>
      ({ ok: false, kind, reason: redactSecrets(reason, secrets), latencyMs: Date.now() - started, ...(raw ? { raw } : {}), ...(observed ? { identity: observed } : {}) });
    if (!desc.available) return fail('unavailable', desc.reason ?? 'the transport is not set up');
    if (config.token_file) {
      const t = readTokenFile(config.token_file);
      if (!t.ok) return fail('unavailable', t.why);
      secrets.token = t.token;
    }
    // R9 (H162): the local digest, before the call (nothing here is inference; only the scoring path below is)
    const digest = await this.localDigest(desc, this.o.fetch ?? globalThis.fetch, o);
    observed = digest;
    const url = this.o.transport === 'workers-ai'
      ? `${(this.o.baseUrl ?? WORKERS_AI_BASE).replace(/\/+$/, '')}${workersAiPath(config.account_id ?? '', desc.model)}`
      : `${config.systemone_url}${SYSTEMONE_PATH}`;
    const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json' };
    if (secrets.token) headers.authorization = `Bearer ${secrets.token}`;

    const ac = new AbortController();
    let timedOut = false;
    let cancelled = false;
    // a fetch that ignores the signal still cannot hold the decision past its timeout (made before anything can abort)
    const aborted = new Promise<never>((_resolve, reject) => { ac.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }); });
    aborted.catch(() => { /* settled through the race below */ });
    const timer = setTimeout(() => { timedOut = true; ac.abort(); }, o.timeoutMs);
    const onCancel = (): void => { cancelled = true; ac.abort(); };
    if (o.signal?.aborted) onCancel();
    o.signal?.addEventListener('abort', onCancel, { once: true });
    const stopped = (e: unknown): ProviderFailure => {
      if (timedOut) return fail('timeout', `no answer within ${o.timeoutMs} ms`);
      if (cancelled) return fail('unavailable', 'the caller cancelled the call');
      return fail('unavailable', `network error: ${e instanceof Error ? e.message : String(e)}`);
    };
    let res: Response;
    let buf: ArrayBuffer;
    try {
      try {
        const f = this.o.fetch ?? globalThis.fetch;
        res = await Promise.race([f(url, { method: 'POST', headers, body: JSON.stringify(request), signal: ac.signal }), aborted]);
      } catch (e) { return stopped(e); }
      try { buf = await Promise.race([res.arrayBuffer(), aborted]); } catch (e) { return timedOut || cancelled ? stopped(e) : fail('unavailable', `the answer could not be read: ${e instanceof Error ? e.message : String(e)}`); }
    } finally {
      clearTimeout(timer);
      o.signal?.removeEventListener('abort', onCancel);
    }
    if (buf.byteLength > MAX_ANSWER_BYTES) return fail('malformed', `the answer is larger than ${MAX_ANSWER_BYTES / 1024 / 1024} MiB`, { sha256: sha256(Buffer.from(buf)), bytes: buf.byteLength });
    const text = Buffer.from(buf).toString('utf8');
    const raw = rawOf(text, secrets);
    let body: unknown;
    let parsed = true;
    try { body = JSON.parse(text); } catch { parsed = false; }
    if (!res.ok) {
      const said = parsed ? unwrapBody(body) : undefined;
      const words = said && !said.ok ? ` (${said.problem.replace(/^the service answered /, '').slice(0, 300)})` : '';
      return fail('unavailable', `the service answered HTTP ${res.status}${words}`, raw);
    }
    if (!parsed) return fail('malformed', 'the answer is not JSON', raw);
    return this.settle(body, request, started, raw, secrets, digest);
  }
}

/** A provider that is not there: every call is refused with why (no config, transport "none", a config that cannot be used). */
export class UnavailableProvider implements DecisionProvider {
  readonly id = 'none';

  constructor(private readonly why: string) {}

  describe(): ProviderDescription {
    return {
      id: this.id, available: false, reason: this.why, transport: 'none', model: 'none', requestModel: 'none', paid: false, local: true, cloudModel: false,
      pricing: { kind: 'no-call', words: 'no decision model is set up, so nothing is called' }, limits: NO_MODEL_LIMITS,
    };
  }

  async decide(): Promise<ProviderFailure> {
    return { ok: false, kind: 'unavailable', reason: this.why, latencyMs: 0 };
  }
}

/** The provider the operator configured in clef.json, or one that says why there is none. */
export function providerFromConfig(read: ClefConfigRead, o: { fetch?: typeof fetch; baseUrl?: string } = {}): DecisionProvider {
  if (read.state !== 'configured') return new UnavailableProvider(read.why);
  if (read.config.transport === 'none') return new UnavailableProvider('the decision model is turned off in clef.json');
  return new ClefOmniProvider({ transport: read.config.transport, config: read.config, fetch: o.fetch, baseUrl: o.baseUrl });
}
