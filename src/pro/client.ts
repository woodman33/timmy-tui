// HttpProService: the ProService port (ports.ts) over the Pro worker's JSON routes.
//
// Every answer is checked for shape before use, every failure becomes one
// ProServiceError kind here and nowhere else, redirects are never followed, and
// claims inside a token are never read here: the manager verifies the token.

import type { ClaimResult, ProService } from './ports.js';
import { ProServiceError } from './ports.js';
import { isProErrorCode, type ProErrorCode } from './protocol.js';
import { isLoopbackHttp } from './settings.js';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const DEFAULT_TIMEOUT_MS = 15_000;

export class HttpProService implements ProService {
  constructor(
    private readonly baseUrl: string,
    private readonly fetchImpl: FetchLike = (input, init) => fetch(input, init),
    private readonly timeoutMs: number = DEFAULT_TIMEOUT_MS,
  ) {}

  async startCheckout(): Promise<{ url: string; sessionId: string }> {
    const { data, status } = await this.post('/checkout', { source: 'cli' });
    return { url: this.link(data, 'url', status), sessionId: field(data, 'session_id', status) };
  }

  async claim(sessionId: string): Promise<ClaimResult> {
    const { data, status } = await this.post('/license/claim', { session_id: sessionId });
    if (status === 202 || data.status === 'pending') return { state: 'pending' };
    if (data.status === 'expired') return { state: 'expired' };
    return { state: 'ready', key: field(data, 'key', status), token: field(data, 'token', status) };
  }

  async activate(key: string): Promise<{ token: string }> {
    const { data, status } = await this.post('/license/activate', { key });
    return { token: field(data, 'token', status) };
  }

  async rotate(key: string): Promise<{ key: string }> {
    const { data, status } = await this.post('/license/rotate', { key });
    return { key: field(data, 'key', status) };
  }

  async billingUrl(): Promise<string> {
    const { data, status } = await this.post('/billing', {});
    return this.link(data, 'url', status);
  }

  private async post(path: string, body: unknown): Promise<{ status: number; data: Record<string, unknown> }> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body),
        // A redirect could carry the license key off the configured https origin.
        redirect: 'manual',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      const timedOut = (error as { name?: unknown } | null)?.name === 'TimeoutError';
      throw new ProServiceError(timedOut ? 'the Pro service did not answer in time' : 'could not reach the Pro service', 'unreachable');
    }
    if (response.status >= 300 && response.status < 400) {
      throw new ProServiceError('the Pro service answered with a redirect, which Timmy does not follow', 'unexpected_response', { httpStatus: response.status });
    }
    const data: unknown = await response.json().catch(() => null);
    if (!response.ok) throw failure(response.status, data);
    if (!isRecord(data)) throw unexpectedResponse(response.status);
    return { status: response.status, data };
  }

  /** A link the CLI may hand to a browser opener: https, or plain http only when the service itself is on loopback http. */
  private link(data: Record<string, unknown>, name: string, status: number): string {
    let url: URL;
    try {
      url = new URL(field(data, name, status));
    } catch {
      throw unexpectedResponse(status);
    }
    if (url.protocol === 'https:' || (isLoopbackHttp(new URL(this.baseUrl)) && isLoopbackHttp(url))) return url.href;
    throw new ProServiceError('the Pro service sent a link that is not https', 'unexpected_response', { httpStatus: status });
  }
}

/** The one place an HTTP answer becomes a failure kind. Only the Pro service's own coded JSON counts as a refusal. */
function failure(status: number, data: unknown): ProServiceError {
  const message = isRecord(data) && typeof data.error === 'string' && data.error ? data.error : `the Pro service answered HTTP ${status}`;
  const code: ProErrorCode | null = isRecord(data) && isProErrorCode(data.code) ? data.code : null;
  const details = { code, httpStatus: status };
  if (status === 429 || code === 'rate_limited') {
    return new ProServiceError('too many requests to the Pro service; wait a minute and try again', 'rate_limited', details);
  }
  if (code === 'unavailable' || code === 'payment_provider_error' || code === 'internal_error') {
    return new ProServiceError(message, 'server_error', details);
  }
  if (code === 'subscription_inactive' || code === 'key_already_issued') {
    const subscriptionStatus = isRecord(data) && typeof data.status === 'string' ? data.status : null;
    return new ProServiceError(message, 'refused', { ...details, subscriptionStatus });
  }
  if (code) return new ProServiceError(message, 'refused', details);
  return new ProServiceError(message, status >= 500 ? 'server_error' : 'unexpected_response', { httpStatus: status });
}

function field(data: Record<string, unknown>, name: string, status: number): string {
  const value = data[name];
  if (typeof value !== 'string' || !value) throw unexpectedResponse(status);
  return value;
}

const unexpectedResponse = (status: number) => new ProServiceError('unexpected response from the Pro service', 'unexpected_response', { httpStatus: status });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
