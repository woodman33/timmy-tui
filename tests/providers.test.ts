import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  pickOllamaModel, probeOllama, ollamaChatCompletion,
  assertLocalOllamaModel, getLocalOllamaBaseUrl,
} from '../src/agent/providers.js';

const localMetadata = {
  capabilities: ['completion', 'tools'],
  details: { format: 'gguf', family: 'granite', parameter_size: '8.8B', quantization_level: 'Q4_K_M' },
  model_info: { 'granite.context_length': 131072 },
};
const response = (data: unknown) => ({ ok: true, json: async () => data });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('pickOllamaModel', () => {
  it('prefers local candidates and never selects a cloud tag', () => {
    const models = ['ornith:latest', 'glm-5.2:cloud', 'kimi-k2.7-code:cloud', 'granite4.2:latest'];
    expect(pickOllamaModel(models, ['kimi-k2.7-code', 'granite'])).toBe('granite4.2:latest');
    expect(pickOllamaModel(models, ['glm-5.2', 'ornith'])).toBe('ornith:latest');
  });

  it('returns null for a cloud-only catalog, including suffixed cloud tags', () => {
    expect(pickOllamaModel(['gemma4:31b-cloud', 'kimi:cloud'], ['gemma'])).toBeNull();
    expect(pickOllamaModel([], ['x'])).toBeNull();
  });

  it('falls back to the first valid local candidate', () => {
    expect(pickOllamaModel(['invalid model', 'x:cloud', 'ornith:latest'], ['missing'])).toBe('ornith:latest');
  });
});

describe('getLocalOllamaBaseUrl', () => {
  it('supports explicit local instances and dynamically reads OLLAMA_HOST', () => {
    vi.stubEnv('OLLAMA_HOST', '127.0.0.1:11435');
    expect(getLocalOllamaBaseUrl()).toBe('http://127.0.0.1:11435');
    expect(getLocalOllamaBaseUrl('http://[::1]:11434/')).toBe('http://[::1]:11434');
  });

  it('refuses nonlocal endpoints, credentials, paths and query strings', () => {
    for (const endpoint of ['https://ollama.com', 'http://localhost.evil.test', 'http://u:p@localhost:11434',
      'http://localhost:11434/api', 'http://localhost:11434/?key=x', 'file:///tmp/ollama']) {
      expect(() => getLocalOllamaBaseUrl(endpoint)).toThrow();
    }
  });
});

