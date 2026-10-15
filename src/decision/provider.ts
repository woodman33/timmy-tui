/**
 * Round R4 (H120): ClefOmniProvider, the one decision provider, behind three transports:
 *
 *   workers-ai   POST https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/run/@cf/cloudflare/clef-omni with
 *                `Authorization: Bearer <token>`: Cloudflare's hosted model; paid, and off this computer
 *   systemone    POST {systemone_url}/v1/systemone: a self-hosted, Jev/SystemOne-compatible deployment (the model card says
 *                it takes the same body and gives the same answer); free; local when its host is 127.0.0.1, ::1 or localhost
 *   fixture      reads a response file named for the call (tests and the offline slice only); free and local
 *
 * The same body goes to each (src/decision/clef-contract.ts), and every answer passes the same checks: unwrapBody (an
 * envelope or a bare body) and checkAnswer (the published schema, against the questions asked). HTTP non-2xx, a network
 * error, a timeout (an AbortController, settings.timeoutMs), an envelope that failed or any schema problem is a
 * ProviderFailure {unavailable | timeout | malformed}, in words; nothing is repaired or retried here.
 *
 * The operator's rule it keeps: this provider only scores options. It is never OpenRouter and never a chat or
 * text-generation wrapper. `fetch` is injected (default: globalThis.fetch, looked up at each call). The token is read with
 * readTokenFile at each call and never kept; the token and the account id never leave a call: every word and every kept
 * response body goes through redactSecrets, and a description names the kind of endpoint, never its address. A fixture's
 * bytes are never kept (only their sha256 and size). `baseUrl` is an internal override for tests only (a FAKE endpoint on
 * 127.0.0.1); the default stays https://api.cloudflare.com, and no config file can set it.
 */
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { readTokenFile } from '../cloud/token.js';
import { tildePath } from '../utils/home-scrub.js';
import { checkAnswer, CLEF_OMNI_MODEL, CLEF_OMNI_MODEL_ID, unwrapBody, type ClefRequest } from './clef-contract.js';
import { checkSystemOneUrl, isLoopbackUrl, redactSecrets, type ClefConfig, type ClefConfigRead } from './config.js';
import type {
  DecisionProvider, ProviderAnswer, ProviderCallOptions, ProviderDescription, ProviderFailure, RawRef, TransportKind,
} from './types.js';

export type { DecisionProvider, ProviderAnswer, ProviderDescription, ProviderFailure } from './types.js';

export const WORKERS_AI_BASE = 'https://api.cloudflare.com';
export const workersAiPath = (accountId: string): string => `/client/v4/accounts/${encodeURIComponent(accountId)}/ai/run/${CLEF_OMNI_MODEL_ID}`;
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

export class ClefOmniProvider implements DecisionProvider {
  readonly id: string;

  constructor(private readonly o: ClefProviderOptions) {
    this.id = `clef-omni:${o.transport}`;
  }

  describe(): ProviderDescription {
    const { transport, config } = this.o;
    if (transport === 'fixture') return { id: this.id, available: true, transport, endpoint: 'fixture-file', model: CLEF_OMNI_MODEL, paid: false, local: true };
    if (transport === 'workers-ai') {
      const d: ProviderDescription = { id: this.id, available: true, transport, endpoint: 'workers-ai-rest', model: CLEF_OMNI_MODEL_ID, paid: true, local: false };
      if (!config?.account_id) return { ...d, available: false, reason: 'Workers AI needs an account id in clef.json' };
      if (!config.token_file) return { ...d, available: false, reason: 'Workers AI needs a token_file in clef.json' };
      return d;
    }
    const url = config?.systemone_url ? checkSystemOneUrl(config.systemone_url) : { why: 'SystemOne needs systemone_url in clef.json' };
    const local = 'url' in url && isLoopbackUrl(url.url);
    const d: ProviderDescription = { id: this.id, available: true, transport, endpoint: local ? 'systemone-loopback' : 'systemone-remote', model: CLEF_OMNI_MODEL, paid: false, local };
    return 'why' in url ? { ...d, available: false, reason: url.why } : d;
  }

