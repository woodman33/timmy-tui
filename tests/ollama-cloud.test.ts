/**
 * R10 (H169): the Ollama Cloud adapter (src/agent/ollama-cloud.ts), a route of its own beside the loopback-only local one.
 * Every request goes to a FAKE fetch handed to it (no request reaches ollama.com); `never` fails the test when anything is
 * asked. The key is a FAKE one, and no word the adapter gives back may carry it.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cloudRouteWords, OllamaCloudError, ollamaCloudKey, ollamaCloudKeyFrom, runOllamaCloudTurn } from '../src/agent/ollama-cloud.js';
import { checkRoute, inferenceAt } from '../src/agent/route-policy.js';
import { keyInUse } from '../src/setup/provider-keys.js';

const KEY = 'FAKE-ollama-cloud-key-0001';
const OFF = { freeOnly: false, localOnly: false };
const never = (() => { throw new Error('FAKE fetch: no request may be made here'); }) as unknown as typeof fetch;

function fake(route: (url: string, init: RequestInit) => Response) {
  const calls: Array<{ url: string; auth: string | null; body: Record<string, unknown> }> = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const h = new Headers(init?.headers ?? {});
    calls.push({ url: String(input), auth: h.get('authorization'), body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown> });
    return route(String(input), init ?? {});
  }) as typeof fetch;
  return { f, calls };
}
const ndjson = (lines: unknown[]): Response => new Response(lines.map((l) => JSON.stringify(l)).join('\n') + '\n', { status: 200, headers: { 'content-type': 'application/x-ndjson' } });

describe('Ollama Cloud: its own route, labelled cloud, apart from the local one', () => {
  it('is remote inference everywhere: never this computer, excluded by local-only, not known to be free', () => {
    expect(inferenceAt({ source: 'ollama-cloud', model: 'gpt-oss:120b' })).toBe('cloud');
    expect(cloudRouteWords('gpt-oss:120b')).toBe('gpt-oss:120b · Ollama Cloud (ollama.com): remote inference, no local weights');
    expect(checkRoute({ source: 'ollama-cloud', model: 'gpt-oss:120b' }, { freeOnly: false, localOnly: true })).toMatchObject({ ok: false, reason: 'cloud-under-local-only' });
    expect(checkRoute({ source: 'ollama-cloud', model: 'gpt-oss:120b' }, { freeOnly: true, localOnly: false })).toMatchObject({ ok: false, reason: 'price-unknown-under-free-only' });
  });

  it('sends nothing without a key, under local-only or under free-only', async () => {
    await expect(runOllamaCloudTurn({ model: 'gpt-oss:120b', history: [{ role: 'user', content: 'hi' }], key: null, policy: OFF, fetch: never }))
      .rejects.toMatchObject({ name: 'OllamaCloudError', sent: false, message: expect.stringMatching(/^Ollama Cloud is not set up, so nothing was sent\./) });
    await expect(runOllamaCloudTurn({ model: 'gpt-oss:120b', history: [{ role: 'user', content: 'hi' }], key: KEY, policy: { freeOnly: false, localOnly: true }, fetch: never }))
      .rejects.toMatchObject({ sent: false, message: expect.stringMatching(/^This message was not sent to Ollama Cloud\.\nReason: Ollama's cloud \(ollama\.com\) runs off this computer/) });
    await expect(runOllamaCloudTurn({ model: 'gpt-oss:120b', history: [{ role: 'user', content: 'hi' }], key: KEY, policy: { freeOnly: true, localOnly: false }, fetch: never }))
      .rejects.toMatchObject({ sent: false, message: expect.stringContaining('unknown is never free') });
  });

  it('streams the answer from ollama.com/api/chat, the key in the Authorization header only, and names the model Ollama answered with', async () => {
    const net = fake(() => ndjson([
      { model: 'gpt-oss:120b-2026-10', message: { role: 'assistant', content: 'FAKE: hello ' }, done: false },
      { model: 'gpt-oss:120b-2026-10', message: { role: 'assistant', content: 'from the cloud.' }, done: true, done_reason: 'stop' },
    ]));
    const texts: string[] = [];
    const notices: string[] = [];
    const r = await runOllamaCloudTurn({ model: 'gpt-oss:120b', history: [{ role: 'user', content: 'hi' }], instructions: 'Be brief.', key: KEY, policy: OFF, fetch: net.f, onText: (t) => texts.push(t), onNotice: (n) => notices.push(n) });
    expect(net.calls).toHaveLength(1);
    expect(net.calls[0].url).toBe('https://ollama.com/api/chat');
    expect(net.calls[0].auth).toBe(`Bearer ${KEY}`);
    expect(net.calls[0].body).toMatchObject({ model: 'gpt-oss:120b', stream: true });
    expect(JSON.stringify(net.calls[0].body)).not.toContain(KEY);
    expect(r).toEqual({
      text: 'FAKE: hello from the cloud.', returned: 'gpt-oss:120b-2026-10', sent: true,
      cost: { usd: null, measured: false, words: 'cost unknown: Ollama\'s cloud reports none per request (its plans bill it)' },
      route: { source: 'ollama-cloud', inference: 'cloud', endpoint: 'ollama.com', gateway: 'none' },
    });
    expect(texts.at(-1)).toBe('FAKE: hello from the cloud.');
    expect(notices[0]).toMatch(/^tools off: Ollama Cloud turns run without Timmy's tools here\. This answer comes from Ollama's cloud \(remote inference\)/);
  });

  it('says a refused key, a plan limit and a failed connection in words, and never the key', async () => {
    const refused = await runOllamaCloudTurn({ model: 'm', history: [], key: KEY, policy: OFF, fetch: fake(() => new Response('{"error":"unauthorized"}', { status: 401 })).f }).catch((e: OllamaCloudError) => e);
    expect(refused).toMatchObject({ sent: true, status: 401, message: expect.stringMatching(/^Ollama Cloud refused the key, so nothing was answered\./) });
    const limit = await runOllamaCloudTurn({ model: 'm', history: [], key: KEY, policy: OFF, fetch: fake(() => new Response('{"error":"usage limit reached"}', { status: 429 })).f }).catch((e: OllamaCloudError) => e);
    expect(limit).toMatchObject({ status: 429, message: expect.stringContaining('its plan\'s limit was reached') });
    const down = (async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } }); }) as unknown as typeof fetch;
    const off = await runOllamaCloudTurn({ model: 'm', history: [], key: KEY, policy: OFF, fetch: down }).catch((e: OllamaCloudError) => e);
    expect(off).toMatchObject({ sent: false, message: expect.stringMatching(/^The request to Ollama Cloud was not sent\.\nReason: the connection failed \(ENOTFOUND\)/) });
    for (const e of [refused, limit, off]) expect(String((e as Error).message)).not.toContain(KEY);
  });

  it('stops when the person stops it', async () => {
    const stop = new AbortController();
    const slow = (async (_u: string, init?: RequestInit) => {
      const body = new ReadableStream<Uint8Array>({
        start(c) { c.enqueue(new TextEncoder().encode(`${JSON.stringify({ model: 'm', message: { content: 'FAKE: part' } })}\n`)); setTimeout(() => stop.abort(), 20); },
        pull() { return new Promise(() => undefined); },
      });
      void init;
      return new Response(body, { status: 200 });
    }) as unknown as typeof fetch;
    await expect(runOllamaCloudTurn({ model: 'm', history: [], key: KEY, policy: OFF, fetch: slow, signal: stop.signal })).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('reads the key the setup keeps (H170\'s keyInUse(\'ollama-cloud\')): OLLAMA_API_KEY first, else providers.json\'s ollama_cloud_api_key, and sends it only in the header', async () => {
    const home = mkdtempSync(join(tmpdir(), 'h169-cloud-key-'));
    try {
      const env: Record<string, string | undefined> = { TIMMY_HOME: home, TIMMY_SETTINGS_DIR: join(home, 'settings') };
      const keep = (body: Record<string, string>): void => writeFileSync(join(home, 'providers.json'), JSON.stringify(body), { mode: 0o600 });
      expect([ollamaCloudKey(env), ollamaCloudKeyFrom(env)]).toEqual([null, null]);
      // the interim field this adapter read before the setup's store landed is not read any more
      keep({ ollama_api_key: KEY });
      expect(ollamaCloudKey(env)).toBeNull();
      keep({ ollama_cloud_api_key: KEY, openrouter_api_key: 'FAKE-openrouter-not-this-one' });
      expect([ollamaCloudKey(env), ollamaCloudKeyFrom(env)]).toEqual([KEY, 'providers.json']);
      expect(ollamaCloudKey(env)).toBe(keyInUse('ollama-cloud', env)?.key);
      expect([ollamaCloudKey({ ...env, OLLAMA_API_KEY: 'FAKE-ollama-cloud-key-env' }), ollamaCloudKeyFrom({ ...env, OLLAMA_API_KEY: 'FAKE-ollama-cloud-key-env' })]).toEqual(['FAKE-ollama-cloud-key-env', 'OLLAMA_API_KEY']);
      // a turn given no key takes the store's, in the Authorization header only
      const net = fake(() => ndjson([{ model: 'gpt-oss:120b', message: { role: 'assistant', content: 'FAKE: ok' }, done: true }]));
      const r = await runOllamaCloudTurn({ model: 'gpt-oss:120b', history: [{ role: 'user', content: 'hi' }], env, policy: OFF, fetch: net.f });
      expect(r.text).toBe('FAKE: ok');
      expect(net.calls.map((c) => [c.url, c.auth])).toEqual([['https://ollama.com/api/chat', `Bearer ${KEY}`]]);
      expect(JSON.stringify(net.calls[0].body)).not.toContain(KEY);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});
