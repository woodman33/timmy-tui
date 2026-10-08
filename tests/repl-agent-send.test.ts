import { describe, expect, it } from 'vitest';
import { createAgent } from '../src/agent/core.js';

// The additive send options for the REPL (plan C-9, playbook §17.8): an AbortSignal cancels the turn
// without trying fallback models, and `retry` asks the SDK to retry 429 and 5xx with backoff.
// The OpenRouter client is replaced by a stub that records what send() asks of it.
function stubbed(items: unknown[], { delayMs = 0, fail = false, failFirst = false } = {}) {
  const agent = createAgent({ apiKey: 'x', model: 'm', instructions: '', maxSteps: 1, maxCost: 1 }, { multiplexer: 'none' });
  const calls: Array<{ model: string; options: any }> = [];
  let cancelled = 0;
  (agent as any).client = {
    callModel: (req: any, options: any) => {
      calls.push({ model: req.model, options });
      if (fail || (failFirst && calls.length === 1)) throw new Error('503 Service Unavailable');
      return {
        async *getItemsStream() {
          for (const item of items) {
            if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
            yield item;
          }
        },
        getResponse: async () => ({}),
        cancel: async () => { cancelled++; },
      };
    },
  };
  return { agent, calls, cancelled: () => cancelled };
}
const msg = (text: string) => ({ type: 'message', id: 'm1', content: [{ text }] });

