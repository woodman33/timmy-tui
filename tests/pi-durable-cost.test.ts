/**
 * Pi Durable S1 (R4 H118), plan i.9: the cost words (the operator's "invalid costs", 14:48 PT). REAL: cost.ts's rules,
 * Timmy's one endpoint rule (src/code-agents endpointClass, imported by cost.ts), and pi-ai 1.1.0's own OpenRouter
 * catalog and calculateCost, run in this process through the adapter: pure arithmetic, no request, no key. FAKE:
 * nothing is called; the endpoint addresses are examples (loopback, and an example.com host). The in-flight case
 * through a real worker kill and resend is kill (c) in tests/pi-durable-kill.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { loadPi } from '../src/pi-durable/adapter/pi-api.js';
import { AUTO_UNKNOWN, costWords, FAKE_COST, freeRoute, IN_FLIGHT_COST, LOCAL_FREE } from '../src/pi-durable/cost.js';
import { INSTALLED, SKIP_WHY, WORKER_DIR } from './helpers/pi-durable.js';

const LOCAL = 'http://127.0.0.1:11434/v1';

describe('the cost words of a Pi run (plan i.9)', () => {
  it('the FAKE route: no charge, as a figure of 0 with its basis', () => {
    expect(costWords({ route: 'faux' })).toEqual({ usd: 0, basis: 'fake', measured: false, words: FAKE_COST });
  });

  it('a local endpoint: "no charge (local endpoint)" only on this machine with a tag that does not end in cloud', () => {
    for (const baseUrl of [LOCAL, 'http://localhost:11434/v1', 'http://[::1]:11434/v1']) {
      expect(costWords({ route: 'local', baseUrl, model: 'qwen3:8b' })).toEqual({ usd: 0, basis: 'local endpoint', measured: false, words: LOCAL_FREE });
    }
    expect(LOCAL_FREE).toBe('no charge (local endpoint)');
  });

  it('a :cloud tag is unknown, although the endpoint is on this machine (pi-ai would compute $0 from zero rates)', () => {
    for (const model of ['glm-5.3-flash:cloud', 'gpt-oss:120b-cloud']) {
      const c = costWords({ route: 'local', baseUrl: LOCAL, model });
      expect(c).toMatchObject({ usd: null, basis: 'unknown', measured: false });
      expect(c.words).toBe(`unknown (a cloud model through Ollama: ${model})`);
    }
  });

  it('another host, a credential in the address or no address: unknown, saying why', () => {
    expect(costWords({ route: 'local', baseUrl: 'http://gpu-box.example.com:11434/v1', model: 'qwen3:8b' }).words).toBe('unknown (gpu-box.example.com:11434 is not this machine)');
    expect(costWords({ route: 'local', baseUrl: 'http://user:secret@127.0.0.1:11434/v1', model: 'qwen3:8b' })).toMatchObject({ usd: null, basis: 'unknown' });
    expect(costWords({ route: 'local', model: 'qwen3:8b' }).words).toBe('unknown (no endpoint address was recorded)');
  });

  it('OpenRouter: openrouter/auto is unknown and never negative; a negative or non-finite estimate is unknown; a real one is said as an estimate; no request yet gives no figure', () => {
    expect(costWords({ route: 'openrouter', model: 'openrouter/auto', estimateUsd: -1500 })).toEqual({ usd: null, basis: 'unknown', measured: false, words: AUTO_UNKNOWN });
    expect(costWords({ route: 'openrouter', model: 'openrouter/auto' }).usd).toBeNull();
    for (const bad of [-0.01, -1500, Number.NaN, Number.POSITIVE_INFINITY]) {
      const c = costWords({ route: 'openrouter', model: 'some/model', estimateUsd: bad });
      expect(c.usd).toBeNull();
      expect(c.words).toMatch(/^unknown \(pi-ai's catalog gives some\/model a price that is not a charge/);
    }
    expect(costWords({ route: 'openrouter', model: 'anthropic/claude-haiku-4.5', estimateUsd: 0.0035 })).toEqual({
      usd: 0.0035, basis: 'catalog estimate', measured: false, words: 'about $0.0035 (estimated from pi-ai\'s catalog prices; not a measured charge)',
    });
    expect(costWords({ route: 'openrouter', model: 'anthropic/claude-haiku-4.5' })).toEqual({ usd: null, basis: 'no request yet', measured: false, words: 'none yet (no model request went out)' });
  });

  it('a request in flight when a worker stopped makes the cost unknown whatever else holds; a resend does not make it known again', () => {
    for (const c of [
      costWords({ route: 'faux', inFlight: true }),
      costWords({ route: 'local', baseUrl: LOCAL, model: 'qwen3:8b', inFlight: true }),
      costWords({ route: 'openrouter', model: 'anthropic/claude-haiku-4.5', estimateUsd: 0.0035, inFlight: true }),
    ]) expect(c).toEqual({ usd: null, basis: 'unknown', measured: false, words: IN_FLIGHT_COST });
  });

  it('free routes (what may resume at Timmy\'s start without the operator): the FAKE route and a local endpoint by the rule, nothing else', () => {
    expect(freeRoute({ route: 'faux' })).toBe(true);
    expect(freeRoute({ route: 'local', baseUrl: LOCAL, model: 'qwen3:8b' })).toBe(true);
    expect(freeRoute({ route: 'local', baseUrl: LOCAL, model: 'glm-5.3-flash:cloud' })).toBe(false);
    expect(freeRoute({ route: 'openrouter', model: 'openrouter/free' })).toBe(false);
    expect(freeRoute({ route: 'openrouter', model: 'openrouter/auto' })).toBe(false);
  });

  it.skipIf(!INSTALLED)(`pi-ai's own catalog: openrouter/auto computes -$1,500 for 1,000 + 500 tokens (spike E); the words refuse it${INSTALLED ? '' : ` — skipped: ${SKIP_WHY}`}`, async () => {
    const pi = await loadPi(WORKER_DIR);
    const auto = await pi.catalogEstimate('openrouter/auto', { input: 1000, output: 500 });
    expect(auto?.usd).toBe(-1500);
    expect(auto?.rates.input).toBeLessThan(0);
    expect(costWords({ route: 'openrouter', model: 'openrouter/auto', estimateUsd: auto!.usd }).words).toBe(AUTO_UNKNOWN);
    const haiku = await pi.catalogEstimate('anthropic/claude-haiku-4.5', { input: 1000, output: 500 });
    expect(haiku?.usd).toBeCloseTo(0.0035, 10);
    expect(costWords({ route: 'openrouter', model: 'anthropic/claude-haiku-4.5', estimateUsd: haiku!.usd }).words).toBe('about $0.0035 (estimated from pi-ai\'s catalog prices; not a measured charge)');
    expect(await pi.catalogEstimate('no-such/model-in-the-catalog', { input: 1, output: 1 })).toBeUndefined();
  });
});
