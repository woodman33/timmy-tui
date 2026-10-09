// "References in, observations out" (round R2, look): which models take images, read from OpenRouter's
// public models list, and a model's interpretation of an image — refused for a model that does not take
// images. Every request here goes to a mocked fetch; nothing reaches the network.
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { acceptsImages, describeImage, imageInputModels, resetImageModelCache } from '../src/vision/route.js';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('fake png body')]);
const MODELS = {
  data: [
    { id: 'anthropic/claude-haiku-4.5', architecture: { input_modalities: ['text', 'image'] } },
    { id: 'deepseek/deepseek-chat', architecture: { input_modalities: ['text'] } },
    { id: 'google/gemini-2.5-flash', architecture: { input_modalities: ['text', 'image', 'file'] } },
    { id: 'no/architecture' },
  ],
};

interface Call { url: string; init?: RequestInit }
function mockFetch(opts: { models?: unknown; modelsStatus?: number; completion?: unknown; completionStatus?: number } = {}) {
  const calls: Call[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push({ url, init });
    if (url.endsWith('/models')) {
      return new Response(JSON.stringify(opts.models ?? MODELS), { status: opts.modelsStatus ?? 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.endsWith('/chat/completions')) {
      return new Response(JSON.stringify(opts.completion ?? {
        id: 'gen-1', model: 'anthropic/claude-haiku-4.5',
        choices: [{ message: { role: 'assistant', content: 'A red square on white.' } }],
        usage: { prompt_tokens: 900, completion_tokens: 12, total_tokens: 912, cost: 0.00123 },
      }), { status: opts.completionStatus ?? 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response('not here', { status: 404 });
  }) as typeof fetch;
  return { fn, calls };
}

let dir = '';
beforeEach(() => { resetImageModelCache(); dir = mkdtempSync(join(tmpdir(), 'route-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('which models take images', () => {
  it('reads input_modalities from the public models list, once', async () => {
    const { fn, calls } = mockFetch();
    const r = await imageInputModels(fn);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.models).toEqual(['anthropic/claude-haiku-4.5', 'google/gemini-2.5-flash']);
    await imageInputModels(fn);
    expect(calls.filter((c) => c.url === 'https://openrouter.ai/api/v1/models')).toHaveLength(1);
  });

  it('accepts and refuses by modality, and says unknown when the list cannot be read', async () => {
    const { fn } = mockFetch();
    expect(await acceptsImages('anthropic/claude-haiku-4.5', fn)).toEqual({ accepts: true });
    const text = await acceptsImages('deepseek/deepseek-chat', fn);
    expect(text.accepts).toBe(false);
    expect(text).toMatchObject({ reason: expect.stringContaining('text') });
    const missing = await acceptsImages('nobody/none', fn);
    expect(missing.accepts).toBe(false);
    expect(missing).toMatchObject({ reason: expect.stringContaining('not in OpenRouter') });
    resetImageModelCache();
    const down = mockFetch({ modelsStatus: 503 });
    const unknown = await acceptsImages('anthropic/claude-haiku-4.5', down.fn);
    expect(unknown.accepts).toBeNull();
  });
});

describe('a model interpretation of an image', () => {
  it('refuses a model that does not take images, with the reason and image-capable alternatives', async () => {
    const image = join(dir, 'a.png');
    writeFileSync(image, PNG);
    const { fn, calls } = mockFetch();
    const r = await describeImage({ model: 'deepseek/deepseek-chat', imagePath: image, question: 'What is it?', apiKey: 'k', fetch: fn });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.refused).toBe(true);
    expect(r.error).toContain('deepseek/deepseek-chat');
    expect(r.alternatives).toContain('anthropic/claude-haiku-4.5');
    expect(calls.some((c) => c.url.endsWith('/chat/completions'))).toBe(false);
  });

  it('sends the image as a data URI and records the tier, the model and the reported cost', async () => {
    const image = join(dir, 'a.png');
    writeFileSync(image, PNG);
    const { fn, calls } = mockFetch();
    const r = await describeImage({ model: 'anthropic/claude-haiku-4.5', imagePath: image, question: 'What is it?', apiKey: 'test-key', fetch: fn });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r).toMatchObject({ tier: 'model interpretation', model: 'anthropic/claude-haiku-4.5', answer: 'A red square on white.', cost_usd: 0.00123 });
    expect(r.image_sha256).toBe(createHash('sha256').update(PNG).digest('hex'));
    const post = calls.find((c) => c.url === 'https://openrouter.ai/api/v1/chat/completions');
    expect(post?.init?.method).toBe('POST');
    expect((post?.init?.headers as Record<string, string>).Authorization).toBe('Bearer test-key');
    const body = JSON.parse(String(post?.init?.body)) as { model: string; messages: Array<{ content: Array<{ type: string; text?: string; image_url?: { url: string } }> }> };
    expect(body.model).toBe('anthropic/claude-haiku-4.5');
    // R2 (the Mac run): without usage accounting OpenRouter reported cost 0 for a paid call; ask for it.
    expect((body as unknown as { usage?: { include?: boolean } }).usage).toEqual({ include: true });
    const parts = body.messages[0].content;
    expect(parts.find((p) => p.type === 'text')?.text).toContain('What is it?');
    expect(parts.find((p) => p.type === 'image_url')?.image_url?.url).toBe(`data:image/png;base64,${PNG.toString('base64')}`);
  });

  it('says the cost is unknown when the answer does not report one, and refuses without a key', async () => {
    const image = join(dir, 'a.png');
    writeFileSync(image, PNG);
    const { fn } = mockFetch({ completion: { model: 'anthropic/claude-haiku-4.5', choices: [{ message: { content: 'ok' } }] } });
    const r = await describeImage({ model: 'anthropic/claude-haiku-4.5', imagePath: image, question: 'q', apiKey: 'k', fetch: fn });
    expect(r.ok && r.cost_usd).toBeNull();
    const none = mockFetch();
    const nokey = await describeImage({ model: 'anthropic/claude-haiku-4.5', imagePath: image, question: 'q', apiKey: '', fetch: none.fn });
    expect(nokey.ok).toBe(false);
    expect(none.calls).toHaveLength(0);
  });

  it('refuses a file that is not an image it can send', async () => {
    const doc = join(dir, 'a.pdf');
    writeFileSync(doc, '%PDF-1.4 not an image');
    const { fn, calls } = mockFetch();
    const r = await describeImage({ model: 'anthropic/claude-haiku-4.5', imagePath: doc, question: 'q', apiKey: 'k', fetch: fn });
    expect(r.ok).toBe(false);
    expect(calls.some((c) => c.url.endsWith('/chat/completions'))).toBe(false);
  });
});

// Round R3 (the independent review of 40022d9, finding 3): a known cost is never dropped, and the answer kept
// is the answer given (up to a generous hard cap, flagged when cut), not a display-sized slice of it.
describe('what a response reported is kept, whatever became of the answer', () => {
  it('a 2xx response with usage but no answer text is a failure that still carries its reported cost', async () => {
    const image = join(dir, 'a.png');
    writeFileSync(image, PNG);
    const { fn } = mockFetch({ completion: { model: 'anthropic/claude-haiku-4.5', choices: [{ message: { content: '' } }], usage: { cost: 0.0042, total_tokens: 800 } } });
    const r = await describeImage({ model: 'anthropic/claude-haiku-4.5', imagePath: image, question: 'q', apiKey: 'k', fetch: fn });
    expect(r).toMatchObject({ ok: false, sent: true, cost_usd: 0.0042, tokens: 800, error: 'the model returned no answer' });
  });

  it('a request that went out and failed says its cost is unknown (null), never 0; a refusal sent nothing', async () => {
    const image = join(dir, 'a.png');
    writeFileSync(image, PNG);
    const { fn } = mockFetch({ completion: { error: { message: 'upstream down' } }, completionStatus: 502 });
    const r = await describeImage({ model: 'anthropic/claude-haiku-4.5', imagePath: image, question: 'q', apiKey: 'k', fetch: fn });
    expect(r).toMatchObject({ ok: false, sent: true, cost_usd: null });
    expect(r.ok === false && r.error).toContain('502');
    const refused = await describeImage({ model: 'deepseek/deepseek-chat', imagePath: image, question: 'q', apiKey: 'k', fetch: fn });
    expect(refused.ok).toBe(false);
    expect(refused).not.toHaveProperty('sent');
    expect(refused).not.toHaveProperty('cost_usd');
  });

  it('keeps the whole answer up to 64 KB (no 8,000-character slice), and past that cuts on a character and says so', async () => {
    const image = join(dir, 'a.png');
    writeFileSync(image, PNG);
    const long = 'é'.repeat(10_000); // 20,000 bytes: more than the old slice, less than the cap
    const a = await describeImage({ model: 'anthropic/claude-haiku-4.5', imagePath: image, question: 'q', apiKey: 'k', fetch: mockFetch({ completion: { model: 'anthropic/claude-haiku-4.5', choices: [{ message: { content: long } }] } }).fn });
    expect(a.ok && a.answer).toBe(long);
    expect(a).not.toHaveProperty('answer_truncated');
    const huge = `a${'é'.repeat(40_000)}`; // 80,001 bytes
    const b = await describeImage({ model: 'anthropic/claude-haiku-4.5', imagePath: image, question: 'q', apiKey: 'k', fetch: mockFetch({ completion: { model: 'anthropic/claude-haiku-4.5', choices: [{ message: { content: huge } }], usage: { cost: 0.01 } } }).fn });
    if (!b.ok) throw new Error(b.error);
    expect(b.answer_truncated).toBe(true);
    expect(b.answer_bytes).toBe(80_001);
    expect(Buffer.byteLength(b.answer, 'utf8')).toBeLessThanOrEqual(64 * 1024);
    expect(Buffer.byteLength(b.answer, 'utf8')).toBeGreaterThan(64 * 1024 - 4);
    expect(huge.startsWith(b.answer)).toBe(true);
    expect(b.answer).not.toContain('�');
    expect(b.cost_usd).toBe(0.01);
  });
});

// Round R3 (the independent review of 40022d9, finding 2): the paid request had no AbortSignal, so nothing
// could stop it. describeImage takes one now, combined with its time limit.
describe('a model interpretation can be stopped', () => {
  /** OpenRouter whose chat request never answers: it ends only when its signal aborts (or never, with `deaf`). */
  function silent(o: { deaf?: boolean; slowList?: boolean } = {}) {
    const posts: string[] = [];
    let posted: () => void = () => undefined;
    const sent = new Promise<void>((resolve) => { posted = resolve; });
    const never = (signal?: AbortSignal | null): Promise<Response> => new Promise((_resolve, reject) => {
      if (signal && !o.deaf) signal.addEventListener('abort', () => reject(signal.reason ?? new Error('aborted')), { once: true });
    });
    const fn = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/models')) return o.slowList ? never(null) : new Response(JSON.stringify(MODELS), { status: 200 });
      posts.push(String(init?.body));
      posted();
      return never(init?.signal);
    }) as typeof fetch;
    return { fn, posts, sent };
  }

  it('aborting while the model answers ends the call at once: cancelled, sent, cost unknown (null)', async () => {
    const image = join(dir, 'a.png');
    writeFileSync(image, PNG);
    const api = silent();
    const stop = new AbortController();
    let requested = 0;
    const pending = describeImage({ model: 'anthropic/claude-haiku-4.5', imagePath: image, question: 'q', apiKey: 'k', fetch: api.fn, signal: stop.signal, onRequest: () => { requested++; } });
    await api.sent;
    expect(requested).toBe(1);
    stop.abort();
    const r = await pending;
    expect(r).toMatchObject({ ok: false, cancelled: true, sent: true, cost_usd: null });
    expect(r.ok === false && r.error).toMatch(/stopped while the model was answering/);
  });

  it('a fetch that ignores its signal cannot hold the stop', async () => {
    const image = join(dir, 'a.png');
    writeFileSync(image, PNG);
    const api = silent({ deaf: true });
    const stop = new AbortController();
    const pending = describeImage({ model: 'anthropic/claude-haiku-4.5', imagePath: image, question: 'q', apiKey: 'k', fetch: api.fn, signal: stop.signal });
    await api.sent;
    stop.abort();
    expect(await pending).toMatchObject({ ok: false, cancelled: true, sent: true, cost_usd: null });
  }, 10_000);

  it('aborted before the request goes out (the models list is slow): nothing is sent, so no cost at all', async () => {
    const image = join(dir, 'a.png');
    writeFileSync(image, PNG);
    const api = silent({ slowList: true });
    const stop = new AbortController();
    const pending = describeImage({ model: 'anthropic/claude-haiku-4.5', imagePath: image, question: 'q', apiKey: 'k', fetch: api.fn, signal: stop.signal });
    await new Promise((resolve) => setTimeout(resolve, 30));
    stop.abort();
    const r = await pending;
    expect(r).toMatchObject({ ok: false, cancelled: true });
    expect(r).not.toHaveProperty('sent');
    expect(r).not.toHaveProperty('cost_usd');
    expect(api.posts).toHaveLength(0);
    const before = new AbortController();
    before.abort();
    const early = await describeImage({ model: 'anthropic/claude-haiku-4.5', imagePath: image, question: 'q', apiKey: 'k', fetch: mockFetch().fn, signal: before.signal });
    expect(early).toMatchObject({ ok: false, cancelled: true });
    expect(early).not.toHaveProperty('sent');
  }, 10_000);

  it('its own time limit still applies beside the signal, and is a failure, not a stop', async () => {
    const image = join(dir, 'a.png');
    writeFileSync(image, PNG);
    const api = silent();
    const r = await describeImage({ model: 'anthropic/claude-haiku-4.5', imagePath: image, question: 'q', apiKey: 'k', fetch: api.fn, signal: new AbortController().signal, timeoutMs: 50 });
    expect(r).toMatchObject({ ok: false, sent: true, cost_usd: null });
    expect(r).not.toHaveProperty('cancelled');
    expect(r.ok === false && r.error).toMatch(/did not complete/);
  });
});

// Round R2 (the Mac run): on the operator's own provider key (BYOK) OpenRouter reports cost 0 (its fee) and
// the provider's charge as upstream_inference_cost; the first paid image call was recorded as costing 0.
describe('the image call\'s cost on a provider key (BYOK)', () => {
  const reply = (usage: Record<string, unknown>) => async (url: string | URL | Request) => {
    const u = String(url);
    if (u.endsWith('/models')) return new Response(JSON.stringify({ data: [{ id: 'anthropic/claude-haiku-4.5', architecture: { input_modalities: ['text', 'image'] } }] }));
    return new Response(JSON.stringify({ model: 'anthropic/claude-haiku-4.5', choices: [{ message: { content: 'a card' } }], usage }));
  };
  it('adds the provider\'s charge to OpenRouter\'s fee, and says unknown when the charge is missing', async () => {
    const { mkdtempSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { describeImage } = await import('../src/vision/route.js');
    const dir = mkdtempSync(join(tmpdir(), 'byok-'));
    const img = join(dir, 'card.png');
    writeFileSync(img, PNG);
    const base = { model: 'anthropic/claude-haiku-4.5', imagePath: img, question: 'what is it?', apiKey: 'test' };
    const a = await describeImage({ ...base, fetch: reply({ cost: 0, is_byok: true, cost_details: { upstream_inference_cost: 0.0031 }, total_tokens: 900 }) as typeof fetch });
    expect(a.ok && a.cost_usd).toBeCloseTo(0.0031, 6);
    const b = await describeImage({ ...base, fetch: reply({ cost: 0, is_byok: true, total_tokens: 900 }) as typeof fetch });
    expect(b.ok && b.cost_usd).toBeNull();
    const c = await describeImage({ ...base, fetch: reply({ cost: 0.002, total_tokens: 900 }) as typeof fetch });
    expect(c.ok && c.cost_usd).toBeCloseTo(0.002, 6);
  });
});
