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
