/**
 * A recording fetch (R4 H103, D1), FAKE network: every request this process makes through fetch is recorded (its method and
 * address). A request to an address the test allows (its FAKE servers on 127.0.0.1) goes through; any other is refused here,
 * before it leaves this process, as a connection that was never made (ECONNREFUSED): nothing reaches openrouter.ai or any
 * other host, and the record says whether anything tried. The OpenRouter SDK calls the global fetch at each request, so it is
 * recorded too.
 */
export interface RecordedRequest { method: string; url: string }

export function recordFetch(allow: (url: URL) => boolean = () => false): { requests: RecordedRequest[]; restore(): void } {
  const original = globalThis.fetch;
  const requests: RecordedRequest[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? (typeof input === 'object' && 'method' in input ? input.method : 'GET');
    requests.push({ method, url: href });
    if (allow(new URL(href))) return original(input, init);
    const cause = Object.assign(new Error('refused by the test\'s recording fetch: nothing left this process'), { code: 'ECONNREFUSED' });
    throw new TypeError('fetch failed', { cause });
  }) as typeof fetch;
  return { requests, restore: () => { globalThis.fetch = original; } };
}

/** Only the test's own servers on 127.0.0.1, by port. */
export const onlyPorts = (...ports: Array<number | string>) => (url: URL): boolean => url.hostname === '127.0.0.1' && ports.map(String).includes(url.port);