describe('agent.send options', () => {
  it('passes nothing new when called as before', async () => {
    const { agent, calls } = stubbed([msg('hi')]);
    expect(await agent.send('hello')).toBe('hi');
    expect(calls).toEqual([{ model: 'm', options: undefined }]);
  });
  it('asks for 429 and 5xx retries with 1s, 2s, 4s backoff when retry is set', async () => {
    const { agent, calls } = stubbed([msg('hi')]);
    await agent.send('hello', { retry: true });
    expect(calls[0].options).toMatchObject({
      retries: { strategy: 'backoff', backoff: { initialInterval: 1000, maxInterval: 30000, exponent: 2, maxElapsedTime: 7500 }, retryConnectionErrors: true },
      retryCodes: ['429', '5XX'],
    });
  });
  it('cancels the stream on abort, tries no fallback model, and frees the agent for the next turn', async () => {
    const { agent, calls, cancelled } = stubbed([msg('a'), msg('ab'), msg('abc'), msg('abcd')], { delayMs: 30 });
    const controller = new AbortController();
    const errors: Error[] = [];
    agent.on('error', (e) => errors.push(e));
    setTimeout(() => controller.abort(), 45);
    await expect(agent.send('long answer', { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(calls.map((c) => c.model)).toEqual(['m']);
    expect(calls[0].options.signal).toBe(controller.signal);
    expect(cancelled()).toBe(1);
    expect(errors).toEqual([]);
    expect(agent.isRunning()).toBe(false);
  });
  it('cancels during the fallback model without trying another provider or reporting an error', async () => {
    const { agent, calls } = stubbed([msg('a'), msg('ab'), msg('abc'), msg('abcd')], { delayMs: 30, failFirst: true });
    const controller = new AbortController();
    const errors: Error[] = [];
    agent.on('error', (e) => errors.push(e));
    setTimeout(() => controller.abort(), 45);
    await expect(agent.send('long answer', { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(calls.map((c) => c.model)).toEqual(['m', 'anthropic/claude-opus-4.7']);
    expect(errors).toEqual([]);
  });
});

// LIVE-01 (ledger row 65): the turn's cost was a flat $0.00001 a token on the last response only, and a
// cancelled turn reported nothing although its first response had been charged. The cost is now what
// OpenRouter charged: the `cost` its usage reports on every response of the tool loop, each counted
// once; a cancel, or a response with no charge reported, makes the figure a lower bound, said so.
function priced(responses: Array<{ id: string; cost?: number }>, opts: { final?: { id: string; cost?: number }; hang?: number } = {}) {
  const agent = createAgent({ apiKey: 'x', model: 'm', instructions: '', maxSteps: 3, maxCost: 1 }, { multiplexer: 'none' });
  const usage = (cost?: number) => ({ inputTokens: 4000, outputTokens: 150, ...(cost === undefined ? {} : { cost }) });
  (agent as any).client = {
    callModel: () => ({
      async *getItemsStream() {
        yield msg('done');
        if (opts.hang) await new Promise((r) => setTimeout(r, opts.hang));
      },
      async *getFullResponsesStream() {
        for (const r of responses) yield { type: 'response.completed', response: { id: r.id, usage: usage(r.cost) } };
        if (opts.hang) await new Promise((r) => setTimeout(r, opts.hang));
      },
      getResponse: async () => (opts.final ? { id: opts.final.id, usage: usage(opts.final.cost) } : {}),
      cancel: async () => {},
    }),
  };
  const costs: unknown[][] = [];
  agent.on('cost:update', (...a: unknown[]) => costs.push(a));
  return { agent, costs };
}

describe("the turn's cost", () => {
  it('is what OpenRouter charged for every response of the turn, each counted once', async () => {
    const { agent, costs } = priced([{ id: 'r1', cost: 0.0123 }, { id: 'r2', cost: 0.0045 }], { final: { id: 'r2', cost: 0.0045 } });
    await agent.send('two steps');
    expect(costs).toHaveLength(1);
    expect(costs[0][0]).toBeCloseTo(0.0168, 10);
    expect(costs[0][1]).toBeCloseTo(0.0168, 10);
    expect(costs[0][2]).toEqual({ complete: true });
  });
  it('counts the final response even when the stream of responses never showed it', async () => {
    const { agent, costs } = priced([{ id: 'r1', cost: 0.01 }], { final: { id: 'r2', cost: 0.002 } });
    await agent.send('x');
    expect(costs[0][0]).toBeCloseTo(0.012, 10);
    expect(costs[0][2]).toEqual({ complete: true });
  });
  it('says the cost is a lower bound when a response reported no charge', async () => {
    const { agent, costs } = priced([{ id: 'r1', cost: 0.01 }, { id: 'r2' }], { final: { id: 'r2' } });
    await agent.send('x');
    expect(costs[0][0]).toBeCloseTo(0.01, 10);
    expect(costs[0][2]).toEqual({ complete: false });
  });
  it('reports what a cancelled turn had already been charged, as a lower bound, before it rejects', async () => {
    const { agent, costs } = priced([{ id: 'r1', cost: 0.02 }], { hang: 150 });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 40);
    await expect(agent.send('x', { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(costs).toHaveLength(1);
    expect(costs[0][0]).toBeCloseTo(0.02, 10);
    expect(costs[0][2]).toEqual({ complete: false });
  });
});

// LIVE-01 (ledger row 65) measured on the operator's key: Anthropic runs on his own provider key through
// OpenRouter (BYOK), so `usage.cost` is only OpenRouter's fee and the provider's charge comes as
// `costDetails.upstreamInferenceCost`. Without BYOK that figure is already inside `cost`.
function withUsage(responses: Array<{ id: string; usage: Record<string, unknown> }>) {
  const agent = createAgent({ apiKey: 'x', model: 'm', instructions: '', maxSteps: 3, maxCost: 1 }, { multiplexer: 'none' });
  (agent as any).client = {
    callModel: () => ({
      async *getItemsStream() { yield msg('done'); },
      async *getFullResponsesStream() {
        for (const r of responses) yield { type: 'response.completed', response: { id: r.id, usage: { inputTokens: 4000, outputTokens: 150, ...r.usage } } };
      },
      getResponse: async () => ({ id: responses.at(-1)!.id, usage: { inputTokens: 4000, outputTokens: 150, ...responses.at(-1)!.usage } }),
      cancel: async () => {},
    }),
  };
  const costs: unknown[][] = [];
  agent.on('cost:update', (...a: unknown[]) => costs.push(a));
  return { agent, costs };
}
const upstream = (total: number | null) => ({ upstreamInferenceCost: total, upstreamInferenceInputCost: 0.02, upstreamInferenceOutputCost: 0.0031 });

describe("the turn's cost on the operator's own provider key (BYOK)", () => {
  it("adds the provider's charge to OpenRouter's fee", async () => {
    const { agent, costs } = withUsage([{ id: 'r1', usage: { cost: 0.0004, isByok: true, costDetails: upstream(0.0231) } }]);
    await agent.send('x');
    expect(costs[0][0]).toBeCloseTo(0.0235, 10);
    expect(costs[0][2]).toEqual({ complete: true });
  });
  it("never adds the provider's charge twice when OpenRouter billed it (no BYOK)", async () => {
    const { agent, costs } = withUsage([{ id: 'r1', usage: { cost: 0.0123, isByok: false, costDetails: upstream(0.0119) } }]);
    await agent.send('x');
    expect(costs[0][0]).toBeCloseTo(0.0123, 10);
    expect(costs[0][2]).toEqual({ complete: true });
  });
  it("is a lower bound when a BYOK response does not say what the provider charged", async () => {
    const { agent, costs } = withUsage([{ id: 'r1', usage: { cost: 0.0004, isByok: true, costDetails: upstream(null) } }]);
    await agent.send('x');
    expect(costs[0][0]).toBeCloseTo(0.0004, 10);
    expect(costs[0][2]).toEqual({ complete: false });
  });
});
