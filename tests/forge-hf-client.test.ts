import { inspect } from 'node:util';
import { afterEach, describe, it, expect } from 'vitest';
import {
  hfGenerate,
  mapHfStatus,
  _setHfV2LoaderForTests,
  type HfV2Module,
  type HfV2Response,
} from '../src/forge/higgsfield/client.js';
import { probeEligible, type EndpointEntry } from '../src/forge/higgsfield/config.js';

const HF_CREDS = 'hf-test-key-id:hf-test-secret-value';

// Async counterpart of the withHfEnv pattern in tests/forge-hf-config.test.ts:
// restores HF_CREDENTIALS even when the wrapped body rejects.
async function withHfEnvAsync(value: string | undefined, fn: () => Promise<void>): Promise<void> {
  const prev = process.env.HF_CREDENTIALS;
  try {
    if (value === undefined) delete process.env.HF_CREDENTIALS;
    else process.env.HF_CREDENTIALS = value;
    await fn();
  } finally {
    if (prev === undefined) delete process.env.HF_CREDENTIALS;
    else process.env.HF_CREDENTIALS = prev;
  }
}

function mockV2(overrides: Partial<HfV2Module['higgsfield']> & Pick<HfV2Module['higgsfield'], 'subscribe'>): HfV2Module {
  return { config: () => {}, higgsfield: { subscribe: overrides.subscribe } };
}

afterEach(() => {
  _setHfV2LoaderForTests(undefined);
});

