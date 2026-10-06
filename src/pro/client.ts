// The `timmy pro` client's view of the Pro service (workers/pro).
//
// ProService is the port the license manager and CLI depend on; HttpProService
// speaks the worker's JSON routes. Every answer is checked for shape before use,
// and claims inside a token are never read here: the manager verifies the token.

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** A failed call to the Pro service. `status` is the HTTP status, or 0 when the service was not reached. */
export class ProServiceError extends Error {
  override name = 'ProServiceError';
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export type ClaimResult = { state: 'pending' } | { state: 'ready'; key: string; token: string };

export interface ProService {
  startCheckout(): Promise<{ url: string; sessionId: string }>;
  claim(sessionId: string): Promise<ClaimResult>;
  activate(key: string): Promise<{ token: string }>;
  rotate(key: string): Promise<{ key: string }>;
  billingUrl(): Promise<string>;
}

const DEFAULT_TIMEOUT_MS = 15_000;

export class HttpProService implements ProService {
  constructor(
    private readonly baseUrl: string,
    private readonly fetchImpl: FetchLike = (input, init) => fetch(input, init),
    private readonly timeoutMs: number = DEFAULT_TIMEOUT_MS,
  ) {}

  async startCheckout(): Promise<{ url: string; sessionId: string }> {
    const { data, status } = await this.post('/checkout', { source: 'cli' });
    return { url: field(data, 'url', status), sessionId: field(data, 'session_id', status) };
  }

  async claim(sessionId: string): Promise<ClaimResult> {
    const { data, status } = await this.post('/license/claim', { session_id: sessionId });
    if (status === 202 || data.status === 'pending') return { state: 'pending' };
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
    return field(data, 'url', status);
  }

  private async post(path: string, body: unknown): Promise<{ status: number; data: Record<string, unknown> }> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      const timedOut = (error as { name?: unknown } | null)?.name === 'TimeoutError';
      throw new ProServiceError(timedOut ? 'the Pro service did not answer in time' : 'could not reach the Pro service', 0);
    }
    const data: unknown = await response.json().catch(() => null);
    if (!response.ok) throw new ProServiceError(errorMessage(response.status, data), response.status);
    if (!isRecord(data)) throw unexpectedResponse(response.status);
    return { status: response.status, data };
  }
}

function errorMessage(status: number, data: unknown): string {
  if (status === 429) return 'too many requests to the Pro service; wait a minute and try again';
  if (isRecord(data) && typeof data.error === 'string' && data.error) return data.error;
  return `the Pro service answered HTTP ${status}`;
}

function field(data: Record<string, unknown>, name: string, status: number): string {
  const value = data[name];
  if (typeof value !== 'string' || !value) throw unexpectedResponse(status);
  return value;
}

const unexpectedResponse = (status: number) => new ProServiceError('unexpected response from the Pro service', status);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
