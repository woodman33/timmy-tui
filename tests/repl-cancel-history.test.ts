// The operator's 00:28 order, release issue 2: keep a cancelled request's history and what finished,
// record the cancel in the conversation, and never let the unfinished work resume silently during an
// unrelated turn. LIVE-01 at C-17: the turn after a cancel ("compute 987654 * 123457") also redid the
// cancelled request's three products and their sum, because the conversation ended in the cancelled
// request with nothing after it. Now a record of the cancel closes the request: what finished, with its
// result; what started with no result; the text streamed so far; and that it continues only if asked.
import { describe, expect, it } from 'vitest';
import { createAgent } from '../src/agent/core.js';

type Item = Record<string, unknown>;
const call = (id: string, expression: string): Item => ({ type: 'function_call', callId: id, name: 'calculate', arguments: JSON.stringify({ expression }), status: 'completed' });
const output = (id: string, expression: string, result: number): Item => ({ type: 'function_call_output', callId: id, output: JSON.stringify({ expression, result }) });
const msg = (id: string, text: string): Item => ({ type: 'message', id, content: [{ text }] });

/**
 * An agent whose OpenRouter client is a script: each callModel answers with the next turn's items and
 * records the input it was sent. `abortAt` aborts the turn's signal just before that item is yielded.
 */
function scripted(turns: Array<{ items: Item[]; abortAt?: number }>) {
  const agent = createAgent({ apiKey: 'x', model: 'm', instructions: '', maxSteps: 5, maxCost: 1 }, { multiplexer: 'none' });
  // An agent resumes the newest session saved under .sessions/ in its folder; this one starts empty and
  // saves nothing there.
  agent.clearHistory();
  const inputs: Array<Array<{ role: string; content: string }>> = [];
  let controller: AbortController | null = null;
  let n = 0;
  (agent as any).client = {
    callModel: (req: any) => {
      inputs.push(JSON.parse(JSON.stringify(req.input)));
      const turn = turns[n++];
      return {
        async *getItemsStream() {
          for (const [i, item] of turn.items.entries()) {
            if (i === turn.abortAt) controller?.abort();
            await new Promise((r) => setTimeout(r, 5));
            yield item;
          }
        },
        getResponse: async () => ({}),
        cancel: async () => {},
      };
    },
  };
  const send = (text: string, cancel = false) => {
    controller = cancel ? new AbortController() : null;
    return agent.send(text, controller ? { signal: controller.signal } : {});
  };
  return { agent, inputs, send };
}

const REQUEST = 'Use the calculator three times, one call per step: 1234*5678, then 2345*6789, then 3456*7890. Then add the three results.';
const cancelledTurn = {
  // One call finished with its result, a second had started, then the cancel; what follows the cancel was never shown.
  items: [msg('m0', 'I will do the three products first.'), call('c1', '1234*5678'), output('c1', '1234*5678', 7006652), call('c2', '2345*6789'), output('c2', '2345*6789', 15920205), msg('m1', 'The sum is 50194697.')],
  abortAt: 4,
};

describe('a cancelled request is closed in the conversation', () => {
  it('keeps the request, and records the cancel: what finished, what started, the text so far, and that it stops', async () => {
    const { agent, send } = scripted([cancelledTurn]);
    await expect(send(REQUEST, true)).rejects.toMatchObject({ name: 'AbortError' });
    const history = agent.getHistory();
    expect(history.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(history[0].content).toBe(REQUEST);
    const record = history[1].content;
    expect(record).toMatch(/^\[Cancelled by the user before I answered\./);
    expect(record).toContain('Finished before the cancel: calculate {"expression":"1234*5678"} returned {"expression":"1234*5678","result":7006652}.');
    expect(record).toContain('Started, with no result before the cancel, so its effect is unknown: calculate {"expression":"2345*6789"}.');
    expect(record).toContain('What I had written so far: "I will do the three products first."');
    expect(record).toContain('Nothing was rolled back.');
    expect(record).toMatch(/I stopped here and will not continue this request unless the user asks me to\.\]$/);
    // Nothing that arrived after the cancel is claimed: not the second result, not the final text.
    expect(record).not.toContain('15920205');
    expect(record).not.toContain('50194697');
  });

  it('a cancel before any tool or text says so', async () => {
    const { agent, send } = scripted([{ items: [msg('m0', 'late')], abortAt: 0 }]);
    await expect(send('Write a long essay.', true)).rejects.toMatchObject({ name: 'AbortError' });
    expect(agent.getHistory().map((m) => m.content)).toEqual([
      'Write a long essay.',
      '[Cancelled by the user before I answered. No tool had run. I stopped here and will not continue this request unless the user asks me to.]',
    ]);
  });

  it('an unrelated next request reaches the model after the record, never as a second pending request', async () => {
    const { agent, inputs, send } = scripted([cancelledTurn, { items: [msg('m2', 'Paris.')] }]);
    await expect(send(REQUEST, true)).rejects.toMatchObject({ name: 'AbortError' });
    expect(await send('What is the capital of France?')).toBe('Paris.');
    const sent = inputs[1];
    expect(sent.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(sent[1].content).toMatch(/^\[Cancelled by the user before I answered\./);
    expect(sent[2].content).toBe('What is the capital of France?');
    expect(agent.getHistory().map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
  });

  it('an explicit request to resume gets the original request and the finished result to continue from', async () => {
    const { agent, inputs, send } = scripted([cancelledTurn, { items: [msg('m3', 'Continuing: the remaining products and the sum.')] }]);
    await expect(send(REQUEST, true)).rejects.toMatchObject({ name: 'AbortError' });
    await send('Please continue the cancelled request.');
    const sent = inputs[1];
    expect(sent.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(sent[0].content).toBe(REQUEST);
    expect(sent[1].content).toContain('"result":7006652');
    expect(sent[1].content).toContain('unless the user asks me to');
    expect(sent[2].content).toBe('Please continue the cancelled request.');
    expect(agent.getHistory().at(-1)).toMatchObject({ role: 'assistant', content: 'Continuing: the remaining products and the sum.' });
  });

  it('a finished turn is recorded as before, with no cancel record', async () => {
    const { agent, send } = scripted([{ items: [call('c1', '2+2'), output('c1', '2+2', 4), msg('m0', 'Four.')] }]);
    expect(await send('What is 2+2?')).toBe('Four.');
    expect(agent.getHistory().map((m) => [m.role, m.content])).toEqual([['user', 'What is 2+2?'], ['assistant', 'Four.']]);
  });
});
