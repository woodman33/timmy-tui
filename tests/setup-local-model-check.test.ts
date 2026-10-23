/**
 * R11 (H170; Phase 0 item 6): the one readiness check for a local model, checkLocalModel, against a FAKE Ollama on 127.0.0.1.
 * The FAKE lists what the operator's Mac lists (the plan's 1.6): `granite4.2:latest` by that exact name, an embedding model,
 * a cloud-backed entry; it answers /api/show by exact name only, as Ollama does, so no spelling is normalised into another
 * model. Every state is read in words; nothing is run, downloaded or sent off this computer (any request that is not to
 * 127.0.0.1 fails the test).
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkLocalModel, localModelGlyph } from '../src/setup/local-model-check.js';

/** FAKE Ollama: /api/show by exact name; FAKE facts in Ollama's shape (the sizes are the operator's granite entry's words). */
function fakeOllama() {
  const asked: string[] = [];
  let stall = false;
  const held: Record<string, unknown> = {
    'granite4.2:latest': { capabilities: ['completion', 'tools'], details: { format: 'gguf', family: 'granite', parameter_size: '8.8B', quantization_level: 'Q4_K_M' }, model_info: { 'granite.context_length': 40960 } },
    'fake-embed:latest': { capabilities: ['embedding'], details: { format: 'gguf', family: 'bert', parameter_size: '33M', quantization_level: 'F16' }, model_info: {} },
    'fake-remote:latest': { capabilities: ['completion'], remote_host: 'https://ollama.com', remote_model: 'fake-remote', details: { format: '', family: '' }, model_info: {} },
  };
  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const json = (code: number, v: unknown) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(v)); };
      if (req.method === 'POST' && req.url === '/api/show') {
        const model = (JSON.parse(body) as { model?: string }).model ?? '';
        asked.push(model);
        if (stall) return; // never answers: the client's time runs out
        return held[model] ? json(200, held[model]) : json(404, { error: `model '${model}' not found` });
      }
      json(404, { error: 'not found' });
    });
  });
  return { server, asked, setStall: (v: boolean) => { stall = v; } };
}

