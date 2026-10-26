/**
 * R12 (the operator's order of 2026-10-25, 21:15 PT: @openrouter/sdk 0.12.35 → 1.5.7, "update it now"): the SDK's own callModel
 * on its core client (src/agent/openrouter-lean.ts), through Timmy's own Agent (src/agent/core.ts), against a LABELLED FAKE
 * OpenResponses server on 127.0.0.1: no key, no network beyond loopback, no paid call.
 *
 * The address pin: with no test serverURL the client always calls OpenRouter's own address, whatever OPENROUTER_BASE_URL says
 * (the SDK 1.x reads it otherwise). The loop: a streamed function call → Timmy's tool runs → its output goes back → a streamed
 * answer; the text deltas, the tool events, the native items, and the cost summed over both responses (BYOK's upstream charge
 * included). Cancel: aborted mid-stream, the send rejects with AbortError and nothing is left unhandled.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tool } from '@openrouter/sdk/lib/tool.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod/v4';
import { createAgent } from '../src/agent/core.js';
import { OpenRouterClient } from '../src/agent/openrouter-lean.js';

const base = (id: string, output: unknown[], usage: unknown, status = 'completed') => ({
  id, object: 'response', created_at: 1, completed_at: 2, status, model: 'fake/answered-model', output,
  error: null, incomplete_details: null, instructions: null, metadata: {}, parallel_tool_calls: true,
  frequency_penalty: null, presence_penalty: null, temperature: null, top_p: null, tool_choice: 'auto', tools: [], usage,
});
const usage = (cost: number, extra: Record<string, unknown> = {}) => ({ input_tokens: 10, input_tokens_details: { cached_tokens: 0 }, output_tokens: 5, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 15, cost, ...extra });
const sse = (res: http.ServerResponse, events: Array<Record<string, unknown>>): void => {
  let n = 0;
  for (const e of events) res.write(`event: ${String(e.type)}\ndata: ${JSON.stringify({ ...e, sequence_number: n++ })}\n\n`);
  res.end();
};

describe('the OpenRouter SDK 1.5.7 through its core client (FAKE OpenResponses server on 127.0.0.1)', () => {
  let server: http.Server;
  let serverURL = '';
  let mode: 'loop' | 'stall' = 'loop';
  const bodies: Array<{ path?: string; body: { model?: string; input?: unknown } }> = [];
  const kept = process.env.OPENROUTER_BASE_URL;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        const body = JSON.parse(raw) as { input?: unknown };
        bodies.push({ path: req.url, body });
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        if (mode === 'stall') { res.write(': ping\n\n'); return; }
        if (!JSON.stringify(body.input).includes('function_call_output')) {
          const call = { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'fake_echo', arguments: '', status: 'in_progress' };
          const done = { ...call, arguments: '{"text":"ping"}', status: 'completed' };
          sse(res, [
            { type: 'response.created', response: base('resp_1', [], null, 'in_progress') },
            { type: 'response.output_item.added', output_index: 0, item: call },
            { type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'fc_1', delta: '{"text":"ping"}' },
            { type: 'response.function_call_arguments.done', output_index: 0, item_id: 'fc_1', arguments: '{"text":"ping"}', name: 'fake_echo' },
            { type: 'response.output_item.done', output_index: 0, item: done },
            { type: 'response.completed', response: base('resp_1', [done], usage(0.001)) },
          ]);
        } else {
          const msg = { type: 'message', id: 'msg_2', role: 'assistant', status: 'in_progress', content: [] };
          const text = 'FAKE answer after the tool.';
          const doneMsg = { ...msg, status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] };
          sse(res, [
            { type: 'response.created', response: base('resp_2', [], null, 'in_progress') },
            { type: 'response.output_item.added', output_index: 0, item: msg },
            { type: 'response.content_part.added', output_index: 0, item_id: 'msg_2', content_index: 0, part: { type: 'output_text', text: '', annotations: [] } },
            { type: 'response.output_text.delta', output_index: 0, item_id: 'msg_2', content_index: 0, delta: 'FAKE answer ', logprobs: [] },
            { type: 'response.output_text.delta', output_index: 0, item_id: 'msg_2', content_index: 0, delta: 'after the tool.', logprobs: [] },
            { type: 'response.output_text.done', output_index: 0, item_id: 'msg_2', content_index: 0, text, logprobs: [] },
            { type: 'response.output_item.done', output_index: 0, item: doneMsg },
            { type: 'response.completed', response: base('resp_2', [doneMsg], usage(0.002, { is_byok: true, cost_details: { upstream_inference_cost: 0.01, upstream_inference_input_cost: 0.006, upstream_inference_output_cost: 0.004 } })) },
          ]);
        }
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    serverURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
  });
  afterAll(async () => {
    if (kept === undefined) delete process.env.OPENROUTER_BASE_URL; else process.env.OPENROUTER_BASE_URL = kept;
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('calls OpenRouter\'s own address whatever OPENROUTER_BASE_URL says; a test\'s serverURL only when named', () => {
    process.env.OPENROUTER_BASE_URL = 'http://127.0.0.1:9/api/v1';
    expect(String((new OpenRouterClient({ apiKey: 'sk-or-FAKE' }).core as unknown as { _baseURL: URL })._baseURL)).toBe('https://openrouter.ai/api/v1/');
    expect(String((new OpenRouterClient({ apiKey: 'sk-or-FAKE', serverURL }).core as unknown as { _baseURL: URL })._baseURL)).toBe(`${serverURL}/`);
    delete process.env.OPENROUTER_BASE_URL;
  });

  it('the tool loop: a streamed call runs Timmy\'s tool, its output goes back, the answer streams; the cost of both responses is summed', async () => {
    mode = 'loop';
    bodies.length = 0;
    const agent = createAgent({ apiKey: 'sk-or-FAKE', model: 'fake/asked-model', instructions: 'FAKE', maxSteps: 4, maxCost: 1 }, { multiplexer: 'none' });
    (agent as unknown as { client: OpenRouterClient }).client = new OpenRouterClient({ apiKey: 'sk-or-FAKE', serverURL });
    const executed: unknown[] = [];
    agent.setTools([tool({ name: 'fake_echo', description: 'FAKE echo', inputSchema: z.object({ text: z.string() }), execute: async (a: { text: string }) => { executed.push(a); return { echoed: a.text }; } })]);
    const deltas: string[] = [];
    const costs: unknown[][] = [];
    const calls: unknown[] = [];
    const errors: string[] = [];
    agent.on('stream:delta', (d: string) => deltas.push(d));
    agent.on('cost:update', (...a: unknown[]) => costs.push(a));
    agent.on('tool:call', (...a: unknown[]) => calls.push(a));
    agent.on('error', (e: Error) => errors.push(e.message));
    const text = await agent.send('hi');
    expect(text).toBe('FAKE answer after the tool.');
    expect(executed).toEqual([{ text: 'ping' }]);
    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect(deltas.join('')).toContain('FAKE answer after the tool.');
    expect(errors).toEqual([]);
    expect(bodies.map((b) => b.path)).toEqual(['/api/v1/responses', '/api/v1/responses']);
    expect(bodies.every((b) => b.body.model === 'fake/asked-model')).toBe(true);
    // 0.001 + (0.002 OpenRouter's fee + 0.01 BYOK upstream) = 0.013, as the receipts read it
    const total = JSON.stringify(costs.at(-1));
    expect(total).toContain('0.013');
  }, 60_000);

  it('cancel: aborted mid-stream, the send rejects with AbortError and nothing is left unhandled', async () => {
    mode = 'stall';
    const unhandled: string[] = [];
    const onUnhandled = (e: unknown): void => { unhandled.push(String(e)); };
    process.on('unhandledRejection', onUnhandled);
    const agent = createAgent({ apiKey: 'sk-or-FAKE', model: 'fake/m', instructions: '', maxSteps: 2, maxCost: 1 }, { multiplexer: 'none' });
    (agent as unknown as { client: OpenRouterClient }).client = new OpenRouterClient({ apiKey: 'sk-or-FAKE', serverURL });
    agent.on('error', () => { /* the abort is said through the rejection */ });
    const c = new AbortController();
    setTimeout(() => c.abort(), 300);
    let name = '';
    try { await agent.send('hi', { signal: c.signal }); } catch (e) { name = (e as Error).name; }
    await new Promise((r) => setTimeout(r, 800));
    process.off('unhandledRejection', onUnhandled);
    expect(name).toBe('AbortError');
    expect(agent.isRunning()).toBe(false);
    expect(unhandled).toEqual([]);
  }, 60_000);
});