describe('higgsfield adapter (stub)', () => {
  it('returns deterministic stub result with $0 cost', async () => {
    const r = await hfGenerate({ endpoint: 'dop-turbo', input: { prompt: 'a cat' }, mode: 'stub' });
    expect(r.cost_usd).toBe(0);
    expect(r.status).toBe('completed');
    expect(r.artifact_url).toMatch(/^stub:\/\//);
    expect(r.request_id).toBeTruthy();
  });

  it('stub result marks cost as measured and keeps the six-key live shape', async () => {
    const r = await hfGenerate({ endpoint: 'dop-turbo', input: {}, mode: 'stub' });
    expect(r.cost_measured).toBe(true);
    expect(Object.keys(r).filter((k) => k !== 'cost_measured'))
      .toEqual(['request_id', 'status', 'artifact_url', 'cost_usd', 'probe']);
  });

  it('live mode without credentials is denied, not attempted', async () => {
    await withHfEnvAsync(undefined, async () => {
      await expect(hfGenerate({ endpoint: 'dop-turbo', input: {}, mode: 'live' }))
        .rejects.toThrow(/HF_CREDENTIALS/);
    });
  });
});

describe('higgsfield adapter probe/render classification (stub)', () => {
  it('kind render yields probe:false in stub mode', async () => {
    const r = await hfGenerate({ endpoint: 'dop-turbo', input: {}, mode: 'stub', kind: 'render' });
    expect(r.probe).toBe(false);
  });

  it('kind probe yields probe:true in stub mode', async () => {
    const r = await hfGenerate({ endpoint: 'dop-turbo', input: {}, mode: 'stub', kind: 'probe' });
    expect(r.probe).toBe(true);
  });

  it('absent kind defaults to probe:true in stub mode', async () => {
    const r = await hfGenerate({ endpoint: 'dop-turbo', input: {}, mode: 'stub' });
    expect(r.probe).toBe(true);
  });
});

describe('mapHfStatus', () => {
  it('maps terminal statuses exactly', () => {
    expect(mapHfStatus('completed')).toBe('completed');
    expect(mapHfStatus('nsfw')).toBe('nsfw');
    expect(mapHfStatus('failed')).toBe('failed');
  });

  it('maps non-terminal and garbage statuses to unknown', () => {
    expect(mapHfStatus('queued')).toBe('unknown');
    expect(mapHfStatus('in_progress')).toBe('unknown');
    expect(mapHfStatus('garbage')).toBe('unknown');
    expect(mapHfStatus('')).toBe('unknown');
  });
});

describe('higgsfield adapter (live, mocked client)', () => {
  it('mid-poll network drop with request_id rejects spend=unknown and never leaks the secret', async () => {
    await withHfEnvAsync(HF_CREDS, async () => {
      const err = Object.assign(
        new Error(`socket hang up while using key hf-test-secret-value`),
        { request_id: 'req-post-accept' },
      );
      _setHfV2LoaderForTests(() => mockV2({ subscribe: async () => { throw err; } }));
      try {
        await hfGenerate({ endpoint: 'dop-turbo', input: {}, mode: 'live' });
        expect.unreachable('hfGenerate should have rejected');
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        expect(msg).toContain('request_id=req-post-accept');
        expect(msg).toContain('spend=unknown');
        expect(msg).toContain('[redacted]');
        expect(msg).not.toContain('hf-test-secret-value');
        expect((e as Error).cause).not.toBe(err);
        expect(inspect(e, { depth: null })).not.toContain('hf-test-secret-value');
        expect(err.message).toContain('hf-test-secret-value');
      }
    });
  });

  it('error embedding the key secret is redacted from the surfaced message', async () => {
    await withHfEnvAsync(HF_CREDS, async () => {
      _setHfV2LoaderForTests(() => mockV2({
        subscribe: async () => { throw new Error(`401 unauthorized: bad key hf-test-secret-value`); },
      }));
      try {
        await hfGenerate({ endpoint: 'dop-turbo', input: {}, mode: 'live' });
        expect.unreachable('hfGenerate should have rejected');
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        expect(msg).not.toContain('hf-test-secret-value');
        expect(msg).toContain('[redacted]');
        expect(msg).toContain('spend=unlikely');
      }
    });
  });

  it('non-terminal status after polling rejects spend=unknown, not a failed result', async () => {
    await withHfEnvAsync(HF_CREDS, async () => {
      const res: HfV2Response = { status: 'queued', request_id: 'req-still-queued' };
      _setHfV2LoaderForTests(() => mockV2({ subscribe: async () => res }));
      try {
        await hfGenerate({ endpoint: 'dop-turbo', input: {}, mode: 'live' });
        expect.unreachable('hfGenerate should have rejected');
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        expect(msg).toContain('spend=unknown');
        expect(msg).toContain('request_id=req-still-queued');
        expect(msg).not.toContain('failed');
      }
    });
  });

  it('live with credentials but a failing loader reports the global-install requirement', async () => {
    await withHfEnvAsync(HF_CREDS, async () => {
      _setHfV2LoaderForTests(() => { throw new Error('MODULE_NOT_FOUND'); });
      await expect(hfGenerate({ endpoint: 'dop-turbo', input: {}, mode: 'live' }))
        .rejects.toThrow(/requires global @higgsfield\/client/);
    });
  });

  it('live success returns the placeholder cost flagged as unmeasured', async () => {
    await withHfEnvAsync(HF_CREDS, async () => {
      const res: HfV2Response = { status: 'completed', request_id: 'req-ok', video: { url: 'https://cdn.example/v.mp4' } };
      _setHfV2LoaderForTests(() => mockV2({ subscribe: async () => res }));
      const r = await hfGenerate({ endpoint: 'dop-turbo', input: {}, mode: 'live' });
      expect(r).toEqual({
        request_id: 'req-ok', status: 'completed', artifact_url: 'https://cdn.example/v.mp4',
        cost_usd: 0, probe: true, cost_measured: false,
      });
    });
  });

  it('live success honors kind render with probe:false', async () => {
    await withHfEnvAsync(HF_CREDS, async () => {
      const res: HfV2Response = { status: 'completed', request_id: 'req-render', video: { url: 'https://cdn.example/v.mp4' } };
      _setHfV2LoaderForTests(() => mockV2({ subscribe: async () => res }));
      const r = await hfGenerate({ endpoint: 'dop-turbo', input: {}, mode: 'live', kind: 'render' });
      expect(r.probe).toBe(false);
      expect(r.request_id).toBe('req-render');
    });
  });
});

describe('probeEligible (advisory catalog helper)', () => {
  const catalog: EndpointEntry[] = [
    { endpoint: 'dop-turbo', stage: 'i2v', cost_class: 'probe', probe_eligible: true },
    { endpoint: 'cinematic-master', stage: 'i2v', cost_class: 'full', probe_eligible: false },
  ];

  it('catalog hit with probe_eligible true returns true', () => {
    expect(probeEligible('dop-turbo', catalog)).toBe(true);
  });

  it('catalog hit with probe_eligible false returns false', () => {
    expect(probeEligible('cinematic-master', catalog)).toBe(false);
  });

  it('unknown endpoint returns true (probes are the cheap default)', () => {
    expect(probeEligible('never-heard-of-it', catalog)).toBe(true);
  });

  it('absent catalog returns true (renders must be explicit kind render)', () => {
    expect(probeEligible('cinematic-master')).toBe(true);
    expect(probeEligible('dop-turbo', undefined)).toBe(true);
  });
});


describe('adapter credential and replay boundaries', () => {
  it('keeps artifact bytes stable for equivalent inputs but gives each attempt an id', async () => {
    const a = await hfGenerate({ endpoint: 'demo', input: { z: 1, nested: { b: 2, a: 1 } }, mode: 'stub' });
    const b = await hfGenerate({ endpoint: 'demo', input: { nested: { a: 1, b: 2 }, z: 1 }, mode: 'stub', kind: 'probe' });
    const changed = await hfGenerate({ endpoint: 'demo', input: { z: 2, nested: { b: 2, a: 1 } }, mode: 'stub' });
    const render = await hfGenerate({ endpoint: 'demo', input: { z: 1, nested: { b: 2, a: 1 } }, mode: 'stub', kind: 'render' });
    expect(Buffer.from(a.artifact_url)).toEqual(Buffer.from(b.artifact_url));
    expect(a.request_id).not.toBe(b.request_id);
    expect(changed.artifact_url).not.toBe(a.artifact_url);
    expect(render.artifact_url).not.toBe(a.artifact_url);
  });

  it('refuses control characters before loading the provider', async () => {
    let loaded = false;
    _setHfV2LoaderForTests(() => { loaded = true; throw new Error('must not load'); });
    await withHfEnvAsync('fake-id:bad\r\nsecret', async () => {
      await expect(hfGenerate({ endpoint: 'demo', input: {}, mode: 'live' })).rejects.toThrow(/HF_CREDENTIALS/);
    });
    expect(loaded).toBe(false);
  });

  it.each(['loader', 'subscribe'])('sanitizes the entire public %s error, preserving the original privately', async (phase) => {
    await withHfEnvAsync(HF_CREDS, async () => {
      const nested = new Error('nested hf-test-secret-value');
      const raw = Object.assign(new Error('failure hf-test-secret-value', { cause: nested }), {
        request_id: 'req-safe', headers: { authorization: HF_CREDS },
      });
      nested.cause = raw;
      _setHfV2LoaderForTests(() => {
        if (phase === 'loader') throw raw;
        return mockV2({ subscribe: async () => {
          delete process.env.HF_CREDENTIALS;
          throw raw;
        } });
      });
      try {
        await hfGenerate({ endpoint: 'demo', input: {}, mode: 'live' });
        expect.unreachable('must reject');
      } catch (error) {
        const output = inspect(error, { depth: null });
        expect(output).not.toContain('hf-test-secret-value');
        expect(output).not.toContain(HF_CREDS);
        expect(output).toContain('[redacted]');
        if (phase === 'subscribe') {
          expect((error as Error).message).toContain('request_id=req-safe');
          expect((error as Error).message).toContain('spend=unknown');
        }
        expect(raw.message).toContain('hf-test-secret-value');
        expect(raw.headers.authorization).toBe(HF_CREDS);
      }
    });
  });

  it('sanitizes status and request id interpolated into reconciliation errors', async () => {
    await withHfEnvAsync(HF_CREDS, async () => {
      _setHfV2LoaderForTests(() => mockV2({ subscribe: async () => ({
        status: 'unknown hf-test-secret-value', request_id: HF_CREDS,
      }) }));
      try {
        await hfGenerate({ endpoint: 'demo', input: {}, mode: 'live' });
        expect.unreachable('must reject');
      } catch (error) {
        expect(inspect(error, { depth: null })).not.toContain('hf-test-secret-value');
        expect((error as Error).message).toContain('spend=unknown');
      }
    });
  });
});


describe('terminal provider identity boundary', () => {
  it.each(['completed', 'failed', 'nsfw'])('sanitizes echoed credentials in %s result IDs after env changes', async (status) => {
    await withHfEnvAsync(HF_CREDS, async () => {
      _setHfV2LoaderForTests(() => mockV2({ subscribe: async () => {
        process.env.HF_CREDENTIALS = 'replacement-id:replacement-secret';
        return { status, request_id: `req-${HF_CREDS}`, video: { url: 'https://cdn.example/clip.mp4' } };
      } }));
      const result = await hfGenerate({ endpoint: 'demo', input: {}, mode: 'live' });
      expect(result.request_id).toBe('req-[redacted]');
      expect(JSON.stringify(result)).not.toContain('hf-test-secret-value');
      expect(result.status).toBe(status);
      expect(result.cost_measured).toBe(false);
    });
  });
});


describe('runtime generation classification', () => {
  it.each([
    { mode: 'unknown', kind: undefined },
    { mode: null, kind: 'probe' },
    { mode: 'live', kind: 'full' },
    { mode: 'stub', kind: null },
  ])('refuses malformed mode/kind before provider loading (%j)', async ({ mode, kind }) => {
    let loaded = false;
    _setHfV2LoaderForTests(() => { loaded = true; throw new Error('must not load'); });
    await withHfEnvAsync(HF_CREDS, async () => {
      await expect(hfGenerate({ endpoint: 'demo', input: {}, mode, kind } as never))
        .rejects.toThrow(/higgsfield (mode|kind) must be/);
    });
    expect(loaded).toBe(false);
  });
});