describe('assertLocalOllamaModel', () => {
  it('returns inspected capabilities and architectural context metadata', async () => {
    const fetch = vi.fn(async () => response(localMetadata));
    vi.stubGlobal('fetch', fetch);
    await expect(assertLocalOllamaModel('granite4.2:latest')).resolves.toEqual({
      name: 'granite4.2:latest', capabilities: ['completion', 'tools'], contextLength: 131072,
      format: 'gguf', family: 'granite', parameterSize: '8.8B', quantizationLevel: 'Q4_K_M',
    });
    expect(fetch.mock.calls[0]?.[0]).toBeDefined();
    expect(fetch).toHaveBeenCalledWith(expect.stringContaining('/api/show'), expect.objectContaining({
      method: 'POST', redirect: 'error', signal: expect.any(AbortSignal),
    }));
  });

  it('rejects a renamed cloud alias using either remote metadata field', async () => {
    for (const metadata of [{ remote_host: 'https://ollama.com' }, { remote_model: 'remote-model' }]) {
      vi.stubGlobal('fetch', vi.fn(async () => response({ ...localMetadata, ...metadata })));
      await expect(assertLocalOllamaModel('innocent:latest')).rejects.toThrow('cloud-backed model metadata');
    }
  });

  it('rejects missing metadata or a model that lacks completion capability', async () => {
    for (const metadata of [{}, { capabilities: ['completion'] },
      { ...localMetadata, capabilities: ['embedding'] }, { ...localMetadata, details: { format: '' } }]) {
      vi.stubGlobal('fetch', vi.fn(async () => response(metadata)));
      await expect(assertLocalOllamaModel('a')).rejects.toThrow('does not establish installed local');
    }
  });

  it('accepts safetensors local weights and preserves absent context as unknown', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response({
      capabilities: ['completion', 'vision'], details: { format: 'safetensors' },
      model_info: { 'bad.context_length': Infinity },
    })));
    const result = await assertLocalOllamaModel('qwen:mlx');
    expect(result.contextLength).toBeNull();
    expect(result.capabilities).toContain('vision');
  });

  it('refuses cloud tags and invalid timeouts before any network request', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    await expect(assertLocalOllamaModel('qwen:cloud')).rejects.toThrow('cloud-backed');
    for (const timeout of [NaN, Infinity, 0, -1, 120001]) {
      await expect(assertLocalOllamaModel('a', timeout)).rejects.toThrow('timeout');
    }
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('probeOllama', () => {
  it('reports only local weights after checking aliases, preserving catalog order', async () => {
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/api/tags')) return response({ models: [
        { name: 'ornith:latest' }, { name: 'qwen:cloud' }, { name: 'alias:latest' }, { name: 'granite4.2:latest' },
      ] });
      const { model } = JSON.parse(String(init?.body));
      return response(model === 'alias:latest' ? { ...localMetadata, remote_model: 'remote-qwen' } : localMetadata);
    });
    vi.stubGlobal('fetch', fetch);
    const result = await probeOllama();
    expect(result.ok).toBe(true);
    expect(result.models).toEqual(['ornith:latest', 'granite4.2:latest']);
    expect(fetch.mock.calls.some(([, init]) => String(init?.body).includes('qwen:cloud'))).toBe(false);
  });

  it('does not report an unchecked alias as ready when its model lookup fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => url.endsWith('/api/tags')
      ? response({ models: [{ name: 'alias:latest' }] }) : { ok: false, status: 404 }));
    expect((await probeOllama()).ok).toBe(false);
  });

  it('reports not-ready for an unavailable, failed, malformed or empty catalog', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED'); }));
    expect(await probeOllama()).toEqual({ ok: false, models: [] });
    for (const data of [{ models: [] }, { models: 'wrong' }, { models: Array(257).fill({ name: 'a' }) }]) {
      vi.stubGlobal('fetch', vi.fn(async () => response(data)));
      expect((await probeOllama()).ok).toBe(false);
    }
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 503 })));
    expect((await probeOllama()).ok).toBe(false);
  });
});

describe('ollamaChatCompletion', () => {
  it('rechecks local model metadata immediately before bounded completion', async () => {
    const fetch = vi.fn(async (url: string) => url.endsWith('/api/show')
      ? response(localMetadata) : response({ choices: [{ message: { content: 'OK' } }] }));
    vi.stubGlobal('fetch', fetch);
    await expect(ollamaChatCompletion('ornith:latest', [{ role: 'user', content: 'hi' }])).resolves.toBe('OK');
    expect(fetch.mock.calls.map(([url]) => new URL(url).pathname)).toEqual(['/api/show', '/v1/chat/completions']);
    expect(fetch).toHaveBeenLastCalledWith(expect.stringContaining('/v1/chat/completions'), expect.objectContaining({
      redirect: 'error', signal: expect.any(AbortSignal),
      body: JSON.stringify({ model: 'ornith:latest', messages: [{ role: 'user', content: 'hi' }], stream: false, max_tokens: 2048 }),
    }));
  });

  it('never sends a prompt when an alias has become cloud backed', async () => {
    const fetch = vi.fn(async () => response({ ...localMetadata, remote_host: 'https://ollama.com' }));
    vi.stubGlobal('fetch', fetch);
    await expect(ollamaChatCompletion('local-alias', [{ role: 'user', content: 'private' }])).rejects.toThrow('cloud-backed');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(expect.stringContaining('/api/show'), expect.anything());
  });

  it('throws on completion HTTP failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => url.endsWith('/api/show')
      ? response(localMetadata) : { ok: false, status: 500 }));
    await expect(ollamaChatCompletion('m', [])).rejects.toThrow('HTTP 500');
  });

  it('aborts a completion that exceeds its finite request budget', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/api/show')) return response(localMetadata);
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      });
    }));
    await expect(ollamaChatCompletion('m', [], 15)).rejects.toThrow();
  });
});
