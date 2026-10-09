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