const listen = (s: Server): Promise<string> => new Promise((r) => s.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${(s.address() as AddressInfo).port}`)));
const close = (s: Server): Promise<void> => new Promise((r) => { s.close(() => r()); s.closeAllConnections(); });

const realFetch = globalThis.fetch;
const left: string[] = [];
const localOnly = (async (input: string | URL | Request, init?: RequestInit) => {
  const u = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url);
  if (u.hostname !== '127.0.0.1') { left.push(u.origin); throw new Error(`a request left this computer: ${u.origin}`); }
  return realFetch(input, init);
}) as typeof fetch;

let fake: ReturnType<typeof fakeOllama>;
let origin = '';
beforeEach(async () => {
  fake = fakeOllama();
  origin = await listen(fake.server);
  left.length = 0;
  vi.stubGlobal('fetch', (input: unknown) => { throw new Error(`the global fetch was used: ${String(input)}`); });
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await close(fake.server);
  expect(left).toEqual([]);
});

describe('checkLocalModel: one readiness check for a local model, shared by every surface', () => {
  it('ready: the exact installed name, with its facts, checked just now, no model run', async () => {
    const r = await checkLocalModel('granite4.2:latest', { origin, fetch: localOnly });
    expect(r).toMatchObject({ state: 'ready', why: 'completion', name: 'granite4.2:latest', origin });
    expect(r.words).toBe('ready: granite4.2:latest is installed on this computer\'s Ollama (8.8B Q4_K_M, 41k context); checked just now, no model run.');
    expect(r.facts).toMatchObject({ name: 'granite4.2:latest', parameterSize: '8.8B', quantizationLevel: 'Q4_K_M', contextLength: 40960, capabilities: ['completion', 'tools'] });
    expect(Date.parse(r.at)).toBeGreaterThan(Date.now() - 10_000);
    expect(r.latencyMs).toBeGreaterThanOrEqual(0);
    expect(fake.asked).toEqual(['granite4.2:latest']);
    expect(localModelGlyph(r.state)).toEqual({ glyph: '●', tone: 'live', word: 'ready' });
  });

  it('names are matched exactly as Ollama lists them: a spelling is never normalised into another model', async () => {
    for (const spelling of ['granite4.2', 'granite 4.2 latest', 'Granite4.2:latest', 'granite4.2:Latest']) {
      const r = await checkLocalModel(spelling, { origin, fetch: localOnly });
      expect(r.state, spelling).not.toBe('ready');
      expect(r.name).toBe(spelling);
    }
    // the one with a space is not a name at all (asked of nothing); the rest were asked, as given, and are not held
    expect(fake.asked).toEqual(['granite4.2', 'Granite4.2:latest', 'granite4.2:Latest']);
    const r = await checkLocalModel('granite4.2', { origin, fetch: localOnly });
    expect(r).toMatchObject({ state: 'not-installed', why: 'not-held' });
    expect(r.words).toBe(`Ollama at ${origin.replace('http://', '')} does not have granite4.2: ollama pull granite4.2 downloads it (its size shows first), then choose it again.`);
    expect(localModelGlyph('not-installed')).toEqual({ glyph: '✕', tone: 'failure', word: 'not installed' });
  });

  it('not a chat model: an embedding model, a cloud-backed entry, a cloud tag (asked of nothing), an invalid name', async () => {
    const embed = await checkLocalModel('fake-embed:latest', { origin, fetch: localOnly });
    expect(embed).toMatchObject({ state: 'not-a-chat-model', why: 'no-completion' });
    expect(embed.words).toMatch(/^fake-embed:latest is not a chat model: Ollama at 127\.0\.0\.1:\d+ lists it without the completion capability \(an embedding model, or weights in a form it cannot run\)\. Choose a chat model\.$/);
    const remote = await checkLocalModel('fake-remote:latest', { origin, fetch: localOnly });
    expect(remote).toMatchObject({ state: 'not-a-chat-model', why: 'remote' });
    expect(remote.words).toMatch(/is cloud-backed: Ollama at .* names a remote host for it, so the local route never uses it/);
    const cloud = await checkLocalModel('fake-gpt-oss:120b-cloud', { origin, fetch: localOnly });
    expect(cloud).toMatchObject({ state: 'not-a-chat-model', why: 'cloud-tag' });
    expect(cloud.words).toMatch(/^fake-gpt-oss:120b-cloud is a cloud model: this computer's Ollama would send the chat to a cloud/);
    const bad = await checkLocalModel('two words', { origin, fetch: localOnly });
    expect(bad).toMatchObject({ state: 'not-a-chat-model', why: 'invalid-name' });
    expect(fake.asked).toEqual(['fake-embed:latest', 'fake-remote:latest']);
    expect(localModelGlyph('not-a-chat-model')).toEqual({ glyph: '✕', tone: 'failure', word: 'not a chat model' });
  });

  it('unreachable: Ollama not running (refused), a time-out, a cancelled check, an address that is not this computer', async () => {
    fake.setStall(true);
    const slow = await checkLocalModel('granite4.2:latest', { origin, fetch: localOnly, timeoutMs: 80 });
    expect(slow).toMatchObject({ state: 'unreachable', why: 'no-answer' });
    expect(slow.words).toMatch(/^Ollama at 127\.0\.0\.1:\d+ did not answer within 0\.08 s: check that it runs \(ollama serve\), then choose the model again\.$/);
    const ac = new AbortController();
    const pending = checkLocalModel('granite4.2:latest', { origin, fetch: localOnly, signal: ac.signal, timeoutMs: 5000 });
    ac.abort();
    expect(await pending).toMatchObject({ state: 'unreachable', why: 'no-answer', words: expect.stringMatching(/^The check of granite4.2:latest was cancelled/) });
    fake.setStall(false);
    await close(fake.server);
    const down = await checkLocalModel('granite4.2:latest', { origin, fetch: localOnly });
    expect(down).toMatchObject({ state: 'unreachable', why: 'not-running' });
    expect(down.words).toMatch(/^Ollama is not running at 127\.0\.0\.1:\d+ \(the connection was refused\): start it \(ollama serve\), then choose the model again\.$/);
    const away = await checkLocalModel('granite4.2:latest', { origin: 'http://192.0.2.9:11434', fetch: localOnly });
    expect(away).toMatchObject({ state: 'unreachable', why: 'not-loopback', words: expect.stringContaining('192.0.2.9:11434 is not this computer') });
    expect(localModelGlyph('unreachable')).toEqual({ glyph: '✕', tone: 'failure', word: 'unreachable' });
    expect(localModelGlyph('checking')).toEqual({ glyph: '●', tone: 'attention', word: 'checking' });
    expect(localModelGlyph('unknown')).toEqual({ glyph: '○', tone: 'secondary', word: 'not checked' });
  });

  it('with no origin given, the address asked is the one the chat asks (OLLAMA_HOST here)', async () => {
    const r = await checkLocalModel('granite4.2:latest', { env: { OLLAMA_HOST: origin, TIMMY_HOME: process.env.TIMMY_HOME, TIMMY_SETTINGS_DIR: process.env.TIMMY_SETTINGS_DIR }, fetch: localOnly });
    expect(r.state).toBe('ready');
    expect(r.origin).toBe(origin);
  });
});