  async decide(request: ClefRequest, o: ProviderCallOptions): Promise<ProviderAnswer | ProviderFailure> {
    return this.o.transport === 'fixture' ? this.fromFixture(request, o) : this.overHttp(request, o);
  }

  private settle(body: unknown, request: ClefRequest, started: number, raw: RawRef, secrets: { token?: string; accountId?: string }): ProviderAnswer | ProviderFailure {
    const fail = (kind: ProviderFailure['kind'], reason: string): ProviderFailure => ({ ok: false, kind, reason: redactSecrets(reason, secrets), latencyMs: Date.now() - started, raw });
    const u = unwrapBody(body);
    if (!u.ok) return fail(/success=false/.test(u.problem) ? 'unavailable' : 'malformed', u.problem);
    const c = checkAnswer(u.response, request.questions);
    if (!c.ok) return fail('malformed', `the answer does not match the published schema: ${c.problems.join('; ')}`);
    return { ok: true, response: c.response, usageReported: c.usageReported, latencyMs: Date.now() - started, raw };
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
    return this.settle(body, request, started, raw, {});
  }

  private async overHttp(request: ClefRequest, o: ProviderCallOptions): Promise<ProviderAnswer | ProviderFailure> {
    const started = Date.now();
    const desc = this.describe();
    const config = this.o.config ?? ({} as ClefConfig);
    const secrets: { token?: string; accountId?: string } = { accountId: config.account_id };
    const fail = (kind: ProviderFailure['kind'], reason: string, raw?: RawRef): ProviderFailure =>
      ({ ok: false, kind, reason: redactSecrets(reason, secrets), latencyMs: Date.now() - started, ...(raw ? { raw } : {}) });
    if (!desc.available) return fail('unavailable', desc.reason ?? 'the transport is not set up');
    if (config.token_file) {
      const t = readTokenFile(config.token_file);
      if (!t.ok) return fail('unavailable', t.why);
      secrets.token = t.token;
    }
    const url = this.o.transport === 'workers-ai'
      ? `${(this.o.baseUrl ?? WORKERS_AI_BASE).replace(/\/+$/, '')}${workersAiPath(config.account_id ?? '')}`
      : `${config.systemone_url}${SYSTEMONE_PATH}`;
    const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json' };
    if (secrets.token) headers.authorization = `Bearer ${secrets.token}`;

    const ac = new AbortController();
    let timedOut = false;
    let cancelled = false;
    const timer = setTimeout(() => { timedOut = true; ac.abort(); }, o.timeoutMs);
    const onCancel = (): void => { cancelled = true; ac.abort(); };
    if (o.signal?.aborted) onCancel();
    o.signal?.addEventListener('abort', onCancel, { once: true });
    // a fetch that ignores the signal still cannot hold the decision past its timeout
    const aborted = new Promise<never>((_resolve, reject) => { ac.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }); });
    aborted.catch(() => { /* settled through the race below */ });
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
    return this.settle(body, request, started, raw, secrets);
  }
}

/** A provider that is not there: every call is refused with why (no config, transport "none", a config that cannot be used). */
export class UnavailableProvider implements DecisionProvider {
  readonly id = 'clef-omni:none';

  constructor(private readonly why: string) {}

  describe(): ProviderDescription {
    return { id: this.id, available: false, reason: this.why, transport: 'none', model: CLEF_OMNI_MODEL, paid: false, local: true };
  }

  async decide(): Promise<ProviderFailure> {
    return { ok: false, kind: 'unavailable', reason: this.why, latencyMs: 0 };
  }
}

/** The provider the operator configured in clef.json, or one that says why there is none. */
export function providerFromConfig(read: ClefConfigRead, o: { fetch?: typeof fetch; baseUrl?: string } = {}): DecisionProvider {
  if (read.state !== 'configured') return new UnavailableProvider(read.why);
  if (read.config.transport === 'none') return new UnavailableProvider('Clef is turned off in clef.json');
  return new ClefOmniProvider({ transport: read.config.transport, config: read.config, fetch: o.fetch, baseUrl: o.baseUrl });
}
